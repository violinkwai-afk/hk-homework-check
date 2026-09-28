// Ticket 37 (2026-09-27): a permanent regression fixture built from
// REAL raw OCR text that has actually broken parseOcrLine or the OCR
// prompt's own format contract in production this session. Every case
// here is a genuine raw model reply captured via a diagnostic route
// during real debugging, not a synthetic guess at what might go wrong.
//
// Why this exists: two separate real bugs this session (Ticket 26's
// "no pipe on bare-arithmetic questions" and Ticket 31's "newline
// instead of comma between items") were both prompt-wording regressions
// that could ONLY be caught by spending real money on a live test and
// noticing the output looked wrong. Running this fixture costs nothing
// and takes milliseconds -- it should be run (and extended with any
// NEW real raw-text failure found in the future) before trusting any
// change to OCR_ONLY_PROMPT or parseOcrLine itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_ocrregress.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_ocrregress.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_ocrregress.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

let mod;
test.before(async () => { mod = await import(TMP); });

test("Ticket 31 real regression: Gemini used newlines instead of commas between items on a multi-item passage page -- must not swallow later items into the first one's answer", () => {
  // Captured 2026-09-27 via a raw-text debug route, real photo (math
  // word problems). Each individual item was well-formed
  // ("label=printed|answer"), but joined by "\n" instead of ",".
  const raw = "9=A teacher divides 53 bookmarks equally among 7 pupils. How many bookmarks does each pupil get? How many bookmarks are left?|53÷7=7...4;7;4\n10=Pack 48 pieces of sushi into boxes of 5. To pack all the pieces of sushi, at least how many boxes are needed?|48÷5=9...3;9 boxes are needed.;3 pieces are left.\n11=Ivy takes 4 minutes to fold a paper crane. How many paper cranes can she fold in half an hour? How many minutes are left?|30÷4=7...2;She can fold 7 paper cranes in half an hour;2 minutes are left.";
  const items = mod.parseOcrLine(raw);
  assert.equal(items.length, 3, "all 3 items must be split, none swallowed into another");
  assert.equal(items[0].label, "9");
  assert.equal(items[0].studentAnswer, "53÷7=7...4;7;4");
  assert.equal(items[1].label, "10");
  assert.match(items[1].printedQuestion, /Pack 48 pieces of sushi/);
  assert.equal(items[2].label, "11");
  assert.match(items[2].studentAnswer, /2 minutes are left/);
});

test("Ticket 26 real regression (pre-fix raw shape): bare arithmetic questions with NO pipe at all must be recognized as unparseable (0 items), not silently misread", () => {
  // Captured 2026-09-27, Gemini's raw reply BEFORE the □-preservation
  // prompt fix -- folded the label's own "=" together with the printed
  // expression's "=", never emitting the required "|". This exact shape
  // must keep returning 0 items (proving the format really is broken,
  // not that parseOcrLine has a bug) -- if a future prompt change makes
  // the model regress to this shape, this test documents WHY 0 items
  // is the correct, expected outcome for text like this, not a parser
  // bug to "fix" by loosening the regex.
  const raw = "1=25÷5=5;5)25/25,2=12÷3=4;3)12/12,3=18÷2=9;2)18/18,4=48÷6=8;6)48/48,5=54÷9=6,6=56÷8=7,7=42÷6=7,8=36÷4=9";
  const items = mod.parseOcrLine(raw);
  assert.equal(items.length, 0, "no pipe present anywhere -- this raw shape is genuinely unparseable, 0 items is correct");
});

test("Ticket 26 real regression (post-fix raw shape): bare arithmetic with the required pipe and preserved blank must parse cleanly", () => {
  // Captured 2026-09-27, Gemini's raw reply AFTER the □-preservation
  // fix -- the real shape that should now always be produced for
  // "A÷B=C" style questions with the blank as an operand.
  const raw = "1=25÷5|5;5,2=12÷3|4;4,3=18÷2|9;9,4=48÷6|8;8,5=54÷□=6|9,6=56÷□=7|8,7=42÷□=7|6,8=36÷□=9|4";
  const items = mod.parseOcrLine(raw);
  assert.equal(items.length, 8);
  assert.equal(items[4].label, "5");
  assert.equal(items[4].printedQuestion, "54÷□=6");
  assert.equal(items[4].studentAnswer, "9");
  assert.equal(items[7].label, "8");
  assert.equal(items[7].printedQuestion, "36÷□=9");
  assert.equal(items[7].studentAnswer, "4");
});

