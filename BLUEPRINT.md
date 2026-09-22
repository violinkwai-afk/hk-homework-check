# hk-homework-check — Blueprint

Generated 2026-09-22, verified against the actual repo (git log, git
status, git diff, `node --test`, live Worker probe, `wrangler
deployments list`) rather than recalled from memory alone. Where this
corrects something a saved memory said, that's called out explicitly —
memories decay fast on this project.

## 1. What this is

A parent photographs a completed homework page; the AI marks each
question ✓/✗ directly on the photo and hands it back. Two live-code
entry points share one backend philosophy but are **not yet unified**
(see §4):

- **Website** (`/api/check` + `/api/verify`) — Sonnet-based real
  judgment, phase-split (fast pass returns immediately, a second pass
  resolves anything still ambiguous). This is the older, more expensive
  path.
- **Telegram bot** (`/api/mark`) — OCR (Qwen3-VL-235B) → deterministic
  code verification → fallback to `needs_review`, never a guessed
  verdict. This is the newer, cheaper path and the one all future work
  is converging on (**confirmed standing direction**: "理解啱，全部嘅
  工作都要考慮返呢一個原則嚟做" — every future change should be judged
  against this one-shared-backend vision).

**No real users yet** on either path — this is still the owner's own
testing. Treat any "production impact" framing as hypothetical until
told otherwise.

## 2. Architecture, as it actually stands

```
Photo in ──▶ /api/check (website, Sonnet)         [older path]
         ──▶ /api/mark  (Telegram, Qwen OCR)       [newer path, converging point]
                 │
                 ├─ downscaleForCheapTier (640px, before OCR only)
                 ├─ callQwenOcrText → parseOcrLine (label=printed|answer)
                 ├─ verifyMath (arithmetic, remainder notation,
                 │    blank-token substitution for "?"/"□")
                 ├─ NEW, uncommitted: verifyNumberWordConversion,
                 │    verifyComparisonSymbol, + more (see §3)
                 ├─ findBboxForItem (Vision OCR bbox lookup)
                 └─ annotateImage (Photon, stamps ✓/✗ on the photo)
```

**Repos:**
- `/home/claude_user/hk-homework-check` — the real product. Cloudflare
  Worker, `git push origin main` auto-deploys (Workers Builds/GitHub
  integration), any other branch → preview URL only.
- `/home/claude_user/hk-homework-grader-node` — **a real, load-bearing
  infrastructure piece, not a toy/abandoned rewrite** (this was NOT in
  any saved memory — found only by reading the repo). A large (~300-
  400KB) homework photo sent to OpenRouter reliably hung/timed out when
  called *from the Cloudflare Worker runtime specifically*; the exact
  same call from a plain Node process didn't. Rather than keep fighting
  a Workers-runtime networking issue, the model call itself was moved
  here — a thin, stateless Node proxy on Railway (`POST /grade`, Qwen-
  first/DeepSeek-fallback). The Worker still owns all grading logic
  (prompts, verification, rotation, annotation); this is purely "run
  the model call somewhere that doesn't hang." **Confirmed NOT wired in
  yet**: `grep -n "railway\|grader-node" src/worker.js` returns nothing
  — `/api/mark` still calls the model directly from the Worker. The
  proxy exists, is scaffolded, and is presumably deployed to Railway,
  but the Worker isn't calling it, so the original large-photo hang risk
  this was built to fix is still live in the current code path.
- Sibling project `/home/claude_user/hk-maths` — same domain (HK
  primary maths, photo grading) but a deliberately different product
  and a deliberately different philosophy: hk-maths uses worksheet-
  bank/answer-key matching; hk-homework-check has an explicit, resolved
  **hard rule against ever doing that** ("冇一個題型係要靠已知嘅答案
  Key" — no question type may rely on a pre-known key, because this
  product is FOR people who don't have one). Don't cross-pollinate that
  pattern between the two projects.

## 3. Current real state (verified, not recalled)

**Correction to a stale memory**: `project_hk_homework_check_current_state.md`
says local `main` (`fabb0af`, "Telegram MVP") was NOT pushed and
`origin/main` was still at `0774b2c`. As of right now, `git status`
shows local `main` **is** "up to date with origin/main" — the push has
since happened. Whether the Telegram *webhook* has actually been
registered with the real bot (a separate manual step from deploying
code) is still unconfirmed in this pass.

**Uncommitted work sitting in the working tree right now** (not in any
memory file — found only by reading `git diff`/`git status`):
1. `src/worker.js` — a real, previously-undocumented **subtraction bug
   fix**: `evalArithmetic`'s tokenizer greedily swallowed the "-" in
   e.g. "328-214" as a unary sign on the next number instead of a binary
   operator, meaning **plain two-number subtraction silently evaluated
   to `null`** (never actually verified) until today's fix (a lookbehind
   regex). No existing test happened to cover this path before. This is
   a significant correctness fix sitting unmerged.
