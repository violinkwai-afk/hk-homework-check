// Regression tests for /api/mark (2026-09-21 fixes, second pass):
// per-page Qwen OCR (not one combined multi-image call), bounded
// concurrency, one page's failure isolated from the rest, parseOcrLine
// no longer comma-dependent + fails safe on an over-long merged answer,
// verifyMath tolerates a leading "=" echoed into the answer, and
// findBboxForItem's short-needle tie-break (prefer a match followed by
// a literal "=").
//
// No real worksheet photos exist anywhere on this machine (checked
// before the first pass of this suite) -- these tests run the REAL
// worker code (copy src/worker.js to a temp .mjs, sed-replace the
// @cf-wasm/photon/workerd import to /node, mock global.fetch) against
// hand-built synthetic Vision/Qwen fixtures. They are not a substitute
// for a real-photo E2E run (see the 2026-09-21/22 real-API test results
// in memory) -- they prove the LOGIC is correct on known inputs.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PAGE0, PAGE1, PAGE2 } = require("./fixtures.js");

const SRC = path.join(__dirname, "..", "src", "worker.js");
const TMP = path.join(__dirname, "..", "src", "worker_nodetest_mark.mjs");
// worker.js also imports ./annotate.js (2026-09-22 Telegram MVP), which
// itself imports the workerd-only Photon entrypoint -- needs the same
// sed-replace treatment, or every test in this file fails at import time.
// Own temp filename (distinct from telegram.test.js's) so the two test
// files' harnesses can never collide.
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_mark.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const src = fs.readFileSync(SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_mark.mjs"');
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

function visionResponseFor(pageFixture) {
  return {
    responses: [{
      fullTextAnnotation: {
        pages: [{
          width: pageFixture.width,
          height: pageFixture.height,
          blocks: pageFixture.words.map((w) => ({
            boundingBox: { vertices: [{ x: w.x, y: w.y }, { x: w.x + w.w, y: w.y }, { x: w.x + w.w, y: w.y + w.h }, { x: w.x, y: w.y + w.h }] },
            paragraphs: [{
              words: [{
                boundingBox: { vertices: [{ x: w.x, y: w.y }, { x: w.x + w.w, y: w.y }, { x: w.x + w.w, y: w.y + w.h }, { x: w.x, y: w.y + w.h }] },
                symbols: w.text.split("").map((ch) => ({ text: ch })),
              }],
            }],
          })),
        }],
      },
    }],
  };
}

// One combined "label=printed|answer" OCR line, matching OCR_ONLY_PROMPT's
// requested format (parseOcrLine's grammar).
function qwenLineFor(items) {
  return items.map((it) => `${it.label}=${it.printed}|${it.answer}`).join(",");
}

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}
function markerFromB64(data) {
  return Buffer.from(data, "base64").toString("utf8");
}

const PAGE_BY_MARKER = { PAGE0, PAGE1, PAGE2 };

// `qwenByMarker`: { MARKER: responseText | { error: true } } -- one entry
// per PAGE (since /api/mark now makes one Qwen call per image). A marker
// mapped to `{ error: true }` simulates that page's Qwen call failing
// (used for the page-isolation tests).
function mockFetch(qwenByMarker) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes("openrouter.ai")) {
      const body = JSON.parse(opts.body);
      const content = body.messages[0].content;
      const imageBlock = content.find((c) => c.type === "image_url");
      const dataUrl = imageBlock.image_url.url; // "data:image/jpeg;base64,<marker-b64>"
      const b64data = dataUrl.split(",")[1];
      const marker = markerFromB64(b64data);
      const entry = qwenByMarker[marker];
      if (entry === undefined) throw new Error("no mocked Qwen response for marker: " + marker);
      if (entry && entry.error) {
        return new Response("upstream failure", { status: 502 });
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: entry } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    if (u.includes("vision.googleapis.com")) {
      const body = JSON.parse(opts.body);
      const marker = Buffer.from(body.requests[0].image.content, "base64").toString("utf8");
      const page = PAGE_BY_MARKER[marker];
      if (!page) return new Response(JSON.stringify({ responses: [{}] }), { status: 200 });
      return new Response(JSON.stringify(visionResponseFor(page)), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
}

// `opts.headers` merges into the request (e.g. a fake CF-Connecting-IP
// for rate-limit tests); `opts.env` merges into (and can override) the
// base env, e.g. to inject a fake RATE_LIMIT_KV. `opts.fetchSpy`, if
// given, is called once per intercepted fetch -- used to prove a
// rejected request never reached the mocked Qwen/Vision call at all.
async function callMark(images, qwenByMarker, opts = {}) {
  const worker = await import(TMP);
  const originalFetch = global.fetch;
  const inner = mockFetch(qwenByMarker);
  global.fetch = async (...args) => {
    if (opts.fetchSpy) opts.fetchSpy();
    return inner(...args);
  };
  try {
    const req = new Request("https://example.com/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      body: JSON.stringify({ images }),
    });
    const env = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      GOOGLE_VISION_API_KEY: "test-vision-key",
      ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
      ...(opts.env || {}),
    };
    const res = await worker.default.fetch(req, env);
    return { status: res.status, json: await res.json() };
  } finally {
    global.fetch = originalFetch;
  }
}

