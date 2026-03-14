## Commands

```bash
cp .env.example .env    # First-time setup: copy env template
pnpm ci                  # Install dependencies
pnpm start               # Start both server + Electron app (concurrently)
pnpm run start:server    # Express API proxy only (port 13373)
pnpm run start:electron  # Electron app only
pnpm run make            # Build DMG for distribution
```

## Architecture

Two-process app:
- **Express server** (`src/server.js`, port 13373) — proxies requests to Recall.ai API to keep the API key server-side
- **Electron app** (main process: `src/main.js`, renderer: `src/renderer.js`) — built via electron-forge + webpack

## Key Files

| File | Role |
|------|------|
| `src/main.js` | Electron main process, IPC handlers, RecallAI SDK init |
| `src/server.js` | Express server, Recall.ai API proxy |
| `src/renderer.js` | Webpack renderer entry point |
| `src/preload.js` | Electron preload (context bridge) |
| `src/pages/note-editor/` | Note editor page |
| `forge.config.js` | Electron Forge config (signing, webpack, makers) |
| `webpack.main.config.js` | Webpack config for main process |
| `webpack.renderer.config.js` | Webpack config for renderer |

## Environment Variables

Required in `.env`:
- `RECALLAI_API_URL` — Recall.ai regional base URL (e.g., `https://us-east-1.recall.ai`)
- `RECALLAI_API_KEY` — Recall.ai API key
- `OPENAI_API_KEY` — (optional) OpenAI key for AI meeting summaries

## Gotchas

- `@recallai/desktop-sdk` is unpacked from asar (native module) — handled in `forge.config.js` via `asar.unpackDir`
- AI summaries use OpenAI (`gpt-5-mini`) — requires `OPENAI_API_KEY` in `.env`
- macOS signing uses a custom fork of `@electron/osx-sign` via the `overrides` field in `package.json`
- No linting configured (`pnpm run lint` is a no-op)
