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
import { PhotonImage, crop, rotate, resize, SamplingFilter } from "@cf-wasm/photon/workerd";
import { parseTelegramUpdate, telegramGetFile, telegramDownloadFile, telegramSendPhoto, telegramSendMessage, constantTimeEqual } from "./telegram.js";
import { annotateImage } from "./annotate.js";

// 2026-09-23, explicit instruction: "At the testing stage, do NOT use
// Sonnet/Opus to solve any questions." Claude Sonnet/Opus are meaningfully
// more expensive per call than the OpenRouter cheap tiers (Qwen/DeepSeek) --
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
    // leaving this in production long-term.
    if (url.pathname === "/api/test-noai-check" && request.method === "POST") {
      return handleTestNoAiCheck(request, env);
    }
    // TEMPORARY diagnostic route -- isolating why a real /api/check request's
    // DeepSeek call reliably times out (~30s) from this Worker when the same
    // image/prompt consistently returns in a few seconds from a plain Node
    // script. Makes a minimal, imageless OpenRouter call and reports how
    // long THAT alone takes, to tell apart "OpenRouter itself is slow from
    // this Worker/colo" from "something about the image payload specifically
    // is the problem". Remove once the real cause is found.
    if (url.pathname === "/api/test-deepseek-latency" && request.method === "GET") {
      return handleTestDeepSeekLatency(env);
    }
    // TEMPORARY diagnostic route -- isolating whether detectAndCorrectRotation
    // (Google Vision OCR + Photon, only exercised for real in this live
    // environment, never in local Node testing) is what's slow/failing for
    // a real ~400KB photo, separately from timing the Qwen call on the same
    // real image with rotation-detection skipped entirely. Remove once the
    // real cause is found.
    if (url.pathname === "/api/test-rotation-latency" && request.method === "POST") {
      return handleTestRotationLatency(request, env);
    }
    // TEMPORARY diagnostic route -- OCR engine benchmark. Calls the existing
    // googleOcr() (Google Cloud Vision DOCUMENT_TEXT_DETECTION, already used
    // for rotation/bbox-refinement) directly on a real photo and reports
    // real round-trip latency plus the raw extracted text/word count, to
    // compare against Qwen's OCR-only latency for the same real worksheet.
    // Remove once the benchmark is done.
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

