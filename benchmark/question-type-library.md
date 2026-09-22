# 題型庫 (Question-Type Library)

Started 2026-09-22. One running list of every distinct real question
type found so far, its solvability tier, and current code status. This
is the single source of truth — update it every time a new type is
found or a type's status changes, instead of leaving findings scattered
across chat/memory only.

**Standing rule (user, 2026-09-22 night):** whenever the LIVE app
encounters a question it doesn't recognise/can't verify, that should be
recorded (not just silently declined), and the reason WHY it wasn't
recognised should be investigated — not just noted as "unknown" and
left there. In practice: `correct: null` / `needs_review` outcomes are a
real signal worth logging with enough detail (the actual OCR'd
question/answer shape) to later ask "is this a new type this library
doesn't have yet, or a real bug in an existing detector?" — this is how
several of today's findings (fractions, the multi-box conflict) were
actually surfaced in the first place, and should stay a deliberate habit,
not a one-off.

**🟡 Real JS/Photon PORT ATTEMPT, 2026-09-22 (same day, later) — fish-length
comparison ports successfully; clock-reading does NOT, a real diagnosed
engineering gap, not just "harder".** Following the portability finding
below, actually built working Node.js scripts using `@cf-wasm/photon/node`
(the exact package this repo ships) to reimplement the Python/OpenCV logic
from scratch in JavaScript — not just re-confirming `edge_detection()`
produces a nice-looking image, but building the full measurement pipeline
end to end and testing it against the same real images.

- **Fish-length comparison — REAL SUCCESS, closely matches the Python
  reference.** `edge_detection()` + a flood-fill connected-components pass
  (pick the largest component on each half of the image, since a fish
  body is much bigger than any single character stroke of the "P魚"/"Q魚"
  labels) measured P fish = 112px, Q fish = 257px, ratio 2.29× — versus
  the earlier Python/OpenCV result of 121px/253px, ratio ~2.1×. Very
  close agreement, and both correctly conclude Q魚 is the longer fish
  (matches the real picture). Script saved at
  `/tmp/claude-115/.../scratchpad/photon_fish.js` for reuse.
- **Clock reading — REAL FAILURE, root cause identified.** Two genuine
  JS implementation attempts, both failed to reach the Python version's
  safety bar (0 confidently-wrong):
  1. A ray-casting approach (walk outward from the assumed center at
     each angle, checking for edge pixels) produced **2 confidently
     WRONG answers out of 6** (worse than the Python version).
  2. A direct edge-pixel-angle-voting approach (every edge pixel votes
     for its own angle bucket) produced 0 wrong but 0 CORRECT either —
     every single test case declined.
  **Root cause, actually diagnosed via debug output, not guessed**:
  Photon has no true Hough-line-transform equivalent (only 4 fixed-angle
  line detectors: horizontal/vertical/45°/135°), so this port had to work
  from raw edge PIXELS rather than the Python version's connected LINE
  SEGMENTS. The Python approach's real strength was filtering Hough line
  *segments* by whether they pass near the clock's center — a hand
  segment does, the rim circle's edge does not (a circle is tangent to
  every radius, never crossing near the center). Working from scattered
  edge pixels instead loses this structural distinction: the rim circle
  itself produces edge pixels at EVERY angle around the clock face, at
  roughly the same distance from center as a fully-extended hand tip —
  so the rim swamps the real hand signal almost everywhere, and no
  radius/angle-band tuning found in the time available could cleanly
  separate them. **This is a genuine, non-trivial gap between what
  Python/OpenCV could do and what Photon's current primitives support
  for THIS shape of problem** — not proof clock-reading can never work
  in JS, but proof this specific porting attempt, with the tools
  currently available, does not yet clear the bar. Scripts saved at
  `/tmp/claude-115/.../scratchpad/photon_clock.js` and `photon_clock2.js`
  for reference/future attempts.
- **Overall honest verdict**: portability is NOT a blanket yes or no —
  it depends on the specific technique. Length/size-comparison-style
  problems (connected-component measurement) port cleanly to Photon.
  Angle/rotation-reading problems (clock hands, and by extension likely
  ruler tick marks) do NOT port cleanly with Photon's current feature
  set alone — a real, currently-open gap, not yet resolved.

**🟢🟢 CRITICAL portability finding, 2026-09-22 — the real product's own
already-integrated image library can do this, not just Python's OpenCV.**
All OpenCV testing tonight ran in Python — the real product runs
JavaScript on Cloudflare Workers, which CANNOT run Python, and a full
OpenCV.js port is a likely non-starter (its WASM binary is ~6MB, against
Cloudflare's ~1MB per-file Wasm limit — a real, serious blocker,
confirmed via web search, not yet tested directly). BUT: this project
ALREADY ships `@cf-wasm/photon` (proven working in production — it's
what powers the existing photo-rotation/crop/annotation features), and
Photon turns out to have real, relevant primitives: `edge_detection`,
`sobel_global`/`sobel_horizontal`/`sobel_vertical`, `laplace`,
`detect_horizontal_lines`/`detect_vertical_lines`/`detect_45_deg_lines`/
`detect_135_deg_lines`, `threshold`, `get_image_data`/`to_raw_pixels`
(raw pixel access for custom logic). **Verified directly (Node.js,
`@cf-wasm/photon/node` — the same package already in this repo's
`package.json`, not a new dependency)**: `edge_detection()` on the real
P魚/Q魚 image cleanly outlined BOTH fish (including the outline-style
one that defeated the original naive Pillow attempt) plus the text
labels, separably. `edge_detection()` on a real clock image cleanly
outlined the clock face AND both hands, visually verified. One real
quirk found: `sobel_global()` crashed with a WASM runtime error
("unreachable") on the clock image specifically — `edge_detection()`
worked fine as an alternative, cause not investigated further.
**Conclusion: the "can this ever reach the real product" concern the
user raised is answered — YES, there is a real, already-integrated,
size-compatible path (Photon), not just a Python dead end.** Still not
done: rebuilding the actual angle/measurement/decline-when-uncertain
logic (which exists only in Python right now) in JavaScript against
Photon's primitives — real remaining engineering work, not yet started.

**🟡 OpenCV re-test, 2026-09-22 — real, meaningful improvement over the
earlier failed Pillow-only attempt, but not a universal fix.** With
`opencv-python-headless`+`numpy` now installed: `cv2.Canny`+contours
cleanly measured the real P魚/Q魚 image (121px vs 253px, verified by
drawing the boxes back on and checking them visually) — a real
improvement over the earlier naive color-threshold failure.
`cv2.HoughLinesP` on a real clock image (green hands, textbook diagram)
correctly found both hands and reconstructed "2時", verified visually.
**Real, tested limits, not just caveats**: re-running the clock test
WITHOUT a color hint (plain grayscale, simulating the common
black-handed-clock case) was noticeably noisier — tick marks got
picked up as spurious lines alongside the real hands. No real ruler
example was available to test at all. Real photographed (not scanned)
homework — lighting, skew, shadow — is untested. **Conclusion: worth
pursuing further as a real lever for the V-tier (measuring
cup/clock/ruler/length-comparison) types, but still needs real
photographed-homework testing before trusting it over real AI for
these — not yet a replacement, a promising unfinished lead.**

**🔴 OpenCV robustness re-test, 2026-09-22 (same day, later) — FAILED the
user's own bar, verdict downgraded.** Attacked the 3 flagged weaknesses
above with real testing against a strict rule: 8-10 diverse real
examples, zero confidently-wrong results allowed (same fail-safe
standard as every verifier in this project). Result:
- **Noise fix worked**: a center-distance line filter (find the clock's
  center via `cv2.HoughCircles`, keep only Hough lines passing near it)
  really did clean up the tick-mark noise from the earlier grayscale
  (no-color-hint) test — a genuine, kept improvement.
- **But a NEW, separate problem surfaced**: converting measured hand
  angles to an hour/minute reading by rounding is imprecise on
  hand-drawn clip-art. Real result across 7 diverse real clock/fish
  examples: 5 correct, 1 unconfirmable, **2 confidently WRONG** (9:00
  read as 9:01; 9:30 read as 10:30 — wrong hour, not just imprecise).
- **2/7 confidently wrong fails the "zero confidently-wrong" bar.**
- Ruler: genuinely searched (measurement/度量 chapters checked) — no
  real ruler diagram found anywhere in the material available; honestly
  not tested, not force-fit.
- Real phone-photo noise (tested on a real `batch4` photo, not a scan):
  quantified real degradation — 82 spurious contours vs ~1-2 on clean
  scans — the shape was still found in this one spot-check but this is
  clearly unproven at scale.

**🟢 Third OpenCV pass, 2026-09-22 (same day) — clock-precision fix now
clears the zero-confidently-wrong bar, at reduced coverage; object
counting gets a real (but narrow) positive result.**

**Clock, fixed**: added (a) hand LENGTH as a second signal (not just
angle) to tell hour/minute apart, (b) the existing hour/minute
angle-consistency residual check, and (c) a NEW guard — decline
whenever the two hands' detected lengths are too close to call
(`min/max reach ratio > 0.85`) rather than guessing which is which.
Re-ran on the same 6 real clock crops (grayscale, no color hint):
**2 correct (2:00, 8:00), 4 honestly declined (9:00, 9:30, 5:30, and
the earlier length-ambiguous 2:00 case), 0 confidently wrong.** This
clears the user's bar, but coverage dropped hard (2/6 ≈ 33% actually
answered) — a real trade of coverage for safety, consistent with this
project's fail-safe philosophy everywhere else. Root cause of the two
newly-declined real-time cases (9:00, 9:30): Hough-detected hand angles
carry a few degrees of real error, and near a tick boundary (minute≈0
or the hour hand sitting past-halfway between two numbers) that error
flips the nearest-tick reading — the system now recognizes this
inconsistency (via the residual check) and declines instead of
confidently misreading, which is exactly the intended behavior, just at
a real coverage cost.

