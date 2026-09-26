// Regression tests for POST /telegram-webhook (2026-09-22 Telegram MVP):
// photo in, /api/mark run via a direct handleMark() call (no HTTP
// round-trip), annotateImage() stamps cross.png on incorrect items,
// sendPhoto sends the result back. Covers the 8 required scenarios plus
// the webhook secret-token gate.
//
// Own copy of the "copy worker.js to a temp .mjs, sed-replace the Photon
// import, mock global.fetch" harness from mark.test.js -- duplicated
// rather than shared on purpose, so this file can't accidentally affect
// mark.test.js's existing 32 passing tests. Also needs a matching temp
// copy of annotate.js (same Photon-import problem), since worker.js
// imports it by relative path.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const WORKER_SRC = path.join(__dirname, "..", "src", "worker.js");
const WORKER_TMP = path.join(__dirname, "..", "src", "worker_nodetest_telegram.mjs");
const ANNOTATE_SRC = path.join(__dirname, "..", "src", "annotate.js");
const ANNOTATE_TMP = path.join(__dirname, "..", "src", "annotate_nodetest_telegram.mjs");

test.before(() => {
  const annotateSrc = fs.readFileSync(ANNOTATE_SRC, "utf8").replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node");
  fs.writeFileSync(ANNOTATE_TMP, annotateSrc);
  const workerSrc = fs.readFileSync(WORKER_SRC, "utf8")
    .replace("@cf-wasm/photon/workerd", "@cf-wasm/photon/node")
    .replace('from "./annotate.js"', 'from "./annotate_nodetest_telegram.mjs"');
  fs.writeFileSync(WORKER_TMP, workerSrc);
});
test.after(() => {
  fs.rmSync(WORKER_TMP, { force: true });
  fs.rmSync(ANNOTATE_TMP, { force: true });
});

const REAL_JPEG = fs.readFileSync(path.join(__dirname, "fixtures", "tiny-photo.jpg"));
const NOT_AN_IMAGE = new TextEncoder().encode("not a real image, plain text bytes");

const BOT_TOKEN = "test-bot-token";
const WEBHOOK_SECRET = "test-webhook-secret";

function photoUpdate(fileId) {
  return {
    message: {
      chat: { id: 987654321 },
      photo: [
        { file_id: fileId, width: 90, height: 60, file_size: 1000 },
        { file_id: fileId, width: 800, height: 600, file_size: 8227 }, // largest -- must be the one picked
      ],
    },
  };
}