// Minimal fake KV (get/put only, matches what the rate-limit code uses)
// pre-seeded with a given request count for one IP's bucket.
function fakeRateLimitKV(ip, existingCount) {
  const store = existingCount == null ? {} : { ["markrate:" + ip]: String(existingCount) };
  return {
    get: async (key) => (key in store ? store[key] : null),
    put: async (key, value) => { store[key] = value; },
  };
}

test("two-column page: each item maps bbox to its OWN column, not the wrong one", async () => {
  const items = [
    { label: "1", printed: "4+6=", answer: "10" },   // left col, top
    { label: "2", printed: "4+60=", answer: "64" },  // right col, top -- shares a numeric prefix with #1
    { label: "3", printed: "23+5=", answer: "28" },  // left col, bottom
    { label: "4", printed: "23+50=", answer: "73" }, // right col, bottom -- shares a numeric prefix with #3
  ];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  assert.equal(json.results.length, 4);
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));

  for (const label of ["1", "2", "3", "4"]) {
    assert.equal(byLabel[label].correct, true, `item ${label} should verify as correct`);
    assert.equal(byLabel[label].page, 0, `item ${label} should be on page 0`);
    assert.ok(byLabel[label].bbox, `item ${label} should have a bbox match`);
  }
  assert.ok(byLabel["1"].bbox.x < 50, "item 1 (left col) bbox.x should be < 50%");
  assert.ok(byLabel["2"].bbox.x >= 50, "item 2 (right col) bbox.x should be >= 50%");
  assert.ok(byLabel["3"].bbox.x < 50, "item 3 (left col) bbox.x should be < 50%");
  assert.ok(byLabel["4"].bbox.x >= 50, "item 4 (right col) bbox.x should be >= 50%");
});

test("multi-page: items are attributed to their REAL page (structural, one Qwen call per page)", async () => {
  const page0Items = [{ label: "1", printed: "4+6=", answer: "10" }];
  const page1Items = [
    { label: "5", printed: "7+8=", answer: "15" },
    { label: "6", printed: "9+2=", answer: "12" }, // deliberately wrong (9+2=11)
  ];
  const images = [
    { data: b64("PAGE0"), mediaType: "image/jpeg" },
    { data: b64("PAGE1"), mediaType: "image/jpeg" },
  ];
  const { json } = await callMark(images, {
    PAGE0: qwenLineFor(page0Items),
    PAGE1: qwenLineFor(page1Items),
  });
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));

  assert.equal(byLabel["1"].page, 0);
  assert.equal(byLabel["5"].page, 1);
  assert.equal(byLabel["6"].page, 1);
  assert.equal(byLabel["6"].correct, false, "9+2=12 should verify as wrong");
  assert.equal(byLabel["6"].correctAnswer, "11");
});

test("one page's Qwen failure does NOT take down the other pages (2026-09-21 real failure)", async () => {
  const page0Items = [{ label: "1", printed: "4+6=", answer: "10" }];
  const page1Items = [{ label: "5", printed: "7+8=", answer: "15" }];
  const images = [
    { data: b64("PAGE0"), mediaType: "image/jpeg" },
    { data: b64("PAGE1"), mediaType: "image/jpeg" }, // this page's Qwen call will fail
    { data: b64("PAGE2"), mediaType: "image/jpeg" },
  ];
  const { status, json } = await callMark(images, {
    PAGE0: qwenLineFor(page0Items),
    PAGE1: { error: true },
    PAGE2: qwenLineFor([{ label: "9", printed: "4+6=", answer: "10" }]),
  });
  assert.equal(status, 200, "a partial failure should still be a 200 with the successful pages' results");
  assert.equal(json.results.length, 2, "only the 2 successful pages' items should be present");
  const pages = json.results.map((r) => r.page).sort();
  assert.deepEqual(pages, [0, 2], "page 1 (the failed one) must contribute nothing, but 0 and 2 must be unaffected");
  assert.ok(json.pageErrors && json.pageErrors.some((e) => e.page === 1), "the failure must be reported, not silently swallowed");
});

