# Review: 2026-09-23 verifier batch (e793264..HEAD)

Scope: 6 commits, 1388 insertions across `src/worker.js`, `TICKETS.md`,
`benchmark/question-type-library.md`, `test/mark.test.js`,
`test/new-question-types.test.js`. Adds 11 new Tier-A verifiers, fixes
`evalArithmetic` (bracket support + operator precedence),
`verifySortNumbers` (fraction/mixed-number parsing), generalizes
`verifySequenceFill` (multi-blank) and `verifyWordProblemTotal` (2+
addends, ticket B9). 244/244 tests pass (verified live, not assumed).

No `CONTRIBUTING.md`/`CODING_STANDARDS.md` exists in this repo, and no
formal issue tracker (`docs/agents/issue-tracker.md`) either — Standards
pass uses the Fowler smell baseline only; Spec pass treats `TICKETS.md` +
the standing user instructions (captured in this session's memory) as the
spec of record, noted explicitly below since that's an inference, not a
documented convention.

## Standards (smell baseline)

1. **Duplicated Code — numeric-answer parse/compare boilerplate.**
   At least 8 of the 11 new verifiers repeat the identical 4-line
   shape: `const studentNum = parseFloat(answer.replace(/[^\d.]/g,
   ""))`, NaN-guard, then `{correct: studentNum===expected,
   correctAnswer: ...}`. A shared `compareNumericAnswer(answer,
   expected)` helper would collapse ~30 duplicated lines to one call
   site each and fix finding #2 below in one place instead of eleven.

2. **Real defect, not just a smell — the shared parse pattern strips a
   leading minus sign.** `answer.replace(/[^\d.]/g, "")` removes `-`
   along with every other non-digit character. Reproduced directly:
   `"-5".replace(/[^\d.]/g,"")` → `"5"` → `parseFloat` → `5`, sign
   silently discarded. This pattern is not new to this diff (11 total
   occurrences in the file, of which 10 were added by it), but this
   batch is what propagated it into 8+ new call sites. Concrete failure:
   expected answer is 5, student actually wrote `-5` (a genuine sign
   error, or an OCR-real minus sign) — graded **correct**. None of the
   new verifiers' expected values are legitimately negative, so this
   never produces a false "expected -5" case, but it can produce a false
   *correct* whenever a student's own answer is wrong-signed. Fix:
   extract via `/-?\d+(\.\d+)?/` match instead of a blanket strip, or at
   minimum only drop a `-` that isn't the first character.

3. **Growing duplicated-list risk in `classifyAndVerify`.** Whether a
   handler counts as "math" for subject-classification is decided by a
   hand-maintained string array that must be kept in sync with the
   registry above it by hand, on every new verifier. This diff added 10
   names to that array correctly (verified — no name missed), but the
   design has no structural guard against a future miss; a forgotten
   entry wouldn't error, just silently misclassify the item's subject.
   Cheap fix: derive "is this a math handler" from a field on the
   registry entry itself (`math: true`) rather than a separate name
   list.

4. **`src/worker.js` continues to grow as a single file** (routing, OCR
   parsing, ~30 verifiers, the registry, dispatch — now >4200 lines).
   Judgement call, not urgent given the project's own "no premature
   abstraction" stance and that it's still one Worker — flagging as a
   Divergent Change smell worth revisiting once the verifier count
   roughly doubles again.

## Spec (against TICKETS.md + standing instructions)

1. **Real tracking gap: TICKETS.md's ticket B9 still reads as an open
   question, but the code has already implemented and shipped the
   decision.** `TICKETS.md:12` asks the user "想我照改...定係maintain現
   狀？" (change it, given the risk, or keep the safe behavior?) — worded
   as unresolved. But `verifyWordProblemTotal`'s new code comment states
   "per explicit user decision (ticket B9)" and the function is already
   generalized to 2+ addends, registered, tested, and (per `git log`)
   already pushed to `origin/main` in an earlier commit tonight. The
   user's real decision (quoted in this session: "ignore the rule that
   told you not to guess when there were more than three numbers") was
   never written back into TICKETS.md's B9 entry to close it out —
   anyone reading TICKETS.md today would wrongly think this is still
   awaiting a decision. Should be moved to the "✅ 已經解決" section like
   B10 was, in the same file.

2. **`DISABLE_ANTHROPIC_DURING_TESTING` correctly matches the standing
   instruction** ("do NOT use Sonnet/Opus during testing") — single kill
   switch, all call sites covered, `/api/mark` correctly noted as
   already unaffected. No finding.

3. **`verifySelectTwoNumbersSumTarget` correctly follows the "never give
   up, only stay unregistered for genuine blockers" rule** — the
   function exists, is tested, and is deliberately not wired into the
   registry only because the real OCR shape for the candidate-set
   already gets solved for free elsewhere; the one narrow remaining gap
   is logged in TICKETS.md's 🟢 section, consistent with its own
   description. No finding — noted as a positive spec-match, not a
   defect.

4. **Accepted, spec-acknowledged risk worth restating, not a defect:**
   `verifyWordProblemTotal`'s "sum every non-第-prefixed number in the
   text" approach has no protection against an unrelated number
   embedded in the same OCR'd text (a percentage, a unit, a stray
   adjacent question's number) being swept into the sum — the user
   weighed and accepted this trade-off for ticket B9, but TICKETS.md
   should say so explicitly once B9 is closed out (see finding #1).

## Challenge-all (7 lenses)

### 1. Question
- What evidence is there that first-match-wins `detect()` ordering
  won't keep producing silent overlap bugs as the registry grows past
  30 handlers? Two real overlaps were already found and fixed THIS
  SESSION (`multi_blank_math` vs `sequence_fill`; ceiling-division vs
  plain division) — both found by luck (a real user photo), not by any
  systematic check.
- Is the PDF-derived example phrasing (source of every new trigger
  regex tonight) representative of real photo-OCR phrasing, or only of
  clean-scan phrasing? 213 real inbox photos exist and are unused for
  this specific question.
- Why does `verifyDigitCountOfNPlusOne`'s trigger use two independent,
  anywhere-in-string keyword checks (`後面|之後|...` AND `位|digit`)
  when every other detector added the same day anchors its keywords
  into ONE contiguous pattern?

### 2. Unknown concepts
- This registry is a **Chain of Responsibility** already, informally.
  The actual gap it's missing is closer to a **rule-engine confluence
  check**: a cheap regression test that runs every handler's `detect()`
  against every OTHER handler's own fixture examples, asserting only
  the intended one fires. This would have caught both real overlap bugs
  from tonight automatically instead of by luck, and costs one test
  file, no runtime change.
- **Property-based / fuzz testing** for the numeric-parsing helpers
  (`evalArithmetic`, the shared parse-compare pattern) would surface
  finding #2 above (sign-stripping) and similar edge cImagine cheaply,
  vs. relying on hand-picked examples.
- Worth it once handler count is large enough that manual reasoning
  about interaction order is unreliable — already true at ~30 handlers.
  Overkill: a full rule-engine/priority DSL — not needed at this scale,
  a static overlap test suffices.

### 3. Disagree
- Opposing position: hand-writing a bespoke regex verifier per narrow
  real example doesn't scale sub-linearly — each new type costs real
  PDF-reading time plus dev time plus a permanent overlap-risk surface,
  while marginal coverage gain per new verifier keeps shrinking as the
  easy/common types get exhausted first (already visible: tonight's
  batch moved to genuinely rare types — reverse-factor-sum, N-th
  multiple difference — vs. earlier batches' much more common types).
- The counter the user has real leverage on: an undetected item already
  fails safe to `needs_review`, not a wrong grade — so the marginal
  value of each additional narrow verifier is "fewer items need a human
  glance", not "fewer wrong grades". That's a real, measurable but
  currently untracked number (needs_review rate over time) that would
  tell you whether this is still worth it.
- Decision test: if a type has been seen on fewer than ~2 real papers
  total, question whether a bespoke function is worth the overlap risk
  vs. bucketing it into a future AI-judgment (Tier V) fallback instead.

### 4. Edge cases
**Hidden assumptions:**
1. OCR'd `printedQuestion` is a clean, single-item string — several new
   detectors (digit-count-of-N+1 especially) assume this; real OCR
   concatenation across adjacent questions is an *already-documented*
   failure mode in this exact codebase (the B9 "第1組" ordinal-label bug
   found the same day).
2. The shared numeric-parse helper safely converts any legible written
   answer — false, see Standards finding #2 (sign-stripping).
3. Exactly one relevant number appears per item for several new single-
   number detectors (`round_to_nearest_hundred`, `digit_count_of_n_plus_one`)
   — a stray leading question-number digit ("3. 用四捨五入法...") would
   silently decline the whole item (fails safe, but a real, currently
   untested coverage gap).

**Black swans:**
- A fullwidth fraction slash or a rendered "over" fraction bar the OCR
  emits differently from ASCII `/` would make `parseSortableNumber`
  (and every fraction-aware verifier) silently decline — fails safe,
  low severity, unquantified real frequency.
- `verifyElapsedTimeForward` has no plausible-duration upper bound; a
  swapped AM/PM misread produces a ~12h-off diff that still returns a
  confident verdict rather than sanity-bounding to a homework-plausible
  range.

**Paper vs production (2 scenarios):**
1. *Paper:* `digit_count_of_n_plus_one`'s two independent substring
   checks reliably scope to this one question type. *Production:* "位"
   (ones/tens/hundreds place) and "後面"/"之後" are extremely common,
   generic Chinese math vocabulary that can co-occur in an unrelated
   question, especially under the already-documented OCR-concatenation
   risk. *Failure:* an unrelated item gets confidently marked wrong
   against a nonsense "digit count" interpretation — the one failure
   mode this whole codebase is explicitly designed to avoid everywhere
   else (fail-safe, never guess). *Fix:* anchor the trigger into one
   contiguous regex spanning the number and the keyword, matching the
   pattern used by `reverse_divisor_from_remainder` and others added
   the same day.
2. *Paper:* the shared `parseFloat(answer.replace(/[^\d.]/g,""))`
   pattern safely reads any legible numeral, proven over many prior
   verifiers. *Production:* it was only ever exercised on inputs where
   the correct answer is non-negative; it silently discards a genuine
   minus sign in the STUDENT's own (possibly wrong) answer. *Failure:*
   student writes "-5", correct answer is "5" → graded correct.
   Reproduced directly, not hypothetical. *Fix:* Standards finding #2.

**Hardening moves:** a cross-detector overlap test (see Unknown
Concepts); a shared, sign-preserving numeric-answer parser; anchor
`digit_count_of_n_plus_one`'s trigger into one contiguous pattern; a
tracked `needs_review` rate over time to make the "is this verifier
worth it" question answerable with data instead of vibes.

### 5. Scale
Not meaningfully applicable at this project's real scale (single
Cloudflare Worker, no shared mutable state across requests, D1/KV not
touched by this diff, low real request volume) — the closest real
"scale" axis is *handler count*, already covered under Question/Unknown
above (confluence risk grows with registry size, not request volume).

### 6. Execute
- **Option A (conventional):** keep hand-writing one bespoke verifier
  per real example, as done tonight.
- **Option B (counter-intuitive):** stop writing new detect()/verify()
  pairs for single-digit-frequency types; instead spend that same time
  on the ONE structural fix (shared numeric-answer parser + cross-
  detector overlap test) that de-risks all ~30 existing verifiers at
  once, then resume new-type coverage.
- **80/20 version:** ship the shared parser fix now (small, mechanical,
  fixes a real reproduced bug in 8+ places at once); defer the overlap-
  test suite and the TICKETS.md B9 cleanup to the next session, since
  neither blocks correctness today.
- **Cut 50%:** of tonight's 4 lenses of new work, the overlap-test and
  registry-derived math-flag refactor (Standards #3) are the two most
  cuttable without real near-term cost — both are structural
  improvements with no user-facing urgency yet.
- **Decision trigger:** the next real overlap bug found in production
  (a third one) is the signal to stop deferring the overlap-test suite.

### 7. Complexity check
This report itself: rated 4/10 — grounded in reproduced/verified
findings (test suite rerun live, sign-strip bug reproduced directly, B9
gap confirmed against the actual TICKETS.md text), no invented
scenarios. Kept under the acceptable-complexity threshold by citing
exact file:line and one fix per finding rather than open-ended
discussion.

## Recommended next move

Ship the sign-stripping fix (Standards #2) — it's small, mechanical, and
a genuinely reproduced defect. Close out TICKETS.md's B9 entry (Spec
#1) — a 2-line edit. Tighten `digit_count_of_n_plus_one`'s trigger
(Edge Case scenario 1) before it sees more real traffic. The cross-
detector overlap test and the registry math-flag refactor are real but
not urgent — worth scheduling, not blocking anything today.
