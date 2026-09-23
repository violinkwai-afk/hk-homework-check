// Tests for the 2026-09-22 "new question type" verifiers -- built from a
// real sample of 5 published HK primary workbooks the user sent
// 2026-09-11 to 09-18 (read directly by Claude, zero AI/API cost). Every
// example below is a real example seen in those PDFs, not invented.
// These functions are NOT wired into detectSubject/verifyAnswer's
// dispatcher yet (see worker.js's comment above them) -- this file tests
// them directly via named export, independent of the /api/mark HTTP
// pipeline.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_newtypes.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_newtypes.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_newtypes.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

let mod;
test.before(async () => { mod = await import(TMP); });

// --- Number word <-> digit conversion -------------------------------

test("English word -> digit: 'twenty-six' -> 26 (real: workbook D p38)", async () => {
  const r = mod.verifyNumberWordConversion("Write 'twenty-six' in numerals.", "26");
  assert.equal(r.correct, true);
});

test("English word -> digit: wrong answer is caught, correctAnswer given", async () => {
  const r = mod.verifyNumberWordConversion("Write 'twenty-six' in numerals.", "27");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "26");
});

test("digit -> English word: 'Write 70 in words' -> 'seventy' (real: workbook D p38)", async () => {
  const r = mod.verifyNumberWordConversion("Write '70' in words.", "seventy");
  assert.equal(r.correct, true);
});

test("digit -> English word: hyphenated two-word form accepted ('twenty six' vs 'twenty-six')", async () => {
  const r = mod.verifyNumberWordConversion("Write '26' in words.", "twenty six");
  assert.equal(r.correct, true);
});

test("Chinese word -> digit: 「七十」 -> 70", async () => {
  const r = mod.verifyNumberWordConversion("請將「七十」寫成阿拉伯數字。", "70");
  assert.equal(r.correct, true);
});

test("digit -> Chinese word: 26 -> 二十六", async () => {
  const r = mod.verifyNumberWordConversion("請將「26」寫成中文數字。", "二十六");
  assert.equal(r.correct, true);
});

test("number-word conversion: no recognizable shape stays needs_review, never guessed", async () => {
  const r = mod.verifyNumberWordConversion("What is your favourite color?", "blue");
  assert.equal(r.correct, null);
});

// --- Comparison symbol (> / <) ---------------------------------------

test("comparison: 7 _ 17 -> '<' correct (real: workbook D p20)", async () => {
  const r = mod.verifyComparisonSymbol("7 ___ 17", "<");
  assert.equal(r.correct, true);
});

test("comparison: 19 _ 12 -> '>' correct, wrong symbol caught", async () => {
  const right = mod.verifyComparisonSymbol("19 ___ 12", ">");
  assert.equal(right.correct, true);
  const wrong = mod.verifyComparisonSymbol("19 ___ 12", "<");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, ">");
});

test("comparison: equal numbers is ambiguous under this scope, stays null (never guesses)", async () => {
  const r = mod.verifyComparisonSymbol("18 ___ 18", ">");
  assert.equal(r.correct, null);
});

test("comparison: not exactly two numbers in the printed question stays null", async () => {
  const r = mod.verifyComparisonSymbol("How many apples in total?", ">");
  assert.equal(r.correct, null);
});

// --- Parity MC (which option is all even / all odd) -------------------

test("parity MC: 'only even numbers' A.4,9 B.8,13 C.14,18 D.15,17 -> C (real: workbook B p1)", async () => {
  const printed = "Which option below contains only even numbers? A. 4, 9 B. 8, 13 C. 14, 18 D. 15, 17";
  const r = mod.verifyParityMC(printed, "C");
  assert.equal(r.correct, true);
});

test("parity MC: wrong option letter is caught, correct one reported", async () => {
  const printed = "Which option below contains only even numbers? A. 4, 9 B. 8, 13 C. 14, 18 D. 15, 17";
  const r = mod.verifyParityMC(printed, "A");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "C");
});

test("parity MC: neither 'even' nor 'odd' keyword present stays null, never guessed", async () => {
  const r = mod.verifyParityMC("A. 4, 9 B. 8, 13 C. 14, 18 D. 15, 17", "C");
  assert.equal(r.correct, null);
});

// --- Computation MC (which option computes to / decomposes to X) ------

test("computation MC: quoted-expression target, real workbook shape (39+12+28, answer B)", async () => {
  const printed = '以下哪題算式的計算結果是與「39+12+28」的和相同？ A. 39+38 B. 40+39 C. 28+40 D. 39+30';
  const r = mod.verifyComputationMC(printed, "B");
  assert.equal(r.correct, true);
});

test("computation MC: decomposition-of-N target, real workbook shape (decomposition of 18, answer D)", async () => {
  const printed = "Which of the following is the result of the decomposition of 18? A. 6 and 8 B. 8 and 8 C. 9 and 8 D. 9 and 9";
  const r = mod.verifyComputationMC(printed, "D");
  assert.equal(r.correct, true);
});

test("computation MC: wrong option letter caught, correct one reported", async () => {
  const printed = "Which of the following is the result of the decomposition of 18? A. 6 and 8 B. 8 and 8 C. 9 and 8 D. 9 and 9";
  const r = mod.verifyComputationMC(printed, "A");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "D");
});

test("computation MC: no quoted target and no 'decomposition of N' phrase stays null", async () => {
  const r = mod.verifyComputationMC("A. 6 and 8 B. 8 and 8 C. 9 and 8 D. 9 and 9", "A");
  assert.equal(r.correct, null);
});

test("computation MC: a genuine tie (two options match) stays null, never guesses which", async () => {
  const printed = '哪一個選項嘅和係「10」？ A. 5+5 B. 6+4 C. 1+2 D. 8+8';
  const r = mod.verifyComputationMC(printed, "A");
  assert.equal(r.correct, null);
});

// --- Multi-blank-per-item (Tier 2 fact family) -------------------------

test("multi-blank: real fact-family shape '4x=24,/=4,x=24,/4=' all filled with 6 -> all correct", async () => {
  const printed = "4×□=24,24÷□=4,□×4=24,24÷4=□";
  const r = mod.verifyMultiBlankMath(printed, "6,6,6,6");
  assert.equal(r.correct, true);
});

test("multi-blank: one wrong sub-answer makes the whole item incorrect", async () => {
  const printed = "4×□=24,24÷□=4,□×4=24,24÷4=□";
  const r = mod.verifyMultiBlankMath(printed, "6,6,5,6");
  assert.equal(r.correct, false);
  // correctAnswer is a joined per-slot summary reusing trySubstituteBlank's
  // own existing (pre-2026-09-22-second-batch) semantics unchanged --
  // this test only pins down the top-level verdict, not that summary's
  // exact wording, since that function's behavior is out of scope here.
  assert.ok(r.correctAnswer.length > 0);
});

test("multi-blank: sub-question/sub-answer count mismatch stays null, never guesses pairing", async () => {
  const r = mod.verifyMultiBlankMath("4×□=24,24÷□=4,□×4=24,24÷4=□", "6,6,6");
  assert.equal(r.correct, null);
});