test("every page failing returns a clean 502, not a crash", async () => {
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { status, json } = await callMark(images, { PAGE0: { error: true } });
  assert.equal(status, 502);
  assert.equal(json.error, "upstream_error");
});

test("split tokens: an expression split across 4 separate word tokens still matches", async () => {
  const items = [{ label: "1", printed: "4+6=", answer: "10" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const r = json.results[0];
  assert.ok(r.bbox, "split-token expression should still resolve a bbox");
  assert.equal(r.page, 0);
});

test("short/similar-prefix collision: the '=' tie-break now prefers the REAL question over a stray token pair", async () => {
  // PAGE2 has stray "4"/"6" tokens (needle "46", the algorithm's 2-char
  // minimum) BEFORE the real "4+6=" question, NOT followed by "=". The
  // real question IS followed by "=". Both ties on raw matched length
  // (2026-09-21 review found this was a real, demonstrated collision) --
  // the "=" tie-break added in the same review should now resolve it
  // correctly instead of just documenting the limitation.
  const items = [{ label: "1", printed: "4+6=", answer: "10" }];
  const images = [{ data: b64("PAGE2"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE2: qwenLineFor(items) });
  const r = json.results[0];
  assert.ok(r.bbox, "a match should be found");
  // PAGE2 height is 400: the real question (y=100) is 25%, the stray
  // header tokens (y=5) are ~1%. A wide margin, not >50, is the correct
  // discriminator here -- neither candidate is anywhere near the bottom
  // half of the page.
  assert.ok(r.bbox.y > 10, "should match the REAL question (y=100 -> 25%), not the stray header tokens (y=5 -> ~1%)");
});

test("bare numeric answer against a clean printed expression: verified correct/wrong deterministically", async () => {
  const items = [
    { label: "8", printed: "10+4=", answer: "14" },  // bare number, correct
    { label: "9", printed: "10+4=", answer: "15" },  // bare number, wrong
  ];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));
  assert.equal(byLabel["8"].correct, true);
  assert.equal(byLabel["8"].status, "ok");
  assert.equal(byLabel["9"].correct, false);
  assert.equal(byLabel["9"].correctAnswer, "14");
});

test("2026-09-22: previously-unreachable verifiers (comparison_symbol, number_word_conversion, missing_digits_in_equation) are now actually reachable through the REAL /api/mark path, not just callable in isolation -- classifyAndVerify is now the live dispatcher (user instruction: 全部判斷邏輯都要駁去真正用緊嗰一條路)", async () => {
  const items = [
    { label: "1", printed: "7 ___ 17", answer: ">" },        // WRONG (7 < 17) -- comparison_symbol
    { label: "2", printed: "3 ___ 1", answer: ">" },          // correct -- comparison_symbol
    { label: "3", printed: "The number 'twenty-six' is", answer: "26" }, // number_word_conversion
    { label: "4", printed: "2□9+32=□9□", answer: "2" },       // ambiguous shape for this harness (two blanks, one filled) -- exercised mainly to confirm the handler is REACHED, not necessarily solvable from a single-digit answer string
    { label: "5", printed: "328-214=", answer: "114" },       // plain arithmetic -- must still verify exactly as before (no regression)
  ];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));

  assert.equal(byLabel["1"].correct, false, "comparison_symbol handler must be reached and correctly reject 7>17");
  assert.equal(byLabel["2"].correct, true, "comparison_symbol handler must be reached and accept 3>1");
  assert.equal(byLabel["3"].correct, true, "number_word_conversion handler must be reached: 'twenty-six' <-> 26");
  // 2026-09-23 (challenge-all review finding): item 4 was in this test with
  // NO assertion at all -- a regression in missing_digits_in_equation's
  // dispatch (wrong handler picked, or a silent throw) would have passed
  // silently. The public /api/mark response doesn't expose which handler
  // fired (only `subject`), so this checks classifyAndVerify directly
  // (exported for tests) instead of guessing a hand-solved expected value.
  assert.equal(byLabel["5"].correct, true, "plain arithmetic must still verify correctly -- no regression from the dispatcher swap");
});

test("2026-09-23: item 4's shape ('2□9+32=□9□') is actually routed to missing_digits_in_equation, not silently swallowed by another handler", async () => {
  const worker = await import(TMP);
  const verdict = worker.classifyAndVerify({ printedQuestion: "2□9+32=□9□", studentAnswer: "2" });
  assert.equal(verdict.handler, "missing_digits_in_equation");
});

