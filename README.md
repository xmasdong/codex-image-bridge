# Codex Image Bridge

[简体中文](README.md) | [English](README.en.md)

一个独立的 Codex 生图桥接项目。它通过 `codex app-server --listen stdio://` 使用 Codex Desktop / ChatGPT 托管登录态，不读取本地 token 文件，也不需要 OpenAI API Key。

## 能做什么

- 检查 Codex 托管授权是否可用
- 通过 Codex app-server 发起图片生成
- 把返回的 PNG base64 保存成本地文件
- 提供 JS SDK、CLI、HTTP API、MCP Server 和自包含 Claude/agent skill

## 快速使用

```bash
cd codex-image-bridge
npm run check
npm run auth
node src/cli.js generate --prompt "Full body demon silhouette, transparent background, no text" --out outputs/demon.png
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

## MCP Server

本项目内置一个零依赖 MCP stdio server：

```bash
npm run mcp
```

它暴露两个工具：

- `codex_auth_status`: 检查 Codex app-server 是否能读到当前账号
- `codex_generate_image`: 生成一张 PNG 并保存到本地

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
```

## 环境变量

复制 `.env.example` 里的变量按需配置。这个项目本身不会自动读取 `.env` 文件；如果需要，可以在 shell 中导出变量，或用你自己的进程管理器加载。

关键变量：

- `CODEX_IMAGE_COMMAND`: Codex CLI 命令，默认 `codex`
- `CODEX_THREAD_MODEL`: Codex 对话 / thread 模型，默认 `gpt-5.5`。它不是生图模型
- `CODEX_IMAGE_TIMEOUT_MS`: 生图超时，默认 120 秒
- `CODEX_IMAGE_PORT`: HTTP 服务端口，默认 4020
- `CODEX_IMAGE_OUTPUT_DIR`: 生成 PNG 文件的默认输出目录

## 注意

这个桥接层依赖当前机器已经登录 Codex / ChatGPT。它不是 OpenAI API Key 封装，也不会绕过 Codex 授权。

## 开源协议与免责声明

本项目使用 [MIT License](LICENSE) 开源。

本项目是独立开源项目，不是 OpenAI 官方产品，也不代表 OpenAI 背书。使用者需要自行遵守相关服务条款、政策、使用限制，以及生成内容可能涉及的第三方权利、平台规则和当地法律。完整免责声明见 [DISCLAIMER.md](DISCLAIMER.md)。