async function handleTestVisionOcrLatency(request, env) {
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

async function handleTestDeepSeekLatency(env) {
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
        body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", max_tokens: 100, provider: { ignore: ["Alibaba"] }, messages: [{ role: "user", content: "Say OK and nothing else." }] }),
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
        body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", max_tokens: 100, provider: { ignore: ["Alibaba"] }, messages: [{ role: "user", content: [{ type: "text", text: "What color is this image? One word." }, { type: "image_url", image_url: { url: `data:image/png;base64,${tinyPng}` } }] }] }),
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
  // OpenRouter cheap tiers (Qwen/DeepSeek) are tried FIRST and often
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
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateKey = "checkrate:" + ip;
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

  // DeepSeek-only, deliberately condensed version of the same prompt --
  // Sonnet keeps the full one above untouched. Real testing 2026-09-20
  // showed prompt length/complexity directly drives DeepSeek's internal
  // "reasoning" token usage (same image+task: the short prompt below used
  // ~7000 reasoning tokens and finished; the full prompt maxed out 20000
  // and failed outright) -- speed/cost took priority over exhaustive edge-
  // case coverage per explicit instruction. Keeps only the highest-value,
  // confirmed-real-bug protections (faint pencil misread as blank; using
  // stated numbers over counting illustration objects); drops the longer
  // tail of narrower edge-case rules (coins, angles, tally marks, position
  // value, compass tricks, fraction shading, etc.) that Sonnet still covers
  // when DeepSeek fails or when this item lands in the null->verify tier.
  const deepseekPrompt = `你是一位細心的小學老師，正在批改學生的功課相片（共${images.length}頁）。冇提供標準答案——請你自己諗清楚每一題應該點答，再同學生手寫嘅答案比較。

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
  const usage = { primaryModel: null, qwenFailReason: null, deepseekFailReason: null, sonnet: null, sonnetZoom: null, opus: null };
  // Two-tier cheap pipeline, tried when OPENROUTER_API_KEY is configured --
  // per explicit instruction 2026-09-20: Sonnet's real cost (~£5 gone in
  // ~20 real submissions before this session's fixes) makes it
  // unacceptable as a silent fallback. Neither tier ever falls through to
  // Sonnet; a page either gets a real answer from Qwen/DeepSeek or a
  // clear "couldn't grade, please check by hand" response.
  //
  // 1. Qwen first (non-reasoning, fast, ~0.5-4s) -- cheapest and quickest
  //    when it works, but real testing showed it silently gives up
  //    (empty results, caught by callOpenRouterVisionModel's guard) on
  //    visually complex layouts (circling/ticking/matching).
  // 2. DeepSeek second, only if Qwen didn't produce usable results --
  //    slower and less predictable (internal "reasoning" token usage
  //    varies a lot run-to-run) but has handled everything Qwen gave up
  //    on in testing so far.
  // 3. If both fail, tell the user plainly rather than erroring out --
  //    at least some pages/pass may have partial results already cached
  //    from prior attempts on retry, and "please check by hand" is more
  //    actionable than a generic service error.
  if (openrouterKey) {
    // Downscaled once, shared by both tiers -- see downscaleForCheapTier's
    // own comment for why this exists. bbox stays valid: the model reports
    // position as a 0-100% fraction of the page, not pixels, so a smaller
    // image sent to the API doesn't change what the client draws against
    // the original photo.
    const cheapTierImages = images.concat(exemplars).map((img) => downscaleForCheapTier(img, 640));
    try {
      const r = await callQwen(cheapTierImages, deepseekPrompt, openrouterKey);
      parsed = r.parsed;
      usage.primaryModel = "qwen";
      usage.qwen = r.usage;
    } catch (e) {
      usage.qwenFailReason = e.kind || "unknown";
    }
    if (!parsed) {
      try {
        const r = await callDeepSeek(cheapTierImages, deepseekPrompt, openrouterKey);
        parsed = r.parsed;
        usage.primaryModel = "deepseek";
        usage.deepseek = r.usage;
      } catch (e) {
        usage.deepseekFailReason = e.kind || "unknown";
      }
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
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateKey = "verifyrate:" + ip;
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
async function callOpenRouterVisionModel(images, prompt, openrouterKey, { model, maxTokens, timeoutMs, providerFilter, logPrefix }) {
  const body = {
    model,
    max_tokens: maxTokens,
    ...(providerFilter ? { provider: providerFilter } : {}),
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
function downscaleForCheapTier(img, maxDim) {
  let photonImg;
  try {
    const bytes = base64ToBytes(img.data);
    photonImg = PhotonImage.new_from_byteslice(bytes);
    const w = photonImg.get_width();
    const h = photonImg.get_height();
    if (Math.max(w, h) <= maxDim) return img;
    const scale = maxDim / Math.max(w, h);
    const resized = resize(photonImg, Math.round(w * scale), Math.round(h * scale), SamplingFilter.Lanczos3);
    try {
      return { data: bytesToBase64(resized.get_bytes_jpeg(80)), mediaType: "image/jpeg" };
    } finally {
      resized.free();
    }
  } catch (e) {
    // Downscaling is a workaround, not a requirement -- if Photon itself
    // fails for any reason, send the original image rather than block.
    return img;
  } finally {
    if (photonImg) photonImg.free();
  }
}

// Single source of truth for the production OCR/vision model -- both
// callQwen (used by /api/check) and callQwenOcrText (used by /api/mark)
// used to hardcode this string independently (flagged 2026-09-22 in
// [[project_hk_homework_check_code_notes]], never acted on until now,
// per the user's 2026-09-25 request that a future model swap be easy).
// A swap now only means changing this one line. (2026-09-25 real-data
// comparison against 3 candidates -- Claude Haiku 4.5, Gemini 3.7 Flash,
// Qwen3.6-flash -- concluded this baseline stays: all 3 candidates were
// both less accurate on real worksheet photos AND more expensive, one
// (Qwen3.6-flash) was effectively unusable, a reasoning model that burns
// its token budget "thinking" before ever producing OCR output. See
// benchmark/ or ask for the numbers if this needs re-litigating later.)
const PRODUCTION_OCR_MODEL = "qwen/qwen3-vl-235b-a22b-instruct";

async function callQwen(images, prompt, openrouterKey) {
  return callOpenRouterVisionModel(images, prompt, openrouterKey, {
    model: PRODUCTION_OCR_MODEL,
    maxTokens: 4096,
    timeoutMs: 8000,
    logPrefix: "qwen",
  });
}

// Reasoning-based second look, tried when Qwen fails/gives up. Real
// testing 2026-09-20: most pages succeed in a few seconds for a few
// cents; occasionally a reasoning-heavy page (dense grammar/visual-logic
// questions) exhausts the token budget with zero output -- excluding the
// "Alibaba" route (an observed source of false-positive content-
// moderation blocks on ordinary children's homework) and a generous
// max_tokens noticeably reduces but does not eliminate this.
async function callDeepSeek(images, prompt, openrouterKey) {
  return callOpenRouterVisionModel(images, prompt, openrouterKey, {
    model: "deepseek/deepseek-v4.1-flash",
    maxTokens: 20000,
    timeoutMs: 12000,
    providerFilter: { ignore: ["Alibaba"] },
    logPrefix: "deepseek",
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

如果一條題嘅答題位置完全冇筆跡，一定要將學生答案填空白（即係嗰個位留空），絕對唔可以自己計出個答案填返去頂替，就算你識計都好——你嘅工作淨係抄低實際存在嘅筆跡，唔係幫學生完成功課。

如果見到用紅筆／同學生手寫顏色明顯唔同嘅筆改動過（劃咗線、圈返個答案、加咗字），要抄低學生原本用筆寫低嘅答案（就算個答案錯），唔好抄老師事後改咗嗰個版本。

如果呢張相根本唔似一份實體功課/練習卷——例如係手機或電腦嘅screenshot（有瀏覽器工具列、App介面、滑鼠標、按鈕、hyperlink）——就當呢頁冇任何題目，回覆空結果，唔好老作內容出嚟砌題目。但一張乾淨嘅掃描相（冇反光、冇陰影、冇摺痕）都算正常嘅功課相，唔好單純因為冇呢啲影相特徵就當佢唔係真嘅功課。

呢張相有${pageCount}頁。每一題回覆「題號=印刷題目文字|學生手寫答案」，用逗號分隔唔同題。題號跟返張相印刷嘅題號/標籤，搵唔到印刷編號就用簡短描述代替（例如題目嘅前幾個字）。如果一條題目入面學生寫咗多過一個答案（例如兩條算式），呢啲sub-answer之間用分號";"分隔，唔好用逗號（逗號淨係用嚟分隔唔同題目）。「|」呢個符號每一題一定要有、一定唔可以漏——尤其係長除法（例如5)40呢種直式）或者一題有幾個sub-answer嘅情況，都要跟返「題號=印刷題目|答案」呢個format，唔好淨係將啲數字答案接住上一題冧埋一齊列。例如：
1=4+6|6+4=10,2=2+5|5+2=7,9=make two sums|6+9=15;5+8=13

唔好加任何其他文字、判斷、JSON。`;

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
    // "printed/answer swap" regression test). 235B remains the most
    // reliable model for this task; latency is being addressed by
    // other means (downscale, already applied; see the ongoing
    // latency-audit findings in memory/commit history) rather than by
    // continuing to swap models.
    model: PRODUCTION_OCR_MODEL,
    // 2026-09-22 latency audit #1 result: provider:{sort:"latency"} was
    // tried and rejected -- real benchmark showed it made every case
    // SLOWER (not faster) and one case notably LESS accurate (matching
    // the already-rejected DeepSeek failure pattern almost exactly).
    // Reverted to default OpenRouter routing (no provider override).
    max_tokens: 2000,
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
  const items = parseOcrLine(text);
  if (!items.length) {
    throw { kind: "upstream_error", uiMessage: "改功課服務暫時無法使用，請稍後再試。", detail: "qwen_ocr_empty", status: 502 };
  }
  return { items, usage: data.usage || null };
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
  const norm = String(text).replace(/，/g, ",").replace(/＝/g, "=").replace(/｜/g, "|").replace(/；/g, ";");
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
  return { correct: Math.abs(lhsVal - rhsVal) < 1e-9, correctAnswer: lhsVal === rhsVal ? "" : String(lhsVal) };
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
      const lhsVal = evalArithmetic(lhs);
      const rhsVal = parseNumericAnswer(rhs);
      if (lhsVal !== null && !Number.isNaN(rhsVal)) {
        return { correct: Math.abs(lhsVal - rhsVal) < 1e-9, correctAnswer: lhsVal === rhsVal ? "" : String(lhsVal) };
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
    const expected = evalArithmetic(printedExpr);
    const studentVal = parseNumericAnswer(sub);
    if (expected !== null && !Number.isNaN(studentVal)) {
      return { correct: Math.abs(expected - studentVal) < 1e-9, correctAnswer: expected === studentVal ? "" : String(expected) };
    }
    return { correct: null, correctAnswer: "" };
  });

  if (results.some((r) => r.correct === null)) return { correct: null, correctAnswer: "" };
  const allCorrect = results.every((r) => r.correct === true);
  return { correct: allCorrect, correctAnswer: allCorrect ? "" : results.map((r) => r.correctAnswer || "?").join(", ") };
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
  const isWordAnswer = /[a-zA-Z]/.test(answer) || /[一二三四五六七八九十零]/.test(answer);
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

// "Finish the sentences with 'but' or 'and'" linking-word fill (real
// example: benchmark/photos/batch3/p2_english_but_and_dialogue.jpg --
// the worksheet's own instruction box states the rule explicitly: "but"
// links DIFFERENT/opposite ideas, "and" links SIMILAR ideas. Confirmed
// against all 8 real scored blanks on that page (items 1-5, some with
// 2-3 sub-blanks each) -- every one matches a simple POLARITY rule:
// detect whether each clause is affirmative or negative (a negation
// marker: not/n't/don't/doesn't/can't/won't/isn't/aren't/didn't/
// wasn't/weren't); if the two clauses share the same polarity -> "and",
// if they differ -> "but". A short clause with no verb of its own (e.g.
// "one sister", "badminton", "soya milk") has no pronoun or negation
// marker either, so it inherits clause A's polarity -- matches all 3
// real elliptical examples on the page (items 3, 4a, 5a). Anything
// neither clause's polarity can be read from returns null, never a
// guess.
function verifyConjunctionFill(clauseA, clauseB, studentAnswer) {
  const answer = String(studentAnswer || "").trim().toLowerCase();
  if (answer !== "but" && answer !== "and") return { correct: null, correctAnswer: "" };
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
const RATE_MULTIPLICATION_UNIT_RE = /([一二兩三四五六七八九十]+|\d+)(?=天|日|次|個|年|月|小時|星期|週|盒|包|本|支|條)/;
function verifyWordProblemRateMultiplication(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/每/.test(printed) || !/(共|總共|一共|合共)/.test(printed)) return { correct: null, correctAnswer: "" };

  const rateMatch = printed.match(/(?<!第)\d+/);
  if (!rateMatch) return { correct: null, correctAnswer: "" };
  const rate = Number(rateMatch[0]);

  const unitMatch = printed.slice(rateMatch.index + rateMatch[0].length).match(RATE_MULTIPLICATION_UNIT_RE) || printed.match(RATE_MULTIPLICATION_UNIT_RE);
  if (!unitMatch) return { correct: null, correctAnswer: "" };
  const countToken = unitMatch[1];
  const count = /^\d+$/.test(countToken) ? Number(countToken) : parseChineseNumberWord(countToken);
  if (count === null || Number.isNaN(count)) return { correct: null, correctAnswer: "" };

  const expected = rate * count;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  const correct = studentNum === expected;
  return { correct, correctAnswer: correct ? "" : String(expected) };
}

function verifyWordProblemTotal(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/(共|總共|一共|合共)/.test(printed)) return { correct: null, correctAnswer: "" };
  // 2026-09-25 real bug found: this function's own "共" trigger also
  // fires on a genuinely different real shape -- a RATE word problem
  // ("小克每天儲蓄30元，他五天共儲蓄多少元" -> 30×5=150, NOT 30+5=35).
  // The 2026-09-23 decision (ticket B9) to sum every number found when
  // "共" appears was scoped to same-kind-count-addition examples; a "每"
  // (per/each) rate marker signals a different operation entirely and
  // must refuse here rather than silently sum, not be swept into that
  // decision by the shared keyword. See verifyWordProblemRateMultiplication
  // for the dedicated handler.
  if (/每/.test(printed)) return { correct: null, correctAnswer: "" };
  const nums = (printed.match(/(?<!第)\d+/g) || []).map(Number);
  if (nums.length < 2) return { correct: null, correctAnswer: "" };
  const expected = nums.reduce((a, b) => a + b, 0);
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
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
    return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
  }
  if (isSum && !isDifference) {
    const expected = priceA + priceB;
    return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
  }
  return { correct: null, correctAnswer: "" };
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
function verifyWordProblemDifference(printedQuestion, studentAnswer) {
  const printed = String(printedQuestion || "");
  const answer = String(studentAnswer || "").trim();
  if (!answer || !/相差/.test(printed)) return { correct: null, correctAnswer: "" };
  const nums = (printed.match(/\d+/g) || []).map(Number);
  if (nums.length !== 2) return { correct: null, correctAnswer: "" };
  const expected = Math.abs(nums[0] - nums[1]);
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
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
  const perMatch = printed.match(/每[^\d]{0,10}(\d+)/);
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
  return { correct: studentNum === expected, correctAnswer: studentNum === expected ? "" : String(expected) };
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
  return { correct: closeEnough, correctAnswer: closeEnough ? "" : expectedStr };
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
  if (!times || times.length !== 2) return { correct: null, correctAnswer: "" };
  const t1 = parseTime12h(times[0]);
  const t2 = parseTime12h(times[1]);
  if (t1 === null || t2 === null) return { correct: null, correctAnswer: "" };
  let diffMin = t2 - t1;
  if (diffMin < 0) diffMin += 24 * 60;
  const expected = diffMin / 60;
  const studentNum = parseSignedStudentNumber(answer);
  if (Number.isNaN(studentNum)) return { correct: null, correctAnswer: "" };
  const closeEnough = Math.abs(studentNum - expected) < 1e-9;
  const expectedStr = Number.isInteger(expected) ? String(expected) : String(expected);
  return { correct: closeEnough, correctAnswer: closeEnough ? "" : expectedStr };
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
    name: "number_word_conversion",
    detect: (item) => {
      const printed = String(item.printedQuestion || "").trim();
      const answer = String(item.studentAnswer || "").trim();
      if (!printed || !answer) return false;
      const quoted = /'([a-zA-Z\s-]+)'|"([a-zA-Z\s-]+)"|「([一二三四五六七八九十零]+)」/.test(printed);
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
      const isWordAnswer = /[a-zA-Z]/.test(answer) || /[一二三四五六七八九十零]/.test(answer);
      return hasSmallDigit && isWordAnswer;
    },
    verify: (item) => verifyNumberWordConversion(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "word_problem_total",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/(共|總共|一共|合共)/.test(printed)) return false;
      return (printed.match(/(?<!第)\d+/g) || []).length >= 2;
    },
    verify: (item) => verifyWordProblemTotal(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "word_problem_difference",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/相差/.test(printed)) return false;
      return (printed.match(/\d+/g) || []).length === 2;
    },
    verify: (item) => verifyWordProblemDifference(item.printedQuestion, item.studentAnswer),
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
    name: "count_primes_below",
    detect: (item) => /\d+\s*(?:以內|以下|之內)[^\d]{0,10}(?:質數|prime)/i.test(String(item.printedQuestion || "")),
    verify: (item) => verifyCountPrimesBelow(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "elapsed_time_forward",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!/(hours?|小時)/i.test(printed)) return false;
      return (printed.match(/\d{1,2}:\d{2}\s*[ap]\.?m\.?/gi) || []).length === 2;
    },
    verify: (item) => verifyElapsedTimeForward(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "reverse_divisor_from_remainder",
    detect: (item) => /\d+\s*[÷\/]\s*[?□※]\s*=\s*\d+\s*[…\.]{1,3}\s*\d+/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyReverseDivisorFromRemainder(item.printedQuestion, item.studentAnswer),
  },
  {
    name: "multiple_difference",
    detect: (item) => /\d+嘅第[一二三四五六七八九十]+個同第[一二三四五六七八九十]+個倍數相差/.test(String(item.printedQuestion || "")),
    verify: (item) => verifyMultipleDifference(item.printedQuestion, item.studentAnswer),
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
    name: "grammar_cloze",
    detect: (item) => {
      const printed = String(item.printedQuestion || "");
      if (!String(item.studentAnswer || "").trim()) return false;
      if (/\b(I|He|She|They|We|You|His\s+sister|Her\s+brother)\s+_{2,}/i.test(printed)) return true;
      return /_{2,}\s*[a-zA-Z']+/.test(printed);
    },
    verify: (item) => verifyGrammarCloze(item.printedQuestion, item.studentAnswer),
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
function classifyAndVerify(item) {
  if (item.parseFailed) return { correct: null, correctAnswer: "", subject: "uncertain", handler: null };
  for (const handler of QUESTION_TYPE_HANDLERS) {
    if (handler.detect(item)) {
      const result = handler.verify(item);
      const subject = handler.name === "math_equation" || handler.name.startsWith("word_problem")
        || ["multi_blank_math", "missing_digit_in_number", "missing_digits_in_equation", "multi_box_digit_answer", "sequence_fill", "sort_numbers", "comparison_symbol", "parity_mc", "computation_mc", "number_word_conversion", "digit_count_of_n_plus_one", "compound_unit_conversion", "construct_extreme_number", "list_factors", "count_primes_below", "elapsed_time_forward", "reverse_divisor_from_remainder", "multiple_difference", "round_to_nearest_hundred", "reverse_factor_sum"].includes(handler.name)
        ? "math" : detectSubject(item.printedQuestion, item.studentAnswer);
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

// Ticket 5 (2026-09-25 rigor check): counts how many question-number
// LABELS (not just any digit) genuinely seem to be printed on the page,
// from Google Vision's word list, as a cheap safety net against AI
// silently dropping whole items (a real confirmed bug: 3 items' worth
// of content vanished from a 6-line exercise).
//
// Primary signal (strongest, tried first): a candidate label shape
// ("1." "2)" "一、" a circled digit) whose X position lines up with
// OTHER candidates AND whose numbers form a run of 3+ consecutive
// integers. Sequential-increment is what tells a real question-number
// column apart from a coincidentally-aligned table data column (a data
// column like 5,8,12,20 is never a clean run) -- this single check
// doubles as the fix for the table false-positive trap, no separate
// table-detection logic needed. X-alignment on its own is NOT required
// -- a worksheet whose own numbering isn't neatly aligned (a teacher-
// made sheet, mixed section formats) would wrongly lose real labels if
// alignment were a hard filter, so it's folded into "which candidates
// count toward the run", not a standalone gate.
//
// Fallback signal (only when no 3+ run is found): a label-shaped token
// followed by a clear horizontal gap before the next word -- a real
// label has visual breathing room before the question text; a stray
// number matching the shape mid-equation (e.g. "5." right before "×2=")
// does not. This is a purely local, per-token check, so it still works
// on a page whose layout is irregular.
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

function countLikelyQuestionNumbers(visionWords, pageWidth, pageHeight) {
  if (!Array.isArray(visionWords) || !visionWords.length || !pageWidth) return null;
  const candidateNumber = candidateQuestionLabelNumber;
  const candidates = [];
  for (let i = 0; i < visionWords.length; i++) {
    const num = candidateNumber(visionWords[i].text);
    if (num !== null) candidates.push({ idx: i, word: visionWords[i], num });
  }
  if (!candidates.length) return null;

  // Primary: bucket by X position (~3% of page width tolerance), look
  // for the longest run of consecutive integers within any one bucket.
  const xBucketSize = Math.max(pageWidth * 0.03, 1);
  const buckets = new Map();
  for (const c of candidates) {
    const bucket = Math.round((c.word.x || 0) / xBucketSize);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(c.num);
  }
  let bestRun = 0;
  for (const nums of buckets.values()) {
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    let run = 1;
    for (let i = 1; i < sorted.length; i++) {
      run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
      bestRun = Math.max(bestRun, run);
    }
    bestRun = Math.max(bestRun, sorted.length ? 1 : 0);
  }
  if (bestRun >= 3) return bestRun;

  // Fallback: label-shaped token followed by a clear gap.
  let gapCount = 0;
  for (const c of candidates) {
    const next = visionWords[c.idx + 1];
    const charWidth = c.word.w || 10;
    if (!next || (next.x || 0) - ((c.word.x || 0) + charWidth) > charWidth * 1.5) gapCount++;
  }
  return gapCount || null;
}

// Groups Vision's flat word list into per-question chunks, for a human
// to read Vision's raw output grouped by which question it belongs to
// (2026-09-25, real user request during the Ticket 4 validation pass).
// A new chunk starts at every candidate label token (reusing the same
// shape-matching as countLikelyQuestionNumbers); everything before the
// first label lands in a leading "(unlabeled)" chunk. Deliberately
// simple -- no X-position/sequential filtering here, this is a human-
// readable diagnostic view, not the production safety-net logic.
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
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateKey = "markrate:" + ip;
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
      .then((r) => ({ ok: true, items: r.items, usage: r.usage, qwenMs: Date.now() - tQwen }))
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
    return { page: pageIdx, failed: false, items: qwenOutcome.items, usage: qwenOutcome.usage, vision, qwenMs: qwenOutcome.qwenMs, visionMs: vision ? vision.visionMs : null };
  });
  const pagesMs = Date.now() - tPages;

  // Module 2: subject-aware verification (deterministic, no I/O) -- one
  // failed page contributes an empty verdict list, nothing more.
  const tVerify = Date.now();
  const verdictsByPage = pageResults.map((pr) => (pr.failed ? [] : pr.items.map((item) => classifyAndVerify(item))));
  const verifyMs = Date.now() - tVerify;

  // Module 3: bbox, scoped to each item's OWN page's Vision words only --
  // no more cross-page guessing needed now that page identity is already
  // structural (see above).
  const tMap = Date.now();
  const matchesByPage = pageResults.map((pr) =>
    pr.failed ? [] : pr.items.map((item) => (pr.vision ? findBboxForItem(item, pr.vision.words, pr.vision.width, pr.vision.height) : null))
  );
  const mapMs = Date.now() - tMap;

  // Module 3b, Ticket 4 (2026-09-25): cross-check printed NUMBERS
  // against Vision's independent reading, per item -- see
  // crossCheckPrintedNumbers's own comment for why this is narrower
  // than a full printed-text substitution. `null` (not run / no
  // Vision / no numbers to check) is treated as "nothing to flag",
  // same fail-open-to-trusting-AI behaviour as before this existed.
  const numberChecksByPage = pageResults.map((pr) =>
    pr.failed ? [] : pr.items.map((item) => (pr.vision ? crossCheckPrintedNumbers(item, pr.vision.words, pr.vision.width, pr.vision.height) : null))
  );

  // Deterministic merge: a failed page is recorded in `pageErrors` and
  // simply contributes no items -- every OTHER page's results are
  // unaffected, unlike the old single-combined-call design where one
  // failure took down the whole submission.
  const results = [];
  const pageErrors = [];
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
        note: printedNumberMismatch ? "印刷數字唔肯定" : effectiveCorrect === null ? "需要人手複核" : "",
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
    });
  });

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
  }));

  // Ticket 5 (2026-09-25): dropped-content safety net. Logging only for
  // now, not yet a user-facing flag -- see countLikelyQuestionNumbers's
  // own comment for the detection method. Only fires on a MEANINGFUL
  // margin (Vision counted 2+ more likely labels than AI returned
  // items), not any mismatch at all, to tolerate this heuristic's own
  // imperfection (real worksheets don't always number cleanly).
  pageResults.forEach((pr, pageIdx) => {
    if (pr.failed || !pr.vision) return;
    const visionCount = countLikelyQuestionNumbers(pr.vision.words, pr.vision.width, pr.vision.height);
    if (visionCount === null) return;
    const aiCount = pr.items.length;
    if (visionCount - aiCount >= 2) {
      console.log(JSON.stringify({
        event: "mark_possible_dropped_content",
        page: pageIdx,
        visionLikelyQuestionCount: visionCount,
        aiReturnedItemCount: aiCount,
      }));
    }
  });

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

  return json({
    results,
    score: `${correctCount} / ${results.length}`,
    needsVerify: results.filter((r) => r.correct === null).map((r) => ({ page: r.page, question: r.question })),
    pageRotations,
    ...(pageErrors.length ? { pageErrors } : {}),
  });
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
      const photonImg = PhotonImage.new_from_byteslice(photoBytes);
      try {
        const rotatedImg = rotate(photonImg, rotationDeg);
        try {
          bytesToAnnotate = rotatedImg.get_bytes_jpeg(90);
        } finally { rotatedImg.free(); }
      } catch (e) {
        console.log(JSON.stringify({ event: "telegram_rotation_apply_failed", error: String(e && e.message || e) }));
        // best-effort -- annotate the un-rotated original rather than fail the whole submission
      } finally { photonImg.free(); }
    }

    const tAnnotate = Date.now();
    const annotated = annotateImage(bytesToAnnotate, markJson.results || []);
    const annotationMs = Date.now() - tAnnotate;

    const tSend = Date.now();
    // "Checked" means only "this photo was processed", NOT "every answer
    // is correct" -- it is not a correctness verdict and must not be read
    // as one. needs_review (correct === null) items now get their own "?"
    // mark (annotateImage's "review" icon kind, drawn via Photon's
    // draw_text_with_color -- see annotate.js) distinct from the cross, so
    // an all-correct-looking marked-up photo no longer hides unreviewed
    // items from the parent.
    await telegramSendPhoto(botToken, chatId, annotated.data, annotated.mediaType, "Checked");
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
  return { data: bytesToBase64(outBytes), mediaType: "image/jpeg" };
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
  crossCheckPrintedNumbers,
  countLikelyQuestionNumbers,
  evalArithmetic,
  parseNumericAnswer,
  verifyMath,
  parseChineseNumberWord,
  numberToChineseWord,
  parseEnglishNumberWord,
  numberToEnglishWord,
  verifyNumberWordConversion,
  verifyComparisonSymbol,
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
  verifyPictureMatchFormat,
  verifyWordBankOnceEach,
  verifyLiteralKeywordMC,
  verifyConjunctionFill,
  verifyWordProblemTotal,
  verifyPriceTableLookup,
  verifyWordProblemDivision,
  verifyWordProblemDifference,
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
};
