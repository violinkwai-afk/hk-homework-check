// 2026-09-30: first installment of "code 題解釋部分 -- 逐個handler補"
// (explicit user request, Telegram). Two independent halves:
// (1) code-verified handlers now optionally return an `explanation`
//     field alongside `correct`/`correctAnswer` -- classifyAndVerify
//     already spreads a handler's whole return object onto `verdict`
//     (worker.js, no wiring change needed there), and the results.push
//     site now reads `verdict.explanation` into `note` for wrong items
//     (previously always cleared to "" for `correct === false`).
// (2) the AI-fallback prompt (buildAiFallbackPrompt) now asks Gemini to
//     put a short WHY into the existing "note" field for wrong items
//     too (previously only requested for the null/needs_review case) --
//     zero new API calls, same existing call, negligible extra output
//     tokens.
// Only a first batch of the highest-volume handlers got a bespoke
// explanation this round (plain arithmetic, word-problem totals, price
// table lookups, digit-count, compound-unit conversion) -- every other
// handler simply has no `explanation` field yet and degrades to the
// exact prior behaviour (empty note), never a fabricated guess. See
// benchmark/question-type-library.md for the running coverage list.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_explanations.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_explanations.mjs");

let mod;
test.before(async () => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_explanations.mjs"');
  fs.writeFileSync(TMP, src);
  mod = await import(TMP);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// --- verifyMath: full-equation case ("5+2=7" style) -------------------

test("verifyMath: wrong full equation gets an explanation showing the real computation", () => {
  const r = mod.verifyMath("", "5+2=8");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "7");
  assert.match(r.explanation, /5\+2 = 7/);
});

test("verifyMath: correct full equation has an empty explanation", () => {
  const r = mod.verifyMath("", "5+2=7");
  assert.equal(r.correct, true);
  assert.equal(r.explanation, "");
});

// --- verifyMath: bare-answer-against-printed-expression case ----------

test("verifyMath: wrong bare answer against a printed expression explains the real computation", () => {
  const r = mod.verifyMath("4+6=", "9");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "10");
  assert.match(r.explanation, /4\+6 = 10/);
});

// --- verifyMath: division-with-remainder case --------------------------

test("verifyMath: wrong division-with-remainder explains quotient and remainder", () => {
  const r = mod.verifyMath("87÷6", "14…5"); // real remainder is 3, not 5
  assert.equal(r.correct, false);
  assert.match(r.explanation, /87÷6 = 14\.\.\.3/);
  assert.match(r.explanation, /商14餘3/);
});

// --- verifyMath: blank-in-the-middle substitution case -----------------

test("verifyMath: wrong blank-fill substitution explains the reconstructed equation", () => {
  // trySubstituteBlank substitutes the student's OWN answer into the
  // blank and evaluates whether that reconstruction holds -- correctAnswer
  // here is what the LHS evaluates to under the student's (wrong)
  // substitution, not the actual missing digit (9). Pre-existing
  // behaviour, unrelated to this change -- the explanation documents
  // exactly that same computation, not a different one.
  const r = mod.verifyMath("54÷□=6", "8");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "6.75");
  assert.match(r.explanation, /54÷8 = 6\.75/);
});

// --- verifyMath: multi-sub-answer joining --------------------------------

test("verifyMath: multiple wrong sub-answers join their own explanations", () => {
  const r = mod.verifyMath("", "5+2=8;3+3=7");
  assert.equal(r.correct, false);
  assert.match(r.explanation, /5\+2 = 7/);
  assert.match(r.explanation, /3\+3 = 6/);
});

// --- verifyWordProblemTotal ---------------------------------------------

test("verifyWordProblemTotal: wrong sum explains which numbers get added", () => {
  const r = mod.verifyWordProblemTotal("樓上有10人，樓下有4人，共有多少人？", "16");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "14");
  assert.match(r.explanation, /10\+4 = 14/);
});

test("verifyWordProblemTotal: correct sum has an empty explanation", () => {
  const r = mod.verifyWordProblemTotal("樓上有10人，樓下有4人，共有多少人？", "14");
  assert.equal(r.correct, true);
  assert.equal(r.explanation, "");
});

// --- verifyPriceTableLookup ----------------------------------------------

test("verifyPriceTableLookup: wrong sum explains both prices", () => {
  const r = mod.verifyPriceTableLookup({ 機械人: 48, 洋娃娃: 25 }, "買機械人和洋娃娃各一個共需付()元", "80");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "73");
  assert.match(r.explanation, /機械人\$48\+洋娃娃\$25 = \$73/);
});

test("verifyPriceTableLookup: wrong difference explains both prices", () => {
  const r = mod.verifyPriceTableLookup({ 機械人: 48, 跑車: 89 }, "跑車比機械人貴()元", "40");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "41");
  assert.match(r.explanation, /相差/);
  assert.match(r.explanation, /\$89-\$48 = \$41/);
});

// --- verifyDigitCountOfNPlusOne -------------------------------------------

test("verifyDigitCountOfNPlusOne: wrong answer explains N+1 and its digit count", () => {
  const r = mod.verifyDigitCountOfNPlusOne("9999後面個數有幾多位?", "4");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "5");
  assert.match(r.explanation, /9999後面一個數係10000，有5位數/);
});

// --- verifyCompoundUnitConversion -----------------------------------------

test("verifyCompoundUnitConversion: wrong answer explains the per-component conversion", () => {
  const r = mod.verifyCompoundUnitConversion("8m 11cm=___cm", "812");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "811");
  assert.match(r.explanation, /800cm\+11cm = 811cm/);
});

// --- buildAiFallbackPrompt: now asks for a "why" on wrong items too ------

test("buildAiFallbackPrompt: instructs the model to explain WHY on wrong items, not just null", () => {
  const prompt = mod.buildAiFallbackPrompt([{ question: "1", printedQuestion: "3+4=", studentAnswer: "8" }]);
  assert.match(prompt, /"correct"為false嗰陣，"note"要簡短.*講清楚學生點解錯/);
});
