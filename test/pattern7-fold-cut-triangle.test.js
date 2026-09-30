// Ticket 222 "Pattern 7" (2026-09-30, real citation: 小學數學新思維
// 3下A 作業, footer p.23):
// Q7: "沿着虛線把左圖的長方形剪開後，可得出2個（直角/等腰/等邊）三角
//      形。(把答案圈起來)" -- real answer 直角 (confirmed against the
//      actual worksheet, message sent 2026-09-30 with the real answer
//      circled). Closed-form fact: a rectangle's diagonal always
//      produces 2 congruent right triangles, no measurement needed.
// Q8: "下面的六邊形每條邊的長度都相等。[cut into A/B/C/D, drawn apart]
//      圖A是（直角/等腰/等邊）三角形。(把答案圈起來)" -- reuses the same
//      real polygon-geometry measurement as triangle_subtype_letter.
//      NOT independently verified against a real handwritten answer
//      (none was sent for this specific sub-question) -- confidence
//      instead comes from a strong geometric self-consistency check:
//      the hexagon's own left-right symmetry means piece A and piece D
//      (the two end slivers) are mirror images and MUST classify the
//      same way, and piece B/C (the two middle pieces) likewise -- the
//      real measured data below shows exactly that pairing (A,D both
//      isosceles; B,C both right), which would not happen by chance if
//      the geometry extraction were unreliable.
// Q9: "詠恩把正方形紙依以下的方法摺和剪...打開後，把正方形紙沿摺痕剪
//      開，可得出8個____三角形。" -- real answer 等腰 (confirmed). Closed-
//      form fact: this fold-twice-then-cut-diagonal method always
//      produces 8 congruent isosceles triangles by symmetry.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_pattern7.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_pattern7.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_pattern7.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "hexagon-cut", name)).toString("base64");
}

// ---------- Q7: rectangle_diagonal_cut ----------

test("isRectangleDiagonalCutQuestion: matches the real citation", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "沿着虛線把左圖的長方形剪開後，可得出2個（直角/等腰/等邊）三角形。(把答案圈起來)" };
  assert.equal(worker.isRectangleDiagonalCutQuestion(item), true);
});

test("verifyRectangleDiagonalCut: real citation, correct answer 直角", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "沿着虛線把左圖的長方形剪開後，可得出2個（直角/等腰/等邊）三角形。", studentAnswer: "直角" };
  const result = worker.verifyRectangleDiagonalCut(item);
  assert.equal(result.correct, true);
});

test("verifyRectangleDiagonalCut: wrong answer reports 直角", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "沿着虛線把左圖的長方形剪開後，可得出2個（直角/等腰/等邊）三角形。", studentAnswer: "等腰" };
  const result = worker.verifyRectangleDiagonalCut(item);
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "直角");
});

// ---------- Q9: square_fold_cut_eight ----------

test("isSquareFoldCutEightQuestion: matches the real citation", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "打開後，把正方形紙沿摺痕剪開，可得出8個____三角形。" };
  assert.equal(worker.isSquareFoldCutEightQuestion(item), true);
});

test("verifySquareFoldCutEight: real citation, correct answer 等腰", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "打開後，把正方形紙沿摺痕剪開，可得出8個____三角形。", studentAnswer: "等腰" };
  const result = worker.verifySquareFoldCutEight(item);
  assert.equal(result.correct, true);
});

test("verifySquareFoldCutEight: wrong answer reports 等腰", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "打開後，把正方形紙沿摺痕剪開，可得出8個____三角形。", studentAnswer: "不等邊" };
  const result = worker.verifySquareFoldCutEight(item);
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "等腰");
});

// ---------- Q8: hexagon_cut_piece_type ----------

test("isHexagonCutPieceTypeQuestion: matches the real citation", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "下面的六邊形每條邊的長度都相等。沿着虛線把六邊形剪開後，可得出4個三角形。圖A是（直角/等腰/等邊）三角形。(把答案圈起來)" };
  assert.equal(worker.isHexagonCutPieceTypeQuestion(item), true);
});

