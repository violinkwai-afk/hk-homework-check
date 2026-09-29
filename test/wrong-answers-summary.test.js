// 2026-09-30: buildWrongAnswersSummary -- see its own comment in
// src/worker.js. Real gap found: every wrong item's correctAnswer was
// already fully computed by every handler (code or AI-fallback) but was
// only ever shown to the parent in the rare CPU-guard-tripped fallback
// text path, never in the normal annotated-photo send path. This
// extracts the shared logic so both paths show it -- zero new AI cost,
// purely surfacing data that already existed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_wronganswers.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_wronganswers.mjs");

let worker;
test.before(async () => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_wronganswers.mjs"');
  fs.writeFileSync(TMP, src);
  worker = await import(TMP);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

test("buildWrongAnswersSummary: one wrong item with a correctAnswer", () => {
  const results = [{ question: "1", correct: true }, { question: "2", correct: false, correctAnswer: "8" }];
  assert.equal(worker.buildWrongAnswersSummary(results), "第2題：啱嘅答案係「8」");
});

test("buildWrongAnswersSummary: multiple wrong items, one per line", () => {
  const results = [
    { question: "1", correct: false, correctAnswer: "8" },
    { question: "3", correct: false, correctAnswer: "十二" },
  ];
  assert.equal(worker.buildWrongAnswersSummary(results), "第1題：啱嘅答案係「8」\n第3題：啱嘅答案係「十二」");
});

test("buildWrongAnswersSummary: wrong item with no correctAnswer (AI-fallback declined to give one) still shows something", () => {
  const results = [{ question: "5", correct: false, correctAnswer: "" }];
  assert.equal(worker.buildWrongAnswersSummary(results), "第5題：錯");
});

test("buildWrongAnswersSummary: no wrong items -> empty string (so callers can skip sending a pointless message)", () => {
  const results = [{ question: "1", correct: true }, { question: "2", correct: null }];
  assert.equal(worker.buildWrongAnswersSummary(results), "");
});

test("buildWrongAnswersSummary: empty/missing results array -> empty string, never throws", () => {
  assert.equal(worker.buildWrongAnswersSummary([]), "");
  assert.equal(worker.buildWrongAnswersSummary(undefined), "");
  assert.equal(worker.buildWrongAnswersSummary(null), "");
});