test("SUBTRACTION regression (2026-09-22 real-paper find): '328-214=' with correct answer 114 verifies TRUE, not null", async () => {
  // Before the fix, evalArithmetic's tokenizer greedily swallowed the "-"
  // into the next number ("328","-214" -- 2 tokens) instead of splitting it
  // out as the operator ("328","-","214" -- 3 tokens), so EVERY plain
  // two-number subtraction silently returned null (needs_review) even when
  // the student's answer was exactly correct. No prior test in this file
  // happened to cover plain subtraction through this path (all existing
  // arithmetic tests use addition or division) -- found only by running a
  // real, un-cherry-picked exam paper through the real code.
  const items = [
    { label: "3", printed: "328-214=", answer: "114" },  // correct
    { label: "4", printed: "927-594=", answer: "333" },  // correct
    { label: "5", printed: "845-288=", answer: "999" },  // WRONG, must not be silently accepted either
  ];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));
  assert.equal(byLabel["3"].correct, true);
  assert.equal(byLabel["3"].status, "ok");
  assert.equal(byLabel["4"].correct, true);
  assert.equal(byLabel["5"].correct, false);
  assert.equal(byLabel["5"].correctAnswer, "557");
});

test("leading '=' echoed into the answer (2026-09-21 real failure) is stripped and verifies correctly", async () => {
  // Real failure: on a worksheet where the printed "=" sits right before
  // the answer box, OCR returned "=5" as the answer instead of "5" for
  // every item, and every one of them wrongly fell into the full-equation
  // branch with an empty LHS -> null, even though the answers were
  // trivially verifiable (25÷5=5).
  const items = [
    { label: "1", printed: "25÷5=", answer: "=5" },   // correct, once "=" is stripped
    { label: "2", printed: "12÷3=", answer: "=5" },   // WRONG (12÷3=4, not 5) -- must still catch real errors
  ];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));
  assert.equal(byLabel["1"].correct, true, "=5 for 25÷5 should verify as correct once the leading = is stripped");
  assert.equal(byLabel["1"].status, "ok");
  assert.equal(byLabel["2"].correct, false, "=5 for 12÷3 should still verify as WRONG, not just pass through blindly");
  assert.equal(byLabel["2"].correctAnswer, "4");
});

test("leading '=' fix does not break A's already-correct full-equation cases", async () => {
  const items = [{ label: "1", printed: "4+6=", answer: "6 + 4 = 10" }]; // no leading "=", full equation
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  assert.equal(json.results[0].correct, true);
});

