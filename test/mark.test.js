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
const REAL_JPEG_800x600 = fs.readFileSync(path.join(__dirname, "fixtures", "tiny-photo.jpg"));

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
// Ticket 13 (2026-09-26): the AI-fallback pass sends a SECOND, distinct
// prompt (buildAiFallbackPrompt) to the same "openrouter.ai" URL for any
// page with unresolved items -- distinguished here by its own opening
// phrase (distinct from OCR_ONLY_PROMPT's), not by URL, since both calls
// hit the same endpoint. `fallbackByMarker` is optional and defaults to
// "nothing mocked" (existing tests never register one, so their
// unresolved items' fallback attempts fail closed exactly like a real
// unmocked call would -- caught internally by callAiFallbackJudge,
// leaving those items untouched, which is why adding this stage never
// broke any pre-existing test).
function mockFetch(qwenByMarker, fallbackByMarker = {}) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes("openrouter.ai")) {
      const body = JSON.parse(opts.body);
      const content = body.messages[0].content;
      const imageBlock = content.find((c) => c.type === "image_url");
      const dataUrl = imageBlock.image_url.url; // "data:image/jpeg;base64,<marker-b64>"
      const b64data = dataUrl.split(",")[1];
      const marker = markerFromB64(b64data);
      const textBlock = content.find((c) => c.type === "text");
      const isFallbackCall = textBlock && textBlock.text.startsWith("你是一位細心的小學老師");
      if (isFallbackCall) {
        const entry = fallbackByMarker[marker];
        if (entry === undefined) return new Response("no mocked fallback response", { status: 502 });
        if (entry && entry.error) return new Response("upstream failure", { status: 502 });
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(entry) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001 },
        }), { status: 200 });
      }
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
  const inner = mockFetch(qwenByMarker, opts.fallbackByMarker);
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

// Ticket 13 (2026-09-26): AI judges what code can't -- a code-unresolved
// (Chinese) item gets a real verdict from the fallback pass instead of
// staying needs_review forever.
test("Ticket 13: a code-unresolved Chinese item gets resolved by the AI fallback pass", async () => {
  const items = [{ label: "7", printed: "男仔叫咩名？", answer: "阿明" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) }, {
    fallbackByMarker: { PAGE0: { results: [{ question: "7", correct: true, correctAnswer: "", note: "" }] } },
  });
  const r = json.results[0];
  assert.equal(r.correct, true);
  assert.equal(r.status, "ok");
  assert.equal(r.verifiedBy, "ai");
});

test("Ticket 13: fallback failure (nothing mocked) leaves the item exactly as before -- needs_review/pending, no regression", async () => {
  const items = [{ label: "7", printed: "男仔叫咩名？", answer: "阿明" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) }); // no fallbackByMarker at all
  const r = json.results[0];
  assert.equal(r.correct, null);
  assert.equal(r.status, "needs_review");
  assert.equal(r.verifiedBy, "pending");
});

test("Ticket 13: fallback batches ALL of a page's unresolved items into one call, and ignores any extra label it wasn't asked about", async () => {
  const items = [
    { label: "1", printed: "男仔叫咩名？", answer: "阿明" },
    { label: "2", printed: "女仔叫咩名？", answer: "阿珠" },
  ];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) }, {
    fallbackByMarker: { PAGE0: { results: [
      { question: "1", correct: true, correctAnswer: "", note: "" },
      { question: "2", correct: false, correctAnswer: "阿英", note: "" },
      { question: "99", correct: true, correctAnswer: "", note: "" }, // hallucinated extra -- must be ignored, not crash
    ] } },
  });
  const byLabel = Object.fromEntries(json.results.map((r) => [r.question, r]));
  assert.equal(byLabel["1"].correct, true);
  assert.equal(byLabel["2"].correct, false);
  assert.equal(byLabel["2"].correctAnswer, "阿英");
  assert.equal(json.results.length, 2, "the hallucinated extra label must not appear as a phantom result");
});

test("Ticket 13: fallback returning null for an item keeps it needs_review with the AI's own note, verifiedBy stays pending (not falsely 'ai')", async () => {
  const items = [{ label: "7", printed: "睇圖，呢個係咩形狀？", answer: "三角形" }];
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const { json } = await callMark(images, { PAGE0: qwenLineFor(items) }, {
    fallbackByMarker: { PAGE0: { results: [{ question: "7", correct: null, correctAnswer: "", note: "睇唔清幅圖" }] } },
  });
  const r = json.results[0];
  assert.equal(r.correct, null);
  assert.equal(r.status, "needs_review");
  assert.equal(r.verifiedBy, "pending");
  assert.equal(r.note, "睇唔清幅圖");
});

test("Ticket 15: a page with MORE than 5 unresolved items is split into multiple ≤5-item fallback batches (real production finding: a single 10-item batch made both tiers time out)", async () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ label: String(i + 1), printed: `題目${i + 1}`, answer: `答案${i + 1}` }));
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  let fallbackCalls = 0;
  const inner = mockFetch(
    { PAGE0: qwenLineFor(items) },
    { PAGE0: { results: items.map((it) => ({ question: it.label, correct: true, correctAnswer: "", note: "" })) } },
  );
  const worker = await import(TMP);
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || "{}");
    const textBlock = body.messages && body.messages[0].content.find((c) => c.type === "text");
    if (textBlock && textBlock.text.startsWith("你是一位細心的小學老師")) fallbackCalls++;
    return inner(url, opts);
  };
  try {
    const req = new Request("https://example.com/api/mark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ images }) });
    const env = { OPENROUTER_API_KEY: "test-openrouter-key", GOOGLE_VISION_API_KEY: "test-vision-key", ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } };
    const res = await worker.default.fetch(req, env);
    const resJson = await res.json();
    assert.equal(fallbackCalls, 2, "7 items at a 5-item cap must split into exactly 2 batches (5 + 2), not 1 oversized call");
    assert.equal(resJson.results.filter((r) => r.verifiedBy === "ai").length, 7, "both batches' results still get merged back correctly");
  } finally {
    global.fetch = originalFetch;
  }
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

// Ticket 16 (2026-09-26): duplicate-submission protection -- a parent
// double-tapping "send" in Telegram must not trigger two real OCR spends
// for the identical photo(s).
test("Ticket 16: an identical resubmission within the dedup window returns the cached result WITHOUT a second Qwen call", async () => {
  const kv = fakeRateLimitKV("9.9.9.9", null);
  const images = [{ data: b64("PAGE0"), mediaType: "image/jpeg" }];
  const qwenByMarker = { PAGE0: qwenLineFor([{ label: "1", printed: "4+6=", answer: "10" }]) };
  let fetchCalls = 0;
  const first = await callMark(images, qwenByMarker, { env: { RATE_LIMIT_KV: kv }, fetchSpy: () => { fetchCalls++; } });
  assert.equal(first.status, 200);
  const callsAfterFirst = fetchCalls;
  assert.ok(callsAfterFirst > 0, "the first submission should genuinely call Qwen/Vision");

  const second = await callMark(images, qwenByMarker, { env: { RATE_LIMIT_KV: kv }, fetchSpy: () => { fetchCalls++; } });
  assert.equal(second.status, 200);
  assert.deepEqual(second.json.results, first.json.results, "the resubmission returns the exact same result");
  assert.equal(fetchCalls, callsAfterFirst, "no additional Qwen/Vision calls on the duplicate submission");
});

