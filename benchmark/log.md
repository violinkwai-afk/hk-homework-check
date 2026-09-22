# Benchmark log

Testing/classification only — see `README.md`. Rows appended as batches
arrive; nothing here triggers a code change on its own.

**Ground-truth policy (2026-09-22, user instruction):** all 12 photos
across batches 1-3 have teacher red-pen marking. Ground truth for
"human-confirmed correct?" is worksheet-printed content + the child's
ORIGINAL pencil/handwritten answer only — teacher red-pen ✓/✗,
corrections, circles, and comments are a secondary reference only, never
treated as the student's answer. Where red pen overlaps/obscures the
original answer, or a handwritten mark is too small/unclear in the photo
to confirm confidently, the row is marked `ground_truth_uncertain` rather
than guessed either way. Raw images sent to `/api/mark` are always
unmodified originals — no red-pixel stripping or any other
preprocessing; exclusion happens only at this log's analysis stage.

## Per-item log

| Batch/ID | 題型 | Layer(s) | OCR result | Student answer | Verdict | Bbox | Latency | Human-confirmed correct? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| batch1_p1[0] | Chinese 句子配對 (4 items) | B, A | label="三", ans="1.F,2.A,3.D,4.B,5.C" | (merged) | needs_review | no | 4225ms | ground_truth_uncertain | 4 separate matching blanks merged into 1 item + a phantom 5th entry. Answer bank area has teacher red-pen circled corrections overlapping the student's original picks — can't reliably isolate original pencil answer from this photo. |
| batch1_p1[1] | Chinese 改寫句子 ×2 | A | label="四", both full rewritten sentences captured with trailing "(會)" annotations | as above | needs_review | no | 4225ms | ground_truth_uncertain | Base rewritten sentences look right; the "(會)" fragments look like teacher red-pen annotation folded into studentAnswer text rather than excluded — OCR isn't currently separating red-pen annotation from the student's own writing. |
| batch1_p2[0] | Chinese 選詞填充 (from passage) | F | "不可或缺" | same | needs_review | no | 4448ms | ground_truth_uncertain | Text matches the visible answer, but can't tell from the photo whether that text is the student's own pencil or teacher red-pen — underline color unclear at this resolution. |
| batch1_p2[1] | Chinese concept-map fill (總述/分述/總結 diagram) | G, B | "眼鏡,方格" | same | needs_review | no | 4448ms | not correct | Task requires filling multiple labeled boxes in a concept-map diagram; captured only a 2-word fragment, not the actual structured diagram content. Confirms concept-map/diagram fill-in is unsupported, not a near-miss. |
| batch1_p2[2] | Chinese "圈出詞語" (circle words within a passage) | G | "?" | n/a | needs_review | no | 4448ms | correct (safe refusal) | Task is literally "circle words in running text" — not representable as a text answer. Model returned "?" (own uncertainty marker) rather than guessing — correct, safe behavior; confirms this task-type has no path to a real answer under the current design, not a bug to fix. |
| batch1_p2[3] | Chinese reading-comprehension MCQ | F | "B.介紹不同眼鏡的用途。" | same | needs_review | no | 4448ms | correct | Matches the circled option in the photo. Correct capture; no verifier for MCQ correctness exists yet (expected — needs_review is right). |
| batch1_p3[0-6] | Chinese 選詞填充 ×7 | F | 討論/生動/目的/遊覽/講解/出發/"到達,首先" | same | needs_review (×7) | no | 6747ms | mostly correct | Clean 1:1 segmentation (contrast with batch1_p1's merge on a visually similar exercise type). Item 7 correctly captured as 2 values for the item's 2 blanks. |
| batch1_p3[7-10] | Chinese 句子配對 (4 items, global idx 8-11) | A | B / D / A / C | same | needs_review (×4) | no | 6747ms | discrepancy — see note | My own read of the photo's tiny handwritten circled answers looked like C/E/B/A, not B/D/A/C. Given how small/compressed the handwriting is in this photo, I'm not confident enough in my own read to call this a confirmed AI error — flagging as a discrepancy that needs the user to check against the physical book, not asserting the AI is wrong. |
| batch2_p1[0] | Math word problem, English, sharing w/ remainder (apples) | C, F | "7 apples;3 plates;2 apples on each plate;1 apple is left" | mixed printed+blank | needs_review | yes | 5511ms | correct values, wrong shape | The two real blanks (2, 1) are correct, but parser jammed them together with the pre-printed given numbers (7, 3) into one unusable semicolon string — no separation between "printed context" and "actual answer". subject misclassified "english" for what's really a math item. |
| batch2_p1[1] | Math word problem, English, sharing w/ remainder (erasers) | C, F | "14 erasers;boxes of 4;3 boxes;2 erasers left" | mixed printed+blank | needs_review | yes | 5511ms | correct values, wrong shape | Same pattern as above: real blanks (3, 2) correct, printed givens (14, 4) wrongly folded into the same answer string. |
| batch2_p1[2] | Math table, division w/ remainder ×5 rows | D, G | 5 rows captured as people→each→left triples | same | needs_review | yes | 5511ms | uncertain, needs zoom | Values for rows 1-3 look right (10÷3=3r1, 10÷4=2r2, 10÷5=2r0). Rows 4-5 have visible red-pen correction marks over the original numbers in the photo — can't confirm the original pencil values there without a clearer photo. subject=uncertain despite being pure arithmetic. |
| batch2_p2[0] | Math "Horizontal form" single blank (9÷3=3) | D | "3" | same | needs_review | yes | 2215ms | correct | Single value correctly captured. subject=uncertain (should be math) — detectSubject gap on this phrasing. |
| batch2_p2[1] | Math "Horizontal form" dual blank, quotient+remainder (11÷4=2...3) | D | "2;3" | same | needs_review | yes | 2215ms | correct | Both blanks correctly captured as separate values. needs_review is the right outcome — this is a genuine 2-blank shape, current Tier 1 design intentionally stays null on >1 blank rather than guess. Confirms Tier 1's boundary is being hit exactly as designed, not a bug. |
| batch2_p3[0] | Math sharing w/ remainder (shuttlecocks, 18÷4=4...2) | D | "4,2" | same | needs_review | yes | 6776ms | correct | Both blanks correctly captured. subject=uncertain again. |
| batch2_p3[1] | Math fact-family box (5×8=40, 40÷5=8, 40÷8=5) | A | mislabeled "18÷4", ans="30,8,5" | same | needs_review | yes | 6776ms | incorrect — real OCR error | First value should be 40, model read 30 — confirmed digit misread. Item's own label field also wrongly picked up "18÷4" (leftover from a neighboring item) instead of its own circled number — a real anchor/labeling bug, not just an OCR digit slip. |
| batch2_p3[2] | Math fact-family box (9×7=63, 63÷9=7, 63÷7=9) | C | label="3", ans="63,7,9" | same | needs_review | yes | 6776ms | correct values, wrong label | Values correct, but labeled "3" instead of the box's own circled "⑤" — same anchor/labeling inconsistency as the previous item. |
| batch2_p3[3] | Math fact-family box + circular arrow diagram (4×6=24 family) | D, G | label="4", ans="6,6,6,4,6,4" (6 values) | same | needs_review | yes | 6776ms | needs review | The rectangular fact box (3 blanks) and the circular arrow diagram expressing the same fact got merged into one 6-value answer. Not necessarily wrong content-wise, but the current design has no verifier shape for this — a real worksheet pattern (box + redundant circle diagram) Tier 1 wasn't built against. |
| batch2_p3[4] | Math fact-family box + circular arrow diagram (8×4=32 family) | D, G, E | label="5", ans="4,4,4,8,4,8" | same | needs_review | no | 6776ms | needs review | Same box+circle merge pattern as above; this one also has no bbox match (only item in this photo without one). |
| batch3_p1[0-5] | English sentence rewrite, "and"/"or" (6 items) | F | 6 full rewritten sentences captured cleanly | same | needs_review (×6) | yes | 6360ms | correct | Clean 1:1 segmentation, full sentence text captured accurately including item 2's messy cross-out/rewrite. No verifier exists for open-ended English writing (expected). |
| batch3_p2[0-1] | English fill-the-blank, single word ("but") | F | "but I don't like strawberries" / "but she doesn't tidy her room" | same | needs_review (×2) | yes | 4709ms | correct | Clean capture of simple single-blank dialogue lines. |
| batch3_p2[2-4] | English fill-the-blank, 2-part dialogue (3 items) | B | each merged both blanks of its dialogue (B-line + C-line, or A-line) into one answer separated by "\|" | same | needs_review (×3) | yes (2/3) | 4709ms | correct content, ambiguous shape | Both blanks per item captured correctly, but jammed into one string with a "|" separator rather than kept as 2 distinct sub-answers — same segmentation-boundary pattern as batch2_p1. subject flipped to "uncertain" on the 2 later ones despite being English fill-blank throughout. |
| batch3_p3[0-3] | English sentence rewrite, "and/but/or" (4 items) | F | 4 full rewritten sentences | same | needs_review (×4) | yes | 6258ms | correct | Clean capture, including handwritten corrections inline (e.g. "dolb" for "dolls" captured as written). |
| batch3_p3[4] | English letter-fill, 8 inline blanks in one running paragraph | B | label="5", all 8 words captured in order, semicolon-joined: "and;and;and;or;but;and;or;or;but" | same | needs_review | yes | 6258ms | correct values, wrong shape | All 8 answers individually correct and in the right order, but collapsed into one item instead of 8 — the hardest segmentation case in this batch (inline circled numbers inside a paragraph, not a numbered list) and the model didn't split it, though it also didn't lose or scramble any value. |

## Backfill — missing input from batches 1-3 (2026-09-22)

Reconciliation found each of batches 1-3 was actually 4 photos, not 3 —
the earliest-timestamped photo in each batch (the one attached to the
"batch N" caption) never reached this session as a notification (see
`feedback_telegram_album_first_photo_dropped` memory). These 3 rows are
that missing input, run against production `/api/mark` under identical
conditions (no code/prompt/model changes), clearly separated from the
original 9-photo set below.

| Batch/ID | 題型 | Layer(s) | OCR result | Student answer | Verdict | Bbox | Latency | Human-confirmed correct? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| backfill_batch1[0-6] | Chinese 選詞填充 (7 items) | F | 在/堅硬/可靠/便利/移動/相連/新式 | same | needs_review (×7) | no | 6066ms | correct | Clean 1:1 segmentation, consistent with batch1_p3's baseline for this exercise type. |
| backfill_batch1[7-10] | Chinese 填反義詞 (antonym fill, 4 items) | F | 清楚/安全/特別/猛烈 (each with trailing repeated sentence text) | same | needs_review (×4) | no | 6066ms | correct | Different task from 選詞填充 (antonym, not passage-lookup) but same clean capture behaviour. Item 8's OCR shows "清楚（全/全）" — a red-pen annotation ("全"?) folded into the text, same pattern as earlier red-pen-into-studentAnswer findings. |
| backfill_batch2[0] | Math sharing w/ subtraction algorithm (8÷4=2) | D | "8÷4=2" | same | **ok — correct** | yes | 2620ms | correct | First genuine true-positive `correct:true` verdict in the whole benchmark (12 photos). Matches the worksheet's own checkmark. |
| backfill_batch2[1] | Math sharing w/ remainder (12÷5=2 R2) | **D — confirmed verifier bug** | "12÷5=2 R2" | same | **ok — marked incorrect, correctAnswer="2.4"** | yes | 2620ms | AI's math judgment is wrong; whether "2 R2" itself is the student's original pencil answer (vs. red-pen-corrected value) is ground_truth_uncertain — see note | **Most severe finding across all 12 photos.** The verifier doesn't recognise "R" remainder notation and evaluated `12÷5` as plain decimal division (2.4), so a mathematically-valid remainder answer got marked wrong. This is an active false negative, not a coverage gap — unlike every other `needs_review` row in this benchmark, a real parent/child would see an incorrect "✗" here. This worksheet also has heavy overlapping red-pen correction directly on the answer boxes, so separately from the verifier bug, I can't fully confirm "2 R2" is the child's original pencil answer rather than the teacher's correction — flagging both issues rather than picking one. |
| backfill_batch3[0-3] | English picture-match short-answer (Yes/No modal Qs) | A | "Yes, I can.✓" / "No, I can't.✓" / "Yes, I can.✓" / "No, I can't.✓" | same | needs_review (×4) | yes | 4140ms | correct text, tick-mark folded in | Same red-pen-tick-into-studentAnswer pattern seen elsewhere (batch1_p1, backfill_batch1[7]) — third occurrence of this exact issue shape. |
| backfill_batch3[4-6] | English word-rearrange → sentence (3 items) | E | 3 full correct sentences | same | needs_review (×3) | no | 4140ms | correct | Clean text capture; these 3 are the only items in this photo with no bbox match, while the 4 short-answer items above them did get one — inconsistent bbox success within the same page. |

## Summary (as of batches 1-3 + backfill, 12 photos, ~45 items)

**Accuracy by subject, at a glance (2026-09-22):**

| Subject | Can the system judge right/wrong today? | Notes |
| --- | --- | --- |
| Math — plain arithmetic | **Yes, reliably** | Deterministic verifier, not AI judgment; the one confirmed bug (remainder "R" notation) has a tested fix ready (`fix/remainder-verifier` branch, not yet merged) |
| Math — blank-in-the-middle (Tier 1: single "?"/"□") | **Yes, reliably** | Working as designed; 2+ blanks intentionally stays `needs_review`, not guessed |
| Math — diagrams (fact-family boxes, circular arrow diagrams) | **No** | OCR captures values but no verifier shape exists for box+diagram combos yet |
| Chinese — any question type | **No** | OCR transcription only; zero correctness-judgment logic exists |
| English — any question type | **No** | Same as Chinese — transcription only |
| Anything requiring reading a picture/diagram to know the correct answer (measuring cups, clocks, graphs, 3-D shapes, pictograms) | **No, and structurally can't be "code does the math" style** | The correct answer itself depends on visually reading the image — this needs the AI's own judgment, not a deterministic check on top of OCR. See `project_ai_model_watch.md`'s criteria section. |

**Headline finding, updated with backfill: 1 `correct`, 1 `incorrect`,
~43/~45 `needs_review`.** The 2 non-`needs_review` verdicts both came
from the backfilled photos. One is a genuine true positive
(`8÷4=2` correctly marked correct). **The other is a confirmed false
negative**, and the single most serious finding in the benchmark so
far: `12÷5=2 R2` (mathematically valid remainder notation) was marked
`correct:false` because the verifier evaluated it as plain decimal
division (`12/5=2.4`) rather than recognising "R"-remainder notation —
see `backfill_batch2[1]` above. Every other `needs_review` across all
12 photos is a subject this pipeline has no verification path for at
all (Chinese, English, word-problem-with-embedded-blanks, fact-family
boxes) or a genuine intentional Tier 1 boundary case (batch2_p2[1],
batch2_p3[0]) — not a near-miss.

| Category | 題型 | 測試數量 | Correct | Incorrect | Needs review | Main issue | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F | Chinese 選詞填充 (fill from passage) | 8 | 0 | 0 | 8 | No Chinese-language verifier exists; OCR capture itself looks reliable | 目前應該 needs_review (OCR layer reliable; verifier layer doesn't exist yet) |
| F, B | Chinese 句子配對 (sentence matching) | 2 | 0 | 0 | 2 | 1 of 2 had 4 separate blanks merged into 1 item; the other's letter-answers didn't match my own (low-confidence) read of tiny handwriting | 需要較大架構改動 (segmentation) + ground_truth_uncertain on accuracy |
| A | Chinese 改寫句子 (sentence rewrite) | 1 | 0 | 0 | 1 | Values look right but teacher red-pen annotation appears folded into studentAnswer text | 可以安全改善 (exclude red-pen from OCR capture) |
| G | Chinese concept-map/diagram fill | 1 | 0 | 0 | 1 | Captured a 2-word fragment, not the structured diagram content | 需要較大架構改動 |
| G | Chinese "circle words in text" | 1 | 0 | 0 | 1 | Correctly refused with "?" — task has no text-answer representation | 目前已可靠支援 (safe refusal, working as intended) |
| F | Chinese reading MCQ | 1 | 0 | 0 | 1 | Correct capture, no MCQ verifier | 目前應該 needs_review |
| C, F | Math word problem, printed context + embedded blanks (English wording) | 2 | 0 | 0 | 2 | Real answer values correct but merged with pre-printed given numbers into one unusable string; subject misclassified as English | 可以安全改善 (separate printed-given from blank in parser) |
| D | Math table, division w/ remainder ×5 rows | 1 | 0 | 0 | 1 | Values plausible but red-pen corrections over 2 of 5 rows block confident ground truth | ground_truth_uncertain on 2/5 rows |
| D | Math horizontal-form, single blank | 1 | 0 | 0 | 1 | Correct capture; subject detection says "uncertain" not "math" | 可以安全改善 (detectSubject gap) |
| D | Math horizontal-form, dual blank (quotient+remainder) | 2 | 0 | 0 | 2 | Both values correctly captured; needs_review is the CORRECT Tier 1 outcome for a genuine 2-blank item | 目前已可靠支援 (working as designed) |
| A, C | Math fact-family box, single equation, blank in varying position | 2 | 0 | 0 | 2 | 1 has a confirmed digit misread (30 vs 40); both have item.label picking up unrelated leftover text instead of the box's own circled number | 可以安全改善 (label/anchor bug) + needs bigger look at digit accuracy |
| D, G | Math fact-family box + redundant circular arrow diagram | 2 | 0 | 0 | 2 | Box and circle diagram (same fact, 2 representations) merged into one 6-value answer; no verifier shape for this exists | 需要較大架構改動 |
| F | English sentence rewrite (and/or/but) | 10 | 0 | 0 | 10 | Clean, accurate full-sentence capture incl. messy handwritten corrections; no open-ended-writing verifier | 目前應該 needs_review (OCR layer reliable) |
| F | English single-word fill blank | 2 | 0 | 0 | 2 | Clean, correct capture | 目前應該 needs_review (OCR layer reliable) |
| B, F | English 2-part dialogue fill (2 blanks/item) | 3 | 0 | 0 | 3 | Both values per item correct but merged into one "\|"-joined string instead of 2 sub-answers | 可以安全改善 (same merge pattern as the math word-problem case) |
| B | English inline-paragraph multi-blank (8 blanks in running text) | 1 | 0 | 0 | 1 | All 8 individual values correct and in order, but collapsed into a single item instead of 8 | 需要較大架構改動 (hardest segmentation shape seen so far) |
| F | Chinese 填反義詞 (antonym fill) | 4 | 0 | 0 | 4 | Same OCR reliability as 選詞填充; one item has red-pen text folded in | 目前應該 needs_review (OCR layer reliable) |
| D | Math subtraction-algorithm sharing, single blank | 1 | 1 | 0 | 0 | None — this one worked correctly end-to-end | 目前已可靠支援 |
| D | Math subtraction-algorithm sharing, remainder notation ("N R M") | 1 | 0 | 1 | 0 | **Confirmed verifier bug**: "R"-remainder answers get evaluated as decimal division, producing a false-negative wrong verdict | **需要較大架構改動 / 需要code fix (blocked pending your approval — not fixed)** |
| A | English picture-match short-answer w/ tick mark | 4 | 0 | 0 | 4 | Teacher's red-pen tick appears folded into studentAnswer text — 3rd occurrence of this exact pattern | 可以安全改善 (exclude red-pen from OCR capture) |
| E | English word-rearrange → sentence | 3 | 0 | 0 | 3 | Correct text capture but no bbox match for any of the 3 | 可以安全改善 (bbox matching gap) |

**Cross-cutting pattern (not its own row):** the exact same "correct
values, wrong shape" merge happens in 3 unrelated contexts — math
word-problems with printed-given + blank on one line, English 2-part
dialogue fill, and the Chinese/English multi-blank items generally. This
looks like one shared parser/segmentation root cause, not 3 separate
issues, worth keeping in mind if this ever gets scoped as a fix.

## Candidate: Gemini 3.5 Flash Lite (2026-09-22)

Tried as a faster/cheaper alternative to the 235B baseline, same 12
photos, via a preview deployment only (`test/gemini-flash-lite-benchmark`,
never production). Cost: negligible (estimated well under $0.01 total for
all 12 attempts — Gemini Flash Lite's per-token pricing is a fraction of
a cent even summed across 12 real calls; exact OpenRouter billing wasn't
pulled, this is a computed estimate from published per-token rates).

**Latency: a real, clear win.** 9/12 succeeded, averaging **2976ms**
(range 2312–3532ms) vs 235B's 4955ms average (range 2215–6776ms) on the
same photos — roughly **40% faster**. 3/12 failed with a generic 502
(batch1_p1, batch2_p3, backfill3) in 2.4–3.2s each — clearly not a
15s-timeout case, root cause not yet diagnosed (investigation was
started, then paused per explicit instruction not to spend further
tonight). Likely candidates: a Gemini-specific `finish_reason` value
(e.g. "SAFETY") not equal to `"stop"`, or a response shape that
`parseOcrLine` matched zero items in.

**Quality: genuinely mixed, not a clean win or a clean loss.**

- **Clean, correct, matching 235B closely:** batch3_p1 (6/6 items),
  backfill1 (11/11 items) — 2 of 9 successes had no issues at all.
- **Better segmentation than 235B on the exact same content:**
  batch3_p2 — the 5-dialogue exercise came back as 9 *individually*
  split sub-answers (one blank per item) instead of 235B's merged
  `"|"`-joined strings. Real improvement on this specific shape, at the
  cost of duplicate labels (multiple items share the same number, since
  each blank within one numbered exercise kept that exercise's number).
- **Correct content, but a new format defect ("stray pipe"):**
  batch1_p3 (items 1–6), batch2_p2 (both items) — the actual answer
  value is present and correct, but extra text (sometimes a repeat of
  trailing printed content, sometimes stray digits) gets appended after
  an unexpected second `"|"` inside what should be one field. Different
  failure shape from anything 235B produces — not something the current
  parser was designed to tolerate.
- **Real merge failures (unrelated exercises collapsed into one item):**
  batch1_p2 (a concept-map + a separate circle-the-words task merged
  into one item), batch1_p3's item 7 (merged with all 4 sentence-
  matching items from a different exercise), batch3_p3's item 4 (merged
  with the entire 8-blank letter exercise — though notably all 8
  individual values inside it were still correctly extracted, in the
  right order). Same *pattern* 235B has (cross-exercise merging), on
  different specific items — not eliminated, just relocated.
- **Worst single result:** backfill2 (sweets/gummy-bears sharing,
  2 items) — collapsed to 1 item with the answer field literally
  `"2;|2"`, most of the real content lost. This is 235B's best-performing
  photo (the one true-positive `correct:true` verdict in the whole
  benchmark, see the remainder-verifier section above) turning into
  Gemini's worst.
- **Label quality is worse than content quality:** several items came
  back labeled `"Date"` or `"日期"` instead of the real item number
  (batch1_p2 item 1, batch2_p2 item 1) — the model appears to have
  picked up a nearby page furniture field instead of the printed
  question number in these cases.

**Bottom line:** meaningfully faster, and not uniformly worse on
segmentation (one case was better than 235B) — but a real, systematic
25% failure rate (3/12) that isn't understood yet, plus its own distinct
format-compliance issues on top of the merge problems 235B already has.
Not a drop-in replacement without (a) diagnosing the 502s and (b)
deciding whether the stray-pipe defect is parser-fixable or needs a
prompt change. Further real-money testing on this candidate (retrying
the 3 failures, or moving on to GPT-5.6 Luna / GLM-5.3-FlashX) needs
separate explicit approval each time — see
`project_ai_model_watch.md` and the `feedback_real_money_always_ask_first`
/ `feedback_ask_before_every_action` memories.