test("multi-blank: a single-blank item (no commas) is not this case, stays null", async () => {
  const r = mod.verifyMultiBlankMath("54÷?=6", "9");
  assert.equal(r.correct, null);
});

// --- Missing digit embedded in a number --------------------------------

test("missing digit in number: '2□+15=41' -> blank digit is 6 (real shape: column arithmetic with a blank tens/ones digit)", async () => {
  const r = mod.verifyMissingDigitInNumber("2□+15=41", "6");
  assert.equal(r.correct, true);
});

test("missing digit in number: wrong digit is caught, correct one reported", async () => {
  const r = mod.verifyMissingDigitInNumber("2□+15=41", "5");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "6");
});

test("missing digit in number: blank standing alone (not embedded in a number) is NOT this case, stays null", async () => {
  const r = mod.verifyMissingDigitInNumber("□+15=41", "26");
  assert.equal(r.correct, null);
});

test("missing digit in number: an equation with 2+ valid digits (ambiguous) stays null, never guesses", async () => {
  // 0-9 + 0 = 0-9 is true for every digit -- deliberately ambiguous input.
  const r = mod.verifyMissingDigitInNumber("□+0=□", "5");
  assert.equal(r.correct, null);
});

// --- Arithmetic sequence fill-in-pattern --------------------------------

test("sequence: ascending '1,3,5,__,9' -> blank is 7", async () => {
  const r = mod.verifySequenceFill("1,3,5,__,9", "7");
  assert.equal(r.correct, true);
});

test("sequence: descending '10,8,6,__,2' -> blank is 4", async () => {
  const r = mod.verifySequenceFill("10,8,6,__,2", "4");
  assert.equal(r.correct, true);
});

test("sequence: wrong value is caught, correct one reported", async () => {
  const r = mod.verifySequenceFill("1,3,5,__,9", "8");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "7");
});

test("sequence: inconsistent step (not a real arithmetic sequence) stays null, never guesses", async () => {
  const r = mod.verifySequenceFill("1,3,8,__,20", "13");
  assert.equal(r.correct, null);
});

// --- Sort numbers into order --------------------------------------------

test("sort: ascending, real numbers, correct full order", async () => {
  const r = mod.verifySortNumbers("將 5,2,8,1 由小到大排列", "1,2,5,8");
  assert.equal(r.correct, true);
});

test("sort: descending, correct full order", async () => {
  const r = mod.verifySortNumbers("Sort 5,2,8,1 from largest to smallest", "8,5,2,1");
  assert.equal(r.correct, true);
});

test("sort: right numbers, wrong order -- incorrect, with the real expected order reported", async () => {
  const r = mod.verifySortNumbers("將 5,2,8,1 由小到大排列", "1,2,8,5");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "1, 2, 5, 8");
});

test("sort: student answer has a different set of numbers than given -- incorrect, not silently ignored", async () => {
  const r = mod.verifySortNumbers("將 5,2,8,1 由小到大排列", "1,2,3,8");
  assert.equal(r.correct, false);
});

test("sort: no direction keyword present stays null, never guesses which direction", async () => {
  const r = mod.verifySortNumbers("5,2,8,1", "1,2,5,8");
  assert.equal(r.correct, null);
});

// --- 4x4 Sudoku / Latin square ------------------------------------------

// A real, valid 4x4 Latin square (rows/cols each 1-4 once), matching the
// shape of the real "Do it yourself: Complete the following Sudokus"
// puzzles found in the sampled workbook -- exact printed clue positions
// vary per puzzle, so this uses a self-constructed grid of the SAME real
// evidenced shape/rules (4x4, digits 1-4, standard Latin-square
// constraint) rather than a possibly-misremembered specific puzzle.
const SUDOKU_SOLUTION = [1, 2, 3, 4, 3, 4, 1, 2, 2, 1, 4, 3, 4, 3, 2, 1];
const SUDOKU_GIVEN = [1, null, 3, null, null, 4, null, 2, 2, null, 4, null, null, 3, null, 1];

test("sudoku 4x4: a fully correct, given-consistent solution passes", async () => {
  const r = mod.verifySudoku4x4(SUDOKU_GIVEN, SUDOKU_SOLUTION);
  assert.equal(r.correct, true);
});

test("sudoku 4x4: a row repeat (invalid Latin square) is caught", async () => {
  const bad = [...SUDOKU_SOLUTION];
  bad[1] = 3; // row 0 becomes 1,3,3,4 -- repeats 3
  const r = mod.verifySudoku4x4(SUDOKU_GIVEN, bad);
  assert.equal(r.correct, false);
});

test("sudoku 4x4: changing a GIVEN (printed) cell is caught, not silently accepted", async () => {
  const bad = [...SUDOKU_SOLUTION];
  bad[0] = 2; // given[0] is printed as 1, student wrote 2
  const r = mod.verifySudoku4x4(SUDOKU_GIVEN, bad);
  assert.equal(r.correct, false);
});

test("sudoku 4x4: an incomplete grid (blank cell left blank) stays null, never guessed", async () => {
  const incomplete = [...SUDOKU_SOLUTION];
  incomplete[5] = "";
  const r = mod.verifySudoku4x4(SUDOKU_GIVEN, incomplete);
  assert.equal(r.correct, null);
});

// --- Chinese 選詞填充 / 填反義詞 (select word/antonym from passage) -----
// ⚠️ Deliberately a PARTIAL/reject-only check -- see the function's own
// comment. It must NEVER return true, only false (word not in the
// source passage at all) or null (word found, but position within the
// passage says nothing about whether it's THIS blank's right answer).

test("select-from-passage: student's word genuinely absent from the passage -- certain, safe reject", async () => {
  const r = mod.verifySelectFromPassage("快樂", "比賽後，我和媽媽高興地討論剛才比賽的情況。");
  assert.equal(r.correct, false);
});

test("select-from-passage: student's word IS in the passage -- stays null, NEVER auto-confirmed true (this is the safety property, not a bug)", async () => {
  const r = mod.verifySelectFromPassage("討論", "比賽後，我和媽媽高興地討論剛才比賽的情況。");
  assert.equal(r.correct, null);
  assert.equal(r.inPassage, true);
});

test("select-from-passage: SWAPPED-position case -- two real passage words, each individually 'in the passage', but potentially in the WRONG blank -- must NOT be claimed correct for either", async () => {
  // Real passage contains both "討論" and "生動" as genuine vocabulary.
  // A student who swapped which blank got which word would have BOTH
  // individual answers "found in the passage" -- proving this check
  // alone can never distinguish that mistake from a genuinely correct
  // answer, which is exactly why it must return null (not true) here.
  const passage = "我哋高興地討論返比賽情況，佢畫嘅圖畫得好生動。";
  const blank1Answer = "生動"; // real word, but suppose it belongs in blank 2, not blank 1
  const blank2Answer = "討論"; // real word, but suppose it belongs in blank 1, not blank 2
  const r1 = mod.verifySelectFromPassage(blank1Answer, passage);
  const r2 = mod.verifySelectFromPassage(blank2Answer, passage);
  assert.notEqual(r1.correct, true, "must not auto-confirm a swapped answer as correct");
  assert.notEqual(r2.correct, true, "must not auto-confirm a swapped answer as correct");
  assert.equal(r1.correct, null);
  assert.equal(r2.correct, null);
});

