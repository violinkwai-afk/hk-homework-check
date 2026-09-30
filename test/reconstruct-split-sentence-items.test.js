// Ticket 222 "cross-item context" (2026-10-01). Real citation: a
// 9-photo full-pipeline test found OCR splitting ONE printed sentence's
// several blanks into SEPARATE items (real raw OCR text below, the
// "Super Kids Christmas Party" poster) -- every downstream judge (code,
// Jev, and even the real vision AI-fallback) independently defaulted
// to the same wrong answer on the affected items because each only
// saw its own truncated snippet. See
// project_hk_homework_check_cross_item_context_gap.md (memory) for the
// full real-data account across all three layers.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_reconstruct.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_reconstruct.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_reconstruct.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// Real raw OCR text, verbatim, from the 2026-10-01 test run (see
// benchmark/english-subject-pipeline-test-log.csv, christmas_poster).
const REAL_CHRISTMAS_POSTER_OCR = `1=The party is ____ 25th December (Christmas Day).|on
2=The party is ____ nine thirty|from
3=The party is ____ the morning|in
4=The party is ____ seven thirty|to
5=The party is ____ the evening.|in
6=There are free crafts and games all day. There is an animal show ____ ten fifteen|at
7=There are free crafts and games all day. There is an animal show ____ the morning.|in
8=We also have a music and dance show ____ two thirty|from
9=We also have a music and dance show ____ four o'clock|to
10=We also have a music and dance show ____ the afternoon.|at
11=There is a lucky draw ____ five o'clock.|at
12=There is a lucky draw ____ the evening there is a firework show.|in`;

test("reconstructSplitSentenceItems: real citation -- items 2,3,4,5 merge back into the original sentence", async () => {
  const worker = await import(TMP);
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(REAL_CHRISTMAS_POSTER_OCR));
  const item2 = items.find((i) => i.label === "2");
  const item5 = items.find((i) => i.label === "5");
  assert.equal(
    item2.printedQuestion,
    "The party is ____ nine thirty ____ the morning ____ seven thirty ____ the evening."
  );
  // Every member of the group gets the SAME fully-reconstructed text --
  // only targetBlankIndex differs, telling each item which blank is
  // its own.
  assert.equal(item5.printedQuestion, item2.printedQuestion);
  assert.equal(item2.targetBlankIndex, 0);
  assert.equal(items.find((i) => i.label === "3").targetBlankIndex, 1);
  assert.equal(items.find((i) => i.label === "4").targetBlankIndex, 2);
  assert.equal(item5.targetBlankIndex, 3);
});

test("reconstructSplitSentenceItems: real citation -- items 8,9,10 merge into their own separate sentence", async () => {
  const worker = await import(TMP);
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(REAL_CHRISTMAS_POSTER_OCR));
  const item8 = items.find((i) => i.label === "8");
  assert.equal(
    item8.printedQuestion,
    "We also have a music and dance show ____ two thirty ____ four o'clock ____ the afternoon."
  );
  assert.equal(item8.targetBlankIndex, 0);
  assert.equal(items.find((i) => i.label === "9").targetBlankIndex, 1);
  assert.equal(items.find((i) => i.label === "10").targetBlankIndex, 2);
});

test("reconstructSplitSentenceItems: items 6,7 merge too (both share the 'animal show' prefix)", async () => {
  const worker = await import(TMP);
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(REAL_CHRISTMAS_POSTER_OCR));
  const item6 = items.find((i) => i.label === "6");
  assert.equal(
    item6.printedQuestion,
    "There are free crafts and games all day. There is an animal show ____ ten fifteen ____ the morning."
  );
});

test("reconstructSplitSentenceItems: standalone items (1, 11, 12, no real sibling) are left untouched", async () => {
  const worker = await import(TMP);
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(REAL_CHRISTMAS_POSTER_OCR));
  const item1 = items.find((i) => i.label === "1");
  assert.equal(item1.printedQuestion, "The party is ____ 25th December (Christmas Day).");
  assert.equal(item1.targetBlankIndex, undefined);
  const item11 = items.find((i) => i.label === "11");
  assert.equal(item11.printedQuestion, "There is a lucky draw ____ five o'clock.");
  assert.equal(item11.targetBlankIndex, undefined);
});

