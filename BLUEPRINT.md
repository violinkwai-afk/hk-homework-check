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
question ✓/✗ directly on the photo and hands it back. Two live-code
entry points, meant to share one backend, currently don't:

- **Website** (`/api/check` + `/api/verify`) — AI (Qwen/DeepSeek, Sonnet
  as a last-resort fallback) reads the photo AND judges correctness in
  one call, no code-verification layer at all. This is the OLDER, more
  expensive, less testable path — **scheduled for retirement**, see §4.
- **Telegram bot** (`/api/mark`) — AI reads only (OCR), code judges
  deterministically, unresolved items fall back to `needs_review`. This
  is the path all future work converges on.

No confirmed real production users on either path as of this writing —
some field-testing has happened against real user-submitted photos (see
`~/.claude/channels/telegram/inbox`, ~260 real photos), but this hasn't
been independently confirmed as live production traffic vs. the owner's
own testing. Don't assert "real users" without checking current state.

## 2. Architecture

### 2a. Current, as actually deployed

```
/api/check (website)  ── AI reads + judges in ONE call, no code check   [retiring]
/api/mark  (Telegram)  ── detectAndCorrectRotation (both paths now, since 2026-09-25)
                        ── callQwenOcrText (OCR only, model = PRODUCTION_OCR_MODEL constant)
                        ── parseOcrLine (label=printed|answer)
                        ── classifyAndVerify / QUESTION_TYPE_HANDLERS (code, ~30+ Tier-A verifiers)
                        ── findBboxForItem (Vision word-position lookup, cached across the
                             rotation-check call when a page didn't need rotating)
                        ── annotateImage (Photon, stamps ✓/✗ on the corrected photo)
```

`PRODUCTION_OCR_MODEL` (src/worker.js, currently
`"qwen/qwen3-vl-235b-a22b-instruct"`) is the single source of truth for
which model both `callQwen` (`/api/check`) and `callQwenOcrText`
(`/api/mark`) use — extracted 2026-09-25 specifically so a future model
swap is a one-line change. **Do not re-test this model choice without
new evidence** — see §3's rigor-check summary for why.

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
- **Dropped-content safety net**: separately, pattern-match
  question-number-shaped tokens in Vision's word list. Primary, strongest
  signal: a run of candidates that's BOTH X-position-aligned AND
  sequential (1,2,3,4… no gaps) — sequential-increment is what
  distinguishes a real question-number column from a coincidentally
  X-aligned table data column (a data column like 5,8,12,20 won't be a
  clean ascending run), and doubles as the fix for tables specifically —
  no separate table-handling logic needed. Fallback signal (when no clean
  aligned+sequential run is found, e.g. an irregularly-laid-out
  worksheet): "label followed by a clear spacing gap" before the next
  word, a purely local check that doesn't depend on page-wide alignment.
  X-position alignment on its own is a confidence BOOSTER, not a hard
  requirement — an isolated, unaligned candidate is not auto-discarded,
  to avoid false-negatives on irregular real layouts. Compare the
  resulting count against how many items AI actually returned; only flag
  "possibly dropped content" on a meaningful margin (2+), not any
  mismatch, to tolerate the method's own imperfection.
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

**Open tickets** (see TICKETS.md "2026年9月25號" section for full detail,
1-8): prompt fixes for blank-handling/teacher-marks/homework-detection
(1-3), the Vision-primary printed-text mechanism from §2b (4), the
dropped-content safety net (5), PDF upload handling (6), cross-page
question stitching for Telegram — `/api/check` already has this via
`stitchPages`, `/api/mark` has no equivalent (7), and the website
migration onto the shared pipeline (8, blocked on 1-6 being done AND
re-verified with the same rigor method before cutting over).

## 4. Standing product principles

1. **Accuracy is the floor, never traded for cost/speed/cleanliness/
   shipping timeline** — explicit cross-project hard rule, reaffirmed
   2026-09-25 directly in this project's context.
2. **A comparison test's baseline/reference must be independently
   verified correct BEFORE the comparison is meaningful** — hard rule,
   arising directly from tonight's model-comparison methodology gap
   (see §3).
3. **One shared backend eventually** — website and Telegram (and any
   future interface) are thin windows over one pipeline. `/api/check`'s
   internals are the thing being replaced; `/api/mark`'s pipeline SHAPE
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