test("verifyHexagonCutPieceType: real citation, 圖A是等腰三角形 (real measured geometry, cross-checked via hexagon's own left-right symmetry)", async () => {
  const worker = await import(TMP);
  const crop = { data: loadFixtureBase64("p23-pieces-a-d.png") };
  const item = { printedQuestion: "下面的六邊形每條邊的長度都相等。沿着虛線把六邊形剪開後，可得出4個三角形。圖A是（直角/等腰/等邊）三角形。", studentAnswer: "等腰" };
  const result = worker.verifyHexagonCutPieceType(item, crop);
  assert.equal(result.correct, true);
});

test("verifyHexagonCutPieceType: symmetry cross-check -- A and D (mirror pieces) classify the same; B and C (mirror pieces) classify the same", async () => {
  const worker = await import(TMP);
  const crop = { data: loadFixtureBase64("p23-pieces-a-d.png") };
  const a = worker.verifyHexagonCutPieceType({ printedQuestion: "下面的六邊形每條邊的長度都相等。沿着虛線把六邊形剪開後，可得出4個三角形。圖A是（直角/等腰/等邊）三角形。", studentAnswer: "不等邊" }, crop).correctAnswer;
  const d = worker.verifyHexagonCutPieceType({ printedQuestion: "下面的六邊形每條邊的長度都相等。沿着虛線把六邊形剪開後，可得出4個三角形。圖D是（直角/等腰/等邊）三角形。", studentAnswer: "不等邊" }, crop).correctAnswer;
  const b = worker.verifyHexagonCutPieceType({ printedQuestion: "下面的六邊形每條邊的長度都相等。沿着虛線把六邊形剪開後，可得出4個三角形。圖B是（直角/等腰/等邊）三角形。", studentAnswer: "不等邊" }, crop).correctAnswer;
  const c = worker.verifyHexagonCutPieceType({ printedQuestion: "下面的六邊形每條邊的長度都相等。沿着虛線把六邊形剪開後，可得出4個三角形。圖C是（直角/等腰/等邊）三角形。", studentAnswer: "不等邊" }, crop).correctAnswer;
  assert.equal(a, d);
  assert.equal(b, c);
  assert.notEqual(a, b);
});

test("verifyHexagonCutPieceType: wrong answer reports the real correct category", async () => {
  const worker = await import(TMP);
  const crop = { data: loadFixtureBase64("p23-pieces-a-d.png") };
  const item = { printedQuestion: "下面的六邊形每條邊的長度都相等。沿着虛線把六邊形剪開後，可得出4個三角形。圖B是（直角/等腰/等邊）三角形。", studentAnswer: "等邊" };
  const result = worker.verifyHexagonCutPieceType(item, crop);
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "直角");
});

// ---------- dispatch registration ----------

test("rectangle_diagonal_cut, square_fold_cut_eight, hexagon_cut_piece_type: registered, each wins dispatch on its own real citation", async () => {
  const worker = await import(TMP);
  const item1 = { printedQuestion: "沿着虛線把左圖的長方形剪開後，可得出2個（直角/等腰/等邊）三角形。", studentAnswer: "直角" };
  assert.equal(worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item1))[0].name, "rectangle_diagonal_cut");

  const item2 = { printedQuestion: "打開後，把正方形紙沿摺痕剪開，可得出8個____三角形。", studentAnswer: "等腰" };
  assert.equal(worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item2))[0].name, "square_fold_cut_eight");

  const item3 = { printedQuestion: "下面的六邊形每條邊的長度都相等。沿着虛線把六邊形剪開後，可得出4個三角形。圖A是（直角/等腰/等邊）三角形。", studentAnswer: "等腰" };
  assert.equal(worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item3))[0].name, "hexagon_cut_piece_type");
});