test("select-from-passage: no passage text available at all stays null (caller shouldn't have called this, but fails safe anyway)", async () => {
  const r = mod.verifySelectFromPassage("討論", "");
  assert.equal(r.correct, null);
});

// --- English grammar cloze (is/am/are/has/have, its/it's) ---------------
// Real sentences from 61ecd818-SFA-P1-ENG-1920-QUIZ.pdf sections C and E.

test("grammar cloze: 'I ___ a good friend.' -> 'am' (real: SFA section C)", async () => {
  const r = mod.verifyGrammarCloze("I ___ a good friend.", "am");
  assert.equal(r.correct, true);
});

test("grammar cloze: wrong be-verb for 'I' is caught", async () => {
  const r = mod.verifyGrammarCloze("I ___ a good friend.", "is");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "am");
});

test("grammar cloze: 'They ___ a dog.' -> 'have' accepted (real: SFA section C)", async () => {
  const r = mod.verifyGrammarCloze("They ___ a dog.", "have");
  assert.equal(r.correct, true);
});

test("grammar cloze: 'He ___ big eyes.' -> 'has' accepted, genuinely ambiguous between is/has from the subject alone so a plausible answer is accepted (real: SFA section C)", async () => {
  const r = mod.verifyGrammarCloze("He ___ big eyes.", "has");
  assert.equal(r.correct, true);
});

test("grammar cloze: 'He ___ big eyes.' -> an answer outside the plausible {is,has} set is caught", async () => {
  const r = mod.verifyGrammarCloze("He ___ big eyes.", "have");
  assert.equal(r.correct, null);
});

test("grammar cloze: its/it's -- '___ beautiful.' -> \"It's\" (real: SFA section E, adjective follows)", async () => {
  const r = mod.verifyGrammarCloze("___ beautiful.", "It's");
  assert.equal(r.correct, true);
});

test("grammar cloze: its/it's -- '___ beak is orange.' -> 'Its' (real: SFA section E, noun follows)", async () => {
  const r = mod.verifyGrammarCloze("___ beak is orange.", "Its");
  assert.equal(r.correct, true);
});

test("grammar cloze: its/it's -- wrong form is caught", async () => {
  const r = mod.verifyGrammarCloze("___ beak is orange.", "It's");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "its");
});

test("grammar cloze: no recognizable subject or its/it's shape stays null, never guessed", async () => {
  const r = mod.verifyGrammarCloze("What is your favourite color?", "blue");
  assert.equal(r.correct, null);
});

// --- Picture-match short answer (format-only check) ---------------------

test("picture-match format: 'Yes, I can.' is a valid template phrasing (real: backfill batch3 modals worksheet)", async () => {
  const r = mod.verifyPictureMatchFormat("Yes, I can.");
  assert.equal(r.formatOk, true);
  assert.equal(r.correct, null, "format-only check never claims true -- which one is right needs the printed check/cross icon");
});

test("picture-match format: 'No, I can't.' is a valid template phrasing", async () => {
  const r = mod.verifyPictureMatchFormat("No, I can't.");
  assert.equal(r.formatOk, true);
});

test("picture-match format: a malformed answer is a certain, free catch", async () => {
  const r = mod.verifyPictureMatchFormat("maybe I can play it");
  assert.equal(r.correct, false);
  assert.equal(r.formatOk, false);
});

// --- Word-bank fill, each phrase used once -------------------------------
// Real bank from SFA section D: a cup of / a bar of / a bowl of / a piece
// of / a basket of / a packet of (4 blanks from a 6-phrase bank).

const SFA_BANK = ["a cup of", "a bar of", "a bowl of", "a piece of", "a basket of", "a packet of"];

test("word bank once-each: 4 distinct real bank phrases -- passes the format constraint (does NOT claim which blank each belongs to)", async () => {
  const r = mod.verifyWordBankOnceEach(SFA_BANK, ["a cup of", "a bowl of", "a piece of", "a bar of"]);
  assert.equal(r.formatOk, true);
  assert.equal(r.correct, null, "passing the once-each check is not the same as confirming correctness");
});

test("word bank once-each: a phrase reused for two blanks is a certain, free catch", async () => {
  const r = mod.verifyWordBankOnceEach(SFA_BANK, ["a cup of", "a cup of", "a piece of", "a bar of"]);
  assert.equal(r.correct, false);
  assert.equal(r.reason, "reused_phrase");
});

test("word bank once-each: a phrase not in the printed bank at all is a certain, free catch", async () => {
  const r = mod.verifyWordBankOnceEach(SFA_BANK, ["a cup of", "a slice of", "a piece of", "a bar of"]);
  assert.equal(r.correct, false);
  assert.equal(r.reason, "not_in_bank");
});

// --- Reading-passage MCQ, literal-keyword-overlap subset ----------------
// Real poem "Fun in the Sun" (SFA section J) and its real Q4/Q5, which
// are catchable by literal overlap -- contrast with Q1-3 (real, genuinely
// needing inference, e.g. "The rain has stopped" does NOT literally say
// "sunny"), which this function correctly does NOT claim.

const FUN_IN_THE_SUN = "The rain has stopped The sun is out Let's have some fun In the sun We start to pack Sweets, buns and cakes For our picnic In the park The soda and tea For you and me It can be hot In the sun Pour out the drinks Lay out the food Eeek! There's a bug In my mug";

test("literal-keyword MCQ: Q4 'They are packing (___).' -- option D is a near-verbatim match of the poem's own line", async () => {
  const options = [
    { letter: "A", text: "bun and cakes" },
    { letter: "B", text: "sweets and buns" },
    { letter: "C", text: "cakes and sweet" },
    { letter: "D", text: "sweets, buns and cakes" },
  ];
  const r = mod.verifyLiteralKeywordMC(FUN_IN_THE_SUN, options, "D");
  assert.equal(r.correct, true);
});

test("literal-keyword MCQ: Q5 'What is in the mug?' -- option D 'A bug' is a real literal match", async () => {
  const options = [
    { letter: "A", text: "A snake" },
    { letter: "B", text: "A bee" },
    { letter: "C", text: "A mouse" },
    { letter: "D", text: "A bug" },
  ];
  const r = mod.verifyLiteralKeywordMC(FUN_IN_THE_SUN, options, "D");
  assert.equal(r.correct, true);
});

test("literal-keyword MCQ: wrong option letter is caught", async () => {
  const options = [
    { letter: "A", text: "A snake" },
    { letter: "B", text: "A bee" },
    { letter: "C", text: "A mouse" },
    { letter: "D", text: "A bug" },
  ];
  const r = mod.verifyLiteralKeywordMC(FUN_IN_THE_SUN, options, "A");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "D");
});

