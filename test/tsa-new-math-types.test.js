// Found 2026-10-02 while surveying HKEAA's official TSA maths archive
// (benchmark/external_pdfs/tsa/, downloaded same day) for new question
// types. Three genuinely new Tier-A shapes confirmed not covered by any
// existing handler (checked against all ~140 existing verify* functions
// before writing these) -- see each verify function's own comment in
// src/worker.js for the exact real citation (file + question number).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_tsamath.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_tsamath.mjs");

let worker;
test.before(async () => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_tsamath.mjs"');
  fs.writeFileSync(TMP, src);
  worker = await import(TMP);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// ---------- shortfall_from_needed_total ----------
// Real citation: tsa/2022/p3_paper_2022_3MC2.txt Q10, .../3MC3.txt Q8

const SHORTFALL_Q = "做一個薄餅需用330克麪粉。做一個蛋糕需用250克麪粉。爸爸有425克麪粉，他要做一個薄餅和一個蛋糕，還欠___克麪粉。";

test("verifyShortfallFromNeededTotal: real citation, correct answer", () => {
  const r = worker.verifyShortfallFromNeededTotal(SHORTFALL_Q, "155");
  assert.equal(r.correct, true);
});

test("verifyShortfallFromNeededTotal: real citation, wrong answer", () => {
  const r = worker.verifyShortfallFromNeededTotal(SHORTFALL_Q, "150");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "155");
});

test("verifyShortfallFromNeededTotal: declines without the 還欠 keyword", () => {
  const r = worker.verifyShortfallFromNeededTotal("做一個薄餅需用330克麪粉。做一個蛋糕需用250克麪粉。爸爸有425克麪粉。", "155");
  assert.equal(r.correct, null);
});

test("weekly_rate_with_exception_day handler: registered, reachable, wins dispatch", () => {
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "weekly_rate_with_exception_day");
  assert.ok(handler, "handler must be registered");
  const item = { printedQuestion: "家明上興趣班，星期一至六每天上2小時，星期日上4小時。他這星期上興趣班共多少小時？", studentAnswer: "16" };
  assert.equal(handler.detect(item), true);
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "weekly_rate_with_exception_day");
});

test("shortfall_from_needed_total handler: registered, reachable, wins dispatch", () => {
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "shortfall_from_needed_total");
  assert.ok(handler, "handler must be registered");
  const item = { printedQuestion: SHORTFALL_Q, studentAnswer: "155" };
  assert.equal(handler.detect(item), true);
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "shortfall_from_needed_total");
});

// ---------- weekly_rate_with_exception_day ----------
// Real citation: tsa/2022/p3_paper_2022_3MC2.txt Q12

const WEEKLY_Q = "家明上興趣班，星期一至六每天上2小時，星期日上4小時。他這星期上興趣班共多少小時？";

test("verifyWeeklyRateWithExceptionDay: real citation, correct answer", () => {
  const r = worker.verifyWeeklyRateWithExceptionDay(WEEKLY_Q, "16");
  assert.equal(r.correct, true);
});

test("verifyWeeklyRateWithExceptionDay: real citation, wrong answer", () => {
  const r = worker.verifyWeeklyRateWithExceptionDay(WEEKLY_Q, "12");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "16");
});

// ---------- price_table_sum_with_discount ----------
// Real citation: tsa/2022/p3_paper_2022_3MC2.txt Q12, .../3MC3.txt Q10,
// .../3MC4.txt Q12 -- "外套462元，褲子236元，買兩件貨品可減50元"

const DISCOUNT_Q = "百貨公司進行大減價，買兩件貨品可減50元。美芬買了一件外套和一條褲子，她應付多少元？";
const DISCOUNT_TABLE = { 外套: 462, 褲子: 236 };

test("verifyPriceTableSumWithDiscount: real citation, correct answer", () => {
  const r = worker.verifyPriceTableSumWithDiscount(DISCOUNT_TABLE, DISCOUNT_Q, "648");
  assert.equal(r.correct, true);
});

test("verifyPriceTableSumWithDiscount: real citation, wrong answer (forgot the discount)", () => {
  const r = worker.verifyPriceTableSumWithDiscount(DISCOUNT_TABLE, DISCOUNT_Q, "698");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "648");
});

test("verifyPriceTableSumWithDiscount: declines without a 減N元 discount phrase", () => {
  const r = worker.verifyPriceTableSumWithDiscount(DISCOUNT_TABLE, "美芬買了一件外套和一條褲子，她應付多少元？", "648");
  assert.equal(r.correct, null);
});

test("price_table_sum_with_discount handler: registered, reachable, wins over price_table_lookup", () => {
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "price_table_sum_with_discount");
  assert.ok(handler, "handler must be registered");
  const item = { priceTable: DISCOUNT_TABLE, printedQuestion: DISCOUNT_Q, studentAnswer: "648" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "price_table_sum_with_discount");
});

// ---------- English-medium versions (same TSA items, official English paper) ----------
// Real citations: tsa/2022/p3_paper_2022_3ME2.txt Q10 (shortfall),
// Q12 (weekly rate); tsa/2022/p3_paper_2022_3ME3.txt Q10 (discount).

const SHORTFALL_EN_Q = "It takes 330 grams of flour to make a pizza and 250 grams of flour to make a cake. Father has 425 grams of flour. He wants to make a pizza and a cake. He needs ___ grams more of flour.";
const WEEKLY_EN_Q = "Ken goes to interest classes. He attends 2 hours a day from Monday to Saturday and 4 hours on Sunday. How many hours does Ken go to interest classes this week?";
const DISCOUNT_EN_Q = "The department store is having a sale. If you buy 2 items you can get 50 dollars off. Mandy buys a jacket and a pair of pants. How much does she have to pay altogether?";
const DISCOUNT_EN_TABLE = { jacket: 462, pants: 236 };

test("verifyShortfallFromNeededTotal: English citation, correct answer", () => {
  const r = worker.verifyShortfallFromNeededTotal(SHORTFALL_EN_Q, "155");
  assert.equal(r.correct, true);
});

test("verifyWeeklyRateWithExceptionDay: English citation, correct answer", () => {
  const r = worker.verifyWeeklyRateWithExceptionDay(WEEKLY_EN_Q, "16");
  assert.equal(r.correct, true);
});

test("verifyPriceTableSumWithDiscount: English citation, correct answer", () => {
  const r = worker.verifyPriceTableSumWithDiscount(DISCOUNT_EN_TABLE, DISCOUNT_EN_Q, "648");
  assert.equal(r.correct, true);
});

test("shortfall_from_needed_total handler: English citation wins real dispatch", () => {
  const item = { printedQuestion: SHORTFALL_EN_Q, studentAnswer: "155" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "shortfall_from_needed_total");
});

test("weekly_rate_with_exception_day handler: English citation wins real dispatch", () => {
  const item = { printedQuestion: WEEKLY_EN_Q, studentAnswer: "16" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "weekly_rate_with_exception_day");
});

test("price_table_sum_with_discount handler: English citation wins real dispatch", () => {
  const item = { priceTable: DISCOUNT_EN_TABLE, printedQuestion: DISCOUNT_EN_Q, studentAnswer: "648" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "price_table_sum_with_discount");
});

// ---------- percentage_discount_zhe ----------
// Real citation: tsa/2022/p6_paper_2022_6MC2.txt Q15

const ZHE_Q = "一條裙子的原價是160元。凱晴以七折購買這條裙子，須付___元。";

test("verifyPercentageDiscountZhe: real citation, correct answer", () => {
  const r = worker.verifyPercentageDiscountZhe(ZHE_Q, "112");
  assert.equal(r.correct, true);
});

test("verifyPercentageDiscountZhe: real citation, wrong answer", () => {
  const r = worker.verifyPercentageDiscountZhe(ZHE_Q, "160");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "112");
});

test("verifyPercentageDiscountZhe: declines without 原價 keyword", () => {
  const r = worker.verifyPercentageDiscountZhe("凱晴以七折購買一條裙子，須付___元。", "112");
  assert.equal(r.correct, null);
});

