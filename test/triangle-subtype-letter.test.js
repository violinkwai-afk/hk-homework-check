// Ticket 222 (2026-09-30, real citation: 小學數學新思維 3下A 作業,
// footer p.18 -- "觀察以下各平面圖形，把所有代表答案的英文字母填在橫
// 線上。③等邊三角形：___ ④等腰直角三角形：___ ⑤不等邊三角形：___",
// real shapes labelled A-G): classify each printed TRIANGLE's own
// sub-type from real polygon geometry, same real-edge-measurement
// approach as Ticket 204's classifyTrapezoidType.
//
// Real finding during verification, kept as regression coverage here:
// (1) each shape's own letter label is printed INSIDE its filled
// outline, close enough that the glyph's own ink forms a small blob
// next to the real shape -- readShapeClassificationFromPixels's raw
// output for the real fixture below is dominated by ~30 spurious tiny
// blobs (a real, previously-undiscovered gap, NOT specific to this
// ticket's own new code -- shape_classification_grid/trapezoid_type_letter
// share the same underlying function and were not shown to hit this,
// but were also never tested against a letters-INSIDE-shapes layout).
// Fixed locally (not in the shared function, to avoid any risk to
// those two already-shipped callers) via a relative-size filter.
// (2) the polygon-simplification step sometimes reads a real triangle
// as a 4-vertex "quadrilateral" when contour noise adds one spurious
// near-collinear vertex along an otherwise-straight edge (confirmed:
// interior angles 169.2° and 177.9° on the two real shapes this hit,
// vs every genuine corner under 113°) -- recovered locally via
// collapseNearCollinearQuadToTriangle.
//
// Real verified ground truth used below: 等邊三角形 (C,E) matches the
// student's real handwritten answer on the actual worksheet EXACTLY
// (case-insensitive "c, e"). The other two real answers on this same
// page (④等腰直角三角形：B, ⑤不等邊三角形：D,F,G,B) were flagged to the
// user as an unresolved discrepancy against this code's own precise
// angle measurement (F measures a right angle at 90.9°, isosceles by
// side length; B measures no angle within 22° of 90° at all) -- NOT
// asserted here as ground truth pending that resolution; only the
// unambiguous 等邊/C,E match and the code's internal self-consistency
// (whichever shape the code calls "isosceles-right" must also appear
// in both the 等腰 and 直角 result sets) are tested against the real
// fixture.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_trisubtype.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_trisubtype.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_trisubtype.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "triangle-subtype", name)).toString("base64");
}

// ---------- computeTriangleSubtypeProperties: synthetic geometry ----------

test("computeTriangleSubtypeProperties: equilateral", async () => {
  const worker = await import(TMP);
  const a = { x: 0, y: 0 }, b = { x: 100, y: 0 }, c = { x: 50, y: 86.6 };
  const props = worker.computeTriangleSubtypeProperties([a, b, c]);
  assert.equal(props.isEquilateral, true);
  assert.equal(props.isRight, false);
});

test("computeTriangleSubtypeProperties: isosceles right (legs equal)", async () => {
  const worker = await import(TMP);
  const a = { x: 0, y: 0 }, b = { x: 0, y: 100 }, c = { x: 100, y: 100 };
  const props = worker.computeTriangleSubtypeProperties([a, b, c]);
  assert.equal(props.isEquilateral, false);
  assert.equal(props.isIsosceles, true);
  assert.equal(props.isRight, true);
});

test("computeTriangleSubtypeProperties: scalene, no right angle", async () => {
  const worker = await import(TMP);
  // sides ~206, ~103, ~150 -- clearly distinct, well outside the 8% tolerance.
  const a = { x: 0, y: 0 }, b = { x: 200, y: 40 }, c = { x: 60, y: 130 };
  const props = worker.computeTriangleSubtypeProperties([a, b, c]);
  assert.equal(props.isEquilateral, false);
  assert.equal(props.isIsosceles, false);
});

// ---------- collapseNearCollinearQuadToTriangle ----------