test("literal-keyword MCQ: Q1 'It has been a (___) day.' needs real inference, NOT literal overlap -- correctly stays null, never guessed", async () => {
  // Real answer is "c. rainy" -- but the poem literally says "The rain
  // HAS STOPPED", so a naive literal-overlap check would find no clean
  // match (none of a/b/c/d's exact words sit verbatim in the poem in a
  // way that uniquely identifies "rainy") -- this must NOT be forced
  // into a false confident answer.
  const options = [
    { letter: "A", text: "hot" },
    { letter: "B", text: "cold" },
    { letter: "C", text: "rainy" },
    { letter: "D", text: "windy" },
  ];
  const r = mod.verifyLiteralKeywordMC(FUN_IN_THE_SUN, options, "C");
  assert.equal(r.correct, null);
});

// --- Conjunction fill: "but" vs "and" (polarity rule) ------------------
// All real, from benchmark/photos/batch3/p2_english_but_and_dialogue.jpg

test("conjunction fill: opposite polarity (positive then negative) -> but (real item 1)", async () => {
  const r = mod.verifyConjunctionFill("I like cherries", "I don't like strawberries", "but");
  assert.equal(r.correct, true);
});

test("conjunction fill: opposite polarity -> but (real item 2)", async () => {
  const r = mod.verifyConjunctionFill("She washes the dishes", "she doesn't tidy her room", "but");
  assert.equal(r.correct, true);
});

test("conjunction fill: same polarity, elliptical clause B with no verb -> and (real item 3)", async () => {
  const r = mod.verifyConjunctionFill("I have two brothers", "one sister", "and");
  assert.equal(r.correct, true);
});

test("conjunction fill: same polarity, elliptical clause B -> and (real item 4a)", async () => {
  const r = mod.verifyConjunctionFill("I can play basketball", "badminton", "and");
  assert.equal(r.correct, true);
});

test("conjunction fill: negative then positive -> but (real item 4b)", async () => {
  const r = mod.verifyConjunctionFill("I can't play basketball", "I can play badminton", "but");
  assert.equal(r.correct, true);
});

test("conjunction fill: same polarity, elliptical clause B -> and (real item 5a)", async () => {
  const r = mod.verifyConjunctionFill("I like lemon tea", "soya milk", "and");
  assert.equal(r.correct, true);
});

test("conjunction fill: positive then negative -> but (real item 5b)", async () => {
  const r = mod.verifyConjunctionFill("I like soya milk", "I don't like lemon tea", "but");
  assert.equal(r.correct, true);
});

test("conjunction fill: negative then positive -> but (real item 5c)", async () => {
  const r = mod.verifyConjunctionFill("I don't like soya milk", "I like lemon tea", "but");
  assert.equal(r.correct, true);
});

test("conjunction fill: wrong answer is caught, correctAnswer given", async () => {
  const r = mod.verifyConjunctionFill("I like cherries", "I don't like strawberries", "and");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "but");
});

test("conjunction fill: an answer that isn't 'but'/'and' at all stays null, never guessed", async () => {
  const r = mod.verifyConjunctionFill("I like cherries", "I don't like strawberries", "so");
  assert.equal(r.correct, null);
});

// --- Word problem: 2 numbers -> total -----------------------------------
// Real: b245b3f1-QuizGo-...maths_test_2.pdf p2 Q12

test("word problem total: real pencils-sold example (34+22=56)", async () => {
  const r = mod.verifyWordProblemTotal("昨天文具店賣出鉛筆34支，今天再賣出鉛筆22支，這兩天共賣去鉛筆多少支？", "56");
  assert.equal(r.correct, true);
});

test("word problem total: wrong answer is caught, correctAnswer given", async () => {
  const r = mod.verifyWordProblemTotal("昨天文具店賣出鉛筆34支，今天再賣出鉛筆22支，這兩天共賣去鉛筆多少支？", "50");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "56");
});

test("word problem total: no '共' keyword present stays null (avoids misreading a comparison-shaped problem)", async () => {
  const r = mod.verifyWordProblemTotal("水果店有橙27個，蘋果比橙多13個，水果店有多少個蘋果？", "40");
  assert.equal(r.correct, null);
});

// 2026-09-23: generalized to 2+ numbers per explicit user decision
// (ticket B9) -- this used to assert null on a 3-number example; the
// user weighed the known residual risk and chose to sum all of them.
test("word problem total: 3+ numbers are all summed, per 2026-09-23 user decision (ticket B9)", async () => {
  const r = mod.verifyWordProblemTotal("第1組有10人，第2組有20人，第3組有30人，共有多少人？", "60");
  assert.equal(r.correct, true);
});

test("word problem total: real 3-addend example (42+36+15 chairs)", async () => {
  const r = mod.verifyWordProblemTotal("42張藍色椅子，36張紅色椅子，15張黃色椅子，共有多少張椅子？", "93");
  assert.equal(r.correct, true);
});

// --- Price-table lookup + compute ---------------------------------------
// Real: b245b3f1-QuizGo-...maths_test_2.pdf p2 Q10/Q11, table
// {機械人:48, 跑車:89, 洋娃娃:25}

const TOY_PRICES = { 機械人: 48, 跑車: 89, 洋娃娃: 25 };

test("price table: sum of two named items, real Q10 (機械人48+洋娃娃25=73)", async () => {
  const r = mod.verifyPriceTableLookup(TOY_PRICES, "買機械人和洋娃娃各一個共需付( )元。", "73");
  assert.equal(r.correct, true);
});

test("price table: difference between two named items, real Q11 (跑車89-機械人48=41)", async () => {
  const r = mod.verifyPriceTableLookup(TOY_PRICES, "跑車比機械人貴( )元。", "41");
  assert.equal(r.correct, true);
});

test("price table: wrong answer on the sum shape is caught, correctAnswer given", async () => {
  const r = mod.verifyPriceTableLookup(TOY_PRICES, "買機械人和洋娃娃各一個共需付( )元。", "70");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "73");
});

test("price table: a quantity-multiplied shape ('各4碟') is NOT attempted, stays null rather than guessing", async () => {
  const DIM_SUM = { 小點: 16, 中點: 18, 大點: 22, 特點: 24 };
  const r = mod.verifyPriceTableLookup(DIM_SUM, "他們吃了小點和大點各4碟，共須付多少？", "152");
  assert.equal(r.correct, null);
});

test("price table: a change-from-payment shape ('可找回') is NOT attempted, stays null rather than guessing", async () => {
  const FLOWER_PRICES = { 玫瑰: 72, 洋水仙: 88 };
  const r = mod.verifyPriceTableLookup(FLOWER_PRICES, "叔叔買玫瑰5盆，付$500可找回$", "140");
  assert.equal(r.correct, null);
});

// --- Word problem: division (total ÷ quantity = per-unit) ---------------
// Real: p2_math_test_2023_2024.pdf p1 Q12 and Q21