test("Ticket 16: a genuinely DIFFERENT submission (different image) is never treated as a duplicate", async () => {
  const kv = fakeRateLimitKV("9.9.9.9", null);
  const qwenByMarker = {
    PAGE0: qwenLineFor([{ label: "1", printed: "4+6=", answer: "10" }]),
    PAGE1: qwenLineFor([{ label: "1", printed: "2+2=", answer: "4" }]),
  };
  const first = await callMark([{ data: b64("PAGE0"), mediaType: "image/jpeg" }], qwenByMarker, { env: { RATE_LIMIT_KV: kv } });
  const second = await callMark([{ data: b64("PAGE1"), mediaType: "image/jpeg" }], qwenByMarker, { env: { RATE_LIMIT_KV: kv } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notDeepEqual(second.json.results, first.json.results, "a different photo must be graded independently, not served from the other one's cache");
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

test("2026-09-23: DISABLE_ANTHROPIC_DURING_TESTING makes /api/verify return {patches:[]} immediately, never attempting Sonnet/Opus", async () => {
  const worker = await import(TMP);
  const req = new Request("https://example.com/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ images: [{ data: b64("PAGE0"), mediaType: "image/jpeg" }], items: [{ page: 0, correct: null }] }),
  });
  // No ANTHROPIC_API_KEY in env at all -- if the kill switch were NOT
  // checked, this would still be a graceful {patches:[]} (the existing
  // missing-key behaviour), so this test only proves something real when
  // read together with the source: DISABLE_ANTHROPIC_DURING_TESTING is
  // checked in the SAME early-return line as the missing-key check, so
  // there is no separate code path left that could still call Anthropic.
  const res = await worker.default.fetch(req, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { patches: [] });
});

test("2026-09-23: /api/check does NOT hard-fail with 'not_configured' just because ANTHROPIC_API_KEY is missing while testing-mode is on (previously required Anthropic even though OpenRouter is tried first)", async () => {
  const worker = await import(TMP);
  const req = new Request("https://example.com/api/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ images: [{ data: b64("PAGE0"), mediaType: "image/jpeg" }] }),
  });
  // No OPENROUTER_API_KEY either, so this can't actually grade anything --
  // proving the DISTINCTION that matters: it must fail as "upstream_error"
  // (nothing available to try), never as "not_configured" (which would
  // incorrectly imply Anthropic specifically is the missing piece).
  const res = await worker.default.fetch(req, {});
  const body = await res.json();
  assert.notEqual(body.error, "not_configured", "must not claim Anthropic-not-configured when it was deliberately disabled, not actually unconfigured");
  assert.equal(body.error, "upstream_error");
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

// Ticket 22 Stage A (2026-09-26): generic "verifier can see the real
// photo, not just OCR'd text" plumbing -- cropItem (shared with /api/
// check's own zoom-recheck tiers) + classifyAndVerify's new optional
// getImageCrop/verifyVisual contract. No real visual handler (abacus
// etc.) is wired into QUESTION_TYPE_HANDLERS yet -- these tests prove
// the PLUMBING itself works against a real decoded image, using a
// throwaway fake handler pushed onto (and popped back off) the real
// registry, rather than a hypothetical.

test("Ticket 22 Stage A: cropItem returns real, valid, non-empty JPEG bytes for a bbox on a real 800x600 photo", async () => {
  const worker = await import(TMP);
  const images = [{ data: REAL_JPEG_800x600.toString("base64"), mediaType: "image/jpeg" }];
  const photonCache = new Map();
  try {
    const crop = worker.cropItem({ bbox: { x: 10, y: 10, w: 20, h: 20 }, page: 0 }, images, photonCache);
    assert.equal(crop.mediaType, "image/jpeg");
    assert.ok(crop.data && crop.data.length > 100, "must return real, non-trivial JPEG bytes, not an empty/placeholder result");
    const cropBytes = Buffer.from(crop.data, "base64");
    assert.equal(cropBytes[0], 0xff, "must be real JPEG magic bytes (SOI marker), not garbage");
    assert.equal(cropBytes[1], 0xd8);
  } finally {
    for (const img of photonCache.values()) img.free();
  }
});

test("Ticket 22 Stage A: cropItem throws cleanly (caught by classifyAndVerify's fail-open path) when the item has no bbox", async () => {
  const worker = await import(TMP);
  const images = [{ data: REAL_JPEG_800x600.toString("base64"), mediaType: "image/jpeg" }];
  assert.throws(() => worker.cropItem({ bbox: null, page: 0 }, images, new Map()));
});

test("Ticket 22 Stage A: classifyAndVerify's verifyVisual contract -- a matched visual handler receives the REAL cropped image, and its verdict flows through exactly like a text handler's", async () => {
  const worker = await import(TMP);
  const images = [{ data: REAL_JPEG_800x600.toString("base64"), mediaType: "image/jpeg" }];
  const photonCache = new Map();
  let receivedCrop = null;
  const fakeHandler = {
    name: "fake_visual_test_handler",
    detect: (item) => item.printedQuestion === "__TICKET22_STAGE_A_TEST__",
    verifyVisual: (item, crop) => {
      receivedCrop = crop;
      return { correct: true, correctAnswer: "" };
    },
  };
  worker.QUESTION_TYPE_HANDLERS.unshift(fakeHandler); // front of the list so it can't be shadowed by an earlier real handler
  try {
    const item = { label: "1", printedQuestion: "__TICKET22_STAGE_A_TEST__", studentAnswer: "whatever" };
    const getImageCrop = () => worker.cropItem({ bbox: { x: 5, y: 5, w: 30, h: 30 }, page: 0 }, images, photonCache);
    const result = worker.classifyAndVerify(item, getImageCrop);
    assert.equal(result.handler, "fake_visual_test_handler");
    assert.equal(result.correct, true);
    assert.ok(receivedCrop, "the handler must have actually received a crop object");
    assert.equal(receivedCrop.mediaType, "image/jpeg");
    assert.ok(receivedCrop.data.length > 100, "the handler's crop must be real image bytes, not a placeholder");
  } finally {
    worker.QUESTION_TYPE_HANDLERS.shift(); // remove the fake handler -- never pollute the real registry for other tests
    for (const img of photonCache.values()) img.free();
  }
});

test("Ticket 22 Stage A: a visual handler with NO crop available (getImageCrop omitted) fails open to needs_review, never a guess", async () => {
  const worker = await import(TMP);
  const fakeHandler = {
    name: "fake_visual_test_handler_2",
    detect: (item) => item.printedQuestion === "__TICKET22_STAGE_A_TEST_NO_CROP__",
    verifyVisual: () => ({ correct: true, correctAnswer: "" }), // must never actually be called
  };
  worker.QUESTION_TYPE_HANDLERS.unshift(fakeHandler);
  try {
    const item = { label: "1", printedQuestion: "__TICKET22_STAGE_A_TEST_NO_CROP__", studentAnswer: "x" };
    const result = worker.classifyAndVerify(item); // no getImageCrop passed at all
    assert.equal(result.handler, "fake_visual_test_handler_2");
    assert.equal(result.correct, null, "must fail open to needs_review, never call verifyVisual without a real crop");
  } finally {
    worker.QUESTION_TYPE_HANDLERS.shift();
  }
});

// Ticket 27 (2026-09-27): Jev TEXT-ONLY pre-check, mocked fetch only --
// no real OpenRouter/Jev spend, per the standing "mock before real API
// cost" rule. These prove the LOGIC (request shape, confidence
// thresholds, fail-open behavior) is correct; they are not a substitute
// for a real-data accuracy test (see TICKETS.md Ticket 27).

test("buildJevQuestions: one noul question per pending item, keyed by resultIndex, embeds the real question/answer text", async () => {
  const worker = await import(TMP);
  const pendingItems = [
    { resultIndex: 0, question: "1", printedQuestion: "3+4", studentAnswer: "7" },
    { resultIndex: 3, question: "4", printedQuestion: "5+5", studentAnswer: "9" },
  ];
  const questions = worker.buildJevQuestions(pendingItems);
  assert.deepEqual(Object.keys(questions), ["0", "3"]);
  assert.equal(questions["0"].type, "noul");
  assert.match(questions["0"].instructions, /3\+4/);
  assert.match(questions["0"].instructions, /7/);
  assert.match(questions["3"].instructions, /5\+5/);
});

test("callJevPreCheck: resolves items with high confidence (>=0.9 or <=0.1), leaves mid-confidence items unresolved", async () => {
  const worker = await import(TMP);
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "typesafe/jev-1.13");
    assert.equal(typeof body.state, "string");
    return {
      ok: true,
      json: async () => ({
        answers: {
          "0": { type: "noul", noul: 0.97 }, // confident correct
          "1": { type: "noul", noul: 0.02 }, // confident wrong
          "2": { type: "noul", noul: 0.5 },  // genuinely uncertain -- must NOT resolve
        },
        usage: { input_tokens: 100, output_tokens: 0, cost: 0.0000042 },
      }),
    };
  };
  try {
    const pendingItems = [
      { resultIndex: 0, question: "1", printedQuestion: "3+4", studentAnswer: "7" },
      { resultIndex: 1, question: "2", printedQuestion: "3+4", studentAnswer: "8" },
      { resultIndex: 2, question: "3", printedQuestion: "unclear handwriting", studentAnswer: "?" },
    ];
    const resolved = await worker.callJevPreCheck(pendingItems, "fake-key");
    assert.equal(resolved.size, 2, "only the two high-confidence items resolve");
    assert.deepEqual(resolved.get(0), { correct: true });
    assert.deepEqual(resolved.get(1), { correct: false });
    assert.equal(resolved.has(2), false, "mid-confidence item must stay unresolved, not guessed");
  } finally {
    global.fetch = originalFetch;
  }
});

test("callJevPreCheck: fails open to an empty Map on a non-ok HTTP response (never blocks the real fallback)", async () => {
  const worker = await import(TMP);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    const pendingItems = [{ resultIndex: 0, question: "1", printedQuestion: "3+4", studentAnswer: "7" }];
    const resolved = await worker.callJevPreCheck(pendingItems, "fake-key");
    assert.equal(resolved.size, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("callJevPreCheck: fails open to an empty Map when fetch itself throws (network error)", async () => {
  const worker = await import(TMP);
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("network down"); };
  try {
    const pendingItems = [{ resultIndex: 0, question: "1", printedQuestion: "3+4", studentAnswer: "7" }];
    const resolved = await worker.callJevPreCheck(pendingItems, "fake-key");
    assert.equal(resolved.size, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("callJevPreCheck: ignores a malformed answer (missing/non-numeric noul) rather than guessing", async () => {
  const worker = await import(TMP);
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ answers: { "0": { type: "noul" }, "1": { type: "noul", noul: "high" } } }),
  });
  try {
    const pendingItems = [
      { resultIndex: 0, question: "1", printedQuestion: "3+4", studentAnswer: "7" },
      { resultIndex: 1, question: "2", printedQuestion: "3+4", studentAnswer: "7" },
    ];
    const resolved = await worker.callJevPreCheck(pendingItems, "fake-key");
    assert.equal(resolved.size, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("callJevPreCheck: empty pendingItems returns an empty Map without calling fetch at all", async () => {
  const worker = await import(TMP);
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ answers: {} }) }; };
  try {
    const resolved = await worker.callJevPreCheck([], "fake-key");
    assert.equal(resolved.size, 0);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

// Ticket 50 (2026-09-27): self-imposed CPU-ms circuit breaker -- see the
// standing constraint in worker.js's own comment (this must NEVER
// degrade grading accuracy, only the cosmetic Telegram photo annotation).
function fakeGenericKV(initial = {}) {
  const store = { ...initial };
  return {
    get: async (key) => (key in store ? store[key] : null),
    put: async (key, value) => { store[key] = value; },
    _store: store,
  };
}

test("recordCpuGuardUsage: accumulates across multiple calls under today's key", async () => {
  const worker = await import(TMP);
  const kv = fakeGenericKV();
  await worker.recordCpuGuardUsage({ RATE_LIMIT_KV: kv }, 100);
  await worker.recordCpuGuardUsage({ RATE_LIMIT_KV: kv }, 250);
  const key = Object.keys(kv._store).find((k) => k.startsWith("cpuguard:"));
  assert.ok(key, "should have written a cpuguard:<date> key");
  assert.equal(kv._store[key], "350");
});

test("recordCpuGuardUsage: silently no-ops with no RATE_LIMIT_KV binding or a non-positive ms value", async () => {
  const worker = await import(TMP);
  await assert.doesNotReject(() => worker.recordCpuGuardUsage({}, 100));
  const kv = fakeGenericKV();
  await worker.recordCpuGuardUsage({ RATE_LIMIT_KV: kv }, 0);
  await worker.recordCpuGuardUsage({ RATE_LIMIT_KV: kv }, -5);
  assert.equal(Object.keys(kv._store).length, 0, "zero/negative ms must not write anything");
});

test("isCpuGuardTripped: false under the threshold, true at/over it", async () => {
  const worker = await import(TMP);
  const todayKey = "cpuguard:" + new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
  const underKv = fakeGenericKV({ [todayKey]: String(worker.CPU_GUARD_DAILY_THRESHOLD_MS - 1) });
  assert.equal(await worker.isCpuGuardTripped({ RATE_LIMIT_KV: underKv }), false);
  const overKv = fakeGenericKV({ [todayKey]: String(worker.CPU_GUARD_DAILY_THRESHOLD_MS) });
  assert.equal(await worker.isCpuGuardTripped({ RATE_LIMIT_KV: overKv }), true);
});

test("isCpuGuardTripped: fails open (false) when RATE_LIMIT_KV is missing or a read throws -- never blocks a real request over a monitoring failure", async () => {
  const worker = await import(TMP);
  assert.equal(await worker.isCpuGuardTripped({}), false);
  const throwingKv = { get: async () => { throw new Error("kv down"); } };
  assert.equal(await worker.isCpuGuardTripped({ RATE_LIMIT_KV: throwingKv }), false);
});

// Ticket 54 (2026-09-27): word-bank "used once each" group constraint
// (Module 2b in handleMark). Two real, explicit-user-decision outcomes:
// (1) an answer that isn't even a real bank phrase is code-confident
// wrong; (2) a genuine clash (same bank phrase used by 2+ items) is NOT
// forced to needs_review -- it's passed to Jev/the AI-fallback judge
// WITH the cross-item context they wouldn't otherwise have, and their
// own existing confidence mechanism decides case by case.
test("Module 2b: an answer not in the word bank at all is code-confident wrong, no AI involved", async () => {
  const worker = await import(TMP);
  const ocrText = "WORD_BANK: a cup of;a bar of;a bowl of\n1=I'd like ____ tea.|a mug of";
  const originalFetch = global.fetch;
  let fallbackCalled = false;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("vision.googleapis.com")) return new Response(JSON.stringify({ responses: [{}] }), { status: 200 });
    if (u.includes("alpha/decisions")) return new Response("no jev in this test", { status: 502 });
    if (u.includes("openrouter.ai")) {
      const body = JSON.parse(opts.body);
      const textBlock = body.messages[0].content.find((c) => c.type === "text");
      if (textBlock.text.startsWith("你是一位細心的小學老師")) { fallbackCalled = true; return new Response("should not be called", { status: 502 }); }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: ocrText } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const req = new Request("https://example.com/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ data: Buffer.from("PAGE0").toString("base64"), mediaType: "image/jpeg" }] }),
    });
    const env = { OPENROUTER_API_KEY: "test-key", GOOGLE_VISION_API_KEY: "test-vision-key", ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } };
    const res = await worker.default.fetch(req, env);
    const json = await res.json();
    assert.equal(json.results[0].correct, false);
    assert.equal(json.results[0].verifiedBy, "code");
    assert.equal(fallbackCalled, false, "a definite not-in-bank violation needs no AI at all");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Module 2b: two items using the same bank phrase get a cross-item hint passed to the AI-fallback judge, not silently forced to needs_review", async () => {
  const worker = await import(TMP);
  const ocrText = "WORD_BANK: a cup of;a bar of;a bowl of\n1=I'd like ____ of tea.|a cup of,2=I'd like ____ of soap.|a cup of";
  const originalFetch = global.fetch;
  let capturedFallbackPrompt = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("vision.googleapis.com")) return new Response(JSON.stringify({ responses: [{}] }), { status: 200 });
    if (u.includes("alpha/decisions")) return new Response("no jev in this test", { status: 502 });
    if (u.includes("openrouter.ai")) {
      const body = JSON.parse(opts.body);
      const textBlock = body.messages[0].content.find((c) => c.type === "text");
      if (textBlock.text.startsWith("你是一位細心的小學老師")) {
        capturedFallbackPrompt = textBlock.text;
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ results: [
            { question: "1", correct: true, correctAnswer: "", note: "" },
            { question: "2", correct: false, correctAnswer: "a bowl of", note: "" },
          ] }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: ocrText } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const req = new Request("https://example.com/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ data: Buffer.from("PAGE0").toString("base64"), mediaType: "image/jpeg" }] }),
    });
    const env = { OPENROUTER_API_KEY: "test-key", GOOGLE_VISION_API_KEY: "test-vision-key", ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } };
    const res = await worker.default.fetch(req, env);
    const json = await res.json();
    assert.ok(capturedFallbackPrompt, "the AI-fallback judge should have been called for these unresolved word-bank items");
    assert.match(capturedFallbackPrompt, /撞用咗同一個詞/, "the clash hint must reach the fallback judge's prompt");
    const r1 = json.results.find((r) => r.question === "1");
    const r2 = json.results.find((r) => r.question === "2");
    assert.equal(r1.correct, true);
    assert.equal(r2.correct, false);
    assert.equal(r2.correctAnswer, "a bowl of");
  } finally {
    global.fetch = originalFetch;
  }
});

