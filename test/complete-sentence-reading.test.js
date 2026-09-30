// Ticket 222 "reading comprehension marking criteria" (2026-09-30, real
// citation: Junius Publications "Practice in Reading 3", Part A:
// "Answer the questions in COMPLETE sentences" after a Hailey/pickpocket
// passage). User asked for real research into how HK PRIMARY school
// teachers mark this format, explicitly rejecting the more lenient
// DSE/HKEAA-level leniency principle ("小學唔可以跟dse") -- this
// reference block follows only the stricter primary-level criteria
// found (a real, sourced HK-parenting-media summary of primary tutor
// experience: format correctness matters, not just meaning).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_readingcomp.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_readingcomp.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_readingcomp.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

test("mentionsCompleteSentenceReadingQuestion: real citation Q1 (What will Hailey do...) with a sentence-length answer", async () => {
  const worker = await import(TMP);
  const items = [{ question: "1", printedQuestion: "What will Hailey do when her friends do something wrong?", studentAnswer: "She will point it out without delay." }];
  assert.equal(worker.mentionsCompleteSentenceReadingQuestion(items), true);
});

test("mentionsCompleteSentenceReadingQuestion: does not fire on a short fill-blank/MC answer", async () => {
  const worker = await import(TMP);
  const items = [{ question: "1", printedQuestion: "What is the capital of France?", studentAnswer: "Paris" }];
  assert.equal(worker.mentionsCompleteSentenceReadingQuestion(items), false);
});

test("mentionsCompleteSentenceReadingQuestion: does not fire on a non-question item", async () => {
  const worker = await import(TMP);
  const items = [{ question: "1", printedQuestion: "25÷5", studentAnswer: "5" }];
  assert.equal(worker.mentionsCompleteSentenceReadingQuestion(items), false);
});

test("buildAiFallbackPrompt: includes the complete-sentence reading criteria for the real citation, and does NOT blend in the more lenient DSE leniency principle (spelling errors always forgiven)", async () => {
  const worker = await import(TMP);
  const items = [{ question: "1", printedQuestion: "What will Hailey do when her friends do something wrong?", studentAnswer: "She will point it out without delay." }];
  const prompt = worker.buildAiFallbackPrompt(items);
  assert.ok(prompt.includes("完整句子"));
  assert.ok(prompt.includes("時式"));
  assert.ok(prompt.includes("代名詞"));
  // DSE is mentioned only as a comparison point (primary is stricter),
  // never as a leniency principle to actually apply -- check the
  // specific lenient DSE wording is absent, not the bare word "DSE".
  assert.ok(!prompt.includes("照畀啱"));
});

test("buildAiFallbackPrompt: omits the reading-criteria block for unrelated (non-reading) items", async () => {
  const worker = await import(TMP);
  const items = [{ question: "1", printedQuestion: "25÷5", studentAnswer: "5" }];
  const prompt = worker.buildAiFallbackPrompt(items);
  assert.ok(!prompt.includes("完整句子"));
});