2. `src/worker.js` — ~850 new lines: a library of **new question-type
   verifiers** (number-word conversion 一/two ↔ digit, `>`/`<` comparison
   symbols, and more per the diff) built from 5 real published HK
   workbooks the user sent in over 2026-09-11 to 09-18. Explicitly **not
   wired into the dispatcher yet** — standalone, tested functions,
   pending an integration decision (how OCR would represent "which MC
   option did the student pick", and a real per-type detector so these
   don't misfire on an ordinary math item).
3. `test/new-question-types.test.js` (untracked, 34KB) — tests for the
   above.
4. `DEPLOYMENT.md` (untracked) — a rollback/deploy runbook draft,
   content-complete, marked "not yet reviewed/approved."
5. `benchmark/` (untracked, real scaffolding, not meant to be committed
   per its own README) — `question-type-library.md` (34KB "single
   source of truth" running catalog of every question type found, its
   solvability tier, and code status — actively updated today, most
   recent edit 17:09), `speed-log.md`, `log.md`, real photo sets under
   `photos/` and `external_pdfs/`.

**Full local test suite: 154/154 passing** (`node --test test/*.test.js`
— note the glob matters, `node --test test/` alone fails with
`MODULE_NOT_FOUND`, that's a shell/CLI quirk not a real failure).

**A genuine, diagnosed technical limit found today** (in
`benchmark/question-type-library.md`, not memory): porting the
Python/OpenCV visual-derivation prototypes to this repo's actual JS/
Photon toolchain is a real yes-for-some/no-for-others split, not a
blanket answer —
- Fish-length/size comparison (connected-component measurement) ports
  cleanly to Photon: 112px/257px vs Python's 121px/253px, same
  conclusion.
- Clock-hand reading does **not** port cleanly: Photon has no Hough-
  line-transform equivalent, only 4 fixed-angle line detectors. Two
  independent JS approaches were tried and both failed the "0
  confidently wrong" bar the Python version cleared. Root cause is
  structural (working from scattered edge pixels instead of Python's
  connected line segments loses the rim-circle-vs-hand distinction), not
  a tuning problem — this is real signal for scoping future
  diagram/visual-comprehension work, not a temporary gap.

## 4. Standing product principles (apply to every future decision)

1. **One shared backend eventually** — website, Telegram, and any
   future interface (WhatsApp/Signal) are thin interfaces over one OCR
   → code → AI-fallback pipeline. Currently `/api/check` and `/api/mark`
   are still genuinely different pipelines; migrating the website onto
   `/api/mark`-style logic is a real, not-yet-started task.
2. **No answer-key/worksheet-bank lookup, ever** — resolved hard rule,
   the opposite of hk-maths' approach. A question type that seems to
   need a fixed key instead needs real-time AI visual derivation
   (genuinely read the ruler, genuinely count the objects) or an honest
   `needs_review`.
3. **`needs_review` is a correct output, never a failure to eliminate.**
   Same discipline across math, the new question-type verifiers, and
   the (unbuilt) Chinese/English judgment layer.
4. **Teacher-parity is the real north star, with no fixed finish date**:
   "老師改到嘅功課，呢個app都要改到" — whatever a real teacher could
   mark without an answer key, this app should eventually handle too.
   Explicitly NOT "cover the N benchmark photos" — new question types
   keep appearing forever, so no "100% coverage" date should ever be
   stated as achievable.
5. **Sonnet is being shelved for cost, not quality** — don't reintroduce
   "Sonnet is worse" as a reason for anything; it isn't the reason.
6. **Never ask the user to verify a fix on the real production URL** —
   use `?demoId=`/`/api/test-noai-check` or local mocked tests. (This
   was broken once, justifiably, during a live incident — not a general
   exception.)
7. **Real model-swap testing costs real money** — confirm with the user
   before each new candidate, per their explicit "don't give up after
   one failure" instruction: keep working the list, don't stop after a
   single rejection, but don't spend without asking either.

## 5. Where to look for more detail

- Full technical/decision history (every model tried, every real A/B/C/D
  benchmark result): `project_hk_homework_check_architecture.md` memory
  — long, chronological, worth skimming for the specific incident you
  care about rather than reading start to end.
- Roadmap with explicit 1-week/1-month/6-month framing:
  `project_hk_homework_check_roadmap.md` memory (see TICKETS.md in this
  repo for the same content turned into concrete tickets).
- Chinese/English verification design (not built):
  `project_hk_homework_check_chinese_english_verifier_design.md` memory.
- Small known code issues + UX notes, nothing acted on yet:
  `project_hk_homework_check_code_notes.md` memory.
- This project's own running question-type catalog:
  `benchmark/question-type-library.md` (in-repo, most current source for
  "what question types exist and what's their status").

See `TICKETS.md` (same repo) for the triage + ticket breakdown.
