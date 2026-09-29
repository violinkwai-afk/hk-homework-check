// Bar chart reading (Ticket 199, 2026-09-30) -- see readBarChartValues's
// and extractBarChart's own long comments in src/worker.js for the
// full real design/validation history. This is a genuine HYBRID ticket
// (unlike every other pixel-geometry ticket tonight, 197/198): OCR
// reads only the printed axis calibration (min/max/step/categories);
// code measures each bar's real pixel position and converts it to a
// value via the axis line's own real pixel calibration.
//
// Real citation: 26週數學訓練 P3, "浩明上半年看書的數量" -- Y-axis
// 0-12 step 2, months 1-6 read 10,4,6,12,8,2 books.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_barchart.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_barchart.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_barchart.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "barchart", name)).toString("base64");
}

const REAL_BAR_CHART = { direction: "vertical", min: 0, max: 12, step: 2, categories: ["1月", "2月", "3月", "4月", "5月", "6月"] };

test("extractBarChart: parses the real OCR marker format", async () => {
  const worker = await import(TMP);
  const { barChart, cleanedText } = worker.extractBarChart("BAR_CHART: 方向=垂直;刻度最小值=0;刻度最大值=12;刻度間距=2;類別=1月,2月,3月,4月,5月,6月\n1=浩明在___月看書最多|4月");
  assert.deepEqual(barChart, REAL_BAR_CHART);
  assert.ok(!cleanedText.includes("BAR_CHART"));
});

test("extractBarChart: returns null (no marker) when absent, leaves text untouched", async () => {
  const worker = await import(TMP);
  const { barChart, cleanedText } = worker.extractBarChart("1=4+6|10");
  assert.equal(barChart, null);
  assert.equal(cleanedText, "1=4+6|10");
});

test("findAxisLine: real photo -- finds the chart's own y-axis line, top aligned with the max tick, bottom with the min tick", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_bar_chart_books.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const axis = worker.findAxisLine(img.get_raw_pixels(), img.get_width(), img.get_height());
  img.free();
  assert.ok(axis);
  assert.ok(axis.yTop < axis.yBottom);
});

test("readBarChartValues: real photo -- all 6 real bar values read exactly, including the two extremes (max=12, min=2)", async () => {
  const worker = await import(TMP);
  const { PhotonImage } = await import("@cf-wasm/photon/node");
  const bytes = Buffer.from(loadFixtureBase64("real_bar_chart_books.png"), "base64");
  const img = PhotonImage.new_from_byteslice(bytes);
  const values = worker.readBarChartValues(img.get_raw_pixels(), img.get_width(), img.get_height(), REAL_BAR_CHART);
  img.free();
  assert.deepEqual(values, [10, 4, 6, 12, 8, 2]);
});

test("isBarChartQuestion: true only when item.barChart is present", async () => {
  const worker = await import(TMP);
  assert.equal(worker.isBarChartQuestion({ barChart: REAL_BAR_CHART }), true);
  assert.equal(worker.isBarChartQuestion({ printedQuestion: "4+6=?" }), false);
});