test("Real shape: multi-blank passage with context-preserving printedQuestion (Ticket 29 fix), comma-separated, parses every item independently", () => {
  // Captured 2026-09-27, Gemini's raw reply for the and/but/or letter
  // exercise after Ticket 29's context-preservation prompt fix.
  const raw = '1=David likes noodles. He doesn\'t like rice.|David likes noodles but he doesn\'t like rice,2=We have two hamburgers. We have three hot dogs.|we have two hamburgers and three hot dogs.,3=I don\'t like dolls. I don\'t like teddy bears.|I don\'t like dolls and teddy bears.,4=My name is Eric. I have three sisters ____ I don\'t have any brothers.|but';
  const items = mod.parseOcrLine(raw);
  assert.equal(items.length, 4);
  assert.match(items[0].printedQuestion, /David likes noodles/);
  assert.equal(items[3].studentAnswer, "but");
  assert.match(items[3].printedQuestion, /____/, "the blank marker must survive parsing intact");
});

// Ticket 48 (2026-09-27): /api/mark never carried the page-continuation
// markers /api/check has always had, so the website's cross-page-stitch
// trigger has been silently unreachable since Ticket 32. This tests the
// new extractContinuationMarkers() helper that restores them for the
// plain-text OCR_ONLY_PROMPT format.
test("extractContinuationMarkers: recognises both markers and strips them from the item text", () => {
  const raw = "CONTINUES_FROM_PREVIOUS\n1=25÷5|5,2=12÷3|4\nCONTINUES_TO_NEXT";
  const { continuesFromPrevious, continuesToNext, cleanedText } = mod.extractContinuationMarkers(raw);
  assert.equal(continuesFromPrevious, true);
  assert.equal(continuesToNext, true);
  assert.doesNotMatch(cleanedText, /CONTINUES_/);
  const items = mod.parseOcrLine(cleanedText);
  assert.equal(items.length, 2, "stripping the markers must not swallow real items");
});

test("extractContinuationMarkers: defaults both to false when neither marker is present (the common case)", () => {
  const raw = "1=25÷5|5,2=12÷3|4";
  const { continuesFromPrevious, continuesToNext, cleanedText } = mod.extractContinuationMarkers(raw);
  assert.equal(continuesFromPrevious, false);
  assert.equal(continuesToNext, false);
  assert.equal(cleanedText, raw, "text with no markers must pass through unchanged");
});

test("extractContinuationMarkers: only CONTINUES_TO_NEXT present, item text still parses cleanly", () => {
  const raw = "1=A teacher divides 53 bookmarks equally among 7 pupils.|53÷7=7...4\nCONTINUES_TO_NEXT";
  const { continuesFromPrevious, continuesToNext, cleanedText } = mod.extractContinuationMarkers(raw);
  assert.equal(continuesFromPrevious, false);
  assert.equal(continuesToNext, true);
  const items = mod.parseOcrLine(cleanedText);
  assert.equal(items.length, 1);
  assert.equal(items[0].studentAnswer, "53÷7=7...4");
});

// Ticket 52 (2026-09-27): extractPriceTable pulls an optional printed
// price table out of the raw OCR text so verifyPriceTableLookup can
// finally be reached in production. Real shape (same source PDF as
// verifyPriceTableLookup's own comment): 機械人=$48, 跑車=$89, 洋娃娃=$25.
test("extractPriceTable: parses a real price table line and strips it from the item text", () => {
  const raw = "PRICE_TABLE: 機械人=48;跑車=89;洋娃娃=25\n1=買機械人和洋娃娃各一個共需付()元|73";
  const { priceTable, cleanedText } = mod.extractPriceTable(raw);
  assert.deepEqual(priceTable, { "機械人": 48, "跑車": 89, "洋娃娃": 25 });
  assert.doesNotMatch(cleanedText, /PRICE_TABLE/);
  const items = mod.parseOcrLine(cleanedText);
  assert.equal(items.length, 1);
  assert.equal(items[0].studentAnswer, "73");
});

