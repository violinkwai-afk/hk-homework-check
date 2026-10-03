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

// 2026-10-02: 菱形 (rhombus) used to be unsupported and this test asserted
// the question gets declined entirely rather than half-checked. The
// classifier now supports rhombus/trapezoid/parallelogram too (see
// classifyParallelQuadType), so this exact question is expected to be
// ACCEPTED now -- the underlying "decline rather than half-check"
// discipline itself is preserved (still tested via a genuinely
// unsupported name below), just no longer demonstrated with 菱形.
test("isShapeClassificationGridQuestion: 菱形 (rhombus) is now a supported shape name, no longer declined", async () => {
  const worker = await import(TMP);
  const printed = "觀察下面的平面圖形，寫出所有代表答案的英文字母。(a)正方形 (b)菱形";
  assert.equal(worker.isShapeClassificationGridQuestion({ printedQuestion: printed }), true);
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

// Octagon support added 2026-10-02 (TSA full-years diagram survey found
// 八邊形(octagon) was the one missing shape that needed no new geometry
// at all -- just another v===8 branch, the exact same pattern already
// proven for pentagon(v===5)/hexagon(v===6). No real octagon photo in
// this repo's fixtures, so this draws a regular octagon directly into a
// raw RGBA pixel buffer (black ink on white) -- the same pixel format
// readShapeClassificationFromPixels takes, so this exercises the real
// marching-squares + vertex-count pipeline end to end, just not a real
// photo's noise/anti-aliasing.
function drawFilledPolygon(w, h, points) {
  const pixels = new Uint8Array(w * h * 4).fill(255); // white RGBA
  const inside = (px, py) => {
    let c = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x, yi = points[i].y, xj = points[j].x, yj = points[j].y;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inside(x + 0.5, y + 0.5)) {
        const idx = (y * w + x) * 4;
        pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 255;
      }
    }
  }
  return pixels;
}
function regularPolygonPoints(cx, cy, radiusX, radiusY, sides, rotation = 0) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (2 * Math.PI * i) / sides;
    pts.push({ x: cx + radiusX * Math.cos(a), y: cy + radiusY * Math.sin(a) });
  }
  return pts;
}

// IMPORTANT caveat found while writing this test: a PERFECTLY REGULAR
// octagon (equal radiusX/radiusY) measures extentCircle≈0.90 -- high
// enough to trip the existing isRound() check (>0.75) and get
// misclassified as "circle" before vertex-count is even consulted. A
// regular hexagon is ALSO theoretically >0.75 (≈0.83) by the same pure
// geometry, yet the real-photo hexagon test above passes -- real printed
// hexagons/octagons in actual textbook diagrams are evidently never
// drawn perfectly regular enough to trip this in practice, but a
// deliberately idealized regular octagon can. This test therefore uses a
// mildly elongated octagon (closer to how a hand-drawn/printed textbook
// octagon actually looks) rather than a geometrically perfect one --
// this is a disclosed limitation, not a fix: a sufficiently regular real
// photo's octagon could still be read as a circle, and only a real
// photo (none available in this repo) can confirm where real textbook
// octagons actually fall.
test("readShapeClassificationFromPixels: synthetic octagon (mildly elongated, not a perfect regular polygon) -> classified as octagon with 8 vertices", async () => {
  const worker = await import(TMP);
  const w = 100, h = 100;
  const octagon = regularPolygonPoints(50, 50, 40, 22, 8, Math.PI / 8);
  const pixels = drawFilledPolygon(w, h, octagon);
  const shapes = worker.readShapeClassificationFromPixels(pixels, w, h);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].vertices, 8);
  assert.equal(shapes[0].shape, "octagon");
});

test("isShapeClassificationGridQuestion: 八邊形 no longer in the unsupported-exclusion list", async () => {
  const worker = await import(TMP);
  const printed = "觀察下面的平面圖形，寫出所有代表答案的英文字母。(a)正方形 (b)八邊形";
  assert.equal(worker.isShapeClassificationGridQuestion({ printedQuestion: printed }), true);
});

// Rhombus/parallelogram/trapezoid support added 2026-10-02 (TSA
// full-years diagram survey found 菱形/梯形/平行四邊形 were the single
// highest-frequency undetected shape-letter-ID gap, 133 real occurrences,
// 27 undetected because of this exclusion). classifyParallelQuadType
// reuses the SAME parallel-pair angle detection classifyTrapezoidType
// already has its own dedicated, previously-validated tests for -- these
// tests exercise the NEW rhombus/parallelogram branch specifically, plus
// confirm a real trapezoid now gets classified as "trapezoid" through
// the full readShapeClassificationFromPixels pipeline (not just through
// classifyTrapezoidType called directly, which trapezoid-classification
// test.js already covers). No real photo available for any of these
// three -- same disclosed limitation as every other visual contract
// built this round.

