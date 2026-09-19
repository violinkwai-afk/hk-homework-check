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
import { PhotonImage, crop, rotate } from "@cf-wasm/photon/workerd";

// Client now sends one /api/check call PER PAGE (see website/index.html), so
// this counts pages, not submissions -- a single 5-page homework already
// spends 5 of these. 15 meant just 3 real five-page submissions per hour
// before every subsequent page started failing with "短時間內請求太多",
// which is easy to mistake for a generic error during real testing.
const CHECK_RATE_LIMIT = 40; // max /api/check calls per IP per hour
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
    if (url.pathname === "/api/verify" && request.method === "POST") {
      return handleVerify(request, env);
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
      await env.RATE_LIMIT_KV.put("idem:" + String(demoRequestId).slice(0, 100), JSON.stringify(finalResult), { expirationTtl: 3600 });
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
2. 答題位置完全空白、無筆跡，"correct" 設為 false，"note" 填「未作答」。
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

  let parsed;
  const usage = { sonnet: null, sonnetZoom: null, opus: null };
  try {
    // Reverted from "medium" effort after a live report of confidently-wrong
    // grading on trivial, unambiguous arithmetic (10+4=14 marked wrong) --
    // exactly the accuracy risk flagged when "medium" was first tried, now
    // confirmed for real. Accuracy is the one non-negotiable requirement
    // here ("一定要準確"); the latency this bought back is not worth trading
    // against it. max_tokens 8192 (up from the original 4096) is kept --
    // that only prevents truncation, it doesn't reduce reasoning depth.
    const r = await callClaude("claude-sonnet-5", 8192, images.concat(exemplars), prompt, apiKey);
    parsed = r.parsed;
    usage.sonnet = r.usage;
    (parsed.results || []).forEach(fixSelfContradiction);
  } catch (e) {
    return json({ error: e.kind || "upstream_error", message: e.uiMessage, detail: e.detail }, e.status || 502);
  }

  // Position refinement runs BEFORE the recheck (not after) so that if we
  // need to crop a zoomed-in close-up for the recheck pass below, the crop
  // is centered on OCR's precise position rather than the model's own
  // rougher guess -- exactly the cases where that guess is least reliable
  // are the ones about to get rechecked. `images` here is already the
  // rotation-corrected version from above, so this OCR call (and the bbox
  // it produces) is relative to the same upright frame.
  if (visionKey && parsed.results && parsed.results.length) {
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
  // answer was right. Items this pass isn't confident about (null, or
  // riskyDiagram-tagged) are marked "verifiedBy: pending" and listed in
  // `needsVerify` below instead of being resolved inline.
  (parsed.results || []).forEach((r) => {
    r.verifiedBy = (r.correct === null || r.riskyDiagram === true) ? "pending" : "sonnet";
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
  console.log(JSON.stringify({ event: "check_usage", pages: images.length, usage, ocrUsed: !!visionKey, verifiedByCounts, elapsedMs: Date.now() - startedAt }));
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
  if (!env.ANTHROPIC_API_KEY) return json({ patches: [] }, 200);
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
