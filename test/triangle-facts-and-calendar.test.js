// Ticket 216 (triangle true/false fact table + max-obtuse-angle fact)
// and Ticket 208 (calendar fact lookup: days-with-31 count, weekday
// offset) -- both pure text/logic, zero image or OCR-marker work.
//
// Real citations:
// - 216: 小學數學新思維 3下A 作業 p.21 (math3xa_pdf/p22.png), Q⑦-⑩ and
//   p.19 (math3xa_pdf/p20.png) Q⑧ -- self-verified against the real
//   page images before building.
// - 208: 26週數學訓練 P3 Topic 2「年月日」(math34pdf/p04.png) Q1, Q2,
//   cross-checked against the real answer key (math34pdf/answers_p01.png,
//   Topic 2: "1. 7  2. 三") -- self-verified against both real pages.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_trianglecal.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_trianglecal.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_trianglecal.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// ---------- Ticket 216: triangle T/F facts ----------

test("classifyTriangleFactStatement: real citation Q7-10, all 4 classified correctly", async () => {
  const worker = await import(TMP);
  assert.equal(worker.classifyTriangleFactStatement("所有等邊三角形皆是等腰三角形。"), true);
  assert.equal(worker.classifyTriangleFactStatement("所有等腰三角形皆是等腰直角三角形。"), false);
  assert.equal(worker.classifyTriangleFactStatement("等腰三角形必定有一個直角。"), false);
  assert.equal(worker.classifyTriangleFactStatement("在一個三角形中，任意兩邊的長度之和必定大於第三邊的長度。"), true);
});

test("classifyTriangleFactStatement: unrelated statement returns null (fails open)", async () => {
  const worker = await import(TMP);
  assert.equal(worker.classifyTriangleFactStatement("所有正方形都是長方形。"), null);
});

test("normalizeCheckMark: common real-world mark variants", async () => {
  const worker = await import(TMP);
  assert.equal(worker.normalizeCheckMark("✓"), true);
  assert.equal(worker.normalizeCheckMark("√"), true);
  assert.equal(worker.normalizeCheckMark("✗"), false);
  assert.equal(worker.normalizeCheckMark("×"), false);
  assert.equal(worker.normalizeCheckMark(""), null);
});

test("verifyTriangleFactTrueFalse: real citation Q7 -- student marks ✓ -> correct", async () => {
  const worker = await import(TMP);
  const r = worker.verifyTriangleFactTrueFalse("所有等邊三角形皆是等腰三角形。", "✓");
  assert.equal(r.correct, true);
});

test("verifyTriangleFactTrueFalse: real citation Q8 -- student wrongly marks ✓ -> wrong, correct answer ✗", async () => {
  const worker = await import(TMP);
  const r = worker.verifyTriangleFactTrueFalse("所有等腰三角形皆是等腰直角三角形。", "✓");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "✗");
});

test("verifyTriangleFactTrueFalse: real citation Q10 -- student marks ✓ -> correct", async () => {
  const worker = await import(TMP);
  const r = worker.verifyTriangleFactTrueFalse("在一個三角形中，任意兩邊的長度之和必定大於第三邊的長度。", "✓");
  assert.equal(r.correct, true);
});

test("verifyMaxObtuseAngleInTriangle: real citation p20 Q8 -- correct answer 1", async () => {
  const worker = await import(TMP);
  const right = worker.verifyMaxObtuseAngleInTriangle("一個三角形最多有鈍角多少個？答案：______個", "1");
  assert.equal(right.correct, true);
  const wrong = worker.verifyMaxObtuseAngleInTriangle("一個三角形最多有鈍角多少個？答案：______個", "2");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "1");
});

test("triangle_fact_true_false handler: registered, wins dispatch on real citation", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "所有等邊三角形皆是等腰三角形。", studentAnswer: "✓" };
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item))[0];
  assert.equal(matched.name, "triangle_fact_true_false");
  const result = worker.classifyAndVerify(item, () => null);
  assert.equal(result.correct, true);
});

// ---------- Ticket 208: calendar fact lookup ----------

test("verifyDaysWith31Count: real citation Q1 -- 7 is correct", async () => {
  const worker = await import(TMP);
  const right = worker.verifyDaysWith31Count("一年裏有31天的月份有___個。", "7");
  assert.equal(right.correct, true);
  const wrong = worker.verifyDaysWith31Count("一年裏有31天的月份有___個。", "6");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "7");
});

test("verifyWeekdayOffset: real citation Q2 -- June 1 Sunday -> May 28 is Wednesday", async () => {
  const worker = await import(TMP);
  const printed = "如果6月1日是星期日，那麼5月28日是星期___。";
  const right = worker.verifyWeekdayOffset(printed, "三");
  assert.equal(right.correct, true);
  const wrong = worker.verifyWeekdayOffset(printed, "二");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "三");
});

test("verifyWeekdayOffset: forward-direction offset also works (not just backward)", async () => {
  const worker = await import(TMP);
  // 1月1日是星期一 -> 1月8日 is exactly 7 days later -> same weekday (一)
  const r = worker.verifyWeekdayOffset("如果1月1日是星期一，那麼1月8日是星期___。", "一");
  assert.equal(r.correct, true);
});

test("days_with_31_count and weekday_offset handlers: registered, win dispatch", async () => {
  const worker = await import(TMP);
  const item1 = { printedQuestion: "一年裏有31天的月份有___個。", studentAnswer: "7" };
  assert.equal(worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item1))[0].name, "days_with_31_count");
  assert.equal(worker.classifyAndVerify(item1, () => null).correct, true);

  const item2 = { printedQuestion: "如果6月1日是星期日，那麼5月28日是星期___。", studentAnswer: "三" };
  assert.equal(worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item2))[0].name, "weekday_offset");
  assert.equal(worker.classifyAndVerify(item2, () => null).correct, true);
});