// `telegramBehavior` controls each mocked Telegram endpoint's outcome;
// `openrouterBehavior` controls the mocked Qwen OCR call handleMark makes
// internally. `photoBytes` is what the mocked file-download endpoint
// returns -- real JPEG bytes by default, swappable per test.
function mockFetch({ telegramBehavior = {}, openrouterBehavior = "ok", photoBytes = REAL_JPEG, calls = [] } = {}) {
  return async (url, opts) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("api.telegram.org")) {
      if (u.includes("/getFile")) {
        if (telegramBehavior.getFile === "fail") return new Response("{}", { status: 500 });
        return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg" } }), { status: 200 });
      }
      if (u.includes("/file/bot")) {
        if (telegramBehavior.download === "fail") return new Response("not found", { status: 404 });
        return new Response(photoBytes, { status: 200, headers: { "content-length": String(photoBytes.length) } });
      }
      if (u.includes("/sendPhoto")) {
        if (telegramBehavior.sendPhoto === "fail") return new Response("bad request", { status: 400 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.includes("/sendMessage")) {
        if (telegramBehavior.sendMessage === "fail") return new Response("bad request", { status: 400 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error("unexpected telegram endpoint: " + u);
    }
    if (u.includes("openrouter.ai")) {
      if (openrouterBehavior === "fail") return new Response("upstream failure", { status: 502 });
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "1=4+6|10" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
}

async function callWebhook(body, { headers = {}, telegramBehavior, openrouterBehavior, photoBytes, env = {} } = {}) {
  const worker = await import(WORKER_TMP);
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = mockFetch({ telegramBehavior, openrouterBehavior, photoBytes, calls });
  try {
    const req = new Request("https://example.com/telegram-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const fullEnv = {
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      OPENROUTER_API_KEY: "test-openrouter-key",
      ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
      ...env,
    };
    const res = await worker.default.fetch(req, fullEnv);
    const text = await res.text();
    return { status: res.status, text, calls };
  } finally {
    global.fetch = originalFetch;
  }
}

test("1. valid photo update: downloads, marks, annotates, and sends a photo back", async () => {
  const { status, text, calls } = await callWebhook(photoUpdate("file123"));
  assert.equal(status, 200);
  assert.equal(text, "ok");
  assert.ok(calls.some((u) => u.includes("/getFile")), "expected a getFile call");
  assert.ok(calls.some((u) => u.includes("/file/bot")), "expected a file download call");
  assert.ok(calls.some((u) => u.includes("/sendPhoto")), "expected a sendPhoto call");
  // The success path now sends exactly ONE text message: the "改緊功課..."
  // in-progress notice sent right after download, before marking starts.
  // GENERIC_ERROR is only ever sent from the failure branches (tests 4-6),
  // which never reach sendPhoto -- so on a path that DOES reach sendPhoto,
  // a single sendMessage can only be that progress notice, not an error.
  const sendMessageCalls = calls.filter((u) => u.includes("/sendMessage"));
  assert.equal(sendMessageCalls.length, 1, "expected exactly one sendMessage call: the in-progress notice");
});

test("2. no photo update: returns ok, makes no Telegram/OpenRouter calls at all", async () => {
  const { status, text, calls } = await callWebhook({ message: { chat: { id: 1 }, text: "hello" } });
  assert.equal(status, 200);
  assert.equal(text, "ok");
  assert.equal(calls.length, 0, "a non-photo update should never touch Telegram or OpenRouter");
});

test("2b. document (e.g. PDF) update with no photo: sends a clear 'not supported' message, no getFile/mark/OpenRouter calls", async () => {
  const { status, text, calls } = await callWebhook({
    message: { chat: { id: 1 }, document: { file_id: "doc1", mime_type: "application/pdf", file_name: "homework.pdf" } },
  });
  assert.equal(status, 200);
  assert.equal(text, "ok");
  assert.ok(!calls.some((u) => u.includes("/getFile")), "must not try to download a document as a photo");
  assert.ok(!calls.some((u) => u.includes("openrouter.ai")), "must not spend any AI call on an unsupported document");
  const sendMessageCalls = calls.filter((u) => u.includes("/sendMessage"));
  assert.equal(sendMessageCalls.length, 1, "expected exactly one clear notice message, not silence");
});

test("2c. document AND photo both present (e.g. photo sent as a file attachment): treated as a photo, not silenced", async () => {
  const update = photoUpdate("file123");
  update.message.document = { file_id: "doc1", mime_type: "image/jpeg", file_name: "scan.jpg" };
  const { status, calls } = await callWebhook(update);
  assert.equal(status, 200);
  assert.ok(calls.some((u) => u.includes("/getFile")), "photo present alongside a document should still be marked normally");
});

test("3. malformed update: bad JSON body returns ok, does not throw", async () => {
  const { status, text, calls } = await callWebhook("{not valid json");
  assert.equal(status, 200);
  assert.equal(text, "ok");
  assert.equal(calls.length, 0);
});

test("4. Telegram API failure (getFile fails): sends a generic error message, does not crash", async () => {
  const { status, text, calls } = await callWebhook(photoUpdate("file123"), { telegramBehavior: { getFile: "fail" } });
  assert.equal(status, 200);
  assert.equal(text, "ok");
  assert.ok(calls.some((u) => u.includes("/sendMessage")), "expected a fallback error message to be sent");
  assert.ok(!calls.some((u) => u.includes("/sendPhoto")), "must not attempt sendPhoto after getFile failed");
});

test("5. marking failure (OpenRouter/Qwen fails on the only page): sends a generic error, no photo sent", async () => {
  const { status, text, calls } = await callWebhook(photoUpdate("file123"), { openrouterBehavior: "fail" });
  assert.equal(status, 200);
  assert.equal(text, "ok");
  assert.ok(calls.some((u) => u.includes("/sendMessage")), "expected a fallback error message when marking produces no usable results");
  assert.ok(!calls.some((u) => u.includes("/sendPhoto")));
});

test("6. annotation failure (downloaded bytes aren't a decodable image): sends a generic error, no photo sent", async () => {
  // handleMark's own downscaleForCheapTier silently falls back to the
  // original bytes if Photon can't decode them (see its own comment in
  // worker.js) -- so marking itself still "succeeds" here. annotateImage
  // does NOT swallow that failure (by design), which is exactly the
  // scenario this test locks in.
  const { status, text, calls } = await callWebhook(photoUpdate("file123"), { photoBytes: NOT_AN_IMAGE });
  assert.equal(status, 200);
  assert.equal(text, "ok");
  assert.ok(calls.some((u) => u.includes("/sendMessage")), "expected a fallback error message when annotation throws");
  assert.ok(!calls.some((u) => u.includes("/sendPhoto")), "must not send a photo when annotation failed");
});

test("7. sendPhoto failure: does not throw, falls back to a text error message", async () => {
  const { status, text, calls } = await callWebhook(photoUpdate("file123"), { telegramBehavior: { sendPhoto: "fail" } });
  assert.equal(status, 200);
  assert.equal(text, "ok");
  assert.ok(calls.some((u) => u.includes("/sendPhoto")), "sendPhoto should still have been attempted");
  assert.ok(calls.some((u) => u.includes("/sendMessage")), "expected the outer catch to fall back to a text message after sendPhoto failed");
});

test("webhook secret: missing X-Telegram-Bot-Api-Secret-Token header is rejected with 403", async () => {
  const worker = await import(WORKER_TMP);
  const originalFetch = global.fetch;
  global.fetch = mockFetch({});
  try {
    const req = new Request("https://example.com/telegram-webhook", {
      method: "POST",
      headers: { "content-type": "application/json" }, // no secret header
      body: JSON.stringify(photoUpdate("file123")),
    });
    const env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, OPENROUTER_API_KEY: "k" };
    const res = await worker.default.fetch(req, env);
    assert.equal(res.status, 403);
  } finally {
    global.fetch = originalFetch;
  }
});

test("webhook secret: wrong header value is rejected with 403", async () => {
  const { status } = await callWebhook(photoUpdate("file123"), { headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" } });
  assert.equal(status, 403);
});

test("webhook secret: TELEGRAM_WEBHOOK_SECRET not configured fails closed with 503, never reads the update", async () => {
  const { status, calls } = await callWebhook(photoUpdate("file123"), { env: { TELEGRAM_WEBHOOK_SECRET: undefined } });
  assert.equal(status, 503);
  assert.equal(calls.length, 0);
});

test("TELEGRAM_BOT_TOKEN not configured fails closed with 503 (after the secret check passes)", async () => {
  const { status, calls } = await callWebhook(photoUpdate("file123"), { env: { TELEGRAM_BOT_TOKEN: undefined } });
  assert.equal(status, 503);
  assert.equal(calls.length, 0);
});

// 8. annotation output has valid image bytes -- direct unit test of
// annotateImage(), independent of the webhook plumbing above.
//
// Byte-length/content differing from the untouched input on its own only
// proves a JPEG *re-encode* happened (decode -> encode at quality 90
// changes bytes even with zero marks drawn) -- it is NOT proof a cross
// was actually stamped. To isolate the cross's own contribution, this
// compares the WITH-an-incorrect-item output against a WITHOUT-any-mark
// output produced from the exact same input bytes and pipeline: if those
// two differ from EACH OTHER, the difference is attributable to the
// watermark step specifically, not to re-encoding noise common to both.
test("8. annotateImage produces valid JPEG bytes, and a cross specifically changes the output", async () => {
  const { annotateImage } = await import(ANNOTATE_TMP);
  const withCross = annotateImage(new Uint8Array(REAL_JPEG), [
    { bbox: { x: 10, y: 10, w: 20, h: 8 }, correct: false },
    { bbox: { x: 50, y: 50, w: 20, h: 8 }, correct: true },
    { bbox: { x: 10, y: 70, w: 20, h: 8 }, correct: null },
    { bbox: null, correct: false }, // no bbox -- must be skipped, not crash
  ]);
  const withoutAnyMark = annotateImage(new Uint8Array(REAL_JPEG), [
    { bbox: { x: 50, y: 50, w: 20, h: 8 }, correct: true }, // no cross for a correct item
  ]);
  assert.equal(withCross.mediaType, "image/jpeg");
  assert.ok(withCross.data.length > 0);
  assert.equal(withCross.data[0], 0xff, "JPEG magic byte 1");
  assert.equal(withCross.data[1], 0xd8, "JPEG magic byte 2");
  // Same input bytes, same encode settings, the ONLY difference between
  // these two calls is whether a cross got drawn -- so a difference here
  // is attributable to the watermark step, not generic re-encode noise.
  assert.notDeepEqual(
    Buffer.from(withCross.data),
    Buffer.from(withoutAnyMark.data),
    "an incorrect item's cross should change the output relative to an otherwise-identical call with no marks to draw"
  );
});

test("8a2. a needs_review (correct: null) item draws its own '?' mark, isolated from the cross path", async () => {
  const { annotateImage } = await import(ANNOTATE_TMP);
  const withReviewMark = annotateImage(new Uint8Array(REAL_JPEG), [
    { bbox: { x: 10, y: 70, w: 20, h: 8 }, correct: null },
  ]);
  const withNoMarks = annotateImage(new Uint8Array(REAL_JPEG), [
    { bbox: { x: 50, y: 50, w: 20, h: 8 }, correct: true },
  ]);
  assert.notDeepEqual(
    Buffer.from(withReviewMark.data),
    Buffer.from(withNoMarks.data),
    "a needs_review item should draw a visible '?' mark, distinct from drawing nothing"
  );
});

test("8b. annotateImage with no incorrect items still returns valid JPEG bytes (no watermark step run)", async () => {
  const { annotateImage } = await import(ANNOTATE_TMP);
  const results = [
    { bbox: { x: 10, y: 10, w: 20, h: 8 }, correct: true },
    { bbox: { x: 50, y: 50, w: 20, h: 8 }, correct: null },
  ];
  const out = annotateImage(new Uint8Array(REAL_JPEG), results);
  assert.equal(out.mediaType, "image/jpeg");
  assert.equal(out.data[0], 0xff);
  assert.equal(out.data[1], 0xd8);
});

test("8c. annotateImage throws on an image whose DECODED pixel count exceeds MAX_ANNOTATION_MEGAPIXELS", async () => {
  const { annotateImage, MAX_ANNOTATION_MEGAPIXELS } = await import(ANNOTATE_TMP);
  const { PhotonImage, resize, SamplingFilter } = await import("@cf-wasm/photon/node");
  // Upscale the small real fixture past the cap rather than shipping a
  // large fixture file -- Nearest sampling + low JPEG quality keep this
  // fast, since pixel fidelity is irrelevant to what this test checks.
  const side = Math.ceil(Math.sqrt(MAX_ANNOTATION_MEGAPIXELS * 1_000_000 * 1.05)); // 5% over the cap
  const small = PhotonImage.new_from_byteslice(new Uint8Array(REAL_JPEG));
  const big = resize(small, side, side, SamplingFilter.Nearest);
  const bigBytes = big.get_bytes_jpeg(60);
  small.free();
  big.free();
  assert.ok((side * side) / 1_000_000 > MAX_ANNOTATION_MEGAPIXELS, "test setup sanity check: the generated image must actually exceed the cap");
  assert.throws(() => annotateImage(new Uint8Array(bigBytes), []), /too large to annotate safely/);
});