// Ticket 55 (2026-09-27): 4x4 Sudoku puzzles (Module 3d in handleMark) --
// a completely separate item shape from every other question type, so
// this needs its own end-to-end test rather than reusing
// classifyAndVerify-based assertions. Real fixture shape matches
// test/new-question-types.test.js's own SUDOKU_GIVEN/SOLUTION.
test("Module 3d: a correct, complete Sudoku solution is verified via the real verifySudoku4x4, with no AI call at all", async () => {
  const worker = await import(TMP);
  const given = "1,0,3,0,0,4,0,2,2,0,4,0,0,3,0,1";
  const solution = "1,2,3,4,3,4,1,2,2,1,4,3,4,3,2,1";
  const ocrText = `SUDOKU: 1|${given}|${solution}`;
  let anyAiCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("vision.googleapis.com")) return new Response(JSON.stringify({ responses: [{}] }), { status: 200 });
    if (u.includes("alpha/decisions")) { anyAiCalled = true; return new Response("should not be called", { status: 502 }); }
    if (u.includes("openrouter.ai")) {
      const body = JSON.parse(opts.body);
      const textBlock = body.messages[0].content.find((c) => c.type === "text");
      if (textBlock.text.startsWith("你是一位細心的小學老師")) { anyAiCalled = true; return new Response("should not be called", { status: 502 }); }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: ocrText } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const req = new Request("https://example.com/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ data: Buffer.from("PAGE0").toString("base64"), mediaType: "image/jpeg" }] }),
    });
    const env = { OPENROUTER_API_KEY: "test-key", GOOGLE_VISION_API_KEY: "test-vision-key", ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } };
    const res = await worker.default.fetch(req, env);
    const json = await res.json();
    assert.equal(json.results.length, 1);
    assert.equal(json.results[0].question, "1");
    assert.equal(json.results[0].correct, true);
    assert.equal(json.results[0].verifiedBy, "code");
    assert.equal(anyAiCalled, false, "a fully code-resolved puzzle needs no Jev/AI call at all");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Module 3d: a Sudoku solution with a row conflict is caught as wrong", async () => {
  const worker = await import(TMP);
  const given = "1,0,3,0,0,4,0,2,2,0,4,0,0,3,0,1";
  const badSolution = "1,1,3,4,3,4,1,2,2,1,4,3,4,3,2,1"; // row 0 now has two 1s
  const ocrText = `SUDOKU: 1|${given}|${badSolution}`;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("vision.googleapis.com")) return new Response(JSON.stringify({ responses: [{}] }), { status: 200 });
    if (u.includes("alpha/decisions")) return new Response("should not be called", { status: 502 });
    if (u.includes("openrouter.ai")) {
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: ocrText } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const req = new Request("https://example.com/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ data: Buffer.from("PAGE0").toString("base64"), mediaType: "image/jpeg" }] }),
    });
    const env = { OPENROUTER_API_KEY: "test-key", GOOGLE_VISION_API_KEY: "test-vision-key", ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } };
    const res = await worker.default.fetch(req, env);
    const json = await res.json();
    assert.equal(json.results[0].correct, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Module 3d: an incomplete Sudoku stays needs_review, never guessed, and is not sent to Jev/AI", async () => {
  const worker = await import(TMP);
  const given = "1,0,3,0,0,4,0,2,2,0,4,0,0,3,0,1";
  const incomplete = "1,0,3,4,3,4,1,2,2,1,4,3,4,3,2,1"; // cell 1 left blank
  const ocrText = `SUDOKU: 1|${given}|${incomplete}`;
  let anyAiCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("vision.googleapis.com")) return new Response(JSON.stringify({ responses: [{}] }), { status: 200 });
    if (u.includes("alpha/decisions")) { anyAiCalled = true; return new Response("should not be called", { status: 502 }); }
    if (u.includes("openrouter.ai")) {
      const body = JSON.parse(opts.body);
      const textBlock = body.messages[0].content.find((c) => c.type === "text");
      if (textBlock.text.startsWith("你是一位細心的小學老師")) { anyAiCalled = true; return new Response("should not be called", { status: 502 }); }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: ocrText } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const req = new Request("https://example.com/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ data: Buffer.from("PAGE0").toString("base64"), mediaType: "image/jpeg" }] }),
    });
    const env = { OPENROUTER_API_KEY: "test-key", GOOGLE_VISION_API_KEY: "test-vision-key", ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } };
    const res = await worker.default.fetch(req, env);
    const json = await res.json();
    assert.equal(json.results[0].correct, null);
    assert.equal(json.results[0].status, "needs_review");
    assert.equal(anyAiCalled, false, "an incomplete puzzle deliberately isn't sent to Jev/AI in this first pass");
  } finally {
    global.fetch = originalFetch;
  }
});

// Ticket 57 (2026-09-27): real HK currency reference (HKMA + Wikipedia
// verified facts) added to the AI-fallback judge's prompt, ONLY when a
// pending item's printed text actually mentions money -- avoids paying
// extra input-token cost on every unrelated AI-fallback call.
test("buildAiFallbackPrompt: includes the real HK currency reference when a pending item mentions money", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "How much money is shown? (coins)", studentAnswer: "$3.50" },
  ]);
  assert.match(prompt, /洋紫荊/, "the real coin-series reference must be present");
  assert.match(prompt, /\$20藍色/, "the real banknote colour reference must be present");
});

test("buildAiFallbackPrompt: omits the currency reference entirely for unrelated questions (no wasted tokens)", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "What 3-D shape has two circular bases?", studentAnswer: "cylinder" },
  ]);
  assert.doesNotMatch(prompt, /洋紫荊/);
  assert.doesNotMatch(prompt, /\$20藍色/);
});

test("mentionsMoneyDenomination: recognises real Chinese and English money keywords", async () => {
  const worker = await import(TMP);
  assert.equal(worker.mentionsMoneyDenomination([{ printedQuestion: "呢個係咩硬幣？" }]), true);
  assert.equal(worker.mentionsMoneyDenomination([{ printedQuestion: "How many $2 coins?" }]), true);
  assert.equal(worker.mentionsMoneyDenomination([{ printedQuestion: "25÷5" }]), false);
});

// Ticket 59 (2026-09-27): real 3-D shape geometry reference added to the
// AI-fallback prompt, same conditional-inclusion pattern as Ticket 57's
// currency reference -- and both can coexist in one call if a page has
// both types of pending item.
test("buildAiFallbackPrompt: includes the real 3-D shape reference when a pending item is about shape geometry", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "Which 3-D shape has two circular bases?", studentAnswer: "cylinder" },
  ]);
  assert.match(prompt, /圓柱體\(cylinder\)/, "the real cylinder fact must be present");
  assert.match(prompt, /三棱柱\(triangular prism\)/, "the real triangular prism fact must be present");
});

test("buildAiFallbackPrompt: omits the shape reference for unrelated questions", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "25÷5", studentAnswer: "5" },
  ]);
  assert.doesNotMatch(prompt, /圓柱體/);
});

test("buildAiFallbackPrompt: both currency and shape references can appear together when a page has both types of pending item", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "How much money is shown?", studentAnswer: "$5" },
    { question: "2", printedQuestion: "How many faces does a cone have?", studentAnswer: "2" },
  ]);
  assert.match(prompt, /洋紫荊/);
  assert.match(prompt, /圓錐體\(cone\)/);
});

test("mentionsShapeGeometry: recognises real Chinese and English shape-geometry keywords", async () => {
  const worker = await import(TMP);
  assert.equal(worker.mentionsShapeGeometry([{ printedQuestion: "邊個係三棱柱？" }]), true);
  assert.equal(worker.mentionsShapeGeometry([{ printedQuestion: "How many edges does a cube have?" }]), true);
  assert.equal(worker.mentionsShapeGeometry([{ printedQuestion: "25÷5" }]), false);
});

// Ticket 60 (2026-09-27): "做法B" -- concrete measurement-guidance
// sentences (not reference data) added to the AI-fallback prompt for
// question types that need real measurement, not a lookup fact.
test("buildAiFallbackPrompt: includes angle measurement guidance when a pending item is about angles", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "Is this a right angle?", studentAnswer: "yes" },
  ]);
  assert.match(prompt, /角度題：/);
});

test("buildAiFallbackPrompt: includes clock guidance only when relevant, and can combine with an unrelated reference block", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "What time does the clock show?", studentAnswer: "3:15" },
    { question: "2", printedQuestion: "How many faces does a cube have?", studentAnswer: "6" },
  ]);
  assert.match(prompt, /鐘面題：/);
  assert.match(prompt, /正方體\(cube\)/);
  assert.doesNotMatch(prompt, /水位\/量杯題/);
});

test("buildAiFallbackPrompt: no Tier V guidance added for an ordinary arithmetic item", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([{ question: "1", printedQuestion: "25÷5", studentAnswer: "5" }]);
  assert.doesNotMatch(prompt, /角度題：|水位\/量杯題：|間尺題：|鐘面題：/);
});

// Ticket 61 (2026-09-27): real 2-D shape geometry reference, same
// pattern as Ticket 59's 3-D one but a genuinely separate keyword set
// and fact table (sides/vertices, not faces/edges/vertices).
test("buildAiFallbackPrompt: includes the real 2-D shape reference when a pending item is about flat shapes", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "How many sides does a hexagon have?", studentAnswer: "6" },
  ]);
  assert.match(prompt, /六邊形\(hexagon\)/);
  assert.doesNotMatch(prompt, /圓柱體\(cylinder\)/, "2-D reference must not pull in the 3-D block");
});

test("mentionsShape2D: recognises real Chinese and English 2-D shape keywords, distinct from 3-D", async () => {
  const worker = await import(TMP);
  assert.equal(worker.mentionsShape2D([{ printedQuestion: "呢個係咪三角形？" }]), true);
  assert.equal(worker.mentionsShape2D([{ printedQuestion: "How many faces does a cube have?" }]), false, "3-D 'faces' keyword must not trigger the 2-D reference");
});

// Ticket 62 (2026-09-27, user's own real insight, confirmed against this
// project's own past PDF survey): real coin illustrations almost always
// print the exact denomination directly on the coin as small text, so
// reading that text is the primary, more reliable method -- not
// shape/colour classification.
test("buildAiFallbackPrompt: money guidance tells the AI to read the printed denomination directly, and coexists with the currency reference data", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "How much money is shown? (coins)", studentAnswer: "$5" },
  ]);
  assert.match(prompt, /硬幣\/紙幣面額題：/);
  assert.match(prompt, /印刷數字先係最準嘅資訊來源/);
  assert.match(prompt, /洋紫荊/, "the Ticket 57 reference data must still appear as a fallback");
});

// Ticket 64 (2026-09-28): calendar/leap-year and days-per-month reference
// data, found by a background survey fork re-reading MCLQ 2A's Time/
// Calendar chapter (real citations: book p.63 "leap year" Feb-28th
// question, book p.64 common/leap-year fill-in-the-blank).
test("mentionsYearType / YEAR_TYPE_REFERENCE: fires on real leap-year question wording", async () => {
  const worker = await import(TMP);
  assert.equal(worker.mentionsYearType([{ printedQuestion: "The above calendar is of March in a leap year." }]), true);
  assert.equal(worker.mentionsYearType([{ printedQuestion: "This year is a *common/leap year, there are ___ days this year." }]), true);
  assert.equal(worker.mentionsYearType([{ printedQuestion: "Tom saved $50 last year." }]), false);
});

test("mentionsMonthLength: requires BOTH a month name AND day-count context, not a bare month mention", async () => {
  const worker = await import(TMP);
  assert.equal(worker.mentionsMonthLength([{ printedQuestion: "Which month has the smallest number of days? May/June/July/August" }]), true);
  assert.equal(worker.mentionsMonthLength([{ printedQuestion: "In March, Tom saved $50." }]), false, "a bare month mention in an unrelated word problem must not trigger the calendar reference");
});

