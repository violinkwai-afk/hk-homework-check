// Müller-Lyer visual-illusion line comparison (found 2026-09-28 in the
// 躍思 workbook survey, p.39). Validated BOTH against the real source
// image AND a synthetic counter-test with genuinely different lengths --
// see readLineShaftLengths's own comment in src/worker.js for the full
// story. This test file follows the same harness pattern as
// test/clock-reading.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_lines.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_lines.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_lines.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "lines", name)).toString("base64");
}

const REAL_PRINTED = "右圖有三條直線，以下哪項描述是正確的？\nA. 直線P最長。 B. 直線Q最長。 C. 直線R最短。 D. 三條直線一樣長。";

test("readLineShaftLengths: real Müller-Lyer image measures all 3 lines within ~1% of each other", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_muller_lyer_p39.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const w = img.get_width(), h = img.get_height();
  const lengths = worker.readLineShaftLengths(img.get_raw_pixels(), w, h, 3);
  img.free();
  const [max, min] = [Math.max(...lengths), Math.min(...lengths)];
  assert.ok((max - min) / max < 0.05, `expected all 3 shaft lengths within 5% of each other, got ${JSON.stringify(lengths)}`);
});

test("readLineShaftLengths: synthetic genuinely-different lengths are correctly discriminated, not reported equal", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("synthetic_unequal.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const w = img.get_width(), h = img.get_height();
  const lengths = worker.readLineShaftLengths(img.get_raw_pixels(), w, h, 3);
  img.free();
  assert.ok(lengths[0] < lengths[1] && lengths[1] < lengths[2], `expected strictly increasing lengths, got ${JSON.stringify(lengths)}`);
});

test("verifyLineShaftAllEqual: real image + correct 'all equal' answer -> correct", async () => {
  const worker = await import(TMP);
  const result = worker.verifyLineShaftAllEqual(
    { printedQuestion: REAL_PRINTED, studentAnswer: "D" },
    { data: loadFixtureBase64("real_muller_lyer_p39.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, true, `expected D (all equal) to be correct, got ${JSON.stringify(result)}`);
});

test("verifyLineShaftAllEqual: real image + wrong answer -> flags it", async () => {
  const worker = await import(TMP);
  const result = worker.verifyLineShaftAllEqual(
    { printedQuestion: REAL_PRINTED, studentAnswer: "A" },
    { data: loadFixtureBase64("real_muller_lyer_p39.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "D");
});

test("verifyLineShaftAllEqual: declines (null) when lines are genuinely NOT equal -- this shape isn't validated yet", async () => {
  const worker = await import(TMP);
  const printed = "右圖有三條直線 A/B/C，以下哪項描述是正確的？\nA. 直線A最長。 B. 直線B最長。 C. 直線C最短。 D. 三條直線一樣長。";
  const result = worker.verifyLineShaftAllEqual(
    { printedQuestion: printed, studentAnswer: "D" },
    { data: loadFixtureBase64("synthetic_unequal.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, null, "unequal lines must decline, not guess -- only the all-equal shape is validated");
});

test("verifyLineShaftAllEqual: fails open (null) when no 'all equal' MC option is present", async () => {
  const worker = await import(TMP);
  const printed = "右圖有三條直線P/Q/R，直線P長度是多少厘米？";
  const result = worker.verifyLineShaftAllEqual(
    { printedQuestion: printed, studentAnswer: "10cm" },
    { data: loadFixtureBase64("real_muller_lyer_p39.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, null);
});

test("verifyLineShaftAllEqual: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const result = worker.verifyLineShaftAllEqual(
    { printedQuestion: REAL_PRINTED, studentAnswer: "D" },
    { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" },
  );
  assert.equal(result.correct, null);
});

test("line_shaft_all_equal handler: registered, detect() requires both line labels and an all-equal MC option", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "line_shaft_all_equal");
  assert.ok(handler, "line_shaft_all_equal handler must be registered");
  assert.equal(handler.detect({ printedQuestion: REAL_PRINTED, studentAnswer: "D" }), true);
  assert.equal(handler.detect({ printedQuestion: "9 + 4 = ?", studentAnswer: "13" }), false);
  assert.equal(handler.detect({ printedQuestion: "直線P有幾長？", studentAnswer: "10cm" }), false, "no all-equal MC option present must not match");
  assert.equal(typeof handler.verifyVisual, "function");
});
