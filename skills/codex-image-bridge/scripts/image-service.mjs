import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateCodexImage, readCodexAuthStatus } from "./codex-app-server.mjs";

export async function getAuthStatus(options = {}) {
  return readCodexAuthStatus(options);
}

export async function generateImageFile(options = {}) {
  if (!options.prompt || typeof options.prompt !== "string") {
    throw new Error("prompt is required");
  }

  const generated = await generateCodexImage(options.prompt, {
    command: options.command,
    cwd: options.cwd,
    effort: options.effort,
    imagePath: options.imagePath,
    imagePaths: options.imagePaths,
    threadModel: options.threadModel ?? options.model,
    timeoutMs: options.timeoutMs,
    sandbox: options.sandbox,
    acceptToolImages: options.acceptToolImages,
  });
  const bytes = Buffer.from(generated.resultBase64, "base64");
  const dimensions = readPngDimensions(bytes);
  const outputPath = resolveOutputPath(options);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);

  return {
    filePath: outputPath,
    uri: `file://${outputPath}`,
    mimeType: "image/png",
    width: dimensions.width,
    height: dimensions.height,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    codex: {
      threadId: generated.threadId,
      turnId: generated.turnId,
      imageId: generated.imageId,
      status: generated.status,
      revisedPrompt: generated.revisedPrompt,
      savedPath: generated.savedPath,
      model: generated.model,
      modelProvider: generated.modelProvider,
      source: generated.source,
    },
  };
}

export function readPngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error("PNG data must be a Buffer");
  }
  if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
    throw new Error("Codex image result is not a PNG");
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function resolveOutputPath(options) {
  if (options.outputPath) {
    return resolve(String(options.outputPath));
  }
  const outputDir = resolve(String(options.outputDir ?? process.env.CODEX_IMAGE_OUTPUT_DIR ?? "outputs"));
  const filename = safeFilename(options.filename ?? `codex-image-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.png`);
  return resolve(outputDir, filename.endsWith(".png") ? filename : `${filename}.png`);
}

function safeFilename(value) {
  return String(value)
    .replace(/[\\/]/g, "-")
    .replace(/[^a-z0-9._ -]+/giu, "-")
    .trim()
    .slice(0, 120) || "codex-image.png";
}