test("buildAiFallbackPrompt: includes calendar reference blocks only when the question actually needs them", async () => {
  const worker = await import(TMP);
  const withLeap = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "This year is a *common/leap year, there are ___ days this year.", studentAnswer: "366" },
  ]);
  assert.match(withLeap, /常年\(common year\)：全年365日/);
  const withMonths = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "Which month has the smallest number of days? May/June/July", studentAnswer: "June" },
  ]);
  assert.match(withMonths, /二月28日\(閏年29日\)/);
  const unrelated = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "9 + 4 = ?", studentAnswer: "13" },
  ]);
  assert.doesNotMatch(unrelated, /常年\(common year\)/);
  assert.doesNotMatch(unrelated, /二月28日/);
});

// Ticket 68 (2026-09-28): pictogram (象形圖) data-query verifier. Found
// independently in two real materials -- a P2 exam (days-of-week hours
// online) and a P3 exam (flower counts in a vase) -- both asking count/
// max/min/difference/ratio/total questions against an icon chart. Uses
// clean self-built numbers (no ties) rather than the real exam's exact
// counts, since re-reading the source image precisely enough to be sure
// of every icon count wasn't practical -- the QUESTION SHAPES/phrasing
// below are real quotes, the numbers are a safe synthetic stand-in.
test("verifyPictogramQuery: shape 1 -- count of zero-value categories", async () => {
  const worker = await import(TMP);
  const data = { unit: 1, counts: { "星期日": 5, "星期一": 0, "星期二": 1, "星期三": 0 } };
  const r = worker.verifyPictogramQuery(data, "希敏上星期有___天沒有上網。", "2");
  assert.equal(r.correct, true);
  const wrong = worker.verifyPictogramQuery(data, "希敏上星期有___天沒有上網。", "1");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "2");
});

test("verifyPictogramQuery: shape 2 -- max/min category name, declines on a tie", async () => {
  const worker = await import(TMP);
  const data = { unit: 1, counts: { "星期日": 5, "星期一": 2, "星期二": 1 } };
  const r = worker.verifyPictogramQuery(data, "希敏在上星期___上網所用的時間是最多的。", "星期日");
  assert.equal(r.correct, true);
  const wrong = worker.verifyPictogramQuery(data, "希敏在上星期___上網所用的時間是最多的。", "星期一");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "星期日");
  const tie = { unit: 1, counts: { "星期日": 5, "星期六": 5, "星期二": 1 } };
  const declined = worker.verifyPictogramQuery(tie, "邊日最多?", "星期日");
  assert.equal(declined.correct, null, "a genuine tie must decline, not guess");
});

test("verifyPictogramQuery: shape 3 -- sum of two named categories", async () => {
  const worker = await import(TMP);
  const data = { unit: 1, counts: { "貓形花": 4, "玫瑰花": 3, "菊花": 2 } };
  const r = worker.verifyPictogramQuery(data, "貓形花和玫瑰花共有___朵。", "7");
  assert.equal(r.correct, true);
});

test("verifyPictogramQuery: shape 4 -- difference between two named categories (unit-scaled)", async () => {
  const worker = await import(TMP);
  const data = { unit: 2, counts: { "星期六": 5, "星期四": 3 } };
  const r = worker.verifyPictogramQuery(data, "希敏在上星期六上網所用的時間比上星期四多幾多小時。", "4");
  assert.equal(r.correct, true, "(5-3) icons * unit=2 hours each = 4 hours");
});

test("verifyPictogramQuery: shape 5 -- ratio between two named categories, declines when not evenly divisible", async () => {
  const worker = await import(TMP);
  const data = { unit: 1, counts: { "星期六": 6, "星期四": 3 } };
  const r = worker.verifyPictogramQuery(data, "希敏在上星期六上網所用的時間是上星期四的___倍。", "2");
  assert.equal(r.correct, true);
  const uneven = { unit: 1, counts: { "星期六": 5, "星期四": 3 } };
  const declined = worker.verifyPictogramQuery(uneven, "星期六是星期四的___倍。", "2");
  assert.equal(declined.correct, null, "5/3 isn't a whole number -- must decline rather than round/guess");
});

test("verifyPictogramQuery: shape 6 -- grand total across all categories, no category named", async () => {
  const worker = await import(TMP);
  const data = { unit: 1, counts: { "貓形花": 4, "玫瑰花": 3, "菊花": 2 } };
  const r = worker.verifyPictogramQuery(data, "花瓶內共有花___朵。", "9");
  assert.equal(r.correct, true);
});

test("verifyPictogramQuery: declines (null) when the question doesn't match any known shape", async () => {
  const worker = await import(TMP);
  const data = { unit: 1, counts: { "貓形花": 4, "玫瑰花": 3 } };
  const r = worker.verifyPictogramQuery(data, "貓形花係咪紅色嘅?", "係");
  assert.equal(r.correct, null);
});

test("pictogram_data_query handler: registered and reachable via QUESTION_TYPE_HANDLERS", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "pictogram_data_query");
  assert.ok(handler, "pictogram_data_query handler must be registered");
  const item = { printedQuestion: "花瓶內共有花___朵。", studentAnswer: "9", pictogramData: { unit: 1, counts: { "貓形花": 4, "玫瑰花": 3, "菊花": 2 } } };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
  assert.equal(handler.detect({ printedQuestion: "9+4=", studentAnswer: "13" }), false, "no pictogramData on the item must not match");
});

// Ticket 109: static "square is a special rectangle" fact, found in a
// real P2 worksheet's own conclusion sentence ("square is a kind of
// special ___ because it has all the properties of rectangle").
test("mentionsShape2D / SHAPE_2D_REFERENCE: the square-is-a-rectangle fact is present in the reference block", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "Is a square a kind of rectangle?", studentAnswer: "yes" },
  ]);
  assert.match(prompt, /正方形係一種特別嘅長方形/);
});

// Ticket 107: 柱體/錐體 grouping convention, found in a real 躍思 answer
// key ("6 立體圖形" grouping triangular prism under 柱體, not just cylinder).
test("mentionsShapeGeometry / SHAPE_REFERENCE: the 柱體/錐體 grouping convention is present", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "以下邊個立體圖形唔係錐體?", studentAnswer: "三棱柱" },
  ]);
  assert.match(prompt, /「柱體」包括長方柱、圓柱/);
});

// Ticket 107 (dozen/clock mechanics reference).
test("mentionsQuantityWordOrClockMechanics: fires on dozen/half-dozen and clock small-division wording", async () => {
  const worker = await import(TMP);
  assert.equal(worker.mentionsQuantityWordOrClockMechanics([{ printedQuestion: "Mum buys half a dozen of waffles." }]), true);
  assert.equal(worker.mentionsQuantityWordOrClockMechanics([{ printedQuestion: "當分針行了1小格，秒針行了多少小格？" }]), true);
  assert.equal(worker.mentionsQuantityWordOrClockMechanics([{ printedQuestion: "9 + 4 = ?" }]), false);
});

test("buildAiFallbackPrompt: includes the dozen/clock-mechanics reference only when relevant", async () => {
  const worker = await import(TMP);
  const withDozen = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "Mum buys half a dozen of waffles. How much should she pay?", studentAnswer: "30 dollars" },
  ]);
  assert.match(withDozen, /半打\(half a dozen\) = 6個/);
  const unrelated = worker.buildAiFallbackPrompt([{ question: "1", printedQuestion: "9 + 4 = ?", studentAnswer: "13" }]);
  assert.doesNotMatch(unrelated, /一打\(a dozen\)/);
});

// Ticket 97/107: HK curriculum's week-starts-Sunday convention, confirmed
// independently in both 樂思 and 躍思 -- a real trap: "一個星期中，第五
// 天是星期五" is FALSE under this convention (the 5th day is Thursday).
test("mentionsWeekdayOrdinal / WEEKDAY_CONVENTION_REFERENCE: fires on ordinal-day-of-week wording", async () => {
  const worker = await import(TMP);
  const prompt = worker.buildAiFallbackPrompt([
    { question: "1", printedQuestion: "一個星期中，第五天是星期五。", studentAnswer: "錯" },
  ]);
  assert.match(prompt, /一星期嘅第一天係星期日/);
  const unrelated = worker.buildAiFallbackPrompt([{ question: "1", printedQuestion: "9 + 4 = ?", studentAnswer: "13" }]);
  assert.doesNotMatch(unrelated, /一星期嘅第一天係星期日/);
});

// Ticket 108 (2026-09-28, real citations from a P2 3-D shapes unit
// test's own answer key): reverse shape lookup from stated face
// properties -- pure text reasoning, reuses the SHAPE_REFERENCE facts
// in reverse. Real quotes: "A 3-D shape has 6 lateral faces. All the
// lateral faces are triangles. It is a ___." -> Hexagonal pyramid;
// "A 3-D shape has 8 faces. Its lateral faces are quadrilaterals. It
// is a ___." -> hexagonal prism.
test("verifyReverseShapeFromFaceProperties: N triangular lateral faces -> N-sided pyramid", async () => {
  const worker = await import(TMP);
  const r = worker.verifyReverseShapeFromFaceProperties(
    "A 3-D shape has 6 lateral faces. All the lateral faces are triangles. It is a ___.",
    "hexagonal pyramid",
  );
  assert.equal(r.correct, true);
  const wrong = worker.verifyReverseShapeFromFaceProperties(
    "A 3-D shape has 6 lateral faces. All the lateral faces are triangles. It is a ___.",
    "pentagonal pyramid",
  );
  assert.equal(wrong.correct, false);
});

test("verifyReverseShapeFromFaceProperties: total faces + quadrilateral lateral faces -> N-sided prism", async () => {
  const worker = await import(TMP);
  const r = worker.verifyReverseShapeFromFaceProperties(
    "A 3-D shape has 8 faces. Its lateral faces are quadrilaterals. It is a ___.",
    "hexagonal prism",
  );
  assert.equal(r.correct, true, "8 faces = 6 lateral + 2 bases -> hexagonal prism");
});

test("verifyReverseShapeFromFaceProperties: explicit face-composition list (2 triangles = the prism's own bases)", async () => {
  const worker = await import(TMP);
  const r = worker.verifyReverseShapeFromFaceProperties("Faces: 3 rectangles + 2 triangles", "triangular prism");
  assert.equal(r.correct, true);
});

test("verifyReverseShapeFromFaceProperties: declines outside the 3-8 sided range and on ambiguous phrasing", async () => {
  const worker = await import(TMP);
  const outOfRange = worker.verifyReverseShapeFromFaceProperties(
    "A 3-D shape has 12 lateral faces. All the lateral faces are triangles. It is a ___.",
    "12-agonal pyramid",
  );
  assert.equal(outOfRange.correct, null);
  const ambiguous = worker.verifyReverseShapeFromFaceProperties("Which shape has 6 faces?", "cube");
  assert.equal(ambiguous.correct, null);
});

test("reverse_shape_from_face_properties handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "reverse_shape_from_face_properties");
  assert.ok(handler, "reverse_shape_from_face_properties handler must be registered");
  const item = { printedQuestion: "A 3-D shape has 6 lateral faces. All the lateral faces are triangles. It is a ___.", studentAnswer: "hexagonal pyramid" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
  assert.equal(handler.detect({ printedQuestion: "9 + 4 = ?", studentAnswer: "13" }), false);
});

// Ticket 78/89 (2026-09-28, real citations: "6 cars in front of his car.
// His car is the ___ car." -> 7th; MC "8 people in front of her.
// Position? A.Sixth B.Seventh C.Eighth D.Ninth" -> Ninth).
test("verifyOrdinalFromCountInFront: position = count-in-front + 1, numeric and spelled-out forms", async () => {
  const worker = await import(TMP);
  const r1 = worker.verifyOrdinalFromCountInFront("6 cars in front of his car. His car is the ___ car.", "7");
  assert.equal(r1.correct, true);
  const r2 = worker.verifyOrdinalFromCountInFront("8 people in front of her. What is her position?", "Ninth");
  assert.equal(r2.correct, true);
  const wrong = worker.verifyOrdinalFromCountInFront("6 cars in front of his car. His car is the ___ car.", "6th");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "7");
});

test("parseOrdinalToNumber: numeric, Nth-suffixed, and spelled-out ordinal words", async () => {
  const worker = await import(TMP);
  assert.equal(worker.parseOrdinalToNumber("7"), 7);
  assert.equal(worker.parseOrdinalToNumber("7th"), 7);
  assert.equal(worker.parseOrdinalToNumber("Seventh"), 7);
  assert.ok(Number.isNaN(worker.parseOrdinalToNumber("cylinder")));
});