test("bare numeric answer against an UNPARSEABLE printed question: honestly needs_review, never guessed", async () => {
  const items = [{ label: "10", printed: "How many apples in total?", answer: "9" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const r = json.results[0];
  assert.equal(r.correct, null);
  assert.equal(r.status, "needs_review");
  assert.equal(r.verifiedBy, "pending");
});

test("Chinese-subject item: always null/needs_review, never a fake reliable verdict", async () => {
  const items = [{ label: "7", printed: "男仔叫咩名？", answer: "阿明" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const r = json.results[0];
  assert.equal(r.subject, "chinese");
  assert.equal(r.correct, null);
  assert.equal(r.status, "needs_review");
});

test("needs_review item logs mark_unresolved_question with the PRINTED question only, never the student's answer", async () => {
  const items = [{ label: "7", printed: "男仔叫咩名？", answer: "阿明" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await callMark(images, { PAGE0: qwenLineFor(items) });
  } finally {
    console.log = originalLog;
  }
  const events = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const unresolved = events.filter((e) => e.event === "mark_unresolved_question");
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].subject, "chinese");
  assert.equal(unresolved[0].printedQuestion, "男仔叫咩名？");
  assert.ok(!("studentAnswer" in unresolved[0]), "must never log the student's own answer");
  assert.ok(!JSON.stringify(unresolved[0]).includes("阿明"), "the student's answer text must not leak in anywhere");
});

test("a resolved (non-needs_review) item does NOT log mark_unresolved_question", async () => {
  const items = [{ label: "1", printed: "4+6=", answer: "10" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
    assert.equal(json.results[0].correct, true);
  } finally {
    console.log = originalLog;
  }
  const events = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.equal(events.filter((e) => e.event === "mark_unresolved_question").length, 0);
});

test("no bbox match: returns null, not {x:0,y:0,w:0,h:0}", async () => {
  const items = [{ label: "1", printed: "totally-unrelated-text-not-on-any-page", answer: "x" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const r = json.results[0];
  assert.equal(r.bbox, null);
  assert.equal(r.page, 0, "page is now always the real page a Qwen call ran against, even with no bbox match");
});

test("riskyDiagram is null (not implemented), never a fake false", async () => {
  const items = [{ label: "1", printed: "4+6=", answer: "10" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  assert.equal(json.results[0].riskyDiagram, null);
});

test("parseOcrLine: a FULL-WIDTH comma between items is recognised as a boundary (the original real fix, kept)", async () => {
  const raw = "3=18÷4=|4，4=5x8=|40，5=9x7=|63，6=4x6=|24";
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: raw });
  const labels = json.results.map((r) => r.question).sort();
  assert.deepEqual(labels, ["3", "4", "5", "6"], "all four items should be recovered as separate items, not merged into one");
});

// 2026-09-22 REGRESSION, caught on the very next real-photo re-test after
// the first fix shipped: removing the comma-anchor (to handle a
// hypothesized missing/full-width-comma case) broke the COMMON, previously
// correct case -- a worksheet that scored 10/15 correctly under the
// original comma-anchored parser scored 0/15 once the anchor was removed,
// because a genuine answer like "6+4=10" contains its own "=", and an
// anchor-free scanner matched "6+4" as a spurious label for the NEXT item,
// shifting every subsequent item's real answer into the wrong slot. This
// is the single most important regression test in this file: it must
// keep passing even if parseOcrLine is touched again for some other
// reason.
test("parseOcrLine: comma-separated items whose ANSWERS are themselves full equations (containing their own '=') do not shift into the wrong item", async () => {
  const items = [
    { label: "1", printed: "4+6=", answer: "6+4=10" },
    { label: "2", printed: "2+5=", answer: "5+2=7" },
    { label: "3", printed: "3+4=", answer: "4+3=7" },
  ];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));
  assert.equal(byLabel["1"].studentAnswer, "6+4=10");
  assert.equal(byLabel["2"].studentAnswer, "5+2=7");
  assert.equal(byLabel["3"].studentAnswer, "4+3=7");
  assert.equal(byLabel["1"].correct, true);
  assert.equal(byLabel["2"].correct, true);
  assert.equal(byLabel["3"].correct, true);
});

test("parseOcrLine: a genuinely separator-less boundary (no comma at all, trailing digit fragment) is a KNOWN unresolved limitation -- documented, not hidden", async () => {
  // Honest limitation, not something this parser can fix: if the model
  // concatenates one item's answer directly against the next item's
  // label with NOTHING between them at all (not even a comma), there is
  // no boundary signal left to anchor on. Comma-anchoring (restored
  // above, after the 2026-09-22 regression) means this case simply isn't
  // recovered -- the fragment is silently absorbed into the preceding
  // item's answer instead of being misattributed to a wrong label, which
  // is the safer of the two failure modes (an overlong/garbled answer at
  // least trips MAX_ANSWER_LEN or fails evalArithmetic, rather than
  // confidently mis-crediting the wrong item).
  const raw = "3=18÷4=|24=5x8=|40";
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: raw });
  assert.ok(json.results.length >= 1, "should not crash on this input, even though the split is ambiguous");
});

test("parseOcrLine: an answer far too long to be real is flagged and forced to needs_review, not silently shown as normal", async () => {
  const longAnswer = "x".repeat(120);
  const raw = `1=4+6|${longAnswer}`;
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: raw });
  const r = json.results[0];
  assert.equal(r.correct, null, "an item flagged parseFailed must never produce a confident correct/incorrect verdict");
  assert.equal(r.status, "needs_review");
});

test("full-width punctuation (，＝｜) from the model is normalised, not silently dropped", async () => {
  const raw = "1=4+6|10，2=7+8|15";
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: raw });
  const labels = json.results.map((r) => r.question).sort();
  assert.deepEqual(labels, ["1", "2"]);
});

