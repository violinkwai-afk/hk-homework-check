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
import { PhotonImage, crop } from "@cf-wasm/photon/workerd";

const CHECK_RATE_LIMIT = 15; // max /api/check calls per IP per hour
const MAX_HANDWRITING_SAMPLES = 12; // per device, oldest evicted first
const HANDWRITING_SAMPLE_TTL = 60 * 60 * 24 * 90; // 90 days
const HANDWRITING_SAMPLES_PER_REQUEST = 3; // new exemplars captured per submission
const HANDWRITING_EXEMPLARS_USED = 4; // most recent samples sent as reference

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/check" && request.method === "POST") {
      return handleCheck(request, env);
    }
    if (url.pathname === "/api/forget-handwriting" && request.method === "POST") {
      return handleForgetHandwriting(request, env);
    }
    // TEMPORARY debug route -- exercises the real rate-limit KV and real
    // Google Vision OCR refinement against a caller-supplied "parsed" result
    // (skipping the Anthropic call entirely), so infra behavior/cost can be
    // checked without spending on the metered Claude key. Remove before
    // leaving this in production long-term.
    if (url.pathname === "/api/test-noai-check" && request.method === "POST") {
      return handleTestNoAiCheck(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

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
  const { images, parsed } = body;
  if (!images || !images.length || !parsed || !parsed.results) {
    return json({ error: "bad_request", message: "缺少images或parsed。" }, 400);
  }

  const visionKey = typeof env.GOOGLE_VISION_API_KEY === "string"
    ? env.GOOGLE_VISION_API_KEY
    : (env.GOOGLE_VISION_API_KEY ? await env.GOOGLE_VISION_API_KEY.get() : null);
  let ocrUsed = false;
  if (visionKey && parsed.results.length) {
    try {
      await refineWithOcr(parsed.results, images, visionKey);
      ocrUsed = true;
    } catch (e) {
      return json({ error: "ocr_error", message: String(e && e.message || e) }, 500);
    }
  }

  return json({ ...parsed, ocrUsed }, 200);
}

async function handleCheck(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json(
      { error: "not_configured", message: "自動改功課未設定好，請聯絡網站管理員。" },
      503
    );
  }
  const apiKey = typeof env.ANTHROPIC_API_KEY === "string"
    ? env.ANTHROPIC_API_KEY
    : await env.ANTHROPIC_API_KEY.get();

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

  let { images, image, mediaType, requestId, deviceId, rememberHandwriting } = body;
  if (!images && image) images = [{ data: image, mediaType }];
  if (!images || !images.length) {
    return json({ error: "bad_request", message: "缺少相片。" }, 400);
  }
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
1. 睇清楚相入面每一條題目（可以係印刷體或手寫題目），自己諗出正確答案，然後同學生手寫嘅作答比較。如果題目要睇圖表／刻度先答到（例如燒杯水位、尺、鐘面），一定要搵返個刻度線實際喺邊度，唔好單憑感覺假設「啱啱注滿到頂」或者「啱啱指住嗰粒」，睇唔清就寧願設 "correct" 為 null，唔好肯定咁答錯。
1a. 數圖形／物件數量嗰陣，記住連埋結構性、唔顯眼嘅元件都要數（例如天平嘅橫樑本身都算一個長方形，唔淨係數天平掛住嗰啲圖案），唔好淨係數最搶眼嗰幾件。算柱／珠算圖（萬千百十個嗰種）要逐條柱仔細數珠，數完可以自我檢查：每一條柱代表一個數位，正常應該係0-9粒，如果數到10粒或以上，好大機會數錯咗，要重新數過。
1b. 如果幾條題目喺數值上有關係（例如後面一題係前面幾題相加或相減），計埋條數check吓學生嘅幾個答案夾唔夾得埋，先落判斷——夾得埋通常代表學生方法啱，唔好淨係逐題獨立咁睇。
1c. 學生作答唔一定係手寫填空：可能係圈出印刷體幾個選項入面嗰一個（例如「Odd / even」、「more / fewer」）、選擇題揀咗個字母寫落格仔、或者一條題目入面有兩三個獨立填空位（呢種情況每個空位當一條獨立嘅細題，題號可以寫「9-1」「9-2」咁分辨，各自有自己嘅bbox）。呢幾種都要當正常作答咁判斷啱唔啱。
1c2. 另一種圈嘢係「喺一堆印刷嘅銀紙／銀仔入面，圈出加埋等於某個金額（例如找續）嘅幾件」——呢個唔係二揀一，係要驗證學生實際圈咗嗰幾件加埋啱唔啱等於目標金額，唔係淨係睇佢有冇圈嘢。
1d. 如果係填色、連線、畫路線呢類靠顏色／筆劃分佈先睇到岩唔岩嘅題目（唔係文字/數字/圈選/字母），呢個方法暫時判斷唔到，"correct" 設為 null，"note" 填「暫未支援」，唔好亂估。
1e. 涉及硬幣／金錢嘅題目，一定要逐個銀仔睇清楚面額先加埋——好似嘅面額容易睇錯（例如$2同2毫、$10同$1、$5同5毫），唔好掃一眼就當晒係熟悉嗰個幣值。日常物件長度／重量嘅估算題（例如「一枝牙籤大約幾多厘米」），可以用生活常識判斷合理答案，唔使淨係靠張相度長度。
1f. 「用尺喺相片度量出實物長度」呢類題目（張相冇印刷刻度，淨係得箭嘴標住個範圍），相片本身冇辦法知道原本印刷嘅實際比例，要靠校準先度得到。優先用**同一題入面較早部份學生自己填嘅長度答案**做參照，同相入面兩件物件嘅像素長度比例推算後面嘅答案（呢個方法兩件物件通常喺相入面距離接近，受影相角度/透視影響較細）；搵唔到就退而求其次，睇吓張相有冇完整影到成張紙嘅左右兩邊——大部分香港功課用A4紙（直度闊21厘米，橫度闊29.7厘米），用嗰個已知闊度做比例尺（但如果張紙睇落唔規則／有明顯透視傾斜，呢個方法唔準，唔好用）。用呢兩種校準方法計出嚟嘅答案，比較學生答案嗰陣要畀寬鬆少少嘅容忍度（正負1厘米或者正負一成，以較大者為準）先算啱，因為呢個方法本身已經有額外誤差，唔應該當精確量度咁計較。兩種方法都用唔到、又冇容忍到嘅範圍先設"correct"為null，"note"填「無法量度」。
1g. 判斷角度大小、係咪直角呢類靠小圖線條斜度先睇到嘅題目，同睇刻度一樣容易睇錯，唔好淨係睇成頁縮圖就落判斷——如果唔夠肯定就設"correct"為null，等後續放大果層先仔細睇。留意好多教科書標示直角會加一個細方塊符號喺個角度，見到就可以直接當直角。
1h. 「喺鐘面度畫時針分針」呢類畫圖題,同填色/連線唔同,呢個係有明確答案嘅——睇清楚學生畫嗰兩支針分別指向邊度,計返係幾點幾分,同題目要求嘅時間比較,唔使當「暫未支援」。
1i. 「(Show full steps)/列式計算」呢類要求寫低成串計算過程嘅大空白格,唔好淨係搵一個獨立數字，成個空白格當一條題目、一個bbox——判斷嗰陣淨係睇個過程最尾嗰個答案啱唔啱，"correctAnswer"填正確嘅最終答案，中間步驟有冇小瑕疵唔使深究（呢個系統冇部分給分，淨係啱定錯）。
1k. 直式長除法／直式計算入面填缺格嘅數字題（即係傳統嗰種：除數喺左邊、商喺上面、下面一步步減嘅格式），呢啲缺格唔係印刷字，要靠成條直式嘅運算關係自己計返嗰個缺格應該係咩數字，唔係憑空估。
1j. 分辨立體圖形（prism/pyramid）嗰陣，唔好淨係睇成個2D畫圖嘅輪廓形狀（例如「楔形」睇落成日兩種都好似），要睇清楚圖入面畫緊嘅**每一塊面本身係咩形狀**：prism嘅畫法一定會見到最少一塊平行四邊形／長方形嘅側面（因為佢係將一個底面拉長嗰種形狀）；pyramid嘅畫法所有面都係三角形，全部匯聚去一個尖頂，冇任何平行四邊形側面。見到內部分界線分出嚟嘅兩塊都係三角形，就係pyramid，唔好因為個輪廓睇落似楔形就當係prism。
1l. 方向題（東南西北）一定要留意圖入面個指南針／「北」字箭嘴實際指住邊——呢類題目成日刻意將個指南針畫成唔係向上（例如「北」指向左邊），專登考你有冇認定「上面就係北」呢個錯誤假設。答呢類題之前，一定要先喺圖度搵到個方向指標，用嗰個嚟做基準，唔好預設向上=北。
2. 答題位置完全空白、無筆跡，"correct" 設為 false，"note" 填「未作答」。
3. 只有答題位置確實有筆跡，但寫得太潦草或有歧義而無法判斷，先將 "correct" 設為 null，並喺 "note" 簡短註明原因（例如「字跡不清」），四個字以內。
4. 只有 "correct" 係 false 先填 "correctAnswer"（即係正確答案應該係咩，愈短愈好），其他情況（答啱或者唔確定）"correctAnswer" 留空字串。"note" 只在未作答或唔確定時填寫，其餘一律留空。
5. 對於每一題，喺 "bbox" 提供一個大約嘅方框位置，用百分比（0-100）表示，相對於嗰一頁相片嘅闊度同高度，方框範圍應該喺學生手寫作答附近或題號隔籬，等我哋可以喺相片上面嗰個位置標記剔號或交叉。另外用 "page" 講呢一題喺第幾張相（由0開始計）。
6. 喺 "anchor" 填低嗰一題「印刷體」嘅題號標籤本身，淨係果幾個字符（例如 "1."、"3)"、"(a)"、"四、"），千祈唔好抄埋成句題目或者算式，愈短愈準。搵唔到就填空字串。
7. 淨係做啱錯判斷，唔使分析弱項或者其他額外內容。只回覆一個JSON物件，不要加任何其他文字：
{
  "results": [
    {"question":"題號","studentAnswer":"學生答案","correct":true/false/null,"correctAnswer":"","note":"","page":0,"bbox":{"x":0,"y":0,"w":0,"h":0},"anchor":""}
  ],
  "score": "X / Y（Y為總題數，X為答對題數，包括未作答；只有字跡不清的題目不計入Y）"
}`
    + (exemplars.length
      ? `\n\n附加：最後${exemplars.length}張圖係同一個小朋友之前已確認啱嘅字跡樣本，純粹俾你熟悉佢寫字嘅風格，唔屬於今次功課，唔使批改，"page"編號同"bbox"都唔關呢幾張事。`
      : '');

  let parsed;
  const usage = { sonnet: null, sonnetZoom: null, opus: null };
  try {
    const r = await callClaude("claude-sonnet-5", 4096, images.concat(exemplars), prompt, apiKey);
    parsed = r.parsed;
    usage.sonnet = r.usage;
  } catch (e) {
    return json({ error: e.kind || "upstream_error", message: e.uiMessage, detail: e.detail }, e.status || 502);
  }

  // Position refinement runs BEFORE the recheck (not after) so that if we
  // need to crop a zoomed-in close-up for the recheck pass below, the crop
  // is centered on OCR's precise position rather than the model's own
  // rougher guess -- exactly the cases where that guess is least reliable
  // are the ones about to get rechecked.
  const visionKey = typeof env.GOOGLE_VISION_API_KEY === "string"
    ? env.GOOGLE_VISION_API_KEY
    : (env.GOOGLE_VISION_API_KEY ? await env.GOOGLE_VISION_API_KEY.get() : null);
  if (visionKey && parsed.results && parsed.results.length) {
    try {
      await refineWithOcr(parsed.results, images, visionKey);
    } catch (e) {
      // OCR is a precision upgrade, not a requirement -- keep the model's
      // own bbox estimates if anything here goes wrong.
    }
  }

  // Three-tier hybrid: the zoom-crop is what actually helps read messy
  // handwriting, and that benefit doesn't require the expensive model --
  // so retry unsure items with a cheap Sonnet call FIRST using zoomed
  // crops, and only escalate to Opus for whatever is still unresolved
  // after that. Most "illegible" cases are really just "too small in the
  // full-page image" and get caught by the cheap zoom retry.
  //
  // photonCache is shared across BOTH tiers so a page only gets decoded
  // from JPEG once even if items on it are still unsure after tier 1 and
  // need cropping again for tier 2 -- freed once at the very end.
  const photonCache = new Map();
  let unsure = (parsed.results || []).filter((r) => r.correct === null);
  try {
    if (unsure.length) {
      unsure = await recheckPass(parsed, unsure, images, apiKey, "claude-sonnet-5", 2048, usage, "sonnetZoom", photonCache);
    }
    if (unsure.length) {
      unsure = await recheckPass(parsed, unsure, images, apiKey, "claude-opus-5", 2048, usage, "opus", photonCache);
    }
    // Capture a few confirmed-correct answers as new handwriting exemplars
    // for next time -- reuses whatever pages recheck already decoded via
    // photonCache, so this rarely needs a fresh decode of its own. Only
    // "correct: true" items qualify: a wrong or still-uncertain answer is
    // exactly the messy handwriting we do NOT want to teach the model as a
    // reference example.
    if (rememberHandwriting && deviceKey && env.RATE_LIMIT_KV) {
      const goodOnes = (parsed.results || []).filter((r) => r.correct === true && r.bbox && images[r.page]).slice(0, HANDWRITING_SAMPLES_PER_REQUEST);
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
  if (parsed.results && parsed.results.length) {
    const graded = parsed.results.filter((r) => r.correct !== null);
    const correctCount = graded.filter((r) => r.correct === true).length;
    parsed.score = `${correctCount} / ${graded.length}`;
  }

  console.log(JSON.stringify({ event: "check_usage", pages: images.length, usage, ocrUsed: !!visionKey }));

  if (idemKey && env.RATE_LIMIT_KV) {
    try {
      await env.RATE_LIMIT_KV.put(idemKey, JSON.stringify(parsed), { expirationTtl: 1800 });
    } catch (e) { /* best-effort */ }
  }

  return json(parsed, 200);
}

// Upgrades each result's bbox from "the model's own guess at pixel
// coordinates" (imprecise, drifts on a skewed photo) to "a real OCR engine's
// bounding box for the matching printed anchor text" (precise, but only
// works for TYPESET text -- which is exactly why the model was asked for the
// printed question number/label as the anchor, not the handwritten answer;
// OCR is no better than the model at reading messy handwriting, so it isn't
// asked to).
async function refineWithOcr(results, images, visionKey) {
  const byPage = new Map();
  results.forEach((r) => {
    const p = r.page || 0;
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p).push(r);
  });

  for (const [pageIdx, pageResults] of byPage.entries()) {
    const anchored = pageResults.filter((r) => r.anchor && r.anchor.trim());
    if (!anchored.length || !images[pageIdx]) continue;

    // Scoped per page: one page's OCR call failing (bad image data, a
    // transient Vision API error) must not skip refinement for every OTHER
    // page in the same submission -- those are independent images and
    // independently likely to succeed.
    let ocr;
    try {
      ocr = await googleOcr(images[pageIdx].data, visionKey);
    } catch (e) {
      continue;
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

function normalizeAnchor(s) {
  return String(s || "").replace(/[\s.()（）、,，]/g, "").toLowerCase();
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
  return { width: page.width, height: page.height, words };
}

async function callClaude(model, maxTokens, images, prompt, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
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
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
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

// Re-sends only the still-unsure items to `model`, using a zoomed-in crop
// around each one's own position (falling back to the whole page if
// cropping isn't possible) rather than the whole page again -- same idea as
// a parent pinch-zooming a photo to read messy handwriting. Returns the
// list of items still unresolved afterward, for a possible further tier.
async function recheckPass(parsed, unsure, images, apiKey, model, maxTokens, usage, usageKey, photonCache) {
  let cropImages = [];
  try {
    const built = await buildCrops(unsure, images, photonCache);
    cropImages = built.cropImages;
  } catch (e) {
    cropImages = [];
  }
  const useCrops = cropImages.length === unsure.length;
  const recheckImages = useCrops ? cropImages : images;
  const listText = useCrops
    ? unsure.map((r, i) => `圖${i + 1}：第${r.page + 1}頁，題號「${r.question}」嘅放大近鏡`).join('、')
    : unsure.map((r) => `第${r.page + 1}頁，題號「${r.question}」`).join('、');

  const recheckPrompt = `你是一位細心的小學老師。另一位老師已經批改咗呢份功課嘅大部分題目，但以下題目佢睇唔清楚學生寫嘅答案，需要你用更仔細嘅眼光再睇一次：
${listText}

${useCrops ? '每張圖係一條題目答案位置嘅放大近鏡相，方便你睇清楚啲字。留意有啲字可能潦草或者被擦改過，如果單睇一個字睇唔出，試吓連埋前後字一齊估係咪一個詞語，唔好淨係逐粒字咁樣睇。' : ''}

呢份功課冇標準答案，請你自己諗清楚每一題應該點答，再判斷學生手寫嘅答案。

只需要回覆上面列出嘅題目，按${useCrops ? '圖片次序' : '題號'}回覆，要求：
1. 盡量仔細判斷。如果答題位置完全空白、冇任何筆跡，"correct" 設為 false，"note" 填「未作答」。
2. 只有答題位置確實有筆跡、但寫得太潦草無法判斷寫嘅係咩，先設 "correct" 為 null。
3. 只有 "correct" 係 false 先填 "correctAnswer"，其他情況留空。"note" 最多四個字，答對可留空。
4. 只回覆JSON，不要其他文字：
{"results":[{"question":"題號","page":0,"correct":true/false/null,"correctAnswer":"","note":""}]}`;

  try {
    const rc = await callClaude(model, maxTokens, recheckImages, recheckPrompt, apiKey);
    usage[usageKey] = rc.usage;
    const byKey = new Map((rc.parsed.results || []).map((r) => [`${r.page}:${r.question}`, r]));
    parsed.results = (parsed.results || []).map((r) => {
      const updated = byKey.get(`${r.page}:${r.question}`);
      return updated && r.correct === null ? { ...r, correct: updated.correct, correctAnswer: updated.correctAnswer || '', note: updated.note, studentAnswer: updated.studentAnswer || r.studentAnswer } : r;
    });
  } catch (e) {
    // A recheck tier failing shouldn't sink the whole response -- whatever
    // was still null just stays null and falls through to the next tier
    // (or to the human-confirm "?" in the UI if this was the last one).
  }
  return parsed.results.filter((r) => r.correct === null);
}

// Crops a zoomed-in close-up around each unsure item's bbox (falling back
// to the whole page if a given item has no bbox), for the Opus recheck pass.
// Uses Photon (a WASM image library bundled specifically for Workers) --
// verified locally with a real photo before wiring in: crop(image, x1, y1,
// x2, y2) in pixel coordinates, confirmed against the library's own source.
//
// `photonCache` (page index -> decoded PhotonImage) is owned by the caller
// (handleCheck), not this function -- it's shared across both the
// sonnet-zoom and opus tiers so a page already decoded for tier 1 isn't
// decoded from JPEG bytes a second time if it's still unsure in tier 2.
// The caller is responsible for calling .free() on every cached image once
// all tiers are done.
async function buildCrops(unsure, images, photonCache) {
  const cropImages = [];
  const cropLabels = [];
  for (const r of unsure) {
    cropImages.push(cropItem(r, images, photonCache));
    cropLabels.push(`page ${r.page} ${r.question}`);
  }
  return { cropImages, cropLabels };
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
