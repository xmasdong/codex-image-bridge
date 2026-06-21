import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_IMAGE_BRIDGE_DEVELOPER_INSTRUCTIONS = [
  "You are Codex Image Bridge.",
  "For image requests, use Codex native image generation to create exactly one PNG image.",
  "Do not create substitute images using shell commands, MCP tools, node_repl, JavaScript, SVG, canvas, HTML, or procedural drawing.",
  "Return only the generated image. If native image generation is unavailable, answer exactly NATIVE_IMAGE_GENERATION_UNAVAILABLE.",
].join(" ");

const TOOL_IMAGE_FALLBACK_DEVELOPER_INSTRUCTIONS = [
  "You are Codex Image Bridge.",
  "For image requests, prefer Codex native image generation.",
  "If native image generation is unavailable, you may return exactly one PNG image from another available tool.",
  "Return only the generated image and no explanatory text.",
].join(" ");

export async function readCodexAuthStatus(options = {}) {
  const status = await readCodexAuthTokenStatus({ ...options, includeToken: true });
  return {
    account: status.account,
    authMethod: status.authMethod,
    requiresOpenaiAuth: status.requiresOpenaiAuth,
    tokenPresent: status.tokenPresent,
    tokenLength: status.tokenLength,
    userAgent: status.userAgent,
  };
}

export async function readCodexAuthTokenStatus(options = {}) {
  const client = new CodexAppServerClient(options);
  try {
    const initialized = await client.initialize();
    const accountResponse = await client.request("account/read", {
      refreshToken: options.refreshToken ?? true,
    });
    const authResponse = await client.request("getAuthStatus", {
      includeToken: options.includeToken ?? false,
      refreshToken: options.refreshToken ?? true,
    });

    return {
      account: accountResponse.account ?? null,
      authMethod: authResponse.authMethod ?? null,
      requiresOpenaiAuth: authResponse.requiresOpenaiAuth ?? accountResponse.requiresOpenaiAuth ?? null,
      tokenPresent: typeof authResponse.authToken === "string" && authResponse.authToken.length > 0,
      tokenLength: authResponse.authToken?.length,
      authToken: authResponse.authToken ?? null,
      userAgent: initialized.userAgent,
    };
  } finally {
    client.close();
  }
}

export async function generateCodexImage(prompt, options = {}) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("prompt is required");
  }

  const timeoutMs = numberFrom(options.timeoutMs, process.env.CODEX_IMAGE_TIMEOUT_MS, 120_000);
  const client = new CodexAppServerClient({
    ...options,
    timeoutMs,
  });
  const acceptToolImages = Boolean(options.acceptToolImages ?? truthyEnv(process.env.CODEX_IMAGE_ACCEPT_TOOL_IMAGES));
  const toolCalls = new Map();
  let generatedImage = null;
  let rejectedToolImage = null;
  let assistantText = "";
  let completed = false;
  let failure = null;

  try {
    await client.initialize();
    const imagePrompt = buildCodexImagePrompt(prompt, options);
    const requestedModel = options.threadModel ?? options.model ?? process.env.CODEX_THREAD_MODEL ?? process.env.CODEX_IMAGE_MODEL ?? "gpt-5.5";
    const cwd = options.cwd ?? process.cwd();
    const sandbox = options.sandbox ?? process.env.CODEX_IMAGE_SANDBOX ?? "danger-full-access";
    const personality = options.personality ?? process.env.CODEX_IMAGE_PERSONALITY ?? "friendly";
    const threadOptions = {
      cwd,
      approvalPolicy: "never",
      sandbox,
      experimentalRawEvents: true,
      persistExtendedHistory: options.persistExtendedHistory ?? false,
      ephemeral: options.ephemeral ?? true,
      threadSource: options.threadSource ?? process.env.CODEX_IMAGE_THREAD_SOURCE ?? "user",
      personality,
      developerInstructions: buildDeveloperInstructions(options, acceptToolImages),
    };
    if (requestedModel) {
      threadOptions.model = requestedModel;
    }
    const thread = await client.request("thread/start", threadOptions);

    client.onNotification((notification) => {
      const params = notification.params && typeof notification.params === "object" ? notification.params : {};
      const item = params.item;
      if (notification.method === "error") {
        failure = new Error(`Codex image turn failed${formatNotificationError(notification.params)}`);
        completed = true;
        return;
      }
      if (notification.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        assistantText += params.delta;
      }
      if (notification.method === "turn/completed") {
        completed = true;
        return;
      }
      recordToolCall(item, toolCalls);
      const image = parseImageGenerationItem(item);
      if (!image) {
        const toolImage = parseToolImageOutputItem(item, toolCalls);
        if (toolImage && (toolImage.nativeTool || acceptToolImages)) {
          generatedImage = buildGeneratedImage(toolImage, params, thread, generatedImage);
        } else if (toolImage) {
          rejectedToolImage = toolImage;
        }
        return;
      }
      generatedImage = buildGeneratedImage(image, params, thread, generatedImage);
    });

    await client.request("turn/start", {
      threadId: thread.thread.id,
      input: await buildTurnInput(imagePrompt, options),
      effort: options.effort ?? "low",
      approvalPolicy: "never",
      personality,
      sandboxPolicy: sandboxPolicyFromMode(sandbox, cwd),
    });

    await waitUntil(() => completed, timeoutMs);
    if (failure) {
      throw failure;
    }
    if (!generatedImage?.resultBase64) {
      throw new Error(buildNoImageError({ assistantText, rejectedToolImage }));
    }
    return generatedImage;
  } finally {
    client.close();
  }
}