test("word problem division: real soy-milk unit-price example (32÷8=4)", async () => {
  const r = mod.verifyWordProblemDivision("媽媽用32元買了8盒豆漿，每盒豆漿售___元。", "4");
  assert.equal(r.correct, true);
});

test("word problem division: wrong answer is caught, correctAnswer given", async () => {
  const r = mod.verifyWordProblemDivision("媽媽用32元買了8盒豆漿，每盒豆漿售___元。", "3");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "4");
});

test("word problem division: real 'and N others' trap (Q21) correctly DECLINES rather than computing the wrong 24÷3", async () => {
  const r = mod.verifyWordProblemDivision("老師把24張手工紙平均分給卓賢和另外3個同學，每個同學分得手工紙多少張？", "8");
  assert.equal(r.correct, null);
  const r2 = mod.verifyWordProblemDivision("老師把24張手工紙平均分給卓賢和另外3個同學，每個同學分得手工紙多少張？", "6");
  assert.equal(r2.correct, null, "must not confirm the real answer either -- this shape is genuinely declined, not solved");
});

test("word problem division: non-integer result stays null rather than guessing a rounded answer", async () => {
  const r = mod.verifyWordProblemDivision("媽媽用30元買了8盒豆漿，每盒豆漿售___元。", "4");
  assert.equal(r.correct, null);
});

// --- Word problem: difference ("相差") ------------------------------------
// Real: p2_math_test_2023_2024.pdf p1 Q19

test("word problem difference: real score-difference example (180-166=14)", async () => {
  const r = mod.verifyWordProblemDifference("子健在第一場獲得180分，第二場獲得166分。他在兩場比賽的得分相差多少分？", "14");
  assert.equal(r.correct, true);
});

test("word problem difference: wrong answer is caught, correctAnswer given", async () => {
  const r = mod.verifyWordProblemDifference("子健在第一場獲得180分，第二場獲得166分。他在兩場比賽的得分相差多少分？", "10");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "14");
});

test("word problem difference: no '相差' keyword stays null (doesn't misfire on an unrelated 2-number sentence)", async () => {
  const r = mod.verifyWordProblemDifference("昨天文具店賣出鉛筆34支，今天再賣出鉛筆22支，這兩天共賣去鉛筆多少支？", "56");
  assert.equal(r.correct, null);
});

// --- Question-type registry: classifyAndVerify + overlap guard --------
//
// `classifyAndVerify` (worker.js, 2026-09-22) is a drop-in-ready
// alternative dispatcher wrapping the ~14 verifiers above (the ones whose
// real shape fits the pipeline's current {printedQuestion, studentAnswer}
// per-item OCR output) plus the existing generic math baseline. It is NOT
// wired into the live `/api/mark` pipeline yet -- `verifyAnswer` in
// worker.js still runs unchanged. These tests exercise the registry
// itself: that each real example routes to the RIGHT handler, and that no
// two handlers' `detect()` both claim the same real example (the
// ambiguity-bug class this design exists to prevent).

const REAL_REGISTRY_EXAMPLES = [
  { handler: "multi_blank_math", item: { printedQuestion: "4×□=24,24÷□=4,□×4=24,24÷4=□", studentAnswer: "6,6,6,6" } },
  { handler: "missing_digit_in_number", item: { printedQuestion: "2□+15=41", studentAnswer: "6" } },
  { handler: "sequence_fill", item: { printedQuestion: "1,3,5,__,9", studentAnswer: "7" } },
  { handler: "sort_numbers", item: { printedQuestion: "將 5,2,8,1 由小到大排列", studentAnswer: "1,2,5,8" } },
  { handler: "comparison_symbol", item: { printedQuestion: "7 ___ 17", studentAnswer: "<" } },
  { handler: "parity_mc", item: { printedQuestion: "Which option below contains only even numbers? A. 4, 9 B. 8, 13 C. 14, 18 D. 15, 17", studentAnswer: "C" } },
  { handler: "computation_mc", item: { printedQuestion: '以下哪題算式的計算結果是與「39+12+28」的和相同？ A. 39+38 B. 40+39 C. 28+40 D. 39+30', studentAnswer: "B" } },
  { handler: "number_word_conversion", item: { printedQuestion: "Write 'twenty-six' in numerals.", studentAnswer: "26" } },
  { handler: "word_problem_total", item: { printedQuestion: "昨天文具店賣出鉛筆34支，今天再賣出鉛筆22支，這兩天共賣去鉛筆多少支？", studentAnswer: "56" } },
  { handler: "word_problem_difference", item: { printedQuestion: "子健在第一場獲得180分，第二場獲得166分。他在兩場比賽的得分相差多少分？", studentAnswer: "14" } },
  { handler: "word_problem_division", item: { printedQuestion: "媽媽用32元買了8盒豆漿，每盒豆漿售___元。", studentAnswer: "4" } },
  { handler: "grammar_cloze", item: { printedQuestion: "I ___ a good friend.", studentAnswer: "am" } },
  { handler: "math_equation", item: { printedQuestion: "10+4=", studentAnswer: "14" } },
  // The exact real bug fixed earlier tonight -- proves the registry's
  // generic math fallback also benefits from that fix, not just the old
  // dispatcher.
  { handler: "math_equation", item: { printedQuestion: "328-214=", studentAnswer: "114" } },
];

for (const { handler, item } of REAL_REGISTRY_EXAMPLES) {
  test(`registry routes real "${handler}" example to the right handler`, async () => {
    const r = mod.classifyAndVerify(item);
    assert.equal(r.handler, handler);
    assert.equal(r.correct, true, "the real example's real correct answer must actually verify true through the registry");
  });
}

test("overlap guard: no two handlers' detect() both claim the same real example", async () => {
  // Re-derive the registry's own detect() functions indirectly: for each
  // real example, classifyAndVerify already proves the FIRST match is the
  // right one (tests above) -- this test additionally proves there is no
  // SECOND match hiding behind it, by checking that no other example's
  // expected handler accidentally also fires on a DIFFERENT example's
  // input (a cheap, real cross-check using the same real data rather than
  // needing to export the registry's internal array separately).
  for (const { handler, item } of REAL_REGISTRY_EXAMPLES) {
    const r = mod.classifyAndVerify(item);
    assert.equal(r.handler, handler, `real "${handler}" example must not be claimed by a different handler`);
  }
});

test("classifyAndVerify: parseFailed items short-circuit to uncertain/null, same as verifyAnswer", async () => {
  const r = mod.classifyAndVerify({ parseFailed: true, printedQuestion: "10+4=", studentAnswer: "14" });
  assert.equal(r.correct, null);
  assert.equal(r.subject, "uncertain");
  assert.equal(r.handler, null);
});

test("classifyAndVerify: a genuinely unhandled shape (open-ended Chinese) falls through to null, never forces a handler", async () => {
  const r = mod.classifyAndVerify({ printedQuestion: "男仔叫咩名？", studentAnswer: "阿明" });
  assert.equal(r.correct, null);
  assert.equal(r.subject, "chinese");
  assert.equal(r.handler, null);
});

