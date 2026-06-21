#!/usr/bin/env node
import { getAuthStatus, generateImageFile } from "./image-service.mjs";

const serverInfo = {
  name: "codex-image-bridge",
  version: "0.1.0",
};

const tools = [
  {
    name: "codex_auth_status",
    description: "Check whether Codex app-server can access the current managed ChatGPT/Codex account.",
    inputSchema: {
      type: "object",
      properties: {
        refreshToken: {
          type: "boolean",
          description: "Ask Codex app-server to refresh auth state before reading it.",
          default: true,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_generate_image",
    description: "Generate one PNG image through Codex app-server and save it to disk.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description: "Image generation prompt.",
        },
        filename: {
          type: "string",
          description: "Output filename under outputDir. Defaults to a timestamped PNG.",
        },
        outputDir: {
          type: "string",
          description: "Directory where the PNG should be saved. Defaults to outputs.",
        },
        outputPath: {
          type: "string",
          description: "Exact output PNG path. Overrides filename/outputDir.",
        },
        threadModel: {
          type: "string",
          description: "Optional Codex thread/start model. Defaults to CODEX_THREAD_MODEL or gpt-5.5.",
        },
        model: {
          type: "string",
          description: "Deprecated alias for threadModel.",
        },
        timeoutMs: {
          type: "number",
          description: "Generation timeout in milliseconds.",
        },
        cwd: {
          type: "string",
          description: "Working directory passed to Codex thread/start.",
        },
        effort: {
          type: "string",
          description: "Codex turn effort. Defaults to low.",
          enum: ["low", "medium", "high"],
        },
        sandbox: {
          type: "string",
          description: "Codex thread sandbox. Defaults to danger-full-access to match Codex Desktop native image generation behavior.",
          enum: ["read-only", "workspace-write", "danger-full-access"],
        },
        acceptToolImages: {
          type: "boolean",
          description: "Accept image data returned by non-native tools. Disabled by default because it can be procedural fallback rather than native model image generation.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_edit_image",
    description: "Edit or reinterpret a PNG image using a source image as visual reference through Codex app-server.",
    inputSchema: {
      type: "object",
      required: ["prompt", "imagePath"],
      properties: {
        prompt: {
          type: "string",
          description: "Editing prompt. Describe what should change and what must stay consistent.",
        },
        imagePath: {
          type: "string",
          description: "Local source image path used as the visual reference.",
        },
        filename: {
          type: "string",
          description: "Output filename under outputDir. Defaults to a timestamped PNG.",
        },
        outputDir: {
          type: "string",
          description: "Directory where the PNG should be saved. Defaults to outputs.",
        },
        outputPath: {
          type: "string",
          description: "Exact output PNG path. Overrides filename/outputDir.",
        },
        threadModel: {
          type: "string",
          description: "Optional Codex thread/start model. Defaults to CODEX_THREAD_MODEL or gpt-5.5.",
        },
        model: {
          type: "string",
          description: "Deprecated alias for threadModel.",
        },
        timeoutMs: {
          type: "number",
          description: "Generation timeout in milliseconds.",
        },
        cwd: {
          type: "string",
          description: "Working directory passed to Codex thread/start.",
        },
        effort: {
          type: "string",
          description: "Codex turn effort. Defaults to low.",
          enum: ["low", "medium", "high"],
        },
        sandbox: {
          type: "string",
          description: "Codex thread sandbox. Defaults to danger-full-access to match Codex Desktop native image generation behavior.",
          enum: ["read-only", "workspace-write", "danger-full-access"],
        },
        acceptToolImages: {
          type: "boolean",
          description: "Accept image data returned by non-native tools. Disabled by default because it can be procedural fallback rather than native model image generation.",
        },
      },
      additionalProperties: false,
    },
  },
];

async function handleMessage(message) {
  if (!Object.hasOwn(message, "id")) {
    return;
  }

  if (message.method === "initialize") {
    transport.send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo,
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    transport.send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools },
    });
    return;
  }

  if (message.method === "tools/call") {
    const result = await callTool(message.params?.name, message.params?.arguments ?? {});
    transport.send({
      jsonrpc: "2.0",
      id: message.id,
      result,
    });
    return;
  }

  transport.send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `Method not found: ${message.method}`,
    },
  });
}

async function callTool(name, args) {
  if (name === "codex_auth_status") {
    const status = await getAuthStatus({
      refreshToken: args.refreshToken !== false,
    });
    return textResult({
      ok: Boolean(status.account),
      provider: "codex-app-server",
      status,
    });
  }

  if (name === "codex_generate_image") {
    const image = await generateImageFile({
      prompt: args.prompt,
      filename: args.filename,
      outputDir: args.outputDir,
      outputPath: args.outputPath,
      cwd: args.cwd,
      threadModel: args.threadModel ?? args.model,
      timeoutMs: args.timeoutMs,
      effort: args.effort,
      sandbox: args.sandbox,
      acceptToolImages: args.acceptToolImages,
    });
    return textResult({ image });
  }

  if (name === "codex_edit_image") {
    const image = await generateImageFile({
      prompt: args.prompt,
      imagePath: args.imagePath,
      filename: args.filename,
      outputDir: args.outputDir,
      outputPath: args.outputPath,
      cwd: args.cwd,
      threadModel: args.threadModel ?? args.model,
      timeoutMs: args.timeoutMs,
      effort: args.effort,
      sandbox: args.sandbox,
      acceptToolImages: args.acceptToolImages,
    });
    return textResult({ image });
  }

  throw new Error(`Unknown tool: ${name}`);
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

class StdioJsonRpcTransport {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.onMessage = () => {};
    this.input.on("data", (chunk) => this.handleData(Buffer.from(chunk)));
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.output.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.output.write(body);
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      if (this.buffer.subarray(0, 1).toString("utf8") === "{") {
        const newlineIndex = this.buffer.indexOf(10);
        if (newlineIndex < 0) {
          return;
        }
        const line = this.buffer.subarray(0, newlineIndex).toString("utf8").trim();
        this.buffer = this.buffer.subarray(newlineIndex + 1);
        if (line) {
          this.dispatch(line);
        }
        continue;
      }

      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLengthMatch = /content-length:\s*(\d+)/iu.exec(header);
      if (!contentLengthMatch) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const length = Number(contentLengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) {
        return;
      }
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.dispatch(body);
    }
  }

  dispatch(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    this.onMessage(message);
  }
}

const transport = new StdioJsonRpcTransport(process.stdin, process.stdout);
transport.onMessage = (message) => {
  handleMessage(message).catch((error) => {
    if (Object.hasOwn(message, "id")) {
      transport.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
};
