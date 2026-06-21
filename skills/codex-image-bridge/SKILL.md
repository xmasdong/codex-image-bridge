---
name: codex-image-bridge
description: Use when the user wants to generate or edit PNG images through Codex app-server using the machine's managed ChatGPT/Codex login, use a source image as visual reference, check Codex auth status, save generated images to disk, or expose the generator as CLI, HTTP, or MCP. The skill is self-contained and includes bundled scripts.
---

# Codex Image Bridge

Use bundled scripts in this skill to generate or edit images through `codex app-server`.

## When To Use

- The user asks to generate an image using Codex auth / ChatGPT managed login.
- The user asks to edit an image using a mother/source image as visual reference.
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

Important: auth success only verifies the managed login. The bundled scripts start an app-like Codex Desktop thread (`danger-full-access`, `threadSource: "user"`, `friendly`) and default to strict mode: accept only native `image_generation_call` / `imageGeneration`, or explicit built-in `image_gen` output. If native generation is unavailable, report that clearly instead of treating tool/code output as success.

## Generate One Image

```bash
node scripts/cli.mjs generate \
  --prompt "full body demon silhouette, transparent background, no text" \
  --out outputs/demon.png
```

Return the generated `filePath`, image dimensions, and any important `codex.revisedPrompt`.

On success, check `codex.source`; it should normally be `imageGeneration` or `image_generation_call`. `codex.savedPath` points to the original file saved by Codex Desktop under `~/.codex/generated_images/...` when app-server provides it. For diagnostics only, `--accept-tool-images true` or `CODEX_IMAGE_ACCEPT_TOOL_IMAGES=1` can accept other tool-returned PNGs, but `mcp__node_repl/js` means a tool/code fallback, not native model image generation.

## Edit From A Source Image

Use `edit` when the user wants to keep a mother image as reference and change only specific details.

```bash
node scripts/cli.mjs edit \
  --image outputs/demon.png \
  --prompt "keep the same character identity, silhouette, palette, and transparent background; only raise both wing tips slightly" \
  --out outputs/demon-frame-02.png
```

Prefer prompts that explicitly say what must stay unchanged and what can move. For game animation frames, mention "same identity", "same silhouette", "same palette", "transparent background", and the exact local pose change.

This is reference-image regeneration, not pixel-level in-place editing or masked inpainting. Use it for mother-image-driven variants and keyframes. Tell the user if they need stricter skeleton, mask, or layer control for production animation.

## Start HTTP API

```bash
node scripts/cli.mjs serve --port 4020
```

Useful endpoints:

- `GET /health`
- `GET /auth/status`
- `POST /images/generate`
- `POST /images/edit`

Example:

```bash
curl -X POST http://127.0.0.1:4020/images/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"full body demon silhouette, transparent background, no text","filename":"demon.png"}'
```

```bash
curl -X POST http://127.0.0.1:4020/images/edit \
  -H 'Content-Type: application/json' \
  -d '{"imagePath":"outputs/demon.png","prompt":"keep the same character identity and silhouette; only curl the tail slightly upward","filename":"demon-frame-02.png"}'
```

## MCP

Run the bundled MCP server with:

```bash
node scripts/mcp-server.mjs
```

It exposes:

- `codex_auth_status`
- `codex_generate_image`
- `codex_edit_image`

Prefer MCP when the host client can call tools directly. Prefer CLI for quick local verification.

## Safety Notes

- Do not read or print local Codex token files.
- Do not claim `tokenPresent=false` means generation is impossible; perform a small generation test if needed.
- Do not claim a non-native tool image is a successful production model generation. Check `codex.source`.
- Generated files go to `outputs/` by default.
