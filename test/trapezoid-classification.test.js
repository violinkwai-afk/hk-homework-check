// Ticket 204 (trapezoid sub-type classification) -- NOT WIRED into
// QUESTION_TYPE_HANDLERS. See classifyTrapezoidType's own long comment
// in src/worker.js and TICKETS.md for the full real finding: tested
// against the real citation (26週數學訓練 P3 Topic 22 梯形,
// math34pdf/p57.png Q1), classifyTrapezoidType's own geometry logic is
// correct, but the SHARED shape classifier it depends on
// (readShapeClassificationFromPixels) mis-detects this citation's real
// shapes -- a pale fill colour produces corner-jag artifacts that split
// a real 4-vertex trapezoid's corner into 6-7 spurious vertices. Fixing
// that needs care against Ticket 197's own already-shipped real
// citations (regression risk), not attempted in this pass.
//
// These tests verify classifyTrapezoidType's own geometry logic in
// isolation using disclosed SYNTHETIC point sets (clean, hand-computed
// quadrilateral coordinates, not from a real photo) -- this is
// deliberately narrower than this project's usual real-citation
// standard, exactly because the real-photo integration is the known
// blocked part, not this function's own math.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_trapezoid.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_trapezoid.mjs");

let worker;
test.before(async () => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_trapezoid.mjs"');
  fs.writeFileSync(TMP, src);
  worker = await import(TMP);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

test("classifyTrapezoidType: synthetic right trapezoid (one 90deg corner)", () => {
  // (0,0)-(10,0) top base, (0,10)-(6,10) bottom base, left leg vertical
  // (perpendicular to both bases), right leg slanted.
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 6, y: 10 }, { x: 0, y: 10 }];
  assert.equal(worker.classifyTrapezoidType(points), "right");
});

test("classifyTrapezoidType: synthetic isosceles trapezoid (equal legs, no right angle)", () => {
  const points = [{ x: 2, y: 0 }, { x: 8, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(worker.classifyTrapezoidType(points), "isosceles");
});

test("classifyTrapezoidType: synthetic scalene trapezoid (unequal legs, no right angle)", () => {
  const points = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 10, y: 10 }, { x: -8, y: 10 }];
  assert.equal(worker.classifyTrapezoidType(points), "scalene");
});

test("classifyTrapezoidType: a parallelogram (TWO parallel pairs) is correctly rejected", () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 13, y: 10 }, { x: 3, y: 10 }];
  assert.equal(worker.classifyTrapezoidType(points), null);
});

test("classifyTrapezoidType: a non-trapezoid quadrilateral (no parallel pair) is correctly rejected", () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 8, y: 10 }, { x: 1, y: 6 }];
  assert.equal(worker.classifyTrapezoidType(points), null);
});

test("classifyTrapezoidType: non-quadrilateral input fails open (null)", () => {
  assert.equal(worker.classifyTrapezoidType([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]), null);
  assert.equal(worker.classifyTrapezoidType(null), null);
});

test("trapezoid_type_letters handler: NOT registered (disclosed, blocked -- see TICKETS.md)", () => {
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "trapezoid_type_letters");
  assert.equal(handler, undefined);
});
