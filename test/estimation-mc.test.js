// Ticket 222 "Pattern 1: estimation MC" (2026-10-01, real citations,
// re-verified 2026-10-01 -- the original archive citations for this
// pattern (p8, p11) were both wrong; a background fork re-scanned all
// 29 pages and found the real ones, independently spot-checked by
// direct re-reading before trusting): 小學數學新思維 3下A 作業,
// footer p.2 Q10 and footer p.10 Q7.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_estimmc.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_estimmc.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_estimmc.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

test("roundToLeadingDigit: rounds to the number's own leading-digit place value", async () => {
  const worker = await import(TMP);
  assert.equal(worker.roundToLeadingDigit(4105), 4000);
  assert.equal(worker.roundToLeadingDigit(1070), 1000);
  assert.equal(worker.roundToLeadingDigit(2899), 3000);
  assert.equal(worker.roundToLeadingDigit(205), 200);
  assert.equal(worker.roundToLeadingDigit(497), 500);
});

test("verifyEstimationMc: real citation footer p2 Q10 -- DISCLOSED scope gap, declines rather than guesses", async () => {
  // This real citation's expression to estimate is never literally
  // printed in the question sentence -- it must be DERIVED from a
  // narrative word problem ("原有4105元...賺得1070元...用2899元...還
  // 餘多少"), a materially harder extraction problem (parsing which
  // numbers are gains vs spends from surrounding Chinese verbs) than
  // the footer p10 Q7 shape this handler actually covers (where the
  // expression IS literally printed after "估算"). NOT built here --
  // declining safely is the correct, disclosed behavior, not a bug.
  const worker = await import(TMP);
  const item = {
    printedQuestion: "表哥原有4105元，他做兼職賺得1070元後，用2899元買了一部遊戲機。以下哪道算式最適合用來估算他還餘多少元？A. 4000-1000+2000 B. 4000+1000-2000 C. 4000-1000+3000 D. 4000+1000-3000",
    studentAnswer: "D",
  };
  const result = worker.verifyEstimationMc(item);
  assert.equal(result.correct, null);
});

test("verifyEstimationMc: real citation footer p10 Q7, correct answer B", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "以下哪道算式最適合用來估算(205+497)×3的結果？A. (200+400)×3 B. (200+500)×3 C. (300+400)×3 D. (300+500)×3",
    studentAnswer: "B",
  };
  const result = worker.verifyEstimationMc(item);
  assert.equal(result.correct, true);
});

test("verifyEstimationMc: wrong answer reports the real correct letter", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "以下哪道算式最適合用來估算(205+497)×3的結果？A. (200+400)×3 B. (200+500)×3 C. (300+400)×3 D. (300+500)×3",
    studentAnswer: "A",
  };
  const result = worker.verifyEstimationMc(item);
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "B");
});

test("isEstimationMcQuestion / dispatch: registered, wins dispatch on the real citation shape", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "以下哪道算式最適合用來估算(205+497)×3的結果？A. (200+400)×3 B. (200+500)×3 C. (300+400)×3 D. (300+500)×3",
    studentAnswer: "B",
  };
  // The generic math_equation catch-all also technically matches this
  // shape (it contains "="-like arithmetic) -- same established
  // order-dependent-overlap pattern already used elsewhere in this
  // file (see handler-collision.test.js's KNOWN_ORDER_DEPENDENT_PAIRS):
  // classifyAndVerify's dispatch loop uses first-match-wins, and
  // estimation_mc is registered earlier in QUESTION_TYPE_HANDLERS than
  // math_equation, so it always wins in the real dispatch path. Assert
  // the FIRST match, not exclusivity.
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item));
  assert.equal(matched[0].name, "estimation_mc");
  const verdict = worker.classifyAndVerify(item, () => null);
  assert.equal(verdict.handler, "estimation_mc");
  assert.equal(verdict.correct, true);
});

test("verifyEstimationMc: declines (null) when no option's rounded form matches (ambiguous/unexpected shape)", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "以下哪道算式最適合用來估算99+1的結果？A. 90+10 B. 80+20",
    studentAnswer: "A",
  };
  const result = worker.verifyEstimationMc(item);
  assert.equal(result.correct, null);
});
