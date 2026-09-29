// Ticket 201 (colour-based icon counting) -- see readColorCountedBlobs's
// own long comment in src/worker.js for the real design/validation
// history (including the real bug found: a single centre-pixel sample
// or an unfiltered-by-saturation average both land on a car's grey
// window/wheel detail, not its coloured body panel).
//
// Real citation: 26週數學訓練 P3 Topic 10「分數」(math34pdf/p25.png Q2):
// "下圖是停泊在停車場裏的汽車。" (a) 綠色車有___輛,佔全部汽車的☐。
// (b) 黃色車有___輛,佔全部汽車的☐。 -- 10 cars, self-verified against
// the real page image AND the real answer key ((a) 1;1/10 (b) 3;3/10)
// before building.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_colorcount.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_colorcount.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_colorcount.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "colorcount", name)).toString("base64");
}

test("classifyColorName: primary/secondary hues classified correctly", async () => {
  const worker = await import(TMP);
  assert.equal(worker.classifyColorName(230, 50, 60), "red");
  assert.equal(worker.classifyColorName(60, 90, 220), "blue");
  assert.equal(worker.classifyColorName(230, 210, 40), "yellow");
  assert.equal(worker.classifyColorName(60, 170, 70), "green");
  assert.equal(worker.classifyColorName(20, 20, 20), "black");
  assert.equal(worker.classifyColorName(240, 240, 240), "white");
});

test("readColorCountedBlobs: real photo -- 10 cars, exact colour breakdown matches the real answer key", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_cars_10.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const { blobs, safe } = worker.readColorCountedBlobs(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.equal(safe, true);
  assert.equal(blobs.length, 10);
  const counts = {};
  for (const b of blobs) counts[b.color] = (counts[b.color] || 0) + 1;
  assert.equal(counts.green, 1, "real answer key: green cars = 1");
  assert.equal(counts.yellow, 3, "real answer key: yellow cars = 3");
  assert.equal(counts.blue, 4);
  assert.equal(counts.red, 2);
});

test("isColorCountedQuestion: detects the real citation shape, rejects unrelated text", async () => {
  const worker = await import(TMP);
  assert.equal(worker.isColorCountedQuestion({ printedQuestion: "綠色車有___輛，佔全部汽車的☐。" }), true);
  assert.equal(worker.isColorCountedQuestion({ printedQuestion: "4+6=?" }), false);
});

test("verifyColorCountedIcons: real photo, real citation (a) -- correct count+fraction", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "綠色車有___輛，佔全部汽車的☐。",
    studentAnswer: "1,1/10",
  };
  const result = worker.verifyColorCountedIcons(item, { data: loadFixtureBase64("real_cars_10.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyColorCountedIcons: real photo, real citation (b) -- correct count+fraction", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "黃色車有___輛，佔全部汽車的☐。",
    studentAnswer: "3,3/10",
  };
  const result = worker.verifyColorCountedIcons(item, { data: loadFixtureBase64("real_cars_10.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyColorCountedIcons: wrong count flagged wrong with the real correct answer", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "黃色車有___輛，佔全部汽車的☐。",
    studentAnswer: "2,2/10",
  };
  const result = worker.verifyColorCountedIcons(item, { data: loadFixtureBase64("real_cars_10.png"), mediaType: "image/png" });
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "3,3/10");
});

test("verifyColorCountedIcons: accepts count-only answer when no fraction blank present", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "綠色車有___輛。",
    studentAnswer: "1",
  };
  const result = worker.verifyColorCountedIcons(item, { data: loadFixtureBase64("real_cars_10.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyColorCountedIcons: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "綠色車有___輛，佔全部汽車的☐。", studentAnswer: "1,1/10" };
  const result = worker.verifyColorCountedIcons(item, { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("color_counted_icons handler: registered, wins dispatch via the real classifyAndVerify path", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "color_counted_icons");
  assert.ok(handler, "color_counted_icons handler must be registered");
  const item = { printedQuestion: "綠色車有___輛，佔全部汽車的☐。", studentAnswer: "1,1/10" };
  assert.equal(handler.detect(item), true);
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item))[0];
  assert.equal(matched.name, "color_counted_icons", "must be the FIRST handler to match, not stolen by a broader one earlier in the registry");
  const result = worker.classifyAndVerify(item, () => ({ data: loadFixtureBase64("real_cars_10.png"), mediaType: "image/png" }));
  assert.equal(result.correct, true);
  assert.equal(result.handler, "color_counted_icons");
});
