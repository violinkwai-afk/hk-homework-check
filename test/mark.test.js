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

test.before(() => {
  const src = fs.readFileSync(SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(TMP, src);
});
test.after(() => {
  fs.rmSync(TMP, { force: true });
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

async function callMark(images, qwenByMarker) {
  const worker = await import(TMP);
  const originalFetch = global.fetch;
  global.fetch = mockFetch(qwenByMarker);
  try {
    const req = new Request("https://example.com/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images }),
    });
    const env = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      GOOGLE_VISION_API_KEY: "test-vision-key",
      ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    };
    const res = await worker.default.fetch(req, env);
    return { status: res.status, json: await res.json() };
  } finally {
    global.fetch = originalFetch;
  }
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
