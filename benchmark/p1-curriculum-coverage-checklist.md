# 小一(P1)課程涵蓋checklist — 中英數

Started 2026-10-01。目的：有系統噉對比「HK EDB官方課程大綱/真實教材單元」同「而家code/Jev/AI-fallback實際做唔做到」，唔好淨係靠直覺估。

**老實披露**：呢份文件嘅「✅已有handler」欄位,好多係靠handler個名/舊有real citation推斷,**未必逐個都用真實P1相片驗證過**——P1題目通常好簡單,好大機會generic嘅`math_equation`/`computation_mc`呢類catch-all已經做到,但未實測前唔應該當100%confirm。英文部分就係用返呢個project已經真係驗證過嘅真實workbook(大部分係P2/P3,非純P1,已標明)。中文——**完全未開始，0%**，呢個project到目前為止淨係做咗英文同數學嘅判斷邏輯。

## 數學 (Math) — 對照HK EDB 2017課程大綱 + KooBits P1單元

| 主題 | 官方/教材來源 | 狀態 | 備註 |
|---|---|---|---|
| 位置 (Position) | KooBits | 🟡部分 | `facing_direction_query`/`location_grid_query`存在,但原本係為P2/P3「方位圖」題設計,未驗證純P1「上下左右」淺題 |
| 20以內嘅數(認識/順倒數/序數基數/奇偶) | EDB 2017 | 🟡推斷 | 太淺,應該generic嘅`math_equation`/`sort_numbers`已夠,未用真P1相驗證 |
| 數嘅分和合 | KooBits | 🟡推斷 | `open_decomposition`存在但原本為複雜拆解題設計 |
| 長度和距離(直觀比較/自訂單位) | EDB 2017 / KooBits | 🟡部分 | `distance_ranking`/`object_heights`存在,但呢啲係已經要讀數字嘅題,P1「用鉛筆量」呢類直觀比較未必做到(要識別圖形,非純數字) |
| 基本加法/減法(18以內口算) | EDB 2017 | ✅(推斷) | generic `math_equation`/`computation_mc`應該做到,但未用真P1相確認 |
| 基本乘法(0-10乘法表) | EDB 2017 | ✅(推斷) | generic handlers應該做到 |
| 時間 | KooBits | ✅已驗證(但非純P1) | `clock_reading`/`clock_options_mc`/`second_hand_clock`/`textual_clock_description`——呢批真citation大多數源自P2/P3教材,P1淺題(例如「依家幾點」淺鐘面)未單獨驗證 |
| 數數方法 | KooBits | 🟡推斷 | generic |
| 100以內嘅數 | KooBits | 🟡推斷 | generic |
| 分類方法 | KooBits | ❌未搵到對應handler | 可能要新code,未見過真citation |
| 平面圖形(點/直線/曲線/三邊四邊五邊六邊形/圓形基本認識) | EDB 2017 | 🟡部分 | `shape_classification_grid`/`triangle_subtype_letter`存在但原本係P3+「分類判斷」複雜題,P1「認識基本形狀」淺題未驗證 |
| 立體圖形 | KooBits | 🟡部分 | `reverse_shape_from_face_properties`存在但係P3+複雜反推題 |
| 日期 | KooBits | ✅已驗證(但非純P1) | `calendar_grid_query`/`weekday_offset`/`yesterday_tomorrow_shift`,真citation源自P2/P3 |
| 香港嘅硬幣 | KooBits | ✅已驗證(但非純P1) | `coin_blanks`/`coin_exchange_ratio`/`price_*`,真citation源自P2/P3 |
| 加減應用題 | KooBits | ✅(部分) | `word_problem_total`/`word_problem_difference`等,但呢批原本為P3+文字題設計,P1淺應用題(1-2步,20以內)未單獨驗證 |
| 厘米 | KooBits | 🟡推斷 | generic量度 |

**數學結論**：119個已有handler入面，大部分原本係為P2-P6難度設計(呢個project嘅真實相片來源偏向P2-P3)。**P1真正做過嘅real citation測試幾乎冇**——呢個係一個真gap,唔係「做唔到」,而係「未驗證過淺題格式係咪一樣work」。

## 英文 (English) — 對照真實已測試嘅workbook單元(非官方大綱，因為EDB英文課程大綱唔係以離散topic列出)

| 單元/題型 | 來源 | Level | 狀態 |
|---|---|---|---|
| Prepositions of time (on/in/at/from...to) | 真worksheet | P2/P3 | ✅已驗證(2026-10-01) |
| Question words (When/What) + 字砌問句 | 真worksheet | P2/P3 | 🟡部分(MC做到,字砌問句code未做) |
| Modals (can/can't) | 真worksheet | P2/P3 | 🟡部分(字砌句未code化,睇圖題要vision) |
| Linking words (and/but/or) | 真worksheet | P2/P3 | ✅填充題已驗證；句子合併rewrite未code化 |
| 動詞變化(verb conjugation) | 真worksheet | P2/P3 | ✅已驗證 |
| "want to"+word bank配詞 | 真worksheet | P2/P3 | ❌評估為唔code得 |
| 完整句子閱讀理解評分準則 | 真教材 | 未知 | ✅已加入AI-fallback prompt |
| Crossword | 真考試 | P2 | 🟡演算法已有,OCR擷取未接 |
| 基礎詞彙(顏色/身體部位/家人/數字) | 未測試 | P1 | ❌完全未搵過真citation |
| 基本句型(I am.../This is.../簡單現在式) | 未測試 | P1 | ❌完全未搵過真citation |

**英文結論**：已驗證嘅全部真citation都源自P2/P3嘅worksheet(呢個project收到嘅真實相片入面，暫時未見過純P1程度嘅)。P1專屬嘅基礎詞彙/句型，呢個project**完全未見過真實P1相片**，所以冇得驗證。

## 中文 (Chinese)

**0%——完全未開始。** 查`project_hk_homework_check_chinese_english_verifier_design.md`(memory)確認：中文verifier淨係有設計plan，未寫過任何實際code。冇任何中文handler，冇任何中文真citation測試過。

## 建議嘅下一步(排優先次序)

1. **先掃描inbox現有嘅200幾張真實相片**，計實際收到過幾多張係P1程度(而唔係假設大綱)——可能呢個project根本冇收到幾多真P1相，咁樣投資喺P1專屬code可能唔抵
2. 如果P1相真係多，先補做**淺題嘅real citation測試**(用返今日established嘅流程)，確認generic handler做唔做到P1淺題，唔好靠名推斷
3. 中文——如果要開始，建議由揀1-2張真中文P1/P2相做起，唔好一開始就追求全大綱覆蓋