test("collapseNearCollinearQuadToTriangle: recovers a triangle with one spurious near-straight vertex", async () => {
  const worker = await import(TMP);
  // A real triangle (0,0)-(100,0)-(50,80) with an extra point inserted
  // almost exactly on the (0,0)-(100,0) edge (170deg+ interior angle).
  const quad = [{ x: 0, y: 0 }, { x: 50, y: 1 }, { x: 100, y: 0 }, { x: 50, y: 80 }];
  const tri = worker.collapseNearCollinearQuadToTriangle(quad);
  assert.equal(tri.length, 3);
});

test("collapseNearCollinearQuadToTriangle: a genuine quadrilateral (no near-straight vertex) returns null", async () => {
  const worker = await import(TMP);
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  assert.equal(worker.collapseNearCollinearQuadToTriangle(square), null);
});

// ---------- classifyPrintedTriangleSubtypeTarget: anchored detection ----------

test("classifyPrintedTriangleSubtypeTarget: real citation-format strings match", async () => {
  const worker = await import(TMP);
  assert.equal(worker.classifyPrintedTriangleSubtypeTarget("等邊三角形："), "等邊三角形");
  assert.equal(worker.classifyPrintedTriangleSubtypeTarget("等腰直角三角形："), "等腰直角三角形");
  assert.equal(worker.classifyPrintedTriangleSubtypeTarget("不等邊三角形："), "不等邊三角形");
});

test("classifyPrintedTriangleSubtypeTarget: does NOT match a full T/F sentence merely mentioning a category name (real collision found + fixed)", async () => {
  const worker = await import(TMP);
  assert.equal(worker.classifyPrintedTriangleSubtypeTarget("所有等邊三角形皆是等腰三角形。"), null);
  assert.equal(worker.classifyPrintedTriangleSubtypeTarget("等腰三角形必定有一個直角。"), null);
});

test("triangle_subtype_letter vs triangle_fact_true_false: no dispatch collision on the real T/F citation", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "所有等邊三角形皆是等腰三角形。", studentAnswer: "✓" };
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item));
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, "triangle_fact_true_false");
});

// ---------- verifyTriangleSubtypeLetterQuestion: real fixture end-to-end ----------

test("verifyTriangleSubtypeLetterQuestion: real citation, 等邊三角形 = C,E (matches the real handwritten answer exactly)", async () => {
  const worker = await import(TMP);
  const crop = { data: loadFixtureBase64("p18-shapes-a-g.png") };
  const item = { printedQuestion: "等邊三角形：", studentAnswer: "c, e" };
  const result = worker.verifyTriangleSubtypeLetterQuestion(item, crop);
  assert.equal(result.correct, true);
});

test("verifyTriangleSubtypeLetterQuestion: real citation, wrong answer reports the real correct letters", async () => {
  const worker = await import(TMP);
  const crop = { data: loadFixtureBase64("p18-shapes-a-g.png") };
  const item = { printedQuestion: "等邊三角形：", studentAnswer: "A" };
  const result = worker.verifyTriangleSubtypeLetterQuestion(item, crop);
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "C,E");
});

test("verifyTriangleSubtypeLetterQuestion: internal self-consistency -- whichever shape is isosceles-right also appears in both 等腰 and 直角 result sets", async () => {
  const worker = await import(TMP);
  const crop = { data: loadFixtureBase64("p18-shapes-a-g.png") };
  const rightItem = { printedQuestion: "等腰直角三角形：", studentAnswer: "A" };
  const rightResult = worker.verifyTriangleSubtypeLetterQuestion(rightItem, crop);
  const isoLetters = worker.verifyTriangleSubtypeLetterQuestion({ printedQuestion: "等腰三角形：", studentAnswer: "A" }, crop).correctAnswer.split(",");
  const rightAngleLetters = worker.verifyTriangleSubtypeLetterQuestion({ printedQuestion: "直角三角形：", studentAnswer: "A" }, crop).correctAnswer.split(",");
  const isoRightLetter = rightResult.correctAnswer;
  assert.ok(isoLetters.includes(isoRightLetter));
  assert.ok(rightAngleLetters.includes(isoRightLetter));
});

test("triangle_subtype_letter handler: registered, wins dispatch on the real citation format", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "不等邊三角形：", studentAnswer: "D" };
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item));
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, "triangle_subtype_letter");
});
