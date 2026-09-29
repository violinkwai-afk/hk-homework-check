// Ticket 202 (clock second-hand reading) -- see
// readSecondHandAngleFromPixels's own long comment in src/worker.js for
// the real citation and the colour-isolation design (isolates the
// distinct orange/gold third hand by colour, not by relative length
// like readClockHandsFromPixels's existing two-black-hand tracking).
//
// Real citation: 26週數學訓練 P3 Topic 15「秒」(math34pdf/p41.png Q1):
// "寫出鐘面所顯示的時間。" (a) 10時___分,再過了___秒 (b) ___時45分,再
// 過了___秒 -- self-measured and verified exact against the real answer
// key ((a) 28,8 (b) 4,22) before building; both clock crops taken
// directly from the rendered PDF page, precisely centred via the real
// bezel-ring bounding box.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_secondhand.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_secondhand.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_secondhand.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "clocksecond", name)).toString("base64");
}

test("readSecondHandAngleFromPixels: real photo (a) -- exact match, 8 seconds", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_clock_10_28_8.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const seconds = worker.readSecondHandAngleFromPixels(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.equal(seconds, 8);
});

test("readSecondHandAngleFromPixels: real photo (b) -- exact match, 22 seconds", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_clock_4_45_22.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const seconds = worker.readSecondHandAngleFromPixels(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.equal(seconds, 22);
});

test("isSecondHandClockQuestion: detects the real citation shape", async () => {
  const worker = await import(TMP);
  assert.equal(worker.isSecondHandClockQuestion({ printedQuestion: "10時___分，再過了___秒" }), true);
  assert.equal(worker.isSecondHandClockQuestion({ printedQuestion: "4+6=?" }), false);
});

test("verifySecondHandClock: real photo (a), hour printed+minute blank -- correct minute+seconds", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "10時___分，再過了___秒", studentAnswer: "28,8" };
  const result = worker.verifySecondHandClock(item, { data: loadFixtureBase64("real_clock_10_28_8.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifySecondHandClock: real photo (a) -- wrong seconds flagged wrong with real correct answer", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "10時___分，再過了___秒", studentAnswer: "28,5" };
  const result = worker.verifySecondHandClock(item, { data: loadFixtureBase64("real_clock_10_28_8.png"), mediaType: "image/png" });
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "28,8");
});

test("verifySecondHandClock: real photo (b), minute printed+hour blank -- correct hour+seconds", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "___時45分，再過了___秒", studentAnswer: "4,22" };
  const result = worker.verifySecondHandClock(item, { data: loadFixtureBase64("real_clock_4_45_22.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifySecondHandClock: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "10時___分，再過了___秒", studentAnswer: "28,8" };
  const result = worker.verifySecondHandClock(item, { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("second_hand_clock handler: registered, wins dispatch via the real classifyAndVerify path", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "second_hand_clock");
  assert.ok(handler, "second_hand_clock handler must be registered");
  const item = { printedQuestion: "10時___分，再過了___秒", studentAnswer: "28,8" };
  assert.equal(handler.detect(item), true);
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item))[0];
  assert.equal(matched.name, "second_hand_clock", "must be the FIRST handler to match, not stolen by a broader one earlier in the registry");
  const result = worker.classifyAndVerify(item, () => ({ data: loadFixtureBase64("real_clock_10_28_8.png"), mediaType: "image/png" }));
  assert.equal(result.correct, true);
  assert.equal(result.handler, "second_hand_clock");
});
