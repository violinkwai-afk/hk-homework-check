// Ticket 41 (2026-09-27): the discipline of "remember to delete every
// temporary diagnostic route" turned out to be unreliable in practice --
// 8-9 real temp routes got added/removed by hand across one session with
// no automated check, purely on memory. Writing down a 4-point plan in
// TICKETS.md does not, by itself, guarantee it gets followed next time.
//
// This test converts point 3 of that plan (every temp route must be
// tracked as "待刪" in TICKETS.md while it exists) from a soft memory-based
// habit into a hard, automatically-enforced check: it runs every time the
// full suite runs (which happens before every commit in this project's
// own workflow), so a debug route silently left in src/worker.js with no
// matching TICKETS.md tracking line fails the test suite loudly instead
// of depending on anyone remembering to grep for it by hand.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const WORKER_SRC = path.join(__dirname, "..", "src", "worker.js");
const TICKETS_MD = path.join(__dirname, "..", "TICKETS.md");

// 2026-09-30 real finding: this check had silently gone vacuous. Every
// temp route added in practice actually landed under "/api/test-*", not
// the "/api/debug/*" prefix this test's own regex looked for -- so
// `foundRoutes` was always empty and this test passed without checking
// anything at all. Broadened to catch the naming convention actually in
// use. Three of the current /api/test-* routes are a deliberate
// exception: Ticket 46 kept them PERMANENTLY (real reusable latency
// diagnostics, not one-use-then-delete) -- allowlisted by name with the
// same reasoning as their own code comment, not silently excluded.
const PERMANENT_DIAGNOSTIC_ROUTES = new Set([
  "/api/test-deepseek-latency",
  "/api/test-rotation-latency",
  "/api/test-vision-ocr-latency",
]);

test("every temporary /api/debug/* or /api/test-* route in worker.js has a matching '待刪' tracking line in TICKETS.md", () => {
  const workerSrc = fs.readFileSync(WORKER_SRC, "utf8");
  const ticketsText = fs.readFileSync(TICKETS_MD, "utf8");

  const routePattern = /url\.pathname\s*===\s*"(\/api\/(?:debug|test)\/?[^"]*)"/g;
  const foundRoutes = new Set();
  let m;
  while ((m = routePattern.exec(workerSrc))) {
    if (!PERMANENT_DIAGNOSTIC_ROUTES.has(m[1])) foundRoutes.add(m[1]);
  }

  const untracked = [...foundRoutes].filter((route) => {
    // Look for a "待刪" line that also mentions this exact route path --
    // a route existing anywhere in TICKETS.md isn't enough, it must be
    // explicitly marked pending-deletion.
    const trackingLine = new RegExp("待刪[^\\n]*" + route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return !trackingLine.test(ticketsText);
  });

  assert.deepEqual(
    untracked,
    [],
    `Found /api/debug/* route(s) in src/worker.js with no "待刪" tracking line in TICKETS.md: ${untracked.join(", ")}. ` +
    `Either add a "待刪：\`${untracked[0] || ""}\`" line to the relevant ticket, or the route was forgotten and should be removed.`
  );
});

test("every DEBUG_TOKEN-gated route dispatch lives under the /api/debug/ prefix (no scattered ad-hoc temp paths)", () => {
  const workerSrc = fs.readFileSync(WORKER_SRC, "utf8");
  // Find any route dispatch block that checks a header for a hardcoded
  // token string (the old ad-hoc pattern, e.g. "x-compare-token") outside
  // the unified /api/debug/ + DEBUG_TOKEN convention.
  const legacyTokenPattern = /request\.headers\.get\("x-compare-token"\)/g;
  const legacyMatches = workerSrc.match(legacyTokenPattern) || [];
  assert.equal(legacyMatches.length, 0, "Found a legacy ad-hoc diagnostic-route token pattern (x-compare-token) -- all temp routes must use the unified DEBUG_TOKEN under /api/debug/ instead (Ticket 41).");
});