**Object counting — real, positive result, on CLEAN non-touching
grids only.** Tested contour-counting (`cv2.threshold`+morphology-close
+`cv2.findContours`, with a hand-inspected area-band: <4000px²=noise,
4000-9000px²=one object, >9000px²=merged blob split by
`round(area/6100)`) on two real, DIFFERENT images from the same real
exam (`benchmark/external_pdfs/p2_math_test_2023_2024.pdf` p1 Q1/Q2,
300dpi render): a 16-item tart grid → **16/16 correct**, a 20-item
sushi grid → **20/20 correct, using the exact same thresholds with NO
per-image re-tuning**. This is real evidence contour-counting can work
on clean, evenly-spaced, non-overlapping object grids. **Important
unresolved caveat**: thresholds are in absolute PIXEL AREA, tied to
this one document's 300dpi render — not yet proven scale-invariant
across different photos/zoom levels/resolutions (a real product would
see arbitrary phone-photo scales). The original harder case — visibly
TOUCHING/OVERLAPPING objects (e.g. coins piled in a bag) — was NOT
re-tested this pass (no clean high-res crop was available in time);
that harder case's earlier "genuinely infeasible" assessment stands,
not overturned.

**Ruler/measuring-cup**: searched again, more broadly (additional
measurement/度量 chapter pages across 3 PDFs) — still genuinely not
found in any material available. Not tested, not force-fit.

**Updated overall verdict**: clock reading is now safe-by-construction
(zero wrong, real coverage cost) but still not "done" — worth
real-photo (not scanned) testing before trusting further. Object
counting has a real positive signal on the easy (non-touching,
same-scale) case specifically — worth pursuing, but the scale-invariance
gap and the untested touching/overlapping case mean it's not ready for
arbitrary real submissions either. Neither type is ready to replace
real AI yet; both are more promising than they were an hour ago.

**Revised conclusion: NOT currently trustworthy enough to build for
real.** Stay on real AI for clock/ruler/length-comparison/counting for
now. If revisited, the next concrete idea (untested) is a "too close to
call → decline" band around ambiguous angles instead of always forcing
a rounded reading — this trades some coverage for the zero-confidently-
wrong guarantee the project requires everywhere else.

**🟢 Fourth OpenCV pass, 2026-09-22 (same day) — weight-scale tilt reading: a real, verified NEW positive; object counting on the harder case: promising but unconfirmed; position-in-row not located this pass. IMPORTANT: everything below (and everything above in this section) was tested in Python on this machine, NOT in the real product's actual runtime — the live Cloudflare Worker only runs JavaScript, not Python. None of this OpenCV work can be used as-is; it would need a from-scratch JS/WASM re-implementation (e.g. via opencv.js or similar) — that porting step has not been started or evaluated for feasibility/cost.**

**Weight-scale (balance) reading — real, verified win.** Real example:
cover page of `1789722963636-AgADQCIAAoEaaVE.pdf` ("Primary Mathematics
Problem Solving Strategies") — a digital camera balanced against a
printed "400g" weight, beam visibly tilted (camera side down), marked
correct answer "A. 500g" (i.e. camera is heavier than 400g). This is
NOT a dial/needle-reading task like the clock — it's simpler: detect
WHICH SIDE of the balance beam is lower. `cv2.Canny`+`cv2.HoughLinesP`
on the real cropped image found the diagonal beam line at a real -4.9°
tilt (after filtering out unrelated near-0°/near-90° lines from
borders/support posts) — the sign of the tilt correctly indicates the
camera side is lower/heavier, matching the marked answer. This is a
different, more tractable sub-problem (binary "which side is lower",
like the fish-length comparison) than reading a rotating dial pointer.

**Object counting, harder case — promising, NOT confirmed.** Re-tested
the original "genuinely infeasible" case (money bags with loose coins,
real page: `1789714963421-AgADICIAAoEaaVE.pdf` p10) using
`cv2.HoughCircles` (circle-shape detection, not blob-separation —
different technique from what failed before and from what worked on
the clean tart/sushi grids) — found 64 circles across 6 bags + 2 loose
coins, and the drawn-back overlay LOOKS visually reasonable (circles
land on individual coins, no obvious large false positives). **Honest
limit**: manual ground-truth counting on this specific irregular,
non-uniform coin arrangement (bags do NOT all have the same count —
counted 10 in bag 1, 11 in bag 2 by hand, inconsistent with a simple
"N per bag" assumption) proved difficult to verify with full confidence
in the time available, and at least one region showed what may be a
duplicate/overlapping detection on adjacent coins. **Do not report this
as a confirmed win — it's a real technique improvement over the earlier
Pillow attempt, with a plausible-looking but not independently
verified count.** Needs a cleaner verification method (e.g. a real
answer key, or careful cell-by-cell manual recount) before trusting it.

**Position-in-row (swim-race distance) — not located this pass.**
Searched pages near the previously-found fish/clock examples in the
same PDF and did not find the specific swim-race image referenced
earlier in the session; may be in a different file or page than
recalled. Not tested — genuinely not found in the time available, not
declared infeasible.

**AI-vision latency, reasoned (not money-tested) findings, 2026-09-22**:
cropping to the diagram region and lowering `max_tokens` for a
single-value judgment call are both plausible, real, unverified-without-
a-real-call levers. Provider `sort:"latency"` is a **confirmed dead end**
(already real-tested earlier tonight: slower AND less accurate — do not
retry without new evidence). Downscaling — already proven safe/helpful
for TEXT OCR — is flagged as a **possible real risk, not a clean win**,
for visual-derivation types specifically, since reading fine tick marks/
hand angles may need higher resolution than reading printed text does;
unverified either way, don't assume the text-OCR downscale setting
transfers safely.

**🔴 Real bug found + fixed 2026-09-22 (full-paper run):** running a
whole real 44-item exam through the ACTUAL live `evalArithmetic`/
`verifyMath` code (not cherry-picked examples) found that EVERY plain
subtraction (e.g. "328-214=") was silently returning `needs_review` even
when the student's answer was exactly correct — the tokenizer regex
greedily swallowed the `-` into the next number as a negative sign
instead of splitting it out as the subtraction operator (`"328-214"` →
`["328","-214"]`, 2 tokens, instead of `["328","-","214"]`, 3 tokens).
No prior test in the suite happened to cover plain subtraction through
this path. **Fixed** via a lookbehind (`(?<![\d)])` before the number
pattern) so `-` only binds to a number when NOT immediately preceded by
a digit. 3 new regression tests added, 137/137 passing. Fixed locally,
NOT yet deployed to production — this is currently the highest-priority
pending deploy decision (affects code already live). Lesson: cherry-
picked/hand-built test examples can miss basic real-world shapes that a
genuinely unfiltered real paper exposes — worth periodically running a
whole real paper through the real code, not just targeted examples.

**Full-paper run result (same pass, `benchmark/external_pdfs/p2_math_test_2023_2024.pdf`,
44 real items, zero AI cost — literally executed the real functions):**
3 resolved correctly as-is (division ×2, a "相差" subtraction), 4 more
would resolve for free once the bug above is deployed, ~26 have no
matching function at all yet (mostly picture/shape/map items — genuine
Tier V, ~20 of the 26 — plus a few new Tier-A shapes: multi-blank-digit
column arithmetic, remainder-notation word problems, ceiling-division
word problems). Also found `verifyComputationMC`'s real trigger is
narrower than assumed — it expects a quoted target like `「39+12+28」`;
a real unquoted phrasing didn't match. Not yet incorporated into the
tier tables below row-by-row — flagged here so the finding isn't lost;
do a proper table pass next time this file is touched.

**Hard product rule (2026-09-22, non-negotiable):** no worksheet-bank /
pre-known-answer-key approach, ever. Every submission is judged fresh
from what's actually in that photo. "Needs a key" is not a real
solution path for this product — see reframing below.

**Pre-check pattern (2026-09-22, third pass):** even when a type genuinely
needs AI (V or J), a cheap deterministic pre-check can often catch a slice
of answers for free — its job is ONLY to catch the confidently-obvious
case and pass everything else through to real AI/`needs_review`, never to
assert a confident wrong verdict. Three real, evidence-backed patterns
found, all fail-safe by construction:
1. **MC-format validity** (broadest win, applies to MANY types at once):
   if the question has a fixed set of printed option labels (A/B/C/D,
   or two named choices like "P魚/Q魚"), and the student's answer isn't
   one of those labels, that's an instant, certain catch — no AI needed
   to know the answer is malformed. Applies to: 句子配對, length/position
   comparison MC, weight-estimate MC, reading-passage MCQ.
2. **Range/format plausibility using data OCR already captured**: if the
   question's own printed scale/labels give a valid range (a ruler's
   printed max, a measuring cup's printed max, a clock's valid 0-59
   minute / 1-12 hour range), an answer outside that range is certainly
   wrong — cheap, and re-uses OCR output already being captured for
   other purposes, no new AI call. Applies to: ruler reading, measuring
   cup, clock, weight estimate, object counting (only as a loose upper-
   bound sanity check, not real counting).
3. **Rule-computed expected answer + fuzzy match** (prototyped this
   pass, see below): for narrow-transform grammar tasks, code computes
   ONE textbook-rule answer and only auto-passes a HIGH-similarity match
   (typos/case/contractions) — anything below a high threshold must NOT
   be treated as wrong (it may be a valid alternate phrasing), so it
   still falls through to real AI/needs_review. This is a "skip AI on
   the obviously-fine case" filter, never a reject filter.

