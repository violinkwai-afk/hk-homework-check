// Ticket 206 (balance-scale icon counting) -- see readBalanceScalePiles's
// own long comment in src/worker.js for the real design (re-scoped from
// "which side sinks" to pure per-pile icon counting after checking the
// real image -- both scales are drawn level) and the real touching-icon
// bug found (coin outlines touch in a pyramid stack; fixed by flood-
// filling only the coin's inner orange "flame" mark, plus spatial
// clustering to discard a stray same-hue icon printed in the question
// text and the toy animals' own larger orange fur blobs).
//
// Real citation: 26週數學訓練 P3 Topic 16「克和公斤」(math34pdf/p43.png
// Q1): 文聰把豹玩偶和猴玩偶放在天平上稱量 -- self-verified against the
// real page image AND the real answer key ((a) 8 (b) 輕;2) before
// building; cropped directly from the rendered PDF page.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_balance.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_balance.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_balance.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "balancescale", name)).toString("base64");
}

test("readBalanceScalePiles: real photo -- leopard pile=8, monkey pile=10, matches the real answer key", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_balance_leopard_monkey.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const piles = worker.readBalanceScalePiles(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.ok(piles);
  assert.equal(piles.leftCount, 8, "real answer key: leopard = 8");
  assert.equal(piles.rightCount, 10, "10-8=2 matches real answer key's 輕;2");
});

test("isBalanceScalePileQuestion: detects the real citation shape", async () => {
  const worker = await import(TMP);
  assert.equal(worker.isBalanceScalePileQuestion({ printedQuestion: "文聰把豹玩偶和猴玩偶放在天平上稱量。" }), true);
  assert.equal(worker.isBalanceScalePileQuestion({ printedQuestion: "4+6=?" }), false);
});

test("verifyBalanceScalePiles: real photo, shape (a) -- correct pile count", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "豹玩偶重___粒◉。",
    studentAnswer: "8",
  };
  const result = worker.verifyBalanceScalePiles(item, { data: loadFixtureBase64("real_balance_leopard_monkey.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyBalanceScalePiles: real photo, shape (a) -- wrong count flagged wrong with real correct answer", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "豹玩偶重___粒◉。", studentAnswer: "7" };
  const result = worker.verifyBalanceScalePiles(item, { data: loadFixtureBase64("real_balance_leopard_monkey.png"), mediaType: "image/png" });
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "8");
});

test("verifyBalanceScalePiles: real photo, shape (b) -- correct direction+difference", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "豹玩偶比猴玩偶*輕/重，重量相差___粒◉。(*圈出答案)",
    studentAnswer: "輕,2",
  };
  const result = worker.verifyBalanceScalePiles(item, { data: loadFixtureBase64("real_balance_leopard_monkey.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyBalanceScalePiles: real photo, shape (b) -- wrong direction flagged wrong", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "豹玩偶比猴玩偶*輕/重，重量相差___粒◉。(*圈出答案)",
    studentAnswer: "重,2",
  };
  const result = worker.verifyBalanceScalePiles(item, { data: loadFixtureBase64("real_balance_leopard_monkey.png"), mediaType: "image/png" });
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "輕,2");
});

test("verifyBalanceScalePiles: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "豹玩偶重___粒◉。", studentAnswer: "8" };
  const result = worker.verifyBalanceScalePiles(item, { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("balance_scale_piles handler: registered, wins dispatch via the real classifyAndVerify path", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "balance_scale_piles");
  assert.ok(handler, "balance_scale_piles handler must be registered");
  const item = { printedQuestion: "文聰把豹玩偶和猴玩偶放在天平上稱量。豹玩偶重___粒◉。", studentAnswer: "8" };
  assert.equal(handler.detect(item), true);
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item))[0];
  assert.equal(matched.name, "balance_scale_piles", "must be the FIRST handler to match, not stolen by a broader one earlier in the registry");
  const result = worker.classifyAndVerify(item, () => ({ data: loadFixtureBase64("real_balance_leopard_monkey.png"), mediaType: "image/png" }));
  assert.equal(result.correct, true);
  assert.equal(result.handler, "balance_scale_piles");
});