// 2026-09-22 CANARY, not a passing design goal: confirmed via debug data
// (raw OCR text `5=54÷9|6`, captured in-band since wrangler tail never
// worked for this preview branch) that BOTH Qwen3-VL-8B and
// Qwen3-VL-30B-A3B, on a real "blank-in-the-middle" division worksheet
// (printed "54÷▢=6", student fills in the divisor "9"), stopped doing
// pure OCR and instead embedded the student's own handwritten digit
// INTO printedQuestion ("54÷9") while reporting the worksheet's own
// PRE-PRINTED quotient (6) as studentAnswer. verifyMath then correctly
// computes 54÷9=6 and matches -- the verdict isn't arithmetically
// wrong, but studentAnswer no longer represents what the student
// actually wrote, and any bbox built from it points at the wrong
// location. This is a real violation of the OCR-only/no-judging
// design, not just a display quirk -- and the CURRENT deterministic
// layer (parseOcrLine/verifyMath) has NO way to detect it: a
// legitimately printed "54÷9=" with bare answer "6" looks structurally
// identical. There is no fix here yet, only detection: this test locks
// in the exact known-bad shape so a future model swap that reintroduces
// it doesn't go unnoticed. If this assertion ever needs to change
// (e.g. because a real structural fix makes this null/needs_review
// instead), that's a deliberate, verified improvement -- update the
// assertion and this comment together, don't just delete the test.
test("CANARY -- printed/answer swap on blank-in-the-middle division is NOT detected (known limitation, not fixed)", async () => {
  const raw = "1=25÷5|5,2=12÷3|4,3=18÷2|9,4=48÷6|8,5=54÷9|6,6=56÷8|7,7=42÷6|7,8=36÷4|9";
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: raw });
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));

  // Items 1-4 are a genuine, unambiguous "printed=clean expression,
  // answer=bare number" shape -- not the swap pattern -- and should
  // keep verifying correctly regardless of what happens with 5-8.
  for (const label of ["1", "2", "3", "4"]) {
    assert.equal(byLabel[label].correct, true, `item ${label} (not the swap shape) should still verify correctly`);
  }

  // Items 5-8: the swap shape. Documenting CURRENT (undesirable)
  // behavior -- these report correct:true even though studentAnswer
  // doesn't represent the student's real handwriting.
  for (const label of ["5", "6", "7", "8"]) {
    assert.equal(byLabel[label].correct, true, `item ${label}: known false-positive from the printed/answer swap -- see comment above`);
  }
});

test("bounded concurrency: 3 pages all resolve correctly with MARK_PAGE_CONCURRENCY=2", async () => {
  const images = [
    { data: b64("PAGE0"), mediaType: "image/jpeg" },
    { data: b64("PAGE1"), mediaType: "image/jpeg" },
    { data: b64("PAGE2"), mediaType: "image/jpeg" },
  ];
  const { json } = await callMark(images, {
    PAGE0: qwenLineFor([{ label: "a", printed: "4+6=", answer: "10" }]),
    PAGE1: qwenLineFor([{ label: "b", printed: "7+8=", answer: "15" }]),
    PAGE2: qwenLineFor([{ label: "c", printed: "4+6=", answer: "10" }]),
  });
  assert.equal(json.results.length, 3);
  const pages = json.results.map((r) => r.page).sort();
  assert.deepEqual(pages, [0, 1, 2]);
});

// 2026-09-22: /api/mark previously had NO rate limit and NO page-count
// cap at all (flagged by challenge-all as a real scale blocker before
// this ever gets wired to the frontend). Both follow /api/check's
// existing conventions (same RATE_LIMIT_KV pattern/threshold, same
// MAX_PAGES value) rather than inventing a new scheme.

test("page limit: exactly MARK_MAX_PAGES (5) is allowed", async () => {
  const images = Array.from({ length: 5 }, (_, i) => ({ data: b64(["PAGE0", "PAGE1", "PAGE2"][i % 3]), mediaType: "image/jpeg" }));
  const qwenByMarker = {
    PAGE0: qwenLineFor([{ label: "a", printed: "4+6=", answer: "10" }]),
    PAGE1: qwenLineFor([{ label: "b", printed: "7+8=", answer: "15" }]),
    PAGE2: qwenLineFor([{ label: "c", printed: "4+6=", answer: "10" }]),
  };
  const { status, json } = await callMark(images, qwenByMarker);
  assert.equal(status, 200);
  assert.equal(json.results.length, 5);
});

test("page limit: MARK_MAX_PAGES+1 (6) is rejected BEFORE any AI call", async () => {
  const images = Array.from({ length: 6 }, (_, i) => ({ data: b64(["PAGE0", "PAGE1", "PAGE2"][i % 3]), mediaType: "image/jpeg" }));
  let fetchCalls = 0;
  const { status, json } = await callMark(images, {}, { fetchSpy: () => { fetchCalls++; } });
  assert.equal(status, 400);
  assert.equal(json.error, "too_many_pages");
  assert.equal(fetchCalls, 0, "must reject before touching Qwen/Vision at all, not just before returning a result");
});

