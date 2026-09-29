# hk-homework-check — 問題整理同工作清單

**2026-09-30起：呢個檔案淨係留返仲未完成嘅嘢。** 已完成嘅ticket一律即刻搬去TICKETS_ARCHIVE.md（用戶明確指示「即刻做完即刻搬」）。舊有嘅完整歷史（2026-09-22至2026-09-30，Wayfinder地圖、工作清單、逐日記錄）已經原封不動全部搬咗去TICKETS_ARCHIVE.md底部，一字不改。**想知道「而家個project真正狀態係點」，一律查code，唔好淨係睇呢個檔案（包括archive）嘅✅/🔲標記——今晚已經證實舊清單有真實錯誤例子（鐘面讀時間、Ticket 210都係話未做但實際已做咗）。**

## 未完成嘅嘢（🔲 = 未做，⏸ = 做咗但未wire，⚪ = 已決定唔使再諗）

- 🔲 **207. 長除法多個散開嘅缺格填空** — 真citation搵到咗(math34pdf/p14.png Q5),但要新增一個結構化OCR marker先解析到條直式嘅版位,會改動production嘅OCR prompt,風險/範圍都大過209,未動手。
- 🔲 **41. 診斷route管理** — 今晚起碼8-9個臨時診斷route要人手記得刪,未做結構性改進。

217-219、209、18、28已完成並push，詳情見TICKETS_ARCHIVE.md。**210查證咗其實老早已經做咗**(commit `ee3757e`,`cjk_parallel_lines_mc`/`latin_parallel_lines_count`)——舊嘅🔲標記本身就係錯嘅,已經喺TICKETS_ARCHIVE.md補返正確記錄。