test("extractPriceTable: no table present returns null and leaves the text untouched", () => {
  const raw = "1=25÷5|5";
  const { priceTable, cleanedText } = mod.extractPriceTable(raw);
  assert.equal(priceTable, null);
  assert.equal(cleanedText, raw);
});

// Ticket 53 (2026-09-27): extractPassageText pulls an optional printed
// reading passage out of the raw OCR text (same marker-line pattern as
// extractPriceTable) so verifySelectFromPassage and verifyLiteralKeywordMC
// can finally be reached in production.
test("extractPassageText: parses a real passage line and strips it from the item text", () => {
  const raw = "PASSAGE: 比賽後，我和媽媽高興地討論剛才比賽的情況。\n1=比賽後，我和媽媽高興地____剛才比賽的情況。|討論";
  const { passageText, cleanedText } = mod.extractPassageText(raw);
  assert.equal(passageText, "比賽後，我和媽媽高興地討論剛才比賽的情況。");
  assert.doesNotMatch(cleanedText, /PASSAGE/);
  const items = mod.parseOcrLine(cleanedText);
  assert.equal(items.length, 1);
  assert.equal(items[0].studentAnswer, "討論");
});

test("extractPassageText: no passage present returns null and leaves the text untouched", () => {
  const raw = "1=25÷5|5";
  const { passageText, cleanedText } = mod.extractPassageText(raw);
  assert.equal(passageText, null);
  assert.equal(cleanedText, raw);
});

test("parseMcOptions: pulls A/B/C/D options straight out of a real printedQuestion string", () => {
  const printed = "They are packing (___). A. bun and cakes B. sweets and buns C. cakes and sweet D. sweets, buns and cakes";
  const options = mod.parseMcOptions(printed);
  assert.equal(options.length, 4);
  assert.deepEqual(options[3], { letter: "D", text: "sweets, buns and cakes" });
});

// Ticket 54 (2026-09-27): extractWordBank pulls an optional printed word
// bank out of the raw OCR text (same marker-line pattern as
// extractPriceTable/extractPassageText).
test("extractWordBank: parses a real word-bank line and strips it from the item text", () => {
  const raw = "WORD_BANK: a cup of;a bar of;a bowl of\n1=I'd like ____ tea.|a cup of";
  const { wordBank, cleanedText } = mod.extractWordBank(raw);
  assert.deepEqual(wordBank, ["a cup of", "a bar of", "a bowl of"]);
  assert.doesNotMatch(cleanedText, /WORD_BANK/);
  const items = mod.parseOcrLine(cleanedText);
  assert.equal(items.length, 1);
});

test("extractWordBank: no bank present returns null and leaves the text untouched", () => {
  const raw = "1=25÷5|5";
  const { wordBank, cleanedText } = mod.extractWordBank(raw);
  assert.equal(wordBank, null);
  assert.equal(cleanedText, raw);
});

// Ticket 55 (2026-09-27): extractSudokuPuzzles pulls 4x4 Sudoku puzzles
// out of the raw OCR text as a completely separate item shape (a 16-cell
// grid, not a printedQuestion/studentAnswer pair) -- multiple puzzles
// can appear on one page, so this returns an array. Real fixture shape
// matches test/new-question-types.test.js's own SUDOKU_GIVEN/SOLUTION.
test("extractSudokuPuzzles: parses a real 4x4 grid line and strips it from the item text", () => {
  const given = "1,0,3,0,0,4,0,2,2,0,4,0,0,3,0,1";
  const solution = "1,2,3,4,3,4,1,2,2,1,4,3,4,3,2,1";
  const raw = `SUDOKU: 1|${given}|${solution}\n2=25÷5|5`;
  const { puzzles, cleanedText } = mod.extractSudokuPuzzles(raw);
  assert.equal(puzzles.length, 1);
  assert.equal(puzzles[0].label, "1");
  assert.equal(puzzles[0].givenGrid[1], null, "a printed 0 must become null (blank), not the string '0'");
  assert.equal(puzzles[0].studentGrid[0], "1");
  assert.doesNotMatch(cleanedText, /SUDOKU/);
  const items = mod.parseOcrLine(cleanedText);
  assert.equal(items.length, 1, "the remaining normal item must still parse cleanly");
});

