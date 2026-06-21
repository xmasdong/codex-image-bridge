# Codex Image Bridge

[简体中文](README.md) | [English](README.en.md)

一个独立的 Codex 生图桥接项目。它通过 `codex app-server --listen stdio://` 使用 Codex Desktop / ChatGPT 托管登录态，不读取本地 token 文件，也不需要 OpenAI API Key。

## 能做什么

- 检查 Codex 托管授权是否可用
- 通过 Codex app-server 发起图片生成
- 以本地母图为视觉参考，生成编辑后的新 PNG
- 把返回的 PNG base64 保存成本地文件
- 提供 JS SDK、CLI、HTTP API、MCP Server 和自包含 Claude/agent skill

## 快速使用

```bash
cd codex-image-bridge
npm run check
npm run auth
node src/cli.js generate --prompt "Full body demon silhouette, transparent background, no text" --out outputs/demon.png
node src/cli.js edit --image outputs/demon.png --prompt "Keep the same identity and silhouette, only raise both wings slightly" --out outputs/demon-frame-02.png
```

启动 HTTP 服务：

```bash
npm run serve
```

默认地址：

```text
http://127.0.0.1:4020
```

## HTTP API

检查服务：

```bash
curl http://127.0.0.1:4020/health
```

检查授权：

```bash
curl http://127.0.0.1:4020/auth/status
```

`ok=true` 表示 Codex app-server 能读到当前 ChatGPT/Codex 账号；`tokenPresent` 只是说明 app-server 是否暴露了 token 字段，不作为能否生图的唯一依据。

生成图片：

```bash
curl -X POST http://127.0.0.1:4020/images/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Full body demon silhouette, transparent background, no text","filename":"demon.png"}'
```

以母图为参考生成编辑图：

```bash
curl -X POST http://127.0.0.1:4020/images/edit \
  -H 'Content-Type: application/json' \
  -d '{"imagePath":"outputs/demon.png","prompt":"Keep the same identity and silhouette, only raise both wings slightly","filename":"demon-frame-02.png"}'
```

返回结果会包含：

- `filePath`: 保存后的 PNG 路径
- `uri`: `file://` URI
- `width` / `height`
- `sha256`
- Codex `threadId` / `turnId` / `imageId`

## 关于模型参数

默认情况下不需要传 `threadModel`。这个项目不是直接调用某个图片模型 API，而是通过 Codex app-server 创建一次 Codex 会话，再由 Codex 在 turn 中触发图片生成能力。当前默认 Codex 对话模型是 `gpt-5.5`。

因此 `threadModel` 只表示可选的 Codex 对话 / thread 模型，不是生图模型。图片生成模型由 Codex 内部路由，bridge 不指定也不假设具体是哪一个。

推荐用法：

- 生成图片时只传 `prompt`、输出路径、超时等参数
- 不配置时默认使用 `gpt-5.5`
- 只有明确需要覆盖 Codex 对话模型时，才传 `--thread-model`、HTTP/MCP 字段 `threadModel`，或设置 `CODEX_THREAD_MODEL`
- `--model` / `model` / `CODEX_IMAGE_MODEL` 只是旧版兼容别名，不推荐继续使用

## 当前生图链路

`auth` 成功只代表 Codex app-server 可以读到当前托管登录态，不等于已经完成了一次图片生成验证。

bridge 默认按 Codex Desktop 自己的生图线程方式启动：`danger-full-access` 沙盒、`threadSource: "user"`、`friendly` personality，并从 app-server 通知里接收原生 `imageGeneration` / `image_generation_call` 结果。Codex App 自己也会把同一张生成图保存到 `~/.codex/generated_images/<threadId>/ig_*.png`，bridge 会把这个 `savedPath` 放进返回结果的 `codex.savedPath`。

当前 bridge 默认仍然是严格模式：只接受 Codex 原生 `image_generation_call` / `imageGeneration`，或明确的内置 `image_gen` 工具输出。如果环境没有暴露原生生图能力，命令会明确失败，例如：

```text
Codex app-server is reachable, but native image generation / built-in image_gen is unavailable in this app-server turn.
```

可以显式加 `--accept-tool-images true` 或设置 `CODEX_IMAGE_ACCEPT_TOOL_IMAGES=1` 接收其它工具返回的 PNG，但这只适合诊断或占位，不应当当作生产级模型生图能力。返回结果里的 `codex.source` 会标明来源；如果看到 `mcp__node_repl/js`，说明它是工具/代码 fallback，不是原生图片模型生成。

如果你需要诊断沙盒差异，可以传 `--sandbox read-only` / `--sandbox workspace-write` / `--sandbox danger-full-access`，或设置 `CODEX_IMAGE_SANDBOX`。默认不要改，除非你在验证 app-server 行为。

## 母图编辑

`edit` 会把本地图片路径作为 `localImage` 输入传给 Codex，再配合文本 prompt 生成新的 PNG。它适合做母图驱动的素材迭代，例如：