test("readShapeClassificationFromPixels: synthetic rhombus (equal sides, unequal diagonals, not axis-aligned square) -> classified as rhombus", async () => {
  const worker = await import(TMP);
  const w = 120, h = 100;
  // A square-looking diamond (equal diagonals) reads as "square" via the
  // EARLIER bounding-box-aspect branch before ever reaching the new
  // quadrilateral sub-check -- this rhombus deliberately has unequal
  // diagonals (40 wide x 80 tall) so its bounding-box aspect (2.0) and
  // rect-fill (0.5) both clear the square/rectangle thresholds first.
  const rhombus = [{ x: 60, y: 10 }, { x: 80, y: 50 }, { x: 60, y: 90 }, { x: 40, y: 50 }];
  const pixels = drawFilledPolygon(w, h, rhombus);
  const shapes = worker.readShapeClassificationFromPixels(pixels, w, h);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].vertices, 4);
  assert.equal(shapes[0].shape, "rhombus");
});

// Found 2026-10-03 (pmc2017_tc.pdf P6 對稱 unit, read page-by-page per
// user request): the curriculum gives a closed, DEFINITIONAL list of
// shapes that are always axis-symmetric regardless of exact proportions
// -- 正方形/長方形/菱形/圓 among them. classifyBlob now shortcuts
// isSymmetric=true for these 4 shape names instead of trusting the
// newer, more tolerance-sensitive hasLineSymmetry() reflection check --
// this test proves the shortcut fires even for the rhombus above, whose
// unequal-diagonal construction is a real reflection (visually obvious)
// but is exactly the kind of near-threshold case the raw geometric
// computation could plausibly mis-calibrate on a real noisy photo.
test("readShapeClassificationFromPixels: rhombus/square/circle get isSymmetric=true via curriculum definition, not just the geometric reflection check", async () => {
  const worker = await import(TMP);
  const rhombusPixels = drawFilledPolygon(120, 100, [{ x: 60, y: 10 }, { x: 80, y: 50 }, { x: 60, y: 90 }, { x: 40, y: 50 }]);
  const rhombusShapes = worker.readShapeClassificationFromPixels(rhombusPixels, 120, 100);
  assert.equal(rhombusShapes[0].shape, "rhombus");
  assert.equal(rhombusShapes[0].isSymmetric, true);

  const squarePixels = drawFilledPolygon(100, 100, [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]);
  const squareShapes = worker.readShapeClassificationFromPixels(squarePixels, 100, 100);
  assert.equal(squareShapes[0].shape, "square");
  assert.equal(squareShapes[0].isSymmetric, true);

  const circle = regularPolygonPoints(50, 50, 40, 40, 32, 0);
  const circlePixels = drawFilledPolygon(100, 100, circle);
  const circleShapes = worker.readShapeClassificationFromPixels(circlePixels, 100, 100);
  assert.equal(circleShapes[0].shape, "circle");
  assert.equal(circleShapes[0].isSymmetric, true);
});

test("readShapeClassificationFromPixels: synthetic parallelogram (unequal adjacent sides, both pairs parallel) -> classified as parallelogram", async () => {
  const worker = await import(TMP);
  const w = 140, h = 100;
  const para = [{ x: 20, y: 20 }, { x: 110, y: 20 }, { x: 90, y: 80 }, { x: 0, y: 80 }];
  const pixels = drawFilledPolygon(w, h, para);
  const shapes = worker.readShapeClassificationFromPixels(pixels, w, h);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].vertices, 4);
  assert.equal(shapes[0].shape, "parallelogram");
});

test("readShapeClassificationFromPixels: synthetic trapezoid (exactly one parallel pair) -> classified as trapezoid (not left as generic quadrilateral)", async () => {
  const worker = await import(TMP);
  const w = 140, h = 100;
  const trap = [
    { x: 40, y: 20 },
    { x: 100, y: 20 },
    { x: 120, y: 80 },
    { x: 20, y: 80 },
  ];
  const pixels = drawFilledPolygon(w, h, trap);
  const shapes = worker.readShapeClassificationFromPixels(pixels, w, h);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].vertices, 4);
  assert.equal(shapes[0].shape, "trapezoid");
});

