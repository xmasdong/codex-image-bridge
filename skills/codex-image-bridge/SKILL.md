---
name: codex-image-bridge
description: Use when the user wants to generate PNG images through Codex app-server using the machine's managed ChatGPT/Codex login, check Codex auth status, save generated images to disk, or expose the generator as CLI, HTTP, or MCP. The skill is self-contained and includes bundled scripts.
---

# Codex Image Bridge

Use bundled scripts in this skill to generate images through `codex app-server`.

## When To Use

- The user asks to generate an image using Codex auth / ChatGPT managed login.
- The user asks to check whether Codex app-server auth works.
- The user wants a PNG saved locally for another tool, game asset pipeline, or review.
- The user asks to expose the same generator through CLI, HTTP, or MCP.

## Script Location

Resolve paths relative to this `SKILL.md` file:

- CLI: `scripts/cli.mjs`
- MCP server: `scripts/mcp-server.mjs`

When running from the skill directory, use `node scripts/cli.mjs ...`.

## Validation

From the skill directory:

```bash
node --check scripts/cli.mjs
node scripts/cli.mjs auth
```

`auth` is usable if it returns a current `account`. `tokenPresent` may be `false`; that only means Codex app-server did not expose the token field. It does not necessarily block image generation.

## Generate One Image

```bash
node scripts/cli.mjs generate \
  --prompt "full body demon silhouette, transparent background, no text" \
  --out outputs/demon.png
```

Return the generated `filePath`, image dimensions, and any important `codex.revisedPrompt`.

## Start HTTP API

```bash
node scripts/cli.mjs serve --port 4020
```

Useful endpoints:

- `GET /health`
- `GET /auth/status`
- `POST /images/generate`

Example:

```bash
curl -X POST http://127.0.0.1:4020/images/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"full body demon silhouette, transparent background, no text","filename":"demon.png"}'
```

## MCP

Run the bundled MCP server with:

```bash
node scripts/mcp-server.mjs
```

It exposes:

- `codex_auth_status`
- `codex_generate_image`

Prefer MCP when the host client can call tools directly. Prefer CLI for quick local verification.

## Safety Notes

- Do not read or print local Codex token files.
- Do not claim `tokenPresent=false` means generation is impossible; perform a small generation test if needed.
- Generated files go to `outputs/` by default.
