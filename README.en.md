# Codex Image Bridge

[简体中文](README.md) | [English](README.en.md)

A standalone bridge for generating PNG images through `codex app-server --listen stdio://`.

It uses the managed Codex Desktop / ChatGPT login on the current machine. It does not read local token files, does not require an OpenAI API key, and does not try to bypass Codex authentication.

## What It Does

- Checks whether the managed Codex / ChatGPT auth state is available
- Starts image generation through Codex app-server
- Saves the returned PNG base64 payload to a local file
- Provides a JS SDK, CLI, HTTP API, MCP server, and self-contained Claude/agent skill

## Quick Start

```bash
cd codex-image-bridge
npm run check
npm run auth
node src/cli.js generate --prompt "Full body demon silhouette, transparent background, no text" --out outputs/demon.png
```

Start the HTTP server:

```bash
npm run serve
```

Default URL:

```text
http://127.0.0.1:4020
```

## HTTP API

Health check:

```bash
curl http://127.0.0.1:4020/health
```

Auth check:

```bash
curl http://127.0.0.1:4020/auth/status
```

`ok=true` means Codex app-server can read the current Codex / ChatGPT account. `tokenPresent` only reports whether app-server exposes a token field; it is not the only signal for whether image generation can work.

Generate an image:

```bash
curl -X POST http://127.0.0.1:4020/images/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Full body demon silhouette, transparent background, no text","filename":"demon.png"}'
```

The response includes:

- `filePath`: saved PNG path
- `uri`: `file://` URI
- `width` / `height`
- `sha256`
- Codex `threadId` / `turnId` / `imageId`

## Model Parameter

You usually do not need to pass `threadModel`.

This project does not call a standalone image model API. It creates a Codex conversation through Codex app-server, then Codex triggers image generation during the turn. The image generation model is routed internally by Codex.

`threadModel` means the optional Codex conversation / thread model. It is not the image generation model. The current default thread model is `gpt-5.5`.

Recommended usage:

- Pass only `prompt`, output path, timeout, and other generation options
- Let the bridge use the default `gpt-5.5` thread model
- Override the conversation model only when you explicitly need to, using `--thread-model`, HTTP/MCP field `threadModel`, or `CODEX_THREAD_MODEL`
- `--model`, `model`, and `CODEX_IMAGE_MODEL` are deprecated compatibility aliases

## MCP Server

The project includes a zero-dependency MCP stdio server:

```bash
npm run mcp
```

It exposes two tools:

- `codex_auth_status`: checks whether Codex app-server can read the current account
- `codex_generate_image`: generates one PNG and saves it locally

Example Claude Desktop / MCP client config:

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

The same example is available in `claude-desktop-mcp.example.json`.

## Claude / Agent Skill

The skill package lives at:

```text
skills/codex-image-bridge
```

It includes a `SKILL.md` for Claude or other skill-aware agents. The skill explains how to check auth, generate images, start the HTTP API, and expose the bridge through MCP.

The skill is self-contained. Its runnable scripts are bundled in:

```text
skills/codex-image-bridge/scripts
```

After copying the skill directory into a client skills folder, it does not need the repository-level `src/` directory.

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

## Environment Variables

Use `.env.example` as a reference. This project does not automatically load `.env` files; export variables in your shell or load them through your own process manager if needed.

Key variables:

- `CODEX_IMAGE_COMMAND`: Codex CLI command, defaults to `codex`
- `CODEX_THREAD_MODEL`: Codex conversation / thread model, defaults to `gpt-5.5`. This is not an image generation model
- `CODEX_IMAGE_TIMEOUT_MS`: image generation timeout, defaults to 120 seconds
- `CODEX_IMAGE_PORT`: HTTP server port, defaults to 4020
- `CODEX_IMAGE_OUTPUT_DIR`: default output folder for generated PNG files

## Notes

This bridge depends on a working Codex / ChatGPT login on the current machine. It is not an OpenAI API key wrapper and does not expose or persist auth tokens.

## License and Disclaimer

This project is released under the [MIT License](LICENSE).

This is an independent open source project. It is not an official OpenAI product and is not endorsed by OpenAI. Users are responsible for complying with applicable service terms, policies, usage limits, third-party rights, platform rules, and local laws related to generated content. See [DISCLAIMER.md](DISCLAIMER.md) for the full disclaimer.