test("verifyBarChart: real photo, Shape 1 (max category + value) -- real official answer -> correct", async () => {
  const worker = await import(TMP);
  const item = {
    barChart: REAL_BAR_CHART,
    printedQuestion: "浩明在___月看書最多，有___本。",
    studentAnswer: "4月,12",
  };
  const result = worker.verifyBarChart(item, { data: loadFixtureBase64("real_bar_chart_books.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyBarChart: real photo, Shape 1 -- wrong value flagged wrong with the real correct answer", async () => {
  const worker = await import(TMP);
  const item = {
    barChart: REAL_BAR_CHART,
    printedQuestion: "浩明在___月看書最多，有___本。",
    studentAnswer: "4月,10",
  };
  const result = worker.verifyBarChart(item, { data: loadFixtureBase64("real_bar_chart_books.png"), mediaType: "image/png" });
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "4月,12");
});

test("verifyBarChart: real photo, Shape 2 (difference from previous category) -- real citation '在6月...比上一個月少了___本' -> correct (8-2=6)", async () => {
  const worker = await import(TMP);
  const item = {
    barChart: REAL_BAR_CHART,
    printedQuestion: "在6月，浩明看書的數量比上一個月少了___本。",
    studentAnswer: "6",
  };
  const result = worker.verifyBarChart(item, { data: loadFixtureBase64("real_bar_chart_books.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyBarChart: real photo, Shape 3 (total + average) -- real citation -> correct (42 total, 7 average)", async () => {
  const worker = await import(TMP);
  const item = {
    barChart: REAL_BAR_CHART,
    printedQuestion: "浩明在上半年共看書___本，平均每月看___本。",
    studentAnswer: "42,7",
  };
  const result = worker.verifyBarChart(item, { data: loadFixtureBase64("real_bar_chart_books.png"), mediaType: "image/png" });
  assert.equal(result.correct, true);
});

test("verifyBarChart: fails open (null) on a question shape not yet handled (needs outside knowledge, e.g. days-in-month)", async () => {
  const worker = await import(TMP);
  const item = {
    barChart: REAL_BAR_CHART,
    printedQuestion: "今年是平年，浩明在2月平均用___天看完一本書。",
    studentAnswer: "7",
  };
  const result = worker.verifyBarChart(item, { data: loadFixtureBase64("real_bar_chart_books.png"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("verifyBarChart: fails open (null) on corrupt image bytes, never throws", async () => {
  const worker = await import(TMP);
  const item = {
    barChart: REAL_BAR_CHART,
    printedQuestion: "浩明在___月看書最多，有___本。",
    studentAnswer: "4月,12",
  };
  const result = worker.verifyBarChart(item, { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" });
  assert.equal(result.correct, null);
});

test("bar_chart_reading handler: registered, dispatches via the real classifyAndVerify path on the real photo", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "bar_chart_reading");
  assert.ok(handler, "bar_chart_reading handler must be registered");
  assert.equal(typeof handler.verifyVisual, "function");
  const item = {
    barChart: REAL_BAR_CHART,
    printedQuestion: "浩明在___月看書最多，有___本。",
    studentAnswer: "4月,12",
  };
  assert.equal(handler.detect(item), true);
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item))[0];
  assert.equal(matched.name, "bar_chart_reading", "must be the FIRST handler to match, not stolen by a broader one earlier in the registry");
  const result = worker.classifyAndVerify(item, () => ({ data: loadFixtureBase64("real_bar_chart_books.png"), mediaType: "image/png" }));
  assert.equal(result.correct, true);
  assert.equal(result.handler, "bar_chart_reading");
});

test("findBarChartBbox: finds the real axis-number sequence clustered vertically, ignores an unrelated stray number elsewhere", async () => {
  const worker = await import(TMP);
  const pageWidth = 1000, pageHeight = 1000;
  const axisWords = ["12", "10", "8", "6", "4", "2", "0"].map((text, i) => ({ text, x: 300, y: 100 + i * 50, w: 20, h: 20 }));
  const stray = { text: "8", x: 800, y: 900, w: 20, h: 20 }; // e.g. an unrelated page-number digit elsewhere
  const bbox = worker.findBarChartBbox([...axisWords, stray], pageWidth, pageHeight, REAL_BAR_CHART);
  assert.ok(bbox);
  assert.ok(bbox.x < 50, "bbox should anchor on the clustered axis labels, not be dragged toward the stray digit");
});

test("findBarChartBbox: returns null when the axis number sequence isn't present", async () => {
  const worker = await import(TMP);
  const words = [{ text: "12", x: 10, y: 10, w: 10, h: 10 }];
  assert.equal(worker.findBarChartBbox(words, 1000, 1000, REAL_BAR_CHART), null);
});