test("percentage_discount_zhe handler: registered, reachable, wins dispatch", () => {
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "percentage_discount_zhe");
  assert.ok(handler, "handler must be registered");
  const item = { printedQuestion: ZHE_Q, studentAnswer: "112" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "percentage_discount_zhe");
});

// ---------- daily_rate_sum_times_week ----------
// Real citation: tsa/2022/p6_paper_2022_6MC3.txt Q15, .../6MC4.txt Q15

const DAILY_WEEK_Q = "小晴每天用1.5小時看電視，又用0.75小時閱讀。她一星期共用___小時看電視和閱讀。";

test("verifyDailyRateSumTimesWeek: real citation, correct answer", () => {
  const r = worker.verifyDailyRateSumTimesWeek(DAILY_WEEK_Q, "15.75");
  assert.equal(r.correct, true);
});

test("verifyDailyRateSumTimesWeek: real citation, wrong answer", () => {
  const r = worker.verifyDailyRateSumTimesWeek(DAILY_WEEK_Q, "14");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "15.75");
});

test("daily_rate_sum_times_week handler: registered, reachable, wins dispatch (not word_problem_rate_multiplication)", () => {
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "daily_rate_sum_times_week");
  assert.ok(handler, "handler must be registered");
  const item = { printedQuestion: DAILY_WEEK_Q, studentAnswer: "15.75" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "daily_rate_sum_times_week");
});

// ---------- spent_plus_remaining_equals_original ----------
// Real citation: tsa/2023/p3_paper_TSA2023_3MC.txt (3MC2 Q10, 3MC3 Q11)

const ORIGINAL_Q = "一個籃球售160元。浩明買了一個籃球後，還餘145元，他原有___元。";

test("verifySpentPlusRemainingEqualsOriginal: real citation, correct answer", () => {
  const r = worker.verifySpentPlusRemainingEqualsOriginal(ORIGINAL_Q, "305");
  assert.equal(r.correct, true);
});

test("verifySpentPlusRemainingEqualsOriginal: real citation, wrong answer", () => {
  const r = worker.verifySpentPlusRemainingEqualsOriginal(ORIGINAL_Q, "15");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "305");
});

test("spent_plus_remaining_equals_original handler: registered, reachable, wins dispatch", () => {
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "spent_plus_remaining_equals_original");
  assert.ok(handler, "handler must be registered");
  const item = { printedQuestion: ORIGINAL_Q, studentAnswer: "305" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "spent_plus_remaining_equals_original");
});

// Second real citation (2026-10-02, TSA 2024 P3 maths) generalized this
// handler from "exactly 2 numbers" to "sum all numbers" -- this
// citation has 3 (two separate sold amounts + one remaining).
const CANDY_Q = "糖果店有一些糖果，上午賣出130包，下午賣出258包，還餘下215包。糖果店原有糖果多少包？";

test("verifySpentPlusRemainingEqualsOriginal: 2nd real citation (candy, 3 numbers), correct answer", () => {
  const r = worker.verifySpentPlusRemainingEqualsOriginal(CANDY_Q, "603");
  assert.equal(r.correct, true);
});

test("spent_plus_remaining_equals_original handler: 2nd real citation wins dispatch", () => {
  const item = { printedQuestion: CANDY_Q, studentAnswer: "603" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "spent_plus_remaining_equals_original");
});

// ---------- percentage_more_less_than_base ----------
// Real citation: tsa/2023/p6_paper_TSA2023_6MC.txt (6MC1) Q19.
// Real bug found: verifyWordProblemMoreThan used to confidently compute
// 800+20=820 for this exact item (should be 800*1.2=960) because it
// treated the "%" amount as a flat quantity. Fixed by (a) making
// verifyWordProblemMoreThan decline on any percentage phrasing, and
// (b) adding this dedicated multiplicative handler ahead of it.

const PERCENT_MORE_Q = "一包普通裝奶粉重800克，一包增量裝奶粉的重量比普通裝的多20%，增量裝奶粉重多少克?";

test("verifyWordProblemMoreThan: now DECLINES on the percentage shape (real bug, fixed)", () => {
  const r = worker.verifyWordProblemMoreThan(PERCENT_MORE_Q, "960");
  assert.equal(r.correct, null);
});

test("verifyPercentageMoreLessThanBase: real citation, correct answer", () => {
  const r = worker.verifyPercentageMoreLessThanBase(PERCENT_MORE_Q, "960");
  assert.equal(r.correct, true);
});

test("verifyPercentageMoreLessThanBase: real citation, wrong answer (the old buggy additive answer)", () => {
  const r = worker.verifyPercentageMoreLessThanBase(PERCENT_MORE_Q, "820");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "960");
});

test("percentage_more_less_than_base handler: wins real dispatch (not word_problem_more_than)", () => {
  const item = { printedQuestion: PERCENT_MORE_Q, studentAnswer: "960" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "percentage_more_less_than_base");
});

test("word_problem_more_than: still works correctly on a real NON-percentage citation (no regression)", () => {
  // Existing real citation from this handler's own history: 249 oranges,
  // 41 more apples than oranges.
  const q = "停車場有249架橙色的車，藍色的車比橙色的多41架，藍色的車有多少架？";
  const r = worker.verifyWordProblemMoreThan(q, "290");
  assert.equal(r.correct, true);
});

// ---------- base_plus_multiple_of_base_total ----------
// Real citation: tsa/2023/p6_paper_TSA2023_6MC.txt (6MC2) Q15

const RIBBON_Q = "紅絲帶長117cm，綠絲帶的長度是紅絲帶的3倍，兩條絲帶共長___cm。";

test("verifyBasePlusMultipleOfBaseTotal: real citation, correct answer", () => {
  const r = worker.verifyBasePlusMultipleOfBaseTotal(RIBBON_Q, "468");
  assert.equal(r.correct, true);
});

test("verifyBasePlusMultipleOfBaseTotal: real citation, wrong answer (the word_problem_total collision answer)", () => {
  const r = worker.verifyBasePlusMultipleOfBaseTotal(RIBBON_Q, "120");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "468");
});

test("base_plus_multiple_of_base_total handler: wins real dispatch (not word_problem_total)", () => {
  const item = { printedQuestion: RIBBON_Q, studentAnswer: "468" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "base_plus_multiple_of_base_total");
});

// Second real citation (2026-10-02, TSA 2024 P3 maths) found the first
// citation's trigger too narrow ("共長/共重/共有" didn't match this
// citation's "共吃了") -- widened to the full 共/總共/一共/合共 set.
const LYCHEE_Q = "明輝吃了4粒荔枝，珮詩吃了荔枝的數量是明輝的3倍，兩人共吃了荔枝多少粒？";

test("verifyBasePlusMultipleOfBaseTotal: 2nd real citation (lychee), correct answer", () => {
  const r = worker.verifyBasePlusMultipleOfBaseTotal(LYCHEE_Q, "16");
  assert.equal(r.correct, true);
});

test("base_plus_multiple_of_base_total handler: 2nd real citation wins dispatch", () => {
  const item = { printedQuestion: LYCHEE_Q, studentAnswer: "16" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "base_plus_multiple_of_base_total");
});

// ---------- first_n_common_multiples ----------
// Real citations: tsa/2022/p6_paper_2022_6MC3.txt Q3 (4,6);
// tsa/2023/p6_paper_TSA2023_6MC.txt (6MC3/6MC4) Q4 (6,8)

test("verifyFirstNCommonMultiples: real citation (4,6), correct answer", () => {
  const r = worker.verifyFirstNCommonMultiples("列出4和6的最初三個公倍數。", "12,24,36");
  assert.equal(r.correct, true);
});

test("verifyFirstNCommonMultiples: real citation (6,8), correct answer", () => {
  const r = worker.verifyFirstNCommonMultiples("列出6和8的最初三個公倍數。", "24, 48, 72");
  assert.equal(r.correct, true);
});

