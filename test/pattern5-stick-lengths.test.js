// Ticket 222 "Pattern 5" (2026-09-30, real citation: 小學數學新思維
// 3下A 作業, footer p.21, Q12: "利用左面3枝竹簽，（可以/不可以）圍成
// 一個三角形。（把答案圈起來）" -> 可以 (8<6+4=10, triangle inequality
// holds); "...（可以/不可以）圍成一個等腰三角形。" -> 不可以 (8,6,4 all
// distinct -- no two sides equal).
//
// A first attempt at this exact citation (earlier the same night) tried
// to parse these cm values straight out of printedQuestion and had to
// be reverted -- a real OCR test proved the numbers are printed ONLY in
// the diagram beside the question, never inside the question's own
// sentence, so detect() could never fire. Fixed properly this time via
// a new OCR_ONLY_PROMPT STICK_LENGTHS marker line (extractStickLengths)
// that captures the diagram's own printed lengths as page-level shared
// context, attached onto every item on that page (item.stickLengths)
// the same way priceTable/passageText already are.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_pattern5.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_pattern5.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_pattern5.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// ---------- extractStickLengths ----------

test("extractStickLengths: parses the real citation's marker line", async () => {
  const worker = await import(TMP);
  const text = "STICK_LENGTHS: 8cm;6cm;4cm\n12a=利用左面3枝竹簽，（可以 / 不可以）圍成一個三角形。（把答案圈起來）|可以";
  const { stickLengths, cleanedText } = worker.extractStickLengths(text);
  assert.deepEqual(stickLengths, [8, 6, 4]);
  assert.ok(!cleanedText.includes("STICK_LENGTHS"));
});

test("extractStickLengths: no marker line -> null, text unchanged", async () => {
  const worker = await import(TMP);
  const text = "1=2+2|4";
  const { stickLengths, cleanedText } = worker.extractStickLengths(text);
  assert.equal(stickLengths, null);
  assert.equal(cleanedText, text);
});

// ---------- isTriangleFormableFromSticksQuestion / verifyTriangleFormableFromSticks ----------

test("verifyTriangleFormableFromSticks: real citation Q12a, 8/6/4 can form a triangle -> 可以", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "利用左面3枝竹簽，（可以 / 不可以）圍成一個三角形。（把答案圈起來）", studentAnswer: "可以", stickLengths: [8, 6, 4] };
  const result = worker.verifyTriangleFormableFromSticks(item);
  assert.equal(result.correct, true);
});

test("verifyTriangleFormableFromSticks: real citation Q12b, 8/6/4 cannot form an isosceles triangle -> 不可以", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "利用左面3枝竹簽，（可以 / 不可以）圍成一個等腰三角形。（把答案圈起來）", studentAnswer: "不可以", stickLengths: [8, 6, 4] };
  const result = worker.verifyTriangleFormableFromSticks(item);
  assert.equal(result.correct, true);
});

test("verifyTriangleFormableFromSticks: wrong answer reports the real correct choice", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "利用左面3枝竹簽，（可以 / 不可以）圍成一個三角形。（把答案圈起來）", studentAnswer: "不可以", stickLengths: [8, 6, 4] };
  const result = worker.verifyTriangleFormableFromSticks(item);
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "可以");
});

test("verifyTriangleFormableFromSticks: sides that fail the triangle inequality -> 不可以", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "利用左面3枝竹簽，（可以 / 不可以）圍成一個三角形。（把答案圈起來）", studentAnswer: "不可以", stickLengths: [4, 5, 10] };
  const result = worker.verifyTriangleFormableFromSticks(item);
  assert.equal(result.correct, true);
});

test("isTriangleFormableFromSticksQuestion: declines (false) without stickLengths attached", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "利用左面3枝竹簽，（可以 / 不可以）圍成一個三角形。（把答案圈起來）" };
  assert.equal(worker.isTriangleFormableFromSticksQuestion(item), false);
});

test("triangle_formable_from_sticks handler: registered, wins dispatch on the real citation shape", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "利用左面3枝竹簽，（可以 / 不可以）圍成一個三角形。（把答案圈起來）", studentAnswer: "可以", stickLengths: [8, 6, 4] };
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item));
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, "triangle_formable_from_sticks");
});