- 保持角色身份、轮廓和画风，只改变翅膀、手、尾巴等局部姿态
- 基于同一母图生成动画关键帧
- 对生成图做二次修正，例如清理边缘、调整构图、统一透明背景

CLI 示例：

```bash
node src/cli.js edit \
  --image outputs/demon.png \
  --prompt "Keep the same character identity, silhouette, palette, and transparent background. Only move the wing tips upward slightly." \
  --out outputs/demon-frame-02.png
```

HTTP 使用 `POST /images/edit`，MCP 使用 `codex_edit_image`。

注意：这是一条“以母图作为视觉参考重新生成”的链路，不是逐像素原地修改，也不是带 mask 的局部重绘。它适合做母图驱动的变体和动画关键帧；如果需要严格锁定骨架或局部区域，后续还需要再叠加 mask、分层或骨架约束工作流。

## MCP Server

本项目内置一个零依赖 MCP stdio server：

```bash
npm run mcp
```

它暴露两个工具：

- `codex_auth_status`: 检查 Codex app-server 是否能读到当前账号
- `codex_generate_image`: 生成一张 PNG 并保存到本地
- `codex_edit_image`: 以本地母图为参考生成编辑后的 PNG

Claude Desktop / 其它 MCP 客户端可参考：

```json
{
  "mcpServers": {
    "codex-image-bridge": {
      "command": "node",
      "args": [
        "/absolute/path/to/codex-image-bridge/src/mcp-server.js"
      ],
      "env": {
        "CODEX_IMAGE_TIMEOUT_MS": "120000",
        "CODEX_IMAGE_OUTPUT_DIR": "outputs"
      }
    }
  }
}
```

同样的配置也放在 `claude-desktop-mcp.example.json`。

## Claude / Agent Skill

Claude/agent skill 包位于：

```text
skills/codex-image-bridge
```

它提供了给 Claude 使用的 `SKILL.md`，说明如何检查授权、生成图片、启动 HTTP API，以及如何走 MCP。需要安装到 Claude 或其它支持 skill 的客户端时，把这个目录复制到对应客户端的 skills 目录即可。

这个 skill 是自包含的，脚本已经复制在：

```text
skills/codex-image-bridge/scripts
```

复制 skill 目录后，不需要再依赖仓库外层的 `src/` 目录。

## JS SDK

```js
import { readCodexAuthStatus, generateCodexImage } from "./src/codex-app-server.js";
import { generateImageFile } from "./src/image-service.js";

const auth = await readCodexAuthStatus();
console.log(auth);

const result = await generateImageFile({
  prompt: "Full body monster sprite, transparent background",
  outputPath: "outputs/monster.png"
});
console.log(result.filePath);

const edited = await generateImageFile({
  imagePath: "outputs/monster.png",
  prompt: "Keep the same monster, only curl the tail slightly upward",
  outputPath: "outputs/monster-frame-02.png"
});
console.log(edited.filePath);
```

## 环境变量

复制 `.env.example` 里的变量按需配置。这个项目本身不会自动读取 `.env` 文件；如果需要，可以在 shell 中导出变量，或用你自己的进程管理器加载。

关键变量：

- `CODEX_APP_SERVER_COMMAND`: Codex app-server 命令。默认会优先使用 macOS Codex Desktop 自带二进制，其次使用 `$HOME/.codex/plugins/.plugin-appserver/codex`，最后才回退到 PATH 里的 `codex`
- `CODEX_IMAGE_COMMAND`: 旧变量名，仍可覆盖 Codex app-server 命令
- `CODEX_THREAD_MODEL`: Codex 对话 / thread 模型，默认 `gpt-5.5`。它不是生图模型
- `CODEX_IMAGE_SANDBOX`: Codex thread 沙盒，默认 `danger-full-access`，用于匹配 Codex Desktop 原生生图链路
- `CODEX_IMAGE_TIMEOUT_MS`: 生图超时，默认 120 秒
- `CODEX_IMAGE_APP_SERVER_TIMEOUT_MS`: app-server 单次请求超时，默认 30 秒
- `CODEX_IMAGE_ACCEPT_TOOL_IMAGES`: 设为 `1` 时允许接收非原生工具返回的图片。默认关闭
- `CODEX_IMAGE_PORT`: HTTP 服务端口，默认 4020
- `CODEX_IMAGE_OUTPUT_DIR`: 生成 PNG 文件的默认输出目录

## 注意

这个桥接层依赖当前机器已经登录 Codex / ChatGPT。它不是 OpenAI API Key 封装，也不会绕过 Codex 授权。

## 开源协议与免责声明

本项目使用 [MIT License](LICENSE) 开源。

本项目是独立开源项目，不是 OpenAI 官方产品，也不代表 OpenAI 背书。使用者需要自行遵守相关服务条款、政策、使用限制，以及生成内容可能涉及的第三方权利、平台规则和当地法律。完整免责声明见 [DISCLAIMER.md](DISCLAIMER.md)。