test("verifyFirstNCommonMultiples: wrong answer", () => {
  const r = worker.verifyFirstNCommonMultiples("列出6和8的最初三個公倍數。", "6,8,16");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "24, 48, 72");
});

test("first_n_common_multiples handler: registered, reachable, wins dispatch", () => {
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "first_n_common_multiples");
  assert.ok(handler, "handler must be registered");
  const item = { printedQuestion: "列出6和8的最初三個公倍數。", studentAnswer: "24,48,72" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "first_n_common_multiples");
});

// ---------- paid_minus_known_item_divided_by_quantity ----------
// Real citation: tsa/2024/p6_paper_TSA2024_6MC2.txt Q15

const TART_Q = "高先生付294元買了一個生日蛋糕和6件蛋撻，平均每件蛋撻售___元。";
const TART_TABLE = { 生日蛋糕: 252 };

test("verifyPaidMinusKnownItemDividedByQuantity: real citation, correct answer", () => {
  const r = worker.verifyPaidMinusKnownItemDividedByQuantity(TART_TABLE, TART_Q, "7");
  assert.equal(r.correct, true);
});

test("verifyPaidMinusKnownItemDividedByQuantity: real citation, wrong answer", () => {
  const r = worker.verifyPaidMinusKnownItemDividedByQuantity(TART_TABLE, TART_Q, "49");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "7");
});

test("paid_minus_known_item_divided_by_quantity handler: registered, reachable, wins dispatch", () => {
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "paid_minus_known_item_divided_by_quantity");
  assert.ok(handler, "handler must be registered");
  const item = { priceTable: TART_TABLE, printedQuestion: TART_Q, studentAnswer: "7" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "paid_minus_known_item_divided_by_quantity");
});

// ---------- English versions, added 2026-10-02 ----------
// Each one's own official English-medium translation of the same real
// TSA item its Chinese-only citation above was built from.

// percentage_discount_zhe EN -- tsa/2022/p6_paper_2022_6ME2.txt Q15 /
// .../6ME3.txt Q17: "30% off" phrasing (no "X折" notation in English).
const DRESS_EN_Q = "The original price of a dress is 160 dollars. Heidi buys the dress at 30% off. She should pay ___ dollars.";

test("verifyPercentageDiscountZhe: English citation, correct answer", () => {
  const r = worker.verifyPercentageDiscountZhe(DRESS_EN_Q, "112");
  assert.equal(r.correct, true);
});

test("verifyPercentageDiscountZhe: English citation, wrong answer", () => {
  const r = worker.verifyPercentageDiscountZhe(DRESS_EN_Q, "130");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "112");
});

test("percentage_discount_zhe handler: English citation wins dispatch", () => {
  const item = { printedQuestion: DRESS_EN_Q, studentAnswer: "112" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "percentage_discount_zhe");
});

// daily_rate_sum_times_week EN -- tsa/2022/p6_paper_2022_6ME3.txt Q15 /
// .../6ME4.txt Q15.
const CINDY_EN_Q = "Cindy spends 1.5 hours on watching TV and 0.75 hour on reading every day. In total she spends ___ hours on watching TV and reading in one week.";

test("verifyDailyRateSumTimesWeek: English citation, correct answer", () => {
  const r = worker.verifyDailyRateSumTimesWeek(CINDY_EN_Q, "15.75");
  assert.equal(r.correct, true);
});

test("daily_rate_sum_times_week handler: English citation wins dispatch (not word_problem_rate_multiplication)", () => {
  const item = { printedQuestion: CINDY_EN_Q, studentAnswer: "15.75" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "daily_rate_sum_times_week");
});

// spent_plus_remaining_equals_original EN -- 2-number citation:
// tsa/2023/p3_paper_TSA2023_3ME.txt (3ME2 split); 3-number citation:
// tsa/2024/p3_paper_TSA2024_3ME3.txt Q9 / .../3ME4.txt Q11.
const BASKETBALL_EN_Q = "A basketball costs 160 dollars. After buying a basketball, Jack has 145 dollars left. Jack has ___ dollars at first.";
const CANDY_EN_Q = "There are some packs of candies in a candy store. The shopkeeper sells 130 packs in the morning and 258 packs in the afternoon. There are 215 packs left. How many packs of candies are there at first?";

test("verifySpentPlusRemainingEqualsOriginal: English 2-number citation, correct answer", () => {
  const r = worker.verifySpentPlusRemainingEqualsOriginal(BASKETBALL_EN_Q, "305");
  assert.equal(r.correct, true);
});

test("verifySpentPlusRemainingEqualsOriginal: English 3-number citation, correct answer", () => {
  const r = worker.verifySpentPlusRemainingEqualsOriginal(CANDY_EN_Q, "603");
  assert.equal(r.correct, true);
});

test("spent_plus_remaining_equals_original handler: English citation wins dispatch", () => {
  const item = { printedQuestion: BASKETBALL_EN_Q, studentAnswer: "305" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "spent_plus_remaining_equals_original");
});

// percentage_more_less_than_base EN -- tsa/2023/p6_paper_TSA2023_6ME.txt
// Q19 (same item as the live production bug fix above).
const MILK_EN_Q = "A regular pack of milk powder weighs 800 grams. The weight of a value pack of milk powder is 20% more than that of a regular pack. How many grams does a value pack of milk powder weigh?";

test("verifyPercentageMoreLessThanBase: English citation, correct answer", () => {
  const r = worker.verifyPercentageMoreLessThanBase(MILK_EN_Q, "960");
  assert.equal(r.correct, true);
});

test("percentage_more_less_than_base handler: English citation wins dispatch (not word_problem_more_than)", () => {
  const item = { printedQuestion: MILK_EN_Q, studentAnswer: "960" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "percentage_more_less_than_base");
});

// base_plus_multiple_of_base_total EN -- "times that of" citation:
// tsa/2023/p6_paper_TSA2023_6ME.txt Q15; "times as many...as" citation:
// tsa/2024/p3_paper_TSA2024_3ME2.txt Q13.
const RIBBON_EN_Q = "A red ribbon is 117 cm long. The length of a green ribbon is 3 times that of the red ribbon. The total length of the two ribbons is ___ cm.";
const LYCHEE_EN_Q = "Michael eats 4 lychees. Christy eats 3 times as many lychees as Michael. How many lychees do they eat altogether?";

test("verifyBasePlusMultipleOfBaseTotal: English 'times that of' citation, correct answer", () => {
  const r = worker.verifyBasePlusMultipleOfBaseTotal(RIBBON_EN_Q, "468");
  assert.equal(r.correct, true);
});

test("verifyBasePlusMultipleOfBaseTotal: English 'times as many...as' citation, correct answer", () => {
  const r = worker.verifyBasePlusMultipleOfBaseTotal(LYCHEE_EN_Q, "16");
  assert.equal(r.correct, true);
});

test("base_plus_multiple_of_base_total handler: English citation wins dispatch (not word_problem_total)", () => {
  const item = { printedQuestion: LYCHEE_EN_Q, studentAnswer: "16" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "base_plus_multiple_of_base_total");
});

// first_n_common_multiples EN -- tsa/2022/p6_paper_2022_6ME3.txt Q3.
const COMMON_MULT_EN_Q = "List the first three common multiples of 4 and 6.";

test("verifyFirstNCommonMultiples: English citation, correct answer", () => {
  const r = worker.verifyFirstNCommonMultiples(COMMON_MULT_EN_Q, "12,24,36");
  assert.equal(r.correct, true);
});

test("first_n_common_multiples handler: English citation wins dispatch", () => {
  const item = { printedQuestion: COMMON_MULT_EN_Q, studentAnswer: "12,24,36" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "first_n_common_multiples");
});

// paid_minus_known_item_divided_by_quantity EN --
// tsa/2024/p6_paper_TSA2024_6ME2.txt Q15.
const TART_EN_Q = "Mr Ko paid 294 dollars for a birthday cake and 6 egg tarts. On average, each egg tart costs ___ dollar(s).";
const TART_EN_TABLE = { "birthday cake": 252 };