test("ordinal_from_count_in_front handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "ordinal_from_count_in_front");
  assert.ok(handler, "ordinal_from_count_in_front handler must be registered");
  const item = { printedQuestion: "6 cars in front of his car. His car is the ___ car.", studentAnswer: "7" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
  assert.equal(handler.detect({ printedQuestion: "9 + 4 = ?", studentAnswer: "13" }), false);
});

// Ticket 86 (2026-09-28, real citation: "If 7+6=☆, then ☆-6=? A.0 B.6
// C.7 D.13" -> answer C=7).
test("verifySymbolicSubstitution: solves the first equation, substitutes into the second", async () => {
  const worker = await import(TMP);
  const r = worker.verifySymbolicSubstitution("If 7+6=☆, then ☆-6=?", "7");
  assert.equal(r.correct, true);
  const wrong = worker.verifySymbolicSubstitution("If 7+6=☆, then ☆-6=?", "13");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "7");
});

test("symbolic_substitution handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "symbolic_substitution");
  assert.ok(handler);
  const item = { printedQuestion: "If 7+6=☆, then ☆-6=?", studentAnswer: "7" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 93 (2026-09-28, real citation: "如果△+○=□，(a) ○+___=□
// (b) □-___=△" -> (a)=△ (b)=○).
test("verifySymbolicRelation: resolves equivalent rearranged forms of a given symbolic sum", async () => {
  const worker = await import(TMP);
  const ra = worker.verifySymbolicRelation("如果△+○=□，○+___=□", "△");
  assert.equal(ra.correct, true);
  const rb = worker.verifySymbolicRelation("如果△+○=□，□-___=△", "○");
  assert.equal(rb.correct, true);
  const wrong = worker.verifySymbolicRelation("如果△+○=□，○+___=□", "○");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "△");
});

test("symbolic_relation handler: registered and reachable, doesn't confuse □ (a real symbol here) with the blank marker", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "symbolic_relation");
  assert.ok(handler);
  const item = { printedQuestion: "如果△+○=□，○+___=□", studentAnswer: "△" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
  assert.equal(handler.detect({ printedQuestion: "9 + 4 = ?", studentAnswer: "13" }), false);
});

// Ticket 116 (2026-09-28, real citation: "Sarah takes 3 seconds longer
// than Linda, but 2 seconds shorter than Jessie. Among the three
// people, ___ walks the fastest." -> Linda).
test("verifyRelativeComparisonChain: resolves fastest/slowest from a relative-difference chain", async () => {
  const worker = await import(TMP);
  const printed = "To walk the same distance, Sarah takes 3 seconds longer than Linda, but 2 seconds shorter than Jessie. Among the three people, ___ walks the fastest.";
  const r = worker.verifyRelativeComparisonChain(printed, "Linda");
  assert.equal(r.correct, true);
  const wrong = worker.verifyRelativeComparisonChain(printed, "Jessie");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "Linda");
});

