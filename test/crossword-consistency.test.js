// Ticket 222 "crossword grid-consistency check" (2026-10-01, real
// citation: 2022/2023 P2 General English First Examination, Part A --
// "Complete the crossword with the correct adjectives"). Real user
// insight: a crossword answer's LENGTH and shared-cell LETTERS can be
// checked against the grid's own geometry with zero language
// understanding -- catches some wrong answers for free, but can never
// confirm an answer is the intended one (see the long comment on
// checkCrosswordConsistency in src/worker.js).
//
// IMPORTANT: the grid coordinates used below are ILLUSTRATIVE, not a
// pixel-measured reconstruction of the real citation photo (a chat
// screenshot too imprecise to hand-measure reliably) -- they prove the
// ALGORITHM is correct against a grid with the same essential shape
// (two across slots crossing one down slot), not that this exact real
// worksheet's coordinates were extracted. No OCR extraction or
// QUESTION_TYPE_HANDLERS wiring exists yet -- this is the algorithm
// only, disclosed as not-yet-shipped in the function's own comment.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_crossword.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_crossword.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_crossword.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

// Grid: A=down@(0,2):4, B=across@(0,0):3 (crosses A at (0,2)),
// C=across@(2,1):4 (crosses A at (2,2))
const GRID_TEXT = "A=down@0,2:4;B=across@0,0:3;C=across@2,1:4";

test("parseCrosswordGrid: parses slot definitions", async () => {
  const worker = await import(TMP);
  const slots = worker.parseCrosswordGrid(GRID_TEXT);
  assert.deepEqual(slots.A, { direction: "down", row: 0, col: 2, length: 4 });
  assert.deepEqual(slots.B, { direction: "across", row: 0, col: 0, length: 3 });
});

test("crosswordSlotCells: across and down slots occupy the right cells", async () => {
  const worker = await import(TMP);
  const slots = worker.parseCrosswordGrid(GRID_TEXT);
  assert.deepEqual(worker.crosswordSlotCells(slots.A), [[0, 2], [1, 2], [2, 2], [3, 2]]);
  assert.deepEqual(worker.crosswordSlotCells(slots.B), [[0, 0], [0, 1], [0, 2]]);
});

test("checkCrosswordConsistency: fully consistent fill -> no conflicts", async () => {
  const worker = await import(TMP);
  const slots = worker.parseCrosswordGrid(GRID_TEXT);
  // A=TIDY (T,I,D,Y down col2) -- B=CAT ends in T at (0,2), matches A's T.
  // C starts at (2,1), its index1 lands on (2,2) = A's 'D' -- EDGY matches (E,D,G,Y).
  const fills = { A: "TIDY", B: "CAT", C: "EDGY" };
  const conflicts = worker.checkCrosswordConsistency(slots, fills);
  assert.deepEqual(conflicts, []);
});

test("checkCrosswordConsistency: catches a letter conflict with zero language understanding", async () => {
  const worker = await import(TMP);
  const slots = worker.parseCrosswordGrid(GRID_TEXT);
  // C="RUDE" -> its index1 (cell (2,2)) is 'U', but A says that cell is 'D' (TIDY's 3rd letter).
  const fills = { A: "TIDY", B: "CAT", C: "RUDE" };
  const conflicts = worker.checkCrosswordConsistency(slots, fills);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, "letter_conflict");
  assert.equal(conflicts[0].slot, "C");
  assert.equal(conflicts[0].withSlot, "A");
});

test("checkCrosswordConsistency: catches a length mismatch", async () => {
  const worker = await import(TMP);
  const slots = worker.parseCrosswordGrid(GRID_TEXT);
  const fills = { A: "TIDY", B: "CATS" }; // slot B only has 3 cells
  const conflicts = worker.checkCrosswordConsistency(slots, fills);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, "length_mismatch");
  assert.equal(conflicts[0].expectedLength, 3);
  assert.equal(conflicts[0].gotLength, 4);
});

test("checkCrosswordConsistency: a structurally-consistent fill does NOT prove correctness (documents the real limitation)", async () => {
  const worker = await import(TMP);
  const slots = worker.parseCrosswordGrid(GRID_TEXT);
  // "EDGY" is structurally consistent at C, but so would any other
  // 4-letter word matching D at index 1 (e.g. a wrong-but-coincidentally-
  // fitting adjective) -- checkCrosswordConsistency cannot and does not
  // claim to know which one is the CLUE's real intended answer.
  const fills = { A: "TIDY", C: "EDGY" };
  const conflicts = worker.checkCrosswordConsistency(slots, fills);
  assert.deepEqual(conflicts, []); // consistent, but this is NOT the same as "confirmed correct"
});