test("verifyPaidMinusKnownItemDividedByQuantity: English citation, correct answer", () => {
  const r = worker.verifyPaidMinusKnownItemDividedByQuantity(TART_EN_TABLE, TART_EN_Q, "7");
  assert.equal(r.correct, true);
});

test("paid_minus_known_item_divided_by_quantity handler: English citation wins dispatch", () => {
  const item = { priceTable: TART_EN_TABLE, printedQuestion: TART_EN_Q, studentAnswer: "7" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "paid_minus_known_item_divided_by_quantity");
});

// ---------- Hardening regression tests, added 2026-10-02 ----------
// The user asked whether these triggers just check for keyword PRESENCE
// anywhere in the text, ignoring relative order -- they originally did
// for several of the 7 types above. Each test below is a synthetic
// sentence where the real keywords all appear, but in the WRONG relative
// order compared to every real citation -- proving the hardened triggers
// now correctly DECLINE (return null) instead of confidently computing a
// wrong answer, where the old order-blind version would have fired.

test("verifySpentPlusRemainingEqualsOriginal: 'at first' before 'left' (reversed order) declines, not a wrong sum", () => {
  // Old order-blind trigger would have summed 50+10+5=65 (wrong -- real
  // answer to this subtraction-chain shape is 50-10-5=35). Hardened
  // trigger requires "left" to precede "at first", so this declines.
  const reversedOrder = "Peter had 50 apples at first. He ate 10 apples, then gave away 5 more. How many apples does he have left?";
  const r = worker.verifySpentPlusRemainingEqualsOriginal(reversedOrder, "65");
  assert.equal(r.correct, null);
});

test("verifyBasePlusMultipleOfBaseTotal: total-keyword before the multiplier phrase (reversed order) declines", () => {
  // "合共" appears BEFORE "的3倍" here, unlike every real citation (where
  // the total keyword always follows the multiplier phrase). Old
  // order-blind trigger would have fired anyway; hardened trigger checks
  // for the total keyword only in the text AFTER the multiplier match.
  const reversedOrder = "他們合共有20蘋果，然後哥哥買的香蕉數量是細佬的3倍。";
  const r = worker.verifyBasePlusMultipleOfBaseTotal(reversedOrder, "80");
  assert.equal(r.correct, null);
});

test("verifyDailyRateSumTimesWeek: '一星期共' before '每天'/'又' (reversed order) declines", () => {
  // Old order-blind trigger (three independent .test() calls) would have
  // fired on this reversed-order sentence too; hardened trigger requires
  // the real citations' own left-to-right order (每天 ... 又 ... 一星期共).
  const reversedOrder = "佳文一星期共用15.75小時溫習，她每天又睇電視。";
  const r = worker.verifyDailyRateSumTimesWeek(reversedOrder, "15.75");
  assert.equal(r.correct, null);
});

test("verifyPercentageDiscountZhe: 'X折' before '原價' (reversed order) declines", () => {
  // Old order-blind trigger (/原價/ and /折/ independently) would have
  // fired here too; hardened trigger requires 原價 to precede X折.
  const reversedOrder = "凱晴以七折購買這條裙子，裙子原價是160元，須付___元。";
  const r = worker.verifyPercentageDiscountZhe(reversedOrder, "112");
  assert.equal(r.correct, null);
});

// ---------- Full-codebase order-risk audit, 2026-10-02 ----------
// The user asked for ALL existing handlers (not just the 7 TSA types
// above) to be checked for the same order-blind keyword risk. A static
// scan of all 138 registered handlers flagged 33 with 2+ independent
// regex checks; manual review found most were false positives (counting
// checks, OCR-field gates, or already order-aware extraction) but 2 more
// genuine risks, now hardened the same way.

test("verifyChineseLargeNumeralToArabic: unrelated quote before '阿拉伯數字' no longer grabs the wrong span", () => {
  // Old trigger independently checked for "阿拉伯數字" anywhere and the
  // FIRST「」quote anywhere -- an earlier, unrelated quoted span would
  // have been grabbed instead of the real numeral. Hardened to require
  // the quote to be the first one AFTER "阿拉伯數字".
  const unrelatedQuoteFirst = "請把「你好」譯做英文。然後以阿拉伯數字寫出「五億零八百萬零二十」。";
  const r = worker.verifyChineseLargeNumeralToArabic(unrelatedQuoteFirst, "508000020");
  assert.equal(r.correct, true);
});

test("verifyWordProblemRateMultiplication: '共' before '每' (reversed order) declines", () => {
  // Real citation always has 每 before 共 ("小克每天儲蓄30元，他五天共
  // 儲蓄多少元？"); old trigger was order-blind. Hardened to require
  // that order.
  const reversedOrder = "他五天共儲蓄多少元？小克每天儲蓄30元。";
  const r = worker.verifyWordProblemRateMultiplication(reversedOrder, "150");
  assert.equal(r.correct, null);
});

// ---------- Diagram-question survey, 2026-10-02 ----------
// User asked to study every question across all 36 TSA papers that
// needs the actual image/diagram to solve (not just text), and check
// whether existing handlers cover them. Found: the TSA archive's own
// "陰影部分佔全圖的幾分之幾/百分之幾" shaded-fraction picture question
// (extremely frequent, appears in nearly every paper) was NOT covered by
// the existing fraction_shading handler -- that one only matched a
// different real worksheet's "有色部分" wording. These tests only check
// the TEXT-level trigger (isFractionShadingQuestion/
// isPercentageShadingQuestion/the registry detect()) against real TSA
// citation text -- the actual pixel-measurement computation inside
// verifyFractionShading needs a real cropped image, which this text-only
// PDF extraction does not have, so that part is NOT verified here.

test("isFractionShadingQuestion: real TSA citation ('陰影部分佔全圖的幾分之幾') now triggers", () => {
  const tsaQ = "下圖中的陰影部分佔全圖的幾分之幾？                答案：陰影部分佔全圖的       。";
  assert.equal(worker.isFractionShadingQuestion({ printedQuestion: tsaQ }), true);
});

test("isPercentageShadingQuestion: real TSA citation ('陰影部分佔全圖的百分之幾') triggers", () => {
  const tsaQ = "下圖陰影部分佔全圖的百分之幾？                           答案：陰影部分佔全圖的 ____________  %。";
  assert.equal(worker.isPercentageShadingQuestion({ printedQuestion: tsaQ }), true);
});

test("fraction_shading handler: real TSA percentage citation now reaches the dispatcher", () => {
  const tsaQ = "下圖陰影部分佔全圖的百分之幾？";
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "fraction_shading");
  assert.ok(handler, "handler must be registered");
  assert.equal(handler.detect({ printedQuestion: tsaQ }), true);
});

test("isFractionShadingQuestion: original 有色部分 citation still works (no regression)", () => {
  assert.equal(worker.isFractionShadingQuestion({ printedQuestion: "有色部分佔全圖的幾分之幾？" }), true);
});

// ---------- Full-archive years survey (2004-2021), 2026-10-02 ----------
// User asked for ALL years of the maths archive (not just 2022-2024) to
// be reviewed. Downloaded 216 PDFs across 2005-2021 (2004 and 2020 have
// no maths papers published -- confirmed via the real HKEAA index pages,
// not a download failure). Scanned all 368 paper PDFs' real text through
// the ACTUAL QUESTION_TYPE_HANDLERS dispatch table (not a re-implemented
// approximation) to separate already-covered from genuinely new shapes.

// ---------- direct_hcf / direct_lcm ----------
// Real citations: tsa/2013/TSA2013_6MC1.txt Q4 (18,48)->6;
// tsa/2014/TSA2014_6MC3.txt Q4 (24,36)->12; tsa/2015/TSA2015_6MC2.txt Q4
// (24,96)->24; tsa/2018/TSA2018_6MC1.txt Q4 (16,24)->8 (direct HCF, 8
// total occurrences across the archive); tsa/2014/TSA2014_6MC1.txt Q4
// (15,24)->120; tsa/2015/TSA2015_6MC2.txt Q3 (4,46)->92 (direct LCM).