test("End-to-end fix: verifyPrepositionOfTime now correctly resolves the real citations that were wrong before this fix", async () => {
  const worker = await import(TMP);
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(REAL_CHRISTMAS_POSTER_OCR));
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));

  // Before this fix: these 4 confidently got the WRONG verdict (from
  // Jev and/or the real AI-fallback -- see the memory file). Now code
  // itself resolves them correctly.
  assert.deepEqual(worker.verifyPrepositionOfTime(byLabel["2"]), { correct: true, correctAnswer: "" });
  assert.deepEqual(worker.verifyPrepositionOfTime(byLabel["4"]), { correct: true, correctAnswer: "" });
  assert.deepEqual(worker.verifyPrepositionOfTime(byLabel["8"]), { correct: true, correctAnswer: "" });
  assert.deepEqual(worker.verifyPrepositionOfTime(byLabel["9"]), { correct: true, correctAnswer: "" });

  // Still-standalone ones remain correct too.
  assert.equal(worker.verifyPrepositionOfTime(byLabel["1"]).correct, true);
  assert.equal(worker.verifyPrepositionOfTime(byLabel["6"]).correct, true);
  assert.equal(worker.verifyPrepositionOfTime(byLabel["11"]).correct, true);
  // Item 10's real wrong-answer catch (student wrote "at", real answer
  // "in") must still fire correctly after reconstruction.
  const v10 = worker.verifyPrepositionOfTime(byLabel["10"]);
  assert.equal(v10.correct, false);
  assert.equal(v10.correctAnswer, "in");
});

test("reconstructSplitSentenceItems: does not merge items with a non-numeric label (e.g. 'B1'/'B2')", async () => {
  const worker = await import(TMP);
  const text = `B1=I like to eat ____ very much.|apples
B2=I like to eat ____ every day.|bananas`;
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(text));
  assert.equal(items[0].printedQuestion, "I like to eat ____ very much.");
  assert.equal(items[1].printedQuestion, "I like to eat ____ every day.");
});

test("reconstructSplitSentenceItems: does not merge items with only a short/trivial shared prefix", async () => {
  const worker = await import(TMP);
  // Two genuinely unrelated fill-ins that happen to start with the
  // same short word -- must not be spliced into one fake sentence.
  const text = `1=I ____ apples.|like
2=I ____ my homework.|do`;
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(text));
  assert.equal(items[0].printedQuestion, "I ____ apples.");
  assert.equal(items[1].printedQuestion, "I ____ my homework.");
});

// ---- Ticket 222 "disambiguate which blank for Jev/AI-fallback" ----
// Real validating question from the user: reconstruction gives 4 items
// the SAME full sentence with all 4 blanks looking identical -- code
// tells them apart via targetBlankIndex, but Jev/buildAiFallbackPrompt
// read printedQuestion as plain text and would have no way to know
// which of the 4 identical "____" a one-word answer is about.
// displayPrintedQuestionForJudge fixes this by filling every OTHER
// blank with that sibling's own real studentAnswer (a further real
// suggestion from the user, better than the first version which just
// left them as bare "____") and bracketing only the one being judged
// -- reads as one natural sentence with exactly one word marked out.

test("displayPrintedQuestionForJudge: real citation -- fills every OTHER blank with that sibling's real answer, brackets only the target", async () => {
  const worker = await import(TMP);
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(REAL_CHRISTMAS_POSTER_OCR));
  const item2 = items.find((i) => i.label === "2"); // targetBlankIndex 0, siblings' real answers: from,in,to,in
  const item4 = items.find((i) => i.label === "4"); // targetBlankIndex 2
  assert.equal(
    worker.displayPrintedQuestionForJudge(item2),
    "The party is 【from】 nine thirty in the morning to seven thirty in the evening."
  );
  assert.equal(
    worker.displayPrintedQuestionForJudge(item4),
    "The party is from nine thirty in the morning 【to】 seven thirty in the evening."
  );
});

test("displayPrintedQuestionForJudge: item with no targetBlankIndex (not part of a reconstructed group) is unchanged", async () => {
  const worker = await import(TMP);
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(REAL_CHRISTMAS_POSTER_OCR));
  const item1 = items.find((i) => i.label === "1");
  assert.equal(worker.displayPrintedQuestionForJudge(item1), item1.printedQuestion);
});

test("buildJevQuestions: the marker and disambiguation note both actually reach Jev's instructions text", async () => {
  const worker = await import(TMP);
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(REAL_CHRISTMAS_POSTER_OCR));
  const item2 = { ...items.find((i) => i.label === "2"), resultIndex: 1 };
  const questions = worker.buildJevQuestions([item2]);
  assert.match(questions["1"].instructions, /【from】/);
  assert.match(questions["1"].instructions, /淨係要判斷/);
});

test("buildAiFallbackPrompt: the marker and disambiguation note both actually reach the AI-fallback prompt text", async () => {
  const worker = await import(TMP);
  const items = worker.reconstructSplitSentenceItems(worker.parseOcrLine(REAL_CHRISTMAS_POSTER_OCR));
  const item2 = { ...items.find((i) => i.label === "2"), question: "1" };
  const prompt = worker.buildAiFallbackPrompt([item2]);
  assert.match(prompt, /【from】/);
  assert.match(prompt, /淨係判斷/);
});