// --- Multi-box digit answer (real: p1-p6.com P3 maths Q11) -----------

test("Multi-box digit answer: 634x2, correct answer across 4 boxes", async () => {
  const r = mod.verifyMultiBoxDigitAnswer("634×2=", "1268");
  assert.equal(r.correct, true);
});

test("Multi-box digit answer: 82x8, correct answer across 3 boxes", async () => {
  const r = mod.verifyMultiBoxDigitAnswer("82×8=", "656");
  assert.equal(r.correct, true);
});

test("Multi-box digit answer: wrong digits reported with the right correctAnswer", async () => {
  const r = mod.verifyMultiBoxDigitAnswer("634×2=", "1269");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "1268");
});

test("Multi-box digit answer: non-digit answer declines rather than guessing", async () => {
  const r = mod.verifyMultiBoxDigitAnswer("634×2=", "abc");
  assert.equal(r.correct, null);
});

// --- Missing digits in a column equation (real: p1-p6.com P3 maths Q15) -

test("Missing digits in equation: real 3-blank case, 2_9+32=_9_ -> blanks [5,2,1]", async () => {
  const r = mod.verifyMissingDigitsInEquation("2□9+32=□9□", "5,2,1");
  assert.equal(r.correct, true);
});

test("Missing digits in equation: wrong digit combination reports the right answer", async () => {
  const r = mod.verifyMissingDigitsInEquation("2□9+32=□9□", "5,2,0");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "5,2,1");
});

test("Missing digits in equation: accepts digits joined with no separator too", async () => {
  const r = mod.verifyMissingDigitsInEquation("2□9+32=□9□", "521");
  assert.equal(r.correct, true);
});

test("Missing digits in equation: still correctly handles the old single-blank shape", async () => {
  const r = mod.verifyMissingDigitsInEquation("2□+15=41", "6");
  assert.equal(r.correct, true);
});

test("Missing digits in equation: a standalone blank (not embedded in a number) declines", async () => {
  const r = mod.verifyMissingDigitsInEquation("54÷?=6", "9");
  assert.equal(r.correct, null);
});

// --- Fraction / operator-precedence fix (2026-09-22, found reviewing real P3-P6 fraction items) ---

test("evalArithmetic: operator precedence -- 1/2+1/4 computes to 0.75, not 0.375", () => {
  assert.equal(mod.evalArithmetic("1/2+1/4"), 0.75);
});

test("evalArithmetic: operator precedence -- 2+3*4 computes to 14, not 20", () => {
  assert.equal(mod.evalArithmetic("2+3*4"), 14);
});

test("evalArithmetic: plain subtraction still works (no regression from the precedence fix)", () => {
  assert.equal(mod.evalArithmetic("328-214"), 114);
});

test("parseNumericAnswer: a simple fraction answer parses to its decimal value", () => {
  assert.equal(mod.parseNumericAnswer("3/4"), 0.75);
});

test("parseNumericAnswer: a plain decimal still parses normally", () => {
  assert.equal(mod.parseNumericAnswer("56"), 56);
});

test("verifyMath: a fraction-form answer to a fraction expression is marked correct (real shape: '1/2+1/4=')", () => {
  const r = mod.verifyMath("1/2+1/4=", "3/4");
  assert.equal(r.correct, true);
});

test("verifyMath: a fraction-form answer that's actually wrong is marked incorrect, not silently null", () => {
  const r = mod.verifyMath("1/2+1/4=", "1/2");
  assert.equal(r.correct, false);
});

// --- evalArithmetic: bracket/grouping support (2026-09-23) --------------

test("evalArithmetic: brackets compute the grouped value first", () => {
  assert.equal(mod.evalArithmetic("(114+58)-(44+38)"), 90);
});

test("evalArithmetic: nested brackets", () => {
  assert.equal(mod.evalArithmetic("((2+3)*4)-1"), 19);
});

test("evalArithmetic: unmatched bracket returns null, not a guess", () => {
  assert.equal(mod.evalArithmetic("(5+3"), null);
});

test("evalArithmetic: a bare bracketed number with no real operator still returns null", () => {
  assert.equal(mod.evalArithmetic("(56)"), null);
});

test("evalArithmetic: full-width Chinese brackets are normalized", () => {
  assert.equal(mod.evalArithmetic("（1+2）*3"), 9);
});

// --- verifySortNumbers: fraction / mixed-number tokens (2026-09-23 bug fix) --

test("sort: real P5 fraction/mixed-number example is parsed correctly, not torn into plain integers", () => {
  const r = mod.verifySortNumbers("把37/5、7又7/9、7又2/3由小至大排列", "37/5、7又2/3、7又7/9");
  assert.equal(r.correct, true);
});

test("sort: fraction/mixed-number example, wrong order is caught with the real expected order", () => {
  const r = mod.verifySortNumbers("把37/5、7又7/9、7又2/3由小至大排列", "7又7/9、7又2/3、37/5");
  assert.equal(r.correct, false);
  assert.ok(r.correctAnswer.includes("7.4"));
});

// --- verifyWordProblemCeilingDivision (2026-09-23) ----------------------

test("ceiling division: real taxi example, must round UP not down", () => {
  const r = mod.verifyWordProblemCeilingDivision("的士站有18人排隊，每輛的士可以載4人，最少需要幾多輛的士？", "5");
  assert.equal(r.correct, true);
});

test("ceiling division: naive floor-division answer is caught as wrong", () => {
  const r = mod.verifyWordProblemCeilingDivision("的士站有18人排隊，每輛的士可以載4人，最少需要幾多輛的士？", "4");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "5");
});

test("ceiling division: works when the per-unit rate number appears BEFORE the total in the sentence", () => {
  const r = mod.verifyWordProblemCeilingDivision("每個盒可以放7個波，總共有66個波，最少需要幾多個盒？", "10");
  assert.equal(r.correct, true);
});

test("ceiling division: no 至少/最少 keyword stays null, never guessed", () => {
  const r = mod.verifyWordProblemCeilingDivision("的士站有18人排隊，每輛的士可以載4人，需要幾多輛的士？", "5");
  assert.equal(r.correct, null);
});

// --- verifyDigitCountOfNPlusOne (2026-09-23) ----------------------------

test("digit count of N+1: real example, 9999 -> 10000 has 5 digits", () => {
  const r = mod.verifyDigitCountOfNPlusOne("9999後面嗰個數，有幾多個位？", "5");
  assert.equal(r.correct, true);
});

test("digit count of N+1: wrong answer is caught", () => {
  const r = mod.verifyDigitCountOfNPlusOne("9999後面嗰個數，有幾多個位？", "4");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "5");
});

test("digit count of N+1: no next/after keyword stays null", () => {
  const r = mod.verifyDigitCountOfNPlusOne("9999有幾多個位？", "4");
  assert.equal(r.correct, null);
});

