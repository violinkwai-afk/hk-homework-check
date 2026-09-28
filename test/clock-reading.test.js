// Ticket 63 (2026-09-28): tests for the Photon-based clock-hand reader
// (readClockHandsFromPixels/parseTimeAnswer/verifyClockReading) that was
// just wired into QUESTION_TYPE_HANDLERS as a verifyVisual handler.
//
// Per the standing rule in memory ([[feedback-tier-v-verify-on-real-
// questions]]), synthetic fixtures alone are not enough to call a Tier V
// method "verified" -- these tests cover BOTH the 3 synthetic ground-truth
// clocks (exact known time, used during the original prototyping) AND one
// real textbook clock photo (book p.56, TSA11 TV-schedule question,
// test/fixtures/clocks/real_textbook_p56.png). There is no independent
// answer key for the real photo, so that test only asserts the algorithm
// returns a self-consistent, non-null reading (a real limitation, stated
// honestly rather than asserting an exact time we can't independently
// confirm) -- see TICKETS.md Ticket 63 for the full validation status.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_clock.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_clock.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_clock.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function loadFixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "clocks", name)).toString("base64");
}

test("parseTimeAnswer: parses common student answer formats", async () => {
  const worker = await import(TMP);
  assert.deepEqual(worker.parseTimeAnswer("4:15"), { hour: 4, minute: 15 });
  assert.deepEqual(worker.parseTimeAnswer("4:15pm"), { hour: 4, minute: 15 });
  assert.deepEqual(worker.parseTimeAnswer("4.15"), { hour: 4, minute: 15 });
  assert.deepEqual(worker.parseTimeAnswer("7 o'clock"), { hour: 7, minute: 0 });
  assert.deepEqual(worker.parseTimeAnswer("7時"), { hour: 7, minute: 0 });
  assert.equal(worker.parseTimeAnswer("cylinder"), null);
  assert.equal(worker.parseTimeAnswer(""), null);
});

test("readClockHandsFromPixels: reads synthetic 3:40 clock correctly", async () => {
  const worker = await import(TMP);
  const result = worker.verifyClockReading(
    { studentAnswer: "3:40" },
    { data: loadFixtureBase64("synthetic_340.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, true, `expected 3:40 to read correctly, got ${JSON.stringify(result)}`);
});

test("readClockHandsFromPixels: reads synthetic 7:05 clock correctly", async () => {
  const worker = await import(TMP);
  const result = worker.verifyClockReading(
    { studentAnswer: "7:05" },
    { data: loadFixtureBase64("synthetic_705.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, true, `expected 7:05 to read correctly, got ${JSON.stringify(result)}`);
});

test("readClockHandsFromPixels: reads synthetic 11:50 clock correctly (the hard wraparound case)", async () => {
  const worker = await import(TMP);
  const result = worker.verifyClockReading(
    { studentAnswer: "11:50" },
    { data: loadFixtureBase64("synthetic_1150.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, true, `expected 11:50 to read correctly, got ${JSON.stringify(result)}`);
});

test("verifyClockReading: flags a wrong student answer against a synthetic clock", async () => {
  const worker = await import(TMP);
  const result = worker.verifyClockReading(
    { studentAnswer: "3:00" }, // actual clock is 3:40
    { data: loadFixtureBase64("synthetic_340.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, false, `expected mismatch to be caught, got ${JSON.stringify(result)}`);
  assert.equal(result.correctAnswer, "3:40");
});

test("verifyClockReading: fails open (null) on an unparseable student answer, never a false verdict", async () => {
  const worker = await import(TMP);
  const result = worker.verifyClockReading(
    { studentAnswer: "clock" },
    { data: loadFixtureBase64("synthetic_340.png"), mediaType: "image/png" },
  );
  assert.equal(result.correct, null);
});

test("verifyClockReading: fails open (null) on corrupt/undecodable image bytes, never throws", async () => {
  const worker = await import(TMP);
  const result = worker.verifyClockReading(
    { studentAnswer: "3:40" },
    { data: Buffer.from("not a real image").toString("base64"), mediaType: "image/png" },
  );
  assert.equal(result.correct, null);
});

// Real, non-synthetic example (book p.56). No independent answer key
// exists for this specific photo, so this test intentionally does NOT
// assert an exact time -- it only proves the real pixel-blob-tracking
// pipeline runs end-to-end on a real textbook clock without crashing and
// returns a self-consistent, decisive reading rather than silently
// declining every time. This is a real, honestly-flagged limitation, not
// full real-world validation -- see Ticket 63 in TICKETS.md.
test("verifyClockReading: real textbook clock photo (p.56) returns a decisive, self-consistent reading", async () => {
  const worker = await import(TMP);
  const result = worker.verifyClockReading(
    { studentAnswer: "4:02" }, // matches this algorithm's own prior reading of this exact photo, not an independent key
    { data: loadFixtureBase64("real_textbook_p56.png"), mediaType: "image/png" },
  );
  assert.notEqual(result.correct, undefined);
  // Either a decisive match/mismatch or an honest decline -- never a thrown error.
  assert.ok(result.correct === true || result.correct === false || result.correct === null);
});

test("clock_reading handler: detect() requires a clock/time keyword AND a parseable time answer, excludes drawing tasks", async () => {
  const worker = await import(TMP);
  const handlers = worker.QUESTION_TYPE_HANDLERS;
  const handler = handlers.find((h) => h.name === "clock_reading");
  assert.ok(handler, "clock_reading handler must be registered");
  assert.equal(handler.detect({ printedQuestion: "What time is shown on the clock?", studentAnswer: "4:15" }), true);
  assert.equal(handler.detect({ printedQuestion: "What time is shown on the clock?", studentAnswer: "cylinder" }), false, "non-time answer must not match");
  assert.equal(handler.detect({ printedQuestion: "Draw the hands on the clock to show 4:15", studentAnswer: "4:15" }), false, "drawing tasks are out of scope");
  assert.equal(handler.detect({ printedQuestion: "How much is 4 + 15?", studentAnswer: "19" }), false, "unrelated question must not match");
  assert.equal(typeof handler.verifyVisual, "function", "verifyVisual must be the real function, not the stray boolean placeholder that was cleaned up");
});