test("extractSudokuPuzzles: multiple puzzles on one page (real shape: 5 separate puzzles found on one worksheet page)", () => {
  const raw = "SUDOKU: 1|1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0|1,2,3,4,3,4,1,2,2,1,4,3,4,3,2,1\nSUDOKU: 2|0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0|1,2,3,4,3,4,1,2,2,1,4,3,4,3,2,1";
  const { puzzles } = mod.extractSudokuPuzzles(raw);
  assert.equal(puzzles.length, 2);
  assert.equal(puzzles[0].label, "1");
  assert.equal(puzzles[1].label, "2");
});

test("extractSudokuPuzzles: no puzzle present returns an empty array and leaves the text untouched", () => {
  const raw = "1=25÷5|5";
  const { puzzles, cleanedText } = mod.extractSudokuPuzzles(raw);
  assert.deepEqual(puzzles, []);
  assert.equal(cleanedText, raw);
});

test("extractSudokuPuzzles: a malformed line (wrong cell count) is silently dropped, never thrown", () => {
  const raw = "SUDOKU: 1|1,2,3|1,2,3,4,3,4,1,2,2,1,4,3,4,3,2,1";
  assert.doesNotThrow(() => mod.extractSudokuPuzzles(raw));
  const { puzzles } = mod.extractSudokuPuzzles(raw);
  assert.deepEqual(puzzles, []);
});

// Ticket 68 (2026-09-28): pictogram (象形圖) marker extraction. Real
// citations: P2 exam Q38-42 (days-of-week hours-online chart), P3 exam
// Q36 (flower-count-in-a-vase chart) -- both found independently.
test("extractPictogramData: extracts unit + per-category counts, strips the marker line", () => {
  const raw = "PICTOGRAM: 單位=1;星期日=5;星期一=0;星期二=1\n1=How many days had zero hours?|2";
  const { pictogramData, cleanedText } = mod.extractPictogramData(raw);
  assert.deepEqual(pictogramData, { unit: 1, counts: { "星期日": 5, "星期一": 0, "星期二": 1 } });
  assert.doesNotMatch(cleanedText, /PICTOGRAM/);
  assert.match(cleanedText, /How many days had zero hours/);
});

test("extractPictogramData: returns null when no marker line is present, doesn't touch normal text", () => {
  const raw = "1=9+4=|13";
  const { pictogramData, cleanedText } = mod.extractPictogramData(raw);
  assert.equal(pictogramData, null);
  assert.equal(cleanedText, raw);
});

// Ticket 134 (2026-09-28): CALENDAR_GRID marker extraction. Real
// citation: a printed "五月" calendar, day 1 falling on Saturday, 31 days.
test("extractCalendarGrid: parses a real calendar grid line and strips it from the item text", () => {
  const raw = "CALENDAR_GRID: 月份=5;首日星期=六;日數=31\n31=五月有___個星期一。|5";
  const { calendarGrid, cleanedText } = mod.extractCalendarGrid(raw);
  assert.deepEqual(calendarGrid, { month: 5, firstWeekday: 6, daysInMonth: 31 });
  assert.doesNotMatch(cleanedText, /CALENDAR_GRID/);
  assert.match(cleanedText, /五月有/);
});

test("extractCalendarGrid: returns null when no marker line is present", () => {
  const raw = "1=9+4=|13";
  const { calendarGrid, cleanedText } = mod.extractCalendarGrid(raw);
  assert.equal(calendarGrid, null);
  assert.equal(cleanedText, raw);
});