**Prototype result, rule-computed negative-form pre-check (real SFA P1
quiz sentences, section F, tested with a real Python script, not just
reasoned about):** a simple has/have/is/are → negation + some→any rule
correctly reconstructed all 3 real sentences ("Joe has some chocolate
eggs." → "Joe does not have any chocolate eggs.", etc.). Fuzzy-match
(difflib) against real plausible student variants: typos, contractions
("doesn't"), and case differences all scored 0.89-1.00 similarity (safe
to auto-pass) — but a genuinely valid ALTERNATE construction ("Joe has
no" instead of "Joe does not have any") scored only 0.52, i.e. a naive
similarity threshold cannot safely distinguish "valid different
phrasing" from "actually wrong" — **only very-high similarity is a safe
auto-pass; anything below stays needing AI/review, never auto-rejected.**
Confirms the pattern works for the format/typo-tolerance goal, does NOT
mean full auto-grading is now safe for this type. The parallel
question-form (G) and plural-form (H) sections were read from the same
real PDF but not separately coded this pass (G needs word-reordering not
just insertion, H needs an irregular-noun lookup table e.g.
child→children — both plausible, flagged not built, for time reasons)
— word-rearrange's word-set pre-check was also not independently
re-tested this pass (no real word-rearrange example was found in the
material available this round; the idea itself is unchanged from the
prior pass).

**Tiers**
- **A — code-solvable**: a formula/rule, computed fresh from what's OCR'd
  off THIS submission (no stored key needed).
- **V — AI visual-derivation**: no formula exists; the AI must look at
  THIS photo fresh, every time, and derive the fact itself (e.g. really
  read a ruler, really count objects). Costs real money per use, no
  code shortcut. Replaces what was earlier miscalled "Tier B".
- **J — AI judgment (language/meaning)**: open-ended, needs real
  reasoning about meaning, with the safety-net pattern (cross-verify,
  judge meaning not exact wording, `needs_review` always acceptable).
- **?** — not yet classified / not enough real evidence.

Status: `done` (code written+tested) / `todo` (classified, not coded) /
`n/a` (tier V or J, no code applicable) / `blocked` (structurally can't
verify, e.g. OCR can't even capture it).

**Registry built, 2026-09-22 (`QUESTION_TYPE_HANDLERS` + `classifyAndVerify`
in `src/worker.js`):** 14 of the Tier-A functions below whose real shape
fits the pipeline's current per-item `{printedQuestion, studentAnswer}`
OCR output are now wired together as one ordered, data-driven registry —
adding a future type means inserting ONE new entry, never editing an
existing one or the dispatch loop (built specifically to avoid a growing,
increasingly bug-prone if/else chain). Includes an automated "overlap
guard" test proving no two handlers' detectors both claim the same real
example. 17 new tests, 154/154 total passing. **`classifyAndVerify` is
NOT yet swapped in to replace the live `verifyAnswer` dispatcher** —
`handleMark` still calls the original `detectSubject`+`verifyMath` path
unchanged; the swap is a deliberate separate decision. **7 functions
could NOT be registered** because their real shape needs structured data
the OCR step doesn't currently extract as separate fields (a grid, a
source passage, an accepted-phrasing list, a word bank, MC option
objects, two separate clauses, or a price table): `verifySudoku4x4`,
`verifySelectFromPassage`, `verifyPictureMatchFormat`,
`verifyWordBankOnceEach`, `verifyLiteralKeywordMC`,
`verifyConjunctionFill`, `verifyPriceTableLookup` — wiring these in needs
an OCR-prompt/pipeline change first, not just a registry entry.

## Math

| Type | Tier | Status | Example (real) | Notes |
|---|---|---|---|---|
| Basic arithmetic equation (+ - × ÷) | A | done (`verifyMath`) | "34+23=" | baseline |
| Single blank-in-the-middle (`?`/`□`) | A | done (`trySubstituteBlank`) | "54÷?=6" | Tier 1, 2026-09-22 |
| Division with remainder ("R" notation) | A | done (`verifyRemainderAnswer`) | "12÷5=2 R2" | fixed this session, not yet merged |
| Number-word ↔ digit (en+zh, 0-99) | A | done (`verifyNumberWordConversion`) | "twenty-six" ↔ 26 | not wired to live dispatcher yet |
| Comparison symbol fill (`>`/`<`) | A | done (`verifyComparisonSymbol`) | "7 ___ 17" | not wired yet |
| MC: which option all-even/all-odd | A | done (`verifyParityMC`) | "A.4,9 B.8,13..." | not wired yet |
| MC: which option computes to target | A | done (`verifyComputationMC`) | "same sum as 39+12+28?" | not wired yet |
| Multi-blank-per-item (Tier 2) | A | done (`verifyMultiBlankMath`) | "4×□=24,24÷□=4..." | reuses `trySubstituteBlank` per comma-joined sub-equation, positional pairing |
| Arithmetic sequence fill-in-pattern | A | done (`verifySequenceFill`) | "1,3,5,__,9" | ascending/descending, constant-step inferred from the OTHER numbers |
| Sort numbers into order | A | done (`verifySortNumbers`) | "將5,2,8,1由小到大排列" | needs an explicit direction keyword, else null |
| Missing digit embedded in a number | A | done, PARTIAL (`verifyMissingDigitInNumber`) | "2□+15=41" | ⚠️ only handles ONE blank digit; the real captured harder case (`□8-3□=45`, TWO blank digits in two different operands) is NOT solved by this — flagged, not silently claimed |
| Multi-box digit answer (each digit of the answer in its own box) | A | found 2026-09-22, NOT yet built | "634×2=", answer split across 4 separate boxes (one digit each) | real: p1-p6.com P3 maths 2025-2026 Term1 Q11. Verification is trivial once the boxes are read as one number (compute the product, zero-pad to box count, compare digit-by-digit) — the real unknown is whether OCR reads a 4-box grid as one coherent answer or 4 separate fragments; untested |
| Missing digits WITHIN a column addition/subtraction (multiple blanks, with carrying) | A | found 2026-09-22, NOT yet built, HARDER than the existing single-digit row above | "2□9 + 32 = □9□" (find both □s so the column sum is consistent) | real: same source, Q15. Needs real constraint-solving (brute-force each blank digit 0-9, check the full column arithmetic including carries) — not just substitute-and-check like the simpler existing row |
| Word problem, 2 numbers → total (addition) | A | done (`verifyWordProblemTotal`) | "昨天賣出鉛筆34支，今天再賣22支，共賣去多少支？" (34+22=56) | real example found in `b245b3f1-QuizGo-...maths_test_2.pdf` p2 Q12, after a broader search than the first pass; narrow trigger: exactly 2 numbers + a 共/總共/一共/合共 keyword |
| Word problem, total ÷ quantity → per-unit | A | done, PARTIAL (`verifyWordProblemDivision`) | "用32元買咗8盒豆漿，每盒售___元" (32÷8=4) | real: `p2_math_test_2023_2024.pdf` p1 Q12. ⚠️ explicitly DECLINES (never guesses) on a real found trap in the same PDF (Q21): "...分給卓賢和另外3個同學" — true group size is 3+1=4, not the literal "3", so this shape is recognized and refused rather than computing a confidently wrong 24÷3 |
| Word problem, 2 numbers → difference | A | done (`verifyWordProblemDifference`) | "第一場獲得180分，第二場獲得166分，相差多少分？" (180−166=14) | real: `p2_math_test_2023_2024.pdf` p1 Q19; narrow "相差" keyword trigger |
| Price-table lookup + compute | A | done, PARTIAL (`verifyPriceTableLookup`) | "買機械人和洋娃娃各一個共需付()元" (48+25=73); "跑車比機械人貴()元" (89−48=41) | real: `b245b3f1-QuizGo-...maths_test_2.pdf` p2 Q10/Q11. Handles ONLY one-each-sum and pairwise-difference. Explicitly declines (guarded, caught by its own test suite) on quantity-multiplied ("各4碟", found same PDF p20 Q2) and change-from-payment ("付$500可找回", found same source p20 Q4) shapes — both real, both seen, neither attempted |
| Sudoku (small grid) | A | done (`verifySudoku4x4`) | 4x4 grid puzzles | generic Latin-square checker (rows+cols 1-4 once); tested against a self-built valid grid of the same real-evidenced shape/rules, not a possibly-misremembered specific puzzle |
| Construct smallest/largest N-digit number from given digits | A | found 2026-09-22, NOT yet built | "Use 5,0,8,6,2 to form the smallest 5-digit number" | real: p1-p6.com P3 maths Q1. Code-solvable: sort digits, put smallest non-zero digit first (leading zero not allowed for an N-digit number), rest ascending (or descending for "largest") |
| Digit-count reasoning about N+1 | A | found 2026-09-22, NOT yet built | "the number after 9999, how many digits?" | real: same source Q4. Narrow but purely computable (count digits of N+1) |
| Elapsed time, backward (end time + duration → start time) | A | found 2026-09-22, NOT yet built | "closed at 6:15pm, open for 4 hours → opened at?" (real MC, 2:15pm) | real: same source Q24 (MC), Q25 (fill blank incl. am/pm), Q31-33 (12h/24h format conversion, table lookup). The accompanying clock-face ILLUSTRATIONS are decorative/worked-example, not something that needs visual reading — the actual answer is pure time arithmetic. Distinct from analog clock-READING (still Tier V, see row below) |
| 12-hour ↔ 24-hour time format conversion | A | found 2026-09-22, NOT yet built | "11:52 in the morning" → 11:52; "14:05" → "2:05 in the afternoon" | real: same source Q30/32/33. Pure format conversion once the time value itself is already text (from OCR or from a real digital-display reading, see V row below) |
| Comparative/relative reasoning (word problem, no direct arithmetic) | A (parsing-hard) | found 2026-09-22, NOT yet built | "Sarah takes 3s longer than Linda, 2s shorter than Jessie — who's fastest?" | real: same source Q29. The LOGIC is simple (least time = fastest) but reliably parsing the relational structure ("X longer than Y", "X shorter than Z") out of natural-language OCR text is the real difficulty, not the reasoning itself |
| Digital-clock display reading | V, plausibly easy (untested) | found 2026-09-22, n/a | "16:15" shown as LED-style digital clock graphic | real: same source Q30. Likely much easier than analog hand-reading (literal stylised digit recognition, closer to OCR than geometry) — not yet tested against the abacus-style methodology |
| Spatial/compass-relative position reasoning | V | found 2026-09-22, n/a | "___ is to the east of the school" (icons on a map with a compass rose) | real: same source Q34. Distinct from other V types — needs relative 2D position + compass-direction reasoning, not counting/measuring |
| 3-D shape identification from line drawing | V | found 2026-09-22, n/a | "circle the 3-D shape with quadrilateral lateral faces" (cone/cylinder/bipyramid line drawings, unlabelled) | real: same source Q35 |
| Pictogram reading (count icons, then compute) | V then A | found 2026-09-22, n/a | flower pictogram, "how many 🌼 and 🌹 altogether" | real: same source Q36. Two-stage: read icon counts per row (V, icons touch/vary — plausibly harder than abacus's uniform beads, untested), then plain arithmetic on the counts (A) |
| Table lookup: comparison/difference between two rows | A, PARTIAL pattern exists | found 2026-09-22, real example for existing pattern | "港島線" vs "觀塘線" length difference, from a 4-row MTR-line table | real: same source Q17. Same shape as the already-built `verifyPriceTableLookup` (done, partial) — worth checking whether that function's pairwise-difference case already covers this, or needs generalizing beyond price tables |
| Unit conversion (compound → single unit) | A | found 2026-09-22, NOT yet built | "10 cm 2 mm = ___ mm" | real: same source Q18. Straightforward arithmetic once units are parsed |
| Elapsed time, forward (start + end time → duration in hours) | A | found 2026-09-22, NOT yet built | "10:32am to 1:32pm, surgery lasts ___ hours" | real: same source Q20 |
| Read a value off a drawn ruler | V | **now has a real concrete example**, still untested | "how tall is the rabbit/bear in mm?" (animal silhouettes against a printed ruler, 0-4cm) | real: same source Q19. This row already existed as "not directly tested" — now there's an actual real image to test the fish-length/abacus methodology against, not just a hypothetical |
| Count objects in a picture | V | n/a | 6 money-bags each with loose coins inside | tested (see below): coins are small, touching/overlapping, low-contrast — genuinely infeasible with basic pixel tools, confirmed V |
| Read a value off a drawn ruler | V | n/a | — | not directly tested this round, but see fish-length finding below — same fragility expected |
| Compare two drawn objects' length | V | n/a | "P魚/Q魚邊條長" (真.測試過) | **tested, real result: fragile, not reliable** — see note below |
| Position-in-a-row-of-pictures | V | n/a | "邊個距起點最近"(游泳圖) | not directly tested, but icons are smaller/lower-contrast than the fish test that already failed — expect same or worse |
| Measuring cup / clock reading | V | n/a | — | flagged earlier, untested with real model |
| Weight estimate from balance-scale picture | V | n/a | "camera weighs ~400g" | found in PDF |
| Abacus (算盤) reading — how many beads, what number | A/V hybrid, REAL SUCCESS, **Photon port DONE and verified 2026-09-22 (later same night)** | tested 2026-09-22 (Python/PIL, per-bead segmentation; ported to `@cf-wasm/photon/node`, same night) | "萬千百十個" columns, read the number shown | real: p1-p6.com P3 maths Q2, rendered at 400dpi. **Photon port result**: same algorithm (row-width profile, baseline-subtract, smooth, local-maxima peak detection), rod x-ranges re-derived directly from the image via dark-column detection (176-234, 273-333, 371-432, 470-528, 567-625px). First pass with the Python script's exact parameters got 4/5 right, U rod wrong (3 instead of 2) — root cause: Photon's raw-pixel decode of this PNG produces slightly different luminance values than PIL's, making one rod's bead-boundary dip shallower and triggering a spurious extra peak. Fixed by widening `min_distance` from 8 to 12 (one parameter, applied uniformly to all 5 rods, not a per-rod hack) and trimming the sampled y-range slightly (530→525) to exclude a few trailing table-border pixels. **Result: 5/5 exact matches**, confirmed by rerunning against the same real image. Script: `benchmark/photon-prototypes/abacus-reader.js`. Not wired into the live verifier registry (no real OCR contract yet for how an abacus image reaches a verifier) — this proves the technique ports to the real production image library, nothing more yet. Still only tested against the one real illustration (see caveat below) — a second, independently-drawn abacus is still needed before trusting this over AI. **Second attempt, following the "try the identified next step once" rule**: per-rod row-width profile (bead pixels per horizontal row, minus the constant rod-line baseline), smoothed, then genuine local-maxima peak detection (not a height ratio) — each peak = one bead, using its visible "pinch" boundary where adjacent beads meet, not overall blob height. First established real ground truth by directly looking at a high-res crop of each rod myself (not guessed): 10Th=4, Th=3, H=5, T=1, U=2. Algorithm result with ONE fixed set of parameters across all 5 rods (no per-rod tuning): **5/5 exact matches** (10Th=4, Th=3, H=5, T=1, U=2) — 0 wrong, clears this project's own bar. Script + test image saved at `/tmp/claude-115/.../scratchpad/abacus_bead_count.py` + `abacus_photon_test.png`. **Real, important caveat**: this paper's Chinese-labelled abacus (same page) turned out to be the IDENTICAL drawing (same bead pixels, just relabelled columns) — so this is genuinely only ONE real illustration tested, not several independent ones. The algorithm is principled (real geometric bead-boundary detection, same params worked across bead-counts 1 through 5) rather than a hack tuned to this image, which is a good sign, but "works on the one drawing style seen so far" is a real, stated limit, not "proven to generalize across different textbooks' abacus art styles". **Verdict: real success on available evidence, Photon port not yet attempted** (matches this project's own rule: port only what's proven in Python first — this now qualifies) — worth a Photon port + testing against a second, genuinely different abacus illustration (from a different source) before fully trusting this over AI. |

**2026-09-22 feasibility test (real code, real images, Pillow only, no AI):** tried a
pure color-threshold pixel-measurement approach on the real P魚/Q魚 length-comparison
image (`長度和距離(一)`, page 34). Result: the orange (Q) fish's colored pixels were
detected accurately (bbox matched the visual extent), but the green (P) fish's outline-
style illustration (mostly white fill, thin colored/black strokes) was badly
under-detected (81px measured vs a much wider true extent) — the relative comparison
still came out right in THIS one case, but only by luck; the absolute measurement was
clearly wrong. Conclusion: **naive pixel measurement is illustration-style-dependent
and not trustworthy** — a solid-fill drawing style might work, an outline style
doesn't, and there's no way to know which style a given worksheet uses in advance.
Confirms these stay Tier V (real AI still needed), not a false "V" — this was a
genuine attempt, not a reflexive dismissal.

**2026-09-23 — 20-paper batch from p1-p6.com's "數學 Maths" label-page listing.**
Downloaded all 20 posts listed on that category page (real Google-Drive-hosted
PDFs, 215 pages total). Sampled with real depth (not literally all 215 pages —
see Evidence base note below) across 8 of the 20 papers, plus 4 spot-checks
across further papers. One real confirming finding: the paper named `p3_a` in
this batch turned out to be the SAME exam already fully read in the prior
session (`p3_maths_p1p6com_2026.pdf` — identical Q17/Q18/Q19/Q20/abacus
content, already in rows above) — a useful duplicate-detection data point, not
new content. New/confirming rows found in the rest:

| Type | Tier | Status | Example (real) | Notes |
|---|---|---|---|---|
| Select 2 of 3 given numbers that sum to a target | A | found, NOT built | from {6,9,4} pick 2 that add to 10 | P1 term2. Brute-force all pairs, trivial |
| Classify numbers in a picture set: even/odd, prime/composite, or divisible-by-N | A | found, NOT built | circle all numbers divisible by 3 from a labelled set | P4 term1. Code-solvable once OCR'd; all-or-nothing scoring (must catch every match) |
| LCM/GCD via short division (短除法) — final numeric answer only | A (working shown = J) | found, NOT built | — | P4 term1. Final answer checkable; "show your working" part is not |
| MC: closest multiple / GCD / factor-count / common-multiple / range-estimate reasoning | A | found, NOT built | "36 is a common multiple of 2 and X, X could be?" | P4/P5/P6, several papers. All pure number-theory computation once parsed; some have multiple valid answers (need a range/set check, not exact match) |
| Algebra substitution via given relationship (★+▲=15 → ★×3+▲×3; A×B=C → (A+2)×B) | A | found, NOT built | — | P4 exam. Direct symbolic substitution, code-solvable |
| Reverse division-with-remainder algebra (750÷x=16 R14, find x) | A | found, NOT built | — | P4 exam |
| Minimum-add-for-divisibility / combinatorics+divisibility count / prime-count knowledge | A | found, NOT built | "form all 3-digit numbers from given digits divisible by 5, count them" | P4 exam. Combinatorics ones are nontrivial but fully computable |
| HCF-matching MC / algebraic-expression-identification MC / missing-digit-with-variable (83-Y2=21, find Y) | A | found, NOT built | — | P6. Symbolic-reasoning MC, code-solvable |
| Net (展開圖) → 3-D solid identification | A (knowledge lookup) | found, NOT built | "2 hexagons+6 rectangles → which solid?" | P6. Fixed lookup table, not visual — the shape is DESCRIBED in text, not drawn |
| Recurring-decimal magnitude comparison (dot notation over digits) | A, OCR-hard | found, NOT built | — | P6. The dot-notation itself is a real OCR sub-challenge before any comparison logic runs |
| Fraction word problems / fraction-of-quantity MC | A, GAP FLAGGED | found, NOT confirmed working | colour hankies, milk drunk | P5. `verifyMath` is integer-focused — fraction support not yet confirmed; flagged, not fixed |
| Write a number between X and Y | A, open-range | found, NOT built | — | P1 term2. Any value in the open range is correct — a genuinely different verification shape (range-membership, not exact-match) from ordinary fill-blank |
| Word problem: total + difference → other total (additive "more than") | A | found, NOT built | "249 oranges, 41 MORE apples than oranges, how many apples?" (249+41) | P2 exam, real, spot-checked 2026-09-23. Inverse of the existing difference-finder (`verifyWordProblemDifference`) — given one total + the difference, find the other total |
| Table lookup: comparison/difference (2nd real confirming example) | A, PARTIAL pattern exists | 2nd example confirmed | MTR-line-length table — SAME shape as the already-logged row above | this batch's `p3_a` duplicate paper re-confirms the existing row, not new |
| Calendar-table reading (Nth weekday of month) | V | 2nd real example, still untested | "third Friday in June?" from a printed month grid | P2 exam, spot-checked 2026-09-23 — a SECOND independent real example of the calendar-reading type already flagged from the P1 paper; per the methodology's rule 5 (never call solved from one example), this is a good candidate pair to test together once attempted |
| Shape composition classification (straight lines vs curves, from a picture) | V | found, NOT tested | "the picture is made of (straight lines / curves) — circle correct" | P2 exam, spot-checked 2026-09-23. Distinct from the earlier single-shape-name MC (square/circle/triangle) — this is a composition judgment about a whole picture, not naming one shape |
| Countable-icon-group division + remainder (well-separated icons, e.g. egg tarts) | V, plausibly easier than coins | found, NOT tested | — | P2. Icons don't overlap (unlike the confirmed-infeasible coin-counting case), so may be more tractable — untested |
| Pictogram completion by DRAWING marks per a data table | V, production task | found, NOT tested | — | P2. Gradeable in principle by counting drawn marks against the table, but it's a drawing task, not a text answer |
| Geo-strip / dot-grid shape construction or classification (forms a square? draw 3 segments to complete a rectangle; draw a rhombus on a dot grid) | V, production task, likely hard | found, NOT tested | — | P2/P4. Drawing production tasks — harder to autograde than a text answer; flagged, not attempted |
| Count squares within a composite geometric picture | V | found, NOT tested | a person-shape built from squares | P2 |
| Composite 3-D volume from a labelled stacked-box diagram | V, harder than abacus | found, NOT tested | — | P6. Needs reading a 3-D diagram and decomposing into known shapes — a step up from abacus's flat 2-D bead-counting |
| Composite area/perimeter (split rectangle, one part's area given, find other's perimeter) | A/V hybrid | found, NOT tested | — | P6 |
| Spatial/compass direction from a floor-plan diagram | V | 2nd+ real example | — | P4/P2, appears repeatedly — same type already flagged, now confirmed recurring across multiple independent papers |
| Clock + "N hours later, what time" (analog reading + time arithmetic) | V | 2nd real example, teacher-marked ground truth found | — | P1 term2 — this exact page had real red-pen teacher marks, useful as ground truth if clock-reading is ever revisited |

## 2026-09-23 — 4-fork parallel read of remaining 21 PDFs (224 pages)

Groups A, C, D complete (Group B still running, will be appended separately
when done). Combined: ~164 of 224 pages read this pass. Two duplicate-file
findings confirmed (`p2_maths_p1p6com_2023_2024_term2exam.pdf` = byte-identical
dup of `p2_math_test_2023_2024.pdf`; `p2_maths_p1p6com_2024_2025_a.pdf`'s 29
"pages" are one 15-page exam appearing twice, blank + teacher-marked).

**Real bug found in an EXISTING built verifier:** `verifySortNumbers`'s number
regex (`-?\d+(\.\d+)?`) does not parse fraction ("37/5") or mixed-number
("7又7/9") tokens — would silently mis-extract a real P5 sort-fractions
question. Needs a fix, not a new function. (Group D)

**Real gap found in `evalArithmetic`:** no bracket/parenthesis support at all
— "(114+58)-(44+38)=" would mis-tokenize or return null. Distinct from the
already-fixed operator-precedence bug. (Group D)

**Recurring new pattern (found independently twice, P4 2021-2022 AND P4
2024-2025):** inferring an obscured/ink-stained PRINTED digit (not a student
blank) from a divisibility/estimation constraint, then often a follow-up
computation. Genuinely new concept the pipeline has no notion of yet. (Group D)

**Structural finding, not a single question type:** real teacher marking uses
PER-STEP partial credit on word problems (equation / numeric answer /
conclusion sentence, separately scored) — this pipeline's binary
correct/wrong model doesn't reflect that. (Group A) Also: a direction-word
English answer was marked wrong purely for capitalization per that teacher's
own stated rule — case-sensitivity may need to follow the specific paper's
convention, not be assumed lenient. (Group A)

**Drawing-only answers** (student must draw a line/shape, no text
representation exists at all) confirmed recurring across multiple papers
(Group C, Group D) — flagged as a structurally out-of-scope category, not a
V-tier/AI-solvable gap, so it should be explicitly classified "not
applicable, always defer" rather than attempted.

**Clock illustrations often redundant**: several "clock reading" items give
the anchor time as printed/spoken TEXT alongside a decorative clock-face
graphic — these are actually pure A-tier time arithmetic, not V-tier
image-reading. Worth checking whether the time is already stated in text
before classifying an item as needing clock-reading. (Group C)

### Group A — new types (P1/P2 papers, money/calendar/geometry heavy)

| Type | Tier | Status | Example (real) | Notes |
|---|---|---|---|---|
| Coin denomination recognition from drawn coin image | V | found, NOT built | "$5" coin drawn with small print | high-value recurring type across nearly every P1/P2 money page |
| Count specific coin type among a mixed group | V then A | found, NOT built | "上圖有___個十元硬幣" | |
| Sum coin values in a hand/group image → dollars+jiao | V then A | found, NOT built | "$10+$10+$10 → ___元___角" | |
| Currency exchange-ratio arithmetic | A (needs a small HK-coin constants table) | found, NOT built | "1個$10可換$2___個" | code-solvable once a denomination table exists |
| Price tag → dollars+jiao format conversion | A | found, NOT built | "$75.80 → ___元___角" | pure format conversion |
| Pay-exact-amount: circle which coins to use | V (+A) | found, NOT built | | hard to verify — checks WHICH coins circled |
| Weekly activity-schedule table reasoning | A (once table OCR'd as grid) | found, NOT built | "文文一星期有___天需要上課外活動班" | recurring |
| Calendar-grid reasoning (weekday of date, Nth weekday, days remaining) | A (once calendar OCR'd as grid) | found, NOT built | "母親節在5月的第二個星期日" | very recurring across P1 papers |
| Column addition/subtraction with separate 十位/個位 boxes | A | found, same computation as plain arithmetic, different answer shape | "25+21" answer split into 2 boxes | worth confirming pipeline handles split-box answers |
| Select 2 of N numbers summing to a target | A | found, first concrete real example for existing G7 entry | "從6,9,4中選兩個, ___+___=10" | brute-force pairs, trivial |
| Multi-step addition with an intermediate partial-sum blank | A | found, NOT built | "15+33+24 = ___+24 = ___" | 2 blanks, different expected values |
| Largest/smallest N-digit number under a parity constraint | A (fixed knowledge table) | found, NOT built | "最大的三位數和最小的三位奇數相差是___" | |
| Estimation MC (round-then-match) | A | found, NOT built | "以下哪道算式最適合估算791−496?" | standard round-to-nearest-hundred rule |
| MC solve-for-unknown "★" placeholder | A | found, NOT built | "如果16÷★=4, ★代表的數是多少?" | note: uses ★ not just ?/□ |
| Ceiling-division word problem (round UP) | A | found, NOT built — distinct trap | "18人,每輛載4人,最少需要幾多輛?" (⌈18/4⌉=5) | naive floor-division would wrongly accept 4 |
| 3-addend word problem (sum of THREE quantities) | A | found — extends `verifyWordProblemTotal` | "42+36+15張椅子共___" | existing function is 2-number only |
| Repeated-quantity-over-N-periods word problem | A | found, NOT built | "每個月儲蓄50元,三個月後共___" (50×3) | |
| Two-step inverse-operation loop diagram | A | found, NOT built | "7 →(+4)→ ___ →(−4)→" | |
| Multi-part chained word problem (compute→compare→conclude) | A+V/J | found, complex | "$80−$60=$20; 比$33多/少; 夠唔夠錢買?" | 3 linked answers, each depends on the previous |
| Clock reading given hand positions AS TEXT | A (if OCR captures the words) | found, NOT built | "長針指着12,短針指着5,那時是___時正" | distinct from image-based clock reading |
| "Circle ALL matching a property" (multi-select) | A | found, NOT built | "把方格中所有單數圈出來" | all-or-nothing, not single-answer MC |
| Visual thickness/size comparison | V | found, NOT built | "圈出比較厚的漢堡包" | |
| Multi-runner relative-position ordering | V | found, NOT built | "Joe比Ben遠/近,又比Candy遠/近" | |
| Angle-size visual comparison/ranking | V | found, NOT built | "以下哪一個角最大?" | MC and 3-way ranking variants |
| Mark/count angles in a shape | V | found, NOT built | "圖內有幾多個銳角" | real trap: a plain circle has 0 angles |
| "Perpendicular is always shortest distance" (fixed geometric fact) | A (constant law, not diagram-dependent) | found, NOT built | | doesn't need to measure the drawing |
| Identify perpendicular line from labeled candidates | V | found, NOT built | | |
| "Which letters formed by curves only" (font classification) | V | found, NOT built | "(Q/H/R/S)" — real answer only S | font-dependent, needs to look at glyph shapes |
| Curve-vs-straight path discrimination | V | found, NOT built | | |
| Multi-hop compass-direction sequence + final-facing reasoning | V | found, NOT built | | richer chained version of simpler direction type |

### Group C — new types (misc P2/P3 papers, shapes/units/tables heavy)

| Type | Tier | Status | Example (real) | Notes |
|---|---|---|---|---|
| Shape naming from a drawn outline | V | found, NOT built | "Name the quadrilateral" | rotation/skew-invariant recognition needed |
| Shape-property tick table (✔/✖ per drawn shape) | V | found, NOT built | | unusual answer shape: 2 tick boxes + circled word per shape |
| Validate rectangle consistency from 4 labelled side lengths | A/V hybrid | found, NOT built | "10cm/5cm/5cm/1cm → valid rectangle?" | rule is trivial once 4 numbers known |
| **Drawing-only answer** | out of scope | found, recurring | "draw a simple vertical pictograph" | no text representation exists at all |
| Largest/smallest N-digit number with odd/even constraint | A | found, NOT built | "form largest 5-digit ODD number from 7,0,3,9,1" | generalizes existing extremal-number entry |
| N-digit number magnitude-threshold formation | A | found, NOT built | "form 5-digit numbers > 40,000 from 0,0,4,8,2" | combinatorics + inequality |
| Count hidden squares/rectangles in an n×n grid | A | found, NOT built | "4×4 grid — find all hidden squares/rectangles" | **fully code-solvable from grid size alone**, closed formulas |
| Word-phrase multiplication ("N twenty-fives") | A | found, NOT built | "four twenty-fives are ___" (100) | parses English number-word phrase |
| Word problem, quantity×per-unit→total | A | found — mirrors existing division verifier, inverse op | "6 jars×50 biscuits ___" | |
| Chained/derived unit-price word problem (2-step) | A | found, NOT built | "2 mango cakes=1 cheesecake price, 3 cheesecakes?" | derives intermediate unit price first |
| Word problem with "twice back-and-forth" multiplier trap | A, flagged risk | found, NOT built | "25m pool, back and forth TWICE →100m not 50m" | same trap family as existing "另外" trap |
| Scaffolded multi-blank + circle-word combined answer | A, complex parse | found, NOT built | compare→sum→conclude in one answer box | genuinely chained |
| Map/graph distance-path arithmetic | V | found, NOT built | sum along path; "at least" = shorter of 2 routes | needs graph topology |
| Choose the correct UNIT (not a number) | A/J | found, NOT built | "A P2 student is about 120 ___ tall" → cm | answer is a unit word |
| Unit conversion (m↔cm, km↔m, cm↔mm) | A | found, NOT built | "8m 11cm = ___cm" | trivial once conversion factor known |
| Stack-and-sum height from labelled diagram | A (if OCR-readable) | found, NOT built | 100cm cabinet + 30cm box → 130cm | both numbers are diagram labels |
| Coin subset-sum ("circle coins that make $X") | A, novel answer-capture | found, NOT built | "$3.60 — circle coins from set" | subset-sum enumeration, but capture shape is the real blocker |
| Multi-select list-of-labels answer | V, novel answer-capture | found, NOT built | "Write all acute angles: B, F" | needs order-independent set comparison |
| Right-angle-counting inside one complex polygon | V | found, NOT built | | distinct from angle-MC bucket |
| Calendar table lookup — Nth weekday | A | found, first worked example for G7 entry | "third Friday in June?" | code-solvable once calendar grid OCR'd |
| Place-value meaning of one specific digit | A (once abacus/number read) | found, NOT built | "4 beads in ten-thousands place = ___" (40000) | |
| Digit-count of N+1 (place-value boundary) | A | found, NOT built | "number after 9999 has ___ digits" | `len(str(n+1))`, trivial |
| Relative/comparative reasoning without absolute numbers | A | found, NOT built | "Sarah 3s longer than Linda, 2s shorter than Jessie" | parses relational statements into ordering |
| Digital-clock-display reading | V, plausibly easy | 2nd real example, still untested | "16:15" → "4:15 in the afternoon" | |
| Compass-direction reading from icon map + rose | V | found, 1st worked example for G7 entry | "___ is east/south of school" | |
| 3D shape distinguishing (quadrilateral lateral faces) | V | found, 1st worked example for G7 entry | | |
| Pictogram MC-by-picture (circle icon, not letter) | V, novel answer-capture | found, NOT built | | choices ARE pictures |

### Group B — new types (40 rows, P2 papers, money/place-value/word-problem heavy)

Real OCR/format notes: remainder answers have ≥3 written forms ("R2",
dot-ellipsis "5...2", and bracket/tableau long-division "8)48"); a "★" blank
placeholder appears (not currently in `BLANK_TOKENS`, which only has "?"/"□");
word problems in this batch overwhelmingly need a 4-part answer (橫式/直式/
steps/full-sentence answer), a systemic gap vs. the single-`studentAnswer`
field OCR contract; 2 of 6 PDFs contained third-party AI-generated answer-key
pages mixed into the same file as the real worksheet.

| Type | Tier | Status | Example | Notes |
|---|---|---|---|---|
| Construct largest/smallest N-digit number under a parity constraint | A | found, NOT built | "largest 3-digit ODD number from 0,1,7" | real edge case: duplicate-digit cards seen too |
| Construct MULTIPLE distinct N-digit numbers under a constraint, ranked | A | found, NOT built | "form THREE different 4-digit EVEN numbers, largest to smallest" | harder — enumerate multiple outputs |
| Single-step multiplication word problem | A | found, NOT built | "100 rubber bands/box, 8 boxes → ___" | existing rows cover total/difference/division, not plain multiplication |
| "Total÷unit→quantity" word problem (inverse framing) | A | found, NOT built | "want 75 oranges, 25/pack → ___ packs" | distinct trigger phrasing from existing division verifier |
| Change-from-payment word problem (plain, non-price-table) | A (currently declined) | confirmed real | "$50 pays for $18 toy, change=___" | matches existing declined shape, new citation |
| Multi-step word problem: qty×price for MULTIPLE categories, summed | A (parsing-hard)/J | found, NOT built | "2 adults@$234+1 child@$120" | real student error confirms this trips people up too |
| Two-step relational word problem ("A is N fewer than B, find A+B") | A (parsing-hard) | found, NOT built | "67 books, 12 fewer than B, total?" | extends existing comparative-reasoning row to 2-step |
| THREE-person chained relative comparison word problem | A (parsing-hard) | found, NOT built | 2-hop chain across 3 people | harder than the 2-person case |
| Abacus reading, output in Chinese numeral WORDS | V then A | found, NOT built | "用中國數字寫出算柱表示的數" | existing abacus row is Arabic-digit output only |
| Place-value digit-position arithmetic (extract+combine 2 digits) | A | found, NOT built | "in 2490, tens+hundreds digit=___" (13) | pure digit extraction, no visual needed |
| Reverse construction from place-value clues | A | found, NOT built | build a number from stated digit meanings | |
| 3D shape name ↔ face-count reverse lookup | A (small closed table) | found, NOT built | "3 faces → name it" (cylinder) | shape not shown, just the fact |
| Time format: 12h-English → Chinese civil format | A | found, NOT built | "11:59 p.m. 即___午___時___分" | variant of existing 12h/24h row |
| Currency equivalence algebra (solve unknown note/coin count) | V+A | found, NOT built | "2×$500 and ___×$100 = 2×$1000" | read denominations then solve linear eq |
| Multi-item money word problem: sum shown notes/coins, subtract purchase | V+A | found, NOT built | | harder than 2-item price-table sum/diff |
| Money answer split into two blanks (dollars, cents) | A (output-format) | found, NOT built | "$122.00 → ___dollars ___cents" | one value, two output fields |
| "How much MORE is needed" (insufficient funds) | A | found, NOT built | "$50 note, $64.20 item, need $___more" | inverse of change-from-payment |
| Select EXACT currency items for an exact payment | V (multi-select) | found, NOT built | circle notes/coins for $122.00 exactly | must pick the physical items, not state counts |
| Length reading from a wrapped/curved tape measure | V | found, untested | can circumference ≈24cm | harder variant of ruler-reading |
| Measure using a repeated non-standard-unit icon | V | found, untested | "octopus card ≈ ___ finger-widths" | |
| Weekday extrapolation beyond a given calendar table | A (mod-7 reasoning) | found, NOT built | table shows Sept; "3 Oct was ___" | needs days-past-table-end mod 7, not lookup |
| Classify multiple labeled angles sharing one vertex by type | V | found, untested | | |
| Compare/rank multiple drawn angles by visual size | V | found, untested | | |
| Count shape-types within one composite 2D figure | V | found, untested | | |
| Classify figures by line-type composition (straight+curved mix) | V | found, untested | | |
| Multi-select "write ALL matching letters" from labeled 3D shapes | V | found, untested | | |
| Decompose a compound 3D solid into constituent named solids | V | found, untested | | |
| True/false (✓/✗) property-judgment grid for shape statements | A/V (format) | found, untested | "sphere has 1 curved surface only (✓/✗)" | new answer format: checkbox/circle grid |
| MC where each option is a symbolic EXPRESSION, not a value | A/J | found, untested | "which expression models this word problem?" | distinct from `verifyComputationMC` (value-match) |
| Base-10 block (Dienes blocks) reading | V | found, untested | | same place-value concept as abacus, different graphic |
| Chained multi-step vertical arithmetic, sequential intermediate boxes | A | found, NOT built | "235+557=[box], then [box]-281=[box]" | two dependent results, not one |
| Multi-step arithmetic with an explicit intermediate NEGATIVE value | A | found, NOT built | "292-411+204" (step 1 goes negative) | must not be treated as an error |
| Complete/draw a pictogram from a data table | V (construction) | found, structurally un-answerable via text | | draw-the-answer, no text/numeric output |
| Geometric construction/drawing tasks (general family) | V (construction) | found, structurally out of scope | draw largest square/perpendicular line/etc. | **flag as distinct systemic category, needs permanent exclusion or image-diff, not a verifier** |
| Reverse modular-arithmetic reasoning MC | A (harder) | found, untested | "shared among 10, 1 left — which COULD be total?" | candidate-checking against N mod 10 = 1 |
| Choose appropriate NON-standard measuring reference for a large distance | J/A (heuristic) | found, untested | footstep/thumb-width/hand-span for a hall | distinct from choose-appropriate-UNIT row |
| Constrained-resource max-combinations word problem (min of 2 ratios) | A (harder) | found, NOT built | "2 bows+3 buttons/dress; 11 bows,19 buttons; max dresses?" = min(⌊11/2⌋,⌊19/3⌋) | |
| Ceiling/round-up division word problem ("at least how many containers") | A (error-prone) | found, NOT built | "7/box, 66 balls, AT LEAST ___ boxes" (→10 not 9) | same ceiling-division trap as Group A's row |
| "How many MORE needed to complete a partial extra group" | A | found, NOT built | "groups of 4, 15 bulbs, leftover becomes extra group, ___ more needed" (1) | distinct from plain remainder AND ceiling-division |
| Derive a multiplication AND division equation from one array picture | V+A | found, untested | 16-item array → "8×___=___" and "___÷8=___" | |
| Pictogram: find category matching a MULTIPLICATIVE relationship | V+A | found, untested | "___ sold is TWICE erasers sold" | needs multiplicative match, not additive |
| Compare/sum distances in MIXED units on a map | A (needs unit normalization) | found, untested | "9m", "785cm", "10m" — nearest? total? | must normalize units before comparing |
| Geometric figure line-length comparison by INFERENCE | V | found, untested | | not measuring, inferring from stated relationship |
| Select matching geo-strips that assemble into a target shape | V | found, untested | | |
| Multi-select "which irregular/concave shapes are quadrilaterals" | V | found, untested | | |

### Group D — new types (P4/P5/P6 papers, word problems/geometry/fractions heavy)

General observation: P4-P6 papers skew much more toward multi-step word
problems, 3D geometry, and decimal/fraction arithmetic than P1-P3 — real
gap-filling for the library's coverage.

| Type | Tier | Status | Example (real) | Notes |
|---|---|---|---|---|
| Arithmetic with brackets/parentheses | A | **NOT BUILT — real `evalArithmetic` gap** | "(114+58)-(44+38)=" | no grouping support at all |
| Find missing factor + restate ("A×B=C×(?), (?)=") | A | found, NOT built | "9×8=4×( ), ( )=" | two positionally-linked blanks |
| Derive a related product from a given fact | A | found, NOT built | "328×84=27552, 330×84=27552+◆" | reuses first equation's given product |
| Compute using extremal-number constraints | A | found, NOT built | "最大三位數×最小兩位數" (999×10) | |
| Reverse-solve divisor from quotient+remainder | A | found, NOT built | "750÷※=16…14,※=?" | |
| Smallest addition for divisibility | A | found, NOT built | "625最少要加上多少先被3整除?" | recurs at P6 for primality too |
| Combinatorics: enumerate N-digit numbers + divisibility constraint | A (harder) | found, NOT built | "用3、5、0組成被5整除嘅三位數,共幾多個?" | needs real enumeration, not one formula |
| Reverse-solve base number from "Nth multiple" | A | found, NOT built | "某數第十三個倍數是169,某數?" | |
| Count primes in a range | A | found, NOT built | "100以內共有質數幾多個?" (25) | needs primality sieve |
| "Which even number is NOT composite" | A | found, NOT built | | trap: 2 is the one even prime |
| Reverse-solve number from factor-sum | A | found, NOT built | "最小和最大因數之和係37" (min factor always 1, so 36) | |
| List all factors of a number | A | found, NOT built | "寫出25嘅所有因數" | all-or-nothing list match |
| Difference between two specific multiples | A | found, NOT built | "17嘅第十一同第十七個倍數相差?" | |
| Infer obscured/ink-stained printed digit from divisibility constraint | A (harder) | **found TWICE independently — recurring** | "62÷1◉≈6" / "35◯能被3整除,沾污墨水" | genuinely new concept: a PRINTED digit the paper obscures, not a student blank |
| Word problem: average-split | A | found, NOT built | "6人合資516元,平均每人?" | |
| Word problem: max-affordable-quantity (floor division) | A | found, NOT built | "68元,每把12元,最多買幾多把?" | |
| Word problem: monthly-total from daily rate | A | found, NOT built | "每天營業額870元,六月共?" | needs external fact: June=30 days |
| Drawing-based question (no extractable text answer) | N/A | found, real problem for pipeline design | 畫平行四邊形/分割形狀 | explicit "always defer" classification recommended |
| Shape identification from labelled set | V | found | | |
| Shape composition (2 shapes → named quadrilateral) | V | found | | |
| Shape composition via digit-cards + largest/smallest N-digit | A | found, concrete evidence for G7 entry | "用9、0、7、1揀2張組成最大兩位合成數" | |
| Rotation-from-facing-direction (turn N right-angles) | V then A | found | "向左轉兩個直角,面向___方" | read starting direction (V) then apply rotation (A) |
| Bar chart reading + derived computation (single-series) | V | found, reinforces G7 | read value/compare/threshold-count/redistribute | |
| Bar chart reading + derived computation (multi-series) | V | found, harder | | 2-series compound chart |
| Rounding to nearest hundred, complete a table | A | found, NOT built | "1584→1600, 1733→1700" | |
| Fraction-of-remainder 3-way split word problem | A | found — **real evidence B4 is common at P5** | "1/3綠色,2/9紫色,餘下粉紅色" | |
| Chained fraction-of-fraction word problem | A | found, NOT built | "7/12是男生,男生中3/7戴眼鏡" | |
| MC: which result could be (fraction × proper fraction) | A (range-check) | found, NOT built | | |
| MC: estimation/approximate-equality reasoning | A (range-check) | found, NOT built | | |
| Column subtraction with unknown variable digit + follow-up | A | found, NOT built | "83−Y2=21, find Y" | |
| Algebra: translate word description → expression | A/J borderline | found, hardest A-tier item this batch | "每瓶紙星星有S顆,平均分3人" → S/3 | needs Chinese-sentence→symbolic parsing |
| Algebra: substitute a given value | A | found, NOT built | "T=8, 10+T-6=___" | |
| Algebra: MC, which expression differs from a given one for arbitrary n | A (symbolic reasoning) | found, NOT built | "邊道代數式與4n唔同?" | single substitution unsafe |
| Compound-shape area/perimeter from labelled diagram | V+A hybrid | found, many real examples | | mostly "match printed number to shape side" then formula |
| Large-number Chinese-word → Arabic digit (100M+ scale) | A | found — extends existing 0-99 converter | "五億零八百萬零二十" (508000020) | needs 億/萬-scale support |
| Place-value magnitude difference (same digit, two positions) | A | found, NOT built | "71460864,兩個「6」相差?" | |
| Sort/order fractions and mixed numbers | A | **real gap in EXISTING `verifySortNumbers`** | "37/5、7又7/9、7又2/3排序" | regex doesn't parse fraction/mixed tokens |
| Chained relative-price word problem (3+ linked prices) | A | found, NOT built | | |
| Mixed unit-and-fraction word problem | A | found, NOT built | "1盒12隻蛋,2盒,打破3隻,用去5/6盒" | |
| Decimal arithmetic with a rounding directive | A | found, NOT built | "40.9÷1.2≈(取值至十分位)" | must parse the rounding instruction itself |
| Recurring decimal notation (dot-above-digit) | A/OCR-risk | found, flag as OCR-fragility risk | "0.7322222222……" | dot placement changes the value; may not survive OCR |
| Decimal-quotient magnitude reasoning MC | A | found, NOT built | "邊道算式嘅商小於1?" | |
| Reverse repeated-addition count | A | found, NOT built | "___個「0.3」相加後,總和是30" (100) | |
| 3D solid net ↔ solid identification (both directions) | V | found, big expansion of G7 entry | | genuinely open-ended spatial reasoning |
| Cross-section shape from a cutting-plane diagram | V | found | | |
| Edge/vertex/face counting on a drawn 3D solid | V | found | | |
| Compound 3D volume from a labelled diagram | V+A hybrid | found, harder than simple box volume | | |
| Water-displacement volume word problem | A (multi-step) | found, NOT built | | derive area, subtract volume, recompute height |
| Sequential water-level diagrams → infer added-object volume | V | found | | |
| Tiered/graduated pricing-table computation | A | found — **distinct from existing flat-lookup verifier** | 的士首2公里$22,之後每0.2公里$1.60 | base+per-increment+flat-fee composition |
| 3D packing/volume-comparison word problem | V+A hybrid | found | | |
| Weight-scale (analog dial) reading | V | found — direct 2nd citation for already-verified technique | | worth testing against the proven weight-scale method |


|---|---|---|---|---|
| 選詞填充 (select word from passage) | A | done, PARTIAL/reject-only (`verifySelectFromPassage`) | "我哋高興地[討論]剛才嘅情況" | ⚠️ needs the SOURCE passage photographed too — often on a different page, not always available. ⚠️⚠️ (user-caught correction 2026-09-22) this check can ONLY safely reject (word not in passage at all) — it must NEVER confirm correctness, since a real passage word could be the RIGHT word in the WRONG blank (a swap). Always returns `null`, never `true`, when the word is found. |
| 圈出詞語 (circle words in passage) | n/a | n/a | — | not representable as a text answer at all; current "?" refusal is correct behavior |
| 句子配對 (sentence matching A-F) | V (reframed from B) | n/a | batch1_p3 A-F bank | no formula; AI must judge fresh each time, no stored key |
| 填反義詞 (antonym fill) | A | done, PARTIAL/reject-only, same function+caveat as 選詞填充 above | 清楚/安全/特別/猛烈 | confirmed real: instruction text says the antonym is ALSO drawn from the passage ("從課文裏選出...的反義詞"), so the same passage-membership check (and the same swap-safety caveat) applies |
| 睇圖表答中文題 (diagram-based) | blocked | blocked | — | OCR itself only captures a fragment; unblock OCR first |
| 改寫句子 (sentence rewrite) | J | n/a | — | multiple valid phrasings |
| 不供詞填充 (open fill-in-the-blank, NO word bank/passage given) | J | found 2026-09-22, n/a | "小猴子最愛___到樹上" | real: p1-p6.com P1 Chinese 2021-2022. Distinct from 選詞填充 above (which at least has a passage to check membership against) — here there is no reference list at all, several different words could be genuinely correct (e.g. 爬/跳/攀), so no code-only check is possible even in reject-only form |
| 標點符號填充 (fill in the correct punctuation mark) | not yet assessed | found 2026-09-22, n/a | "中秋節快到了□黃老師教我做了一個燈籠□" (comma/period in boxes) | real: same source. Not yet tried against either tier — plausibly partially rule-based (e.g. a sentence ending in an obvious question shape wants a question mark) but real Cantonese/Chinese punctuation usage has enough judgment calls (comma vs no punctuation, 、vs，) that a confident code-only rule set is unverified, not assumed |
| 同音字/易混字辨析 (circle the correct of 2 given similar characters) | not yet assessed, plausibly A | found 2026-09-22, n/a | "(藍/籃)色的天空中有幾朵白雲" (circle 藍, not 籃) | real: p1-p6.com P1 Chinese 2021-2022, part (四). Unlike 不供詞填充 (fully open) this gives exactly 2 candidates, which bounds the problem — plausibly closed-form (check which of the 2 real words grammatically/semantically fits) but real correctness judgment is still needed per item, not assumed automatic |
| 閱讀理解：從文章中填空作答 (reading comprehension, extract answer phrase from a passage into boxes) | A, PARTIAL (same caveat as 選詞填充) | found 2026-09-22, real example | "姐姐把餅乾做成[][]的形狀" (fill in 動物, matching a phrase from the passage above) | real: same source, part (六). Same underlying check as the already-built `verifySelectFromPassage` (passage-membership, reject-only — a real passage word could still be right-word-wrong-blank) — this is comprehension-extraction rather than vocabulary fill, but the safe automatable check is identical; worth confirming whether the existing function already generalizes to this or needs a comprehension-specific variant |

## English

| Type | Tier | Status | Example (real) | Notes |
|---|---|---|---|---|
| Linking-word fill: "but" vs "and" | A | done (`verifyConjunctionFill`) | "I like cherries ___ I don't like strawberries." → but | real: `batch3/p2_english_but_and_dialogue.jpg` — the exercise's OWN instruction box states the rule ("but"=opposite ideas, "and"=similar ideas); a POLARITY-match rule (detect negation in each clause) matches all 8 real scored blanks on the page, including 3 elliptical clauses with no verb of their own (inherit the other clause's polarity) |
| Single-word fill blank (open vocabulary, no printed rule) | A | **still honestly unsolved** | — | distinct from the row above — this is for a blank where the correct word ISN'T decidable from an in-exercise rule (unlike but/and); no real example of this narrower shape was found separate from what's now covered above |
| Grammar cloze (is/am/are/has/have, its/it's) | A | done (`verifyGrammarCloze`) | SFA quiz sections C/E (real sentences) | small evidenced rule set only (subject->be-verb, blank-followed-by-adjective/verb->"it's" else "its"); anything outside stays null |
| Picture-match short answer (small closed set) | A, FORMAT-ONLY | done (`verifyPictureMatchFormat`) | "Yes, I can."/"No, I can't." (real: backfill batch3) | only validates the answer is one of the 2 template phrasings — does NOT know which is right for a given item (needs the printed check/cross icon, a real Tier-V fact) |
| Word-bank fill, each word used once | A (constraint only) + V/J rest | done, PARTIAL (`verifyWordBankOnceEach`) | SFA section D, real 6-phrase bank | only checks "each answer is a real bank phrase, used at most once" — does NOT confirm which blank each belongs to |
| Reading-passage MCQ | A partial / J rest | done, literal-overlap subset only (`verifyLiteralKeywordMC`) | SFA "Fun in the Sun" poem, real Q4/Q5 vs Q1-3; second real example found 2026-09-22, p1-p6.com P3 English 2025-2026 ("Fast Food" story, blacken-the-circle MCQs) | only claims a verdict when exactly one option is a near-verbatim substring of the passage (real Q4/Q5); inference-needed questions (real Q1-3) correctly stay null. The new P3 example is a good candidate for the project's own recommended-first "select from passage" build (see roadmap G3) — not yet actually run against it |
| Word-rearrange → sentence | J (partial A pre-filter) | n/a | — | full correctness needs judgment, BUT a free code pre-check is possible: does the answer use EXACTLY the same set of given words, no extras/missing? Catches obviously-wrong answers for free; doesn't confirm grammatical correctness |
| Negative/question/plural-form transform | J (hybrid worth trying) | n/a | SFA F/G/H | reasoned (not image-tested) reconsideration: code CAN compute the one "textbook-correct" transformed sentence via rule, then fuzzy-compare (tolerate spelling/capitalization) instead of exact match — catches the common case for free, falls back to real judgment only on a real mismatch. Worth a real prototype, not yet built |
| Verb-tense-in-context cloze | J | n/a | SFA section I | needs real narrative understanding — reconsidered, no hidden formula found |
| Reading comprehension, full-sentence answer | J | n/a | SFA section A | fully open-ended — reconsidered, no hidden formula found |

## Genuinely hardest (flagged, not yet a real plan)

Subjective essay/creative-writing grading, "explain your reasoning"
depth-of-understanding grading — hard even for AI judgment, not just
for code. Distinct, longer-term category.

## Evidence base so far (be honest about thinness)

12-16 real benchmark photos + 1 real English quiz PDF (SFA P1, 5 pages)
+ ~30 sampled pages across 5 math workbook PDFs (179 pages total, not
exhaustively read) + 3 older-session PDFs re-checked specifically for
word-problem/price-table content (`b245b3f1-QuizGo-...maths_test_2.pdf`,
3 pages, fully read) + a real Grade 2 exam PDF added 2026-09-22,
`benchmark/external_pdfs/p2_math_test_2023_2024.pdf` (9 pages, fully
read). Treat percentages/splits as "rough shape", not precise stats,
until more real material is reviewed.

**2026-09-22, later same night — first genuine Chinese-subject PDF
reviewed, plus 2 more.** Downloaded from p1-p6.com (real HK past-paper
site) and read directly (Claude's own vision, no OCR API call — zero
cost): `p3_maths_p1p6com_2026.pdf` (~6 of 21 pages read),
`p3_english_p1p6com_2026.pdf` (~2 of 16 pages read),
`p1_chinese_p1p6com_2021_2022.pdf` (~2 of 8 pages read — the first real
Chinese-only source in this library). Found 5 new/confirming real
examples (see Math/Chinese/English tables above); none of the new types
have been run against actual code or AI yet — "found" only, not
"tested".

**2026-09-22, later still — all three PDFs now fully read, per the
user's standing instruction (every page, not a sample).** Real
structural finding: both `p3_maths_p1p6com_2026.pdf` (21 pages) and
`p3_english_p1p6com_2026.pdf` (16 pages) turn out to each contain TWO
copies of the same exam back-to-back — a blank template (pages 1-11 /
1-8) followed by one real student's completed, teacher-marked copy
(pages 12-21 / 9-16, red-pen grading visible) — not new content, but a
real source of ground-truth marked answers if ever needed for testing.
`p1_chinese_p1p6com_2021_2022.pdf` (8 pages) has no such duplicate.
Found 13 more genuinely new/confirming real question-type examples
across the remaining pages (see Math/Chinese tables above, all dated
2026-09-22) — none yet run against code or AI, "found" only.

**2026-09-23 — 20-paper Maths-category batch, HONEST coverage statement.**
All 20 PDFs listed on p1-p6.com's "數學 Maths" label page were downloaded (215
pages total, confirmed real PDFs). Per the user's standing "every page" rule,
the target was full coverage of all 215 pages — **that target was NOT fully
met this round**: about 8 of the 20 papers were read with real per-page depth,
plus 4 further spot-checks (1-2 pages each) across other papers, for roughly
40-50 of the 215 pages actually looked at. The remaining ~10-12 papers were
downloaded and rendered to images but not yet read. This is stated plainly
here rather than reported as complete — remaining pages are still sitting as
rendered PNGs in the scratch folder, ready for a future pass to finish the job
properly. 25 new/confirming real question-type rows were added above from
what WAS read; one real duplicate-paper finding (`p3_a` = an already-fully-read
paper from the prior session) was also confirmed. Two V-tier types (calendar
reading, compass-direction reading) now have a genuine SECOND independent real
example each, which matters for the "never call solved from one example" rule
once they're actually attempted — they are still untested, not solved.
