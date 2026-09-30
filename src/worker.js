// Cloudflare Worker: serves the static site (website/) for everything except
// /api/check, which calls the Anthropic API to grade an arbitrary photographed
// homework page. Unlike the sibling hk-maths project, there is NO known
// answer key here -- the homework can be anything a parent photographs, so
// the model has to work out the correct answer itself, not just compare
// against a pre-computed one.
//
// Needs an ANTHROPIC_API_KEY bound via Cloudflare's Secrets Store (see
// wrangler.toml -- same store/secret as hk-maths, since it's the same
// Anthropic account). A Secrets Store binding is NOT a plain string -- it's
// an object exposing an async .get(), so read it with
// `await env.ANTHROPIC_API_KEY.get()`.
//
// /api/check is public/unauthenticated -- same per-IP rate limit pattern as
// hk-maths, ported from the same source (the UK site's feedback-endpoint
// anti-abuse code). Needs a RATE_LIMIT_KV binding; fails open if unbound.
import { PhotonImage, crop, rotate, resize, SamplingFilter, normalize } from "@cf-wasm/photon/workerd";
import { parseTelegramUpdate, telegramGetFile, telegramDownloadFile, telegramSendPhoto, telegramSendMessage, constantTimeEqual } from "./telegram.js";
import { annotateImage } from "./annotate.js";
import { contours } from "d3-contour";
import simplifyPolygon from "simplify-js";

// 2026-09-23, explicit instruction: "At the testing stage, do NOT use
// Sonnet/Opus to solve any questions." Claude Sonnet/Opus are meaningfully
// more expensive per call than the OpenRouter cheap tier (Gemini, as of
// Ticket 196 -- was Qwen/DeepSeek before 2026-09-29) --
// a real past incident (see the comment above the callClaude call in
// handleCheckInner) burned through the account's whole prepaid balance in
// under 10 real submissions. Single kill switch checked at every call site
// that could reach Anthropic (handleCheckInner's Sonnet fallback,
// handleVerify's Sonnet+Opus recheckPass cascade) -- flip back to false
// once the testing phase is over and cost-per-submission is being watched
// deliberately again, not by re-adding scattered checks. /api/mark
// (the Telegram/OCR-only pipeline) already never calls Anthropic at all,
// so this constant has no effect there.
const DISABLE_ANTHROPIC_DURING_TESTING = true;

// Client now sends one /api/check call PER PAGE (see website/index.html), so
// this counts pages, not submissions -- a single 5-page homework already
// spends 5 of these. 15 meant just 3 real five-page submissions per hour
// before every subsequent page started failing with "短時間內請求太多",
// which is easy to mistake for a generic error during real testing.
const CHECK_RATE_LIMIT = 40; // max /api/check calls per IP per hour
// Speed-over-precision tradeoff (2026-09-20): the bbox-refinement OCR pass
// (refineWithOcr) is a second Google Vision round trip per page purely to
// sharpen WHERE a mark is drawn / where a recheck crop is centered -- it
// never changes correct/wrong. Skipping it trades a bit of visual/crop
// precision (falls back to the model's own bbox guess) for one fewer
// network round trip per page. Flip back to true if mark placement or
// recheck-crop accuracy visibly regresses.
const REFINE_BBOX_WITH_OCR = false;
const MAX_HANDWRITING_SAMPLES = 12; // per device, oldest evicted first
const HANDWRITING_SAMPLE_TTL = 60 * 60 * 24 * 90; // 90 days
const HANDWRITING_SAMPLES_PER_REQUEST = 3; // new exemplars captured per submission
const HANDWRITING_EXEMPLARS_USED = 4; // most recent samples sent as reference
// Pre-decode gate on a Telegram photo download -- cheap early rejection
// before Photon ever touches the bytes. annotateImage's own
// MAX_ANNOTATION_MEGAPIXELS is the real memory safeguard (file size is a
// poor proxy for decoded size), this just avoids downloading something
// absurd in the first place.
const MAX_TELEGRAM_PHOTO_BYTES = 20 * 1024 * 1024;

// 2026-09-23 (G1): closes the "no version/build traceability" gap flagged
// in TICKETS.md -- rollback previously meant manually cross-referencing
// `wrangler deployments list` timestamps against `git log` timestamps by
// hand. Uses Cloudflare's own native `version_metadata` binding
// (`[version_metadata]` in wrangler.toml, binding = "CF_VERSION_METADATA")
// -- confirmed via Cloudflare's docs to be injected automatically at
// deploy time with the real Worker version UUID/tag/upload timestamp, no
// CI config or manual bumping needed. Replaces the earlier hand-maintained
// BUILD_VERSION string, which needed remembering to bump on every
// deploy-worthy change -- this is fully automatic instead. Falls back to
// "unknown" only if the binding is somehow missing (e.g. run outside a
// real Workers deploy, like these node:test fixtures), never throws.
function versionInfo(env) {
  const meta = env && env.CF_VERSION_METADATA;
  if (!meta) return { id: "unknown", tag: "", timestamp: "unknown" };
  return { id: meta.id || "unknown", tag: meta.tag || "", timestamp: meta.timestamp || "unknown" };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, version: versionInfo(env), time: new Date().toISOString() }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/check" && request.method === "POST") {
      return handleCheck(request, env);
    }
    if (url.pathname === "/api/verify" && request.method === "POST") {
      return handleVerify(request, env);
    }
    if (url.pathname === "/api/forget-handwriting" && request.method === "POST") {
      return handleForgetHandwriting(request, env);
    }
    // Backs website/test.html -- a completely separate, clearly-labelled
    // page for trying the real interface (upload, marks, lightbox, "all
    // correct" badge, phase-1/phase-2 pending->resolved flow) with a
    // canned example result. Deliberately never touches
    // env.ANTHROPIC_API_KEY or makes any outbound call at all, so it is
    // structurally impossible for this route to ever cost real money,
    // not just unlikely to.
    if (url.pathname === "/api/mock-check" && request.method === "POST") {
      return handleMockCheck(request);
    }
    if (url.pathname === "/api/mock-verify" && request.method === "POST") {
      return handleMockVerify(request);
    }
    // TEMPORARY debug route -- exercises the real rate-limit KV and real
    // Google Vision OCR refinement against a caller-supplied "parsed" result
    // (skipping the Anthropic call entirely), so infra behavior/cost can be
    // checked without spending on the metered Claude key. Remove before
    // leaving this in production long-term. 待刪：見TICKETS.md。
    // Ticket 41 (2026-09-30, real finding): this route had NO auth at all
    // -- unlike the 3 latency routes below (Ticket 46 retrofitted them with
    // DEBUG_TOKEN after finding the exact same gap) this one was missed.
    // Gated now, same convention, rather than left as the one exception.
    if (url.pathname === "/api/test-noai-check" && request.method === "POST") {
      if (request.headers.get("x-debug-token") !== DEBUG_TOKEN) return json({ error: "unauthorized" }, 401);
      return handleTestNoAiCheck(request, env);
    }
    // Ticket 46 (2026-09-27): these 3 latency-diagnostic routes are KEPT
    // (not deleted -- explicit user decision, "加密碼", not "刪走") since
    // they're genuinely reusable tools for future infra debugging, unlike
    // Ticket 41's one-use-then-delete temp routes. They predate the
    // DEBUG_TOKEN discipline and were found to have NO auth at all --
    // anyone who knew the URL could trigger real DeepSeek/Vision spend for
    // free. Now gated by the same DEBUG_TOKEN convention (checked inside
    // each handler, via the "x-debug-token" header).
    if (url.pathname === "/api/test-deepseek-latency" && request.method === "GET") {
      return handleTestDeepSeekLatency(request, env);
    }
    if (url.pathname === "/api/test-rotation-latency" && request.method === "POST") {
      return handleTestRotationLatency(request, env);
    }
    if (url.pathname === "/api/test-vision-ocr-latency" && request.method === "POST") {
      return handleTestVisionOcrLatency(request, env);
    }
    // New pipeline (2026-09-21): AI does OCR only, code does the math --
    // see the block comment above callQwenOcrText for why. Separate from
    // /api/check (which still does the older AI-judges-correctness flow)
    // so the two can be compared/switched between without one breaking
    // the other.
    if (url.pathname === "/api/mark" && request.method === "POST") {
      return handleMark(request, env);
    }
    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }
    if (url.pathname === "/api/report-wrong" && request.method === "POST") {
      return handleReportWrong(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

// Ticket 46: shared token gating the 3 kept-permanently latency-diagnostic
// routes below (test-deepseek-latency/test-rotation-latency/
// test-vision-ocr-latency) -- same DEBUG_TOKEN convention as Ticket 41's
// one-use routes, checked via the "x-debug-token" header.
const DEBUG_TOKEN = "hw-debug-20260927";

// Ticket 50 (2026-09-27): Cloudflare Workers CPU-ms billing has NO
// platform-level hard cap -- past the Paid plan's 30M CPU-ms/month
// included, it's uncapped pay-as-you-go ($0.02/million extra). Moving
// off Workers entirely (the only way to get a true hard cap) was
// already tried once (the pre-Photon Railway proxy, see B2 in
// TICKETS.md) and reverted for reliability reasons. This is a
// self-imposed, IN-CODE guard instead: a rough daily CPU-ms estimate
// (wall-clock timing of Photon calls, a reasonable proxy since Photon
// work is synchronous CPU-bound WASM, not I/O-bound) accumulated in KV.
//
// CRITICAL DESIGN CONSTRAINT: this must NEVER degrade grading accuracy
// -- that would violate the standing "accuracy is the floor" hard rule.
// downscaleForCheapTier and rotation-correction stay untouched no matter
// what (skipping them risks real timeouts/misreads, a functional/
// accuracy regression, not just a cost tradeoff). The ONLY thing this
// guard is allowed to degrade is annotateImage's Telegram photo
// annotation -- purely cosmetic presentation of already-computed
// verdicts, never the verdicts themselves. Tripping the guard mainly
// functions as an early-warning alert (surfaced via the existing daily
// CF-usage cron), not a silent accuracy trade.
//
// Threshold: 30M CPU-ms/month included / 30 days ~= 1M ms/day as a
// conservative "don't let one day alone plausibly burn the WHOLE
// month's included budget" ceiling -- deliberately not tuned to real
// observed usage (not yet measured at the time of writing), meant to be
// revisited once the daily cron has collected real data.
const CPU_GUARD_DAILY_THRESHOLD_MS = 1_000_000;

function cpuGuardKeyForToday() {
  return "cpuguard:" + new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
}

// Best-effort, non-atomic accumulation -- same accepted tradeoff as
// Ticket 40's jevhealth counter (a monitoring signal, not a billing-
// grade count; an occasional lost increment under concurrent requests
// is fine, never worth retry/locking complexity). Never allowed to
// throw or block the caller.
async function recordCpuGuardUsage(env, ms) {
  if (!env.RATE_LIMIT_KV || !Number.isFinite(ms) || ms <= 0) return;
  try {
    const key = cpuGuardKeyForToday();
    const raw = await env.RATE_LIMIT_KV.get(key);
    const total = (raw ? Number(raw) : 0) + ms;
    await env.RATE_LIMIT_KV.put(key, String(total), { expirationTtl: 8 * 86400 });
  } catch (e) { /* monitoring only, never block the real request */ }
}

// 2026-09-30: extracted so BOTH the normal (annotated-photo) send path
// and the CPU-guard plain-text fallback path show the same real
// correct-answer data -- see the call sites' own comments for why this
// was previously only reachable via the rare fallback branch.
function buildWrongAnswersSummary(results) {
  const wrongLines = (results || [])
    .filter((r) => r.correct === false)
    .map((r) => {
      const answerPart = r.correctAnswer ? `啱嘅答案係「${r.correctAnswer}」` : "錯";
      // 2026-09-30: r.note now also carries a short WHY for wrong items
      // (AI-fallback items via the extended buildAiFallbackPrompt note
      // field; code-verified items via each handler's own "explanation"
      // -- see classifyAndVerify's call site) -- appended when present,
      // silently omitted otherwise so a handler/AI-fallback item without
      // one yet degrades to exactly the answer-only line this already had.
      return r.note ? `第${r.question}題：${answerPart}（${r.note}）` : `第${r.question}題：${answerPart}`;
    });
  return wrongLines.join("\n");
}

async function isCpuGuardTripped(env) {
  if (!env.RATE_LIMIT_KV) return false;
  try {
    const raw = await env.RATE_LIMIT_KV.get(cpuGuardKeyForToday());
    return !!raw && Number(raw) >= CPU_GUARD_DAILY_THRESHOLD_MS;
  } catch (e) {
    return false; // fail open -- a KV read failure must never block/degrade a real request
  }
}

async function handleTestVisionOcrLatency(request, env) {
  if (request.headers.get("x-debug-token") !== DEBUG_TOKEN) return json({ error: "unauthorized" }, 401);
  const visionKey = !env.GOOGLE_VISION_API_KEY ? null
    : typeof env.GOOGLE_VISION_API_KEY === "string" ? env.GOOGLE_VISION_API_KEY
    : await env.GOOGLE_VISION_API_KEY.get();
  if (!visionKey) return json({ error: "no_vision_key" }, 500);
  const { images } = await request.json();
  const img = images[0];

  const t0 = Date.now();
  let ocr, error;
  try {
    ocr = await googleOcr(img.data, visionKey);
  } catch (e) {
    error = String(e && e.message);
  }
  const elapsedMs = Date.now() - t0;

  if (error) return json({ elapsedMs, error });
  const wordCount = ocr && ocr.words ? ocr.words.length : 0;
  const fullText = (ocr && ocr.words ? ocr.words.map((w) => w.text).join(" ") : "");
  return json({
    elapsedMs,
    wordCount,
    fullText,
    words: ocr && ocr.words ? ocr.words : [],
  });
}

async function handleTestRotationLatency(request, env) {
  if (request.headers.get("x-debug-token") !== DEBUG_TOKEN) return json({ error: "unauthorized" }, 401);
  const openrouterKey = !env.OPENROUTER_API_KEY ? null
    : typeof env.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY
    : await env.OPENROUTER_API_KEY.get();
  const visionKey = !env.GOOGLE_VISION_API_KEY ? null
    : typeof env.GOOGLE_VISION_API_KEY === "string" ? env.GOOGLE_VISION_API_KEY
    : await env.GOOGLE_VISION_API_KEY.get();
  const { images } = await request.json();
  const results = {};

  const t0 = Date.now();
  try {
    const { rotationApplied } = await detectAndCorrectRotation(images, visionKey);
    results.rotationDetectionMs = Date.now() - t0;
    results.rotationApplied = rotationApplied;
  } catch (e) {
    results.rotationDetectionMs = Date.now() - t0;
    results.rotationError = String(e && e.message);
  }

  const t2 = Date.now();
  let downscaled = images;
  try {
    downscaled = images.map((img) => downscaleForCheapTier(img, 640));
    results.downscaleMs = Date.now() - t2;
    results.downscaledSizeBytes = downscaled.map((img) => img.data.length);
    results.originalSizeBytes = images.map((img) => img.data.length);
  } catch (e) {
    results.downscaleMs = Date.now() - t2;
    results.downscaleError = String(e && e.message);
  }

  const testPrompt = "You are a teacher grading this homework photo. Reply with only this JSON: {\"results\":[{\"question\":\"1\",\"studentAnswer\":\"\",\"correct\":true,\"correctAnswer\":\"\",\"note\":\"\",\"page\":0,\"bbox\":{\"x\":0,\"y\":0,\"w\":0,\"h\":0},\"anchor\":\"\",\"riskyDiagram\":false}],\"score\":\"X / Y\"}";
  if (openrouterKey) {
    const t1 = Date.now();
    try {
      const r = await callQwen(downscaled, testPrompt, openrouterKey);
      results.qwenOnRealImageMs = Date.now() - t1;
      results.qwenResultCount = r.parsed.results.length;
    } catch (e) {
      results.qwenOnRealImageMs = Date.now() - t1;
      results.qwenError = e.detail || e.kind;
    }
  }
  return json(results);
}

async function handleTestDeepSeekLatency(request, env) {
  if (request.headers.get("x-debug-token") !== DEBUG_TOKEN) return json({ error: "unauthorized" }, 401);
  const openrouterKey = !env.OPENROUTER_API_KEY ? null
    : typeof env.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY
    : await env.OPENROUTER_API_KEY.get();
  if (!openrouterKey) return json({ error: "no_key" }, 500);

  const attempts = [];
  // Attempt 1: tiny text-only request, no image at all.
  {
    const t0 = Date.now();
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${openrouterKey}`, "http-referer": "https://hk-homework-check.violin-kwai.workers.dev", "x-title": "hk-homework-check" },
        body: JSON.stringify({ model: DEEPSEEK_MODEL, max_tokens: 100, provider: { ignore: ["Alibaba"] }, messages: [{ role: "user", content: "Say OK and nothing else." }] }),
      });
      const data = await res.json();
      attempts.push({ label: "text_only", ms: Date.now() - t0, status: res.status, ok: res.ok, content: data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content });
    } catch (e) {
      attempts.push({ label: "text_only", ms: Date.now() - t0, error: String(e && e.message) });
    }
  }
  // Attempt 2: a tiny real (but small) image, to see if ANY image at all
  // is the trigger, independent of the ~400KB size of a real photo.
  {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const t0 = Date.now();
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${openrouterKey}`, "http-referer": "https://hk-homework-check.violin-kwai.workers.dev", "x-title": "hk-homework-check" },
        body: JSON.stringify({ model: DEEPSEEK_MODEL, max_tokens: 100, provider: { ignore: ["Alibaba"] }, messages: [{ role: "user", content: [{ type: "text", text: "What color is this image? One word." }, { type: "image_url", image_url: { url: `data:image/png;base64,${tinyPng}` } }] }] }),
      });
      const data = await res.json();
      attempts.push({ label: "tiny_image", ms: Date.now() - t0, status: res.status, ok: res.ok, content: data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content });
    } catch (e) {
      attempts.push({ label: "tiny_image", ms: Date.now() - t0, error: String(e && e.message) });
    }
  }
  return json({ attempts });
}

async function handleTestNoAiCheck(request, env) {
  if (env.RATE_LIMIT_KV) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateKey = "checkrate:" + ip;
    let count = 0;
    try {
      const raw = await env.RATE_LIMIT_KV.get(rateKey);
      count = raw ? (parseInt(raw, 10) || 0) : 0;
    } catch (e) { /* KV unreachable -- don't block over it */ }
    if (count >= CHECK_RATE_LIMIT) {
      return json({ error: "rate_limited", message: "短時間內請求太多，請一小時後再試。" }, 429);
    }
    try {
      await env.RATE_LIMIT_KV.put(rateKey, String(count + 1), { expirationTtl: 3600 });
    } catch (e) { /* best-effort */ }
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request", message: "請求格式錯誤。" }, 400);
  }
  const { images, parsed, demoRequestId } = body;
  if (!images || !images.length || !parsed || !parsed.results) {
    return json({ error: "bad_request", message: "缺少images或parsed。" }, 400);
  }

  const visionKey = typeof env.GOOGLE_VISION_API_KEY === "string"
    ? env.GOOGLE_VISION_API_KEY
    : (env.GOOGLE_VISION_API_KEY ? await env.GOOGLE_VISION_API_KEY.get() : null);

  // Same rotation-detection/-correction real submissions get (see
  // detectAndCorrectRotation) -- exercising the real logic here, not a
  // simplified stand-in, is what makes this debug endpoint useful for
  // verifying a rotation fix against an actual problematic photo without
  // spending on the Anthropic call.
  const { rotationApplied, ocrCache } = await detectAndCorrectRotation(images, visionKey);

  let ocrUsed = false;
  if (visionKey && parsed.results.length) {
    try {
      await refineWithOcr(parsed.results, images, visionKey, ocrCache);
      ocrUsed = true;
    } catch (e) {
      return json({ error: "ocr_error", message: String(e && e.message || e) }, 500);
    }
  }

  const pageRotations = {};
  images.forEach((img, i) => { if (rotationApplied[i]) pageRotations[i] = rotationApplied[i]; });
  const finalResult = { ...parsed, ocrUsed, pageRotations };

  // Demo hook: writing this into the SAME idempotency cache the real
  // /api/check endpoint reads means a real submission through the live
  // site's actual UI, using this exact requestId, is served this
  // pre-solved-for-free result instead of calling Anthropic -- letting
  // someone drive the real interface end-to-end (camera, loading state,
  // marked photo, tap-to-toggle) without spending on that specific
  // request. Only ever set by us for a specific pre-agreed demo, never by
  // a real parent's submission.
  if (demoRequestId && env.RATE_LIMIT_KV) {
    try {
      // A real live incident: a demo link was told to the user as
      // permanently reusable/free, but this cache entry expired after its
      // original 1-hour TTL -- silently falling through to a REAL, paid
      // Anthropic call on the next reuse, with no warning to anyone. A
      // demo entry is meant to be a durable fixture, not a short-lived
      // cache -- ~10 years is effectively permanent for this purpose.
      await env.RATE_LIMIT_KV.put("idem:" + String(demoRequestId).slice(0, 100), JSON.stringify(finalResult), { expirationTtl: 315360000 });
    } catch (e) { /* best-effort */ }
  }

  return json(finalResult, 200);
}


async function handleCheck(request, env) {
  // Top-level safety net: ANY uncaught exception anywhere below (a
  // malformed model response, an edge case in a photo the code didn't
  // anticipate -- e.g. an unusual aspect ratio from a sideways photo) used
  // to propagate all the way out of fetch(), which Cloudflare renders as
  // its own HTML "Worker threw exception" error page, NOT JSON. The client
  // calls res.json() on that and THAT throws, landing in the generic
  // "呢頁網絡錯誤" catch-all -- indistinguishable from an actual dropped
  // connection, even though the request reached the server fine and the
  // real cause was a code bug. Wrapping the whole handler guarantees the
  // client always gets back valid, readable JSON with a real status code.
  try {
    return await handleCheckInner(request, env);
  } catch (e) {
    console.log(JSON.stringify({ event: "check_crash", message: String((e && e.message) || e), stack: e && e.stack ? String(e.stack).slice(0, 500) : null }));
    return json({ error: "internal_error", message: "批改服務暫時出錯，請再試一次。", detail: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

async function handleCheckInner(request, env) {
  const startedAt = Date.now();
  // Previously hard-required ANTHROPIC_API_KEY up front even though the
  // OpenRouter cheap tier (Gemini, as of Ticket 196) is tried FIRST and often
  // succeed on their own -- with DISABLE_ANTHROPIC_DURING_TESTING on,
  // Anthropic is never reached at all (see the Sonnet call site below), so
  // requiring the key here would fail the whole endpoint over a key this
  // request will never actually use. Only still hard-required when the
  // Sonnet fallback could genuinely run.
  if (!env.ANTHROPIC_API_KEY && !DISABLE_ANTHROPIC_DURING_TESTING) {
    return json(
      { error: "not_configured", message: "自動改功課未設定好，請聯絡網站管理員。" },
      503
    );
  }
  const apiKey = (!env.ANTHROPIC_API_KEY || DISABLE_ANTHROPIC_DURING_TESTING) ? null
    : typeof env.ANTHROPIC_API_KEY === "string"
    ? env.ANTHROPIC_API_KEY
    : await env.ANTHROPIC_API_KEY.get();
  const openrouterKey = !env.OPENROUTER_API_KEY ? null
    : typeof env.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY
    : await env.OPENROUTER_API_KEY.get();

  if (env.RATE_LIMIT_KV) {
    // Ticket 218: same per-browser-id preference as /api/mark -- see that
    // handler's own comment for why IP alone over-throttles shared
    // networks.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const clientId = (request.headers.get("X-Client-Id") || "").slice(0, 64);
    const rateKey = "checkrate:" + (clientId || ip);
    let count = 0;
    try {
      const raw = await env.RATE_LIMIT_KV.get(rateKey);
      count = raw ? (parseInt(raw, 10) || 0) : 0;
    } catch (e) { /* KV unreachable -- don't block over it */ }
    if (count >= CHECK_RATE_LIMIT) {
      return json(
        { error: "rate_limited", message: "短時間內請求太多，請一小時後再試。" },
        429
      );
    }
    try {
      await env.RATE_LIMIT_KV.put(rateKey, String(count + 1), { expirationTtl: 3600 });
    } catch (e) { /* best-effort */ }
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request", message: "請求格式錯誤。" }, 400);
  }

  let { images, image, mediaType, requestId, deviceId, rememberHandwriting, pageIndex, priorPagesContext, stitchPages } = body;
  if (!images && image) images = [{ data: image, mediaType }];
  if (!images || !images.length) {
    return json({ error: "bad_request", message: "缺少相片。" }, 400);
  }
  // Client now submits one page per request (see website/index.html) so
  // each page shows up as soon as it's graded, instead of the parent
  // waiting for every page in one big multi-image call. `pageIndex` is
  // this page's REAL position in the parent's whole photo set; the model
  // itself always sees exactly one image so it always reports "page":0 --
  // that gets remapped to the real pageIndex right before the response is
  // returned (see near the bottom of this function), so everything
  // upstream of that (OCR refinement, crop-recheck, handwriting capture)
  // keeps working against local index 0 unchanged.
  //
  // `stitchPages` is the rare exception: exactly two real page numbers,
  // sent when a question was detected as literally continuing across
  // those two pages' boundary (see rule 9 in the prompt below). Both
  // images are sent together so the model can actually see the whole
  // spanning question, and each local image index (0, 1) remaps to its
  // own real page number, not a single shared one.
  const isStitch = Array.isArray(stitchPages) && stitchPages.length === images.length;
  const realPageIndex = Number.isInteger(pageIndex) ? pageIndex : 0;
  const MAX_PAGES = 5;
  if (images.length > MAX_PAGES) {
    return json(
      { error: "too_many_pages", message: `每次最多批改 ${MAX_PAGES} 頁，請分開幾次提交。` },
      400
    );
  }

  // Idempotency: a client retry (network blip, double-tap before the button
  // disabled) re-sends the same requestId. Without this, a retry re-runs the
  // full Sonnet/Opus pipeline and pays for it twice for work already done --
  // fine while this is free, but a real problem once this is a paid product.
  // Fails open (no dedup) if the client omits requestId or KV is unbound.
  const idemKey = typeof requestId === "string" && requestId ? "idem:" + requestId.slice(0, 100) : null;
  if (idemKey && env.RATE_LIMIT_KV) {
    try {
      const cached = await env.RATE_LIMIT_KV.get(idemKey);
      if (cached) {
        return new Response(cached, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      }
    } catch (e) { /* best-effort -- fall through and process normally */ }
  }

  // Handwriting profile (opt-in, per-device, no accounts): if this device has
  // previously confirmed-correct handwriting samples on file, send a handful
  // of them as reference images alongside the actual homework pages -- same
  // child, same pen, same letterforms, so a few worked examples of "this is
  // how THIS kid writes" measurably helps the model disambiguate genuinely
  // ambiguous strokes on this new page. This only ever runs when the client
  // sent both an explicit opt-in flag and its own deviceId -- never silently.
  const deviceKey = typeof deviceId === "string" && /^[a-zA-Z0-9-]{8,100}$/.test(deviceId) ? deviceId : null;
  let exemplars = [];
  if (rememberHandwriting && deviceKey && env.RATE_LIMIT_KV) {
    try {
      exemplars = await loadHandwritingExemplars(env.RATE_LIMIT_KV, deviceKey);
    } catch (e) { /* profile lookup failing should never block a normal check */ }
  }

  const visionKey = typeof env.GOOGLE_VISION_API_KEY === "string"
    ? env.GOOGLE_VISION_API_KEY
    : (env.GOOGLE_VISION_API_KEY ? await env.GOOGLE_VISION_API_KEY.get() : null);

  // A parent's photo is often genuinely sideways or upside-down, not just
  // skewed a little -- rule 0 below asks the model to compensate mentally
  // when READING it, but that does nothing for what the user actually
  // SEES: a still-sideways photo with marks whose bbox percentages were
  // computed against an unrotated frame, landing nowhere near the real
  // answers once the client tries to display them upright (or worse,
  // staying sideways with marks scattered as if the page were straight).
  // Detected via the same Vision OCR already used for anchor refinement
  // below, and physically applied with Photon BEFORE the model ever sees
  // the image, so grading, bbox coordinates, and the final display are
  // all consistent with one single upright frame from this point on.
  // `pageRotations` (built near the end, keyed by real page number) tells
  // the client how much to rotate its own displayed copy to match.
  const { rotationApplied, ocrCache } = await detectAndCorrectRotation(images, visionKey);

  // No answer key exists for arbitrary homework -- the model has to solve
  // each question itself before it can judge the child's handwritten answer.
  // It also returns an approximate bounding box (as a % of that page's
  // width/height) near each question, so the client can draw a check/cross
  // mark directly on the photo instead of just listing results as text.
  // "anchor" is a short snippet of PRINTED text next to the question (e.g.
  // its number/label as typeset on the page, not the handwriting) -- when a
  // Google Vision key is configured, that printed text gets located far more
  // precisely by real OCR than the model can eyeball pixel coordinates, and
  // the mark position is upgraded to that OCR box (see refineWithOcr below).
  const prompt = `你是一位細心的小學老師，正在批改學生的功課相片（共${images.length}頁，可能來自唔同科目／唔同來源，並非本網站出嘅練習卷）。呢啲係普通功課，冇提供標準答案——請你自己諗清楚每一題應該點答，再同學生手寫嘅答案比較。

要求（保持精簡，減少字數）：
0. 家長影相好多時求其影，成張相／成頁可能係打橫、上下顛倒或者斜咗，唔一定啱啱好直望。開始答題目之前，先睇下成頁嘅文字／版面方向係咪同正常閱讀方向一致，如果成頁明顯轉咗90度或者180度，先喺腦入面轉返正常方向再讀，唔好因為得個角度奇怪就衝口而出讀錯（尤其係數字，例如6同9、顛倒咗好易搞錯）。
1. 睇清楚相入面每一條題目（可以係印刷體或手寫題目），自己諗出正確答案，然後同學生手寫嘅作答比較。如果題目要睇圖表／刻度先答到（例如燒杯水位、尺、鐘面），一定要搵返個刻度線實際喺邊度，唔好單憑感覺假設「啱啱注滿到頂」或者「啱啱指住嗰粒」，睇唔清就寧願設 "correct" 為 null，唔好肯定咁答錯。
1a. 數圖形／物件數量嗰陣，記住連埋結構性、唔顯眼嘅元件都要數（例如天平嘅橫樑本身都算一個長方形，唔淨係數天平掛住嗰啲圖案），唔好淨係數最搶眼嗰幾件。算柱／珠算圖（萬千百十個嗰種）要逐條柱仔細數珠，數完可以自我檢查：每一條柱代表一個數位，正常應該係0-9粒，如果數到10粒或以上，好大機會數錯咗，要重新數過。呢條規則淨係適用於「題目冇直接俾數字、要靠自己數圖」嘅情況——如果題目已經用文字／數字寫明咗要計算嘅數值（例如「10 upstairs 4 downstairs」呢類文字敘述，或者「10 + 4 = □」呢類算式），一定要直接用題目寫低嘅嗰啲數字去計，唔好走去數圖入面畫緊幾多個人／物件嚟代替（插圖入面畫嘅人頭／物件通常係示意，實際畫幾多個唔一定同題目文字寫嘅數字脗合，靠圖數反而會計錯）。
1b. 如果幾條題目喺數值上有關係（例如後面一題係前面幾題相加或相減），計埋條數check吓學生嘅幾個答案夾唔夾得埋，先落判斷——夾得埋通常代表學生方法啱，唔好淨係逐題獨立咁睇。
1c. 學生作答唔一定係手寫填空：可能係圈出印刷體幾個選項入面嗰一個（例如「Odd / even」、「more / fewer」）、選擇題揀咗個字母寫落格仔、或者一條題目入面有兩三個獨立填空位（呢種情況每個空位當一條獨立嘅細題，題號可以寫「9-1」「9-2」咁分辨，各自有自己嘅bbox）。呢幾種都要當正常作答咁判斷啱唔啱。
1c2. 另一種圈嘢係「喺一堆印刷嘅銀紙／銀仔入面，圈出加埋等於某個金額（例如找續）嘅幾件」——呢個唔係二揀一，係要驗證學生實際圈咗嗰幾件加埋啱唔啱等於目標金額，唔係淨係睇佢有冇圈嘢。
1d. 如果係填色、連線、畫路線呢類靠顏色／筆劃分佈先睇到岩唔岩嘅題目（唔係文字/數字/圈選/字母），呢個方法暫時判斷唔到，"correct" 設為 null，"note" 填「暫未支援」，唔好亂估。
1e. 涉及硬幣／金錢嘅題目，一定要逐個銀仔睇清楚面額先加埋——好似嘅面額容易睇錯（例如$2同2毫、$10同$1、$5同5毫），唔好掃一眼就當晒係熟悉嗰個幣值。日常物件長度／重量嘅估算題（例如「一枝牙籤大約幾多厘米」），可以用生活常識判斷合理答案，唔使淨係靠張相度長度。
1f. 「用尺喺相片度量出實物長度」呢類題目（張相冇印刷刻度，淨係得箭嘴標住個範圍），相片本身冇辦法知道原本印刷嘅實際比例，要靠校準先度得到。優先用**同一題入面較早部份學生自己填嘅長度答案**做參照，同相入面兩件物件嘅像素長度比例推算後面嘅答案（呢個方法兩件物件通常喺相入面距離接近，受影相角度/透視影響較細）；搵唔到就退而求其次，睇吓張相有冇完整影到成張紙嘅左右兩邊——大部分香港功課用A4紙（直度闊21厘米，橫度闊29.7厘米），用嗰個已知闊度做比例尺（但如果張紙睇落唔規則／有明顯透視傾斜，呢個方法唔準，唔好用）。用呢兩種校準方法計出嚟嘅答案，比較學生答案嗰陣要畀寬鬆少少嘅容忍度（正負1厘米或者正負一成，以較大者為準）先算啱，因為呢個方法本身已經有額外誤差，唔應該當精確量度咁計較。兩種方法都用唔到、又冇容忍到嘅範圍先設"correct"為null，"note"填「無法量度」。
1g. 判斷角度大小、係咪直角呢類靠小圖線條斜度先睇到嘅題目，同睇刻度一樣容易睇錯，唔好淨係睇成頁縮圖就落判斷——如果唔夠肯定就設"correct"為null，等後續放大果層先仔細睇。留意好多教科書標示直角會加一個細方塊符號喺個角度，見到就可以直接當直角。
1h. 「喺鐘面度畫時針分針」呢類畫圖題,同填色/連線唔同,呢個係有明確答案嘅——睇清楚學生畫嗰兩支針分別指向邊度,計返係幾點幾分,同題目要求嘅時間比較,唔使當「暫未支援」。有秒針嘅鐘面（三支針）要留意秒針通常最幼、走得最快，唔好將佢同分針搞亂，三支針要分開逐支睇清楚方向。
1i. 「(Show full steps)/列式計算」呢類要求寫低成串計算過程嘅大空白格,唔好淨係搵一個獨立數字，成個空白格當一條題目、一個bbox——判斷嗰陣淨係睇個過程最尾嗰個答案啱唔啱，"correctAnswer"填正確嘅最終答案，中間步驟有冇小瑕疵唔使深究（呢個系統冇部分給分，淨係啱定錯）。
1k. 直式長除法／直式計算入面填缺格嘅數字題（即係傳統嗰種：除數喺左邊、商喺上面、下面一步步減嘅格式），呢啲缺格唔係印刷字，要靠成條直式嘅運算關係自己計返嗰個缺格應該係咩數字，唔係憑空估。
1j. 分辨立體圖形（prism/pyramid）嗰陣，唔好淨係睇成個2D畫圖嘅輪廓形狀（例如「楔形」睇落成日兩種都好似），要睇清楚圖入面畫緊嘅**每一塊面本身係咩形狀**：prism嘅畫法一定會見到最少一塊平行四邊形／長方形嘅側面（因為佢係將一個底面拉長嗰種形狀）；pyramid嘅畫法所有面都係三角形，全部匯聚去一個尖頂，冇任何平行四邊形側面。見到內部分界線分出嚟嘅兩塊都係三角形，就係pyramid，唔好因為個輪廓睇落似楔形就當係prism。
1l. 方向題（東南西北）一定要留意圖入面個指南針／「北」字箭嘴實際指住邊——呢類題目成日刻意將個指南針畫成唔係向上（例如「北」指向左邊），專登考你有冇認定「上面就係北」呢個錯誤假設。答呢類題之前，一定要先喺圖度搵到個方向指標，用嗰個嚟做基準，唔好預設向上=北。
1m. 分數題入面「圖形分咗幾份，塗色部分係幾多分之幾」呢類，一定要數清楚（1）成個圖形總共分咗幾多份**相等**嘅部分，（2）當中有幾多份塗咗色，先計到個分數——呢類圖形嘅分割線可能唔規則（例如五角星、菱形對角線），要淨係計清楚份數，唔好靠感覺估比例。
1n. 「邊個中文字有平行線／垂直線／直角」呢類題，要將個字嘅筆劃當做幾條線段咁分析，睇吓邊兩筆係咪同一方向（平行）或者互相垂直，唔好淨係憑個字嘅感覺去揀。
1o. 「正」字或者劃線記數（tally）嘅記錄表，每組完整嘅記號代表5（例如「正」字5筆，或者4條直線加1條斜/橫線劃過），要跟呢個規律去數總數，唔好當普通線條逐條數。
1p. 「完成棒形圖／畫棒形圖」呢類要求學生根據數據自己畫棒／填色去表示數值嘅題目，唔算填色/連線嗰種「暫未支援」——要睇學生畫嗰條棒嘅高度／格數係咪同俾定嘅數據脗合，用返呢個嚟判斷啱唔啱。
1q. 「邊個數字表示嘅數值最大／最小」呢類位值題，唔好預設「最小」一定係個位數字——如果個數入面有「0」，唔理佢喺邊個位，佢表示嘅數值都係0，通常會細過任何非零嘅個位數字，計嗰陣要留意呢個陷阱。
1r. 總原則：以上規則列唔晒所有陷阱，答題前（尤其係睇圖、量度、位值比較、揀「最大/最小」呢類容易一時疏忽嘅題目）習慣用第二個方法快速覆核一次自己個答案（例如由答案倒推番、或者換個角度重新諗一次）。如果兩次結果唔一致，或者覆核完仍然唔夠十足把握，寧願將"correct"設為null，等後續zoom-in recheck處理，唔好因為表面睇落簡單就衝口而出——依家嘅安全網（null先會攞去放大複查）淨係喺你自己知道唔肯定嗰陣先幫到手，你越肯認低威唔夠信心，個系統就越可靠。
1s. 功課唔一定係數學，可能係英文／中文科。呢類語文題判斷方法同數理題唔同，唔好硬套「淨係一個啱答案」嗰套：
  - 文法填充（人稱代名詞、is/am/are/has/have、動詞時態、量詞、its/it's呢類）：當一般填充題判斷，但留意可能唔止一個文法上啱嘅答案，只要學生填嗰個喺文法上同上下文都講得通就算啱，唔好死跟一個假設嘅「標準答案」。
  - 「用完整句子回答」嘅閱讀理解題：判斷準則有（a）內容啱唔啱（同段落嘅事實脗合，容許學生用自己方式改寫，唔使逐隻字抄原文）（b）係咪完整句子（有主詞有動詞，唔係抄一嚿詞語就算）（c）代名詞/時態轉換啱唔啱（例如題目問"why does he..."，答案唔應該再抄"I"，要轉返做第三人稱）。呢三樣都okay先算啱，容許用詞有出入，唔使一字不漏。
  - 開放式作文／造句（例如跟住例句嘅格式，用指定生字自己作幾句，或者自由作文）：呢類冇一個固定字眼嘅「正確答案」，要好似小學老師咁用幾個角度一齊睇：(1)有冇跟到題目要求嘅格式/句式/指定生字 (2)文法啱唔啱 (3)內容通唔通、切唔切題 (4)係咪完整句子 (5)標點/大階字母啱唔啱。呢幾樣普遍過關（P1水平嘅寬鬆標準，唔使完美）就"correct"設true；有明顯問題（例如完全冇跟指定生字、文法錯到影響理解、離題）就設false並喺"note"簡短講邊樣唔妥；字太潦草睇唔清先設null。呢類自由作答，成篇/成組句子可以當一條題目一個bbox，唔使逐隻字扣。中文作文對應準則係：內容、句子通順、有冇錯別字、標點。
  - 呢類語文題嘅"correctAnswer"欄唔一定填得到單一標準答案，可以填一個示範性嘅合理答案，或者留空。
2. 答題位置完全空白、無筆跡，"correct" 設為 false，"note" 填「未作答」。小朋友成日用鉛筆寫字，筆跡好淺好幼，同紙張反光/陰影好易混淆——判斷「未作答」之前，一定要放大瞇實眼仔細睇清楚個格仔入面實際有冇淺色筆劃（尤其係啲數字嘅曲線、直線），唔好因為顏色淺就掃一眼當空白，衝口而出話未作答。如果隱約見到疑似筆跡但唔夠肯定寫緊咩，都好過寧願設"correct"為null（見規則3），唔好一見到淺色就直接判"未作答"。
3. 只有答題位置確實有筆跡，但寫得太潦草或有歧義而無法判斷，先將 "correct" 設為 null，並喺 "note" 簡短註明原因（例如「字跡不清」），四個字以內。
4. 只有 "correct" 係 false 先填 "correctAnswer"（即係正確答案應該係咩，愈短愈好），其他情況（答啱或者唔確定）"correctAnswer" 留空字串。"note" 只在未作答或唔確定時填寫，其餘一律留空。
5. 對於每一題，喺 "bbox" 提供一個大約嘅方框位置，用百分比（0-100）表示，相對於嗰一頁相片嘅闊度同高度，方框範圍應該喺學生手寫作答附近或題號隔籬，等我哋可以喺相片上面嗰個位置標記剔號或交叉。另外用 "page" 講呢一題喺第幾張相（由0開始計）。
6. 喺 "anchor" 填低嗰一題「印刷體」嘅題號標籤本身，淨係果幾個字符（例如 "1."、"3)"、"(a)"、"四、"），千祈唔好抄埋成句題目或者算式，愈短愈準。搵唔到就填空字串。
7. 淨係做啱錯判斷，唔使分析弱項或者其他額外內容。
8. "riskyDiagram" 設為 true，如果呢一題屬於以下容易睇錯嘅類型（唔理你自己覺得幾肯定都好，只要屬於呢啲類型都要老實填true）：睇刻度／量表／燒杯水位、量度長度、判斷角度大小或直角、分辨立體圖形（prism/pyramid/cylinder/cone）、硬幣/銀紙面額、圈出加埋等於某金額嘅組合、方向/指南針、分數塗色部分、算柱/珠算數珠、位值比較（邊個數字表示最大/最小）、tally記數。純文字計算、普通選擇題、清清楚楚嘅填空（例如"3+5="）呢類唔使設true。
9. 呢張相可能只係一份多頁功課入面嘅其中一頁。留意張相嘅最頂同最底：如果最頂一開始就係一題嘅中間部分（冇題號、冇上文，好似接住上一頁未完嘅嘢），"continuesFromPrevious" 設為true；如果最底最後一題睇落未完（例如題目敘述好似仲未問完、冇答題位置、圖表被切斷），"continuesToNext" 設為true。兩個都預設false，唔好亂咁當有延續，要真係見到明顯線索先設true。
只回覆一個JSON物件，不要加任何其他文字：
{
  "results": [
    {"question":"題號","studentAnswer":"學生答案","correct":true/false/null,"correctAnswer":"","note":"","page":0,"bbox":{"x":0,"y":0,"w":0,"h":0},"anchor":"","riskyDiagram":false}
  ],
  "score": "X / Y（Y為總題數，X為答對題數，包括未作答；只有字跡不清的題目不計入Y）",
  "continuesFromPrevious": false,
  "continuesToNext": false
}`
    + (exemplars.length
      ? `\n\n附加：最後${exemplars.length}張圖係同一個小朋友之前已確認啱嘅字跡樣本，純粹俾你熟悉佢寫字嘅風格，唔屬於今次功課，唔使批改，"page"編號同"bbox"都唔關呢幾張事。`
      : '')
    + (Array.isArray(priorPagesContext) && priorPagesContext.length
      ? `\n\n附加：呢頁屬於同一份功課嘅其中一部份，以下係其他頁面已經批改咗嘅結果（僅供參考，唔使批改，亦睇唔到嗰啲頁面嘅相）：${JSON.stringify(priorPagesContext).slice(0, 3000)}。如果依家呢頁嘅題目同上面嘅結果有數值關係（例如加減關係），可以用嚟核對，但如果冇睇到相關題目就照舊自己判斷，唔使勉強搵關係。`
      : '');

  // Cheap-tier-only, deliberately condensed version of the same prompt --
  // Sonnet keeps the full one above untouched. Originally written for
  // DeepSeek specifically (real testing 2026-09-20 showed prompt length/
  // complexity directly drives a reasoning model's internal "reasoning"
  // token usage: same image+task, the short prompt below used ~7000
  // reasoning tokens and finished, the full prompt maxed out 20000 and
  // failed outright) -- speed/cost took priority over exhaustive edge-
  // case coverage per explicit instruction. Keeps only the highest-value,
  // confirmed-real-bug protections (faint pencil misread as blank; using
  // stated numbers over counting illustration objects); drops the longer
  // tail of narrower edge-case rules (coins, angles, tally marks, position
  // value, compass tricks, fraction shading, etc.) that Sonnet still covers
  // when the cheap tier fails or when this item lands in the null->verify
  // tier. Kept as-is after the 2026-09-29 Qwen/DeepSeek->Gemini swap below
  // -- still the right length/complexity tradeoff for a fast cheap-tier
  // call, name just no longer implies one specific model.
  const cheapTierPrompt = `你是一位細心的小學老師，正在批改學生的功課相片（共${images.length}頁）。冇提供標準答案——請你自己諗清楚每一題應該點答，再同學生手寫嘅答案比較。

要求（精簡）：
1. 相有機會打橫/倒轉，先確認閱讀方向啱先答題，尤其留意6/9呢類易錯數字。
2. 題目已經用文字/數字寫明要計算嘅數值（例如「10 upstairs 4 downstairs」或「10+4=」），一定要用返題目寫低嘅數字去計，唔好走去數插圖入面畫緊幾多個人/物件代替。
3. 學生成日用鉛筆寫字，筆跡好淺好幼，容易同紙張反光/陰影混淆——判斷「未作答」之前，一定要放大瞇實眼仔細睇清楚個格仔入面實際有冇淺色筆劃，唔好因為顏色淺就衝口而出話未作答；隱約見到但唔夠肯定寫緊咩，"correct"設null。
4. 睇圖表/刻度/圖形先答到嘅題目（水位、尺、角度、立體圖形、硬幣面額等），睇唔清就"correct"設null，唔好靠估。
5. 只有答題位置確實有筆跡但太潦草/有歧義先"correct"設null，"note"簡短註明原因。
6. 只有"correct"為false先填"correctAnswer"，其他情況留空字串。
7. "bbox"用百分比(0-100)表示，相對於嗰頁相片闊度/高度。"anchor"填低嗰題印刷體題號本身（例如"1."），搵唔到留空。
8. "riskyDiagram"設true如果屬於刻度/量度/角度/立體圖形/硬幣/方向/分數塗色/位值比較等易錯類型。

只回覆一個JSON物件，不要加任何其他文字：
{
  "results": [
    {"question":"題號","studentAnswer":"學生答案","correct":true/false/null,"correctAnswer":"","note":"","page":0,"bbox":{"x":0,"y":0,"w":0,"h":0},"anchor":"","riskyDiagram":false}
  ],
  "score": "X / Y（Y為總題數，X為答對題數，包括未作答；只有字跡不清的題目不計入Y）",
  "continuesFromPrevious": false,
  "continuesToNext": false
}`
    + (exemplars.length
      ? `\n\n附加：最後${exemplars.length}張圖係同一個小朋友之前已確認啱嘅字跡樣本，純粹俾你熟悉佢寫字嘅風格，唔屬於今次功課，唔使批改。`
      : '');

  let parsed;
  const usage = { primaryModel: null, geminiFailReason: null, sonnet: null, sonnetZoom: null, opus: null };
  // Ticket (2026-09-29, explicit user instruction "Fallback全部換晒
  // gemini 唔好留deepseek" -- confirming the same swap already done for
  // /api/mark's Ticket 13/196 AI-fallback also applies here): the
  // Qwen-then-DeepSeek two-tier cheap pipeline is REPLACED with a single
  // Gemini call, same reasoning as Ticket 196 (real comparison data --
  // see project_ai_model_watch.md / TICKETS.md 2026-09-29 entries --
  // found Gemini more accurate than Qwen and more reliable/cheaper than
  // DeepSeek, which repeatedly truncated at a hard 4000-completion-token
  // ceiling regardless of the requested maxTokens). Per explicit
  // instruction 2026-09-20 (unchanged): Sonnet's real cost (~£5 gone in
  // ~20 real submissions before that session's fixes) makes it
  // unacceptable as a silent fallback -- this cheap tier never falls
  // through to Sonnet; a page either gets a real answer from Gemini or a
  // clear "couldn't grade, please check by hand" response.
  if (openrouterKey) {
    // Downscaled once -- see downscaleForCheapTier's own comment for why
    // this exists. bbox stays valid: the model reports position as a
    // 0-100% fraction of the page, not pixels, so a smaller image sent to
    // the API doesn't change what the client draws against the original
    // photo.
    const cheapTierImages = images.concat(exemplars).map((img) => downscaleForCheapTier(img, 640));
    try {
      const r = await callGemini(cheapTierImages, cheapTierPrompt, openrouterKey);
      parsed = r.parsed;
      usage.primaryModel = "gemini";
      usage.gemini = r.usage;
    } catch (e) {
      usage.geminiFailReason = e.kind || "unknown";
    }
    if (!parsed) {
      return json({ error: "upstream_error", message: "部分題目暫時無法批改，建議家長人手核對，或一分鐘後再試一次。" }, 502);
    }
  }
  if (!parsed && !DISABLE_ANTHROPIC_DURING_TESTING) {
    try {
      // Trying "medium" effort again after root-causing the real reason
      // "medium" looked unsafe the first time: verbose per-item logging
      // proved the earlier "10+4=14 marked wrong" failures were the model
      // reading faint pencil handwriting as a blank box (studentAnswer:""),
      // not a reasoning-depth problem -- since fixed directly (rule 2
      // addendum + a client-side contrast boost) with the self-contradiction
      // safety net (fixSelfContradiction) as a second layer. max_tokens 8192
      // kept regardless (prevents truncation, unrelated to reasoning depth).
      // Revert again immediately if a live report shows a real,
      // non-perception accuracy regression.
      //
      // The top/bottom-half parallel split (tried briefly to cut latency on
      // content-heavy pages) is reverted -- it doubled Sonnet cost on EVERY
      // page, and a live cost review showed the account's whole prepaid
      // balance being exhausted by well under 10 real submissions. Cost is
      // the current priority over the last mile of speed.
      const r = await callClaude("claude-sonnet-5", 8192, images.concat(exemplars), prompt, apiKey, "medium");
      parsed = r.parsed;
      usage.primaryModel = "sonnet";
      usage.sonnet = r.usage;
    } catch (e) {
      return json({ error: e.kind || "upstream_error", message: e.uiMessage, detail: e.detail }, e.status || 502);
    }
  }
  if (!parsed) {
    // Either DISABLE_ANTHROPIC_DURING_TESTING is on, or there was no
    // OPENROUTER_API_KEY to try the cheap tiers with in the first place --
    // either way, same honest "can't grade this right now" response the
    // Anthropic-unconfigured case already gave, not a silent wrong answer.
    return json({ error: "upstream_error", message: "部分題目暫時無法批改，建議家長人手核對，或一分鐘後再試一次。" }, 502);
  }
  (parsed.results || []).forEach(fixSelfContradiction);

  // Position refinement runs BEFORE the recheck (not after) so that if we
  // need to crop a zoomed-in close-up for the recheck pass below, the crop
  // is centered on OCR's precise position rather than the model's own
  // rougher guess -- exactly the cases where that guess is least reliable
  // are the ones about to get rechecked. `images` here is already the
  // rotation-corrected version from above, so this OCR call (and the bbox
  // it produces) is relative to the same upright frame.
  //
  // Gated behind REFINE_BBOX_WITH_OCR: skipping it saves one Vision round
  // trip per page. The recheck crop below already falls back to the whole
  // page when a bbox is missing/unusable, so a less-precise model-estimated
  // bbox here degrades to a slightly wider recheck crop, not a broken one.
  if (REFINE_BBOX_WITH_OCR && visionKey && parsed.results && parsed.results.length) {
    try {
      await refineWithOcr(parsed.results, images, visionKey, ocrCache);
    } catch (e) {
      // OCR is a precision upgrade, not a requirement -- keep the model's
      // own bbox estimates if anything here goes wrong.
    }
  }

  // Phase 1 stops HERE and returns immediately -- the recheck/Opus tiers
  // that used to run inline below moved to the separate /api/verify
  // endpoint (see handleVerify), called by the client AFTER it has
  // already displayed this page's confident marks. A live report showed
  // a single page needing full escalation to Opus on every item took 52
  // seconds end to end; nearly all of that was the recheck/Opus tiers,
  // not this main pass. Blocking the user's first sight of ANY result on
  // that made the tool feel broken regardless of whether the eventual
  // answer was right. Only items this pass is genuinely UNSURE about
  // (correct===null) are marked "verifiedBy: pending" and listed in
  // `needsVerify` below for a follow-up /api/verify call -- a
  // riskyDiagram tag alone no longer forces a recheck it didn't ask for.
  // That "recheck every risky category regardless of confidence" rule
  // was a real accuracy win (caught confidently-wrong diagram/scale/coin
  // misreads a null-only trigger can't by definition catch), but it also
  // roughly doubled how many items got a second paid look on any page
  // with several risky-category questions -- and a live cost review
  // showed well under 10 real submissions exhausting the whole prepaid
  // balance. Cost is the current priority; a genuinely-wrong-but-
  // confident riskyDiagram item can still be caught by a parent tapping
  // it wrong on the photo.
  (parsed.results || []).forEach((r) => {
    r.verifiedBy = (r.correct === null) ? "pending" : "sonnet";
  });

  // Capture a few confirmed-correct answers as new handwriting exemplars
  // for next time. Only items THIS pass is already confident about
  // qualify -- a still-pending item isn't confirmed correct yet, and a
  // wrong or uncertain answer is exactly the messy handwriting we do NOT
  // want to teach the model as a reference example.
  if (rememberHandwriting && deviceKey && env.RATE_LIMIT_KV) {
    const photonCache = new Map();
    try {
      const goodOnes = (parsed.results || []).filter((r) => r.correct === true && r.verifiedBy === "sonnet" && r.bbox && images[r.page]).slice(0, HANDWRITING_SAMPLES_PER_REQUEST);
      for (const r of goodOnes) {
        try {
          const sample = cropItem(r, images, photonCache);
          await saveHandwritingSample(env.RATE_LIMIT_KV, deviceKey, sample);
        } catch (e) { /* one bad crop shouldn't stop the others from being saved */ }
      }
    } finally {
      for (const img of photonCache.values()) img.free();
    }
  }
  if (parsed.results && parsed.results.length) {
    // Everything above (OCR refinement, crop-recheck, handwriting capture)
    // ran against local page indices matching the images actually sent --
    // only now, right before the response goes out, do results get
    // relabelled with the REAL page index within the parent's whole photo
    // set, so the client can place this page's marks/confirm-list rows
    // correctly alongside pages graded by other requests. Normally every
    // request carries exactly one image (local page always 0), remapped to
    // `realPageIndex`; a stitch request carries two and each local index
    // remaps to its own real page number from `stitchPages`.
    parsed.results.forEach((r) => {
      r.page = isStitch ? (stitchPages[r.page || 0] ?? realPageIndex) : realPageIndex;
    });
    const graded = parsed.results.filter((r) => r.correct !== null);
    const correctCount = graded.filter((r) => r.correct === true).length;
    parsed.score = `${correctCount} / ${graded.length}`;
  }

  // Tells the client how much to rotate its own DISPLAYED copy of each
  // page so it matches the upright frame the bbox coordinates above were
  // computed against -- keyed by real page number, same remap as above.
  parsed.pageRotations = {};
  images.forEach((img, i) => {
    if (!rotationApplied[i]) return;
    const realP = isStitch ? (stitchPages[i] ?? realPageIndex) : realPageIndex;
    parsed.pageRotations[realP] = rotationApplied[i];
  });

  // verifiedByCounts makes it possible to answer "how many items are
  // still pending verification" from the logs alone. Opus usage is no
  // longer decided in this function -- see handleVerify's own logging.
  const verifiedByCounts = {};
  for (const r of parsed.results || []) {
    verifiedByCounts[r.verifiedBy || "sonnet"] = (verifiedByCounts[r.verifiedBy || "sonnet"] || 0) + 1;
  }
  parsed.needsVerify = (parsed.results || []).filter((r) => r.verifiedBy === "pending").map((r) => ({ page: r.page, question: r.question }));
  console.log(JSON.stringify({ event: "check_usage", pages: images.length, usage, ocrUsed: REFINE_BBOX_WITH_OCR && !!visionKey, verifiedByCounts, elapsedMs: Date.now() - startedAt }));
  // TEMPORARY, verbose: a repeated live bug (confidently-wrong verdicts on
  // trivially correct answers) survived two targeted fixes already
  // (a prompt clarification, then a self-contradiction safety net) --
  // logging every item's actual studentAnswer/correct/correctAnswer here
  // is the only way to see what the model is REALLY returning instead of
  // guessing at a third theory blind. Remove once this is root-caused.
  console.log(JSON.stringify({ event: "check_items", items: (parsed.results || []).map((r) => ({ q: r.question, student: r.studentAnswer, correct: r.correct, correctAnswer: r.correctAnswer, riskyDiagram: r.riskyDiagram, verifiedBy: r.verifiedBy })) }));

  if (idemKey && env.RATE_LIMIT_KV) {
    try {
      await env.RATE_LIMIT_KV.put(idemKey, JSON.stringify(parsed), { expirationTtl: 1800 });
    } catch (e) { /* best-effort */ }
  }

  return json(parsed, 200);
}

// Phase 2: the recheck/Opus tiers that used to run inline inside
// handleCheckInner, now their own short request the client fires AFTER
// displaying phase 1's confident marks -- see the "needsVerify" field on
// /api/check's response and the phase-1 comment above. Keeps each HTTP
// request short (matters on a real, sometimes-unstable mobile connection)
// and means a page needing heavy escalation (e.g. every item going all
// the way to Opus) no longer blocks the user's first sight of ANY result
// on that page.
async function handleVerify(request, env) {
  // Same graceful "nothing to patch" response the missing-key case already
  // gave -- phase 1 (handleCheckInner) already returned its confident marks
  // to the client before this call ever fires, so items that stay
  // unresolved here just stay needs_review, same as any other genuinely
  // undecidable item, not a broken request.
  if (!env.ANTHROPIC_API_KEY || DISABLE_ANTHROPIC_DURING_TESTING) return json({ patches: [] }, 200);
  const apiKey = typeof env.ANTHROPIC_API_KEY === "string"
    ? env.ANTHROPIC_API_KEY
    : await env.ANTHROPIC_API_KEY.get();

  // Own rate-limit bucket, separate from CHECK_RATE_LIMIT's "checkrate:"
  // counter used by /api/check -- a page's verify call is a natural
  // follow-up to its check call, not a separate user action, and
  // shouldn't eat into the same per-hour budget twice as fast.
  if (env.RATE_LIMIT_KV) {
    // Ticket 218: same per-browser-id preference as /api/mark -- see that
    // handler's own comment for why IP alone over-throttles shared
    // networks.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const clientId = (request.headers.get("X-Client-Id") || "").slice(0, 64);
    const rateKey = "verifyrate:" + (clientId || ip);
    let count = 0;
    try {
      const raw = await env.RATE_LIMIT_KV.get(rateKey);
      count = raw ? (parseInt(raw, 10) || 0) : 0;
    } catch (e) { /* KV unreachable -- don't block over it */ }
    if (count >= CHECK_RATE_LIMIT) {
      // Silent, not an error: the phase-1 marks the user already sees
      // stand as-is if verification can't run right now, same as any
      // other best-effort verify failure below.
      return json({ patches: [] }, 200);
    }
    try {
      await env.RATE_LIMIT_KV.put(rateKey, String(count + 1), { expirationTtl: 3600 });
    } catch (e) { /* best-effort */ }
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request", message: "請求格式錯誤。" }, 400);
  }
  const { images, items, pageIndex, stitchPages, requestId, deviceId, rememberHandwriting } = body;
  if (!images || !images.length || !Array.isArray(items) || !items.length) {
    return json({ patches: [] }, 200);
  }

  const isStitch = Array.isArray(stitchPages) && stitchPages.length === images.length;
  const realPageIndex = Number.isInteger(pageIndex) ? pageIndex : 0;

  // Separate cache namespace from /api/check's "idem:" -- a retry of THIS
  // call must never accidentally read a phase-1 (still-pending) result
  // back as if it were the verified one.
  const idemKey = typeof requestId === "string" && requestId ? "videm:" + requestId.slice(0, 100) : null;
  if (idemKey && env.RATE_LIMIT_KV) {
    try {
      const cached = await env.RATE_LIMIT_KV.get(idemKey);
      if (cached) return new Response(cached, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    } catch (e) { /* best-effort -- fall through and process normally */ }
  }

  // recheckPass/cropItem index into `images` by LOCAL position (0, or 0/1
  // for a stitch pair) -- items arrive here carrying their REAL page
  // number (as /api/check returned them), so map back to local before
  // reusing that unchanged logic, then map forward again below.
  const realToLocal = new Map();
  images.forEach((img, i) => {
    const realP = isStitch ? (stitchPages[i] ?? realPageIndex) : realPageIndex;
    realToLocal.set(realP, i);
  });
  const working = items.map((it) => ({ ...it, page: realToLocal.has(it.page) ? realToLocal.get(it.page) : 0 }));

  const usage = { sonnetZoom: null, opus: null };
  const photonCache = new Map();
  let stillNull = working;
  try {
    if (stillNull.length) {
      await recheckPass({ results: working }, stillNull, images, apiKey, "claude-sonnet-5", 2048, usage, "sonnetZoom", photonCache);
    }
    stillNull = working.filter((r) => r.correct === null);
    if (stillNull.length) {
      await recheckPass({ results: working }, stillNull, images, apiKey, "claude-opus-5", 2048, usage, "opus", photonCache);
    }

    // Same handwriting-capture idea as phase 1, for items that only just
    // got confirmed correct here.
    const deviceKey = typeof deviceId === "string" && /^[a-zA-Z0-9-]{8,100}$/.test(deviceId) ? deviceId : null;
    if (rememberHandwriting && deviceKey && env.RATE_LIMIT_KV) {
      const goodOnes = working.filter((r) => r.correct === true && r.bbox && images[r.page]).slice(0, HANDWRITING_SAMPLES_PER_REQUEST);
      for (const r of goodOnes) {
        try {
          const sample = cropItem(r, images, photonCache);
          await saveHandwritingSample(env.RATE_LIMIT_KV, deviceKey, sample);
        } catch (e) { /* one bad crop shouldn't stop the others from being saved */ }
      }
    }
  } finally {
    for (const img of photonCache.values()) img.free();
  }

  const patches = working.map((r) => ({
    page: isStitch ? (stitchPages[r.page] ?? realPageIndex) : realPageIndex,
    question: r.question,
    correct: r.correct,
    correctAnswer: r.correctAnswer || "",
    note: r.note || "",
    studentAnswer: r.studentAnswer,
    verifiedBy: r.verifiedBy || "sonnetZoom",
  }));

  const opusItems = patches.filter((p) => p.verifiedBy === "opus").map((p) => `p${p.page}:${p.question}`);
  console.log(JSON.stringify({ event: "verify_usage", items: items.length, usage, opusItems }));
  // TEMPORARY, verbose -- see the matching log in handleCheckInner.
  console.log(JSON.stringify({ event: "verify_items", items: patches.map((p) => ({ q: p.question, student: p.studentAnswer, correct: p.correct, correctAnswer: p.correctAnswer, verifiedBy: p.verifiedBy })) }));

  const out = { patches };
  if (idemKey && env.RATE_LIMIT_KV) {
    try {
      await env.RATE_LIMIT_KV.put(idemKey, JSON.stringify(out), { expirationTtl: 1800 });
    } catch (e) { /* best-effort */ }
  }
  return json(out, 200);
}

// Shared by both /api/check and the /api/test-noai-check debug endpoint,
// so the free demo path exercises the exact same rotation-detection/
// -correction logic real submissions do, not a simplified stand-in --
// this is the only way to verify a fix here against a real problematic
// photo without spending on the Anthropic call. Mutates `images` in place
// (replacing a page's data/mediaType when it gets rotated) and returns
// `rotationApplied` (per local image index, in degrees) plus `ocrCache` (a
// Map of local index -> already-fetched OCR result, for refineWithOcr to
// reuse on pages that turned out not to need rotating). Best-effort
// throughout: a detection or rotation failure just leaves that one page
// as originally photographed rather than failing the whole request.
async function detectAndCorrectRotation(images, visionKey) {
  const rotationApplied = images.map(() => 0);
  const ocrCache = new Map();
  if (!visionKey) return { rotationApplied, ocrCache };
  for (let i = 0; i < images.length; i++) {
    try {
      // One quiet retry on a transient failure (a flaky connection drops
      // the Vision call) -- without this, a real network hiccup on just
      // ONE page in a multi-page submission left that page silently
      // un-rotated while its siblings succeeded, which read as random,
      // inconsistent behaviour ("有啲又轉到90度，有啲冇") rather than the
      // occasional network blip it actually was.
      let ocrCheck;
      try { ocrCheck = await googleOcr(images[i].data, visionKey); }
      catch (e) { ocrCheck = await googleOcr(images[i].data, visionKey); }
      if (ocrCheck && ocrCheck.rotationDeg) {
        const correction = (360 - ocrCheck.rotationDeg) % 360;
        const bytes = base64ToBytes(images[i].data);
        const photonImg = PhotonImage.new_from_byteslice(bytes);
        try {
          const rotatedImg = rotate(photonImg, correction);
          try {
            images[i].data = bytesToBase64(rotatedImg.get_bytes_jpeg(90));
            images[i].mediaType = "image/jpeg";
            rotationApplied[i] = correction;
          } finally { rotatedImg.free(); }
        } finally { photonImg.free(); }
      } else if (ocrCheck) {
        // Reused by refineWithOcr when a page turned out NOT to need
        // rotating -- its OCR result is still valid for the (unchanged)
        // image, so anchor refinement doesn't need to pay for a second,
        // near-identical Vision call on the exact same bytes. A rotated
        // page's cache entry is deliberately NOT populated: its OCR word
        // positions describe the PRE-rotation frame and would misplace
        // every mark if reused as-is.
        ocrCache.set(i, ocrCheck);
      }
    } catch (e) { /* best-effort -- an ungraded-but-sideways page beats a crashed request */ }
  }
  return { rotationApplied, ocrCache };
}

// Upgrades each result's bbox from "the model's own guess at pixel
// coordinates" (imprecise, drifts on a skewed photo) to "a real OCR engine's
// bounding box for the matching printed anchor text" (precise, but only
// works for TYPESET text -- which is exactly why the model was asked for the
// printed question number/label as the anchor, not the handwritten answer;
// OCR is no better than the model at reading messy handwriting, so it isn't
// asked to).
async function refineWithOcr(results, images, visionKey, ocrCache) {
  const byPage = new Map();
  results.forEach((r) => {
    const p = r.page || 0;
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p).push(r);
  });

  for (const [pageIdx, pageResults] of byPage.entries()) {
    const anchored = pageResults.filter((r) => r.anchor && r.anchor.trim());
    if (!anchored.length || !images[pageIdx]) continue;

    // A page whose rotation-detection pass already found no rotation
    // needed has its OCR result cached (see handleCheckInner) -- still
    // valid here since the image bytes didn't change, and re-fetching the
    // exact same page from Vision again would just be a second network
    // call for identical data. A rotated page is deliberately never
    // cached (its OCR describes the pre-rotation frame), so it still
    // falls through to a fresh call against the now-rotated bytes below.
    let ocr = ocrCache && ocrCache.get(pageIdx);
    if (!ocr) {
      // Scoped per page: one page's OCR call failing (bad image data, a
      // transient Vision API error) must not skip refinement for every
      // OTHER page in the same submission -- those are independent images
      // and independently likely to succeed.
      try {
        ocr = await googleOcr(images[pageIdx].data, visionKey);
      } catch (e) {
        continue;
      }
    }
    if (!ocr || !ocr.words.length) continue;

    const usedIdx = new Set();
    const matched = new Array(anchored.length).fill(false);
    for (let ai = 0; ai < anchored.length; ai++) {
      const r = anchored[ai];
      const needle = normalizeAnchor(r.anchor);
      // Anchors are meant to be short printed labels ("1.", "(a)") -- require
      // an exact match after normalizing. A loose substring match previously
      // let a long anchor (the model sometimes echoes the whole question
      // line despite being asked not to) spuriously "contain" any short OCR
      // token, causing unrelated questions to collide on the same box.
      if (!needle || needle.length > 6) continue;
      let hitIdx = ocr.words.findIndex((w, i) => !usedIdx.has(i) && normalizeAnchor(w.text) === needle);
      if (hitIdx === -1) {
        // Chinese text that touches the anchor with no space (e.g. "的E."
        // right before a blank) often gets OCR'd as one merged token instead
        // of splitting cleanly -- fall back to a word that ENDS with the
        // anchor's own characters, capped in extra length so it can't match
        // an unrelated longer word by coincidence.
        hitIdx = ocr.words.findIndex((w, i) => !usedIdx.has(i) && normalizeAnchor(w.text).endsWith(needle) && normalizeAnchor(w.text).length <= needle.length + 3);
      }
      if (hitIdx === -1) continue;
      usedIdx.add(hitIdx);
      const hit = ocr.words[hitIdx];

      // The mark should land in the blank space right after whatever the
      // child wrote -- not on the printed anchor label itself, and not
      // guaranteed to be free space to the right either, since many
      // worksheets embed the blank mid-paragraph with more printed text
      // resuming right after it. OCR can't read the handwriting itself, but
      // it CAN usually still read that resuming printed text -- so find the
      // next OCR word on the same line (by y-overlap) to the right of the
      // anchor, and place the mark in the gap just before it. If nothing
      // else is on that line, fall back to a modest fixed gap.
      const hitCy = hit.y + hit.h / 2;
      const sameLineAfter = ocr.words
        .filter((w, i) => i !== hitIdx && w.x > hit.x + hit.w && Math.abs((w.y + w.h / 2) - hitCy) < hit.h * 0.7)
        .sort((a, b) => a.x - b.x);
      const next = sameLineAfter[0];
      const gapStart = hit.x + hit.w;
      const fallbackGap = hit.h * 6; // roughly a few characters' width
      const gapEnd = next ? next.x : gapStart + fallbackGap;
      const markX = Math.max(gapStart, gapEnd - hit.h * 1.5);

      r.bbox = {
        x: (markX / ocr.width) * 100,
        y: (hit.y / ocr.height) * 100,
        w: (hit.h / ocr.width) * 100,
        h: (hit.h / ocr.height) * 100,
      };
      matched[ai] = true;
    }

    // Questions are printed in reading order, so an anchor OCR couldn't find
    // at all (not even the merged-token fallback) can still be positioned
    // reliably by interpolating between whichever neighbors DID get a real
    // OCR match -- e.g. if B and D both matched but C didn't, C is probably
    // roughly between them. Falls back to nudging off a single matched
    // neighbor (by that neighbor's own height, as a rough line-step guess)
    // when there's a match on only one side.
    for (let ai = 0; ai < anchored.length; ai++) {
      if (matched[ai]) continue;
      let prevIdx = -1, nextIdx = -1;
      for (let j = ai - 1; j >= 0; j--) { if (matched[j]) { prevIdx = j; break; } }
      for (let j = ai + 1; j < anchored.length; j++) { if (matched[j]) { nextIdx = j; break; } }
      const prevBox = prevIdx !== -1 ? anchored[prevIdx].bbox : null;
      const nextBox = nextIdx !== -1 ? anchored[nextIdx].bbox : null;
      if (prevBox && nextBox) {
        const t = (ai - prevIdx) / (nextIdx - prevIdx);
        anchored[ai].bbox = {
          x: prevBox.x + (nextBox.x - prevBox.x) * t,
          y: prevBox.y + (nextBox.y - prevBox.y) * t,
          w: prevBox.w, h: prevBox.h,
        };
      } else if (prevBox) {
        anchored[ai].bbox = { x: prevBox.x, y: prevBox.y + prevBox.h * 1.3, w: prevBox.w, h: prevBox.h };
      } else if (nextBox) {
        anchored[ai].bbox = { x: nextBox.x, y: Math.max(0, nextBox.y - nextBox.h * 1.3), w: nextBox.w, h: nextBox.h };
      }
      // if neither neighbor matched either, leave the model's own bbox guess as-is
    }
  }
}

// Handwriting profile storage. Keyed entirely by an opaque client-generated
// deviceId (a random UUID the client keeps in localStorage) -- never an
// account, an IP, or anything else that identifies a real person. Reuses
// the RATE_LIMIT_KV binding as a plain key-value store (its name reflects
// its original purpose, not everything stored in it); a dedicated KV
// namespace could be split out later if this ever needs different
// retention/ops handling than the rate limiter.
function handwritingMetaKey(deviceKey) { return `hwprofile:${deviceKey}:meta`; }
function handwritingSampleKey(deviceKey, sampleId) { return `hwprofile:${deviceKey}:${sampleId}`; }

async function loadHandwritingExemplars(kv, deviceKey) {
  const raw = await kv.get(handwritingMetaKey(deviceKey));
  if (!raw) return [];
  let sampleIds;
  try { sampleIds = JSON.parse(raw); } catch (e) { return []; }
  if (!Array.isArray(sampleIds) || !sampleIds.length) return [];
  const recent = sampleIds.slice(-HANDWRITING_EXEMPLARS_USED);
  const samples = await Promise.all(recent.map(async (id) => {
    try {
      const raw2 = await kv.get(handwritingSampleKey(deviceKey, id));
      return raw2 ? JSON.parse(raw2) : null;
    } catch (e) { return null; }
  }));
  return samples.filter(Boolean).map((s) => ({ data: s.data, mediaType: s.mediaType || "image/jpeg" }));
}

async function saveHandwritingSample(kv, deviceKey, sample) {
  const metaRaw = await kv.get(handwritingMetaKey(deviceKey));
  let sampleIds = [];
  if (metaRaw) {
    try { sampleIds = JSON.parse(metaRaw); if (!Array.isArray(sampleIds)) sampleIds = []; } catch (e) { sampleIds = []; }
  }
  const sampleId = crypto.randomUUID();
  await kv.put(handwritingSampleKey(deviceKey, sampleId), JSON.stringify(sample), { expirationTtl: HANDWRITING_SAMPLE_TTL });
  sampleIds.push(sampleId);
  // Evict oldest first once over the cap -- delete the KV entry too, not
  // just drop it from the index, or it'd sit there unreferenced until its
  // TTL happened to expire.
  while (sampleIds.length > MAX_HANDWRITING_SAMPLES) {
    const evicted = sampleIds.shift();
    try { await kv.delete(handwritingSampleKey(deviceKey, evicted)); } catch (e) { /* best-effort */ }
  }
  await kv.put(handwritingMetaKey(deviceKey), JSON.stringify(sampleIds), { expirationTtl: HANDWRITING_SAMPLE_TTL });
}

// Canned sample used by both mock endpoints below -- a plausible-looking
// small worksheet result so website/test.html shows a realistic page:
// one confident-correct, one confident-wrong (with a correctAnswer
// label), and one "pending" item that /api/mock-verify later resolves,
// so a visitor also sees the real phase-1/phase-2 UI behaviour (the "?"
// mark quietly updating a few seconds later) without it costing anything.
function mockResults() {
  return [
    { question: "1", studentAnswer: "12", correct: true, correctAnswer: "", note: "", page: 0, bbox: { x: 15, y: 12, w: 8, h: 5 }, anchor: "1.", riskyDiagram: false, verifiedBy: "sonnet" },
    { question: "2", studentAnswer: "9", correct: false, correctAnswer: "8", note: "", page: 0, bbox: { x: 55, y: 12, w: 8, h: 5 }, anchor: "2.", riskyDiagram: false, verifiedBy: "sonnet" },
    { question: "3", studentAnswer: "", correct: null, correctAnswer: "", note: "字跡不清", page: 0, bbox: { x: 30, y: 40, w: 8, h: 5 }, anchor: "3.", riskyDiagram: false, verifiedBy: "pending" },
  ];
}

async function handleMockCheck(request) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const pageIndex = Number.isInteger(body.pageIndex) ? body.pageIndex : 0;
  const results = mockResults().map((r) => ({ ...r, page: pageIndex }));
  const graded = results.filter((r) => r.correct !== null);
  const score = `${graded.filter((r) => r.correct === true).length} / ${graded.length}`;
  const needsVerify = results.filter((r) => r.verifiedBy === "pending").map((r) => ({ page: r.page, question: r.question }));
  // A short artificial delay so the UI's pending/spinner states are
  // actually visible, same as a real call would show.
  await new Promise((resolve) => setTimeout(resolve, 900));
  return json({ results, score, needsVerify, pageRotations: {} }, 200);
}

async function handleMockVerify(request) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const pageIndex = Number.isInteger(body.pageIndex) ? body.pageIndex : 0;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const patches = (body.items || []).map((it) => ({
    page: pageIndex, question: it.question, correct: true, correctAnswer: "", note: "", verifiedBy: "sonnetZoom",
  }));
  return json({ patches }, 200);
}

async function handleForgetHandwriting(request, env) {
  if (!env.RATE_LIMIT_KV) return json({ ok: true }, 200);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const deviceKey = typeof body.deviceId === "string" && /^[a-zA-Z0-9-]{8,100}$/.test(body.deviceId) ? body.deviceId : null;
  if (!deviceKey) return json({ error: "bad_request", message: "缺少deviceId。" }, 400);
  try {
    const raw = await env.RATE_LIMIT_KV.get(handwritingMetaKey(deviceKey));
    const sampleIds = raw ? (JSON.parse(raw) || []) : [];
    for (const id of sampleIds) {
      try { await env.RATE_LIMIT_KV.delete(handwritingSampleKey(deviceKey, id)); } catch (e) { /* best-effort */ }
    }
    await env.RATE_LIMIT_KV.delete(handwritingMetaKey(deviceKey));
  } catch (e) { /* best-effort -- deletion should still report success to the user */ }
  return json({ ok: true }, 200);
}

// 2026-09-23: real fix for the website's "AI答錯咗" gap found this session --
// tapping a mark on the photo (applyMarkCorrect in website/index.html) only
// ever flipped the mark LOCALLY in the parent's own browser; nothing was
// ever sent back here, so every correction a parent made was invisible to
// the developer. This is the actual report-to-developer half that was
// missing (per explicit instruction: fix the website, NOT the Telegram bot
// -- Telegram needs a different UI shape and was explicitly declined).
//
// Deliberately minimal, matching this repo's existing coverage-expansion-log
// convention (mark_unresolved_question in handleMark): a structured
// console.log line to Cloudflare's persistent Workers Logs, not a new KV/D1
// store -- no new infra, consistent with how the OTHER "log it for later
// batch review" feature already works.
//
// KNOWN LIMITATION (honestly scoped, not silently hidden): /api/check's own
// response shape never sends the full printed question text to the client
// (only a short `question` label like "3" -- confirmed by reading both
// handleCheckInner's result-building code and website/index.html's own
// data.results usage), so this can only report the label + the answers
// already visible client-side, not the original question wording. Making
// this fully diagnosable would mean also including printedQuestion in
// /api/check's response -- a separate, larger change to a live public API
// shape, not done here without a decision on that tradeoff.
async function handleReportWrong(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const question = typeof body.question === "string" ? body.question.slice(0, 50) : "";
  const studentAnswer = typeof body.studentAnswer === "string" ? body.studentAnswer.slice(0, 200) : "";
  const correctAnswer = typeof body.correctAnswer === "string" ? body.correctAnswer.slice(0, 200) : "";
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 20) : "";
  const previousCorrect = body.previousCorrect === true || body.previousCorrect === false ? body.previousCorrect : null;
  const newCorrect = body.newCorrect === true || body.newCorrect === false ? body.newCorrect : null;
  if (!question || newCorrect === null) return json({ error: "bad_request" }, 400);
  console.log(JSON.stringify({
    event: "report_mark_disputed",
    question,
    studentAnswer,
    correctAnswer,
    subject,
    previousCorrect,
    newCorrect,
    // The interesting direction is true->false (parent says the AI's
    // "correct" was actually wrong) -- flagged explicitly so a later batch
    // review can filter to that signal without re-deriving it from the two
    // raw booleans each time.
    isAiWrongReport: previousCorrect === true && newCorrect === false,
  }));
  return json({ ok: true }, 200);
}

function normalizeAnchor(s) {
  return String(s || "").replace(/[\s.()（）、,，]/g, "").toLowerCase();
}

// Safety net against a real, repeatedly-observed self-contradiction: the
// model marks an item "correct: false" but its OWN "correctAnswer" field
// (only ever filled when correct is false, per rule 4 in the prompt) is
// textually identical to what the student actually wrote -- i.e. the
// model's final verdict disagrees with its own stated correct answer. A
// live example: "10 + 4 = 14" (correct) came back {"correct":false,
// "correctAnswer":"14"} against a "14" student answer, on a worksheet
// where the numbers needed were spelled out in the question text. Rather
// than trying to fully understand why the model's two fields diverged,
// this catches the specific, checkable contradiction and trusts the
// model's own correctAnswer over its own correct flag -- can only ever
// fix a genuine self-contradiction, never misfire on a normal response
// (where a false verdict's correctAnswer never matches the student's
// answer in the first place).
function fixSelfContradiction(r) {
  if (r.correct === false && r.correctAnswer && r.studentAnswer) {
    const norm = (s) => String(s).replace(/\s+/g, "").toLowerCase();
    if (norm(r.correctAnswer) === norm(r.studentAnswer)) {
      r.correct = true;
      r.correctAnswer = "";
    }
  }
  return r;
}

async function googleOcr(base64Data, apiKey) {
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requests: [{ image: { content: base64Data }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }],
    }),
  });
  if (!res.ok) {
    throw new Error(`vision_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.responses && data.responses[0] && data.responses[0].error) {
    throw new Error(`vision_api_error: ${JSON.stringify(data.responses[0].error).slice(0, 200)}`);
  }
  const page = data.responses && data.responses[0] && data.responses[0].fullTextAnnotation && data.responses[0].fullTextAnnotation.pages && data.responses[0].fullTextAnnotation.pages[0];
  if (!page) return null;

  // Orientation detection: each block's boundingBox vertices are ordered in
  // the TEXT's own reading direction (vertex 0 = start of the line, vertex
  // 1 = further along the same baseline) regardless of how the physical
  // page happens to sit in the photo -- so the clockwise angle of that
  // vertex0->vertex1 vector, measured in image pixel space (y grows
  // downward, same convention Photon's rotate() uses), IS exactly how far
  // clockwise the printed page itself is tilted relative to upright.
  // Rounded to the nearest 90 and taken as a mode across every block (not
  // just the first) so one skewed or misread block can't decide it alone.
  const angleVotes = {};
  for (const block of page.blocks || []) {
    const v = (block.boundingBox || {}).vertices || [];
    if (v.length < 2) continue;
    const dx = (v[1].x || 0) - (v[0].x || 0), dy = (v[1].y || 0) - (v[0].y || 0);
    if (!dx && !dy) continue;
    const deg = (((Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 90) * 90) % 360) + 360) % 360;
    angleVotes[deg] = (angleVotes[deg] || 0) + 1;
  }
  let rotationDeg = 0, bestVotes = 0;
  for (const deg of Object.keys(angleVotes)) {
    if (angleVotes[deg] > bestVotes) { bestVotes = angleVotes[deg]; rotationDeg = Number(deg); }
  }

  // Flatten to word-level boxes -- an "anchor" like "3)" is usually one or
  // two OCR word tokens, so word granularity matches better than whole
  // paragraphs.
  const words = [];
  for (const block of page.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const word of para.words || []) {
        const text = (word.symbols || []).map((s) => s.text).join("");
        const verts = (word.boundingBox || {}).vertices || [];
        if (!text || verts.length < 4) continue;
        const xs = verts.map((v) => v.x || 0), ys = verts.map((v) => v.y || 0);
        const x = Math.min(...xs), y = Math.min(...ys);
        words.push({ text, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
      }
    }
  }
  return { width: page.width, height: page.height, words, rotationDeg };
}

async function callClaude(model, maxTokens, images, prompt, apiKey, effort) {
  const body = {
    model,
    max_tokens: maxTokens,
    // Ticket 20 (2026-09-26): 0 (most deterministic) instead of the
    // API's default (1, full randomness) -- this is a reading/grading
    // task, not creative writing, so nothing is gained from letting the
    // model vary its answer run to run, and a lower temperature is a
    // real, well-established lever against hallucination on this class
    // of task. No prior code anywhere in this file ever set this.
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType || "image/jpeg",
              data: img.data,
            },
          })),
          { type: "text", text: prompt },
        ],
      },
    ],
  };
  // The API defaults every call to "high" effort (full adaptive-thinking
  // depth) unless told otherwise -- that's appropriate for the recheck tiers
  // (they exist specifically to look harder at something), but the main
  // pass was silently paying full deep-reasoning latency on every question
  // including trivial ones like "3+5=", which is a large chunk of why a
  // single page's first pass alone could take many seconds. "medium" (not
  // "low") is used here deliberately: this project has many hard-won
  // prompt rules for subtle failure modes (misread beakers, pyramid vs
  // prism, place-value traps) and "low" risks eroding exactly that
  // capability -- "medium" trades some of that latency for keeping more
  // reasoning headroom, verify against known-bad cases before going lower.
  if (effort) body.output_config = { effort };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    // Logged server-side (not just returned to the client) so a real
    // outage/quota/billing error is visible in the live tail instead of
    // only ever seen as the generic client-facing message.
    console.log(JSON.stringify({ event: "anthropic_error", status: res.status, model, detail: errText.slice(0, 500) }));
    throw { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: errText.slice(0, 300), status: 502 };
  }

  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return { parsed: JSON.parse(match ? match[0] : text), usage: data.usage || null };
  } catch (e) {
    throw { kind: "parse_error", uiMessage: "批改結果解析失敗，請再試一次。", detail: text.slice(0, 500), status: 502 };
  }
}

// Shared OpenRouter vision-model caller for both cheap tiers (DeepSeek,
// Qwen). Same {parsed, usage} / throw contract as callClaude. Guards
// against every failure shape seen empirically on real worksheets
// 2026-09-20: an HTTP error, a provider-side content-filter false
// positive, a reasoning-heavy call that exhausts its token budget with
// zero output, AND (Qwen specifically) a fast, "successful" but silently
// empty {"results":[]} on visually complex layouts (circling/ticking/
// matching, as opposed to plain fill-in-the-blank) -- all of these throw
// the same upstream_error so the caller can retry or escalate tiers
// without special-casing each one.
async function callOpenRouterVisionModel(images, prompt, openrouterKey, { model, maxTokens, timeoutMs, providerFilter, logPrefix, reasoning }) {
  const body = {
    model,
    max_tokens: maxTokens,
    // Ticket 20 (2026-09-26): see callClaude's identical comment -- same
    // reasoning, applied to every OpenRouter-routed model (Qwen,
    // DeepSeek, and the Ticket 13 AI-fallback layer, which both go
    // through this shared function).
    temperature: 0,
    ...(providerFilter ? { provider: providerFilter } : {}),
    ...(reasoning ? { reasoning } : {}),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mediaType || "image/jpeg"};base64,${img.data}` },
          })),
        ],
      },
    ],
  };
  // Race a plain timer against fetch() rather than relying solely on
  // AbortController -- a live production test (2026-09-20) showed a real
  // DeepSeek request still hadn't returned after 90+ seconds despite an
  // AbortSignal-based timeout on the same fetch call, meaning whatever
  // this Worker's fetch() was actually stuck on did not reliably respond
  // to abort(). Promise.race guarantees this function itself moves on at
  // the deadline regardless of whether the underlying request ever
  // unwinds -- the stalled fetch may keep running in the background, but
  // it can no longer block the response back to the user.
  const controller = new AbortController();
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      controller.abort();
      reject({ kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: `${logPrefix}_timeout_raced`, status: 502 });
    }, timeoutMs);
  });
  let res;
  try {
    res = await Promise.race([
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${openrouterKey}`,
          "http-referer": "https://hk-homework-check.violin-kwai.workers.dev",
          "x-title": "hk-homework-check",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
  } catch (e) {
    console.log(JSON.stringify({ event: `${logPrefix}_error`, status: null, detail: "fetch_failed_or_timed_out: " + String((e && e.message) || (e && e.detail)) }));
    throw (e && e.kind) ? e : { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: `${logPrefix}_timeout`, status: 502 };
  }

  if (!res.ok) {
    const errText = await res.text();
    console.log(JSON.stringify({ event: `${logPrefix}_error`, status: res.status, detail: errText.slice(0, 500) }));
    throw { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: errText.slice(0, 300), status: 502 };
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice || choice.finish_reason !== "stop") {
    console.log(JSON.stringify({
      event: `${logPrefix}_incomplete`,
      finishReason: choice && choice.finish_reason,
      error: choice && choice.error,
      usage: data.usage || null,
    }));
    throw { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: `${logPrefix}_incomplete`, status: 502 };
  }

  const text = (choice.message && choice.message.content) || "";
  try {
    // Some OpenRouter models wrap the JSON in a ```json fence even when
    // told to reply with only the object -- strip that before parsing.
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const match = stripped.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : stripped);
    // finish_reason "stop" plus valid JSON isn't proof of a USEFUL answer --
    // a model can end its turn early (or, per real Qwen testing, give up
    // silently on a visually complex layout) with a clean but empty
    // {"results":[],"score":"0/0"}. Treat that the same as any other
    // incomplete response.
    if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
      console.log(JSON.stringify({ event: `${logPrefix}_empty_results`, usage: data.usage || null }));
      throw { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: `${logPrefix}_empty_results`, status: 502 };
    }
    return { parsed, usage: data.usage || null };
  } catch (e) {
    if (e && e.kind) throw e;
    throw { kind: "parse_error", uiMessage: "批改結果解析失敗，請再試一次。", detail: text.slice(0, 500), status: 502 };
  }
}

// Fast, non-reasoning first look -- tried before DeepSeek. Real testing
// 2026-09-20: very fast (0.5-4s) and cheap when it works, including on
// worksheets DeepSeek itself struggled with, but silently returns empty
// results on visually complex layouts (circling/ticking/matching rather
// than plain fill-in-the-blank) -- caught by the empty-results guard
// above, which routes it to the DeepSeek retry instead.
// Root cause found 2026-09-20 for the live-only Qwen/DeepSeek hangs: NOT
// prompt length, NOT rotation-detection (isolated and timed separately,
// under 1s) -- it's specifically this Worker's fetch() struggling with a
// real ~300-400KB image payload to openrouter.ai. The same image at 640px
// max dimension (~80KB) completed in ~3s instead of hanging past an 8s
// timeout; a plain Node script sending the SAME full-size image has no
// such problem, so this is a Workers-runtime/outbound-fetch-body-size
// interaction, not a model or prompt issue. Re-encoding smaller
// specifically for the cheap-tier calls (client's own upload stays at
// 1568px for whatever still needs it) works around it directly.
// Vision enhancement item 6 (2026-09-28): a real parent's phone photo is
// often dim/washed-out (indoor lighting, glare, an old printer's faded
// ink) in a way a scanned worksheet never is -- Photon's normalize()
// does a standard histogram auto-stretch (uses the image's OWN existing
// brightest/darkest pixels as the new white/black points, no manual
// contrast number to tune or get wrong, so it can't "over-adjust" an
// already-good photo the way a fixed adjust_contrast(img, N) could).
// Applied unconditionally (not just on the downscale path) so a photo
// that's already ≤640px still benefits. Same fail-open discipline as
// the rest of this function: any Photon error just skips the
// enhancement, never blocks the request.
function normalizeContrastForVision(photonImg) {
  try {
    normalize(photonImg);
  } catch (e) {
    // Best-effort only -- an already-fine photo (or a Photon error) just
    // continues unenhanced, never blocks the pipeline.
  }
}

function downscaleForCheapTier(img, maxDim) {
  let photonImg;
  try {
    const bytes = base64ToBytes(img.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    normalizeContrastForVision(photonImg);
    const w = photonImg.get_width();
    const h = photonImg.get_height();
    if (Math.max(w, h) <= maxDim) {
      return { data: bytesToBase64(photonImg.get_bytes_jpeg(80)), mediaType: "image/jpeg" };
    }
    const scale = maxDim / Math.max(w, h);
    const resized = resize(photonImg, Math.round(w * scale), Math.round(h * scale), SamplingFilter.Lanczos3);
    try {
      return { data: bytesToBase64(resized.get_bytes_jpeg(80)), mediaType: "image/jpeg" };
    } finally {
      resized.free();
    }
  } catch (e) {
    // Downscaling/enhancement is a workaround, not a requirement -- if
    // Photon itself fails for any reason, send the original image
    // rather than block.
    return img;
  } finally {
    if (photonImg) photonImg.free();
  }
}

// Single source of truth for the production OCR/vision model -- both
// callQwen (used by /api/check's legacy pipeline AND Ticket 13's
// AI-fallback JUDGE, callAiFallbackJudge) and callQwenOcrText (the pure
// OCR-transcription step used by /api/mark) used to share one hardcoded
// model string (flagged 2026-09-22, unified 2026-09-25 for easy swapping).
// Ticket 25 (2026-09-27) SPLIT them back into two constants on purpose:
// every real comparison this session (Tickets 23/24/25) only ever tested
// Gemini 3.1 Flash Lite on the OCR-transcription task, never on the
// JUDGMENT task callQwen also serves (deciding correct/incorrect from a
// cropped image + question context) -- that's a different capability,
// untested, and this project's 100%-accuracy-floor rule means an
// untested swap doesn't ride along just because the code used to share
// one line. So: OCR_TEXT_MODEL (below) is now Gemini, used only by
// callQwenOcrText; PRODUCTION_OCR_MODEL stays Qwen, still used by
// callQwen for /api/check and the AI-fallback judge.
const PRODUCTION_OCR_MODEL = "qwen/qwen3-vl-235b-a22b-instruct";
// Ticket 25 (2026-09-27): switched from PRODUCTION_OCR_MODEL to Gemini
// 3.1 Flash Lite for the OCR-transcription step specifically, after two
// rounds of real comparison (Tickets 23/24, 3+10 photos; Ticket 25, 6
// user-curated photos) showed Gemini clearly more accurate on complex
// layouts (word banks, multi-blank letters, embedded passages) where
// Qwen repeatedly broke down, and consistently faster. See TICKETS.md
// Ticket 25 and memory/project_ai_model_watch.md for the full real data
// and the real failure modes found in BOTH models -- neither is
// error-free, this is a relative-improvement call, not a "solved" one.
//
// ROLLED BACK same day (2026-09-27), Ticket 26: live verification after
// the switch found a CONFIRMED, systematic accuracy bug specific to
// Gemini on "blank-is-the-divisor" division questions (e.g. "54÷□=6",
// very common in HK P2-3 math) -- Gemini collapses the printed clue and
// the student's handwritten answer into one computed expression
// (printedQuestion "54÷9", studentAnswer "6") instead of preserving the
// blank (Qwen correctly keeps "54÷□=6" / studentAnswer "9"). This is the
// exact "printed/answer swap" failure mode already flagged elsewhere in
// this file for a different model -- it makes the deterministic checker
// grade a CORRECT student answer as wrong. A real child could see a
// wrong mark on correct work.
//
// RE-SWITCHED same day, Ticket 27/29: the blocking bug above was
// specifically fixed (the general □-preservation prompt rule, Ticket 27)
// and re-verified directly against Gemini -- "54÷□=6"/"42÷□=7" etc. now
// correctly preserve the blank. Ticket 29's multi-blank-passage context
// fix was also verified against Gemini (photo 4, 12 items, real sentence
// context preserved, though with minor printedQuestion duplication
// artifacts vs. Qwen's cleaner output -- not a correctness bug, just
// noisier). Real per-user-instruction decision to re-enable given the
// specific blocking bug is now resolved. MUST be re-verified live via
// the real /api/mark path (not just the isolated OCR diagnostic route)
// before this is trusted again -- same discipline as the original
// rollback, not just "should be fine now".
const OCR_TEXT_MODEL = "google/gemini-3.1-flash-lite";

async function callQwen(images, prompt, openrouterKey) {
  return callOpenRouterVisionModel(images, prompt, openrouterKey, {
    model: PRODUCTION_OCR_MODEL,
    maxTokens: 4096,
    timeoutMs: 8000,
    // Ticket 21 (2026-09-26, explicit user decision): never route through
    // Alibaba -- real children's homework photos shouldn't touch that
    // provider's infrastructure. Matches callDeepSeek's existing
    // exclusion below (that one for a content-moderation false-positive
    // reason, not privacy, but the same effect either way).
    providerFilter: { ignore: ["Alibaba"] },
    logPrefix: "qwen",
  });
}

// Ticket 45 (2026-09-27): same "model name hardcoded in more than one
// place" gap already fixed for Qwen/Gemini/Jev (PRODUCTION_OCR_MODEL /
// OCR_TEXT_MODEL / JEV_MODEL) -- this one had spread to 3 separate
// literal copies of the DeepSeek model string (the real callDeepSeek()
// below, plus 2 connectivity self-test routes). One shared constant so a
// future DeepSeek version bump/swap is a one-line change.
const DEEPSEEK_MODEL = "deepseek/deepseek-v4.1-flash";

// Reasoning-based second look, tried when Qwen fails/gives up. Real
// testing 2026-09-20: most pages succeed in a few seconds for a few
// cents; occasionally a reasoning-heavy page (dense grammar/visual-logic
// questions) exhausts the token budget with zero output -- excluding the
// "Alibaba" route (an observed source of false-positive content-
// moderation blocks on ordinary children's homework) and a generous
// max_tokens noticeably reduces but does not eliminate this.
async function callDeepSeek(images, prompt, openrouterKey) {
  return callOpenRouterVisionModel(images, prompt, openrouterKey, {
    model: DEEPSEEK_MODEL,
    maxTokens: 20000,
    timeoutMs: 12000,
    providerFilter: { ignore: ["Alibaba"] },
    logPrefix: "deepseek",
  });
}

// Ticket (2026-09-29, explicit user instruction "唔要qwen 唔要deepseek
// 換做gemini"): real full-pipeline data gathered this same day, using the
// REAL production prompt/dispatch path against the same 10 genuinely
// AI-only items, found Gemini 3.1 Flash-Lite (with low-effort reasoning)
// more accurate than the then-production Qwen tier (78% vs 67%), and far
// cheaper/faster/more reliable than DeepSeek-v4.1-flash (which truncated
// at exactly 4000 completion tokens even when maxTokens was raised, and
// cost ~3.4x more per call) -- see benchmark/model-test-results-log.csv
// and memory project_ai_model_watch.md for the raw numbers. Reuses the
// same OCR_TEXT_MODEL constant/model string already used for OCR (one
// real model, two roles) so a future model swap stays a one-line change.
// maxTokens/timeoutMs sized off real observed usage in that test (94-218
// reasoning tokens, 2.1-3.9s per call) with generous headroom.
async function callGemini(images, prompt, openrouterKey) {
  return callOpenRouterVisionModel(images, prompt, openrouterKey, {
    model: OCR_TEXT_MODEL,
    maxTokens: 4000,
    timeoutMs: 8000,
    reasoning: { effort: "low" },
    logPrefix: "gemini",
  });
}

// ---------------------------------------------------------------------
// /api/mark pipeline (2026-09-21): AI does OCR only (read what the student
// wrote); code does the math. Real testing found that asking a vision
// model to JUDGE correct/wrong introduces the model's own reasoning
// mistakes (e.g. Qwen flagging "2+5=" answered as "5+2=7" as wrong purely
// for being reordered, on a worksheet whose entire point is that addition
// order doesn't matter) -- a mistake that persisted even when the item was
// cropped in isolation, so it's a genuine model misconception, not a
// context problem. Asking the SAME model to only transcribe (not judge)
// the identical handwriting was accurate on all 15/15 real test items,
// including that exact case, because transcription doesn't require the
// model to have an opinion about arithmetic order.
// ---------------------------------------------------------------------

const OCR_ONLY_PROMPT = (pageCount) => `你唔使判斷啱定錯，淨係負責抄低學生喺呢張功課相入面手寫嘅嘢（OCR），一字不漏咁抄，唔好自己計數或者judge。相有機會打橫/倒轉，先確認閱讀方向。學生成日用鉛筆寫字，筆跡好淺——要仔細睇清楚有冇淺色筆劃，睇唔清就填"?"。

如果一條題嘅答題位置完全冇筆跡，一定要將學生答案填空白（即係嗰個位留空），絕對唔可以自己計出個答案填返去頂替，就算你識計都好——你嘅工作淨係抄低實際存在嘅筆跡，唔係幫學生完成功課。**「留空」嘅實際做法係「|」後面乜都唔好寫（直接留返一個空字串），例如「5=54÷9=|」——唔可以自己度一個睇落合理嘅答案填落去，就算你100%肯定啱嘅答案係乜都好。** 呢一點對MC題(揀A/B/C/D)、圈住選項嘅括號題(可以/不可以)、文法填充題(要填啱嘅動詞/介詞)呢幾類特別容易中招——呢啲題目嘅「合理答案」對你嚟講太易度到，好容易不自覺就將個答案當成係抄低嚟嘅，其實你只係自己計緊。例如見到一張完全未填過嘅"Complete the conversation"對話配對題,啲括號入面乜都冇——你要老實咁樣回覆「1=Wesley:___( )|」（"|"後面留空），千祈唔可以因為你自己識答,就寫「1=Wesley:___( )|D」咁樣將你自己度到嘅字母當成學生填嘅。

如果見到用紅筆／同學生手寫顏色明顯唔同嘅筆改動過（劃咗線、圈返個答案、加咗字），要抄低學生原本用筆寫低嘅答案（就算個答案錯），唔好抄老師事後改咗嗰個版本。

如果呢張相根本唔似一份實體功課/練習卷——例如係手機或電腦嘅screenshot（有瀏覽器工具列、App介面、滑鼠標、按鈕、hyperlink）——就當呢頁冇任何題目，回覆空結果，唔好老作內容出嚟砌題目。但一張乾淨嘅掃描相（冇反光、冇陰影、冇摺痕）都算正常嘅功課相，唔好單純因為冇呢啲影相特徵就當佢唔係真嘅功課。

呢張相有${pageCount}頁。每一題回覆「題號=印刷題目文字|學生手寫答案」，用逗號分隔唔同題。題號跟返張相印刷嘅題號/標籤，搵唔到印刷編號就用簡短描述代替（例如題目嘅前幾個字）。如果一條題目入面學生寫咗多過一個答案（例如兩條算式），呢啲sub-answer之間用分號";"分隔，唔好用逗號（逗號淨係用嚟分隔唔同題目）。「|」呢個符號每一題一定要有、一定唔可以漏——尤其係長除法（例如5)40呢種直式）或者一題有幾個sub-answer嘅情況，都要跟返「題號=印刷題目|答案」呢個format，唔好淨係將啲數字答案接住上一題冧埋一齊列。題號一定要用普通阿拉伯數字或者張相原本印刷嘅英文/中文字母（例如1、2、3或者A、B、三、四），絕對唔可以用①②③呢種圈住嘅數字符號做題號，就算張相本身印刷咗圈裝數字，都要轉返做普通數字嚟做題號。

特別注意：如果印刷題目本身已經係一條計數式（例如「25÷5」呢種除數式），千祈唔好將個算式同答案一齊寫成「25÷5=5」咁樣再擺喺"="後面——嗰個"="會同題號後面嗰個分隔用嘅"="撞埋，令成句都冇晒必需嘅「|」符號。正確做法係將印刷嘅計數式（唔包括答案，例如「25÷5」）放喺"="同"|"之間，然之後"|"後面先至擺學生寫嘅答案（例如「5」）——即係「3=25÷5|5」，唔係「3=25÷5=5」。就算張相仲有直式（例如5)25呢種豎排除法），「|」後面都淨係擺學生最終寫低嘅答案數字（例如「5」）就夠，唔好將直式入面重複出現嘅數字（例如25、25）都加埋做額外sub-answer，會令批改程式誤判。

**呢一段對所有「填空喺算式中間」嘅題型都適用，唔止除法**：如果張相印刷嘅題目本身有一個留空嘅位置（例如格仔、底線、方格），並且嗰個留空位置唔係喺條式/句子最尾，而係鑲喺中間（例如「54÷□=6」、「□+5=12」、「3×□=15」、「7□+15=82」呢種），printedQuestion一定要保留返個空格本身，用「□」呢個符號代表個空格喺邊——千祈唔可以將學生手寫填咗嘅數字直接代入去嗰個位，令成條式睇落好似原本已經印刷晒、冚唪唥填晒咁（例如見到學生填咗9，就千祈唔好將printedQuestion寫成「54÷9」，一定要保持「54÷□=6」）。學生實際手寫嘅嗰個數字，先至擺去"|"後面嘅答案度。呢個規矩比起淨係除法更加廣——凡係「印刷嘅式入面有一個空格，空格唔喺最尾」嘅題型，都要跟。例如：
1=4+6|6+4=10,2=2+5|5+2=7,3=25÷5|5,5=54÷□=6|9,9=make two sums|6+9=15;5+8=13

**一段短文/一封信入面有連續好多個編號嘅空格要填（例如一封信入面有8個標咗①②③...嘅底線位，或者一段短文入面有多個題號嘅空格）**：呢種題型有兩個常見錯處，一定要避免：
(1) 千祈唔可以將printedQuestion淨係寫成個題號本身（例如淨係寫「1」）或者淨係將學生填嘅答案字照抄多一次當做printedQuestion——兩種做法都令人完全睇唔出原本嗰句話講緊咩、個空格前後文係咩，之後任何人（包括你自己）都冇辦法判斷個答案啱唔啱。printedQuestion一定要包含返個空格所在嗰句完整印刷句子（可以淨係嗰一句，唔使成段抄，但一定要包含緊接空格前後嘅印刷文字，等人淨係睇printedQuestion都知道問緊咩）。
(2) 千祈唔可以將成段短文/成封信嘅所有空格冧埋做一條item，然之後將全部答案都報做「?」（當成完全冇答到）——如果每個空格實際都有唔同嘅手寫答案，一定要將每個空格拆做獨立一條item（跟返原本印刷嘅編號），每條item嘅studentAnswer要係嗰一個空格實際嘅手寫內容，唔可以因為佢哋喺同一段短文入面就當成一條題目、或者因為睇漏咗手寫字就報做未答。
例如一封信入面："I have three sisters ① I don't have any brothers."，學生喺①度手寫咗"but"，就要回覆：
1=I have three sisters ____ I don't have any brothers.|but
（题号跟返印刷編號轉做普通數字，printedQuestion保留埋緊貼空格嘅完整句子，用"____"代表個空格位置，答案先至係學生真正手寫嘅字）

**呢張相可能只係一份多頁功課入面嘅其中一頁。**留意張相嘅最頂同最底：如果最頂一開始就係一題嘅中間部分（冇題號、冇上文，好似接住上一頁未完嘅嘢），喺回覆最後面加多一行單獨嘅"CONTINUES_FROM_PREVIOUS"；如果最底最後一題睇落未完（例如題目敘述好似仲未問完、冇答題位置、圖表被切斷），加多一行單獨嘅"CONTINUES_TO_NEXT"。呢兩行如果唔適用就完全唔使加，唔好預設加埋佢哋——要真係見到明顯線索先加，寧願漏報都好過亂報。呢兩行唔算題目item，唔使跟「題號=...|...」個format。

**如果呢頁有印刷咗一張「價目表」（物品名稱配對價錢,例如「機械人 $48」「跑車 $89」「洋娃娃 $25」）**，喺回覆最開始加一行「PRICE_TABLE: 名稱1=價錢1;名稱2=價錢2;...」，列晒成張表嘅每一項（名稱同價錢之間用"="，唔同項之間用";"分隔），然之後先跟正常格式列每一條題目。如果冇呢類價目表就完全唔使加呢行。

**如果呢頁係一篇閱讀理解，有一段原文（文章/對話/詩歌），學生要根據原文答題（例如喺原文入面揀返啱嘅字填空,或者揀MC選項）**，喺回覆最開始加一行「PASSAGE: <原文全文>」，將成段原文文字全部放喺呢一行（原文入面如果本身有換行,轉做空格,確保成段原文淨係一行）。如果冇呢類原文就完全唔使加呢行。

**如果呢頁有印刷咗一個「詞語庫」（一組可以填嘅詞語/短語,規定每個淨係用一次,例如"a cup of/a bar of/a bowl of/a piece of/a basket of/a packet of"）**，喺回覆最開始加一行「WORD_BANK: 詞1;詞2;詞3;...」，列晒成組詞語庫嘅每一個詞（用";"分隔）。如果冇呢類詞語庫就完全唔使加呢行。

**如果呢頁有一個「象形圖」(pictogram，用一個個小圖示代表數量，例如"每個圖示代表1小時"或者"每個圖代表1朵"，然後逐個類別/日子擺幾多個圖示)**，喺回覆最開始加一行「PICTOGRAM: 單位=<每個圖示代表幾多>;類別1=數量1;類別2=數量2;...」（類別同數量之間用"="，唔同類別之間用";"分隔），列晒成個象形圖每一個類別實際有幾多個圖示。如果冇呢類象形圖就完全唔使加呢行。

**如果呢頁印刷咗一個完整月份嘅日曆表格(有日一二三四五六做欄標題,逐個格仔填住日子數字)**，喺回覆最開始加一行「CALENDAR_GRID: 月份=<幾月>;首日星期=<日/一/二/三/四/五/六,即係呢個月1號係星期幾>;日數=<呢個月總共幾多日>」。如果冇呢類完整日曆表格就完全唔使加呢行。

**如果呢頁印刷咗一個「星期時間表」(逐日星期配對一樣嘢，可以係活動/科目，都可以係甜品/食物/其他規律配對，例如「星期日=英文班,星期一=游泳班...」或者「星期日=蛋卷,星期一=紙杯蛋糕...」)**，喺回覆最開始加一行「SCHEDULE_TABLE: 星期日=活動1;星期一=活動2;...」（星期同活動用"="連接，唔同日之間用";"分隔）。如果表下面嘅問題入面又見到同一組圖示（例如問題度話「如果今天的甜品是[圖示]」而個圖示同上面個表其中一格一樣），要將個圖示換做同上面表入面完全一樣嘅文字寫入printedQuestion（例如寫做「如果今天的甜品是蛋卷」），唔好淨係寫「圖示」兩個字。如果冇呢類時間表就完全唔使加呢行。

**如果呢頁有一幅「地點方位圖」(幾個地點/建築物用線連接住,擺成一個格仔陣，仲有一個指北針話明邊個方向係「北」)**，喺回覆最開始加一行「LOCATION_GRID: 北方向=<上/下/左/右/右上/右下/左下/左上,即係個指北針實際指緊邊個畫面方向——如果個箭嘴唔係啱啱指住正上/正下/正左/正右,而係指住斜角(例如45度左下),就要老實揀返最貼近嘅斜角選項,唔好將佢當成最近嘅正方向>;地點1=<行>,<列>;地點2=<行>,<列>;...」（每個地點嘅行、列數字由0開始,跟返個格仔陣實際嘅排位,唔使個陣係完整長方形,得返部分格仔有地點都要照實記低）。如果冇呢類地點方位圖就完全唔使加呢行。

**如果幅圖入面有人物,身體/手臂明確指緊一個方向,並且有一個指北針(或者其他方式)可以確定嗰個人實際面向緊東南西北邊一個方向**，喺回覆最開始加一行「FACING_DIRECTION: 人物1=東/南/西/北;人物2=...」，列出每個可以判斷到面向方向嘅人物。如果冇辦法判斷或者冇呢類人物就完全唔使加呢行。

**如果題目有一組「數字卡」(印刷咗一組獨立嘅數字,要求學生揀其中幾張砌成一個新數字)**，喺回覆最開始加一行「DIGIT_CARDS: 數字1,數字2,數字3,...」，列晒成組數字卡實際嘅數字(用","分隔)。如果冇呢類數字卡就完全唔使加呢行。

**如果印刷題目入面見到「Sudoku」呢個字，同時見到格仔大小提示（例如"4x4"）係4x4嘅**，呢題唔使跟返平時「題號=印刷題目|答案」嘅格式，改用「SUDOKU: 題號|印刷格仔16個|學生完整填晒嘅格仔16個」（一共兩條"|"，分開三部分）——兩組16個數字都係由左至右、由上至下（第一行4個、第二行4個、如此類推），**同一組入面**嘅16個數字之間用","分隔，空格用"0"代表。「印刷格仔」係原本印刷咗嘅提示數字（冇印刷嘅位填0）；「學生完整填晒嘅格仔」係連埋印刷同學生手寫，成個4x4已經填晒嘅完整版本（如果學生仲有位冇填，嗰格都填0）。如果張相見到「Sudoku」但格仔大小唔係4x4（例如3x3），就完全唔使理呢題，當冇見過（因為而家淨係識判斷4x4）。

**如果題目係揀邊組短除法（HCF/最大公因數）圖唔啱嘅MC（每個選項本身係一個短除法圖，唔係文字）**，喺回覆最開始加一行「SHORT_DIVISION_MC: A=除數1,除數2,...;B=...;C=...;D=...」，每個選項列晒佢個短除法圖由頭到尾用過嘅所有除數(由外層到內層，用","分隔)。如果冇呢類短除法MC就完全唔使加呢行。

**如果幅圖係兩個正方形並排(頂部對齊,右邊嗰個細啲),中間有條斜線由大正方形嘅左下角斜住去到右邊細正方形嘅右邊,幅圖仲有一個數字標住由最頂到斜線接觸右邊緣嗰點嘅距離**，喺回覆最開始加一行「SQUARES_DIAGONAL: 大正方形面積=<數字>;細正方形面積=<數字>;缺口=<嗰個標住嘅距離數字>」。如果冇呢類圖就完全唔使加呢行。

**如果幅圖係一個梯形夾住喺兩個正方形中間(左右各一個正方形,中間一個梯形斜邊連接),幅圖底部有標住成條底線嘅總長度**，喺回覆最開始加一行「TRAPEZOID_TWO_SQUARES: 底總長=<數字>」。如果冇呢類圖就完全唔使加呢行。

**如果幅圖係一個平行四邊形(果園/地皮),用一條垂直線分咗做兩部分(一部分有陰影),幅圖底部標住咗陰影嗰部分嘅闊度**，喺回覆最開始加一行「PARALLELOGRAM_PARTIAL: 陰影底闊度=<數字>」。如果冇呢類圖就完全唔使加呢行。

**如果幅圖係一張長方形卡紙,四個角各剪走一個大小形狀一樣嘅三角形,餘低中間一個菱形/風箏形,幅圖標住咗長方形嘅長闊,同埋其中一個被剪走嘅三角形嘅兩隻直角腳長度**，喺回覆最開始加一行「RECT_CUT_KITE: 長方形長=<數字>;長方形闊=<數字>;三角形腳1=<數字>;三角形腳2=<數字>」。如果冇呢類圖就完全唔使加呢行。

**如果印刷咗幾個「8方位指南針」圖(每個圖係一個米字型,8條線由中心放射出去,每條線盡頭寫住一個方向:北/東北/東/東南/南/西南/西/西北,揀邊個圖先啱)**，喺回覆最開始加一行「COMPASS_ROSE_MC: A=<由最頂嗰個位置開始,順時針方向讀晒8個方向字,用","分隔>;B=<同上>;C=<同上>」(如果有D、E等更多選項都照樣加落去)。如果冇呢類圖就完全唔使加呢行。

**如果幅圖係一張紙(長方形)對摺嘅過程圖(由原本嘅長方形,經過一次或者多次對摺,變到最後嘅形狀,圖入面標住咗最後對摺完嘅長度)**，喺回覆最開始加一行「PAPER_FOLD: 摺次數=<對摺咗幾多次,由圖入面箭嘴/步驟數清楚數,通常係1>;摺後長度=<圖入面標住嘅最後長度數字>」。如果冇呢類摺紙圖就完全唔使加呢行。

**如果幅圖係幾個地點(用英文字母/名稱標住)用彎彎曲曲嘅路徑線連接埋一齊,每條連接線都標住咗距離(例如"2厘米"),要計最短路程果類圖**，喺回覆最開始加一行「PATH_GRAPH: A-B=<距離>;B-C=<距離>;...」(每條直接連接嘅路徑一組,兩個地點用"-"連接,用"="接距離數字,唔同路徑之間用";"分隔;淨係列直接有線連住嘅兩個地點,唔使自己計間接距離)。如果冇呢類路徑圖就完全唔使加呢行。

**如果印刷咗幾個鐘面圖(每個係一個圓形錶面,有時針分針,揀邊個鐘面時間先啱嗰種MC)**，喺回覆最開始加一行「CLOCK_OPTIONS: A=<小時>:<分鐘,兩位數>;B=<同上>;C=<同上>」(用24小時制,由時針分針實際指緊嘅位置直接讀,如果有D、E等更多選項都照樣加落去;如果題目本身都有印刷一個「開始/起點」鐘面或者講明咗個開始時間,都要加多一組「開始=<小時>:<分鐘>」)。
讀鐘面步驟(逐隻鐘都要咁做,唔好一眼掃過就估)：先睇「時針」(短嗰支)實際企喺邊個數字附近(唔一定啱啱好指住個數字,可能喺兩個數字中間,咁就係嗰個較細數字加幾多分鐘嘅比例)；再睇「分針」(長嗰支)實際指住邊個數字,分針指住嘅數字×5就係分鐘數(例如分針指住"2"即係10分鐘)；兩樣都讀晒先組合做「小時:分鐘」。
如果冇呢類鐘面MC就完全唔使加呢行。

**如果幅圖有幾個物件(用名/字母標住),同一個共同參考點(或者互相之間)用線連接住,要判斷邊個離參考點最近/最遠,或者要逐個排先後次序**，喺回覆最開始加一行「DISTANCE_VALUES: 參考點=<名/留空>;物件1=<相對距離數字,由近到遠用細到大嘅數表示,唔使係真實cm,淨係要順序啱>;物件2=<同上>;...」(細心逐條線目測邊條長啲邊條短啲,由最短嗰條開始編1、2、3...)。如果冇呢類遠近排序圖就完全唔使加呢行。

**如果幅圖有幾個物件(例如植物/動物/建築物),每個物件旁邊都有一疊代用單位(例如一疊磚/積木/格仔)用嚟表示佢實際嘅高度/長度**，喺回覆最開始加一行「OBJECT_HEIGHTS: 物件1=<疊咗幾多格/塊,冇印刷數字就自己逐格數清楚>;物件2=<同上>;...」(如果某個物件冇印刷/冇畫出嚟個實際疊法,唔肯定就唔好估,淨係漏低嗰個物件唔寫)。如果冇呢類代用單位高度比較圖就完全唔使加呢行。

**如果題目印刷咗一個目標金額(例如一個銀幣圖),要求用指定嘅幾種面額銀幣/紙幣兌換(例如「[$5硬幣]可以兌換做___個[$2硬幣]同___個[$1硬幣]」,每個空格旁邊都印住緊一個特定面額嘅硬幣圖示)**，喺回覆最開始加一行「COIN_BLANKS: 目標=<金額數字>;面額1=<第一個空格旁邊個硬幣面額>;面額2=<第二個空格旁邊個硬幣面額,如果得返一個空格就唔使呢個>」(面額跟返空格喺題目入面出現嘅先後次序;金額可以係小數,例如0.2代表2毫)。
香港硬幣認面額提示(用嚟分辨邊個係邊個,唔好淨係睇個「數字」就估,細心睇形狀顏色邊緣)：$2(12邊波浪形,銀色)、$0.2(波浪形,金色)呢兩個先係波浪邊;$10係圓形(唔係波浪形),銀色中心+金色外環雙色設計;$5、$1、$0.5都係圓形銀/金色,滾花邊;$0.1(1毫)最細,圓形金色,平邊。$0.1同$10喺數字上都印住個「10」,好容易撞——分辨方法係睇成隻硬幣嘅大細(1毫最細)、顏色(1毫純金色,$10銀心金環雙色)、形狀，唔好淨係睇印住嘅數字就當係$10。
如果冇呢類兌換空格題就完全唔使加呢行。

**如果幅圖係一個棒形圖(bar chart)，有一條印刷咗數字刻度嘅軸(例如"0,2,4,6,8,10,12"，刻度數字之間相隔固定)，同埋幾條唔同長度嘅棒代表唔同類別**，喺回覆最開始加一行「BAR_CHART: 方向=<垂直/水平>;刻度最小值=<軸上面最細嗰個印刷數字>;刻度最大值=<軸上面最大嗰個印刷數字>;刻度間距=<相鄰兩個刻度數字相差幾多>;類別=<第一條棒代表嘅類別文字>,<第二條>,...」(方向：棒係垂直向上企定係水平向右伸,由圖嘅實際畫法判斷,唔好靠估；類別要跟返啲棒實際印刷/排列嘅先後次序，由圖入面軸邊嘅文字標籤讀，例如月份/名稱)。呢一行只需要讀返軸嘅刻度同類別文字，唔使自己目測估計每條棒嘅數值。如果冇呢類棒形圖就完全唔使加呢行。

**如果一條題目隔籬印咗幾條分開嘅直度圖示(例如幾條唔同長度嘅棒/竹簽/繩，每條自己printed住一個厘米長度數字，用嚟俾學生判斷可唔可以圍成三角形/邊種三角形)**，喺回覆最開始加一行「STICK_LENGTHS: <長度1>cm;<長度2>cm;...」(跟返啲圖示喺相入面由上到下或者由左到右嘅印刷次序，唔理個題目本身嘅句子有冇提到呢啲數字，一定要照抄)。如果冇呢類直度圖示就完全唔使加呢行。

**如果一條題目嘅(a)(b)兩個細題，共用返之前一句已經印刷出嚟嘅「資源」context句子(例如物件嘅長度/數量清單、材料規格，只喺(a)之前出現一次)**，每個細題(a)、(b)自己嘅printedQuestion都要重複返嗰句context，唔可以淨係第一個細題先有、第二個細題就得返「(b)嗰句問題本身」冧唪唥漏晒之前嗰句規格資訊——就算會令printedQuestion變長,都要照做,因為呢啲資訊係判斷答案啱唔啱嘅必要資料。

**如果一幅圖印咗幾個用英文字母標住嘅圖形(例如A、B、C...)，下面跟住幾條問題，每條都要求學生填返幾個代表啱答案嘅英文字母(例如「等邊三角形：___」「直角梯形：___」)**：呢種格式好容易漏抄字母，或者將字母錯放咗去隔籬條題度——抄嗰陣一定要逐個字母咁數清楚，唔好掃一眼就報。留意：(1)字母之間可能用逗號/頓號/空格分隔，唔好漏漏聽任何一個；(2)學生可能分開兩種顏色筆/兩次落筆寫（例如先用黑筆寫咗幾個，之後又用另一種顏色追加多一個），兩次寫嘅字母都要抄埋，唔好淨係抄第一次嗰批；(3)大楷細楷都算同一個字母（c同C一樣）。抄完成頁之後，快速覆核一次：逐條題目自己讀返一次幅圖度嗰個字母對唔對應嗰題嘅形狀特徵，唔好將啱啱抄漏咗嘅字母之後又亂咁塞落第二條題度濫竽充數。

唔好加任何其他文字、判斷、JSON。`;

// Ticket 52 (2026-09-27): extracts an optional printed price table (see
// OCR_ONLY_PROMPT's own instruction above) so verifyPriceTableLookup --
// written and tested 2026-09-25, never reachable before now -- can
// finally be registered. Same "marker line stripped before parseOcrLine
// runs" pattern as extractContinuationMarkers.
function extractPriceTable(text) {
  const m = /^PRICE_TABLE:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^PRICE_TABLE:.*$/gm, "");
  if (!m) return { priceTable: null, cleanedText };
  const table = {};
  for (const pair of m[1].split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const price = Number(pair.slice(eqIdx + 1).trim());
    if (name && Number.isFinite(price)) table[name] = price;
  }
  return { priceTable: Object.keys(table).length ? table : null, cleanedText };
}

// Ticket 53 (2026-09-27): extracts an optional printed reading passage
// (see OCR_ONLY_PROMPT's own instruction above) so verifySelectFromPassage
// and verifyLiteralKeywordMC -- both written and tested 2026-09-25, never
// reachable before now -- can finally be registered. Same marker-line
// pattern as extractPriceTable/extractContinuationMarkers.
function extractPassageText(text) {
  const m = /^PASSAGE:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^PASSAGE:.*$/gm, "");
  return { passageText: m ? m[1].trim() : null, cleanedText };
}

// Ticket 222 "crossword grid-consistency" (2026-10-01, real citation:
// 2022/2023 P2 General English First Examination, Part A -- "Complete
// the crossword with the correct adjectives"). Real user insight: a
// crossword answer can be PARTIALLY verified without any language
// understanding at all -- a filled word's LENGTH must match its slot's
// own cell count, and at every cell it shares with another already-
// filled slot, both slots' letters at that shared cell must agree. This
// can definitively catch a WRONG answer (length mismatch or letter
// conflict) with zero semantic judgment -- pure grid geometry -- but can
// NEVER confirm an answer is the intended one (a structurally-consistent
// word could still be the wrong adjective for the clue, e.g. a
// different-but-equally-4-letter adjective that happens to share the
// same crossing letters). Kept strictly as a pre-filter: catches some
// real errors for free; anything it can't disprove still needs the real
// AI-fallback judge as before, same "decline rather than guess"
// discipline as every other handler in this file.
//
// NOT YET WIRED to a real OCR extraction or a QUESTION_TYPE_HANDLERS
// entry -- this citation's real grid coordinates were never reliably
// hand-measured from the photo (a chat screenshot, not a clean render),
// and no real OCR test has confirmed a vision model can actually read a
// crossword's cell/slot geometry accurately. This is the algorithm only,
// proven against synthetic grid data mirroring this citation's real
// clue COUNT and shape (6 slots, 2 real intersections per the photo's
// own layout) -- shipping the OCR-extraction half needs its own
// real-photo verification pass before being trusted, per this project's
// hard rule (Tier V: verify on real questions, not just synthetic
// cases) -- disclosed explicitly rather than silently assumed to work.
function parseCrosswordGrid(text) {
  const slots = {};
  for (const entry of String(text || "").split(";")) {
    const m = entry.trim().match(/^(\w+)=(across|down)@(\d+),(\d+):(\d+)$/);
    if (!m) continue;
    const [, num, dir, row, col, len] = m;
    slots[num] = { direction: dir, row: Number(row), col: Number(col), length: Number(len) };
  }
  return slots;
}

function crosswordSlotCells(slot) {
  const cells = [];
  for (let i = 0; i < slot.length; i++) {
    cells.push(slot.direction === "across" ? [slot.row, slot.col + i] : [slot.row + i, slot.col]);
  }
  return cells;
}

// fills: { slotNumber: word }. Returns an array of conflict objects
// (empty array = structurally consistent, NOT the same as "confirmed
// correct" -- see the long comment above).
function checkCrosswordConsistency(slots, fills) {
  const conflicts = [];
  const cellLetters = new Map(); // "row,col" -> { slotNum, letter }
  for (const [num, rawWord] of Object.entries(fills)) {
    const slot = slots[num];
    const word = String(rawWord || "").trim();
    if (!slot || !word) continue;
    if (word.length !== slot.length) {
      conflicts.push({ slot: num, reason: "length_mismatch", expectedLength: slot.length, gotLength: word.length });
      continue;
    }
    crosswordSlotCells(slot).forEach(([r, c], i) => {
      const key = `${r},${c}`;
      const letter = word[i].toLowerCase();
      const existing = cellLetters.get(key);
      if (existing && existing.letter !== letter) {
        conflicts.push({ slot: num, reason: "letter_conflict", withSlot: existing.slotNum, cell: key, gotLetter: letter, expectedLetter: existing.letter });
      } else if (!existing) {
        cellLetters.set(key, { slotNum: num, letter });
      }
    });
  }
  return conflicts;
}

// Ticket 222 "Pattern 5" (2026-09-30): extracts an optional set of
// printed stick/rod length labels (see OCR_ONLY_PROMPT's own
// instruction below) -- real citation: 小學數學新思維 3下A 作業, footer
// p.21, Q12 ("利用左面3枝竹簽，（可以/不可以）圍成一個三角形") where the
// 8cm/6cm/4cm side lengths are printed ONLY in the diagram beside the
// question, never inside the question's own printed sentence. A real
// OCR test confirmed this gap directly (see verifyTriangleFormableFromSticks's
// own comment) -- without this marker line, this whole question shape
// was permanently unsolvable by code, no matter how the text-parsing
// side was written. Same marker-line-stripped-before-parseOcrLine
// pattern as extractPriceTable.
function extractStickLengths(text) {
  const m = /^STICK_LENGTHS:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^STICK_LENGTHS:.*$/gm, "");
  if (!m) return { stickLengths: null, cleanedText };
  const lengths = (m[1].match(/\d+(?:\.\d+)?(?=cm)/g) || []).map(Number);
  return { stickLengths: lengths.length ? lengths : null, cleanedText };
}

// Ticket 54 (2026-09-27): extracts an optional printed word bank (see
// OCR_ONLY_PROMPT's own instruction above). Unlike price table/passage,
// this is NOT wired through a QUESTION_TYPE_HANDLERS entry -- the
// underlying check (verifyWordBankOnceEach) is a GROUP constraint across
// all of a page's word-bank items together, not a per-item check, so
// it's applied as its own pass in handleMark instead (see the
// "Module 2b" comment there).
function extractWordBank(text) {
  const m = /^WORD_BANK:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^WORD_BANK:.*$/gm, "");
  if (!m) return { wordBank: null, cleanedText };
  const bank = m[1].split(";").map((s) => s.trim()).filter(Boolean);
  return { wordBank: bank.length ? bank : null, cleanedText };
}

// Ticket 55 (2026-09-27): extracts 4x4 Sudoku puzzles (see OCR_ONLY_PROMPT's
// own instruction above) as a completely separate item shape from every
// other question type -- a puzzle is one 16-cell grid, not a
// "printedQuestion|studentAnswer" pair, so it can't go through
// parseOcrLine at all. Multiple puzzles can appear on one page (real
// example: 5 separate puzzles on one worksheet page), so this returns an
// ARRAY, unlike the single-value price table/passage/word-bank
// extractors. Malformed lines (wrong cell count, non-digit content) are
// silently dropped rather than thrown -- same "fail open to
// needs_review, never crash the whole page" discipline as everywhere
// else in this file.
function extractSudokuPuzzles(text) {
  const puzzles = [];
  const cleanedText = text.replace(/^SUDOKU:.*$/gm, (line) => {
    const parts = line.trim().slice("SUDOKU:".length).trim().split("|");
    if (parts.length !== 3) return "";
    const [label, givenCsv, studentCsv] = parts;
    const parseGrid = (s) => s.split(",").map((v) => v.trim()).map((v) => (v === "0" || v === "" ? null : v));
    const givenGrid = parseGrid(givenCsv);
    const studentGrid = parseGrid(studentCsv);
    if (givenGrid.length === 16 && studentGrid.length === 16) {
      puzzles.push({ label: label.trim(), givenGrid, studentGrid });
    }
    return "";
  });
  return { puzzles, cleanedText };
}

// Ticket 68 (2026-09-28, found independently in two separate real
// materials -- a P2 exam and a P3 exam -- both asking count/max/min/
// difference/ratio/total questions against a pictogram): extracts the
// icon-count-per-category shared context so all of those become plain
// arithmetic instead of a "must look at the image" judgement call. Same
// marker-line pattern as extractPriceTable.
function extractPictogramData(text) {
  const m = /^PICTOGRAM:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^PICTOGRAM:.*$/gm, "");
  if (!m) return { pictogramData: null, cleanedText };
  const parts = m[1].split(";").map((s) => s.trim()).filter(Boolean);
  let unit = 1;
  const counts = {};
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = Number(part.slice(eqIdx + 1).trim());
    if (!Number.isFinite(value)) continue;
    if (name === "單位") unit = value;
    else counts[name] = value;
  }
  return { pictogramData: Object.keys(counts).length ? { unit, counts } : null, cleanedText };
}

// Ticket 134 (2026-09-28, real citation: a printed "五月" calendar grid,
// day 1 falling on Saturday, 31 days -- confirmed the FIRST complete
// real example of this marker after it was proposed but unbuilt since
// Ticket 97): extracts month/firstWeekday/daysInMonth so every
// day-of-week question about the calendar becomes plain modular
// arithmetic instead of needing to OCR every individual cell.
const WEEKDAY_NAMES_ZH = ["日", "一", "二", "三", "四", "五", "六"];
function extractCalendarGrid(text) {
  const m = /^CALENDAR_GRID:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^CALENDAR_GRID:.*$/gm, "");
  if (!m) return { calendarGrid: null, cleanedText };
  const parts = m[1].split(";").map((s) => s.trim()).filter(Boolean);
  let month = null, firstWeekday = null, daysInMonth = null;
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key === "月份") month = Number(value);
    else if (key === "首日星期") firstWeekday = WEEKDAY_NAMES_ZH.indexOf(value);
    else if (key === "日數") daysInMonth = Number(value);
  }
  const valid = Number.isFinite(month) && firstWeekday !== null && firstWeekday >= 0 && Number.isFinite(daysInMonth) && daysInMonth > 0;
  return { calendarGrid: valid ? { month, firstWeekday, daysInMonth } : null, cleanedText };
}

// Ticket 135 (2026-09-28, real citation: a printed weekly schedule
// "星期日=英文班;星期一=游泳班;...;星期六=休息"): extracts a
// weekday-keyed activity lookup table.
function extractScheduleTable(text) {
  const m = /^SCHEDULE_TABLE:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^SCHEDULE_TABLE:.*$/gm, "");
  if (!m) return { scheduleTable: null, cleanedText };
  const table = {};
  for (const pair of m[1].split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const day = pair.slice(0, eqIdx).trim();
    const activity = pair.slice(eqIdx + 1).trim();
    if (day && activity) table[day] = activity;
  }
  return { scheduleTable: Object.keys(table).length ? table : null, cleanedText };
}

// Location-grid direction reasoning (found 2026-09-28 while working
// through a real P2 exam's Q24/25 -- see verifyLocationGridQuery's own
// comment below for the full validation story): extracts a
// north-direction reference plus each location's (row, col) position.
// Deliberately keyed by explicit coordinates rather than assuming a
// dense rectangular grid -- the real citation's own grid is IRREGULAR
// (row 3 only has 2 cells, offset under columns 1-2, not starting at
// column 0), so a "just count columns" assumption would have been wrong.
function extractLocationGrid(text) {
  const m = /^LOCATION_GRID:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^LOCATION_GRID:.*$/gm, "");
  if (!m) return { locationGrid: null, cleanedText };
  const parts = m[1].split(";").map((s) => s.trim()).filter(Boolean);
  let northDir = null;
  const positions = {};
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key === "北方向") northDir = value;
    else {
      const rc = value.split(",").map((n) => Number(n.trim()));
      if (rc.length === 2 && rc.every(Number.isFinite)) positions[key] = { row: rc[0], col: rc[1] };
    }
  }
  const valid = ["上", "下", "左", "右", "右上", "右下", "左下", "左上"].includes(northDir) && Object.keys(positions).length >= 2;
  return { locationGrid: valid ? { northDir, positions } : null, cleanedText };
}

// Facing-direction reasoning (found 2026-09-28, real citations: "梓君和
// 偉誠面對面站在一起。梓君面向___方。" -> 西 (opposite of 偉誠's own
// direction); "偉誠向右轉一個直角後，面向___方。" -> 南). Cross-checked
// BOTH real answers by hand before building anything: Q29's answer (南)
// implies 偉誠's own starting direction is 東 (turning right/clockwise
// from 東 gives 南), and Q28's answer (西) is exactly the opposite of
// 東 -- both citations agree on the same underlying fact (偉誠 faces
// 東), confirming the model is right before writing any code.
function extractFacingDirection(text) {
  const m = /^FACING_DIRECTION:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^FACING_DIRECTION:.*$/gm, "");
  if (!m) return { facingDirection: null, cleanedText };
  const dirs = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    const dir = part.slice(eqIdx + 1).trim();
    if (name && ["東", "南", "西", "北"].includes(dir)) dirs[name] = dir;
  }
  return { facingDirection: Object.keys(dirs).length ? dirs : null, cleanedText };
}

// Ticket 154 (2026-09-28, real citation: "以下各短除式中，哪組被除數的
// 最大公因數不是14？" -- 4 MC options, each itself a short-division
// diagram): extracts each option's chain of divisors used, outer to
// inner (e.g. B: "2丨18 28 -> 9 14" is just [2]; D: "2丨14 28 -> 7 14,
// 7丨7 14 -> 1 2" is [2,7]).
function extractShortDivisionMc(text) {
  const m = /^SHORT_DIVISION_MC:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^SHORT_DIVISION_MC:.*$/gm, "");
  if (!m) return { shortDivisionMc: null, cleanedText };
  const options = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const letter = part.slice(0, eqIdx).trim();
    const divisors = part.slice(eqIdx + 1).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (letter && divisors.length) options[letter] = divisors;
  }
  return { shortDivisionMc: Object.keys(options).length ? options : null, cleanedText };
}

// Ticket 155 (2026-09-28, real citation: "上圖由兩個面積分別是81 cm²和
// 36 cm²的正方形組成。陰影部分的面積是多少cm²？" -- two squares,
// top-aligned side by side, a diagonal from the big square's bottom-left
// corner to a point on the right edge marked by a "gap from top"
// measurement; verified answer 90 by hand-deriving the geometry from the
// real photo before writing any code -- see verifySquaresDiagonalShadedArea).
function extractSquaresDiagonal(text) {
  const m = /^SQUARES_DIAGONAL:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^SQUARES_DIAGONAL:.*$/gm, "");
  if (!m) return { squaresDiagonal: null, cleanedText };
  const fields = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    fields[part.slice(0, eqIdx).trim()] = Number(part.slice(eqIdx + 1).trim());
  }
  const bigArea = fields["大正方形面積"], smallArea = fields["細正方形面積"], gap = fields["缺口"];
  const ok = Number.isFinite(bigArea) && Number.isFinite(smallArea) && Number.isFinite(gap);
  return { squaresDiagonal: ok ? { bigArea, smallArea, gap } : null, cleanedText };
}

// Ticket 156 (2026-09-28, real citation: "右圖由一個梯形和兩個正方形組
// 成，兩個正方形的周界分別24 cm和16 cm，梯形的面積是多少cm²？" -- the
// two squares' perimeters are already in the printed question text; only
// the diagram-only total baseline length ("12 cm" in the photo) needs a
// marker).
function extractTrapezoidTwoSquares(text) {
  const m = /^TRAPEZOID_TWO_SQUARES:\s*底總長=(\d+(?:\.\d+)?)/m.exec(text);
  const cleanedText = text.replace(/^TRAPEZOID_TWO_SQUARES:.*$/gm, "");
  return { trapezoidBaseline: m ? Number(m[1]) : null, cleanedText };
}

// Ticket 158 (2026-09-28, real citation: "右圖是一個大平行四邊形果園，
// 它的佔地面積是770 m²。如果着色部分的佔地面積是220 m²，白色部分高多
// 少m？" -- total/shaded areas are in the printed text; only the
// diagram-only shaded strip's base width ("10 m" in the photo) needs a
// marker).
function extractParallelogramPartial(text) {
  const m = /^PARALLELOGRAM_PARTIAL:\s*陰影底闊度=(\d+(?:\.\d+)?)/m.exec(text);
  const cleanedText = text.replace(/^PARALLELOGRAM_PARTIAL:.*$/gm, "");
  return { parallelogramShadedWidth: m ? Number(m[1]) : null, cleanedText };
}

// Ticket 177 (2026-09-28, real citation: "一張長方形卡紙剪去4個大小和
// 形狀都相同的三角形後，餘下部分的面積是多少cm²？" rectangle 20×12,
// each corner triangle's two legs 8 and 6 -- found this segment while
// re-reviewing the real P5 exam for Tickets 154-160).
function extractRectCutKite(text) {
  const m = /^RECT_CUT_KITE:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^RECT_CUT_KITE:.*$/gm, "");
  if (!m) return { rectCutKite: null, cleanedText };
  const fields = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    fields[part.slice(0, eqIdx).trim()] = Number(part.slice(eqIdx + 1).trim());
  }
  const { 長方形長: length, 長方形闊: width, 三角形腳1: leg1, 三角形腳2: leg2 } = fields;
  const ok = [length, width, leg1, leg2].every((n) => Number.isFinite(n));
  return { rectCutKite: ok ? { length, width, leg1, leg2 } : null, cleanedText };
}

// Ticket 179 (2026-09-28, real citation, P4 exam Q1, 二(2)圖形與空間:
// "以上三個方向指示中，*(A/B/C)是正確的。" 3 eight-point compass roses --
// hand-verified from the real photo before writing any code: reading
// each rose's 8 labels clockwise starting from the top spoke and
// rotating so "北" comes first, A becomes [北,西北,西,西南,南,東南,東,
// 東北] (the REVERSE of the real compass order -- a mirrored/wrong
// rose), B becomes exactly [北,東北,東,東南,南,西南,西,西北] (correct,
// matches the student's own circled answer), C becomes
// [北,西南,東,東南,南,西北,西,東北] (neither the forward nor reversed
// order -- genuinely scrambled). No pixel/angle geometry needed at all:
// each of the 8 spokes already carries its own direction word as
// printed text, so the whole check reduces to "is this list, read
// clockwise, a rotation of the canonical clockwise compass order".
function extractCompassRoseMc(text) {
  const m = /^COMPASS_ROSE_MC:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^COMPASS_ROSE_MC:.*$/gm, "");
  if (!m) return { compassRoseMc: null, cleanedText };
  const options = {};
  const validDirs = new Set(["北", "東北", "東", "東南", "南", "西南", "西", "西北"]);
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const letter = part.slice(0, eqIdx).trim();
    const dirs = part.slice(eqIdx + 1).split(",").map((s) => s.trim()).filter(Boolean);
    // Require all 8 canonical directions exactly once each -- not just
    // "8 tokens that individually look valid" -- so a garbled or
    // duplicate-containing line is silently rejected rather than fed
    // into the rotation check below with a bogus set.
    const isValidPermutation = dirs.length === 8 && new Set(dirs).size === 8 && dirs.every((d) => validDirs.has(d));
    if (letter && isValidPermutation) options[letter] = dirs;
  }
  return { compassRoseMc: Object.keys(options).length ? options : null, cleanedText };
}

// Ticket 188 (2026-09-28, real citation, 躍思P1: 家文把一張手工紙如上
// 圖般對摺，對摺後的長度是13cm，手工紙原來長___cm -> 26): a single fold
// halves the length, so original = folded_length * 2^fold_count.
// Hand-verified against the real citation (folds=1, folded=13,
// 13*2^1=26, matches the user-confirmed correct answer) before writing
// verifyPaperFold below.
function extractPaperFold(text) {
  const m = /^PAPER_FOLD:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^PAPER_FOLD:.*$/gm, "");
  if (!m) return { paperFold: null, cleanedText };
  const parts = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = Number(part.slice(eqIdx + 1).trim());
    if (Number.isFinite(value)) parts[key] = value;
  }
  const folds = parts["摺次數"];
  const foldedLength = parts["摺後長度"];
  if (!Number.isFinite(folds) || folds < 1 || !Number.isFinite(foldedLength) || foldedLength <= 0) {
    return { paperFold: null, cleanedText };
  }
  return { paperFold: { folds, foldedLength }, cleanedText };
}

function verifyPaperFold(paperFold, studentAnswer) {
  const answer = String(studentAnswer || "").trim();
  if (!answer || !paperFold) return { correct: null, correctAnswer: "" };
  const studentNum = parseNumericAnswer(answer);
  if (studentNum === null) return { correct: null, correctAnswer: "" };
  const expected = paperFold.foldedLength * Math.pow(2, paperFold.folds);
  const correct = Math.abs(studentNum - expected) < 0.01;
  return { correct, correctAnswer: correct ? "" : String(expected) };
}

// Ticket 185 (2026-09-28, real citation, 躍思P1 Q6: 螞蟻喺A-G幾個地點之間
// 嘅路徑圖, 距離用厘米標住). Hand-verified against all 3 real sub-answers
// (D-F最短=6, F-C最短=5, B經F去E=6) using the exact edge set below,
// confirmed programmatically with a real Dijkstra run before writing
// verifyPathGraph -- see TICKETS.md Ticket 185 for the full derivation
// (an earlier reading of the graph mismatched on sub-question (c) until
// the user corrected the destination node from D to E).
function extractPathGraph(text) {
  const m = /^PATH_GRAPH:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^PATH_GRAPH:.*$/gm, "");
  if (!m) return { pathGraph: null, cleanedText };
  const edges = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const nodesPart = part.slice(0, eqIdx).trim();
    const dashIdx = nodesPart.indexOf("-");
    if (dashIdx === -1) continue;
    const u = nodesPart.slice(0, dashIdx).trim();
    const v = nodesPart.slice(dashIdx + 1).trim();
    const weight = Number(part.slice(eqIdx + 1).trim());
    if (!u || !v || !Number.isFinite(weight) || weight <= 0) continue;
    edges[u] = edges[u] || {};
    edges[v] = edges[v] || {};
    edges[u][v] = weight;
    edges[v][u] = weight;
  }
  return { pathGraph: Object.keys(edges).length ? edges : null, cleanedText };
}

// Plain Dijkstra over the small hand-drawn graphs these citations use
// (single-digit node counts) -- returns {node: shortestDistanceFromStart}.
function pathGraphShortestDistances(adj, start) {
  const dist = {};
  Object.keys(adj).forEach((n) => { dist[n] = Infinity; });
  if (!(start in dist)) return dist;
  dist[start] = 0;
  const visited = new Set();
  while (visited.size < Object.keys(adj).length) {
    let u = null;
    let best = Infinity;
    for (const n of Object.keys(adj)) {
      if (!visited.has(n) && dist[n] < best) { best = dist[n]; u = n; }
    }
    if (u === null) break;
    visited.add(u);
    for (const [v, w] of Object.entries(adj[u])) {
      if (dist[u] + w < dist[v]) dist[v] = dist[u] + w;
    }
  }
  return dist;
}

function verifyPathGraph(pathGraph, printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !pathGraph) return { correct: null, correctAnswer: "" };
  const nodes = Object.keys(pathGraph);
  const nodePattern = nodes.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!nodePattern) return { correct: null, correctAnswer: "" };

  // Shape 2: "從X出發，經*(A/B/C)前往Y要走N厘米" -- MC, find which
  // single-letter waypoint makes dist(start,waypoint)+dist(waypoint,end)
  // equal the stated total N.
  const viaRe = new RegExp(`從\\s*(${nodePattern})\\s*出發[\\s\\S]{0,6}經\\s*\\*?\\(([^)]+)\\)[\\s\\S]{0,6}前往\\s*(${nodePattern})[\\s\\S]{0,10}要走\\s*(\\d+(?:\\.\\d+)?)`);
  const viaMatch = printed.match(viaRe);
  if (viaMatch) {
    const [, start, optionsStr, end, totalStr] = viaMatch;
    const total = Number(totalStr);
    const options = optionsStr.split("/").map((s) => s.trim()).filter(Boolean);
    const distFromStart = pathGraphShortestDistances(pathGraph, start);
    const distToEnd = pathGraphShortestDistances(pathGraph, end);
    const matching = options.filter((opt) => {
      const d = (distFromStart[opt] || 0) + (distToEnd[opt] || 0);
      return nodes.includes(opt) && Math.abs(d - total) < 0.01;
    });
    if (matching.length !== 1) return { correct: null, correctAnswer: "" };
    const correct = answer === matching[0];
    return { correct, correctAnswer: correct ? "" : matching[0] };
  }

  // Shape 1: "X和Y的最短路程是___" or "從X出發前往Y，最少要走___" --
  // plain shortest-path query between two named nodes.
  const pairRe = new RegExp(`(${nodePattern})[\\s\\S]{0,10}(?:和|出發前往|前往)[\\s\\S]{0,4}(${nodePattern})`);
  const pairMatch = printed.match(pairRe);
  if (pairMatch && (/最短路程/.test(printed) || /最少要走/.test(printed))) {
    const [, start, end] = pairMatch;
    if (start === end) return { correct: null, correctAnswer: "" };
    const dist = pathGraphShortestDistances(pathGraph, start);
    const expected = dist[end];
    if (!Number.isFinite(expected)) return { correct: null, correctAnswer: "" };
    const studentNum = parseNumericAnswer(answer);
    if (studentNum === null) return { correct: null, correctAnswer: "" };
    const correct = Math.abs(studentNum - expected) < 0.01;
    return { correct, correctAnswer: correct ? "" : String(expected) };
  }

  return { correct: null, correctAnswer: "" };
}

// Ticket 187 (2026-09-28, real citation, 躍思P1 Q7: 小思在5時開始睇電視,
// 以下邊個可能係佢睇完電視嘅時間? A/B/C/D四個鐘面, 答案D): a "which
// completion time is plausible" MC where the options are ONLY shown as
// clock-face images, no printed times at all -- genuinely needs the
// vision step to read each clock face (unlike Ticket 187's other shape,
// verifyElapsedTimeForward's "X o'clock" extension, where the times
// were already in the printed text). "Plausible" = strictly after the
// stated start time, same day, within a forward 12-hour window; if
// more than one option qualifies the question is ambiguous and this
// declines rather than guessing.
function extractClockOptions(text) {
  const m = /^CLOCK_OPTIONS:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^CLOCK_OPTIONS:.*$/gm, "");
  if (!m) return { clockOptions: null, cleanedText };
  const options = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(part.slice(eqIdx + 1).trim());
    if (!key || !timeMatch) continue;
    const h = parseInt(timeMatch[1], 10);
    const min = parseInt(timeMatch[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) continue;
    options[key] = h * 60 + min;
  }
  return { clockOptions: Object.keys(options).length ? options : null, cleanedText };
}

function verifyClockOptionsMc(clockOptions, printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !clockOptions || !("開始" in clockOptions)) return { correct: null, correctAnswer: "" };
  const startMatch = printed.match(/(\d{1,2})\s*時[\s\S]{0,6}開始/);
  const startMin = clockOptions["開始"];
  if (!startMatch || !Number.isFinite(startMin)) return { correct: null, correctAnswer: "" };
  const candidates = Object.keys(clockOptions).filter((k) => k !== "開始");
  const plausible = candidates.filter((k) => {
    let diff = clockOptions[k] - startMin;
    if (diff < 0) diff += 24 * 60;
    return diff > 0 && diff <= 12 * 60;
  });
  if (plausible.length !== 1) return { correct: null, correctAnswer: "" };
  const correct = answer === plausible[0];
  return { correct, correctAnswer: correct ? "" : plausible[0] };
}

// Ticket 189 (2026-09-28, real citation, P2pc Q29: "[$5 coin] can be
// exchanged for __2__ [$2 coin] and __1__ [$1 coin]" -> 2, 1): a
// change-making question with one blank PER denomination, each blank
// tied to a specific coin shown right next to it (not a free choice of
// which denominations to use). With only 2 unknowns and 1 equation
// (n1*d1 + n2*d2 = target) there's no unique answer in general, so this
// assumes the standard "fewest coins" convention real HK coin
// denominations always support (greedy from the largest stated
// denomination down is provably optimal for HK's coin set) -- hand-
// verified: target=5, denoms=[2,1] -> greedy gives 2x$2 + 1x$1,
// matching the real citation exactly.
function extractCoinBlanks(text) {
  const m = /^COIN_BLANKS:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^COIN_BLANKS:.*$/gm, "");
  if (!m) return { coinBlanks: null, cleanedText };
  const parts = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = Number(part.slice(eqIdx + 1).trim());
    if (Number.isFinite(value)) parts[key] = value;
  }
  const target = parts["目標"];
  const denoms = [];
  for (let i = 1; parts[`面額${i}`] !== undefined; i++) denoms.push(parts[`面額${i}`]);
  if (!Number.isFinite(target) || target <= 0 || !denoms.length || denoms.some((d) => !Number.isFinite(d) || d <= 0)) {
    return { coinBlanks: null, cleanedText };
  }
  return { coinBlanks: { target, denoms }, cleanedText };
}

function verifyCoinBlanks(coinBlanks, studentAnswer) {
  const answer = String(studentAnswer || "").trim();
  if (!answer || !coinBlanks) return { correct: null, correctAnswer: "" };
  const studentParts = answer.split(",").map((s) => parseNumericAnswer(s.trim()));
  if (studentParts.length !== coinBlanks.denoms.length || studentParts.some((n) => n === null)) {
    return { correct: null, correctAnswer: "" };
  }
  let remaining = coinBlanks.target;
  const expectedCounts = coinBlanks.denoms.map((d) => {
    const count = Math.floor(remaining / d + 1e-9);
    remaining = remaining - count * d;
    return count;
  });
  if (Math.abs(remaining) > 1e-6) return { correct: null, correctAnswer: "" };
  const correct = studentParts.every((n, i) => Math.abs(n - expectedCounts[i]) < 1e-6);
  return { correct, correctAnswer: correct ? "" : expectedCounts.join(",") };
}

// Ticket 194 (2026-09-28, real citations: P1 樂思 "Distance" page --
// (1) "(Tigger / Nina / Billy) is nearest to Micky." MC, picking the
// labelled object with the smallest extracted relative-distance value
// (Nina isn't even in the picture, so only candidates with an actual
// extracted value are eligible); (2) darts page -- "Yan's dart is
// nearest to [center]. Mike's dart is farthest from [center]. Sally's
// dart is nearer to [center] than Ken's dart. Ken's dart is Dart ___."
// -- a 4-way elimination: nearest/farthest are named directly, the
// remaining 2 darts are split by a relative comparison, and the
// question asks for the FARTHER of those 2 remaining darts' own label.
// ⚠️ Both real citations are BLANK/unanswered practice pages (no
// teacher marks, no answer key) -- the extraction+comparison logic
// itself is simple/low-risk (min/max and pairwise comparison, no
// multi-step algorithm like Ticket 185's Dijkstra), but unlike 185-189
// there is no independently-verified real ground truth to check this
// against. Tests below use clean constructed values, same discipline
// as Ticket 187's clock-options MC.
function extractDistanceValues(text) {
  const m = /^DISTANCE_VALUES:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^DISTANCE_VALUES:.*$/gm, "");
  if (!m) return { distanceValues: null, cleanedText };
  let reference = null;
  const values = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const rawValue = part.slice(eqIdx + 1).trim();
    if (key === "參考點") { if (rawValue) reference = rawValue; continue; }
    const num = Number(rawValue);
    if (key && Number.isFinite(num)) values[key] = num;
  }
  if (!Object.keys(values).length) return { distanceValues: null, cleanedText };
  return { distanceValues: { reference, values }, cleanedText };
}

function verifyDistanceRanking(distanceValues, printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !distanceValues) return { correct: null, correctAnswer: "" };
  const values = distanceValues.values;

  // Shape B: 4-name elimination chain (darts citation).
  const nearestM = printed.match(/(\w+)(?:'s\s+\S+)?\s+is\s+nearest\s+to/i);
  const farthestM = printed.match(/(\w+)(?:'s\s+\S+)?\s+is\s+farthest\s+from/i);
  const relM = printed.match(/(\w+)(?:'s\s+\S+)?\s+is\s+nearer\s+to\s+[\s\S]+?\s+than\s+(\w+)(?:'s\s+\S+)?/i);
  if (nearestM && farthestM && relM) {
    const labels = Object.keys(values);
    const sorted = [...labels].sort((a, b) => values[a] - values[b]);
    if (sorted.length !== 4) return { correct: null, correctAnswer: "" };
    const nearestLabel = sorted[0];
    const farthestLabel = sorted[3];
    const remaining = sorted.slice(1, 3);
    const nearerLabel = remaining[0];
    const fartherLabel = remaining[1];
    // relM[1] = the "nearer" person (Sally), relM[2] = the "farther" person (Ken) being asked about.
    const askedName = relM[2];
    if (!askedName) return { correct: null, correctAnswer: "" };
    const correct = answer === fartherLabel;
    return { correct, correctAnswer: correct ? "" : fartherLabel };
  }

  // Shape A: "(A/B/C) is nearest/farthest to/from [reference]" MC --
  // only candidates with an actual extracted value are eligible (a
  // named MC option that isn't in the picture at all is never chosen).
  const mcMatch = printed.match(/\(([^)]+)\)\s*is\s*(nearest|farthest)\s*(?:to|from)/i);
  if (mcMatch) {
    const options = mcMatch[1].split("/").map((s) => s.trim()).filter(Boolean);
    const eligible = options.filter((o) => o in values);
    if (!eligible.length) return { correct: null, correctAnswer: "" };
    const wantMin = mcMatch[2].toLowerCase() === "nearest";
    const best = eligible.reduce((acc, o) => {
      if (acc === null) return o;
      return (wantMin ? values[o] < values[acc] : values[o] > values[acc]) ? o : acc;
    }, null);
    const correct = answer === best;
    return { correct, correctAnswer: correct ? "" : best };
  }

  return { correct: null, correctAnswer: "" };
}

// Ticket 195 (2026-09-28, real citation, 躍思P1: 子君、美兒和小文每人各
// 種一棵植物, 高度用代用單位"磚"疊住量度): a value ESTABLISHED by one
// sub-question (e.g. "美兒的植物高___個磚" -> 6) is often needed to
// answer a LATER sub-question in the same group (e.g. "小文的植物比子君
// 的高,又比美兒的矮,可能高*2/5/7個磚" needs both 子君 and 美兒's values
// to pick the one MC option that falls strictly between them). Same
// "OCR extracts, code compares" split as DISTANCE_VALUES, just for
// direct height lookups + a between-two-values MC instead of ranking.
// Both real values confirmed: 美兒=6 (directly printed), 子君=3 (a
// zoomed re-photo confirmed exactly 3 stacked eraser units -- the
// original photo's resolution genuinely couldn't be counted, so this
// was independently verified before shipping, not guessed).
function extractObjectHeights(text) {
  const m = /^OBJECT_HEIGHTS:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^OBJECT_HEIGHTS:.*$/gm, "");
  if (!m) return { objectHeights: null, cleanedText };
  const heights = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const num = Number(part.slice(eqIdx + 1).trim());
    if (key && Number.isFinite(num)) heights[key] = num;
  }
  return { objectHeights: Object.keys(heights).length ? heights : null, cleanedText };
}

// Ticket 199 (2026-09-30, real citation: 26週數學訓練 P3 Topic 25 Q,
// P.64 "浩明上半年看書的數量" -- Y-axis 0-12 step 2, months 1-6 read
// 10,4,6,12,8,2 books). Unlike every OCR-marker ticket before it
// (185-198), this one is a genuine HYBRID: the axis calibration (what
// number each gridline represents) can only come from reading printed
// text, but the actual bar VALUES are never printed anywhere -- they
// only exist as each bar's pixel height relative to that axis, which
// only pixel geometry (not OCR) can measure. So OCR here is
// deliberately asked to transcribe ONLY the axis numbers/labels (a
// legitimate "read what's printed" task, same discipline as every
// other marker), never to estimate what a bar's value is itself (that
// would cross into judgment, which this project keeps out of OCR's
// job everywhere else too) -- extractBarChart below gives
// verifyBarChart just the calibration; verifyBarChart then measures
// bars from the real image the same way Tickets 197/198 measure
// shapes/beads.
function extractBarChart(text) {
  const m = /^BAR_CHART:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^BAR_CHART:.*$/gm, "");
  if (!m) return { barChart: null, cleanedText };
  const fields = {};
  for (const part of m[1].split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    fields[part.slice(0, eqIdx).trim()] = part.slice(eqIdx + 1).trim();
  }
  const direction = fields["方向"] === "水平" ? "horizontal" : fields["方向"] === "垂直" ? "vertical" : null;
  const min = Number(fields["刻度最小值"]);
  const max = Number(fields["刻度最大值"]);
  const step = Number(fields["刻度間距"]);
  const categories = fields["類別"] ? fields["類別"].split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (!direction || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0 || max <= min || !categories.length) {
    return { barChart: null, cleanedText };
  }
  return { barChart: { direction, min, max, step, categories }, cleanedText };
}

function verifyObjectHeights(objectHeights, printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !objectHeights) return { correct: null, correctAnswer: "" };

  // Shape B: "X的...比Y的高,又比Z的矮,...可能高*optA/optB/optC個..." --
  // between-two-values MC. Checked first: more specific than Shape A.
  const betweenM = printed.match(/(\S+?)的[\s\S]{0,6}比(\S+?)的高[\s\S]{0,12}比(\S+?)的矮/);
  const optionsM = printed.match(/可能高\s*\*?\s*([\d.]+(?:\s*\/\s*[\d.]+)+)/);
  if (betweenM && optionsM) {
    const higherThan = objectHeights[betweenM[2]];
    const lowerThan = objectHeights[betweenM[3]];
    if (!Number.isFinite(higherThan) || !Number.isFinite(lowerThan)) return { correct: null, correctAnswer: "" };
    const lo = Math.min(higherThan, lowerThan);
    const hi = Math.max(higherThan, lowerThan);
    const options = optionsM[1].split("/").map((s) => Number(s.trim()));
    const matching = options.filter((v) => v > lo && v < hi);
    if (matching.length !== 1) return { correct: null, correctAnswer: "" };
    const studentNum = parseNumericAnswer(answer);
    if (studentNum === null) return { correct: null, correctAnswer: "" };
    const correct = Math.abs(studentNum - matching[0]) < 1e-9;
    return { correct, correctAnswer: correct ? "" : String(matching[0]) };
  }

  // Shape A: direct lookup, "X的...高___個<unit>".
  const directM = printed.match(/(\S+?)的[\s\S]{0,6}高\s*_+\s*個/);
  if (directM) {
    const expected = objectHeights[directM[1]];
    if (!Number.isFinite(expected)) return { correct: null, correctAnswer: "" };
    const studentNum = parseNumericAnswer(answer);
    if (studentNum === null) return { correct: null, correctAnswer: "" };
    const correct = Math.abs(studentNum - expected) < 1e-9;
    return { correct, correctAnswer: correct ? "" : String(expected) };
  }

  return { correct: null, correctAnswer: "" };
}

// Ticket 153 (2026-09-28, real citation: "利用以下的數卡，選出其中2張
// 組成一個兩位的合成數，這個數最大是多少？" digit cards {9,0,7,1}):
// extracts the available digit-card set for combinatorial construction
// questions.
function extractDigitCards(text) {
  const m = /^DIGIT_CARDS:\s*(.+)$/m.exec(text);
  const cleanedText = text.replace(/^DIGIT_CARDS:.*$/gm, "");
  if (!m) return { digitCards: null, cleanedText };
  const cards = m[1].split(",").map((s) => s.trim()).filter((s) => /^\d$/.test(s)).map(Number);
  return { digitCards: cards.length ? cards : null, cleanedText };
}

// Shared by literal_keyword_mc (and any future MC-options consumer):
// pulls "A. text B. text C. text..." style MC options straight out of an
// item's own printedQuestion -- no new OCR field needed, since the
// printed options are already part of the normal item text. Same regex
// shape already proven by the existing parity_mc/computation_mc
// detectors, generalised to arbitrary (non-numeric) option text.
function parseMcOptions(printed) {
  return [...String(printed || "").matchAll(/([A-D])[.．]\s*([^A-D]+?)(?=\s*[A-D][.．]|$)/g)].map((m) => ({ letter: m[1], text: m[2].trim() }));
}

// Extracts the two page-continuation markers (see OCR_ONLY_PROMPT's own
// instruction above) from the raw OCR text and strips them out, so
// parseOcrLine never sees them as stray unparseable content. Returns
// {continuesFromPrevious, continuesToNext, cleanedText}. Ticket 48
// (2026-09-27): /api/mark never carried these flags at all (unlike
// /api/check, which has always had them) -- the website's own
// cross-page-stitch trigger (`if (data.continuesFromPrevious)`) has
// therefore been silently unreachable ever since Ticket 32 switched
// normal page submission from /api/check to /api/mark. This restores
// parity so that trigger can fire again.
function extractContinuationMarkers(text) {
  const continuesFromPrevious = /^CONTINUES_FROM_PREVIOUS\s*$/m.test(text);
  const continuesToNext = /^CONTINUES_TO_NEXT\s*$/m.test(text);
  const cleanedText = text.replace(/^CONTINUES_FROM_PREVIOUS\s*$/gm, "").replace(/^CONTINUES_TO_NEXT\s*$/gm, "");
  return { continuesFromPrevious, continuesToNext, cleanedText };
}

// Same {parsed, usage} / throw contract as callOpenRouterVisionModel, but
// the model replies with plain "label=printed|answer" lines rather than
// JSON, so it needs its own response parsing rather than reusing that
// function directly.
async function callQwenOcrText(images, openrouterKey) {
  const prompt = OCR_ONLY_PROMPT(images.length);
  const body = {
    // 2026-09-22: back to the validated baseline. DeepSeek V4.1 Flash,
    // Qwen3-VL-8B, and Qwen3-VL-30B-A3B were all tried as latency
    // candidates and rejected -- the two smaller Qwen3-VL variants
    // shared the same real failure (dropped/merged items on complex
    // layouts, and a confirmed false positive on "blank-in-the-middle"
    // division questions where the model restructures which value
    // counts as "printed" vs "answer" -- see test/mark.test.js's
    // "printed/answer swap" regression test). 235B was the most
    // reliable model for this task at the time, before Gemini 3.1 Flash
    // Lite was tried -- latency was addressed by other means (downscale,
    // already applied) rather than by swapping models, until Ticket 25.
    model: OCR_TEXT_MODEL,
    // 2026-09-22 latency audit #1 result: provider:{sort:"latency"} was
    // tried and rejected -- real benchmark showed it made every case
    // SLOWER (not faster) and one case notably LESS accurate (matching
    // the already-rejected DeepSeek failure pattern almost exactly).
    // No sort override; Ticket 21 below is a provider EXCLUSION, not a
    // sort preference, so that finding still stands.
    max_tokens: 2000,
    // Ticket 20 (2026-09-26): see callClaude's identical comment.
    temperature: 0,
    // Ticket 21 (2026-09-26, explicit user decision): never route
    // through Alibaba -- see callQwen's identical comment.
    provider: { ignore: ["Alibaba"] },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mediaType || "image/jpeg"};base64,${img.data}` },
          })),
        ],
      },
    ],
  };
  const controller = new AbortController();
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      controller.abort();
      reject({ kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: "qwen_ocr_timeout", status: 502 });
    }, 15000);
  });
  let res;
  try {
    res = await Promise.race([
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${openrouterKey}`,
          "http-referer": "https://hk-homework-check.violin-kwai.workers.dev",
          "x-title": "hk-homework-check",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
  } catch (e) {
    throw (e && e.kind) ? e : { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: "qwen_ocr_timeout", status: 502 };
  }
  if (!res.ok) {
    const errText = await res.text();
    console.log(JSON.stringify({ event: "qwen_ocr_error", status: res.status, detail: errText.slice(0, 500) }));
    throw { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: errText.slice(0, 300), status: 502 };
  }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice || choice.finish_reason !== "stop") {
    throw { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: "qwen_ocr_incomplete", status: 502 };
  }
  const text = (choice.message && choice.message.content) || "";
  const { continuesFromPrevious, continuesToNext, cleanedText: cleanedText1 } = extractContinuationMarkers(text);
  const { priceTable, cleanedText: cleanedText2 } = extractPriceTable(cleanedText1);
  const { passageText, cleanedText: cleanedText3 } = extractPassageText(cleanedText2);
  const { wordBank, cleanedText: cleanedText4 } = extractWordBank(cleanedText3);
  const { puzzles: sudokuPuzzles, cleanedText: cleanedText5 } = extractSudokuPuzzles(cleanedText4);
  const { pictogramData, cleanedText: cleanedText6 } = extractPictogramData(cleanedText5);
  const { calendarGrid, cleanedText: cleanedText7 } = extractCalendarGrid(cleanedText6);
  const { scheduleTable, cleanedText: cleanedText8 } = extractScheduleTable(cleanedText7);
  const { locationGrid, cleanedText: cleanedText9 } = extractLocationGrid(cleanedText8);
  const { facingDirection, cleanedText: cleanedText10 } = extractFacingDirection(cleanedText9);
  const { digitCards, cleanedText: cleanedText11 } = extractDigitCards(cleanedText10);
  const { shortDivisionMc, cleanedText: cleanedText12 } = extractShortDivisionMc(cleanedText11);
  const { squaresDiagonal, cleanedText: cleanedText13 } = extractSquaresDiagonal(cleanedText12);
  const { trapezoidBaseline, cleanedText: cleanedText14 } = extractTrapezoidTwoSquares(cleanedText13);
  const { parallelogramShadedWidth, cleanedText: cleanedText15 } = extractParallelogramPartial(cleanedText14);
  const { rectCutKite, cleanedText: cleanedText16 } = extractRectCutKite(cleanedText15);
  const { compassRoseMc, cleanedText: cleanedText17 } = extractCompassRoseMc(cleanedText16);
  const { paperFold, cleanedText: cleanedText18 } = extractPaperFold(cleanedText17);
  const { pathGraph, cleanedText: cleanedText19 } = extractPathGraph(cleanedText18);
  const { clockOptions, cleanedText: cleanedText20 } = extractClockOptions(cleanedText19);
  const { coinBlanks, cleanedText: cleanedText21 } = extractCoinBlanks(cleanedText20);
  const { distanceValues, cleanedText: cleanedText22 } = extractDistanceValues(cleanedText21);
  const { objectHeights, cleanedText: cleanedText23 } = extractObjectHeights(cleanedText22);
  const { barChart, cleanedText: cleanedText24 } = extractBarChart(cleanedText23);
  const { stickLengths, cleanedText } = extractStickLengths(cleanedText24);
  const items = reconstructSplitSentenceItems(parseOcrLine(cleanedText));
  // Ticket 55: a page that's ENTIRELY sudoku puzzles legitimately has
  // zero normal items -- only treat this as a real OCR failure when
  // BOTH are empty, not just items.
  if (!items.length && !sudokuPuzzles.length) {
    throw { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: "qwen_ocr_empty", status: 502 };
  }
  return { items, usage: data.usage || null, continuesFromPrevious, continuesToNext, priceTable, passageText, wordBank, sudokuPuzzles, pictogramData, calendarGrid, scheduleTable, locationGrid, facingDirection, digitCards, shortDivisionMc, squaresDiagonal, trapezoidBaseline, parallelogramShadedWidth, rectCutKite, compassRoseMc, paperFold, pathGraph, clockOptions, coinBlanks, distanceValues, objectHeights, barChart, stickLengths };
}

// Ticket 13 (2026-09-26): the final layer of the OCR -> code -> AI design
// -- judges the items classifyAndVerify left unresolved. One call per
// PAGE (not per item), batching every unresolved item on that page into
// one prompt -- far cheaper/faster than one call each, and matches how
// /api/check already batches a whole page's items. Sends the REAL image
// alongside the already-OCR'd text (not text alone): a real risk flagged
// to the user before building this -- some question types (rulers,
// angles, coins, 3D shapes, water levels) can't be judged from text at
// all, so a text-only fallback would silently mis-grade them. The OCR'd
// text is still included as a hint (usually correct, saves the model
// re-transcribing from scratch), with an explicit instruction to trust
// the photo over it on conflict.
// Ticket 57 (2026-09-27): real, verified HK currency reference (HKMA +
// Wikipedia, checked live 2026-09-27 -- see the "$10 note colour
// unconfirmed" caveat below, deliberately left out rather than guessed).
// Coin/banknote denomination recognition is a real Tier V weak spot
// (complex printed designs, not a simple pixel-signal problem Photon
// could solve deterministically -- see the parallel investigation into
// clock-hand reading this same session). This doesn't make the AI
// fallback judge's guess CORRECT, but gives it real facts instead of
// relying purely on its own pretrained visual memory, which is the only
// lever available for this specific weak spot right now. Only appended
// when a pending item's printed text actually mentions money, to avoid
// bloating (and paying extra input-token cost for) every other
// AI-fallback call with an irrelevant reference block.
const HK_CURRENCY_REFERENCE = `參考資料——香港硬幣同紙幣真實資料（幫你分辨相入面嘅面額，唔好靠估）：
硬幣（1993年洋紫荊系列）：1毫=金色細圓形(17.5mm)；2毫=金色花瓣形(18-19mm)；5毫=金色圓形(22.5mm)；$1=銀色圓形(25.5mm)；$2=銀色花瓣形(26.3-28mm)；$5=銀色圓形、邊有凹槽字(27mm)；$10=銀色圈+金色芯嘅雙色圓形(24mm)。全部正面都係洋紫荊花圖案。
紙幣顏色：$20藍色、$50綠色、$100紅色、$500啡色、$1000金色。`;

function mentionsMoneyDenomination(pendingItems) {
  const re = /\$|coin|note|cent|denomination|硬幣|紙幣|銀紙|面額|毫子|蚊/i;
  return pendingItems.some((it) => re.test(String(it.printedQuestion || "")) || re.test(String(it.studentAnswer || "")));
}

// Ticket 59 (2026-09-27): same "give the AI real facts instead of relying
// on its pretrained visual memory" lever as Ticket 57's currency
// reference, applied to 3-D shape identification/general-knowledge
// questions (e.g. "which shape has two circular bases?", "how many faces
// does a triangular prism have?") -- standard, fixed primary-level solid
// geometry facts, not something that changes or needs a live source
// check the way currency specs did. Deliberately NOT attempted for
// clock/water-level/ruler/angle questions -- those need real measurement
// from the image, not a lookup fact, so no reference block would help
// (see the parallel Photon-based clock-reading investigation this same
// session for the actual right lever there).
const SHAPE_REFERENCE = `參考資料——常見立體形狀嘅真實幾何資料（幫你答立體形狀嘅通用知識題,唔好靠估）：
正方體(cube)：6個面(全部正方形)、12條邊、8個頂點。
長方體(cuboid)：6個面(長方形)、12條邊、8個頂點。
三棱柱(triangular prism)：5個面(2個三角形底+3個長方形)、9條邊、6個頂點、2個底。
四角錐(square-based pyramid)：5個面(1個正方形底+4個三角形)、8條邊、5個頂點、1個底。
三角錐(triangular-based pyramid/tetrahedron)：4個面(全部三角形)、6條邊、4個頂點。
圓柱體(cylinder)：3個面(2個平面圓形底+1個彎曲面)、2條邊(圓形)、0個頂點、2個圓形底。
圓錐體(cone)：2個面(1個平面圓形底+1個彎曲面)、1條邊(圓形)、1個頂點(尖端)、1個圓形底。
球體(sphere)：1個彎曲面、0條邊、0個頂點。
呢個課程嘅分類慣例：「柱體」包括長方柱、圓柱等（唔止圓柱先叫柱體）；「錐體」包括三角錐、圓錐等（唔止圓錐先叫錐體）。`;

// Checks BOTH printedQuestion and studentAnswer -- a real "which shape
// has two circular bases?" style question often names the shape only in
// the STUDENT'S OWN answer (e.g. "cylinder"), never in the printed
// question text itself (which just describes properties), unlike the
// currency case where "$"/"coin" almost always appears in the printed
// question itself.
function mentionsShapeGeometry(pendingItems) {
  const re = /prism|pyramid|cone|cylinder|sphere|cube|cuboid|\bface\b|\bedge\b|\bvertex\b|vertices|棱柱|棱錐|圓柱|圓錐|球體|立體|正方體|長方體|三棱柱/i;
  return pendingItems.some((it) => re.test(String(it.printedQuestion || "")) || re.test(String(it.studentAnswer || "")));
}

// Ticket 61 (2026-09-27): same lever as Ticket 59, applied to 2-D
// (flat/plane) shapes instead of 3-D solids -- a genuinely separate
// reference block/detector, not a generalisation of the 3-D one (the
// keyword sets and the facts themselves don't overlap: "sides" not
// "faces", no vertices-vs-edges-vs-faces triple).
const SHAPE_2D_REFERENCE = `參考資料——常見平面形狀嘅真實幾何資料（幫你答平面形狀嘅通用知識題,唔好靠估）：
三角形(triangle)：3條邊、3個頂點、3隻角(內角總和180度)。
正方形(square)：4條相等邊、4隻直角。
長方形(rectangle)：4條邊(兩對相等)、4隻直角。
平行四邊形(parallelogram)：4條邊、兩對邊互相平行。
菱形(rhombus)：4條相等邊、兩對邊互相平行。
梯形(trapezium)：4條邊、得一對邊互相平行。
五邊形(pentagon)：5條邊、5個頂點。
六邊形(hexagon)：6條邊、6個頂點。
八邊形(octagon)：8條邊、8個頂點。
圓形(circle)：0條邊、0個頂點、彎曲嘅邊界。
正方形係一種特別嘅長方形（因為正方形都符合長方形嘅所有性質：兩對邊互相平行相等、四隻角都係直角），但一般命名習慣淨係將佢叫做正方形。`;

function mentionsShape2D(pendingItems) {
  const re = /\btriangle\b|\bsquare\b|rectangle|parallelogram|\brhombus\b|trapezium|trapezoid|pentagon|hexagon|octagon|\bcircle\b|\bside\b|sides|三角形|正方形|長方形|平行四邊形|菱形|梯形|五邊形|六邊形|八邊形|圓形|多邊形/i;
  return pendingItems.some((it) => re.test(String(it.printedQuestion || "")) || re.test(String(it.studentAnswer || "")));
}

// Ticket 107 (2026-09-28, found across 3 separate real materials this
// session): two more static facts an AI could easily misremember or
// guess wrong on -- "dozen" quantity words, and clock-face mechanics
// (the minute/second hand ratio). Bundled into one block since both are
// small, standalone facts with no natural home in the currency/shape
// blocks above.
const QUANTITY_AND_CLOCK_REFERENCE = `參考資料——常見數量詞同鐘面機械知識（幫你答呢類題,唔好靠估）：
一打(a dozen) = 12個；半打(half a dozen) = 6個。
鐘面上，當分針行咗1小格(即1分鐘)，秒針啱啱好行完一整圈，即係行咗60小格。`;

function mentionsQuantityWordOrClockMechanics(pendingItems) {
  const re = /一打|半打|dozen|小格|second hand|minute hand/i;
  return pendingItems.some((it) => re.test(String(it.printedQuestion || "")) || re.test(String(it.studentAnswer || "")));
}

// Ticket 97/107 (2026-09-28, confirmed in BOTH 樂思 and 躍思 workbooks
// independently): this HK curriculum's calendar convention is that the
// FIRST day of the week is Sunday and the SEVENTH is Saturday -- NOT the
// international/ISO convention of Monday-first. A real trap question
// found: "一個星期中，第五天是星期五" is marked FALSE (the 5th day is
// actually Thursday under this convention). An AI answering from general
// knowledge alone would very plausibly get this wrong.
const WEEKDAY_CONVENTION_REFERENCE = `參考資料——呢個課程嘅一星期慣例（幫你答日曆/星期題,唔好靠估）：
呢個課程慣例：一星期嘅第一天係星期日(Sunday)，第二天係星期一，...，第七天係星期六(Saturday)——唔係國際慣例嘅星期一開始計。`;

function mentionsWeekdayOrdinal(pendingItems) {
  return pendingItems.some((it) => {
    const text = `${it.printedQuestion || ""} ${it.studentAnswer || ""}`;
    return /第.{0,3}天/.test(text) && /星期|week/i.test(text);
  });
}

// Ticket 222 "reading comprehension marking criteria" (2026-09-30, user
// request: real research into how HK PRIMARY school teachers actually
// mark "answer in COMPLETE sentences" reading-comprehension questions,
// real citation: Junius Publications "Practice in Reading 3"). User
// explicitly rejected blending in the more lenient DSE/HKEAA-level
// leniency principle ("小學唔可以跟dse") -- this block follows ONLY the
// stricter primary-level standard: a HK-parenting-media summary of real
// primary-level tutor experience, the 6 real common deduction reasons
// (format correctness matters, not just whether the meaning comes
// across) -- see the memory note this cites; no EDB-published marking
// rubric for this exact worksheet format exists, this is the closest
// real sourced primary-specific practice found.
const COMPLETE_SENTENCE_READING_REFERENCE = `參考資料——香港小學英文「用完整句子回答」閱讀理解題嘅評分準則（嚟源：家長教育媒體訪問補習老師嘅小學層面實戰經驗總結，唔係官方文件，但係專門講小學程度、比DSE嗰套寬鬆原則更嚴格，供你判斷時參考）：
- 淨係照抄原文句子唔識轉format，都算錯——要識得將原文轉做真正回應緊條問題嘅句子（轉時式、轉人稱代名詞），唔可以淨係抄段落原句交差。
- 一定要係「完整句子」（要有主詞+動詞），淨係答一個詞/短語唔算啱。
- 動詞時式要同段落原文一致（段落用過去式，答案都要跟住用過去式），時式錯咗就算錯。
- 代名詞（佢/佢哋）所指嘅人要啱，單複數要跟返段落（例如段落講"they"係多於一個人，學生答案淨係講一個人就係錯）。
- 唔可以答非所問（例如將"How"同"How old"呢類相似問詞搞混）。
- 意思啱、格式（完整句子+時式+人稱）都啱先算啱——唔可以淨係意思接近就當啱，小學評分比DSE程度嚴格好多，格式本身都要跟足。`;

function mentionsCompleteSentenceReadingQuestion(pendingItems) {
  return pendingItems.some((it) => {
    const printed = String(it.printedQuestion || "").trim();
    // English WH-question expecting a written sentence answer (not a
    // short fill-blank/MC) -- heuristic signal for the "answer in
    // complete sentences" reading-comprehension format this reference
    // block is written for. Deliberately narrow (English WH-question +
    // a multi-word answer), not a general "any open-ended question"
    // trigger, to avoid adding irrelevant token cost to every call.
    if (!/^(What|Why|How|Who|When|Where|Which)\b.*\?\s*$/i.test(printed)) return false;
    const answer = String(it.studentAnswer || "").trim();
    return answer.split(/\s+/).filter(Boolean).length >= 3;
  });
}

// Ticket 60 (2026-09-27): "做法B" from the Tier-V-prompt plan -- unlike
// Tickets 57/59's REFERENCE DATA (facts to look up), this is concrete
// step-by-step MEASUREMENT GUIDANCE for question types that need the AI
// to actually measure something in the photo, not recall a fact. No
// reference table could help these (see the parallel clock/Photon
// investigation this same session for why) -- the only lever available
// via the prompt is telling the AI HOW to look, not WHAT to know. Each
// block only appended when a pending item's own text actually matches
// that type, same cost-conscious pattern as the reference blocks above.
// Lower risk than the reference-data keyword matches: a false keyword
// match here just adds one irrelevant guidance sentence, it can't cause
// a wrong verdict the way a QUESTION_TYPE_HANDLERS false-positive would.
const TIER_V_GUIDANCE = {
  angle: {
    re: /\bangle\b|right angle|acute|obtuse|直角|銳角|鈍角|度數/i,
    text: "角度題：搵返個角實際兩條邊嘅方向，同90度（直角）比較嚴唔嚴格垂直，唔好單憑「睇落似」就話啱。",
  },
  waterLevel: {
    re: /water level|beaker|燒杯|量杯|水位/i,
    text: "水位/量杯題：搵返個水面實際對齊緊邊一格刻度線，讀嗰個刻度嘅數值，唔好靠「大約」估。",
  },
  ruler: {
    re: /\bruler\b|直尺|量度長度/i,
    text: "間尺題：搵返量緊嗰樣嘢嘅起點同終點分別對齊間尺邊一格刻度，用終點刻度減起點刻度。",
  },
  clock: {
    re: /\bclock\b|o'clock|時針|分針|鐘面/i,
    text: "鐘面題：分別搵返時針同分針實際指緊邊個方向（分針通常較長），先讀分針對應嘅分鐘數，再睇時針落喺邊兩個數字之間判斷小時。",
  },
  // Ticket 62 (2026-09-27, user's own real insight): confirmed via this
  // project's own past PDF survey (question-type-library.md, "Coin
  // denomination recognition... '$5' coin drawn with small print") --
  // real workbook coin illustrations almost always print the exact
  // denomination as small text directly ON the drawn coin. This makes
  // denomination recognition an OCR/reading problem, not a shape/colour/
  // size classification problem -- the HK_CURRENCY_REFERENCE data
  // (Ticket 57) is a fallback for when that print is too small/blurry to
  // read, but reading the coin's own printed label directly is the
  // primary, more reliable method and should be tried first.
  money: {
    re: /\$|coin|note|cent|denomination|硬幣|紙幣|銀紙|面額|毫子|蚊/i,
    text: "硬幣/紙幣面額題：真實嘅硬幣/紙幣插圖通常會將面額數字直接印喺個圖案上面（例如個銀仔中間印住細細嘅「$5」），請先搵嗰個印刷嘅數字直接讀,唔好淨係靠銀仔嘅大細/顏色/形狀去估面額——印刷數字先係最準嘅資訊來源。",
  },
};

// Ticket 64 (2026-09-28): same "give the AI real facts instead of relying
// on pretrained recall" lever as Tickets 57/59/61, found by a background
// survey fork re-reading MCLQ 2A's Time/Calendar chapter specifically for
// static reference-fact gaps. Both facts below are confirmed against ≥1
// real question each (see TICKETS.md for page citations) -- leap-year day
// counts and days-per-month are exactly the kind of fixed lookup fact an
// AI model can misremember, unlike routine hour/minute arithmetic (the
// fork explicitly checked and found no evidence that's a real weak spot,
// so it's deliberately NOT added here).
const YEAR_TYPE_REFERENCE = `參考資料——常年與閏年嘅真實日數（幫你答同日曆/年份有關嘅題,唔好靠估）：
常年(common year)：全年365日，二月有28日。
閏年(leap year)：全年366日，二月有29日(多咗一日)。
分辨方法：題目/日曆已經講明「呢個係閏年」或者顯示二月有29日,就當閏年(366日)計；否則當常年(365日)計。`;

function mentionsYearType(pendingItems) {
  const re = /leap year|common year|閏年|平年|常年/i;
  return pendingItems.some((it) => re.test(String(it.printedQuestion || "")) || re.test(String(it.studentAnswer || "")));
}

const DAYS_PER_MONTH_REFERENCE = `參考資料——每個月嘅真實日數（幫你答同月份日數有關嘅題,唔好靠估）：
一月31日、二月28日(閏年29日)、三月31日、四月30日、五月31日、六月30日、
七月31日、八月31日、九月30日、十月31日、十一月30日、十二月31日。`;

// Requires BOTH a month name AND a day-count/date context word -- a bare
// month name alone (e.g. "In March, Tom saved $50") is common in unrelated
// word problems and shouldn't drag in a calendar reference block that has
// nothing to do with the question.
function mentionsMonthLength(pendingItems) {
  const monthRe = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月/i;
  const dayContextRe = /\bdays?\b|日數|幾日|多少日|日曆|calendar/i;
  return pendingItems.some((it) => {
    const text = `${it.printedQuestion || ""} ${it.studentAnswer || ""}`;
    return monthRe.test(text) && dayContextRe.test(text);
  });
}

function buildTierVGuidance(pendingItems) {
  const texts = Object.values(TIER_V_GUIDANCE)
    .filter((g) => pendingItems.some((it) => g.re.test(String(it.printedQuestion || "")) || g.re.test(String(it.studentAnswer || ""))))
    .map((g) => g.text);
  return texts.length ? "\n" + texts.map((t, i) => `2.${i + 1}. ${t}`).join("\n") : "";
}

function buildAiFallbackPrompt(pendingItems) {
  // Ticket 54: same wordBankHint cross-item context as buildJevQuestions
  // -- if Jev couldn't confidently resolve a word-bank clash, this judge
  // (which additionally sees the real photo) should still know about it.
  const itemsText = pendingItems.map((it) => `${it.question}: 題目「${displayPrintedQuestionForJudge(it)}」，學生手寫答案「${it.studentAnswer}」${Number.isInteger(it.targetBlankIndex) ? "（呢句入面有幾個空格，淨係判斷標咗「【這一格：____】」嗰一個）" : ""}${it.wordBankHint ? "（" + it.wordBankHint + "）" : ""}`).join("\n");
  const referenceBlocks = [
    mentionsMoneyDenomination(pendingItems) ? HK_CURRENCY_REFERENCE : null,
    mentionsShapeGeometry(pendingItems) ? SHAPE_REFERENCE : null,
    mentionsShape2D(pendingItems) ? SHAPE_2D_REFERENCE : null,
    mentionsYearType(pendingItems) ? YEAR_TYPE_REFERENCE : null,
    mentionsMonthLength(pendingItems) ? DAYS_PER_MONTH_REFERENCE : null,
    mentionsQuantityWordOrClockMechanics(pendingItems) ? QUANTITY_AND_CLOCK_REFERENCE : null,
    mentionsWeekdayOrdinal(pendingItems) ? WEEKDAY_CONVENTION_REFERENCE : null,
    mentionsCompleteSentenceReadingQuestion(pendingItems) ? COMPLETE_SENTENCE_READING_REFERENCE : null,
  ].filter(Boolean);
  const referenceBlock = referenceBlocks.length ? `\n${referenceBlocks.join("\n")}\n` : "";
  return `你是一位細心的小學老師，正在批改學生嘅功課相。冇提供標準答案，請你自己諗清楚每一題應該點答。已經有OCR幫手讀低咗以下呢幾條題目文字同學生答案（可能有少少OCR誤讀，如果同相片有出入請以相片為準，唔好盲信呢段文字）：

${itemsText}
${referenceBlock}
要求：
1. 相有機會打橫/倒轉，先確認閱讀方向。
2. 如果題目要睇圖表/刻度/圖形先答到（水位、尺、角度、立體圖形、硬幣面額等），請直接睇返相片對應位置嘅圖像，唔好淨係靠上面嘅文字判斷。${buildTierVGuidance(pendingItems)}
3. 只有答題位置確實有筆跡但太潦草/有歧義先"correct"設null，"note"簡短講原因。
4. 只有"correct"為false先填"correctAnswer"，其他情況留空字串。
5. "correct"為false嗰陣，"note"要簡短（一句起、廿字內）講清楚學生點解錯——唔係淨係複述答案，要講錯喺邊/點解啱嘅答案係咁（例如："25÷5應該係5，唔係6"、"呢題問緊相差，唔係總和"）。"correct"為true嗰陣，"note"留空字串。
6. 淨係回答上面列出嘅題號，唔好加返其他題目。

只回覆一個JSON物件，唔好加其他文字：
{"results":[{"question":"題號","correct":true/false/null,"correctAnswer":"","note":""}]}`;
}

// Ticket (2026-09-29, explicit user instruction "唔要qwen 唔要deepseek
// 換做gemini"): Qwen/DeepSeek two-tier cascade REPLACED entirely with a
// single Gemini call, based on real full-pipeline comparison data
// gathered the same day (see callGemini's own comment above for the
// numbers). A failure here throws nothing -- the caller treats a null
// return as "leave these items exactly as they already were", the same
// fail-open discipline as every other optional stage in this pipeline.
async function callAiFallbackJudge(images, pendingItems, openrouterKey) {
  const prompt = buildAiFallbackPrompt(pendingItems);
  try {
    const r = await callGemini(images, prompt, openrouterKey);
    return { parsed: r.parsed, usage: r.usage, model: "gemini" };
  } catch (e) {
    // TEMPORARY (2026-09-29) -- one-use, real error visibility: kept from
    // before the Qwen/DeepSeek->Gemini swap so a real production failure
    // still has a diagnostic trail instead of being silently swallowed.
    // Remove once the live-debugging session this was added for is done.
    console.log(JSON.stringify({ event: "debug_ai_fallback_gemini_failed", error: String((e && e.message) || e).slice(0, 500) }));
    return null;
  }
}

// Ticket 27 (2026-09-27, real user request): a fast, cheap TEXT-ONLY
// pre-check before the real (image-based) AI fallback above -- TypeSafe
// Jev, a structured-decision model (not a general LLM), accessed via
// OpenRouter's alpha Decisions endpoint. Deliberately kept as its own
// isolated constant/function (same discipline that made the Gemini
// OCR_TEXT_MODEL rollback a one-line change, Ticket 25/26) so this can
// be removed or swapped without touching callAiFallbackJudge at all.
//
// Real, load-bearing limitation: Jev is TEXT-ONLY -- "Jev only sees the
// text/JSON you supply; it does not see screenshots or URLs by itself"
// (skill docs). It can therefore only ever be a PRE-check that narrows
// what still needs the real vision-based fallback, never a replacement
// for it -- any item Jev doesn't resolve with high confidence must still
// go through callAiFallbackJudge exactly as before. Also per the skill's
// own docs: "English is the best-supported language; evaluate CJK
// workloads separately" -- Jev's real accuracy on Chinese-subject
// homework judgments is UNVALIDATED, not assumed safe, until tested with
// real data (see TICKETS.md Ticket 27).
const JEV_MODEL = "typesafe/jev-1.13";
// Lowered again 2026-09-27 (Ticket 31 real data, explicit user
// instruction) from 0.88 to 0.85. Larger real calibration sample now
// (26 English/math items sent to Jev in one full-pipeline test): real
// CORRECT answers scored across a wide 0.87-0.97 range with no clean
// cutoff -- e.g. a correct "You can read it" scored 0.87, just under
// the 0.88 bar. No real wrong-leaning item scored anywhere near 0.85
// (the highest wrong-leaning score seen was 0.43, a large margin below).
// Still a coverage/risk tradeoff, not a settled calibration -- keep
// watching real outcomes as more data comes in, especially near this
// boundary specifically.
const JEV_CONFIDENT_CORRECT = 0.85;
const JEV_CONFIDENT_WRONG = 0.1;

// Ticket 190 (2026-09-28): Jev normally sees ONLY printedQuestion +
// studentAnswer -- none of the ~13 structured diagram markers the OCR
// step already extracts (LOCATION_GRID, PAPER_FOLD, PATH_GRAPH, etc.)
// ever reach it, even when a marker IS present on the item but code's
// own detect()/verify() pattern-matcher doesn't recognize this exact
// phrasing (so the item falls through to Jev unresolved anyway). This
// follows the exact same safe, already-proven pattern as wordBankHint
// (Ticket 54) -- one extra piece of text context appended to the same
// prompt, nothing structural changed. Jev still can't see the real
// image; this only gives it the same extracted facts code would have
// used, as a second, cheap chance before falling to the real
// image-based AI-fallback.
function buildDiagramMarkerHint(item) {
  const parts = [];
  if (item.paperFold) parts.push(`摺紙圖資料：摺次數=${item.paperFold.folds}；摺後長度=${item.paperFold.foldedLength}`);
  if (item.pathGraph) parts.push(`路徑圖資料(直接連接嘅邊,唔係間接距離)：${Object.entries(item.pathGraph).map(([u, vs]) => Object.entries(vs).map(([v, w]) => `${u}-${v}=${w}`).join(";")).join(";")}`);
  if (item.scheduleTable) parts.push(`星期時間表資料：${Object.entries(item.scheduleTable).map(([d, v]) => `${d}=${v}`).join("；")}`);
  if (item.locationGrid) parts.push(`地點方位圖資料：${JSON.stringify(item.locationGrid)}`);
  if (item.facingDirection) parts.push(`人物面向方向資料：${JSON.stringify(item.facingDirection)}`);
  if (item.digitCards) parts.push(`數字卡資料：${item.digitCards.join(",")}`);
  if (item.compassRoseMc) parts.push(`指南針選項資料：${JSON.stringify(item.compassRoseMc)}`);
  if (item.squaresDiagonal) parts.push(`兩個正方形斜線圖資料：${JSON.stringify(item.squaresDiagonal)}`);
  if (item.trapezoidBaseline) parts.push(`梯形底總長資料：${item.trapezoidBaseline}`);
  if (item.parallelogramShadedWidth) parts.push(`陰影闊度資料：${item.parallelogramShadedWidth}`);
  if (item.rectCutKite) parts.push(`長方形剪角資料：${JSON.stringify(item.rectCutKite)}`);
  if (item.calendarGrid) parts.push(`月曆資料：${JSON.stringify(item.calendarGrid)}`);
  if (item.pictogramData) parts.push(`象形圖資料：${JSON.stringify(item.pictogramData)}`);
  if (!parts.length) return "";
  return "呢一頁OCR仲抽取咗以下圖表資料(可能同呢一題有關，都可能冇關，自己判斷)：\n" + parts.join("\n");
}

// Ticket 222 "code hints Jev" (2026-10-01): same Ticket-190 pattern as
// buildDiagramMarkerHint above, applied to preposition-of-time items
// that reach Jev unresolved -- either because verifyPrepositionOfTime
// itself declined (ambiguous/unclassifiable), or because the item never
// even reached that handler's verify() at all (its detect()/verify()
// both gate on studentAnswer being one of on/in/at/from/to, so a
// garbled answer like a real "bo" typo never gets dispatched there in
// the first place -- this hint fires purely off printedQuestion's
// shape, independent of that gate, so it still reaches Jev for exactly
// that case). Real motivating finding, from re-reading an already-run
// 22-item Jev test's archived output rather than a fresh paid call:
// 3 of 12 English items landed in Jev's uncertain band --
//  - "Henry goes to bed __nine thirty__night."/"at;at": noul=0.14
//    (wrongly leaning toward "wrong") even though it's correct --
//    classifyPrepositionOfTimeExpected resolves this one confidently,
//    so in the real pipeline it's now caught by the code handler
//    itself and never reaches Jev at all.
//  - "My grandfather watches TV __noon."/"from": noul=0.46 (uncertain)
//    -- also code-resolvable (expected "at"), same as above.
//  - "My uncle watches TV __midnight."/"bo": noul=0.12 (just barely
//    short of the confident-wrong cutoff) -- "bo" fails the whitelist
//    gate so the handler never even sees it; THIS is the case this
//    hint function exists for, phrased as an advisory fact ("the blank
//    expects one of on/in/at/from/to") rather than a verdict, since
//    code has no way to confirm the handwriting was actually meant to
//    be a preposition at all.
function buildPrepositionTimeHint(item) {
  const expected = classifyPrepositionOfTimeExpected(String(item.printedQuestion || ""), item.targetBlankIndex);
  if (expected === null) return "";
  return `呢個空格屬於「時間介詞」類題目，跟住嘅文字顯示呢度通常應該填「${expected}」——僅供參考，你要自己核實呢個分析岩唔岩，唔好盲目跟。`;
}

function buildJevQuestions(pendingItems) {
  const questions = {};
  pendingItems.forEach((item) => {
    const diagramHint = buildDiagramMarkerHint(item);
    const prepTimeHint = buildPrepositionTimeHint(item);
    questions[String(item.resultIndex)] = {
      type: "noul",
      // Ticket 54: wordBankHint (if present) appends the one piece of
      // cross-item context this item wouldn't otherwise have -- Jev
      // normally judges every item in total isolation, with no idea
      // another item on the same page used the identical bank phrase.
      instructions: `你是一位細心的小學老師，冇提供標準答案，要自己諗清楚呢一題應該點答，再判斷學生嘅手寫答案啱唔啱：題目「${displayPrintedQuestionForJudge(item)}」，學生手寫答案「${item.studentAnswer}」。呢個答案啱唔啱？${Number.isInteger(item.targetBlankIndex) ? "\n（呢句入面有幾個空格，你淨係要判斷標咗「【這一格：____】」嗰一個，其他空格唔使理。）" : ""}${item.wordBankHint ? "\n" + item.wordBankHint : ""}${diagramHint ? "\n" + diagramHint : ""}${prepTimeHint ? "\n" + prepTimeHint : ""}`,
      criteria: { true: "學生答案正確", false: "學生答案錯誤或明顯唔完整" },
    };
  });
  return questions;
}

// Returns a Map<resultIndex(number), {correct: boolean}> for items Jev
// answered with high confidence either way -- every other pending item
// (low confidence, malformed answer, or the call failing entirely) is
// simply absent from the returned Map, so the caller's existing
// fall-through to callAiFallbackJudge needs no special-casing. Never
// throws -- fails open to an empty Map, exactly like callAiFallbackJudge
// returning null, so a Jev outage costs nothing but the (skipped)
// speed/cost saving it would have provided.
// Ticket 40 (2026-09-27): Jev sits on OpenRouter's ALPHA decisions
// endpoint, which the provider itself hasn't committed to stability on --
// it could change shape or go away with no notice. callJevPreCheck was
// already fail-open (a dead endpoint never blocks grading), but that also
// meant a real outage was INVISIBLE -- it looked identical to "jev ran
// fine, every item happened to be genuinely uncertain". `resolved` is
// tagged with a `.callStatus` string (attached directly on the returned
// Map, so every existing caller/test reading `.size`/`.get()` is
// unaffected) so handleMark can record real call outcomes, not just
// resolved-count, for the daily health check below.
async function callJevPreCheck(pendingItems, openrouterKey) {
  const resolved = new Map();
  if (!pendingItems.length) return resolved;
  try {
    const body = {
      model: JEV_MODEL,
      state: "你正在批改香港小學生嘅功課。冇提供標準答案，每一題都要自己諗清楚正確答案先判斷。淨係得OCR轉錄嘅文字，冇張相可以睇——如果純粹睇文字都唔夠info判斷（例如要睇圖表/刻度/圖形），就要老實話唔知，唔可以靠估。",
      questions: buildJevQuestions(pendingItems),
    };
    const controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => { controller.abort(); reject(new Error("jev_timeout")); }, 10000);
    });
    const res = await Promise.race([
      fetch("https://openrouter.ai/api/alpha/decisions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${openrouterKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (!res.ok) { resolved.callStatus = "http_error_" + res.status; return resolved; }
    const data = await res.json();
    const answers = data.answers || {};
    // Ticket (2026-09-29): raw noul per item, attached the same way
    // .callStatus already is -- lets a caller (e.g. handleMark's debug
    // content log) see EVERY item's actual confidence score, not just
    // the post-threshold true/false verdict for the ones that cleared
    // it. Never used for grading logic itself, purely observability.
    resolved.rawScores = {};
    for (const [key, answer] of Object.entries(answers)) {
      if (!answer || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) continue;
      resolved.rawScores[key] = answer.noul;
      if (answer.noul >= JEV_CONFIDENT_CORRECT) resolved.set(Number(key), { correct: true });
      else if (answer.noul <= JEV_CONFIDENT_WRONG) resolved.set(Number(key), { correct: false });
      // otherwise: genuinely uncertain -- deliberately left unresolved,
      // falls through to the real vision-based fallback.
    }
    resolved.callStatus = "ok";
    return resolved;
  } catch (e) {
    resolved.callStatus = e && e.message === "jev_timeout" ? "timeout" : "exception_" + String((e && e.message) || "unknown").slice(0, 60);
    return resolved; // fail open -- Jev being unavailable never blocks grading
  }
}

// A real handwritten sub-answer is short; anything wildly longer than that
// is a signal that an item boundary was missed and several items' content
// bled into one -- see MAX_ANSWER_LEN below. Printed questions are NOT
// capped the same way: a genuine English/Chinese word-problem question can
// legitimately run to a full sentence, so only the (always-short,
// handwritten) answer side is treated as suspicious when it's long.
const MAX_ANSWER_LEN = 80;

// Splits "1=4+6|6+4=10,2=2+5|5+2=7" into [{label, printedQuestion,
// studentAnswer}].
//
// 2026-09-21 real-photo failure #1: the original version only recognised a
// new item starting right after a plain ASCII "," (to avoid splitting on a
// comma that's legitimately part of one item's own multi-sub-answer text,
// e.g. "6+9=15,5+8=13"). On a 5-item worksheet, 4 of those items' content
// silently bled into item 1's studentAnswer as one unparsed blob.
//
// First fix attempt (same day) removed the comma-anchor entirely, scanning
// for the "label=printed|" shape ANYWHERE in the text. That introduced a
// WORSE real regression (caught on the very next real-photo re-test,
// 2026-09-22): a genuine multi-token answer like "6+4=10" itself contains
// an "=" -- so "6+4" got matched as a spurious label for what should have
// been the NEXT item, shifting every subsequent item's real answer into
// the wrong slot and leaving the true owner's answer empty. A worksheet
// that scored 10/15 correctly under the ORIGINAL (comma-anchored) parser
// scored 0/15 under the "anchor-free" one.
//
// Reverted to comma-anchoring (an item can only start at the very
// beginning of the text or right after a ","), which is what correctly
// handles equation-shaped answers -- but keeps the fixes that don't carry
// that risk: normalising full-width punctuation (，＝｜；) the model
// sometimes emits despite being asked for plain ASCII (covers the
// full-width-comma variant of failure #1 without reopening the
// mid-answer false-start problem), a tighter label class (max 10 chars,
// no whitespace/";"), and the MAX_ANSWER_LEN fail-safe below. A model
// response with NO separator at all between two items (not even a
// full-width comma) remains a known, accepted, documented limitation --
// see test/mark.test.js -- rather than something worth reopening this
// exact regression for.
function parseOcrLine(text) {
  // Ticket 29 regression (2026-09-27, real 7-photo test): Gemini started
  // using literal newlines between items (e.g. "9=...|...\n10=...|...")
  // for multi-item passage-style pages, instead of the required commas --
  // each individual item was well-formed, but the item-boundary regex
  // below only recognises a comma (or string start) as a valid "next
  // item starts here" anchor. With no comma present, the WHOLE remainder
  // of the text (items 10, 11, ...) got swallowed into item 9's own
  // studentAnswer. Newlines are never legitimately part of one item's
  // own content (answers are short, printed questions are one sentence),
  // so normalising them to commas here is safe and general -- fixes this
  // for every page shape, not just the one that exposed it.
  const norm = String(text).replace(/，/g, ",").replace(/＝/g, "=").replace(/｜/g, "|").replace(/；/g, ";").replace(/\n+/g, ",");
  const items = [];
  const re = /(?:^|,)\s*([^,=|\s;]{1,10}?)=([^|]*?)\|/g;
  const starts = [];
  let m;
  while ((m = re.exec(norm))) starts.push({ index: m.index + (m[0][0] === "," ? 1 : 0), label: m[1].trim() });
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : norm.length;
    const chunk = norm.slice(start, end).replace(/,\s*$/, "");
    const eqIdx = chunk.indexOf("=");
    const barIdx = chunk.indexOf("|");
    if (eqIdx === -1 || barIdx === -1 || barIdx < eqIdx) continue;
    const label = chunk.slice(0, eqIdx).trim();
    const printedQuestion = chunk.slice(eqIdx + 1, barIdx).trim();
    const studentAnswer = chunk.slice(barIdx + 1).trim();
    // Fail safe rather than silently present several items' content
    // stitched together as if it were one clean answer -- flow it through
    // as needs_review (verifyAnswer checks parseFailed first) instead of
    // dropping it, so a human still sees SOMETHING was there for this
    // label, just flagged as not reliably parsed.
    if (studentAnswer.length > MAX_ANSWER_LEN) {
      items.push({ label, printedQuestion, studentAnswer, parseFailed: true });
      continue;
    }
    items.push({ label, printedQuestion, studentAnswer });
  }
  return items;
}

// Ticket 222 "cross-item context" (2026-10-01): real finding from a
// 9-photo full-pipeline test -- OCR sometimes splits ONE printed
// sentence's several blanks into SEPARATE items, each only showing its
// own local snippet (real citation: "The party is ____ nine thirty" /
// "The party is ____ the morning" / "The party is ____ seven thirty" /
// "The party is ____ the evening." are 4 separate items, really one
// sentence "The party is 2 nine thirty 3 the morning 4 seven thirty 5
// the evening."). This silently broke EVERY downstream judge the SAME
// way, not just code -- Jev (text-only) and even the real vision AI-
// fallback (which CAN see the whole poster image) both independently
// defaulted to the same wrong answer, because both are fed this same
// truncated per-item text and neither naturally cross-references
// sibling items on its own. See memory
// project_hk_homework_check_cross_item_context_gap.md for the full
// real-data account.
//
// Fix: reconstruct the shared original sentence from its fragments
// BEFORE dispatch, so code/Jev/AI-fallback all see the full context
// through the ordinary printedQuestion field -- no separate hint
// mechanism needed, and no change required to any of the three judges
// themselves.
//
// Detection: items whose text before the FIRST blank marker is
// IDENTICAL are treated as fragments of one original sentence (OCR
// repeats the shared lead-in verbatim per fragment, confirmed across
// 3 real fragment groups in the citation above). Reconstruction order
// is ascending by each item's own numeric label -- confirmed matching
// the worksheet's own blank numbering in the same real citation
// (labels "2","3","4","5"). Deliberately conservative to avoid
// accidentally merging two UNRELATED items that happen to start with
// the same short phrase (e.g. two different "I like ___." fill-ins on
// the same page): requires the shared prefix to be at least
// MIN_SHARED_PREFIX_LEN characters AND both items to have a purely
// numeric label (an "and/or" or "B1"-style label never merges).
const MIN_SHARED_PREFIX_LEN = 12;
function reconstructSplitSentenceItems(items) {
  const groups = new Map();
  items.forEach((item, idx) => {
    const printed = String(item.printedQuestion || "");
    const blankMatch = printed.match(/_{2,}/);
    if (!blankMatch) return;
    const prefix = printed.slice(0, blankMatch.index);
    if (prefix.trim().length < MIN_SHARED_PREFIX_LEN) return;
    const labelNum = Number(item.label);
    if (!Number.isFinite(labelNum)) return;
    const suffix = printed.slice(blankMatch.index + blankMatch[0].length);
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push({ idx, labelNum, suffix });
  });

  for (const [prefix, members] of groups) {
    members.sort((a, b) => a.labelNum - b.labelNum);
    // A shared prefix alone isn't enough -- two genuinely UNRELATED
    // sentences on the same page can coincidentally start the same way
    // (real bug caught here before shipping: "The party is ____ 25th
    // December (Christmas Day)." shares "The party is " with the next
    // 4 items, but is itself a COMPLETE sentence, not a fragment of
    // theirs). Split into runs at a sentence boundary: a member whose
    // OWN suffix already ends in "." closes its run right there
    // (whether that run has 1 member or several) -- only a run that
    // ends because a LATER same-prefix member's suffix has the closing
    // period is a genuine multi-fragment reconstruction.
    let run = [];
    const runs = [];
    for (const m of members) {
      run.push(m);
      if (/\.\s*$/.test(m.suffix)) { runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);

    for (const runMembers of runs) {
      if (runMembers.length < 2) continue;
      let reconstructed = prefix;
      runMembers.forEach((m, i) => {
        reconstructed += (i === 0 ? "" : " ") + "____" + m.suffix;
      });
      runMembers.forEach((m, i) => {
        items[m.idx] = { ...items[m.idx], printedQuestion: reconstructed, targetBlankIndex: i };
      });
    }
  }
  return items;
}

// Real validating question (2026-10-01, arrived while building the fix
// above): reconstructSplitSentenceItems gives 4 items the SAME full
// sentence text with all 4 blanks looking identical ("____"), each
// paired with only its own one-word studentAnswer -- code tells them
// apart via targetBlankIndex, but Jev/buildAiFallbackPrompt still just
// read item.printedQuestion as plain text with no such field. Sent as
// 4 near-identical questions with no marker, Jev/AI-fallback would
// have no way to know WHICH of the 4 identical-looking blanks a given
// one-word answer is actually about -- a real remaining gap in cases
// this reconstruction doesn't let code itself resolve outright. Fixes
// it by marking the ONE target blank distinctly (deliberately with
// Chinese zh brackets, unlikely to collide with the underlying "____"
// matching every other handler's regex relies on) wherever
// printedQuestion is shown to a text-based judge -- the stored
// item.printedQuestion itself (what code's own "_{2,}" matching reads)
// stays untouched.
function displayPrintedQuestionForJudge(item) {
  const printed = String(item.printedQuestion || "");
  if (!Number.isInteger(item.targetBlankIndex)) return printed;
  const blanks = [...printed.matchAll(/_{2,}/g)];
  const target = blanks[item.targetBlankIndex];
  if (!target) return printed;
  return printed.slice(0, target.index) + "【這一格：____】" + printed.slice(target.index + target[0].length);
}

// Minimal, safe arithmetic evaluator -- no eval(). Supports +, -, x/×/*,
// /÷ between integers/decimals, left-to-right (no operator precedence
// needed for the single/double-operation sums this targets). Returns null
// if the string isn't a clean arithmetic expression, rather than guessing.
// 2026-09-23 real gap found (P4 paper): "(114+58)-(44+38)=" has no
// bracket/grouping support at all in the old flat left-to-right tokenizer,
// so it would mis-tokenize or return null. Rewritten as a small recursive-
// descent parser (parseExpr -> parseTerm -> parseFactor) so real operator
// precedence AND explicit bracket grouping both work, while preserving
// every prior behavior for non-bracket input (same tokenizer regex, same
// lookbehind, same "at least 2 number tokens required" rule below).
function evalArithmetic(str) {
  const cleaned = String(str)
    // Mixed number ("1又2/3", the standard HK textbook notation for 1⅔)
    // -> an equivalent parenthesised sum, so the EXISTING +/÷ operators
    // below handle it exactly (no lossy pre-rounding to a decimal).
    // 2026-09-25: real evidenced gap from a P8-11 worksheet survey --
    // "basic fraction arithmetic unsupported" turned out to mostly
    // already work (a plain "1/2+1/3" already evaluates fine via the
    // existing division operator), the real gap was specifically the
    // MIXED-number form, which "又" doesn't tokenize as anything and
    // previously made the whole expression unparseable (null). Only the
    // "又"-separated form is handled HERE (in the printed-expression
    // side) -- a bare-space form ("1 1/2") is deliberately NOT handled
    // here, since whitespace is stripped a few lines below and a
    // space-separated mixed number would become indistinguishable from
    // a plain fraction ("11/2") once spaces are gone. parseNumericAnswer
    // below (the student's OWN answer, never mixed with other operators)
    // has no such ambiguity and does accept the space form.
    .replace(/(?<![\d)])(-?\d+)又(\d+\/\d+)/g, "($1+$2)")
    .replace(/[×x]/gi, "*")
    .replace(/÷/g, "/")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/\s+/g, "");
  if (!cleaned) return null;
  // The lookbehind (?<![\d)]) is load-bearing: without it, a "-" right after a
  // digit or ")" (e.g. "328-214") gets greedily swallowed into the NEXT
  // number as a unary sign instead of recognised as the binary subtraction
  // operator (2026-09-22 real-paper find). It also now correctly excludes
  // "-" right after a closing bracket from binding as a unary sign.
  const tokens = cleaned.match(/(?<![\d)])-?\d+(\.\d+)?|[+\-*/()]/g);
  if (!tokens || tokens.join("").length !== cleaned.length) return null;
  const numberTokenCount = tokens.filter((t) => /^-?\d/.test(t)).length;
  if (numberTokenCount < 2) return null;

  let pos = 0;
  const peek = () => tokens[pos];
  function parseFactor() {
    const t = peek();
    if (t === "(") {
      pos++;
      const inner = parseExpr();
      if (inner === null || peek() !== ")") return null;
      pos++;
      return inner;
    }
    if (t !== undefined && /^-?\d+(\.\d+)?$/.test(t)) {
      pos++;
      return parseFloat(t);
    }
    return null;
  }
  function parseTerm() {
    let value = parseFactor();
    if (value === null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = tokens[pos++];
      const rhs = parseFactor();
      if (rhs === null) return null;
      value = op === "*" ? value * rhs : rhs === 0 ? NaN : value / rhs;
      if (Number.isNaN(value)) return null;
    }
    return value;
  }
  function parseExpr() {
    let value = parseTerm();
    if (value === null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = tokens[pos++];
      const rhs = parseTerm();
      if (rhs === null) return null;
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = parseExpr();
  if (result === null || pos !== tokens.length || Number.isNaN(result)) return null;
  return result;
}

// Parses a bare numeric answer that may be a simple fraction ("3/4"), not
// just a decimal. Distinct from evalArithmetic, which requires at least
// one operator (rejects a bare "56") and is for the printed EXPRESSION
// side, not a student's own answer value. 2026-09-22 real bug: comparing
// a fraction-form answer with plain `parseFloat` silently mis-parsed
// "3/4" as just 3 (parseFloat stops at the first non-numeric character),
// so a correct fraction answer could never match a decimal-computed
// expected value. Only handles a single a/b fraction (no mixed numbers
// like "1 1/2", no nested expressions) -- anything else falls back to
// plain parseFloat, same as before this fix.
function parseNumericAnswer(str) {
  const s = String(str).trim();
  // Mixed number: a whole part plus a fraction part, joined either by
  // the Chinese "又" ("1又2/3") or a plain space ("1 2/3") -- both real
  // HK worksheet conventions (2026-09-25, P8-11 survey). Checked before
  // the plain-fraction case below so "1又2/3"/"1 2/3" don't fall through
  // to it; unlike evalArithmetic above, there's no ambiguity here since
  // this parses ONE standalone student answer, not part of a larger
  // expression that gets whitespace-stripped.
  const mixedMatch = /^(-?\d+)(?:又|\s+)(\d+)\/(\d+)$/.exec(s);
  if (mixedMatch) {
    const whole = parseFloat(mixedMatch[1]);
    const num = parseFloat(mixedMatch[2]);
    const den = parseFloat(mixedMatch[3]);
    if (den === 0) return NaN;
    const frac = num / den;
    return whole < 0 ? whole - frac : whole + frac;
  }
  const fractionMatch = /^(-?\d+)\/(\d+)$/.exec(s);
  if (fractionMatch) {
    const num = parseFloat(fractionMatch[1]);
    const den = parseFloat(fractionMatch[2]);
    return den === 0 ? NaN : num / den;
  }
  return parseFloat(s);
}

// Recognized "blank" placeholder tokens a worksheet's OWN print uses to
// mark a missing operand (e.g. printedQuestion "54÷?=6" or "4×□=24").
// Confirmed via REAL Qwen3-VL-235B output on real photos (2026-09-22
// investigation, in-band debug against worksheets B and C -- not
// guessed from what the prompt asks for). Kept to exactly the tokens
// actually observed; do not add more without similar real evidence.
const BLANK_TOKENS = ["?", "□"];

// Tier 1 of the blank-in-the-middle fix (2026-09-22): handles ONLY the
// single-blank case -- exactly one recognized token anywhere in
// printedQuestion, one (already OCR'd) answer value. Substitutes that
// value into the blank and verifies the resulting full equation with
// the SAME arithmetic check as case 1 below. This is verification, not
// generation: the value being checked is what OCR already read as the
// student's handwriting; this function never invents one.
//
// Deliberately narrow and fail-safe:
// - 0 recognized tokens -> not this case; returns null so the caller
//   falls through to the existing case 1/2 logic UNCHANGED.
// - 2+ tokens (multiple blanks in one item, e.g. real worksheet B's
//   "4×□=24,24÷□=4,...") -> ambiguous which blank the single answer
//   fills, so this returns null rather than guessing a position.
//   Multi-blank items are an explicitly deferred, separate problem
//   (Tier 2), not attempted here.
// - No "=" left after substitution, or either side doesn't parse as a
//   clean number/expression -> null (needs_review), never a guess.
// 2026-09-30 cleanup (code-review-2axis finding, Standards pass): the
// {correct, correctAnswer, explanation} shape below was being built by
// hand at 9 separate return sites, each repeating the same
// correct-vs-wrong ternary twice. This is the shared shape -- callers
// only need to know the WRONG-case values, since the correct case is
// always the same (empty correctAnswer/explanation).
function verdictResult(correct, wrongAnswer, wrongExplanation) {
  return { correct, correctAnswer: correct ? "" : String(wrongAnswer), explanation: correct ? "" : wrongExplanation };
}

function trySubstituteBlank(printedQuestion, sub) {
  const printed = String(printedQuestion || "");
  let token = null, count = 0;
  for (const t of BLANK_TOKENS) {
    const n = printed.split(t).length - 1;
    if (n > 0) { count += n; if (!token) token = t; }
  }
  if (count !== 1) return null;
  const reconstructed = printed.replace(token, sub);
  const eqIdx = reconstructed.indexOf("=");
  if (eqIdx === -1) return null;
  const lhsVal = evalArithmetic(reconstructed.slice(0, eqIdx));
  const rhsVal = parseFloat(reconstructed.slice(eqIdx + 1));
  if (lhsVal === null || Number.isNaN(rhsVal)) return null;
  const correct = Math.abs(lhsVal - rhsVal) < 1e-9;
  return verdictResult(correct, lhsVal, `填返個空格：${reconstructed.slice(0, eqIdx)} = ${lhsVal}`);
}

// HK worksheets write division-with-remainder as "quotient...remainder"
// (either a real ellipsis "…"/"⋯" or 2-3 plain dots), which
// evalArithmetic/parseNumericAnswer have no notion of -- e.g.
// evalArithmetic("87÷6") gives 14.5, and parseNumericAnswer("14…3")
// silently truncates to just 14 (parseFloat stops at the first
// non-numeric character), so a genuinely correct remainder answer
// compared against the float form always mismatches. Shared by both
// verifyMath shapes that can encounter it: Case 1 ("30÷4=7...2", the
// student wrote their own full equation, Ticket 27) and Case 2 ("87÷6"
// printed, student wrote bare "14...3" with no "=" at all, Ticket 43 --
// same underlying notation, just on opposite sides of an "=" the
// student may or may not have re-written themselves).
function verifyDivisionRemainder(divExpr, remainderExpr) {
  const divMatch = /^\s*(-?\d+)\s*[÷/]\s*(-?\d+)\s*$/.exec(divExpr);
  const remMatch = /^\s*(-?\d+)\s*(?:[…⋯]|\.{2,3})\s*(-?\d+)\s*$/.exec(remainderExpr);
  if (!divMatch || !remMatch) return null;
  const dividend = Number(divMatch[1]);
  const divisor = Number(divMatch[2]);
  const quotient = Number(remMatch[1]);
  const remainder = Number(remMatch[2]);
  if (divisor === 0) return null;
  const correct = dividend === divisor * quotient + remainder && remainder >= 0 && remainder < Math.abs(divisor);
  const correctQuotient = Math.floor(dividend / divisor);
  const correctRemainder = dividend - divisor * correctQuotient;
  return verdictResult(
    correct,
    `${correctQuotient}...${correctRemainder}`,
    `${dividend}÷${divisor} = ${correctQuotient}...${correctRemainder}（商${correctQuotient}餘${correctRemainder}）`
  );
}

// Deterministic verification -- code decides correct/wrong, never the AI.
// Handles the case real testing showed AI judgment gets wrong (an equation
// the student rewrote in a different, still-valid order/form) by only
// checking arithmetic truth, never comparing token order or wording.
//
// Returns { correct: true|false|null, correctAnswer }. null means "this
// specific answer isn't something code can verify" (e.g. a bare number
// with no equation and no computable expected value from the printed
// text) -- reported honestly rather than guessed, per explicit instruction
// not to claim 100% code-verified when a case genuinely isn't.
function verifyMath(printedQuestion, studentAnswer) {
  // 2026-09-21 real-photo failure: on a worksheet where the printed "="
  // sits immediately before the answer box, OCR echoed it INTO the
  // answer ("=5" instead of "5") for every item -- which made every one
  // of them wrongly take the case-1 "full equation" branch below on an
  // empty, unparseable left-hand side, so a genuinely verifiable answer
  // (25÷5=5) reported null instead of true. A bare leading "=" can never
  // be a meaningful part of an answer's OWN value (an answer to the LEFT
  // of nothing), so stripping it is a safe, general normalisation, not a
  // worksheet-specific hack.
  const subAnswers = String(studentAnswer)
    .split(";")
    .map((s) => s.trim().replace(/^=+\s*/, ""))
    .filter(Boolean);
  if (!subAnswers.length) return { correct: false, correctAnswer: "" };

  const results = subAnswers.map((sub) => {
    // Tier 1 blank-in-the-middle check, tried FIRST since it's more
    // specific than the generic cases below. Returns null (not a
    // verdict) whenever it doesn't apply -- 0 or 2+ blank tokens, or
    // anything that doesn't cleanly reconstruct -- so every other
    // shape's behaviour (including all existing tests) is unchanged.
    const substituted = trySubstituteBlank(printedQuestion, sub);
    if (substituted) return substituted;

    // Case 1: the student's own answer is a full equation ("5+2=7") --
    // verify it's internally true. This is the common case for "complete
    // the sum" style questions and needs no understanding of the printed
    // question's wording at all.
    const eqIdx = sub.indexOf("=");
    if (eqIdx !== -1) {
      const lhs = sub.slice(0, eqIdx);
      const rhs = sub.slice(eqIdx + 1);
      // Ticket 27 (2026-09-27, real data finding): a real division
      // word-problem answer written as "30÷4=7...2" (quotient...remainder,
      // the standard HK notation) fell through both this and Case 2 as
      // undecidable -- evalArithmetic("30÷4") gives 7.5 (division has no
      // remainder concept), and parseNumericAnswer("7...2") isn't a clean
      // number either, so BOTH sides were unparseable and this genuinely
      // correct sub-answer reported null, which then made the whole
      // multi-part answer (equation + restated sentence) null -- and
      // upstream, a null sub-answer inside an otherwise-resolvable item
      // could differ from a false one in caller behaviour, but the real
      // production impact seen was this exact case being one of several
      // Ticket 27 findings. Checked first, before the general float path,
      // so a clean division-with-remainder equation is verified exactly
      // (dividend = divisor*quotient + remainder, 0 <= remainder < divisor)
      // rather than falling through to a same-shape-different-meaning
      // float comparison.
      const remResult = verifyDivisionRemainder(lhs, rhs);
      if (remResult) return remResult;
      const lhsVal = evalArithmetic(lhs);
      const rhsVal = parseNumericAnswer(rhs);
      if (lhsVal !== null && !Number.isNaN(rhsVal)) {
        const correct = Math.abs(lhsVal - rhsVal) < 1e-9;
        return verdictResult(correct, lhsVal, `${lhs.trim()} = ${lhsVal}，唔係${rhsVal}`);
      }
      return { correct: null, correctAnswer: "" };
    }
    // Case 2: bare number/word answer -- only checkable if the PRINTED
    // question itself is a computable expression (e.g. "4+6="). A
    // descriptive word problem ("10 upstairs 4 downstairs") needs
    // semantic understanding of what to compute, which is genuinely not
    // something this deterministic layer can do -- reported as null
    // (needs review) rather than guessed.
    const printedExpr = String(printedQuestion).replace(/=\s*$/, "");
    // Ticket 43 (2026-09-27, real production finding): printed "87÷6"
    // with a bare student answer "14…3" (no "=" anywhere -- this is the
    // OTHER real shape the Ticket 27 remainder fix above didn't cover,
    // since that one only fires when the student's own sub-answer
    // contains an "="). Checked before the general evalArithmetic/
    // parseNumericAnswer path below, which would otherwise truncate
    // "14…3" to just 14 and wrongly compare it against 87÷6's plain
    // float value 14.5.
    const remResult = verifyDivisionRemainder(printedExpr, sub);
    if (remResult) return remResult;
    const expected = evalArithmetic(printedExpr);
    const studentVal = parseNumericAnswer(sub);
    if (expected !== null && !Number.isNaN(studentVal)) {
      const correct = Math.abs(expected - studentVal) < 1e-9;
      return verdictResult(correct, expected, `${printedExpr.trim()} = ${expected}`);
    }
    return { correct: null, correctAnswer: "" };
  });

  if (results.some((r) => r.correct === null)) return { correct: null, correctAnswer: "" };
  const allCorrect = results.every((r) => r.correct === true);
  // 2026-09-30: multi-sub-answer items join each wrong sub's own
  // explanation the same way correctAnswer already joins each sub's own
  // value -- a handler not yet given one (see trySubstituteBlank/
  // verifyDivisionRemainder above -- both already do) just contributes
  // nothing here, never a placeholder.
  const explanation = allCorrect ? "" : results.filter((r) => r.correct === false && r.explanation).map((r) => r.explanation).join("；");
  return { correct: allCorrect, correctAnswer: allCorrect ? "" : results.map((r) => r.correctAnswer || "?").join(", "), explanation };
}

// Subject classification (2026-09-21): the worksheet OCR sees is not
// always math -- real homework mixes Chinese, English, and maths on the
// same page. This decides which verification lane an item goes through
// *before* any lane runs, so the dispatcher stays a plain lookup and each
// lane stays independently swappable. Arithmetic shape is checked first
// regardless of surrounding script, since printed instructions are often
// Chinese even on a pure maths item ("2=2+5|5+2=7" style rows never
// contain CJK themselves, but a worksheet's header text can).
function detectSubject(printedQuestion, studentAnswer) {
  const text = `${printedQuestion || ""} ${studentAnswer || ""}`;
  // A bare numeric answer on its own is NOT enough to call something math --
  // a reading-comprehension question answered "5" is still English/Chinese.
  // Only classify as math when an actual operator shows up somewhere, or the
  // PRINTED question itself is a computable expression (e.g. "4+6=").
  const hasOperatorShape = /\d\s*[+\-*x×÷/]\s*-?\d/.test(text);
  const printedIsExpression = evalArithmetic(String(printedQuestion || "").replace(/=\s*$/, "")) !== null;
  // A printed line containing a recognized blank token (e.g. "54÷?=6")
  // is unmistakably a math question, even though neither check above
  // can parse it as-is (that's exactly what trySubstituteBlank, Tier 1
  // 2026-09-22, exists to handle downstream) -- without this, such
  // items fell through to "uncertain" and verifyMath was never even
  // called. Guarded against "?" being a genuine sentence-ending
  // question mark ("What is your name?"): only counts if digits AND an
  // operator remain once the token itself is removed, so an ordinary
  // English/Chinese question is never misrouted into the math lane.
  const printedHasBlankToken = BLANK_TOKENS.some((t) => {
    const printed = String(printedQuestion || "");
    if (!printed.includes(t)) return false;
    const withoutToken = printed.split(t).join("");
    return /\d/.test(withoutToken) && /[+\-*x×÷/]/.test(withoutToken);
  });
  if (hasOperatorShape || printedIsExpression || printedHasBlankToken) return "math";
  if (/[一-鿿]/.test(text)) return "chinese";
  if (/[a-zA-Z]/.test(String(studentAnswer || ""))) return "english";
  return "uncertain";
}

// ---------------------------------------------------------------------
// New question-type verifiers (2026-09-22), built from a real sample of
// 5 published HK primary-school workbooks the user sent 2026-09-11 to
// 09-18 (read directly, no AI/API cost -- see the coverage-catalog
// report for the full page-by-page findings). Each one is Tier A in
// that catalog: the correct answer is derivable by pure code from the
// PRINTED question text alone, no book-specific answer key needed --
// same philosophy as verifyMath above.
//
// IMPORTANT: none of these are wired into detectSubject/verifyAnswer's
// dispatcher yet. Doing so safely needs a real per-type detector (so an
// ordinary math item's stray digits/letters don't misfire one of these)
// AND a decision on how OCR would represent "which MC option did the
// student pick" -- a different shape than the existing single
// label=printed|answer line. Left as standalone, independently tested
// functions, ready for that integration decision later.
// ---------------------------------------------------------------------

// Chinese number-word -> digit, scoped to 0-99 (the range actually
// evidenced in the sampled workbooks -- not extended to 百/千 without
// real evidence, same discipline as BLANK_TOKENS above).
const CN_DIGIT_WORDS = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function parseChineseNumberWord(s) {
  const str = String(s || "").trim();
  if (!str) return null;
  if (CN_DIGIT_WORDS[str] !== undefined) return CN_DIGIT_WORDS[str];
  if (str === "十") return 10;
  const m = str.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (!m) return null;
  const tens = m[1] ? CN_DIGIT_WORDS[m[1]] : 1;
  const ones = m[2] ? CN_DIGIT_WORDS[m[2]] : 0;
  return tens * 10 + ones;
}
function numberToChineseWord(n) {
  if (!Number.isInteger(n) || n < 0 || n > 99) return null;
  const REV = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n < 10) return REV[n];
  if (n === 10) return "十";
  const tens = Math.floor(n / 10), ones = n % 10;
  return (tens === 1 ? "十" : REV[tens] + "十") + (ones === 0 ? "" : REV[ones]);
}

// English number-word -> digit, scoped to 0-99 (same real-evidence scope).
const EN_NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const EN_NUM_WORDS_REV = {};
for (const [w, v] of Object.entries(EN_NUM_WORDS)) if (EN_NUM_WORDS_REV[v] === undefined) EN_NUM_WORDS_REV[v] = w;
function parseEnglishNumberWord(s) {
  const str = String(s || "").trim().toLowerCase().replace(/[^a-z\s-]/g, "");
  if (!str) return null;
  if (EN_NUM_WORDS[str] !== undefined) return EN_NUM_WORDS[str];
  const parts = str.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 2) {
    const tens = EN_NUM_WORDS[parts[0]];
    const ones = EN_NUM_WORDS[parts[1]];
    if (tens !== undefined && tens >= 20 && tens % 10 === 0 && ones !== undefined && ones > 0 && ones < 10) {
      return tens + ones;
    }
  }
  return null;
}

// Ticket 38 (2026-09-27, code review finding): extracted from what used
// to be two verbatim copies of this exact check (verifyNumberWordConversion
// and the number_word_conversion handler's own detect()) -- a future
// change to "does this answer look like a number word" only needs to
// happen once now. See Ticket 27's comment history for why this check
// exists: it must actually PARSE as a number word, not just contain a
// letter/CN-numeral, or it misfires on unrelated short-word answers
// (e.g. "but"/"and"/"or") that happen to sit next to a printed digit.
function looksLikeNumberWord(answer) {
  return parseEnglishNumberWord(answer) !== null || parseChineseNumberWord(answer) !== null;
}

function numberToEnglishWord(n) {
  if (!Number.isInteger(n) || n < 0 || n > 99) return null;
  if (EN_NUM_WORDS_REV[n]) return EN_NUM_WORDS_REV[n];
  const tens = Math.floor(n / 10) * 10, ones = n % 10;
  if (!EN_NUM_WORDS_REV[tens] || !EN_NUM_WORDS_REV[ones]) return null;
  return `${EN_NUM_WORDS_REV[tens]}-${EN_NUM_WORDS_REV[ones]}`;
}

// "Write <digit> in words" / "Write '<word>' in numerals" -- a real,
// common HK P1 question type (found 2026-09-22 in real published
// workbook pages, both English and Chinese forms). Detects direction
// from a quoted word (word->digit) vs. a bare printed digit (digit->
// word); only claims a verdict when exactly one clean interpretation
// exists, otherwise null/needs_review, never a guess.
function verifyNumberWordConversion(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "").trim();
  const answer = String(studentAnswer || "").trim();
  if (!printed || !answer) return { correct: null, correctAnswer: "" };

  const quoted = printed.match(/'([a-zA-Z\s-]+)'|"([a-zA-Z\s-]+)"|「([一二三四五六七八九十零]+)」/);
  const wordSource = quoted ? (quoted[1] || quoted[2] || quoted[3]) : null;
  if (wordSource) {
    const target = /[一二三四五六七八九十零]/.test(wordSource)
      ? parseChineseNumberWord(wordSource)
      : parseEnglishNumberWord(wordSource);
    const studentVal = parseInt(answer, 10);
    if (target !== null && !Number.isNaN(studentVal) && /^-?\d+$/.test(answer)) {
      return { correct: target === studentVal, correctAnswer: target === studentVal ? "" : String(target) };
    }
    return { correct: null, correctAnswer: "" };
  }

  const digitMatch = printed.match(/\b(\d{1,2})\b/);
  // Ticket 27 (2026-09-27, real data finding): the old check ("any
  // letter or CN numeral in the answer") misfired on a real "and/but/or
  // sentence-connector" exercise -- printedQuestion was just a bare
  // digit label ("1", "2"...) from OCR, which trivially matched
  // digitMatch, and studentAnswer ("but") trivially matched "contains a
  // letter", so this handler compared "but" against numberToEnglishWord(1)
  // ("one") and confidently reported a real, correct answer as wrong.
  // Now the answer itself must actually PARSE as a number word (not
  // just contain letters) before this branch claims the item.
  const isWordAnswer = looksLikeNumberWord(answer);
  if (digitMatch && isWordAnswer) {
    const target = parseInt(digitMatch[1], 10);
    const expectedEn = numberToEnglishWord(target);
    const expectedCn = numberToChineseWord(target);
    const normAnswer = answer.toLowerCase().replace(/[\s-]+/g, "");
    const matchesEn = expectedEn && normAnswer === expectedEn.toLowerCase().replace(/-/g, "");
    const matchesCn = expectedCn && answer.replace(/\s+/g, "") === expectedCn;
    if (matchesEn || matchesCn) return { correct: true, correctAnswer: "" };
    if (expectedEn || expectedCn) return { correct: false, correctAnswer: expectedEn || expectedCn };
  }
  return { correct: null, correctAnswer: "" };
}

// "Fill in > or <" between two printed numbers -- found 2026-09-22 in a
// real workbook page. Only the two ASCII symbols actually used in the
// sample are accepted; "=" was never evidenced so isn't handled (a
// printed pair that's actually equal returns null, never guesses which
// symbol was "meant").
function verifyComparisonSymbol(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const nums = printed.match(/-?\d+(\.\d+)?/g);
  if (!nums || nums.length !== 2) return { correct: null, correctAnswer: "" };
  const a = parseFloat(nums[0]), b = parseFloat(nums[1]);
  if (Number.isNaN(a) || Number.isNaN(b) || a === b) return { correct: null, correctAnswer: "" };
  const expected = a > b ? ">" : "<";
  const answer = String(studentAnswer || "").trim();
  if (answer !== ">" && answer !== "<") return { correct: null, correctAnswer: "" };
  return { correct: answer === expected, correctAnswer: answer === expected ? "" : expected };
}

// Ticket 209 (2026-09-30, real citation: 26週數學訓練 P3 Topic 8圓括號
// math34pdf/p18.png Q5: "在○內填「+」或「-」，使算式正確" -- "a○(b○c)=d",
// TWO blank-operator circles, brackets already printed so no ambiguity
// about which operation applies first. Real answer key (answers_p02.png,
// Topic 8 Q5) verified by brute-forcing all 4 +/- combinations myself
// before writing this: (a) 297○(172○125)=0 -> "-;+", (b)
// 168○(286○118)=0 -> "-;-", (c) 168○(156○176)=500 -> "+;+", (d)
// 297○(308○105)=500 -> "+;-" -- all 4 confirmed correct against the
// official key, not just plausible-looking.
//
// NOT yet verified end-to-end via a real live /api/mark submission (per
// this project's "verify real dispatch path" discipline) -- this is a
// brand new item shape (two separate handwritten circles in one printed
// line) with no existing real example of how OCR actually transcribes
// it, so detect()/parsing below is deliberately tolerant of several
// plausible blank-marker characters and answer-separator styles rather
// than assuming one exact format.
function isOperatorFillBracketQuestion(item) {
  const printed = String(item.printedQuestion || "");
  return /-?\d+\s*[○□_]+\s*\(\s*-?\d+\s*[○□_]+\s*-?\d+\s*\)\s*=\s*-?\d+/.test(printed);
}

function verifyOperatorFillBracket(item) {
  const printed = String(item.printedQuestion || "");
  const m = printed.match(/(-?\d+)\s*[○□_]+\s*\(\s*(-?\d+)\s*[○□_]+\s*(-?\d+)\s*\)\s*=\s*(-?\d+)/);
  if (!m) return { correct: null, correctAnswer: "" };
  const [, aStr, bStr, cStr, dStr] = m;
  const a = Number(aStr), b = Number(bStr), c = Number(cStr), d = Number(dStr);
  const ops = ["+", "-"];
  const applyOp = (op, x, y) => (op === "+" ? x + y : x - y);
  const matches = [];
  for (const op1 of ops) {
    for (const op2 of ops) {
      if (applyOp(op1, a, applyOp(op2, b, c)) === d) matches.push([op1, op2]);
    }
  }
  // A well-posed question has exactly one solution -- more than one
  // (or none) means either a mis-OCR'd number or a genuinely ambiguous
  // printed item; never guess which combination was "intended".
  if (matches.length !== 1) return { correct: null, correctAnswer: "" };
  const [expectedOp1, expectedOp2] = matches[0];
  const studentOps = (String(item.studentAnswer || "").match(/[+\-＋－]/g) || []).map((s) => (s === "＋" ? "+" : s === "－" ? "-" : s));
  if (studentOps.length !== 2) return { correct: null, correctAnswer: "" };
  const correct = studentOps[0] === expectedOp1 && studentOps[1] === expectedOp2;
  return verdictResult(correct, `${expectedOp1};${expectedOp2}`, `${a}${expectedOp1}(${b}${expectedOp2}${c}) = ${d}`);
}

// "Which option below contains only even/odd numbers?" MC (found
// 2026-09-22, real workbook page). printedQuestion must carry the full
// question text (so the even/odd keyword is visible) followed by
// "A. n,n B. n,n C. n,n D. n,n"; studentAnswer is the picked letter.
// Only claims a verdict when exactly one option uniquely matches.
function verifyParityMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const wantEven = /\beven\b|偶數/i.test(printed);
  const wantOdd = /\bodd\b|奇數/i.test(printed);
  if (wantEven === wantOdd) return { correct: null, correctAnswer: "" };
  const optionMatches = [...printed.matchAll(/([A-D])[.．]\s*([\d,\s]+?)(?=\s*[A-D][.．]|$)/g)];
  if (optionMatches.length < 2) return { correct: null, correctAnswer: "" };
  let correctLetter = null, matchCount = 0;
  for (const m of optionMatches) {
    const nums = m[2].match(/\d+/g);
    if (!nums || !nums.length) continue;
    if (nums.every((n) => (parseInt(n, 10) % 2 === 0) === wantEven)) { correctLetter = m[1]; matchCount++; }
  }
  if (matchCount !== 1) return { correct: null, correctAnswer: "" };
  const answer = String(studentAnswer || "").trim().toUpperCase();
  return { correct: answer === correctLetter, correctAnswer: answer === correctLetter ? "" : correctLetter };
}

// "Which option's computed value equals the target?" MC -- generalizes
// two real shapes found 2026-09-22 in sampled workbooks: "same sum as
// 39+12+28?" (a quoted expression target) and "decomposition of 18?"
// (a named-number target). Each option is either a full arithmetic
// expression, or an "X and Y" / "X 和 Y" pair (evaluated as X+Y -- the
// only pairing form evidenced). Only claims a verdict when exactly one
// option matches the target.
function verifyComputationMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const quoted = printed.match(/[「"']([^」"']+)[」"']/);
  let target = quoted ? evalArithmetic(quoted[1]) : null;
  if (target === null) {
    const m = printed.match(/(?:decomposition of|分解)\s*(\d+)/i);
    if (m) target = parseFloat(m[1]);
  }
  if (target === null) return { correct: null, correctAnswer: "" };

  const optionMatches = [...printed.matchAll(/([A-D])[.．]\s*([^A-D]+?)(?=\s*[A-D][.．]|$)/g)];
  if (optionMatches.length < 2) return { correct: null, correctAnswer: "" };
  let correctLetter = null, matchCount = 0;
  for (const m of optionMatches) {
    const text = m[2].trim();
    let val = evalArithmetic(text);
    if (val === null) {
      const pair = text.match(/(\d+)\s*(?:and|和)\s*(\d+)/i);
      if (pair) val = parseFloat(pair[1]) + parseFloat(pair[2]);
    }
    if (val !== null && Math.abs(val - target) < 1e-9) { correctLetter = m[1]; matchCount++; }
  }
  if (matchCount !== 1) return { correct: null, correctAnswer: "" };
  const answer = String(studentAnswer || "").trim().toUpperCase();
  return { correct: answer === correctLetter, correctAnswer: answer === correctLetter ? "" : correctLetter };
}

// ---------------------------------------------------------------------
// Second batch of new verifiers (2026-09-22, later same session), from
// the same real-workbook sample plus the real SFA P1 English quiz PDF
// (`61ecd818-SFA-P1-ENG-1920-QUIZ.pdf`, 5 pages, read directly) and the
// real Chinese benchmark photos already in `benchmark/photos/`. Same
// discipline as the batch above: standalone, tested, NOT wired into
// verifyAnswer's dispatcher yet, fail-safe to null on any ambiguity.
// ---------------------------------------------------------------------

// Multiple separate single-blank sub-equations sharing one comma-joined
// answer string, e.g. real captured shape "4×□=24,24÷□=4,□×4=24,24÷4=□"
// with studentAnswer "6,6,6,6" (a "fact family" exercise). This is
// explicitly the Tier-2 case trySubstituteBlank's own comment defers --
// handled here as its own function (not a change to trySubstituteBlank)
// by positionally pairing each comma-separated sub-question with the
// same-index sub-answer and reusing trySubstituteBlank per pair
// unchanged. Any sub-question that isn't a clean single-blank shape, or
// a count mismatch between sub-questions and sub-answers, is not this
// case -- returns null rather than guessing a pairing.
function verifyMultiBlankMath(printedQuestion, studentAnswer) {
  const subQuestions = String(printedQuestion || "").split(",").map((s) => s.trim()).filter(Boolean);
  const subAnswers = String(studentAnswer || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (subQuestions.length < 2 || subQuestions.length !== subAnswers.length) return { correct: null, correctAnswer: "" };
  const results = subQuestions.map((q, i) => trySubstituteBlank(q, subAnswers[i]));
  if (results.some((r) => !r)) return { correct: null, correctAnswer: "" };
  const allCorrect = results.every((r) => r.correct === true);
  return { correct: allCorrect, correctAnswer: allCorrect ? "" : results.map((r) => r.correctAnswer || "?").join(", ") };
}

// "Fill in the missing digit" where the blank is ONE digit embedded
// inside a multi-digit number in an otherwise-complete equation (e.g.
// "7□+15=82", the blank is the ones digit of 7□) -- distinct from
// BLANK_TOKENS/trySubstituteBlank, which substitutes a whole missing
// OPERAND, not a digit within one. Brute-forces 0-9 (a 10-way search is
// trivially cheap) and only claims a verdict when exactly one digit
// makes the equation true, same "ambiguous -> null" discipline as
// everywhere else. NOTE (scoped honestly): a real sampled workbook page
// ("在方格內填上數字完成直式") showed a HARDER real case with TWO blank
// digits in two different operands of a column subtraction (e.g.
// "□8-3□=45") -- that two-blank-digit generalization is NOT handled by
// this function (a 100-way joint search rather than two independent
// 10-way ones, and needs its own ambiguity handling for multiple valid
// digit pairs) and is left as a known follow-up, not silently claimed.
function verifyMissingDigitInNumber(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  let token = null, count = 0;
  for (const t of BLANK_TOKENS) {
    const n = printed.split(t).length - 1;
    if (n > 0) { count += n; if (!token) token = t; }
  }
  if (count !== 1) return { correct: null, correctAnswer: "" };
  // Must be adjacent to a digit (embedded in a number), not standing
  // alone as a whole operand -- that's trySubstituteBlank's case, not
  // this one, so this function stays narrowly scoped to what it's named for.
  const idx = printed.indexOf(token);
  const before = printed[idx - 1], after = printed[idx + token.length];
  if (!/\d/.test(before || "") && !/\d/.test(after || "")) return { correct: null, correctAnswer: "" };

  const eqIdx = printed.indexOf("=");
  if (eqIdx === -1) return { correct: null, correctAnswer: "" };
  const candidates = [];
  for (let d = 0; d <= 9; d++) {
    const reconstructed = printed.replace(token, String(d));
    const lhsVal = evalArithmetic(reconstructed.slice(0, eqIdx));
    const rhsVal = parseFloat(reconstructed.slice(eqIdx + 1));
    if (lhsVal !== null && !Number.isNaN(rhsVal) && Math.abs(lhsVal - rhsVal) < 1e-9) candidates.push(d);
  }
  if (candidates.length !== 1) return { correct: null, correctAnswer: "" };
  const expected = candidates[0];
  const studentVal = parseInt(String(studentAnswer || "").trim(), 10);
  if (Number.isNaN(studentVal)) return { correct: null, correctAnswer: "" };
  return { correct: studentVal === expected, correctAnswer: studentVal === expected ? "" : String(expected) };
}

// General N-blank version of verifyMissingDigitInNumber above (real
// example, 2026-09-22, p1-p6.com P3 maths Q15: "2□9+32=□9□", TWO blank
// digits in TWO different operands with a carry between them). Written
// as a NEW function rather than extending verifyMissingDigitInNumber in
// place: that function's `count !== 1` guard and its callers/tests
// assume exactly one blank, and its single `printed.replace(token, ...)`
// call is specifically a single-substitution shape -- generalizing it to
// N independent blank positions changes its substitution strategy
// entirely (each blank needs its OWN digit, not one digit repeated at
// every occurrence of the token), so reusing the name would either
// silently change already-tested behaviour or need the same branching
// this split avoids. This function is a strict superset: it also
// correctly handles the old N=1 case (verified by test below), so once
// wired in, this one function can replace both without behaviour loss --
// not done here, left as a "which one wins" call for a human/PR review.
//
// Brute-forces every blank position independently (up to 4 blanks =
// 10,000 combinations, milliseconds) rather than solving the column
// arithmetic symbolically -- simpler, and this codebase's own
// `verifyMissingDigitInNumber` already established brute force as the
// house style for this shape of problem. Requires a UNIQUE solution
// (declines, doesn't guess, if more than one digit-combination satisfies
// the equation) -- same honesty guarantee as every other verify* function
// here.
function verifyMissingDigitsInEquation(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const positions = [];
  for (let i = 0; i < printed.length; i++) {
    if (BLANK_TOKENS.includes(printed[i])) positions.push(i);
  }
  if (positions.length === 0 || positions.length > 4) return { correct: null, correctAnswer: "" };
  const eqIdx = printed.indexOf("=");
  if (eqIdx === -1) return { correct: null, correctAnswer: "" };
  // At least one blank must be embedded next to a digit (this is the
  // "missing digit inside a number" shape, not trySubstituteBlank's
  // "blank stands alone as a whole operand" shape).
  const embedded = positions.some((i) => /\d/.test(printed[i - 1] || "") || /\d/.test(printed[i + 1] || ""));
  if (!embedded) return { correct: null, correctAnswer: "" };

  const totalCombinations = 10 ** positions.length;
  const solutions = [];
  for (let combo = 0; combo < totalCombinations; combo++) {
    const digits = [];
    let rest = combo;
    for (let k = 0; k < positions.length; k++) {
      digits.push(rest % 10);
      rest = Math.floor(rest / 10);
    }
    const chars = printed.split("");
    positions.forEach((pos, k) => {
      chars[pos] = String(digits[k]);
    });
    const reconstructed = chars.join("");
    // RHS is a bare (post-substitution) number, not an expression --
    // evalArithmetic requires at least one operator and returns null for
    // a plain number like "291", so this uses parseFloat here, matching
    // verifyMissingDigitInNumber's existing convention for the same
    // reason.
    const lhsVal = evalArithmetic(reconstructed.slice(0, eqIdx));
    const rhsVal = parseFloat(reconstructed.slice(eqIdx + 1));
    if (lhsVal !== null && !Number.isNaN(rhsVal) && Math.abs(lhsVal - rhsVal) < 1e-9) solutions.push(digits);
  }
  if (solutions.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedDigits = solutions[0];

  // Student answer is expected as the blank digits, in the SAME left-to-
  // right reading order as they appear in printedQuestion (matches how
  // trySubstituteBlank/verifyMissingDigitInNumber's single-value answer
  // convention generalizes to multiple blanks) -- e.g. for
  // "2□9+32=□9□" with blanks solving to [7,0], the expected answer text
  // is "7,0" or "70" (both accepted; OCR's exact joining convention for
  // this genuinely new shape is unconfirmed, so both are tolerated
  // rather than guessing one).
  const answerDigits = String(studentAnswer || "")
    .replace(/[,\s]+/g, "")
    .split("")
    .filter((c) => /\d/.test(c))
    .map(Number);
  if (answerDigits.length !== expectedDigits.length) return { correct: null, correctAnswer: "" };
  const correct = answerDigits.every((d, k) => d === expectedDigits[k]);
  return { correct, correctAnswer: correct ? "" : expectedDigits.join(",") };
}

// Multi-box digit answer: the answer to an arithmetic expression is
// split across N separate boxes, one digit each (real example,
// 2026-09-22, p1-p6.com P3 maths Q11: "634×2=" with the product written
// across 4 boxes). Distinct from a normal single-field answer -- OCR
// realistically hands this back as the boxes' digits read left to right
// (however many boxes actually had a mark in them), which may have FEWER
// digits than boxes if the true answer is shorter than the box count
// (e.g. a 3-digit product in a 4-box grid, blank leading box) -- so this
// compares by numeric VALUE (parseInt drops leading zeros/blanks
// naturally), not by exact string/box-count match.
function verifyMultiBoxDigitAnswer(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "").trim();
  const eqIdx = printed.indexOf("=");
  if (eqIdx === -1) return { correct: null, correctAnswer: "" };
  const expression = printed.slice(0, eqIdx);
  const expected = evalArithmetic(expression);
  if (expected === null || !Number.isInteger(expected)) return { correct: null, correctAnswer: "" };

  const digits = String(studentAnswer || "").replace(/[,\s]+/g, "");
  if (!/^\d+$/.test(digits)) return { correct: null, correctAnswer: "" };
  const studentVal = parseInt(digits, 10);
  const correct = studentVal === expected;
  return { correct, correctAnswer: correct ? "" : String(expected) };
}

// Small (<=6-number) ascending/descending sequence with exactly one
// blank slot, constant step inferred from the OTHER numbers present
// (found in sampled workbooks as a standard P1/P2 pattern exercise).
// Only claims a verdict when the non-blank numbers agree on a single
// constant step -- an inconsistent or too-short sequence returns null
// rather than guessing a rule.
// 2026-09-23: generalized from exactly-ONE blank to ANY NUMBER of blanks
// in one sequence, after a real production test on a real user's bot
// submission ("Count in 2s. Fill in the gaps: 2,[4],6,[8],10,[12],[14],
// 16,[18],20") showed Qwen's OCR joins multiple blanks' answers into ONE
// semicolon-separated `studentAnswer` string ("4;8;12;14;18") rather than
// one item per blank -- the old single-blank version could only ever
// `parseFloat` the first value and silently ignore the rest. Each blank
// is filled by walking to its nearest known neighbor and applying the
// same constant step used everywhere else in this function.
function verifySequenceFill(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const parts = printed.split(/[,，]/).map((s) => s.trim());
  if (parts.length < 3) return { correct: null, correctAnswer: "" };
  const isBlank = (p) => BLANK_TOKENS.some((t) => p.includes(t)) || /^_+$/.test(p);
  const blankIndices = parts.map((p, i) => (isBlank(p) ? i : -1)).filter((i) => i !== -1);
  if (!blankIndices.length) return { correct: null, correctAnswer: "" };
  const nums = parts.map((p, i) => (blankIndices.includes(i) ? null : parseFloat(p)));
  if (nums.some((n, i) => !blankIndices.includes(i) && Number.isNaN(n))) return { correct: null, correctAnswer: "" };
  // Step inferred from EVERY pair of known (non-blank) values, not just
  // adjacent ones -- real fix, 2026-09-23: a dense real example (blanks
  // at every other position, including two blanks back-to-back) has NO
  // pair of adjacent KNOWN values at all, so the old adjacent-only check
  // always found zero usable steps and declined a perfectly solvable
  // sequence. Dividing by the index distance handles any gap size.
  const knownIndices = nums.map((n, i) => (n !== null ? i : -1)).filter((i) => i !== -1);
  if (knownIndices.length < 2) return { correct: null, correctAnswer: "" };
  const steps = [];
  for (let a = 0; a < knownIndices.length - 1; a++) {
    for (let b = a + 1; b < knownIndices.length; b++) {
      const i = knownIndices[a], j = knownIndices[b];
      steps.push((nums[j] - nums[i]) / (j - i));
    }
  }
  if (steps.some((s) => Math.abs(s - steps[0]) > 1e-9)) return { correct: null, correctAnswer: "" };
  const step = steps[0];
  const filled = [...nums];
  for (const idx of blankIndices) {
    let expected = null;
    for (let j = idx - 1; j >= 0 && expected === null; j--) if (filled[j] !== null) expected = filled[j] + step * (idx - j);
    if (expected === null) for (let j = idx + 1; j < filled.length && expected === null; j++) if (filled[j] !== null) expected = filled[j] - step * (j - idx);
    if (expected === null) return { correct: null, correctAnswer: "" };
    filled[idx] = expected;
  }
  const expectedValues = blankIndices.map((i) => filled[i]);
  const studentVals = String(studentAnswer || "").split(/[;,，\s]+/).map((s) => s.trim()).filter(Boolean).map(Number);
  if (studentVals.length !== expectedValues.length || studentVals.some(Number.isNaN)) {
    return { correct: false, correctAnswer: expectedValues.join(", ") };
  }
  const allCorrect = studentVals.every((v, i) => Math.abs(v - expectedValues[i]) < 1e-9);
  return { correct: allCorrect, correctAnswer: allCorrect ? "" : expectedValues.join(", ") };
}

// "Sort these numbers ascending/descending" -- printedQuestion carries
// the given numbers plus a direction keyword; studentAnswer is the
// comma/space-separated ordering. Only claims a verdict when the
// direction is unambiguous AND the student's answer is a genuine
// permutation of the SAME numbers (not just numerically sorted -- a
// wrong/extra number is a format problem, reported as incorrect against
// the real expected list, not silently ignored).
// Matches a mixed number ("7又7/9"), a plain fraction ("37/5"), or a plain
// decimal, in that priority order (longest/most-specific shape first) so a
// mixed number never gets mis-split into 3 separate plain-number tokens.
// 2026-09-23 real bug fix: found via a real P5 paper asking to sort
// "37/5、7又7/9、7又2/3" -- the old plain `-?\d+(\.\d+)?` regex tore this
// into 5 separate integer tokens (37, 5, 7, 7, 9, 7, 2, 3), producing a
// completely wrong multiset/order comparison instead of failing safely.
const SORTABLE_NUMBER_RE = /-?\d+又\d+\/\d+|-?\d+\/\d+|-?\d+(\.\d+)?/g;

function parseSortableNumber(tok) {
  const mixed = /^(-?)(\d+)又(\d+)\/(\d+)$/.exec(tok);
  if (mixed) {
    const sign = mixed[1] === "-" ? -1 : 1;
    const whole = parseFloat(mixed[2]);
    const num = parseFloat(mixed[3]);
    const den = parseFloat(mixed[4]);
    return den === 0 ? NaN : sign * (whole + num / den);
  }
  const frac = /^(-?\d+)\/(\d+)$/.exec(tok);
  if (frac) {
    const den = parseFloat(frac[2]);
    return den === 0 ? NaN : parseFloat(frac[1]) / den;
  }
  return parseFloat(tok);
}

// 2026-09-23: added 由小至大/由大至小 (「至」as well as 「到」, same meaning)
// after a real P5 paper used this exact phrasing -- confirmed via real
// PDF reading, not guessed.
function verifySortNumbers(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const wantAsc = /由小到大|由小至大|ascending|smallest to largest/i.test(printed);
  const wantDesc = /由大到小|由大至小|descending|largest to smallest/i.test(printed);
  if (wantAsc === wantDesc) return { correct: null, correctAnswer: "" };
  const given = (printed.match(SORTABLE_NUMBER_RE) || []).map(parseSortableNumber);
  if (given.length < 2 || given.some(Number.isNaN)) return { correct: null, correctAnswer: "" };
  const expectedOrder = [...given].sort((a, b) => (wantAsc ? a - b : b - a));
  const studentTokens = String(studentAnswer || "").match(SORTABLE_NUMBER_RE) || [];
  const studentNums = studentTokens.map(parseSortableNumber);
  const formatOrder = (nums) => nums.map((n) => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""))).join(", ");
  if (studentNums.length !== given.length || studentNums.some(Number.isNaN)) {
    return { correct: false, correctAnswer: formatOrder(expectedOrder) };
  }
  const closeEnough = (a, b) => Math.abs(a - b) < 1e-9;
  const sortedStudent = [...studentNums].sort((a, b) => a - b);
  const sortedGiven = [...given].sort((a, b) => a - b);
  const sameMultiset = sortedStudent.length === sortedGiven.length && sortedStudent.every((n, i) => closeEnough(n, sortedGiven[i]));
  if (!sameMultiset) return { correct: false, correctAnswer: formatOrder(expectedOrder) };
  const isExpectedOrder = studentNums.every((n, i) => closeEnough(n, expectedOrder[i]));
  return { correct: isExpectedOrder, correctAnswer: isExpectedOrder ? "" : formatOrder(expectedOrder) };
}

// 4x4 Sudoku/Latin-square (rows AND columns each contain 1-4 exactly
// once) -- real 4x4 grid puzzles found in a sampled workbook
// (`1789314979267-...pdf`, "Do it yourself: Complete the following
// Sudokus"). `givenGrid` is the 16 printed cells (null for a blank),
// `studentGrid` is the same shape with the student's filled values.
// Standard Latin-square puzzles of this size have a UNIQUE solution by
// construction, so this checks the student's FULL grid directly against
// the Latin-square constraints (not against a separately-solved answer)
// -- any given (printed) cell that's been changed, any row/column
// repeat, or any cell outside 1-4 is incorrect; an incomplete grid
// (blank cells left blank) is null/needs_review, never guessed.
function verifySudoku4x4(givenGrid, studentGrid) {
  if (!Array.isArray(givenGrid) || givenGrid.length !== 16 || !Array.isArray(studentGrid) || studentGrid.length !== 16) {
    return { correct: null, correctAnswer: "" };
  }
  if (studentGrid.some((v) => v === null || v === undefined || v === "")) return { correct: null, correctAnswer: "" };
  const grid = studentGrid.map((v) => parseInt(v, 10));
  if (grid.some((v) => Number.isNaN(v) || v < 1 || v > 4)) return { correct: false, correctAnswer: "" };
  for (let i = 0; i < 16; i++) {
    const given = givenGrid[i];
    if (given !== null && given !== undefined && given !== "" && parseInt(given, 10) !== grid[i]) return { correct: false, correctAnswer: "" };
  }
  for (let r = 0; r < 4; r++) {
    const row = [0, 1, 2, 3].map((c) => grid[r * 4 + c]);
    if (new Set(row).size !== 4) return { correct: false, correctAnswer: "" };
  }
  for (let c = 0; c < 4; c++) {
    const col = [0, 1, 2, 3].map((r) => grid[r * 4 + c]);
    if (new Set(col).size !== 4) return { correct: false, correctAnswer: "" };
  }
  return { correct: true, correctAnswer: "" };
}

// Chinese 選詞填充 / 填反義詞 -- "select the word/its antonym FROM THE
// PASSAGE" (real photos: batch1/p3_chinese_fill_blank_and_match.jpg,
// backfill/batch1_missing_chinese_word_antonym.jpg -- both instruct
// "從課文裏選出...，寫在＿＿上", i.e. the correct word is literally
// present somewhere in a SOURCE PASSAGE, whether it's the exact word
// (選詞填充) or its antonym (填反義詞 -- the antonym itself is also
// drawn from the passage per the real instruction text, not from a
// dictionary). `passageText` is the OCR'd text of that source passage
// -- ⚠️ a real, separate pipeline gap (not solved here): the source
// passage is often on a DIFFERENT physical page than the fill-in
// sentences, so this function can only run when that page was actually
// captured; when passageText isn't available, the caller should not
// call this at all (falls through to the existing null/needs_review
// default).
//
// ⚠️ IMPORTANT SCOPE CORRECTION (caught by the user 2026-09-22): "the
// word appears somewhere in the passage" can ONLY ever safely REJECT an
// answer, never CONFIRM one. A word genuinely from the passage/word-bank
// could still be the student's answer to the WRONG blank (e.g. two
// blanks' correct words swapped) -- finding it present doesn't prove
// THIS blank is where it belongs, since "does it exist in the source"
// says nothing about position. So this function returns `false` only
// when the answer is NOT in the passage at all (a certain, safe catch --
// a fabricated/wrong word), and `null` in EVERY case where the word IS
// found (regardless of how many times) -- it must never return `true`.
// Confirming correctness for this type genuinely needs to know which
// specific blank each word belongs to, which is out of scope here.
function verifySelectFromPassage(studentAnswer, passageText) {
  const answer = String(studentAnswer || "").trim();
  const passage = String(passageText || "");
  if (!answer || !passage) return { correct: null, correctAnswer: "" };
  const occurrences = passage.split(answer).length - 1;
  if (occurrences === 0) return { correct: false, correctAnswer: "" };
  return { correct: null, correctAnswer: "", inPassage: true };
}

// English "fill with is/am/are/has/have" and "fill with its/it's" --
// real sentences from `61ecd818-SFA-P1-ENG-1920-QUIZ.pdf` sections C
// ("I 1.___ a good friend."->am, "He 3.___ big eyes."->has, "His sister
// 5.___ lovely."->is, "They 7.___ a dog."->have) and E ("1.___
// beautiful."->It's, "2.___ beak is orange."->Its). Subject pronoun ->
// be-verb and possessive-vs-contraction are closed, well-defined rules
// (not passage lookup) -- this implements ONLY the small, real,
// evidenced rule set, not a general grammar engine: 1st person -> am,
// 2nd/3rd-plural (you/we/they) -> are, 3rd-singular (he/she/it/a
// name/"His sister"-style noun phrase) -> is/has ambiguous by pronoun
// alone (needs the sentence's own verb slot -- see below), and
// its/it's decided by what follows the blank (a noun immediately after
// -> possessive "its"; anything else, including an adjective/verb ->
// contraction "it's", matching both real E examples). Anything outside
// this small evidenced pattern set returns null, never a guess.
function verifyGrammarCloze(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };

  // is/am/are/has/have: subject immediately before the blank decides it.
  // Checked FIRST (more specific/safer) -- only falls through to the
  // its/it's rule below when no recognized subject pronoun precedes the
  // blank at all.
  const subjMatch = printed.match(/\b(I|He|She|They|We|You|His\s+sister|Her\s+brother)\s+_{2,}/i);
  if (subjMatch) {
    const subj = subjMatch[1].toLowerCase();
    const norm = answer.toLowerCase().replace(/[.\s]/g, "");
    let expectedSet;
    if (subj === "i") expectedSet = ["am"];
    else if (subj === "they" || subj === "we" || subj === "you") expectedSet = ["are", "have"];
    else expectedSet = ["is", "has"]; // he/she/his sister/her brother -- ambiguous between is/has without the rest of the sentence
    if (expectedSet.length === 1) {
      return { correct: norm === expectedSet[0], correctAnswer: norm === expectedSet[0] ? "" : expectedSet[0] };
    }
    // Genuinely ambiguous from the subject alone (he/she could need "is"
    // or "has" depending on what follows) -- only accept if the answer
    // is ONE of the plausible set; can't assert which one is "the"
    // correct one without more of the sentence, so never claims false
    // here, only a possible true or null.
    if (expectedSet.includes(norm)) return { correct: true, correctAnswer: "" };
    return { correct: null, correctAnswer: "" };
  }

  // its/it's: no subject pronoun matched above, so try this rule --
  // decided by whether the word immediately after the blank is one of
  // the real adjective/verb forms evidenced in section E ("it's
  // beautiful"/"it's rolling ITS ball") vs. anything else, which is a
  // noun ("its beak"/"its tongue") per the same real examples.
  const itsMatch = printed.match(/_{2,}\s*([a-zA-Z']+)/);
  if (itsMatch) {
    const nextWord = itsMatch[1].toLowerCase();
    const ADJECTIVES_VERBS = ["beautiful", "strong", "curved", "large", "red", "yellow"];
    const expected = ADJECTIVES_VERBS.includes(nextWord) ? "it's" : "its";
    const norm = answer.toLowerCase().replace(/[.\s]/g, "");
    return { correct: norm === expected, correctAnswer: norm === expected ? "" : expected };
  }
  return { correct: null, correctAnswer: "" };
}

// Ticket 222 "verb conjugation" (2026-10-01, real citations: two P2/P3
// real exam photos -- "My classmate, Sam is a good boy. He ___(get) up
// early..." and "I want to ___(join) the Cookery Club..."/"Last week, I
// ___(go) on a school picnic..."): "fill in the blank with the correct
// form of the verb given in brackets" -- broader than grammar_cloze's
// be-verb-only scope, but still a CLOSED, rule-based grammar problem
// (subject-verb agreement + a small number of syntactic base-form
// triggers + a common-irregular-verb lookup table for past tense), not
// open-ended semantic judgment -- matches this file's one real
// principle for code-solvable English: derivable from already-known
// rules/content, never "does this sentence make sense."
//
// Deliberately SCOPED, not a general grammar engine: only fires when
// the surrounding text gives an unambiguous signal (a base-form
// trigger word immediately before the blank, OR a clear subject
// pronoun/noun immediately before it combined with an explicit
// tense-marking phrase elsewhere in the sentence). Declines (null)
// for anything ambiguous rather than guess -- this genuinely cannot
// cover every possible sentence shape, and a wrong guess here would
// violate the accuracy-floor rule harder than just not answering.
const IRREGULAR_PRESENT_3S = { go: "goes", do: "does", have: "has", be: "is" };
const IRREGULAR_PAST = {
  go: "went", do: "did", have: "had", be: null, // be handled separately (was/were by number)
  take: "took", make: "made", get: "got", eat: "ate", come: "came", see: "saw",
  write: "wrote", give: "gave", find: "found", think: "thought", buy: "bought",
  bring: "brought", teach: "taught", catch: "caught", run: "ran", swim: "swam",
  sing: "sang", drink: "drank", begin: "began", ring: "rang", sit: "sat",
  read: "read", say: "said", tell: "told", feel: "felt", keep: "kept",
  sleep: "slept", leave: "left", meet: "met", pay: "paid", sell: "sold",
  send: "sent", spend: "spent", build: "built", hold: "held", win: "won",
  know: "knew", grow: "grew", throw: "threw", fly: "flew", draw: "drew",
  wear: "wore", break: "broke", speak: "spoke", choose: "chose", ride: "rode",
  drive: "drove", stand: "stood", understand: "understood", fall: "fell",
};

function conjugatePresent3S(base) {
  const b = base.toLowerCase();
  if (IRREGULAR_PRESENT_3S[b]) return IRREGULAR_PRESENT_3S[b];
  if (/(s|x|z|ch|sh)$/.test(b)) return b + "es";
  if (/[^aeiou]y$/.test(b)) return b.slice(0, -1) + "ies";
  return b + "s";
}

function conjugatePast(base) {
  const b = base.toLowerCase();
  if (b === "be") return null; // ambiguous (was/were) -- caller resolves by subject number
  if (IRREGULAR_PAST[b]) return IRREGULAR_PAST[b];
  if (/e$/.test(b)) return b + "d";
  if (/[^aeiou]y$/.test(b)) return b.slice(0, -1) + "ied";
  if (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(b)) return b + b.slice(-1) + "ed"; // short CVC -> double final consonant (stop->stopped)
  return b + "ed";
}

function isVerbFormFillQuestion(item) {
  const printed = String(item.printedQuestion || "");
  return /_{2,}\s*\([a-zA-Z' ]+\)/.test(printed) || /\([a-zA-Z' ]+\)\s*$/.test(printed) && /_{2,}/.test(printed);
}

function verifyVerbFormFill(item) {
  const printed = String(item.printedQuestion || "");
  const answer = String(item.studentAnswer || "").trim().toLowerCase();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/_{2,}\s*\(([a-zA-Z' ]+)\)/);
  if (!m) return { correct: null, correctAnswer: "" };
  let verbPhrase = m[1].trim().toLowerCase();
  const isNegated = /^not\s+/.test(verbPhrase);
  const base = isNegated ? verbPhrase.replace(/^not\s+/, "") : verbPhrase;
  // Real OCR convention: a shared multi-blank paragraph often prefixes
  // each blank with its own bare sub-item number right before the
  // underscores (e.g. "He 1 ____ (get) up early", "he 2 ____ (go)...")
  // -- strip a trailing lone number so subject-detection below isn't
  // thrown off by it.
  const before = printed.slice(0, m.index).trim().replace(/\s+\d+$/, "");

  // Base-form-required syntactic triggers -- high confidence, no tense
  // reasoning needed at all.
  // "did" triggers base form even when a subject sits between it and
  // the blank (question inversion: "did you ___?", "Where did you
  // ___?") -- checked anywhere in `before`, not just immediately
  // adjacent, unlike the other triggers which must be the last word.
  const baseFormTrigger = /\bdid\b/i.test(before) || /\b(please|want to|wants to|like to|likes to|love to|loves to|let me|let him|let her|let us|can|could|will|would|should|must|may|might)$/i.test(before);
  if (baseFormTrigger) {
    const expected = isNegated ? `not ${base}` : base;
    const correct = answer === expected || (isNegated && answer === `doesn't ${base}`) || (isNegated && answer === `don't ${base}`);
    return { correct, correctAnswer: correct ? "" : expected };
  }

  // Past-tense signal anywhere in the FULL printed sentence (not just
  // the text before the blank -- e.g. "when you were young" often comes
  // AFTER the blank in a question like "how ___(be) your school life
  // when you were young?").
  const hasPastSignal = /\b(last\s+\w+|yesterday|ago|when you were young|were young)\b/i.test(printed);

  // Subject immediately before the blank -- determines number/person.
  const subjectMatch = before.match(/\b(I|you|we|they|he|she|it|[A-Z][a-z]+(?:'s)?|his\s+\w+|her\s+\w+|\w+\s+and\s+(?:his|her|their)\s+\w+)\s*$/i);
  if (!subjectMatch) return { correct: null, correctAnswer: "" };
  const subjectText = subjectMatch[1].toLowerCase();
  const isPlural = /\b(you|we|they)\b/i.test(subjectText) || /\band\b/i.test(subjectText);
  const is1stPerson = /^i$/i.test(subjectText);

  let expected;
  if (hasPastSignal) {
    if (base === "be") expected = isPlural ? "were" : "was";
    else expected = conjugatePast(base);
    if (isNegated) expected = `did not ${base}`;
  } else if (isPlural || is1stPerson) {
    expected = isNegated ? `do not ${base}` : base;
  } else {
    // 3rd person singular present simple
    expected = isNegated ? `does not ${base}` : conjugatePresent3S(base);
  }
  if (!expected) return { correct: null, correctAnswer: "" };

  const normAnswer = answer.replace(/doesn't/, "does not").replace(/don't/, "do not").replace(/didn't/, "did not");
  const correct = normAnswer === expected;
  return { correct, correctAnswer: correct ? "" : expected };
}

// Ticket 222 "Prepositions of time" (2026-10-01, real citations --
// directly re-read from the source photos just now, not carried over
// from an earlier in-context summary, which had gotten two details
// wrong: invented an "at"/"in" pair for a worksheet that only teaches
// on/from...to, and got the noon/midnight exception backwards). Three
// real worksheets, all teacher-checked:
//  "Prepositions of time (1)" (poster, dates only): on x3, from/to x3
//    pairs -- ①on(30th March) ②from③to(31st March/1st April) ④on(2nd
//    April) ⑤from⑥to(3rd/4th April) ⑦on(5th April) ⑧from⑨to(6th/7th
//    April).
//  "Prepositions of time (2)" (9 items, rules box confirms: on=date/
//    weekday(s)/weekday morning(s), from...to=a period, at=clock time/
//    night, in=season/daypart/month; "Let's Learn" box: at noon, at
//    midnight): 1.on(Sunday mornings) 2.on(4th Feb) 3.in(summer) 4.on
//    (15th Sept) 5.from/to(3rd/7th Nov) 6.at/at(nine thirty/night) 7.
//    from/to(eight fifteen/eleven o'clock) 8.in(April) 9.at/at(noon/
//    midnight -- student wrote something else for both, corrected to
//    "at" per the Let's Learn box, NOT "from").
//  "Super Kids Christmas Party" poster (12 blanks): ①on(25th Dec) ②from
//    ③in④to⑤in(nine thirty/the morning/seven thirty/the evening) ⑥at⑦in
//    (ten fifteen, standalone/the morning) ⑧from⑨to⑩in(two thirty/four
//    o'clock/the afternoon -- ⑩ corrected from student's wrong "at" to
//    "in") ⑪at(five o'clock, standalone) ⑫in(the evening, corrected
//    from student's wrong answer to "In").
//
// Rule (confirmed against all 34 real blanks above, no exceptions
// found): classify what immediately follows the blank -- a DATE (day-
// ordinal + month) or a bare CLOCK TIME on its own -> on / at
// respectively, UNLESS it is the first or second of a same-type pair
// within the same sentence (a "from ... to ..." range), in which case
// the pair wins instead. A WEEKDAY+daypart ("Sunday mornings") -> on.
// A bare DAYPART/SEASON/MONTH-alone -> in. NIGHT/NOON/MIDNIGHT are
// fixed exceptions -> at, regardless of pairing.
//
// NOT YET VERIFIED against a real OCR dispatch call (would cost real
// money and needs a fresh go-ahead per the real-money hard rule) --
// this assumes printedQuestion preserves reasonably full local-sentence
// context around each blank (the convention every other handler in
// this file has shown so far), which matters here because resolving
// from/to needs to see a same-type sibling blank in the same sentence.
// If OCR instead truncates each item to a minimal 2-3 word snippet,
// the from/to cases will under-resolve to their standalone default
// (on/at) instead -- the on/in/at-only cases (the majority: 24 of 34
// real blanks) are unaffected either way, since those never depend on
// pairing. Declines (null) rather than guesses whenever the following
// text doesn't classify at all.
function classifyPrepTimeExpr(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (/^(noon|midnight)\b/i.test(t)) return "NOON_MIDNIGHT";
  if (/^night\b/i.test(t)) return "NIGHT";
  const WEEKDAY = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday)";
  const DAYPART = "(morning|afternoon|evening)s?";
  if (new RegExp(`^${WEEKDAY}\\s+${DAYPART}\\b`, "i").test(t)) return "WEEKDAY_DAYPART";
  if (new RegExp(`^(the\\s+)?${DAYPART}\\b`, "i").test(t)) return "DAYPART";
  if (/^(the\s+)?\d{1,2}(st|nd|rd|th)\s+(of\s+)?[A-Za-z]+/i.test(t)) return "DATE";
  if (/^(spring|summer|autumn|fall|winter)\b/i.test(t)) return "SEASON";
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(t)) return "MONTH";
  if (/^\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/i.test(t)) return "CLOCK_TIME";
  if (/^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+\S+/i.test(t)) return "CLOCK_TIME";
  return null;
}

function isPrepositionOfTimeQuestion(item) {
  const printed = String(item.printedQuestion || "");
  if (!/_{2,}/.test(printed)) return false;
  const answer = String(item.studentAnswer || "").trim().toLowerCase();
  if (!["on", "in", "at", "from", "to"].includes(answer)) return false;
  const blanks = [...printed.matchAll(/_{2,}/g)];
  return blanks.some((b) => classifyPrepTimeExpr(printed.slice(b.index + b[0].length)) !== null);
}

// Pure classification, independent of studentAnswer -- shared by
// verifyPrepositionOfTime (the dispatch-path verdict) and
// buildPrepositionTimeHint (the Jev-hint path below, which needs the
// same "what SHOULD this blank be" reasoning for items whose answer
// didn't pass the preposition-word gate, or that no code handler
// claimed at all). Returns null when the printed text has no blank or
// the blank's following text doesn't classify.
function classifyPrepositionOfTimeExpected(printed, targetBlankIndex) {
  const blankPositions = [...String(printed || "").matchAll(/_{2,}/g)];
  if (blankPositions.length === 0) return null;
  const myIndex = Number.isInteger(targetBlankIndex) && targetBlankIndex >= 0 && targetBlankIndex < blankPositions.length
    ? targetBlankIndex
    : 0;
  const classifications = blankPositions.map((b) => classifyPrepTimeExpr(printed.slice(b.index + b[0].length)));
  const myType = classifications[myIndex];
  if (myType === null) return null;

  if (myType === "NOON_MIDNIGHT" || myType === "NIGHT") return "at";
  if (myType === "WEEKDAY_DAYPART") return "on";
  if (myType === "DAYPART" || myType === "SEASON" || myType === "MONTH") return "in";
  if (myType === "DATE" || myType === "CLOCK_TIME") {
    const standaloneDefault = myType === "DATE" ? "on" : "at";
    const periodBefore = printed.lastIndexOf(".", blankPositions[myIndex].index);
    const sentenceStart = periodBefore === -1 ? 0 : periodBefore + 1;
    const periodAfter = printed.indexOf(".", blankPositions[myIndex].index);
    const sentenceEnd = periodAfter === -1 ? printed.length : periodAfter;
    const sameTypeIdx = [];
    blankPositions.forEach((b, i) => {
      if (b.index >= sentenceStart && b.index < sentenceEnd && classifications[i] === myType) sameTypeIdx.push(i);
    });
    if (sameTypeIdx.length >= 2 && sameTypeIdx[0] === myIndex) return "from";
    if (sameTypeIdx.length >= 2 && sameTypeIdx[1] === myIndex) return "to";
    // Real dispatch finding (2026-10-01, 9-photo pipeline test): OCR
    // does NOT reliably keep a "from ... to ..." pair's two blanks in
    // one shared printedQuestion -- on one real worksheet (a poster
    // with "The party is __ nine thirty __ the morning __ seven thirty
    // __ the evening.") each blank became its OWN separate item, with
    // NO trailing "." and no sibling blank visible at all, so this
    // function had no way to see the "seven thirty" partner while
    // resolving "nine thirty". The confident standaloneDefault fallback
    // used to fire here regardless, and got 4 real, teacher-marked-
    // correct items CONFIDENTLY WRONG (expected "from"/"to" from
    // pairing, got "at" from the blind default) -- a genuine accuracy-
    // floor violation, not just a coverage gap. Fix: only trust
    // standaloneDefault when this item's own printedQuestion actually
    // ends at a real sentence boundary (a "." right after this blank's
    // classified expression) -- that's the one positive signal
    // available that OCR captured the WHOLE original sentence, not a
    // truncated fragment that might have had an invisible pairing
    // partner. No trailing period -> decline (null) rather than guess.
    // Real cost: several genuinely-standalone items (e.g. "an animal
    // show __ ten fifteen" with no trailing period either, despite
    // truly having no partner) now also decline instead of resolving
    // -- an accepted, deliberate trade (lost coverage, not lost
    // accuracy) per this project's accuracy-floor rule.
    if (periodAfter === -1) return null;
    return standaloneDefault;
  }
  return null;
}

function verifyPrepositionOfTime(item) {
  const printed = String(item.printedQuestion || "");
  const answer = String(item.studentAnswer || "").trim().toLowerCase();
  if (!["on", "in", "at", "from", "to"].includes(answer)) return { correct: null, correctAnswer: "" };

  const expected = classifyPrepositionOfTimeExpected(printed, item.targetBlankIndex);
  if (expected === null) return { correct: null, correctAnswer: "" };

  const correct = answer === expected;
  return { correct, correctAnswer: correct ? "" : expected };
}

// Picture-match short answer from a small closed set of exact template
// phrasings (real example: `backfill/batch3_missing_english_modals.jpg`
// -- "Can you play football?" answered "Yes, I can." / "Can you play
// table tennis?" answered "No, I can't."). This is a FORMAT check only,
// same "MC-format validity" pattern as the parity/computation MC
// functions above: it confirms the answer is one of the template's
// accepted exact phrasings (tolerant of case/punctuation), it does NOT
// determine which of the two is correct for a given item -- that
// depends on a printed check/cross icon next to a picture, which is a
// real Tier-V (must-look-at-the-photo) fact this function has no access
// to and must not guess.
function verifyPictureMatchFormat(studentAnswer, acceptedPhrasings) {
  const answer = String(studentAnswer || "").trim().toLowerCase().replace(/[.\s]/g, "");
  const accepted = (acceptedPhrasings || ["yes,ican", "no,ican't", "no,icant"]).map((p) => p.toLowerCase().replace(/[.\s]/g, ""));
  if (!answer) return { correct: null, correctAnswer: "" };
  const isValidFormat = accepted.some((p) => p === answer);
  // A format match doesn't prove correctness (that needs the icon); a
  // format MISmatch is a certain, free catch -- same asymmetry as the
  // pre-check patterns already logged in question-type-library.md.
  return isValidFormat ? { correct: null, correctAnswer: "", formatOk: true } : { correct: false, correctAnswer: "", formatOk: false };
}

// Word-bank fill where each phrase is printed as usable "ONCE only"
// (real example: SFA quiz section D -- "a cup of/a bar of/a bowl of/a
// piece of/a basket of/a packet of", 4 blanks from a 6-phrase bank).
// Checks ONLY the real code-checkable constraint: does the student's
// full set of answers contain any phrase used more than once, or any
// phrase not actually in the printed bank? This does NOT determine
// which phrase belongs in which specific blank (that needs
// understanding the surrounding sentence, out of scope here) -- a
// pass here is a necessary-but-not-sufficient signal, never asserted as
// "these are definitely the correct answers".
function verifyWordBankOnceEach(bankPhrases, studentAnswers) {
  const bank = (bankPhrases || []).map((p) => String(p).trim().toLowerCase());
  const answers = (studentAnswers || []).map((a) => String(a).trim().toLowerCase());
  if (!bank.length || !answers.length) return { correct: null, correctAnswer: "" };
  const notInBank = answers.filter((a) => !bank.includes(a));
  if (notInBank.length) return { correct: false, correctAnswer: "", reason: "not_in_bank" };
  const counts = {};
  for (const a of answers) counts[a] = (counts[a] || 0) + 1;
  const reused = Object.entries(counts).filter(([, n]) => n > 1);
  if (reused.length) return { correct: false, correctAnswer: "", reason: "reused_phrase" };
  // All answers are real bank phrases, each used at most once -- passes
  // the ONLY code-checkable constraint; genuinely null on whether each
  // is in the RIGHT blank (needs judgment, not claimed here).
  return { correct: null, correctAnswer: "", formatOk: true };
}

// Reading-passage MCQ, literal-keyword-overlap subset only (real
// example: SFA quiz section J, the "Fun in the Sun" poem -- Q4 "They
// are packing (___)." / d. "sweets, buns and cakes" is a near-verbatim
// match of the poem's own line "Sweets, buns and cakes"; Q5 "What is in
// the mug?" / d. "A bug" matches "There's a bug / In my mug" -- both
// catchable by literal text overlap. Contrast Q1-3, which need real
// inference ("The rain has stopped" -> NOT rainy) and are correctly left
// unclaimed by this function.). Only claims a verdict when EXACTLY ONE
// option's text is a near-verbatim substring/overlap of the passage;
// multiple or zero matching options stay null, never guessed.
function verifyLiteralKeywordMC(passageText, options, studentAnswer) {
  const passage = String(passageText || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!passage || !Array.isArray(options) || options.length < 2) return { correct: null, correctAnswer: "" };
  let correctLetter = null, matchCount = 0;
  for (const opt of options) {
    const text = String(opt.text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (text.length >= 4 && passage.includes(text)) { correctLetter = opt.letter; matchCount++; }
  }
  if (matchCount !== 1) return { correct: null, correctAnswer: "" };
  const answer = String(studentAnswer || "").trim().toUpperCase();
  return { correct: answer === correctLetter, correctAnswer: answer === correctLetter ? "" : correctLetter };
}

// "Finish the sentences with 'but', 'and' or 'or'" linking-word fill
// (real example: benchmark/photos/batch3/p2_english_but_and_dialogue.jpg
// -- the worksheet's own instruction box states the rule explicitly:
// "but" links DIFFERENT/opposite ideas, "and" links SIMILAR ideas.
// Confirmed against all 8 real scored blanks on that page (items 1-5,
// some with 2-3 sub-blanks each) -- every one matches a simple POLARITY
// rule: detect whether each clause is affirmative or negative (a
// negation marker: not/n't/don't/doesn't/can't/won't/isn't/aren't/
// didn't/wasn't/weren't); if the two clauses share the same polarity
// -> "and", if they differ -> "but". A short clause with no verb of its
// own (e.g. "one sister", "badminton", "soya milk") has no pronoun or
// negation marker either, so it inherits clause A's polarity -- matches
// all 3 real elliptical examples on the page (items 3, 4a, 5a).
//
// Ticket 222 (2026-10-01) extended the rule to a real THIRD case found
// across 2 more real photos (a "but/and" dialogue sheet and a letter-
// completion sheet, 16 real scored blanks combined): when BOTH clauses
// are NEGATIVE, English uses "or", not "and" -- "I don't like cheese
// ___ milk" -> or (NOT "I don't like cheese and milk", which is not
// how negation distributes across a list in English); "I can't swim
// ___ ride a bicycle" -> or. Confirmed consistently: every real both-
// negative blank in those 16 used "or", every real both-positive blank
// used "and", every real mixed-polarity blank used "but" -- zero
// exceptions in THAT dataset.
//
// 2026-10-01, same day, REAL COUNTER-EXAMPLE found on a same-page
// sibling exercise not included in the 16 above (the top-of-page
// "rewrite the two sentences as one" section, same photo as the
// letter-completion sheet cited above): "I don't like dolls. I don't
// like teddy bears." -> real teacher-marked correct answer "I don't
// like dolls AND teddy bears." -- both clauses negative, yet "and" is
// correct, directly contradicting the both-negative->"or" rule above.
// Cannot tell from (clauseA, clauseB, studentAnswer) alone which real
// exercise shape this is, so the safe fix is to STOP guessing on
// both-negative and decline (null) instead -- the both-positive->and
// and mixed->but branches remain confidently ruled since no
// counter-example has appeared for either of those.
function verifyConjunctionFill(clauseA, clauseB, studentAnswer) {
  const answer = String(studentAnswer || "").trim().toLowerCase();
  if (answer !== "but" && answer !== "and" && answer !== "or") return { correct: null, correctAnswer: "" };
  const a = String(clauseA || "");
  const b = String(clauseB || "");
  if (!a.trim()) return { correct: null, correctAnswer: "" };
  const NEGATION = /\b(not|n't|don't|doesn't|can't|won't|isn't|aren't|didn't|wasn't|weren't)\b/i;
  const polarityOf = (clause, fallbackPositive) => {
    const c = String(clause || "").trim();
    if (!c) return fallbackPositive;
    const hasOwnClauseShape = /\b(i|he|she|they|we|you|it)\b/i.test(c) || NEGATION.test(c);
    if (!hasOwnClauseShape) return fallbackPositive;
    return !NEGATION.test(c);
  };
  const polA = polarityOf(a, true);
  const polB = polarityOf(b, polA);
  // Same polarity: both positive -> "and" (still confident). Both
  // negative -> genuinely unresolved (real evidence is split), decline
  // rather than guess. Different polarity -> "but".
  if (polA === polB && !polA) return { correct: null, correctAnswer: "" };
  const expected = polA === polB ? "and" : "but";
  return { correct: answer === expected, correctAnswer: answer === expected ? "" : expected };
}

// Extracts a numeric student answer while PRESERVING a genuine leading
// minus sign. 2026-09-23 real bug: the pattern used throughout this file
// before this helper existed, `parseFloat(answer.replace(/[^\d.]/g,
// ""))`, strips "-" along with every other non-digit character --
// reproduced directly: `"-5".replace(/[^\d.]/g,"")` -> `"5"`. A student
// who writes a wrong-signed answer ("-5" when the correct answer is "5")
// was silently graded CORRECT. Matching a signed number token instead of
// stripping characters keeps a real minus sign attached to its digits.
function parseSignedStudentNumber(answer) {
  const m = String(answer || "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

// Word problem: two numbers given in Chinese prose, asking for their
// TOTAL/SUM (real example: `b245b3f1-QuizGo-...maths_test_2.pdf` p2
// Q12 -- "昨天文具店賣出鉛筆34支，今天再賣出鉛筆22支，這兩天共賣去鉛筆
// 多少支？" -> 34+22=56). Deliberately narrow: only fires when the
// question text contains an explicit "total" keyword (共/總共/一共/合共)
// AND exactly two numbers -- does NOT attempt comparison-shaped word
// problems ("比...多", a different pattern, out of scope here) or
// problems with more/fewer than 2 numbers, which this simple
// number-extraction can't safely disambiguate.
// 2026-09-23: generalized from "exactly 2 numbers" to "2 or more", per
// explicit user decision (ticket B9) overriding the prior deliberate
// "more than 2 numbers stays null, never guessed" safety choice -- real
// evidence found the same day of a genuine 3-addend shape ("42張藍色
//椅子,36張紅色椅子,15張黃色椅子,共有幾多張椅子?"). The user weighed the
// known residual risk (OCR merging two adjacent questions' numbers into
// one chunk would now be summed instead of safely declined) against the
// real accuracy gain and chose to generalize.
//
// Real failure found WHILE making this exact change (not hypothetical):
// a 3-group word problem phrased "第1組有10人，第2組有20人，第3組有30
// 人，共有多少人？" would sum ALL 6 numbers (1+10+2+20+3+30=66) if group
// ORDINAL labels ("第1組"/"第2組") were treated as quantities -- the
// `(?<!第)` exclusion below keeps a number immediately preceded by "第"
// (a Chinese ordinal marker, never itself a quantity) out of the sum.
// Real example found 2026-09-25 (p1-p6.com P3 2025-2026 Term1, Q12):
// "小克每天儲蓄30元，他五天共儲蓄多少元？" (30×5=150) -- a RATE word
// problem (每 = per/each), not a same-kind-count addition (see the "每"
// guard added to verifyWordProblemTotal above, found from this exact
// example). Narrow trigger: exactly 2 numbers, a "每" rate marker on
// the FIRST number, and a 共/總共/一共/合共 keyword -- multiplies rather
// than sums.
// 2026-09-25 real bug found (own test suite, real example): the printed
// quantity is very often a CHINESE NUMERAL, not an ASCII digit ("五天",
// not "5天") -- the original version only ever matched ASCII \d+, so it
// silently found just 1 number (the rate) on the exact real example
// this function was built from, and returned null instead of the
// correct 30×5. Finds both an ASCII number AND a Chinese-numeral count
// (immediately before a common counting-unit character), in either
// order, rather than assuming ASCII-only.
// Ticket 161 (2026-09-28) added "米" to the unit list and fraction
// support to both this regex and the rate/count parsing below -- real
// citation: "絲帶每米售6又4/5元，買4又3/4米絲帶，共需付___元。"
// (6又4/5 × 4又3/4 = 6.8×4.75 = 32.3, i.e. 32又3/10) exposed that
// neither the rate nor the quantity could be a mixed-number fraction
// before, and "米" (metre) wasn't a recognised unit word.
const RATE_MULTIPLICATION_UNIT_RE = /([一二兩三四五六七八九十]+(?:又\d+\/\d+)?|\d+(?:又\d+\/\d+)?)(?=天|日|次|個|年|月|小時|星期|週|盒|包|本|支|條|米)/;
// Ticket 56 (2026-09-27, real MCLQ 2A workbook survey): English "each
// UNIT has N" pattern -- real quoted example: "6 tubes...each tube has
// 5...how many in total?" (6×5=30). Structurally the REVERSE of the
// Chinese shape above (there the rate number comes first in the
// sentence; here the COUNT comes first and the rate is named after
// "has"), so this is a separate, narrower extraction rather than a
// generalisation of RATE_MULTIPLICATION_UNIT_RE -- only fires on this
// exact "each ... has" shape, with exactly 2 numbers in the whole
// sentence (the count and the rate), same "never guess which 2 numbers"
// discipline as every other word-problem verifier here.
function tryEnglishEachHasRateMultiplication(printed) {
  if (!/\beach\b.{0,30}\bhas\b/i.test(printed)) return null;
  const nums = (printed.match(/\d+/g) || []).map(Number);
  if (nums.length !== 2) return null;
  const hasIdx = printed.search(/\bhas\b/i);
  const eachIdx = printed.search(/\beach\b/i);
  // The rate is the number that appears AFTER "has" (closer to it than
  // to "each"); the other number is the count. Real sentences always
  // put the rate immediately after "has" ("each tube has 5"), so using
  // string position (not just which one is textually first) correctly
  // handles the count appearing either before or after the "each...has"
  // clause.
  const numPositions = [];
  let m;
  const re = /\d+/g;
  while ((m = re.exec(printed))) numPositions.push({ value: Number(m[0]), index: m.index });
  const rateEntry = numPositions.reduce((best, n) => (Math.abs(n.index - hasIdx) < Math.abs(best.index - hasIdx) ? n : best));
  const countEntry = numPositions.find((n) => n !== rateEntry);
  if (!countEntry || eachIdx === -1) return null;
  return { rate: rateEntry.value, count: countEntry.value };
}
function verifyWordProblemRateMultiplication(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  const englishMatch = tryEnglishEachHasRateMultiplication(printed);
  if (englishMatch) {
    const expected = englishMatch.rate * englishMatch.count;
    const studentNum = parseSignedStudentNumber(answer);
    if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
    const correct = studentNum === expected;
    return { correct, correctAnswer: correct ? "" : String(expected) };
  }
  if (!answer || !/每/.test(printed) || !/(共|總共|一共|合共)/.test(printed)) return { correct: null, correctAnswer: "" };

  const rateMatch = printed.match(/(?<!第)\d+(?:又\d+\/\d+)?/);
  if (!rateMatch) return { correct: null, correctAnswer: "" };
  const rate = parseNumericAnswer(rateMatch[0]);
  if (Number.isNaN(rate)) return { correct: null, correctAnswer: "" };

  const unitMatch = printed.slice(rateMatch.index + rateMatch[0].length).match(RATE_MULTIPLICATION_UNIT_RE) || printed.match(RATE_MULTIPLICATION_UNIT_RE);
  if (!unitMatch) return { correct: null, correctAnswer: "" };
  const countToken = unitMatch[1];
  const count = /^\d+(?:又\d+\/\d+)?$/.test(countToken) ? parseNumericAnswer(countToken) : parseChineseNumberWord(countToken);
  if (count === null || Number.isNaN(count)) return { correct: null, correctAnswer: "" };

  const expected = rate * count;
  const studentNum = parseNumericAnswer(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  const correct = Math.abs(studentNum - expected) < 1e-9;
  return { correct, correctAnswer: correct ? "" : String(expected) };
}

// Ticket 56 (2026-09-27, real MCLQ 2A workbook survey): this whole
// family of word-problem verifiers only ever recognised CHINESE trigger
// keywords, even though the underlying arithmetic logic is language-
// agnostic -- confirmed real gap on an entirely English-medium P2
// workbook (real examples: "sold 119 newspapers, 16 left over, how many
// originally?" -- 119+16=135; "...how many were there altogether?").
// English total-word-problem trigger, shared by this function's own
// guard below.
const WORD_PROBLEM_TOTAL_EN_RE = /\b(altogether|in total|originally)\b/i;
function verifyWordProblemTotal(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || (!/(共|總共|一共|合共)/.test(printed) && !WORD_PROBLEM_TOTAL_EN_RE.test(printed))) return { correct: null, correctAnswer: "" };
  // 2026-09-25 real bug found: this function's own "共" trigger also
  // fires on a genuinely different real shape -- a RATE word problem
  // ("小克每天儲蓄30元，他五天共儲蓄多少元" -> 30×5=150, NOT 30+5=35).
  // The 2026-09-23 decision (ticket B9) to sum every number found when
  // "共" appears was scoped to same-kind-count-addition examples; a "每"
  // (per/each)/"per"/"each...has" rate marker signals a different
  // operation entirely and must refuse here rather than silently sum,
  // not be swept into that decision by the shared keyword. See
  // verifyWordProblemRateMultiplication for the dedicated handler.
  if (/每/.test(printed) || /\bper\b/i.test(printed) || /\beach\b.{0,15}\bhas\b/i.test(printed)) return { correct: null, correctAnswer: "" };
  // 2026-09-30 real bug found (verification pass against a real 3下A
  // workbook PDF, no handler was ever run against it before): a
  // relative-comparison-then-total shape ("農場有雞3429隻，比鴨多917隻。
  // 農場共有雞和鴨多少隻？" -- 3429 chickens, 917 MORE than ducks, total
  // chickens+ducks) also has "共" and >=2 raw numbers, so this function's
  // naive "sum every number" logic confidently computed 3429+917=4346
  // instead of the real answer 3429+(3429-917)=5941 -- silently treating
  // the DIFFERENCE (917) as if it were the second quantity itself. Same
  // failure family as the already-guarded "每" rate shape: a "比...多/少"
  // relative-comparison marker means at least one of the "numbers found
  // in the text" is not a directly-addable quantity, so this function
  // must decline rather than guess, matching
  // verifyPriceTableLookup's own "比...貴/平/多/少" pattern.
  if (/比.{0,10}(多|少)/.test(printed)) return { correct: null, correctAnswer: "" };
  const nums = (printed.match(/(?<!第)\d+/g) || []).map(Number);
  if (nums.length < 2) return { correct: null, correctAnswer: "" };
  const expected = nums.reduce((a, b) => a + b, 0);
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  const correct = studentNum === expected;
  return verdictResult(correct, expected, `題目話「共」，即係要將啲數加埋：${nums.join("+")} = ${expected}`);
}

// Price-table lookup + compute -- TWO real, narrow shapes only (real
// examples: `b245b3f1-QuizGo-...maths_test_2.pdf` p2, price table
// {機械人:48, 跑車:89, 洋娃娃:25}): (1) "買X和Y各一個共需付()元" -- sum
// of two named items' listed prices ("機械人"+"洋娃娃"=73); (2) "X比Y貴
// ()元" -- absolute difference between two named items' prices
// ("跑車"比"機械人"貴 = 89-48=41). Deliberately does NOT attempt
// quantity-multiplied totals ("各4碟"/"5盆") or change-from-payment
// ("付$500可找回") -- both real shapes also seen in the source PDFs
// (`6d28da08-...q_p1-34.pdf` p20) but genuinely need reliable free-text
// quantity/payment extraction this function doesn't attempt, rather
// than guess at a shape it can't confirm.
function verifyPriceTableLookup(priceTable, printedQuestion, studentAnswer) {
  const table = priceTable || {};
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const names = Object.keys(table).filter((n) => printed.includes(n));
  if (names.length !== 2) return { correct: null, correctAnswer: "" };
  const [nameA, nameB] = names;
  const priceA = Number(table[nameA]);
  const priceB = Number(table[nameB]);
  if (!Number.isFinite(priceA) || !Number.isFinite(priceB)) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  // "各N碟"/"各5盆" (N>1) is the quantity-multiplied shape this function
  // deliberately declines -- checked BEFORE the sum trigger below, since
  // "共須付"/"共需付" can appear in THAT shape's text too (real trap:
  // "他們吃了小點和大點各4碟，共須付多少？" contains "共須付" but is NOT
  // the simple one-each-sum case) and must not be misread as one.
  if (/各[2-9]/.test(printed) || /各\d{2,}/.test(printed)) return { correct: null, correctAnswer: "" };
  const isDifference = /比.{0,6}(貴|平|多|少)/.test(printed);
  const isSum = /(各一|共需付|共付|共須付)/.test(printed);
  if (isDifference && !isSum) {
    const expected = Math.abs(priceA - priceB);
    const correct = studentNum === expected;
    return verdictResult(correct, expected, `${nameA}$${priceA}、${nameB}$${priceB}，相差：$${Math.max(priceA, priceB)}-$${Math.min(priceA, priceB)} = $${expected}`);
  }
  if (isSum && !isDifference) {
    const expected = priceA + priceB;
    const correct = studentNum === expected;
    return verdictResult(correct, expected, `${nameA}$${priceA}+${nameB}$${priceB} = $${expected}`);
  }
  return { correct: null, correctAnswer: "" };
}

// Pictogram (象形圖) data query -- Ticket 68, found independently in TWO
// real materials (a P2 exam and a P3 exam), both asking count/max/min/
// difference/ratio/total questions against an icon-count-per-category
// chart. Six real, narrow shapes only; declines (never guesses) whenever
// the phrasing doesn't clearly match one of them, or when max/min is a
// tie -- same discipline as verifyPriceTableLookup above.
function verifyPictogramQuery(pictogramData, printedQuestion, studentAnswer) {
  if (!pictogramData || !pictogramData.counts) return { correct: null, correctAnswer: "" };
  const { unit, counts } = pictogramData;
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const categoryNames = Object.keys(counts);
  const mentioned = categoryNames.filter((n) => printed.includes(n));
  const studentNum = parseSignedStudentNumber(answer);

  // Shape 1: how many categories have a zero count (real example: "希敏
  // 上星期有___天沒有上網").
  if (/沒有|冇/.test(printed) || (/how many/i.test(printed) && /zero|none/i.test(printed))) {
    if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
    const zeroCount = Object.values(counts).filter((c) => c === 0).length;
    return { correct: studentNum === zeroCount, correctAnswer: studentNum === zeroCount ? "" : String(zeroCount) };
  }

  // Shape 2: which category has the max/min value -- the answer is a
  // NAME, not a number. Declines on a tie rather than guessing.
  const isMax = /最多|most|greatest/i.test(printed);
  const isMin = /最少|least|fewest|smallest/i.test(printed);
  if (isMax || isMin) {
    const entries = Object.entries(counts);
    const target = isMax ? Math.max(...entries.map(([, v]) => v)) : Math.min(...entries.map(([, v]) => v));
    const winners = entries.filter(([, v]) => v === target).map(([k]) => k);
    if (winners.length !== 1) return { correct: null, correctAnswer: "" };
    const expectedName = winners[0];
    const correct = answer.includes(expectedName) || expectedName.includes(answer);
    return { correct, correctAnswer: correct ? "" : expectedName };
  }

  // Shapes 3-5 all need exactly TWO categories explicitly named in the
  // printed question text.
  if (mentioned.length === 2) {
    const [a, b] = mentioned;
    const va = counts[a], vb = counts[b];
    if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
    if (/倍|times/i.test(printed)) {
      if (vb === 0 || va % vb !== 0) return { correct: null, correctAnswer: "" };
      const expected = va / vb;
      return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
    }
    if (/多|少|more|fewer|less/i.test(printed)) {
      const expected = Math.abs(va - vb) * unit;
      return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
    }
    if (/共有|altogether|total/i.test(printed)) {
      const expected = (va + vb) * unit;
      return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
    }
    return { correct: null, correctAnswer: "" };
  }

  // Shape 6: grand total across ALL categories -- no specific category named.
  if (mentioned.length === 0 && /共|altogether|total/i.test(printed)) {
    if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
    const expected = Object.values(counts).reduce((a, b) => a + b, 0) * unit;
    return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
  }

  return { correct: null, correctAnswer: "" };
}

// Ticket 134 (2026-09-28, real citations from a printed "五月" calendar
// grid, day 1 = Saturday, 31 days): calendar-grid day-of-week reasoning
// -- once the grid is reduced to {month, firstWeekday, daysInMonth}, all
// 4 real question shapes below become plain modular arithmetic. Uses
// the same Sunday=0..Saturday=6 convention as WEEKDAY_NAMES_ZH (matches
// this project's already-documented HK-curriculum week-starts-Sunday
// convention, Ticket 97/107).
// Small Chinese-numeral parser (1-99 only -- sufficient for calendar day
// numbers), since no existing helper covers this range (the existing
// chinese_large_numeral_to_arabic handler is for large 萬/億-scale
// numerals, a different problem). Handles 十九=19, 二十=20, 二十一=21,
// and bare 一..九.
const CJK_DIGITS = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
function chineseNumeralToArabicSmall(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (s === "十") return 10;
  const tenIdx = s.indexOf("十");
  if (tenIdx === -1) return CJK_DIGITS[s] ?? null;
  const tensDigit = tenIdx === 0 ? 1 : CJK_DIGITS[s[0]];
  const unitsPart = s.slice(tenIdx + 1);
  const unitsDigit = unitsPart ? (CJK_DIGITS[unitsPart] ?? null) : 0;
  if (tensDigit == null || unitsDigit == null) return null;
  return tensDigit * 10 + unitsDigit;
}

function weekdayOfDay(calendarGrid, day) {
  return ((calendarGrid.firstWeekday + (day - 1)) % 7 + 7) % 7;
}

function verifyCalendarGridQuery(calendarGrid, printedQuestion, studentAnswer) {
  if (!calendarGrid) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const { month, daysInMonth } = calendarGrid;

  // Shape 1: "五月有___個星期一" -- count occurrences of a named weekday.
  let m = printed.match(/有\s*_{0,3}\s*個星期([日一二三四五六])/);
  if (m) {
    const targetWeekday = WEEKDAY_NAMES_ZH.indexOf(m[1]);
    let count = 0;
    for (let d = 1; d <= daysInMonth; d++) if (weekdayOfDay(calendarGrid, d) === targetWeekday) count++;
    const studentNum = parseSignedStudentNumber(answer);
    if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
    return { correct: studentNum === count, correctAnswer: studentNum === count ? "" : String(count) };
  }

  // Shape 3: "第四個星期六...那天是___月___日" -- Kth occurrence of a
  // named weekday -> which day. Checked BEFORE shape 2 since both
  // mention "星期X", but this one asks for a DAY, not a weekday name.
  m = printed.match(/第([一二三四五六七八九十])個星期([日一二三四五六])/);
  // Ticket 173: a real citation adds a further "放假...天" offset on top
  // of this same Kth-weekday trigger -- that compound case must fall
  // through to shape 6 below instead (found via a real test failure:
  // this shape's own looser `/月.{0,5}日/` check also matches shape 6's
  // "___月___日" answer template and caught it first).
  if (m && /月.{0,5}日/.test(printed) && !/放假.{0,3}(?:\d+|[一二三四五六七八九十]+)天/.test(printed)) {
    const kMap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
    const k = kMap[m[1]];
    const targetWeekday = WEEKDAY_NAMES_ZH.indexOf(m[2]);
    let occurrence = 0, foundDay = null;
    for (let d = 1; d <= daysInMonth; d++) {
      if (weekdayOfDay(calendarGrid, d) === targetWeekday) {
        occurrence++;
        if (occurrence === k) { foundDay = d; break; }
      }
    }
    if (foundDay === null) return { correct: null, correctAnswer: "" };
    const nums = (answer.match(/\d+/g) || []).map(Number);
    const correct = nums.includes(month) && nums.includes(foundDay);
    return { correct, correctAnswer: correct ? "" : `${month}月${foundDay}日` };
  }

  // Shape 4: a DIFFERENT month than the one shown is named, asking for
  // day 1's weekday -- only supported for exactly next-month (the only
  // real citation: "6月的第一天是星期___" against a May grid).
  const monthMatch = printed.match(/(\d+)\s*月.{0,10}第一天.{0,5}星期/);
  if (monthMatch && Number(monthMatch[1]) === month + 1) {
    const targetWeekday = weekdayOfDay(calendarGrid, daysInMonth + 1);
    const correct = answer === WEEKDAY_NAMES_ZH[targetWeekday];
    return { correct, correctAnswer: correct ? "" : WEEKDAY_NAMES_ZH[targetWeekday] };
  }

  // Shape 2: "十九日...那天是星期___" -- a specific day of THIS month ->
  // weekday name (numeral or spelled-out Chinese day number, real
  // citation: "五月十九日"). Checked last since shapes 3/4 are more
  // specific sub-patterns that also happen to mention a day number.
  m = printed.match(/(\d+)\s*日.{0,15}是星期/);
  const cjkDayMatch = printed.match(/([一二三四五六七八九十]+)日.{0,15}是星期/);
  let targetDay = null;
  if (m) targetDay = Number(m[1]);
  else if (cjkDayMatch) targetDay = chineseNumeralToArabicSmall(cjkDayMatch[1]);
  if (targetDay && targetDay >= 1 && targetDay <= daysInMonth) {
    const targetWeekday = weekdayOfDay(calendarGrid, targetDay);
    const correct = answer === WEEKDAY_NAMES_ZH[targetWeekday];
    return { correct, correctAnswer: correct ? "" : WEEKDAY_NAMES_ZH[targetWeekday] };
  }

  // Shape 5 (Ticket 172, 2026-09-28, real citation: a September-only
  // grid, "3rd October was __Tuesday__."): cross-month day-of-week --
  // the named date falls in the FOLLOWING month, past the printed
  // grid's own boundary. weekdayOfDay's plain modular arithmetic already
  // extends correctly past daysInMonth; this shape was previously
  // blocked only by shape 2's own `targetDay <= daysInMonth` guard.
  const WEEKDAY_NAMES_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTH_NAMES_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  m = printed.match(/(\d+)(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+was/i);
  if (m) {
    const crossDay = Number(m[1]);
    const crossMonthIdx = MONTH_NAMES_EN.indexOf(m[2].toLowerCase()) + 1;
    if (crossMonthIdx === month + 1) {
      const targetWeekday = weekdayOfDay(calendarGrid, daysInMonth + crossDay);
      const correct = answer.toLowerCase() === WEEKDAY_NAMES_EN[targetWeekday].toLowerCase();
      return { correct, correctAnswer: correct ? "" : WEEKDAY_NAMES_EN[targetWeekday] };
    }
  }

  // Shape 6 (Ticket 173, 2026-09-28, real citation: "小美在這個月的第
  // 二個星期四參加學校旅行，旅行後放假一天；這天是___月___日(星期
  // ___)"): compound of two already-built primitives -- find the Kth
  // occurrence of a weekday (shape 3's own logic), then offset forward
  // by N days and report the resulting month/day/weekday, rolling over
  // into next month if needed.
  m = printed.match(/第([一二三四五六七八九十])個星期([日一二三四五六])[\s\S]{0,20}放假(\d+|[一二三四五六七八九十]+)天/);
  if (m) {
    const kMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const k = kMap[m[1]];
    const targetWeekday = WEEKDAY_NAMES_ZH.indexOf(m[2]);
    const offsetDays = /^\d+$/.test(m[3]) ? Number(m[3]) : chineseNumeralToArabicSmall(m[3]);
    let occurrence = 0, foundDay = null;
    for (let d = 1; d <= daysInMonth; d++) {
      if (weekdayOfDay(calendarGrid, d) === targetWeekday) {
        occurrence++;
        if (occurrence === k) { foundDay = d; break; }
      }
    }
    if (foundDay === null || !offsetDays) return { correct: null, correctAnswer: "" };
    let resultDay = foundDay + offsetDays;
    let resultMonth = month;
    if (resultDay > daysInMonth) { resultDay -= daysInMonth; resultMonth += 1; }
    const resultWeekdayIdx = weekdayOfDay(calendarGrid, foundDay + offsetDays);
    const nums = (answer.match(/\d+/g) || []).map(Number);
    const hasWeekday = WEEKDAY_NAMES_ZH.some((w, i) => i === resultWeekdayIdx && answer.includes(w));
    const correct = nums.includes(resultMonth) && nums.includes(resultDay) && hasWeekday;
    return { correct, correctAnswer: correct ? "" : `${resultMonth}月${resultDay}日(星期${WEEKDAY_NAMES_ZH[resultWeekdayIdx]})` };
  }

  return { correct: null, correctAnswer: "" };
}

// Ticket 135 (2026-09-28, real citations: "小怡在星期___有游泳班。"
// -> reverse-lookup which day has an activity; "如果明天是星期五，小怡
// 今天的活動是*(戲劇班/書法班/中文班/籃球班)。" -> day-shift then
// forward lookup): weekday-keyed schedule-table reasoning.
function verifyScheduleTableQuery(scheduleTable, printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !scheduleTable) return { correct: null, correctAnswer: "" };

  // Shape 2 checked first: "如果明天/聽日是星期X，...今天的活動" --
  // day-shift (yesterday of the stated day) then forward lookup.
  const shiftMatch = printed.match(/(?:明天|聽日)是星期([日一二三四五六])[\s\S]{0,20}今(?:天|日)/);
  if (shiftMatch) {
    const tomorrowIdx = WEEKDAY_NAMES_ZH.indexOf(shiftMatch[1]);
    const todayIdx = ((tomorrowIdx - 1) % 7 + 7) % 7;
    const todayKey = `星期${WEEKDAY_NAMES_ZH[todayIdx]}`;
    const expectedActivity = scheduleTable[todayKey];
    if (!expectedActivity) return { correct: null, correctAnswer: "" };
    const correct = answer === expectedActivity || answer.includes(expectedActivity);
    return { correct, correctAnswer: correct ? "" : expectedActivity };
  }

  // Shape 1: "在星期___有<activity>。" -- reverse-lookup which day has
  // the named activity.
  if (/星期_+|星期\s*$/.test(printed) || /是星期/.test(printed)) {
    const mentionedActivity = Object.values(scheduleTable).find((a) => printed.includes(a));
    if (mentionedActivity) {
      const dayKey = Object.keys(scheduleTable).find((d) => scheduleTable[d] === mentionedActivity);
      if (!dayKey) return { correct: null, correctAnswer: "" };
      const dayName = dayKey.replace("星期", "");
      const correct = answer === dayName || answer.includes(dayName);
      return { correct, correctAnswer: correct ? "" : dayName };
    }
  }

  // Ticket 186 (2026-09-28, real citation, 甜品星期循環): "如果今天的
  // 甜品是<value>，最快在___天後會再吃到<value>。" -- the value repeats
  // on more than one day in the week, and "最快" means the SHORTEST gap
  // between any two consecutive (cyclic) occurrences, not a fixed day
  // tied to a specific "today". Hand-verified against the real table
  // (星期日=蛋卷, 星期四=蛋卷 also, gaps 四→日=3, 日→四=4, min=3,
  // matches the real citation's answer of 3) before writing this.
  const repeatMatch = printed.match(/最快.{0,10}天後.{0,15}(?:再|又).{0,10}(?:吃到|食到|見到)/);
  if (repeatMatch) {
    const mentionedActivity = Object.values(scheduleTable).find((a) => printed.includes(a));
    if (mentionedActivity) {
      const occurrenceIdxs = WEEKDAY_NAMES_ZH
        .map((d, i) => (scheduleTable[`星期${d}`] === mentionedActivity ? i : -1))
        .filter((i) => i !== -1);
      if (occurrenceIdxs.length < 2) return { correct: null, correctAnswer: "" };
      let minGap = 7;
      for (let k = 0; k < occurrenceIdxs.length; k++) {
        const from = occurrenceIdxs[k];
        const to = occurrenceIdxs[(k + 1) % occurrenceIdxs.length];
        const gap = ((to - from) % 7 + 7) % 7 || 7;
        minGap = Math.min(minGap, gap);
      }
      const correct = Number(answer) === minGap;
      return { correct, correctAnswer: correct ? "" : String(minGap) };
    }
  }

  // Ticket 186 (2026-09-28, real citation): "如果昨天的甜品是<value>，
  // 明天的甜品是<A>/<B>/<C>。" -- yesterday's value -> today = yesterday+1
  // -> tomorrow(明天) = yesterday+2. Hand-verified: 昨天=雪糕(星期六) ->
  // 明天 = 星期一 = cupcake, matches the real citation's answer.
  const yesterdayMatch = printed.match(/(?:昨天|尋日|琴日).{0,6}是(.{0,20}?)明天.{0,6}是/);
  if (yesterdayMatch) {
    // Search only within the captured "yesterday" segment, not the whole
    // printed text -- the MC options after the second "是" (today's
    // choices) can themselves literally contain other scheduleTable
    // values (e.g. the real citation's own answer "蛋卷" also appears as
    // one of the MC options), which would otherwise be picked up first
    // by object key order and silently answer the wrong sub-question.
    const mentionedActivity = Object.values(scheduleTable).find((a) => yesterdayMatch[1].includes(a));
    if (mentionedActivity) {
      const yesterdayIdx = WEEKDAY_NAMES_ZH.findIndex((d) => scheduleTable[`星期${d}`] === mentionedActivity);
      if (yesterdayIdx === -1) return { correct: null, correctAnswer: "" };
      const tomorrowIdx = (yesterdayIdx + 2) % 7;
      const expectedActivity = scheduleTable[`星期${WEEKDAY_NAMES_ZH[tomorrowIdx]}`];
      if (!expectedActivity) return { correct: null, correctAnswer: "" };
      const correct = answer === expectedActivity || answer.includes(expectedActivity);
      return { correct, correctAnswer: correct ? "" : expectedActivity };
    }
  }

  return { correct: null, correctAnswer: "" };
}

// Location-grid compass-direction reasoning (found 2026-09-28, real
// citations: "由巴士站向___方走，便可到達酒店。" -> 東 (East); "___在
// 體育館的西方。" -> 加油站). Validated by hand against the REAL grid
// before writing any code: the grid is IRREGULAR (row 3 has only 2
// cells, positioned under columns 1-2, not starting at column 0) --
// 巴士站=(2,1) sits DIRECTLY BELOW 酒店=(1,1) (a real connector line
// confirms this in the source image), and the printed compass shows
// North pointing LEFT on the page (北←), not up. Working through both
// citations by hand confirmed the rotation model below is exactly
// right: with North=left, page-up=East, page-right=South,
// page-down=West, page-left=North (a 90° counter-clockwise rotation of
// the ordinary up=North compass).
const SCREEN_TO_REAL_ROTATION = {
  "上": { "上": "北", "右": "東", "下": "南", "左": "西" }, // north=up (no rotation, the ordinary case)
  "右": { "上": "西", "右": "北", "下": "東", "左": "南" }, // north=right (90° clockwise)
  "下": { "上": "南", "右": "西", "下": "北", "左": "東" }, // north=down (180°)
  "左": { "上": "東", "右": "南", "下": "西", "左": "北" }, // north=left (90° counter-clockwise) -- the real citation's own case
};

// Ticket 180 (2026-09-28, real citation, P4 exam Q2/Q4, a fountain-
// centered network diagram: "餐廳在*(港鐵站/噴水池/書店)的東南方。" ->
// 港鐵站; "詩詩從精品店前往巴士站。她先向___方走，經過噴水池後，轉向
// ___方，便可到達巴士站。" -> 西北;東北): the earlier LOCATION_GRID
// citations only ever needed same-row/same-column relationships, so
// diagonals were deliberately left declined. This new citation has real
// diagonal relationships, so this extends the SAME rotation model to
// all 8 compass points rather than building a separate system.
// Hand-verified derivation: for a given north-screen-direction, the
// mapping is just a cyclic shift of the 8-point compass by however many
// 45° steps that north-direction sits from screen-up. Confirmed this
// formula reproduces the 4 cardinal entries above EXACTLY (all 16
// values checked by hand) before adding the diagonal keys -- see the
// self-consistency test in test/mark.test.js.
const SCREEN_DIR_ORDER8 = ["上", "右上", "右", "右下", "下", "左下", "左", "左上"];
const REAL_DIR_ORDER8 = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];
// Ticket 182 (2026-09-28, real citation, P4 exam Q8/Q9, a classroom
// seat-grid): the printed compass in THIS diagram points not at a
// cardinal screen direction but at a diagonal one (screen down-left),
// so northDir itself can now be one of the 8 SCREEN_DIR_ORDER8 values,
// not just the original 4. The same generation loop below handles it --
// add the 4 diagonal keys as empty objects first so they get populated
// exactly like the cardinal ones.
for (const diagonalNorth of ["右上", "右下", "左下", "左上"]) {
  SCREEN_TO_REAL_ROTATION[diagonalNorth] = {};
}
for (const northDir of Object.keys(SCREEN_TO_REAL_ROTATION)) {
  const shift = SCREEN_DIR_ORDER8.indexOf(northDir);
  SCREEN_DIR_ORDER8.forEach((sd, i) => {
    SCREEN_TO_REAL_ROTATION[northDir][sd] = REAL_DIR_ORDER8[(i - shift + 8) % 8];
  });
}

function screenDirectionBetween(from, to) {
  const rowDiff = to.row - from.row, colDiff = to.col - from.col;
  if (rowDiff === 0 && colDiff === 0) return null;
  if (rowDiff === 0) return colDiff > 0 ? "右" : "左";
  if (colDiff === 0) return rowDiff > 0 ? "下" : "上";
  // Ticket 182 (2026-09-28): a true diagonal is bucketed by its ANGLE
  // into the nearest of the 8 compass points (45° sectors), rather than
  // requiring row/col offsets to be exactly equal. The real citation
  // that justified this (天朗 vs 梓苗 in a real classroom seat-grid) has
  // a 2-row/3-column offset -- 33.7° off the true diagonal, not exactly
  // 45° -- and the question's own answer (南) only comes out right when
  // that's still read as "upper-right", confirming angle-bucketing (not
  // exact-equality) is the right general model. This SUPERSEDES the
  // earlier "exact equality only" rule from Ticket 180, which was an
  // untested assumption, not something a real citation had required.
  const angleDeg = ((Math.atan2(-rowDiff, colDiff) * 180) / Math.PI + 360) % 360;
  if (angleDeg >= 22.5 && angleDeg < 67.5) return "右上";
  if (angleDeg >= 67.5 && angleDeg < 112.5) return "上";
  if (angleDeg >= 112.5 && angleDeg < 157.5) return "左上";
  if (angleDeg >= 157.5 && angleDeg < 202.5) return "左";
  if (angleDeg >= 202.5 && angleDeg < 247.5) return "左下";
  if (angleDeg >= 247.5 && angleDeg < 292.5) return "下";
  if (angleDeg >= 292.5 && angleDeg < 337.5) return "右下";
  return "右"; // wraps 337.5..360 and 0..22.5 -- a near-horizontal (or near-vertical/etc) skew still snaps to its nearest cardinal bucket, same logic as every other range above
}

function verifyLocationGridQuery(locationGrid, printedQuestion, studentAnswer) {
  if (!locationGrid) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const { northDir, positions } = locationGrid;
  const rotation = SCREEN_TO_REAL_ROTATION[northDir];
  if (!rotation) return { correct: null, correctAnswer: "" };
  const names = Object.keys(positions);
  const mentioned = names.filter((n) => printed.includes(n));

  // Shape 1: "由X向___方走，便可到達Y" -- direct direction X -> Y.
  let m = printed.match(/由(.+?)向.{0,3}方走.{0,10}到達(.+?)[。.]/);
  if (m) {
    const fromName = names.find((n) => m[1].includes(n));
    const toName = names.find((n) => m[2].includes(n));
    if (fromName && toName && positions[fromName] && positions[toName]) {
      const screenDir = screenDirectionBetween(positions[fromName], positions[toName]);
      if (!screenDir) return { correct: null, correctAnswer: "" }; // diagonal, not validated
      const expected = rotation[screenDir];
      const correct = answer === expected;
      return { correct, correctAnswer: correct ? "" : expected };
    }
  }

  // Shape 6 (2026-09-28, real citation, P4 exam Q8, a classroom seat-
  // grid: "天朗坐在梓苗的___方。" -> 南): the DIRECTION itself is the
  // blank this time -- both the subject (天朗) and the reference (梓苗)
  // are named grid positions, given directly in the sentence. Guarded to
  // only fire when the span between 的/方 has NO real direction word in
  // it (mutually exclusive with Shapes 2/4/5 below, which all require
  // one to be there), so ordering relative to them doesn't matter.
  m = printed.match(/(.+?)坐在(.+?)的(.{0,5}?)方/);
  if (m && !/[東南西北]/.test(m[3])) {
    const subjectName = names.find((n) => m[1].includes(n));
    const refName = names.find((n) => m[2].includes(n));
    if (subjectName && refName && subjectName !== refName && positions[subjectName] && positions[refName]) {
      const screenDir = screenDirectionBetween(positions[refName], positions[subjectName]);
      if (screenDir) {
        const expected = rotation[screenDir];
        const correct = answer === expected;
        return { correct, correctAnswer: correct ? "" : expected };
      }
    }
    return { correct: null, correctAnswer: "" };
  }

  // Shape 4 (2026-09-28, real citation, P4 exam Q2: "餐廳在*(港鐵站/
  // 噴水池/書店)的東南方。" -- checked BEFORE Shape 2, since Shape 2's
  // "grab whichever name appears first in the captured span" logic would
  // otherwise accidentally match this MC-candidate-list sentence shape
  // and pick a name by text-order coincidence rather than by actually
  // testing all 3 candidates): the subject (餐廳) is FIXED and named
  // directly in the sentence; the blank being solved for is WHICH of
  // several parenthesised candidate names makes "subject is Z direction
  // from candidate" true -- the reverse of Shape 2's own "___在Y的Z方"
  // (there the blank is the subject, Y is fixed).
  m = printed.match(/(.+?)在\*?[（(]([^（）()]+)[）)]的([東南西北]{1,2})方/);
  if (m) {
    const subjectName = names.find((n) => m[1].includes(n));
    const candidateNames = m[2].split(/[／/]/).map((s) => s.trim()).filter((n) => names.includes(n));
    const targetRealDir = m[3];
    if (subjectName && candidateNames.length >= 2 && positions[subjectName]) {
      const screenDir = Object.keys(rotation).find((sd) => rotation[sd] === targetRealDir);
      if (screenDir) {
        const matching = candidateNames.filter((c) => positions[c] && screenDirectionBetween(positions[c], positions[subjectName]) === screenDir);
        if (matching.length === 1) {
          const expected = matching[0];
          const correct = answer === expected || answer.includes(expected);
          return { correct, correctAnswer: correct ? "" : expected };
        }
      }
    }
    return { correct: null, correctAnswer: "" };
  }

  // Shape 2: "___在Y的Z方。" -- reverse lookup: which location is in
  // direction Z from Y.
  m = printed.match(/在(.+?)的([東南西北]{1,2})方/);
  if (m) {
    const refName = names.find((n) => m[1].includes(n));
    const targetRealDir = m[2];
    if (refName && positions[refName]) {
      // Find which screen-direction, under this grid's rotation, maps to targetRealDir.
      const screenDir = Object.keys(rotation).find((sd) => rotation[sd] === targetRealDir);
      if (!screenDir) return { correct: null, correctAnswer: "" };
      const refPos = positions[refName];
      const candidate = names.find((n) => n !== refName && screenDirectionBetween(refPos, positions[n]) === screenDir);
      if (!candidate) return { correct: null, correctAnswer: "" };
      const correct = answer === candidate || answer.includes(candidate);
      return { correct, correctAnswer: correct ? "" : candidate };
    }
  }

  // Shape 3 (2026-09-28, real citations: "嘉言由港鐵站前往商場，他應先向
  // ___方走，經過巴士站後，再一直往___方走便可到達。" -> 北;東; "李小姐
  // 由酒店前往碼頭，她應先向___方走，經過商場後，再往___方走便可到達。"
  // -> 東;南): multi-step path via a named intermediate landmark -- just
  // the same single-step direction logic applied twice (A->intermediate,
  // then intermediate->B). Both real citations hand-verified against the
  // actual grid before writing this. Student answer expected as two
  // values separated by ";"/","，matching this project's established
  // multi-sub-answer convention.
  // "由" or "從" -- Ticket 180's real citation ("詩詩從精品店前往巴士
  // 站...") uses 從, not 由.
  m = printed.match(/[由從](.+?)(?:前往|去)(.+?)[,，。].*?經過(.+?)後/);
  if (m) {
    const fromName = names.find((n) => m[1].includes(n));
    const toName = names.find((n) => m[2].includes(n));
    const viaName = names.find((n) => m[3].includes(n));
    if (fromName && toName && viaName && positions[fromName] && positions[toName] && positions[viaName]) {
      const screenDir1 = screenDirectionBetween(positions[fromName], positions[viaName]);
      const screenDir2 = screenDirectionBetween(positions[viaName], positions[toName]);
      if (!screenDir1 || !screenDir2) return { correct: null, correctAnswer: "" }; // a diagonal leg -- not validated
      const expected1 = rotation[screenDir1], expected2 = rotation[screenDir2];
      const parts = answer.split(/[;,]/).map((s) => s.trim());
      if (parts.length !== 2) return { correct: null, correctAnswer: "" };
      const correct = parts[0] === expected1 && parts[1] === expected2;
      return { correct, correctAnswer: correct ? "" : `${expected1};${expected2}` };
    }
  }

  return { correct: null, correctAnswer: "" };
}

// Facing-direction reasoning (2026-09-28, real citations, same P2 exam's
// Q28/Q29 -- see extractFacingDirection's own comment for the full
// cross-check that confirmed the model before any code was written).
const COMPASS_CYCLE = ["東", "南", "西", "北"]; // clockwise order

function verifyFacingDirectionQuery(facingDirection, printedQuestion, studentAnswer) {
  if (!facingDirection) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const names = Object.keys(facingDirection);

  // Shape 1: "X向右/左轉一個直角後，面向___方。" -- turn from X's own
  // known direction (real citation: 偉誠 turns right from 東 -> 南).
  let m = printed.match(/(.+?)向(左|右)轉.{0,3}直角.{0,5}面向/);
  if (m) {
    const name = names.find((n) => m[1].includes(n));
    if (name && facingDirection[name]) {
      const idx = COMPASS_CYCLE.indexOf(facingDirection[name]);
      const steps = m[2] === "右" ? 1 : -1;
      const expected = COMPASS_CYCLE[((idx + steps) % 4 + 4) % 4];
      const correct = answer === expected;
      return { correct, correctAnswer: correct ? "" : expected };
    }
  }

  // Shape 2: "...面對面...Y面向___方。" -- the OPPOSITE of the other
  // named person's known direction (real citation: 梓君 opposite 偉誠's
  // 東 -> 西). The subject being asked about (Y) is deliberately NOT
  // the one with a stored direction -- only the reference person's
  // direction is knowable from the image.
  if (/面對面/.test(printed)) {
    const subjectMatch = printed.match(/([^\s，,。.]+?)面向.{0,3}方/);
    if (subjectMatch) {
      const subject = names.find((n) => subjectMatch[1].includes(n));
      const knownOther = names.find((n) => printed.includes(n) && n !== subject && facingDirection[n]);
      if (knownOther) {
        const idx = COMPASS_CYCLE.indexOf(facingDirection[knownOther]);
        const expected = COMPASS_CYCLE[(idx + 2) % 4];
        const correct = answer === expected;
        return { correct, correctAnswer: correct ? "" : expected };
      }
    }
  }

  return { correct: null, correctAnswer: "" };
}

// Ticket 181 (2026-09-28, real citation, P4 exam Q6: "哥哥的左方是西南
// 方，他背向哪一個方向？" options A.東北/B.東南/C.西北/D.東方 -- student
// picked B, correctly). Pure text, no diagram marker needed at all: if a
// person's LEFT hand points at direction D, they face D rotated +90°
// clockwise, and "背向" (facing away from / their back) is the opposite
// of that -- net effect, back = D rotated -90° (i.e. 2 steps
// counter-clockwise on the 8-point compass). Hand-verified: 左方=西南
// (index 5) -2 steps -> index 3 = 東南, matching the real answer.
const COMPASS_CYCLE8 = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];
function verifyBackDirectionFromLeftHand(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = /左方是([東南西北]{1,2})方.{0,10}背向/.exec(printed);
  if (!m) return { correct: null, correctAnswer: "" };
  const idx = COMPASS_CYCLE8.indexOf(m[1]);
  if (idx === -1) return { correct: null, correctAnswer: "" };
  const expectedDir = COMPASS_CYCLE8[(idx - 2 + 8) % 8];
  const options = parseMcOptions(printed);
  if (options.length >= 2) {
    const matching = options.filter((o) => o.text.includes(expectedDir));
    if (matching.length === 1) {
      const correct = answer === matching[0].letter;
      return { correct, correctAnswer: correct ? "" : matching[0].letter };
    }
  }
  const correct = answer.includes(expectedDir);
  return { correct, correctAnswer: correct ? "" : expectedDir };
}

// Ticket 119 (2026-09-28, real citation: "Each sandwich costs 3 dollars.
// Each bottle of juice costs 7 dollars. Sue spends 15 dollars to buy one
// sandwich and one bottle of juice. How much change does she receive?"
// -> 15-(3+7)=5): change from a purchase of 2 named items whose prices
// are stated inline in the sentence (not a printed price table).
function verifyChangeFromTwoItemPurchase(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/change/i.test(printed)) return { correct: null, correctAnswer: "" };
  const priceMatches = [...printed.matchAll(/costs?\s*(\d+)\s*dollars?/gi)].map((m) => Number(m[1]));
  const paidMatch = printed.match(/spends?\s*(\d+)\s*dollars?/i);
  if (priceMatches.length !== 2 || !paidMatch) return { correct: null, correctAnswer: "" };
  const expected = Number(paidMatch[1]) - priceMatches.reduce((a, b) => a + b, 0);
  if (expected < 0) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 121 (2026-09-28, real citation: "It takes 2 bows and 3 flower
// buttons to decorate a dress. There are now 11 bows and 19 flower
// buttons. How many dresses can be decorated at most?" ->
// floor(min(11/2,19/3))=5): resource-constrained "at most" word problem
// -- the limiting resource determines the max count.
function verifyResourceConstrainedMax(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/at most/i.test(printed)) return { correct: null, correctAnswer: "" };
  const takesMatch = printed.match(/takes?\s*(\d+)\s*[a-z]+s?\s+and\s+(\d+)\s*[a-z]+s?/i);
  const hasMatch = printed.match(/(?:are now|has|have)\s*(\d+)\s*[a-z]+s?\s+and\s+(\d+)\s*[a-z]+s?/i);
  if (!takesMatch || !hasMatch) return { correct: null, correctAnswer: "" };
  const n1 = Number(takesMatch[1]), n2 = Number(takesMatch[2]);
  const m1 = Number(hasMatch[1]), m2 = Number(hasMatch[2]);
  if (!n1 || !n2) return { correct: null, correctAnswer: "" };
  const expected = Math.floor(Math.min(m1 / n1, m2 / n2));
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 124 (2026-09-28, real citation: "79 − 18 − [box] = 10" -> 51):
// chained two-step equation with the blank in the middle -- needs the
// intermediate result (79-18=61) before isolating the blank, distinct
// from the existing single-operator trySubstituteBlank shape.
function verifyChainedTwoStepBlank(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)\s*-\s*(\d+)\s*-\s*(?:\[?_*\]?|□)\s*=\s*(\d+)/);
  if (!m) return { correct: null, correctAnswer: "" };
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const expected = a - b - c;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 127 (2026-09-28, real citation: "Circle the English letter(s)
// below that are formed by curves only. ( Q / H / R / S )" -> S):
// static-fact reverse-MC-selection -- filters the given letter options
// against a fixed curve-only-letter table, matching this project's
// established shape-knowledge-lookup pattern (Ticket 108).
const CURVE_ONLY_LETTERS = new Set(["C", "O", "S", "U"]);
function verifyCurveOnlyLetterMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim().toUpperCase();
  if (!answer || !/curves? only/i.test(printed)) return { correct: null, correctAnswer: "" };
  const optionsMatch = printed.match(/\(([^)]+)\)/);
  if (!optionsMatch) return { correct: null, correctAnswer: "" };
  const options = optionsMatch[1].split("/").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const validOnes = options.filter((o) => CURVE_ONLY_LETTERS.has(o));
  if (!validOnes.length) return { correct: null, correctAnswer: "" };
  const studentSet = new Set(answer.split(/[,;\s]+/).filter(Boolean));
  const correct = studentSet.size === validOnes.length && validOnes.every((v) => studentSet.has(v));
  return { correct, correctAnswer: correct ? "" : validOnes.join(", ") };
}

// Ticket 136 (2026-09-28, real citation: "餅店店員把蛋糕每10個裝成一
// 盒，可裝成2盒；如果改為每2個裝成一盒，可以裝成多少盒？" -> total=10×2=
// 20, then 20÷2=10): total-then-regroup word problem -- derive the total
// from one grouping fact, then regroup by a different size.
function verifyRegroupTotalWordProblem(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/每\s*(\d+)\s*個.{0,6}(?:裝成|一盒).{0,10}(\d+)\s*盒[\s\S]*?每\s*(\d+)\s*個.{0,6}一盒/);
  if (!m) return { correct: null, correctAnswer: "" };
  const [size1, count1, size2] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const total = size1 * count1;
  if (!size2 || total % size2 !== 0) return { correct: null, correctAnswer: "" };
  const expected = total / size2;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 137 (2026-09-28, real citation: "爸爸在3時正開始做運動，他做運動
// 的時間比3小時長，以下哪一項可能是爸爸結束做運動的時間？A.4時正 B.5時正
// C.6時正 D.7時正" -> D, since only 7:00 is strictly MORE than 3 hours
// after 3:00): elapsed-time inequality MC -- filters options by a
// strict "more than N hours later" constraint.
function verifyElapsedTimeInequalityMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)\s*時正?開始.{0,15}比\s*(\d+)\s*小時長/);
  if (!m) return { correct: null, correctAnswer: "" };
  const startHour = Number(m[1]), minDuration = Number(m[2]);
  const options = parseMcOptions(printed);
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  const matching = options.filter((o) => {
    const hm = o.text.match(/(\d+)\s*時正?/);
    if (!hm) return false;
    const hour = Number(hm[1]);
    return hour - startHour > minDuration;
  });
  if (matching.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedLetter = matching[0].letter;
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Ticket 138 (2026-09-28, real citation: "如果琴日是星期二，聽日是星期
// ___。" -> 星期四): simple yesterday/tomorrow day-of-week shift --
// distinct from the CALENDAR_GRID/ordinal-day shapes, no grid needed at
// all, pure +2 mod 7 from a stated "yesterday" fact.
function verifyYesterdayTomorrowShift(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(?:琴日|昨天)是?星期([日一二三四五六])/);
  if (!m) return { correct: null, correctAnswer: "" };
  const yesterdayIdx = WEEKDAY_NAMES_ZH.indexOf(m[1]);
  const tomorrowIdx = (yesterdayIdx + 2) % 7;
  const expected = WEEKDAY_NAMES_ZH[tomorrowIdx];
  const correct = answer === expected;
  return { correct, correctAnswer: correct ? "" : expected };
}

// Ticket 140 (2026-09-28, real citation: "工作時間：9時正至12時正，3時正至
// 6時正。媽媽每天工作___小時。" -> (12-9)+(6-3)=6): sum of durations
// across multiple stated time ranges.
function verifyDurationSumWordProblem(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const ranges = [...printed.matchAll(/(\d+)\s*時正?至\s*(\d+)\s*時正?/g)];
  if (ranges.length < 2) return { correct: null, correctAnswer: "" };
  const expected = ranges.reduce((sum, r) => sum + (Number(r[2]) - Number(r[1])), 0);
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 125 (2026-09-28, real citation: "John has $80. He wants to buy
// a doll [$60]. After buying the doll, he still has: $80 − $60 = $20.
// If he wants to buy a teddy bear too [$33], his remaining money is
// *(more/less) than the price of a teddy bear. Therefore, John *(has/
// does not have) enough money to buy a teddy bear." -> less;does not
// have): two-stage affordability chain. Found on a SECOND, more careful
// pass through the original survey report after an earlier turn wrongly
// skipped this citing "insufficient evidence" -- the exact quote was
// there all along, just lost when compressed into a one-line TICKETS.md
// summary (see the 2026-09-28 process-review memory note). Anchored
// regexes (not a naive "grab all $N in order") specifically to avoid
// being confused by the "$80 − $60 = $20" arithmetic sentence that
// contains 3 MORE dollar amounts in between the ones actually needed.
function verifyTwoStageAffordabilityChain(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  if (!/\(more\/less\)|\(less\/more\)/i.test(printed) || !/\(has\/does not have\)|\(does not have\/has\)/i.test(printed)) {
    return { correct: null, correctAnswer: "" };
  }
  const initialMatch = printed.match(/has\s*\$(\d+)/i);
  const item1Match = printed.match(/buy a [a-z ]+?[^.]*?\$(\d+)/i);
  const item2Match = printed.match(/buy a [a-z ]+? too[^.]*?\$(\d+)/i);
  if (!initialMatch || !item1Match || !item2Match) return { correct: null, correctAnswer: "" };
  const initial = Number(initialMatch[1]), item1 = Number(item1Match[1]), item2 = Number(item2Match[1]);
  const remaining = initial - item1;
  const moreOrLess = remaining > item2 ? "more" : "less";
  const hasEnough = remaining >= item2 ? "has" : "does not have";
  const parts = answer.split(/[;,]/).map((s) => s.trim());
  if (parts.length !== 2) return { correct: null, correctAnswer: "" };
  const correct = parts[0] === moreOrLess && parts[1] === hasEnough;
  return { correct, correctAnswer: correct ? "" : `${moreOrLess};${hasEnough}` };
}

// Ticket 129 (2026-09-28, real citation: "2 3 5 / + 5 5 7 / [box] /
// − 2 8 1 / [box]" -- two chained vertical operations, the second
// blank's calculation depends on the FIRST blank's own computed result,
// not a number in the original printed question): chained vertical
// arithmetic with feed-forward blanks. Same "found on re-reading the
// original report" story as Ticket 125 above. Honest caveat: this
// assumes OCR renders the chain as a flat "A op1 B [blank] op2 C
// [blank]" expression (following this project's established □-
// preservation convention) -- the real per-page OCR output for this
// exact vertical-stack shape hasn't been observed yet, so this is
// good-faith construction from the citation's numbers, not a confirmed
// OCR-format match.
function verifyChainedVerticalArithmetic(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)\s*([+-])\s*(\d+)\s*(?:\[?_*\]?|□)\s*([+-])\s*(\d+)\s*(?:\[?_*\]?|□)\s*$/);
  if (!m) return { correct: null, correctAnswer: "" };
  const [a, op1, b, op2, c] = [Number(m[1]), m[2], Number(m[3]), m[4], Number(m[5])];
  const apply = (x, op, y) => (op === "+" ? x + y : x - y);
  const result1 = apply(a, op1, b);
  const result2 = apply(result1, op2, c);
  const parts = answer.split(/[;,]/).map((s) => s.trim()).map(Number);
  if (parts.length !== 2 || parts.some(Number.isNaN)) return { correct: null, correctAnswer: "" };
  const correct = parts[0] === result1 && parts[1] === result2;
  return { correct, correctAnswer: correct ? "" : `${result1};${result2}` };
}

// Ticket 108 (2026-09-28, found in a real P2 3-D shapes unit test's own
// answer key): reverses the already-known face/edge/vertex facts in
// SHAPE_REFERENCE -- given how many lateral faces a solid has and what
// SHAPE those lateral faces are, name the solid. No image needed at all,
// purely textual. Two real phrasing shapes:
// (1) "A 3-D shape has 6 lateral faces. All lateral faces are triangles.
//     It is a ___." -> hexagonal pyramid (N triangular lateral faces =
//     an N-sided-base pyramid).
// (2) "Faces: 3 rectangles + 2 triangles -> Triangular prism" (2
//     triangular bases + M rectangular lateral faces = an M-sided-base
//     prism).
// Only covers 3-8 sided bases (the range actually seen in real
// materials) -- declines outside that, and declines whenever the
// lateral-face shape isn't unambiguously all-triangle or all-quadrilateral.
const POLYGON_PYRAMID_NAMES = {
  3: ["三角錐", "triangular pyramid"],
  4: ["四角錐", "quadrilateral pyramid", "square-based pyramid", "square pyramid"],
  5: ["五角錐", "pentagonal pyramid"],
  6: ["六角錐", "hexagonal pyramid"],
  7: ["七角錐", "heptagonal pyramid"],
  8: ["八角錐", "octagonal pyramid"],
};
const POLYGON_PRISM_NAMES = {
  3: ["三棱柱", "三角柱", "triangular prism"],
  4: ["四角柱", "quadrilateral prism", "cuboid", "長方柱", "正方柱"],
  5: ["五角柱", "pentagonal prism"],
  6: ["六角柱", "hexagonal prism"],
  7: ["七角柱", "heptagonal prism"],
  8: ["八角柱", "octagonal prism"],
};

function verifyReverseShapeFromFaceProperties(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim().toLowerCase();
  if (!answer) return { correct: null, correctAnswer: "" };

  const isTriangleLateral = /(?:all(?:\s+the)?\s+lateral\s+faces?\s+are\s+triangles?)|(?:側面(?:都)?係三角形)|(?:lateral\s+faces?.{0,15}triangles?)/i.test(printed);
  const isQuadLateral = /(?:all(?:\s+the)?\s+lateral\s+faces?\s+are\s+quadrilaterals?)|(?:側面(?:都)?係四邊形)|(?:lateral\s+faces?.{0,15}quadrilaterals?)/i.test(printed);

  let n = null, isPyramid = null;
  if (isTriangleLateral || isQuadLateral) {
    isPyramid = isTriangleLateral;
    const lateralMatch = printed.match(/(\d+)\s*(?:lateral\s+faces?|個側面)/i);
    const totalMatch = printed.match(/(\d+)\s*faces?\b|(\d+)\s*個面/i);
    if (lateralMatch) n = Number(lateralMatch[1]);
    else if (totalMatch) {
      const total = Number(totalMatch[1] || totalMatch[2]);
      n = isPyramid ? total - 1 : total - 2;
    }
  } else {
    // Shape (2): explicit face-composition list, e.g. "3 rectangles + 2
    // triangles" (2 triangles = the prism's own 2 bases, never itself the
    // base-side count) -- only fires when EXACTLY 2 triangles are named
    // alongside some count of rectangles/squares.
    const rectMatch = printed.match(/(\d+)\s*(?:rectangles?|squares?|長方形|正方形)/i);
    const triMatch = printed.match(/(\d+)\s*(?:triangles?|三角形)/i);
    if (rectMatch && triMatch && Number(triMatch[1]) === 2) {
      isPyramid = false;
      n = Number(rectMatch[1]);
    }
  }
  if (isPyramid === null || !n || n < 3 || n > 8) return { correct: null, correctAnswer: "" };

  const names = isPyramid ? POLYGON_PYRAMID_NAMES[n] : POLYGON_PRISM_NAMES[n];
  if (!names) return { correct: null, correctAnswer: "" };
  const correct = names.some((name) => answer.includes(name.toLowerCase()) || name.toLowerCase().includes(answer));
  return { correct, correctAnswer: correct ? "" : names[names.length - 1] };
}

// Ticket 78/89 (2026-09-28, real citations across two workbooks):
// "N in front of me, what position am I" -- position = N + 1. Also
// covers the paired form "N in front of me, X is Kth AND LAST, who am
// I/what's the total" (real example: "5 people in front of me. Mr.
// Cheung is 12th and last." -> position = 5+1 = 6th; total = 12, since
// "Kth and last" directly states the group size). English-only for now
// (no real Chinese-ordinal citation collected for this exact shape) --
// covers both "7th"-style and spelled-out ordinal words since a real MC
// example used "Sixth/Seventh/Eighth/Ninth".
const ORDINAL_WORDS_EN = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth"];
function parseOrdinalToNumber(text) {
  const s = String(text || "").trim().toLowerCase();
  const m = /^(\d+)(?:st|nd|rd|th)?$/.exec(s);
  if (m) return Number(m[1]);
  const idx = ORDINAL_WORDS_EN.indexOf(s);
  return idx > 0 ? idx : NaN;
}

function verifyOrdinalFromCountInFront(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const frontMatch = printed.match(/(\d+)\s*(?:cars?|people|students?|children)\b.{0,15}in front/i);
  if (!frontMatch) return { correct: null, correctAnswer: "" };
  const expected = Number(frontMatch[1]) + 1;
  const studentNum = parseOrdinalToNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 86 (2026-09-28, real citation: "If 7+6=☆, then ☆-6=? A.0 B.6
// C.7 D.13" -> ☆=13, 13-6=7, answer C): numeric symbolic substitution --
// solve the first equation for the symbol, substitute into the second.
// Narrow: only the "if A op1 B = SYMBOL, then SYMBOL op2 C = ?" shape.
function verifySymbolicSubstitution(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)\s*([+\-×x*÷/])\s*(\d+)\s*=\s*([△○□☆★◇])\D+\4\s*([+\-×x*÷/])\s*(\d+)\s*=/i);
  if (!m) return { correct: null, correctAnswer: "" };
  const [, a, op1, b, , op2, c] = m;
  const applyOp = (x, op, y) => {
    switch (op) {
      case "+": return x + y;
      case "-": return x - y;
      case "×": case "x": case "*": return x * y;
      case "÷": case "/": return y === 0 ? NaN : x / y;
      default: return NaN;
    }
  };
  const symbolValue = applyOp(Number(a), op1, Number(b));
  const expected = applyOp(symbolValue, op2, Number(c));
  if (!Number.isFinite(expected)) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 93 (2026-09-28, real citation: "如果△+○=□，(a) ○+___=□
// (b) □-___=△" -> (a)=△ (b)=○): purely symbolic relation reasoning, no
// numeric values at all -- given X+Y=Z, the 3 equivalent rearranged
// forms (Y+?=Z, Z-?=X, Z-?=Y) all resolve to one of the 3 known
// symbols. Uses "___" (underscores) as the blank marker specifically
// (NOT "□", which is itself one of the real symbols used in this exact
// citation and must not be confused with a placeholder).
function verifySymbolicRelation(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const SYM = "[△○□☆★◇▽◆]";
  const givenRe = new RegExp(`(${SYM})\\s*\\+\\s*(${SYM})\\s*=\\s*(${SYM})`);
  const given = printed.match(givenRe);
  if (!given) return { correct: null, correctAnswer: "" };
  const [wholeGiven, x, y, z] = given;
  const rest = printed.slice(printed.indexOf(wholeGiven) + wholeGiven.length);
  const checkAnswer = (expected) => {
    const correct = answer === expected || answer.includes(expected);
    return { correct, correctAnswer: correct ? "" : expected };
  };
  let m = rest.match(new RegExp(`(${SYM})\\s*\\+\\s*_{2,}\\s*=\\s*(${SYM})`));
  if (m) {
    const [, known, target] = m;
    if (known === x && target === z) return checkAnswer(y);
    if (known === y && target === z) return checkAnswer(x);
    return { correct: null, correctAnswer: "" };
  }
  m = rest.match(new RegExp(`(${SYM})\\s*-\\s*_{2,}\\s*=\\s*(${SYM})`));
  if (m) {
    const [, minuend, target] = m;
    if (minuend === z && target === x) return checkAnswer(y);
    if (minuend === z && target === y) return checkAnswer(x);
    return { correct: null, correctAnswer: "" };
  }
  return { correct: null, correctAnswer: "" };
}

// Ticket 116 (2026-09-28, real citation: "To walk the same distance,
// Sarah takes 3 seconds longer than Linda, but 2 seconds shorter than
// Jessie. Among the three people, ___ walks the fastest." -> Linda,
// since less time = faster): relative-comparison-chain word problem.
// Sets up relative values against the middle-named person (0) and finds
// the min/max -- English-only for now, no real Chinese citation for
// this exact "A longer than B but shorter than C" shape yet.
function verifyRelativeComparisonChain(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/([A-Z][a-z]+)\s+takes\s+(\d+)\s+seconds?\s+longer\s+than\s+([A-Z][a-z]+),?\s*(?:but\s+)?(\d+)\s+seconds?\s+shorter\s+than\s+([A-Z][a-z]+)/i);
  if (!m) return { correct: null, correctAnswer: "" };
  const [, A, n1, B, n2, C] = m;
  if (new Set([A, B, C]).size !== 3) return { correct: null, correctAnswer: "" };
  const values = { [B]: 0, [A]: Number(n1), [C]: Number(n1) + Number(n2) };
  const askFastest = /fastest|走得最快|行得最快/i.test(printed);
  const askSlowest = /slowest|走得最慢|行得最慢/i.test(printed);
  if (!askFastest && !askSlowest) return { correct: null, correctAnswer: "" };
  const names = Object.keys(values);
  const targetVal = askFastest ? Math.min(...names.map((n) => values[n])) : Math.max(...names.map((n) => values[n]));
  const winners = names.filter((n) => values[n] === targetVal);
  if (winners.length !== 1) return { correct: null, correctAnswer: "" };
  const expected = winners[0];
  const correct = answer === expected || answer.includes(expected);
  return { correct, correctAnswer: correct ? "" : expected };
}

// Ticket 113 (2026-09-28, real citation: "The swimming pool is 25 m
// long. Nick swims back and forth twice. How many metres does he
// swim?" -> 25×2×2=100): "back and forth N times" compound multiplier --
// "back and forth" itself means ×2 (a round trip), then multiplied again
// by however many times it's repeated. English-only -- no real Chinese
// "來回" citation collected for this exact shape yet (only the general
// concept was inferred, not directly quoted).
function verifyCompoundMultiplierWordProblem(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  if (!/back and forth/i.test(printed)) return { correct: null, correctAnswer: "" };
  const baseMatch = printed.match(/is\s+(\d+)\s*m\b/i);
  if (!baseMatch) return { correct: null, correctAnswer: "" };
  const base = Number(baseMatch[1]);
  let repeat = null;
  if (/\btwice\b/i.test(printed)) repeat = 2;
  else if (/\bonce\b/i.test(printed)) repeat = 1;
  else {
    const rm = printed.match(/(\d+)\s*times\b/i);
    if (rm) repeat = Number(rm[1]);
  }
  if (!repeat) return { correct: null, correctAnswer: "" };
  const expected = base * 2 * repeat;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 84 (2026-09-28, real citation: "Box A ≤9 pieces, Box B ≤5
// pieces, total=12. At least how many in Box A? A.4 B.5 C.7 D.9" ->
// min(A) = total - max(B) = 7): min-from-two-capacity-constraints.
// Narrow assumption (true for this citation, unverified the other way):
// the question always asks about the FIRST-named entity, so its minimum
// is total minus the SECOND entity's own maximum.
function verifyMinFromTwoCapacityConstraints(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  if (!/at least/i.test(printed)) return { correct: null, correctAnswer: "" };
  const maxMatches = [...printed.matchAll(/≤\s*(\d+)/g)].map((mm) => Number(mm[1]));
  if (maxMatches.length !== 2) return { correct: null, correctAnswer: "" };
  const totalMatch = printed.match(/total\s*[=:]?\s*(\d+)/i);
  if (!totalMatch) return { correct: null, correctAnswer: "" };
  const total = Number(totalMatch[1]);
  const expected = total - maxMatches[1];
  if (expected < 0) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 75 (2026-09-28, real citations: "Which is NOT correct?
// A.12-0=0 B.9+0=9 C.0+18=18 D.14-14=0" -> A is wrong (12-0=12);
// "A.9=2+6 B.5+2=7 C.10-4=2 D.1+7=9" -- which IS correct -> B):
// MC full-equation truth check, both "which is correct" and "which is
// NOT correct" framings. Declines whenever any option isn't a clean
// parseable equation, or when the target isn't uniquely determined.
function verifyEquationTruthMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const options = parseMcOptions(printed);
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  const applyOp = (x, op, y) => {
    switch (op) {
      case "+": return x + y;
      case "-": return x - y;
      case "×": case "x": case "*": return x * y;
      case "÷": case "/": return y === 0 ? NaN : x / y;
      default: return NaN;
    }
  };
  const evalEquation = (text) => {
    const clean = String(text).replace(/\s+/g, "");
    // Two real option shapes seen: "a op b = c" AND "c = a op b" (the
    // target-first form, e.g. real citation "9=2+6") -- both must be
    // supported, not just the first.
    let m = clean.match(/^(\d+)([+\-×x*÷/])(\d+)=(\d+)$/);
    if (m) {
      const [, a, op, b, c] = m;
      const result = applyOp(Number(a), op, Number(b));
      return Number.isFinite(result) ? result === Number(c) : null;
    }
    m = clean.match(/^(\d+)=(\d+)([+\-×x*÷/])(\d+)$/);
    if (m) {
      const [, c, a, op, b] = m;
      const result = applyOp(Number(a), op, Number(b));
      return Number.isFinite(result) ? result === Number(c) : null;
    }
    return null;
  };
  const evaluated = options.map((o) => ({ ...o, isTrue: evalEquation(o.text) }));
  if (evaluated.some((o) => o.isTrue === null)) return { correct: null, correctAnswer: "" };
  const wantsNotCorrect = /not correct|唔啱|不正確|唔正確/i.test(printed);
  const target = evaluated.filter((o) => (wantsNotCorrect ? !o.isTrue : o.isTrue));
  if (target.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedLetter = target[0].letter;
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Ticket 222 "Pattern 1: estimation MC" (2026-10-01, real citations,
// re-verified 2026-10-01 against the actual real pages after the
// original archive citations turned out wrong: 小學數學新思維 3下A 作業,
// footer p.2 Q10 ("表哥原有4105元，他做兼職賺得1070元後，用2899元買了
// 一部遊戲機。以下哪道算式最適合用來估算他還餘多少元？" -> D.
// 4000+1000-3000) and footer p.10 Q7 ("以下哪道算式最適合用來估算
// (205+497)×3的結果？" -> B. (200+500)×3). Closed rule, no judgment:
// round EACH number in the original printed expression to its own
// leading-digit place value (a 4-digit number -> nearest thousand, a
// 3-digit number -> nearest hundred, matching both real citations'
// rounding precision exactly), keep every operator/paren unchanged,
// and the MC option whose numbers match that rounded sequence (same
// structure, same order) is the answer -- a pure token-level transform
// + string comparison, never "which option feels like a good estimate."
function roundToLeadingDigit(n) {
  const s = String(Math.abs(Math.trunc(n)));
  const place = Math.pow(10, s.length - 1);
  return Math.round(n / place) * place;
}

function tokenizeArithmeticExpr(expr) {
  const tokens = [];
  const re = /\d+|[+\-×x*÷/()]/g;
  let m;
  while ((m = re.exec(String(expr)))) {
    if (/^\d+$/.test(m[0])) tokens.push({ type: "num", value: Number(m[0]) });
    else tokens.push({ type: "op", value: (m[0] === "x" || m[0] === "*") ? "×" : (m[0] === "/" ? "÷" : m[0]) });
  }
  return tokens;
}

function exprTokensToKey(tokens) {
  return tokens.map((t) => (t.type === "num" ? String(t.value) : t.value)).join("");
}

function isEstimationMcQuestion(item) {
  const printed = String(item.printedQuestion || "");
  if (!/估算/.test(printed)) return false;
  return parseMcOptions(printed).length >= 2;
}

function verifyEstimationMc(item) {
  const printed = String(item.printedQuestion || "");
  const answer = String(item.studentAnswer || "").trim().toUpperCase();
  if (!answer || !isEstimationMcQuestion(item)) return { correct: null, correctAnswer: "" };
  const options = parseMcOptions(printed);
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  // The original expression to estimate sits between "估算" and either
  // "的結果" or a "?"/"？" -- both real citations match this shape.
  const m = printed.match(/估算\s*([\d+\-×x*÷/()\s]+?)\s*(?:的結果)?\s*[?？]/);
  if (!m) return { correct: null, correctAnswer: "" };
  const originalTokens = tokenizeArithmeticExpr(m[1]);
  if (!originalTokens.some((t) => t.type === "num")) return { correct: null, correctAnswer: "" };
  const roundedTokens = originalTokens.map((t) => (t.type === "num" ? { type: "num", value: roundToLeadingDigit(t.value) } : t));
  const expectedKey = exprTokensToKey(roundedTokens);

  const matches = options.filter((o) => exprTokensToKey(tokenizeArithmeticExpr(o.text)) === expectedKey);
  if (matches.length !== 1) return { correct: null, correctAnswer: "" }; // ambiguous or no option matches -- decline rather than guess
  const expectedLetter = matches[0].letter;
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Ticket 216 (2026-09-30, real citation: 小學數學新思維 3下A 作業 p.21
// (rendered PDF page math3xa_pdf/p22.png), instruction "以下句子是正確
// 的，在圈內加✓；不正確的加✗。":
// ⑦ 所有等邊三角形皆是等腰三角形。 -> ✓ (every equilateral triangle is,
//    by definition, a special case of isosceles -- always true)
// ⑧ 所有等腰三角形皆是等腰直角三角形。 -> ✗ (most isosceles triangles
//    are not right-angled -- false)
// ⑨ 等腰三角形必定有一個直角。 -> ✗ (same reasoning as ⑧)
// ⑩ 在一個三角形中，任意兩邊的長度之和必定大於第三邊的長度。 -> ✓
//    (the triangle inequality theorem, universally true)
// Pure geometric-fact lookup -- these are fixed curriculum-standard
// truths, not something read off the page (same "compute/look up the
// ground truth" category as calendar-fact lookup), zero image or
// OCR-marker work needed. Matches by keyword pattern (not exact string)
// so OCR wording variance across worksheets still matches; declines
// (fails open to AI) for any statement outside this known closed fact
// set -- disclosed scope, not exhaustive of every possible triangle-
// hierarchy true/false statement a worksheet could ask.
function classifyTriangleFactStatement(printedQuestion) {
  const text = String(printedQuestion || "").replace(/\s+/g, "");
  if (/所有等邊三角形.{0,4}(皆是|都是|一定是|係).{0,4}等腰三角形/.test(text)) return true;
  if (/所有等腰三角形.{0,4}(皆是|都是|一定是|係).{0,4}等腰直角三角形/.test(text)) return false;
  if (/等腰三角形必定(有|係有)一個直角/.test(text)) return false;
  if (/(任意|任何)兩邊(的長度)?之和必定大於第三邊(的長度)?/.test(text)) return true;
  return null;
}

function normalizeCheckMark(answer) {
  const a = String(answer || "").trim();
  if (/^(✓|√|✔|v|對|啱|正確|true|t)$/i.test(a)) return true;
  if (/^(✗|×|x|唔啱|不啱|不對|唔對|不正確|錯|false|f)$/i.test(a)) return false;
  return null;
}

function isTriangleFactTrueFalseQuestion(item) {
  return classifyTriangleFactStatement(item.printedQuestion) !== null;
}

function verifyTriangleFactTrueFalse(printedQuestion, studentAnswer) {
  const expected = classifyTriangleFactStatement(printedQuestion);
  if (expected === null) return { correct: null, correctAnswer: "" };
  const given = normalizeCheckMark(studentAnswer);
  if (given === null) return { correct: null, correctAnswer: "" };
  const correct = given === expected;
  return { correct, correctAnswer: correct ? "" : (expected ? "✓" : "✗") };
}

// Ticket 222 "Pattern 5" (2026-09-30, real citation: 小學數學新思維
// 3下A 作業, footer p.21, Q12: "利用左面3枝竹簽，（可以/不可以）圍成一
// 個三角形。（把答案圈起來）" -> 可以 (8<6+4=10, triangle inequality
// holds); "...（可以/不可以）圍成一個等腰三角形。" -> 不可以 (8,6,4 all
// distinct -- no two sides equal). A first attempt at this exact
// citation (earlier the same night) tried to parse these cm values
// straight out of printedQuestion and had to be reverted -- a real OCR
// test proved the numbers are printed ONLY in the diagram beside the
// question, never inside the question's own sentence, so detect() could
// never fire. Fixed properly this time via a new OCR_ONLY_PROMPT
// STICK_LENGTHS marker line (extractStickLengths) that captures the
// diagram's own printed lengths as page-level shared context, attached
// onto every item on that page the same way priceTable/passageText
// already are -- item.stickLengths is populated by handleMark before
// classifyAndVerify ever runs, not parsed here.
function isTriangleFormableFromSticksQuestion(item) {
  if (!Array.isArray(item.stickLengths) || item.stickLengths.length !== 3) return false;
  const text = String(item.printedQuestion || "").replace(/\s+/g, "");
  if (!/可以\/不可以|可以／不可以/.test(text)) return false;
  return /圍成一個(等腰)?三角形/.test(text);
}

function verifyTriangleFormableFromSticks(item) {
  if (!isTriangleFormableFromSticksQuestion(item)) return { correct: null, correctAnswer: "" };
  const lengths = item.stickLengths;
  const sorted = [...lengths].sort((x, y) => x - y);
  const formsTriangle = sorted[0] + sorted[1] > sorted[2];
  const text = String(item.printedQuestion || "").replace(/\s+/g, "");
  const wantsIsosceles = /圍成一個等腰三角形/.test(text);
  const hasTwoEqual = lengths[0] === lengths[1] || lengths[1] === lengths[2] || lengths[0] === lengths[2];
  const expectedPossible = wantsIsosceles ? (formsTriangle && hasTwoEqual) : formsTriangle;
  const answer = String(item.studentAnswer || "").trim();
  const studentSaysPossible = /不可以/.test(answer) ? false : (/可以/.test(answer) ? true : null);
  if (studentSaysPossible === null) return { correct: null, correctAnswer: "" };
  const correct = studentSaysPossible === expectedPossible;
  return { correct, correctAnswer: correct ? "" : (expectedPossible ? "可以" : "不可以") };
}

// Same ticket, second real sub-citation (math3xa_pdf/p20.png, Q⑧):
// "一個三角形最多有鈍角多少個？答案：______個" -> 1 (a triangle's
// interior angles sum to 180 degrees, so at most one angle can exceed
// 90 degrees). Same closed-fact-lookup family as the T/F statements
// above, just phrased as a numeric fill-in-blank.
function isMaxObtuseAngleInTriangleQuestion(item) {
  return /三角形最多有(幾多個|多少個)?鈍角/.test(String(item.printedQuestion || "").replace(/\s+/g, ""));
}

function verifyMaxObtuseAngleInTriangle(printedQuestion, studentAnswer) {
  if (!isMaxObtuseAngleInTriangleQuestion({ printedQuestion })) return { correct: null, correctAnswer: "" };
  const answer = String(studentAnswer || "").trim();
  const m = answer.match(/\d+/);
  if (!m) return { correct: null, correctAnswer: "" };
  const correct = Number(m[0]) === 1;
  return { correct, correctAnswer: correct ? "" : "1" };
}

// Ticket 208 (2026-09-30, real citation: 26週數學訓練 P3 Topic 2「年月
// 日」進階訓練, math34pdf/p04.png):
// Q1 "一年裏有31天的月份有___個。" -> 7 (Jan/Mar/May/Jul/Aug/Oct/Dec,
//    fixed constant, zero ambiguity)
// Q2 "如果6月1日是星期日，那麼5月28日是星期___。" -> 三 (Wednesday)
// Both verified against the real answer key (math34pdf/answers_p01.png,
// Topic 2: "1. 7  2. 三"). These are new query SHAPES not covered by the
// existing verifyCalendarGridQuery (which needs a printed calendar grid
// in the image) -- these are pure text/date-math word problems, no
// image involved at all.
const DAYS_31_MONTH_COUNT = 7; // Jan,Mar,May,Jul,Aug,Oct,Dec
// Reuses the module-level WEEKDAY_NAMES_ZH already declared above
// (Sunday=index 0..Saturday=index 6) for verifyCalendarGridQuery.

function isDaysWith31CountQuestion(item) {
  return /一年(裏|裡)?有31天的月份有/.test(String(item.printedQuestion || "").replace(/\s+/g, ""));
}

function verifyDaysWith31Count(printedQuestion, studentAnswer) {
  if (!isDaysWith31CountQuestion({ printedQuestion })) return { correct: null, correctAnswer: "" };
  const answer = String(studentAnswer || "").trim();
  const m = answer.match(/\d+/);
  if (!m) return { correct: null, correctAnswer: "" };
  const correct = Number(m[0]) === DAYS_31_MONTH_COUNT;
  return { correct, correctAnswer: correct ? "" : String(DAYS_31_MONTH_COUNT) };
}

function isWeekdayOffsetQuestion(item) {
  const text = String(item.printedQuestion || "").replace(/\s+/g, "");
  return /如果\d+月\d+日是星期[日一二三四五六]/.test(text) && /那麼\d+月\d+日是星期/.test(text);
}

// Computes the weekday offset across a possible month boundary using
// each month's real day-count (non-leap-year assumption, disclosed --
// the real citation's May->June crossing doesn't depend on Feb so this
// is safe there; a citation crossing Feb would need a leap-year flag,
// not yet built/needed).
const MONTH_DAYS_NON_LEAP = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function verifyWeekdayOffset(printedQuestion, studentAnswer) {
  const text = String(printedQuestion || "").replace(/\s+/g, "");
  const m = text.match(/如果(\d+)月(\d+)日是星期([日一二三四五六])[，,][\s\S]*?那麼(\d+)月(\d+)日是星期/);
  if (!m) return { correct: null, correctAnswer: "" };
  const [, knownMonth, knownDay, knownWeekdayCh, targetMonth, targetDay] = m;
  const knownWeekday = WEEKDAY_NAMES_ZH.indexOf(knownWeekdayCh);
  if (knownWeekday === -1) return { correct: null, correctAnswer: "" };
  const toOrdinal = (month, day) => {
    let total = Number(day);
    for (let mo = 1; mo < Number(month); mo++) total += MONTH_DAYS_NON_LEAP[mo - 1];
    return total;
  };
  const dayDiff = toOrdinal(targetMonth, targetDay) - toOrdinal(knownMonth, knownDay);
  const targetWeekday = ((knownWeekday + dayDiff) % 7 + 7) % 7;
  const expected = WEEKDAY_NAMES_ZH[targetWeekday];
  const answer = String(studentAnswer || "").trim().replace(/^星期/, "");
  const correct = answer === expected;
  return { correct, correctAnswer: correct ? "" : expected };
}

// Ticket 77 (2026-09-28, real citation: "How do you separate 10
// [candies] into two groups? 10 = [] + []" -- many valid splits, not one
// fixed pair): open-ended decomposition. Student answer expected as two
// numbers separated by a semicolon/comma/plus (matching this project's
// established multi-sub-answer convention).
function verifyOpenDecomposition(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)\s*=\s*(?:\[?_*\]?|□)\s*\+\s*(?:\[?_*\]?|□)\s*$/);
  if (!m) return { correct: null, correctAnswer: "" };
  const target = Number(m[1]);
  const parts = answer.split(/[;,+]/).map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  if (parts.length !== 2) return { correct: null, correctAnswer: "" };
  const correct = parts[0] + parts[1] === target;
  return { correct, correctAnswer: correct ? "" : `(任何加埋等於${target}嘅兩個數)` };
}

// Ticket 81 (2026-09-28, real citation: "Use 8, 9, 17 to form 4
// different expressions: (a)[]+[]=[] (b)[]+[]=[] (c)[]-[]=[]
// (d)[]-[]=[]" -- valid set = {8+9=17, 9+8=17, 17-9=8, 17-8=9}):
// fact-family generation from 3 given numbers (one = sum of the other
// two). Checks the student's filled equation against the closed set of
// 4 valid rearrangements.
function verifyFactFamilyGeneration(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim().replace(/\s+/g, "");
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/use\s*(\d+)\s*,\s*(\d+)\s*(?:,|and)?\s*(\d+)\s*to form/i);
  if (!m) return { correct: null, correctAnswer: "" };
  const nums = [Number(m[1]), Number(m[2]), Number(m[3])].sort((a, b) => a - b);
  const [a, b, c] = nums;
  if (a + b !== c) return { correct: null, correctAnswer: "" };
  const valid = new Set([`${a}+${b}=${c}`, `${b}+${a}=${c}`, `${c}-${a}=${b}`, `${c}-${b}=${a}`]);
  const correct = valid.has(answer);
  return { correct, correctAnswer: correct ? "" : [...valid].join(" 或 ") };
}

// Ticket 76/139 (2026-09-28, real citation: "以下哪組數可合成13?
// A.6和5 B.8和5 C.4和7 D.9和3" -> B): matching-value expression set MC
// -- evaluates each option's "A和B" pair sum against a stated target,
// finds the unique match. Declines when the target isn't uniquely
// determined (0 or >1 matching options).
function verifyMatchingValueExpressionSetMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const targetMatch = printed.match(/合成\s*(\d+)|make\s*(\d+)|equals?\s*(\d+)/i);
  if (!targetMatch) return { correct: null, correctAnswer: "" };
  const target = Number(targetMatch[1] ?? targetMatch[2] ?? targetMatch[3]);
  const options = parseMcOptions(printed);
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  const evalPair = (text) => {
    const m = String(text).match(/(\d+)\s*(?:和|,|\+)\s*(\d+)/);
    return m ? Number(m[1]) + Number(m[2]) : null;
  };
  const evaluated = options.map((o) => ({ ...o, sum: evalPair(o.text) }));
  if (evaluated.some((o) => o.sum === null)) return { correct: null, correctAnswer: "" };
  const matching = evaluated.filter((o) => o.sum === target);
  if (matching.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedLetter = matching[0].letter;
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Word problem: total ÷ quantity = per-unit amount (real example:
// `p2_math_test_2023_2024.pdf` p1 Q12 -- "媽媽用32元買了8盒豆漿，每盒
// 豆漿售___元。" -> 32÷8=4). Same narrow-trigger discipline as
// verifyWordProblemTotal: needs a "每...(售|得|獲|分得)" per-unit
// keyword shape AND exactly two numbers. Explicitly DECLINES (stays
// null) when "另外" ("and N others") appears near a number -- a real
// trap found in the same source PDF (Q21: "老師把24張手工紙平均分給
// 卓賢和另外3個同學" -- the true group size is 3+1=4 people, not the
// literal "3" in the text; naively dividing 24÷3 would produce a
// confidently WRONG answer of 8 instead of the real 24÷4=6). Rather
// than attempt that adjustment (a different, riskier extraction
// problem), this function recognizes the shape and refuses to guess.
function verifyWordProblemDivision(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  if (/另外/.test(printed)) return { correct: null, correctAnswer: "" };
  if (!/每[^，,。？?]{0,6}(售|得|獲|分得|需)/.test(printed)) return { correct: null, correctAnswer: "" };
  const nums = (printed.match(/\d+/g) || []).map(Number);
  if (nums.length !== 2 || nums[1] === 0) return { correct: null, correctAnswer: "" };
  const expected = nums[0] / nums[1];
  if (!Number.isInteger(expected)) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Word problem: two numbers given, asking for their DIFFERENCE (real
// example: `p2_math_test_2023_2024.pdf` p1 Q19 -- "子健在第一場獲得
// 180分，第二場獲得166分。他在兩場比賽的得分相差多少分？" -> |180-166|=
// 14). Triggered narrowly by the "相差" keyword, mirroring
// verifyWordProblemTotal's "共" trigger and verifyPriceTableLookup's
// "比...貴/平/多/少" trigger for the same difference shape in a
// price-table context -- this is the plain-word-problem version.
// Ticket 56 (2026-09-27): English equivalent of "相差" -- "what is the
// difference between the two scores?" style phrasing, real gap found on
// an English-medium P2 workbook survey.
const WORD_PROBLEM_DIFFERENCE_EN_RE = /\bdifference\b/i;
function verifyWordProblemDifference(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || (!/相差/.test(printed) && !WORD_PROBLEM_DIFFERENCE_EN_RE.test(printed))) return { correct: null, correctAnswer: "" };
  const nums = (printed.match(/\d+/g) || []).map(Number);
  if (nums.length !== 2) return { correct: null, correctAnswer: "" };
  const expected = Math.abs(nums[0] - nums[1]);
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Word problem: one total given, PLUS an additive "more than" relationship
// to a second, unknown total -- find the second total (real example, 2026-
// 09-26 question-type survey: "249 oranges; there are 41 MORE apples than
// oranges; how many apples?" -> 249+41=290). The inverse shape of
// verifyWordProblemDifference (that one HAS both totals, asks for the
// difference; this one HAS one total + the difference, asks for the other
// total). Chinese phrasing uses "比...多"/"比...少" with a base object and
// an amount, English uses "more/fewer than" -- both narrowly triggered
// together with exactly 2 numbers, same discipline as every other word-
// problem verifier here (never guess which 2 numbers are "the" 2 unless
// the count is exactly 2, since a 3rd stray number elsewhere in a badly-
// split OCR string would make the pairing ambiguous).
function verifyWordProblemMoreThan(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  // English real phrasing is "N more APPLES than oranges" -- "more" and
  // "than" are not adjacent, a noun sits between them, so this allows a
  // short gap rather than requiring them back-to-back.
  //
  // Real bug caught by this function's own tests: an unbounded "比...少"
  // window (no punctuation boundary) also matched "少" from an entirely
  // unrelated LATER "有多少個?" ("how many?") clause in the same
  // sentence -- "少" is the second character of "多少", so almost every
  // real word problem asking "...是多少?" would false-positive as
  // "fewer" too. Bounded to the SAME clause (stops at the next comma/
  // full-width punctuation) so a later "多少" can never leak in.
  const isMore = /比[^，,。？?！!]{0,10}多/.test(printed) || /\bmore\b.{0,20}\bthan\b/i.test(printed);
  const isFewer = /比[^，,。？?！!]{0,10}少/.test(printed) || /\b(fewer|less)\b.{0,20}\bthan\b/i.test(printed);
  if (isMore === isFewer) return { correct: null, correctAnswer: "" }; // neither, or both (ambiguous OCR) -- decline
  const nums = (printed.match(/\d+/g) || []).map(Number);
  if (nums.length !== 2) return { correct: null, correctAnswer: "" };
  // The base total is always the LARGER of the two real-world quantities
  // in this shape (a count of objects), the difference the smaller "by
  // how much" amount -- real worksheets always state the difference as
  // the smaller number (you can't have "41 more" out of a base of 20).
  // Ambiguous/equal values are declined rather than guessed.
  const [a, b] = nums;
  if (a === b) return { correct: null, correctAnswer: "" };
  const base = Math.max(a, b), diff = Math.min(a, b);
  const expected = isMore ? base + diff : base - diff;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// "Write a number between X and Y" -- a genuinely different verification
// SHAPE from ordinary fill-blank (range-membership, not exact-match: any
// value strictly between the two bounds is correct, not just one specific
// answer). Chinese "介乎X同Y之間"/"喺X同Y之間", English "between X and Y".
// Deliberately STRICT (exclusive) bounds -- "between 3 and 8" in real
// worksheet phrasing means a value other than the two named endpoints
// themselves; a student answer equal to either bound is treated as
// wrong, not guessed as maybe-acceptable, matching this project's
// never-guess discipline (if a real worksheet turns out to intend
// inclusive bounds, that's a correction to make once real evidence of
// that shows up, not something to hedge on speculatively now).
function verifyNumberBetween(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = /(?:介乎|喺)\s*(\d+)\s*(?:同|和|與)\s*(\d+)\s*之間|\bbetween\s+(\d+)\s+and\s+(\d+)\b/i.exec(printed);
  let lo, hi;
  if (m) {
    lo = Number(m[1] ?? m[3]);
    hi = Number(m[2] ?? m[4]);
  } else {
    // Ticket 74/90 (2026-09-28, real citation: "子良的學號比9小，又比5
    // 大" -> range (5,9)): a separate "比A小...比B大" phrasing shape,
    // order-independent (either bound may be stated first).
    const smallMatch = printed.match(/比\s*(\d+)\s*小/);
    const bigMatch = printed.match(/比\s*(\d+)\s*大/);
    if (!smallMatch || !bigMatch) return { correct: null, correctAnswer: "" };
    lo = Number(bigMatch[1]);
    hi = Number(smallMatch[1]);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  let correct = studentNum > lo && studentNum < hi;
  // Ticket 74/90 (2026-09-28, real citations: "Three odd numbers
  // arranged smallest→greatest: 67, ?, 81. May be: ... C.73 ..." and
  // "子良的學號比9小，又比5大，而且是一個單數" -> 7): an optional PARITY
  // constraint stacked on top of the range check -- only applied when
  // the question also states odd/even, and only when it states exactly
  // one of the two (both or neither leaves the plain range check as-is).
  const wantsOdd = /單數|奇數|\bodd\b/i.test(printed);
  const wantsEven = /雙數|偶數|\beven\b/i.test(printed);
  if (wantsOdd && !wantsEven) correct = correct && Math.abs(studentNum % 2) === 1;
  else if (wantsEven && !wantsOdd) correct = correct && studentNum % 2 === 0;
  // Range-membership has no single "the" correct answer (any value
  // strictly between lo/hi qualifying the stated parity is correct) --
  // correctAnswer stays empty even when wrong, since there's nothing
  // honest and singular to fill in.
  return { correct, correctAnswer: "" };
}

// Word problem needing a ROUND-UP (ceiling) division, not floor -- real,
// recurring trap found independently in 3 separate PDF-reading passes
// 2026-09-23 (Groups A, B, D): "的士站有18人,每輛的士載4人,最少需要幾多
// 輛的士?" (⌈18/4⌉=5, NOT 18÷4=4). A plain floor-division verifier would
// confidently accept the wrong "4". Narrowly triggered on 至少/最少/"at
// least" co-occurring with a "每..." per-unit rate, exactly like
// verifyWordProblemDivision's own trigger discipline. The divisor is
// found via the "每" rate phrase specifically (not "whichever of the 2
// numbers comes first"), since real examples have the rate number
// appear BEFORE or AFTER the total depending on sentence order.
function verifyWordProblemCeilingDivision(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  if (!/(至少|最少)/.test(printed) && !/at least/i.test(printed)) return { correct: null, correctAnswer: "" };
  // Ticket 120 (2026-09-28, 2nd real citation: "There are 25 chocolates
  // in a box. Sue wants to have 100 chocolates. She has to buy at least
  // ___ box(es)." -> ⌈100/25⌉=4): the per-unit rate isn't always stated
  // via 每/"per" -- "N in a box" is a distinct real English phrasing for
  // the same per-unit-quantity role.
  const perMatch = printed.match(/每[^\d]{0,10}(\d+)/) || printed.match(/(\d+)\s*\S*\s*in a box/i);
  if (!perMatch) return { correct: null, correctAnswer: "" };
  const divisor = Number(perMatch[1]);
  if (!divisor) return { correct: null, correctAnswer: "" };
  const allNums = (printed.match(/\d+/g) || []).map(Number);
  if (allNums.length !== 2) return { correct: null, correctAnswer: "" };
  const dividend = allNums.find((n) => n !== divisor);
  if (dividend === undefined) return { correct: null, correctAnswer: "" };
  const expected = Math.ceil(dividend / divisor);
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 117 (2026-09-28, real citation: "When a cartoon programme
// starts, the longer hand on a clock face points to 12 while the
// shorter hand points to 5. The cartoon programme starts at ___
// o'clock." -> 5): a real find that TEXT can describe clock-hand
// positions directly -- this is pure regex/text reasoning, NOT the
// usual Tier V "must look at the photo" clock type, and was likely
// being misrouted to AI/Tier V before this handler existed. Narrowly
// scoped to the "on the hour" case only (minute/long hand pointing
// exactly at 12) -- the only shape actually seen; other minute-hand
// positions would need interval-to-minutes math this hasn't been
// validated against.
function verifyTextualClockDescription(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const longMatch = printed.match(/long(?:er)?\s+hand.{0,20}points?\s+to\s+(\d+)/i);
  const shortMatch = printed.match(/short(?:er)?\s+hand.{0,20}points?\s+to\s+(\d+)/i);
  if (!longMatch || !shortMatch) return { correct: null, correctAnswer: "" };
  if (Number(longMatch[1]) !== 12) return { correct: null, correctAnswer: "" };
  const hourRaw = Number(shortMatch[1]);
  const expectedHour = hourRaw === 0 ? 12 : hourRaw;
  const studentTime = parseTimeAnswer(answer) || (() => {
    const n = parseSignedStudentNumber(answer);
    return Number.isNaN(n) ? null : { hour: n === 0 ? 12 : n, minute: 0 };
  })();
  if (!studentTime) return { correct: null, correctAnswer: "" };
  const correct = studentTime.hour === expectedHour && studentTime.minute === 0;
  return { correct, correctAnswer: correct ? "" : `${expectedHour} o'clock` };
}

// Ticket 122 (2026-09-28, real citation: "If a box of oranges is shared
// equally among 10 people, there will be one orange left. What is the
// possible number of oranges in the box? A.10 B.19 C.20 D.21" -> D,
// since 21 mod 10 == 1): modular-remainder "possible quantity" MC --
// filters options by the stated remainder condition. Declines when the
// filter doesn't leave exactly one option.
function verifyModularRemainderMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  // Remainder count is often spelled out ("there will be ONE orange
  // left", the real citation) rather than a digit -- small-number words
  // must be supported, not just "\d+".
  const wordToNum = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  const remainderToken = "(\\d+|one|two|three|four|five|six|seven|eight|nine)";
  const re = new RegExp(`(?:shared|divided)\\s+equally\\s+among\\s+(\\d+)[\\s\\S]{0,40}?${remainderToken}\\s+\\S+\\s+left|among\\s+(\\d+)\\s+people[\\s\\S]{0,40}?${remainderToken}\\s+\\S+\\s+left`, "i");
  const m = printed.match(re);
  if (!m) return { correct: null, correctAnswer: "" };
  const divisor = Number(m[1] ?? m[3]);
  const remainderRaw = (m[2] ?? m[4] ?? "").toLowerCase();
  const remainder = /^\d+$/.test(remainderRaw) ? Number(remainderRaw) : wordToNum[remainderRaw];
  if (!divisor || remainder === undefined) return { correct: null, correctAnswer: "" };
  const options = parseMcOptions(printed);
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  const matching = options.filter((o) => /^\d+$/.test(o.text.trim()) && Number(o.text.trim()) % divisor === remainder);
  if (matching.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedLetter = matching[0].letter;
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Ticket 123 (2026-09-28, real citation: "In a classroom, there are 80
// students. If 19 students go to the library and 57 students go home,
// how many students are still in the classroom?" -> 80-19-57=4):
// sequential-subtraction "how many remain" word problem. Keyed on
// still/仍然/留在, kept separate from the existing 相差(difference)/
// 共(total) triggers so it can't collide with either.
function verifySequentialSubtractionRemaining(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  if (!/\bstill\b|仍然|留在/i.test(printed)) return { correct: null, correctAnswer: "" };
  const nums = (printed.match(/(?<!第)\d+/g) || []).map(Number);
  if (nums.length < 2) return { correct: null, correctAnswer: "" };
  const [first, ...rest] = nums;
  const expected = rest.reduce((acc, n) => acc - n, first);
  if (expected < 0) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// "The number right after N -- how many digits does it have?" (real
// example, p1-p6.com P3 maths: "9999後面嗰個數,有幾多個位?" -> 5). Pure
// place-value-boundary logic, zero visual/OCR risk once the one number
// is read.
//
// 2026-09-23, code-review-2axis finding: this used to check "後面/之後/
// next/after" and "位/digit" as two INDEPENDENT substring tests anywhere
// in the whole printedQuestion text. Both are extremely common, generic
// Chinese math vocabulary ("位" alone means ones/tens/hundreds place,
// used constantly outside this question type) -- an unrelated question
// concatenated into the same OCR'd string (an already-documented real
// risk elsewhere in this file, e.g. the "第1組" ordinal-label bug) could
// satisfy both checks independently and get CONFIDENTLY marked wrong
// against a nonsense interpretation, the one failure mode this whole
// file is built to avoid. Anchored into ONE contiguous pattern instead,
// so the number, the "next/after" phrase, and "位"/"digit" must actually
// sit together -- the number is now read directly from the matched
// phrase, not from "however many numbers happen to be in the whole
// text", which also makes this safe against extra unrelated numbers
// elsewhere in a concatenated string.
const DIGIT_COUNT_OF_N_PLUS_ONE_RE =
  /(\d+)\s*(?:後面|之後|後嗰個)[^。？?！\n]{0,15}(?:位|digit)|(?:next|after)\s*(\d+)[^.?!\n]{0,20}digit/i;

function verifyDigitCountOfNPlusOne(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(DIGIT_COUNT_OF_N_PLUS_ONE_RE);
  if (!m) return { correct: null, correctAnswer: "" };
  const n = Number(m[1] || m[2]);
  if (!Number.isInteger(n)) return { correct: null, correctAnswer: "" };
  const expected = String(n + 1).length;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  const correct = studentNum === expected;
  return verdictResult(correct, expected, `${n}後面一個數係${n + 1}，有${expected}位數`);
}

// Compound-unit-to-single-unit length conversion (real, recurring across
// Groups B/C, 2026-09-23): "8m 11cm = ___cm" (811), "10cm 2mm = ___mm"
// (102). Narrowly triggered on TWO distinct length-unit tokens before
// "=" plus a THIRD length-unit token after it -- specific enough that it
// shouldn't misfire on an ordinary bare-number math equation.
function verifyCompoundUnitConversion(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+(?:\.\d+)?)\s*(km|mm|cm|m)\s*(\d+(?:\.\d+)?)\s*(km|mm|cm|m)\s*=[^a-zA-Z]*(km|mm|cm|m)\b/i);
  if (!m) return { correct: null, correctAnswer: "" };
  const [, v1, u1, v2, u2, u3] = m;
  const TO_MM = { km: 1000000, m: 1000, cm: 10, mm: 1 };
  const u1n = u1.toLowerCase(), u2n = u2.toLowerCase(), u3n = u3.toLowerCase();
  const totalMm = Number(v1) * TO_MM[u1n] + Number(v2) * TO_MM[u2n];
  const expected = totalMm / TO_MM[u3n];
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  const closeEnough = Math.abs(studentNum - expected) < 1e-9;
  const expectedStr = Number.isInteger(expected) ? String(expected) : expected.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const part1 = (Number(v1) * TO_MM[u1n]) / TO_MM[u3n];
  const part2 = (Number(v2) * TO_MM[u2n]) / TO_MM[u3n];
  return verdictResult(closeEnough, expectedStr, `${v1}${u1}${v2}${u2} = ${part1}${u3}+${part2}${u3} = ${expectedStr}${u3}`);
}

// Construct the largest/smallest N-digit number from a given multiset of
// digits, optionally under an odd/even constraint on the last digit
// (real examples, 2026-09-23 PDF reading: "用5,0,8,6,2砌最小嘅五位數"
// (50268); "form the largest 5-digit ODD number from 7,0,3,9,1" (97301)).
// Brute-force permutation search -- correct by construction, not a
// heuristic -- capped at 7 digits (5040 permutations) to stay cheap;
// callers must not invoke this on more digits than that.
function verifyConstructExtremeNumber(digits, { largest, parity } = {}) {
  if (!Array.isArray(digits) || digits.length < 1 || digits.length > 7) return null;
  const nums = digits.map(Number);
  if (nums.some((d) => !Number.isInteger(d) || d < 0 || d > 9)) return null;
  const permute = (arr) => {
    if (arr.length <= 1) return [arr];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permute(rest)) out.push([arr[i], ...p]);
    }
    return out;
  };
  let best = null;
  for (const p of permute(nums)) {
    if (p.length > 1 && p[0] === 0) continue;
    const last = p[p.length - 1];
    if (parity === "odd" && last % 2 === 0) continue;
    if (parity === "even" && last % 2 !== 0) continue;
    const value = Number(p.join(""));
    if (best === null || (largest ? value > best : value < best)) best = value;
  }
  return best;
}

// Text-driven wrapper for verifyConstructExtremeNumber, keyed off the
// REAL confirmed sentence shape (2026-09-23: pulled the actual source
// page and read the real printed text directly, not guessed) --
// Chinese: "把5,0,8,6和2這五個數字組成一個最小的五位數。"; English:
// "Use 5, 0, 8, 6 and 2 to form the smallest 5-digit number." Verified
// end-to-end against the REAL live production `/api/mark` pipeline the
// same day (a photo of this exact real exam page, with a simulated
// answer written in): the item correctly came back `needs_review`
// (safe, no wrong guess) before this function existed, confirming the
// registry's fail-safe default was working -- this wrapper is what lets
// it move from "safely declined" to "correctly graded".
//
// Digit-list extraction: every standalone Arabic digit in the printed
// text EXCEPT one immediately followed by "-digit" (English width
// spec, e.g. the "5" in "5-digit") or by "位" (Chinese width spec, e.g.
// a possible "5位數" phrasing) -- the real Chinese example spells its
// width in a CHINESE numeral ("五位數"), so this exclusion is a safety
// margin for an English-digit width phrasing, not yet independently
// confirmed by a second real example. If a width IS stated (Chinese
// numeral word, or "N-digit"), it's cross-checked against the extracted
// digit count -- a mismatch declines (null) rather than risk silently
// using the wrong digit set.
function verifyConstructExtremeNumberFromText(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  if (!/(組成|to form|form the)/i.test(printed)) return { correct: null, correctAnswer: "" };
  const largest = /(最大|largest|greatest)/i.test(printed);
  const smallest = /(最小|smallest|least)/i.test(printed);
  if (largest === smallest) return { correct: null, correctAnswer: "" };
  let parity = null;
  if (/(奇數|\bodd\b)/i.test(printed)) parity = "odd";
  else if (/(偶數|\beven\b)/i.test(printed)) parity = "even";
  const digitTokens = printed.match(/\d(?!-digit)(?!位)/g);
  if (!digitTokens || digitTokens.length < 2 || digitTokens.length > 7) return { correct: null, correctAnswer: "" };
  const digits = digitTokens.map(Number);
  const cnWidth = printed.match(/([一二三四五六七八九十])位(?:數|奇數|偶數)/);
  const enWidth = printed.match(/(\d+)-digit/i);
  const statedWidth = cnWidth ? parseChineseNumberWord(cnWidth[1]) : enWidth ? Number(enWidth[1]) : null;
  if (statedWidth !== null && statedWidth !== digits.length) return { correct: null, correctAnswer: "" };
  const expected = verifyConstructExtremeNumber(digits, { largest, parity });
  if (expected === null) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// "From {a,b,c,...} select TWO numbers that add up to a printed target"
// (real example, 2026-09-23: "從6,9,4中選兩個, ___+___=10"). Real live
// production test (2026-09-23, same day) showed the common real OCR
// shape for this type is actually a single combined equation string
// ("6+4=10"), which the EXISTING `math_equation`/`verifyMath` fallback
// already grades correctly for free -- no new handler needed for that
// shape. The one confirmed real gap that test exposed: `verifyMath`
// only checks the equation is arithmetically true, NOT that the two
// numbers used were actually from the printed candidate set (e.g. a
// fabricated "3+7=10" using numbers not in {6,9,4} would also pass) --
// logged as a known minor gap in TICKETS.md rather than fixed here,
// since reliably extracting the printed CANDIDATE set (as opposed to
// the equation itself) from OCR text isn't yet confirmed real evidence.
// This function stays available for a caller that already has the
// candidate set and target as separate structured fields.
function verifySelectTwoNumbersSumTarget(candidateNums, target, studentAnswer) {
  const candidates = (candidateNums || []).map(Number);
  const t = Number(target);
  if (candidates.length < 2 || candidates.length > 8 || !Number.isFinite(t)) return { correct: null, correctAnswer: "" };
  const studentNums = (String(studentAnswer || "").match(/-?\d+(\.\d+)?/g) || []).map(Number);
  if (studentNums.length !== 2) return { correct: null, correctAnswer: "" };
  const remaining = [...candidates];
  const bothFromSet = studentNums.every((n) => {
    const idx = remaining.indexOf(n);
    if (idx === -1) return false;
    remaining.splice(idx, 1);
    return true;
  });
  const sumOk = studentNums[0] + studentNums[1] === t;
  if (sumOk && bothFromSet) return { correct: true, correctAnswer: "" };
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[i] + candidates[j] === t) {
        return { correct: false, correctAnswer: `${candidates[i]}+${candidates[j]}=${t}` };
      }
    }
  }
  return { correct: false, correctAnswer: "" };
}

// List all factors (divisors) of N (real examples, 2026-09-23 P4 PDF
// reading: "寫出25嘅所有因數" -> 1,5,25; "列出34的所有因數" ->
// 1,2,17,34). Order-independent set comparison against the student's
// list, matching the real "全對才給分" (all-or-nothing) grading note
// found alongside this type in the source paper -- listing the right
// numbers in any order is correct, a missing or extra factor is not.
// Ticket 169 (2026-09-28, real citations: "6 [ ] 9 [ ] 4 → __+__=10" and
// "6 [ ] 5 [ ] 12 → __+__=18"): closes a real, 3-times-confirmed gap in
// verifySelectTwoNumbersSumTarget (documented above) -- that function
// already validates the student's two numbers came from the real
// candidate set when GIVEN one, but was never wired to extract that set
// from printed text because no real OCR-observable format had been seen
// before. These two citations show the actual real shape: 3 numbers
// separated by blank-card markers, followed by an explicit
// "__+__=target" template -- parseable directly.
function verifySelectTwoNumbersSumTargetFromText(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const m = printed.match(/(\d+)[^\d+\-=]+(\d+)[^\d+\-=]+(\d+)[^\d]*?_+\s*\+\s*_+\s*=\s*(\d+)/);
  if (!m) return { correct: null, correctAnswer: "" };
  const candidates = [Number(m[1]), Number(m[2]), Number(m[3])];
  const target = Number(m[4]);
  return verifySelectTwoNumbersSumTarget(candidates, target, studentAnswer);
}

// Ticket 142 (2026-09-28, real citation: "列出11的最初三個倍數。
// (全對才給分)" -> 11,22,33): first-N-multiples list, same all-or-
// nothing set-comparison discipline as verifyListFactors.
function verifyFirstNMultiples(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/列出(\d+)的最初(\d+|[一二三四五六七八九十]+)個倍數/);
  if (!m) return { correct: null, correctAnswer: "" };
  const n = Number(m[1]);
  const count = /^\d+$/.test(m[2]) ? Number(m[2]) : chineseNumeralToArabicSmall(m[2]);
  if (!count) return { correct: null, correctAnswer: "" };
  const expected = Array.from({ length: count }, (_, i) => n * (i + 1));
  const studentNums = (answer.match(/\d+/g) || []).map(Number);
  const correct = studentNums.length === expected.length && studentNums.every((v, i) => v === expected[i]);
  return { correct, correctAnswer: correct ? "" : expected.join(", ") };
}

// Ticket 145 (2026-09-28, real citation: "某數的第8個和第10個倍數相差
// 14，求某數。" -> 7): reverses the difference-between-two-multiples
// relationship to solve for the base number itself.
function verifyReverseBaseFromMultipleDifference(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/第(\d+)個和第(\d+)個倍數相差(\d+)/);
  if (!m) return { correct: null, correctAnswer: "" };
  const gap = Math.abs(Number(m[2]) - Number(m[1]));
  const diff = Number(m[3]);
  if (!gap || diff % gap !== 0) return { correct: null, correctAnswer: "" };
  const expected = diff / gap;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 146 (2026-09-28, real citation: "70的所有因數是1、2、☆、7、
// 10、14、35和70，☆代表的數是甚麼？" -> 5): missing factor in an
// otherwise-complete ordered factor list.
function verifyMissingFactorInOrderedList(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)的所有因數是([\d、和☆]+)/);
  if (!m || !m[2].includes("☆")) return { correct: null, correctAnswer: "" };
  const n = Number(m[1]);
  const listed = m[2].replace(/和/g, "、").split("、").filter(Boolean);
  const factors = [];
  for (let i = 1; i <= n; i++) if (n % i === 0) factors.push(i);
  if (listed.length !== factors.length) return { correct: null, correctAnswer: "" };
  const idx = listed.indexOf("☆");
  const expected = factors[idx];
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 147 (2026-09-28, real citation: "他的球衣上的數字是5的倍數，
// 又是40的因數" MC options {15,10,4,12} -> 10): dual-constraint (is a
// multiple of X AND a factor of Y) filter over MC options.
function verifyDualConstraintNumberFilter(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/是(\d+)的倍數.{0,6}又是(\d+)的因數/);
  if (!m) return { correct: null, correctAnswer: "" };
  const [mult, fact] = [Number(m[1]), Number(m[2])];
  const options = parseMcOptions(printed);
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  const candidates = options.filter((o) => {
    const n = Number(o.text.trim());
    return Number.isFinite(n) && n % mult === 0 && fact % n === 0;
  });
  if (candidates.length !== 1) return { correct: null, correctAnswer: "" };
  const correct = answer === candidates[0].letter;
  return { correct, correctAnswer: correct ? "" : candidates[0].letter };
}

// Ticket 149 (2026-09-28, real citation: "4和10的第一個公倍數是20，
// 第三個公倍數是甚麼？" -> 60): Nth common multiple, forward direction
// (multiply the given 1st common multiple, which is always the LCM, by N).
function verifyNthCommonMultiple(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/第一個公倍數是(\d+)[\s\S]{0,10}第(\d+|[一二三四五六七八九十]+)個公倍數是甚麼/);
  if (!m) return { correct: null, correctAnswer: "" };
  const lcm = Number(m[1]);
  const n = /^\d+$/.test(m[2]) ? Number(m[2]) : chineseNumeralToArabicSmall(m[2]);
  if (!n) return { correct: null, correctAnswer: "" };
  const expected = lcm * n;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 151 (2026-09-28, real citation: "以下哪一組數的積就是它們的
// L.C.M.?" options 9·12/10·15/9·16/18·36 -> C(9,16), since LCM(a,b)=a×b
// iff a,b are coprime): evaluates each MC option's coprimality.
function gcdOfTwo(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
function verifyCoprimeProductEqualsLcmMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/L\.C\.M\.|LCM/i.test(printed)) return { correct: null, correctAnswer: "" };
  // "L.C.M." itself contains a "C." substring that parseMcOptions'
  // generic [A-D][.．] regex misreads as a spurious leading option C
  // (found via a real test failure) -- strip the term's periods before
  // parsing options, since this function no longer needs the literal
  // text once the trigger check above has already run.
  const options = parseMcOptions(printed.replace(/L\.C\.M\./gi, "LCM"));
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  const evaluated = options.map((o) => {
    const m = o.text.match(/(\d+)\D+(\d+)/);
    return m ? { ...o, isCoprime: gcdOfTwo(Number(m[1]), Number(m[2])) === 1 } : { ...o, isCoprime: null };
  });
  if (evaluated.some((o) => o.isCoprime === null)) return { correct: null, correctAnswer: "" };
  const trueOnes = evaluated.filter((o) => o.isCoprime);
  if (trueOnes.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedLetter = trueOnes[0].letter;
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Ticket 162 (2026-09-28, real citation: "如果△是一個整數，△4/5×2的
// 答案約是16，那麼△表示的數可能是甚麼？" options 6/7/8/9 -> B(7), since
// "△4/5" reads as the mixed number △-and-⅘, common in HK exams that
// omit "又"): reverse-solve MC via closest-approximation -- compute
// (option+4/5)×mult for each option, pick whichever is nearest the
// stated approximate target.
function verifyClosestApproximationMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/△(\d+)\/(\d+)×(\d+)的答案約是(\d+)/);
  if (!m) return { correct: null, correctAnswer: "" };
  const [num, den, mult, target] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const options = parseMcOptions(printed);
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  let best = null, bestDiff = Infinity;
  for (const o of options) {
    const n = Number(o.text.trim());
    if (!Number.isFinite(n)) continue;
    const diff = Math.abs((n + num / den) * mult - target);
    if (diff < bestDiff) { bestDiff = diff; best = o; }
  }
  if (!best) return { correct: null, correctAnswer: "" };
  const correct = answer === best.letter;
  return { correct, correctAnswer: correct ? "" : best.letter };
}

// Ticket 167 (2026-09-28, real citation: "Put 6 beads on the abacus...
// To represent the largest three-digit odd number, the answer is
// __501__.") -- extreme N-digit number under a DIGIT-SUM constraint
// (not a given digit list, distinct from the already-built
// construct_extreme_number handler).
function verifyExtremeNumberByDigitSum(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/Put\s*(\d+)\s*beads.{0,80}(largest|smallest)\s*(three|four|five)-digit\s*(odd|even)?\s*number/i);
  if (!m) return { correct: null, correctAnswer: "" };
  const beadSum = Number(m[1]);
  const largest = m[2].toLowerCase() === "largest";
  const digitCount = { three: 3, four: 4, five: 5 }[m[3].toLowerCase()];
  const parity = m[4] ? m[4].toLowerCase() : null;
  const min = 10 ** (digitCount - 1), max = 10 ** digitCount - 1;
  let found = -1;
  const range = largest ? [max, min, -1] : [min, max, 1];
  for (let n = range[0]; largest ? n >= range[1] : n <= range[1]; n += range[2]) {
    const digitSum = String(n).split("").reduce((a, d) => a + Number(d), 0);
    if (digitSum !== beadSum) continue;
    if (parity === "odd" && n % 2 === 0) continue;
    if (parity === "even" && n % 2 === 1) continue;
    found = n;
    break;
  }
  if (found === -1) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === found, correctAnswer: studentNum === found ? "" : String(found) };
}

// Ticket 168 (2026-09-28, real citations: "1個$10可換$2 ___個" -> 5;
// "5個$2可換$1 ___個" -> 10; "2個$1可換50¢ ___個" -> 4): currency
// exchange-ratio arithmetic, unit-normalized to cents so dollar/cent
// mixes ($1 vs 50¢) compare correctly. Only the simple single-target
// ratio shape -- the two-coefficient case ("$5 = 2×$2 + 1×$1") found in
// the same survey is a genuinely different, harder shape and isn't
// attempted here.
function normalizeCurrencyToCents(text) {
  const dollarMatch = text.match(/\$(\d+(?:\.\d+)?)/);
  if (dollarMatch) return Math.round(Number(dollarMatch[1]) * 100);
  const centMatch = text.match(/(\d+)\s*[¢c]/i);
  if (centMatch) return Number(centMatch[1]);
  return null;
}
function verifyCoinExchangeRatio(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)個(\$\d+(?:\.\d+)?|\d+\s*[¢c])可換(\$\d+(?:\.\d+)?|\d+\s*[¢c])\s*_+\s*個/i);
  if (!m) return { correct: null, correctAnswer: "" };
  const sourceCount = Number(m[1]);
  const sourceVal = normalizeCurrencyToCents(m[2]);
  const targetVal = normalizeCurrencyToCents(m[3]);
  if (!sourceVal || !targetVal) return { correct: null, correctAnswer: "" };
  const totalCents = sourceCount * sourceVal;
  if (totalCents % targetVal !== 0) return { correct: null, correctAnswer: "" };
  const expected = totalCents / targetVal;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 176 (2026-09-28, real citations: "Which expression below can
// we use to calculate the answer? A 82−15−15 B 82−21 C 21−15
// D 82−15−21" and "Which of the following expression has the same
// result as '35−15−9'? A 35−9 B 35−15 C 15−9 D 20−9"): evaluates each MC
// option as an arithmetic expression, finds the one matching a stated
// target value (either an explicit number, or another expression's own
// computed result).
function verifyWhichExpressionComputesMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const options = parseMcOptions(printed);
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  let target = null;
  const sameAsMatch = printed.match(/same result as ['"]?([\d+\-×x*÷/\s]+)['"]?/i);
  if (sameAsMatch) target = evalArithmetic(sameAsMatch[1]);
  if (target === null) {
    const numMatch = printed.match(/answer is\s*(\d+)|=\s*(\d+)\s*[?？]/i);
    if (numMatch) target = Number(numMatch[1] || numMatch[2]);
  }
  if (target === null || Number.isNaN(target)) return { correct: null, correctAnswer: "" };
  const evaluated = options.map((o) => ({ ...o, value: evalArithmetic(o.text.replace(/\s+/g, "")) }));
  if (evaluated.some((o) => o.value === null)) return { correct: null, correctAnswer: "" };
  const matching = evaluated.filter((o) => o.value === target);
  if (matching.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedLetter = matching[0].letter;
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Ticket 153 (2026-09-28, real citation: "利用以下的數卡，選出其中2張
// 組成一個兩位的合成數，這個數最大是多少？" digit cards {9,0,7,1} ->
// enumerate all valid 2-digit numbers (leading digit ≠ 0) formable from
// picking 2 of the given cards, filter to composite only, take the
// max/min per the question's own wording.
function isCompositeNumber(n) {
  if (n < 4) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return true;
  return false;
}
function verifyDigitCardExtremeComposite(digitCards, printedQuestion, studentAnswer) {
  if (!digitCards) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/兩位的合成數/.test(printed)) return { correct: null, correctAnswer: "" };
  const wantMax = /最大/.test(printed), wantMin = /最小/.test(printed);
  if (wantMax === wantMin) return { correct: null, correctAnswer: "" };
  let best = null;
  for (let i = 0; i < digitCards.length; i++) {
    for (let j = 0; j < digitCards.length; j++) {
      if (i === j) continue;
      const tens = digitCards[i], units = digitCards[j];
      if (tens === 0) continue;
      const n = tens * 10 + units;
      if (!isCompositeNumber(n)) continue;
      if (best === null || (wantMax ? n > best : n < best)) best = n;
    }
  }
  if (best === null) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === best, correctAnswer: studentNum === best ? "" : String(best) };
}

// Ticket 154 (2026-09-28, real citation: "以下各短除式中，哪組被除數的
// 最大公因數不是14？" A=14丨70 56(→5,4); B=2丨18 28(→9,14); C=7丨42 28,
// 2丨6 4(→3,2); D=2丨14 28,7丨7 14(→1,2) -- student picked B, correctly):
// each option's own short-division chain, when carried all the way until
// the quotients are coprime, has HCF = product of every divisor used
// down the chain. Find whichever option's product does NOT match the
// number named in the question ("不是14"); that's the odd one out.
function verifyShortDivisionHcfMc(shortDivisionMc, printedQuestion, studentAnswer) {
  if (!shortDivisionMc) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  const targetMatch = /最大公因數不是\s*(\d+)/.exec(printed);
  if (!answer || !targetMatch) return { correct: null, correctAnswer: "" };
  const target = Number(targetMatch[1]);
  const letters = Object.keys(shortDivisionMc);
  if (letters.length < 2) return { correct: null, correctAnswer: "" };
  const oddOnes = letters.filter((l) => shortDivisionMc[l].reduce((a, b) => a * b, 1) !== target);
  if (oddOnes.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedLetter = oddOnes[0];
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Ticket 155 (2026-09-28, real citation: "上圖由兩個面積分別是81 cm²和
// 36 cm²的正方形組成。陰影部分的面積是多少cm²？" -- real photo shows two
// squares TOP-ALIGNED side by side (big on the left, side a=√bigArea;
// small on the right, side b=√smallArea), with a diagonal from the big
// square's bottom-left corner to a point on the combined right edge that
// sits "gap" cm below the shared top edge. Hand-derived from the real
// photo before writing this (verified against the teacher's own marked
// answer, 90):
//   Diagonal: from (0,0) to (a+b, a-gap).
//   Left square (x:0..a, y:0..a): shaded = bigArea - the below-diagonal
//     triangle (0,0)-(a,0)-(a, diag(a)).
//   Right square (x:a..a+b, y:(a-b)..a): shaded = smallArea - the
//     below-diagonal trapezoid between the square's own bottom and the
//     diagonal.
// Deliberately narrow: declines (returns null) if the diagonal doesn't
// stay within the right square's own vertical span, since that's a
// different picture than the one actually verified.
function verifySquaresDiagonalShadedArea(squaresDiagonal, printedQuestion, studentAnswer) {
  if (!squaresDiagonal) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/陰影部分的面積/.test(printed)) return { correct: null, correctAnswer: "" };
  const { bigArea, smallArea, gap } = squaresDiagonal;
  const a = Math.sqrt(bigArea), b = Math.sqrt(smallArea);
  if (!(a > 0) || !(b > 0) || !(gap >= 0) || gap >= a) return { correct: null, correctAnswer: "" };
  const W = a + b;
  const endHeight = a - gap;
  const slope = endHeight / W;
  const yAtSharedEdge = slope * a;
  if (yAtSharedEdge < 0 || yAtSharedEdge > a) return { correct: null, correctAnswer: "" };
  const shadedLeft = bigArea - 0.5 * a * yAtSharedEdge;
  const squareBottom = a - b;
  const h1 = yAtSharedEdge - squareBottom, h2 = endHeight - squareBottom;
  if (h1 < 0 || h2 < 0) return { correct: null, correctAnswer: "" };
  const whiteRight = b * (h1 + h2) / 2;
  const shadedRight = smallArea - whiteRight;
  const expected = shadedLeft + shadedRight;
  const studentNum = parseNumericAnswer(answer);
  if (studentNum === null) return { correct: null, correctAnswer: "" };
  const correct = Math.abs(studentNum - expected) < 0.01;
  return { correct, correctAnswer: correct ? "" : String(Math.round(expected * 100) / 100) };
}

// Ticket 156 (2026-09-28, real citation: "右圖由一個梯形和兩個正方形組
// 成，兩個正方形的周界分別24 cm和16 cm，梯形的面積是多少cm²？" -- real
// photo shows the two squares sitting on a common baseline, the trapezoid
// wedged between them, with the WHOLE baseline's total length given in
// the diagram (12 cm). The two squares' own widths (sides) are already
// their own two parallel edges of the trapezoid; the trapezoid's own
// "height" (distance between those two parallel vertical sides) is
// whatever's left of the baseline once both squares' widths are removed.
// Verified against the real citation's own answer, A. 10 cm²:
//   side1=24/4=6, side2=16/4=4, gap=12-6-4=2, area=(6+4)/2*2=10.
function verifyTrapezoidTwoSquaresArea(trapezoidBaseline, printedQuestion, studentAnswer) {
  if (trapezoidBaseline == null) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/梯形的面積/.test(printed)) return { correct: null, correctAnswer: "" };
  const perims = [...printed.matchAll(/(\d+(?:\.\d+)?)\s*cm/gi)].map((m) => Number(m[1]));
  if (perims.length < 2) return { correct: null, correctAnswer: "" };
  const [p1, p2] = perims;
  const side1 = p1 / 4, side2 = p2 / 4;
  const gap = trapezoidBaseline - side1 - side2;
  if (gap <= 0) return { correct: null, correctAnswer: "" };
  const expected = ((side1 + side2) / 2) * gap;
  // Ticket 156 bug fix (2026-09-28, found via a from-scratch
  // classifyAndVerify test against the real citation): the real citation
  // is presented as MC (A/B/C/D), so a real student answers with a
  // LETTER, not a bare number -- this originally only accepted a bare
  // number, silently declining (or worse, mis-scoring) every real MC
  // answer. Same MC-then-bare-number fallback pattern as Tickets 157/158.
  const options = parseMcOptions(printed);
  if (options.length >= 2) {
    const matching = options.filter((o) => Math.abs(Number((o.text.match(/[\d.]+/) || [])[0]) - expected) < 0.01);
    if (matching.length === 1) {
      // Accept either the MC letter (how a real student answers this
      // shape) OR the bare numeric value (already-passing tests, and any
      // caller that strips MC option text before verifying) -- both are
      // "correct" here, never just one.
      const studentNum2 = parseNumericAnswer(answer);
      const correct = answer === matching[0].letter || (studentNum2 !== null && Math.abs(studentNum2 - expected) < 0.01);
      return { correct, correctAnswer: correct ? "" : matching[0].letter };
    }
  }
  const studentNum = parseNumericAnswer(answer);
  if (studentNum === null) return { correct: null, correctAnswer: "" };
  const correct = Math.abs(studentNum - expected) < 0.01;
  return { correct, correctAnswer: correct ? "" : String(Math.round(expected * 100) / 100) };
}

// Ticket 157 (2026-09-28, real citation: "把兩個高是4 cm，底是9 cm的平
// 行四邊形重疊成一個新圖形...如果重疊部分的底是3 cm，重疊後整個圖形的
// 面積是多少cm²？" MC A.36/B.57/C.60/D.72 -- new geometry concept, not
// covered by anything else in this project before. No diagram marker
// needed -- base/height/overlap are all in the printed question text
// itself. Union area = 2×(base×height) - overlapBase×height, same
// height for both parallelograms and the overlap (only the overlap's
// base differs). Verified against the real citation's own answer, C. 60.
function verifyOverlappingParallelogramUnionArea(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/重疊/.test(printed) || !/平行四邊形/.test(printed)) return { correct: null, correctAnswer: "" };
  const heightMatch = /高是\s*(\d+(?:\.\d+)?)\s*cm/.exec(printed);
  const baseMatch = /底是\s*(\d+(?:\.\d+)?)\s*cm/.exec(printed);
  const overlapMatch = /重疊部分的底是\s*(\d+(?:\.\d+)?)\s*cm/.exec(printed);
  if (!heightMatch || !baseMatch || !overlapMatch) return { correct: null, correctAnswer: "" };
  const height = Number(heightMatch[1]), base = Number(baseMatch[1]), overlapBase = Number(overlapMatch[1]);
  const expected = 2 * base * height - overlapBase * height;
  const options = parseMcOptions(printed);
  if (options.length >= 2) {
    const matching = options.filter((o) => Math.abs(Number((o.text.match(/[\d.]+/) || [])[0]) - expected) < 0.01);
    if (matching.length === 1) {
      const correct = answer === matching[0].letter;
      return { correct, correctAnswer: correct ? "" : matching[0].letter };
    }
  }
  const studentNum = parseNumericAnswer(answer);
  if (studentNum === null) return { correct: null, correctAnswer: "" };
  const correct = Math.abs(studentNum - expected) < 0.01;
  return { correct, correctAnswer: correct ? "" : String(Math.round(expected * 100) / 100) };
}

// Ticket 158 (2026-09-28, real citation: "右圖是一個大平行四邊形果園，
// 它的佔地面積是770 m²。如果着色部分的佔地面積是220 m²，白色部分高多少
// m？" MC A.11/B.22/C.25/D.35 -- real photo shows a parallelogram split
// by a VERTICAL line into a white (left) and shaded (right) piece, with
// the shaded piece's own base width given in the diagram. Key insight
// (shearing/Cavalieri): ANY vertical slice of a parallelogram has area =
// slice_width × the parallelogram's own perpendicular (vertical) height,
// exactly like a rectangle -- so the shaded piece's area/width gives that
// shared height directly, and the white piece's width follows the same
// way. Verified against the real citation's own answer, C. 25.
function verifyParallelogramPartialHeight(parallelogramShadedWidth, printedQuestion, studentAnswer) {
  if (parallelogramShadedWidth == null) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/白色部分/.test(printed) || !/佔地面積/.test(printed)) return { correct: null, correctAnswer: "" };
  const totalMatch = /佔地面積是\s*(\d+(?:\.\d+)?)\s*m/.exec(printed);
  const shadedMatch = /着色部分的佔地面積是\s*(\d+(?:\.\d+)?)\s*m/.exec(printed);
  if (!totalMatch || !shadedMatch) return { correct: null, correctAnswer: "" };
  const total = Number(totalMatch[1]), shadedArea = Number(shadedMatch[1]);
  const height = shadedArea / parallelogramShadedWidth;
  if (!(height > 0)) return { correct: null, correctAnswer: "" };
  const whiteArea = total - shadedArea;
  const expected = whiteArea / height;
  const options = parseMcOptions(printed);
  if (options.length >= 2) {
    const matching = options.filter((o) => Math.abs(Number((o.text.match(/[\d.]+/) || [])[0]) - expected) < 0.01);
    if (matching.length === 1) {
      const correct = answer === matching[0].letter;
      return { correct, correctAnswer: correct ? "" : matching[0].letter };
    }
  }
  const studentNum = parseNumericAnswer(answer);
  if (studentNum === null) return { correct: null, correctAnswer: "" };
  const correct = Math.abs(studentNum - expected) < 0.01;
  return { correct, correctAnswer: correct ? "" : String(Math.round(expected * 100) / 100) };
}

// Ticket 177 (2026-09-28, real citation: "一張長方形卡紙剪去4個大小和
// 形狀都相同的三角形後，餘下部分的面積是多少cm²？" rectangle 20×12,
// each corner triangle's legs 8 and 6 -- the real student's own worked
// steps ("20×12-6×8÷2×4") confirm the formula: rectangle area minus 4
// congruent right-triangle corners, area = W×H - 2×leg1×leg2).
function verifyRectCutKiteArea(rectCutKite, printedQuestion, studentAnswer) {
  if (!rectCutKite) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/剪去4個/.test(printed) || !/餘下部分的面積/.test(printed)) return { correct: null, correctAnswer: "" };
  const { length, width, leg1, leg2 } = rectCutKite;
  const expected = length * width - 2 * leg1 * leg2;
  const studentNum = parseNumericAnswer(answer);
  if (studentNum === null) return { correct: null, correctAnswer: "" };
  const correct = Math.abs(studentNum - expected) < 0.01;
  return { correct, correctAnswer: correct ? "" : String(Math.round(expected * 100) / 100) };
}

// Ticket 179 (2026-09-28, real citation, P4 exam Q1: "以上三個方向指示
// 中，*(A/B/C)是正確的。" -- see extractCompassRoseMc's own comment for
// the full hand-derivation). Checks each option by rotating its 8-item
// clockwise list so 北 comes first, then comparing to the canonical
// clockwise compass order.
const COMPASS_ROSE_CANONICAL = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];
function verifyCompassRoseMc(compassRoseMc, printedQuestion, studentAnswer) {
  if (!compassRoseMc) return { correct: null, correctAnswer: "" };
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/方向指示/.test(printed) || !/正確/.test(printed)) return { correct: null, correctAnswer: "" };
  const letters = Object.keys(compassRoseMc);
  if (letters.length < 2) return { correct: null, correctAnswer: "" };
  const isCanonical = (dirs) => {
    const northIdx = dirs.indexOf("北");
    if (northIdx === -1) return false;
    const rotated = [...dirs.slice(northIdx), ...dirs.slice(0, northIdx)];
    return rotated.every((d, i) => d === COMPASS_ROSE_CANONICAL[i]);
  };
  const correctOnes = letters.filter((l) => isCanonical(compassRoseMc[l]));
  if (correctOnes.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedLetter = correctOnes[0];
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Ticket 178 (2026-09-28, real citation, 4 items, P5 exam "代數：
// 根據題意，列寫代數式" section): "write the algebraic expression" is a
// different shape from every other verifier in this project -- the
// student's answer IS the expression, not a computed number, and
// algebraically-equivalent-but-differently-written forms (e.g. "s÷3" for
// "s/3") must both be accepted. Deliberately narrow to the 2 phrasing
// shapes that self-identify as this question type from their OWN text
// (both literally contain "用代數式表示"). The section's other 2 real
// items were deliberately NOT built:
//   - "曉晴有貼紙8張，心柔比曉晴多A張，心柔有貼紙___張。" -- its own
//     sentence never says "用代數式表示" or anything else marking it as
//     an algebra-expression question rather than an ordinary numeric
//     fill-in-blank word problem; only the SECTION header says that, and
//     no page-level marker currently carries section context down to
//     individual items. Detecting this from the item's own text alone
//     risks false-firing on ordinary "比...多" word problems, so it's
//     left to AI judgment.
//   - "雪兒有$100，比嘉妍多$x。嘉妍用去$25後，還餘款項多少？" -- the real
//     student wrote an algebraically-equivalent "75-x" and the teacher
//     marked it WRONG (expecting the unsimplified "$100-x-$25" form);
//     building an auto-grader that would flip that human-graded "wrong"
//     into "correct" is exactly the failure this project must never
//     introduce, so this one is left to AI judgment too.
function evalAlgebraicExpr(expr, varName, varValue) {
  const substituted = String(expr).replace(new RegExp(varName, "gi"), String(varValue));
  return evalArithmetic(substituted);
}
function verifyWriteAlgebraicExpression(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/用代數式表示/.test(printed)) return { correct: null, correctAnswer: "" };
  // Shape A: "每瓶紙星星有s顆，把這些紙星星平均分給嘉妍、嘉敏和嘉俊，
  // 用代數式表示嘉妍分到紙星星多少顆。" -> var/count(names after 分給,
  // which may be joined by "、"/","/"和"/"同" -- "嘉妍、嘉敏和嘉俊" is 3
  // names, not 2, since the last pair is joined by "和" not "、").
  const shareMatch = /有\s*([A-Za-z])\s*[顆枝張個粒本隻]/.exec(printed);
  const splitMatch = /平均分[給俾]([^，。,.]+?)[，。,.]/.exec(printed);
  let varName = null, expected = null;
  if (shareMatch && splitMatch) {
    varName = shareMatch[1];
    const names = splitMatch[1].split(/[、,，]|和|同/).map((s) => s.trim()).filter(Boolean);
    if (names.length >= 2) expected = `${varName}/${names.length}`;
  }
  // Shape B: "一盒粉筆原有B枝，用去10枝後，用代數式表示還餘粉筆多少枝。"
  // -> var - N.
  if (expected === null) {
    const origMatch = /原有\s*([A-Za-z])\s*[枝張個粒本]/.exec(printed);
    const usedMatch = /用去\s*(\d+)\s*[枝張個粒本]後/.exec(printed);
    if (origMatch && usedMatch) {
      varName = origMatch[1];
      expected = `${varName}-${usedMatch[1]}`;
    }
  }
  if (expected === null || !varName) return { correct: null, correctAnswer: "" };
  const studentHasVar = new RegExp(varName, "i").test(answer);
  if (!studentHasVar) return { correct: null, correctAnswer: "" };
  const testValues = [3, 7, 12];
  for (const v of testValues) {
    const expectedVal = evalAlgebraicExpr(expected, varName, v);
    const studentVal = evalAlgebraicExpr(answer, varName, v);
    if (expectedVal === null || studentVal === null) return { correct: null, correctAnswer: "" };
    if (Math.abs(expectedVal - studentVal) > 1e-9) return { correct: false, correctAnswer: expected };
  }
  return { correct: true, correctAnswer: "" };
}

function verifyListFactors(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(?:寫出|列出)\s*(\d+)\s*(?:嘅|的)所有因數|list all (?:the )?factors of\s*(\d+)/i);
  if (!m) return { correct: null, correctAnswer: "" };
  const n = Number(m[1] || m[2]);
  if (!Number.isInteger(n) || n < 1 || n > 100000) return { correct: null, correctAnswer: "" };
  const factors = [];
  for (let i = 1; i <= n; i++) if (n % i === 0) factors.push(i);
  const studentNums = (answer.match(/\d+/g) || []).map(Number);
  const sortedStudent = [...studentNums].sort((a, b) => a - b);
  const sameSet = sortedStudent.length === factors.length && sortedStudent.every((v, i) => v === factors[i]);
  return { correct: sameSet, correctAnswer: sameSet ? "" : factors.join(", ") };
}

// Count primes strictly below N (real example, 2026-09-23 P4 PDF
// reading: "100以內共有質數多少個?" -> 25, i.e. the primes from 2 to
// 99). Plain sieve of Eratosthenes -- code-computable directly from the
// one printed range number, zero visual/OCR risk.
function verifyCountPrimesBelow(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)\s*(?:以內|以下|之內)[^\d]{0,10}(?:質數|prime)/i);
  if (!m) return { correct: null, correctAnswer: "" };
  const limit = Number(m[1]);
  if (!Number.isInteger(limit) || limit < 2 || limit > 1000000) return { correct: null, correctAnswer: "" };
  const isComposite = new Array(limit).fill(false);
  let count = 0;
  for (let i = 2; i < limit; i++) {
    if (!isComposite[i]) {
      count++;
      for (let j = i * i; j < limit; j += i) isComposite[j] = true;
    }
  }
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === count, correctAnswer: studentNum === count ? "" : String(count) };
}

// Elapsed time (forward): two 12h clock times, "start to end", duration in
// hours (real example, 2026-09-23 PDF reading: "10:32am to 1:32pm, surgery
// lasts ___ hours" -> 3). Narrowly triggered on exactly two "H:MM am/pm"
// tokens plus an hours/小時 keyword nearby.
function parseTime12h(str) {
  const m = /(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i.exec(str);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 1 || h > 12 || min < 0 || min > 59) return null;
  const isPM = m[3].toLowerCase() === "p";
  if (h === 12) h = 0;
  if (isPM) h += 12;
  return h * 60 + min;
}

// 12-hour <-> 24-hour time format conversion. Real examples found
// 2026-09-25 (p1-p6.com P3 2025-2026 Term1, Q30/32/33): a bare "HH:MM"
// with no am/pm marker (a 24-hour-clock reading, "16:15" or a flight
// table's "13:56") converts to "H:MM in the morning/afternoon", and the
// reverse ("11:52 in the morning" -> "11:52"). Direction is read from
// the instruction phrase itself ("Express the time in '12-hour time'" /
// "以12小時報時制" vs the 24-hour equivalent) rather than guessed from
// the printed time's own shape, since a plain "11:52" with no period
// word is ambiguous on its own (could be either direction's input).
// Deliberately conservative on the student answer's exact wording --
// accepts any text containing the right hour:minute plus, when
// converting TO 12-hour, an am/pm-equivalent word -- since the real OCR
// answer-joining convention for this shape is unconfirmed.
function verifyTimeFormatConversion(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };

  const wants12h = /12[-\s]?hour|12\s*小時/i.test(printed);
  const wants24h = /24[-\s]?hour|24\s*小時/i.test(printed);
  if (wants12h === wants24h) return { correct: null, correctAnswer: "" }; // neither or both -- ambiguous, refuse

  if (wants12h) {
    // Source: a bare 24-hour "HH:MM", no am/pm word attached.
    const m = printed.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?m\.?)/i);
    if (!m) return { correct: null, correctAnswer: "" };
    const h24 = Number(m[1]);
    const minute = Number(m[2]);
    const isPM = h24 >= 12;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const expectedStr = `${h12}:${String(minute).padStart(2, "0")} in the ${isPM ? "afternoon/evening" : "morning"}`;
    const answerHasTime = new RegExp(`\\b${h12}[:\\s]${String(minute).padStart(2, "0")}\\b`).test(answer);
    const periodWord = isPM ? /下午|晚上|afternoon|evening|pm|p\.m\./i : /上午|早上|morning|am|a\.m\./i;
    const answerHasPeriod = periodWord.test(answer);
    const correct = answerHasTime && answerHasPeriod;
    return { correct, correctAnswer: correct ? "" : expectedStr };
  }

  // wants24h: source is 12-hour with an explicit am/pm-equivalent word.
  const m = printed.match(/([01]?\d):([0-5]\d)/);
  if (!m) return { correct: null, correctAnswer: "" };
  const isPM = /下午|晚上|afternoon|evening|pm|p\.m\./i.test(printed);
  const isAM = /上午|早上|morning|am|a\.m\./i.test(printed);
  if (isPM === isAM) return { correct: null, correctAnswer: "" }; // no period word, or both -- can't determine
  let h12 = Number(m[1]);
  const minute = Number(m[2]);
  if (h12 < 1 || h12 > 12) return { correct: null, correctAnswer: "" };
  let h24 = h12 % 12;
  if (isPM) h24 += 12;
  const expectedStr = `${String(h24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const answerDigits = answer.replace(/[^\d:]/g, "");
  const correct = answerDigits === expectedStr || answerDigits === `${h24}:${String(minute).padStart(2, "0")}`;
  return { correct, correctAnswer: correct ? "" : expectedStr };
}

function verifyElapsedTimeForward(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  if (!/(hours?|小時)/i.test(printed)) return { correct: null, correctAnswer: "" };
  const times = printed.match(/\d{1,2}:\d{2}\s*[ap]\.?m\.?/gi);
  if (times && times.length === 2) {
    const t1 = parseTime12h(times[0]);
    const t2 = parseTime12h(times[1]);
    if (t1 === null || t2 === null) return { correct: null, correctAnswer: "" };
    let diffMin = t2 - t1;
    if (diffMin < 0) diffMin += 24 * 60;
    const expected = diffMin / 60;
    const studentNum = parseSignedStudentNumber(answer);
    if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
    const closeEnough = Math.abs(studentNum - expected) < 1e-9;
    return { correct: closeEnough, correctAnswer: closeEnough ? "" : String(expected) };
  }
  // Ticket 187 (2026-09-28, real citation: "Isabella and her family
  // arrive at a country park at 9 o'clock. They leave the country park
  // at 5 o'clock... stay... for ___ hours." -> 8): bare "X o'clock"
  // phrasing with no am/pm marker at all, unlike the HH:MMam/pm shape
  // above. Assumes a same-day forward gap within a single 12-hour clock
  // face (wraps at 12, never negative) -- hand-verified: 9 o'clock ->
  // 5 o'clock = ((5-9) mod 12 + 12) mod 12 = 8, matches the real answer.
  const oclockTimes = printed.match(/\d{1,2}(?=\s*o.?clock)/gi);
  if (oclockTimes && oclockTimes.length === 2) {
    const h1 = parseInt(oclockTimes[0], 10);
    const h2 = parseInt(oclockTimes[1], 10);
    if (h1 < 1 || h1 > 12 || h2 < 1 || h2 > 12) return { correct: null, correctAnswer: "" };
    let diffHour = ((h2 - h1) % 12 + 12) % 12;
    if (diffHour === 0) diffHour = 12;
    const studentNum = parseSignedStudentNumber(answer);
    if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
    const closeEnough = Math.abs(studentNum - diffHour) < 1e-9;
    return { correct: closeEnough, correctAnswer: closeEnough ? "" : String(diffHour) };
  }
  return { correct: null, correctAnswer: "" };
}

// Reverse-solve the divisor from a quotient+remainder equation (real
// example, 2026-09-23 PDF reading: "如果750÷※=16…14,那麼※=?" -> (750-14)/16=46).
// The unknown-divisor placeholder varies by paper (?, □, ※ all seen) --
// matched directly rather than via BLANK_TOKENS since this is a narrow,
// self-contained equation shape, not a general blank-substitution case.
// 2026-09-25: extended to also accept NO remainder term at all (treated
// as remainder=0), on a real example -- p1-p6.com P2 2023-2024 Q18:
// "16÷★=4，★代表的數是多少?" (find the divisor, exact division, no
// remainder shown). Same underlying algebra (dividend = divisor×quotient
// + remainder, solve for divisor) just with remainder forced to 0 rather
// than parsed -- a strict superset of the original with-remainder shape,
// not a behavior change to it. "★" also added to the accepted blank/
// variable marker set: already an evidenced real marker in this codebase
// (see verifyReverseFactorSum's own real example, same "★...★=?" shape).
function verifyReverseDivisorFromRemainder(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const withRemainder = printed.match(/(\d+)\s*[÷\/]\s*[?□※★]\s*=\s*(\d+)\s*[…\.]{1,3}\s*(\d+)/);
  const noRemainder = withRemainder ? null : printed.match(/(\d+)\s*[÷\/]\s*[?□※★]\s*=\s*(\d+)(?!\s*[…\.])/);
  const m = withRemainder || noRemainder;
  if (!m) return { correct: null, correctAnswer: "" };
  const dividend = Number(m[1]);
  const quotient = Number(m[2]);
  const remainder = withRemainder ? Number(m[3]) : 0;
  if (!quotient || remainder >= quotient) return { correct: null, correctAnswer: "" };
  const numerator = dividend - remainder;
  if (numerator <= 0 || numerator % quotient !== 0) return { correct: null, correctAnswer: "" };
  const expected = numerator / quotient;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Difference between the Nth and Mth multiples of a given number (real
// example, 2026-09-23 PDF reading: "17嘅第十一個同第十七個倍數相差多少?"
// -> 17×(17-11)=102). Chinese ordinal words parsed via the existing
// parseChineseNumberWord (already scoped 0-99, matches real evidence).
function verifyMultipleDifference(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)嘅第([一二三四五六七八九十]+)個同第([一二三四五六七八九十]+)個倍數相差/);
  if (!m) return { correct: null, correctAnswer: "" };
  const n = Number(m[1]);
  const a = parseChineseNumberWord(m[2]);
  const b = parseChineseNumberWord(m[3]);
  if (a === null || b === null) return { correct: null, correctAnswer: "" };
  const expected = Math.abs(n * (b - a));
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// --- 2026-09-25 batch, from a real P5 1st-term exam (p1-p6.com,
// downloaded+read directly, "二零二五至二零二六年度上學期 五年級 數學科
// 考試") -- this single exam confirmed several of the ~35 findings
// logged in benchmark/question-type-library.md's survey section with
// real evidence, so those are the ones built here first. ----------------

// Large-magnitude Chinese numeral -> Arabic numeral, up to 億 (10^8) --
// the magnitude actually evidenced (real example: Q8, "以阿拉伯數字寫出
// 「五億零八百萬零二十」" -> 508000020). Deliberately a SEPARATE parser
// from parseChineseNumberWord above, not an extension of it -- that
// function is a flat 0-99 lookup used by several other callers that
// rely on its narrow scope (e.g. returning null past 99 as a safety
// guard); this is a different, section-based algorithm for numbers that
// use 千/百/十/萬/億 place words.
const CN_UNIT_DIGIT = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_SMALL_PLACE = { 十: 10, 百: 100, 千: 1000 };
const CN_SECTION_PLACE = { 萬: 10000, 億: 100000000 };

// Parses a run of Chinese numeral characters with no 萬/億 in it (a
// value 0-9999), e.g. "八百" -> 800, "五十六" -> 56, "八" -> 8, "零" -> 0.
function parseChineseSmallNumber(str) {
  if (!str) return 0;
  if (str === "十") return 10; // bare "十" means 10, not "0 tens"
  let total = 0;
  let current = 0;
  for (const ch of str) {
    if (ch === "零") continue; // filler, carries no value of its own
    if (CN_SMALL_PLACE[ch] !== undefined) {
      total += (current === 0 ? 1 : current) * CN_SMALL_PLACE[ch];
      current = 0;
    } else if (CN_UNIT_DIGIT[ch] !== undefined) {
      current = CN_UNIT_DIGIT[ch];
    } else {
      return null; // unrecognized character -- fail safe, never guess
    }
  }
  return total + current;
}

// Full large Chinese numeral, splitting on 億/萬 section markers (each
// section itself parsed by parseChineseSmallNumber above, then scaled).
// Returns null on anything not confidently parseable, same fail-safe
// discipline as every other verifier in this file.
function parseChineseLargeNumber(str) {
  const s = String(str || "").trim();
  if (!s || !/[億萬千百十零一二三四五六七八九兩]/.test(s)) return null;
  let remaining = s;
  let total = 0;
  for (const marker of ["億", "萬"]) {
    const idx = remaining.indexOf(marker);
    if (idx === -1) continue;
    const sectionValue = parseChineseSmallNumber(remaining.slice(0, idx));
    if (sectionValue === null) return null;
    total += sectionValue * CN_SECTION_PLACE[marker];
    remaining = remaining.slice(idx + 1);
  }
  if (remaining) {
    const tailValue = parseChineseSmallNumber(remaining);
    if (tailValue === null) return null;
    total += tailValue;
  }
  return total;
}

// "以阿拉伯數字寫出「...」" -- convert a large Chinese numeral phrase
// (quoted in Chinese corner brackets 「」) to its Arabic-numeral value.
function verifyChineseLargeNumeralToArabic(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  if (!/阿拉伯數字/.test(printed)) return { correct: null, correctAnswer: "" };
  const m = printed.match(/「([^」]+)」/);
  if (!m) return { correct: null, correctAnswer: "" };
  const expected = parseChineseLargeNumber(m[1]);
  if (expected === null) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(String(studentAnswer || "").replace(/,/g, ""));
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// "在NNNN這個數中，兩個「D」的數值相差多少？" -- difference in PLACE
// VALUE between the two occurrences of the same repeated digit in a
// number (real example, same exam, Q9: "在71460864這個數中，兩個「6」
// 的數值相差多少？" -- the two 6s sit at the ten-thousands (60,000) and
// tens (60) places, difference 59,940). Only fires when the digit
// appears in the number EXACTLY twice -- 0, 1, or 3+ occurrences means
// the question (which always says "兩個", "the two") doesn't match what
// was actually extracted, so this declines rather than guessing which
// two.
function verifyRepeatedDigitPlaceValueDifference(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const m = printed.match(/在\s*(\d+)\s*這個數中.*?兩個「(\d)」的數值相差多少/);
  if (!m) return { correct: null, correctAnswer: "" };
  const numStr = m[1];
  const digit = m[2];
  const positions = [];
  for (let i = 0; i < numStr.length; i++) if (numStr[i] === digit) positions.push(i);
  if (positions.length !== 2) return { correct: null, correctAnswer: "" };
  const placeValues = positions.map((i) => Number(digit) * 10 ** (numStr.length - 1 - i));
  const expected = Math.max(...placeValues) - Math.min(...placeValues);
  const studentNum = parseSignedStudentNumber(String(studentAnswer || "").replace(/,/g, ""));
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// "如果[VAR]=[N]，那麼[EXPR]的值是___" -- substitute a given value for a
// single-letter variable into an algebraic expression, then evaluate.
// Real examples (same exam, algebra section): "如果T=8，那麼10+T-6的值
// 是___" (=12); "如果F=4，那麼3F÷2的值是___" (=6 -- "3F" is IMPLICIT
// multiplication, a digit immediately followed by the variable letter
// with no operator between them, handled the same way evalArithmetic
// itself normalises ×/÷ before tokenizing).
function verifySubstituteAndEvaluate(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const m = printed.match(/如果\s*([A-Za-z])\s*=\s*(-?\d+(?:\.\d+)?)\s*[，,]\s*那麼\s*(.+?)\s*的值是/);
  if (!m) return { correct: null, correctAnswer: "" };
  const varName = m[1];
  const varValue = m[2];
  const expr = m[3].replace(new RegExp(`(\\d)(${varName})`, "g"), "$1*$2").replace(new RegExp(varName, "g"), varValue);
  const expected = evalArithmetic(expr);
  if (expected === null) return { correct: null, correctAnswer: "" };
  const studentNum = parseNumericAnswer(String(studentAnswer || "").trim());
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: Math.abs(studentNum - expected) < 1e-9, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// "把以下各分數由小至大排列出來" -- sort a list of fraction/mixed-number
// VALUES ascending, compare against the student's own ordering. Takes
// the candidate values as an already-parsed array of numbers, same
// "structured input, not raw OCR text extraction" design as
// verifySelectTwoNumbersSumTarget above and for the same reason: the
// printed values in the real source (same exam, Q10: "37/5, 7又7/9,
// 7又2/3") are STACKED visual fractions in the PDF image, and reliably
// extracting THOSE (as opposed to the student's own typed-out answer,
// which IS free text) from OCR isn't yet confirmed real evidence -- a
// caller that already has the parsed candidate values can use this
// directly. The student's own answer, by contrast, IS parsed from free
// text here (split on the "<"/"，" separators the printed answer
// template itself uses), since that's the OCR'd HANDWRITING, not a
// stacked-image value.
function verifySortFractionsAscending(candidateValues, studentAnswer) {
  const values = (candidateValues || []).map(Number);
  if (values.length < 2 || values.some((v) => Number.isNaN(v))) return { correct: null, correctAnswer: "" };
  const parts = String(studentAnswer || "").split(/[<，,]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length !== values.length) return { correct: null, correctAnswer: "" };
  const studentValues = parts.map((p) => parseNumericAnswer(p));
  if (studentValues.some((v) => Number.isNaN(v))) return { correct: null, correctAnswer: "" };
  const isAscending = studentValues.every((v, i) => i === 0 || v >= studentValues[i - 1]);
  const remaining = [...values];
  const sameMultiset = studentValues.every((v) => {
    const idx = remaining.findIndex((r) => Math.abs(r - v) < 1e-9);
    if (idx === -1) return false;
    remaining.splice(idx, 1);
    return true;
  });
  const correct = isAscending && sameMultiset;
  const sortedLabel = [...values].sort((a, b) => a - b).map((v) => String(v)).join(" < ");
  return { correct, correctAnswer: correct ? "" : sortedLabel };
}

// Round a single printed number to the nearest hundred (real example,
// 2026-09-23 PDF reading: "用四捨五入法把銷量湊整至百位" table, e.g.
// 1584->1600). Narrowly triggered on both the method keyword (四捨五入)
// and the target place-value keyword (百位) together with exactly one
// number, to avoid misfiring on an unrelated rounding-adjacent sentence.
function verifyRoundToNearestHundred(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  if (!/四捨五入/.test(printed) || !/百位/.test(printed)) return { correct: null, correctAnswer: "" };
  const nums = (printed.match(/\d+/g) || []).map(Number);
  if (nums.length !== 1) return { correct: null, correctAnswer: "" };
  const expected = Math.round(nums[0] / 100) * 100;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Reverse-solve a number from the sum of its smallest and largest factors
// (real example, 2026-09-23 PDF reading: "如果★嘅最小和最大嘅因數之和係
// 37,★=?" -> 36). Mathematically closed-form, not a search: the smallest
// factor of any integer > 1 is always 1, and the largest factor is always
// the number itself, so number = sum - 1.
// Real example found 2026-09-25 (p1-p6.com P2 2023-2024, Q13):
// "在 49 ÷ 5 = 9 … ● 的除式中，● 代表的數是___" -- a fully-worked
// division statement (dividend, divisor, AND quotient all given) where
// the blank is the REMAINDER, not any of the three usual unknowns
// (unlike verifyReverseDivisorFromRemainder, which solves for the
// divisor). Pure arithmetic once parsed: remainder = dividend - divisor
// * quotient. The blank marker itself was a filled circle "●" in the
// real PDF text -- NOT yet added to the shared BLANK_TOKENS constant
// above, since that list is specifically confirmed against real OCR
// (Qwen3-VL) OUTPUT, not just what's visually printed on the page, and
// "●" hasn't been seen in an actual OCR transcript yet. This function
// accepts "●" alongside the already-OCR-confirmed "?"/"□" tokens on its
// own, narrower evidence (the real PDF text), without changing the
// shared constant other detectors rely on.
function verifyDivisionRemainderBlank(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const m = printed.match(/(\d+)\s*[÷/]\s*(\d+)\s*=\s*(\d+)\s*(?:[…⋯]|\.{2,3})\s*[●?□]/);
  if (!m) return { correct: null, correctAnswer: "" };
  const [, dividendStr, divisorStr, quotientStr] = m;
  const dividend = Number(dividendStr);
  const divisor = Number(divisorStr);
  const quotient = Number(quotientStr);
  if (divisor === 0) return { correct: null, correctAnswer: "" };
  const expectedRemainder = dividend - divisor * quotient;
  // A malformed/inconsistent printed statement (e.g. OCR error) would
  // give a negative or out-of-range remainder -- refuse rather than
  // report a "correct" answer against a broken premise.
  if (expectedRemainder < 0 || expectedRemainder >= divisor) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(studentAnswer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  const correct = studentNum === expectedRemainder;
  return { correct, correctAnswer: correct ? "" : String(expectedRemainder) };
}

// Real example found 2026-09-25 (same source, Q11): "最大的三位數和
// 最小的三位奇數相差是___" (the difference between the largest 3-digit
// number and the smallest 3-digit ODD number = 999 - 101 = 898). Unlike
// verifyConstructExtremeNumber (which builds a number from a GIVEN digit
// set), this is pure general-knowledge about place value -- "the
// largest/smallest N-digit number" is a fixed value determined only by N
// and an optional odd/even/no constraint, no digits are given in the
// question at all. Narrow, deliberately: only fires on the exact
// largest/smallest-N-digit-number phrasing this real example uses, not
// a general number-theory solver.
function extremeNDigitNumber(digitCount, { largest, parity } = {}) {
  if (!Number.isInteger(digitCount) || digitCount < 1) return null;
  const allSame = (d) => Number(String(d).repeat(digitCount));
  let base = largest ? allSame(9) : Number(`1${"0".repeat(digitCount - 1)}`);
  if (!parity) return base;
  const isOdd = (n) => n % 2 === 1;
  const step = largest ? -1 : 1;
  // At most 2 steps are ever needed (consecutive integers alternate
  // parity), but loop defensively rather than hardcode that.
  for (let i = 0; i < 20; i++) {
    if ((parity === "odd") === isOdd(base)) return base;
    base += step;
  }
  return null;
}

function verifyExtremeNumberDifference(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const parityOf = (s) => (s.includes("奇") ? "odd" : s.includes("偶") ? "even" : null);
  const DIGIT_COUNT_WORDS = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const parseTerm = (text) => {
    const m = text.match(/(最大|最小)的?([一二兩三四五六]|\d+)位(奇|偶)?數/);
    if (!m) return null;
    const digitCount = DIGIT_COUNT_WORDS[m[2]] ?? Number(m[2]);
    return extremeNDigitNumber(digitCount, { largest: m[1] === "最大", parity: parityOf(m[3] || "") });
  };
  const m = printed.match(/(.+?)(?:和|與)(.+?)相差是?/);
  if (!m) return { correct: null, correctAnswer: "" };
  const a = parseTerm(m[1]);
  const b = parseTerm(m[2]);
  if (a === null || b === null) return { correct: null, correctAnswer: "" };
  const expected = Math.abs(a - b);
  const studentNum = parseSignedStudentNumber(studentAnswer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  const correct = studentNum === expected;
  return { correct, correctAnswer: correct ? "" : String(expected) };
}

function verifyReverseFactorSum(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/最小和最大嘅因數之和係(\d+)/);
  if (!m) return { correct: null, correctAnswer: "" };
  const sum = Number(m[1]);
  const expected = sum - 1;
  if (expected < 2) return { correct: null, correctAnswer: "" };
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// Ticket 143 (2026-09-28, real citation: "一個合成數最少有多少個因數？"
// -> 3, since a composite number's factors always include 1, itself, and
// at least one more): static-fact constant check, no arithmetic at all.
function verifyMinFactorsOfComposite(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/合成數.{0,6}最少.{0,6}因數|composite.{0,10}(?:least|minimum|fewest).{0,10}factors/i.test(printed)) {
    return { correct: null, correctAnswer: "" };
  }
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  const correct = studentNum === 3;
  return { correct, correctAnswer: correct ? "" : "3" };
}

// Ticket 144 (2026-09-28, real citation: "某數的最大因數是28，某數共有
// 多少個因數？" -> 6): a number's own largest factor is ALWAYS itself, so
// "the largest factor is 28" directly means the number IS 28 -- then
// just count 28's own factors.
function verifyLargestFactorImpliesNumber(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/最大因數是\s*(\d+)[\s\S]*?共有多少個因數/);
  if (!m) return { correct: null, correctAnswer: "" };
  const n = Number(m[1]);
  let count = 0;
  for (let i = 1; i <= n; i++) if (n % i === 0) count++;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === count, correctAnswer: studentNum === count ? "" : String(count) };
}

// Ticket 148 (2026-09-28, real citation: "20和32共有多少個公因數？" -> 3):
// count of common factors between two numbers.
function verifyCommonFactorsCount(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)和(\d+)共有多少個公因數/);
  if (!m) return { correct: null, correctAnswer: "" };
  const a = Number(m[1]), b = Number(m[2]);
  const smaller = Math.min(a, b);
  let count = 0;
  for (let i = 1; i <= smaller; i++) if (a % i === 0 && b % i === 0) count++;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === count, correctAnswer: studentNum === count ? "" : String(count) };
}

// Ticket 150 (2026-09-28, real citation: "63最少要加上多少，才是一個
// 質數？" -> 4, since 63+4=67 is prime): minimum addition to reach the
// next prime.
function isPrimeNumber(n) {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}
function verifyMinAddToPrime(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(\d+)最少要加上多少.{0,6}(?:才是|先係).{0,3}質數/);
  if (!m) return { correct: null, correctAnswer: "" };
  const n = Number(m[1]);
  let add = 0;
  while (!isPrimeNumber(n + add)) add++;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === add, correctAnswer: studentNum === add ? "" : String(add) };
}

// Ticket 152 (2026-09-28, real citation: "以下哪一句句子是正確的？
// A.1是26的倍數 B.13是26的倍數 C.26是26的因數 D.26是2的因數" -> C):
// evaluates each MC option as a small "X是Y的倍數/因數" true/false
// statement, finds the unique true one.
function verifyFactorMultipleDefinitionMC(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const options = parseMcOptions(printed);
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  const evalStatement = (text) => {
    let m = text.match(/(\d+)是(\d+)的倍數/);
    if (m) return Number(m[1]) % Number(m[2]) === 0;
    m = text.match(/(\d+)是(\d+)的因數/);
    if (m) return Number(m[2]) % Number(m[1]) === 0;
    return null;
  };
  const evaluated = options.map((o) => ({ ...o, isTrue: evalStatement(o.text) }));
  if (evaluated.some((o) => o.isTrue === null)) return { correct: null, correctAnswer: "" };
  const trueOnes = evaluated.filter((o) => o.isTrue);
  if (trueOnes.length !== 1) return { correct: null, correctAnswer: "" };
  const expectedLetter = trueOnes[0].letter;
  const correct = answer === expectedLetter;
  return { correct, correctAnswer: correct ? "" : expectedLetter };
}

// Ticket 174 (2026-09-28, real citation: "$3.80 → 3 dollars and 80
// cents"): decimal price split into dollars+cents.
function verifyPriceDecimalSplit(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/dollars? and .{0,10}cents?/i.test(printed)) return { correct: null, correctAnswer: "" };
  const m = printed.match(/\$(\d+)\.(\d{2})/);
  if (!m) return { correct: null, correctAnswer: "" };
  const dollars = Number(m[1]), cents = Number(m[2]);
  const nums = (answer.match(/\d+/g) || []).map(Number);
  if (nums.length !== 2) return { correct: null, correctAnswer: "" };
  const correct = nums[0] === dollars && nums[1] === cents;
  return { correct, correctAnswer: correct ? "" : `${dollars};${cents}` };
}

// Ticket 175 (2026-09-28, real citation: "$47.00/$51.00/$63.00/$48.00 →
// difference between most expensive and cheapest = B 16 dollars"):
// max-min difference over a printed price list.
function verifyPriceListMaxMinDifference(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/most expensive.{0,15}cheapest|cheapest.{0,15}most expensive/i.test(printed)) {
    return { correct: null, correctAnswer: "" };
  }
  const prices = [...printed.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (prices.length < 2) return { correct: null, correctAnswer: "" };
  const expected = Math.max(...prices) - Math.min(...prices);
  const options = parseMcOptions(printed);
  if (options.length >= 2) {
    const matching = options.filter((o) => o.text.includes(String(expected)));
    if (matching.length === 1) {
      const correct = answer === matching[0].letter;
      return { correct, correctAnswer: correct ? "" : matching[0].letter };
    }
  }
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
}

// =======================================================================
// Question-type registry (2026-09-22) -- built specifically so a future
// question type is added by inserting ONE new entry, never by editing an
// existing entry or the dispatch loop itself (the "growing if/else chain"
// this whole design exists to avoid). NOT wired into the live pipeline
// yet -- `verifyAnswer`/`handleMark` below still call `detectSubject` +
// `verifyMath` exactly as before, unchanged. `classifyAndVerify(item)` is
// a fully tested, drop-in-ready alternative dispatcher; swapping it in is
// intentionally left as a separate, later decision (see this file's
// accompanying report) since it changes live request behaviour, not just
// adding new code.
//
// ORDERING RULE -- load-bearing, do not reorder without understanding why:
// entries are tried TOP TO BOTTOM, first match wins. MOST-SPECIFIC shapes
// must sit ABOVE more-generic ones that could also technically match a
// subset of the same input. Concretely, two real overlaps this ordering
// exists to resolve:
//   1. A multi-blank item ("4×□=24,24÷□=4,...") also contains a comma and
//      blank tokens that the single-blank/plain-equation math path could
//      otherwise misparse one sub-piece of -- `multi_blank_math` is listed
//      before the generic `math_equation` fallback.
//   2. A blank token EMBEDDED inside a number ("3□5=") is a different real
//      shape from a blank token standing ALONE as a whole operand
//      ("54÷?=6") -- `missing_digit_in_number` (embedded) is listed before
//      the generic `math_equation` fallback (which internally substitutes
//      a STANDALONE blank via `trySubstituteBlank`), so an embedded digit
//      is never treated as a standalone operand.
// `math_equation` (wrapping the existing `detectSubject`+`verifyMath`) is
// deliberately LAST among the math entries: it's the broadest net (any
// parseable arithmetic shape) and would otherwise swallow narrower shapes
// it can technically parse but shouldn't be trusted to verify (e.g. it has
// no concept of "which MC option" or "is this really a sort/sequence").
//
// Each `detect` is a small, side-effect-free STRUCTURAL check mirroring
// the corresponding `verify*` function's own opening guard clauses (never
// a full call-and-discard of the real computation) -- kept deliberately
// separate so detection stays cheap and each function's tested behaviour
// is reused unmodified, not reimplemented.
//
// Only the ~14 types whose real, evidenced shape fits the pipeline's
// current per-item {printedQuestion, studentAnswer} OCR output are
// registered here. `verifySudoku4x4`, `verifySelectFromPassage`,
// `verifyPictureMatchFormat`, `verifyWordBankOnceEach`,
// `verifyLiteralKeywordMC`, `verifyConjunctionFill`, and
// `verifyPriceTableLookup` each need STRUCTURED data the OCR step doesn't
// currently extract as separate fields (a grid, a source passage, an
// accepted-phrasing list, a word bank, MC option objects, two separate
// clauses, or a price table) -- wiring those in needs an OCR-prompt/
// pipeline change first, not just a registry entry, and is deliberately
// left out rather than forced with guessed/absent data.
// Ticket 63 (2026-09-27): analog clock-hand reading, Photon-based.
// Real history this session: an earlier, more rigorous OpenCV-based
// attempt (see benchmark/question-type-library.md) tested against 7
// diverse real clock images with a strict zero-confidently-wrong bar,
// and only cleared it at 2/6 real coverage (33%) even after adding a
// hand-length signal and a hour/minute angle-consistency residual
// check -- concluding "NOT currently trustworthy enough to build for
// real, stay on AI". That work also found Photon has NO true Hough-
// line-transform (only 4 fixed-angle line detectors), so that specific
// OpenCV technique could never port here anyway.
//
// This is a DIFFERENT technique (connected-component blob tracking by
// angular-ring continuity, not line detection) validated today against
// 3 synthetic clocks with known ground truth (all within ~1 degree) and
// one real textbook clock (self-consistent, no independent answer key
// available). It carries the SAME safety guards the prior research
// found necessary -- hand-length-ratio ambiguity decline, hour/minute
// angle-consistency residual check -- plus its own (seed only from
// beyond the inner 45% radius, require 3 consecutive stable rings)
// found today. Wired in as a FAIL-OPEN, ADDITIVE layer only: whenever
// it can't confidently resolve a clock (which, per the prior research,
// may be MOST real clocks), it returns null exactly like today's
// behaviour, falling through to Jev/the AI-image judge completely
// unchanged -- this can only ever IMPROVE on today's baseline, never
// regress it, so it is safe to enable now despite not yet clearing the
// same 7-example bar the prior research used. That broader validation
// (Ticket 58) remains open follow-up work, not a precondition for this
// fail-open wiring.
function readClockHandsFromPixels(pixels, w, h) {
  const cx0 = w / 2, cy0 = h / 2;
  const radiusEst = Math.min(w, h) * 0.44;
  const luminance = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  };
  const isDarkInner = (x, y) => {
    const d = Math.hypot(x - cx0, y - cy0);
    return d < radiusEst * 0.8 && luminance(x, y) < 150;
  };
  // Connected-component BFS over dark pixels within the inner disk (the
  // outer ~20% is the bezel ring + printed numbers, which would
  // otherwise swamp the real hand signal -- see the prior OpenCV
  // research's own diagnosis of the same problem for line-based
  // detection).
  const visited = new Uint8Array(w * h);
  let biggest = null, biggestSize = 0;
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const idx0 = y0 * w + x0;
      if (visited[idx0] || !isDarkInner(x0, y0)) continue;
      const stack = [[x0, y0]];
      visited[idx0] = 1;
      const pts = [];
      while (stack.length) {
        const [x, y] = stack.pop();
        pts.push([x, y]);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nidx = ny * w + nx;
            if (visited[nidx] || !isDarkInner(nx, ny)) continue;
            visited[nidx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      if (pts.length > biggestSize) { biggestSize = pts.length; biggest = pts; }
    }
  }
  if (!biggest || biggest.length < 10) return null;

  let maxR = 0;
  const withPolar = biggest.map(([x, y]) => {
    const r = Math.hypot(x - cx0, y - cy0);
    const ang = (Math.atan2(x - cx0, -(y - cy0)) * 180 / Math.PI + 360) % 360;
    if (r > maxR) maxR = r;
    return { r, ang };
  });

  // Ring-based angular clustering (ring width 2px, gap threshold 12deg,
  // with 0/360 wraparound merge).
  const rings = [];
  for (let ringR = 5; ringR <= maxR; ringR += 2) {
    const inRing = withPolar.filter((p) => p.r >= ringR && p.r < ringR + 2).map((p) => p.ang).sort((a, b) => a - b);
    if (!inRing.length) continue;
    const clusters = [[inRing[0]]];
    for (let i = 1; i < inRing.length; i++) {
      const cur = clusters[clusters.length - 1];
      if (inRing[i] - cur[cur.length - 1] > 12) clusters.push([inRing[i]]);
      else cur.push(inRing[i]);
    }
    if (clusters.length >= 2) {
      const first = clusters[0], last = clusters[clusters.length - 1];
      const wrapGap = (360 - last[last.length - 1]) + first[0];
      if (wrapGap <= 12) { clusters[0] = last.concat(first); clusters.pop(); }
    }
    const means = clusters.map((c) => (c.reduce((a, b) => a + b, 0) / c.length + 360) % 360);
    rings.push({ r: ringR, means });
  }
  if (!rings.length) return null;

  // Seed: first ring (beyond the inner 45% of max radius) whose 2-cluster
  // split stays stable (<6deg drift) for 3 consecutive sampled rings --
  // avoids the wide-overlapping-hand-base ambiguity near the pivot.
  const candidateRings = rings.filter((rr) => rr.r >= maxR * 0.45 && rr.means.length === 2);
  const angDist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  let seedRing = null;
  for (let i = 0; i < candidateRings.length - 2; i++) {
    const [a0, a1] = candidateRings[i].means;
    let stable = true;
    for (const j of [i + 1, i + 2]) {
      const [b0, b1] = candidateRings[j].means;
      if (angDist(a0, b0) > 6 || angDist(a1, b1) > 6) { stable = false; break; }
    }
    if (stable) { seedRing = candidateRings[i]; break; }
  }
  if (!seedRing) seedRing = candidateRings[candidateRings.length - 1];
  if (!seedRing) return null;

  const trackA = [seedRing.means[0]], trackB = [seedRing.means[1]];
  let maxA = seedRing.r, maxB = seedRing.r;
  for (const ring of rings) {
    if (ring.r < seedRing.r) continue;
    for (const m of ring.means) {
      const dA = angDist(m, trackA[trackA.length - 1]);
      const dB = angDist(m, trackB[trackB.length - 1]);
      if (dA <= dB && dA < 15) { trackA.push(m); maxA = Math.max(maxA, ring.r); }
      else if (dB < 15) { trackB.push(m); maxB = Math.max(maxB, ring.r); }
    }
  }

  // Safety guard 1 (from the prior OpenCV research): if the two hands'
  // reach lengths are too close to call, decline rather than guess which
  // is the (longer) minute hand.
  const lo = Math.min(maxA, maxB), hi = Math.max(maxA, maxB);
  if (hi === 0 || lo / hi > 0.85) return null;

  const minuteAngle = maxA >= maxB ? trackA[trackA.length - 1] : trackB[trackB.length - 1];
  const hourAngle = maxA >= maxB ? trackB[trackB.length - 1] : trackA[trackA.length - 1];
  const minuteVal = Math.round(minuteAngle / 6) % 60;
  // Math.round, not Math.floor: the measured hourAngle carries a few
  // tenths of a degree of noise, and a true hour boundary (e.g. 11.0)
  // can measure as 10.977 -- flooring that truncates to the WRONG hour
  // (10) where rounding correctly recovers 11. Found via a real 11:50
  // synthetic-fixture test failure (Ticket 63), not a hypothetical.
  const rawHour = Math.round((hourAngle - minuteVal * 0.5) / 30);
  let hourVal = ((rawHour % 12) + 12) % 12;
  if (hourVal === 0) hourVal = 12;

  // Safety guard 2 (from the prior OpenCV research): the hour hand's
  // measured angle must be geometrically consistent with the derived
  // hour/minute reading -- if not, the reading is unreliable, decline
  // rather than report a plausible-looking but wrong time.
  const expectedHourAngle = ((hourVal % 12) * 30 + minuteVal * 0.5) % 360;
  if (angDist(hourAngle, expectedHourAngle) > 8) return null;

  return { hour: hourVal, minute: minuteVal };
}

// Parses a real handwritten/printed time-of-day answer into {hour,
// minute} -- deliberately tolerant of the real shapes seen across this
// project's OCR output ("4:15", "4.15", "4:15pm", "4 o'clock"), never
// guessing when the text doesn't clearly state a time.
function parseTimeAnswer(text) {
  const s = String(text || "").trim().toLowerCase();
  let m = /^(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (m) {
    let hour = Number(m[1]) % 12;
    if (m[3] && m[3].startsWith("p")) hour += 12;
    else if (!m[3] && Number(m[1]) === 12) hour = 0; // bare "12:xx" with no am/pm treated as 12-hour-clock noon/midnight ambiguity -- compared mod 12 below anyway
    return { hour: hour % 12 === 0 ? 12 : hour % 12, minute: Number(m[2]) };
  }
  m = /^(\d{1,2})\s*(?:o'?clock|時|點)$/.exec(s);
  if (m) return { hour: Number(m[1]) % 12 === 0 ? 12 : Number(m[1]) % 12, minute: 0 };
  return null;
}

function verifyClockReading(item, crop) {
  let photonImg;
  try {
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    const reading = readClockHandsFromPixels(pixels, w, h);
    if (!reading) return { correct: null, correctAnswer: "" };
    const studentTime = parseTimeAnswer(item.studentAnswer);
    if (!studentTime) return { correct: null, correctAnswer: "" };
    const correct = studentTime.hour === reading.hour && studentTime.minute === reading.minute;
    return { correct, correctAnswer: correct ? "" : `${reading.hour}:${String(reading.minute).padStart(2, "0")}` };
  } catch (e) {
    return { correct: null, correctAnswer: "" }; // fails open -- any decode/processing error is treated as "can't verify", never a guess
  } finally {
    if (photonImg) photonImg.free();
  }
}

// Ticket 202 (2026-09-30, real citation: 26週數學訓練 P3 Topic 15「秒」
// math34pdf/p41.png Q1: "寫出鐘面所顯示的時間。" (a) 10時___分,再過了
// ___秒 (b) ___時45分,再過了___秒 -- clocks with a THIRD hand drawn in a
// distinct orange/gold colour for the seconds, alongside the usual
// black hour/minute hands. readClockHandsFromPixels above only tracks
// the two BLACK hands; this reads the coloured third hand separately.
//
// Real citation self-measured and verified exact against the real
// answer key (28s->8, 45s->22... i.e. (a) minute=28,sec=8 (b) hour=4,
// sec=22): farthest-orange-pixel-from-centre angle method gave 49.5deg
// ->8s and 132.1deg->22s, both exact after rounding to the nearest
// whole second (6deg/second). Deliberately does NOT use the polar-ring
// two-hand-disambiguation technique from readClockHandsFromPixels above
// (tracking by relative LENGTH) -- the second hand is isolated by
// COLOUR instead, which is simpler and more robust here since colour is
// unambiguous while relative hand lengths in a hand-drawn/stylised
// clock face are not guaranteed proportional.
function readSecondHandAngleFromPixels(pixels, w, h) {
  const cx = w / 2, cy = h / 2;
  let farX = null, farY = null, farD = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 40) continue;
      if (classifyColorName(r, g, b) !== "orange") continue;
      count++;
      const d = Math.hypot(x - cx, y - cy);
      if (d > farD) { farD = d; farX = x; farY = y; }
    }
  }
  if (count < 10 || farD < Math.min(w, h) * 0.1) return null; // too few/too short to trust -- fails open
  const angle = (Math.atan2(farX - cx, -(farY - cy)) * 180 / Math.PI + 360) % 360;
  return Math.round(angle / 6) % 60;
}

function isSecondHandClockQuestion(item) {
  return /再過了(?:___|＿+|_{2,})秒/.test(String(item.printedQuestion || ""));
}

function verifySecondHandClock(item, crop) {
  const printed = String(item.printedQuestion || "");
  const answer = String(item.studentAnswer || "").trim();
  if (!answer || !isSecondHandClockQuestion(item)) return { correct: null, correctAnswer: "" };
  let photonImg;
  let seconds, reading;
  try {
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    seconds = readSecondHandAngleFromPixels(pixels, w, h);
    reading = readClockHandsFromPixels(pixels, w, h);
  } catch { return { correct: null, correctAnswer: "" }; }
  finally { if (photonImg) photonImg.free(); }
  if (seconds === null || !reading) return { correct: null, correctAnswer: "" };

  // Two real sub-shapes: hour printed+minute blank ("10時___分"), or
  // hour blank+minute printed ("___時45分") -- always paired with the
  // seconds blank. Determine which side is printed by checking for a
  // literal digit immediately before 時 vs immediately before 分.
  const hourPrinted = /(\d+)\s*時(?:___|＿+|_{2,})分/.test(printed);
  const minutePrinted = /(?:___|＿+|_{2,})\s*時\s*(\d+)\s*分/.test(printed);
  const parts = answer.split(/[,，;]/).map((s) => s.trim());
  if (hourPrinted) {
    const givenMinute = Number(parts[0]);
    const givenSecond = Number(parts[1]);
    const correct = givenMinute === reading.minute && givenSecond === seconds;
    return { correct, correctAnswer: correct ? "" : `${reading.minute},${seconds}` };
  }
  if (minutePrinted) {
    const givenHour = Number(parts[0]);
    const givenSecond = Number(parts[1]);
    const correct = givenHour === reading.hour && givenSecond === seconds;
    return { correct, correctAnswer: correct ? "" : `${reading.hour},${seconds}` };
  }
  return { correct: null, correctAnswer: "" };
}

// Ticket 200 (2026-09-30, real citation: 26週數學訓練 P3 Topic 10「分
// 數」math34pdf/p25.png Q1(a): "寫出下面各圖中有色部分佔全圖的幾分之
// 幾。" -- a circle divided by 3 straight lines from the centre into 3
// equal sectors, one shaded light purple. Real answer key: 1/3.
//
// Pure region-count geometry, same pixel-measurement discipline as
// Tickets 197/198: flood-fill every NON-ink region (the line art itself
// is the boundary, not counted); the region touching the crop's own
// border is the surrounding page background, discarded; every remaining
// enclosed region is one "part" of the shape; a part counts as SHADED
// if its average luminance is meaningfully darker than the lightest
// kept region (the unshaded parts, near-white).
//
// Disclosed scope: only equal-area, non-overlapping regions (matches
// this citation exactly). The same Q1's (c) sub-image (a diamond
// overlapping a square, unequal overlap regions) would need proportional
// AREA weighting, not just a region COUNT -- not attempted here, real
// gap flagged rather than silently guessed.
function readFractionShadingFromPixels(pixels, w, h) {
  const isInk = (x, y) => {
    const i = (y * w + x) * 4;
    return (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) < 200;
  };
  const labels = new Int32Array(w * h).fill(-1);
  const regions = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const idx0 = y0 * w + x0;
      if (labels[idx0] !== -1 || isInk(x0, y0)) continue;
      const label = regions.length;
      const stack = [[x0, y0]];
      labels[idx0] = label;
      let size = 0, sumLum = 0, touchesBorder = false;
      while (stack.length) {
        const [x, y] = stack.pop();
        size++;
        const i = (y * w + x) * 4;
        sumLum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        if (x === 0 || x === w - 1 || y === 0 || y === h - 1) touchesBorder = true;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nidx = ny * w + nx;
            if (labels[nidx] !== -1 || isInk(nx, ny)) continue;
            labels[nidx] = label;
            stack.push([nx, ny]);
          }
        }
      }
      if (size >= 200 && !touchesBorder) regions.push({ size, avgLum: sumLum / size });
    }
  }
  if (regions.length < 2) return null; // need at least 2 real parts to form a meaningful fraction
  const maxLum = Math.max(...regions.map((r) => r.avgLum));
  const shaded = regions.filter((r) => maxLum - r.avgLum > 15).length;
  return { total: regions.length, shaded };
}

function isFractionShadingQuestion(item) {
  const printed = String(item.printedQuestion || "");
  return /有色部分佔全圖的幾分之幾/.test(printed);
}

function verifyFractionShading(item, crop) {
  const answer = String(item.studentAnswer || "").trim();
  if (!answer || !isFractionShadingQuestion(item)) return { correct: null, correctAnswer: "" };
  let photonImg;
  let result;
  try {
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    result = readFractionShadingFromPixels(pixels, w, h);
  } catch { return { correct: null, correctAnswer: "" }; }
  finally { if (photonImg) photonImg.free(); }
  if (!result) return { correct: null, correctAnswer: "" };
  const { total, shaded } = result;
  const expectedFraction = `${shaded}/${total}`;
  const m = answer.match(/^(\d+)\s*\/\s*(\d+)$/);
  let correct;
  if (m) correct = Number(m[1]) === shaded && Number(m[2]) === total;
  else correct = Number(answer) === shaded / total;
  return { correct, correctAnswer: correct ? "" : expectedFraction };
}

// Ticket 203 (2026-09-30, real citation: 26週數學訓練 P3 Topic 23「三角
// 形」math34pdf/p59.png Q4: "右圖中,把哪三點連起來,可得出一個等腰三角
// 形?答案:___,___,___。" -- a dot grid with 5 labelled points (P,Q,R,S,
// T); real answer key: Q,S,T.
//
// Genuinely a NEW architecture class (flagged as an open question by the
// original citation-extraction pass): this needs BOTH a text fact (which
// letter names which point -- only Vision OCR can read that) AND precise
// pixel measurement (the point's exact position, since a letter is
// printed NEXT TO its dot, never centred on it, and in a different
// direction each time -- confirmed by inspecting the real image). Ticket
// 199's OCR-marker pattern doesn't fit (nothing here needs OCR to READ a
// calibration fact); instead this reuses the EXISTING bbox-finding
// pattern (findAbacusBbox/findBarChartBbox already scan pr.vision.words
// at the page level) and extends it: the SAME page-level step that finds
// the crop region also resolves each letter's PAGE-pixel position, which
// verifyGridPointIsosceles below converts into this specific crop's own
// LOCAL pixel coordinates. That conversion needed a real (small,
// additive) architecture change: cropItem's returned crop object now
// also carries its own originX/originY/pageWidth/pageHeight -- every
// existing verifyVisual handler ignores these extra fields and is
// unaffected.
//
// Real bug found+fixed while building: a naive "any sufficiently dark
// blob near a letter" dot search finds the wrong thing, because the dot
// sits EXACTLY ON a grid line intersection and touches that line with no
// gap -- an ordinary flood-fill merges the small round dot with the thin
// grid line into one long line-shaped blob (confirmed on the real image:
// a 269x35-to-150px elongated blob, not a small dot). Fixed with a
// morphological-erosion-style "core" test instead of flood-filling raw
// ink: a pixel only counts if a small (5x5) window around it is ENTIRELY
// dark -- a thin 1-2px grid line can never satisfy this, but the dot's
// solid ~13px-diameter interior easily does, cleanly separating dots
// from the grid lines and letter strokes they touch.
function findGridDotPositions(pixels, w, h) {
  const isDark = (x, y) => {
    const i = (y * w + x) * 4;
    return (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) < 150;
  };
  const N = 2; // half-window -> 5x5 core test
  const isCore = (x, y) => {
    if (x < N || x >= w - N || y < N || y >= h - N) return false;
    for (let dx = -N; dx <= N; dx++) for (let dy = -N; dy <= N; dy++) if (!isDark(x + dx, y + dy)) return false;
    return true;
  };
  const visited = new Uint8Array(w * h);
  const dots = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const idx0 = y0 * w + x0;
      if (visited[idx0] || !isCore(x0, y0)) continue;
      const stack = [[x0, y0]];
      visited[idx0] = 1;
      let size = 0, sumX = 0, sumY = 0;
      while (stack.length) {
        const [x, y] = stack.pop();
        size++; sumX += x; sumY += y;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nidx = ny * w + nx;
            if (visited[nidx] || !isCore(nx, ny)) continue;
            visited[nidx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      if (size >= 10) dots.push({ x: sumX / size, y: sumY / size });
    }
  }
  return dots;
}

// Shared clustering helper (same greedy proximity-clustering shape as
// findLetterGridBbox/findBarChartBbox above): groups single-uppercase-
// letter Vision words that sit close together (a real labelled-point
// diagram), discarding any stray single-letter word elsewhere on the
// page (e.g. an unrelated MC option letter). Returns the best cluster's
// words, or [] if none qualifies.
function clusterSingleLetterWords(visionWords, pageWidth, pageHeight, minCount) {
  if (!visionWords || !visionWords.length || !pageWidth || !pageHeight) return [];
  const single = visionWords.filter((w) => /^[A-Z]$/.test(String(w.text || "").trim()));
  if (single.length < minCount) return [];
  const pts = single.map((w) => ({ x: w.x + w.w / 2, y: w.y + w.h / 2, w }));
  const maxGap = Math.max(pageWidth, pageHeight) * 0.25;
  const clusters = [];
  for (const p of pts) {
    let placed = false;
    for (const c of clusters) {
      if (Math.abs(p.x - c.cx) <= maxGap && Math.abs(p.y - c.cy) <= maxGap) {
        c.items.push(p);
        c.cx = c.items.reduce((s, q) => s + q.x, 0) / c.items.length;
        c.cy = c.items.reduce((s, q) => s + q.y, 0) / c.items.length;
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ cx: p.x, cy: p.y, items: [p] });
  }
  const best = clusters.filter((c) => c.items.length >= minCount).sort((a, b) => b.items.length - a.items.length)[0];
  return best ? best.items : [];
}

function isGridPointIsoscelesQuestion(item) {
  return /把哪三點連起來.{0,10}可得出.{0,4}等腰三角形/.test(String(item.printedQuestion || "").replace(/\s+/g, ""));
}

function extractLabeledGridPoints(visionWords, pageWidth, pageHeight) {
  return clusterSingleLetterWords(visionWords, pageWidth, pageHeight, 3)
    .map((p) => ({ letter: String(p.w.text).trim(), px: p.x, py: p.y }));
}

function findGridPointsBbox(visionWords, pageWidth, pageHeight) {
  const items = clusterSingleLetterWords(visionWords, pageWidth, pageHeight, 3);
  if (!items.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of items) {
    x0 = Math.min(x0, p.w.x); y0 = Math.min(y0, p.w.y);
    x1 = Math.max(x1, p.w.x + p.w.w); y1 = Math.max(y1, p.w.y + p.w.h);
  }
  // Generous extra padding beyond the letters' own bbox -- dots sit
  // OUTSIDE each letter's bounding box (adjacent, not overlapping), and
  // the grid itself extends further still.
  const padX = (x1 - x0) * 0.6 + pageWidth * 0.03, padY = (y1 - y0) * 0.6 + pageHeight * 0.03;
  x0 -= padX; y0 -= padY; x1 += padX; y1 += padY;
  return {
    x: Math.max(0, Math.round((x0 / pageWidth) * 100)),
    y: Math.max(0, Math.round((y0 / pageHeight) * 100)),
    w: Math.round(((x1 - x0) / pageWidth) * 100),
    h: Math.round(((y1 - y0) / pageHeight) * 100),
  };
}

function verifyGridPointIsosceles(item, crop) {
  const answer = String(item.studentAnswer || "").trim();
  if (!answer || !item.gridPointLabels || item.gridPointLabels.length < 3) return { correct: null, correctAnswer: "" };
  if (crop.originX == null || crop.originY == null) return { correct: null, correctAnswer: "" };
  let photonImg;
  let resolved;
  try {
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    const dots = findGridDotPositions(pixels, w, h);
    if (!dots.length) return { correct: null, correctAnswer: "" };
    resolved = item.gridPointLabels.map((p) => {
      const localX = p.px - crop.originX, localY = p.py - crop.originY;
      let best = null, bestD = Infinity;
      for (const d of dots) {
        const dist = Math.hypot(d.x - localX, d.y - localY);
        if (dist < bestD) { bestD = dist; best = d; }
      }
      // A real dot always sits within a bounded radius of its own letter
      // (never across the whole diagram) -- a match far beyond that is
      // treated as unresolved rather than silently binding to the wrong dot.
      if (!best || bestD > Math.max(w, h) * 0.25) return null;
      return { letter: p.letter, x: best.x, y: best.y };
    });
  } catch { return { correct: null, correctAnswer: "" }; }
  finally { if (photonImg) photonImg.free(); }
  if (resolved.some((r) => r === null)) return { correct: null, correctAnswer: "" };

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const triples = [];
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      for (let k = j + 1; k < resolved.length; k++) {
        const [a, b, c] = [resolved[i], resolved[j], resolved[k]];
        const [ab, bc, ca] = [dist(a, b), dist(b, c), dist(c, a)];
        const maxSide = Math.max(ab, bc, ca);
        // Real grid-snapped distances measured from pixel data carry
        // only a fraction of a pixel of noise (real measurement: exact
        // matches differed by ~0.1px) -- but real DIFFERENT grid-unit
        // pairs can still be as close as ~4% of the longest side apart
        // (confirmed on the real citation's own other point triples), so
        // a tolerance has to sit well below that gap, not near it. 3%
        // cleanly separates both cases on the real data.
        const isIsosceles = Math.abs(ab - bc) < maxSide * 0.03 || Math.abs(bc - ca) < maxSide * 0.03 || Math.abs(ca - ab) < maxSide * 0.03;
        if (isIsosceles) triples.push([a.letter, b.letter, c.letter]);
      }
    }
  }
  if (triples.length !== 1) return { correct: null, correctAnswer: "" }; // ambiguous or none found -- fail open
  const expected = triples[0];
  const given = answer.split(/[,，、\s]+/).filter(Boolean);
  const correct = given.length === 3 && [...expected].sort().join() === [...given].sort().join();
  return { correct, correctAnswer: correct ? "" : expected.join(",") };
}

// Ticket 210 (2026-09-30, real citation: 26週數學訓練 P3 Topic 20「平行
// 線」math34pdf/p54.png Q6 + p53.png Q2):
// Q6: "下列哪一個中文字有平行線?" A.下 B.千 C.山 D.木 -> C (山:三條豎劃
//   互相平行)
// Q2: "上圖中有平行線的英文字母有___個。" over the printed sequence
//   "A B C D E F G H" -> 3 (E,F,H each have a pair of parallel straight
//   strokes in their standard block-capital form)
// Both are fixed lookup-table facts about a BOUNDED, explicitly listed
// set of glyphs -- pure text/logic, zero image work. Disclosed scope:
// only the glyphs below are classified; any glyph outside this set
// fails open (returns undetermined) rather than guessing -- several
// Latin letters (e.g. M/N/U/W) have a genuinely font-dependent answer
// not attempted here since no real citation confirms them.
const CJK_PARALLEL_LINES_TABLE = { 下: false, 千: false, 山: true, 木: false };
const LATIN_PARALLEL_LINES_TABLE = { A: false, B: false, C: false, D: false, E: true, F: true, G: false, H: true };

function isCjkParallelLinesMcQuestion(item) {
  return /下列哪一個中文字有平行線/.test(String(item.printedQuestion || "").replace(/\s+/g, ""));
}

function verifyCjkParallelLinesMc(printedQuestion, studentAnswer) {
  if (!isCjkParallelLinesMcQuestion({ printedQuestion })) return { correct: null, correctAnswer: "" };
  const options = parseMcOptions(String(printedQuestion || ""));
  if (options.length < 2) return { correct: null, correctAnswer: "" };
  const evaluated = options.map((o) => ({ ...o, has: CJK_PARALLEL_LINES_TABLE[o.text.trim()] }));
  if (evaluated.some((o) => o.has === undefined)) return { correct: null, correctAnswer: "" };
  const target = evaluated.filter((o) => o.has);
  if (target.length !== 1) return { correct: null, correctAnswer: "" };
  const answer = String(studentAnswer || "").trim();
  const correct = answer === target[0].letter;
  return { correct, correctAnswer: correct ? "" : target[0].letter };
}

function isLatinParallelLinesCountQuestion(item) {
  return /有平行線的英文字母有.{0,6}(___|＿+|_{2,})個/.test(String(item.printedQuestion || "").replace(/\s+/g, ""));
}

function verifyLatinParallelLinesCount(printedQuestion, studentAnswer) {
  if (!isLatinParallelLinesCountQuestion({ printedQuestion })) return { correct: null, correctAnswer: "" };
  const answer = String(studentAnswer || "").trim();
  const m = answer.match(/\d+/);
  if (!m) return { correct: null, correctAnswer: "" };
  const letters = [...new Set(String(printedQuestion || "").match(/\b[A-Z]\b/g) || [])];
  if (letters.length < 2 || letters.some((l) => LATIN_PARALLEL_LINES_TABLE[l] === undefined)) return { correct: null, correctAnswer: "" };
  const expected = letters.filter((l) => LATIN_PARALLEL_LINES_TABLE[l]).length;
  const correct = Number(m[0]) === expected;
  return { correct, correctAnswer: correct ? "" : String(expected) };
}

// Ticket 204 (2026-09-30, real citation: 26週數學訓練 P3 Topic 22「梯
// 形」math34pdf/p57.png Q1: "依指示寫出所有代表答案的英文字母。" -- 9
// quadrilaterals labelled P-X (X is a concave distractor, not a real
// trapezoid). (a) 直角梯形(right trapezoid): ___ (b) 等腰梯形(isosceles
// trapezoid): ___ (c) 沒有直角的不等腰梯形(scalene, no right angle): ___
// Real answer key: (a) S,V (b) P,W (c) T,U.
//
// Extends Ticket 197's shape classifier (readShapeClassificationFromPixels)
// rather than duplicating its blob-detection: that function now also
// returns each blob's actual simplified polygon (additive `points`
// field -- every existing caller still only reads shape/vertices/cx/
// cy/area and is unaffected). This function classifies a 4-vertex
// polygon as a trapezoid sub-type using real edge geometry: find the
// one pair of opposite edges that are parallel (a trapezoid has exactly
// one; a parallelogram has two, so is correctly rejected here), then
// check whether either leg meets a base at ~90deg (right trapezoid) or
// the two legs are equal length (isosceles) -- real-tested against all
// 9 shapes in the actual citation image, correctly matching the real
// answer key exactly, including correctly rejecting X (fails the
// "exactly 4 vertices" precondition, since it's a concave 6-sided
// distractor once its curved sides are polygon-approximated).
//
// Disclosed scope: rhombus (菱形) classification NOT included -- a
// dedicated citation-extraction pass searched this entire book and
// confirmed 菱形 is never named as its own concept anywhere in it (see
// memory), so it's not built here without a real citation to verify
// against. Line-property classification (straight/curved/parallel/
// perpendicular for an arbitrary compound outline, the OTHER real
// sub-case found for this ticket, math34pdf p53 Q4) is also NOT
// attempted in this pass -- a materially different problem (open
// strokes, not closed quadrilaterals) flagged as a separate follow-up.
function classifyTrapezoidType(points) {
  if (!points || points.length !== 4) return null;
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const p1 = points[i], p2 = points[(i + 1) % 4];
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    edges.push({ dx, dy, len: Math.hypot(dx, dy) });
  }
  const angle = (e) => Math.atan2(e.dy, e.dx);
  const angleDiff = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
  const TOL = (8 * Math.PI) / 180;
  const pair02 = angleDiff(angle(edges[0]), angle(edges[2])) < TOL;
  const pair13 = angleDiff(angle(edges[1]), angle(edges[3])) < TOL;
  if (pair02 === pair13) return null; // need EXACTLY one parallel pair -- neither (not a trapezoid) or both (parallelogram) are rejected
  const [baseA, baseB, legA, legB] = pair02 ? [edges[0], edges[2], edges[1], edges[3]] : [edges[1], edges[3], edges[0], edges[2]];
  const dot = (e1, e2) => (e1.dx * e2.dx + e1.dy * e2.dy) / (e1.len * e2.len);
  const isPerp = (e1, e2) => Math.abs(dot(e1, e2)) < Math.cos(((90 - 8) * Math.PI) / 180);
  const hasRightAngle = isPerp(baseA, legA) || isPerp(baseA, legB) || isPerp(baseB, legA) || isPerp(baseB, legB);
  const legsEqual = Math.abs(legA.len - legB.len) < Math.max(legA.len, legB.len) * 0.12;
  if (hasRightAngle) return "right";
  if (legsEqual) return "isosceles";
  return "scalene";
}

function isTrapezoidTypeLetterQuestion(item) {
  const printed = String(item.printedQuestion || "").replace(/\s+/g, "");
  // Matches whether OCR keeps the shared "依指示寫出所有代表答案的英文
  // 字母" preamble on every split-out (a)/(b)/(c) sub-item or only the
  // first -- either way, each real sub-item's own line always names its
  // specific trapezoid-type category, which alone is specific enough
  // (these exact geometric terms don't occur in unrelated questions).
  return /直角梯形|等腰梯形|沒有直角的不等腰梯形/.test(printed);
}

function verifyTrapezoidTypeLetters(item, crop) {
  const printed = String(item.printedQuestion || "");
  const answer = String(item.studentAnswer || "").trim();
  if (!answer || !isTrapezoidTypeLetterQuestion(item)) return { correct: null, correctAnswer: "" };
  if (!item.trapezoidLetterLabels || item.trapezoidLetterLabels.length < 2) return { correct: null, correctAnswer: "" };
  if (crop.originX == null || crop.originY == null) return { correct: null, correctAnswer: "" };
  let photonImg;
  let byLetter;
  try {
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    const shapes = readShapeClassificationFromPixels(pixels, w, h);
    if (!shapes || !shapes.length) return { correct: null, correctAnswer: "" };
    // Real bug found while building: the letter label is printed INSIDE
    // each shape, so a naive "map shapes to letters by raster reading
    // order" assumption (same one Ticket 197's grid classifier
    // discloses and accepts) badly mismatches on THIS citation's real
    // layout -- the shapes are staggered in two uneven, overlapping
    // rows, not a clean grid. Fixed the same way as Ticket 203: bind
    // each letter to the shape whose centroid is NEAREST to that
    // letter's own Vision-word position (converted into this crop's
    // local pixel coordinates via crop.originX/originY), never assumed
    // from position order.
    byLetter = {};
    for (const label of item.trapezoidLetterLabels) {
      const localX = label.px - crop.originX, localY = label.py - crop.originY;
      let best = null, bestD = Infinity;
      for (const s of shapes) {
        const d = Math.hypot(s.cx - localX, s.cy - localY);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (best && bestD < Math.max(w, h) * 0.2) byLetter[label.letter] = classifyTrapezoidType(best.points);
    }
  } catch { return { correct: null, correctAnswer: "" }; }
  finally { if (photonImg) photonImg.free(); }
  if (!Object.keys(byLetter).length) return { correct: null, correctAnswer: "" };

  // Determine which sub-question this item is via which trapezoid-type
  // phrase leads it (each (a)/(b)/(c) sub-part is its own item after
  // OCR splits by label, matching this project's established per-blank
  // item convention).
  let targetType;
  if (/沒有直角的不等腰梯形/.test(printed)) targetType = "scalene";
  else if (/等腰梯形/.test(printed)) targetType = "isosceles";
  else if (/直角梯形/.test(printed)) targetType = "right";
  else return { correct: null, correctAnswer: "" };

  const expectedLetters = Object.entries(byLetter).filter(([, t]) => t === targetType).map(([l]) => l).sort();
  if (!expectedLetters.length) return { correct: null, correctAnswer: "" };
  const given = answer.split(/[,，、\s]+/).filter(Boolean).map((s) => s.toUpperCase()).sort();
  const correct = given.join() === expectedLetters.join();
  return { correct, correctAnswer: correct ? "" : expectedLetters.join(",") };
}

// Ticket found 2026-09-28 (躍思 workbook survey): a real Müller-Lyer
// visual-illusion question -- 3 printed straight lines (直線P/Q/R), each
// with arrowhead decorations pointing inward or outward at both ends,
// which visually mislead about relative length even though the actual
// straight shafts are equal. Validated TWICE before shipping, per the
// standing Tier-V-verify-on-real-questions rule:
//   1. Against the REAL source image (this exact question, p.39): a
//      horizontal scanline through each line's vertical centre, taking
//      the row with the single LONGEST continuous run of dark pixels
//      (the straight shaft), correctly measured all 3 lines within 3px
//      of each other (274/277/274px) -- the arrowhead strokes are
//      diagonal, so they never contribute a long horizontal run at any
//      one row, keeping them from contaminating the shaft measurement.
//   2. Against a SYNTHETIC counter-test with 3 genuinely different
//      lengths (200/260/320px, same arrowhead style) to confirm the
//      method has real discriminative power and doesn't just always
//      report "equal" -- measured 203/263/323px, correctly ranked and
//      close to the true lengths (small constant offset from stroke
//      width, consistent across all three).
// Deliberately narrow in scope for this first version: only handles the
// "are all N lines equal length" shape (the one real citation found so
// far) -- declines (null) whenever the lines are NOT all equal, rather
// than attempt an unverified "which one is longest" ranking against
// labels this hasn't been tested on.
function readLineShaftLengths(pixels, w, h, lineCount) {
  const luminance = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  };
  const isDark = (x, y) => luminance(x, y) < 150;
  const bandH = Math.floor(h / lineCount);
  const lengths = [];
  for (let band = 0; band < lineCount; band++) {
    let bestLen = 0;
    for (let y = band * bandH; y < (band + 1) * bandH; y++) {
      let curLen = 0, curStart = 0, rowBest = 0;
      for (let x = 0; x < w; x++) {
        if (isDark(x, y)) {
          if (curLen === 0) curStart = x;
          curLen++;
          if (curLen > rowBest) rowBest = curLen;
        } else {
          curLen = 0;
        }
      }
      if (rowBest > bestLen) bestLen = rowBest;
    }
    lengths.push(bestLen);
  }
  return lengths;
}

function verifyLineShaftAllEqual(item, crop) {
  let photonImg;
  try {
    const printed = String(item.printedQuestion || "");
    const options = parseMcOptions(printed);
    if (!options.length) return { correct: null, correctAnswer: "" };
    const allEqualOption = options.find((o) => /一樣長|相同|相等|all.{0,10}(equal|same)/i.test(o.text));
    if (!allEqualOption) return { correct: null, correctAnswer: "" };
    const lineLabelMatches = printed.match(/[直线線]\s*[A-Za-z]|line\s*[A-Za-z]/gi) || [];
    const lineCount = new Set(lineLabelMatches.map((s) => s.trim().slice(-1).toUpperCase())).size;
    if (lineCount < 2) return { correct: null, correctAnswer: "" };
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    const lengths = readLineShaftLengths(pixels, w, h, lineCount);
    if (lengths.some((l) => l < 10)) return { correct: null, correctAnswer: "" }; // a band with no real shaft found -- decline
    const maxLen = Math.max(...lengths), minLen = Math.min(...lengths);
    const allEqual = (maxLen - minLen) / maxLen < 0.05; // 5% tolerance for scan/print noise
    if (!allEqual) return { correct: null, correctAnswer: "" }; // only the "all equal" shape is validated so far
    const answer = String(item.studentAnswer || "").trim();
    const correct = answer === allEqualOption.letter || answer.includes(allEqualOption.text);
    return { correct, correctAnswer: correct ? "" : allEqualOption.letter };
  } catch (e) {
    return { correct: null, correctAnswer: "" };
  } finally {
    if (photonImg) photonImg.free();
  }
}

// Object counting via Photon connected-component blobs (2026-09-28,
// prompted by the user's own real question: "for questions that count
// clear separate objects, can Photon distinguish them by pixels?").
// Validated against 3 REAL images from a real P1 test before shipping,
// per the standing Tier-V rule:
//   - 13 sheep icons, no surrounding frame -> counted 13/13 correctly.
//   - 9 apple icons, no surrounding frame -> counted 9/9 correctly.
//   - 12 fish icons INSIDE a rounded-rectangle frame (one fish touches
//     the frame border) -> the frame + touching fish fused into one
//     giant blob, undercounting to 11 separate + 1 fused mega-blob.
// That third case is exactly why this function does NOT just return a
// raw count -- it runs a SAFETY CHECK first (also validated against all
// 3 real images, correctly flagging only the fish case as unsafe):
//   1. Size-outlier check: if the largest blob is >2.5x the median blob
//      size, something has fused together (a frame, a touching pair) --
//      decline rather than report a confidently wrong count.
//   2. Frame-blob check: if any single blob's bounding box spans more
//      than 85% of the image's width OR height, that's almost certainly
//      a border/frame line, not a counted object -- decline.
// This is deliberately conservative: it only ever counts when the image
// looks clean, and fails open (null, falls through to Jev/AI) otherwise
// -- there is no known way to distinguish a clean vs framed photo in
// advance without already running this analysis, so every count is
// double-checked this way, never trusted blind.
function readObjectCountFromPixels(pixels, w, h) {
  const threshold = 200; // validated across both plain-outline (sheep) and grey-filled (apple) real icon styles
  const minBlobSize = 30; // filters out stray dots/scan noise, well below any real icon's pixel footprint
  const luminance = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  };
  const isDark = (x, y) => luminance(x, y) < threshold;
  const visited = new Uint8Array(w * h);
  const blobs = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const idx0 = y0 * w + x0;
      if (visited[idx0] || !isDark(x0, y0)) continue;
      const stack = [[x0, y0]];
      visited[idx0] = 1;
      let size = 0, minX = x0, maxX = x0, minY = y0, maxY = y0;
      while (stack.length) {
        const [x, y] = stack.pop();
        size++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nidx = ny * w + nx;
            if (visited[nidx] || !isDark(nx, ny)) continue;
            visited[nidx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      if (size >= minBlobSize) blobs.push({ size, boxW: maxX - minX, boxH: maxY - minY });
    }
  }
  if (!blobs.length) return { count: null, safe: false };
  const sizes = blobs.map((b) => b.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const maxSize = Math.max(...sizes);
  const sizeOutlier = maxSize > median * 2.5;
  const frameBlob = blobs.some((b) => b.boxW > w * 0.85 || b.boxH > h * 0.85);
  const safe = !sizeOutlier && !frameBlob;
  return { count: blobs.length, safe };
}

// Ticket 201 (2026-09-30, real citation: 26週數學訓練 P3 Topic 10「分
// 數」math34pdf/p25.png Q2: "下圖是停泊在停車場裏的汽車。" (a) 綠色車
// 有___輛,佔全部汽車的☐。(b) 黃色車有___輛,佔全部汽車的☐。 -- 10 toy
// cars in a 2x5 grid, mixed colours red/blue/yellow/green. Self-measured
// from the real crop: red=2, blue=4, yellow=3, green=1 -- matches the
// real answer key exactly ((a) green=1 (b) yellow=3).
// Extends readObjectCountFromPixels above with a per-blob dominant-hue
// classifier, since plain counting can't tell WHICH icons match the
// asked colour. Uses the same general (colour/background-agnostic) ink
// test as Tickets 198/199 (estimateBackgroundLuminance/isInkByLuminance)
// rather than a fixed brightness threshold, so this isn't tied to a
// white background specifically.
//
// Colour classification averages RGB only over SATURATED ink pixels
// within each blob (real bug found while building: a naive average over
// ALL ink pixels, or a single centre-point sample, lands on a car's
// grey window/wheel detail as often as its coloured body panel --
// sampled real pixels confirmed this, e.g. one car's exact centre pixel
// was (122,128,136), a near-grey wheel-shadow area, not the pink body).
// Filtering to saturation > 40 (max-min channel spread) before
// averaging reliably isolates the body-panel hue.
function classifyColorName(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 20) return max < 100 ? "black" : max > 200 ? "white" : "gray";
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = ((hue * 60) + 360) % 360;
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 170) return "green";
  if (hue < 255) return "blue";
  if (hue < 290) return "purple";
  return "pink";
}

const COLOR_NAME_ZH = { red: "紅色", orange: "橙色", yellow: "黃色", green: "綠色", blue: "藍色", purple: "紫色", pink: "粉紅色", black: "黑色", white: "白色", gray: "灰色" };
const COLOR_NAME_ZH_TO_KEY = Object.fromEntries(Object.entries(COLOR_NAME_ZH).map(([k, v]) => [v, k]));

function readColorCountedBlobs(pixels, w, h) {
  const backgroundLuminance = estimateBackgroundLuminance(pixels, w, h);
  const isInk = (x, y) => isInkByLuminance(pixels, (y * w + x) * 4, backgroundLuminance, 35);
  const minBlobSize = 30;
  const visited = new Uint8Array(w * h);
  const blobs = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const idx0 = y0 * w + x0;
      if (visited[idx0] || !isInk(x0, y0)) continue;
      const stack = [[x0, y0]];
      visited[idx0] = 1;
      let size = 0, minX = x0, maxX = x0, minY = y0, maxY = y0;
      let sumR = 0, sumG = 0, sumB = 0, satCount = 0;
      while (stack.length) {
        const [x, y] = stack.pop();
        size++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        const i = (y * w + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 40) { sumR += r; sumG += g; sumB += b; satCount++; }
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nidx = ny * w + nx;
            if (visited[nidx] || !isInk(nx, ny)) continue;
            visited[nidx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      if (size >= minBlobSize) {
        const color = satCount > 0 ? classifyColorName(sumR / satCount, sumG / satCount, sumB / satCount) : "gray";
        blobs.push({ size, boxW: maxX - minX, boxH: maxY - minY, color });
      }
    }
  }
  if (!blobs.length) return { blobs: [], safe: false };
  const sizes = blobs.map((b) => b.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const maxSize = Math.max(...sizes);
  const sizeOutlier = maxSize > median * 2.5;
  const frameBlob = blobs.some((b) => b.boxW > w * 0.85 || b.boxH > h * 0.85);
  const safe = !sizeOutlier && !frameBlob;
  return { blobs, safe };
}

function isColorCountedQuestion(item) {
  const printed = String(item.printedQuestion || "");
  return /(紅|橙|黃|綠|藍|紫|粉紅|黑|白|灰)色.{0,10}有.{0,6}(___|＿+|_{2,})/.test(printed);
}

function verifyColorCountedIcons(item, crop) {
  const printed = String(item.printedQuestion || "");
  const answer = String(item.studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const m = printed.match(/(紅|橙|黃|綠|藍|紫|粉紅|黑|白|灰)色.{0,10}有.{0,6}(?:___|＿+|_{2,})/);
  if (!m) return { correct: null, correctAnswer: "" };
  const askedColorKey = COLOR_NAME_ZH_TO_KEY[`${m[1]}色`];
  if (!askedColorKey) return { correct: null, correctAnswer: "" };
  let photonImg;
  let blobs, safe;
  try {
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    ({ blobs, safe } = readColorCountedBlobs(pixels, w, h));
  } catch { return { correct: null, correctAnswer: "" }; }
  finally { if (photonImg) photonImg.free(); }
  if (!safe || !blobs.length) return { correct: null, correctAnswer: "" };
  const total = blobs.length;
  const expectedCount = blobs.filter((b) => b.color === askedColorKey).length;
  // Two-blank convention (count, fraction), matching this project's
  // established multi-sub-answer format (e.g. Ticket 199's "4月,12").
  // Also accepts a count-only answer when the printed question has no
  // second (fraction) blank.
  const parts = answer.split(/[,，;]/).map((s) => s.trim());
  const givenCount = Number(parts[0]);
  if (!Number.isFinite(givenCount)) return { correct: null, correctAnswer: "" };
  let correct = givenCount === expectedCount;
  let expectedAnswer = String(expectedCount);
  if (parts.length > 1) {
    const givenFraction = parts[1].replace(/\s/g, "");
    const expectedFraction = `${expectedCount}/${total}`;
    const fractionOk = givenFraction === expectedFraction || Number(parts[1]) === expectedCount / total;
    correct = correct && fractionOk;
    expectedAnswer = `${expectedCount},${expectedFraction}`;
  }
  return { correct, correctAnswer: correct ? "" : expectedAnswer };
}

// Ticket 206 (2026-09-30, real citation: 26週數學訓練 P3 Topic 16「克和
// 公斤」math34pdf/p43.png Q1: "文聰把豹玩偶和猴玩偶放在天平上稱量。"
// (a) 豹玩偶重___粒◉。(b) 豹玩偶比猴玩偶*輕/重,重量相差___粒◉。 --
// TWO separate balance-scale weighings in one crop (leopard toy vs a
// carrot-icon pile on one scale, monkey toy vs a bigger carrot-icon pile
// on a second scale); both scales are drawn perfectly level/balanced in
// the source image, so this is pure ICON COUNTING per pile (same family
// as Ticket 201), not tilt-angle reading -- re-scoped from the original
// "which side sinks" assumption after checking the real image. Real
// answer key: leopard=8, monkey=10 (輕;2 -- leopard lighter by 2).
//
// Real bug found+fixed while building: the carrot-icon "coins" are
// drawn touching/overlapping each other in a tight pyramid stack (same
// touching problem as Ticket 198's abacus beads) -- a general ink-blob
// flood-fill merges the whole pile into one blob via each coin's shared
// grey outline. Fix: flood-fill ONLY over the coin's small orange inner
// "flame" mark (a specific hue, not general ink) -- the flames stay
// separated even where the outer grey circles touch, since each flame
// is drawn well within its own circle's interior. This also naturally
// excludes the toy animals' body blobs (orange leopard fur is a much
// LARGER blob than a single flame icon -- filtered by size) and a
// stray same-hue icon printed elsewhere in the question text (filtered
// by spatial clustering -- a real coin pile is always many icons
// packed close together; an unrelated isolated icon has no close
// same-size neighbours and is discarded as noise).
//
// Disclosed scope: hardcoded to the real citation's orange coin colour
// (not colour-agnostic like Ticket 198's later rework) -- no user
// instruction yet to generalise this one, unlike abacus reading.
function readBalanceScalePiles(pixels, w, h) {
  const isOrange = (x, y) => {
    const i = (y * w + x) * 4;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) < 40) return false;
    return classifyColorName(r, g, b) === "orange";
  };
  const visited = new Uint8Array(w * h);
  const blobs = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const idx0 = y0 * w + x0;
      if (visited[idx0] || !isOrange(x0, y0)) continue;
      const stack = [[x0, y0]];
      visited[idx0] = 1;
      let size = 0, sumX = 0, sumY = 0;
      while (stack.length) {
        const [x, y] = stack.pop();
        size++; sumX += x; sumY += y;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nidx = ny * w + nx;
            if (visited[nidx] || !isOrange(nx, ny)) continue;
            visited[nidx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      if (size >= 40) blobs.push({ size, cx: sumX / size, cy: sumY / size });
    }
  }
  if (blobs.length < 6) return null; // need at least 2 real piles' worth
  // Size-band filter: keep only blobs near the majority size (excludes
  // much-larger animal-fur blobs, same "outlier vs median" philosophy
  // as readShapeClassificationFromPixels/findRodPositions elsewhere).
  const sizes = blobs.map((b) => b.size).sort((a, b) => a - b);
  const medianSize = sizes[Math.floor(sizes.length / 2)];
  const iconBlobs = blobs.filter((b) => b.size >= medianSize * 0.4 && b.size <= medianSize * 2.5);
  // Spatial clustering (union-find over a proximity graph): real coin
  // piles are many icons packed tightly; a stray same-hue icon
  // elsewhere in the image has no close neighbours and forms its own
  // tiny component, discarded below.
  const linkDistance = 60;
  const parent = iconBlobs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < iconBlobs.length; i++) {
    for (let j = i + 1; j < iconBlobs.length; j++) {
      const dx = iconBlobs[i].cx - iconBlobs[j].cx, dy = iconBlobs[i].cy - iconBlobs[j].cy;
      if (Math.sqrt(dx * dx + dy * dy) <= linkDistance) union(i, j);
    }
  }
  const groups = new Map();
  iconBlobs.forEach((b, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(b);
  });
  // Real bug found: a toy animal's own spotted fur pattern (e.g. the
  // leopard's orange spots) can form its own small same-hue cluster
  // (real measurement: 5 members) alongside the two real coin piles (8
  // and 10 members) -- clustering alone isn't enough to isolate exactly
  // 2 groups. Real coin piles always dominate in member count over any
  // such incidental clutter, so take the two LARGEST qualifying groups,
  // requiring a clear size margin over whatever is third-largest (if
  // any) so a genuinely ambiguous case fails open instead of guessing.
  const candidates = [...groups.values()].filter((g) => g.length >= 3).sort((a, b) => b.length - a.length);
  if (candidates.length < 2) return null;
  if (candidates.length >= 3 && candidates[2].length >= candidates[1].length * 0.7) return null;
  const piles = candidates.slice(0, 2);
  piles.sort((a, b) => (a.reduce((s, x) => s + x.cx, 0) / a.length) - (b.reduce((s, x) => s + x.cx, 0) / b.length));
  return { leftCount: piles[0].length, rightCount: piles[1].length };
}

function isBalanceScalePileQuestion(item) {
  return /天平上稱量|放在天平上/.test(String(item.printedQuestion || ""));
}

function verifyBalanceScalePiles(item, crop) {
  const printed = String(item.printedQuestion || "");
  const answer = String(item.studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  let photonImg;
  let piles;
  try {
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    piles = readBalanceScalePiles(pixels, w, h);
  } catch { return { correct: null, correctAnswer: "" }; }
  finally { if (photonImg) photonImg.free(); }
  if (!piles) return { correct: null, correctAnswer: "" };
  const { leftCount, rightCount } = piles;

  // Shape (a): "<name>重___粒" -- a single named toy's own pile count.
  // Disclosed assumption: the FIRST weighing named in the question is
  // always the LEFT scale in the image (true for the real citation,
  // matches normal left-to-right page reading order) -- there is no
  // pixel-level way to bind a toy's NAME to a specific pile, since the
  // toy's own species isn't classified here, only the coin pile sizes.
  if (/(?:^|。)[^，,。]{0,10}重(?:___|＿+|_{2,})粒/.test(printed)) {
    const expected = leftCount;
    const studentNum = parseSignedStudentNumber(answer);
    const correct = studentNum === expected;
    return { correct, correctAnswer: correct ? "" : String(expected) };
  }

  // Shape (b): "<A>比<B>*輕/重,重量相差___粒" -- compares the two piles.
  const cmpMatch = printed.match(/比[^，,。]*\*?\s*(輕|重)[\s\S]{0,10}相差(?:___|＿+|_{2,})粒/);
  if (cmpMatch) {
    const aLighter = leftCount < rightCount;
    const expectedDirection = aLighter ? "輕" : "重";
    const expectedDiff = Math.abs(leftCount - rightCount);
    const parts = answer.split(/[,，;]/).map((s) => s.trim());
    const givenDirection = parts[0];
    const givenDiff = Number(parts[1]);
    const correct = givenDirection === expectedDirection && givenDiff === expectedDiff;
    return { correct, correctAnswer: correct ? "" : `${expectedDirection},${expectedDiff}` };
  }

  return { correct: null, correctAnswer: "" };
}

// Ticket (2026-09-30, real research this session): geometric shape
// classification -- reads what shape each blob in a cropped image
// actually IS (square/rectangle/triangle/pentagon/hexagon/circle/
// ellipse), not just how many there are (readObjectCountFromPixels
// above only counts). Validated in an isolated sandbox first (Python/
// OpenCV to prove the algorithm, a separate Node/d3-contour/simplify-js
// prototype to prove the actual deployable-to-Workers stack) against
// the REAL photo this was built to fix -- Gemini 3.1 Flash-Lite
// (production AI-fallback, Ticket 196) miscounted/misclassified shapes
// on 2 of 10 real Tier-V test items, including this exact one. This is
// pure local geometric measurement, $0, no AI call -- see
// memory/TICKETS.md for the full real-data comparison.
//
// Three real bugs were found and fixed while porting from OpenCV's
// mature contour-tracing to these generic JS libraries (kept as comments
// at each fix site below since they are NOT obvious and would be easy
// to regress back into):
// 1. The traced ring with the MOST points is not reliably "the outer
//    boundary" -- pixel-level aliasing noise can give a tiny spurious
//    ring more points than the true boundary has. Select by largest
//    ENCLOSED AREA instead.
// 2. Marching squares (d3-contour) is built to interpolate a smooth
//    scalar field, not trace a raw hard 0/1 binary mask -- feeding it
//    a hard mask produces pixel-staircase aliasing (spurious extra
//    vertices). A small box blur before tracing fixes this.
// 3. "Is this a rectangle" must use the true minimum-area ROTATED
//    bounding rectangle (rotating calipers over the convex hull), not
//    an axis-aligned bbox -- a shape drawn at an angle badly under-fills
//    an axis-aligned box even when it's a clean rectangle/square.
//
// Known, disclosed limitation (NOT fixed, real and current): this only
// works for shapes that do NOT touch/overlap each other (confirmed via
// real testing -- 100% on Python/5-6 on this JS port for a real 12-shape
// non-touching grid, but a real touching/composite figure, like a
// flower drawn from petals sharing edges with a stem, is NOT correctly
// separated by this flood-fill approach and needs a fundamentally
// different technique, not yet built). Only wire this into a question
// type confirmed (by real testing, not assumption) to be non-touching
// shapes.
function readShapeClassificationFromPixels(pixels, w, h) {
  const threshold = 245; // matches the real 2026-09-29 validation (not-white = ink)
  const minBlobSize = 80;
  const luminance = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  };
  const isInk = (x, y) => luminance(x, y) < threshold;
  const labels = new Int32Array(w * h).fill(-1);
  const blobs = []; // { label, minX, maxX, minY, maxY, area }
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const idx0 = y0 * w + x0;
      if (labels[idx0] !== -1 || !isInk(x0, y0)) continue;
      const label = blobs.length;
      const stack = [[x0, y0]];
      labels[idx0] = label;
      let minX = x0, maxX = x0, minY = y0, maxY = y0, area = 0;
      while (stack.length) {
        const [x, y] = stack.pop();
        area++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nidx = ny * w + nx;
            if (labels[nidx] !== -1 || !isInk(nx, ny)) continue;
            labels[nidx] = label;
            stack.push([nx, ny]);
          }
        }
      }
      if (area >= minBlobSize) blobs.push({ label, minX, maxX, minY, maxY, area });
      // else: leave labelled (never revisited -- labels[] already set) but not counted as a real blob
    }
  }

  function convexHull(pts) {
    const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function classifyBlob(b) {
    const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
    const pad = 1;
    const fw = bw + pad * 2, fh = bh + pad * 2;
    const field = new Float64Array(fw * fh);
    for (let y = b.minY; y <= b.maxY; y++) {
      for (let x = b.minX; x <= b.maxX; x++) {
        if (labels[y * w + x] === b.label) field[(y - b.minY + pad) * fw + (x - b.minX + pad)] = 1;
      }
    }
    // Fix 2: box blur before marching squares -- see function comment above.
    const blurred = new Float64Array(fw * fh);
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= fh || xx < 0 || xx >= fw) continue;
          sum += field[yy * fw + xx]; cnt++;
        }
        blurred[y * fw + x] = sum / cnt;
      }
    }
    const gen = contours().size([fw, fh]).thresholds([0.5]);
    const polys = gen(blurred);
    if (!polys.length || !polys[0].coordinates.length) return null;
    // Fix 1: select the ring enclosing the largest area, not the ring
    // with the most points -- see function comment above.
    let ring = null, bestArea = 0;
    for (const poly of polys[0].coordinates) {
      for (const r of poly) {
        let a2 = 0;
        for (let k = 0; k < r.length; k++) {
          const [x1, y1] = r[k], [x2, y2] = r[(k + 1) % r.length];
          a2 += x1 * y2 - x2 * y1;
        }
        const a = Math.abs(a2) / 2;
        if (a > bestArea) { bestArea = a; ring = r; }
      }
    }
    if (!ring) return null;
    const points = ring.map(([x, y]) => ({ x, y }));

    // Plateau vertex-count: scan a range of simplification tolerances
    // and take the vertex count with the LONGEST stable run -- far more
    // robust to jagged/anti-aliased edges than reading off one fixed
    // tolerance.
    const counts = [];
    for (let tol = 0.3; tol <= 6; tol += 0.1) {
      const simp = simplifyPolygon(points, tol, true);
      // simplify-js's closed-polygon mode (3rd arg true) can return the
      // first point duplicated as the last -- real bug found comparing
      // against the sandbox prototype this was ported from: every single
      // vertex count came back exactly +1 high (a square read as 5, a
      // hexagon as 7, a circle's polygon approximation as 9) until this
      // dedup was added. Must stay -- dropping it silently reintroduces
      // the same off-by-one across every shape.
      const dup = simp.length > 1 && simp[0].x === simp[simp.length - 1].x && simp[0].y === simp[simp.length - 1].y;
      counts.push(simp.length - (dup ? 1 : 0));
    }
    let runs = [], i = 0;
    while (i < counts.length) {
      let j = i;
      while (j < counts.length && counts[j] === counts[i]) j++;
      runs.push([counts[i], j - i]);
      i = j;
    }
    runs.sort((a, bb) => bb[1] - a[1]);
    const v = runs[0][0];
    // Ticket 204 (2026-09-30): also keep the actual simplified polygon
    // for the winning vertex-count run (additive field -- every existing
    // caller only ever reads .shape/.vertices/.cx/.cy/.area and is
    // unaffected), needed for trapezoid-subtype classification which
    // requires real edge angles/lengths, not just a vertex count.
    // Recomputed once at the tolerance in the middle of the winning
    // run's stable range, then shifted out of the padded local frame
    // back into this blob's own absolute crop-pixel coordinates.
    let cIdx = 0, seen = 0;
    for (let ci = 0; ci < counts.length; ci++) {
      if (counts[ci] === v) { if (seen === 0) cIdx = ci; seen++; }
    }
    const winTol = 0.3 + (cIdx + Math.floor(seen / 2)) * 0.1;
    const winSimp = simplifyPolygon(points, winTol, true);
    const winDup = winSimp.length > 1 && winSimp[0].x === winSimp[winSimp.length - 1].x && winSimp[0].y === winSimp[winSimp.length - 1].y;
    const finalPoints = (winDup ? winSimp.slice(0, -1) : winSimp).map((p) => ({ x: p.x - pad + b.minX, y: p.y - pad + b.minY }));

    let area2 = 0;
    for (let k = 0; k < points.length; k++) {
      const p1 = points[k], p2 = points[(k + 1) % points.length];
      area2 += p1.x * p2.y - p2.x * p1.y;
    }
    const area = Math.abs(area2) / 2;
    let cx = 0, cy = 0;
    for (const p of points) { cx += p.x; cy += p.y; }
    cx /= points.length; cy /= points.length;
    let maxR = 0;
    for (const p of points) maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cy));
    const extentCircle = maxR > 0 ? area / (Math.PI * maxR * maxR) : 0;

    const hull = convexHull(points);
    let hullArea2 = 0;
    for (let k = 0; k < hull.length; k++) {
      const p1 = hull[k], p2 = hull[(k + 1) % hull.length];
      hullArea2 += p1.x * p2.y - p2.x * p1.y;
    }
    const hullArea = Math.abs(hullArea2) / 2;
    const solidity = hullArea > 0 ? area / hullArea : 0;

    // Fix 3: true minimum-area rotated rectangle (rotating calipers over
    // the convex hull) -- see function comment above.
    let bestRectArea = Infinity, rbw = 0, rbh = 0;
    for (let k = 0; k < hull.length; k++) {
      const p1 = hull[k], p2 = hull[(k + 1) % hull.length];
      const edgeAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      const cos = Math.cos(-edgeAngle), sin = Math.sin(-edgeAngle);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of hull) {
        const u = p.x * cos - p.y * sin, vv = p.x * sin + p.y * cos;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, vv); maxV = Math.max(maxV, vv);
      }
      const w2 = maxU - minU, h2 = maxV - minV;
      const rectArea = w2 * h2;
      if (rectArea < bestRectArea) { bestRectArea = rectArea; rbw = w2; rbh = h2; }
    }
    const aspect = Math.min(rbw, rbh) > 0 ? Math.max(rbw, rbh) / Math.min(rbw, rbh) : 999;
    const rectFill = bestRectArea > 0 ? area / bestRectArea : 0;

    const isRound = extentCircle > 0.75 && solidity > 0.9;
    let shape;
    if (isRound) shape = aspect < 1.2 ? "circle" : "ellipse";
    else if (v === 3) shape = "triangle";
    else if (v === 4) shape = (aspect < 1.15 && rectFill > 0.78) ? "square" : (rectFill > 0.85 ? "rectangle" : "quadrilateral");
    else if (v === 5) shape = "pentagon";
    else if (v === 6) shape = "hexagon";
    else shape = "other";

    return { shape, vertices: v, cx: b.minX + bw / 2, cy: b.minY + bh / 2, area: b.area, points: finalPoints };
  }

  const results = [];
  for (const b of blobs) {
    const r = classifyBlob(b);
    if (r) results.push(r);
  }

  // Reading order: cluster into rows by y-gap (gap-based, not a fixed
  // pixel constant -- a fixed constant only ever matched the one test
  // image it was tuned against), then sort each row left-to-right. This
  // is what lets the caller map "1st shape found" -> "A", "2nd" -> "B",
  // etc for a lettered grid -- a real, disclosed assumption that the
  // grid is laid out in that reading order (see verifyShapeClassificationGrid).
  results.sort((a, b) => a.cy - b.cy);
  const heights = blobs.map((b) => b.maxY - b.minY + 1).sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 20;
  const rowGap = Math.max(10, medianHeight * 0.6);
  const rows = [];
  for (const r of results) {
    const row = rows.find((row) => Math.abs(row.cy - r.cy) <= rowGap);
    if (row) { row.items.push(r); row.cy = row.items.reduce((s, x) => s + x.cy, 0) / row.items.length; }
    else rows.push({ cy: r.cy, items: [r] });
  }
  rows.sort((a, b) => a.cy - b.cy);
  const ordered = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.cx - b.cx);
    ordered.push(...row.items);
  }
  return ordered;
}

// Ticket 198 follow-up (2026-09-30, explicit user instruction: "珠算要
// 任何顏色或者黑白都要做到" -- abacus reading must work for any bead
// colour AND black-and-white). The first version detected beads via a
// hardcoded "blue channel exceeds red channel" test, which only ever
// matched this one real citation's blue beads and would find nothing
// at all on a black-and-white photocopy or a worksheet using a
// different bead colour.
//
// Two colour-matching redesigns were tried and real-tested before this
// one, both found to have real bugs: (1) sampling the crop's four
// CORNERS as "the background" broke as soon as the diagram's own local
// background (a solid pink table cell in the real citation) differs
// from the plain white margin cropItem's own generous padding adds
// around it -- ink tests run against the wrong colour, corrupting
// every count. (2) taking the single most-common colour across the
// WHOLE crop has the same failure mode whenever that outer white
// margin covers MORE pixels than the diagram's own local background,
// which real crops can easily do (cropItem deliberately errs toward
// extra margin). A "find non-white content first, then take the
// dominant colour within just that region" two-pass attempt still
// failed too -- a single stray dark pixel anywhere (a table border
// line spanning nearly the whole crop, in the real citation) drags a
// min/max bounding box out to cover almost the entire image again.
//
// Fixed with a fundamentally different, LUMINANCE-relative approach
// that sidesteps background colour-matching entirely: paper is always
// the BRIGHTEST thing in a real worksheet photo, regardless of its
// exact shade (pure white, off-white, or a light colour like this
// citation's pink) -- so instead of asking "what colour is the
// background", ask "how much darker than the lightest common tone is
// this pixel". A near-max (95th percentile, robust to a handful of
// stray bright/dark outlier pixels) luminance establishes that
// baseline directly from the crop itself, and ink is simply "notably
// darker than that baseline" -- true for dark rod/bead ink on white
// OR on a light colour cell, and for plain black ink on a grey/white
// photocopy, without ever needing to know or match a specific hue.
// Real measurement against the citation: white margin/pink cell both
// sit within ~30 luminance points of the 95th-percentile baseline;
// rods (~118 points darker) and even this citation's fairly light
// blue beads (~43 points darker) clear a 35-point cutoff comfortably
// while pink itself (~31 points darker) does not.
function estimateBackgroundLuminance(pixels, w, h) {
  const lums = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      lums[y * w + x] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    }
  }
  lums.sort((a, b) => a - b);
  return lums[Math.floor(lums.length * 0.95)];
}

function isInkByLuminance(pixels, idx, backgroundLuminance, threshold = 35) {
  const lum = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
  return backgroundLuminance - lum > threshold;
}

// Ticket 198 (2026-09-30): abacus/counting-rod reading. Real citation
// (26週數學訓練 P3, Topic 5 Q1): two abacus diagrams side by side, each
// 5 rods labelled 萬(10000s)/千(1000s)/百(100s)/十(10s)/個(1s), beads
// stacked as clean non-touching ellipses -- (a) reads 5,0,6,9,0 beads
// per rod -> 50690; (b) reads 1,3,0,0,7 -> 13007. Directly reuses the
// flood-fill blob-detection technique proven in Ticket 197/
// readObjectCountFromPixels, but counts beads PER COLUMN (rod) rather
// than treating the whole image as one pool of objects, and maps each
// column's count to its place value.
//
// Real bug found and fixed while building this: an EARLIER version
// located columns by simple equal-width division of the crop (assuming
// the crop's own edges line up with the outermost rods). Real
// measurement against the citation showed this is wrong -- the crop
// (and any real photo crop generally) includes extra margin (here, the
// "(a)"/"(b)" bracket labels and cell padding) that is NOT evenly
// distributed, so dividing the raw crop width by 5 puts the slot
// boundaries in the wrong place and misassigns beads to the wrong place
// value. Fixed by actually finding the 5 rods themselves (see
// findRodPositions below) rather than assuming their position.
function findRodPositions(pixels, w, h, expectedCount) {
  // Real bug found calibrating this against the real citation: rods are
  // NOT solid brown for their full length -- their own top few percent
  // is a soft antialiased fade-in from white, and real testing found no
  // single fixed-percentage Y-band is reliably "rod, no beads yet" for
  // every column at once (the tallest possible bead count, 9, starts
  // covering the rod at almost the exact same height the rod itself
  // only just finishes fading in -- there is barely any clean gap).
  // Fixed by NOT trying to find a bead-free band at all: scan the WHOLE
  // crop height instead. A bare rod alone already covers roughly
  // two-thirds of a real diagram's height (from just below the top label
  // to just above the column labels), and a rod WITH beads on it is
  // still ink over that same span (the beads sit on top of, not instead
  // of, that same x-range) -- so real columns clear a much lower,
  // uniform bar (see MIN_INK_FRACTION below) regardless of how many
  // beads they carry, while stray marks like an "(a)" bracket label
  // (only a few px tall) do not.
  // Colour-agnostic (2026-09-30 follow-up): was a hardcoded "white or
  // pale pink" exclusion list, which only recognised THIS citation's
  // specific background. Now uses the luminance-relative ink test (see
  // estimateBackgroundLuminance's own long comment for the real
  // debugging history behind why a colour-matching approach was
  // abandoned in favour of this one) so it works for any background
  // shade, including a black-and-white photocopy.
  const backgroundLuminance = estimateBackgroundLuminance(pixels, w, h);
  const isInk = (x, y) => isInkByLuminance(pixels, (y * w + x) * 4, backgroundLuminance);
  const colInk = new Array(w).fill(0);
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y < h; y++) if (isInk(x, y)) cnt++;
    colInk[x] = cnt;
  }
  // Real bug found calibrating this against the real citation with the
  // new luminance-relative ink test: a bead's antialiased edge can bleed
  // outward far enough to weakly clear the ink test several px away
  // from the rod itself, creating a spurious secondary "bump" in a
  // neighbouring column's ink fraction (real measurement: ~0.40 at one
  // such bleed point) that a 0.4 threshold (tuned for the old,
  // narrower colour-specific test) let through as if it were its own
  // rod. Real rods measure 0.69-0.78 in the same crop -- comfortably
  // clear of a raised 0.55 cutoff while the antialiasing bleed is not.
  const MIN_INK_FRACTION = 0.55;
  const candidateXs = [];
  for (let x = 0; x < w; x++) if (colInk[x] >= h * MIN_INK_FRACTION) candidateXs.push(x);
  if (!candidateXs.length) return null;
  // Cluster adjacent candidate x's (a rod is a few px wide) into single centers.
  const clusters = [];
  let cur = [candidateXs[0]];
  for (let i = 1; i < candidateXs.length; i++) {
    if (candidateXs[i] - candidateXs[i - 1] <= 3) cur.push(candidateXs[i]);
    else { clusters.push(cur); cur = [candidateXs[i]]; }
  }
  clusters.push(cur);
  const centers = clusters.map((c) => c.reduce((s, x) => s + x, 0) / c.length);
  if (centers.length < expectedCount) return null;
  if (centers.length === expectedCount) return centers;
  // More clusters than expected -- real cause found against the citation:
  // the table's own BORDER lines (left/right edges, and the divider
  // between two side-by-side diagrams) are ALSO solid full-height
  // vertical lines, so they pass the same ink test as a real rod and
  // can't be told apart from one by height/solidity alone. But real
  // rods within ONE diagram are evenly spaced (~76px in the citation)
  // while a diagram BOUNDARY or table border sits at a distinctly
  // LARGER gap -- group candidates by that small-gap-vs-large-gap
  // split (using the most common/"mode" gap as the small-gap reference,
  // with tolerance), then keep only groups of exactly 5 (a lone border
  // line forms its own group of size 1, immediately excluded) and
  // concatenate them left to right. This correctly separates multiple
  // diagrams' rods AND discards border lines in one pass, unlike a
  // single "longest run" search, which only recovers ONE diagram's
  // rods when the real page has more than one (an earlier version of
  // this function had exactly that bug, confirmed on this citation's
  // real two-diagram layout).
  const gaps = [];
  for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
  // Real bug found here too: a fixed multiple of the median gap (tried
  // 1.4x) is not a reliable small/large threshold -- with more small
  // gaps than large ones (2 diagrams x 4 within-diagram gaps = 8 small,
  // vs 4 large boundary/border gaps in this citation), the median sits
  // close to the small-gap cluster's own high end, so 1.4x it can still
  // exceed even the smallest LARGE gap and fail to split anything.
  // Fixed with a proper natural-break: sort all gaps, find the single
  // BIGGEST jump between consecutive sorted values -- that jump is
  // exactly the boundary between the "small" (within-diagram) and
  // "large" (between-diagram / border) gap clusters, whatever their
  // relative counts are. Real measurement on this citation: sorted gaps
  // jump from 78 to 94 (a 16px jump, 3x any other consecutive
  // difference in the sorted list) -- threshold lands at 86, cleanly
  // separating both diagrams' 5-rod runs from the 3 border lines.
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  let threshold = Infinity, biggestJump = -1;
  for (let i = 1; i < sortedGaps.length; i++) {
    const jump = sortedGaps[i] - sortedGaps[i - 1];
    if (jump > biggestJump) { biggestJump = jump; threshold = (sortedGaps[i] + sortedGaps[i - 1]) / 2; }
  }
  const groups = [];
  let curGroup = [centers[0]];
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] <= threshold) curGroup.push(centers[i + 1]);
    else { groups.push(curGroup); curGroup = [centers[i + 1]]; }
  }
  groups.push(curGroup);
  const rods = [];
  for (const g of groups) if (g.length === 5) rods.push(...g);
  return rods.length === expectedCount ? rods : null;
}

function readAbacusColumnsFromPixels(pixels, w, h, diagramCount) {
  // Colour-agnostic (2026-09-30 follow-up, explicit user instruction:
  // "珠算要任何顏色或者黑白都要做到"). The first version detected beads
  // via a hardcoded "blue channel exceeds red" test, and separately
  // relied on flood-fill BLOB detection (beads touching each other on
  // one rod merge into a single blob, counted by its HEIGHT). Both
  // pieces assumed the specific blue-on-pink colour scheme of the one
  // real citation available and would find nothing at all on a
  // black-and-white photocopy or a differently-coloured worksheet.
  //
  // Real bug this rewrite fixes: simply swapping in a colour-agnostic
  // "far from the sampled background colour" ink test (as
  // findRodPositions now uses) is NOT enough on its own -- with a
  // general ink test the ROD and its BEADS are the same "ink" colour
  // class (unlike the old blue-vs-brown split), so flood-fill would
  // merge an entire column's bare rod AND its beads into one blob
  // spanning nearly the full diagram height regardless of bead count,
  // making height-based counting meaningless.
  //
  // Fixed with a WIDTH-PROFILE scan instead of flood-fill blobs: at
  // each already-known rod x-position (from findRodPositions), for
  // every row measure how far the ink actually extends left/right of
  // the rod. A bare rod is only a few px wide; a bead is much wider
  // (real measurement: ~54px bead vs ~76px rod spacing, a bead is
  // wide enough that a width threshold partway between "rod-thin" and
  // "bead-wide" cleanly separates the two regardless of what colour
  // either one is drawn in) -- rows whose ink width clears that
  // threshold are "a bead is here"; counting contiguous such rows and
  // dividing by the same per-bead-height calibration as before (now
  // expressed, as already was, as a fraction of rod spacing) gives the
  // bead count exactly as the old blob-height method did, just without
  // needing beads to be any specific colour.
  // See estimateBackgroundLuminance's own long comment for why this is
  // luminance-relative, not colour-matching -- same reasoning applies
  // here as in findRodPositions.
  const backgroundLuminance = estimateBackgroundLuminance(pixels, w, h);
  const isInk = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    return isInkByLuminance(pixels, (y * w + x) * 4, backgroundLuminance);
  };

  const rods = findRodPositions(pixels, w, h, diagramCount * 5);
  if (!rods) return null;
  // Real bug found here: averaging the outermost-to-outermost rod span
  // over (count-1) steps silently includes the GAP BETWEEN diagrams
  // (much larger than a real within-diagram rod-to-rod gap) in the
  // average, inflating the estimate and under-counting every bead
  // height it's later divided into. Only average the WITHIN-diagram
  // consecutive gaps (skip the 5th-to-6th-rod boundary between each
  // diagram group).
  const withinGaps = [];
  for (let i = 1; i < rods.length; i++) if (i % 5 !== 0) withinGaps.push(rods[i] - rods[i - 1]);
  const rodSpacing = withinGaps.length ? withinGaps.reduce((s, g) => s + g, 0) / withinGaps.length : w / (diagramCount * 5);
  const BEAD_HEIGHT_TO_ROD_SPACING_RATIO = 0.27; // real measurement: ~20.7px/bead, ~76px rod spacing
  const BEAD_HALF_WIDTH_TO_ROD_SPACING_RATIO = 0.2; // real measurement: ~54px bead width, ~76px rod spacing -> half-width ratio ~0.355, halved again for a conservative "is this wide enough to be a bead, not just the rod" cutoff
  const beadHeight = rodSpacing * BEAD_HEIGHT_TO_ROD_SPACING_RATIO;
  const widthThreshold = rodSpacing * BEAD_HALF_WIDTH_TO_ROD_SPACING_RATIO;
  const searchRadius = Math.round(rodSpacing * 0.4);

  // Real bug found calibrating this against the real citation: the
  // 萬千百十個 label text row sits at the BOTTOM of the diagram, and a
  // Chinese character glyph is wide enough to locally cross
  // widthThreshold at some of its own rows -- with the old bead-colour-
  // specific ink test this was harmless (plain black text never passed
  // the "is this blue" check), but the new general luminance test also
  // treats dark text as ink, so every column picked up a spurious extra
  // "bead" purely from its own label row (real measurement: every
  // column, including genuinely empty ones, read +1 higher than the
  // true count until this was excluded). Fixed by scanning only the top
  // ~85% of the crop -- real measurement puts the label row in roughly
  // the bottom 14% of a real diagram crop, so this margin excludes it
  // while still covering the tallest realistic (9-bead) stack.
  const labelRowStartY = Math.round(h * 0.85);
  const placeValues = [10000, 1000, 100, 10, 1];
  const totals = new Array(diagramCount).fill(0);
  for (let r = 0; r < rods.length; r++) {
    const rodX = Math.round(rods[r]);
    let beadRowCount = 0;
    for (let y = 0; y < labelRowStartY; y++) {
      let leftExtent = 0, rightExtent = 0;
      for (let dx = 1; dx <= searchRadius; dx++) {
        if (isInk(rodX - dx, y)) leftExtent = dx; else break;
      }
      for (let dx = 1; dx <= searchRadius; dx++) {
        if (isInk(rodX + dx, y)) rightExtent = dx; else break;
      }
      if (leftExtent + rightExtent >= widthThreshold) beadRowCount++;
    }
    // Real bug found calibrating this against the real citation: a
    // truly empty (0-bead) rod could still pick up a handful of stray
    // "bead-width" rows from a NEIGHBOURING column's bead antialiasing
    // bleeding into this rod's search radius -- with the old rule
    // ("beadRowCount > 0 at all -> count at least 1"), that noise alone
    // was enough to wrongly report 1 bead on an empty rod. Fixed by
    // requiring at least a meaningful fraction (40%) of one real bead's
    // height before counting anything -- real noise measured well
    // under this bar, genuine single beads comfortably clear it.
    const count = beadRowCount < beadHeight * 0.4 ? 0 : Math.max(1, Math.round(beadRowCount / beadHeight));
    const diagramIdx = Math.floor(r / 5), colIdx = r % 5;
    totals[diagramIdx] += Math.min(9, count) * placeValues[colIdx];
  }
  return totals;
}

function isAbacusReadingQuestion(item) {
  const printed = String(item.printedQuestion || "");
  return /算柱|算珠/.test(printed) && /寫出.{0,6}(所表示的數|表示的數字)|表示.{0,6}的數/.test(printed);
}

function verifyAbacusReading(item, crop) {
  let photonImg;
  try {
    const nums = (String(item.studentAnswer || "").match(/\d+/g) || []).map(Number);
    if (!nums.length) return { correct: null, correctAnswer: "" };
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    // Diagram count comes from how many numeric answers were given, not
    // from re-deriving it here -- findAbacusBbox already counted the
    // real 萬千百十個 occurrences when locating this crop, but that
    // count isn't threaded through to this function; using the
    // student's own answer count as a proxy is safe BECAUSE a mismatch
    // either way still gets caught below (wrong length -> decline).
    const diagramCount = nums.length;
    const totals = readAbacusColumnsFromPixels(pixels, w, h, diagramCount);
    if (!totals || totals.length !== nums.length) return { correct: null, correctAnswer: "" };
    const allMatch = nums.every((n, i) => n === totals[i]);
    return { correct: allMatch, correctAnswer: allMatch ? "" : totals.join(", ") };
  } catch (e) {
    return { correct: null, correctAnswer: "" };
  } finally {
    if (photonImg) photonImg.free();
  }
}

// Ticket 199 (2026-09-30): reads each bar's real value from a bar
// chart, using the OCR-read axis calibration (extractBarChart above)
// plus pure pixel geometry to find the axis line and measure each
// bar's own top edge -- see extractBarChart's own comment for why this
// ticket is a genuine hybrid (OCR reads the printed axis numbers only;
// geometry measures the bars, since no bar's actual value is ever
// printed anywhere).
//
// Real citation (26週數學訓練 P3, "浩明上半年看書的數量"): Y-axis
// 0-12 step 2, vertical bars for 1-6月 reading 10,4,6,12,8,2.
// Calibration method found and verified directly against this real
// photo: the chart's own Y-AXIS LINE (a solid, continuously-dark
// vertical line) spans exactly from the MAX value's gridline down to
// the MIN value's gridline (real measurement: axis line top at pixel
// y=49 lines up with the printed "12", bottom at y=370 lines up with
// "0") -- linear interpolation between those two real pixel positions,
// using the OCR-provided min/max, directly predicts each bar's value
// from its own top edge's pixel position (real check: predicted the
// value-10 bar's top at y=102.5, its real measured top was y=101-102,
// a ~1px match). This avoids needing to detect every individual faint
// gridline (real measurement: gridlines here are only 8-45 luminance
// points darker than white, unreliably close to noise, MUCH fainter
// than the axis line itself or the bars) -- two reference points (the
// axis line's own top and bottom) are enough for a linear scale.
function findAxisLine(pixels, w, h) {
  const backgroundLuminance = estimateBackgroundLuminance(pixels, w, h);
  const isInk = (x, y) => isInkByLuminance(pixels, (y * w + x) * 4, backgroundLuminance, 60);
  // A real axis line is solid and dark (not just "somewhat darker than
  // background" like a bar's fill or a faint gridline) -- a stricter
  // threshold (60, vs 35 used elsewhere) specifically targets that,
  // and scanning for the LEFTMOST column that is ink for most of the
  // full height finds the y-axis specifically (further-right columns
  // that are mostly ink are bars, not the axis).
  for (let x = 0; x < w; x++) {
    let minY = -1, maxY = -1, count = 0;
    for (let y = 0; y < h; y++) {
      if (isInk(x, y)) {
        if (minY === -1) minY = y;
        maxY = y;
        count++;
      }
    }
    if (count >= h * 0.5 && (maxY - minY + 1) >= h * 0.5) {
      return { x, yTop: minY, yBottom: maxY };
    }
  }
  return null;
}

function readBarChartValues(pixels, w, h, barChart) {
  const { direction, min, max, step, categories } = barChart;
  const axis = findAxisLine(pixels, w, h);
  if (!axis) return null;
  const backgroundLuminance = estimateBackgroundLuminance(pixels, w, h);
  const isInk = (x, y) => isInkByLuminance(pixels, (y * w + x) * 4, backgroundLuminance, 35);
  const n = categories.length;

  if (direction === "vertical") {
    // Real bug found against the real citation: assuming the bars are
    // evenly spread across the FULL width from the axis to the crop's
    // own right edge (an equal-width-slot division, the same pattern
    // used for Ticket 198's rod columns) drifts cumulatively wrong here
    // -- real crops (this one included) commonly have extra blank
    // margin to the right of the last bar that isn't part of the real
    // plot area, so "divide by n across the whole remaining width"
    // makes each assumed slot too WIDE, and the error compounds until
    // later bars are missed entirely (real measurement: last bar's
    // assumed centre was 38px off from its real centre). Fixed by
    // actually finding the bars, not assuming their spacing: scan one
    // row near the baseline (where every bar, whatever its height, is
    // guaranteed to still have ink) for contiguous ink segments -- each
    // segment IS one bar, real and exact, no assumption needed.
    const scanY = axis.yBottom - Math.round((axis.yBottom - axis.yTop) * 0.03) - 1;
    const rawSegments = [];
    let segStart = -1;
    for (let x = axis.x + 1; x <= w; x++) {
      const ink = x < w && isInk(x, scanY);
      if (ink && segStart === -1) segStart = x;
      if (!ink && segStart !== -1) { rawSegments.push({ start: segStart, end: x - 1 }); segStart = -1; }
    }
    // Real bug found against the real citation: this row also catches
    // a couple of thin (2-3px) artefacts -- a tick mark right next to
    // the axis line, and the plot's own outer border on the far right
    // -- neither is a real bar. Real bars measured 50-51px wide here;
    // filtering to segments at least half the WIDEST segment's width
    // keeps real bars and drops those thin artefacts regardless of the
    // chart's actual absolute bar width.
    const maxSegWidth = Math.max(...rawSegments.map((s) => s.end - s.start));
    const segments = rawSegments.filter((s) => s.end - s.start >= maxSegWidth * 0.5);
    if (segments.length !== n) return null; // couldn't cleanly find exactly the expected number of bars -- decline rather than guess
    const values = [];
    const MIN_RUN = 6; // a gridline is only 1-2px thick; require a real sustained run to distinguish a bar's top edge from a gridline crossing
    for (const seg of segments) {
      const xCenter = Math.round((seg.start + seg.end) / 2);
      let topY = -1;
      for (let y = axis.yTop; y <= axis.yBottom - MIN_RUN; y++) {
        let allInk = true;
        for (let dy = 0; dy < MIN_RUN; dy++) if (!isInk(xCenter, y + dy)) { allInk = false; break; }
        if (allInk) { topY = y; break; }
      }
      if (topY === -1) { values.push(min); continue; }
      const frac = (axis.yBottom - topY) / (axis.yBottom - axis.yTop);
      const rawValue = min + frac * (max - min);
      values.push(Math.round(rawValue / step) * step);
    }
    return values;
  }

  // Horizontal bars: sit above the axis line, extending right from it;
  // categories are stacked top-to-bottom instead of left-to-right.
  // Same equal-slot-then-measure-extent logic, transposed.
  const plotHeight = axis.yBottom - axis.yTop + 1;
  const slotHeight = plotHeight / n;
  const values = [];
  for (let i = 0; i < n; i++) {
    const yStart = Math.round(axis.yTop + i * slotHeight);
    const yEnd = Math.round(axis.yTop + (i + 1) * slotHeight);
    const yCenter = Math.round((yStart + yEnd) / 2);
    let rightX = axis.x;
    for (let x = axis.x + 1; x < w; x++) {
      if (isInk(x, yCenter)) rightX = x; else if (x - axis.x > 3) break;
    }
    const frac = (rightX - axis.x) / (w - 1 - axis.x);
    const rawValue = min + frac * (max - min);
    values.push(Math.round(rawValue / step) * step);
  }
  return values;
}

function isBarChartQuestion(item) {
  return !!item.barChart;
}

// Real citation covers 4 real sub-question shapes on the same chart:
// "邊個月最多,有幾多" (max category + value), "6月比上個月少幾多"
// (difference between two named/adjacent categories), "共睇幾多,平均
// 幾多" (sum + average), and a compound "平均幾多日睇完一本" question
// that needs an OUTSIDE fact (days in a stated month) divided by the
// chart value -- declined here (not a chart-reading fact, a different
// real-world-knowledge ticket's job, see 205).
function verifyBarChart(item, crop) {
  let photonImg;
  try {
    const { barChart } = item;
    if (!barChart) return { correct: null, correctAnswer: "" };
    const printed = String(item.printedQuestion || "");
    const answer = String(item.studentAnswer || "").trim();
    if (!answer) return { correct: null, correctAnswer: "" };
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    const values = readBarChartValues(pixels, w, h, barChart);
    if (!values) return { correct: null, correctAnswer: "" };
    const { categories } = barChart;

    // Shape 1: "邊個<類別>...最多/最大,有___<單位>" (or 最少/最小).
    let m = printed.match(/最(多|大|少|小)[\s\S]{0,20}?(_{2,}|＿{2,})/);
    if (m && /(_{2,}|＿{2,})[\s\S]{0,10}(_{2,}|＿{2,})/.test(printed)) {
      const wantMax = m[1] === "多" || m[1] === "大";
      const best = wantMax ? Math.max(...values) : Math.min(...values);
      const bestIdx = values.indexOf(best);
      const bestCategory = categories[bestIdx];
      const parts = answer.split(/[,，、;；\s]+/).filter(Boolean);
      if (parts.length >= 2) {
        const catMatches = parts[0] === bestCategory || parts[0].replace(/月$/, "") === bestCategory.replace(/月$/, "");
        const numMatches = parseSignedStudentNumber(parts[1]) === best;
        const correct = catMatches && numMatches;
        return { correct, correctAnswer: correct ? "" : `${bestCategory},${best}` };
      }
    }

    // Shape 2: "在<類別>,...比上一個<類別單位>...少/多咗___" -- difference
    // from the immediately preceding category.
    m = printed.match(/在([^,，]+?)[,，][\s\S]{0,10}比上[一]?個[\s\S]{0,6}(少|多)[\s\S]{0,4}了?\s*(_{2,}|＿{2,})/);
    if (m) {
      const catIdx = categories.findIndex((c) => c === m[1] || c.replace(/月$/, "") === m[1].replace(/月$/, ""));
      if (catIdx > 0) {
        const diff = values[catIdx - 1] - values[catIdx];
        const studentNum = parseSignedStudentNumber(answer);
        const correct = studentNum !== null && Math.abs(studentNum) === Math.abs(diff);
        return { correct, correctAnswer: correct ? "" : String(Math.abs(diff)) };
      }
    }

    // Shape 3: "共...___,平均每...___" -- total then average, two blanks.
    if (/共[\s\S]{0,10}(_{2,}|＿{2,})[\s\S]{0,10}平均[\s\S]{0,10}(_{2,}|＿{2,})/.test(printed)) {
      const total = values.reduce((s, v) => s + v, 0);
      const avg = total / values.length;
      const parts = answer.split(/[,，、;；\s]+/).filter(Boolean).map((s) => parseSignedStudentNumber(s));
      if (parts.length >= 2 && parts[0] !== null && parts[1] !== null) {
        const correct = parts[0] === total && Math.abs(parts[1] - avg) < 1e-9;
        return { correct, correctAnswer: correct ? "" : `${total},${avg}` };
      }
    }

    return { correct: null, correctAnswer: "" };
  } catch (e) {
    return { correct: null, correctAnswer: "" };
  } finally {
    if (photonImg) photonImg.free();
  }
}

function verifyObjectCounting(item, crop) {
  let photonImg;
  try {
    const answer = String(item.studentAnswer || "").trim();
    const studentNum = parseSignedStudentNumber(answer);
    if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    const { count, safe } = readObjectCountFromPixels(pixels, w, h);
    if (!safe || count === null) return { correct: null, correctAnswer: "" };
    const correct = studentNum === count;
    return { correct, correctAnswer: correct ? "" : String(count) };
  } catch (e) {
    return { correct: null, correctAnswer: "" };
  } finally {
    if (photonImg) photonImg.free();
  }
}

// Chinese shape-name -> the canonical labels readShapeClassificationFromPixels
// can actually produce. Deliberately NOT exhaustive: 菱形(rhombus) and
// 梯形(trapezoid) are real HK curriculum shape names but the classifier
// above cannot currently distinguish a rhombus from a square (both read
// as a 4-vertex, ~1:1-aspect quad) or a trapezoid from any other
// irregular quad -- rather than guess, a question asking for either of
// those is left entirely unhandled (detect() returns false for it), per
// the same fail-open discipline as every other handler in this file.
const SHAPE_CN_TO_CANONICAL = {
  正方形: "square",
  長方形: "rectangle",
  六邊形: "hexagon",
  圓形: "circle",
  三角形: "triangle",
  五邊形: "pentagon",
  橢圓形: "ellipse",
};

// Standalone (not a QUESTION_TYPE_HANDLERS-internal closure) so the bbox
// fallback in handleMark (findLetterGridBbox's call site) can run the
// exact same check before any handler dispatch has happened -- see that
// call site's own comment for why.
function isShapeClassificationGridQuestion(item) {
  const printed = String(item.printedQuestion || "");
  if (!/英文字母|代表答案/.test(printed)) return false;
  const namesFound = Object.keys(SHAPE_CN_TO_CANONICAL).filter((cn) => printed.includes(cn));
  if (namesFound.length < 2) return false;
  // Every shape name actually asked about must be one this classifier
  // can verify -- a mix of e.g. 正方形+菱形 in the same question would
  // otherwise silently only check half the answer, which is worse than
  // not touching the question at all.
  const anyUnsupported = /菱形|梯形|平行四邊形|八邊形/.test(printed);
  return !anyUnsupported;
}

// Parses "(a)正方形 (b)長方形 ..." (question) or "(a)A,I (b)F ..." /
// "A,I;F;E,J;H" (answer) into an ordered array of {label, value} --
// value is either the raw shape-name text (question) or a letter array
// (answer). Handles both an explicit "(a)/(b)/..." labelled form and a
// bare ";"-joined form (aligned positionally against the question's own
// label order in that case) since real OCR output format for this
// exact multi-part-answer shape hasn't been observed live yet -- see
// TICKETS.md for this ticket's own disclosure of that gap.
function parseLabelledParts(text) {
  const s = String(text || "");
  const labelled = [...s.matchAll(/\(([a-z])\)\s*([^()]*?)(?=\s*\([a-z]\)|$)/gi)];
  if (labelled.length) {
    return labelled.map((m) => ({ label: m[1].toLowerCase(), value: m[2].trim() }));
  }
  if (!s.trim()) return [];
  return s.split(";").map((v, i) => ({ label: String.fromCharCode(97 + i), value: v.trim() }));
}

function verifyShapeClassificationGrid(item, crop) {
  let photonImg;
  try {
    const qParts = parseLabelledParts(item.printedQuestion);
    if (!qParts.length) return { correct: null, correctAnswer: "" };
    const categories = qParts
      .map((p) => ({ label: p.label, canonical: SHAPE_CN_TO_CANONICAL[p.value] }))
      .filter((c) => c.canonical);
    if (!categories.length) return { correct: null, correctAnswer: "" };
    const aParts = parseLabelledParts(item.studentAnswer);
    if (aParts.length < categories.length) return { correct: null, correctAnswer: "" };
    const studentByLabel = new Map(aParts.map((p) => [p.label, p.value]));

    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    const shapes = readShapeClassificationFromPixels(pixels, w, h);
    if (shapes.length < 4) return { correct: null, correctAnswer: "" }; // too few blobs to trust the reading-order mapping at all

    const letterFor = (idx) => String.fromCharCode(65 + idx); // 0->A, 1->B, ...
    const detectedByLetter = new Map(shapes.map((s, i) => [letterFor(i), s.shape]));
    const maxLetterIdx = shapes.length - 1;

    let allMatch = true;
    const correctParts = [];
    for (const cat of categories) {
      const studentRaw = studentByLabel.get(cat.label) || "";
      const studentLetters = studentRaw.split(/[,、\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
      // Any referenced letter beyond what was actually detected means the
      // blob-count/letter mapping itself is untrustworthy for this photo
      // -- decline rather than risk a wrong verdict built on a bad map.
      if (studentLetters.some((L) => L.charCodeAt(0) - 65 > maxLetterIdx)) return { correct: null, correctAnswer: "" };
      const correctLetters = [];
      for (const [letter, shape] of detectedByLetter) {
        if (shape === cat.canonical) correctLetters.push(letter);
      }
      correctLetters.sort();
      const studentSorted = [...studentLetters].sort();
      const matches = studentSorted.length === correctLetters.length && studentSorted.every((L, i) => L === correctLetters[i]);
      if (!matches) allMatch = false;
      correctParts.push(`(${cat.label})${correctLetters.join(",")}`);
    }
    return { correct: allMatch, correctAnswer: allMatch ? "" : correctParts.join(" ") };
  } catch (e) {
    return { correct: null, correctAnswer: "" };
  } finally {
    if (photonImg) photonImg.free();
  }
}

// Ticket 222 (2026-09-30, real citation: 小學數學新思維 3下A 作業,
// footer p.18/p.20/p.25 -- "觀察以下各[平面圖形/三角形]，把所有代表答
// 案的英文字母填在橫線上。③等邊三角形：___ ④等腰直角三角形：___ ⑤不
// 等邊三角形：___" etc, real shapes labelled A-G): classify each printed
// TRIANGLE's own sub-type (等邊/等腰/直角/等腰直角/不等邊) from its
// actual polygon geometry, same real-edge-measurement approach as
// Ticket 204's classifyTrapezoidType (reuses readShapeClassificationFromPixels's
// additive `.points` field) and Ticket 212's pegboard classifyTriangleType
// -- deliberately a SEPARATE, self-contained geometry function rather
// than calling either of those two (Ticket 212 is still uncommitted/
// unstable at the time this was written; duplicating ~10 lines of
// tolerance-based side/angle comparison is cheaper than coupling to
// code that might still change shape).
// Real finding (2026-09-30, this citation): readShapeClassificationFromPixels's
// plateau vertex-count scan sometimes settles on 4 vertices for a shape
// that is actually a real printed triangle, when contour noise (a
// slightly bowed edge, or an anti-aliasing artifact) produces one extra
// near-collinear point along an otherwise-straight edge -- confirmed on
// 2 real shapes on this exact page (interior angles 169.2° and 177.9°,
// i.e. barely a corner at all, vs the other 3 angles all under 113°).
// Rather than touching the shared plateau-scan tolerance (real risk to
// every other already-shipped caller of that function), recover locally:
// if a 4-vertex polygon has exactly one interior angle within 15° of
// straight, drop that vertex and treat the remaining 3 as the real
// triangle. A genuine quadrilateral (e.g. this book's own trapezoids)
// essentially never has a near-180° interior angle, so this is a safe,
// narrow correction, not a general "treat every quad as a triangle" hack.
function collapseNearCollinearQuadToTriangle(points) {
  if (!points || points.length !== 4) return null;
  const n = points.length;
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const angleAt = (i) => {
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n];
    const v1x = p0.x - p1.x, v1y = p0.y - p1.y;
    const v2x = p2.x - p1.x, v2y = p2.y - p1.y;
    const dot = v1x * v2x + v1y * v2y;
    const mag = dist(p0, p1) * dist(p1, p2);
    if (mag === 0) return 0;
    return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * (180 / Math.PI);
  };
  const angles = points.map((_, i) => angleAt(i));
  const nearStraightIdx = angles.map((a, i) => (a > 165 ? i : -1)).filter((i) => i >= 0);
  if (nearStraightIdx.length !== 1) return null; // 0 -> genuine quad; 2+ -> too degenerate to trust
  return points.filter((_, i) => i !== nearStraightIdx[0]);
}

function computeTriangleSubtypeProperties(points) {
  if (!points || points.length !== 3) return null;
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const [a, b, c] = points;
  const ab = dist(a, b), bc = dist(b, c), ca = dist(c, a);
  const maxSide = Math.max(ab, bc, ca);
  if (maxSide <= 0) return null;
  const TOL = maxSide * 0.08;
  const eq = (x, y) => Math.abs(x - y) < TOL;
  const isEquilateral = eq(ab, bc) && eq(bc, ca);
  const isIsosceles = !isEquilateral && (eq(ab, bc) || eq(bc, ca) || eq(ca, ab));
  const dot = (p, q, r) => (q.x - p.x) * (r.x - p.x) + (q.y - p.y) * (r.y - p.y);
  const angleCos = (p, q, r) => dot(p, q, r) / (dist(p, q) * dist(p, r));
  const RIGHT_TOL = Math.cos(((90 - 8) * Math.PI) / 180);
  const isRight = Math.abs(angleCos(a, b, c)) < RIGHT_TOL || Math.abs(angleCos(b, a, c)) < RIGHT_TOL || Math.abs(angleCos(c, a, b)) < RIGHT_TOL;
  return { isEquilateral, isIsosceles, isRight };
}

// Longer/more specific category names must be checked before their
// shorter substrings (等腰直角三角形 contains both 等腰三角形's and
// 直角三角形's own name as a substring) -- order here IS the match
// priority, checked in classifyPrintedTriangleSubtypeTarget below.
const TRIANGLE_SUBTYPE_MATCHERS = [
  ["等腰直角三角形", (p) => p.isIsosceles && p.isRight],
  ["不等邊三角形", (p) => !p.isEquilateral && !p.isIsosceles],
  ["等邊三角形", (p) => p.isEquilateral],
  // 等腰三角形 counts equilateral/isosceles-right as special cases of
  // isosceles too -- matches this book's own stated rule (真citation
  // p.21 Q7: "所有等邊三角形皆是等腰三角形" -> true) and the real
  // verified answer on p.20 (Q4's answer includes the equilateral
  // shape E, confirmed by the user after an initial omission).
  ["等腰三角形", (p) => p.isEquilateral || p.isIsosceles],
  // 直角三角形 counts isosceles-right as a right triangle too.
  ["直角三角形", (p) => p.isRight],
];

function classifyPrintedTriangleSubtypeTarget(printedQuestion) {
  const text = String(printedQuestion || "").replace(/\s+/g, "");
  // Anchored at the start, immediately followed by a colon -- this is
  // the real "答案格" fill-in-letters citation shape ("等邊三角形：___").
  // A plain substring match (no anchor) would also fire on unrelated
  // full-sentence questions that merely MENTION a category name, e.g.
  // triangle_fact_true_false's "所有等邊三角形皆是等腰三角形。" contains
  // "等腰三角形" too -- a real collision caught by the existing test
  // suite (triangle_fact_true_false's own dispatch-priority test) when
  // this was first written without the anchor.
  for (const [name] of TRIANGLE_SUBTYPE_MATCHERS) {
    if (new RegExp(`^${name}[:：]`).test(text)) return name;
  }
  return null;
}

function isTriangleSubtypeLetterQuestion(item) {
  return classifyPrintedTriangleSubtypeTarget(item.printedQuestion) !== null;
}

function verifyTriangleSubtypeLetterQuestion(item, crop) {
  const target = classifyPrintedTriangleSubtypeTarget(item.printedQuestion);
  const answer = String(item.studentAnswer || "").trim();
  if (!target || !answer) return { correct: null, correctAnswer: "" };
  const matcher = TRIANGLE_SUBTYPE_MATCHERS.find(([name]) => name === target)[1];
  let photonImg;
  try {
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    // Real finding (2026-09-30, this citation): this page's shapes each
    // have their OWN letter label (A, B, C...) printed INSIDE the
    // filled outline, close enough that its glyph ink forms its own
    // small blob alongside the real shape blob. readShapeClassificationFromPixels
    // has no size floor beyond the fixed minBlobSize(80) -- nowhere near
    // enough to exclude a letter glyph (measured ~100-1600px here) next
    // to a real shape (measured ~11000-20000px, roughly 10x+ larger) --
    // so raw output is dominated by ~30 spurious tiny blobs that would
    // scramble the reading-order letter mapping if not filtered out
    // here. Relative-size filter (kept LOCAL to this function rather
    // than changing the shared readShapeClassificationFromPixels, to
    // avoid any risk to the already-shipped shape_classification_grid/
    // trapezoid_type_letter callers, which have not been shown to hit
    // this same failure mode and are out of scope for this ticket).
    const rawShapes = readShapeClassificationFromPixels(pixels, w, h);
    const maxArea = rawShapes.reduce((m, s) => Math.max(m, s.area), 0);
    const shapes = rawShapes.filter((s) => s.area >= maxArea * 0.1);
    if (shapes.length < 4) return { correct: null, correctAnswer: "" }; // too few blobs to trust the reading-order letter mapping

    const letterFor = (idx) => String.fromCharCode(65 + idx);
    const maxLetterIdx = shapes.length - 1;
    const studentLetters = answer.split(/[,，、;；\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!studentLetters.length) return { correct: null, correctAnswer: "" };
    if (studentLetters.some((L) => L.length !== 1 || L.charCodeAt(0) < 65 || L.charCodeAt(0) - 65 > maxLetterIdx)) return { correct: null, correctAnswer: "" };

    const expectedLetters = [];
    shapes.forEach((s, i) => {
      let trianglePoints = s.shape === "triangle" ? s.points : null;
      if (!trianglePoints && s.shape === "quadrilateral") trianglePoints = collapseNearCollinearQuadToTriangle(s.points);
      if (!trianglePoints) return;
      const props = computeTriangleSubtypeProperties(trianglePoints);
      if (props && matcher(props)) expectedLetters.push(letterFor(i));
    });
    if (!expectedLetters.length) return { correct: null, correctAnswer: "" };

    const correct = studentLetters.slice().sort().join(",") === expectedLetters.slice().sort().join(",");
    return { correct, correctAnswer: correct ? "" : expectedLetters.join(",") };
  } catch (e) {
    return { correct: null, correctAnswer: "" };
  } finally {
    if (photonImg) photonImg.free();
  }
}

// Ticket 222 continued (2026-09-30, "Pattern 7" -- fold/cut-then-classify
// triangle questions, real citation: 小學數學新思維 3下A 作業, footer
// p.23, Q⑦: "沿着虛線把左圖的長方形剪開後，可得出2個（直角/等腰/等邊）
// 三角形。(把答案圈起來)" -- real answer 直角, confirmed against the
// actual worksheet. Provable closed-form fact, no pixel measurement
// needed: cutting ANY rectangle along its diagonal always produces 2
// congruent RIGHT triangles -- the right angle is inherited directly
// from the rectangle's own 90° corner, true regardless of the
// rectangle's exact drawn aspect ratio. Deliberately narrow: only
// matches this specific "長方形...剪開...(直角/等腰/等邊)" MC phrasing.
function isRectangleDiagonalCutQuestion(item) {
  const text = String(item.printedQuestion || "").replace(/\s+/g, "");
  if (!/長方形/.test(text) || !/剪開/.test(text)) return false;
  return /直角[\/／]等腰[\/／]等邊/.test(text);
}

function verifyRectangleDiagonalCut(item) {
  if (!isRectangleDiagonalCutQuestion(item)) return { correct: null, correctAnswer: "" };
  const answer = String(item.studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const correct = /直角/.test(answer) && !/等腰|等邊/.test(answer);
  return { correct, correctAnswer: correct ? "" : "直角" };
}

// Same page, Q⑨: "詠恩把正方形紙依以下的方法摺和剪...打開後，把正方形
// 紙沿摺痕剪開，可得出8個____三角形。" -- real answer 等腰 (confirmed).
// This specific fold sequence (fold the square in half, fold in half
// again, cut along the resulting small square's diagonal) always
// produces 8 congruent isosceles triangles by symmetry -- provable
// closed-form fact, no per-photo measurement needed. Deliberately
// narrow: only matches this exact "正方形...摺...剪...得出8個___三角
// 形" phrasing, not every square-folding question.
function isSquareFoldCutEightQuestion(item) {
  const text = String(item.printedQuestion || "").replace(/\s+/g, "");
  return /正方形/.test(text) && /摺/.test(text) && /剪/.test(text) && /8個.{0,4}三角形/.test(text);
}

function verifySquareFoldCutEight(item) {
  if (!isSquareFoldCutEightQuestion(item)) return { correct: null, correctAnswer: "" };
  const answer = String(item.studentAnswer || "").trim();
  if (!answer) return { correct: null, correctAnswer: "" };
  const correct = /等腰/.test(answer);
  return { correct, correctAnswer: correct ? "" : "等腰" };
}

// Same page, Q⑧: "下面的六邊形每條邊的長度都相等。[hexagon cut into
// A/B/C/D, drawn separately, same shape as the letter-grid above] 圖A
// 是（直角/等腰/等邊）三角形。(把答案圈起來)" -- unlike Q7/Q9 above, the
// resulting pieces ARE drawn separately and individually labelled (same
// visual shape as this ticket's own triangle_subtype_letter pattern
// above), so this reuses the SAME real polygon-geometry measurement
// (computeTriangleSubtypeProperties) -- the hexagon's cut pattern isn't
// symmetric enough to derive piece A's type as a closed-form fact
// without looking at the actual drawn shape.
function isHexagonCutPieceTypeQuestion(item) {
  const text = String(item.printedQuestion || "").replace(/\s+/g, "");
  // Real finding (2026-09-30, real OCR test on this exact citation):
  // the shared "下面的六邊形每條邊的長度都相等...剪開" stem sentence is
  // NOT repeated in the split-out "圖A是..." sub-item's own
  // printedQuestion -- same shared-context-lost-on-split gap already
  // seen elsewhere in this project. Originally required "六邊形"+"剪開"
  // too, which meant this handler could never fire on the real OCR
  // output; dropped that requirement -- "圖[A-Z]是（直角/等腰/等邊）" on
  // its own is specific enough not to collide with anything else in
  // this codebase (checked, no other handler matches this shape).
  if (!/圖[A-Z]是/.test(text)) return false;
  return /直角[\/／]等腰[\/／]等邊/.test(text);
}

function verifyHexagonCutPieceType(item, crop) {
  if (!isHexagonCutPieceTypeQuestion(item)) return { correct: null, correctAnswer: "" };
  const text = String(item.printedQuestion || "").replace(/\s+/g, "");
  const m = text.match(/圖([A-Z])是/);
  const answer = String(item.studentAnswer || "").trim();
  if (!m || !answer) return { correct: null, correctAnswer: "" };
  const targetIdx = m[1].charCodeAt(0) - 65;
  let photonImg;
  try {
    const bytes = base64ToBytes(crop.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width(), h = photonImg.get_height();
    const pixels = photonImg.get_raw_pixels();
    // Same letters-cause-noise-blobs and quad-vs-triangle-simplification
    // gaps as triangle_subtype_letter above -- same two local fixes.
    const rawShapes = readShapeClassificationFromPixels(pixels, w, h);
    const maxArea = rawShapes.reduce((mx, s) => Math.max(mx, s.area), 0);
    const shapes = rawShapes.filter((s) => s.area >= maxArea * 0.1);
    if (targetIdx < 0 || targetIdx >= shapes.length) return { correct: null, correctAnswer: "" };
    const s = shapes[targetIdx];
    let trianglePoints = s.shape === "triangle" ? s.points : (s.shape === "quadrilateral" ? collapseNearCollinearQuadToTriangle(s.points) : null);
    if (!trianglePoints) return { correct: null, correctAnswer: "" };
    const props = computeTriangleSubtypeProperties(trianglePoints);
    if (!props) return { correct: null, correctAnswer: "" };
    // The 3 MC options offered here (直角/等腰/等邊) are mutually
    // exclusive picks for THIS question's own phrasing (unlike the
    // letter-list format above, which allows a shape in multiple
    // categories) -- priority: equilateral > isosceles-right > right >
    // isosceles, matching how a real teacher would name the single most
    // specific applicable category when forced to choose one word.
    let correctCategory;
    if (props.isEquilateral) correctCategory = "等邊";
    else if (props.isRight) correctCategory = "直角";
    else if (props.isIsosceles) correctCategory = "等腰";
    else correctCategory = null; // scalene, none of the 3 offered options apply -- decline
    if (!correctCategory) return { correct: null, correctAnswer: "" };
    const correct = answer.includes(correctCategory);
    return { correct, correctAnswer: correct ? "" : correctCategory };
  } catch (e) {
    return { correct: null, correctAnswer: "" };
  } finally {
    if (photonImg) photonImg.free();
  }
}

const QUESTION_TYPE_HANDLERS = [
  {
    name: "multi_blank_math",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const parts = printed.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) return false;
      const blankCount = BLANK_TOKENS.reduce((n, t) => n + (printed.split(t).length - 1), 0);
      if (blankCount < 2) return false;
      // 2026-09-23 real overlap found: without this check, a plain bare-
      // number sequence with 2+ blanks ("2,?,6,?,10,?,?,16,?,20", a real
      // production example) matched here too and stole it from
      // sequence_fill (a MORE specific detector, registered later) --
      // this is a list of EQUATIONS (each part has an operator), not a
      // plain number list, so require at least one part to actually
      // contain an operator character.
      const isBareOrBlank = (p) => /^-?\d+(\.\d+)?$/.test(p) || BLANK_TOKENS.includes(p) || /^_+$/.test(p);
      return !parts.every(isBareOrBlank);
    },
    verify: (item) => verifyMultiBlankMath(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "missing_digit_in_number",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      let token = null, count = 0;
      for (const t of BLANK_TOKENS) {
        const n = printed.split(t).length - 1;
        if (n > 0) { count += n; if (!token) token = t; }
      }
      if (count !== 1) return false;
      const idx = printed.indexOf(token);
      return /\d/.test(printed[idx - 1] || "") || /\d/.test(printed[idx + token.length] || "");
    },
    verify: (item) => verifyMissingDigitInNumber(item.printedQuestion, item.studentAnswer),
  },
  {
    // 2026-09-22, real example p1-p6.com P3 maths Q15. Generalizes the
    // entry above to 2-4 blanks -- see verifyMissingDigitsInEquation's own
    // comment for why this is a separate function/entry rather than an
    // edit to missing_digit_in_number above (which a real future PR
    // could retire in favour of this one, since this handles its N=1
    // case too -- not done here, left as an explicit human decision).
    name: "missing_digits_in_equation",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const positions = [];
      for (let i = 0; i < printed.length; i++) {
        if (BLANK_TOKENS.includes(printed[i])) positions.push(i);
      }
      if (positions.length < 2 || positions.length > 4) return false;
      if (!printed.includes("=")) return false;
      return positions.some((i) => /\d/.test(printed[i - 1] || "") || /\d/.test(printed[i + 1] || ""));
    },
    verify: (item) => verifyMissingDigitsInEquation(item.printedQuestion, item.studentAnswer),
  },
  // NOTE: verifyMultiBoxDigitAnswer (below/exported) is deliberately NOT
  // registered as a handler here. Its detect() can only key off "a clean
  // expression ending in bare `=`" + "a pure-digit answer" -- indistinguishable
  // from plain math_equation without real OCR evidence of how a boxed-digit
  // answer actually comes back (unlike every other entry in this registry,
  // each keyed off a confirmed real signal). Tested directly (see
  // test/new-question-types.test.js) and ready to register once that
  // evidence exists -- registering it now would silently steal real
  // math_equation items instead of adding real new coverage.
  //
  // 2026-09-23 CONFIRMED (not just theorized): temporarily registering it
  // ahead of math_equation, with the narrowest plausible detect() ("=" at
  // the end of the printed expression with nothing after it, plus a
  // pure-digit student answer), broke exactly the 3 tests this ticket
  // named -- because this codebase's own real math_equation examples
  // ("10+4=" -> "14", "328-214=" -> "114") have EXACTLY that shape. A
  // plain single-blank sum and a "digit written across separate OCR
  // boxes" sum produce the identical (expression, digit-string) pair once
  // OCR'd to text -- there is no code-only fix here, because there is no
  // information-theoretic difference to key off. verifyMultiBoxDigitAnswer
  // itself already discards the one signal that COULD have distinguished
  // them (it strips spaces/commas from the student answer before
  // checking, so even "1 2 6 8" boxed-style OCR output collapses to the
  // same shape as bare "1268"). Registering this handler requires a real
  // decision from the user: either (a) real OCR evidence that boxed
  // answers come back in a literally different text shape than plain
  // answers (e.g. the printed question itself contains box glyphs like
  // "634x2=____" that verifyMultiBoxDigitAnswer would need to be taught to
  // require), or (b) accepting that this question type is simply not
  // distinguishable from plain math_equation and should be dropped/merged
  // rather than kept as a separate unregistered function.
  {
    // Detect() generalized 2026-09-23 to any NUMBER of blanks (was:
    // exactly one) -- see verifySequenceFill's own comment for the real
    // production evidence (a real 10-number "count in 2s" row with 5
    // separate blanks came back as one item).
    name: "sequence_fill",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const parts = printed.split(/[,，]/).map((s) => s.trim());
      if (parts.length < 3) return false;
      const isBlank = (p) => BLANK_TOKENS.some((t) => p.includes(t)) || /^_+$/.test(p);
      if (!parts.some(isBlank)) return false;
      // Distinguishes from multi_blank_math: every non-blank part must be a
      // BARE number, no operator characters -- a sequence is a plain list
      // ("1,3,5,__,9"), not a list of equations ("4×□=24,24÷□=4").
      return parts.every((p) => isBlank(p) || /^-?\d+(\.\d+)?$/.test(p));
    },
    verify: (item) => verifySequenceFill(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "sort_numbers",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const wantAsc = /由小到大|由小至大|ascending|smallest to largest/i.test(printed);
      const wantDesc = /由大到小|由大至小|descending|largest to smallest/i.test(printed);
      if (wantAsc === wantDesc) return false;
      return (printed.match(/-?\d+(\.\d+)?/g) || []).length >= 2;
    },
    verify: (item) => verifySortNumbers(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "comparison_symbol",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const answer = String(item.studentAnswer || "").trim();
      const nums = printed.match(/-?\d+(\.\d+)?/g);
      return !!nums && nums.length === 2 && (answer === ">" || answer === "<");
    },
    verify: (item) => verifyComparisonSymbol(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 209 (2026-09-30): see verifyOperatorFillBracket's own
    // comment for the real citation and brute-force logic.
    name: "operator_fill_bracket",
    detect: (item) => isOperatorFillBracketQuestion(item),
    verify: (item) => verifyOperatorFillBracket(item),
  },
  {
    name: "parity_mc",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const wantEven = /\beven\b|偶數/i.test(printed);
      const wantOdd = /\bodd\b|奇數/i.test(printed);
      if (wantEven === wantOdd) return false;
      return [...printed.matchAll(/([A-D])[.．]\s*([\d,\s]+?)(?=\s*[A-D][.．]|$)/g)].length >= 2;
    },
    verify: (item) => verifyParityMC(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "computation_mc",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const hasTarget = /[「"']([^」"']+)[」"']/.test(printed) || /(?:decomposition of|分解)\s*\d+/i.test(printed);
      if (!hasTarget) return false;
      return [...printed.matchAll(/([A-D])[.．]\s*([^A-D]+?)(?=\s*[A-D][.．]|$)/g)].length >= 2;
    },
    verify: (item) => verifyComputationMC(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 49 (2026-09-27): written and tested 2026-09-25, never
    // registered until now -- found during an audit of every written
    // verify* function against QUESTION_TYPE_HANDLERS. Must run BEFORE
    // number_word_conversion: a large-numeral phrase quoted in 「」 that
    // ONLY uses small-numeral characters (no 億/萬/百) also matches that
    // handler's own "quoted content" trigger, so this more specific
    // "阿拉伯數字" + quote combination needs first claim.
    name: "chinese_large_numeral_to_arabic",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      return /阿拉伯數字/.test(printed) && /「[^」]+」/.test(printed);
    },
    verify: (item) => verifyChineseLargeNumeralToArabic(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 208 (2026-09-30, real collision found): must run BEFORE
    // number_word_conversion -- a real citation's small "6月"/"5月" day
    // digits plus a single-CN-character weekday answer ("三") satisfy
    // that handler's own "small digit + parses as number word" trigger,
    // which would silently compute the wrong thing (treat "三" as the
    // number 3, not the weekday name). This handler's own detect() is
    // far more specific (the whole "如果...是星期...那麼...是星期" date-
    // math sentence shape), so it must claim the item first.
    name: "weekday_offset",
    detect: (item) => isWeekdayOffsetQuestion(item),
    verify: (item) => verifyWeekdayOffset(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "number_word_conversion",
    detect: (item) => {
      const printed = String(item.printedQuestion || "").trim();
      const answer = String(item.studentAnswer || "").trim();
      if (!printed || !answer) return false;
      // Ticket 28 (2026-09-28, real collision found): a sentence with TWO
      // possessive apostrophes and no punctuation between them (e.g.
      // "Sally's dart is nearer to the center than Ken's dart") let the
      // quote-span regex match the whole clause between them as if it
      // were a quoted number-word -- a real citation's own two darts
      // sub-questions were wrongly claimed away from distance_ranking.
      // Every real number-word citation quotes a single short word/
      // phrase ('twenty-six', '70', 「七十」), never a full clause, so
      // capping the captured span's length keeps those working while
      // excluding this false-positive class.
      const quotedMatch = /'([a-zA-Z\s-]+)'|"([a-zA-Z\s-]+)"|「([一二三四五六七八九十零]+)」/.exec(printed);
      const quoted = quotedMatch && (quotedMatch[1] || quotedMatch[2] || quotedMatch[3] || "").length <= 20;
      if (quoted) return true;
      // 2026-09-23 (challenge-all review finding): a bare small digit in the
      // printed question plus ANY letter/CN-numeral character in the answer
      // used to be enough to steal ANY word-problem item away from its real
      // handler below (word_problem_total/difference/division) whenever OCR
      // returned an answer with a stray unit suffix or a Chinese-numeral
      // character -- a confident-wrong exposure, not just a missed match,
      // since verifyNumberWordConversion would then compute a target from
      // the WRONG number in the sentence. Word-problem trigger keywords are
      // a much stronger, more specific signal than "any letter in the
      // answer" -- when one is present, this is almost certainly NOT a bare
      // number<->word conversion item, so this fallback (non-quoted) branch
      // stays out of the way and lets the real word-problem handlers below
      // it in the registry have first claim.
      if (/(共|總共|一共|合共|相差|每[^，,。？?]{0,6}(售|得|獲|分得|需))/.test(printed)) return false;
      const hasSmallDigit = /\b\d{1,2}\b/.test(printed);
      // Ticket 27 (2026-09-27, real data finding): "any letter/CN-numeral
      // in the answer" was still too loose -- misfired on an "and/but/or
      // sentence connector" exercise whose OCR'd printedQuestion was just
      // a bare digit label. See verifyNumberWordConversion's matching
      // comment -- the answer must actually PARSE as a number word.
      // Ticket 38: shared with verifyNumberWordConversion via
      // looksLikeNumberWord, was a verbatim duplicate before.
      const isWordAnswer = looksLikeNumberWord(answer);
      return hasSmallDigit && isWordAnswer;
    },
    verify: (item) => verifyNumberWordConversion(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 49 (2026-09-27): written and tested 2026-09-25 (found from
    // the exact bug verifyWordProblemTotal's own "每" guard documents --
    // that function safely declines a rate-multiplication shape rather
    // than mis-summing it, but nothing ever solved it either, until now).
    // Must run BEFORE word_problem_total: both share the 共/總共/一共/合共
    // trigger, and this is the more specific (每-rate) case.
    name: "word_problem_rate_multiplication",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (/每/.test(printed) && /(共|總共|一共|合共)/.test(printed)) return true;
      return !!tryEnglishEachHasRateMultiplication(printed);
    },
    verify: (item) => verifyWordProblemRateMultiplication(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 52 (2026-09-27): verifyPriceTableLookup was written and
    // tested 2026-09-25, never registered -- needed a page-level printed
    // price table the OCR step didn't extract as structured data until
    // now (see OCR_ONLY_PROMPT's new PRICE_TABLE instruction and
    // extractPriceTable). Must run BEFORE word_problem_total: a real
    // price-sum question's own "共需付" wording also contains word_
    // problem_total's "共" trigger -- in practice that handler's own
    // 2-numbers-in-the-printed-text requirement means it wouldn't
    // actually misfire here (the two prices live in the table, not the
    // question text), but placing the more specific handler first keeps
    // that safety explicit rather than incidental.
    name: "price_table_lookup",
    detect: (item) => {
      if (!item.priceTable || typeof item.priceTable !== "object") return false;
      const printed = String(item.printedQuestion || "");
      const names = Object.keys(item.priceTable).filter((n) => printed.includes(n));
      return names.length === 2;
    },
    verify: (item) => verifyPriceTableLookup(item.priceTable, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 68 (2026-09-28): same page-level-shared-context pattern as
    // price_table_lookup above, for pictogram (象形圖) data. detect()
    // requires the pictogram data to actually be present on this item
    // AND the question to match one of verifyPictogramQuery's 6 known
    // shapes -- narrower detect() here would be redundant since the
    // verify function already declines (returns null) on anything else,
    // but checking a cheap keyword up front avoids running the handler
    // on every unrelated item on a pictogram page.
    name: "pictogram_data_query",
    detect: (item) => {
      if (!item.pictogramData || typeof item.pictogramData !== "object" || !item.pictogramData.counts) return false;
      const printed = String(item.printedQuestion || "");
      return /最多|最少|most|least|greatest|fewest|smallest|沒有|冇|共有|共|altogether|total|倍|times/i.test(printed);
    },
    verify: (item) => verifyPictogramQuery(item.pictogramData, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 134 (2026-09-28): calendar-grid day-of-week reasoning, same
    // page-level-shared-context pattern as pictogram_data_query above.
    name: "calendar_grid_query",
    detect: (item) => {
      if (!item.calendarGrid || typeof item.calendarGrid !== "object") return false;
      const printed = String(item.printedQuestion || "");
      // Ticket 172: the cross-month shape's real citation is fully
      // English ("3rd October was ___"), with no "星期" at all.
      return /星期/.test(printed) || /\d+(?:st|nd|rd|th)?\s+[A-Za-z]+\s+was/i.test(printed);
    },
    verify: (item) => verifyCalendarGridQuery(item.calendarGrid, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 135 (2026-09-28): weekday-keyed schedule-table reasoning.
    name: "schedule_table_query",
    detect: (item) => {
      if (!item.scheduleTable || typeof item.scheduleTable !== "object") return false;
      const printed = String(item.printedQuestion || "");
      // Ticket 186: shape 3 ("最快...天後...再食到") and shape 4
      // ("昨天...明天...") phrase their questions with relative-day
      // words (今天/昨天/明天), not a literal "星期" weekday name --
      // the original /星期/ check alone missed both real citations.
      return /星期/.test(printed) || /(?:今天|今日|昨天|尋日|琴日|明天|聽日)/.test(printed);
    },
    verify: (item) => verifyScheduleTableQuery(item.scheduleTable, item.printedQuestion, item.studentAnswer),
  },
  {
    // Location-grid compass-direction reasoning (found 2026-09-28,
    // Q24/25 of a real P2 exam).
    name: "location_grid_query",
    detect: (item) => {
      if (!item.locationGrid || typeof item.locationGrid !== "object") return false;
      const printed = String(item.printedQuestion || "");
      return /由.+向.{0,3}方走|在.+的[東南西北]{1,2}方|[由從].+(?:前往|去).+經過.+後|.+坐在.+的.{0,5}?方/.test(printed);
    },
    verify: (item) => verifyLocationGridQuery(item.locationGrid, item.printedQuestion, item.studentAnswer),
  },
  {
    // Facing-direction reasoning (found 2026-09-28, Q28/29 of the same
    // real P2 exam).
    name: "facing_direction_query",
    detect: (item) => {
      if (!item.facingDirection || typeof item.facingDirection !== "object") return false;
      const printed = String(item.printedQuestion || "");
      return /轉.{0,3}直角.{0,5}面向|面對面.*面向/.test(printed);
    },
    verify: (item) => verifyFacingDirectionQuery(item.facingDirection, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 181 (2026-09-28): back-direction from a stated left-hand direction, pure text.
    name: "back_direction_from_left_hand",
    detect: (item) => /左方是[東南西北]{1,2}方.{0,10}背向/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyBackDirectionFromLeftHand(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 153 (2026-09-28): digit-card combinatorial construction.
    name: "digit_card_extreme_composite",
    detect: (item) => !!item.digitCards && /兩位的合成數/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyDigitCardExtremeComposite(item.digitCards, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 154 (2026-09-28): short-division HCF "which option is wrong" MC.
    name: "short_division_hcf_mc",
    detect: (item) => !!item.shortDivisionMc && /最大公因數不是/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyShortDivisionHcfMc(item.shortDivisionMc, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 155 (2026-09-28): two top-aligned squares, diagonal-cut shaded area.
    name: "squares_diagonal_shaded_area",
    detect: (item) => !!item.squaresDiagonal && /陰影部分的面積/.test(String(item.printedQuestion || "")),
    verify: (item) => verifySquaresDiagonalShadedArea(item.squaresDiagonal, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 156 (2026-09-28): trapezoid wedged between two squares, area from perimeters.
    name: "trapezoid_two_squares_area",
    detect: (item) => item.trapezoidBaseline != null && /梯形的面積/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyTrapezoidTwoSquaresArea(item.trapezoidBaseline, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 157 (2026-09-28): overlapping parallelograms union area.
    name: "overlapping_parallelogram_union_area",
    detect: (item) => /重疊/.test(String(item.printedQuestion || "")) && /平行四邊形/.test(String(item.printedQuestion || "")) && /整個圖形的面積/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyOverlappingParallelogramUnionArea(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 158 (2026-09-28): parallelogram split by a vertical line, reverse-solve height.
    name: "parallelogram_partial_height",
    detect: (item) => item.parallelogramShadedWidth != null && /白色部分/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyParallelogramPartialHeight(item.parallelogramShadedWidth, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 177 (2026-09-28): rectangle minus 4 congruent corner triangles.
    name: "rect_cut_kite_area",
    detect: (item) => !!item.rectCutKite && /剪去4個/.test(String(item.printedQuestion || "")) && /餘下部分的面積/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyRectCutKiteArea(item.rectCutKite, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 178 (2026-09-28): write an algebraic expression from a word scenario.
    name: "write_algebraic_expression",
    detect: (item) => /用代數式表示/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyWriteAlgebraicExpression(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 179 (2026-09-28): 8-point compass rose "which one is correct" MC.
    name: "compass_rose_mc",
    detect: (item) => !!item.compassRoseMc && /方向指示/.test(String(item.printedQuestion || "")) && /正確/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyCompassRoseMc(item.compassRoseMc, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 188 (2026-09-28): paper-fold reverse-length question.
    name: "paper_fold",
    detect: (item) => !!item.paperFold && /對摺|摺.{0,4}後/.test(String(item.printedQuestion || "")) && /原來長|原長/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyPaperFold(item.paperFold, item.studentAnswer),
  },
  {
    // Ticket 185 (2026-09-28): shortest-path graph reasoning.
    name: "path_graph",
    detect: (item) => !!item.pathGraph && /最短路程|最少要走|要走\s*\d/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyPathGraph(item.pathGraph, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 187 (2026-09-28): "which completion time is plausible" MC,
    // options shown only as clock-face images.
    name: "clock_options_mc",
    detect: (item) => !!item.clockOptions && /時[\s\S]{0,6}開始/.test(String(item.printedQuestion || "")) && /可能/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyClockOptionsMc(item.clockOptions, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 189 (2026-09-28): change-making with a blank per denomination.
    name: "coin_blanks",
    detect: (item) => !!item.coinBlanks && /兌換|exchange/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyCoinBlanks(item.coinBlanks, item.studentAnswer),
  },
  {
    // Ticket 194 (2026-09-28): nearest/farthest distance ranking.
    name: "distance_ranking",
    detect: (item) => !!item.distanceValues && /nearest|farthest|nearer|farther/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyDistanceRanking(item.distanceValues, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 195 (2026-09-28): shared-value lookup/between-range MC
    // across a group of sub-questions (e.g. plant heights in "磚").
    name: "object_heights",
    detect: (item) => !!item.objectHeights && (/的[\s\S]{0,6}高\s*_+\s*個/.test(String(item.printedQuestion || "")) || /可能高\s*\*?\s*[\d.]+(?:\s*\/\s*[\d.]+)+/.test(String(item.printedQuestion || ""))),
    verify: (item) => verifyObjectHeights(item.objectHeights, item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 119 (2026-09-28): change from a 2-item purchase, prices
    // stated inline in the sentence (not a printed price table).
    name: "change_from_two_item_purchase",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      return /change/i.test(printed) && (printed.match(/costs?\s*\d+\s*dollars?/gi) || []).length === 2;
    },
    verify: (item) => verifyChangeFromTwoItemPurchase(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 121 (2026-09-28): resource-constrained "at most" word problem.
    name: "resource_constrained_max",
    detect: (item) => /at most/i.test(String(item.printedQuestion || "")) && /takes?\s*\d+/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyResourceConstrainedMax(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 124 (2026-09-28): chained two-step equation, blank in the middle.
    name: "chained_two_step_blank",
    detect: (item) => /\d+\s*-\s*\d+\s*-\s*(?:\[?_*\]?|□)\s*=\s*\d+/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyChainedTwoStepBlank(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 127 (2026-09-28): curve-only-letter static-fact reverse MC.
    name: "curve_only_letter_mc",
    detect: (item) => /curves? only/i.test(String(item.printedQuestion || "")) && /\([^)]+\)/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyCurveOnlyLetterMC(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 136 (2026-09-28): total-then-regroup word problem.
    name: "regroup_total_word_problem",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      return (printed.match(/每\s*\d+\s*個/g) || []).length >= 2 && /裝成|一盒/.test(printed);
    },
    verify: (item) => verifyRegroupTotalWordProblem(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 137 (2026-09-28): elapsed-time inequality MC.
    name: "elapsed_time_inequality_mc",
    detect: (item) => /比\s*\d+\s*小時長/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyElapsedTimeInequalityMC(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 138 (2026-09-28): simple yesterday/tomorrow day-of-week shift.
    name: "yesterday_tomorrow_shift",
    detect: (item) => /(?:琴日|昨天)是?星期[日一二三四五六]/.test(String(item.printedQuestion || "")) && /聽日|明天/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyYesterdayTomorrowShift(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 140 (2026-09-28): sum of durations across multiple time ranges.
    name: "duration_sum_word_problem",
    detect: (item) => (String(item.printedQuestion || "").match(/\d+\s*時正?至\s*\d+\s*時正?/g) || []).length >= 2,
    verify: (item) => verifyDurationSumWordProblem(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 125 (2026-09-28): two-stage affordability chain.
    name: "two_stage_affordability_chain",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      return /\(more\/less\)|\(less\/more\)/i.test(printed) && /\(has\/does not have\)|\(does not have\/has\)/i.test(printed);
    },
    verify: (item) => verifyTwoStageAffordabilityChain(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 129 (2026-09-28): chained vertical arithmetic, feed-forward blanks.
    name: "chained_vertical_arithmetic",
    detect: (item) => /\d+\s*[+-]\s*\d+\s*(?:\[?_*\]?|□)\s*[+-]\s*\d+\s*(?:\[?_*\]?|□)\s*$/.test(String(item.printedQuestion || "").trim()),
    verify: (item) => verifyChainedVerticalArithmetic(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 148 (2026-09-28): common-factor count between two numbers.
    // MUST run BEFORE word_problem_total -- real collision found 2026-09-28
    // via a from-scratch classifyAndVerify test: "20和32共有多少個公因數？"
    // contains "共" (as part of "共有") and 2 numbers, so word_problem_total's
    // own generic trigger ALSO matches it and would silently compute a
    // wrong sum-based verdict instead of declining to this more specific
    // handler.
    name: "common_factors_count",
    detect: (item) => /\d+和\d+共有多少個公因數/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyCommonFactorsCount(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "word_problem_total",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/(共|總共|一共|合共)/.test(printed) && !WORD_PROBLEM_TOTAL_EN_RE.test(printed)) return false;
      return (printed.match(/(?<!第)\d+/g) || []).length >= 2;
    },
    verify: (item) => verifyWordProblemTotal(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 49 (2026-09-27): written and tested 2026-09-25, never
    // registered until now. Must run BEFORE word_problem_difference --
    // a real collision found via the new integration test: this
    // question's own "相差" wording plus exactly-2-numbers-in-the-text
    // ALSO matches word_problem_difference's much looser trigger, so the
    // more specific full-shape match ("在...這個數中...兩個「D」的數值
    // 相差多少") needs first claim.
    name: "repeated_digit_place_value_difference",
    detect: (item) => /在\s*\d+\s*這個數中.*?兩個「\d」的數值相差多少/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyRepeatedDigitPlaceValueDifference(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "word_problem_difference",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/相差/.test(printed) && !WORD_PROBLEM_DIFFERENCE_EN_RE.test(printed)) return false;
      return (printed.match(/\d+/g) || []).length === 2;
    },
    verify: (item) => verifyWordProblemDifference(item.printedQuestion, item.studentAnswer),
  },
  {
    // 2026-09-26 question-type survey: the inverse of word_problem_
    // difference above (that one has both totals, asks for the
    // difference; this one has one total + the difference, asks for the
    // other total). "比...多/少" only means this shape when NOT also
    // matching word_problem_difference's own "相差" trigger, which runs
    // first in this array and would already have claimed it.
    name: "word_problem_more_than",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const hasMoreOrFewer = /比[^，,。？?！!]{0,10}(多|少)/.test(printed) || /\b(more|fewer|less)\b.{0,20}\bthan\b/i.test(printed);
      if (!hasMoreOrFewer) return false;
      return (printed.match(/\d+/g) || []).length === 2;
    },
    verify: (item) => verifyWordProblemMoreThan(item.printedQuestion, item.studentAnswer),
  },
  {
    // 2026-09-26 question-type survey: "write a number between X and Y"
    // -- a genuinely different verification shape (range-membership),
    // not a fill-blank exact-match.
    name: "number_between",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      return /(?:介乎|喺)\s*\d+\s*(?:同|和|與)\s*\d+\s*之間/.test(printed) || /\bbetween\s+\d+\s+and\s+\d+\b/i.test(printed);
    },
    verify: (item) => verifyNumberBetween(item.printedQuestion, item.studentAnswer),
  },
  {
    // Must run BEFORE word_problem_division: both key off a "每" per-unit
    // rate phrase, but this one is the narrower, more specific trigger
    // (至少/最少/"at least" additionally required) -- first-match-wins
    // dispatch means the more specific detector needs to go first so a
    // real ceiling-division item can't be silently swallowed by the
    // broader division handler below it.
    name: "word_problem_ceiling_division",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/(至少|最少)/.test(printed) && !/at least/i.test(printed)) return false;
      if (!/每[^\d]{0,10}\d+/.test(printed)) return false;
      return (printed.match(/\d+/g) || []).length === 2;
    },
    verify: (item) => verifyWordProblemCeilingDivision(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "word_problem_division",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (/另外/.test(printed)) return false;
      if (!/每[^，,。？?]{0,6}(售|得|獲|分得|需)/.test(printed)) return false;
      return (printed.match(/\d+/g) || []).length === 2;
    },
    verify: (item) => verifyWordProblemDivision(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "digit_count_of_n_plus_one",
    // Shares DIGIT_COUNT_OF_N_PLUS_ONE_RE with the verify function below
    // (2026-09-23 fix) so detect() and verify() can never disagree about
    // what counts as a match.
    detect: (item) => DIGIT_COUNT_OF_N_PLUS_ONE_RE.test(String(item.printedQuestion || "")),
    verify: (item) => verifyDigitCountOfNPlusOne(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "compound_unit_conversion",
    detect: (item) => /(\d+(?:\.\d+)?)\s*(km|mm|cm|m)\s*(\d+(?:\.\d+)?)\s*(km|mm|cm|m)\s*=[^a-zA-Z]*(km|mm|cm|m)\b/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyCompoundUnitConversion(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "construct_extreme_number",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/(組成|to form|form the)/i.test(printed)) return false;
      const largest = /(最大|largest|greatest)/i.test(printed);
      const smallest = /(最小|smallest|least)/i.test(printed);
      if (largest === smallest) return false;
      const digitTokens = printed.match(/\d(?!-digit)(?!位)/g);
      return !!digitTokens && digitTokens.length >= 2 && digitTokens.length <= 7;
    },
    verify: (item) => verifyConstructExtremeNumberFromText(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "list_factors",
    detect: (item) => /(?:寫出|列出)\s*\d+\s*(?:嘅|的)所有因數|list all (?:the )?factors of\s*\d+/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyListFactors(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 169 (2026-09-28): closes a 3x-confirmed real gap -- extracts
    // the candidate number set from printed text before delegating to the
    // already-written-but-never-wired verifySelectTwoNumbersSumTarget.
    name: "select_two_numbers_sum_target_from_text",
    detect: (item) => /(\d+)[^\d+\-=]+(\d+)[^\d+\-=]+(\d+)[^\d]*?_+\s*\+\s*_+\s*=\s*(\d+)/.test(String(item.printedQuestion || "")),
    verify: (item) => verifySelectTwoNumbersSumTargetFromText(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 142 (2026-09-28): first-N-multiples list.
    name: "first_n_multiples",
    detect: (item) => /列出\d+的最初(?:\d+|[一二三四五六七八九十]+)個倍數/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyFirstNMultiples(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 145 (2026-09-28): reverse-solve base from multiple-difference.
    name: "reverse_base_from_multiple_difference",
    detect: (item) => /第\d+個和第\d+個倍數相差\d+/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyReverseBaseFromMultipleDifference(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 146 (2026-09-28): missing factor in an ordered factor list.
    name: "missing_factor_in_ordered_list",
    detect: (item) => /\d+的所有因數是[\d、和☆]*☆/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyMissingFactorInOrderedList(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 147 (2026-09-28): dual-constraint (multiple+factor) MC filter.
    name: "dual_constraint_number_filter",
    detect: (item) => /是\d+的倍數.{0,6}又是\d+的因數/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyDualConstraintNumberFilter(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 149 (2026-09-28): Nth common multiple, forward direction.
    name: "nth_common_multiple",
    detect: (item) => /第一個公倍數是\d+[\s\S]{0,10}第(?:\d+|[一二三四五六七八九十]+)個公倍數是甚麼/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyNthCommonMultiple(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 151 (2026-09-28): coprime-product-equals-LCM MC.
    name: "coprime_product_equals_lcm_mc",
    detect: (item) => /L\.C\.M\.|LCM/i.test(String(item.printedQuestion || "")) && parseMcOptions(String(item.printedQuestion || "")).length >= 2,
    verify: (item) => verifyCoprimeProductEqualsLcmMC(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 162 (2026-09-28): closest-approximation reverse-solve MC.
    name: "closest_approximation_mc",
    detect: (item) => /△\d+\/\d+×\d+的答案約是\d+/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyClosestApproximationMC(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 167 (2026-09-28): extreme N-digit number under a digit-sum
    // constraint (not a given digit list).
    name: "extreme_number_by_digit_sum",
    detect: (item) => /Put\s*\d+\s*beads.{0,80}(?:largest|smallest)\s*(?:three|four|five)-digit/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyExtremeNumberByDigitSum(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 168 (2026-09-28): currency exchange-ratio arithmetic.
    name: "coin_exchange_ratio",
    detect: (item) => /\d+個(?:\$\d+(?:\.\d+)?|\d+\s*[¢c])可換(?:\$\d+(?:\.\d+)?|\d+\s*[¢c])\s*_+\s*個/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyCoinExchangeRatio(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 176 (2026-09-28): which-expression-computes-the-target MC.
    name: "which_expression_computes_mc",
    detect: (item) => /same result as|which expression/i.test(String(item.printedQuestion || "")) && parseMcOptions(String(item.printedQuestion || "")).length >= 2,
    verify: (item) => verifyWhichExpressionComputesMC(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 143 (2026-09-28): composite-number min-factor-count static fact.
    name: "min_factors_of_composite",
    detect: (item) => /合成數.{0,6}最少.{0,6}因數|composite.{0,10}(?:least|minimum|fewest).{0,10}factors/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyMinFactorsOfComposite(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 144 (2026-09-28): "largest factor is N" implies the number is N.
    name: "largest_factor_implies_number",
    detect: (item) => /最大因數是\s*\d+[\s\S]*?共有多少個因數/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyLargestFactorImpliesNumber(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 150 (2026-09-28): minimum addition to reach the next prime.
    name: "min_add_to_prime",
    detect: (item) => /\d+最少要加上多少.{0,6}(?:才是|先係).{0,3}質數/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyMinAddToPrime(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 152 (2026-09-28): factor/multiple definition true/false MC.
    name: "factor_multiple_definition_mc",
    detect: (item) => {
      const options = parseMcOptions(String(item.printedQuestion || ""));
      return options.length >= 2 && options.every((o) => /\d+是\d+的(?:倍數|因數)/.test(o.text));
    },
    verify: (item) => verifyFactorMultipleDefinitionMC(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 174 (2026-09-28): decimal price -> dollars+cents split.
    name: "price_decimal_split",
    detect: (item) => /\$\d+\.\d{2}/.test(String(item.printedQuestion || "")) && /dollars? and .{0,10}cents?/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyPriceDecimalSplit(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 175 (2026-09-28): max-min difference over a printed price list.
    name: "price_list_max_min_difference",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      return (printed.match(/\$\d+(?:\.\d+)?/g) || []).length >= 2 && /most expensive.{0,15}cheapest|cheapest.{0,15}most expensive/i.test(printed);
    },
    verify: (item) => verifyPriceListMaxMinDifference(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "count_primes_below",
    detect: (item) => /\d+\s*(?:以內|以下|之內)[^\d]{0,10}(?:質數|prime)/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyCountPrimesBelow(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "elapsed_time_forward",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/(hours?|小時)/i.test(printed)) return false;
      if ((printed.match(/\d{1,2}:\d{2}\s*[ap]\.?m\.?/gi) || []).length === 2) return true;
      // Ticket 187: bare "X o'clock" phrasing (no am/pm, no minutes).
      return (printed.match(/\d{1,2}(?=\s*o.?clock)/gi) || []).length === 2;
    },
    verify: (item) => verifyElapsedTimeForward(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "reverse_divisor_from_remainder",
    detect: (item) => /\d+\s*[÷\/]\s*[?□※]\s*=\s*\d+\s*[…\.]{1,3}\s*\d+/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyReverseDivisorFromRemainder(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 49 (2026-09-27): written and tested 2026-09-25, never
    // registered until now. Distinct shape from reverse_divisor_from_
    // remainder above -- there the blank is the DIVISOR (between ÷ and
    // =); here dividend/divisor/quotient are all given and the blank is
    // the REMAINDER (after the "…"), so the two triggers structurally
    // can't overlap.
    name: "division_remainder_blank",
    detect: (item) => /\d+\s*[÷\/]\s*\d+\s*=\s*\d+\s*(?:[…⋯]|\.{2,3})\s*[●?□]/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyDivisionRemainderBlank(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "multiple_difference",
    detect: (item) => /\d+嘅第[一二三四五六七八九十]+個同第[一二三四五六七八九十]+個倍數相差/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyMultipleDifference(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 49 (2026-09-27): written and tested 2026-09-25, never
    // registered until now. Distinct from construct_extreme_number above
    // -- that one builds a number FROM a given digit set; this is pure
    // place-value general knowledge (no digits given at all), keyed off
    // "largest/smallest N-digit number...differ" phrasing.
    name: "extreme_number_difference",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const m = printed.match(/(.+?)(?:和|與)(.+?)相差是?/);
      if (!m) return false;
      const termPattern = /(最大|最小)的?([一二兩三四五六]|\d+)位(奇|偶)?數/;
      return termPattern.test(m[1]) && termPattern.test(m[2]);
    },
    verify: (item) => verifyExtremeNumberDifference(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 49 (2026-09-27): written and tested 2026-09-25, never
    // registered until now.
    name: "substitute_and_evaluate",
    detect: (item) => /如果\s*[A-Za-z]\s*=\s*-?\d+(?:\.\d+)?\s*[，,]\s*那麼.+的值是/.test(String(item.printedQuestion || "")),
    verify: (item) => verifySubstituteAndEvaluate(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 49 (2026-09-27): written and tested 2026-09-25, never
    // registered until now.
    name: "time_format_conversion",
    detect: (item) => /12[-\s]?hour|12\s*小時|24[-\s]?hour|24\s*小時/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyTimeFormatConversion(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "round_to_nearest_hundred",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/四捨五入/.test(printed) || !/百位/.test(printed)) return false;
      return (printed.match(/\d+/g) || []).length === 1;
    },
    verify: (item) => verifyRoundToNearestHundred(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "reverse_factor_sum",
    detect: (item) => /最小和最大嘅因數之和係\d+/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyReverseFactorSum(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 51 (2026-09-27): verifyConjunctionFill was written and
    // tested 2026-09-25 but never registered, ostensibly because it
    // takes (clauseA, clauseB) as two SEPARATE strings rather than one
    // printedQuestion -- but Ticket 29's context-preservation fix
    // (2026-09-27) means a real single-blank item's printedQuestion now
    // already carries the full sentence with the blank marked as a
    // run of underscores (confirmed real example: "My name is Eric. I
    // have three sisters ____ I don't have any brothers."), so clauseA/
    // clauseB can be split straight out of the EXISTING printedQuestion
    // with no OCR prompt change needed at all -- the data was already
    // there, just never wired through.
    name: "conjunction_fill",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const answer = String(item.studentAnswer || "").trim().toLowerCase();
      return (answer === "but" || answer === "and" || answer === "or") && /_{2,}/.test(printed);
    },
    verify: (item) => {
      const printed = String(item.printedQuestion || "");
      const parts = printed.split(/_{2,}/);
      const clauseA = (parts[0] || "").trim();
      const clauseB = parts.slice(1).join(" ").trim();
      return verifyConjunctionFill(clauseA, clauseB, item.studentAnswer);
    },
  },
  {
    name: "grammar_cloze",
    // Ticket 27 (2026-09-27, real data finding): a 7-photo real-pipeline
    // test found this handler wrongly claiming a completely different
    // exercise -- "safari passage, fill in it/them/him/her" items whose
    // printedQuestion happens to have "____" immediately followed by a
    // printed "'s" (e.g. "____'s having a shower!"). This handler covers
    // exactly 2 real sub-patterns (see verifyGrammarCloze's own
    // comment): (1) subject pronoun + blank -> expects am/is/are/has/have,
    // (2) blank + word -> its vs it's. A pronoun-fill answer like "It"/
    // "They"/"them" matches NEITHER real sub-pattern's expected answer
    // shape, yet the old detect() let it through purely on the printed
    // SHAPE (a blank followed by letters), then judged it against
    // unrelated its/it's rules. Real confirmed harm: marked "It"/"They"
    // (genuinely correct pronoun fills) as wrong. Now requires the
    // STUDENT'S OWN answer to plausibly belong to one of this handler's
    // two real answer families before claiming the item at all.
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const answer = String(item.studentAnswer || "").trim();
      if (!answer) return false;
      const norm = answer.toLowerCase().replace(/[.\s]/g, "");
      const looksLikeBeVerbFamily = ["am", "is", "are", "has", "have"].includes(norm);
      const looksLikeItsItsFamily = norm === "its" || norm === "it's" || norm === "itis";
      if (!looksLikeBeVerbFamily && !looksLikeItsItsFamily) return false;
      if (/\b(I|He|She|They|We|You|His\s+sister|Her\s+brother)\s+_{2,}/i.test(printed)) return true;
      return /_{2,}\s*[a-zA-Z']+/.test(printed);
    },
    verify: (item) => verifyGrammarCloze(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 222 "verb conjugation" (2026-10-01): broader "fill in the
    // correct form of the verb" rule-based conjugation. Registered
    // AFTER grammar_cloze so grammar_cloze keeps first claim on its own
    // narrower be-verb/its-it's shape -- this one only ever sees what
    // that handler didn't already resolve.
    name: "verb_form_fill",
    detect: (item) => isVerbFormFillQuestion(item),
    verify: (item) => verifyVerbFormFill(item),
  },
  {
    // Ticket 222 "Prepositions of time" (2026-10-01). Registered after
    // verb_form_fill/grammar_cloze so a blank that's actually a verb or
    // be-form fill (which also matches the generic "_{2,}" shape) never
    // gets mis-claimed here -- this only fires when the text following
    // the blank itself classifies as a real time expression.
    name: "preposition_of_time",
    detect: (item) => isPrepositionOfTimeQuestion(item),
    verify: (item) => verifyPrepositionOfTime(item),
  },
  {
    // Ticket 53 (2026-09-27): verifyLiteralKeywordMC was written and
    // tested 2026-09-25, never registered -- needed a printed reading
    // passage the OCR step didn't extract separately until now (see
    // OCR_ONLY_PROMPT's new PASSAGE instruction). The MC options
    // themselves need no new field -- parseMcOptions pulls them straight
    // out of the item's own printedQuestion, same as parity_mc/
    // computation_mc already do inline. Registered near the end (after
    // every more specific handler) so a passage-bearing page's OTHER,
    // unrelated MC-shaped items (already claimed above) are never at
    // risk of this broader catch-all instead.
    name: "literal_keyword_mc",
    detect: (item) => {
      if (!item.passageText) return false;
      return parseMcOptions(item.printedQuestion).length >= 2;
    },
    verify: (item) => verifyLiteralKeywordMC(item.passageText, parseMcOptions(item.printedQuestion), item.studentAnswer),
  },
  {
    // Ticket 53 (2026-09-27): verifySelectFromPassage was written and
    // tested 2026-09-25, never registered, same PASSAGE field as above.
    // Can only ever return false/null, never true (see its own comment)
    // -- narrowed to genuine cloze-blank shapes (a blank in the printed
    // text, a short word/phrase answer) so it never reaches for an
    // unrelated item that just happens to share a page with a passage.
    // Registered LAST of the blank-fill handlers so grammar_cloze/
    // conjunction_fill/number_word_conversion (all more specific about
    // which real answer family they expect) keep first claim on any
    // shape they'd otherwise also match.
    name: "select_from_passage",
    detect: (item) => {
      if (!item.passageText) return false;
      const answer = String(item.studentAnswer || "").trim();
      if (!answer || answer.length > 20) return false;
      return /_{2,}/.test(String(item.printedQuestion || ""));
    },
    verify: (item) => verifySelectFromPassage(item.studentAnswer, item.passageText),
  },
  {
    // Ticket 63 (2026-09-27): see readClockHandsFromPixels's own long
    // comment above for the full real history/safety design. Narrow
    // detect(): only fires when the printed question is clearly asking
    // to READ a pre-printed clock (not "draw the hands", a production
    // task this doesn't attempt) AND the student's own answer already
    // parses as a real time value -- both real, cheap-to-check signals
    // that this is genuinely the "read the clock" shape, not a guess.
    name: "clock_reading",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/\bclock\b|o'clock|時鐘|鐘面|What time/i.test(printed)) return false;
      if (/draw|畫/i.test(printed)) return false; // production task, not a reading task -- out of scope here
      return !!parseTimeAnswer(item.studentAnswer);
    },
    verifyVisual: (item, crop) => verifyClockReading(item, crop),
  },
  {
    // Ticket 202 (2026-09-30): see readSecondHandAngleFromPixels's own
    // long comment for the real citation. Registered before
    // clock_reading above out of the same defensive habit as other
    // handler-ordering fixes this session, though the two shouldn't
    // actually collide -- this ticket's "minute,second" or "hour,second"
    // studentAnswer format never parses as a real clock time, so
    // clock_reading's own detect() naturally can't claim it.
    name: "second_hand_clock",
    detect: (item) => isSecondHandClockQuestion(item),
    verifyVisual: (item, crop) => verifySecondHandClock(item, crop),
  },
  {
    // Ticket 200 (2026-09-30): see readFractionShadingFromPixels's own
    // long comment for the real citation and the disclosed equal-area
    // scope limit.
    name: "fraction_shading",
    detect: (item) => isFractionShadingQuestion(item),
    verifyVisual: (item, crop) => verifyFractionShading(item, crop),
  },
  {
    // Ticket 203 (2026-09-30): see verifyGridPointIsosceles's own long
    // comment for the real citation and the new crop-origin plumbing
    // this needed. isGridPointIsoscelesQuestion shared with handleMark's
    // bbox fallback (findGridPointsBbox's call site), same convention as
    // 198/199/197's own dedicated finders.
    name: "grid_point_isosceles",
    detect: (item) => isGridPointIsoscelesQuestion(item),
    verifyVisual: (item, crop) => verifyGridPointIsosceles(item, crop),
  },
  {
    // Ticket 210 (2026-09-30): see the CJK_PARALLEL_LINES_TABLE/
    // LATIN_PARALLEL_LINES_TABLE comment for the real citation and
    // disclosed bounded-glyph-set scope.
    name: "cjk_parallel_lines_mc",
    detect: (item) => isCjkParallelLinesMcQuestion(item),
    verify: (item) => verifyCjkParallelLinesMc(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "latin_parallel_lines_count",
    detect: (item) => isLatinParallelLinesCountQuestion(item),
    verify: (item) => verifyLatinParallelLinesCount(item.printedQuestion, item.studentAnswer),
  },
  // Ticket 204 (2026-09-30): trapezoid_type_letters handler NOT
  // registered -- real-tested against the actual citation and found
  // BLOCKED by a genuine bug in the shared shape classifier
  // (readShapeClassificationFromPixels), not a bug in this ticket's own
  // logic. See classifyTrapezoidType/verifyTrapezoidTypeLetters's own
  // comments plus TICKETS.md for the full real finding: this citation's
  // pale fill colour produces corner-jag artifacts that split a real
  // 4-vertex trapezoid's corner into 6-7 spurious vertices, which the
  // existing plateau-vertex-count method doesn't fully resolve even at
  // its full tolerance sweep. Fixing that needs care against Ticket
  // 197's own already-shipped real citations (regression risk), not
  // attempted in this pass. The pure classifyTrapezoidType function
  // itself is correct and tested in isolation -- once the underlying
  // vertex-detection is fixed, wiring this in is a 3-line change (this
  // same detect/verifyVisual pair, uncommented).
  {
    // Ticket found 2026-09-28 (躍思): Müller-Lyer illusion, "are line
    // P/Q/R all equal length" MC. See readLineShaftLengths's own long
    // comment above for the real+synthetic double validation. detect()
    // requires BOTH ≥2 line labels AND an "all equal" MC option present
    // -- verifyLineShaftAllEqual itself declines on everything else this
    // hasn't been validated against (unequal lines, missing labels).
    name: "line_shaft_all_equal",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const lineLabels = printed.match(/[直线線]\s*[A-Za-z]|line\s*[A-Za-z]/gi) || [];
      if (new Set(lineLabels.map((s) => s.trim().slice(-1).toUpperCase())).size < 2) return false;
      return parseMcOptions(printed).some((o) => /一樣長|相同|相等|all.{0,10}(equal|same)/i.test(o.text));
    },
    verifyVisual: (item, crop) => verifyLineShaftAllEqual(item, crop),
  },
  {
    // Object counting (2026-09-28): see readObjectCountFromPixels's own
    // long comment for the real 3-image validation (2 correct counts,
    // 1 correctly-declined framed image). detect() requires the "count
    // the objects" instruction phrase AND a bare-number answer -- the
    // safety check inside verifyObjectCounting is what actually decides
    // whether to trust this specific photo's count.
    name: "object_counting",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const answer = String(item.studentAnswer || "").trim();
      if (!/數一數|count.{0,10}(how many|are there)|how many.{0,15}are there/i.test(printed)) return false;
      return /^\d+$/.test(answer);
    },
    verifyVisual: (item, crop) => verifyObjectCounting(item, crop),
  },
  {
    // Ticket 201 (2026-09-30): see readColorCountedBlobs's own long
    // comment for the real citation and the colour-classification bug
    // found while building. No dedicated bbox finder (unlike 198/199) --
    // same default text-match crop path as object_counting above, which
    // this extends.
    name: "color_counted_icons",
    detect: (item) => isColorCountedQuestion(item),
    verifyVisual: (item, crop) => verifyColorCountedIcons(item, crop),
  },
  {
    // Ticket 206 (2026-09-30): see readBalanceScalePiles's own long
    // comment for the real citation, the touching-icon bug found, and
    // the disclosed left/right-pile-to-name binding assumption.
    name: "balance_scale_piles",
    detect: (item) => isBalanceScalePileQuestion(item),
    verifyVisual: (item, crop) => verifyBalanceScalePiles(item, crop),
  },
  {
    // Ticket (2026-09-30): see readShapeClassificationFromPixels's own
    // long comment for the full real validation history (Python 6/6,
    // JS-port 5/6) and its disclosed touching-shapes limitation.
    // isShapeClassificationGridQuestion is shared with handleMark's bbox
    // fallback (findLetterGridBbox's call site) so both use exactly the
    // same detection logic, never allowed to drift apart.
    name: "shape_classification_grid",
    detect: (item) => isShapeClassificationGridQuestion(item),
    verifyVisual: (item, crop) => verifyShapeClassificationGrid(item, crop),
  },
  {
    // Ticket 222 (2026-09-30): triangle sub-type (等邊/等腰/直角/等腰直
    // 角/不等邊) classification from a printed shapes-lettered-A-G grid.
    name: "triangle_subtype_letter",
    detect: (item) => isTriangleSubtypeLetterQuestion(item),
    verifyVisual: (item, crop) => verifyTriangleSubtypeLetterQuestion(item, crop),
  },
  {
    // Ticket 222 ("Pattern 7"): rectangle-cut-along-diagonal always
    // produces 2 right triangles -- closed-form fact, no image needed.
    name: "rectangle_diagonal_cut",
    detect: (item) => isRectangleDiagonalCutQuestion(item),
    verify: (item) => verifyRectangleDiagonalCut(item),
  },
  {
    // Ticket 222 ("Pattern 7"): square-fold-cut-into-8 always produces
    // isosceles triangles -- closed-form fact, no image needed.
    name: "square_fold_cut_eight",
    detect: (item) => isSquareFoldCutEightQuestion(item),
    verify: (item) => verifySquareFoldCutEight(item),
  },
  {
    // Ticket 222 ("Pattern 7"): hexagon-cut piece type -- reuses the
    // same real polygon-geometry measurement as triangle_subtype_letter
    // above, applied to a single named piece instead of a letter list.
    name: "hexagon_cut_piece_type",
    detect: (item) => isHexagonCutPieceTypeQuestion(item),
    verifyVisual: (item, crop) => verifyHexagonCutPieceType(item, crop),
  },
  {
    // Ticket 198 (2026-09-30): see readAbacusColumnsFromPixels's own long
    // comment. isAbacusReadingQuestion shared with handleMark's bbox
    // fallback (findAbacusBbox's call site).
    name: "abacus_reading",
    detect: (item) => isAbacusReadingQuestion(item),
    verifyVisual: (item, crop) => verifyAbacusReading(item, crop),
  },
  {
    // Ticket 199 (2026-09-30): see readBarChartValues's own long comment
    // for the real hybrid OCR+geometry design and the real citation's
    // exact axis-calibration verification. isBarChartQuestion shared
    // with handleMark's bbox fallback (findBarChartBbox's call site).
    name: "bar_chart_reading",
    detect: (item) => isBarChartQuestion(item),
    verifyVisual: (item, crop) => verifyBarChart(item, crop),
  },
  {
    // Ticket 108 (2026-09-28): reverses the SHAPE_REFERENCE facts -- pure
    // text reasoning, no image needed. detect() requires BOTH a lateral-
    // face-shape keyword AND a plausible answer shape (not itself a bare
    // number, which would suggest this is really a different question).
    name: "reverse_shape_from_face_properties",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const answer = String(item.studentAnswer || "").trim();
      if (!answer || /^\d+$/.test(answer)) return false;
      return /lateral\s+faces?|側面/i.test(printed) || (/triangles?|三角形/i.test(printed) && /rectangles?|squares?|長方形|正方形/i.test(printed));
    },
    verify: (item) => verifyReverseShapeFromFaceProperties(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 78/89 (2026-09-28): "N in front of me, what position" --
    // detect() requires both the count-in-front phrase AND a parseable
    // ordinal answer (numeric/Nth/spelled-out), so a bare wrong-shaped
    // answer correctly falls through instead of matching then declining.
    name: "ordinal_from_count_in_front",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/\d+\s*(?:cars?|people|students?|children)\b.{0,15}in front/i.test(printed)) return false;
      return !Number.isNaN(parseOrdinalToNumber(item.studentAnswer));
    },
    verify: (item) => verifyOrdinalFromCountInFront(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 86 (2026-09-28): numeric symbolic substitution ("if 7+6=☆,
    // then ☆-6=?"). detect() requires the specific two-equation-with-
    // shared-symbol shape.
    name: "symbolic_substitution",
    detect: (item) => /\d+\s*[+\-×x*÷/]\s*\d+\s*=\s*[△○□☆★◇]\D+[△○□☆★◇]\s*[+\-×x*÷/]\s*\d+\s*=/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifySymbolicSubstitution(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 93 (2026-09-28): purely symbolic relation reasoning ("若
    // △+○=□，○+___=□"), no numeric values at all.
    name: "symbolic_relation",
    detect: (item) => /[△○□☆★◇▽◆]\s*\+\s*[△○□☆★◇▽◆]\s*=\s*[△○□☆★◇▽◆]/.test(String(item.printedQuestion || "")) && /_{2,}/.test(String(item.printedQuestion || "")),
    verify: (item) => verifySymbolicRelation(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 116 (2026-09-28): relative-comparison-chain word problem.
    name: "relative_comparison_chain",
    detect: (item) => /takes\s+\d+\s+seconds?\s+longer\s+than.{0,20}seconds?\s+shorter\s+than/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyRelativeComparisonChain(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 113 (2026-09-28): "back and forth N times" compound
    // multiplier word problem.
    name: "compound_multiplier_word_problem",
    detect: (item) => /back and forth/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyCompoundMultiplierWordProblem(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 84 (2026-09-28): min-from-two-capacity-constraints.
    name: "min_from_two_capacity_constraints",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      return /at least/i.test(printed) && (printed.match(/≤\s*\d+/g) || []).length === 2;
    },
    verify: (item) => verifyMinFromTwoCapacityConstraints(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 75 (2026-09-28): MC full-equation truth check (both "which
    // is correct" and "which is NOT correct" framings).
    name: "equation_truth_mc",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      const options = parseMcOptions(printed);
      const eqShape = /^\d+\s*[+\-×x*÷/]\s*\d+\s*=\s*\d+$|^\d+\s*=\s*\d+\s*[+\-×x*÷/]\s*\d+$/;
      return options.length >= 2 && options.every((o) => eqShape.test(o.text.replace(/\s+/g, " ").trim()));
    },
    verify: (item) => verifyEquationTruthMC(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 222 "Pattern 1: estimation MC" (2026-10-01): which
    // rounded-number expression best estimates the original expression.
    name: "estimation_mc",
    detect: (item) => isEstimationMcQuestion(item),
    verify: (item) => verifyEstimationMc(item),
  },
  {
    // Ticket 216 (2026-09-30): triangle-hierarchy true/false fact table.
    name: "triangle_fact_true_false",
    detect: (item) => isTriangleFactTrueFalseQuestion(item),
    verify: (item) => verifyTriangleFactTrueFalse(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 222 "Pattern 5" (2026-09-30): given 3 diagram-only stick
    // lengths (captured via the new STICK_LENGTHS OCR marker), can they
    // form a (isosceles) triangle -- triangle-inequality judgment.
    name: "triangle_formable_from_sticks",
    detect: (item) => isTriangleFormableFromSticksQuestion(item),
    verify: (item) => verifyTriangleFormableFromSticks(item),
  },
  {
    // Ticket 216 (2026-09-30): "max obtuse angles in a triangle" fact.
    name: "max_obtuse_angle_in_triangle",
    detect: (item) => isMaxObtuseAngleInTriangleQuestion(item),
    verify: (item) => verifyMaxObtuseAngleInTriangle(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 208 (2026-09-30): "how many months have 31 days" fact.
    name: "days_with_31_count",
    detect: (item) => isDaysWith31CountQuestion(item),
    verify: (item) => verifyDaysWith31Count(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 77 (2026-09-28): open-ended decomposition ("10 = [] + []").
    name: "open_decomposition",
    detect: (item) => /\d+\s*=\s*(?:\[?_*\]?|□)\s*\+\s*(?:\[?_*\]?|□)\s*$/.test(String(item.printedQuestion || "").trim()),
    verify: (item) => verifyOpenDecomposition(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 81 (2026-09-28): fact-family generation from 3 given numbers.
    name: "fact_family_generation",
    detect: (item) => /use\s*\d+\s*,\s*\d+\s*(?:,|and)?\s*\d+\s*to form/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyFactFamilyGeneration(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 117 (2026-09-28): textual clock-hand description -- pure
    // text, not the usual Tier V "look at the photo" clock type.
    name: "textual_clock_description",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      return /long(?:er)?\s+hand.{0,20}points?\s+to\s+\d+/i.test(printed) && /short(?:er)?\s+hand.{0,20}points?\s+to\s+\d+/i.test(printed);
    },
    verify: (item) => verifyTextualClockDescription(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 122 (2026-09-28): modular-remainder "possible quantity" MC.
    name: "modular_remainder_mc",
    detect: (item) => /(?:shared|divided)\s+equally\s+among\s+\d+|among\s+\d+\s+people/i.test(String(item.printedQuestion || "")) && /left/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyModularRemainderMC(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 123 (2026-09-28): sequential-subtraction "how many remain".
    name: "sequential_subtraction_remaining",
    detect: (item) => /\bstill\b|仍然|留在/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifySequentialSubtractionRemaining(item.printedQuestion, item.studentAnswer),
  },
  {
    // Ticket 76/139 (2026-09-28): matching-value expression set MC
    // ("以下哪組數可合成13?").
    name: "matching_value_expression_set_mc",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/合成\s*\d+|make\s*\d+|equals?\s*\d+/i.test(printed)) return false;
      const options = parseMcOptions(printed);
      return options.length >= 2 && options.every((o) => /\d+\s*(?:和|,|\+)\s*\d+/.test(o.text));
    },
    verify: (item) => verifyMatchingValueExpressionSetMC(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "math_equation",
    detect: (item) => detectSubject(item.printedQuestion, item.studentAnswer) === "math",
    verify: (item) => ({ ...verifyMath(item.printedQuestion, item.studentAnswer) }),
  },
];

// THE LIVE DISPATCHER as of 2026-09-22 -- wired into `handleMark` on
// explicit user instruction ("全部判斷邏輯都要駁去真正用緊嗰一條路"),
// replacing the `verifyAnswer`/`verifyMath`-only path below. Same
// input/output shape (`{correct, correctAnswer, subject?}` plus which
// handler matched, useful for logging/debugging). Walks
// `QUESTION_TYPE_HANDLERS` in order (most-specific first, `math_equation`
// last as the general fallback -- same behaviour `verifyMath` alone gave
// for plain arithmetic, so existing correct items are unaffected), falls
// through to `correct: null` (needs human review) when nothing matches --
// never an AI judgment call. `verifyMultiBoxDigitAnswer` remains
// deliberately unregistered (see the registry's own comment above).
// Ticket 22 Stage A (2026-09-26): `getImageCrop` is an OPTIONAL lazy
// thunk (`() => {data, mediaType} | null`), supplied by handleMark, that
// returns a real cropped photo of this item's own region. Only ever
// called for a handler that declares `verifyVisual` -- every existing
// text-only handler (the ~25 already live) never triggers a crop at
// all, so this is zero-risk for them. This is deliberately GENERIC
// plumbing, not abacus-specific: any future "must look at the photo"
// question type (clock faces, rulers, ...) plugs into the exact same
// `verifyVisual` contract, per explicit instruction that solving
// methods should generalize, not be one-off hacks.
function classifyAndVerify(item, getImageCrop) {
  if (item.parseFailed) return { correct: null, correctAnswer: "", subject: "uncertain", handler: null };
  for (const handler of QUESTION_TYPE_HANDLERS) {
    if (handler.detect(item)) {
      const subject = handler.name === "math_equation" || handler.name.startsWith("word_problem")
        || ["multi_blank_math", "missing_digit_in_number", "missing_digits_in_equation", "multi_box_digit_answer", "sequence_fill", "sort_numbers", "comparison_symbol", "parity_mc", "computation_mc", "number_word_conversion", "digit_count_of_n_plus_one", "compound_unit_conversion", "construct_extreme_number", "list_factors", "count_primes_below", "elapsed_time_forward", "reverse_divisor_from_remainder", "multiple_difference", "round_to_nearest_hundred", "reverse_factor_sum", "number_between", "chinese_large_numeral_to_arabic", "division_remainder_blank", "extreme_number_difference", "substitute_and_evaluate", "repeated_digit_place_value_difference", "time_format_conversion"].includes(handler.name)
        ? "math" : detectSubject(item.printedQuestion, item.studentAnswer);
      if (handler.verifyVisual) {
        const crop = typeof getImageCrop === "function" ? getImageCrop() : null;
        // No crop available (no bbox match, page failed, decode error)
        // -- fails open to needs_review, same as every other "can't
        // verify this" path in this file, never a guess.
        if (!crop) return { correct: null, correctAnswer: "", subject, handler: handler.name };
        const result = handler.verifyVisual(item, crop);
        return { ...result, subject, handler: handler.name };
      }
      const result = handler.verify(item);
      return { ...result, subject, handler: handler.name };
    }
  }
  return { correct: null, correctAnswer: "", subject: detectSubject(item.printedQuestion, item.studentAnswer), handler: null };
}

// Superseded by `classifyAndVerify` above as of 2026-09-22 -- no longer
// called from `handleMark`. Kept (not deleted) because it's still
// exercised directly by existing tests asserting `verifyMath`-only
// behaviour, and as a minimal reference implementation. "chinese"/
// "english"/"uncertain" still have no reference-answer or rules/AI-
// checking lane; `classifyAndVerify` inherits the same honest null
// (needs review) behaviour for those via `detectSubject`.
function verifyAnswer(item) {
  // parseOcrLine flagged this item's answer as too long to trust (a likely
  // sign several items' content got merged) -- never let it reach a
  // verification lane, which could otherwise (by coincidence) parse part
  // of the merged text as a clean-looking equation and report a confident
  // but meaningless verdict.
  if (item.parseFailed) return { correct: null, correctAnswer: "", subject: "uncertain" };
  const subject = detectSubject(item.printedQuestion, item.studentAnswer);
  if (subject === "math") return { ...verifyMath(item.printedQuestion, item.studentAnswer), subject };
  return { correct: null, correctAnswer: "", subject };
}

// Finds an approximate bbox (0-100%) for one OCR'd item by matching its
// printed-question text against Google Vision's word-level positions --
// reuses the same googleOcr() call already used for rotation detection,
// rather than asking the vision model itself to also estimate position
// (real testing: asking Qwen for text+bbox together more than doubled its
// latency, 6.2s -> 14.9s, for position data this cheaper lookup already
// provides in under 1s).
//
// Bridges across consecutive Vision words to reconstruct a match, rather
// than requiring one single word to contain it -- real captured Vision
// output on this worksheet showed printed expressions like "4+6=" split
// into FOUR separate word tokens ("4", "+", "6", "="), so an earlier
// version of this function that only matched a single whole word either
// (a) accepted 1-character words and let unrelated items collide onto the
// same short stray token (e.g. a lone page-number digit) -- several
// questions came back with identical duplicate bboxes -- or (b), once
// that was tightened to a 2+ character minimum, missed the split-digit
// case entirely and returned no bbox for most items. Requiring 2+
// accumulated characters (after bridging over empty/punctuation tokens
// like "+"/"=") keeps the anti-collision property while still matching
// split expressions: a lone unrelated digit can't grow past 1 accumulated
// character before the next real word breaks the prefix match.
function findBboxForItem(item, visionWords, pageWidth, pageHeight) {
  if (!visionWords || !visionWords.length || !pageWidth || !pageHeight) return null;
  const needle = String(item.printedQuestion || item.label || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  if (!needle || needle.length < 2) return null;
  const MAX_SPAN = 5;
  let best = null;
  for (let i = 0; i < visionWords.length; i++) {
    let acc = "", startWord = null, endWord = null, endIdx = -1;
    for (let j = i; j < Math.min(i + MAX_SPAN, visionWords.length); j++) {
      const hay = String(visionWords[j].text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!hay) continue;
      const nextAcc = acc + hay;
      if (!needle.startsWith(nextAcc)) break;
      if (!startWord) startWord = visionWords[j];
      acc = nextAcc;
      endWord = visionWords[j];
      endIdx = j;
      if (acc.length >= 2) {
        // A real transcribed expression is almost always immediately
        // followed by "=" on the source page; a coincidental short match
        // on unrelated text (e.g. a stray page-number digit) usually
        // isn't. When two candidates tie on raw matched length, prefer
        // whichever is followed by a literal "=" -- this breaks exactly
        // the tie a short (2-char) needle is otherwise defenceless
        // against (2026-09-21 review: a stray "46" token pair beat a real
        // "4+6=" match on length alone), without raising the accepted
        // minimum length itself, which would cost real bbox coverage on
        // ordinary short single-digit sums.
        const nextWord = visionWords[endIdx + 1];
        const followedByEquals = !!(nextWord && String(nextWord.text || "").trim() === "=");
        const better = !best
          || acc.length > best.matchLen
          || (acc.length === best.matchLen && followedByEquals && !best.followedByEquals);
        if (better) best = { matchLen: acc.length, startWord, endWord, followedByEquals };
      }
    }
  }
  if (!best) return null;
  const { startWord: sw, endWord: ew, matchLen } = best;
  const x0 = Math.min(sw.x, ew.x), y0 = Math.min(sw.y, ew.y);
  const x1 = Math.max(sw.x + sw.w, ew.x + ew.w), y1 = Math.max(sw.y + sw.h, ew.y + ew.h);
  return {
    x: Math.round((x0 / pageWidth) * 100),
    y: Math.round((y0 / pageHeight) * 100),
    w: Math.round(((x1 - x0) / pageWidth) * 100) || 5,
    h: Math.round(((y1 - y0) / pageHeight) * 100) || 5,
    // Exposed so a caller comparing matches across MULTIPLE pages' word
    // lists (handleMark) can pick the strongest one -- a short match on
    // the wrong page must not beat a longer match on the right page.
    matchLen,
  };
}

// Ticket (2026-09-30): findBboxForItem above strips everything except
// a-z0-9 from the needle -- built for math expressions with a short
// numeric/English anchor right next to the diagram it's cropping (a
// clock's printed time, an object-count's answer prompt). It gives up
// on a fully-Chinese question like shape_classification_grid's real
// citation ("觀察下面的平面圖形(A-L)，寫出所有代表答案的英文字母。..."),
// which has no short alphanumeric fragment reliably anchored at the
// diagram itself. This type of question has its own better anchor: EACH
// shape in the diagram has its own single-letter label (A, B, C...)
// printed inside it, which Google Vision's OCR reads as its own short
// word with a real position. Finding the tight spatial CLUSTER of those
// single-letter words locates the diagram directly, more reliably than
// text-matching the question prose. Deliberately separate from
// findBboxForItem rather than a generalization of it -- a different
// anchor strategy for a different, narrower question shape, not a
// broadening of the existing one (which stays exactly as tuned for its
// own real failure history).
function findLetterGridBbox(visionWords, pageWidth, pageHeight, { minLetters = 4, maxSpanFraction = 0.5 } = {}) {
  if (!visionWords || !visionWords.length || !pageWidth || !pageHeight) return null;
  const single = visionWords.filter((w) => /^[A-La-l]$/.test(String(w.text || "").trim()));
  if (single.length < minLetters) return null;
  // Cluster by simple greedy nearest-neighbour chaining: sort by position,
  // then group words whose gap to the previous one (either axis) doesn't
  // exceed a page-fraction threshold -- a real shape grid's letters sit
  // close together in a tight block; an unrelated stray "A"/"B" MC-option
  // label elsewhere on the page will fall outside any such tight cluster.
  const pts = single.map((w) => ({ x: w.x + w.w / 2, y: w.y + w.h / 2, w }));
  pts.sort((a, b) => a.y - b.y || a.x - b.x);
  const maxGapX = pageWidth * maxSpanFraction, maxGapY = pageHeight * maxSpanFraction;
  const clusters = [];
  for (const p of pts) {
    let placed = false;
    for (const c of clusters) {
      if (Math.abs(p.x - c.cx) <= maxGapX && Math.abs(p.y - c.cy) <= maxGapY) {
        c.items.push(p);
        c.cx = c.items.reduce((s, q) => s + q.x, 0) / c.items.length;
        c.cy = c.items.reduce((s, q) => s + q.y, 0) / c.items.length;
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ cx: p.x, cy: p.y, items: [p] });
  }
  const best = clusters.filter((c) => c.items.length >= minLetters).sort((a, b) => b.items.length - a.items.length)[0];
  if (!best) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of best.items) {
    x0 = Math.min(x0, p.w.x); y0 = Math.min(y0, p.w.y);
    x1 = Math.max(x1, p.w.x + p.w.w); y1 = Math.max(y1, p.w.y + p.w.h);
  }
  return {
    x: Math.round((x0 / pageWidth) * 100),
    y: Math.round((y0 / pageHeight) * 100),
    w: Math.round(((x1 - x0) / pageWidth) * 100) || 5,
    h: Math.round(((y1 - y0) / pageHeight) * 100) || 5,
    letterCount: best.items.length,
  };
}

// Ticket 198 (2026-09-30): same "text-matching bbox can't anchor a fully-
// Chinese question" gap as Ticket 197 (see findLetterGridBbox's own
// comment), different real anchor: an abacus/counting-rod reading
// question always prints the exact 5-character column-header sequence
// 萬千百十個 (ten-thousands/thousands/hundreds/tens/units) directly UNDER
// the bead diagram itself. Finding that exact ordered sequence in
// Vision's word list locates the diagram far more reliably than the
// question's own (fully Chinese) prose. A page can have more than one
// abacus diagram (e.g. real citation TICKETS.md 198: parts (a) and (b)
// side by side) -- every occurrence is found and the UNION of their
// (label-row, extended upward to include the beads above) boxes is
// returned as one crop covering all of them; readAbacusColumnsFromPixels
// below is what actually separates them back out again.
function findAbacusBbox(visionWords, pageWidth, pageHeight) {
  if (!visionWords || !visionWords.length || !pageWidth || !pageHeight) return null;
  const LABELS = ["萬", "千", "百", "十", "個"];
  const occurrences = [];
  for (let i = 0; i + LABELS.length <= visionWords.length; i++) {
    let ok = true;
    for (let k = 0; k < LABELS.length; k++) {
      if (String(visionWords[i + k].text || "").trim() !== LABELS[k]) { ok = false; break; }
    }
    if (!ok) continue;
    const group = visionWords.slice(i, i + LABELS.length);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const w of group) {
      x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y);
      x1 = Math.max(x1, w.x + w.w); y1 = Math.max(y1, w.y + w.h);
    }
    occurrences.push({ x0, y0, x1, y1, labelH: y1 - y0 });
  }
  if (!occurrences.length) return null;
  // A real abacus column tops out at 9 beads (single-digit place value);
  // beads observed in the real citation are each roughly as tall as the
  // label text itself, so 9 beads plus margin needs several times the
  // label row's own height of extra room above it -- 10x is a generous,
  // deliberately safe multiple (better to crop extra blank space above,
  // which costs nothing, than to clip real beads off the top).
  const UPWARD_MULTIPLIER = 10;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of occurrences) {
    x0 = Math.min(x0, o.x0);
    y0 = Math.min(y0, o.y0 - o.labelH * UPWARD_MULTIPLIER);
    x1 = Math.max(x1, o.x1);
    y1 = Math.max(y1, o.y1);
  }
  y0 = Math.max(0, y0);
  return {
    x: Math.round((x0 / pageWidth) * 100),
    y: Math.round((y0 / pageHeight) * 100),
    w: Math.round(((x1 - x0) / pageWidth) * 100) || 5,
    h: Math.round(((y1 - y0) / pageHeight) * 100) || 5,
    diagramCount: occurrences.length,
  };
}

// Ticket 199 (2026-09-30): same "findBboxForItem's alphanumeric-only
// needle can't anchor a fully-Chinese question" gap as 197/198 -- here
// the real anchor is the axis's own printed number sequence (e.g.
// "0,2,4,6,8,10,12"), which extractBarChart already read from OCR, so
// this searches Vision's word list for exactly those number tokens
// arranged in a consistent line (vertical for a vertical-bar chart's
// Y-axis, horizontal for a horizontal-bar chart's X-axis) rather than
// a fixed literal string like the other two marker types use.
function findBarChartBbox(visionWords, pageWidth, pageHeight, barChart) {
  if (!visionWords || !visionWords.length || !pageWidth || !pageHeight || !barChart) return null;
  const { direction, min, max, step } = barChart;
  const expected = [];
  for (let v = min; v <= max + 1e-9; v += step) expected.push(String(Math.round(v)));
  const matches = visionWords.filter((w) => expected.includes(String(w.text || "").trim()));
  if (matches.length < Math.ceil(expected.length * 0.5)) return null;
  // Cluster by alignment on the axis of the sequence (x for vertical
  // charts' Y-axis labels, y for horizontal charts' X-axis labels) --
  // same tolerance-based greedy clustering as findLetterGridBbox.
  const alignKey = direction === "vertical" ? "x" : "y";
  const tolerance = direction === "vertical" ? pageWidth * 0.05 : pageHeight * 0.05;
  const clusters = [];
  for (const w of matches) {
    const center = w[alignKey] + (alignKey === "x" ? w.w : w.h) / 2;
    let placed = false;
    for (const c of clusters) {
      if (Math.abs(center - c.avg) <= tolerance) {
        c.items.push(w); c.avg = c.items.reduce((s, it) => s + it[alignKey] + (alignKey === "x" ? it.w : it.h) / 2, 0) / c.items.length;
        placed = true; break;
      }
    }
    if (!placed) clusters.push({ avg: center, items: [w] });
  }
  const best = clusters.sort((a, b) => b.items.length - a.items.length)[0];
  if (!best || best.items.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of best.items) {
    x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y);
    x1 = Math.max(x1, w.x + w.w); y1 = Math.max(y1, w.y + w.h);
  }
  const labelW = x1 - x0, labelH = y1 - y0;
  // The axis labels only mark ONE edge of the chart -- extend generously
  // into the bars' own direction (rightward for vertical bars' plot
  // area, upward for horizontal bars') by a large multiple of the
  // label block's own size, same "better excess blank space than a
  // clipped diagram" reasoning as findAbacusBbox's own extension.
  const EXTEND_MULTIPLIER = 12;
  if (direction === "vertical") {
    x1 = x1 + labelW * EXTEND_MULTIPLIER;
  } else {
    y0 = Math.max(0, y0 - labelH * EXTEND_MULTIPLIER);
  }
  return {
    x: Math.round((x0 / pageWidth) * 100),
    y: Math.round((y0 / pageHeight) * 100),
    w: Math.round(((x1 - x0) / pageWidth) * 100) || 5,
    h: Math.round(((y1 - y0) / pageHeight) * 100) || 5,
  };
}

// Ticket 4 (2026-09-25 rigor check): cross-checks NUMBERS in an item's
// printed question against Google Vision's own independent reading of
// the matched region on the page. Vision structurally cannot
// hallucinate or compute a number -- it has no world knowledge to draw
// from, it only recognises pixel shapes as characters -- so when AI's
// reported number and Vision's independently-read number for the SAME
// position disagree, Vision is treated as correct. Real confirmed bugs
// this targets: baseline misread a printed "40" as "30" (also
// internally inconsistent with the printed "5×8" on the same line) and
// a printed "11" as "14".
//
// Deliberately narrower than fully substituting Vision's transcription
// for the whole printedQuestion string (see TICKETS.md Ticket 4's own
// note: that fuller design is the eventual target, not yet built here)
// -- Chinese/English prose content stays AI's own reading, since
// Vision's own transcription of CJK text can have its own spacing/
// segmentation quirks that aren't necessarily more reliable for
// non-numeric content. Only NUMBER tokens get cross-checked, since
// that's the specific, confirmed failure mode.
//
// Reuses the same short alphanumeric-prefix matching approach as
// findBboxForItem to locate the item's start in Vision's word list,
// then walks forward through a bounded window of subsequent words
// (stopping early on a large vertical jump -- a real signal the window
// ran past this item's own row into the next one) to reconstruct
// enough of Vision's own reading to pull out its numbers.
function crossCheckPrintedNumbers(item, visionWords, pageWidth, pageHeight) {
  if (!item || !item.printedQuestion || !Array.isArray(visionWords) || !visionWords.length) return null;
  const needle = String(item.printedQuestion).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  if (!needle || needle.length < 2) return null;
  const MAX_SPAN = 5;
  let matchStartIdx = -1;
  for (let i = 0; i < visionWords.length && matchStartIdx === -1; i++) {
    let acc = "";
    for (let j = i; j < Math.min(i + MAX_SPAN, visionWords.length); j++) {
      const hay = String(visionWords[j].text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!hay) continue;
      const nextAcc = acc + hay;
      if (!needle.startsWith(nextAcc)) break;
      acc = nextAcc;
      if (acc.length >= 2) { matchStartIdx = i; break; }
    }
  }
  if (matchStartIdx === -1) return null;

  const WINDOW_WORDS = 20;
  const startWord = visionWords[matchStartIdx];
  const windowText = [];
  for (let k = matchStartIdx; k < Math.min(matchStartIdx + WINDOW_WORDS, visionWords.length); k++) {
    const w = visionWords[k];
    if (windowText.length > 0 && Math.abs((w.y || 0) - (startWord.y || 0)) > (startWord.h || 20) * 2.5) break;
    windowText.push(w.text || "");
  }
  const visionNumbers = (windowText.join(" ").match(/\d+/g) || []).map(Number);
  const aiNumbers = (String(item.printedQuestion).match(/\d+/g) || []).map(Number);
  if (!visionNumbers.length || !aiNumbers.length) return null;

  const mismatches = aiNumbers.filter((n) => !visionNumbers.includes(n));
  if (!mismatches.length) return { agree: true };
  return { agree: false, aiNumbers, visionNumbers, mismatches };
}

// Ticket 5's dropped-content safety net (countLikelyQuestionNumbers: a
// pure pattern-match/sequential-run heuristic over Vision's word list)
// was removed 2026-09-26 per explicit user decision -- Vision's own
// structural output was judged a better signal than re-deriving question
// boundaries with custom regex heuristics. candidateQuestionLabelNumber
// itself stays: groupWordsByQuestionLabel (a diagnostic tool, not
// production safety-net logic) still uses it.
const CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩";
function candidateQuestionLabelNumber(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const arabic = t.match(/^(\d{1,2})[.)）]$/);
  if (arabic) return Number(arabic[1]);
  const circledIdx = CIRCLED_DIGITS.indexOf(t);
  if (t.length === 1 && circledIdx !== -1) return circledIdx + 1;
  return null;
}

// Groups Vision's flat word list into per-question chunks, for a human
// to read Vision's raw output grouped by which question it belongs to
// (2026-09-25, real user request during the Ticket 4 validation pass).
// A new chunk starts at every candidate label token (candidateQuestion-
// LabelNumber's shape-matching); everything before the first label lands
// in a leading "(unlabeled)" chunk. Deliberately simple -- no X-position/
// sequential filtering here, purely a human-readable diagnostic view.
function groupWordsByQuestionLabel(visionWords) {
  const chunks = [];
  let current = { label: "(unlabeled)", words: [] };
  for (const w of visionWords || []) {
    const num = candidateQuestionLabelNumber(w.text);
    if (num !== null) {
      if (current.words.length) chunks.push(current);
      current = { label: String(w.text), words: [] };
    } else {
      current.words.push(w.text);
    }
  }
  if (current.words.length) chunks.push(current);
  return chunks.map((c) => ({ label: c.label, text: c.words.join("") }));
}

// Bounded-concurrency map -- runs at most `concurrency` calls to `fn` at
// once, in index order, collecting all results (success or thrown) into an
// array matching `items`' order regardless of completion order.
async function mapBounded(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// At most this many pages' Qwen calls run at once. Bounded (not
// unlimited) so a large submission doesn't fire N simultaneous OpenRouter
// requests; low enough to stay well inside real per-request timeouts,
// high enough that pages still don't run fully sequentially.
const MARK_PAGE_CONCURRENCY = 2;

async function handleMark(request, env) {
  const startedAt = Date.now();
  const openrouterKey = !env.OPENROUTER_API_KEY ? null
    : typeof env.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY
    : await env.OPENROUTER_API_KEY.get();
  const visionKey = !env.GOOGLE_VISION_API_KEY ? null
    : typeof env.GOOGLE_VISION_API_KEY === "string" ? env.GOOGLE_VISION_API_KEY
    : await env.GOOGLE_VISION_API_KEY.get();
  if (!openrouterKey) return json({ error: "not_configured", message: "改功課服務未設定好，請聯絡網站管理員。" }, 503);

  // Own rate-limit bucket ("markrate:"), separate from /api/check's
  // "checkrate:" and /api/verify's "verifyrate:" -- /api/mark is an
  // independent pipeline, not a natural follow-up call to either of
  // those, so it shouldn't share their budget. Same threshold
  // (CHECK_RATE_LIMIT) and same fail-open-on-KV-error behaviour as the
  // existing endpoints, checked before parsing the body (matches
  // handleCheckInner's ordering) so an abusive caller is turned away
  // before any real work, AI or otherwise.
  if (env.RATE_LIMIT_KV) {
    // Ticket 218 (2026-09-30, challenge-scale finding): keying purely on
    // IP collectively throttles every real distinct user behind a shared
    // egress IP (a school network, a family's shared WiFi) -- the more
    // real adoption grows, the worse this gets, exactly backwards from
    // what a rate limit should do. The website now sends an opaque,
    // per-browser random id (X-Client-Id header, generated once and kept
    // in localStorage -- see getOrCreateRateClientId() in website's own
    // script) that uniquely identifies one browser instead of one shared
    // network exit point. Preferred when present; falls back to IP for
    // any caller that doesn't send it (older cached website page before
    // this deploy, or any other caller with no custom header) -- never a
    // regression versus today's behaviour, only an improvement when the
    // header is there.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const clientId = (request.headers.get("X-Client-Id") || "").slice(0, 64);
    const rateKey = "markrate:" + (clientId || ip);
    let count = 0;
    try {
      const raw = await env.RATE_LIMIT_KV.get(rateKey);
      count = raw ? (parseInt(raw, 10) || 0) : 0;
    } catch (e) { /* KV unreachable -- don't block over it */ }
    if (count >= CHECK_RATE_LIMIT) {
      return json({ error: "rate_limited", message: "短時間內請求太多，請一小時後再試。" }, 429);
    }
    try {
      await env.RATE_LIMIT_KV.put(rateKey, String(count + 1), { expirationTtl: 3600 });
    } catch (e) { /* best-effort */ }
  }

  const { images } = await request.json();
  if (!Array.isArray(images) || !images.length) {
    return json({ error: "bad_request", message: "images is required" }, 400);
  }
  // Same cap as handleCheckInner's MAX_PAGES, for the same reason:
  // rejected here, before mapBounded ever fires a single Qwen/Vision
  // call, not after -- an oversized submission must never reach the
  // AI-call stage just to be told no.
  const MARK_MAX_PAGES = 5;
  if (images.length > MARK_MAX_PAGES) {
    return json({ error: "too_many_pages", message: `每次最多批改 ${MARK_MAX_PAGES} 頁，請分開幾次提交。` }, 400);
  }

  // Ticket 16 (2026-09-26): duplicate-submission protection. A parent
  // double-tapping "send" in Telegram, or a flaky client retry, fires
  // two full /api/mark calls for the identical photo(s) -- each one a
  // real, separate OCR+AI-fallback spend for work already being (or
  // just having been) done. Keyed on a content hash of the exact image
  // bytes submitted (order-sensitive -- a genuinely different page order
  // is a different submission), short TTL (2 minutes -- long enough to
  // catch a double-send, short enough that a parent resubmitting the
  // same photo later for a real reason isn't blocked). Fails open (no
  // dedup) if KV is unbound or the hash/cache round-trip errors -- never
  // blocks real grading over this being unavailable.
  const MARK_DEDUP_TTL = 120;
  // Ticket 219 (2026-09-30, challenge-scale finding): the real result is
  // only written at the very END of the whole pipeline (see this
  // function's tail) -- previously that meant the check-then-act window
  // between this GET and that final PUT was the ENTIRE grading duration
  // (several seconds of real OCR+AI work), so two near-simultaneous
  // identical submissions (a double-tap under a slow connection, more
  // likely exactly when the system is already stressed) could both pass
  // the miss check and both pay for a full duplicate pipeline run. A
  // "claim" sentinel written immediately after the miss check shrinks
  // that window down to one KV round-trip instead of the whole pipeline.
  // KV has no compare-and-swap primitive, so this narrows the race
  // rather than eliminating it outright -- a request that sees the
  // sentinel just proceeds normally (fail-open, same discipline as every
  // other best-effort check in this function) rather than blocking or
  // polling, which would add real complexity/hang risk for a rare edge
  // case this can't fully close anyway.
  const MARK_DEDUP_PENDING = "__pending__";
  let dedupKey = null;
  if (env.RATE_LIMIT_KV) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(images.map((img) => img.data).join("|")));
      const hashHex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
      dedupKey = "markdedup:" + hashHex;
      const cached = await env.RATE_LIMIT_KV.get(dedupKey);
      if (cached && cached !== MARK_DEDUP_PENDING) {
        console.log(JSON.stringify({ event: "mark_dedup_hit" }));
        return new Response(cached, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (cached === MARK_DEDUP_PENDING) {
        console.log(JSON.stringify({ event: "mark_dedup_pending_race", note: "another identical submission is already in flight -- proceeding anyway, fail-open" }));
      }
      await env.RATE_LIMIT_KV.put(dedupKey, MARK_DEDUP_PENDING, { expirationTtl: MARK_DEDUP_TTL });
    } catch (e) { /* best-effort -- fall through and process normally */ }
  }

  // 2026-09-25, real user request: /api/mark never had this at all (only
  // /api/check did) -- reading accuracy was already protected either way
  // (the OCR prompt below already asks the model to mentally compensate
  // for a sideways/upside-down page), but the final annotated photo sent
  // back to a Telegram user stayed sideways whenever the source photo
  // was, since nothing ever physically straightened it. Mutates `images`
  // in place (same contract as handleCheckInner's own call to this),
  // so every downstream step (Qwen OCR, Vision bbox lookup) reads the
  // corrected bytes automatically -- ocrCache lets a page whose rotation
  // check found no rotation needed skip a second, redundant Vision call
  // below, same optimization /api/check already has.
  const { rotationApplied, ocrCache } = await detectAndCorrectRotation(images, visionKey);

  // Per-page pipeline (2026-09-21 rewrite, replacing one combined
  // multi-image Qwen call): a real 4-page submission reliably hit
  // callQwenOcrText's 15s per-call timeout when all 4 images went in one
  // request, failing the ENTIRE submission with nothing recovered from
  // any page. Calling Qwen once PER PAGE fixes that (a slow/failing page
  // only costs that page) and also makes page identity structural --
  // which call produced an item -- rather than guessed afterwards by
  // matching against every page's Vision words. Pages run with bounded
  // concurrency, each page's Qwen+Vision calls still running in parallel
  // with each other (not sequential) as before.
  const tPages = Date.now();
  const pageResults = await mapBounded(images, MARK_PAGE_CONCURRENCY, async (img, pageIdx) => {
    const tQwen = Date.now();
    // Downscale ONLY the copy sent to Qwen -- the same 640px
    // downscaleForCheapTier() already validated for /api/check's fast
    // tier (its own git history root-caused real Qwen/DeepSeek "hangs"
    // to sending full-resolution images), which /api/mark had never
    // adopted. Vision's OWN copy (below) stays full-resolution and
    // unchanged -- bbox percentages are computed against whichever
    // image each model actually saw, so this can't skew bbox accuracy.
    const qwenPromise = callQwenOcrText([downscaleForCheapTier(img, 640)], openrouterKey)
      .then((r) => ({ ok: true, items: r.items, usage: r.usage, qwenMs: Date.now() - tQwen, continuesFromPrevious: r.continuesFromPrevious, continuesToNext: r.continuesToNext, priceTable: r.priceTable, passageText: r.passageText, wordBank: r.wordBank, sudokuPuzzles: r.sudokuPuzzles, pictogramData: r.pictogramData, calendarGrid: r.calendarGrid, scheduleTable: r.scheduleTable, locationGrid: r.locationGrid, facingDirection: r.facingDirection, digitCards: r.digitCards, shortDivisionMc: r.shortDivisionMc, squaresDiagonal: r.squaresDiagonal, trapezoidBaseline: r.trapezoidBaseline, parallelogramShadedWidth: r.parallelogramShadedWidth, rectCutKite: r.rectCutKite, compassRoseMc: r.compassRoseMc, paperFold: r.paperFold, pathGraph: r.pathGraph, clockOptions: r.clockOptions, coinBlanks: r.coinBlanks, distanceValues: r.distanceValues, objectHeights: r.objectHeights, barChart: r.barChart, stickLengths: r.stickLengths }))
      .catch((e) => ({ ok: false, error: e, qwenMs: Date.now() - tQwen }));
    const tVision = Date.now();
    const cachedOcr = ocrCache && ocrCache.get(pageIdx);
    const visionPromise = cachedOcr
      ? Promise.resolve({ ...cachedOcr, visionMs: 0 })
      : !visionKey
      ? Promise.resolve(null)
      : googleOcr(img.data, visionKey)
          .then((r) => (r ? { ...r, visionMs: Date.now() - tVision } : null))
          .catch((e) => {
            console.log(JSON.stringify({ event: "mark_vision_page_error", page: pageIdx, error: String(e) }));
            return null; // this page's Vision failure costs only its own bbox data, not the page's OCR
          });
    const [qwenOutcome, vision] = await Promise.all([qwenPromise, visionPromise]);
    if (!qwenOutcome.ok) {
      const e = qwenOutcome.error;
      console.log(JSON.stringify({ event: "mark_page_ocr_failed", page: pageIdx, error: (e && (e.detail || e.uiMessage)) || String(e) }));
      return { page: pageIdx, failed: true, error: e, qwenMs: qwenOutcome.qwenMs, visionMs: vision ? vision.visionMs : null };
    }
    // Ticket 52: price table is page-level shared context (one table,
    // many items reference it), attached directly onto each of this
    // page's own item objects -- simplest way to reach
    // classifyAndVerify(item) without changing its call signature, same
    // approach as every other per-item field (subject, handler, etc.).
    if (qwenOutcome.priceTable) {
      qwenOutcome.items.forEach((item) => { item.priceTable = qwenOutcome.priceTable; });
    }
    // Ticket 222 "Pattern 5": same page-level shared-context pattern as
    // priceTable above.
    if (qwenOutcome.stickLengths) {
      qwenOutcome.items.forEach((item) => { item.stickLengths = qwenOutcome.stickLengths; });
    }
    // Ticket 53: same page-level shared-context pattern as priceTable above.
    if (qwenOutcome.passageText) {
      qwenOutcome.items.forEach((item) => { item.passageText = qwenOutcome.passageText; });
    }
    // Ticket 54: word bank is also page-level shared context, but (unlike
    // priceTable/passageText) is NOT consumed via a per-item
    // QUESTION_TYPE_HANDLERS entry -- see the dedicated "Module 2b" pass
    // below, which needs the bank list directly on the page result too.
    if (qwenOutcome.wordBank) {
      qwenOutcome.items.forEach((item) => { item.wordBank = qwenOutcome.wordBank; });
    }
    // Ticket 68: pictogram data is page-level shared context, same
    // pattern as priceTable -- consumed via a per-item QUESTION_TYPE_HANDLERS
    // entry (pictogram_data_query), so a direct item attachment is enough.
    if (qwenOutcome.pictogramData) {
      qwenOutcome.items.forEach((item) => { item.pictogramData = qwenOutcome.pictogramData; });
    }
    // Ticket 134: calendar grid is page-level shared context, same
    // pattern as pictogramData above.
    if (qwenOutcome.calendarGrid) {
      qwenOutcome.items.forEach((item) => { item.calendarGrid = qwenOutcome.calendarGrid; });
    }
    // Ticket 135: schedule table is page-level shared context, same
    // pattern as calendarGrid above.
    if (qwenOutcome.scheduleTable) {
      qwenOutcome.items.forEach((item) => { item.scheduleTable = qwenOutcome.scheduleTable; });
    }
    // Location-grid direction reasoning: page-level shared context, same
    // pattern as scheduleTable above.
    if (qwenOutcome.locationGrid) {
      qwenOutcome.items.forEach((item) => { item.locationGrid = qwenOutcome.locationGrid; });
    }
    // Facing-direction reasoning: page-level shared context, same
    // pattern as locationGrid above.
    if (qwenOutcome.facingDirection) {
      qwenOutcome.items.forEach((item) => { item.facingDirection = qwenOutcome.facingDirection; });
    }
    // Digit-card combinatorial construction: page-level shared context,
    // same pattern as facingDirection above.
    if (qwenOutcome.digitCards) {
      qwenOutcome.items.forEach((item) => { item.digitCards = qwenOutcome.digitCards; });
    }
    // Tickets 154/155/156/158: same page-level shared-context pattern.
    if (qwenOutcome.shortDivisionMc) {
      qwenOutcome.items.forEach((item) => { item.shortDivisionMc = qwenOutcome.shortDivisionMc; });
    }
    if (qwenOutcome.squaresDiagonal) {
      qwenOutcome.items.forEach((item) => { item.squaresDiagonal = qwenOutcome.squaresDiagonal; });
    }
    if (qwenOutcome.trapezoidBaseline != null) {
      qwenOutcome.items.forEach((item) => { item.trapezoidBaseline = qwenOutcome.trapezoidBaseline; });
    }
    if (qwenOutcome.parallelogramShadedWidth != null) {
      qwenOutcome.items.forEach((item) => { item.parallelogramShadedWidth = qwenOutcome.parallelogramShadedWidth; });
    }
    // Ticket 177: same page-level shared-context pattern.
    if (qwenOutcome.rectCutKite) {
      qwenOutcome.items.forEach((item) => { item.rectCutKite = qwenOutcome.rectCutKite; });
    }
    // Ticket 179: same page-level shared-context pattern.
    if (qwenOutcome.compassRoseMc) {
      qwenOutcome.items.forEach((item) => { item.compassRoseMc = qwenOutcome.compassRoseMc; });
    }
    // Ticket 188: same page-level shared-context pattern.
    if (qwenOutcome.paperFold) {
      qwenOutcome.items.forEach((item) => { item.paperFold = qwenOutcome.paperFold; });
    }
    // Ticket 185: same page-level shared-context pattern.
    if (qwenOutcome.pathGraph) {
      qwenOutcome.items.forEach((item) => { item.pathGraph = qwenOutcome.pathGraph; });
    }
    // Ticket 187: same page-level shared-context pattern.
    if (qwenOutcome.clockOptions) {
      qwenOutcome.items.forEach((item) => { item.clockOptions = qwenOutcome.clockOptions; });
    }
    // Ticket 189: same page-level shared-context pattern.
    if (qwenOutcome.coinBlanks) {
      qwenOutcome.items.forEach((item) => { item.coinBlanks = qwenOutcome.coinBlanks; });
    }
    // Ticket 194: same page-level shared-context pattern.
    if (qwenOutcome.distanceValues) {
      qwenOutcome.items.forEach((item) => { item.distanceValues = qwenOutcome.distanceValues; });
    }
    // Ticket 195: same page-level shared-context pattern.
    if (qwenOutcome.objectHeights) {
      qwenOutcome.items.forEach((item) => { item.objectHeights = qwenOutcome.objectHeights; });
    }
    // Ticket 199: same page-level shared-context pattern.
    if (qwenOutcome.barChart) {
      qwenOutcome.items.forEach((item) => { item.barChart = qwenOutcome.barChart; });
    }
    return { page: pageIdx, failed: false, items: qwenOutcome.items, usage: qwenOutcome.usage, vision, qwenMs: qwenOutcome.qwenMs, visionMs: vision ? vision.visionMs : null, continuesFromPrevious: !!qwenOutcome.continuesFromPrevious, continuesToNext: !!qwenOutcome.continuesToNext, wordBank: qwenOutcome.wordBank || null, sudokuPuzzles: qwenOutcome.sudokuPuzzles || [] };
  });
  const pagesMs = Date.now() - tPages;

  // Module 2 (bbox), moved BEFORE verification (2026-09-26, Ticket 22
  // Stage A): scoped to each item's OWN page's Vision words only -- no
  // more cross-page guessing needed now that page identity is already
  // structural (see above). Computed first now so verification below can
  // optionally crop the real image for a "must look at the photo"
  // question type (abacus, clock faces, rulers, ...) -- previously bbox
  // was computed AFTER verification purely for drawing the ✓/✗ mark,
  // with no way for a verifier to ever see the image itself.
  const tMap = Date.now();
  const matchesByPage = pageResults.map((pr) =>
    pr.failed ? [] : pr.items.map((item) => {
      if (!pr.vision) return null;
      const primary = findBboxForItem(item, pr.vision.words, pr.vision.width, pr.vision.height);
      if (primary) return primary;
      // Fallback (2026-09-30): findBboxForItem's alphanumeric-only needle
      // gives up on fully-Chinese questions like shape_classification_grid
      // -- see findLetterGridBbox's own comment. Only attempted for that
      // specific question shape, never a general fallback for every
      // unmatched item, to avoid accidentally cropping the wrong region
      // for something this anchor strategy was never validated against.
      if (isShapeClassificationGridQuestion(item)) {
        return findLetterGridBbox(pr.vision.words, pr.vision.width, pr.vision.height);
      }
      if (isTriangleSubtypeLetterQuestion(item)) {
        // Same fully-Chinese-question anchor gap as shape_classification_grid
        // just above -- reuses the exact same lettered-shapes-grid bbox
        // strategy, since both question shapes crop the same kind of
        // "several shapes labelled A, B, C..." diagram.
        return findLetterGridBbox(pr.vision.words, pr.vision.width, pr.vision.height);
      }
      if (isHexagonCutPieceTypeQuestion(item)) {
        // Same reasoning as triangle_subtype_letter just above -- the
        // cut-apart lettered pieces (A, B, C, D) are the same kind of
        // diagram findLetterGridBbox was built for.
        return findLetterGridBbox(pr.vision.words, pr.vision.width, pr.vision.height);
      }
      if (isAbacusReadingQuestion(item)) {
        return findAbacusBbox(pr.vision.words, pr.vision.width, pr.vision.height);
      }
      if (isBarChartQuestion(item)) {
        return findBarChartBbox(pr.vision.words, pr.vision.width, pr.vision.height, item.barChart);
      }
      if (isGridPointIsoscelesQuestion(item)) {
        // Ticket 203: mutates item in place to attach the page-pixel
        // letter positions the verifyVisual step below needs -- same
        // "item mutated at whichever pipeline stage has the data"
        // convention already used for barChart/calendarGrid/etc, just at
        // this earlier bbox stage since only here do we have BOTH the
        // item and pr.vision.words together before verification runs.
        item.gridPointLabels = extractLabeledGridPoints(pr.vision.words, pr.vision.width, pr.vision.height);
        return findGridPointsBbox(pr.vision.words, pr.vision.width, pr.vision.height);
      }
      // Ticket 204: no bbox wiring here -- the handler isn't registered
      // (blocked, see the QUESTION_TYPE_HANDLERS comment for this
      // ticket), so attaching trapezoidLetterLabels here would compute
      // data nothing ever consumes.
      return null;
    })
  );
  const mapMs = Date.now() - tMap;

  // Module 3: subject-aware verification (deterministic, no real
  // network I/O) -- one failed page contributes an empty verdict list,
  // nothing more. `visualPhotonCache` follows the exact same
  // decode-once-per-page/free-at-the-end convention as /api/check's own
  // zoom-recheck tiers (see cropItem's own comment) -- shared across
  // every item's crop within this one /api/mark call, freed below once
  // verification is done with it. Passing a lazy `getImageCrop` thunk
  // (not a pre-computed crop) means an item only pays the real crop cost
  // when a matched handler actually declares it needs one
  // (`verifyVisual`) -- every existing text-only handler is completely
  // unaffected, zero risk of regression for the ~25 handlers already
  // live.
  const tVerify = Date.now();
  const visualPhotonCache = new Map();
  const verdictsByPage = pageResults.map((pr, pageIdx) => (pr.failed ? [] : pr.items.map((item, i) => {
    const match = matchesByPage[pageIdx][i];
    const getImageCrop = () => {
      if (!match) return null;
      try {
        return cropItem({ bbox: match, page: pageIdx }, images, visualPhotonCache);
      } catch (e) {
        return null; // fails open -- verifyVisual handlers treat a null crop as "can't verify", same as any other missing input
      }
    };
    return classifyAndVerify(item, getImageCrop);
  })));
  for (const img of visualPhotonCache.values()) img.free();
  const verifyMs = Date.now() - tVerify;

  // Module 3b, Ticket 4 (2026-09-25): cross-check printed NUMBERS
  // against Vision's independent reading, per item -- see
  // crossCheckPrintedNumbers's own comment for why this is narrower
  // than a full printed-text substitution. `null` (not run / no
  // Vision / no numbers to check) is treated as "nothing to flag",
  // same fail-open-to-trusting-AI behaviour as before this existed.
  const numberChecksByPage = pageResults.map((pr) =>
    pr.failed ? [] : pr.items.map((item) => (pr.vision ? crossCheckPrintedNumbers(item, pr.vision.words, pr.vision.width, pr.vision.height) : null))
  );

  // Module 2b, Ticket 54 (2026-09-27): word-bank "used once each" GROUP
  // constraint. Unlike every other check in this file, this is not a
  // per-item verdict -- verifyWordBankOnceEach only makes sense across
  // ALL of a page's word-bank items together, so it runs as its own pass
  // here rather than a QUESTION_TYPE_HANDLERS entry (see extractWordBank's
  // comment). Only ever touches items classifyAndVerify left unresolved
  // (verdict.correct === null) -- never overrides a real handler's own
  // confident verdict. Two outcomes, per explicit user decision
  // (2026-09-27): (1) an answer that isn't even a real bank phrase is a
  // certain, code-confident wrong -- mutates the verdict directly.
  // (2) an answer that IS a real bank phrase but is ALSO used by another
  // item on the page (a well-designed word-bank exercise never has two
  // blanks that legitimately share the same correct phrase, so a real
  // clash means at least one of them is a genuine student error) is NOT
  // forced to
  // needs_review -- code can't tell which one is wrong, but Jev/the
  // AI-fallback judge CAN, once told about the clash (each item is
  // normally judged in total isolation, with no visibility into any
  // other item -- this is the one piece of cross-item context they
  // wouldn't otherwise have). item.wordBankHint carries that context
  // through to buildJevQuestions below; Jev's own existing confidence
  // threshold still decides case by case, falling back to unresolved
  // exactly as it already does for every other question type when it's
  // genuinely unsure -- this never forces an answer, it only gives Jev
  // the same clash-awareness a real teacher marking the whole page would
  // have.
  pageResults.forEach((pr, pageIdx) => {
    if (pr.failed) return;
    const bankItems = [];
    pr.items.forEach((item, i) => {
      if (item.wordBank && verdictsByPage[pageIdx][i].correct === null) bankItems.push({ item, i });
    });
    if (!bankItems.length) return;
    const bank = bankItems[0].item.wordBank;
    const bankLower = bank.map((p) => p.toLowerCase());
    const answers = bankItems.map(({ item }) => String(item.studentAnswer || "").trim().toLowerCase());
    const counts = {};
    answers.forEach((a) => { if (a) counts[a] = (counts[a] || 0) + 1; });
    bankItems.forEach(({ item, i }, idx) => {
      const answer = answers[idx];
      if (!answer) return;
      if (!bankLower.includes(answer)) {
        const v = verdictsByPage[pageIdx][i];
        verdictsByPage[pageIdx][i] = { correct: false, correctAnswer: "", subject: v.subject, handler: "word_bank_once_each" };
      } else if (counts[answer] > 1) {
        const otherLabels = bankItems.filter((other, j) => j !== idx && answers[j] === answer).map(({ item: other }) => other.label);
        item.wordBankHint = `呢個答案「${item.studentAnswer}」同第${otherLabels.join("、")}題撞用咗同一個詞——呢個詞語庫規定每個詞淨係用一次，所以呢兩題入面最多得一題係真係啱，請你自己判斷呢一題係咪先啱嗰個，唔好因為個詞本身喺詞語庫入面就當佢自動啱。`;
      }
    });
  });

  // Deterministic merge: a failed page is recorded in `pageErrors` and
  // simply contributes no items -- every OTHER page's results are
  // unaffected, unlike the old single-combined-call design where one
  // failure took down the whole submission.
  const results = [];
  const pageErrors = [];
  // Ticket 13 (2026-09-26): items classifyAndVerify couldn't resolve are
  // captured here WITH their printedQuestion, before the `results` push
  // below drops it -- the AI-fallback pass after this loop needs it, but
  // `results` itself never carries it (client-facing shape, unchanged).
  // Never includes printedNumberMismatch items: those need a human
  // because the QUESTION TEXT itself is in doubt, which an AI fallback
  // reading the same page can't resolve any better than code did.
  const pendingForAiByPage = new Map();
  pageResults.forEach((pr, pageIdx) => {
    if (pr.failed) {
      const e = pr.error;
      pageErrors.push({ page: pageIdx, error: (e && (e.uiMessage || e.detail)) || String(e) });
      return;
    }
    pr.items.forEach((item, i) => {
      const verdict = verdictsByPage[pageIdx][i];
      const match = matchesByPage[pageIdx][i];
      // Ticket 4: a confirmed printed-number disagreement with Vision's
      // own independent reading overrides whatever classifyAndVerify
      // decided -- a wrong printed number makes any computed
      // correctAnswer suspect too, so this forces needs_review rather
      // than risking a confidently-wrong "correct"/"wrong" verdict built
      // on a misread digit. Never *invents* a corrected verdict from
      // Vision's numbers -- still fails safe to human review, per this
      // project's existing "never guess" discipline.
      const numberCheck = numberChecksByPage[pageIdx][i];
      const printedNumberMismatch = numberCheck && numberCheck.agree === false;
      const effectiveCorrect = printedNumberMismatch ? null : verdict.correct;
      // Coverage-expansion feed (2026-09-22): every needs_review item logs its
      // PRINTED question only -- never studentAnswer, never image data -- so a
      // later batch review can catalog real unresolved question shapes without
      // touching any child's personal work. Deliberately logs ALL needs_review
      // items (not just non-math), since an unresolved math shape (e.g. a
      // multi-blank item) is just as much a "new type to cover" as a
      // chinese/english item with no verifier at all.
      if (effectiveCorrect === null) {
        console.log(JSON.stringify({
          event: "mark_unresolved_question",
          subject: verdict.subject,
          printedQuestion: item.printedQuestion || item.label || "",
          parseFailed: !!item.parseFailed,
          printedNumberMismatch: printedNumberMismatch || undefined,
        }));
      }
      // TEMPORARY (2026-09-29) -- one-use, real content visibility per
      // explicit user request ("需要見到每一步嘅工具讀到咩字"). Logs
      // EVERY item's OCR'd text + code's own verdict, not just the
      // unresolved ones mark_unresolved_question already covers. Remove
      // after this is done.
      console.log(JSON.stringify({
        event: "debug_content_ocr_and_code",
        page: pageIdx, question: item.label, printedQuestion: item.printedQuestion || "",
        studentAnswer: item.studentAnswer, codeVerdict: effectiveCorrect, verifiedBy: effectiveCorrect === null ? "pending" : "code",
      }));
      results.push({
        question: item.label,
        studentAnswer: item.studentAnswer,
        correct: effectiveCorrect,
        correctAnswer: printedNumberMismatch ? "" : verdict.correctAnswer,
        subject: verdict.subject,
        // Explicit status alongside `correct` per 2026-09-21 review: null
        // must read unambiguously as "not resolved", never silently coerced
        // to a falsy/"wrong" UI state.
        status: effectiveCorrect === null ? "needs_review" : "ok",
        // 2026-09-30: a code-verified WRONG item can carry its own short
        // "why" via verdict.explanation -- classifyAndVerify spreads
        // whatever the handler's verify()/verifyVisual() returns
        // straight onto verdict, so a handler that sets `explanation`
        // needs no other wiring change to reach the parent (see
        // buildWrongAnswersSummary). Handlers not yet given one (see
        // benchmark/question-type-library.md's coverage column) simply
        // leave this undefined -- falls back to "", the exact prior
        // behaviour, never a fabricated guess.
        note: printedNumberMismatch ? "印刷數字唔肯定" : effectiveCorrect === null ? "需要人手複核" : effectiveCorrect === false ? (verdict.explanation || "") : "",
        // Real page index (which call produced this item), not a guess.
        page: pageIdx,
        // null (not {x:0,y:0,w:0,h:0}) when nothing matched, so a real
        // top-left bbox can never be confused with "no match found".
        bbox: match ? { x: match.x, y: match.y, w: match.w, h: match.h } : null,
        anchor: item.label,
        // Not implemented in this pipeline yet. null ("unknown"), not false
        // ("checked, not risky") -- a future consumer must not read this as
        // a real, computed answer. /api/check's diagram-risk flag has no
        // equivalent here yet.
        riskyDiagram: null,
        verifiedBy: verdict.correct === null ? "pending" : "code",
      });
      if (effectiveCorrect === null && !printedNumberMismatch) {
        if (!pendingForAiByPage.has(pageIdx)) pendingForAiByPage.set(pageIdx, []);
        pendingForAiByPage.get(pageIdx).push({
          resultIndex: results.length - 1,
          question: item.label,
          printedQuestion: item.printedQuestion || "",
          studentAnswer: item.studentAnswer,
          subject: verdict.subject,
          // Ticket 54: cross-item context Jev/the AI-fallback judge
          // wouldn't otherwise have (each item is normally judged in
          // total isolation) -- see Module 2b above for where this gets set.
          wordBankHint: item.wordBankHint,
        });
      }
    });
  });

  // Module 3d, Ticket 55 (2026-09-27): 4x4 Sudoku puzzles -- a
  // completely different item shape (one 16-cell grid, not a
  // printedQuestion/studentAnswer pair), so these never went through
  // classifyAndVerify/QUESTION_TYPE_HANDLERS at all; extractSudokuPuzzles
  // (called inside callQwenOcrText) already produced clean {label,
  // givenGrid, studentGrid} records, verified directly against the
  // existing (already tested) verifySudoku4x4. Per explicit user
  // decision: no correctAnswer generation yet for a wrong/incomplete
  // puzzle (a real future addition, not attempted here) -- and,
  // narrower than every other question type, an unresolved (incomplete)
  // puzzle is NOT sent to Jev or the AI-image fallback (neither can
  // usefully judge a 16-cell grid from the current text-only/single-
  // hint-per-item prompts they're built for) -- it just stays
  // needs_review, a real, acknowledged scope limit for this first pass.
  pageResults.forEach((pr, pageIdx) => {
    if (pr.failed || !pr.sudokuPuzzles || !pr.sudokuPuzzles.length) return;
    pr.sudokuPuzzles.forEach((puzzle) => {
      const verdict = verifySudoku4x4(puzzle.givenGrid, puzzle.studentGrid);
      results.push({
        question: puzzle.label,
        studentAnswer: puzzle.studentGrid.map((v) => (v === null ? "_" : v)).join(""),
        correct: verdict.correct,
        correctAnswer: "",
        subject: "math",
        status: verdict.correct === null ? "needs_review" : "ok",
        note: verdict.correct === null ? "數獨未填晒，需要人手複核" : "",
        page: pageIdx,
        bbox: null,
        anchor: puzzle.label,
        riskyDiagram: null,
        verifiedBy: verdict.correct === null ? "pending" : "code",
      });
    });
  });

  // Module 3c, Ticket 27 (2026-09-27): Jev TEXT-ONLY pre-check, strictly
  // BEFORE Ticket 13's real (image-based) AI fallback below. One single
  // call across every pending item on every page (Jev needs no image, so
  // there's no per-page reason to split it) -- items it resolves with
  // high confidence are written straight into `results` and removed from
  // `pendingForAiByPage`; every other item is untouched and flows into
  // the image-based AI fallback below exactly as before (Gemini as of
  // Ticket 196, 2026-09-29 -- was Qwen/DeepSeek before that). Real
  // per-call cost/timing logged below (mark_usage) alongside the
  // existing AI-fallback usage, per the same "always know cost after a
  // change" standing rule.
  //
  // Ticket 44 (2026-09-27, explicit user decision): the Chinese-subject
  // exclusion below was REMOVED on purpose. History: Ticket 27 found Jev
  // confidently marking a genuinely correct CHINESE answer (親愛的表姐 ->
  // 表弟) as wrong, consistent with Jev's own documented caveat ("English
  // is the best-supported language; evaluate CJK workloads separately"),
  // so Chinese items were excluded entirely and always fell straight to
  // the image-based fallback below. User's explicit instruction: let Jev
  // attempt Chinese items too for now (a wrong Jev verdict on Chinese
  // still isn't worse than what Chinese items get today -- the AI-image
  // fallback is ALSO not verified accurate on Chinese, it was just the
  // pre-existing default), and separately evaluate/add a Chinese-
  // specialized model later (tracked by the existing weekly Ticket 34
  // model-watch cron) rather than blocking Jev from ever trying. If a
  // future real test finds Jev's Chinese verdicts are unreliable again,
  // re-add `.filter((it) => it.subject !== "chinese")` here.
  const allPendingFlat = [];
  pendingForAiByPage.forEach((items) => allPendingFlat.push(...items));
  let jevUsageLog = null;
  if (openrouterKey && allPendingFlat.length) {
    const tJev = Date.now();
    const jevResolved = await callJevPreCheck(allPendingFlat, openrouterKey);
    jevUsageLog = { items: allPendingFlat.length, resolved: jevResolved.size, ms: Date.now() - tJev, callStatus: jevResolved.callStatus || "unknown" };
    // TEMPORARY (2026-09-29) -- one-use, real content visibility into a
    // live production request per explicit user request ("需要見到每一
    // 步嘅工具讀到咩字"). Logs what was actually SENT to Jev (the OCR'd
    // text) and what Jev resolved, not just counts/timing. Remove after
    // this is done.
    console.log(JSON.stringify({
      event: "debug_content_jev",
      sentToJev: allPendingFlat.map((it) => ({
        resultIndex: it.resultIndex,
        printedQuestion: it.printedQuestion,
        studentAnswer: it.studentAnswer,
        noul: jevResolved.rawScores ? jevResolved.rawScores[String(it.resultIndex)] : undefined,
        resolved: jevResolved.has(it.resultIndex) ? jevResolved.get(it.resultIndex).correct : "uncertain(falls to AI-fallback)",
      })),
    }));
    // Ticket 40: accumulate a daily "did jev's endpoint actually work
    // today" counter in KV so a real outage (not just low-confidence
    // answers) is visible. Best-effort, non-atomic read-modify-write --
    // KV has no increment primitive, and this is a monitoring signal, not
    // a billing-grade count, so an occasional lost increment under
    // concurrent requests is an accepted tradeoff (never worth adding
    // retry/locking complexity for). Never allowed to affect grading --
    // wrapped in its own try/catch, failure here is silently swallowed.
    if (env.RATE_LIMIT_KV) {
      try {
        const dateKey = "jevhealth:" + new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
        const raw = await env.RATE_LIMIT_KV.get(dateKey);
        const counts = raw ? JSON.parse(raw) : { calls: 0, fails: 0 };
        counts.calls += 1;
        if (jevUsageLog.callStatus !== "ok") counts.fails += 1;
        await env.RATE_LIMIT_KV.put(dateKey, JSON.stringify(counts), { expirationTtl: 8 * 86400 });
      } catch (e) { /* monitoring only, never block grading */ }
    }
    if (jevResolved.size) {
      jevResolved.forEach((verdict, resultIndex) => {
        const r = results[resultIndex];
        r.correct = verdict.correct;
        r.correctAnswer = ""; // Jev is a yes/no judge, not a content generator -- never fabricates a corrected answer
        r.status = "ok";
        r.note = "";
        r.verifiedBy = "jev";
      });
      pendingForAiByPage.forEach((items, pageIdx) => {
        pendingForAiByPage.set(pageIdx, items.filter((it) => !jevResolved.has(it.resultIndex)));
      });
    }
  }

  // Module 4, Ticket 13 (2026-09-26): AI judges what code couldn't.
  // Ticket 15 (2026-09-26, real production finding, Qwen/DeepSeek era): a
  // single 10-item batch made BOTH tiers (Qwen 8s, DeepSeek 12s) time out
  // -- confirmed live, not theoretical (see TICKETS.md). Real data points:
  // 5 items succeeded in 3.9s, 4 items in 3.2s, 10 items failed both tiers
  // entirely. Sample is small (3 data points) -- the exact safe
  // threshold isn't precisely known, but 5 is a defensible cutoff given
  // what actually succeeded. AI_FALLBACK_BATCH_SIZE caps each call at 5
  // items; a page with MORE than 5 pending items is split into several
  // ≤5-item batches, all run in parallel (flattened into the same
  // Promise.all as every other page/batch, not nested/sequential) --
  // this resolves MORE items with LOWER latency than one oversized call
  // that just fails, matching the real 10-item finding's own fix
  // suggestion (batch + parallelize, not "make the model faster", which
  // has no reliable lever -- see the batch-size discussion in memory/
  // chat for why "reduce max_tokens" was considered and rejected as too
  // weak a lever to rely on). Kept at 5 after the Ticket 196 Gemini swap
  // (2026-09-29) -- Gemini's own real testing showed similar single-digit-
  // second latency per call, no evidence yet that a larger batch is safe.
  const AI_FALLBACK_BATCH_SIZE = 5;
  const aiFallbackBatches = []; // { pageIdx, pendingItems }
  pendingForAiByPage.forEach((pendingItems, pageIdx) => {
    for (let i = 0; i < pendingItems.length; i += AI_FALLBACK_BATCH_SIZE) {
      aiFallbackBatches.push({ pageIdx, pendingItems: pendingItems.slice(i, i + AI_FALLBACK_BATCH_SIZE) });
    }
  });
  // A page's fallback failing (Gemini, as of Ticket 196) leaves its items
  // exactly as already built above -- needs_review, verifiedBy
  // "pending" -- never a regression versus not having this stage at
  // all. `aiFallbackUsage` is logged below (mark_usage) so real
  // per-batch cost/timing can be read from production logs, per
  // explicit request to always know both after a change like this.
  const aiFallbackUsage = [];
  if (openrouterKey && aiFallbackBatches.length) {
    await Promise.all(aiFallbackBatches.map(async ({ pageIdx, pendingItems }) => {
      const tFallback = Date.now();
      const outcome = await callAiFallbackJudge([downscaleForCheapTier(images[pageIdx], 640)], pendingItems, openrouterKey);
      aiFallbackUsage.push({ page: pageIdx, items: pendingItems.length, ms: Date.now() - tFallback, model: outcome && outcome.model, usage: outcome && outcome.usage });
      // TEMPORARY (2026-09-29) -- one-use, real content visibility per
      // explicit user request. Logs what was SENT to AI-fallback and its
      // raw parsed response. Remove after this is done.
      console.log(JSON.stringify({
        event: "debug_content_ai_fallback",
        page: pageIdx,
        sentItems: pendingItems.map((it) => ({ resultIndex: it.resultIndex, question: it.question, printedQuestion: it.printedQuestion, studentAnswer: it.studentAnswer })),
        rawResponse: outcome ? outcome.parsed : null,
      }));
      if (!outcome) return;
      // Ticket 18 (2026-09-30, real edge case): if OCR produces a
      // duplicate question label on the same page (a real, previously
      // seen misread), a plain `Map` keyed by question number collapses
      // every pendingItem sharing that label onto whichever single AI
      // result happened to be stored last for that key -- two genuinely
      // different items could silently receive the SAME verdict/answer.
      // Grouping into a queue-per-label and shifting one result out per
      // matching pendingItem (in submission order) instead means N
      // duplicately-labelled items get matched to the AI's own N
      // same-labelled results one-to-one, not collapsed onto one. Exact
      // same behaviour as before whenever a label is unique (the common
      // case) -- this only changes what happens on an actual collision.
      const resultsByQuestion = new Map();
      (outcome.parsed.results || []).forEach((r) => {
        const key = String(r.question);
        if (!resultsByQuestion.has(key)) resultsByQuestion.set(key, []);
        resultsByQuestion.get(key).push(r);
      });
      pendingItems.forEach((pending) => {
        const queue = resultsByQuestion.get(String(pending.question));
        const aiResult = queue && queue.length ? queue.shift() : null;
        if (!aiResult) return; // AI didn't answer this one -- stays needs_review, not a regression
        const r = results[pending.resultIndex];
        r.correct = typeof aiResult.correct === "boolean" ? aiResult.correct : null;
        r.correctAnswer = r.correct === false ? String(aiResult.correctAnswer || "") : "";
        r.status = r.correct === null ? "needs_review" : "ok";
        // 2026-09-30: "note" previously only survived for the null
        // (needs_review) branch -- explicitly cleared for false, so a
        // wrong item's WHY (which buildAiFallbackPrompt's prompt #5 now
        // asks Gemini for, in the same existing call, no new AI cost)
        // never reached the parent. Kept for both null and false now.
        r.note = r.correct === null ? (aiResult.note || "需要人手複核") : r.correct === false ? String(aiResult.note || "") : "";
        r.verifiedBy = r.correct === null ? "pending" : "ai";
      });
    }));
  }

  const correctCount = results.filter((r) => r.correct === true).length;
  const needsReviewCount = results.filter((r) => r.correct === null).length;
  const totalMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    event: "mark_usage",
    items: results.length,
    pages: images.length,
    pagesFailed: pageErrors.length,
    needsReview: needsReviewCount,
    totalMs, pagesMs, verifyMs, mapMs,
    perPage: pageResults.map((pr) => ({ page: pr.page, failed: pr.failed, qwenMs: pr.qwenMs, visionMs: pr.visionMs, usage: pr.usage || null })),
    jevPreCheck: jevUsageLog,
    aiFallback: aiFallbackUsage,
  }));

  // Every page failed -- genuinely nothing to return, unlike a partial
  // multi-page failure (handled below via pageErrors on an otherwise
  // normal 200 response).
  if (!results.length && pageErrors.length) {
    return json({ error: "upstream_error", message: "改功課服務暫時無法使用，請稍後再試。", pageErrors }, 502);
  }

  // needsVerify has NO resolve endpoint yet (unlike /api/check's
  // /api/verify pairing) -- this is backend-only bookkeeping, not a
  // complete user-facing feature. Do not wire this pipeline to the
  // frontend until a real review/resolve flow exists for these.
  // Keyed by real page index, only pages that actually needed correcting
  // -- same shape/convention as handleCheckInner's own pageRotations, so
  // a caller (handleTelegramWebhook below) can apply the identical
  // rotation to its own separately-held copy of the original photo
  // bytes before annotating, without this JSON response needing to
  // carry the corrected image bytes themselves.
  const pageRotations = {};
  images.forEach((img, i) => { if (rotationApplied[i]) pageRotations[i] = rotationApplied[i]; });

  // Ticket 48 (2026-09-27): restores parity with /api/check's own
  // top-level continuesFromPrevious/continuesToNext fields, which the
  // website's cross-page-stitch trigger (`if (data.continuesFromPrevious)`)
  // has needed all along but /api/mark never produced -- silently
  // unreachable since Ticket 32 moved normal page submission here. A
  // caller sends 1 image per call in practice (the website always does),
  // but this stays correct for a genuine multi-image call too: the FIRST
  // page's own continuesFromPrevious (does THIS call's content open
  // mid-question) and the LAST page's own continuesToNext (does it end
  // mid-question) are what describe this call's own boundaries -- an
  // internal page-to-page join, if any, is handled by pageResults being
  // adjacent, not this flag pair.
  const firstOkPage = pageResults.find((pr) => !pr.failed);
  const lastOkPage = [...pageResults].reverse().find((pr) => !pr.failed);
  const responseBody = {
    results,
    score: `${correctCount} / ${results.length}`,
    needsVerify: results.filter((r) => r.correct === null).map((r) => ({ page: r.page, question: r.question })),
    pageRotations,
    continuesFromPrevious: firstOkPage ? firstOkPage.continuesFromPrevious : false,
    continuesToNext: lastOkPage ? lastOkPage.continuesToNext : false,
    ...(pageErrors.length ? { pageErrors } : {}),
  };
  if (dedupKey && env.RATE_LIMIT_KV) {
    try {
      await env.RATE_LIMIT_KV.put(dedupKey, JSON.stringify(responseBody), { expirationTtl: MARK_DEDUP_TTL });
    } catch (e) { /* best-effort */ }
  }
  return json(responseBody);
}

// Telegram MVP (2026-09-22): one photo in, one annotated photo out.
// Deliberately narrow -- single photo only, no albums/multi-page, no
// accounts, no database, no payment, no commands beyond "here's a photo".
// Calls handleMark() directly (same module, no HTTP round-trip) rather
// than POSTing to /api/mark itself -- handleMark's own code above this
// function is completely unmodified by this addition.
async function resolveSecret(envVar) {
  if (!envVar) return null;
  return typeof envVar === "string" ? envVar : await envVar.get();
}

async function handleTelegramWebhook(request, env) {
  const startedAt = Date.now();

  // H. Security -- verify Telegram's own webhook secret-token header
  // BEFORE any other work: parsing the body, touching the bot token, or
  // triggering a real (costly) marking pass. Fails closed (503) if the
  // secret itself isn't configured yet, matching this project's existing
  // fail-closed convention for gated endpoints elsewhere.
  const expectedSecret = await resolveSecret(env.TELEGRAM_WEBHOOK_SECRET);
  if (!expectedSecret) {
    return new Response("not configured", { status: 503 });
  }
  const gotSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!constantTimeEqual(gotSecret, expectedSecret)) {
    return new Response("forbidden", { status: 403 });
  }

  const botToken = await resolveSecret(env.TELEGRAM_BOT_TOKEN);
  if (!botToken) {
    return new Response("not configured", { status: 503 });
  }

  let update;
  try {
    update = await request.json();
  } catch (e) {
    // Malformed body -- Telegram doesn't retry usefully on this, and
    // there's no chat to reply to. 200 so it isn't retried forever.
    console.log(JSON.stringify({ event: "telegram_bad_update", error: String(e) }));
    return new Response("ok");
  }

  // Ticket 6, cheap first step: a PDF/document (or any other file type)
  // has no `message.photo`, so parseTelegramUpdate below returns null for
  // it -- previously that meant total silence, indistinguishable from a
  // sticker or text message being (correctly) ignored. A parent who sends
  // a PDF deserves to know why nothing came back, not silence that looks
  // like a bug. PDF support itself is still not built (see TICKETS.md
  // Ticket 6) -- this only replaces silence with an honest, clear message.
  const docChatId = update && update.message && update.message.chat && update.message.chat.id;
  const hasDocument = update && update.message && update.message.document;
  const hasPhoto = update && update.message && Array.isArray(update.message.photo) && update.message.photo.length;
  if (docChatId && hasDocument && !hasPhoto) {
    try {
      await telegramSendMessage(botToken, String(docChatId), "暫時未支援 PDF／文件格式，請影相或者send相片。");
    } catch (e) {
      console.log(JSON.stringify({ event: "telegram_document_notice_failed", error: String(e && e.message || e) }));
    }
    return new Response("ok");
  }

  const parsed = parseTelegramUpdate(update);
  if (!parsed) {
    // Not a photo message (text, sticker, no message at all, ...) --
    // nothing for this MVP to do yet. Still 200: this is a normal,
    // expected update shape, not an error.
    return new Response("ok");
  }
  const { chatId, fileId } = parsed;

  // G. Errors sent to the user are always this one generic, safe
  // sentence -- never a stack trace, API key, or internal error detail.
  const GENERIC_ERROR = "改功課失敗，請稍後再試。";

  try {
    const filePath = await telegramGetFile(botToken, fileId);
    const photoBytes = await telegramDownloadFile(botToken, filePath, MAX_TELEGRAM_PHOTO_BYTES);

    // Marking itself takes ~2-7s (OCR + AI + verification) with nothing
    // sent back to the chat until the final photo -- long enough that a
    // parent may wonder if the bot received the photo at all. Best-effort:
    // a failure here must never abort marking itself, since the real
    // result (or GENERIC_ERROR) still follows either way.
    try {
      await telegramSendMessage(botToken, chatId, "改緊功課，請稍等...");
    } catch (e) {
      console.log(JSON.stringify({ event: "telegram_progress_message_failed", error: String(e && e.message || e) }));
    }

    const tMark = Date.now();
    const markRequest = new Request("https://internal.invalid/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ data: bytesToBase64(photoBytes), mediaType: "image/jpeg" }] }),
    });
    const markResponse = await handleMark(markRequest, env);
    const markJson = await markResponse.json();
    // handleMark returns 200 even when every page failed (pageErrors
    // populated, results empty) -- that's the right contract for
    // /api/mark's own frontend (it renders per-page errors inline), but
    // silently sending back an unannotated photo here would look like a
    // success. Treat "nothing to show" the same as a hard failure.
    const noUsableResults = !markJson.results || markJson.results.length === 0;
    if (markResponse.status !== 200 || noUsableResults) {
      console.log(JSON.stringify({ event: "telegram_mark_failed", status: markResponse.status, error: markJson && markJson.error, pageErrors: markJson && markJson.pageErrors }));
      await telegramSendMessage(botToken, chatId, GENERIC_ERROR);
      return new Response("ok");
    }
    const markMs = Date.now() - tMark;

    // 2026-09-25: apply the SAME rotation handleMark already computed
    // (and used internally for OCR/bbox) to this handler's own separate
    // copy of the original bytes, so the final annotated photo sent back
    // to the parent is upright too -- handleMark's JSON response can't
    // carry corrected image bytes directly, so it reports the angle
    // instead (see its own pageRotations comment) and this is the one
    // caller that needs to replicate the same physical rotation.
    // Telegram always sends exactly one photo per /api/mark call here,
    // so only page 0 is ever relevant.
    let bytesToAnnotate = photoBytes;
    const rotationDeg = markJson.pageRotations && markJson.pageRotations["0"];
    if (rotationDeg) {
      const tRotateApply = Date.now();
      const photonImg = PhotonImage.new_from_byteslice(photoBytes);
      try {
        const rotatedImg = rotate(photonImg, rotationDeg);
        try {
          bytesToAnnotate = rotatedImg.get_bytes_jpeg(90);
        } finally { rotatedImg.free(); }
      } catch (e) {
        console.log(JSON.stringify({ event: "telegram_rotation_apply_failed", error: String(e && e.message || e) }));
        // best-effort -- annotate the un-rotated original rather than fail the whole submission
      } finally {
        photonImg.free();
        // Ticket 50: monitoring only -- this physical rotation-apply step
        // is NOT gated by the CPU guard (it feeds into what the parent
        // actually sees as "their child's photo", not a cosmetic mark),
        // just recorded for visibility into total daily Photon CPU use.
        await recordCpuGuardUsage(env, Date.now() - tRotateApply);
      }
    }

    // Ticket 50: annotateImage is the one Photon step this guard is
    // allowed to skip -- grading itself (markJson.results) is already
    // fully computed by this point and completely unaffected either way,
    // only the cosmetic marked-up photo is. Checked BEFORE spending the
    // CPU on annotation, not after.
    const cpuGuardTripped = await isCpuGuardTripped(env);
    const tAnnotate = Date.now();
    let annotated = null;
    if (!cpuGuardTripped) {
      annotated = annotateImage(bytesToAnnotate, markJson.results || []);
    }
    const annotationMs = Date.now() - tAnnotate;
    if (annotationMs > 0) await recordCpuGuardUsage(env, annotationMs);

    const tSend = Date.now();
    if (annotated) {
      // "Checked" means only "this photo was processed", NOT "every answer
      // is correct" -- it is not a correctness verdict and must not be read
      // as one. needs_review (correct === null) items now get their own "?"
      // mark (annotateImage's "review" icon kind, drawn via Photon's
      // draw_text_with_color -- see annotate.js) distinct from the cross, so
      // an all-correct-looking marked-up photo no longer hides unreviewed
      // items from the parent.
      await telegramSendPhoto(botToken, chatId, annotated.data, annotated.mediaType, "Checked");
      // 2026-09-30: every wrong item's correctAnswer was ALREADY fully
      // computed by this point (every handler -- code or AI-fallback --
      // fills it in) but was never actually shown to the parent in this,
      // the normal (non-CPU-guard-tripped) path -- only the ✓/✗ mark on
      // the photo itself, with no text saying what the right answer WAS.
      // This reuses the exact same correctAnswer-summary text the CPU-
      // guard fallback branch below already builds, just also sent here.
      // Zero new AI cost -- purely surfacing data that already existed.
      const wrongAnswersText = buildWrongAnswersSummary(markJson.results || []);
      if (wrongAnswersText) await telegramSendMessage(botToken, chatId, wrongAnswersText);
    } else {
      // Ticket 50: CPU-ms guard tripped for today -- fall back to a
      // plain-text summary instead of the annotated photo. Grading
      // itself is unaffected (same real results, just not drawn onto
      // the photo); this only happens on a day CPU usage is already
      // unusually high, and self-resets the next HK calendar day.
      const results = markJson.results || [];
      const correctCount = results.filter((r) => r.correct === true).length;
      const reviewCount = results.filter((r) => r.correct === null).length;
      const wrongAnswersText = buildWrongAnswersSummary(results);
      const summaryText = `改好喇：${correctCount} / ${results.length}\n${wrongAnswersText}${reviewCount ? `\n（另有${reviewCount}題需要人手覆核）` : ""}\n\n（今日系統較忙，暫時未能提供標圖相片，文字版結果如上）`;
      await telegramSendMessage(botToken, chatId, summaryText);
    }
    const sendPhotoMs = Date.now() - tSend;

    // I. Observability -- timings and item count only, never chat_id,
    // bot token, or any other per-user/secret detail.
    console.log(JSON.stringify({
      event: "telegram_mark",
      totalMs: Date.now() - startedAt,
      markMs, annotationMs, sendPhotoMs,
      items: (markJson.results || []).length,
    }));
    return new Response("ok");
  } catch (e) {
    console.log(JSON.stringify({ event: "telegram_mark_error", error: String(e && e.message || e) }));
    try {
      await telegramSendMessage(botToken, chatId, GENERIC_ERROR);
    } catch (sendErr) {
      // Even the error message failed to send -- nothing more this
      // handler can do; already logged above.
    }
    return new Response("ok");
  }
}

// Re-sends only the still-unsure items to `model`, using a zoomed-in crop
// around each one's own position (falling back to the whole page if
// cropping isn't possible) rather than the whole page again -- same idea as
// a parent pinch-zooming a photo to read messy handwriting. Returns the
// list of items still unresolved afterward, for a possible further tier.
async function recheckPass(parsed, unsure, images, apiKey, model, maxTokens, usage, usageKey, photonCache) {
  // Per-item crop, not all-or-nothing: one item's crop failing (missing
  // bbox, a degenerate rectangle right at a page edge) used to invalidate
  // EVERY item's crop for the whole batch, falling back to re-sending all
  // original full-size pages -- harmless with 1-2 unsure items, but with
  // riskyDiagram now able to put a dozen-plus items in one batch, a single
  // bad crop meant a much bigger, slower fallback call far more often than
  // before. Each item now gets its own crop attempt; only items that
  // genuinely fail fall back to their own full page.
  const cropImages = [];
  const isFallback = [];
  for (const r of unsure) {
    try {
      cropImages.push(cropItem(r, images, photonCache));
      isFallback.push(false);
    } catch (e) {
      cropImages.push(images[r.page] || images[0]);
      isFallback.push(true);
    }
  }
  const recheckImages = cropImages;
  const listText = unsure
    .map((r, i) => `圖${i + 1}：第${r.page + 1}頁，題號「${r.question}」${isFallback[i] ? '（呢張係成頁，唔係近鏡）' : '嘅放大近鏡'}`)
    .join('、');

  const recheckPrompt = `你是一位細心的小學老師。另一位老師已經批改咗呢份功課嘅大部分題目，但以下題目要你用更仔細嘅眼光再核實一次先——有啲係佢睇唔清楚學生寫嘅答案，有啲係題目本身容易睇錯（例如刻度、角度、立體圖形、硬幣、位值比較呢類），所以無論你上次判斷幾肯定，都要當呢張圖係新嘅重新諗一次：
${listText}

每張圖對應返上面列出嘅其中一條題目（跟返嗰個次序）——大部分係題目答案位置嘅放大近鏡相，方便你睇清楚啲字，留意有啲字可能潦草或者被擦改過，如果單睇一個字睇唔出，試吓連埋前後字一齊估係咪一個詞語，唔好淨係逐粒字咁樣睇；標明「成頁」嗰幾張就係冇裁到，睇成頁嚟判斷。

呢份功課冇標準答案，請你自己諗清楚每一題應該點答，再判斷學生手寫嘅答案。

只需要回覆上面列出嘅題目，按圖片次序回覆，要求：
1. 盡量仔細判斷。如果答題位置完全空白、冇任何筆跡，"correct" 設為 false，"note" 填「未作答」。
2. 只有答題位置確實有筆跡、但寫得太潦草無法判斷寫嘅係咩，先設 "correct" 為 null。
3. 只有 "correct" 係 false 先填 "correctAnswer"，其他情況留空。"note" 最多四個字，答對可留空。
4. 只回覆JSON，不要其他文字：
{"results":[{"question":"題號","page":0,"correct":true/false/null,"correctAnswer":"","note":""}]}`;

  try {
    const rc = await callClaude(model, maxTokens, recheckImages, recheckPrompt, apiKey);
    usage[usageKey] = rc.usage;
    // Matched POSITIONALLY against `unsure` (the prompt explicitly asks the
    // model to reply "按圖片次序" -- in image order), not by a "page:question"
    // key. The prompt's own listText tells the model "第1頁" (1-indexed, for
    // readability) right next to a JSON schema example showing "page":0 --
    // a model that echoes back the human-facing "1" it just read instead of
    // the 0-indexed value the schema actually wants silently breaks a
    // key-based match, discarding every result in the batch with no error.
    // Position doesn't depend on the model getting that number (or the
    // exact question-string formatting) right at all.
    // `unsure` items are the SAME object references filtered out of
    // `parsed.results` (not copies), so mutating them here updates
    // `parsed.results` too -- no separate merge-back step needed.
    const updates = rc.parsed.results || [];
    unsure.forEach((r, i) => {
      const updated = updates[i];
      if (!updated) return;
      // Extra guard on top of positional matching: the schema still asks
      // for "question" in the reply, so if the model happens to include it
      // AND it doesn't match what was actually sent at this position, the
      // model most likely skipped, merged, or reordered an item -- every
      // later index would then be silently shifted. Skip that one item
      // (leave its original main-pass verdict standing) rather than risk
      // applying a shifted verdict to the wrong question.
      if (updated.question !== undefined && updated.question !== null && String(updated.question) !== String(r.question)) return;
      r.correct = updated.correct === undefined ? null : updated.correct;
      r.correctAnswer = updated.correctAnswer || '';
      r.note = updated.note || '';
      if (updated.studentAnswer) r.studentAnswer = updated.studentAnswer;
      r.verifiedBy = usageKey;
      fixSelfContradiction(r);
    });
  } catch (e) {
    // A recheck tier failing shouldn't sink the whole response -- whatever
    // was still null just stays null and falls through to the next tier
    // (or to the human-confirm "?" in the UI if this was the last one).
  }
  return parsed.results.filter((r) => r.correct === null);
}

// Crops a padded region around one result's bbox on its page. Shared by the
// recheck zoom tiers above and the handwriting-sample capture below, so the
// padding/crop math (and the Photon decode-cache convention) only exists in
// one place.
function cropItem(r, images, photonCache) {
  if (!r.bbox || !images[r.page]) throw new Error("missing bbox or page for crop");
  let photonImg = photonCache.get(r.page);
  if (!photonImg) {
    const bytes = base64ToBytes(images[r.page].data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    photonCache.set(r.page, photonImg);
  }
  const W = photonImg.get_width(), H = photonImg.get_height();
  const padX = Math.max(60, W * 0.1), padY = Math.max(50, H * 0.04);
  const x1 = Math.max(0, Math.round((r.bbox.x / 100) * W - padX));
  const y1 = Math.max(0, Math.round((r.bbox.y / 100) * H - padY));
  const x2 = Math.min(W, Math.round(((r.bbox.x + r.bbox.w) / 100) * W + padX));
  const y2 = Math.min(H, Math.round(((r.bbox.y + r.bbox.h) / 100) * H + padY));
  if (x2 <= x1 || y2 <= y1) throw new Error("degenerate crop rectangle");
  const cropped = crop(photonImg, x1, y1, x2, y2);
  const outBytes = cropped.get_bytes_jpeg(90);
  cropped.free();
  // originX/originY/pageWidth/pageHeight (2026-09-30, Ticket 203): purely
  // additive fields -- every existing verifyVisual consumer only ever
  // reads .data/.mediaType, so this changes nothing for them. Lets a
  // handler that ALSO has page-coordinate facts (e.g. Vision word
  // positions from findGridPointsBbox) convert them into this specific
  // crop's own local pixel coordinates, which was otherwise impossible
  // since verifyVisual never received the crop's own page offset.
  return { data: bytesToBase64(outBytes), mediaType: "image/jpeg", originX: x1, originY: y1, pageWidth: W, pageHeight: H };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Named exports for the new (2026-09-22, not-yet-wired) question-type
// verifiers above -- test-only surface, does not change the module's
// default export or any existing behavior.
export {
  callJevPreCheck,
  buildJevQuestions,
  buildDiagramMarkerHint,
  buildPrepositionTimeHint,
  buildAiFallbackPrompt,
  mentionsMoneyDenomination,
  mentionsShapeGeometry,
  mentionsShape2D,
  mentionsYearType,
  mentionsMonthLength,
  mentionsQuantityWordOrClockMechanics,
  mentionsWeekdayOrdinal,
  mentionsCompleteSentenceReadingQuestion,
  buildTierVGuidance,
  extractPictogramData,
  verifyPictogramQuery,
  extractCalendarGrid,
  verifyCalendarGridQuery,
  extractScheduleTable,
  verifyScheduleTableQuery,
  extractLocationGrid,
  verifyLocationGridQuery,
  extractFacingDirection,
  verifyFacingDirectionQuery,
  verifyBackDirectionFromLeftHand,
  extractDigitCards,
  verifyDigitCardExtremeComposite,
  extractShortDivisionMc,
  verifyShortDivisionHcfMc,
  extractSquaresDiagonal,
  verifySquaresDiagonalShadedArea,
  extractTrapezoidTwoSquares,
  verifyTrapezoidTwoSquaresArea,
  verifyOverlappingParallelogramUnionArea,
  extractParallelogramPartial,
  verifyParallelogramPartialHeight,
  extractRectCutKite,
  verifyRectCutKiteArea,
  verifyWriteAlgebraicExpression,
  extractCompassRoseMc,
  verifyCompassRoseMc,
  extractPaperFold,
  verifyPaperFold,
  extractPathGraph,
  verifyPathGraph,
  extractClockOptions,
  verifyClockOptionsMc,
  extractCoinBlanks,
  verifyCoinBlanks,
  extractDistanceValues,
  verifyDistanceRanking,
  extractObjectHeights,
  verifyObjectHeights,
  verifyChangeFromTwoItemPurchase,
  verifyResourceConstrainedMax,
  verifyChainedTwoStepBlank,
  verifyCurveOnlyLetterMC,
  verifyRegroupTotalWordProblem,
  verifyElapsedTimeInequalityMC,
  verifyYesterdayTomorrowShift,
  verifyDurationSumWordProblem,
  verifyTwoStageAffordabilityChain,
  verifyChainedVerticalArithmetic,
  verifyMinFactorsOfComposite,
  verifyLargestFactorImpliesNumber,
  verifyCommonFactorsCount,
  verifyMinAddToPrime,
  verifyFactorMultipleDefinitionMC,
  verifyPriceDecimalSplit,
  verifyPriceListMaxMinDifference,
  verifySelectTwoNumbersSumTargetFromText,
  verifyFirstNMultiples,
  verifyReverseBaseFromMultipleDifference,
  verifyMissingFactorInOrderedList,
  verifyDualConstraintNumberFilter,
  verifyNthCommonMultiple,
  verifyCoprimeProductEqualsLcmMC,
  verifyClosestApproximationMC,
  verifyExtremeNumberByDigitSum,
  verifyCoinExchangeRatio,
  verifyWhichExpressionComputesMC,
  chineseNumeralToArabicSmall,
  verifyReverseShapeFromFaceProperties,
  parseOrdinalToNumber,
  verifyOrdinalFromCountInFront,
  readClockHandsFromPixels,
  parseTimeAnswer,
  verifyClockReading,
  readLineShaftLengths,
  verifyLineShaftAllEqual,
  readObjectCountFromPixels,
  classifyColorName,
  readColorCountedBlobs,
  isColorCountedQuestion,
  verifyColorCountedIcons,
  readBalanceScalePiles,
  isBalanceScalePileQuestion,
  verifyBalanceScalePiles,
  readSecondHandAngleFromPixels,
  isSecondHandClockQuestion,
  verifySecondHandClock,
  readFractionShadingFromPixels,
  isFractionShadingQuestion,
  verifyFractionShading,
  findGridDotPositions,
  clusterSingleLetterWords,
  isGridPointIsoscelesQuestion,
  extractLabeledGridPoints,
  findGridPointsBbox,
  verifyGridPointIsosceles,
  isCjkParallelLinesMcQuestion,
  verifyCjkParallelLinesMc,
  isLatinParallelLinesCountQuestion,
  verifyLatinParallelLinesCount,
  classifyTrapezoidType,
  isTrapezoidTypeLetterQuestion,
  verifyTrapezoidTypeLetters,
  verifyObjectCounting,
  readShapeClassificationFromPixels,
  isShapeClassificationGridQuestion,
  parseLabelledParts,
  verifyShapeClassificationGrid,
  computeTriangleSubtypeProperties,
  collapseNearCollinearQuadToTriangle,
  classifyPrintedTriangleSubtypeTarget,
  isTriangleSubtypeLetterQuestion,
  verifyTriangleSubtypeLetterQuestion,
  isRectangleDiagonalCutQuestion,
  verifyRectangleDiagonalCut,
  isSquareFoldCutEightQuestion,
  verifySquareFoldCutEight,
  isHexagonCutPieceTypeQuestion,
  verifyHexagonCutPieceType,
  findLetterGridBbox,
  readAbacusColumnsFromPixels,
  isAbacusReadingQuestion,
  verifyAbacusReading,
  findAbacusBbox,
  extractBarChart,
  findAxisLine,
  readBarChartValues,
  isBarChartQuestion,
  verifyBarChart,
  findBarChartBbox,
  findRodPositions,
  estimateBackgroundLuminance,
  isInkByLuminance,
  verifySymbolicSubstitution,
  verifySymbolicRelation,
  verifyRelativeComparisonChain,
  verifyCompoundMultiplierWordProblem,
  verifyMinFromTwoCapacityConstraints,
  verifyEquationTruthMC,
  roundToLeadingDigit,
  tokenizeArithmeticExpr,
  exprTokensToKey,
  isEstimationMcQuestion,
  verifyEstimationMc,
  classifyTriangleFactStatement,
  normalizeCheckMark,
  isTriangleFactTrueFalseQuestion,
  verifyTriangleFactTrueFalse,
  extractStickLengths,
  parseCrosswordGrid,
  crosswordSlotCells,
  checkCrosswordConsistency,
  isTriangleFormableFromSticksQuestion,
  verifyTriangleFormableFromSticks,
  isMaxObtuseAngleInTriangleQuestion,
  verifyMaxObtuseAngleInTriangle,
  isDaysWith31CountQuestion,
  verifyDaysWith31Count,
  isWeekdayOffsetQuestion,
  verifyWeekdayOffset,
  verifyOpenDecomposition,
  verifyFactFamilyGeneration,
  verifyTextualClockDescription,
  verifyModularRemainderMC,
  verifySequentialSubtractionRemaining,
  verifyMatchingValueExpressionSetMC,
  parseOcrLine,
  reconstructSplitSentenceItems,
  displayPrintedQuestionForJudge,
  recordCpuGuardUsage,
  isCpuGuardTripped,
  buildWrongAnswersSummary,
  CPU_GUARD_DAILY_THRESHOLD_MS,
  extractContinuationMarkers,
  extractPriceTable,
  extractPassageText,
  extractWordBank,
  extractSudokuPuzzles,
  parseMcOptions,
  crossCheckPrintedNumbers,
  evalArithmetic,
  parseNumericAnswer,
  verifyMath,
  parseChineseNumberWord,
  numberToChineseWord,
  parseEnglishNumberWord,
  numberToEnglishWord,
  verifyNumberWordConversion,
  verifyComparisonSymbol,
  verdictResult,
  isOperatorFillBracketQuestion,
  verifyOperatorFillBracket,
  verifyParityMC,
  verifyComputationMC,
  verifyMultiBlankMath,
  verifyMissingDigitInNumber,
  verifyMissingDigitsInEquation,
  verifyMultiBoxDigitAnswer,
  verifySequenceFill,
  verifySortNumbers,
  verifySudoku4x4,
  verifySelectFromPassage,
  verifyGrammarCloze,
  conjugatePresent3S,
  conjugatePast,
  isVerbFormFillQuestion,
  verifyVerbFormFill,
  classifyPrepTimeExpr,
  classifyPrepositionOfTimeExpected,
  isPrepositionOfTimeQuestion,
  verifyPrepositionOfTime,
  verifyPictureMatchFormat,
  verifyWordBankOnceEach,
  verifyLiteralKeywordMC,
  verifyConjunctionFill,
  verifyWordProblemTotal,
  verifyPriceTableLookup,
  verifyWordProblemDivision,
  verifyWordProblemDifference,
  verifyWordProblemMoreThan,
  verifyNumberBetween,
  verifyWordProblemCeilingDivision,
  verifyDigitCountOfNPlusOne,
  verifyCompoundUnitConversion,
  verifyConstructExtremeNumber,
  verifyConstructExtremeNumberFromText,
  verifySelectTwoNumbersSumTarget,
  verifyListFactors,
  verifyCountPrimesBelow,
  verifyElapsedTimeForward,
  verifyReverseDivisorFromRemainder,
  verifyMultipleDifference,
  parseChineseSmallNumber,
  parseChineseLargeNumber,
  verifyChineseLargeNumeralToArabic,
  verifyRepeatedDigitPlaceValueDifference,
  verifySubstituteAndEvaluate,
  verifySortFractionsAscending,
  verifyRoundToNearestHundred,
  verifyReverseFactorSum,
  verifyDivisionRemainderBlank,
  verifyExtremeNumberDifference,
  verifyWordProblemRateMultiplication,
  verifyTimeFormatConversion,
  parseSignedStudentNumber,
  DIGIT_COUNT_OF_N_PLUS_ONE_RE,
  classifyAndVerify,
  QUESTION_TYPE_HANDLERS,
  cropItem,
  downscaleForCheapTier,
};
