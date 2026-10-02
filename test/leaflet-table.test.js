// Found 2026-10-02 while surveying HKEAA's TSA English-subject archive
// (benchmark/external_pdfs/tsa/) for new code-solvable question types.
// Unlike the maths archive, English/Chinese reading-comprehension papers
// are overwhelmingly genuine comprehension (no generalizable rule), but
// one real recurring sub-pattern reduces to a structured table lookup:
// a leaflet/notice passage where each named item (e.g. a class) carries
// multiple printed attributes (day, age range, fee, teacher), and the MC
// sub-questions just look one of those attributes up. Real citation:
// `tsa/2024/p3_paper_TSA2024_3ERW1.txt` Part 1 -- "Happy Music School"
// leaflet (Piano Class=Mondays,age5-10,$500,Miss Lee; Drum Class=
// Thursdays,age12-16,$600,Mr Wong; Singing Class=Fridays,age8-12,$300,
// Miss Lee; Violin Class=Wednesdays,age7-15,$250,Mr Chan).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_leaflet.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_leaflet.mjs");

let worker;
test.before(async () => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_leaflet.mjs"');
  fs.writeFileSync(TMP, src);
  worker = await import(TMP);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

const MUSIC_SCHOOL_TABLE = {
  "Piano Class": { day: "Mondays", ageMin: 5, ageMax: 10, fee: 500, teacher: "Miss Lee" },
  "Drum Class": { day: "Thursdays", ageMin: 12, ageMax: 16, fee: 600, teacher: "Mr Wong" },
  "Singing Class": { day: "Fridays", ageMin: 8, ageMax: 12, fee: 300, teacher: "Miss Lee" },
  "Violin Class": { day: "Wednesdays", ageMin: 7, ageMax: 15, fee: 250, teacher: "Mr Chan" },
};

test("extractLeafletTable: parses a real LEAFLET_TABLE marker line", () => {
  const text = "LEAFLET_TABLE: Piano Class=Mondays,5-10,$500,Miss Lee;Drum Class=Thursdays,12-16,$600,Mr Wong\nmore text";
  const { leafletTable, cleanedText } = worker.extractLeafletTable(text);
  assert.deepEqual(leafletTable["Piano Class"], { day: "Mondays", ageMin: 5, ageMax: 10, fee: 500, teacher: "Miss Lee" });
  assert.deepEqual(leafletTable["Drum Class"], { day: "Thursdays", ageMin: 12, ageMax: 16, fee: 600, teacher: "Mr Wong" });
  assert.ok(!cleanedText.includes("LEAFLET_TABLE"));
});

// (a) age-range lookup
const AGE_Q = "Joe’s brother is 6 years old. He can join the ____________ Class.    A. Piano   B. Drum   C. Singing   D. Violin";

test("verifyLeafletTableQuery: real citation, age-range lookup, correct answer", () => {
  const r = worker.verifyLeafletTableQuery(MUSIC_SCHOOL_TABLE, AGE_Q, "A");
  assert.equal(r.correct, true);
});

test("verifyLeafletTableQuery: real citation, age-range lookup, wrong answer", () => {
  const r = worker.verifyLeafletTableQuery(MUSIC_SCHOOL_TABLE, AGE_Q, "B");
  assert.equal(r.correct, false);
  assert.equal(r.correctAnswer, "A");
});

// (b) fee lookup
const FEE_Q = "Joe joins the Violin Class. He pays ____________.          A. $250  B. $300  C. $500  D. $600";

test("verifyLeafletTableQuery: real citation, fee lookup, correct answer", () => {
  const r = worker.verifyLeafletTableQuery(MUSIC_SCHOOL_TABLE, FEE_Q, "A");
  assert.equal(r.correct, true);
});

// (c) day lookup
const DAY_Q = "The Drum Class is on ____________.      A. Mondays  B. Thursdays  C. Wednesdays  D. Fridays";

test("verifyLeafletTableQuery: real citation, day lookup, correct answer", () => {
  const r = worker.verifyLeafletTableQuery(MUSIC_SCHOOL_TABLE, DAY_Q, "B");
  assert.equal(r.correct, true);
});

// (d) "who teaches two classes"
const TEACHER_Q = "Who teaches two classes?      A. Miss Lee  B. Mr Chan  C. Miss Ho  D. Mr Wong";

test("verifyLeafletTableQuery: real citation, two-classes teacher lookup, correct answer", () => {
  const r = worker.verifyLeafletTableQuery(MUSIC_SCHOOL_TABLE, TEACHER_Q, "A");
  assert.equal(r.correct, true);
});

test("verifyLeafletTableQuery: hardened against MC answer written as 'A.' or '(A)' instead of a bare letter", () => {
  const r1 = worker.verifyLeafletTableQuery(MUSIC_SCHOOL_TABLE, AGE_Q, "A.");
  assert.equal(r1.correct, true);
  const r2 = worker.verifyLeafletTableQuery(MUSIC_SCHOOL_TABLE, AGE_Q, "(A)");
  assert.equal(r2.correct, true);
});

test("leaflet_table_query handler: registered, reachable, wins dispatch", () => {
  const item = { leafletTable: MUSIC_SCHOOL_TABLE, printedQuestion: AGE_Q, studentAnswer: "A" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.equal(winner.name, "leaflet_table_query");
});

test("leaflet_table_query handler: declines when item.leafletTable is absent (no OCR marker fired)", () => {
  const item = { printedQuestion: AGE_Q, studentAnswer: "A" };
  const winner = worker.QUESTION_TYPE_HANDLERS.find((h) => h.detect(item));
  assert.notEqual(winner && winner.name, "leaflet_table_query");
});