test("relative_comparison_chain handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "relative_comparison_chain");
  assert.ok(handler);
  const item = { printedQuestion: "Sarah takes 3 seconds longer than Linda, but 2 seconds shorter than Jessie. Among the three people, ___ walks the fastest.", studentAnswer: "Linda" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 113 (2026-09-28, real citation: "The swimming pool is 25 m
// long. Nick swims back and forth twice. How many metres does he
// swim?" -> 100).
test("verifyCompoundMultiplierWordProblem: 'back and forth N times' = base * 2 * N", async () => {
  const worker = await import(TMP);
  const printed = "The swimming pool is 25 m long. Nick swims back and forth twice. How many metres does he swim?";
  const r = worker.verifyCompoundMultiplierWordProblem(printed, "100");
  assert.equal(r.correct, true);
  const wrong = worker.verifyCompoundMultiplierWordProblem(printed, "50");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "100");
});

test("compound_multiplier_word_problem handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "compound_multiplier_word_problem");
  assert.ok(handler);
  const item = { printedQuestion: "The swimming pool is 25 m long. Nick swims back and forth twice. How many metres does he swim?", studentAnswer: "100" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 84 (2026-09-28, real citation: "Box A ≤9 pieces, Box B ≤5
// pieces, total=12. At least how many in Box A?" -> 7).
test("verifyMinFromTwoCapacityConstraints: min(first box) = total - max(second box)", async () => {
  const worker = await import(TMP);
  const printed = "Box A ≤9 pieces, Box B ≤5 pieces, total=12. At least how many pieces are in Box A?";
  const r = worker.verifyMinFromTwoCapacityConstraints(printed, "7");
  assert.equal(r.correct, true);
  const wrong = worker.verifyMinFromTwoCapacityConstraints(printed, "4");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "7");
});

test("min_from_two_capacity_constraints handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "min_from_two_capacity_constraints");
  assert.ok(handler);
  const item = { printedQuestion: "Box A ≤9 pieces, Box B ≤5 pieces, total=12. At least how many pieces are in Box A?", studentAnswer: "7" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 75 (2026-09-28, real citations: "Which is NOT correct?
// A.12-0=0 B.9+0=9 C.0+18=18 D.14-14=0" -> A; "A.9=2+6 B.5+2=7 C.10-4=2
// D.1+7=9" -- which IS correct -> B).
test("verifyEquationTruthMC: 'which is NOT correct' framing", async () => {
  const worker = await import(TMP);
  const printed = "Which is NOT correct? A.12-0=0 B.9+0=9 C.0+18=18 D.14-14=0";
  const r = worker.verifyEquationTruthMC(printed, "A");
  assert.equal(r.correct, true);
});

test("verifyEquationTruthMC: 'which IS correct' framing", async () => {
  const worker = await import(TMP);
  const printed = "A.9=2+6 B.5+2=7 C.10-4=2 D.1+7=9";
  const r = worker.verifyEquationTruthMC(printed, "B");
  assert.equal(r.correct, true);
  const wrong = worker.verifyEquationTruthMC(printed, "A");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "B");
});

test("equation_truth_mc handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "equation_truth_mc");
  assert.ok(handler);
  const item = { printedQuestion: "Which is NOT correct? A.12-0=0 B.9+0=9 C.0+18=18 D.14-14=0", studentAnswer: "A" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 77 (2026-09-28, real citation: "How do you separate 10
// [candies] into two groups? 10 = [] + []").
test("verifyOpenDecomposition: any valid split is accepted, not one fixed pair", async () => {
  const worker = await import(TMP);
  const printed = "How do you separate 10 candies into two groups? 10 = [] + []";
  const r1 = worker.verifyOpenDecomposition(printed, "6;4");
  assert.equal(r1.correct, true);
  const r2 = worker.verifyOpenDecomposition(printed, "1;9");
  assert.equal(r2.correct, true, "any pair summing to 10 must be accepted");
  const wrong = worker.verifyOpenDecomposition(printed, "6;3");
  assert.equal(wrong.correct, false);
});

test("open_decomposition handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "open_decomposition");
  assert.ok(handler);
  const item = { printedQuestion: "10 = [] + []", studentAnswer: "6;4" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 81 (2026-09-28, real citation: "Use 8, 9, 17 to form 4
// different expressions" -- valid set includes 8+9=17, 17-9=8, etc.)
test("verifyFactFamilyGeneration: checks membership in the closed set of 4 valid rearrangements", async () => {
  const worker = await import(TMP);
  const printed = "Use 8, 9, 17 to form 4 different expressions: (a)[]+[]=[]";
  assert.equal(worker.verifyFactFamilyGeneration(printed, "8+9=17").correct, true);
  assert.equal(worker.verifyFactFamilyGeneration(printed, "17-9=8").correct, true);
  assert.equal(worker.verifyFactFamilyGeneration(printed, "8+9=18").correct, false);
});

test("fact_family_generation handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "fact_family_generation");
  assert.ok(handler);
  const item = { printedQuestion: "Use 8, 9, 17 to form 4 different expressions: (a)[]+[]=[]", studentAnswer: "8+9=17" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 74/90 (2026-09-28, real citations: "Three odd numbers arranged
// smallest→greatest: 67, ?, 81. May be: ... C.73 ..." and "子良的學號比9
// 小，又比5大，而且是一個單數" -> 7): extends the existing
// verifyNumberBetween with an optional parity constraint stacked on top
// of the range check.
test("verifyNumberBetween: with an odd/even constraint stacked on the range check", async () => {
  const worker = await import(TMP);
  const oddPrinted = "子良的學號比9小，又比5大，而且是一個單數。";
  assert.equal(worker.verifyNumberBetween(oddPrinted, "7").correct, true);
  assert.equal(worker.verifyNumberBetween(oddPrinted, "6").correct, false, "6 is in range but even -- must fail the odd constraint");
  assert.equal(worker.verifyNumberBetween(oddPrinted, "3").correct, false, "3 is odd but out of range");
});

test("verifyNumberBetween: plain range check (no parity keyword) is unaffected by the extension", async () => {
  const worker = await import(TMP);
  const printed = "Write a number between 3 and 8.";
  assert.equal(worker.verifyNumberBetween(printed, "5").correct, true);
  assert.equal(worker.verifyNumberBetween(printed, "4").correct, true, "even numbers must still pass when no parity keyword is present");
});

// Ticket 118 (2026-09-28, real citation: "There are 42 blue chairs, 36
// red chairs and 15 yellow chairs in the office. How many chairs are
// there in the office altogether?" -> 93): confirms the EXISTING
// verifyWordProblemTotal already generalizes to N>=2 addends (its own
// `nums.length < 2` check was never actually restricted to exactly 2) --
// no new code needed, just locking this real 3-addend citation in as a
// regression test.
test("verifyWordProblemTotal: already generalizes to 3+ addends (real citation, no new code needed)", async () => {
  const worker = await import(TMP);
  const printed = "There are 42 blue chairs, 36 red chairs and 15 yellow chairs in the office. How many chairs are there in the office altogether?";
  const r = worker.verifyWordProblemTotal(printed, "93");
  assert.equal(r.correct, true);
});

// Ticket 117 (2026-09-28, real citation: "the longer hand on a clock
// face points to 12 while the shorter hand points to 5. The cartoon
// programme starts at ___ o'clock." -> 5).
test("verifyTextualClockDescription: reads hand positions directly from text, no image needed", async () => {
  const worker = await import(TMP);
  const printed = "When a cartoon programme starts, the longer hand on a clock face points to 12 while the shorter hand points to 5. The cartoon programme starts at ___ o'clock.";
  const r = worker.verifyTextualClockDescription(printed, "5");
  assert.equal(r.correct, true);
  const wrong = worker.verifyTextualClockDescription(printed, "6");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "5 o'clock");
});

test("textual_clock_description handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "textual_clock_description");
  assert.ok(handler);
  const item = { printedQuestion: "the longer hand on a clock face points to 12 while the shorter hand points to 5. The cartoon programme starts at ___ o'clock.", studentAnswer: "5" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 122 (2026-09-28, real citation: "If a box of oranges is shared
// equally among 10 people, there will be one orange left. What is the
// possible number of oranges in the box? A.10 B.19 C.20 D.21" -> D).
test("verifyModularRemainderMC: filters MC options by the stated remainder condition", async () => {
  const worker = await import(TMP);
  const printed = "If a box of oranges is shared equally among 10 people, there will be one orange left. What is the possible number of oranges in the box? A.10 B.19 C.20 D.21";
  const r = worker.verifyModularRemainderMC(printed, "D");
  assert.equal(r.correct, true);
  const wrong = worker.verifyModularRemainderMC(printed, "A");
  assert.equal(wrong.correct, false);
});

test("modular_remainder_mc handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "modular_remainder_mc");
  assert.ok(handler);
  const item = { printedQuestion: "If a box of oranges is shared equally among 10 people, there will be one orange left. What is the possible number of oranges in the box? A.10 B.19 C.20 D.21", studentAnswer: "D" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 123 (2026-09-28, real citation: "In a classroom, there are 80
// students. If 19 students go to the library and 57 students go home,
// how many students are still in the classroom?" -> 4).
test("verifySequentialSubtractionRemaining: subtracts each departing group in turn", async () => {
  const worker = await import(TMP);
  const printed = "In a classroom, there are 80 students. If 19 students go to the library and 57 students go home, how many students are still in the classroom?";
  const r = worker.verifySequentialSubtractionRemaining(printed, "4");
  assert.equal(r.correct, true);
});

test("sequential_subtraction_remaining handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "sequential_subtraction_remaining");
  assert.ok(handler);
  const item = { printedQuestion: "In a classroom, there are 80 students. If 19 students go to the library and 57 students go home, how many students are still in the classroom?", studentAnswer: "4" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 76/139 (2026-09-28, real citation: "以下哪組數可合成13?
// A.6和5 B.8和5 C.4和7 D.9和3" -> B).
test("verifyMatchingValueExpressionSetMC: finds the unique option matching a stated target sum", async () => {
  const worker = await import(TMP);
  const printed = "以下哪組數可合成13? A.6和5 B.8和5 C.4和7 D.9和3";
  const r = worker.verifyMatchingValueExpressionSetMC(printed, "B");
  assert.equal(r.correct, true);
  const wrong = worker.verifyMatchingValueExpressionSetMC(printed, "A");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "B");
});

test("matching_value_expression_set_mc handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "matching_value_expression_set_mc");
  assert.ok(handler);
  const item = { printedQuestion: "以下哪組數可合成13? A.6和5 B.8和5 C.4和7 D.9和3", studentAnswer: "B" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 134 (2026-09-28, real citations from a printed "五月" calendar
// grid: day 1 = Saturday, 31 days). All 4 real question shapes computed
// and cross-checked by hand against the actual printed grid before
// writing these tests: Mondays fall on 3/10/17/24/31 (5 of them); day 19
// is a Wednesday; the 4th Saturday is the 22nd; June 1 (day 32) is a Tuesday.
const MAY_CALENDAR = { month: 5, firstWeekday: 6, daysInMonth: 31 }; // 六=Saturday

test("verifyCalendarGridQuery: shape 1 -- count of a named weekday in the month", async () => {
  const worker = await import(TMP);
  const r = worker.verifyCalendarGridQuery(MAY_CALENDAR, "五月有___個星期一。", "5");
  assert.equal(r.correct, true, "Mondays: 3,10,17,24,31 = 5");
  const wrong = worker.verifyCalendarGridQuery(MAY_CALENDAR, "五月有___個星期一。", "4");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "5");
});

test("verifyCalendarGridQuery: shape 2 -- a specific day (Chinese numeral) -> weekday name", async () => {
  const worker = await import(TMP);
  const r = worker.verifyCalendarGridQuery(MAY_CALENDAR, "小美在五月十九日生日，那天是星期___。", "三");
  assert.equal(r.correct, true, "day 19 is a Wednesday (三)");
  const wrong = worker.verifyCalendarGridQuery(MAY_CALENDAR, "小美在五月十九日生日，那天是星期___。", "二");
  assert.equal(wrong.correct, false);
});

test("verifyCalendarGridQuery: shape 3 -- Kth occurrence of a weekday -> which day", async () => {
  const worker = await import(TMP);
  const r = worker.verifyCalendarGridQuery(MAY_CALENDAR, "小美在第四個星期六參加義工服務。那天是___月___日。", "5月22日");
  assert.equal(r.correct, true, "1st Sat=1, 2nd=8, 3rd=15, 4th=22");
});

test("verifyCalendarGridQuery: shape 4 -- next month's day 1 -> weekday name", async () => {
  const worker = await import(TMP);
  const r = worker.verifyCalendarGridQuery(MAY_CALENDAR, "6月的第一天是星期___", "二");
  assert.equal(r.correct, true, "day 32 (June 1) = Tuesday");
});

test("verifyCalendarGridQuery: declines (null) with no calendarGrid or unmatched phrasing", async () => {
  const worker = await import(TMP);
  assert.equal(worker.verifyCalendarGridQuery(null, "五月有___個星期一。", "5").correct, null);
  assert.equal(worker.verifyCalendarGridQuery(MAY_CALENDAR, "9 + 4 = ?", "13").correct, null);
});

test("calendar_grid_query handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "calendar_grid_query");
  assert.ok(handler);
  const item = { printedQuestion: "五月有___個星期一。", studentAnswer: "5", calendarGrid: MAY_CALENDAR };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
  assert.equal(handler.detect({ printedQuestion: "9 + 4 = ?", studentAnswer: "13" }), false);
});

// chineseNumeralToArabicSmall: needed for shape 2's "十九日" citation.
test("chineseNumeralToArabicSmall: parses 1-99 Chinese numerals", async () => {
  const worker = await import(TMP);
  assert.equal(worker.chineseNumeralToArabicSmall("十九"), 19);
  assert.equal(worker.chineseNumeralToArabicSmall("二十"), 20);
  assert.equal(worker.chineseNumeralToArabicSmall("二十一"), 21);
  assert.equal(worker.chineseNumeralToArabicSmall("五"), 5);
  assert.equal(worker.chineseNumeralToArabicSmall("十"), 10);
});

// Ticket 135 (2026-09-28, real citations: "小怡在星期___有游泳班。" and
// "如果明天是星期五，小怡今天的活動是*(戲劇班/書法班/中文班/籃球班)。").
const XIAOYI_SCHEDULE = { "星期日": "英文班", "星期一": "游泳班", "星期二": "戲劇班", "星期三": "書法班", "星期四": "中文班", "星期五": "籃球班", "星期六": "休息" };

test("verifyScheduleTableQuery: shape 1 -- reverse lookup which day has a named activity", async () => {
  const worker = await import(TMP);
  const r = worker.verifyScheduleTableQuery(XIAOYI_SCHEDULE, "小怡在星期___有游泳班。", "一");
  assert.equal(r.correct, true);
  const wrong = worker.verifyScheduleTableQuery(XIAOYI_SCHEDULE, "小怡在星期___有游泳班。", "二");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "一");
});

test("verifyScheduleTableQuery: shape 2 -- day-shift (yesterday of stated day) then forward lookup", async () => {
  const worker = await import(TMP);
  const r = worker.verifyScheduleTableQuery(XIAOYI_SCHEDULE, "如果明天是星期五，小怡今天的活動是*(戲劇班/書法班/中文班/籃球班)。", "中文班");
  assert.equal(r.correct, true, "tomorrow=Friday -> today=Thursday -> 中文班");
});

test("verifyScheduleTableQuery: declines (null) with no scheduleTable or unmatched phrasing", async () => {
  const worker = await import(TMP);
  assert.equal(worker.verifyScheduleTableQuery(null, "小怡在星期___有游泳班。", "一").correct, null);
  assert.equal(worker.verifyScheduleTableQuery(XIAOYI_SCHEDULE, "9 + 4 = ?", "13").correct, null);
});

test("schedule_table_query handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "schedule_table_query");
  assert.ok(handler);
  const item = { printedQuestion: "小怡在星期___有游泳班。", studentAnswer: "一", scheduleTable: XIAOYI_SCHEDULE };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
  assert.equal(handler.detect({ printedQuestion: "9 + 4 = ?", studentAnswer: "13" }), false);
});

// Location-grid compass-direction reasoning (found 2026-09-28, real
// citations from a P2 exam's Q24/25). Grid positions confirmed by hand
// against the source image: the grid is IRREGULAR (row 3 has only 2
// cells, under columns 1-2), and the printed compass shows North
// pointing LEFT on the page.
const PLAZA_GRID = {
  northDir: "左",
  positions: {
    "體育館": { row: 0, col: 0 }, "商場": { row: 0, col: 1 }, "碼頭": { row: 0, col: 2 },
    "加油站": { row: 1, col: 0 }, "酒店": { row: 1, col: 1 }, "樂園": { row: 1, col: 2 },
    "巴士站": { row: 2, col: 1 }, "港鐵站": { row: 2, col: 2 },
  },
};

test("verifyLocationGridQuery: shape 1 -- direct direction X->Y (real citation)", async () => {
  const worker = await import(TMP);
  const r = worker.verifyLocationGridQuery(PLAZA_GRID, "由巴士站向___方走，便可到達酒店。", "東");
  assert.equal(r.correct, true, "巴士站 is directly below 酒店 on screen; North=left means screen-up=East");
  const wrong = worker.verifyLocationGridQuery(PLAZA_GRID, "由巴士站向___方走，便可到達酒店。", "北");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "東");
});

test("verifyLocationGridQuery: shape 2 -- reverse lookup (real citation)", async () => {
  const worker = await import(TMP);
  const r = worker.verifyLocationGridQuery(PLAZA_GRID, "___在體育館的西方。", "加油站");
  assert.equal(r.correct, true, "加油站 is directly below 體育館 on screen; North=left means screen-down=West");
});

test("verifyLocationGridQuery: declines (null) on a true diagonal relationship, not validated", async () => {
  const worker = await import(TMP);
  // 巴士站=(2,1) and 碼頭=(0,2) differ in BOTH row and column -- a real diagonal.
  const r = worker.verifyLocationGridQuery(PLAZA_GRID, "由巴士站向___方走，便可到達碼頭。", "東北");
  assert.equal(r.correct, null);
});

test("verifyLocationGridQuery: declines (null) with no locationGrid or unmatched phrasing", async () => {
  const worker = await import(TMP);
  assert.equal(worker.verifyLocationGridQuery(null, "由巴士站向___方走，便可到達酒店。", "東").correct, null);
  assert.equal(worker.verifyLocationGridQuery(PLAZA_GRID, "9 + 4 = ?", "13").correct, null);
});

// Rotation-table internal-consistency check for the 3 north-orientations
// NOT covered by a real citation (only "左" is real-world validated
// above) -- verifies the geometry is at least self-consistent: whichever
// screen direction North is defined to point at must itself map back to
// "北" under that same rotation table.
test("verifyLocationGridQuery: rotation table is self-consistent for every north orientation (a location in the declared north screen-direction always resolves to 北)", async () => {
  const worker = await import(TMP);
  const A = { row: 1, col: 1 };
  const screenPositionFor = {
    "上": { row: 0, col: 1 }, // B directly above A
    "右": { row: 1, col: 2 }, // B directly right of A
    "下": { row: 2, col: 1 }, // B directly below A
    "左": { row: 1, col: 0 }, // B directly left of A
  };
  for (const northDir of ["上", "右", "下", "左"]) {
    const grid = { northDir, positions: { A, B: screenPositionFor[northDir] } };
    const r = worker.verifyLocationGridQuery(grid, "由A向___方走，便可到達B。", "北");
    assert.equal(r.correct, true, `northDir=${northDir}: a location in that exact screen direction must resolve to 北`);
  }
});

test("location_grid_query handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "location_grid_query");
  assert.ok(handler);
  const item = { printedQuestion: "由巴士站向___方走，便可到達酒店。", studentAnswer: "東", locationGrid: PLAZA_GRID };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
  assert.equal(handler.detect({ printedQuestion: "9 + 4 = ?", studentAnswer: "13" }), false);
});

// Location-grid shape 3 (2026-09-28, real citations, Q26/27 of the same
// P2 exam): multi-step path via a named intermediate landmark.
test("verifyLocationGridQuery: shape 3 -- multi-step path via intermediate landmark (Q26 real citation)", async () => {
  const worker = await import(TMP);
  const printed = "嘉言由港鐵站前往商場，他應先向___方走，經過巴士站後，再一直往___方走便可到達。";
  const r = worker.verifyLocationGridQuery(PLAZA_GRID, printed, "北;東");
  assert.equal(r.correct, true);
  const wrong = worker.verifyLocationGridQuery(PLAZA_GRID, printed, "南;東");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "北;東");
});

test("verifyLocationGridQuery: shape 3 -- Q27 real citation", async () => {
  const worker = await import(TMP);
  const printed = "李小姐由酒店前往碼頭，她應先向___方走，經過商場後，再往___方走便可到達。";
  const r = worker.verifyLocationGridQuery(PLAZA_GRID, printed, "東;南");
  assert.equal(r.correct, true);
});

// Facing-direction reasoning (2026-09-28, real citations, Q28/29 of the
// same P2 exam as the location-grid tests above -- both cross-verified
// by hand to agree on the same underlying fact: 偉誠 faces 東).
const WAI_SING_FACING = { "偉誠": "東" };

test("verifyFacingDirectionQuery: shape 1 -- turn right/left from a known direction (Q29 real citation)", async () => {
  const worker = await import(TMP);
  const r = worker.verifyFacingDirectionQuery(WAI_SING_FACING, "偉誠向右轉一個直角後，面向___方。", "南");
  assert.equal(r.correct, true, "turning right (clockwise) from 東 gives 南");
  const wrong = worker.verifyFacingDirectionQuery(WAI_SING_FACING, "偉誠向右轉一個直角後，面向___方。", "北");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "南");
});

test("verifyFacingDirectionQuery: turning LEFT goes the other way round the cycle", async () => {
  const worker = await import(TMP);
  const r = worker.verifyFacingDirectionQuery(WAI_SING_FACING, "偉誠向左轉一個直角後，面向___方。", "北");
  assert.equal(r.correct, true, "turning left (counter-clockwise) from 東 gives 北");
});

test("verifyFacingDirectionQuery: shape 2 -- opposite direction when face-to-face (Q28 real citation)", async () => {
  const worker = await import(TMP);
  const printed = "梓君和偉誠面對面站在一起。梓君面向___方。";
  const r = worker.verifyFacingDirectionQuery(WAI_SING_FACING, printed, "西");
  assert.equal(r.correct, true, "opposite of 偉誠's 東 is 西");
  const wrong = worker.verifyFacingDirectionQuery(WAI_SING_FACING, printed, "東");
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correctAnswer, "西");
});

test("verifyFacingDirectionQuery: declines (null) with no facingDirection or unmatched phrasing", async () => {
  const worker = await import(TMP);
  assert.equal(worker.verifyFacingDirectionQuery(null, "偉誠向右轉一個直角後，面向___方。", "南").correct, null);
  assert.equal(worker.verifyFacingDirectionQuery(WAI_SING_FACING, "9 + 4 = ?", "13").correct, null);
});

test("facing_direction_query handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "facing_direction_query");
  assert.ok(handler);
  const item = { printedQuestion: "偉誠向右轉一個直角後，面向___方。", studentAnswer: "南", facingDirection: WAI_SING_FACING };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
  assert.equal(handler.detect({ printedQuestion: "9 + 4 = ?", studentAnswer: "13" }), false);
});

// Ticket 119 (real citation): change from a 2-item purchase.
test("verifyChangeFromTwoItemPurchase: real citation", async () => {
  const worker = await import(TMP);
  const printed = "Each sandwich costs 3 dollars. Each bottle of juice costs 7 dollars. Sue spends 15 dollars to buy one sandwich and one bottle of juice. How much change does she receive?";
  assert.equal(worker.verifyChangeFromTwoItemPurchase(printed, "5").correct, true);
  assert.equal(worker.verifyChangeFromTwoItemPurchase(printed, "8").correct, false);
});
test("change_from_two_item_purchase handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "change_from_two_item_purchase");
  assert.ok(handler);
  const item = { printedQuestion: "Each sandwich costs 3 dollars. Each bottle of juice costs 7 dollars. Sue spends 15 dollars to buy one sandwich and one bottle of juice. How much change does she receive?", studentAnswer: "5" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 121 (real citation): resource-constrained "at most".
test("verifyResourceConstrainedMax: real citation", async () => {
  const worker = await import(TMP);
  const printed = "It takes 2 bows and 3 flower buttons to decorate a dress. There are now 11 bows and 19 flower buttons. How many dresses can be decorated at most?";
  assert.equal(worker.verifyResourceConstrainedMax(printed, "5").correct, true);
  assert.equal(worker.verifyResourceConstrainedMax(printed, "6").correct, false);
});
test("resource_constrained_max handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "resource_constrained_max");
  assert.ok(handler);
  const item = { printedQuestion: "It takes 2 bows and 3 flower buttons to decorate a dress. There are now 11 bows and 19 flower buttons. How many dresses can be decorated at most?", studentAnswer: "5" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 124 (real citation): chained two-step equation, mid blank.
test("verifyChainedTwoStepBlank: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyChainedTwoStepBlank("79 - 18 - [] = 10", "51");
  assert.equal(r.correct, true);
  assert.equal(worker.verifyChainedTwoStepBlank("79 - 18 - [] = 10", "50").correct, false);
});
test("chained_two_step_blank handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "chained_two_step_blank");
  assert.ok(handler);
  const item = { printedQuestion: "79 - 18 - [] = 10", studentAnswer: "51" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 127 (real citation): curve-only-letter MC.
test("verifyCurveOnlyLetterMC: real citation", async () => {
  const worker = await import(TMP);
  const printed = "Circle the English letter(s) below that are formed by curves only. ( Q / H / R / S )";
  assert.equal(worker.verifyCurveOnlyLetterMC(printed, "S").correct, true);
  assert.equal(worker.verifyCurveOnlyLetterMC(printed, "H").correct, false);
});
test("curve_only_letter_mc handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "curve_only_letter_mc");
  assert.ok(handler);
  const item = { printedQuestion: "Circle the English letter(s) below that are formed by curves only. ( Q / H / R / S )", studentAnswer: "S" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 136 (real citation): total-then-regroup word problem.
test("verifyRegroupTotalWordProblem: real citation", async () => {
  const worker = await import(TMP);
  const printed = "餅店店員把蛋糕每10個裝成一盒，可裝成2盒；如果改為每2個裝成一盒，可以裝成多少盒？";
  assert.equal(worker.verifyRegroupTotalWordProblem(printed, "10").correct, true);
  assert.equal(worker.verifyRegroupTotalWordProblem(printed, "5").correct, false);
});
test("regroup_total_word_problem handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "regroup_total_word_problem");
  assert.ok(handler);
  const item = { printedQuestion: "餅店店員把蛋糕每10個裝成一盒，可裝成2盒；如果改為每2個裝成一盒，可以裝成多少盒？", studentAnswer: "10" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 137 (real citation): elapsed-time inequality MC.
test("verifyElapsedTimeInequalityMC: real citation", async () => {
  const worker = await import(TMP);
  const printed = "爸爸在3時正開始做運動，他做運動的時間比3小時長，以下哪一項可能是爸爸結束做運動的時間？A.4時正 B.5時正 C.6時正 D.7時正";
  assert.equal(worker.verifyElapsedTimeInequalityMC(printed, "D").correct, true);
  assert.equal(worker.verifyElapsedTimeInequalityMC(printed, "C").correct, false);
});
test("elapsed_time_inequality_mc handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "elapsed_time_inequality_mc");
  assert.ok(handler);
  const item = { printedQuestion: "爸爸在3時正開始做運動，他做運動的時間比3小時長，以下哪一項可能是爸爸結束做運動的時間？A.4時正 B.5時正 C.6時正 D.7時正", studentAnswer: "D" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 138 (real citation): yesterday/tomorrow simple shift.
test("verifyYesterdayTomorrowShift: real citation", async () => {
  const worker = await import(TMP);
  const printed = "如果琴日是星期二，聽日是星期___。";
  assert.equal(worker.verifyYesterdayTomorrowShift(printed, "四").correct, true);
  assert.equal(worker.verifyYesterdayTomorrowShift(printed, "三").correct, false);
});
test("yesterday_tomorrow_shift handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "yesterday_tomorrow_shift");
  assert.ok(handler);
  const item = { printedQuestion: "如果琴日是星期二，聽日是星期___。", studentAnswer: "四" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 140 (real citation): duration sum across multiple time ranges.
test("verifyDurationSumWordProblem: real citation", async () => {
  const worker = await import(TMP);
  const printed = "工作時間：9時正至12時正，3時正至6時正。媽媽每天工作___小時。";
  assert.equal(worker.verifyDurationSumWordProblem(printed, "6").correct, true);
  assert.equal(worker.verifyDurationSumWordProblem(printed, "3").correct, false);
});
test("duration_sum_word_problem handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "duration_sum_word_problem");
  assert.ok(handler);
  const item = { printedQuestion: "工作時間：9時正至12時正，3時正至6時正。媽媽每天工作___小時。", studentAnswer: "6" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 130 (2026-09-28 REGRESSION, real citation: "[box]82 / − 4[box]
// / 6[box]5" -> 682-47=635): confirms the EXISTING generic
// verifyMissingDigitsInEquation already solves this real 3-blank vertical
// subtraction citation (unique solution H=6,U=7,T=3) -- no new code
// needed, this locks in the real example as a regression test.
test("verifyMissingDigitsInEquation: real 3-blank vertical subtraction citation (682-47=635), no new code needed", async () => {
  const worker = await import(TMP);
  const r = worker.verifyMissingDigitsInEquation("□82-4□=6□5", "6,7,3");
  assert.equal(r.correct, true);
  const wrong = worker.verifyMissingDigitsInEquation("□82-4□=6□5", "5,3,6");
  assert.equal(wrong.correct, false);
});

// Ticket 125 (real citation, found on re-reading the original survey
// report -- see the function's own comment for the process-review story).
test("verifyTwoStageAffordabilityChain: real citation", async () => {
  const worker = await import(TMP);
  const printed = "John has $80. He wants to buy a doll [$60]. After buying the doll, he still has: $80 − $60 = $20. If he wants to buy a teddy bear too [$33], his remaining money is *(more/less) than the price of a teddy bear. Therefore, John *(has/does not have) enough money to buy a teddy bear.";
  const r = worker.verifyTwoStageAffordabilityChain(printed, "less;does not have");
  assert.equal(r.correct, true, `remaining=$20 < $33 -> less, does not have; got ${JSON.stringify(r)}`);
  const wrong = worker.verifyTwoStageAffordabilityChain(printed, "more;has");
  assert.equal(wrong.correct, false);
});
test("two_stage_affordability_chain handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "two_stage_affordability_chain");
  assert.ok(handler);
  const item = { printedQuestion: "John has $80. He wants to buy a doll [$60]. After buying the doll, he still has: $80 − $60 = $20. If he wants to buy a teddy bear too [$33], his remaining money is *(more/less) than the price of a teddy bear. Therefore, John *(has/does not have) enough money to buy a teddy bear.", studentAnswer: "less;does not have" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 129 (real citation, found on re-reading the original survey
// report -- construction assumes a flat feed-forward expression format,
// honestly flagged as unconfirmed against real OCR output).
test("verifyChainedVerticalArithmetic: real citation numbers (235+557, then result-281)", async () => {
  const worker = await import(TMP);
  const r = worker.verifyChainedVerticalArithmetic("235+557[]-281[]", "792;511");
  assert.equal(r.correct, true);
  const wrong = worker.verifyChainedVerticalArithmetic("235+557[]-281[]", "792;500");
  assert.equal(wrong.correct, false);
});
test("chained_vertical_arithmetic handler: registered and reachable", async () => {
  const worker = await import(TMP);
  const handler = worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "chained_vertical_arithmetic");
  assert.ok(handler);
  const item = { printedQuestion: "235+557[]-281[]", studentAnswer: "792;511" };
  assert.equal(handler.detect(item), true);
  assert.equal(handler.verify(item).correct, true);
});

// Ticket 141 (2026-09-28 REGRESSION, real citation: "列出34的所有因數。
// (全對才給分)" -> {1,2,17,34}): confirms the EXISTING verifyListFactors
// already solves this, no new code needed.
test("verifyListFactors: real citation (list all factors of 34)", async () => {
  const worker = await import(TMP);
  const printed = "列出34的所有因數。(全對才給分)";
  assert.equal(worker.verifyListFactors(printed, "1,2,17,34").correct, true);
  assert.equal(worker.verifyListFactors(printed, "1,2,17,34,7,4").correct, false, "7 and 4 are not real factors of 34");
});

// Ticket 159 (2026-09-28 REGRESSION, real citation: "用四捨五入法把
// 1584湊整至百位" -> 1600): confirms the EXISTING
// verifyRoundToNearestHundred already solves this per-item shape.
test("verifyRoundToNearestHundred: real citation numbers from the rounding table", async () => {
  const worker = await import(TMP);
  assert.equal(worker.verifyRoundToNearestHundred("用四捨五入法把1584湊整至百位", "1600").correct, true);
  assert.equal(worker.verifyRoundToNearestHundred("用四捨五入法把1733湊整至百位", "1700").correct, true);
  assert.equal(worker.verifyRoundToNearestHundred("用四捨五入法把1930湊整至百位", "1900").correct, true);
});

// Ticket 143 (real citation): composite min-factor-count.
test("verifyMinFactorsOfComposite: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyMinFactorsOfComposite("一個合成數最少有多少個因數？", "3");
  assert.equal(r.correct, true);
  assert.equal(worker.verifyMinFactorsOfComposite("一個合成數最少有多少個因數？", "4").correct, false);
});
test("min_factors_of_composite handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "min_factors_of_composite"));
});

// Ticket 144 (real citation): largest-factor-implies-number.
test("verifyLargestFactorImpliesNumber: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyLargestFactorImpliesNumber("某數的最大因數是28，某數共有多少個因數？", "6");
  assert.equal(r.correct, true, "factors of 28: 1,2,4,7,14,28 = 6");
});
test("largest_factor_implies_number handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "largest_factor_implies_number"));
});

// Ticket 148 (real citation): common factors count.
test("verifyCommonFactorsCount: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyCommonFactorsCount("20和32共有多少個公因數？", "3");
  assert.equal(r.correct, true, "common factors of 20,32: 1,2,4 = 3");
});
test("common_factors_count handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "common_factors_count"));
});

// Ticket 150 (real citation): min-add-to-prime.
test("verifyMinAddToPrime: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyMinAddToPrime("63最少要加上多少，才是一個質數？", "4");
  assert.equal(r.correct, true, "63+4=67 is prime");
});
test("min_add_to_prime handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "min_add_to_prime"));
});

// Ticket 152 (real citation): factor/multiple definition MC.
test("verifyFactorMultipleDefinitionMC: real citation", async () => {
  const worker = await import(TMP);
  const printed = "以下哪一句句子是正確的？A.1是26的倍數 B.13是26的倍數 C.26是26的因數 D.26是2的因數";
  assert.equal(worker.verifyFactorMultipleDefinitionMC(printed, "C").correct, true);
  assert.equal(worker.verifyFactorMultipleDefinitionMC(printed, "A").correct, false);
});
test("factor_multiple_definition_mc handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "factor_multiple_definition_mc"));
});

// Ticket 174 (real citation): price decimal split.
test("verifyPriceDecimalSplit: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyPriceDecimalSplit("$3.80 -> ___ dollars and ___ cents", "3;80");
  assert.equal(r.correct, true);
});
test("price_decimal_split handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "price_decimal_split"));
});

// Ticket 175 (real citation): price list max-min difference.
test("verifyPriceListMaxMinDifference: real citation", async () => {
  const worker = await import(TMP);
  const printed = "$47.00/$51.00/$63.00/$48.00 difference between most expensive and cheapest = A. 15 dollars B. 16 dollars C. 17 dollars";
  const r = worker.verifyPriceListMaxMinDifference(printed, "B");
  assert.equal(r.correct, true);
});
test("price_list_max_min_difference handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "price_list_max_min_difference"));
});

// Ticket 169 (real citations, closes a 3x-confirmed gap): select-two-
// numbers-sum-target now validates the operands actually came from the
// printed candidate set.
test("verifySelectTwoNumbersSumTargetFromText: real citations", async () => {
  const worker = await import(TMP);
  const r1 = worker.verifySelectTwoNumbersSumTargetFromText("6 [ ] 9 [ ] 4 → __+__=10", "6+4");
  assert.equal(r1.correct, true);
  const r2 = worker.verifySelectTwoNumbersSumTargetFromText("6 [ ] 5 [ ] 12 → __+__=18", "6+12");
  assert.equal(r2.correct, true);
  const bad = worker.verifySelectTwoNumbersSumTargetFromText("6 [ ] 9 [ ] 4 → __+__=10", "3+7");
  assert.equal(bad.correct, false, "3 and 7 are not from the given card set {6,9,4}, even though 3+7=10");
});
test("select_two_numbers_sum_target_from_text handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "select_two_numbers_sum_target_from_text"));
});

// Ticket 142 (real citation).
test("verifyFirstNMultiples: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyFirstNMultiples("列出11的最初三個倍數。(全對才給分)", "11,22,33");
  assert.equal(r.correct, true);
});
test("first_n_multiples handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "first_n_multiples"));
});

// Ticket 145 (real citation).
test("verifyReverseBaseFromMultipleDifference: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyReverseBaseFromMultipleDifference("某數的第8個和第10個倍數相差14，求某數。", "7");
  assert.equal(r.correct, true);
});
test("reverse_base_from_multiple_difference handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "reverse_base_from_multiple_difference"));
});

// Ticket 146 (real citation).
test("verifyMissingFactorInOrderedList: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyMissingFactorInOrderedList("70的所有因數是1、2、☆、7、10、14、35和70，☆代表的數是甚麼？", "5");
  assert.equal(r.correct, true);
});
test("missing_factor_in_ordered_list handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "missing_factor_in_ordered_list"));
});

// Ticket 147 (real citation).
test("verifyDualConstraintNumberFilter: real citation", async () => {
  const worker = await import(TMP);
  const printed = "他的球衣上的數字是5的倍數，又是40的因數 A.15 B.10 C.4 D.12";
  const r = worker.verifyDualConstraintNumberFilter(printed, "B");
  assert.equal(r.correct, true);
});
test("dual_constraint_number_filter handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "dual_constraint_number_filter"));
});

// Ticket 149 (real citation).
test("verifyNthCommonMultiple: real citation", async () => {
  const worker = await import(TMP);
  const r = worker.verifyNthCommonMultiple("4和10的第一個公倍數是20，第三個公倍數是甚麼？", "60");
  assert.equal(r.correct, true);
});
test("nth_common_multiple handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "nth_common_multiple"));
});

// Ticket 151 (real citation).
test("verifyCoprimeProductEqualsLcmMC: real citation", async () => {
  const worker = await import(TMP);
  const printed = "以下哪一組數的積就是它們的L.C.M.? A.9,12 B.10,15 C.9,16 D.18,36";
  const r = worker.verifyCoprimeProductEqualsLcmMC(printed, "C");
  assert.equal(r.correct, true);
});
test("coprime_product_equals_lcm_mc handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "coprime_product_equals_lcm_mc"));
});

// Ticket 161 (2026-09-28, real citation: "絲帶每米售6又4/5元，買4又3/4
// 米絲帶，共需付___元。" -> 32又3/10 = 32.3): extends
// verifyWordProblemRateMultiplication to support mixed-number fractions
// for BOTH rate and quantity, plus the "米" unit word -- neither was
// supported before (rate regex only matched a bare integer, and the
// unit-word list didn't include 米).
test("verifyWordProblemRateMultiplication: real citation with fractional rate AND fractional quantity", async () => {
  const worker = await import(TMP);
  const printed = "絲帶每米售6又4/5元，買4又3/4米絲帶，共需付___元。";
  const r = worker.verifyWordProblemRateMultiplication(printed, "32又3/10");
  assert.equal(r.correct, true, "6又4/5 (6.8) * 4又3/4 (4.75) = 32.3 = 32又3/10");
  const wrong = worker.verifyWordProblemRateMultiplication(printed, "30");
  assert.equal(wrong.correct, false);
});

test("verifyWordProblemRateMultiplication: existing plain-integer shape still works (no regression)", async () => {
  const worker = await import(TMP);
  const r = worker.verifyWordProblemRateMultiplication("小克每天儲蓄30元，他五天共儲蓄多少元？", "150");
  assert.equal(r.correct, true);
});

// Ticket 166 (2026-09-28 REGRESSION, real citation: "50 | 100 | 150 |
// 200 | 250 | 300 | 350 (Must be all correct)" -- confirms the EXISTING
// verifySequenceFill already handles multi-blank skip-counting tables,
// no new code needed).
test("verifySequenceFill: real citation (skip-counting by 50s, 2 blanks)", async () => {
  const worker = await import(TMP);
  const r = worker.verifySequenceFill("50,□,150,200,□,300,350", "100,250");
  assert.equal(r.correct, true);
});

// Ticket 170 (2026-09-28 REGRESSION, real citation: "15 + 33 + 24 = [ ]
// + 24 = [ ]" -- confirms the EXISTING verifyChainedVerticalArithmetic
// (Ticket 129) already handles the add-then-add chain shape, not just
// add-then-subtract).
test("verifyChainedVerticalArithmetic: real citation (add-then-add chain)", async () => {
  const worker = await import(TMP);
  const r = worker.verifyChainedVerticalArithmetic("15+33[]+24[]", "48;72");
  assert.equal(r.correct, true, "15+33=48, then 48+24=72");
});

// Ticket 171 (2026-09-28 REGRESSION, real citation: "2 5 + 2 1 →
// [十位][個位]" -- confirms the EXISTING verifyMultiBoxDigitAnswer
// already handles this split-box answer shape, assuming OCR renders the
// printed expression with a trailing "=" per this project's established
// convention).
test("verifyMultiBoxDigitAnswer: real citation (十位/個位 split-box answer)", async () => {
  const worker = await import(TMP);
  const r = worker.verifyMultiBoxDigitAnswer("25+21=", "46");
  assert.equal(r.correct, true);
  const r2 = worker.verifyMultiBoxDigitAnswer("48-15=", "33");
  assert.equal(r2.correct, true);
});

// Ticket 162 (real citation): closest-approximation reverse MC.
test("verifyClosestApproximationMC: real citation", async () => {
  const worker = await import(TMP);
  const printed = "如果△是一個整數，△4/5×2的答案約是16，那麼△表示的數可能是甚麼？ A.6 B.7 C.8 D.9";
  const r = worker.verifyClosestApproximationMC(printed, "B");
  assert.equal(r.correct, true, "(7+4/5)*2=15.6, closest to 16");
});
test("closest_approximation_mc handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "closest_approximation_mc"));
});

// Ticket 167 (real citation).
test("verifyExtremeNumberByDigitSum: real citation", async () => {
  const worker = await import(TMP);
  const printed = "Put 6 beads on the abacus... To represent the largest three-digit odd number, the answer is ___.";
  const r = worker.verifyExtremeNumberByDigitSum(printed, "501");
  assert.equal(r.correct, true, "501: digit sum 5+0+1=6, odd, largest such 3-digit number");
});
test("extreme_number_by_digit_sum handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "extreme_number_by_digit_sum"));
});

// Ticket 168 (real citations).
test("verifyCoinExchangeRatio: real citations", async () => {
  const worker = await import(TMP);
  assert.equal(worker.verifyCoinExchangeRatio("1個$10可換$2 ___個", "5").correct, true);
  assert.equal(worker.verifyCoinExchangeRatio("5個$2可換$1 ___個", "10").correct, true);
  assert.equal(worker.verifyCoinExchangeRatio("2個$1可換50¢ ___個", "4").correct, true);
});
test("coin_exchange_ratio handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "coin_exchange_ratio"));
});

// Ticket 172 (real citation shape, self-consistent grid values derived
// by hand: firstWeekday=5 (Sept 1 = Friday) makes Oct 3 fall on Tuesday,
// matching the real citation's own answer).
test("verifyCalendarGridQuery: shape 5 -- cross-month day-of-week (real citation shape)", async () => {
  const worker = await import(TMP);
  const septGrid = { month: 9, firstWeekday: 5, daysInMonth: 30 };
  const r = worker.verifyCalendarGridQuery(septGrid, "3rd October was ___.", "Tuesday");
  assert.equal(r.correct, true);
  const wrong = worker.verifyCalendarGridQuery(septGrid, "3rd October was ___.", "Monday");
  assert.equal(wrong.correct, false);
});

// Ticket 173 (real citation shape, using the already-established May
// grid from earlier CALENDAR_GRID tests -- 2nd Thursday of May = 13th,
// +1 day = 14th, a Friday).
test("verifyCalendarGridQuery: shape 6 -- Kth-weekday + day-offset compound", async () => {
  const worker = await import(TMP);
  const r = worker.verifyCalendarGridQuery(MAY_CALENDAR, "小美在這個月的第二個星期四參加學校旅行，旅行後放假一天；這天是___月___日(星期___)", "5月14日(星期五)");
  assert.equal(r.correct, true);
});

// Ticket 176 (real citation).
test("verifyWhichExpressionComputesMC: real citation (same result as)", async () => {
  const worker = await import(TMP);
  const printed = "Which of the following expression has the same result as '35-15-9'? A.35-9 B.35-15 C.15-9 D.20-9";
  const r = worker.verifyWhichExpressionComputesMC(printed, "D");
  assert.equal(r.correct, true, "35-15-9=11, and 20-9=11");
});
test("which_expression_computes_mc handler registered", async () => {
  const worker = await import(TMP);
  assert.ok(worker.QUESTION_TYPE_HANDLERS.find((h) => h.name === "which_expression_computes_mc"));
});
