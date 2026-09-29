// Ticket 203 (grid-point isosceles-triangle geometry) -- see
// verifyGridPointIsosceles's own long comment in src/worker.js for the
// real citation, the new crop-origin plumbing this needed (cropItem now
// also returns originX/originY/pageWidth/pageHeight), and the real dot-
// vs-grid-line touching bug found (fixed with a morphological-erosion
// "core" test instead of a plain flood-fill).
//
// Real citation: 26週數學訓練 P3 Topic 23「三角形」(math34pdf/p59.png
// Q4): "右圖中,把哪三點連起來,可得出一個等腰三角形?" -- a dot grid with
// 5 labelled points P/Q/R/S/T. Self-verified against the real page image
// and the real answer key (Q,S,T) before building; fixture cropped
// directly from the rendered PDF page.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_gridpoint.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_gridpoint.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_gridpoint.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "gridgeometry", name)).toString("base64");
}

// Real letter pixel positions, measured directly against the fixture
// image (real_grid_pqrst.png, 500x320) -- same positions used to derive
// the erosion-based dot detector during development.
const REAL_LABELS = [
  { letter: "P", px: 156, py: 125 },
  { letter: "Q", px: 387, py: 86 },
  { letter: "R", px: 43, py: 200 },
  { letter: "S", px: 194, py: 199 },
  { letter: "T", px: 291, py: 257 },
];

test("findGridDotPositions: real photo -- finds exactly 5 dots, none merged with the grid lines they touch", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_grid_pqrst.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const dots = worker.findGridDotPositions(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.equal(dots.length, 5);
});

test("clusterSingleLetterWords: groups a tight cluster of letters, ignores a distant stray letter", async () => {
  const worker = await import(TMP);
  const words = [
    { text: "P", x: 100, y: 100, w: 10, h: 10 },
    { text: "Q", x: 300, y: 80, w: 10, h: 10 },
    { text: "R", x: 40, y: 180, w: 10, h: 10 },
    { text: "A", x: 1400, y: 1800, w: 10, h: 10 }, // unrelated stray MC-option letter far away
  ];
  const cluster = worker.clusterSingleLetterWords(words, 1600, 2300, 3);
  assert.equal(cluster.length, 3);
  assert.ok(!cluster.some((c) => c.w.text === "A"));
});

test("isGridPointIsoscelesQuestion: detects the real citation shape", async () => {
  const worker = await import(TMP);
  assert.equal(worker.isGridPointIsoscelesQuestion({ printedQuestion: "右圖中，把哪三點連起來，可得出一個等腰三角形？答案：___，___，___。" }), true);
  assert.equal(worker.isGridPointIsoscelesQuestion({ printedQuestion: "4+6=?" }), false);
});

test("verifyGridPointIsosceles: real photo -- correct answer Q,S,T", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "右圖中，把哪三點連起來，可得出一個等腰三角形？答案：___，___，___。",
    studentAnswer: "Q,S,T",
    gridPointLabels: REAL_LABELS,
  };
  const crop = { data: loadFixtureBase64("real_grid_pqrst.png"), mediaType: "image/png", originX: 0, originY: 0, pageWidth: 500, pageHeight: 320 };
  const result = worker.verifyGridPointIsosceles(item, crop);
  assert.equal(result.correct, true);
});

test("verifyGridPointIsosceles: wrong triple flagged wrong with the real correct answer", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "右圖中，把哪三點連起來，可得出一個等腰三角形？答案：___，___，___。",
    studentAnswer: "P,R,S",
    gridPointLabels: REAL_LABELS,
  };
  const crop = { data: loadFixtureBase64("real_grid_pqrst.png"), mediaType: "image/png", originX: 0, originY: 0, pageWidth: 500, pageHeight: 320 };
  const result = worker.verifyGridPointIsosceles(item, crop);
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "Q,S,T");
});

test("verifyGridPointIsosceles: same triple, different order in the student's answer -- still correct", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "右圖中，把哪三點連起來，可得出一個等腰三角形？答案：___，___，___。",
    studentAnswer: "T,Q,S",
    gridPointLabels: REAL_LABELS,
  };
  const crop = { data: loadFixtureBase64("real_grid_pqrst.png"), mediaType: "image/png", originX: 0, originY: 0, pageWidth: 500, pageHeight: 320 };
  const result = worker.verifyGridPointIsosceles(item, crop);
  assert.equal(result.correct, true);
});

test("verifyGridPointIsosceles: fails open (null) when crop origin info is missing", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "右圖中，把哪三點連起來，可得出一個等腰三角形？答案：___，___，___。",
    studentAnswer: "Q,S,T",
    gridPointLabels: REAL_LABELS,
  };
  const crop = { data: loadFixtureBase64("real_grid_pqrst.png"), mediaType: "image/png" };
  const result = worker.verifyGridPointIsosceles(item, crop);
  assert.equal(result.correct, null);
});

test("verifyGridPointIsosceles: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "右圖中，把哪三點連起來，可得出一個等腰三角形？答案：___，___，___。",
    studentAnswer: "Q,S,T",
    gridPointLabels: REAL_LABELS,
  };
  const crop = { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png", originX: 0, originY: 0, pageWidth: 500, pageHeight: 320 };
  const result = worker.verifyGridPointIsosceles(item, crop);
  assert.equal(result.correct, null);
});

test("grid_point_isosceles handler: registered, wins dispatch via the real classifyAndVerify path", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "grid_point_isosceles");
  assert.ok(handler, "grid_point_isosceles handler must be registered");
  const item = {
    printedQuestion: "右圖中，把哪三點連起來，可得出一個等腰三角形？答案：___，___，___。",
    studentAnswer: "Q,S,T",
    gridPointLabels: REAL_LABELS,
  };
  assert.equal(handler.detect(item), true);
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item))[0];
  assert.equal(matched.name, "grid_point_isosceles", "must be the FIRST handler to match, not stolen by a broader one earlier in the registry");
  const result = worker.classifyAndVerify(item, () => ({ data: loadFixtureBase64("real_grid_pqrst.png"), mediaType: "image/png", originX: 0, originY: 0, pageWidth: 500, pageHeight: 320 }));
  assert.equal(result.correct, true);
  assert.equal(result.handler, "grid_point_isosceles");
});