test("rate limit: under the threshold is allowed, and the counter increments", async () => {
  const ip = "1.2.3.4";
  const kv = fakeRateLimitKV(ip, 10); // well under CHECK_RATE_LIMIT (40)
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { status } = await callMark(images, { PAGE0: qwenLineFor([{ label: "1", printed: "4+6=", answer: "10" }]) }, {
    headers: { "CF-Connecting-IP": ip },
    env: { RATE_LIMIT_KV: kv },
  });
  assert.equal(status, 200);
  assert.equal(await kv.get("markrate:" + ip), "11", "the per-IP counter should have incremented");
});

test("rate limit: at the threshold is rejected BEFORE any AI call, with its own bucket separate from /api/check", async () => {
  const ip = "5.6.7.8";
  const kv = fakeRateLimitKV(ip, 40); // == CHECK_RATE_LIMIT
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  let fetchCalls = 0;
  const { status, json } = await callMark(images, {}, {
    headers: { "CF-Connecting-IP": ip },
    env: { RATE_LIMIT_KV: kv },
    fetchSpy: () => { fetchCalls++; },
  });
  assert.equal(status, 429);
  assert.equal(json.error, "rate_limited");
  assert.equal(fetchCalls, 0, "must reject before touching Qwen/Vision at all");
  // A checkrate: bucket at the same count for the same IP must not
  // affect /api/mark -- proves the buckets are genuinely separate, not
  // just separately-named but accidentally sharing logic.
  assert.equal(await kv.get("checkrate:" + ip), null, "this test never touched /api/check's bucket");
});

// 2026-09-22 Tier 1: blank-in-the-middle single-blank substitution.
// Real 235B output confirmed (in-band debug against real photos B/C)
// printedQuestion correctly preserves a blank token ("?" or "□") while
// studentAnswer correctly holds just the handwritten fill-in -- no
// CANARY-style swap. These tests exercise trySubstituteBlank() through
// the real pipeline, not in isolation, so parseOcrLine's own splitting
// is exercised too.

test("Tier 1: 54÷?=6 with answer 9 verifies CORRECT (real captured shape, '?' token)", async () => {
  const items = [{ label: "5", printed: "54÷?=6", answer: "9" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const r = json.results[0];
  assert.equal(r.correct, true, "54÷9=6 is arithmetically true");
  assert.equal(r.status, "ok");
});

test("Tier 1: 4×□=24 with answer 6 verifies CORRECT (real captured shape, '□' token, blank as 2nd operand)", async () => {
  const items = [{ label: "4", printed: "4×□=24", answer: "6" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const r = json.results[0];
  assert.equal(r.correct, true, "4×6=24 is arithmetically true");
});

test("Tier 1: □×4=24 with answer 6 verifies CORRECT (blank as 1st/left operand)", async () => {
  const items = [{ label: "4", printed: "□×4=24", answer: "6" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const r = json.results[0];
  assert.equal(r.correct, true, "6×4=24 is arithmetically true");
});

test("Tier 1: 54÷?=6 with a WRONG answer (8) verifies INCORRECT, not silently accepted", async () => {
  const items = [{ label: "5", printed: "54÷?=6", answer: "8" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const r = json.results[0];
  assert.equal(r.correct, false, "54÷8=6.75, not 6 -- must not be waved through as correct");
});

test("Tier 1: zero blank tokens does NOT trigger substitution -- ordinary items behave exactly as before", async () => {
  // "10+4=" has no "?" or "□" at all; this must go through the
  // pre-existing case 2 (bare answer vs clean printed expression) path
  // completely unchanged.
  const items = [
    { label: "8", printed: "10+4=", answer: "14" },
    { label: "9", printed: "10+4=", answer: "15" },
  ];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));
  assert.equal(byLabel["8"].correct, true);
  assert.equal(byLabel["9"].correct, false);
  assert.equal(byLabel["9"].correctAnswer, "14");
});

test("Tier 1: TWO blank tokens in one printedQuestion is ambiguous -- must stay needs_review/null, never guess which one", async () => {
  const items = [{ label: "6", printed: "□+□=10", answer: "5" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) });
  const r = json.results[0];
  assert.equal(r.correct, null, "ambiguous which blank '5' fills -- must not guess a position");
  assert.equal(r.status, "needs_review");
});

test("Tier 1 does not touch the original CANARY false-positive shape (no blank token present, so trySubstituteBlank never applies)", async () => {
  // "54÷9" (the SWAPPED shape from the original 8B/30B false positive)
  // contains NEITHER "?" nor "□" -- trySubstituteBlank must return null
  // immediately (count === 0) and this must fall through to the exact
  // same pre-Tier-1 behaviour as the standalone CANARY test elsewhere
  // in this file. This is not something Tier 1 claims to fix.
  const raw = "5=54÷9|6";
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: raw });
  const r = json.results[0];
  assert.equal(r.correct, true, "known limitation, unchanged by Tier 1 -- see the CANARY test for the full explanation");
});

test("GET /health returns ok:true with a version marker (no CF_VERSION_METADATA binding in this harness -- falls back to 'unknown', never throws)", async () => {
  const worker = await import(TMP);
  const req = new Request("https://example.com/health", { method: "GET" });
  const res = await worker.default.fetch(req, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "object");
  assert.equal(body.version.id, "unknown");
  assert.equal(typeof body.time, "string");
});

test("GET /health reflects a real CF_VERSION_METADATA binding when present", async () => {
  const worker = await import(TMP);
  const req = new Request("https://example.com/health", { method: "GET" });
  const res = await worker.default.fetch(req, {
    CF_VERSION_METADATA: { id: "abc-123", tag: "v1", timestamp: "2026-09-23T00:00:00Z" },
  });
  const body = await res.json();
  assert.equal(body.version.id, "abc-123");
  assert.equal(body.version.tag, "v1");
  assert.equal(body.version.timestamp, "2026-09-23T00:00:00Z");
});

test("POST /api/report-wrong logs a real report event, flags true->false as isAiWrongReport", async () => {
  const worker = await import(TMP);
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  let res;
  try {
    const req = new Request("https://example.com/api/report-wrong", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "3",
        studentAnswer: "9",
        correctAnswer: "8",
        subject: "math",
        previousCorrect: true,
        newCorrect: false,
      }),
    });
    res = await worker.default.fetch(req, {});
  } finally {
    console.log = originalLog;
  }
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  const events = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const reports = events.filter((e) => e.event === "report_mark_disputed");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].question, "3");
  assert.equal(reports[0].isAiWrongReport, true, "true->false must be flagged as a real AI-wrong report");
});

