# hk-homework-check — 已完成Ticket封存

跟返2026-09-30嘅指示：「Everytime you completed a job, mark the relevant
ticket and archive it, immediately」——每次做完一個ticket，即刻由
TICKETS.md搬過嚟呢度，內容原封不動。TICKETS.md淨係留返未做嘅
(🔲/⏸/⚪)。

## 2026年9月30號：Code review + Challenge all（code-review-2axis / challenge-all，非explanation功能）

用戶明確要求：對今日已完成嘅wrong-answer-explanation功能同BLUEPRINT.md決定做code review + challenge all，搵到嘅嘢（題目解釋本身除外）逐個處理。

- ✅ **217. 修好`website/index.html`一個未經處理嘅`innerHTML`風險（XSS-shaped）。** correctAnswer直接插入HTML字串再用`innerHTML`顯示——對AI-fallback判斷嘅題嚟講，呢個值嚟自Gemini自己嘅輸出，冇經過sanitize。加咗`escapeHtml()`，喺唯一一個真正嘅插入位用返佢。
- ✅ **218. Rate limit改用per-browser client id，唔再淨係靠IP。** 淨IP做key嘅話，學校/屋企共用IP嘅真實用戶會被谷埋一齊、誤中rate limit——用戶越多呢個問題越差。網站而家會send一個永遠都有、同私隱冇關嘅random id（`X-Client-Id` header），伺服器優先用呢個做key，冇嘅話先fallback番IP（`/api/mark`、`/api/check`、`/api/verify`三個endpoint都做咗）。
- ✅ **219. 修窄咗`/api/mark`去重機制嘅race condition。** 之前個「check完先write」做法，成個批改流程(幾秒)都算入window入面——而家一check完就即刻寫一個「pending」claim，將window由「成個pipeline」縮到「一次KV讀寫」咁短。KV冇compare-and-swap，所以呢個係縮窄唔係徹底解決；撞到pending claim嘅request會照常處理(fail-open)，唔會卡住。

7個新test，834/834測試通過，`wrangler deploy --dry-run`確認打包正常。已push（commit 42d99d2），已生效。

- ⚪ **220（用戶決定唔做）**：AI-fallback嗰個note wiring改動冇獨立test直接覆蓋。
- ⚪ **221（用戶決定唔做）**：129個handler入面124個未有explanation，建議用「按運算類型共用樣板」做。

## 2026年9月30號：Show correct answers for wrong items in the normal Telegram flow

- ✅ **（Ticket 1，正確答案顯示）** 每題wrong item嘅correctAnswer已經全部計好，但之前淨係喺CPU-guard文字fallback path先會顯示——而家正常嘅annotated-photo path都會send埋一個follow-up文字訊息列出邊題錯+啱嘅答案。5個新test，808/808測試通過，已push（commit 810e180）。

## 2026年9月30號：AI fallback + code handler explanation（首批5個handler）

- ✅ **（Ticket 2/3，AI fallback + code解釋首批）** AI-fallback（Gemini）prompt擴展到連錯因都答，零新增call。Code-verified嗰邊，`verifyMath`（含trySubstituteBlank/verifyDivisionRemainder）、`verifyWordProblemTotal`、`verifyPriceTableLookup`、`verifyDigitCountOfNPlusOne`、`verifyCompoundUnitConversion`五個handler加咗explanation欄位。13個新test，831/831測試通過，已push（commit 2d4c285）。**未做**：網站前端未render呢個note欄位（用戶其後要求呢部分暫停，見TICKETS.md 220/221）。
