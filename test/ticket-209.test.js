// Ticket 209 (加減運算符填空), 2026-09-30.
// Real citation: 26週數學訓練 P3 Topic 8圓括號 math34pdf/p18.png Q5. Every
// expected value below was brute-forced/checked directly against the
// real official answer key (answers_p02.png Topic 8 Q5) before writing
// the handler, not assumed.
//
// Ticket 210 (parallel-lines letter/character table) was ALSO attempted
// this session but turned out to already exist, committed, as
// cjk_parallel_lines_mc/latin_parallel_lines_count (commit ee3757e) --
// TICKETS.md's 🔲 status for it was stale, not the actual code state.
// The duplicate attempt was reverted before committing; see this
// session's own notes on that discovery.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_209.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_209.mjs");

let mod;
test.before(async () => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_209.mjs"');
  fs.writeFileSync(TMP, src);
  mod = await import(TMP);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

test("209 (a): 297○(172○125)=0 -- real answer key: -;+", () => {
  const item = { printedQuestion: "297○(172○125)=0", studentAnswer: "-;+" };
  assert.equal(mod.isOperatorFillBracketQuestion(item), true);
  const r = mod.verifyOperatorFillBracket(item);
  assert.equal(r.correct, true);
});

test("209 (b): 168○(286○118)=0 -- real answer key: -;-", () => {
  const item = { printedQuestion: "168○(286○118)=0", studentAnswer: "-;-" };
  const r = mod.verifyOperatorFillBracket(item);
  assert.equal(r.correct, true);
});

test("209 (c): 168○(156○176)=500 -- real answer key: +;+", () => {
  const item = { printedQuestion: "168○(156○176)=500", studentAnswer: "+;+" };
  const r = mod.verifyOperatorFillBracket(item);
  assert.equal(r.correct, true);
});

test("209 (d): 297○(308○105)=500 -- real answer key: +;-", () => {
  const item = { printedQuestion: "297○(308○105)=500", studentAnswer: "+;-" };
  const r = mod.verifyOperatorFillBracket(item);
  assert.equal(r.correct, true);
});

test("209: wrong student combination is flagged wrong with the real answer shown", () => {
  const item = { printedQuestion: "297○(172○125)=0", studentAnswer: "+;+" };
  const r = mod.verifyOperatorFillBracket(item);
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "-;+");
});

test("209: tolerates □ and _ as the blank marker too, and full-width +/-", () => {
  const item = { printedQuestion: "168□(156_176)=500", studentAnswer: "＋;＋" };
  assert.equal(mod.isOperatorFillBracketQuestion(item), true);
  const r = mod.verifyOperatorFillBracket(item);
  assert.equal(r.correct, true);
});

test("209: declines (null) when student answer doesn't have exactly 2 operators", () => {
  const item = { printedQuestion: "297○(172○125)=0", studentAnswer: "-" };
  const r = mod.verifyOperatorFillBracket(item);
  assert.equal(r.correct, null);
});

test("209: declines (null) on a genuinely ambiguous equation (more than one valid combo)", () => {
  // 0○(0○0)=0 -- every combination gives 0, never guess which was "intended"
  const item = { printedQuestion: "0○(0○0)=0", studentAnswer: "+;+" };
  const r = mod.verifyOperatorFillBracket(item);
  assert.equal(r.correct, null);
});

test("operator_fill_bracket: registered and wins real dispatch", () => {
  const a = mod.classifyAndVerify({ printedQuestion: "297○(172○125)=0", studentAnswer: "-;+" });
  assert.equal(a.handler, "operator_fill_bracket");
});