test("verifyDirectHcf: real citation (18,48), correct answer", () => {
  const r = worker.verifyDirectHcf("18 和48 的最大公因數 (H. C. F.) 是 __________ 。", "6");
  assert.equal(r.correct, true);
});

test("verifyDirectHcf: real citation (24,96), wrong answer", () => {
  const r = worker.verifyDirectHcf("24 和96 的最大公因數 (H. C. F.) 是 。", "12");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "24");
});

test("direct_hcf handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: "16 和24 的最大公因數 (H. C. F.) 是 。", studentAnswer: "8" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "direct_hcf");
});

test("verifyDirectLcm: real citation (15,24), correct answer", () => {
  const r = worker.verifyDirectLcm("15 和24 的最小公倍數 (L. C. M.) 是 。", "120");
  assert.equal(r.correct, true);
});

test("verifyDirectLcm: real citation (4,46), wrong answer", () => {
  const r = worker.verifyDirectLcm("4 和46 的最小公倍數 (L.C.M.) 是 。", "46");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "92");
});

test("direct_lcm handler: registered, reachable, wins dispatch (not first_n_common_multiples)", () => {
  const item = { printedQuestion: "15 和24 的最小公倍數 (L. C. M.) 是 。", studentAnswer: "120" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "direct_lcm");
});

// English-coverage audit (2026-10-03): the registry's `detect` for both
// of these is an INLINE Chinese-only regex (not a shared isXxxQuestion
// function), so widening verifyDirectHcf/verifyDirectLcm's own regex
// alone was not enough -- the registry entry itself needed widening too.
// English equivalents: `tsa/2013/TSA2013_6ME1.pdf` Q4 "The Highest
// Common Factor (H.C.F.) of 18 and 48 is ." (translation of this
// function's own `tsa/2013/TSA2013_6MC1.pdf` Q4 citation), and
// `tsa/2014/TSA2014_6ME1.pdf` Q4 "The Least Common Multiple (L.C.M.) of
// 15 and 24 is ." (translation of `tsa/2014/TSA2014_6MC1.pdf` Q4).
test("verifyDirectHcf: English citation (tsa/2013/TSA2013_6ME1.pdf Q4), correct answer", () => {
  const r = worker.verifyDirectHcf("4. The Highest Common Factor (H.C.F.) of 18 and 48 is .", "6");
  assert.equal(r.correct, true);
});

test("direct_hcf handler: English citation, registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: "4. The Highest Common Factor (H.C.F.) of 18 and 48 is .", studentAnswer: "6" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "direct_hcf");
});

test("verifyDirectLcm: English citation (tsa/2014/TSA2014_6ME1.pdf Q4), correct answer", () => {
  const r = worker.verifyDirectLcm("4. The Least Common Multiple (L.C.M.) of 15 and 24 is .", "120");
  assert.equal(r.correct, true);
});

test("direct_lcm handler: English citation, registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: "4. The Least Common Multiple (L.C.M.) of 15 and 24 is .", studentAnswer: "120" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "direct_lcm");
});

// ---------- arabic_to_chinese_numeral ----------
// Real citations: tsa/2014/TSA2014_3MC4.txt Q2 "用中國數字寫出「13 849」
// 這個數。" -> 一萬三千八百四十九; tsa/2015/TSA2015_3MC3.txt Q2 "用中國
// 數字寫出「56 509」這個數。" -> 五萬六千五百零九.

test("arabicToChineseLargeNumber: boundary case with internal AND cross-萬 zero gaps", () => {
  // Not from a real citation -- a targeted boundary check for the 零-
  // insertion rule (50008 needs a zero both after 萬 and mid-group).
  assert.equal(worker.arabicToChineseLargeNumber(50008), "五萬零八");
});

test("verifyArabicToChineseNumeral: real citation (13849), correct answer", () => {
  const r = worker.verifyArabicToChineseNumeral("用中國數字寫出「13 849」這個數。 答案：", "一萬三千八百四十九");
  assert.equal(r.correct, true);
});

test("verifyArabicToChineseNumeral: real citation (56509), correct answer", () => {
  const r = worker.verifyArabicToChineseNumeral("用中國數字寫出「56 509」這個數。 答案：", "五萬六千五百零九");
  assert.equal(r.correct, true);
});

test("verifyArabicToChineseNumeral: 大寫 (financial) form also accepted, per the real official marking scheme's own note", () => {
  // Both tsa/2014/TSA2014_3MC4_MS.pdf Q2 and tsa/2015/TSA2015_3MC3_MS.pdf
  // Q2 explicitly say "可接受大寫，不接受錯別字" -- verified directly
  // against the real marking scheme PDFs, not assumed.
  const r = worker.verifyArabicToChineseNumeral("用中國數字寫出「13 849」這個數。", "壹萬參仟捌佰肆拾玖");
  assert.equal(r.correct, true);
});

test("verifyArabicToChineseNumeral: hardened against trailing punctuation a student might naturally add", () => {
  const r = worker.verifyArabicToChineseNumeral("用中國數字寫出「13 849」這個數。 答案：", "一萬三千八百四十九。");
  assert.equal(r.correct, true);
});

test("verifyArabicToChineseNumeral: real citation (56509), wrong answer", () => {
  const r = worker.verifyArabicToChineseNumeral("用中國數字寫出「56 509」這個數。 答案：", "五萬六千五百九");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "五萬六千五百零九");
});

test("arabic_to_chinese_numeral handler: registered, reachable, wins dispatch (not chinese_large_numeral_to_arabic)", () => {
  const item = { printedQuestion: "用中國數字寫出「13 849」這個數。", studentAnswer: "一萬三千八百四十九" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "arabic_to_chinese_numeral");
});

// ---------- two_factor_ceiling_division ----------
// Real citation: tsa/2012/2012_TSA_6MC2.txt Q17 "每本相簿有15頁，每頁
// 放相片4張。要放相片300張，需用相簿多少本？" -> ceil(300/(15×4))=5.
const ALBUM_Q = "每本相簿有15 頁，每頁放相片4 張。要放相片300 張，需用相簿多少本？ 答案：需用相簿 ____________ 本。";

test("verifyTwoFactorCeilingDivision: real citation, correct answer", () => {
  const r = worker.verifyTwoFactorCeilingDivision(ALBUM_Q, "5");
  assert.equal(r.correct, true);
});

test("verifyTwoFactorCeilingDivision: real citation, wrong answer (plain division without ceiling)", () => {
  const r = worker.verifyTwoFactorCeilingDivision(ALBUM_Q, "4");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "5");
});

test("two_factor_ceiling_division handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: ALBUM_Q, studentAnswer: "5" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "two_factor_ceiling_division");
});

// ---------- two_step_average_division ----------
// Real citation: tsa/2013/TSA2013_6MC4.txt Q14 "哥哥收集了540枚郵票。
// 他把郵票放在3本集郵簿內，每本集郵簿有12頁。平均每頁有多少枚郵票？"
// -> 540/(3×12)=15.
const STAMP_Q = "哥哥收集了540 枚郵票。他把郵票放在3 本集郵簿內，每本集郵簿有12 頁。平均每頁有多少枚郵票？ 答案：平均每頁有 枚郵票。";

test("verifyTwoStepAverageDivision: real citation, correct answer", () => {
  const r = worker.verifyTwoStepAverageDivision(STAMP_Q, "15");
  assert.equal(r.correct, true);
});

test("two_step_average_division handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: STAMP_Q, studentAnswer: "15" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "two_step_average_division");
});

