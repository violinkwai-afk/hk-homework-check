// Ticket 28 (proposed 2026-09-27, built 2026-09-28, extended 2026-09-30):
// a real, encountered example of a handler COLLISION -- one handler's
// detect() is loose enough to accidentally claim a question meant for a
// different, more specific handler registered later in
// QUESTION_TYPE_HANDLERS -- has happened twice for real (Ticket 183:
// word_problem_total intercepted common_factors_count; Ticket 184: a
// similar MC-format gap). Both were only found because a real citation
// happened to expose them.
//
// This is the systematic version: for a curated set of REAL citations
// (reused verbatim from each handler's own existing "registered and
// reachable"-style test, so this file introduces no new/synthetic
// examples), run each item through the FULL real QUESTION_TYPE_HANDLERS
// array via classifyAndVerify and check two things:
// (1) the handler that actually wins real dispatch is the expected one
//     (a regression in the expected handler, or a HIGHER-priority
//     handler silently intercepting it, would fail here);
// (2) no OTHER (lower-priority) handler's detect() ALSO silently claims
//     the same item -- the real Ticket 28 failure class, invisible to
//     (1) alone and to every single-handler test, since each of those
//     only ever checks its OWN handler in isolation.
//
// 2026-09-30 note: this file used to be two separately-named, slightly
// overlapping files (test/handler-collision.test.js and
// test/cross-collision-framework.test.js) written independently and, by
// coincidence, sharing the exact same temp-file names -- a real latent
// race if node's test runner ever ran both files in parallel. Merged
// into this one canonical file, keeping every real citation from both
// (the two case sets covered disjoint handlers, nothing was dropped).
//
// Honest scope: this project registers ~130 handlers; this is a curated
// starter set (handlers already exercised by an existing "registered and
// reachable/wins dispatch"-style test elsewhere in test/, harvested by
// hand -- not yet exhaustive for all of them). Extending coverage is
// just adding another {handler, item} entry below; the checking
// mechanism itself is complete and needs no changes.

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

const ANT_PATH_GRAPH = { "A": { "B": 1, "F": 2 }, "B": { "A": 1, "C": 2, "G": 2 }, "C": { "B": 2, "D": 4 }, "D": { "C": 4, "G": 2, "E": 3 }, "F": { "A": 2, "E": 3 }, "G": { "B": 2, "D": 2 }, "E": { "F": 3, "D": 3 } };
const DESSERT_SCHEDULE = { "星期日": "蛋卷", "星期一": "紙杯蛋糕", "星期二": "兩粒朱古力", "星期三": "紙杯蛋糕", "星期四": "蛋卷", "星期五": "紙杯蛋糕", "星期六": "雪糕" };

// Each {handler, item} pair is a REAL citation already used by that
// handler's own dedicated test elsewhere in test/ -- copied, not
// invented. Only `detect()` is exercised (text-level classification);
// visual handlers' own `verifyVisual` correctness is already covered by
// their own test files and needs real crop image data this framework
// deliberately doesn't need.
const REAL_EXAMPLES = [
  // From the original 2026-09-28 file (handlers 183-195, plus the two
  // real fixed collisions that motivated this whole ticket).
  { handler: "common_factors_count", item: { printedQuestion: "20和32共有多少個公因數？", studentAnswer: "3" } },
  { handler: "trapezoid_two_squares_area", item: { printedQuestion: "右圖由一個梯形和兩個正方形組成，兩個正方形的周界分別24 cm和16 cm，梯形的面積是多少cm？ A. 10 cm² B. 20 cm² C. 60 cm² D. 62 cm²", studentAnswer: "A", trapezoidBaseline: 12 } },
  { handler: "path_graph", item: { printedQuestion: "D和F的最短路程是___厘米。", studentAnswer: "6", pathGraph: ANT_PATH_GRAPH } },
  { handler: "path_graph", item: { printedQuestion: "螞蟻從B出發，經*(C/F/G)前往E要走6厘米。", studentAnswer: "F", pathGraph: ANT_PATH_GRAPH } },
  { handler: "schedule_table_query", item: { printedQuestion: "如果今天的甜品是蛋卷，最快在___天後會再吃到蛋卷。", studentAnswer: "3", scheduleTable: DESSERT_SCHEDULE } },
  { handler: "schedule_table_query", item: { printedQuestion: "如果昨天的甜品是雪糕，明天的甜品是*(蛋卷/紙杯蛋糕/兩粒朱古力)。", studentAnswer: "紙杯蛋糕", scheduleTable: DESSERT_SCHEDULE } },
  { handler: "elapsed_time_forward", item: { printedQuestion: "Isabella and her family arrive at a country park at 9 o'clock. They leave the country park at 5 o'clock. Isabella and her family stay in the country park for ___ hours.", studentAnswer: "8" } },
  { handler: "clock_options_mc", item: { printedQuestion: "小思在5時開始看電視，以下邊個可能是她看完電視的時間？", studentAnswer: "D", clockOptions: { "開始": 17 * 60, "A": 15 * 60, "B": 16 * 60, "C": 14 * 60, "D": 18 * 60 + 40 } } },
  { handler: "paper_fold", item: { printedQuestion: "家文把一張手工紙如上圖般對摺，對摺後的長度是13 cm，手工紙原來長___cm。", studentAnswer: "26", paperFold: { folds: 1, foldedLength: 13 } } },
  { handler: "coin_blanks", item: { printedQuestion: "$5硬幣可以兌換做___個$2硬幣同___個$1硬幣。", studentAnswer: "2,1", coinBlanks: { target: 5, denoms: [2, 1] } } },
  { handler: "distance_ranking", item: { printedQuestion: "(Tigger / Nina / Billy) is nearest to Micky.", studentAnswer: "Tigger", distanceValues: { reference: "Micky", values: { Tigger: 2, Billy: 5 } } } },
  { handler: "distance_ranking", item: { printedQuestion: "Yan's dart is nearest to the center. Mike's dart is farthest from the center. Sally's dart is nearer to the center than Ken's dart. Ken's dart is Dart ___.", studentAnswer: "W", distanceValues: { reference: null, values: { W: 3, X: 4, Y: 1, Z: 2 } } } },
  { handler: "object_heights", item: { printedQuestion: "美兒的植物高___個磚。", studentAnswer: "6", objectHeights: { "美兒": 6 } } },
  { handler: "object_heights", item: { printedQuestion: "小文的植物比子君的高，又比美兒的矮，小文的植物可能高*2/5/7個磚。", studentAnswer: "5", objectHeights: { "子君": 3, "美兒": 6 } } },
  // From the 2026-09-30 file (disjoint handler set, including tonight's
  // new Ticket 209).
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
// - "common_factors_count" vs "word_problem_total": this is the EXACT
//   real collision that originally motivated Ticket 28 (Ticket 183) --
//   word_problem_total's detect() is broad enough to also claim a
//   common-factors word problem; the existing fix is registration order
//   (common_factors_count comes first), not a detect() narrowing. Merging
//   this file's two independently-built case sets (2026-09-30) is what
//   first exposed this specific pair to the stricter cross-check test --
//   it was already true before the merge, just never checked by the
//   older file's cases. Allowlisted, not silently loosened.
const KNOWN_ORDER_DEPENDENT_PAIRS = new Set([
  "repeated_digit_place_value_difference:word_problem_difference",
  "common_factors_count:word_problem_total",
]);

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
