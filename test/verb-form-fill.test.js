// Ticket 222 "verb conjugation" (2026-10-01): "fill in the blank with
// the correct form of the verb given in brackets" -- rule-based
// subject-verb agreement + a common-irregular-verb lookup table, not
// open-ended semantic judgment. Real citations:
// - Photo 1 ("My classmate, Sam is a good boy..."): 7 blanks, all
//   present simple, mostly 3rd-person-singular.
// - Photo 2 (letter to Grandma): 7 blanks, a mix of present simple,
//   "want to" base-form, and real PAST tense (last week... went,
//   enjoyed; "when you were young" -> was; "did you ___" -> base form).
// Ground truth for both self-verified directly against the real photos
// this session.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_verbform.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_verbform.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_verbform.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// ---------- conjugatePresent3S / conjugatePast ----------

test("conjugatePresent3S: regular and irregular verbs", async () => {
  const worker = await import(TMP);
  assert.equal(worker.conjugatePresent3S("get"), "gets");
  assert.equal(worker.conjugatePresent3S("take"), "takes");
  assert.equal(worker.conjugatePresent3S("make"), "makes");
  assert.equal(worker.conjugatePresent3S("go"), "goes");
  assert.equal(worker.conjugatePresent3S("do"), "does");
  assert.equal(worker.conjugatePresent3S("have"), "has");
  assert.equal(worker.conjugatePresent3S("study"), "studies");
});

test("conjugatePast: regular and irregular verbs", async () => {
  const worker = await import(TMP);
  assert.equal(worker.conjugatePast("go"), "went");
  assert.equal(worker.conjugatePast("enjoy"), "enjoyed");
  assert.equal(worker.conjugatePast("study"), "studied");
  assert.equal(worker.conjugatePast("take"), "took");
});

// ---------- Real citation Photo 1: Sam paragraph (all present simple) ----------

test("verifyVerbFormFill: real citation 'He ___(get) up early' -> gets", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "My classmate, Sam is a good boy. He ____ (get) up early", studentAnswer: "gets" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

test("verifyVerbFormFill: real citation 'his dad ___(be) a postman' -> is", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "His dad ____ (be) a postman.", studentAnswer: "is" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

test("verifyVerbFormFill: real citation 'Sam and his parents ___(go) hiking' -> go (plural, base form)", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "Every Sunday, Sam and his parents ____ (go) hiking in Sai Kung.", studentAnswer: "go" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

test("verifyVerbFormFill: real citation 'He ___(not need) to go to work' -> does not need / doesn't need", async () => {
  const worker = await import(TMP);
  const item1 = { printedQuestion: "He ____ (not need) to go to work on Sundays.", studentAnswer: "does not need" };
  assert.equal(worker.verifyVerbFormFill(item1).correct, true);
  const item2 = { printedQuestion: "He ____ (not need) to go to work on Sundays.", studentAnswer: "doesn't need" };
  assert.equal(worker.verifyVerbFormFill(item2).correct, true);
});

test("verifyVerbFormFill: wrong answer reports the real correct form", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "His mum ____ (make) breakfast for him.", studentAnswer: "make" };
  const result = worker.verifyVerbFormFill(item);
  assert.equal(result.correct, false);
  assert.equal(result.correctAnswer, "makes");
});

// ---------- Real citation Photo 2: letter to Grandma (mixed tense) ----------

test("verifyVerbFormFill: real citation 'I want to ___(join)' -> join (base form after 'want to')", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "I want to ____ (join) the Cookery Club because it", studentAnswer: "join" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

test("verifyVerbFormFill: real citation 'it ___(be) interesting' -> is", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "it ____ (be) interesting.", studentAnswer: "is" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

test("verifyVerbFormFill: real citation 'Last week, I ___(go) on a school picnic' -> went (past tense signal)", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "Last week, I ____ (go) on a school picnic with my classmates.", studentAnswer: "went" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

test("verifyVerbFormFill: real citation 'We all ___(enjoy) it' -> enjoyed (past signal earlier in sentence)", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "Last week, I went on a school picnic with my classmates. We all ____ (enjoy) it so much.", studentAnswer: "enjoyed" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

test("verifyVerbFormFill: real citation 'how ___(be) your school life when you were young?' -> was", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "Grandma, how ____ (be) your school life when you were young?", studentAnswer: "was" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

test("verifyVerbFormFill: real citation 'Where did you ___(study) 60 years ago?' -> study (base form after 'did')", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "Where did you ____ (study) 60 years ago?", studentAnswer: "study" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

test("verifyVerbFormFill: real citation 'Please ___(tell) me' -> tell (base form after 'Please')", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "Please ____ (tell) me in your next letter.", studentAnswer: "tell" };
  assert.equal(worker.verifyVerbFormFill(item).correct, true);
});

// ---------- declines rather than guesses on ambiguous input ----------

test("verifyVerbFormFill: declines (null) when no clear subject precedes the blank", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "____ (be) great.", studentAnswer: "is" };
  const result = worker.verifyVerbFormFill(item);
  assert.equal(result.correct, null);
});

test("isVerbFormFillQuestion / dispatch: registered, wins dispatch on the real citation shape, does not collide with grammar_cloze", async () => {
  const worker = await import(TMP);
  const item = { printedQuestion: "His mum ____ (make) breakfast for him.", studentAnswer: "makes" };
  const matched = worker.QUESTION_TYPE_HANDLERS.filter((h) => h.detect(item));
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, "verb_form_fill");
});
