// Ticket 222 "Prepositions of time" (2026-10-01). Real citations,
// directly re-read from the source photos before writing this test (an
// earlier in-context memory reconstruction had gotten two details
// wrong -- see the comment above verifyPrepositionOfTime in worker.js
// for the full account): three real worksheets, teacher-checked.
//
// NOTE on real-dispatch risk: these test cases construct printedQuestion
// text assuming OCR preserves the full local sentence around each blank
// (the convention every other handler in this file has shown). This has
// NOT been confirmed against a real OCR call for this specific question
// type -- flagged to the user, not silently assumed solid.
//
// Tests for the SECOND blank of a from/to pair pass targetBlankIndex
// explicitly (0-based position among the blanks found in printedQuestion)
// -- this is the mechanism verifyPrepositionOfTime needs to tell which
// blank is "its own" when a shared sentence has more than one. Whether
// real OCR/dispatch code will ever actually populate this field is also
// unverified; without it the default (blank 0) is still correct for
// every standalone on/in/at case and the "from" half of every pair --
// only the "to" half needs it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_preptime.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_preptime.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_preptime.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// ---- Worksheet (1): "Prepositions of time (1)" poster, dates only ----

test("Worksheet(1) item 1: standalone date -> on", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "Games Day is ____ 30th March.",
    studentAnswer: "on",
  });
  assert.equal(r.correct, true);
});

test("Worksheet(1) item 2/3: date range -> from / to", async () => {
  const worker = await import(TMP);
  const from = worker.verifyPrepositionOfTime({
    printedQuestion: "Drama Camp is ____ 31st March ____ 1st April.",
    studentAnswer: "from",
  });
  assert.equal(from.correct, true);
  const to = worker.verifyPrepositionOfTime({
    printedQuestion: "Drama Camp is ____ 31st March ____ 1st April.",
    studentAnswer: "to",
    targetBlankIndex: 1,
  });
  assert.equal(to.correct, true);
});

test("Worksheet(1) item 4: standalone date -> on (not mistaken for a range)", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "Music Day is ____ 2nd April.",
    studentAnswer: "on",
  });
  assert.equal(r.correct, true);
});

// ---- Worksheet (2): "Prepositions of time (2)", 9 items, 13 blanks ----

test("Worksheet(2) item 1: weekday + daypart plural -> on", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "Wendy goes to the library ____ Sunday mornings.",
    studentAnswer: "on",
  });
  assert.equal(r.correct, true);
});

test("Worksheet(2) item 3: bare season -> in", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "I usually wear a cap ____ summer.",
    studentAnswer: "in",
  });
  assert.equal(r.correct, true);
});

test("Worksheet(2) item 6: clock time + night, both standalone -> at, at", async () => {
  const worker = await import(TMP);
  const clock = worker.verifyPrepositionOfTime({
    printedQuestion: "Henry goes to bed ____ nine thirty ____ night.",
    studentAnswer: "at",
  });
  assert.equal(clock.correct, true);
  const night = worker.verifyPrepositionOfTime({
    printedQuestion: "nine thirty ____ night.",
    studentAnswer: "at",
  });
  assert.equal(night.correct, true);
});

test("Worksheet(2) item 7: clock-time range -> from / to", async () => {
  const worker = await import(TMP);
  const from = worker.verifyPrepositionOfTime({
    printedQuestion: "The concert is ____ eight fifteen ____ eleven o'clock.",
    studentAnswer: "from",
  });
  assert.equal(from.correct, true);
  const to = worker.verifyPrepositionOfTime({
    printedQuestion: "The concert is ____ eight fifteen ____ eleven o'clock.",
    studentAnswer: "to",
    targetBlankIndex: 1,
  });
  assert.equal(to.correct, true);
});

test("Worksheet(2) item 8: bare month alone -> in", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "The school concert is ____ April.",
    studentAnswer: "in",
  });
  assert.equal(r.correct, true);
});

test("Worksheet(2) item 9: noon/midnight exception -> at, at (NOT from)", async () => {
  const worker = await import(TMP);
  const noon = worker.verifyPrepositionOfTime({
    printedQuestion: "My grandfather watches TV ____ noon.",
    studentAnswer: "at",
  });
  assert.equal(noon.correct, true);
  // Real finding: the student actually wrote "from" here and was
  // marked wrong by the teacher -- confirm the handler agrees "from"
  // is wrong and reports the real correct word.
  const wrongFrom = worker.verifyPrepositionOfTime({
    printedQuestion: "My grandfather watches TV ____ noon.",
    studentAnswer: "from",
  });
  assert.equal(wrongFrom.correct, false);
  assert.equal(wrongFrom.correctAnswer, "at");
  const midnight = worker.verifyPrepositionOfTime({
    printedQuestion: "My uncle watches TV ____ midnight.",
    studentAnswer: "at",
  });
  assert.equal(midnight.correct, true);
});

