// Ticket 46 (2026-09-27): found 3 real, live routes (test-deepseek-latency,
// test-rotation-latency, test-vision-ocr-latency) that trigger real paid
// API calls (DeepSeek/OpenRouter/Google Vision) with ZERO auth or rate
// limiting -- anyone who knows the URL can spend the project owner's
// money for free, indefinitely. These predate the Ticket 41 DEBUG_TOKEN
// discipline and slipped through because nothing ever checked for this
// class of gap automatically -- a human has to remember to look, which
// this session already demonstrated is unreliable (see
// feedback-convert-discipline-into-automated-checks.md).
//
// This is a STATIC, heuristic check, not a proof of security: it can't
// see cost hidden behind an indirect call chain it doesn't recognise, and
// "contains RATE_LIMIT_KV somewhere in the function body" is a proxy for
// "has some protection", not a guarantee that protection is correct or
// sufficient. Its job is narrower and honest: catch the exact shape of
// gap Ticket 46 found (a route handler that calls a real paid API with
// NO guard marker anywhere in its body) so it can never silently
// reappear unnoticed, the way it did this time.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const WORKER_SRC = path.join(__dirname, "..", "src", "worker.js");

// Markers that indicate SOME form of access control or cost-avoidance is
// present in a handler: a rate-limit bucket, the unified debug token
// (Ticket 41), Telegram's own webhook secret check, or the "Anthropic
// disabled" cost kill-switch (which makes the call a guaranteed no-op).
const GUARD_MARKERS = ["RATE_LIMIT_KV", "DEBUG_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "DISABLE_ANTHROPIC_DURING_TESTING"];

// Substrings that indicate a handler actually reaches a real, billed
// external API, directly or via one of this file's own wrapper
// functions -- not an exhaustive list of every possible future paid
// call, but covers every real one in this codebase today.
const PAID_CALL_MARKERS = ["fetch(", "callQwen(", "callDeepSeek(", "callOcrTranscribe(", "callClaude(", "googleOcr(", "callAiFallbackJudge(", "callJevPreCheck("];

function extractFunctionBody(src, fnName) {
  const startMatch = new RegExp(`(?:async )?function ${fnName}\\s*\\(`).exec(src);
  if (!startMatch) return null;
  const braceStart = src.indexOf("{", startMatch.index);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  return null;
}

// Some route dispatch entries (e.g. handleCheck) are a thin try/catch
// wrapper that immediately delegates to an "Inner" function holding the
// real logic (including where its rate-limit guard actually lives) --
// without following that indirection, this check would false-positive on
// every such wrapper. Shallow (2-level) local-call resolution: pull in
// the body of any other `handleXxx(...)`-shaped function this handler
// itself calls, so guard markers living one level down are still seen.
function resolveBodyWithLocalCalls(src, fnName, depth = 2) {
  const body = extractFunctionBody(src, fnName);
  if (!body) return "";
  if (depth <= 0) return body;
  const calledNames = new Set();
  const callPattern = /\b(handle\w+)\s*\(/g;
  let m;
  while ((m = callPattern.exec(body))) {
    if (m[1] !== fnName) calledNames.add(m[1]);
  }
  let combined = body;
  for (const name of calledNames) combined += "\n" + resolveBodyWithLocalCalls(src, name, depth - 1);
  return combined;
}

test("every route handler that can reach a real paid API has at least one recognised guard marker", () => {
  const src = fs.readFileSync(WORKER_SRC, "utf8");

  // Pull each "url.pathname === '/api/...'" dispatch line's handler
  // function name from the line(s) immediately following it.
  const dispatchPattern = /url\.pathname === "([^"]+)"[^\n]*\n\s*return (\w+)\(/g;
  const routes = [];
  let m;
  while ((m = dispatchPattern.exec(src))) routes.push({ path: m[1], handler: m[2] });

  assert.ok(routes.length >= 8, `expected to find the known route dispatch table, only matched ${routes.length} -- the dispatch pattern regex may need updating if worker.js's routing style changed`);

  const unguarded = [];
  for (const { path: routePath, handler } of routes) {
    const body = resolveBodyWithLocalCalls(src, handler);
    if (!body) continue; // handler defined via a different pattern (e.g. inline arrow) -- not one of today's real routes, skip rather than false-positive
    const hasPaidCall = PAID_CALL_MARKERS.some((marker) => body.includes(marker));
    if (!hasPaidCall) continue; // no real API cost reachable -- nothing to guard
    const hasGuard = GUARD_MARKERS.some((marker) => body.includes(marker));
    if (!hasGuard) unguarded.push(`${routePath} -> ${handler}`);
  }

  assert.deepEqual(
    unguarded,
    [],
    `Found route(s) that call a real paid API with no recognised guard marker (${GUARD_MARKERS.join("/")}): ${unguarded.join(", ")}. ` +
    `Add rate limiting, a DEBUG_TOKEN check, or remove the route -- an unguarded route is real, uncapped API spend anyone can trigger (Ticket 46).`
  );
});