function buildDeveloperInstructions(options, acceptToolImages) {
  if (options.developerInstructions) {
    return options.developerInstructions;
  }
  return acceptToolImages ? TOOL_IMAGE_FALLBACK_DEVELOPER_INSTRUCTIONS : DEFAULT_IMAGE_BRIDGE_DEVELOPER_INSTRUCTIONS;
}

function buildGeneratedImage(image, params, thread, previous) {
  return {
    threadId: String(params.threadId ?? thread.thread.id),
    turnId: String(params.turnId ?? ""),
    imageId: image.id,
    status: image.status,
    resultBase64: image.resultBase64,
    revisedPrompt: image.revisedPrompt,
    savedPath: image.savedPath ?? previous?.savedPath,
    model: thread.model,
    modelProvider: thread.modelProvider,
    source: image.source,
  };
}

function sandboxPolicyFromMode(mode, cwd) {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [String(cwd)],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return { type: "readOnly", networkAccess: false };
}

function buildCodexImagePrompt(prompt, options) {
  const hasReferenceImage = normalizeImagePaths(options).length > 0;
  const lead = hasReferenceImage
    ? "Generate one PNG image by editing the provided local image as the visual reference."
    : "Generate one PNG image from the prompt below.";
  return [
    lead,
    "Return only the generated image. Do not answer with text.",
    "",
    prompt.trim(),
  ].join("\n");
}

async function buildTurnInput(prompt, options) {
  const input = [];
  const imagePaths = normalizeImagePaths(options);
  for (const imagePath of imagePaths) {
    const absolutePath = resolve(String(imagePath));
    await access(absolutePath);
    input.push({
      type: "localImage",
      path: absolutePath,
    });
  }
  input.push({
    type: "text",
    text: prompt,
    text_elements: [],
  });
  return input;
}