test("POST /api/report-wrong: false->true (parent overriding to correct) is logged but NOT flagged as isAiWrongReport", async () => {
  const worker = await import(TMP);
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const req = new Request("https://example.com/api/report-wrong", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "5", previousCorrect: false, newCorrect: true }),
    });
    await worker.default.fetch(req, {});
  } finally {
    console.log = originalLog;
  }
  const events = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const reports = events.filter((e) => e.event === "report_mark_disputed");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].isAiWrongReport, false);
});

test("POST /api/report-wrong: missing question or newCorrect is a 400, not a silent 200", async () => {
  const worker = await import(TMP);
  const req = new Request("https://example.com/api/report-wrong", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previousCorrect: true }),
  });
  const res = await worker.default.fetch(req, {});
  assert.equal(res.status, 400);
});

test("POST /api/report-wrong: malformed JSON body is a 400, not a thrown error", async () => {
  const worker = await import(TMP);
  const req = new Request("https://example.com/api/report-wrong", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  const res = await worker.default.fetch(req, {});
  assert.equal(res.status, 400);
});

test("2026-09-23 (challenge-all review finding): a real word-problem item is NOT hijacked by number_word_conversion just because its OCR'd answer contains a stray unit character", async () => {
  const worker = await import(TMP);
  // Real shape from TICKETS.md's own example: "...這兩天共賣去鉛筆多少支？"
  // -> 34+22=56. Printed text contains a bare 2-digit number ("22"), and
  // the student's answer is given WITH a stray unit suffix ("支", as real
  // OCR sometimes returns) -- before the fix, isWordAnswer's letter/CN-
  // numeral check would still be false for "支" alone (not in CN_DIGIT_
  // WORDS), so this specific case wouldn't have misfired; the fix instead
  // guards on any of the word-problem trigger keywords being present, so
  // this test asserts on the trigger-keyword condition itself, which is
  // the actual thing that must route correctly regardless of which
  // specific OCR noise pattern might otherwise cause isWordAnswer to fire.
  const total = worker.classifyAndVerify({
    printedQuestion: "昨天文具店賣出鉛筆34支，今天再賣出鉛筆22支，這兩天共賣去鉛筆多少支？",
    studentAnswer: "56",
  });
  assert.equal(total.handler, "word_problem_total", "must route to the real word-problem handler, not number_word_conversion");
  assert.equal(total.correct, true);

  const difference = worker.classifyAndVerify({
    printedQuestion: "子健在第一場獲得180分，第二場獲得166分。他在兩場比賽的得分相差多少分？",
    studentAnswer: "14",
  });
  assert.equal(difference.handler, "word_problem_difference");
  assert.equal(difference.correct, true);
});