// Ticket 135 (2026-09-28): SCHEDULE_TABLE marker extraction. Real
// citation: a weekly activity schedule (English班/游泳班/戲劇班/etc.).
test("extractScheduleTable: parses a real schedule table line and strips it from the item text", () => {
  const raw = "SCHEDULE_TABLE: 星期日=英文班;星期一=游泳班;星期二=戲劇班;星期三=書法班;星期四=中文班;星期五=籃球班;星期六=休息\n37=小怡在星期___有游泳班。|一";
  const { scheduleTable, cleanedText } = mod.extractScheduleTable(raw);
  assert.deepEqual(scheduleTable, { "星期日": "英文班", "星期一": "游泳班", "星期二": "戲劇班", "星期三": "書法班", "星期四": "中文班", "星期五": "籃球班", "星期六": "休息" });
  assert.doesNotMatch(cleanedText, /SCHEDULE_TABLE/);
  assert.match(cleanedText, /小怡在星期/);
});

test("extractScheduleTable: returns null when no marker line is present", () => {
  const raw = "1=9+4=|13";
  const { scheduleTable, cleanedText } = mod.extractScheduleTable(raw);
  assert.equal(scheduleTable, null);
  assert.equal(cleanedText, raw);
});

// Location-grid marker extraction. Real citation: a location grid with
// North pointing left, positions confirmed by hand against the source
// image (row 3 is irregular -- only 2 cells, under columns 1-2).
test("extractLocationGrid: parses a real irregular grid + north direction, strips the marker line", () => {
  const raw = "LOCATION_GRID: 北方向=左;體育館=0,0;商場=0,1;碼頭=0,2;加油站=1,0;酒店=1,1;樂園=1,2;巴士站=2,1;港鐵站=2,2\n24=由巴士站向___方走，便可到達酒店。|東";
  const { locationGrid, cleanedText } = mod.extractLocationGrid(raw);
  assert.equal(locationGrid.northDir, "左");
  assert.deepEqual(locationGrid.positions["巴士站"], { row: 2, col: 1 });
  assert.deepEqual(locationGrid.positions["酒店"], { row: 1, col: 1 });
  assert.doesNotMatch(cleanedText, /LOCATION_GRID/);
  assert.match(cleanedText, /由巴士站向/);
});

test("extractLocationGrid: returns null when no marker line is present", () => {
  const raw = "1=9+4=|13";
  const { locationGrid, cleanedText } = mod.extractLocationGrid(raw);
  assert.equal(locationGrid, null);
  assert.equal(cleanedText, raw);
});

// FACING_DIRECTION marker extraction. Real citation: 偉誠 faces East
// (cross-derived by hand from Q28+Q29's real recorded answers before
// any code was written).
test("extractFacingDirection: parses a real facing-direction line and strips it from the item text", () => {
  const raw = "FACING_DIRECTION: 偉誠=東\n28=梓君面向___方。|西";
  const { facingDirection, cleanedText } = mod.extractFacingDirection(raw);
  assert.deepEqual(facingDirection, { "偉誠": "東" });
  assert.doesNotMatch(cleanedText, /FACING_DIRECTION/);
  assert.match(cleanedText, /梓君面向/);
});

test("extractFacingDirection: returns null when no marker line is present", () => {
  const raw = "1=9+4=|13";
  const { facingDirection, cleanedText } = mod.extractFacingDirection(raw);
  assert.equal(facingDirection, null);
  assert.equal(cleanedText, raw);
});

// Ticket 153 (2026-09-28): DIGIT_CARDS marker extraction. Real citation:
// digit cards {9,0,7,1}.
test("extractDigitCards: parses a real digit-card line and strips it from the item text", () => {
  const raw = "DIGIT_CARDS: 9,0,7,1\n21=利用以下的數卡，選出其中2張組成一個兩位的合成數，這個數最大是多少？|91";
  const { digitCards, cleanedText } = mod.extractDigitCards(raw);
  assert.deepEqual(digitCards, [9, 0, 7, 1]);
  assert.doesNotMatch(cleanedText, /DIGIT_CARDS/);
  assert.match(cleanedText, /利用以下的數卡/);
});

test("extractDigitCards: returns null when no marker line is present", () => {
  const raw = "1=9+4=|13";
  const { digitCards, cleanedText } = mod.extractDigitCards(raw);
  assert.equal(digitCards, null);
  assert.equal(cleanedText, raw);
});