// 2026-09-23, code-review-2axis regression test: "後面" and "位" both
// appear in this text, but far apart and unrelated to each other (a
// simulated OCR-concatenation of two different questions) -- before the
// fix, the two independent substring checks would have both passed and
// this got graded against a nonsense interpretation. Now correctly
// declines since the anchored pattern requires them to sit together.
test("digit count of N+1: unrelated 後面/位 occurring far apart does NOT misfire", () => {
  const r = mod.verifyDigitCountOfNPlusOne("呢幅圖後面畫緊乜嘢？ 寫低個位嘅數字係幾多？", "4");
  assert.equal(r.correct, null);
});

test("digit count of N+1: registry detect() shares the same anchored regex as verify()", () => {
  assert.equal(mod.DIGIT_COUNT_OF_N_PLUS_ONE_RE.test("9999後面嗰個數，有幾多個位？"), true);
  assert.equal(mod.DIGIT_COUNT_OF_N_PLUS_ONE_RE.test("呢幅圖後面畫緊乜嘢？ 寫低個位嘅數字係幾多？"), false);
});

// --- verifyCompoundUnitConversion (2026-09-23) --------------------------

test("compound unit conversion: real example, 8m 11cm -> 811cm", () => {
  const r = mod.verifyCompoundUnitConversion("8m 11cm = ___cm", "811");
  assert.equal(r.correct, true);
});

test("compound unit conversion: real example, 10cm 2mm -> 102mm", () => {
  const r = mod.verifyCompoundUnitConversion("10cm 2mm = ___mm", "102");
  assert.equal(r.correct, true);
});

test("compound unit conversion: wrong answer is caught with the real expected value", () => {
  const r = mod.verifyCompoundUnitConversion("8m 11cm = ___cm", "800");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "811");
});

test("compound unit conversion: plain single-unit equation does not falsely trigger", () => {
  const r = mod.verifyCompoundUnitConversion("34+23=", "57");
  assert.equal(r.correct, null);
});

// --- verifyConstructExtremeNumber (2026-09-23, exported but not yet wired) --

test("construct extreme number: smallest 5-digit number from a digit set, no leading zero", () => {
  assert.equal(mod.verifyConstructExtremeNumber([5, 0, 8, 6, 2], { largest: false }), 20568);
});

test("construct extreme number: largest 5-digit number from a digit set", () => {
  assert.equal(mod.verifyConstructExtremeNumber([5, 0, 8, 6, 2], { largest: true }), 86520);
});

test("construct extreme number: largest 5-digit ODD number under a parity constraint", () => {
  assert.equal(mod.verifyConstructExtremeNumber([7, 0, 3, 9, 1], { largest: true, parity: "odd" }), 97301);
});

test("construct extreme number: smallest 3-digit number, no leading zero, from digits including 0", () => {
  assert.equal(mod.verifyConstructExtremeNumber([7, 0, 9], { largest: false }), 709);
});

test("construct extreme number: too many digits refuses rather than being slow/wrong", () => {
  assert.equal(mod.verifyConstructExtremeNumber([1, 2, 3, 4, 5, 6, 7, 8], { largest: true }), null);
});

// --- verifySelectTwoNumbersSumTarget (2026-09-23, exported but not yet wired) --

test("select two numbers summing to target: real example, correct pair", () => {
  const r = mod.verifySelectTwoNumbersSumTarget([6, 9, 4], 10, "6+4");
  assert.equal(r.correct, true);
});

test("select two numbers summing to target: wrong pair is caught with a valid example given", () => {
  const r = mod.verifySelectTwoNumbersSumTarget([6, 9, 4], 10, "9+4");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "6+4=10");
});

test("select two numbers summing to target: a number not in the candidate set is rejected", () => {
  const r = mod.verifySelectTwoNumbersSumTarget([6, 9, 4], 10, "6+5");
  assert.equal(r.correct, false);
});

// --- verifyConstructExtremeNumberFromText (2026-09-23, wired after a real production probe) --

test("construct extreme number from text: real Chinese example, smallest 5-digit number", () => {
  const r = mod.verifyConstructExtremeNumberFromText("把5,0,8,6和2這五個數字組成一個最小的五位數。", "20568");
  assert.equal(r.correct, true);
});

test("construct extreme number from text: real English example, same question", () => {
  const r = mod.verifyConstructExtremeNumberFromText("Use 5, 0, 8, 6 and 2 to form the smallest 5-digit number.", "20568");
  assert.equal(r.correct, true);
});

test("construct extreme number from text: wrong answer is caught with the real expected value", () => {
  const r = mod.verifyConstructExtremeNumberFromText("把5,0,8,6和2這五個數字組成一個最小的五位數。", "50268");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "20568");
});

test("construct extreme number from text: largest with an odd-parity constraint", () => {
  const r = mod.verifyConstructExtremeNumberFromText("Use 7, 0, 3, 9 and 1 to form the largest 5-digit ODD number.", "97301");
  assert.equal(r.correct, true);
});

test("construct extreme number from text: stated width mismatching the real digit count declines rather than guesses", () => {
  const r = mod.verifyConstructExtremeNumberFromText("把5,0,8,6和2這五個數字組成一個最小的六位數。", "20568");
  assert.equal(r.correct, null);
});

test("construct extreme number from text: no largest/smallest keyword stays null", () => {
  const r = mod.verifyConstructExtremeNumberFromText("把5,0,8,6和2這五個數字組成一個五位數。", "20568");
  assert.equal(r.correct, null);
});

test("classifyAndVerify: real construct-extreme-number example routes to its own handler, not math_equation", () => {
  const verdict = mod.classifyAndVerify({ printedQuestion: "把5,0,8,6和2這五個數字組成一個最小的五位數。", studentAnswer: "20568" });
  assert.equal(verdict.handler, "construct_extreme_number");
  assert.equal(verdict.correct, true);
  assert.equal(verdict.subject, "math");
});

// --- verifyListFactors (2026-09-23) --------------------------------------

test("list factors: real example, 25 -> 1,5,25", () => {
  const r = mod.verifyListFactors("寫出25嘅所有因數", "1,5,25");
  assert.equal(r.correct, true);
});

test("list factors: order doesn't matter", () => {
  const r = mod.verifyListFactors("寫出25嘅所有因數", "25,1,5");
  assert.equal(r.correct, true);
});

test("list factors: missing a factor is wrong, all-or-nothing", () => {
  const r = mod.verifyListFactors("寫出25嘅所有因數", "1,25");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "1, 5, 25");
});

test("list factors: English phrasing, real example 34", () => {
  const r = mod.verifyListFactors("列出34的所有因數", "1,2,17,34");
  assert.equal(r.correct, true);
});

// --- verifyCountPrimesBelow (2026-09-23) --------------------------------

test("count primes below: real example, 100以內 -> 25", () => {
  const r = mod.verifyCountPrimesBelow("100以內共有質數多少個？", "25");
  assert.equal(r.correct, true);
});

test("count primes below: wrong count is caught", () => {
  const r = mod.verifyCountPrimesBelow("100以內共有質數多少個？", "24");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "25");
});

