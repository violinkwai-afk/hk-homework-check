# External dependencies

Every third-party service/API this project talks to, what it's for, and where its credentials live. Update this whenever a new external call is added.

| Service | What it's for | Credential | Where stored |
|---|---|---|---|
| OpenRouter (Qwen model) | The actual homework-marking AI — reads the photo, extracts questions/answers | `OPENROUTER_API_KEY` | Cloudflare Worker secret |
| Google Vision API | OCR for photo rotation-angle detection (word-level positions), separate from the OpenRouter marking call | `GOOGLE_VISION_API_KEY` | Cloudflare Worker secret |
| Telegram Bot API | The Telegram-based marking flow | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` | Cloudflare Worker secret |
| Cloudflare Workers KV (`RATE_LIMIT_KV`) | Rate limiting (`/api/check`, `/api/verify`, `/api/mark` each have their own bucket) + idempotency keys for demo requests | n/a | Cloudflare KV binding |
| `@cf-wasm/photon` | Image processing (rotation, crop, annotation, and today's abacus/fish-length experiments) — a library, not a network service | n/a (bundled dependency) | `package.json` |

## Built, but NOT currently wired into the live code path

- **`hk-homework-grader-node`** (separate repo: `/home/claude_user/hk-homework-grader-node`) — a Node.js proxy deployed on Railway, built specifically because large (~300-400KB) photos reliably hang when the model call is made directly from the Workers runtime. Confirmed via `grep` (2026-09-22) that `src/worker.js` never references it — the hang risk it exists to fix is still live in the real `/api/mark` path for large photos. See TICKETS.md item B2.

## Shared with a sibling project

The Secrets Store / KV setup is shared with `hk-maths` (a separate, related project) — no per-project isolation currently exists (see TICKETS.md item G6).
