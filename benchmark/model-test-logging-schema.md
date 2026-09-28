# AI Model比較測試 - 數據記錄格式 (2026-09-28設計)

## 目的
之前測試出現過2次因為冇記錄夠細節而浪費時間嘅教訓:
1. 排隊問題(60個call同時fire,timing被誤讀做「越嚟越慢」) — 冇分開記錄「單個call」定「batch入面第幾個」
2. max_tokens唔夠燒晒budget(GPT-5/DeepSeek R1都中過) — 冇記錄`finish_reason`,睇唔出係咪truncate咗

呢個schema專登針對呢2個教訓設計,確保下次唔使再撞板。

## 每條題目要記錄嘅原始數據(raw data)

| 欄位 | 例子 | 用途 |
|------|------|------|
| test_run_id | 20260929_gemini31fl_run1 | 分辨邊次測試 |
| model_id | google/gemini-3.1-flash-lite | 邊個model |
| model_config | reasoning_effort=low, max_tokens=4000 | 完整重現條件 |
| batch_id | batch_1 (5條一批) | 對應production嘅真實batch shape |
| item_id | 對應19條清單嘅#1-19 | 追蹤返邊條題 |
| category | 貨幣/角度/3D形狀/... | 事後分類分析 |
| ground_truth | 2,1 | 已verified嘅真答案 |
| model_raw_response | 完整原文(包括reasoning部分) | 出錯時可以追查點解錯 |
| model_verdict | correct/incorrect/unsure | 抽出嚟嘅判斷 |
| is_match | true/false | 同ground_truth啱唔啱 |
| finish_reason | stop / length | **必須記錄**——length即係燒晒budget未答完 |
| prompt_tokens | 1832 | 輸入token數 |
| completion_tokens | 512 | 輸出token數(包括reasoning) |
| cost_usd | 0.00612 | 用返實際token數×真實價錢計 |
| call_started_at | 精確timestamp | 分辨「單獨call」定「排緊隊」 |
| call_completed_at | 精確timestamp | 同上 |
| elapsed_ms | 1520 | **淨係喺冇排隊(單一batch call)先可信**,多個batch同時fire嘅數字唔可信 |

## 點樣處理成有用資訊

### 1. 準繩度(accuracy)表 — 每個model一行
model × (總正確率, 逐類別正確率) — 等我哋知邊個model係邊類題目特別弱(例如:GPT-5-nano可能貨幣得,幾何唔得)

### 2. 成本效益(cost-efficiency)表
每個model嘅 (總成本 / 答啱條數) — 呢個先係真正有意思嘅數,唔係淨係睇「平」,平但錯得多都係嘥錢

### 3. 速度(realistic latency)
**規則:淨係用「單一batch call,冇同時開第二個call」量到嘅時間先可信**,唔可以攞多個batch平行嘅raw elapsed_ms直接比較(呢個正正係之前中過嘅陷阱)

### 4. 可靠性(reliability)
- Truncation率 = finish_reason="length"嘅次數 / 總call數 — 之前DeepSeek R1呢個數字係77%,好誇張
- 讓路率(decline rate) = model_verdict="unsure"嘅比例 — 情願老實講唔知好過肓答

### 5. 總結表(俾用戶睇嘅最終版本)
每個model一行:準繩度% | 成本效益($/答啱條) | 真實速度(秒/batch) | 讓路率% | Truncation率%
——一眼睇晒邊個model「又準又快又平又可靠」

### 6. 交叉分析(cross analysis)
題目類別 × model — 邊類題目所有model都做唔到(可能要留返比人手/更貴model);邊類題目平模型都做得好(可以放心用平嘅)
