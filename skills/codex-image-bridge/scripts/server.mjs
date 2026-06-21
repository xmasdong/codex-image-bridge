import http from "node:http";
import { getAuthStatus, generateImageFile } from "./image-service.mjs";

export function createServer(options = {}) {
  return http.createServer(async (request, response) => {
    try {
      await route(request, response, options);
    } catch (error) {
      sendJson(response, statusFromError(error), {
        error: {
          message: error instanceof Error ? error.message : "Unknown server error",
        },
      });
    }
  });
}

export async function startServer(options = {}) {
  const host = options.host ?? process.env.CODEX_IMAGE_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.CODEX_IMAGE_PORT ?? 4020);
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { server, host, port };
}

async function route(request, response, options) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "codex-image-bridge",
      version: "0.1.0",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/auth/status") {
    const refreshToken = url.searchParams.get("refreshToken") !== "false";
    const status = await getAuthStatus({ refreshToken, command: options.command });
    sendJson(response, 200, {
      provider: "codex-app-server",
      ok: Boolean(status.account),
      status,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/images/generate") {
    const body = await readJson(request);
    const result = await generateImageFile({
      prompt: body.prompt,
      filename: body.filename,
      outputDir: body.outputDir ?? options.outputDir,
      outputPath: body.outputPath,
      cwd: body.cwd ?? options.cwd,
      threadModel: body.threadModel ?? body.model ?? options.threadModel ?? options.model,
      timeoutMs: body.timeoutMs ?? options.timeoutMs,
      command: body.command ?? options.command,
      effort: body.effort,
      sandbox: body.sandbox ?? options.sandbox,
      acceptToolImages: body.acceptToolImages ?? options.acceptToolImages,
    });
    sendJson(response, 201, { image: result });
    return;
  }

  if (request.method === "POST" && url.pathname === "/images/edit") {
    const body = await readJson(request);
    const result = await generateImageFile({
      prompt: body.prompt,
      imagePath: body.imagePath ?? body.image,
      imagePaths: body.imagePaths,
      filename: body.filename,
      outputDir: body.outputDir ?? options.outputDir,
      outputPath: body.outputPath,
      cwd: body.cwd ?? options.cwd,
      threadModel: body.threadModel ?? body.model ?? options.threadModel ?? options.model,
      timeoutMs: body.timeoutMs ?? options.timeoutMs,
      command: body.command ?? options.command,
      effort: body.effort,
      sandbox: body.sandbox ?? options.sandbox,
      acceptToolImages: body.acceptToolImages ?? options.acceptToolImages,
    });
    sendJson(response, 201, { image: result });
    return;
  }

  sendJson(response, 404, {
    error: {
      message: "Not found",
    },
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function statusFromError(error) {
  if (error && typeof error === "object" && Number.isInteger(error.statusCode)) {
    return error.statusCode;
  }
  return 500;
}
