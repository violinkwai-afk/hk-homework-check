// Ticket 28 (2026-09-30, real user request): a structural safety net
// against handler collisions. `classifyAndVerify` walks
// `QUESTION_TYPE_HANDLERS` in array order and returns the FIRST match --
// that alone never reveals whether a LATER-registered handler's own
// detect() would ALSO have claimed the same real item (a silent
// collision, hidden by array order, that a future handler addition
// could turn into a real misfire). This file feeds a curated set of
// REAL per-handler citations (copied from each handler's own existing
// test, not invented) through EVERY handler's detect() directly, and
// fails if more than one handler claims the same item.
//
// Honest scope: this project registers ~120 handlers; this is a STARTER
// set (the handlers already exercised by an existing "registered and
// reachable/wins dispatch"-style test elsewhere in test/, harvested by
// hand from those tests -- not yet exhaustive for all 120). Extending
// coverage is just adding another {handler, item} entry below; the
// checking mechanism itself is complete and needs no changes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_collision.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_collision.mjs");

let mod;
test.before(async () => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_collision.mjs"');
  fs.writeFileSync(TMP, src);
  mod = await import(TMP);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// Each {handler, item} pair is a REAL citation already used by that
// handler's own dedicated test elsewhere in test/ -- copied, not
// invented. Only `detect()` is exercised (text-level classification);
// visual handlers' own `verifyVisual` correctness is already covered by
// their own test files and needs real crop image data this framework
// deliberately doesn't need.
const REAL_EXAMPLES = [
  { handler: "operator_fill_bracket", item: { printedQuestion: "297○(172○125)=0", studentAnswer: "-;+" } },
  { handler: "number_word_conversion", item: { printedQuestion: "課文入面「七」呢個字係邊個數字？", studentAnswer: "7" } },
  { handler: "grammar_cloze", item: { printedQuestion: "The bird is ____ beautiful.", studentAnswer: "it's" } },
  { handler: "construct_extreme_number", item: { printedQuestion: "把5,0,8,6和2這五個數字組成一個最小的五位數。", studentAnswer: "20568" } },
  { handler: "sequence_fill", item: { printedQuestion: "2,?,6,?,10,?,?,16,?,20", studentAnswer: "4;8;12;14;18" } },
  { handler: "chinese_large_numeral_to_arabic", item: { label: "1", printedQuestion: "以阿拉伯數字寫出「五億零八百萬零二十」。", studentAnswer: "508000020" } },
  { handler: "word_problem_rate_multiplication", item: { label: "1", printedQuestion: "小克每天儲蓄30元，他五天共儲蓄多少元？", studentAnswer: "150" } },
  { handler: "division_remainder_blank", item: { label: "1", printedQuestion: "在49÷5=9…●的除式中，●代表的數是___", studentAnswer: "4" } },
  { handler: "extreme_number_difference", item: { label: "1", printedQuestion: "最大的三位數和最小的三位奇數相差是___", studentAnswer: "898" } },
  { handler: "substitute_and_evaluate", item: { label: "1", printedQuestion: "如果T=8，那麼10+T-6的值是______。", studentAnswer: "12" } },
  { handler: "repeated_digit_place_value_difference", item: { label: "1", printedQuestion: "在71460864這個數中，兩個「6」的數值相差多少？", studentAnswer: "59940" } },
  { handler: "time_format_conversion", item: { label: "1", printedQuestion: "Express the time in '12-hour time'. 16:15", studentAnswer: "4:15 in the afternoon" } },
];

test("Ticket 28: every curated real example is claimed by its own intended handler (sanity check on the fixture set itself)", () => {
  for (const { handler, item } of REAL_EXAMPLES) {
    const verdict = mod.classifyAndVerify(item);
    assert.equal(verdict.handler, handler, `expected "${handler}" to win dispatch for its own real citation, got "${verdict.handler}"`);
  }
});

// Real overlaps this framework found on its first run (2026-09-30) --
// kept as an explicit, reasoned allowlist rather than silently loosening
// the check, so a NEW unexpected collision still fails loudly:
// - "math_equation" is the deliberate, always-registered-LAST generic
//   fallback (see its own registration comment) -- it is SUPPOSED to
//   raw-match many math-shaped items; that's not a fragility, it's the
//   design. Excluded from collision counting entirely.
// - "repeated_digit_place_value_difference" (registered BEFORE
//   "word_problem_difference") vs that same handler: both are specific
//   (non-fallback) handlers, so this one IS a real order-dependent
//   fragility worth keeping visible -- allowlisted by name pair, not
//   silently ignored, so anyone reordering QUESTION_TYPE_HANDLERS sees
//   exactly why this line exists.
const KNOWN_ORDER_DEPENDENT_PAIRS = new Set(["repeated_digit_place_value_difference:word_problem_difference"]);

test("Ticket 28: no OTHER registered handler's detect() also claims another handler's real citation", () => {
  const collisions = [];
  for (const { handler: ownerName, item } of REAL_EXAMPLES) {
    const claimants = mod.QUESTION_TYPE_HANDLERS
      .filter((h) => {
        try { return !!h.detect(item); } catch (e) { return false; } // a detect() that throws on a foreign shape doesn't count as a claim
      })
      .map((h) => h.name)
      .filter((n) => n !== ownerName && n !== "math_equation"); // math_equation: see comment above
    const unexpected = claimants.filter((n) => !KNOWN_ORDER_DEPENDENT_PAIRS.has(`${ownerName}:${n}`) && !KNOWN_ORDER_DEPENDENT_PAIRS.has(`${n}:${ownerName}`));
    if (unexpected.length) {
      collisions.push(`"${ownerName}"'s citation is ALSO claimed by: ${unexpected.join(", ")}`);
    }
  }
  assert.deepEqual(collisions, [], collisions.join("\n"));
});
