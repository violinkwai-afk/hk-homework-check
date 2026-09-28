// Object counting via Photon connected-component blobs (2026-09-28,
// prompted directly by the user's own question: "for questions that
// count clear separate objects, can Photon distinguish them by
// pixels?"). Validated against 3 REAL images from a real P1 test before
// shipping -- see readObjectCountFromPixels's own comment in
// src/worker.js for the full story. Follows the same harness pattern as
// test/clock-reading.test.js and test/line-shaft-comparison.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_counting.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_counting.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_counting.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "counting", name)).toString("base64");
}

test("readObjectCountFromPixels: 13 sheep, no frame -> counts correctly and flags safe", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_sheep_13.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const result = worker.readObjectCountFromPixels(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.equal(result.safe, true);
  assert.equal(result.count, 13);
});

test("readObjectCountFromPixels: 9 apples, no frame -> counts correctly and flags safe", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_apples_9.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const result = worker.readObjectCountFromPixels(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.equal(result.safe, true);
  assert.equal(result.count, 9);
});

test("readObjectCountFromPixels: 12 fish INSIDE a frame (one touches the border) -> correctly flags unsafe, does not report a wrong count as if trustworthy", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_fish_12_framed.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const result = worker.readObjectCountFromPixels(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.equal(result.safe, false, "the frame+touching-fish fused blob must be caught by the size-outlier safety check");
});

test("verifyObjectCounting: real sheep image, correct answer -> correct", async () => {
  const worker = await import(TMP);
  const result = worker.verifyObjectCounting(
    { studentAnswer: "13" },
    { data: loadFixtureBase64("real_sheep_13.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, true);
});

test("verifyObjectCounting: real sheep image, wrong answer -> flags it with the real count", async () => {
  const worker = await import(TMP);
  const result = worker.verifyObjectCounting(
    { studentAnswer: "12" },
    { data: loadFixtureBase64("real_sheep_13.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "13");
});

test("verifyObjectCounting: real apple image works independently of the sheep image", async () => {
  const worker = await import(TMP);
  const result = worker.verifyObjectCounting(
    { studentAnswer: "9" },
    { data: loadFixtureBase64("real_apples_9.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, true);
});

test("verifyObjectCounting: real framed fish image declines (null) even when the student's answer happens to be numeric, never guesses", async () => {
  const worker = await import(TMP);
  const result = worker.verifyObjectCounting(
    { studentAnswer: "12" },
    { data: loadFixtureBase64("real_fish_12_framed.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, null, "an unsafe (framed/fused-blob) image must decline, even if the student's answer happens to be right");
});

test("verifyObjectCounting: fails open (null) on a non-numeric answer", async () => {
  const worker = await import(TMP);
  const result = worker.verifyObjectCounting(
    { studentAnswer: "many" },
    { data: loadFixtureBase64("real_sheep_13.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, null);
});

test("verifyObjectCounting: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const result = worker.verifyObjectCounting(
    { studentAnswer: "13" },
    { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" },
  );
  assert.equal(result.correct, null);
});

test("object_counting handler: registered, detect() requires the counting instruction phrase AND a bare-number answer", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "object_counting");
  assert.ok(handler, "object_counting handler must be registered");
  assert.equal(handler.detect({ printedQuestion: "數一數。", studentAnswer: "13" }), true);
  assert.equal(handler.detect({ printedQuestion: "How many apples are there?", studentAnswer: "9" }), true);
  assert.equal(handler.detect({ printedQuestion: "數一數。", studentAnswer: "十三" }), false, "non-bare-digit answers must not match");
  assert.equal(handler.detect({ printedQuestion: "9 + 4 = ?", studentAnswer: "13" }), false);
  assert.equal(typeof handler.verifyVisual, "function");
});