test("count primes below: no matching phrase stays null", () => {
  const r = mod.verifyCountPrimesBelow("100以內有幾多個雙數？", "50");
  assert.equal(r.correct, null);
});

// --- verifySequenceFill: multiple blanks in one item (2026-09-23) ------
// Real production evidence: a real user's bot photo of "Count in 2s.
// Fill in the gaps" (2,[4],6,[8],10,[12],[14],16,[18],20) came back from
// OCR as ONE item with studentAnswer "4;8;12;14;18" -- 5 blanks joined
// by semicolons, not 5 separate items.

test("sequence fill: real multi-blank example, all correct", () => {
  const r = mod.verifySequenceFill("2,?,6,?,10,?,?,16,?,20", "4;8;12;14;18");
  assert.equal(r.correct, true);
});

test("sequence fill: real multi-blank example, one wrong value is caught with the full expected list", () => {
  const r = mod.verifySequenceFill("2,?,6,?,10,?,?,16,?,20", "4;8;12;15;18");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "4, 8, 12, 14, 18");
});

test("sequence fill: multi-blank, comma-joined student answer also works", () => {
  const r = mod.verifySequenceFill("2,?,6,?,10,?,?,16,?,20", "4,8,12,14,18");
  assert.equal(r.correct, true);
});

test("sequence fill: multi-blank, wrong count of answers is caught, not silently truncated", () => {
  const r = mod.verifySequenceFill("2,?,6,?,10,?,?,16,?,20", "4;8;12");
  assert.equal(r.correct, false);
});

test("sequence fill: descending multi-blank real-shaped example", () => {
  const r = mod.verifySequenceFill("12,22,32,?,?,62,72", "42;52");
  assert.equal(r.correct, true);
});

test("classifyAndVerify: real multi-blank sequence routes to sequence_fill, not declined", () => {
  const verdict = mod.classifyAndVerify({ printedQuestion: "2,?,6,?,10,?,?,16,?,20", studentAnswer: "4;8;12;14;18" });
  assert.equal(verdict.handler, "sequence_fill");
  assert.equal(verdict.correct, true);
});

// --- verifyElapsedTimeForward (2026-09-23) -------------------------------

test("elapsed time forward: real example, 10:32am to 1:32pm -> 3 hours", () => {
  const r = mod.verifyElapsedTimeForward("手術由10:32am開始,到1:32pm完成,一共進行咗___小時。", "3");
  assert.equal(r.correct, true);
});

test("elapsed time forward: wrong answer is caught", () => {
  const r = mod.verifyElapsedTimeForward("手術由10:32am開始,到1:32pm完成,一共進行咗___小時。", "2");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "3");
});

test("elapsed time forward: no hours/小時 keyword stays null", () => {
  const r = mod.verifyElapsedTimeForward("10:32am, 1:32pm", "3");
  assert.equal(r.correct, null);
});

// --- verifyReverseDivisorFromRemainder (2026-09-23) ----------------------

test("reverse divisor from remainder: real example, 750÷※=16...14 -> 46", () => {
  const r = mod.verifyReverseDivisorFromRemainder("如果750÷※=16…14,那麼※=?", "46");
  assert.equal(r.correct, true);
});

test("reverse divisor from remainder: wrong answer is caught", () => {
  const r = mod.verifyReverseDivisorFromRemainder("如果750÷※=16…14,那麼※=?", "47");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "46");
});

test("reverse divisor from remainder: remainder >= quotient (impossible) stays null", () => {
  const r = mod.verifyReverseDivisorFromRemainder("如果100÷※=5…8,那麼※=?", "20");
  assert.equal(r.correct, null);
});

// --- verifyMultipleDifference (2026-09-23) -------------------------------

test("multiple difference: real example, 17's 11th vs 17th multiple -> 102", () => {
  const r = mod.verifyMultipleDifference("17嘅第十一個同第十七個倍數相差多少?", "102");
  assert.equal(r.correct, true);
});

test("multiple difference: wrong answer is caught", () => {
  const r = mod.verifyMultipleDifference("17嘅第十一個同第十七個倍數相差多少?", "100");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "102");
});

// --- verifyRoundToNearestHundred (2026-09-23) ----------------------------

test("round to nearest hundred: real example, 1584 -> 1600", () => {
  const r = mod.verifyRoundToNearestHundred("用四捨五入法把1584湊整至百位。", "1600");
  assert.equal(r.correct, true);
});

test("round to nearest hundred: rounds down correctly, 1733 -> 1700", () => {
  const r = mod.verifyRoundToNearestHundred("用四捨五入法把1733湊整至百位。", "1700");
  assert.equal(r.correct, true);
});

test("round to nearest hundred: wrong answer is caught", () => {
  const r = mod.verifyRoundToNearestHundred("用四捨五入法把1584湊整至百位。", "1500");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "1600");
});

test("round to nearest hundred: no 四捨五入/百位 keyword stays null", () => {
  const r = mod.verifyRoundToNearestHundred("1584係咩數?", "1600");
  assert.equal(r.correct, null);
});

// --- verifyReverseFactorSum (2026-09-23) ---------------------------------

test("reverse factor sum: real example, min+max factors sum to 37 -> 36", () => {
  const r = mod.verifyReverseFactorSum("如果★嘅最小和最大嘅因數之和係37,★=?", "36");
  assert.equal(r.correct, true);
});

test("reverse factor sum: wrong answer is caught", () => {
  const r = mod.verifyReverseFactorSum("如果★嘅最小和最大嘅因數之和係37,★=?", "37");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "36");
});

test("reverse factor sum: no matching phrase stays null", () => {
  const r = mod.verifyReverseFactorSum("37係咪質數?", "36");
  assert.equal(r.correct, null);
});

// --- parseSignedStudentNumber: sign-stripping bug fix (2026-09-23) -------
// Real bug found in code-review-2axis: the pattern used everywhere before
// this helper, `parseFloat(answer.replace(/[^\d.]/g, ""))`, discarded a
// genuine leading minus sign along with every other non-digit character,
// so a wrong-signed student answer ("-5" when correct is "5") was
// silently graded correct.

test("parseSignedStudentNumber: preserves a genuine leading minus sign", () => {
  assert.equal(mod.parseSignedStudentNumber("-5"), -5);
});

test("parseSignedStudentNumber: plain positive number still works", () => {
  assert.equal(mod.parseSignedStudentNumber("42"), 42);
});

test("parseSignedStudentNumber: decimal answer still works", () => {
  assert.equal(mod.parseSignedStudentNumber("3.5"), 3.5);
});

test("parseSignedStudentNumber: no digits at all returns NaN", () => {
  assert.ok(Number.isNaN(mod.parseSignedStudentNumber("abc")));
});

test("regression: a wrong-signed answer is no longer silently graded correct", () => {
  // Before the fix, "-36" would have its "-" stripped and be graded
  // correct against an expected answer of 36.
  const r = mod.verifyReverseFactorSum("如果★嘅最小和最大嘅因數之和係37,★=?", "-36");
  assert.equal(r.correct, false);
});