test("isShapeClassificationGridQuestion: 梯形 and 平行四邊形 are now also supported shape names", async () => {
  const worker = await import(TMP);
  const printed = "觀察下面的平面圖形，寫出所有代表答案的英文字母。(a)梯形 (b)平行四邊形";
  assert.equal(worker.isShapeClassificationGridQuestion({ printedQuestion: printed }), true);
});

// hasLineSymmetry added 2026-10-02 (TSA full-years diagram survey, real
// citation: tsa/2024/p6_paper_TSA2024_6MC1.txt Q32 "列出軸對稱圖形" over
// a lettered A-D grid, official answer "A，D"). IMPORTANT caveat found
// while writing these tests: the first tolerance tried (10% of the
// shape's own centroid-radius) produced a real false positive on a
// genuinely scalene (asymmetric) triangle -- tightened to 4%, which
// resolved it. This is disclosed explicitly because it demonstrates the
// algorithm is tolerance-SENSITIVE in a way the other synthetic-shape
// tests this round weren't -- real-photo validation matters even more
// here than for shape-NAME classification, and is still outstanding.
test("hasLineSymmetry: isosceles triangle (symmetric about vertical axis) -> true", async () => {
  const worker = await import(TMP);
  const r = worker.hasLineSymmetry([{ x: 50, y: 10 }, { x: 10, y: 90 }, { x: 90, y: 90 }]);
  assert.equal(r, true);
});

test("hasLineSymmetry: genuinely scalene triangle (no two sides equal) -> false", async () => {
  const worker = await import(TMP);
  const r = worker.hasLineSymmetry([{ x: 10, y: 10 }, { x: 90, y: 30 }, { x: 40, y: 90 }]);
  assert.equal(r, false);
});

test("hasLineSymmetry: square (symmetric, multiple axes) -> true", async () => {
  const worker = await import(TMP);
  const r = worker.hasLineSymmetry([{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]);
  assert.equal(r, true);
});

test("hasLineSymmetry: isosceles trapezoid -> true", async () => {
  const worker = await import(TMP);
  const r = worker.hasLineSymmetry([{ x: 30, y: 10 }, { x: 70, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]);
  assert.equal(r, true);
});

test("hasLineSymmetry: scalene (non-isosceles) trapezoid-like quad -> false", async () => {
  const worker = await import(TMP);
  const r = worker.hasLineSymmetry([{ x: 20, y: 10 }, { x: 70, y: 10 }, { x: 95, y: 90 }, { x: 10, y: 90 }]);
  assert.equal(r, false);
});

test("hasLineSymmetry: irregular pentagon with no symmetry -> false", async () => {
  const worker = await import(TMP);
  const r = worker.hasLineSymmetry([{ x: 10, y: 10 }, { x: 80, y: 15 }, { x: 95, y: 60 }, { x: 50, y: 95 }, { x: 15, y: 70 }]);
  assert.equal(r, false);
});

test("hasLineSymmetry: right-angle L-shape -> false", async () => {
  const worker = await import(TMP);
  const r = worker.hasLineSymmetry([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }, { x: 90, y: 50 }, { x: 90, y: 90 }, { x: 10, y: 90 }]);
  assert.equal(r, false);
});

test("isSymmetricShapesGridQuestion: real citation matches, a plain shape-naming question does not", async () => {
  const worker = await import(TMP);
  const real = "觀察下面的平面圖形，寫出所有代表答案的英文字母。 列出軸對稱圖形。 答案：____________________";
  assert.equal(worker.isSymmetricShapesGridQuestion({ printedQuestion: real }), true);
  const unrelated = "觀察下面的平面圖形，寫出所有代表答案的英文字母。(a)正方形 (b)長方形";
  assert.equal(worker.isSymmetricShapesGridQuestion({ printedQuestion: unrelated }), false);
});

// English-coverage audit (2026-10-03): English equivalent found in
// `tsa/2024/p6_paper_TSA2024_6ME1.pdf` Q32 "Study the 2-D shapes below.
// Write all the letter(s) for the answer. List the axially symmetric
// shape(s)." (the official translation of this function's own
// `tsa/2024/p6_paper_TSA2024_6MC1.txt` Q32 citation).
test("isSymmetricShapesGridQuestion: English citation matches", async () => {
  const worker = await import(TMP);
  const real = "Study the 2-D shapes below. Write all the letter(s) for the answer. List the axially symmetric shape(s). Answer: ____________________";
  assert.equal(worker.isSymmetricShapesGridQuestion({ printedQuestion: real }), true);
});
