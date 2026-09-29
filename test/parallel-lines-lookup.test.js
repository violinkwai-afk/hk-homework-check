// Ticket 210 (letter/character parallel-stroke lookup table) -- see
// CJK_PARALLEL_LINES_TABLE/LATIN_PARALLEL_LINES_TABLE's own comment in
// src/worker.js for the real citation and disclosed bounded-glyph-set
// scope. Pure text/logic, zero image work -- no PhotonImage fixture-swap
// harness needed for this file.
//
// Real citation: 26週數學訓練 P3 Topic 20「平行線」math34pdf/p54.png Q6
// ("下列哪一個中文字有平行線?" A.下 B.千 C.山 D.木 -> C) and
// math34pdf/p53.png Q2 ("上圖中有平行線的英文字母有___個。" over
// "A B C D E F G H" -> 3). Both self-verified against the real page
// image and the real answer key before building.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_parallellines.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_parallellines.mjs");

let worker;
test.before(async () => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_parallellines.mjs"');
  fs.writeFileSync(TMP, src);
  worker = await import(TMP);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

test("verifyCjkParallelLinesMc: real citation -- correct answer C (山)", () => {
  const printed = "下列哪一個中文字有平行線？A.下 B.千 C.山 D.木";
  const result = worker.verifyCjkParallelLinesMc(printed, "C");
  assert.equal(result.correct, true);
});

test("verifyCjkParallelLinesMc: wrong option flagged wrong with the real correct answer", () => {
  const printed = "下列哪一個中文字有平行線？A.下 B.千 C.山 D.木";
  const result = worker.verifyCjkParallelLinesMc(printed, "A");
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "C");
});

test("isCjkParallelLinesMcQuestion: detects the real citation shape, rejects unrelated text", () => {
  assert.equal(worker.isCjkParallelLinesMcQuestion({ printedQuestion: "下列哪一個中文字有平行線？A.下 B.千 C.山 D.木" }), true);
  assert.equal(worker.isCjkParallelLinesMcQuestion({ printedQuestion: "4+6=?" }), false);
});

test("verifyLatinParallelLinesCount: real citation -- correct answer 3 (E,F,H)", () => {
  const printed = "A B C D E F G H\n上圖中有平行線的英文字母有___個。";
  const result = worker.verifyLatinParallelLinesCount(printed, "3");
  assert.equal(result.correct, true);
});

test("verifyLatinParallelLinesCount: wrong count flagged wrong with the real correct answer", () => {
  const printed = "A B C D E F G H\n上圖中有平行線的英文字母有___個。";
  const result = worker.verifyLatinParallelLinesCount(printed, "2");
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "3");
});

test("isLatinParallelLinesCountQuestion: detects the real citation shape, rejects unrelated text", () => {
  assert.equal(worker.isLatinParallelLinesCountQuestion({ printedQuestion: "A B C D E F G H\n上圖中有平行線的英文字母有___個。" }), true);
  assert.equal(worker.isLatinParallelLinesCountQuestion({ printedQuestion: "4+6=?" }), false);
});

test("verifyLatinParallelLinesCount: fails open on a letter outside the disclosed table (e.g. M)", () => {
  const printed = "A B C D E F G H M\n上圖中有平行線的英文字母有___個。";
  const result = worker.verifyLatinParallelLinesCount(printed, "3");
  assert.equal(result.correct, null);
});

test("cjk_parallel_lines_mc and latin_parallel_lines_count handlers: registered, win dispatch", () => {
  const item1 = { printedQuestion: "下列哪一個中文字有平行線？A.下 B.千 C.山 D.木", studentAnswer: "C" };
  const handler1 = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item1))[0];
  assert.equal(handler1.name, "cjk_parallel_lines_mc");
  assert.equal(worker.classifyAndVerify(item1, () => null).correct, true);

  const item2 = { printedQuestion: "A B C D E F G H\n上圖中有平行線的英文字母有___個。", studentAnswer: "3" };
  const handler2 = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item2))[0];
  assert.equal(handler2.name, "latin_parallel_lines_count");
  assert.equal(worker.classifyAndVerify(item2, () => null).correct, true);
});
