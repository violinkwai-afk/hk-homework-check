// Ticket 200 (fraction-shading reading) -- see
// readFractionShadingFromPixels's own long comment in src/worker.js for
// the real citation and the disclosed equal-area-only scope limit.
//
// Real citation: 26週數學訓練 P3 Topic 10「分數」(math34pdf/p25.png
// Q1(a)): "寫出下面各圖中有色部分佔全圖的幾分之幾。" -- a circle
// divided into 3 equal sectors, 1 shaded light purple. Self-verified
// against the real page image and the real answer key (1/3) before
// building; cropped directly from the rendered PDF page.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_fracshade.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_fracshade.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_fracshade.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "fractionshading", name)).toString("base64");
}

test("readFractionShadingFromPixels: real photo -- 3 equal sectors, 1 shaded", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_circle_3parts_1shaded.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const result = worker.readFractionShadingFromPixels(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.ok(result);
  assert.equal(result.total, 3);
  assert.equal(result.shaded, 1);
});

test("isFractionShadingQuestion: detects the real citation shape", async () => {
  const worker = await import(TMP);
  assert.equal(worker.isFractionShadingQuestion({ printedQuestion: "寫出下面各圖中有色部分佔全圖的幾分之幾。" }), true);
  assert.equal(worker.isFractionShadingQuestion({ printedQuestion: "4+6=?" }), false);
});

test("verifyFractionShading: real photo -- correct fraction 1/3", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "寫出下面各圖中有色部分佔全圖的幾分之幾。", studentAnswer: "1/3" };
  const result = worker.verifyFractionShading(item, { data: loadFixtureBase64("real_circle_3parts_1shaded.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyFractionShading: wrong fraction flagged wrong with the real correct answer", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "寫出下面各圖中有色部分佔全圖的幾分之幾。", studentAnswer: "1/2" };
  const result = worker.verifyFractionShading(item, { data: loadFixtureBase64("real_circle_3parts_1shaded.png"), mediaType: "image/png" });
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "1/3");
});

test("verifyFractionShading: accepts a decimal-form answer too", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "寫出下面各圖中有色部分佔全圖的幾分之幾。", studentAnswer: String(1 / 3) };
  const result = worker.verifyFractionShading(item, { data: loadFixtureBase64("real_circle_3parts_1shaded.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyFractionShading: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "寫出下面各圖中有色部分佔全圖的幾分之幾。", studentAnswer: "1/3" };
  const result = worker.verifyFractionShading(item, { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("fraction_shading handler: registered, wins dispatch via the real classifyAndVerify path", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "fraction_shading");
  assert.ok(handler, "fraction_shading handler must be registered");
  const item = { printedQuestion: "寫出下面各圖中有色部分佔全圖的幾分之幾。", studentAnswer: "1/3" };
  assert.equal(handler.detect(item), true);
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item))[0];
  assert.equal(matched.name, "fraction_shading", "must be the FIRST handler to match, not stolen by a broader one earlier in the registry");
  const result = worker.classifyAndVerify(item, () => ({ data: loadFixtureBase64("real_circle_3parts_1shaded.png"), mediaType: "image/png" }));
  assert.equal(result.correct, true);
  assert.equal(result.handler, "fraction_shading");
});