// ---------- simple_average_division ----------
// Real citation: tsa/2012/2012_TSA_6MC4.txt Q14 "一疊50張卡紙的厚度是
// 6.8cm，平均每張卡紙的厚度是___cm。(答案取至小數點後兩個位)" ->
// 6.8/50=0.136, rounded to 2dp -> 0.14.
const CARDSTOCK_Q = "一疊50 張卡紙的厚度是6.8 cm，平均每張卡紙的厚度是 ________ cm。(答案取至小數點後兩個位)";

test("verifySimpleAverageDivision: real citation, correct answer (rounded to 2dp)", () => {
  const r = worker.verifySimpleAverageDivision(CARDSTOCK_Q, "0.14");
  assert.equal(r.correct, true);
});

test("verifySimpleAverageDivision: real citation, wrong answer (unrounded)", () => {
  const r = worker.verifySimpleAverageDivision(CARDSTOCK_Q, "0.136");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "0.14");
});

test("simple_average_division handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: CARDSTOCK_Q, studentAnswer: "0.14" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "simple_average_division");
});

// ---------- multi_person_fare_split ----------
// Real citation: tsa/2013/TSA2013_3MC2.txt Q15 (image caption) "乘車優惠
// 4人同行共須42元" + "子恩和三位朋友一起乘車，平均每人須付___元___角。"
// -> 42÷4=10.5元=10元5角.
const FARE_Q = "乘車優惠 4人同行共須42 元 子恩和三位朋友一起乘車，平均每人須付        元        角。";

test("verifyMultiPersonFareSplit: real citation, correct answer", () => {
  const r = worker.verifyMultiPersonFareSplit(FARE_Q, "10,5");
  assert.equal(r.correct, true);
});

test("verifyMultiPersonFareSplit: real citation, wrong answer", () => {
  const r = worker.verifyMultiPersonFareSplit(FARE_Q, "10,50");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "10;5");
});

test("multi_person_fare_split handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: FARE_Q, studentAnswer: "10,5" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "multi_person_fare_split");
});

// ---------- change_from_rate_multiplication ----------
// Real citation: tsa/2021/2021_3MC1.txt Q11 "每枝鮮花售7元，富榮買4枝
// 鮮花，付款100元。店員應找回多少元？" -> 100-7×4=72. Verified against
// the real official marking scheme (2021_3MC1_MS.pdf), which shows the
// identical working "100 – 7 × 4 = 72".
const FLOWER_Q = "每枝鮮花售7 元，富榮買4 枝鮮花，付款100 元。 店員應找回多少元？ （列式計算）";

test("verifyChangeFromRateMultiplication: real citation, correct answer", () => {
  const r = worker.verifyChangeFromRateMultiplication(FLOWER_Q, "72");
  assert.equal(r.correct, true);
});

test("verifyChangeFromRateMultiplication: real citation, wrong answer", () => {
  const r = worker.verifyChangeFromRateMultiplication(FLOWER_Q, "28");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "72");
});

test("change_from_rate_multiplication handler: registered, reachable, wins dispatch (not word_problem_division)", () => {
  const item = { printedQuestion: FLOWER_Q, studentAnswer: "72" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "change_from_rate_multiplication");
});

// ---------- word_problem_more_than widened to the full comparative-adjective family ----------
// Real citation: tsa/2018/TSA2018_3MC3.txt Q9 / tsa/2018/TSA2018_3MC4.txt
// Q9 "惠芳身高152厘米，浩恩比她矮38厘米。浩恩身高___厘米。" -> 152-38=114.
// Previously only 多/少 were recognised; 矮 (shorter) carries the exact
// same "fewer" arithmetic.
const HEIGHT_Q = "惠芳身高152 厘米，浩恩比她矮38 厘米。 浩恩身高 __________ 厘米。";

test("verifyWordProblemMoreThan: real citation with 矮 (not 多/少), correct answer", () => {
  const r = worker.verifyWordProblemMoreThan(HEIGHT_Q, "114");
  assert.equal(r.correct, true);
});

test("word_problem_more_than handler: 矮 citation wins dispatch", () => {
  const item = { printedQuestion: HEIGHT_Q, studentAnswer: "114" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "word_problem_more_than");
});

// ---------- pie_chart_query ----------
// Real citation verified against the official marking scheme
// (`tsa/2023/p6_marking_TSA2023_6MC2_MS.pdf` Q38, answers (a) 的士,12
// (b) 40): "昨天有120輛汽車停泊在陽光停車場。李先生統計了各種汽車的
// 數量，並製作了以下的圓形圖。(a)停車場內數量最少的汽車是___，只有
// ___輛。(b)小型巴士及私家車佔全部汽車的___%。" with 貨車=20%,的士=10%,
// 小型巴士=25%,私家車=15%,客貨車=30% (this citation's own label/
// percentage pairing was independently confirmed reliable against the
// official answer -- see verifyPieChart's own comment for the OTHER
// citation where positional pairing was NOT reliable).
const CAR_PIE_Q = "昨天有120 輛汽車停泊在陽光停車場。李先生統計了 各種汽車的數量，並製作了以下的圓形圖。 (a)  停車場內數量最少的汽車是              ， 只有            輛。";
const CAR_PIE_CHART = { 貨車: 0.20, 的士: 0.10, 小型巴士: 0.25, 私家車: 0.15, 客貨車: 0.30 };

test("verifyPieChart: real citation, min-category extraction, correct answer", () => {
  const r = worker.verifyPieChart(CAR_PIE_CHART, CAR_PIE_Q, "的士，12");
  assert.equal(r.correct, true);
});

test("verifyPieChart: real citation, min-category extraction, wrong count", () => {
  const r = worker.verifyPieChart(CAR_PIE_CHART, CAR_PIE_Q, "的士，20");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "的士，12");
});

const CAR_PIE_SUM_Q = "(b)  小型巴士及私家車佔全部汽車的            %。";

test("verifyPieChart: real citation, sum-of-two-categories, correct answer", () => {
  const r = worker.verifyPieChart(CAR_PIE_CHART, CAR_PIE_SUM_Q, "40");
  assert.equal(r.correct, true);
});

// Ratio sub-shape verified against `tsa/2024/p6_marking_TSA2024_6MC3_MS.pdf`
// Q38(b) = 1/4 -- using representative fractions in that exact ratio
// (this round's PDF-text survey could not reliably recover the real
// diagram's own degree values for this specific citation -- see
// verifyPieChart's own comment).
const GAME_RATIO_Q = "(b) 最喜愛拼圖遊戲的顧客人數是最喜愛體育遊戲的 幾分之幾？";
const GAME_PIE_CHART = { 拼圖: 30 / 360, 體育: 120 / 360 };

test("verifyPieChart: ratio sub-shape, correct answer", () => {
  const r = worker.verifyPieChart(GAME_PIE_CHART, GAME_RATIO_Q, "1/4");
  assert.equal(r.correct, true);
});

test("verifyPieChart: ratio sub-shape, hardened against surrounding text a student might naturally add", () => {
  const r = worker.verifyPieChart(GAME_PIE_CHART, GAME_RATIO_Q, "答案：1/4。");
  assert.equal(r.correct, true);
});

test("verifyPieChart: ratio sub-shape, wrong answer", () => {
  const r = worker.verifyPieChart(GAME_PIE_CHART, GAME_RATIO_Q, "1/3");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "1/4");
});

test("extractPieChart: parses a real PIE_CHART marker line (degrees), strips it from cleanedText", () => {
  const text = "PIE_CHART: 拼圖=30°;體育=120°\n其他文字";
  const { pieChart, cleanedText } = worker.extractPieChart(text);
  assert.deepEqual(pieChart, { 拼圖: 30 / 360, 體育: 120 / 360 });
  assert.ok(!cleanedText.includes("PIE_CHART"));
});

test("extractPieChart: parses a real PIE_CHART marker line (percentages)", () => {
  const { pieChart } = worker.extractPieChart("PIE_CHART: 貨車=20%;的士=10%");
  assert.deepEqual(pieChart, { 貨車: 0.2, 的士: 0.1 });
});

