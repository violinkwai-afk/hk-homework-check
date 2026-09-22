# 速度紀錄 (Speed Log)

Started 2026-09-22. Every change that could plausibly affect `/api/mark`'s
real speed gets one row here — before/after, on the same benchmark
photos, so numbers are comparable over time. This is the systematic
answer to "how much did each change affect speed" instead of scattered
one-off mentions in chat/`log.md`.

**Two layers**:
1. This file — a manual before/after table, kept up to date by hand
   whenever a change might affect timing.
2. `perf/mark-timing-breakdown-clean` (written+tested, not yet deployed —
   see the Control Room dashboard's pending list) — once deployed, every
   REAL production request automatically logs its own timing breakdown
   (`downscaleMs`/`qwenRequestMs`/`verifyMs`/`mapMs`/`totalMs`) with zero
   manual work. That's the long-term fix for this — deploying it turns
   this file from "must remember to update" into "can just read the
   live logs any time". Worth doing for this reason alone, separate
   from its original observability purpose.

## Rule for what counts as "affects speed"

- **AI/network calls** (OCR model, Vision API) — these dominate total
  time and always deserve a real before/after entry.
- **Pure code/CPU-only logic** (parsing, verification math, no I/O) —
  negligible by nature; log it as "CPU-only, no measurable I/O change
  expected" rather than re-running a full real-photo benchmark each
  time, unless there's a specific reason to suspect otherwise (e.g. a
  loop that could scale badly with input size).

## Log

| Date | Change | Type | Before | After | Notes |
|---|---|---|---|---|---|
| 2026-09-22 | `downscaleForCheapTier(640px)` before Qwen OCR | AI-call-affecting | A 6.39-16s / B 5.56s / C 3.26-8.5s / D 8.78-16.1s | A 6.39s / B 3.80s / C 2.93s / D 7.15s | Real benchmark, meaningful across-the-board drop, no accuracy regression |
| 2026-09-22 | Per-page Qwen calls (was 1 combined multi-image call) | AI-call-affecting | multi-page 15s timeout, 2/3 failures | D: all 4 pages succeed, 7.15s total | Fixes timeout AND makes page-attribution structural |
| 2026-09-22 | Tier 1 blank-token substitution (math verifier) | CPU-only | A 7.48s / B 8.73s / D 12.43s | same range (no change) | Confirmed: pure logic addition, no I/O, latency unaffected |
| 2026-09-22 | 20 new Tier-A verifier functions (number-word, comparison, parity, multi-blank, sequence, Sudoku, price/word-problem, etc.) | CPU-only, not yet wired to live dispatcher | n/a — not live yet | n/a | Expected: negligible once wired (same reasoning as Tier 1 above — pure functions, no network calls) — should be CONFIRMED with a real check once actually wired in, not just assumed |
| 2026-09-22 | `mark_unresolved_question` logging (needs_review items log their printed question) | CPU-only (one extra `console.log` per unresolved item) | n/a — not deployed yet | n/a | `console.log` itself has near-zero cost in Workers; worth a real check post-deploy anyway since "near-zero" isn't "verified zero" |

## Not yet logged / still pending real numbers

- Provider routing, model swaps already tried (Qwen 8B/30B/32B, DeepSeek,
  Gemini Flash-Lite) have their real numbers in `log.md` and
  `project_hk_homework_check_architecture.md` — not duplicated here to
  avoid two sources of truth; this file is for changes to the pipeline
  itself, not model candidates.
