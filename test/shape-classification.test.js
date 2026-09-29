// Geometric shape classification (2026-09-30) -- reads what shape each
// blob in a diagram IS (square/rectangle/triangle/pentagon/hexagon/
// circle/ellipse), not just how many there are. $0, no AI call. See
// readShapeClassificationFromPixels's own long comment in src/worker.js
// for the full real validation history (Python/OpenCV prototype 6/6,
// first JS-port attempt 5/6 due to a real off-by-one bug, fixed here to
// 6/6 matching Python) and its disclosed touching-shapes limitation.
// The fixture is the REAL photo (a P.68 2D-shape-classification grid)
// that hk-homework-check's production AI-fallback (Gemini 3.1
// Flash-Lite, Ticket 196) got wrong in real testing -- this handler is
// specifically meant to beat that real failure, so the test asserts
// against the REAL official answer key, not a synthetic one.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_shapes.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_shapes.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_shapes.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "shapes", name)).toString("base64");
}

// Real official answer key for this exact photo (P.68, "觀察下面的平面
// 圖形(A-L)，寫出所有代表答案的英文字母"): squares A & I, rectangle F,
// hexagons E & J, circle H. Gemini's real answer (Ticket 196 test)
// missed I (read it as a rhombus) and got the hexagons wrong (E only,
// missing J; adding an ellipse C as if it were the circle).

test("readShapeClassificationFromPixels: real 12-shape grid photo -> all 6 officially-graded shapes correctly classified", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_shape_classification_grid.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const shapes = worker.readShapeClassificationFromPixels(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.equal(shapes.length, 12, "must find all 12 shapes in the grid, none merged/split");
  const byLetter = {};
  "ABCDEFGHIJKL".split("").forEach((L, i) => { byLetter[L] = shapes[i].shape; });
  assert.equal(byLetter.A, "square");
  assert.equal(byLetter.I, "square", "the rotated square Gemini itself misread as a rhombus");
  assert.equal(byLetter.F, "rectangle");
  assert.equal(byLetter.E, "hexagon");
  assert.equal(byLetter.J, "hexagon", "a concave zigzag hexagon -- the harder of the two hexagons");
  assert.equal(byLetter.H, "circle");
});

test("isShapeClassificationGridQuestion: real citation matches, an unrelated question does not", async () => {
  const worker = await import(TMP);
  const real = "觀察下面的平面圖形(A-L)，寫出所有代表答案的英文字母。(a)正方形 (b)長方形 (c)六邊形 (d)圓形";
  assert.equal(worker.isShapeClassificationGridQuestion({ printedQuestion: real }), true);
  assert.equal(worker.isShapeClassificationGridQuestion({ printedQuestion: "4 + 6 = ?" }), false);
  assert.equal(worker.isShapeClassificationGridQuestion({ printedQuestion: "觀察圖形，邊個係正方形？" }), false, "only one shape name mentioned -- too weak a signal alone");
});

test("isShapeClassificationGridQuestion: declines a question mixing in an unsupported shape name (菱形), rather than silently checking only half the answer", async () => {
  const worker = await import(TMP);
  const printed = "觀察下面的平面圖形，寫出所有代表答案的英文字母。(a)正方形 (b)菱形";
  assert.equal(worker.isShapeClassificationGridQuestion({ printedQuestion: printed }), false);
});

test("parseLabelledParts: handles the labelled (a)/(b)/... form", async () => {
  const worker = await import(TMP);
  const parts = worker.parseLabelledParts("(a)正方形 (b)長方形 (c)六邊形 (d)圓形");
  assert.deepEqual(parts.map((p) => p.label), ["a", "b", "c", "d"]);
  assert.equal(parts[0].value, "正方形");
  assert.equal(parts[2].value, "六邊形");
});

test("parseLabelledParts: falls back to ';'-joined bare form, assigning labels a/b/c/... in order", async () => {
  const worker = await import(TMP);
  const parts = worker.parseLabelledParts("A,I;F;E,J;H");
  assert.deepEqual(parts.map((p) => p.label), ["a", "b", "c", "d"]);
  assert.equal(parts[0].value, "A,I");
  assert.equal(parts[3].value, "H");
});

