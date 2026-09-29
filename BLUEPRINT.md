# hk-homework-check — Blueprint

**This is the ONE file for this project's current settled state and
design decisions.** Per explicit 2026-09-25 instruction: every new
conclusion updates THIS file, and any work on this project should be
checked against what's written here first — not re-derived from
conversational memory. Superseded content is deleted, not left stale
alongside the update.

Rewritten 2026-09-25 (previous version generated 2026-09-22), verified
against the actual repo (`git log`, `git status`, `node --test`) — not
recalled from memory alone.

## 1. What this is

A parent photographs a completed homework page; the AI marks each
question ✓/✗ directly on the photo and hands it back.

**CORRECTED 2026-09-30** (this section previously said the website still
primarily called `/api/check` and the migration to `/api/mark` was
blocked/not-yet-done — that was stale and got restated as fact in a live
conversation before being caught by the user spotting a contradiction
with an earlier 2026-09-27 answer; verified directly against
`website/index.html`'s actual fetch call sites, not just against
whether `/api/check`'s handler function still exists server-side):

- **Website's PRIMARY grading flow, since Ticket 32 (2026-09-27),
  already calls `/api/mark`** — same pipeline as the Telegram bot (AI
  OCR only, code judges deterministically, Jev/AI-fallback only for what
  code can't resolve). `submitBtn.onclick`'s `attemptOnce()` posts each
  page straight to `/api/mark`. Known regression from this swap
  (disclosed in the Ticket 32 code comment): `/api/mark` ignores
  `pageIndex`/`priorPagesContext`/`requestId`/`deviceId`/
  `rememberHandwriting`, so multi-page cross-page context and the
  "remember this handwriting" feature are gone on the website too.
- **`/api/check` still exists but is now a SECONDARY, narrow path**:
  only called by `restitchSplitPages` (re-solving a question that spans
  two page-boundary photos jointly, once both pages are already
  individually graded via `/api/mark`) — not the main per-page grading
  call anymore.
- **`/api/verify`** is a website-only "phase 2" pass: re-sends a page's
  image with just the items `/api/mark`'s response flagged as
  low-confidence (`needsVerify`), patches those verdicts in place. No
  Telegram equivalent.
- **Telegram bot** (`handleTelegramWebhook` → calls `handleMark()`
  directly, in-process, not via HTTP) — same `/api/mark` pipeline as the
  website's primary flow, just invoked as a direct function call instead
  of a fetch.

Net effect: website and Telegram now share the SAME primary grading
pipeline (`/api/mark`/`handleMark`) for the core "read + judge" step —
the "two separate pipelines, migration blocked" framing this file used
to have is gone. What's still genuinely separate is narrower than that:
cross-page stitching and the phase-2 verify pass only exist on the
website, not Telegram.

No confirmed real production users on either path as of this writing —
some field-testing has happened against real user-submitted photos (see
`~/.claude/channels/telegram/inbox`, ~260 real photos), but this hasn't
been independently confirmed as live production traffic vs. the owner's
own testing. Don't assert "real users" without checking current state.

## 2. Architecture

### 2a. Current, as actually deployed (corrected 2026-09-30, see §1)

```
/api/mark  (Telegram: handleTelegramWebhook calls handleMark() directly, in-process;
            website: submitBtn.onclick's attemptOnce() fetches it over HTTP, since Ticket 32)
                        ── detectAndCorrectRotation (both entry points)
                        ── callQwenOcrText (OCR only, model = PRODUCTION_OCR_MODEL constant, Qwen)
                        ── parseOcrLine (label=printed|answer)
                        ── classifyAndVerify / QUESTION_TYPE_HANDLERS (code, ~130 verifiers now,
                             not ~30 -- Tickets 185-216 added many since this was last accurate)
                        ── findBboxForItem (Vision word-position lookup, cached across the
                             rotation-check call when a page didn't need rotating)
                        ── callJevPreCheck, then callAiFallbackJudge (Gemini, model =
                             OCR_TEXT_MODEL constant) for whatever code/Jev couldn't resolve
                        ── annotateImage (Photon, stamps ✓/✗ on the corrected photo)

/api/check (website only, SECONDARY) ── restitchSplitPages: re-solves a question spanning a
                        page boundary, once both pages are already individually graded via
                        /api/mark. Own judge step also now calls callGemini (OCR_TEXT_MODEL),
                        not Qwen/DeepSeek -- see the 2026-09-29 "196跟進" TICKETS.md entry.

/api/verify (website only, SECONDARY) ── phase-2 recheck of whatever /api/mark's response
                        flagged as needsVerify (low confidence); no Telegram equivalent.
```

`PRODUCTION_OCR_MODEL` (src/worker.js, currently
`"qwen/qwen3-vl-235b-a22b-instruct"`) is the OCR-reading model both
`/api/mark` and (indirectly, since it's the same pipeline now) the
website's primary flow use — extracted 2026-09-25 specifically so a
future model swap is a one-line change. Separately, `OCR_TEXT_MODEL`
(currently `"google/gemini-3.1-flash-lite"`) is the JUDGE-step model
used by `callAiFallbackJudge` (both `/api/mark`'s AI-fallback and
`/api/check`'s own remaining cheap tier) — a different constant, for a
different pipeline stage; don't conflate the two. **Do not re-test the
OCR model choice without new evidence** — see §3's rigor-check summary
for why.

### 2b. Target design (settled, NOT yet built — see Tickets 1-8)

One shared pipeline behind both entry points:
**AI reads → code judges → (not yet built) AI judges only what code
can't.**

Within "AI reads," the settled (2026-09-25, corrected once already —
see TICKETS.md Ticket 4's own note) division of labour:
- **AI owns**: page structure (how many questions, which text belongs to
  which item) and handwritten-answer reading. Vision cannot do either —
  it has no semantic understanding of item boundaries, and is worse than
  a vision-LLM at messy handwriting.
- **Google Vision is PRIMARY for printed question text**, not a
  cross-check. AI and Vision read the same image in parallel (no timing
  dependency between them). Once AI has identified which region belongs
  to an item, the existing position-matching mechanism
  (`findBboxForItem`'s string-search logic, generalized) locates that
  region in Vision's own word list and Vision's transcription of it
  becomes the `printedQuestion` value directly — not "compared against
  AI's reading, override only on disagreement." AI's own reading of that
  region is the fallback ONLY when no Vision match is found. This
  matters because Vision cannot hallucinate/compute answers the way an
  LLM can (it has no world knowledge to draw from) — making it primary
  structurally closes that failure mode wherever a match succeeds,
  rather than merely catching it after the fact.
- **Dropped-content safety net: REMOVED 2026-09-26.** Used to
  pattern-match question-number-shaped tokens in Vision's word list
  (aligned+sequential run, or a spacing-gap fallback) and compare the
  count against how many items AI returned. Retired per explicit user
  decision — judged that Vision's own output is a better signal than a
  custom regex/heuristic layer for this. (Technical caveat raised but not
  blocking: Vision's block/paragraph structure is a LAYOUT signal from
  whitespace/position, not a semantic "this is question 3" signal — worth
  keeping in mind if question-boundary detection is revisited later.)
- **Homework-vs-not classification**: a page counts as homework only if
  it shows NO website/app UI chrome (browser bars, buttons, hyperlinks,
  cursors) AND its layout resembles an educational worksheet/textbook
  page. Deliberately does NOT require photographic imperfection (glare,
  shadow, paper curl) as a signal — a clean scan legitimately lacks those
  and must not be misclassified as a screenshot.
- **Per-item answered-or-blank**: judged separately, by genuine
  handwriting stroke characteristics (irregular width, imprecise
  letterforms) vs. uniform printed/digital marks — never by whether the
  page overall shows handwriting anywhere (a fully blank submission is
  still valid homework).
- **Teacher-mark vs. student-mark**: when a correction is visible (red
  pen, strikethrough), report the student's ORIGINAL answer (even if
  wrong), never the teacher's correction.

PDF upload is currently NOT handled by either entry point at all (image
mediaTypes only) — a real gap, not yet designed, see Ticket 6.

## 3. Current real state (2026-09-25 night)

**Git**: `main` is 3 commits ahead of `origin/main`, NOT pushed pending
the user's go-ahead:
- `b66cdf4` — rotation correction added to `/api/mark` (mirrors what
  `/api/check` already had).
- `eb10783` — tonight's 8 findings logged as tickets.
- `d02d139` — Ticket 4 corrected (Vision-primary, not AI-primary).

Earlier in the same session, already pushed to `origin/main`:
mixed-number fraction support, 4 new Tier-A verifiers from a real P5
exam, the `PRODUCTION_OCR_MODEL` extraction, and the model-comparison
route add+removal.

**Tests**: 301/301 passing (`node --test test/*.test.js`).

**Real-data rigor check completed tonight** (40 real photos: 16 curated
+ 24 from the real inbox, verified by direct human-equivalent read, not
just automated comparison): of the 28 photos that were genuinely
homework content, only **7/28 (25%) were clean, 17/28 (61%) had a
confirmed real transcription error**, 4/28 were too ambiguous to call.
Concrete failure modes found (see TICKETS.md Tickets 1-3 for the fixes):
computing an answer for a blank/unanswered item, reporting a teacher's
correction as the student's own answer, misreading printed digits,
dropping whole lines of content, fabricating content on hard-to-read
photos, and inconsistently declining non-homework screenshots.

**Model comparison, same rigor pass**: tested Claude Haiku 4.5, Gemini
3.7 Flash, and Qwen3.6-flash against the current baseline
(`PRODUCTION_OCR_MODEL`) on the same 40 photos — all 3 were both less
accurate AND more expensive; Qwen3.6-flash was ~unusable (a reasoning
model burning its whole completion budget before producing OCR output,
8% success rate). **Conclusion: keep the baseline model** — but note
this says nothing about the baseline's OWN absolute accuracy (see the
rigor-check numbers above for that; they're the real, separate finding).

**Open tickets** (see TICKETS.md for full detail): prompt fixes for
blank-handling/teacher-marks/homework-detection (1-3, shipped), the
Vision-primary printed-text mechanism from §2b (4, partial), the
dropped-content safety net (5, removed 2026-09-26 per user decision), PDF
upload — **closed 2026-09-26**: user decided not to build real PDF
support; a PDF/document sent via Telegram gets a clear "not supported"
reply, that's the final behavior (6), cross-page question stitching for
Telegram — the website has this via `restitchSplitPages`/`stitchPages`,
`/api/mark` (and so Telegram, which calls it directly) has no equivalent
(7, still open), and (8) the website's PRIMARY grading flow migrated
onto `/api/mark` as of **Ticket 32 (2026-09-27)** — done, not blocked,
contrary to what this file said before the 2026-09-30 correction in §1.
What's left of the old `/api/check` path is now just the secondary
stitching/verify features (7's own gap, and `/api/verify`'s phase-2
recheck), not the primary read+judge job.

**Ticket 9 (2026-09-25 night)**: after Tickets 1-3 shipped, the user
personally reviewed a fresh Qwen OCR test and verdict was direct —
"錯漏百出，絕對唔可以用" (riddled with errors, absolutely unusable).
**Historical note, corrected 2026-09-30**: this file used to say Ticket
8 (the website migration) was "blocked" on this precondition being met
first — that's not what actually happened. Two days later (2026-09-27,
commit `45935df`), the user explicitly instructed the migration to
proceed anyway ("Per explicit user instruction" per that commit's own
message) rather than waiting on Ticket 9's accuracy bar — Ticket 8 and
Ticket 9 turned out to be independent decisions, not sequenced as this
file previously implied. Don't assume Ticket 9's accuracy concern was
ever resolved just because the migration shipped; they're separate
threads. Model search is ALSO active in parallel: **GLM-4.6V tested and
REJECTED** (real 3-photo rigor check, read through directly — on one
photo GLM got only 1/5 items right vs Qwen's 4-5/5; on another GLM
failed to structure its output at all, `parseFailed: true`, while Qwen
stayed correctly structured despite 1-2 likely digit misreads). GLM-5.3-Flash, GPT-6 Luna, and Ling-3.0-Flash-VL were tested next
(2026-09-26) and **all 3 REJECTED for pure OCR**: 6 of 9 real calls (3
photos × 3 models) failed outright, mostly hitting `incomplete: length` —
the model burned its token budget on internal reasoning before producing
any OCR output, the same failure pattern already confirmed for
Qwen3.6-flash. Even the calls that succeeded leaned heavily on reasoning
tokens (69-80% of completion tokens) and one had a structural parse
error. A follow-up same-day test tried the SAME 3 models on the
read+judge task instead (`/api/check`'s actual job): Ling-3.0-Flash-VL
was still 0/3 (unreliable regardless of task), but GLM-5.3-Flash and
GPT-6 Luna both completed reliably this time — still showed no real
advantage though (both slower than Qwen, one notably pricier, judgments
disagreed with baseline on some items with no independently-verified
answer key to say who's right). No further candidates in the queue.
Fine-tuning a custom model was explicitly discussed and deferred — not
enough verified real examples yet (have ~40, would need hundreds+).

## 4. Standing product principles

1. **Accuracy is the floor, never traded for cost/speed/cleanliness/
   shipping timeline** — explicit cross-project hard rule, reaffirmed
   2026-09-25 directly in this project's context.
2. **A comparison test's baseline/reference must be independently
   verified correct BEFORE the comparison is meaningful** — hard rule,
   arising directly from tonight's model-comparison methodology gap
   (see §3).
3. **One shared backend — largely achieved 2026-09-30 correction**:
   website and Telegram now both call `/api/mark`/`handleMark` as their
   PRIMARY grading pipeline (since Ticket 32, 2026-09-27); what remains
   separate is narrower than this principle originally described —
   cross-page stitching and the phase-2 verify pass are website-only
   secondary features, not a second full read+judge pipeline. `/api/mark`'s
   pipeline SHAPE
   is the target, not the other way round.
4. **No answer-key/worksheet-bank lookup, ever** — resolved hard rule,
   the opposite of sibling project hk-maths' approach.
5. **`needs_review` is a correct output, never a failure to eliminate.**
6. **Teacher-parity is the north star, no fixed finish date**: whatever
   a real teacher could mark without an answer key, this app should
   eventually handle too.
7. **Sonnet is shelved for cost, not quality** — don't reintroduce
   "Sonnet is worse" as a reason for anything.
8. **Real model-swap testing costs real money** — confirm with the user
   before each new candidate, with a real priced cost range up front.
9. **No AI call can be guaranteed 100% correct** — layered, independent
   defenses (prompt rules, Vision cross-checks, human review as the
   final backstop) reduce risk; nothing eliminates it outright. Don't
   promise a stronger guarantee than that.

## 5. Where to look for more detail

- `TICKETS.md` (this repo) — the actual task list, triaged, including
  tonight's 8 new items.
- `benchmark/question-type-library.md` (this repo) — running catalog of
  every question type found, its solvability tier, code status.
- `project_hk_homework_check_architecture.md` (Claude memory) — long
  chronological history of every model tried, every A/B/C/D benchmark.
- `project_ai_model_watch.md` (Claude memory) — the cross-project vision
  model tracking initiative this project's model choice feeds from.