test("pie_chart_query handler: registered, reachable, wins dispatch", () => {
  const item = { pieChart: CAR_PIE_CHART, printedQuestion: CAR_PIE_Q, studentAnswer: "的士，12" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "pie_chart_query");
});

test("pie_chart_query handler: declines when item.pieChart is absent (no OCR marker fired)", () => {
  const item = { printedQuestion: CAR_PIE_Q, studentAnswer: "的士，12" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.notEqual(winner && winner.name, "pie_chart_query");
});

// ---------- Circle-geometry closed-form facts, 2026-10-02 ----------
// Found while planning the circle-diagram OCR contract: these 3 shapes
// turned out to need NO image/OCR data at all -- pure geometric facts
// provable from the "O是圓心" labelling alone. All verified against
// their own real official marking schemes.

// two_radii_triangle_type
const RADII_ISOSCELES_Q = "老師畫了一個三角形和一個圓，O是圓心。 (a) 老師畫了一個 * 直角 / 等腰 / 等邊  三角形。 (*圈出答案)";
const RADII_EQUILATERAL_Q = "老師畫了一個三角形和一個圓，O是圓心。 OA 和AB 的長度相等。 (a) 老師畫了一個 * 直角 / 等腰 / 等邊  三角形。 (*圈出答案)";

test("verifyTwoRadiiTriangleType: real citation (no extra constraint), correct answer is 等腰", () => {
  const r = worker.verifyTwoRadiiTriangleType({ printedQuestion: RADII_ISOSCELES_Q, studentAnswer: "等腰" });
  assert.equal(r.correct, true);
});

test("verifyTwoRadiiTriangleType: real citation (no extra constraint), wrong answer 等邊 declined as incorrect", () => {
  const r = worker.verifyTwoRadiiTriangleType({ printedQuestion: RADII_ISOSCELES_Q, studentAnswer: "等邊" });
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "等腰");
});

test("verifyTwoRadiiTriangleType: real citation with 'OA和AB的長度相等' -> correct answer is 等邊", () => {
  const r = worker.verifyTwoRadiiTriangleType({ printedQuestion: RADII_EQUILATERAL_Q, studentAnswer: "等邊" });
  assert.equal(r.correct, true);
});

test("two_radii_triangle_type handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: RADII_ISOSCELES_Q, studentAnswer: "等腰" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "two_radii_triangle_type");
});

// diameter_is_twice_radius
const DIAMETER_TWICE_Q = "老師畫了一個三角形和一個圓，O是圓心。 OA 和AB 的長度相等。 (b) 圓的直徑是OA 長度的         倍。";

test("verifyDiameterIsTwiceRadius: real citation, correct answer", () => {
  const r = worker.verifyDiameterIsTwiceRadius({ printedQuestion: DIAMETER_TWICE_Q, studentAnswer: "2" });
  assert.equal(r.correct, true);
});

test("verifyDiameterIsTwiceRadius: real citation, wrong answer", () => {
  const r = worker.verifyDiameterIsTwiceRadius({ printedQuestion: DIAMETER_TWICE_Q, studentAnswer: "3" });
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "2");
});

test("diameter_is_twice_radius handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: DIAMETER_TWICE_Q, studentAnswer: "2" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "diameter_is_twice_radius");
});

// centre_segment_is_radius
const CENTRE_SEGMENT_Q = "下圖中，O 點是圓心。 (a)  OY 是圓的 ________________。";

test("verifyCentreSegmentIsRadius: real citation, correct answer", () => {
  const r = worker.verifyCentreSegmentIsRadius({ printedQuestion: CENTRE_SEGMENT_Q, studentAnswer: "半徑" });
  assert.equal(r.correct, true);
});

test("verifyCentreSegmentIsRadius: real citation, wrong answer (直徑)", () => {
  const r = worker.verifyCentreSegmentIsRadius({ printedQuestion: CENTRE_SEGMENT_Q, studentAnswer: "直徑" });
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "半徑");
});

test("centre_segment_is_radius handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: CENTRE_SEGMENT_Q, studentAnswer: "半徑" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "centre_segment_is_radius");
});

test("isCentreSegmentIsRadiusQuestion: does not fire on an unrelated blank with a different starting letter", () => {
  // Centre is O, but the blank asks about segment "XY" (doesn't start
  // with the centre's own letter) -- must not assume it's a radius.
  const unrelated = "下圖中，O 點是圓心。 (a)  XY 是圓的 ________________。";
  assert.equal(worker.isCentreSegmentIsRadiusQuestion({ printedQuestion: unrelated }), false);
});

// English-coverage audit (2026-10-03): the user explicitly asked whether
// written code was verified against real English-medium papers too.
// Resolved the earlier blocker -- TSA's "6ME" series is the official
// English translation of the matching "6MC" Chinese paper, confirmed by
// reading `tsa/2024/p6_paper_TSA2024_6ME1.pdf`'s own cover page. These 3
// English citations are the exact translated equivalents of the 3
// Chinese ones above: `tsa/2016/TSA2016_6ME1.pdf` Q28, `6ME2.pdf` Q31,
// and `tsa/2013/TSA2013_6ME2.pdf` Q33 -- empirically confirmed (before
// this fix) that all 3 Chinese-only detect()s silently fell through to
// AI fallback on these, despite citing the exact same real exam question.
const RADII_ISOSCELES_Q_EN = "A teacher drew a triangle and a circle. O is the centre of the circle. (a) The teacher drew * a right-angled / an isosceles / an equilateral triangle. (*Circle the answer)";
const RADII_EQUILATERAL_Q_EN = "A teacher drew a triangle and a circle. O is the centre of the circle. OA and AB are equal in length. (a) The teacher drew * a right-angled / an isosceles / an equilateral triangle.";

test("verifyTwoRadiiTriangleType: English citation (tsa/2016/TSA2016_6ME1.pdf Q28), correct answer is isosceles", () => {
  const r = worker.verifyTwoRadiiTriangleType({ printedQuestion: RADII_ISOSCELES_Q_EN, studentAnswer: "isosceles" });
  assert.equal(r.correct, true);
});

test("verifyTwoRadiiTriangleType: English citation, wrong answer 'equilateral' declined as incorrect", () => {
  const r = worker.verifyTwoRadiiTriangleType({ printedQuestion: RADII_ISOSCELES_Q_EN, studentAnswer: "equilateral" });
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "isosceles");
});

test("verifyTwoRadiiTriangleType: English citation with 'OA and AB are equal in length' -> correct answer is equilateral", () => {
  const r = worker.verifyTwoRadiiTriangleType({ printedQuestion: RADII_EQUILATERAL_Q_EN, studentAnswer: "equilateral" });
  assert.equal(r.correct, true);
});

test("two_radii_triangle_type handler: English citation, registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: RADII_ISOSCELES_Q_EN, studentAnswer: "isosceles" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "two_radii_triangle_type");
});

const DIAMETER_TWICE_Q_EN = "A teacher drew a triangle and a circle. O is the centre of the circle. OA and AB are equal in length. (b) The diameter of the circle is ___________ times the length of OA.";

test("verifyDiameterIsTwiceRadius: English citation (tsa/2016/TSA2016_6ME2.pdf Q31b), correct answer", () => {
  const r = worker.verifyDiameterIsTwiceRadius({ printedQuestion: DIAMETER_TWICE_Q_EN, studentAnswer: "2" });
  assert.equal(r.correct, true);
});

test("diameter_is_twice_radius handler: English citation, registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: DIAMETER_TWICE_Q_EN, studentAnswer: "2" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "diameter_is_twice_radius");
});

const CENTRE_SEGMENT_Q_EN = "In the figure below, O is the centre. (a) OY is the ________________ of the circle.";

test("verifyCentreSegmentIsRadius: English citation (tsa/2013/TSA2013_6ME2.pdf Q33a), correct answer", () => {
  const r = worker.verifyCentreSegmentIsRadius({ printedQuestion: CENTRE_SEGMENT_Q_EN, studentAnswer: "radius" });
  assert.equal(r.correct, true);
});

