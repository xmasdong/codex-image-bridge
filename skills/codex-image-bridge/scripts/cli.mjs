#!/usr/bin/env node
import { getAuthStatus, generateImageFile } from "./image-service.mjs";
import { startServer } from "./server.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";

try {
  if (command === "auth") {
    const status = await getAuthStatus({
      command: args.command,
      timeoutMs: args.timeoutMs,
      refreshToken: args.refreshToken !== "false",
    });
    writeJson({
      ok: Boolean(status.account),
      status,
    });
  } else if (command === "generate") {
    const prompt = args.prompt ?? args.p;
    if (!prompt) {
      throw new Error("缺少 --prompt");
    }
    const result = await generateImageFile({
      prompt,
      outputPath: args.out,
      outputDir: args.outputDir,
      filename: args.filename,
      cwd: args.cwd,
      threadModel: args.threadModel ?? args.model,
      timeoutMs: args.timeoutMs,
      command: args.command,
      effort: args.effort,
      sandbox: args.sandbox,
      acceptToolImages: args.acceptToolImages === "true",
    });
    writeJson({ image: result });
  } else if (command === "edit") {
    const prompt = args.prompt ?? args.p;
    const imagePath = args.image ?? args.imagePath ?? args.input;
    if (!prompt) {
      throw new Error("缺少 --prompt");
    }
    if (!imagePath) {
      throw new Error("缺少 --image");
    }
    const result = await generateImageFile({
      prompt,
      imagePath,
      outputPath: args.out,
      outputDir: args.outputDir,
      filename: args.filename,
      cwd: args.cwd,
      threadModel: args.threadModel ?? args.model,
      timeoutMs: args.timeoutMs,
      command: args.command,
      effort: args.effort,
      sandbox: args.sandbox,
      acceptToolImages: args.acceptToolImages === "true",
    });
    writeJson({ image: result });
  } else if (command === "serve") {
    const { host, port } = await startServer({
      host: args.host,
      port: args.port,
      outputDir: args.outputDir,
      cwd: args.cwd,
      threadModel: args.threadModel ?? args.model,
      timeoutMs: args.timeoutMs,
      command: args.command,
      sandbox: args.sandbox,
    });
    console.log(`Codex Image Bridge listening on http://${host}:${port}`);
  } else {
    printHelp();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function writeJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`Codex Image Bridge

用法:
  node src/cli.js auth
  node src/cli.js generate --prompt "Full body demon, transparent background" --out outputs/demon.png
  node src/cli.js edit --image inputs/mother.png --prompt "Keep identity, raise both wings slightly" --out outputs/frame-02.png
  node src/cli.js serve --port 4020

常用参数:
  --prompt       生图提示词
  --image        母图路径，配合 edit 使用
  --out          输出 PNG 文件路径
  --filename     输出文件名，配合 --output-dir 使用
  --output-dir   输出目录，默认 outputs
  --thread-model Codex 对话/thread 模型；默认 CODEX_THREAD_MODEL 或 gpt-5.5
  --model        旧参数名，等同于 --thread-model
  --timeout-ms   生图超时毫秒数
  --sandbox      Codex thread 沙盒，默认 danger-full-access，用来匹配 Codex App 原生生图链路
  --command      Codex CLI 命令，默认 codex
`);
}
