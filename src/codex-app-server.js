import { spawn } from "node:child_process";

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
  let generatedImage = null;
  let completed = false;
  let failure = null;

  try {
    await client.initialize();
    const requestedModel = options.threadModel ?? options.model ?? process.env.CODEX_THREAD_MODEL ?? process.env.CODEX_IMAGE_MODEL ?? "gpt-5.5";
    const threadOptions = {
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      experimentalRawEvents: true,
      persistExtendedHistory: options.persistExtendedHistory ?? false,
      ephemeral: options.ephemeral ?? true,
    };
    if (requestedModel) {
      threadOptions.model = requestedModel;
    }
    const thread = await client.request("thread/start", threadOptions);

    client.onNotification((notification) => {
      if (notification.method === "error") {
        failure = new Error("Codex image turn failed");
        completed = true;
        return;
      }
      const params = notification.params && typeof notification.params === "object" ? notification.params : {};
      if (notification.method === "turn/completed") {
        completed = true;
        return;
      }
      const image = parseImageGenerationItem(params.item);
      if (!image) {
        return;
      }
      generatedImage = {
        threadId: String(params.threadId ?? thread.thread.id),
        turnId: String(params.turnId ?? ""),
        imageId: image.id,
        status: image.status,
        resultBase64: image.resultBase64,
        revisedPrompt: image.revisedPrompt,
        model: thread.model,
        modelProvider: thread.modelProvider,
      };
    });

    await client.request("turn/start", {
      threadId: thread.thread.id,
      input: [{
        type: "text",
        text: prompt,
        text_elements: [],
      }],
      effort: options.effort ?? "low",
    });

    await waitUntil(() => completed, timeoutMs);
    if (failure) {
      throw failure;
    }
    if (!generatedImage?.resultBase64) {
      throw new Error("Codex completed without returning an image generation result");
    }
    return generatedImage;
  } finally {
    client.close();
  }
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.command = options.command ?? process.env.CODEX_IMAGE_COMMAND ?? "codex";
    this.timeoutMs = numberFrom(options.timeoutMs, process.env.CODEX_IMAGE_APP_SERVER_TIMEOUT_MS, 15_000);
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
    const payload = params === undefined ? { id, method } : { id, method, params };
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("Codex app-server was not started"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server method ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    this.ensureStarted();
    const payload = params === undefined ? { method } : { method, params };
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  close() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
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
    this.child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk.toString()));
    this.child.stderr.on("data", () => {
      // Codex may emit plugin warnings on stderr. Keep the bridge quiet unless
      // a JSON-RPC request actually fails.
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
    this.pending.delete(message.id);
    if (Object.hasOwn(message, "error")) {
      pending.reject(new Error(message.error?.message ?? "Codex app-server request failed"));
      return;
    }
    pending.resolve(message.result);
  }

  handleNotification(notification) {
    for (const handler of this.notificationHandlers) {
      handler(notification);
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
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
    };
  }
  if (item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0) {
    return {
      id: String(item.id ?? "codex-image"),
      status: String(item.status ?? "completed"),
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      resultBase64: item.result,
    };
  }
  return null;
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