// ---- Poster: "Super Kids Christmas Party", 12 blanks ----

test("Poster item 1: date -> on", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "The party is ____ 25th December (Christmas Day).",
    studentAnswer: "on",
  });
  assert.equal(r.correct, true);
});

test("Poster items 2-5: from/to clock-time range, each followed by its own daypart -> from, in, to, in", async () => {
  const worker = await import(TMP);
  const sentence = "The party is ____ nine thirty ____ the morning ____ seven thirty ____ the evening.";
  const from = worker.verifyPrepositionOfTime({ printedQuestion: sentence, studentAnswer: "from", targetBlankIndex: 0 });
  assert.equal(from.correct, true);
  const in1 = worker.verifyPrepositionOfTime({ printedQuestion: sentence, studentAnswer: "in", targetBlankIndex: 1 });
  assert.equal(in1.correct, true);
  const to = worker.verifyPrepositionOfTime({ printedQuestion: sentence, studentAnswer: "to", targetBlankIndex: 2 });
  assert.equal(to.correct, true);
  const in2 = worker.verifyPrepositionOfTime({ printedQuestion: sentence, studentAnswer: "in", targetBlankIndex: 3 });
  assert.equal(in2.correct, true);
});

test("Poster items 6-7: standalone clock time followed by a daypart (not another clock time) -> at, in", async () => {
  const worker = await import(TMP);
  const at = worker.verifyPrepositionOfTime({
    printedQuestion: "There is an animal show ____ ten fifteen ____ the morning.",
    studentAnswer: "at",
  });
  assert.equal(at.correct, true);
  const in1 = worker.verifyPrepositionOfTime({
    printedQuestion: "ten fifteen ____ the morning.",
    studentAnswer: "in",
  });
  assert.equal(in1.correct, true);
});

test("Poster items 8-10: from/to clock range + daypart -> from, to, in (real correction: student wrote 'at', real answer is 'in')", async () => {
  const worker = await import(TMP);
  const sentence = "We also have a music and dance show ____ two thirty ____ four o'clock ____ the afternoon.";
  const from = worker.verifyPrepositionOfTime({ printedQuestion: sentence, studentAnswer: "from", targetBlankIndex: 0 });
  assert.equal(from.correct, true);
  const to = worker.verifyPrepositionOfTime({ printedQuestion: sentence, studentAnswer: "to", targetBlankIndex: 1 });
  assert.equal(to.correct, true);
  const wrongAt = worker.verifyPrepositionOfTime({ printedQuestion: sentence, studentAnswer: "at", targetBlankIndex: 2 });
  assert.equal(wrongAt.correct, false);
  assert.equal(wrongAt.correctAnswer, "in");
  const rightIn = worker.verifyPrepositionOfTime({ printedQuestion: sentence, studentAnswer: "in", targetBlankIndex: 2 });
  assert.equal(rightIn.correct, true);
});

test("Poster item 11: standalone clock time, no daypart following -> at", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "There is a lucky draw ____ five o'clock.",
    studentAnswer: "at",
  });
  assert.equal(r.correct, true);
});

test("Poster item 12: sentence-initial bare daypart -> in (case-insensitive, real answer was capitalized 'In')", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "____ the evening there is a firework show.",
    studentAnswer: "In",
  });
  assert.equal(r.correct, true);
});

// ---- Dispatch / registration ----

test("isPrepositionOfTimeQuestion / dispatch: registered and reachable via classifyAndVerify", async () => {
  const worker = await import(TMP);
  const item = {
    printedQuestion: "Games Day is ____ 30th March.",
    studentAnswer: "on",
  };
  assert.equal(worker.isPrepositionOfTimeQuestion(item), true);
  const verdict = worker.classifyAndVerify(item, () => null);
  assert.equal(verdict.handler, "preposition_of_time");
  assert.equal(verdict.correct, true);
});

test("verifyPrepositionOfTime: declines (null) when the following text doesn't classify at all", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "I like to play ____ football with my friends.",
    studentAnswer: "on",
  });
  assert.equal(r.correct, null);
});

test("verifyPrepositionOfTime: declines (null) when the student answer isn't a preposition word at all", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPrepositionOfTime({
    printedQuestion: "Games Day is ____ 30th March.",
    studentAnswer: "banana",
  });
  assert.equal(r.correct, null);
});
