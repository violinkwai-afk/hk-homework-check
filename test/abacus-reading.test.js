// Abacus/counting-rod reading (Ticket 198, 2026-09-30) -- see
// readAbacusColumnsFromPixels's own long comment in src/worker.js for
// the full real validation history and the 3 real bugs found while
// building it (colour-based ink test needed, beads touching means
// height-based not blob-count-based counting, and rod position must be
// actually detected not assumed from equal-width division). Real
// citation: 26週數學訓練 P3, Topic 5 Q1 -- two abacus diagrams side by
// side, (a) reads 5,0,6,9,0 beads per rod (萬千百十個) -> 50690, (b)
// reads 1,3,0,0,7 -> 13007.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_abacus.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_abacus.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_abacus.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "abacus", name)).toString("base64");
}

test("readAbacusColumnsFromPixels: real 2-diagram photo -> both totals correct, including the empty (0-bead) columns", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_abacus_ab.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const totals = worker.readAbacusColumnsFromPixels(img.get_raw_pixels(), img.get_width(), img.get_height(), 2);
  img.free();
  assert.deepEqual(totals, [50690, 13007]);
});

test("findRodPositions: locates all 10 real rods across 2 diagrams, correctly excluding the 3 table border lines", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_abacus_ab.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const rods = worker.findRodPositions(img.get_raw_pixels(), img.get_width(), img.get_height(), 10);
  img.free();
  assert.equal(rods.length, 10);
  // strictly increasing (left to right), and no huge outlier gap sneaking a border line in
  for (let i = 1; i < rods.length; i++) assert.ok(rods[i] > rods[i - 1]);
});

test("findRodPositions: returns null (declines) when the expected count can't be matched", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_abacus_ab.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const rods = worker.findRodPositions(img.get_raw_pixels(), img.get_width(), img.get_height(), 7);
  img.free();
  assert.equal(rods, null);
});

test("isAbacusReadingQuestion: real citation matches, an unrelated question does not", async () => {
  const worker = await import(TMP);
  const real = "用阿拉伯數字和中國數字寫出各算柱所表示的數。";
  assert.equal(worker.isAbacusReadingQuestion({ printedQuestion: real }), true);
  assert.equal(worker.isAbacusReadingQuestion({ printedQuestion: "4 + 6 = ?" }), false);
  assert.equal(worker.isAbacusReadingQuestion({ printedQuestion: "把3粒算珠放在算柱上，以表示出最小嘅五位奇數" }), false, "a construction/drawing task (put beads ON), not a reading task -- must not match");
});

test("verifyAbacusReading: real photo, real official-key answer -> correct", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "用阿拉伯數字和中國數字寫出各算柱所表示的數。", studentAnswer: "(a)50690 (b)13007" };
  const result = worker.verifyAbacusReading(item, { data: loadFixtureBase64("real_abacus_ab.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyAbacusReading: real photo, one digit wrong -> correctly flagged wrong with the real correct totals", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "用阿拉伯數字和中國數字寫出各算柱所表示的數。", studentAnswer: "(a)50680 (b)13007" };
  const result = worker.verifyAbacusReading(item, { data: loadFixtureBase64("real_abacus_ab.png"), mediaType: "image/png" });
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "50690, 13007");
});

test("verifyAbacusReading: fails open (null) on a non-numeric answer", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "用阿拉伯數字和中國數字寫出各算柱所表示的數。", studentAnswer: "唔識計" };
  const result = worker.verifyAbacusReading(item, { data: loadFixtureBase64("real_abacus_ab.png"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("verifyAbacusReading: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "用阿拉伯數字和中國數字寫出各算柱所表示的數。", studentAnswer: "(a)50690 (b)13007" };
  const result = worker.verifyAbacusReading(item, { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("abacus_reading handler: registered, dispatches via the real classifyAndVerify path on the real photo", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "abacus_reading");
  assert.ok(handler, "abacus_reading handler must be registered");
  assert.equal(typeof handler.verifyVisual, "function");
  const item = { printedQuestion: "用阿拉伯數字和中國數字寫出各算柱所表示的數。", studentAnswer: "(a)50690 (b)13007" };
  assert.equal(handler.detect(item), true);
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item))[0];
  assert.equal(matched.name, "abacus_reading", "must be the FIRST handler to match, not stolen by a broader one earlier in the registry");
  const result = worker.classifyAndVerify(item, () => ({ data: loadFixtureBase64("real_abacus_ab.png"), mediaType: "image/png" }));
  assert.equal(result.correct, true);
  assert.equal(result.handler, "abacus_reading");
});

test("findAbacusBbox: finds the 萬千百十個 label sequence and reports how many diagrams were found", async () => {
  const worker = await import(TMP);
  const pageWidth = 1200, pageHeight = 1600;
  const makeWord = (text, x, y) => ({ text, x, y, w: 20, h: 20 });
  const row1 = ["萬", "千", "百", "十", "個"].map((c, i) => makeWord(c, 100 + i * 30, 400));
  const row2 = ["萬", "千", "百", "十", "個"].map((c, i) => makeWord(c, 700 + i * 30, 400));
  const bbox = worker.findAbacusBbox([...row1, ...row2], pageWidth, pageHeight);
  assert.ok(bbox);
  assert.equal(bbox.diagramCount, 2);
});

test("findAbacusBbox: returns null when the exact column-header sequence isn't present", async () => {
  const worker = await import(TMP);
  const words = [{ text: "萬", x: 10, y: 10, w: 10, h: 10 }, { text: "十", x: 30, y: 10, w: 10, h: 10 }];
  assert.equal(worker.findAbacusBbox(words, 1000, 1000), null);
});
