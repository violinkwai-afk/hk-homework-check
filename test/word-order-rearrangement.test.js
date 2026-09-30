// Ticket 222 "word-order-rearrangement OCR noise" (2026-10-01). Real
// citation: from the "Question words (1)" worksheet's "Rearrange the
// words to form questions. Follow the example." exercise -- OCR
// faithfully transcribed the page's own printed "Q: ... A: ..." worked-
// example labels into printedQuestion, duplicating the student's whole
// rearranged sentence and confusing Jev, which confidently marked a
// real, clearly ✓-marked-correct answer ("When is New Year?") as
// WRONG (noul=0.04). Investigated directly after the user asked why
// Jev was inaccurate on this shape. See stripWorkedExampleEcho's own
// comment in worker.js for the full root-cause account.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_wordorder.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_wordorder.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_wordorder.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// Real raw OCR text, verbatim, from the 2026-10-01 test run.
const REAL_QUESTION_WORDS_OCR = `1=( What / When ) is the school fair? It's on 26th March.|When
2=( When / What ) is the date today? It's 13th May.|What
1=What today the date is Q: What is the date today? A: It's the twenty-sixth of August.|What is the date today?
2=When New Year is Q: When is New Year? A: It's on the first of January.|When is New Year?
3=When the is school picnic Q: When is the school picnic? A: It's on the seventeenth of October.|When is the school picnic?
4=What date is today's Q: What is today's date? A: It's the thirtieth of October.|What is today's date?`;

test("stripWorkedExampleEcho: real citation -- strips the Q:/A: echo down to just the word tiles", async () => {
  const worker = await import(TMP);
  const items = worker.stripWorkedExampleEcho(worker.parseOcrLine(REAL_QUESTION_WORDS_OCR));
  // The 4 word-order items are all labeled "1".."4" a second time
  // (separate section from the MC section above) -- find by position.
  const wordOrderItems = items.filter((i) => /^(What|When)/.test(i.printedQuestion) && !i.printedQuestion.includes("Q:"));
  assert.equal(wordOrderItems.length, 4);
  assert.equal(wordOrderItems[0].printedQuestion, "What today the date is");
  assert.equal(wordOrderItems[1].printedQuestion, "When New Year is");
  assert.equal(wordOrderItems[2].printedQuestion, "When the is school picnic");
  assert.equal(wordOrderItems[3].printedQuestion, "What date is today's");
  // studentAnswer itself is untouched -- only printedQuestion changes.
  assert.equal(wordOrderItems[1].studentAnswer, "When is New Year?");
});

test("stripWorkedExampleEcho: does NOT touch the unrelated MC items on the same page", async () => {
  const worker = await import(TMP);
  const items = worker.stripWorkedExampleEcho(worker.parseOcrLine(REAL_QUESTION_WORDS_OCR));
  const mc1 = items.find((i) => i.printedQuestion.includes("school fair"));
  assert.equal(mc1.printedQuestion, "( What / When ) is the school fair? It's on 26th March.");
});

test("stripWorkedExampleEcho: declines when the 'Q:' portion doesn't actually match studentAnswer (not the redundant-echo pattern)", async () => {
  const worker = await import(TMP);
  const items = worker.stripWorkedExampleEcho([
    { label: "1", printedQuestion: "some tiles Q: a totally different question? A: some fact.", studentAnswer: "an unrelated answer" },
  ]);
  assert.equal(items[0].printedQuestion, "some tiles Q: a totally different question? A: some fact.");
});

test("isWordRearrangementItem: real citation fires after stripping (word-for-word match, no blank marker)", async () => {
  const worker = await import(TMP);
  const items = worker.stripWorkedExampleEcho(worker.parseOcrLine(REAL_QUESTION_WORDS_OCR));
  const item = items.find((i) => i.printedQuestion === "When New Year is");
  assert.equal(worker.isWordRearrangementItem(item), true);
});

test("isWordRearrangementItem: real citation from a DIFFERENT worksheet (modals_canCant, no Q:/A: noise at all)", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "play basketball you can", studentAnswer: "Can you play basketball?" };
  assert.equal(worker.isWordRearrangementItem(item), true);
});

test("isWordRearrangementItem: false for an ordinary question that just reuses a couple of its own words in the answer", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "What is his favourite colour?", studentAnswer: "His favourite colour is blue." };
  assert.equal(worker.isWordRearrangementItem(item), false);
});

test("isWordRearrangementItem: false when a blank marker is present (that's a cloze fill-in, not a rearrangement)", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "I like ____ apples.", studentAnswer: "eating" };
  assert.equal(worker.isWordRearrangementItem(item), false);
});

test("buildWordRearrangementHint: real citation produces the framing hint", async () => {
  const worker = await import(TMP);
  const items = worker.stripWorkedExampleEcho(worker.parseOcrLine(REAL_QUESTION_WORDS_OCR));
  const item = items.find((i) => i.printedQuestion === "When New Year is");
  assert.match(worker.buildWordRearrangementHint(item), /word bank/);
});

test("buildJevQuestions: the word-rearrangement hint actually reaches Jev's instructions text for the real citation", async () => {
  const worker = await import(TMP);
  const items = worker.stripWorkedExampleEcho(worker.parseOcrLine(REAL_QUESTION_WORDS_OCR));
  const item = { ...items.find((i) => i.printedQuestion === "When New Year is"), resultIndex: 1 };
  const questions = worker.buildJevQuestions([item]);
  assert.match(questions["1"].instructions, /word bank/);
});