test("verifyCentreSegmentIsRadius: English citation, wrong answer (diameter)", () => {
  const r = worker.verifyCentreSegmentIsRadius({ printedQuestion: CENTRE_SEGMENT_Q_EN, studentAnswer: "diameter" });
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "radius");
});

test("centre_segment_is_radius handler: English citation, registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: CENTRE_SEGMENT_Q_EN, studentAnswer: "radius" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "centre_segment_is_radius");
});

// chord_shorter_than_diameter -- found 2026-10-03 while reading the
// official English curriculum doc (pmc2017_e.pdf), which states the
// general rule: "line segments joining any two end points on a circle,
// those passing through the centre are the longest" (diameter = longest
// chord). Same real diagram as two_radii_triangle_type above, part (c)
// of the SAME real question -- `tsa/2016/TSA2016_6MC1.pdf` Q28(c) "AB
// 的長度 * 小於 / 等於 / 大於 圓的直徑。" -> official answer "小於"
// (`2016/TSA2016_6MC1_MS.pdf`); English equivalent
// `tsa/2016/TSA2016_6ME1.pdf` Q28(c).
const CHORD_Q = "老師畫了一個三角形和一個圓，O 是圓心。 (c) AB 的長度 * 小於 / 等於 / 大於 圓的直徑。 (*圈出答案)";
const CHORD_Q_EN = "A teacher drew a triangle and a circle. O is the centre of the circle. (c) The length of AB is * smaller than / equal to / larger than the diameter of the circle. (*Circle the answer)";

test("verifyChordShorterThanDiameter: real citation, correct answer 小於", () => {
  const r = worker.verifyChordShorterThanDiameter({ printedQuestion: CHORD_Q, studentAnswer: "小於" });
  assert.equal(r.correct, true);
});

test("verifyChordShorterThanDiameter: real citation, wrong answer 等於 declined as incorrect", () => {
  const r = worker.verifyChordShorterThanDiameter({ printedQuestion: CHORD_Q, studentAnswer: "等於" });
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "小於");
});

test("chord_shorter_than_diameter handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: CHORD_Q, studentAnswer: "小於" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "chord_shorter_than_diameter");
});

test("verifyChordShorterThanDiameter: English citation, correct answer", () => {
  const r = worker.verifyChordShorterThanDiameter({ printedQuestion: CHORD_Q_EN, studentAnswer: "smaller" });
  assert.equal(r.correct, true);
});

test("verifyChordShorterThanDiameter: English citation, wrong answer declined as incorrect", () => {
  const r = worker.verifyChordShorterThanDiameter({ printedQuestion: CHORD_Q_EN, studentAnswer: "larger" });
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "smaller");
});

test("chord_shorter_than_diameter handler: English citation, registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: CHORD_Q_EN, studentAnswer: "smaller" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "chord_shorter_than_diameter");
});

test("isChordShorterThanDiameterQuestion: does not fire when the compared segment includes the centre's own letter (it would be the diameter itself, not a chord)", () => {
  const notAChord = "老師畫了一個三角形和一個圓，O 是圓心。 (c) OA 的長度 * 小於 / 等於 / 大於 圓的直徑。 (*圈出答案)";
  assert.equal(worker.isChordShorterThanDiameterQuestion({ printedQuestion: notAChord }), false);
});

// circumference_from_diameter_integer / diameter_from_circumference_integer
// -- found 2026-10-03, prompted directly by the user flagging pmc2017_e.pdf's
// explicit constraint: "Students are only required to use 22/7 or 3.14
// as approximate values of π for calculations." All 3 real citations
// below give the SAME rounded integer under both approximations.
const CIRCUMFERENCE_Q = "小亮在正方形內畫了一個最大的圓(如上圖)，圓的 直徑是2 cm。 (a) 圓周約是 cm。(以整數作答)";
const CIRCUMFERENCE_Q_EN = "The diameter of the circle is 2 cm. (a) The circumference of the circle is about cm. (Give the answer as a whole number)";

test("verifyCircumferenceFromDiameterInteger: real citation (tsa/2016/TSA2016_6MC3.pdf Q21a), correct answer", () => {
  const r = worker.verifyCircumferenceFromDiameterInteger({ printedQuestion: CIRCUMFERENCE_Q, studentAnswer: "6" });
  assert.equal(r.correct, true);
});

test("verifyCircumferenceFromDiameterInteger: real citation, wrong answer", () => {
  const r = worker.verifyCircumferenceFromDiameterInteger({ printedQuestion: CIRCUMFERENCE_Q, studentAnswer: "7" });
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "6");
});

test("circumference_from_diameter_integer handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: CIRCUMFERENCE_Q, studentAnswer: "6" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "circumference_from_diameter_integer");
});

test("verifyCircumferenceFromDiameterInteger: English citation (tsa/2016/TSA2016_6ME3.pdf Q21a), correct answer", () => {
  const r = worker.verifyCircumferenceFromDiameterInteger({ printedQuestion: CIRCUMFERENCE_Q_EN, studentAnswer: "6" });
  assert.equal(r.correct, true);
});

test("circumference_from_diameter_integer handler: English citation, registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: CIRCUMFERENCE_Q_EN, studentAnswer: "6" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "circumference_from_diameter_integer");
});

const IRON_WIRE_Q_2018 = "把一條長15 cm 的鐵線，製成一個圓形的鐵圈。 鐵圈的直徑約是 cm。(以整數作答)";
const IRON_WIRE_Q_2018_EN = "An iron wire 15 cm long is bent into a circular coil. The diameter of the circular coil is about cm. (Give the answer as a whole number)";
const IRON_WIRE_Q_2019 = "把一個鐵圈剪開後，拉直成一條鐵線(如上圖所示)。 鐵線的長度是19 cm，鐵圈的直徑約是 cm。 (以整數作答)";
const IRON_WIRE_Q_2019_EN = "An iron wire is made by cutting an iron coil (as shown in the diagram above). The length of the iron wire is 19 cm. The diameter of the iron coil is about cm. (Give the answer as a whole number)";

test("verifyDiameterFromCircumferenceInteger: real citation (tsa/2018/TSA2018_6MC1.pdf Q25, '長Xcm的鐵線' phrasing), correct answer", () => {
  const r = worker.verifyDiameterFromCircumferenceInteger({ printedQuestion: IRON_WIRE_Q_2018, studentAnswer: "5" });
  assert.equal(r.correct, true);
});

test("verifyDiameterFromCircumferenceInteger: English citation (tsa/2018/TSA2018_6ME1.pdf Q25), correct answer", () => {
  const r = worker.verifyDiameterFromCircumferenceInteger({ printedQuestion: IRON_WIRE_Q_2018_EN, studentAnswer: "5" });
  assert.equal(r.correct, true);
});

test("verifyDiameterFromCircumferenceInteger: real citation (tsa/2019/TSA2019_6MC1.pdf Q25, '鐵線的長度是X' phrasing), correct answer", () => {
  const r = worker.verifyDiameterFromCircumferenceInteger({ printedQuestion: IRON_WIRE_Q_2019, studentAnswer: "6" });
  assert.equal(r.correct, true);
});

test("verifyDiameterFromCircumferenceInteger: real citation, wrong answer", () => {
  const r = worker.verifyDiameterFromCircumferenceInteger({ printedQuestion: IRON_WIRE_Q_2019, studentAnswer: "7" });
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "6");
});

test("verifyDiameterFromCircumferenceInteger: English citation (tsa/2019/TSA2019_6ME1.pdf Q25), correct answer", () => {
  const r = worker.verifyDiameterFromCircumferenceInteger({ printedQuestion: IRON_WIRE_Q_2019_EN, studentAnswer: "6" });
  assert.equal(r.correct, true);
});

test("diameter_from_circumference_integer handler: registered, reachable, wins dispatch", () => {
  const item = { printedQuestion: IRON_WIRE_Q_2019, studentAnswer: "6" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "diameter_from_circumference_integer");
});
