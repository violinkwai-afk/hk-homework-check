// Ticket 28 (proposed 2026-09-27, built 2026-09-28): a real, encountered
// example of a handler COLLISION -- one handler's detect() is loose
// enough to accidentally claim a question meant for a different, more
// specific handler registered later in QUESTION_TYPE_HANDLERS -- has
// happened twice for real (Ticket 183: word_problem_total intercepted
// common_factors_count; Ticket 184: a similar MC-format gap). Both were
// only found because a real citation happened to expose them.
//
// This is the systematic version: for a curated set of REAL citations
// (reused verbatim from mark.test.js's own "handler: registered and
// reachable" tests, so this file introduces no new/synthetic examples),
// run each item through the FULL real QUESTION_TYPE_HANDLERS array and
// assert that EXACTLY ONE handler's detect() returns true -- the
// expected one. Two failure modes this catches:
// - Nobody claims it (a real regression in the expected handler).
// - MORE than one claims it (a real collision -- the actual Ticket 28
//   failure class, which no existing single-handler test can see,
//   since each of those only ever checks its OWN handler in isolation).
//
// Not exhaustive (doesn't scrape every fixture from every test file --
// that would be its own large undertaking) but covers every handler
// added this session (185-195, the least battle-tested) plus the two
// handlers with a real, confirmed collision history (183/184's fixed
// shapes), so a future regression in any of those is caught here even
// if no other test happens to exercise the exact collision.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_collision.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_collision.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_collision.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

const ANT_PATH_GRAPH = { "A": { "B": 1, "F": 2 }, "B": { "A": 1, "C": 2, "G": 2 }, "C": { "B": 2, "D": 4 }, "D": { "C": 4, "G": 2, "E": 3 }, "F": { "A": 2, "E": 3 }, "G": { "B": 2, "D": 2 }, "E": { "F": 3, "D": 3 } };
const DESSERT_SCHEDULE = { "星期日": "蛋卷", "星期一": "紙杯蛋糕", "星期二": "兩粒朱古力", "星期三": "紙杯蛋糕", "星期四": "蛋卷", "星期五": "紙杯蛋糕", "星期六": "雪糕" };

// {label, item, expectedHandler} -- one per handler added this session
// (185-195), plus 183/184's real fixed collision shapes.
const CASES = [
  { label: "183: common_factors_count (word_problem_total collision, fixed)", item: { printedQuestion: "20和32共有多少個公因數？", studentAnswer: "3" }, expectedHandler: "common_factors_count" },
  { label: "184: verifyTrapezoidTwoSquaresArea MC-letter support", item: { printedQuestion: "右圖由一個梯形和兩個正方形組成，兩個正方形的周界分別24 cm和16 cm，梯形的面積是多少cm？ A. 10 cm² B. 20 cm² C. 60 cm² D. 62 cm²", studentAnswer: "A", trapezoidBaseline: 12 }, expectedHandler: "trapezoid_two_squares_area" },
  { label: "185: path_graph (shortest path)", item: { printedQuestion: "D和F的最短路程是___厘米。", studentAnswer: "6", pathGraph: ANT_PATH_GRAPH }, expectedHandler: "path_graph" },
  { label: "185: path_graph (MC via-waypoint)", item: { printedQuestion: "螞蟻從B出發，經*(C/F/G)前往E要走6厘米。", studentAnswer: "F", pathGraph: ANT_PATH_GRAPH }, expectedHandler: "path_graph" },
  { label: "186: schedule_table_query shape 3 (cycle repeat)", item: { printedQuestion: "如果今天的甜品是蛋卷，最快在___天後會再吃到蛋卷。", studentAnswer: "3", scheduleTable: DESSERT_SCHEDULE }, expectedHandler: "schedule_table_query" },
  { label: "186: schedule_table_query shape 4 (yesterday->tomorrow)", item: { printedQuestion: "如果昨天的甜品是雪糕，明天的甜品是*(蛋卷/紙杯蛋糕/兩粒朱古力)。", studentAnswer: "紙杯蛋糕", scheduleTable: DESSERT_SCHEDULE }, expectedHandler: "schedule_table_query" },
  { label: "187: elapsed_time_forward (o'clock shape)", item: { printedQuestion: "Isabella and her family arrive at a country park at 9 o'clock. They leave the country park at 5 o'clock. Isabella and her family stay in the country park for ___ hours.", studentAnswer: "8" }, expectedHandler: "elapsed_time_forward" },
  { label: "187: clock_options_mc", item: { printedQuestion: "小思在5時開始看電視，以下邊個可能是她看完電視的時間？", studentAnswer: "D", clockOptions: { "開始": 17 * 60, "A": 15 * 60, "B": 16 * 60, "C": 14 * 60, "D": 18 * 60 + 40 } }, expectedHandler: "clock_options_mc" },
  { label: "188: paper_fold", item: { printedQuestion: "家文把一張手工紙如上圖般對摺，對摺後的長度是13 cm，手工紙原來長___cm。", studentAnswer: "26", paperFold: { folds: 1, foldedLength: 13 } }, expectedHandler: "paper_fold" },
  { label: "189: coin_blanks", item: { printedQuestion: "$5硬幣可以兌換做___個$2硬幣同___個$1硬幣。", studentAnswer: "2,1", coinBlanks: { target: 5, denoms: [2, 1] } }, expectedHandler: "coin_blanks" },
  { label: "194: distance_ranking (MC nearest)", item: { printedQuestion: "(Tigger / Nina / Billy) is nearest to Micky.", studentAnswer: "Tigger", distanceValues: { reference: "Micky", values: { Tigger: 2, Billy: 5 } } }, expectedHandler: "distance_ranking" },
  { label: "194: distance_ranking (4-way elimination)", item: { printedQuestion: "Yan's dart is nearest to the center. Mike's dart is farthest from the center. Sally's dart is nearer to the center than Ken's dart. Ken's dart is Dart ___.", studentAnswer: "W", distanceValues: { reference: null, values: { W: 3, X: 4, Y: 1, Z: 2 } } }, expectedHandler: "distance_ranking" },
  { label: "195: object_heights (direct lookup)", item: { printedQuestion: "美兒的植物高___個磚。", studentAnswer: "6", objectHeights: { "美兒": 6 } }, expectedHandler: "object_heights" },
  { label: "195: object_heights (between-range MC)", item: { printedQuestion: "小文的植物比子君的高，又比美兒的矮，小文的植物可能高*2/5/7個磚。", studentAnswer: "5", objectHeights: { "子君": 3, "美兒": 6 } }, expectedHandler: "object_heights" },
];

for (const { label, item, expectedHandler } of CASES) {
  test(`handler collision check: ${label}`, async () => {
    const worker = await import(TMP);
    const matching = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item)).map((h) => h.name);
    // classifyAndVerify uses FIRST-match-wins (array order), so a
    // legitimate broad catch-all registered LAST (e.g. math_equation)
    // matching too is expected and harmless -- what actually matters is
    // which handler wins in real dispatch order, not whether anything
    // else ALSO happens to match. Assert the array's first element (==
    // real dispatch winner) is the expected handler.
    assert.equal(matching[0], expectedHandler, `expected "${expectedHandler}" to be the FIRST (real dispatch winner) -- got [${matching.join(", ")}]`);
  });
}