test("verifyShapeClassificationGrid: real photo, real official-key answer -> correct", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "觀察下面的平面圖形(A-L)，寫出所有代表答案的英文字母。(a)正方形 (b)長方形 (c)六邊形 (d)圓形",
    studentAnswer: "(a)A,I (b)F (c)E,J (d)H",
  };
  const result = worker.verifyShapeClassificationGrid(item, { data: loadFixtureBase64("real_shape_classification_grid.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyShapeClassificationGrid: real photo, Gemini's actual real wrong answer (Ticket 196 test) -> correctly flagged wrong, with the real correct answer", async () => {
  const worker = await import(TMP);
  // Gemini's real reported answer from the same real test this handler was built to fix.
  const item = {
    printedQuestion: "觀察下面的平面圖形(A-L)，寫出所有代表答案的英文字母。(a)正方形 (b)長方形 (c)六邊形 (d)圓形",
    studentAnswer: "(a)A (b)F (c)E,J (d)H,C",
  };
  const result = worker.verifyShapeClassificationGrid(item, { data: loadFixtureBase64("real_shape_classification_grid.png"), mediaType: "image/png" });
  assert.equal(result.correct, false);
  assert.match(result.correctAnswer, /\(a\)A,I/);
});

test("verifyShapeClassificationGrid: declines (null) rather than guess when a referenced letter is beyond what was actually detected", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "觀察下面的平面圖形(A-L)，寫出所有代表答案的英文字母。(a)正方形 (b)長方形 (c)六邊形 (d)圓形",
    studentAnswer: "(a)Z (b)F (c)E,J (d)H",
  };
  const result = worker.verifyShapeClassificationGrid(item, { data: loadFixtureBase64("real_shape_classification_grid.png"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("verifyShapeClassificationGrid: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "觀察下面的平面圖形(A-L)，寫出所有代表答案的英文字母。(a)正方形 (b)長方形 (c)六邊形 (d)圓形",
    studentAnswer: "(a)A,I (b)F (c)E,J (d)H",
  };
  const result = worker.verifyShapeClassificationGrid(item, { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("shape_classification_grid handler: registered, dispatches via the real classifyAndVerify path on the real photo", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "shape_classification_grid");
  assert.ok(handler, "shape_classification_grid handler must be registered");
  assert.equal(typeof handler.verifyVisual, "function");
  const item = {
    printedQuestion: "觀察下面的平面圖形(A-L)，寫出所有代表答案的英文字母。(a)正方形 (b)長方形 (c)六邊形 (d)圓形",
    studentAnswer: "(a)A,I (b)F (c)E,J (d)H",
  };
  assert.equal(handler.detect(item), true);
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item))[0];
  assert.equal(matched.name, "shape_classification_grid", "must be the FIRST handler to match, not stolen by a broader one earlier in the registry");
  const result = worker.classifyAndVerify(item, () => ({ data: loadFixtureBase64("real_shape_classification_grid.png"), mediaType: "image/png" }));
  assert.equal(result.correct, true);
  assert.equal(result.handler, "shape_classification_grid");
});

test("findLetterGridBbox: finds the tight cluster of single-letter Vision words, ignores a stray unrelated single letter far away", async () => {
  const worker = await import(TMP);
  const pageWidth = 1000, pageHeight = 1000;
  const clustered = [];
  const letters = "ABCDEFGHIJKL";
  for (let i = 0; i < letters.length; i++) {
    clustered.push({ text: letters[i], x: 100 + (i % 6) * 100, y: 100 + Math.floor(i / 6) * 100, w: 20, h: 20 });
  }
  const stray = { text: "A", x: 900, y: 900, w: 20, h: 20 }; // e.g. an unrelated MC option label elsewhere on the page
  const bbox = worker.findLetterGridBbox([...clustered, stray], pageWidth, pageHeight);
  assert.ok(bbox);
  assert.equal(bbox.letterCount, 12);
  assert.ok(bbox.x < 20 && bbox.y < 20, "bbox should cover the clustered letters, not be dragged toward the stray one");
});

test("findLetterGridBbox: returns null when there aren't enough single-letter words to trust a cluster", async () => {
  const worker = await import(TMP);
  const words = [{ text: "A", x: 10, y: 10, w: 10, h: 10 }, { text: "B", x: 20, y: 10, w: 10, h: 10 }];
  assert.equal(worker.findLetterGridBbox(words, 1000, 1000), null);
});