function normalizeImagePaths(options) {
  const paths = [];
  if (options.imagePath) {
    paths.push(options.imagePath);
  }
  if (Array.isArray(options.imagePaths)) {
    paths.push(...options.imagePaths);
  }
  return paths.filter(Boolean);
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.command = resolveCodexCommand(options);
    this.timeoutMs = numberFrom(options.appServerTimeoutMs, process.env.CODEX_IMAGE_APP_SERVER_TIMEOUT_MS, options.timeoutMs, 30_000);
    this.startupDelayMs = numberFrom(options.startupDelayMs, process.env.CODEX_IMAGE_APP_SERVER_START_DELAY_MS, 250);
    this.debug = Boolean(options.debug ?? truthyEnv(process.env.CODEX_IMAGE_DEBUG));
    this.stderrTail = "";
    this.startedAt = 0;
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.notificationHandlers = new Set();
  }

  async initialize() {
    this.ensureStarted();
    const response = await this.request("initialize", {
      clientInfo: {
        name: "codex-image-bridge",
        title: "Codex Image Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
    return response;
  }

  request(method, params) {
    this.ensureStarted();
    const id = this.nextId++;
    const payload = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("Codex app-server was not started"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.formatRequestTimeout(method)));
      }, this.timeoutMs);
      const pending = { resolve, reject, timer, writeTimer: undefined };
      const writePayload = () => {
        pending.writeTimer = undefined;
        if (!this.pending.has(id)) {
          return;
        }
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      };
      const delayMs = this.startupWriteDelayMs();
      if (delayMs > 0) {
        pending.writeTimer = setTimeout(writePayload, delayMs);
      }
      this.pending.set(id, pending);
      if (delayMs === 0) {
        writePayload();
      }
    });
  }

  notify(method, params) {
    this.ensureStarted();
    const payload = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  close() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.writeTimer) {
        clearTimeout(pending.writeTimer);
      }
      pending.reject(new Error("Codex app-server client closed"));
      this.pending.delete(id);
    }
    this.child?.kill();
    this.child = undefined;
  }

  ensureStarted() {
    if (this.child) {
      return;
    }
    this.startedAt = Date.now();
    this.child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk.toString()));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      this.stderrTail = appendTail(this.stderrTail, text);
      if (this.debug) {
        process.stderr.write(text);
      }
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`Codex app-server exited before responding (${signal ?? code ?? "unknown"})`));
      }
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.handleMessage(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      this.handleNotification(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    if (pending.writeTimer) {
      clearTimeout(pending.writeTimer);
    }
    this.pending.delete(message.id);
    if (Object.hasOwn(message, "error")) {
      pending.reject(new Error(formatJsonRpcError(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  formatRequestTimeout(method) {
    const stderr = this.stderrTail.trim();
    const details = stderr ? `\nCodex app-server stderr:\n${stderr}` : "";
    return `Timed out waiting ${this.timeoutMs}ms for Codex app-server method ${method} via ${this.command}${details}`;
  }

  startupWriteDelayMs() {
    if (!this.startedAt || this.startupDelayMs <= 0) {
      return 0;
    }
    return Math.max(0, this.startupDelayMs - (Date.now() - this.startedAt));
  }

  handleNotification(notification) {
    for (const handler of this.notificationHandlers) {
      handler(notification);
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.writeTimer) {
        clearTimeout(pending.writeTimer);
      }
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function resolveCodexCommand(options = {}) {
  const explicit = options.command ?? process.env.CODEX_APP_SERVER_COMMAND ?? process.env.CODEX_IMAGE_COMMAND;
  if (explicit) {
    return String(explicit);
  }

  for (const candidate of defaultCodexCommandCandidates()) {
    if (candidate === "codex" || existsSync(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

function defaultCodexCommandCandidates() {
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push("/Applications/Codex.app/Contents/Resources/codex");
  }
  if (process.env.HOME) {
    candidates.push(`${process.env.HOME}/.codex/plugins/.plugin-appserver/codex`);
  }
  candidates.push("codex");
  return candidates;
}

function parseImageGenerationItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  if (item.type === "imageGeneration" && typeof item.result === "string" && item.result.length > 0) {
    return {
      id: String(item.id ?? "codex-image"),
      status: String(item.status ?? "completed"),
      revisedPrompt: typeof item.revisedPrompt === "string" ? item.revisedPrompt : undefined,
      resultBase64: item.result,
      savedPath: typeof item.savedPath === "string" ? item.savedPath : undefined,
      source: "imageGeneration",
    };
  }
  if (item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0) {
    return {
      id: String(item.id ?? "codex-image"),
      status: String(item.status ?? "completed"),
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      resultBase64: item.result,
      source: "image_generation_call",
    };
  }
  return null;
}

function recordToolCall(item, toolCalls) {
  if (!item || typeof item !== "object" || item.type !== "function_call" || typeof item.call_id !== "string") {
    return;
  }
  toolCalls.set(item.call_id, {
    name: typeof item.name === "string" ? item.name : "",
    namespace: typeof item.namespace === "string" ? item.namespace : "",
  });
}

function parseToolImageOutputItem(item, toolCalls) {
  if (!item || typeof item !== "object" || item.type !== "function_call_output") {
    return null;
  }
  const image = findDataImage(item.output);
  if (!image) {
    return null;
  }
  const toolCall = toolCalls.get(item.call_id) ?? {};
  const source = formatToolSource(toolCall);
  return {
    id: String(item.call_id ?? "tool-image"),
    status: "completed",
    revisedPrompt: undefined,
    resultBase64: image.base64,
    source,
    nativeTool: isNativeImageTool(toolCall),
  };
}

function findDataImage(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return parseDataImageUrl(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = findDataImage(item);
      if (image) {
        return image;
      }
    }
    return null;
  }
  if (typeof value === "object") {
    if (typeof value.image_url === "string") {
      const image = parseDataImageUrl(value.image_url);
      if (image) {
        return image;
      }
    }
    if (typeof value.data === "string" && typeof value.mimeType === "string" && value.mimeType.startsWith("image/")) {
      return {
        mimeType: value.mimeType,
        base64: value.data,
      };
    }
    for (const child of Object.values(value)) {
      const image = findDataImage(child);
      if (image) {
        return image;
      }
    }
  }
  return null;
}

function parseDataImageUrl(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1].toLowerCase(),
    base64: match[2],
  };
}

function isNativeImageTool(toolCall) {
  const name = String(toolCall.name ?? "").toLowerCase();
  const namespace = String(toolCall.namespace ?? "").toLowerCase();
  return (!namespace || namespace === "builtin") && ["image_gen", "image_generation", "generate_image"].includes(name);
}

function formatToolSource(toolCall) {
  const name = String(toolCall.name ?? "");
  const namespace = String(toolCall.namespace ?? "");
  if (namespace && name) {
    return `${namespace}/${name}`;
  }
  return name || namespace || "function_call_output";
}

function buildNoImageError({ assistantText, rejectedToolImage }) {
  const normalizedText = assistantText.trim();
  if (normalizedText === "NATIVE_IMAGE_GENERATION_UNAVAILABLE" || normalizedText === "IMAGE_GEN_TOOL_UNAVAILABLE") {
    return "Codex app-server is reachable, but native image generation / built-in image_gen is unavailable in this app-server turn.";
  }
  if (rejectedToolImage) {
    return `Codex returned image data from ${rejectedToolImage.source}, not native image generation. Rejected tool/procedural fallback; set CODEX_IMAGE_ACCEPT_TOOL_IMAGES=1 only if you intentionally want to accept non-native tool images.`;
  }
  const textHint = normalizedText ? ` Assistant text: ${normalizedText.slice(0, 300)}` : "";
  return `Codex completed without returning a native image generation result.${textHint}`;
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for Codex image generation");
}

function numberFrom(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return 0;
}

function appendTail(current, next, maxLength = 8_000) {
  return `${current}${next}`.slice(-maxLength);
}

function truthyEnv(value) {
  return typeof value === "string" && !["", "0", "false", "no", "off"].includes(value.toLowerCase());
}

function formatJsonRpcError(error) {
  if (!error || typeof error !== "object") {
    return "Codex app-server request failed";
  }
  const code = error.code === undefined ? "" : ` (code ${error.code})`;
  const data = error.data === undefined ? "" : `: ${safeStringify(error.data)}`;
  return `${error.message ?? "Codex app-server request failed"}${code}${data}`;
}

function formatNotificationError(params) {
  if (params === undefined) {
    return "";
  }
  return `: ${safeStringify(params)}`;
}

function safeStringify(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
