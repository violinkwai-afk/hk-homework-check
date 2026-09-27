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
