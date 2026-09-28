# hk-homework-check — 問題整理同工作清單

2026年9月22號整理，2026年9月23號夜晚再更新（一輪真相測試、push咗兩批嘢之後嘅最新狀態)。同BLUEPRINT.md（總覽果份）一齊睇。每一樣都真係查返個project嘅實際狀態,唔係靠記憶估嘅。

## 🗺️ Wayfinder地圖（用返呢個file做輕量tracker，2026-09-23）

用嚟追蹤「呢個project幾時先算完成」呢個大問題入面，逐條仲未決定嘅細問題。淨係一個人做，所以冇用正式GitHub Issues，靠呢個部分做index。

### 終點（Destination）

*（未定——第一round grilling問緊緊你）*

### Notes

- 用中文（唔好jargon）同用戶（你）溝通，技術細節留喺code comment/呢個file
- 每次搵到新題型，記錄落benchmark/question-type-library.md，盡量寫code解決
- 淨係喺真係structural blocker（例如冇OCR field、畫畫答案）先擺低唔做，唔可以純粹因為「麻煩」就唔做
- 用AI判斷有真銀錢成本——呢個係lever（諗辦法慳錢），唔係擋你唔做嘅理由

### 已經決定咗（Decisions so far）

*（未有——等第一條ticket解決咗先開始記錄）*

### 仲未夠sharp,未做到ticket（Not yet specified）

- 「答晒所有題」究竟包唔包AI判斷嘅題（作文、開放式問題）？
- 邊啲類型係真係structural做唔到（例如畫畫答案），要點樣正式記錄低「呢個真係out of scope」？
- Tier V/J（要用AI睇相/判斷）幾時開始起，定係淨係停留喺Tier A（code直接計）？

### Out of scope（暫時未有，定咗終點先知）

---

## 邊啲問題要處理，分咗類

### 🔴 急、要盡快決定

- **B3. Telegram bot——已經接駁咗,但仲差一步confirm。** 9月23號夜晚：新bot（@Hk_homework_checker_bot）嘅token已經confirm有效（用Telegram官方`getMe`測過），`setWebhook`都已經撳咗,Telegram官方確認"Webhook was set",同`getWebhookInfo`都見到個網址已經登記好。**唯一未confirm嘅一步**：Cloudflare入面`TELEGRAM_BOT_TOKEN`呢個secret,你之前set嗰個可能係第一次嗰條（已知失效)，唔係後尾send俾我、真正work嗰條(...W9cpU結尾)——麻煩你去Cloudflare confirm一下`TELEGRAM_BOT_TOKEN`係咪已經改咗做新嗰條,唔啱就要重新set過。
- **B4. 分數計算,個判斷邏輯可能未識處理。** 睇20份卷嗰陣搵到,P3-P6好常見分數題,但未confirm`verifyMath`識唔識計——建議先寫test確認,先決定要唔要補。
- **B6. hk-maths同hk-homework-check而家用緊同一條Anthropic key（Cloudflare入面個名"Nn"），改一邊會影響埋另一邊。** 建議開多一條獨立key。呢個涉及真錢/密碼,要你話事點做（我開,定你自己開好交低俾我)。

- **B10（新，9月23號，真bot測試搵到並已修好、已push）：一行有多過一個空格嘅數列題（例如"數2字數到20"咁,一次過5個空格),AI會將啲答案用分號連做一條("4;8;12;14;18"),舊code淨係識一個空格,搵到即刻改好，仲搵埋一個相關嘅「撞規則」問題一齊修，已經push咗。**

- **B7. AI讀「打橫影」或者複雜嘅相,有機會讀到亂晒,唔停咁重複同一堆字。** 真實例子（9月23號用真相試出嚟）：一張拼字（spelling）練習簿嘅相,打橫影,AI讀出嚟嘅答案變咗一堆重複晒嘅英文字,完全冇意義。好彩因為答案太長,系統自動當咗「唔肯定,要人睇」,冇當正常答案影響分數——但呢個唔可以話冇風險。4張真相入面2張都失敗（1張撞15秒上限,1張3秒內出錯）。**你已經話「記低,遲啲先傾」——擺低等你話幾時再拎出嚟。**

### ✅ 今日已經解決（9月23號，仲未push）

- **B9（已解決，已push）：「3個數加埋」呢種題型，你話咗「照改，唔使理超過2個數就唔准估嗰條舊規則」，已經改好、寫咗test、確認咗push咗。** 「加埋等於總數」而家識2個或以上嘅數字加埋（例如「42張藍色椅、36張紅色椅、15張黃色椅,共有___張椅子」=42+36+15）。**已知風險（你已經知道、接受咗）**：如果句子入面有第3個唔應該加埋嘅數字（例如混咗第2條題嘅數字），有機會加錯——冇額外保護,純粹信句子入面嘅數字都係要加嘅。
- **code review搵到3個問題，已經全部改好、加咗test、251個test全部過**（詳細見`docs/review-2026-09-23-verifier-batch.md`）：
  1. 學生答案嘅負號之前會被靜靜哋剝走（例如答"-5"會當"5"），已經整咗個共用function `parseSignedStudentNumber`修好晒11個function。
  2. 「9999後面個數有幾多位」呢個type,detect嘅條件之前太鬆(兩個關鍵字分開check),已經改做一個連埋一齊嘅pattern,唔會再撞到唔相關嘅題目。
- **讀晒剩低224頁PDF（4組背景工作全部完成）**——搵到大約120個新題型/發現,已經全部合併落`benchmark/question-type-library.md`。
- **排序題唔識分數/帶分數——真bug,已修好。** 例如「37/5、7又7/9、7又2/3由小至大排列」,之前個邏輯會將呢啲拆到亂晒,而家啱返晒。
- **四則運算冇括號支援——真gap,已補。** 例如「(114+58)-(44+38)=」之前計唔到,而家識計。
- **3種新題型已寫好code,已駁落用緊嗰套**：「入五除四」嘅最少需要幾多嘅word problem（如「最少需要幾多輛的士」)、「9999後面個數有幾多位」、長度單位換算（如「8m 11cm=___cm」)。
- **「砌最大細數字」已經駁埋用（原本以為未夠OCR證據,但直接搵返真試卷睇真文字,寫返個detect(),真測試confirm啱)。**
- 新加多2種：「寫出某數所有因數」、「100以內有幾多個質數」——都係好簡單嘅純計數,已駁落用。
- 「揀兩個數加埋等於target」——真測試發現原來已經有得計（靠現有嘅基本計數功能),但有個細gap未補（見上面🟢新增嗰項)。
- **再新加4種（凌晨繼續跟開嗰項「搵到新題型就試住寫code」）**：計時間相差（例如「10:32am到1:32pm一共幾多小時」)、由餘數反推除數（例如「750÷?=16…14,?係幾多」)、兩個倍數相差（例如「17嘅第十一個同第十七個倍數相差幾多」)、四捨五入去百位。
- 241個test全部過,仲未push。

### ✅ 之前已經解決/已經push咗

- **B0. 成套「判斷邏輯庫」dispatcher改動** ——已push,已confirm成功上線。
- **B1. 減數計錯bug** ——已一齊push,已生效。
- **B2. Railway proxy「大相會卡住」問題** ——已經用真相confirm：唔會再卡死（4張真相全部16秒內有反應,冇一張永遠冇反應)。原本嗰個problem已經用另一方法（縮圖+計時器）解決咗,唔使再接駁Railway個細程式。（新搵到嘅唔同問題，見B7）
- **B5. 「填格仔乘數」新題型** ——已查清楚根本原因：OCR讀完之後同普通直式計數嘅文字一模一樣,**根本冇資訊可以分辨**,唔係「未解決」。要有新嘅真實OCR證據先有得諗。
- **B8. 測試期間唔用Sonnet/Opus（因為太貴）** ——hk-homework-check已經做咗、已push、已confirm生效。hk-maths你已經話「暫時擱置,唔理佢」——冇特登整壞,淨係唔會再用/再試,留返你話幾時先再搞。
- **G1. 版本記錄** ——已做完、已push、已confirm真係work（撳`/health`見到真正版本編號)。以後想知而家行緊邊個版本,唔使再人手對時間。
- **G2. 新嘅題型判斷駁咗落用戶用緊嗰條路** ——已完全生效,182個test過。
- **網頁版「AI答錯咗」報料** ——已查清楚原來以前完全冇真正report返俾我（淨係阿爸阿媽自己部電話反轉個標記,冇send嘢出嚟)。已經整好一個真正嘅report功能,阿爸阿媽撳一撳個標記,而家真係會send返俾我知,已push生效。**Telegram bot版你已經話唔使加。**
- **「批改緊,請稍等」提示 + 「肯定啱／唔肯定要人睇」分開顯示** ——已做,已push。

### 🟡 真係有缺口,唔急但唔可以唔記得

- **G3. 中英文答案啱唔啱嘅判斷仲未起。** 設計已經寫好,建議先做「喺文章入面揀答案」呢種（唔使用AI都計得到,平），再處理開放式問題（要AI判斷,貴啲、風險高啲)。已喺真實英文卷度搵到岩啱做第一個試驗嘅真例子（"Fast Food"閱讀理解)。
- **G4. 有幾種「睇圖」題型,部分做唔到：**
  - 度鐘面——技術上做唔到（工具冇「認到一條條線」嘅功能）
  - 用尺度嘢——估計都做唔到,已搵到真實例子可以將來試
  - 魚長度比較——得,已經做到
  - 算盤讀數——Python試過準（5條柱全中),但未port去production真正用緊嗰套工具（Photon）
- **G6. 冇獨立嘅測試環境**,同正式環境、同另一個project（hk-maths）共用晒啲密碼/設定（同B6一齊諗)。
- **G7. 38種新/確認咗嘅題型,絕大部分仲係「搵到」階段。** 包括：砌最大/最細N位數、經過幾耐時間、電子鐘讀數、方向感、立體圖形、圖表數嘢、直尺讀數(有真例子)、同音字揀、揀幾個數加埋等於目標、質數/因數分類、LCM/GCD、代數代入、幾何拼圖、日曆表閱讀、羅盤方向。詳細全部喺`benchmark/question-type-library.md`。
- **G8. Life in the UK個project（另一個project,唔係呢個),用緊一個叫Resend嘅email服務,但佢自己嘅CLAUDE.md完全冇提過。** 同呢個project冇直接關係,順便記低。

### 🟢 細嘢,唔急（新增，9月23號真測試搵到）

- **「揀兩個數加埋等於target」類題目——而家靠基本math_equation都計啱,但冇check揀嘅數係咪真係俾定嗰組入面嘅。** 真測試發現：學生寫「6+4=10」(真係俾定嘅6,9,4揀返6,4)會啱,但寫「3+7=10」（3,7根本唔係俾定嗰組）都一樣會話啱——因為淨係check條式計唔計得掂。細gap,唔急,但記低。

### 🟢 細嘢,唔急（詳細見project_hk_homework_check_code_notes.md）

- 用緊嘅AI模型名,寫死咗喺兩個唔同地方,將來換模型要記得兩處都改
- 相片壓縮永遠用最慢最靚嗰種方法,未試過快啲嘅
- 出錯標記淨係識畫交叉,唔識畫剔
- 用咗幾多錢/幾多token呢啲資料,淨係喺伺服器log度先睇得到,冇即時顯示——**用戶已經話想要（9月23號)：每次send相俾bot,想response入面就直接見到用咗幾耐時間、幾多錢**

### ⚪ 已經決定咗嘅嘢,唔使再拎返出嚟諗

- 一條題目入面有多過一個空格要填嘅情況——決定咗遲啲先做
- 複雜長除法排位有時會亂咗次序,呢個已知問題冇試過修
- 幾個曾經試過但拒絕咗嘅AI模型（DeepSeek V4.1 Flash等），全部都有真實benchmark（做過真實測試）證明唔夠好,冇新證據唔使再試
- 填格仔乘數新題型（B5）——冇資訊可以分辨,唔使再諗,除非有新OCR證據
- hk-maths暫時擱置,唔用Sonnet/Opus——留返你話幾時先再搞

## 工作清單

狀態：✅完成（已經正式生效）· 🟨做咗但未生效 · 🔲未開始

### 核心批改功能

- ✅ 分開「快速檢查」同「詳細verify」兩步
- ✅ 相片歪咗會自動較正
- ✅ 逐頁OCR（睇字）、限流（每小時40次、每次5頁）
- ✅ 加減數、餘數、填空題嘅判斷
- ✅ OCR前相片會先壓縮——真係量過,快咗,又冇影響準確度
- ✅ 成套「判斷邏輯庫」已經正式駁埋,已push,已生效
- ✅ 減數bug已修好,已push,已生效
- ✅ 測試期間唔再用Sonnet/Opus,已push,已生效
- 🔲 分數計算識唔識做,要confirm（見B4）
- 🔲 一題多個空格嘅情況（已經決定遲啲做）
- 🔲 複雜長除法排位亂咗次序嘅問題
- 🔲 打橫影/複雜相OCR讀到亂嘅問題（見B7,記低咗遲啲傾）

### 新題型

- ✅ 數字文字互轉判斷、大於細於符號判斷——已經接駁落用戶用緊嗰條路,已push
- ✅ 缺格直式計數（2□9+32=□9□類)——已接駁,已push
- ⚪ 填格仔乘數（634×2分開幾格)——已查清楚冇資訊可以分辨,唔算未解決
- 🔲 「邊條魚長啲」呢類睇圖比較題——技術上得,未接駁落主程式
- 🔲 睇鐘面答時間——技術上做唔到,要換方法先得
- 🔲 用尺量嘢——未試過,估計都做唔到
- 🟨 **算盤讀數（2026-09-26重新查證，之前記錄過時）——Photon port其實已經做咗（5/5準確），但未通用化+未接落判斷系統。** 真實現狀：`benchmark/photon-prototypes/abacus-reader.js`已經有5/5準確嘅Photon版本，但(a)算盤條數位置寫死喺code入面，未做到自動認任何一張相嘅條數位置；(b)`classifyAndVerify`（而家嘅判斷系統）淨係睇AI讀到嘅文字，冇接觸相片本身，算盤讀珠仔呢類「要睇緊張相先計到」嘅題型冇辦法直接接落去。真正瓶頸係(b)，見第22項。
- 🟨 **第22項Stage A完成：起咗通用嘅「睇相」基建，`493965a`已push，334/334測試。** 調返咗判斷流程次序（而家先計位置、後判斷，等判斷可以攞到相），加咗`verifyVisual`呢種新handler類型，用返而家已經有嘅`cropItem`（`/api/check`個zoom recheck已經用緊嘅裁相工具）。**刻意做到通用**，唔係淨係為算盤——鐘面、用尺任何未來嘅視覺題型都用得返同一套。**Stage B未做**：仲未有任何真正嘅視覺handler接落去（算盤都未接），算盤仲要解決埋條數位置通用化嗰個問題先可以真係work。
- 🟨 **38種新搵到嘅題型（見`benchmark/question-type-library.md`，2026-09-26重新查證，之前記錄過時）——比記錄講嘅多好多已經寫咗code。** 查confirm咗`digit_count_of_n_plus_one`、`compound_unit_conversion`、`construct_extreme_number`、`elapsed_time_forward`、`reverse_divisor_from_remainder`呢幾個之前寫低"NOT built"嘅，其實已經寫咗、已經接駁落`classifyAndVerify`。今晚仲加多兩個新嘅：`word_problem_more_than`（「比...多/少」加減關係題）、`number_between`（「寫一個介乎X同Y之間嘅數」）。仍然有一批真係未寫嘅（Multi-box digit answer、Select 2 of 3 sum to target、Classify numbers even/odd/prime from a set、LCM/GCD short division、Algebra substitution、HCF-matching MC等），詳細見question-type-library.md。

### 中英文題判斷（淨係得設計,未起code）

- 🔲 「喺文章入面揀答案」呢種——建議最先做,唔使用AI都計到,唔使錢
- 🔲 配對題點做——要問返你先有答案,唔可以自己作決定
- 🔲 開放式問題要AI判斷——最後先做,最貴、風險最高
- 🔲 同音字揀——可能係closed-form(得幾個選項)

### 基建/營運

- 🟨 部署instructions文件已寫好,未儲落GitHub
- ✅ 版本記錄功能（G1）——已做完,已push,已confirm真係work
- ✅ 測試期間停用Anthropic key（B8,hk-homework-check）——已push生效
- 🔲 Telegram webhook正式註冊（B3）
- 🔲 獨立測試環境,同hk-maths分開(G6)——同B6一齊諗
- 🔲 hk-maths/hk-homework-check共用緊同一條Anthropic key,要分開(B6)
- 🔲 「AI模型watch」呢個功能而家淨係做到7日就要人手重設,想佢自動一直做落去
- ✅ 5個project全部整咗「用緊咩外部服務」嘅清單（`docs/external-dependencies.md`）
- ✅ 搵到問題即刻記入ticket list,分開「即刻做得」同「要傾先」——已經係長期習慣
- ✅ code解決唔到嘅題型,自動有log記低（`mark_unresolved_question`),為咗跟G3/B5呢類問題儲夠一批再分析共通原因

### 網頁/Telegram bot操作體驗

- ✅ 批改緊嗰幾秒有個提示（Telegram)
- ✅ 分清楚「肯定啱」同「唔肯定要人睇」（"?"標記,Telegram)
- ✅ 網頁版「AI答錯咗」報料功能——已整好真正report,已push生效
- ⚪ Telegram版「AI答錯咗」報料——你已話唔使加,唔使再諗

### 長遠（6個月，方向性,未有實際計劃）

- 🔲 真正嘅中英文批改（唔淨係數學）
- 🔲 更多睇圖題型（睇鐘面、用尺呢類要換技術先得）
- 🔲 個網站都轉用返呢一套後台
- 🔲 支援多語言、中學/大學程度——只係方向,冇實際內容,要先問你

---

**建議下一步次序（9月23號夜晚，按「對成品嘅成本/速度/準確度有幾大影響」排先後）：**

1. **G3 中英文判斷完全未起** —— 準確度影響最大：而家淨係識判math,中文/英文題目100%都係「唔識,要人睇」,即係成個功能對呢兩科完全幫唔到手。已有真例子（"Fast Food"閱讀理解）可以做第一個試驗。
2. **B7 打橫/複雜相OCR讀到亂** —— 準確度+速度都有影響,今日真相試先至確認嘅真實風險（雖然而家有安全網冇整壞分數,但撞正嗰15秒上限都係真嘅時間浪費)。你話咗記低遲啲傾,呢個係「遲啲」入面最先做嗰個。
3. **B4 分數計算識唔識做** —— 準確度影響：P3-P6好常見嘅題型,而家未confirm得唔得,隨時有真實缺口未算入去。
4. **G4 睇圖題型（鐘面/用尺/算盤）** —— 準確度/涵蓋面缺口,但範圍比G3窄。
5. **相片壓縮永遠用最慢方法**（細嘢清單入面嗰項）—— 速度影響：已知,但未試過快啲嘅方法,值得盡快驗一驗。
6. B6（分開Anthropic key）、G6（獨立測試環境）—— 呢兩樣係「操作風險」多過直接影響緊使用緊嘅成本/速度/準確度,排後啲都得。
7. B3（Telegram webhook）、G7（38種新題型）—— 呢兩樣同「而家個product好唔好用」關係比較細,排最後。

（呢個排序係按已知證據判斷,冇量到實際準確度跌幅,睇你點揀優先次序。)

## 2026年9月25號 AI準確性rigor check搵到嘅新項目

用真實40張相人手核實baseline之後搵到嘅一批真實問題（詳細數據睇當晚Telegram紀錄）。跟返「凡係問你要唔要做，自行開ticket」呢個新規矩，一個項目一條，用plain number（唔用返舊有嘅B/G字母code），避免漏低。

- ✅ **第1項：OCR prompt加規矩——空白答題位一定要報空白。** `24e2389`已push，314/314測試。**注意**：code已改，但第9項確認真實準繩度仍然未達標，「done」淨係指prompt文字已改，唔代表問題解決咗。
- ✅ **第2項：OCR prompt加規矩——分辨學生原本手寫同老師紅筆改動。** `24e2389`已push，同上，見第9項嘅caveat。
- ✅ **第3項：OCR prompt加規矩——判斷呢頁相係咪真係一份功課。** `24e2389`已push，同上，見第9項嘅caveat。
- 🟨 **第4項：印刷字改用Google Vision做正選，AI做後備（2026-09-25更正，呢個係最終定案，唔係之前寫嘅「AI主答、Vision核對」）——部分完成。** 目標設計：AI負責(1)分題結構(2)讀手寫答案；印刷嘅題目文字直接攞Vision讀到嘅內容用，唔係「夾唔到先執生」。**已做**（`crossCheckPrintedNumbers`）：淨係核對印刷文字入面嘅**數字**——搵到夾唔到就強制標記需要人手覆核，捕捉咗確認過嘅真實bug（40讀成30、11讀成14）。**未做**：中英文/中文內容部分仍然係AI自己讀嘅，冇改用Vision嘅內容——因為Vision讀CJK文字本身都可能有斷句/格式問題，未必一定準過AI，呢部分刻意冇做，要留意呢個仲未達到最初定案嘅完整設計。
- ❌ **第5項：Google Vision數題號捕捉跌漏內容——已於2026-09-26拆走，用戶決定。** 用戶認為Vision本身已經識分邊段字屬於邊條題，唔需要自己pattern-match題號。已提出過一個技術保留（Vision嘅block/paragraph分段係跟版面分，唔係真係識語意上邊條係邊條題），但呢個功能本身淨係log用、冇影響真實判斷結果，risk低，用戶確認拆走，code、log、5個test全部移除咗（`a430f35`），313/313測試通過。舊設計：
  - 先用文字pattern（似「1.」「2)」呢類形狀）搵晒所有候選題號
  - **主要訊號（最強、優先用）：** 候選字係咪企喺同一個X位置**加埋係咪連續遞增**（1,2,3,4...冇跳號）。連續遞增好難巧合，搵到就好有信心
  - **後備訊號（主要訊號搵唔到先用）：** 題號後面有冇明顯空隙（同下一個字有段距離）——呢個訊號唔靠成頁位置對唔對齊，就算題號成頁擺得亂都work
  - 「對齊」呢個訊號本身**改做加分項，唔係必要條件**——對齊到就更加肯定，但一個孤立、冇對齊到嘅候選字唔會自動剔走（避免漏標真係題號，例如老師自己整嘅卷冇規範對齊）
  - **表格陷阱：** 表格自己嘅數據欄都會啱啱好對齊喺一個X位置（例如「數量」欄5,8,12,20），好易被誤判做題號。「連續遞增」呢個主要訊號本身已經解決咗呢個問題——真題號一定1,2,3,4...，普通數據欄唔會咁齊整遞增，唔使開獨立方法處理表格
  - 最後將Vision數到嘅候選題號數，同AI實際交返嘅題數比對——**唔係差1個就話有事，要差夠多（例如2條或以上）先標記做「可能跌漏內容」**，畀返容錯空間俾呢個偵測方法本身唔夠完美嘅情況
- ✅ **第6項：PDF上傳——用戶2026-09-26決定，唔做真正PDF支援，移除呢個選項。** 查到之前Telegram收到PDF/文件（冇相）會完全靜默，已經改咗做即刻回覆「暫時未支援 PDF／文件格式，請影相或者send相片。」（`f797ad7`）。用戶確認呢個就係最終行為，唔再做「轉相/直接讀PDF」呢個方向——PDF明確唔支援，一直清楚咁拒絕，唔會再有進一步計劃。網頁版file input本身已經淨係`accept="image/*"`，冇PDF可以揀，唔使額外改動。
- ⚪ **第7項：Telegram加返跨頁題目偵測（stitching）——2026-09-26用戶決定，網頁版（第8項）優先，呢個押後。** 查到比預期複雜（Telegram本身連「儲埋幾張相」嘅機制都未有），需要獨立設計session，暫時唔做。
- 🔲 **第8項（2026-09-26提升優先）：網頁版（`/api/check`）遷移去「AI讀字→code判斷」呢一套。** 已同你傾好次序：第1-6項嘅prompt/Vision修正做完、再用返同今日一樣嘅方法重新驗證真係準咗，先做呢一步遷移。

## 2026年9月25-26號夜晚：用戶親自核實+新一輪model搜尋

- 🔴 **第9項：用戶親自肉眼核實過第1-3項prompt修正之後嘅Qwen輸出，結論係「錯漏百出，絕對唔可以用」。** 呢個係直接、第一手嘅確認——即係就算加咗第1-3項嘅prompt規矩，準繩度都仲未達標，第8項（網頁遷移）嘅「重新驗證」呢個前提條件仲遠未達到。呢個應該係而家最高優先級——喺呢個問題未解決之前，第8項唔會有真正意義去做。
- ✅ **第10項：GLM-4.6V（Z.ai）rigor check完成，結論——唔用得，比baseline差好多。** 親自逐句核對3張入面嘅2張（第3張因為結論已經好清晰，冇再逐句核）：
  - 相1（中文閱讀理解，5題）：Qwen大致啱（5題入面4-5題合理，有少少字讀錯如「石坑」讀成「石碑」）；GLM 5題入面得1題（Q5）啱，其餘全部錯晒/答非所問（Q1答「一條」冇意思、Q2完全答錯內容、Q3淨係答咗成個複雜答案入面一個字「南門」、Q4答錯咗個MC選項）
  - 相3（英文乘除法填充，6題）：Qwen大致準（有2個可能嘅數字讀錯，例如40讀成30——同之前確認過嘅bug一樣），但成體結構正常；GLM**完全冇拆到題**，成頁6條題全部撈埋做一嚿嘢，仲要`parseFailed`（code識別到呢個係壞data，判斷唔到）
  即係GLM-4.6V呢個candidate測試完，結論明確：**唔可以用嚟代替baseline**，仲差好遠。
- ✅ **第11項：3個新candidate（GLM-5.3-Flash、GPT-6 Luna、Ling-3.0-Flash-VL）全部REJECTED，2026-09-26測試完成。** 用返嗰3張唔睇嘅相，每個model試3次（9次call），結果：**6/9次call直接失敗**——大部分係「incomplete: length」，即係個model用晒自己嘅token budget去「諗」（reasoning），根本冇答到嘢就截斷，同之前已經確認嘅Qwen3.6-flash（reasoning model燒晒budget）嗰個問題模式一模一樣：
  - Ling-3.0-Flash-VL：3次全部失敗（0/3成功）
  - GPT-6 Luna：1/3成功，但成功嗰次都用咗1048個completion tokens入面846個係reasoning（80%）——好唔穩陣
  - GLM-5.3-Flash：2/3成功（三個之中表現最好），但其中一次成功嘅結果都有結構性問題（一個item出現`parseFailed:true`），reasoning tokens都佔咗成功call嘅69%
  真實洗費：3次成功call實際洗咗US$0.0013348（OpenRouter真實usage.cost）。**注意**：另外6次失敗call嘅usage冇被記錄到（因為個測試route喺拋error嗰陣冇讀usage欄），OpenRouter好可能都有就啲已經生成嘅token收費，即係真實總洗費會比呢個數字高少少，但呢個係好細嘅金額，唔會影響到「REJECTED」呢個結論。已移除臨時測試route。
  - **2026-09-26補測：改用「AI自己讀+自己判斷啱唔啱」（同`/api/check`一樣嘅任務），結果唔同咗。** 用返同3張相，跑Qwen(baseline)+3個candidate，12次call：
    - Ling-3.0-Flash-VL：**仍然0/3成功**——唔理係OCR定判斷任務都一樣唔穩陣，確認徹底reject。
    - GLM-5.3-Flash：3/3成功（一次要retry先得），但**冇明顯優勢**——比Qwen慢（平均約19秒 vs Qwen約15秒），同Qwen判斷結果有分歧（例如一張相10題入面有1題判斷同Qwen相反，另一張相拆題方式都唔同）。
    - GPT-6 Luna：3/3成功，其中一張相10題全部同Qwen判斷一致，但另一張相拆題方式完全唔同（Qwen數字題號 vs GPT-6 Luna用a/b/c/d）；速度最慢（平均約23秒），成本亦係4個之中最貴（US$0.0049 for 3次，接近Qwen嘅1.3倍）。
    - 真實洗費（9次成功call）：US$0.01085（Qwen$0.00386 + GLM-5.3-Flash$0.00210 + GPT-6 Luna$0.00489；Ling-3.0-Flash-VL 3次失敗call嘅費用冇被記錄到）。
    - **重要限制**：呢3張相冇獨立核實過嘅正確答案（唔似16張已核實嘅benchmark），所以「同Qwen判斷一唔一致」淨係consistency signal，唔係「邊個啱」嘅證明——冇答案key嘅情況下唔可以話邊個model判斷得啱。
    - **結論：判斷任務入面GLM-5.3-Flash/GPT-6 Luna可以完成，但冇顯示出比而家baseline有任何優勢（更慢、成本相若或更貴、判斷有分歧）——冇理由轉model。** 已移除臨時測試route。
- ⚪ **第12項：訓練自己專屬AI（fine-tune）——已傾清楚，暫時唔做。** 需要遠多過而家有嘅40張已核實例子（通常要成百上千），而家未夠料，建議繼續行prompt修正+試現成model呢兩條路，儲夠真實核實過嘅例子先再諗。

## 2026年9月26號：起「AI判斷code搞唔掂嘅嘢」呢一層

- ✅ **第13項：喺`/api/mark`加咗「AI判斷code搞唔掂」呢一步，`4b1a768`已push，318/318測試通過，2026-09-26真實3頁production測試完成。** 一頁入面所有needs_review嘅題一齊send俾AI（連原張相，唔淨係文字），用返Qwen/DeepSeek兩層。真實3頁測試結果：
  - 相1（5題，中文）：全部由AI解決咗，9.6秒，US$0.00079
  - 相3（6題，數學）：1題code直接解決、1題因為印刷數字唔肯定而正確咁冇送去AI（設計如此）、4題送咗去AI，全部解決，14.9秒，US$0.00072——**有一條真實捕捉咗bug**：第3題OCR讀到學生答案「30;8;5」，AI（睇緊真相）判斷做**錯**，話啱嘅答案應該係「40;8;5」——同之前懷疑嘅「40讀成30」bug完全脗合，證明呢個設計（俾AI睇真相，唔淨係文字）真係有用
  - 相2（10題，英文）：**AI fallback呢頁完全失敗**——10條題一次過問，Qwen（8秒timeout）同DeepSeek（12秒timeout）都爆晒timeout（前後加埋岩岩好係20秒），全部10題維持needs_review，冇改善但都冇變差（fail-safe設計生效，冇亂咁俾錯答案）。**根本原因**：一頁題目太多一次過問，超出咗兩層model嘅timeout。**建議跟進**（未做，要你話事）：一頁題目太多時拆細啲批次去問，或者加長timeout。
  真實總成本（3頁加埋，唔計相2失敗嗰部分冇被記錄嘅費用）：US$0.00198。

## 2026年9月26號：Ticket 13完成後嘅challenge-all + code review

跟返「大改動要challenge-all + code review」呢個規矩，做完之後搵到嘅新問題：

- ❌ **第14項：`verifiedBy: "ai"`同`verifiedBy: "code"`喺UI冇分開顯示——用戶決定唔使做呢個方向。** 用戶明確講法：「家長如果一見到一條係對得唔準確，成個app已經係作廢」——即係分唔分得出邊個判斷嚟自邊度冇意義，家長唔會因為知道「呢個係AI判斷」就接受佢錯，一錯就已經失去信任。真正要解決嘅唔係「標示邊個判斷嚟自邊個來源」，而係「AI判斷本身準唔準」——即係問題根源返返去第9項（Qwen核心準繩度）同第19項（要驗證第13項個AI層真實準唔準）。
- ✅ **第15項：AI-fallback批次上限做5條，多過5條就拆成幾個batch同時（parallel）問。** `7f0285d`已push，316/316測試（新增1個）。真實根據：5題成功3.9秒、4題成功3.2秒、10題兩層model都timeout——樣本細（3個數據點），臨界點唔係精確知道，但5係一個有根據嘅保守cutoff。
- ✅ **第16項：`/api/mark`加咗duplicate/idempotency保護。** `63dddfe`已push，315/315測試（新增2個）。用返相片內容SHA-256 hash，2分鐘內一樣嘅相會直接攞返cache嘅結果，唔會再洗一次錢。
- 🔲 **第17項：Ticket 13嘅fallback prompt直接塞入未經處理嘅OCR印刷文字，理論上有prompt injection風險（已經解釋清楚咗，未做防範）。** 一張刻意整嘅"功課相"如果印刷字度藏住指令，冇防範機制去阻止AI判斷被操控。仲未做。
- 🔲 **第18項：同一頁如果OCR整咗重複題號，Ticket 13嘅merge邏輯淨係用題號做key，兩條唔同題可能錯誤咁攞埋同一個AI判斷。** 需要加返disambiguation（例如用array index代替純題號做key）。
- ✅ **第19項完成：`verifiedBy: "ai"`真實rigor check做咗，結論——同Ticket 9一樣，仍然「錯漏百出」，未解決核心問題。** 用返10張全新真實相（今晚未用過），跑production `/api/mark`，人手逐張直接睇相核實：
  - **相1（三年級數學卷）4條AI判斷嘅題，最少確認咗2條真實錯**：第1題（MC選擇題）學生實際填咗嘅係B，AI讀成C，仲判做啱；第5題（排序題）AI讀到嘅數字「54148」「54188」同張相實際印刷嘅數據（56219/54119/54198）完全對唔上，明顯亂讀。
  - **相2（一年級睇鐘面卷）出現一個自相矛盾嘅結果**：第3題AI話學生答案係「6」，判做**錯**，但「正確答案」都係填「6」——即係AI話學生答案同正確答案一樣，但又判佢錯，邏輯上完全講唔通，merge code冇捕捉到呢種矛盾輸出。呢張相仲要係「睇鐘面」呢類已知未支援嘅題型（見工作清單），代表AI fallback畀咗一個假裝自信嘅錯判斷落一條本身就做唔到嘅題型度。
  結論：**Ticket 13加咗嘅AI判斷層，本質上仲係用緊嗰個已經確認「絕對唔可以用」嘅Qwen（temperature=0都冇解決呢個問題，因為問題唔係random，係讀錯/判斷邏輯本身）。第9項嘅核心問題完全未解決，只係換咗個包裝。** 呢個發現直接支持返用戶今晚提出嘅方向：code能力以外嘅嘢，AI暫時唔應該自己落最終判斷。
- ✅ **第20項：全部AI call加返`temperature: 0`（AI答案random程度設做最低）。** 之前成個code base冇任何一個call設過呢個參數，即係一直用緊AI provider嘅預設值（通常唔係0，即係有隨機性）。呢個係讀字/判斷任務，唔係作文，唔應該有隨機性，減低幻覺（老作嘢）風險嘅其中一個具體、平快嘅做法。已加落`callClaude`、`callOpenRouterVisionModel`（Qwen/DeepSeek/Ticket13 fallback共用）、`callQwenOcrText`三個call嘅地方，313/313測試通過。
- ✅ **第21項：Qwen嘅call都加返排除Alibaba做provider，`2257f0b`已push，313/313測試通過。** 用戶明確因私隱理由要求（唔想小朋友功課相經內地伺服器）。`callQwen`（`providerFilter`）同`callQwenOcrText`（自己個body入面）兩個地方都加咗`{ignore:["Alibaba"]}`，同DeepSeek已有嘅設定睇齊。
- ✅ **第23項：AI model watch搵到嘅4個candidate測試完，真實成本US$0.005666。** 3張唔睇嘅相，OCR-only test：
  - **Gemini 3.1 Flash Lite：3/3成功，內容同已有嘅Qwen baseline脗合度好高**（其中一題「40;8;5」完全脗合，呢條之前有確認過嘅「40讀成30」bug歷史）——**今晚目前為止表現最好嘅新candidate**。發現一個真實format問題：多重答案有時會拆成幾個用返同一個題號嘅獨立item（而唔係跟prompt指示用分號連埋一個item），如果照跟而家「用題號做key」嘅merge邏輯，會靜靜雞跌咗3/4個sub-answer——呢個係prompt跟從度嘅問題，唔係內容準繩度問題，可以修。
  - DeepSeek vision版：0/3，同其他已拒絕嘅model一樣嘅「reasoning燒晒budget」問題，reject。
  - ERNIE 4.5 VL：technically 3/3，但有真實嚴重嘅內容合併問題（一整頁撈埋做一嚿`parseFailed`，仲加埋自己老作嘅中文評論），同GLM-4.6V一樣嘅問題class，reject。
  - Amazon Nova Lite：2/3，1/3都係撞到reasoning budget問題，冇Gemini咁穩，唔繼續跟。
  **建議跟進**：Gemini 3.1 Flash Lite值得再試（judging task test+修format問題），未做。
- ✅ **第24項：Gemini 3.1 Flash Lite再測試，10張相（5張原來得0題嘅唔算真功課），真實成本US$0.008958，仲有直接對真相嘅核實。**
  - **速度**：Gemini每一個可比較嘅真實case都快過Qwen（例如2749ms vs 4083ms、2294ms vs 5659ms）——穩定嘅真實優勢。
  - **成本**：Gemini總成本反而貴過Qwen（$0.005649 vs $0.003309），因為Gemini輸出通常更詳細/題目拆得更細，即使per-token收費平啲，成本都可能更貴。
  - **人手核實真相發現**：一條題度，Qwen確認咗一個真實錯誤（將印刷字「病菌」撈埋落學生答案度，仲跌咗個字，讀成「病菌不在」，正確應該係「無孔不在」）；Gemini讀成「無處不在」都係錯，但冇撈埋印刷字咁離譜，算讀得靠近啲。仲發現Qwen會靜靜雞將印刷嘅繁體字轉做簡體字嚟記錄，Gemini正確保留返繁體——呢個係真實嘅內容忠實度分別。
  - **但Gemini都有兩個真實、已確認嘅結構性bug**：(1) 一頁有兩組題號嘅時候，Gemini會將第二組題號由1重新計，同第一組撞題號——正正就係code review之前提出過嘅「重複題號」風險，而家真係喺真實內容度撞到；(2) 同一張相，Gemini有2條題嘅「印刷題目」同「學生答案」分界錯咗，將印刷句子嘅尾段錯誤塞咗落「學生答案」度，變成一段印刷+手寫溝埋嘅嘢，會令家長誤以為個仔/女寫咗啲佢冇寫過嘅字。
  **結論：Gemini喺讀字忠實度上有真實優勢、速度穩定較快，但唔係一個可以直接取代嘅方案**——兩個結構性bug要先修好，而家個成本仲貴過現用baseline，唔建議而家就轉。
- ✅ **第25項：Gemini 3.1 Flash Lite重測，用戶親自揀6張真功課（中文2/數學2/英文2，親自逐張send，唔係盲抽），真實成本US$0.006765（Qwen $0.002835 + Gemini $0.003930），逐張直接對真相核實。**
  - **速度**：Gemini平均約3.2秒，Qwen平均約4.5秒（重試後）——Gemini再次確認較快。
  - **準確度（6張逐張核實）**：Gemini喺4張（中文選詞填充、英文and/but/or連接句、英文代名詞、中文書信格式）明顯讀得準過Qwen；Qwen喺處理「詞語庫/多空信件/長文章格式」題目時反覆出現結構性錯亂——將詞語庫選項當新題目、漏讀成句手寫答案（8個空全答"?"但學生實際全部填咗）、答案字串入面違規加入"|"符號、多讀/少讀項目數量。Qwen淨係喺數學直式除法（第2張）完勝，因為Gemini嗰次完全冇讀到嘢（0條item）。數學應用題（第3張）兩者數字都啱，Gemini內容更完整（有讀齊印刷全文+完整答句）。
  - **穩定性（兩個模型各撞板一次）**：Qwen第1張第一次call撞25秒timeout，重試先成功；Gemini第2張靜靜雞回覆完全空白（0 items，冇報錯但收咗錢）——呢個空白失敗模式，若真係換入production，理論上會觸發`callQwenOcrText`現有嘅「0 items = 失敗」保護（同而家Qwen共用嗰個guard），但呢次診斷route冇行嗰個guard，未喺production環境實測過，只係code邏輯推斷。
  **結論**：呢6張用戶親自揀嘅樣本入面，Gemini整體表現好過Qwen（4勝1負1打和），比上次10張測試更正面，但兩個模型分別撞過一次真嘅失敗（timeout/空白），都未到100%穩。建議下一步：再測多10-20張，專門盯緊Gemini會唔會重複撞到「靜靜雞空白」呢個問題，先可以放心考慮換baseline。
- ✅ **第26項：用戶決定換Gemini做/api/mark嘅OCR模型 → 真實部署 → 撞板 → 已root cause → 已rollback返Qwen。完整過程：**
  1. 將`callQwenOcrText`用嘅model獨立分做`OCR_TEXT_MODEL`（Gemini），同`PRODUCTION_OCR_MODEL`（Qwen，繼續俾`callQwen`/Ticket13 AI覆核用）分開，冇一齊換，因為判斷啱錯呢個task今次測試從來冇測試過Gemini。
  2. 部署後即刻用真實production `/api/mark`測試，撞到502（完全讀唔到嘢）。用診斷route攞到raw text先發現：Gemini讀緊「25÷5」呢種純算式題嗰陣,完全冇打「|」呢個必需符號（唔係圈裝數字嘅問題，呢個係第一次診斷嘅誤判，已更正）。加咗返一個bare算式嘅prompt例子修好。
  3. 修好之後再測，又發現新問題：prompt入面叫佢加返直式嘅重複數字做sub-answer（例如"4;3)12/12"），令批改程式誤判12÷3=4呢題做錯。移除咗嗰個指示。
  4. 再測，發現最嚴重嘅一個：喺「A÷□=C」呢種「空格係除數」嘅題型（例如「54÷□=6」，喺HK小學數學好常見），Gemini會將印刷題目同學生手寫答案撈埋、掉轉——印刷題目讀成「54÷9」（將學生寫嘅9塞咗入去），學生答案反而讀成「6」（其實嗰個係印刷嘅商數）。呢個令批改程式將學生本身答啱嘅嘢（例如第7題學生寫"6"，42÷6=7係啱嘅）判做錯（correctAnswer顯示做7，即係程式諗錯咗邊個先係啱嘅答案）。同已知嘅「printed/answer swap」係同一個failure class，但呢次係喺Gemini度、喺呢個特定題型度確認。
  5. **即刻rollback返Qwen**（`OCR_TEXT_MODEL = PRODUCTION_OCR_MODEL`），真實再驗證過：同一張相,第5、6、7題（全部都係「A÷□=C」格式）而家全部batch返做`correct:true`，同真相脗合。
  **結論**：Gemini喺純OCR-only測試(Ticket23/24/25)表現靠近甚至優於Qwen，但一旦接落真正嘅批改判斷邏輯，就暴露咗一個之前純OCR測試冇撞到嘅結構性bug——呢個正正證明咗「淨係做OCR-only比較唔夠，一定要跑埋真正production判斷邏輯先可以話個switch安全」。**呢次rollback證明咗architecture本身設計得好**：因為OCR model獨立成一個constant，rollback只係改一行code、重新deploy，唔使動judge model嗰層，全程冇影響過Ticket13嘅AI覆核安全網。要再考慮換Gemini，一定要先response prompt專門修返「A÷□=C」呢種題型，然後用真正/api/mark（唔淨係OCR-only診斷route）重新驗證過，先可以話安全。
- ✅ **第27項（兩部分）：(A) 用戶要求檢查「□空格掉轉」呢個bug係咪系統性問題——已將prompt修正由「除法專用」擴展做「所有中間有空格嘅算式」通用規則，真實用除法相重驗證過，第5-8題全部正確保留「□」、答案啱晒。仲有幾個code入面同樣靠「□」符號嘅handler（缺位數字、比較符號、倒推除數等）用返同一個prompt修正，但未逐一用真實相片驗證過，明確標低未做。(B) 用戶要求開始接入Jev（TypeSafe嘅decision-only模型），已寫好`callJevPreCheck`：喺Ticket13真正（睇相）AI覆核之前，加一層純文字快速篩選——Jev答得好有信心（≥0.9啱或≤0.1錯）先接受佢個判斷（verifiedBy:"jev"），唔夠信心/答案格式錯就完全唔理，原封不動跌返落而家嘅Qwen/DeepSeek覆核，零風險。獨立做返一個constant（JEV_MODEL），跟返OCR_TEXT_MODEL嗰種隔離做法，方便日後换/移除。6個新test，全部mock fetch，冇真實洗費。341/341測試通過，已push，但未部署落production——仲欠一個真實數據驗證計劃先可以信得過（尤其Jev官方都話CJK/中文準繩度未驗證過），下一步要同用戶傾清楚測試方法先至可以真實開支。
  - **(C) 用戶要求跑真正流程（Gemini OCR→code→Jev）測試7張真實相，逐條題報告結果。搵到2個真實、已確認嘅code bug（唔關AI事），已修好：**
    1. `number_word_conversion`錯誤咁claim咗「and/but/or連接句」呢個題型——因為OCR轉錄嘅printedQuestion淨係得個裸數字標籤（例如"1"），啱啱好撞中「有細數字」嘅偵測條件，加上答案（"but"）啱啱好撞中「有字母」條件，於是將"but"同數字1轉做嘅英文字"one"比較，判做錯——8題全部俾呢個bug錯判。
    2. `grammar_cloze`錯誤咁claim咗safari短文嘅代名詞填充題——因為印刷題目啱啱好有「空格跟住印刷嘅"'s"」（例如"____'s having a shower!"），撞中呢個handler原本淨係為「its定it's」呢種題型而設嘅偵測邏輯，但學生真正答案係代名詞"It"，俾呢個handler攞去做its/it's邏輯判斷，判做錯。
    - **兩個都已修好**：而家兩個handler都要求學生個答案本身真係屬於嗰個handler嘅答案家族（number_word_conversion要答案真係parse到做數字詞；grammar_cloze要答案係am/is/are/has/have/its/it's其中一個）先會claim嗰條題，唔再淨係睇印刷文字嘅表面形狀。加咗5個regression test（2個confirm bug已修好，3個confirm handler原本嘅真正用例仍然work）。346/346測試通過。
    - **(D) 兩個都已經跟進修好**：(a) `verifyMath`加咗返專門識別「A÷B=商...餘數」呢種full equation嘅檢查，第11題（30÷4=7...2）而家可以confident咁判做啱；如果答案仲有額外用英文句子覆述嘅部分（例如"She can fold 7 paper cranes..."），呢部分暫時仍然判斷唔到，會安全咁跌返落needs_review（唔會再係false），已加5個regression test。(b) 中文題已經完全排除喺Jev預篩選之外（唔再send去Jev），直接沿用返而家（睇相）嘅AI覆核，同Jev未出現之前一樣安全——呢個係最簡單、零額外風險嘅做法，唔使搵第二個中文model。351/351測試通過。
- 🔲 **第28項（提出咗，未做）：起一個「交叉碰撞test框架」——攞晒`QUESTION_TYPE_HANDLERS`入面每個handler各自嘅真實例子，逐個餵晒俾其他所有handler嘅`detect()`，確保冇一個handler會錯誤咁claim咗第二個handler嘅嘢。** 呢個係第27項root cause分析嘅跟進建議，目的係將「今次靠真實相先撞到bug」變成一個結構性、自動化嘅防護網，唔使淨係靠好彩先撞到。等用戶話事幾時做。
- ✅ **第29項完成：修OCR prompt——處理「連續多空信件/短文」題型嗰陣，要保留返每個空格附近嘅完整句子context，唔可以淨係得返個孤立標籤或者將答案字照抄當printed。**
  - **根本原因（用真實資料查證，唔止Gemini）**：Qwen(而家production用緊嗰個)同Gemini兩個都有問題，但錯法唔同——Qwen將成段短文冧埋做一條item，8個答案全部報做「?」（當成未答，實際上學生全部填咗）；Gemini就拆開晒但printedQuestion淨係得返答案字本身或者個標籤，冇埋句子context。兩個都令code/Jev冇足夠資訊判斷。
  - **修好嘅prompt**：加咗兩條新規則——(1) printedQuestion一定要包含緊貼空格嘅完整句子，唔可以淨係標籤/答案字；(2) 短文入面每個空格一定要拆做獨立item，唔可以因為同一段就冧埋、唔可以因為手寫字讀漏就報做未答。
  - **真實驗證（用返真實相，Qwen production model）**：相4(and/but/or信件)12條item全部啱——每條都有完整句子context、答案全部正確抽取到，同之前「成段冧埋、全部"?"」相比係質嘅飛躍。相5(代名詞+safari短文)15條item全部啱，同樣結構乾淨、context齊全。
  - **附帶發現（未深究，唔阻住呢個ticket close）**：相6(中文書信)測試嗰陣，Qwen讀到嘅內容同之前核實過嘅ground truth有出入（例如「親愛的表姐」答案讀成「表姐」而唔係「表弟」）——因為中文題已經喺第27項排除咗Jev、會跌返落而家嘅vision AI覆核安全網，呢個發現冇即時風險，但值得後續留意。
- ✅ **第30項完成：用戶明確要求換返Gemini做/api/mark嘅OCR模型——已經換咗，真實驗證過production路徑冇問題。**
  - 前提：導致第26項rollback嘅致命bug（A÷□掉轉）已經喺第27項修好，並且直接用Gemini驗證過；第29項嘅短文context修正都用Gemini測試過，有明顯改善。
  - `OCR_TEXT_MODEL`由`PRODUCTION_OCR_MODEL`（Qwen）改返做`"google/gemini-3.1-flash-lite"`。
  - **真實驗證**：用返嗰張原本令第26項撞板嘅除法相，直接call真正production `/api/mark`（唔係診斷route）——第1、2、3、5、6、8題全部正確判做啱（答案5、4、9、9、8、4，同ground truth完全脗合，冇再撞板），第4、7題被Ticket4嘅印刷數字cross-check標做needs_review（呢個係Qwen都會有嘅pre-existing現象，唔係新問題）。351/351測試通過，已部署。
- ✅ **第31項完成：用戶要求重跑7張相全流程測試(記錄每步用咗邊個工具、幾多錢、幾耐)，搵到並修好一個第29項帶嚟嘅真實回歸bug。**
  - **搵到嘅問題**：第29項個prompt改動之後，用7張相全面測試，發現相3/5/6/A/B嘅題目大量混埋、答案互相滲漏（例如8條題變成得返1條，答案欄夾埋咗下一題嘅內容）。
  - **根本原因**：Gemini對住「一段短文有多題」嘅頁面，改用咗換行(\n)分隔唔同題，而唔係要求嘅逗號——但`parseOcrLine`個判斷「新一題喺邊度開始」嘅regex淨係識認逗號，見唔到逗號就將之後所有內容都當成第一題嘅答案，吞晒後面啲題。
  - **修法**：喺`parseOcrLine`加一行，將換行都當逗號處理——呢個係parser層面嘅通用修正，唔淨係修單一張相。
  - **真實驗證（兩輪）**：用返已攞到嘅相3原始文字直接驗證，3條題正確拆晒（之前得1條）；再用真銀重跑成套7張相，全部7張結構都啱返（相3=3條、相5=15條、相6=8條、相A=3條、相B=6條），同修改前嘅混亂結果對比，質嘅改善。351/351測試通過，已部署。
  - **真實成本+速度（呢次測試逐步記錄，包含每個工具、每步用幾耐幾錢）**：7張相共$0.006702美金，19.8秒。OCR(Gemini)每張2000-5000毫秒唔等，$0.0008-0.001一張；Jev每張用得幾百毫秒、$0.00003-0.0001唔等；code判斷幾乎零時間零成本。
  - **附帶執漏**：過程入面兩次因為用`git add -A`唔小心夾埋咗唔想要嘅檔案（wrangler帳戶快取、debug暫存檔），都即刻搵到剷走，已經記低做HARD RULE防止再犯。
- 🟨 **第32項進行中：網頁版主要提交流程已經由`/api/check`轉咗做`/api/mark`。**
  - 查證確認response格式本身已經夾得晒(`results[].bbox/correct/correctAnswer/page/question/studentAnswer/subject/verifiedBy`、`pageRotations`)——因為`/api/mark`本身就係跟Telegram嘅annotateImage功能設計，啱啱好同網頁版`fillPageResult`要求嘅format一樣，唔使改render code。
  - **已知、冇隱藏嘅真實代價**：`pageIndex`/`priorPagesContext`/`requestId`/`deviceId`/`rememberHandwriting`呢幾個欄位`/api/mark`完全唔識、會靜靜雞忽略——即係多頁題目之間嘅context唔會再傳落去、「記住呢種筆跡」功能會停用；`requestId`嘅去重機制轉用返`/api/mark`自己個content-hash去重(第16項)，普通情況下作用類似但唔完全一樣。
  - **未驗證嘅部分**：而家嘅phase 2 zoom-recheck流程(`/api/verify`，由`needsVerify`觸發)保持原封不動冇改——`/api/mark`都會回返`needsVerify`(俾自己個server-side Jev/AI覆核都判斷唔到嘅題目)，理論上呢個流程仲會觸發，但未end-to-end驗證過同`/api/mark`嘅item格式夾唔夾得埋，明確標低未驗證，唔係假設冇事。
  - `restitchSplitPages`(跨頁題目合併)刻意保持用返`/api/check`——`/api/mark`完全冇對應嘅跨頁聯合判斷能力，換咗會靜雞雞令呢個功能完全失效。
  - 351/351後端測試通過(網頁改動冇automated test覆蓋)。等緊用戶自己上傳相片做真實端對端測試。
- 🟨 **第33項進行中：Jev「有信心啱」門檻再由0.88降到0.85(用戶明確要求)。** 根據第31項真實測試嘅26個真實信心分數：真係啱嘅答案分佈响0.87-0.97,冇一個清晰分界(例如一條真係啱嘅"read it"都只有0.87,踩喺舊門檻0.88下面)；而真係錯嘅題目入面,見過嘅最高分都只係0.43,同0.85仲有一段距離。已改code、351/351測試通過，未部署。
- 🟨 **第34項進行中：起咗一個每星期日朝早10:15嘅「搵中文AI model」watch cron job，第一個要試嘅係Kimi K3。** 留意:呢個cron淨係喺呢個session入面生效，最多維持7日就會自動失效，到時要重新設定。真正搵到candidate之後嘅任何真銀測試，仍然要跟返「真銀一定要問過先做」嗰條硬性規矩。
- 🔲 **第35項（提出咗，未做）：網頁版加一個「download已批改相片」按鈕，直接重用Telegram已經起好、已經測試過嘅`annotateImage` function，隨用戶需要生成一張整合埋✓/✗記號嘅完整圖檔。** 分析完Telegram(靜態、可save/轉發/印，但冇互動)vs網頁(即時互動疊圖，但淨係喺開緊個網頁先見到)兩種做法嘅優劣之後嘅建議——唔使二揀一，網頁保留現有互動做主要體驗，加呢個按鈕補埋「攞走保存」呢個Telegram先有嘅用處。等用戶話事幾時做。
- 🔲 **第36項（提出咗，未做）：幫hk-homework-check加返CPU-ms用量追蹤(同而家已經幫road-closures-uk做緊嗰個一樣)。** 真實查證咗Cloudflare Workers Paid plan嘅計價:包3000萬CPU毫秒，超咗每100萬CPU-ms收$0.02美金——Photon(annotate/rotation/crop)呢啲圖像處理會真實食CPU時間，用戶多咗有可能拉近或者超出呢個包額。而家完全未追蹤過hk-homework-check呢個數字，答唔到實際用緊幾多、仲有幾多空間。等用戶話事幾時做。
- ✅ **第37項完成：新增`test/ocr-parsing-regression.test.js`，用返4個真實(唔係作嘅)raw OCR文字案例——第31項嗰個換行bug原文、第26項修前嘅「冇pipe」原文(記錄低0條係啱嘅預期結果，唔係parser bug)、第26項修後嘅正確形狀、第29項嘅短文context保留形狀。已export`parseOcrLine`俾test直接call。355/355測試通過(新增4個)，零成本、幾毫秒跑完，已push。
- ✅ **第38項完成：抽走咗`isWordAnswer`重複邏輯，整做共用function`looksLikeNumberWord`，兩處都改用返佢。** 純refactor，行為冇變。355/355測試通過，已push。
- 🔲 **第39項（提出咗，未做）：修中文排除機制嘅漏洞——而家靠「印刷題目+學生答案有冇CJK字」判斷係咪中文題，如果OCR將中文題讀到完全冇中文字（例如亂碼/誤讀），呢條保護會被繞過，令中文題有機會送咗去Jev，而且冇任何log/警號話你知發生咗。** Challenge-all搵到嘅真實edge case。等用戶話事幾時做。
- ✅ **第40項完成：監察Jev可用性。** `callJevPreCheck`而家會將真實call結果（成功/timeout/http error/exception）標記喺個返回值上（`.callStatus`），`handleMark`每次都會將今日嘅call數同fail數寫入`RATE_LIMIT_KV`（key: `jevhealth:<HK日期>`，8日TTL，best-effort非原子性寫入，純粹做監察用）。每日cron（528766cd，9:37am）已經擴充成同時check CF usage同jev health，如果今日call數>=5且fail率>20%就會喺報告最頂flag出嚟。純監察，唔影響改功課本身（fail-open）。354/354測試通過。
- 🔲 **第41項（有plan，未做code）：診斷route嘅管理——今日一個session起咗拆咗8-9次臨時診斷route，全部靠人手記得刪，建議諗一個更結構性嘅做法。**
  2026-09-27訂立嘅prevention plan（4點）：
  1. 統一入口：以後所有臨時診斷route應該行同一個dispatch前綴（例如`/api/debug/*`），共用同一個token check（一個`DEBUG_TOKEN`常數），而唔係好似今日咁每次自己開新path+自己set token字串——咁樣淨係grep一個關鍵字就搵晒全部，一齊刪。
  2. 唔可以重新實作production邏輯：diagnostic route必須直接call production嘅同一個function（例如`classifyAndVerify`、`callJevPreCheck`），唔可以自己抄一份邏輯——今日就係因為v2/v3 route自己set `subject: null`，冇用返production個Chinese-exclusion filter，令報告一開始唔準確，呢個係今日真實發生過嘅bug。
  3. 加返即用即刪嘅紀律：每次開一條temp route嘅同時，即刻喺呢個TICKETS.md度加一行「待刪：/api/xxx」，投入debug用完即刻對返呢張清單刪、確認冇漏。
  4. Push前grep一次：`git push`之前用`grep -n "test-\|DEBUG_TOKEN"` src/worker.js 確認冇殘留。
  呢個純粹係做法上嘅紀律，未涉及即時code改動；如果想將第1點（統一dispatch前綴）做成一個可重用嘅helper function，可以而家開始做，等用戶話事。

- 🔲 **第42項（一round做完，暫緩）：測試jev解中文數學題嘅能力。** 用戶想知jev係咪識答用中文寫嘅數學題。第一round測試（3張相：估算練習+容量練習）結果：22條item入面得4條真係問到jev，全部答唔出（唔夠信心），冇一條係真正嘅敘事式中文應用題。意外發現咗第43項個bug。`/api/debug/full-flow`已經完成任務，刪走咗（2026-09-27）。想繼續要真嘅敘事式中文應用題相。

- ✅ **第43項完成：除法帶餘數嘅答案（例如「14…3」「11…5」）被code判做錯，但其實學生答啱——已修好。** 根因confirm咗：`verifyMath`嘅Case 2（學生答案本身冇「=」，好似87÷6→"14…3"呢種）一直冇做Ticket 27嗰個除法餘數check（嗰個check淨係喺Case 1、即係學生自己寫埋條完整算式好似"30÷4=7...2"先會做），所以跌落一般路徑，`parseNumericAnswer("14…3")`會靜靜雞截斷做14，同`evalArithmetic("87÷6")`=14.5一比較就唔啱。已經抽咗個共用function`verifyDivisionRemainder`，Case 1同Case 2都call返同一個，唔使再各自維護一份。357/357測試通過，仲live re-verify咗（用真正production嘅`classifyAndVerify`，同一張真相），確認"87÷6"+"14…3"而家判「啱」。

- ✅ **第44項完成：中文題目而家都會送去jev睇，唔再隔開。** 用戶明確指示：「Pls let jev work on everything in chinese from now on- we can add another ai that is good in chinese later.」原因記錄：Ticket 27發現jev試過將啱嘅中文答案（親愛的表姐→表弟）判做錯，先加咗個排除。用戶決定：而家先俾jev試，之後（第34項每週AI巡查）搵到啱嘅中文專用AI先再算。已刪走`allPendingFlat`嗰個`.filter(subject !== "chinese")`，code comment記低咗成個歷史背景，方便日後想返轉頭。357/357測試通過。

- ✅ **第45項完成：模型名寫死喺兩個地方（舊筆記提出）——查證Qwen嗰個已經喺之前嘅refactor度修好咗（`PRODUCTION_OCR_MODEL`/`OCR_TEXT_MODEL`/`JEV_MODEL`，各自淨係出現一次），但發現DeepSeek有一模一樣嘅問題，重複咗3次（`callDeepSeek`本身+2個connectivity self-test route），已修好。** 抽咗一個`DEEPSEEK_MODEL`共用constant，3個地方都改用返佢。357/357測試通過。
  **附帶發現（未做，另開ticket）：查呢個嗰陣搵到`/api/test-deepseek-latency`、`/api/test-rotation-latency`、`/api/test-vision-ocr-latency`呢3條舊式「TEMPORARY diagnostic route」（第41項紀律之前留低嘅），自己個comment都寫住「Remove once the real cause is found」但從來冇刪過，而且完全冇token驗證——即係任何人知道網址都可以free咁trigger真銀call（DeepSeek/OpenRouter/Vision）。見第46項。**

- ✅ **第46項完成：3條舊式公開、冇驗證嘅診斷route，已加返`DEBUG_TOKEN`密碼保護。** 用戶明確選擇「加密碼」（唔係刪走，因為呢3條route仲有用，想保留返日後debug用）。`/api/test-deepseek-latency`、`/api/test-rotation-latency`、`/api/test-vision-ocr-latency`而家都要header `x-debug-token: hw-debug-20260927`先用得，冇password直接401。`test/no-unguarded-paid-routes.test.js`（Ticket46附帶加嘅自動check）確認轉綠。358/358測試通過，已push。

- 🟨 **第47項（免費部分做咗，真OCR驗證未做）：相片壓縮改用快啲嘅filter。** 用真實3張相本地benchmark咗Photon嘅5種resize filter（免費，冇call任何AI）：而家用緊嘅`Lanczos3`每次resize要52ms左右，`Triangle`得23-34ms（快接近一倍），而且輸出檔案仲細啲（例如35.2KB vs 39.6KB）。`Nearest`最快但輸出檔案反而最大（鋸齒令JPEG壓縮率變差），唔建議。**未做嘅部分**：冇驗證過用`Triangle`會唔會影響Gemini讀字（OCR）嘅準繩度——resize快得嚟畫質糙咗，有機會令細字/手寫字模糊咗，跟返「換嘢要用真正pipeline驗證，唔淨係睇跑得快唔快」呢個規矩（Ticket 26教訓），要用真銀做幾張相嘅OCR準繩度對比先可以放心轉。真銀成本好細（3張相×2種filter×Gemini OCR≈$0.006）。等用戶話事想唔想做呢個驗證。

- 🟨 **第46項跟進：加咗一個自動測試`test/no-unguarded-paid-routes.test.js`，會自動搵晒成個worker.js入面所有call真銀AI嘅route，check佢哋有冇保護（rate limit/DEBUG_TOKEN/webhook密碼）。** 用戶問「有冇工具可以確保呢類security風險唔再發生」，答案係：冇工具可以100%保證「全部」風險消除（呢個講法本身唔誠實），但可以將已知嗰類風險（冇保護嘅route）變做自動、持續嘅check。已經實測confirm：呢個新測試準確咁淨係flag到第46項嗰3條真係有問題嘅route，冇flag錯（例如`/api/check`本身有rate limit但淨係喺個inner function度，test識得跟埋去check，冇誤報）。**呢個測試而家會fail**——因為第46項本身仲未修，呢個係故意嘅：測試會一直紅住提醒你，直至你決定點做（加token定刪走）先會轉綠。想我而家就手修埋第46項（加DEBUG_TOKEN），令個新測試都轉綠？

- 🟨 **第48項進行中：跨頁題目偵測已經整返好、真實部署咗，但真正嘅「觸發到會點」路徑未有真實split相試過。** 根因（第32項轉用`/api/mark`之後，呢個flag機制完全冧咗）已經修好：`OCR_ONLY_PROMPT`加咗兩個標記（`CONTINUES_FROM_PREVIOUS`/`CONTINUES_TO_NEXT`），新function`extractContinuationMarkers`負責攞返呢兩個flag同清理返OCR文字，一路傳到`handleMark`個response，網頁版嗰個觸發條件（`if(data.continuesFromPrevious)`）而家終於再有得郁。361/361測試通過，已push。
  **真實驗證（已做）**：用返一張正常、完整（唔係split）嘅相直接call真正`/api/mark`——`continuesFromPrevious`/`continuesToNext`都啱啱好係false（冇亂報），12條item全部正確解析（同prompt改動之前一樣，冇regression）。
  **未驗證（老實講清楚）**：手上冇一張真係「橫跨兩頁」嘅相，所以未實測過個flag喺真正split情況會唔會啱啱好報做true、跟住個stitch會唔會真係觸發到。如果你有呢類相，可以send俾我測到正嘅positive case。

- ✅ **第49項完成：全面review咗所有「解題code」，確保寫咗嘅嘢真係接落生產環境用緊嘅pipeline。** 用戶要求「ensure all codes written for solving questions can be used in the pipeline」，做咗一次完整審計：
  - 成個codebase有45個`verify*` function，逐一check邊啲真係喺`QUESTION_TYPE_HANDLERS`（真正production行緊嗰個dispatcher）入面有註冊。
  - **9個冇註冊，其中2個係啱嘅（有記錄低原因）**：`verifySelectTwoNumbersSumTarget`、`verifySortFractionsAscending`——呢兩個要求structured輸入（已解析好嘅候選數字array），而OCR而家淨係識攞文字，未有可靠方法由張相度直接攞到呢種structured data，暫時真係做唔到，唔係漏咗。
  - **另外7個已有documented原因**（`verifySudoku4x4`/`verifySelectFromPassage`/`verifyPictureMatchFormat`/`verifyWordBankOnceEach`/`verifyLiteralKeywordMC`/`verifyConjunctionFill`/`verifyPriceTableLookup`）——全部要OCR輸出而家未有嘅structured欄位（格仔grid、原文段落、word bank等），同上面一樣，真係欠OCR prompt先可以接。
  - **搵到7個真係「寫咗、測試過、但一直冇接落pipeline」嘅handler，已經全部接返落去**：`chinese_large_numeral_to_arabic`（阿拉伯數字轉換）、`word_problem_rate_multiplication`（「每...共」rate應用題,例如「小克每天儲蓄30元...五天共」）、`division_remainder_blank`（除式帶餘數空格）、`extreme_number_difference`（最大/最小N位數相差）、`substitute_and_evaluate`（代數代入求值）、`repeated_digit_place_value_difference`（重複數字位值相差）、`time_format_conversion`（12/24小時制轉換）。全部有真實例子嘅regression test，加咗7條「真係經classifyAndVerify行到」嘅integration test（唔淨係test個function本身，係test成條dispatcher）。
  - **過程中真係搵到並修好一個碰撞（collision）**：`repeated_digit_place_value_difference`最初擺喺一個位置,俾`word_problem_difference`（更闊嘅trigger,淨係check「相差」+2個數字）搶先攔截咗個真實例子——已經調返去更前面,確保更specific嘅handler優先攞。
  369/369測試通過，已push。

- ✅ **第50項完成：CPU-ms「煞車掣」——自己喺code入面加嘅監察+保護，防止用量爆錶。**
  **重要設計原則（同100%準確度嘅硬規矩一致）**：呢個煞車掣**絕對唔會影響批改準確度**——凡係同準確度有關嘅Photon步驟（相片縮小、轉向較正）完全冇改動，一定照做。**淨係得一樣嘢會喺用量過高嗰日被跳過**：Telegram嘅相片標圖（annotateImage）——因為批改結果（啱定錯）呢個時候其實已經計好晒，標圖淨係將結果畫落相度嘅視覺呈現，跳咗佢完全唔影響批改本身。跳咗嘅話，會send返文字版結果（第幾題啱、第幾題錯、正確答案）畀家長，唔會送冇資訊嘅嘢。
  做法：每次做Photon嘢（annotateImage、轉向處理），將真實耗時（毫秒）累計寫入KV（key: `cpuguard:<HK日期>`），跟返第40項一樣嘅best-effort做法。門檻暫定每日100萬毫秒（根據Workers Paid plan每月包3000萬CPU-ms÷30日嘅保守估算，未有真實數據校準，之後可以再調）。
  373/373測試通過（新加7個，包括fail-open保護測試），已push。

- 🟨 **第51項進行中：跟返「work on OCR prompt」呢個要求，接第一個未接嘅handler——`verifyConjunctionFill`（but/and連接句）。** 意外發現：其實唔使改OCR prompt都做到！因為第29項（2026-09-27）嗰個context保留修正,而家一個blank嘅printedQuestion已經帶埋成句嘢（真實例子：「My name is Eric. I have three sisters ____ I don't have any brothers.」），淨係將呢句字用「____」切開做clauseA/clauseB就得，資料一早已經有，之前淨係冇駁埋。377/377測試通過，已push。
  **剩低6個仲要真係改OCR prompt先接到**（word bank、原文段落、價目表、選項A/B/C/D分開、4x4格仔、睇圖format）——呢6個先係真係要動OCR prompt呢個高風險嘅位（歷史上第26/31項都因為改prompt整出過真regression），建議逐個、逐個驗證咁做，唔好一次過全部加。想我揀邊一個先開始？

- ✅ **第52項完成（跟返「一個一個嚟」）：接咗`price_table_lookup`（價目表計數）——第一個真係要改OCR prompt先接到嘅handler。** 加咗一行新指示：如果張相印刷咗價目表，用「PRICE_TABLE: 名稱=價錢;...」格式喺回覆最開始列出，新function`extractPriceTable`負責攞返呢行、清理返OCR文字。價目表屬於成頁共用嘅context，直接掛喺嗰頁每條item度，唔使改`classifyAndVerify`個function signature。382/382測試通過，已push、已deploy。
  **真實驗證**：用返之前試過嘅相（估算練習，冇印刷任何價目表）直接call真正production /api/mark——結果同之前一致（1、2、3、5題全部仍然code判斷啱），冇因為呢個prompt改動整壞正常讀字，冇誤判任何一條item做price_table_lookup。
  **未驗證**：手上冇一張真係印刷咗價目表嘅相，所以Gemini真係遇到價目表嗰陣識唔識跟返呢個新格式,仲未實測過。

- 🟨 **第53項完成code部分（未做真銀驗證）：接埋`literal_keyword_mc`（閱讀理解逐字對照MC）同`select_from_passage`（喺原文揀字填空）。** 兩個都要「原文段落」呢份新資料，加咗一行新指示：如果係閱讀理解就喺回覆最開始加「PASSAGE: <原文>」，新function`extractPassageText`負責攞返嚟。MC選項本身唔使新欄位——寫咗個共用嘅`parseMcOptions`，直接由printedQuestion文字度攞返A/B/C/D選項（同parity_mc/computation_mc做法一致）。兩個handler都擺喺陣列好後面，等所有更精準嘅handler優先攞。
  select_from_passage只可以判「錯」或者「唔知」，永遠唔會判「啱」（佢自己個function設計本身就係咁——揾到個字喺原文都唔代表填得啱位），已加限制（要有blank記號+短答案）避免誤觸其他唔相關嘅題目。
  390/390測試通過，已push、已deploy咗code，**但跟返啱啱先犯過嘅教訓，未做真銀live驗證**——要做嘅話（用返之前嘅相確認冇regression，大約$0.001）要問你先做。
  **仲欠2個未做**：`word_bank_once_each`（詞語庫填空）因為要「成頁所有答案一齊睇」（唔係逐條題判斷，係一次過check晒成頁），同而家個per-item判斷架構唔夾，要開新一種「頁面層面」嘅判斷模組先做到，工程量大好多；`sudoku_4x4`要成個4x4格仔（16格）做一份structured data，同而家「一題一個printedQuestion+studentAnswer」嘅資料形狀完全唔同，唔係加個欄位咁簡單，要另外諗個做法。呢兩個建議開返獨立ticket，唔好同今次一齊匆忙做。

- ✅ **第54項完成：接埋`word_bank_once_each`（詞語庫填空,每個詞淨用一次）。** 跟用戶明確嘅設計指示做：
  1. 加咗「WORD_BANK: 詞1;詞2;...」新指示,新function`extractWordBank`攞返呢份資料
  2. 因為要成頁所有答案一齊check,寫咗一個新嘅「Module 2b」（喺handleMark入面,唔係一個handler entry）
  3. **答案根本唔喺詞語庫入面** → code直接確定判錯,唔使用AI
  4. **撞用咗同一個詞**（用戶指出：設計得好嘅詞語庫,唔應該有兩題撞用同一個詞,撞咗即係代表梗有一條答錯）→ **唔會強制「需要人手覆核」**,而係將呢個撞用嘅context講埋俾jev/AI覆核知（正常嚟講每條題目jev係獨立咁判斷,完全唔知道第二題用緊咩,而家特登加返呢個佢哋原本冇嘅context），等jev/AI自己判斷邊條先真係啱，jev/AI答唔出自然都會好似而家其他題咁樣跌落「需要人手」,唔係code強行判斷。
  **測試期間自己捉到一個真bug**：最初個code錯誤咁將「唔喺詞語庫」呢個check都綁埋喺「要2條題先做」嗰個條件度,令到得返一條詞語庫題嗰頁完全唔會check——已經修好,分開咗兩個check嘅門檻。
  394/394測試通過,已push、已deploy。**未做真銀live驗證**（跟返新規矩，要問你先做）。

- ✅ **第55項完成：接埋4x4數獨（Sudoku）——用返一直已經寫好、已經測試過嘅`verifySudoku4x4`,只係加返攞資料嗰一步。** 跟用戶明確指示做：
  1. 加咗新指示：見到印刷文字有「Sudoku」呢個字+格仔大小係4x4,就用「SUDOKU: 題號|印刷格仔16個|學生完整填晒嘅格仔16個」新格式列出（3x3或者其他大小暫時唔理，因為而家淨係識判斷4x4）
  2. 呢個係完全獨立嘅資料形狀（一嚿16格,唔係「題目+答案」），寫咗獨立嘅`extractSudokuPuzzles`同一個新嘅「Module 3d」，直接call返現有嘅`verifySudoku4x4`（一路都有,一直未用過）
  3. 跟用戶指示：暫時唔提供「正確答案」（`correctAnswer`留空），得返啱/錯/未填晒3種狀態；未填晒嘅唔會send去jev或者AI（呢兩個而家嘅prompt設計都答唔到一嚿16格嘅嘢），留返做人手覆核，呢個係第一版嘅已知限制
  401/401測試通過（新增9個，包括3個完整handleMark端對端測試：全啱、行內撞號判錯、未填晒唔會送AI），已push、已deploy。**未做真銀live驗證**（跟返新規矩問你先做）。

- 🟨 **第56項進行中：MCLQ 2A survey發現1——擴闊應用題handler,加返英文觸發字。** 已做3個（真實引用嘅例子有quote先做,冇quote嘅例子暫時唔做,避免亂猜）：
  1. `word_problem_total`加咗「altogether/in total/originally」，例如「sold 119 newspapers,16 left over,how many originally?」(119+16=135)
  2. `word_problem_difference`加咗「difference」，例如「what is the difference between the two scores?」
  3. `word_problem_rate_multiplication`加咗全新嘅「each X has N...in total」pattern（英文語序同中文相反,中文係rate行先,英文係count行先），真實例子「6 tubes...each tube has 5...how many in total?」(6×5=30)
  **暫時未做**（冇足夠真實quote,唔想靠估）：`word_problem_division`嘅英文版、「$5 per cup + N friends」呢種要「+1」邏輯嘅shape。
  406/406測試通過（新增5個），已push、已deploy。**未做真銀live驗證**。

- ✅ **第57項完成：將真實嘅香港硬幣/紙幣資料加入AI覆核（Ticket13）嘅prompt度，幫佢分辨面額。** 用戶提出用「文字描述」輔助AI判斷硬幣/紙幣面額嘅諗法——已查證真實資料（HKMA官方+Wikipedia，1993洋紫荊系列7種硬幣嘅顏色/大小/形狀，5種紙幣顏色），加做`HK_CURRENCY_REFERENCE`。**特登淨係喺題目提到錢先加呢段資料**（`mentionsMoneyDenomination`檢查），唔會嘥晒每次AI call嘅token錢。
  講清楚呢個唔係code確定判斷,純粹俾AI多份參考資料,唔保證100%準——同鐘面呢類真正Tier V題型一樣,呢個係輔助,唔係解決方案。
  409/409測試通過，已push、已deploy。

- ✅ **第59項完成：將3D立體形狀嘅通用幾何知識（面數/邊數/頂點數）加入AI覆核prompt，同第57項一樣做法。** 8種常見形狀（正方體、長方體、三棱柱、四角錐、三角錐、圓柱體、圓錐體、球體）嘅真實面/邊/頂點數，一樣淨係喺題目提到形狀先加。
  **順手修埋一個真bug（喺自己寫嘅test度捉到）**：第57/59項嘅偵測function一直淨係check`printedQuestion`,但好多題目個「答案」本身先至有關鍵字（例如問題淨係話「邊個形狀有兩個圓底？」,個關鍵字"cylinder"淨係喺學生答案度出現）——已經改成同時check printedQuestion+studentAnswer,兩個ticket都受惠。
  413/413測試通過，已push、已deploy。

- 🔲 **第58項（research進行中，未接落生產環境）：鐘面讀時間——Photon code方案研究。**
  **2026-09-27今晚新做嘅prototype**：連接像素blob追蹤（唔靠Hough線條）,喺3個已知答案嘅合成測試（3:40、7:05、11:50）全部啱（誤差細過1度）,喺1張真實課本相入面內部邏輯自洽（計出約4:02,冇獨立答案key confirm）。
  **⚠️查返舊有research，發現之前（`benchmark/question-type-library.md`）已經有更嚴謹嘅嘗試**：用OpenCV（Photon冇嘅Hough線條偵測），跟7張唔同真實鐘面相、零容忍「肯定判錯」呢個標準去做，最好結果都只係2/6答到（33%覆蓋率）、0誤判,官方結論係「暫時未夠可信賴,而家仲係應該用AI」，仲有一個更根本嘅發現：**Photon冇真正嘅Hough線條偵測**（淨係得4個固定角度：橫/直/45度/135度），所以就算舊嗰個用OpenCV做到嘅方法,都冇辦法直接搬去Photon用。
  **今日呢個新prototype同舊嘗試技術路線唔同**（靠連接像素blob追蹤,唔係線條偵測），冇被舊research推翻,但都未做過同一個嚴謹程度嘅測試。**下一步**：要用返舊有嘅嚴謹標準（多張唔同真實鐘面相、零容忍判錯）重新驗證,先可以話呢個新方法係咪真係好過舊嘗試。等用戶話事點做。

- ✅ **第60項完成：「做法B」——喺AI覆核prompt加返具體「點樣量度」嘅步驟指示（唔係資料，係方法）。** 4種題型（角度、水位/量杯、間尺、鐘面）,淨係喺題目提到嗰種先加返一句具體操作指示,例如角度題叫AI「搵返個角實際兩條邊嘅方向,同90度比較」。呢個做法風險好細——就算關鍵字撞啱咗唔相關嘅題目,最多加多句冇用嘅指示,唔會好似判斷邏輯咁誤判。
  3個新測試,416/416測試通過，已push、已deploy。

- ✅ **第61項完成：跟第59項一樣，加返2D平面形狀（三角形/正方形/長方形/平行四邊形/菱形/梯形/五-六-八邊形/圓形）嘅真實幾何資料（邊數/頂點數）。** 同3D形狀完全獨立嘅一組keyword同資料表（唔會撞埋一齊），確認咗「faces」（3D用詞）唔會誤觸2D資料。
  2個新測試,418/418測試通過，已push、已deploy。

- ✅ **第62項完成：跟用戶自己嘅諗法——硬幣插圖其實通常自己印咗面額數字，教AI直接讀嗰個數字，唔好淨係靠形狀/顏色估。** 查返本project之前做過嘅PDF survey（`question-type-library.md`），真係搵到confirm：「Coin denomination recognition... '$5' coin drawn with small print」——即係用戶個判斷啱,呢個真係一個讀字問題,唔係圖案分類問題。已經加返一句具體指示「搵嗰個印刷嘅數字直接讀」，同第57項嘅參考資料共存（讀唔到先靠參考資料估）。
  1個新測試,419/419測試通過，已push、已deploy。

- ✅ **第63項完成：跟用戶明確指示「Pls use the method for clock in the production for now」——將第58項嘅鐘面讀時間prototype正式接入生產環境。** 加咗新嘅`clock_reading` `verifyVisual` handler（喺`math_equation`萬用handler之前）：`detect()`要同時見到「clock/時鐘/鐘面/What time」關鍵字**同埋**學生答案要係一個可以解讀嘅時間格式（「4:15」「4.15pm」「7 o'clock」「7時」），特登排除咗「畫出時針分針」呢類作圖題（out of scope）。
  **測試期間（用返已有嘅3張合成測試相：3:40、7:05、11:50）自己捉到一個真bug**：11:50嗰個case讀出嚟係null（唔敢答），同之前Python prototype驗證過嘅結果唔一致。查到原因：個計算用咗`Math.floor`,但量度出嚟嘅角度會有零點幾度嘅誤差,啱啱好落喺11.0望落係10.977咁,`floor`會錯誤咁quat落10,應該用`Math.round`先啱。改咗之後3個合成測試全部啱返。**呢個係一個真實例子,證明咗用戶嗰條「一定要用真實例子驗證」嘅規矩係啱嘅**——如果冇跟呢個11:50嘅測試,呢個bug會直接帶落生產環境。
  已將3張合成測試相+1張真實課本相（p.56）存做`test/fixtures/clocks/`永久測試資料,寫咗9個新測試（`test/clock-reading.test.js`，包括3張合成相個別驗證、錯答案偵測、fail-open on壞相/壞答案、真實相嘅自洽性檢查、handler `detect()`嘅正確性）。
  428/428測試通過，已push、已deploy。
  **老實講清楚未驗證嘅部分**：跟返第58項舊有更嚴謹嘅research標準（7張唔同真實鐘面相、零容忍判錯），今次淨係有1張真實相（自洽,冇獨立答案key confirm），未達到嗰個標準。但係跟返「fail-open,只會加分唔會扣分」呢個設計——判斷唔到就同而家一樣跌落AI覆核,唔會有回歸——所以先照用戶指示而家就用落生產。**跟進**：如果之後可以搵到更多真實鐘面相（尤其係唔同款式/角度嘅），應該繼續用嚟驗證,擴闊呢個方法嘅可信範圍。



- ✅ **第64項完成：跟第57/59/61項一樣做法,加返日曆/閏年/每月日數嘅真實參考資料。** 由背景fork重新睇晒MCLQ 2A嘅時間/日曆章節搵返嚟(真實引用:book p.63「閏年」二月28號問題、book p.64常年/閏年填充題),加咗`YEAR_TYPE_REFERENCE`(常年365日/閏年366日)同`DAYS_PER_MONTH_REFERENCE`(每個月確實日數)兩段。
  `mentionsMonthLength`特登要求**同時**見到月份名**同埋**「日數/日曆」呢類context字眼先觸發,避免好似「In March, Tom saved $50」呢類完全無關嘅應用題都撞中(呢個係fork自己提出嘅風險,已經處理)。
  Fork仲查咗「時間單位換算」（60分鐘/1小時之類）,搵唔到證據話AI呢方面會答錯,所以冇加——呢類淨係例行計算,唔係好似閏年咁嘅死記資料,唔加係啱嘅判斷。
  3個新測試,431/431測試通過,已push、已deploy。

- 🟨 **第65-69項（部分完成——見下面獨立entries）：由用戶提供嘅一份真實已批改P2數學考卷（"P2 maths exam (handwritten).pdf"，9頁，有老師嘅紅筆✓/✗）搵到嘅新題型。** 呢份係手上第一份「真實已批改試卷」，同之前嘅印刷workbook唔同，可以睇到真實學生手寫答案+老師嘅評改。

  - **第65項：「同X和另外N個」均分題** —真實例子（p.3 Q21）：「老師把24張手工紙平均分給卓賢和另外3個同學,每個同學分得手工紙多少張?」正確做法係24÷(3+1)=6,唔係24÷3=8(學生答錯咗)。呢個係一個真實嘅「陷阱」題型——關鍵字係「同X和另外N個」,要識加1先除。可以用code偵測(regex搵「和另外\d+個」)。

  - **第66項：「最少需要」進位除法（ceiling division）** —真實例子（p.4 Q23）：「的士站原有乘客18人,每輛的士可載乘客4人......最少需要的士多少輛?」18÷4=4...2,答案要進位做5,唔係4。關鍵字「最少需要」+除法有餘數,就要quotient+1。

  - **第67項：方向轉向推理** —真實例子（p.5 Q28-30）：「梓君和偉誠面對面站在一起」「偉誠向右轉一個直角後,面向____方」呢類問題係固定嘅方向邏輯(東南西北四個方向,轉直角=90度,面對面=相反方向),可以寫code做返一個「方向狀態機」去判斷,唔使睇圖都計到。

  - **第68項：象形圖（Pictogram）數據題——呢個發現價值好高。** 真實例子（p.8 Q38-42）：一個象形圖用「每個圖示代表1小時」,列出星期日至六每日用嘅時數,問題包括「幾多日冇上網」「邊日最多」「相差幾多」「係幾多倍」「總共幾多」。如果OCR可以讀到「每個類別對應幾多個圖示」（好似而家PRICE_TABLE/WORD_BANK咁,加一條新嘅「PICTOGRAM: 單位=1小時;星期日=5,星期一=0,...」標記),之後所有呢啲問題都變咗純粼術,code可以直接計。**呢個係好似WORD_BANK/PRICE_TABLE咁嘅高回報題型,值得優先做。**

  - **第69項：填色圓圈嘅選擇題（bubble-select MC）** —真實例子（p.2 Q16-18,p.6 Q32-34）：呢類MC唔係用文字剔答案,而係將個選項嘅圓圈完全塗黑,再加上部分題目係「邊個算式答案啱」(例如Q17:「以下邊個除式嘅商與21÷3嘅相同?」),要計晒4個選項先知邊個啱。呢個同之前MCLQ survey搵到嘅「Finding 2:MC-value-matching」係同一個缺口,而家有多個新嘅真實引用confirm。

  **另外3個係Tier V(要睇圖先答到,暫時唔會強行寫code)**:方格位置圖嘅方向推理(p.4 Q24-27,要睇一幅連線圖先知邊個喺邊個嘅邊)、形狀排列/傾斜形狀識別MC(p.5-7 多題)、複合圖形入面數正方形個數(p.7 Q37)。

  呢份試卷仲有一個額外用途:因為佢有老師嘅真實批改(✓/✗),可以做真實嘅pipeline準確度測試(對返老師嘅答案),但要行真銀AI call先做到,要問你先做。

- 🟨 **第70-88項（部分完成:70/78/88見下面獨立entries,其餘未做）：「P1 樂思 Side-by-Side Mathematics Ex 1A」（63頁）survey結果。**
  Tier A（可以寫code判斷,唔使AI睇圖）:
  70. 位值(place value)拆解——例:p.40「43=[]+[]」、p.41「29入面『2』代表(2/20)」
  71. 數字卡砌數(列晒所有答案)——例:p.45「用0,5,2砌3個唔同嘅雙數兩位數」
  72. 算珠總數MC——例:p.41「John用5粒算珠砌兩位數,可能係邊個?」(digit sum check)
  73. 定步長數列MC(唔淨係睇緊升定跌,仲要check步長一致)——例:p.7 Q7
  74. 單雙數+範圍雙重條件——例:p.43「三個單數由小到大:67,?,81」
  75. 完整算式真假MC(包括「邊個唔啱」講法)——例:p.19「A.9=2+6...」/p.33「邊個唔啱」
  76. 配對相同數值嘅算式(list全部/揀一對/揀符合條件)——例:p.55「揀晒啲相等於6+6嘅」
  77. 開放式拆分(10=?+?,答案唔止一個)——例:p.17
  78. 「前面有N個」推算排位——例:p.11「前面有6架車,佢架車係第___架」
  79. 兩組總數相等,反推缺少嘅一部分——例:p.25畫班男女生人數
  80. 交換後拉平問題——例:p.31 Amy分糖果畀Luke,分完之後兩人一樣多
  81. 三個數起4條加減算式(fact family)——例:p.35用8,9,17砌4條式
  82. 「每組N個,共Y組(+餘數)」求總數,包括跨選項比較——例:p.45
  83. **由印刷文字直接數字母/文字個數**——例:p.33「HAPPY BIRTHDAY/生日快樂」問英文字母比中文字多幾多個。呢個純粹係文字題,唔使睇圖,最平最快可以做嘅一個。
  84. 兩個上限,反推最少要幾多喺另一邊——例:p.19「A盒≤9,B盒≤5,共12件,A最少要幾多?」
  85. 鴿籠原理(worst-case保證題)——例:p.58「6盒A款4盒B款,最少揀幾多盒先保證兩款都有?」公式=較大嗰堆+1
  86. 符號代入運算——例:p.49「7+6=☆,求☆-6」
  87. **數列填空驗證要升級**——支援兩邊都有已知錨點、步長可以係2/5/10(唔淨係1),呢個唔係新題型,係修好現有`verifySequenceFill`嘅缺口
  88. 靜態知識——算柱入面「個位每粒=1,十位每粒=10」呢個慣例,p.40有明文寫低,5條題目都靠呢個假設(2欄版本,同已建成嘅5欄唔同)。

  Tier V(要睇圖,暫不強行寫code):方位MC、睇圖數物件、睇圖比較長度、揀最啱嘅代用量度物件、用代用單位沿線點算、遠近排序(部分仲要夾埋邏輯推理)、2欄算柱讀數(建議優先做,因為5欄版本已經做咗)、十位/個位積木讀數、3x3圖案缺格推理、畫圖任務。

- 🟨 **第89-107項（部分完成:89/97/107見下面獨立entries,其餘未做，另外呢度搵到嘅Müller-Lyer視覺錯覺題已經獨立做咗）：「P1 躍思-數學解題策略精練」（77頁）survey結果。**
  Tier A:
  89. 排隊位置(前後夾/左右夾)——例:「佢排第六,後面有2人,共幾多人排緊隊」;「左數第五,右數第___」(left+right-1=total)
  90. 數字線索推理(範圍+單雙數)——例:「學號比9細,比5大,係單數」
  91. 「介乎兩數之間」揀答案MC
  92. 數字鏈/機(順推+反推缺運算)——例:「8→(+3)→□→(−)→□」
  93. 純符號關係推理(唔涉及實際數值)——例:「若△+○=□,則○+___=□」
  94. **算柱結構家族**(呢個好完整,建議跟88項一齊做):讀數、邊個要最多算珠(digit sum)、由個位搬一粒去十位(必然+9)、重新擺位組成最大/最細單雙數
  95. 位值是非題——例:「在10中,『0』的位值是10」(錯)
  96. 中文數字讀法/阿拉伯數字互轉MC
  97. **日曆/星期mod-7運算——呢本書有成個章節,價值好高**:幾日後/幾日前係星期幾、完整月曆格仔查詢(第幾個星期日、最後一個星期三、跨月計算)、is-true/false陷阱題。**重要:呢本書慣例係「星期日=一星期第一天」,「第五天=星期四」,唔係國際慣例星期一開始**——建議寫`CALENDAR_GRID`/`WEEKDAY_FACT`兩個新marker,用Python嘅`datetime`/`calendar`做mod運算
  98. 交錯數列(奇偶各自成規律)——例:「18,1,16,3,14,□,12...」
  99. 指定數字池砌直式算式成立(cryptarithm)——例:用1,2,4,5砌到3□+□□=5□
  100. 進位除法跨選項比較(邊款包裝最少箱)——例:「50個杯,P裝28/Q裝36/R裝19,最少買幾多箱邊款」
  101. 硬幣總值/門檻/組合枚舉——例:「4個銀仔啱啱買到$3.20,最多有幾種組合」
  102. 表格門檻/聚合查詢(count/min/max)——例:「90分或以上有幾多個學生」
  103. 單位換算比例鏈——例:「1張便條=3個手指寬單位,便條同手指寬嘅比例」
  104. 對摺長度反推原長(×2)
  105. 一打/一箱等固定包裝量詞(較細,可能可以摺埋落現有verifier)
  106. 最短路徑距離加總(節點少,可以窮舉)——例:路線圖標明距離,問兩點最短路程
  107. 靜態知識(建議一次過做埋):$2硬幣係波浪形($1/$5/$10係圓形)、HK課程「柱體」包埋長方柱+圓柱、「錐體」包埋三角錐+圓錐(唔係淨係圓嘅先叫)、一打=12、英文字母邊啲純直線(AEK)邊啲純曲線(OS)、星期日係一星期第一天(跟97項共用)。

  Tier V(要睇圖):**特別提醒一個安全陷阱——p.39有Müller-Lyer視覺錯覺線段題(箭嘴方向誤導,但三條線其實一樣長)。呢個提醒咗如果之後用Photon做長度/線段量度(好似而家鐘面/間尺咁),一定要量度真實端點座標,唔可以受箭嘴裝飾影響**;仲有網格圖案填色、鐘面(包括「大約」「差一些」模糊講法)、7巧板砌圖、直尺量度真實物件、非標準單位點算、畫圖任務。

  **兩本書都搵到嘅共通高價值項目**:2欄算柱(70項)、算柱結構家族(94項)建議一齊做;星期日=一星期首日呢個HK課程慣例(97/107項)兩本書都confirm咗,好值得做,因為AI好易憑國際慣例諗錯。

- 🟨 **第108-116項（部分完成:108/109見下面獨立entries,其餘未做）：由用戶提供嘅另外3份材料（P2 Maths Shape 11頁、P2 Maths times table 8頁、P3 Term1 Exam 21頁,後兩份仲有真實學生手寫答案+老師批改)搵到嘅新嘢。**
  108. **由「有幾多面+邊個形狀嘅面」反推立體/平面形狀名——純文字,唔使睇圖。** 例:「一個立體有6個側面,全部係三角形,係咩形狀?」(六角錐);「3個正方形+2個三角形做全部嘅面,係咩形狀?」(三棱柱)。呢個可以直接用返Ticket 59/61已經有嘅形狀資料反過嚟做lookup table。
  109. 靜態知識(加入SHAPE_2D_REFERENCE):「正方形係特別嘅長方形」(square is a kind of special rectangle)。
  110. 「半打」(half a dozen)=6,同躍思搵到嘅「一打」=12一齊擴闊price_table_lookup嘅數量詞。
  111. 4欄算柱(Th/H/T/U)+中文「萬千百十個」位值命名——確認咗算柱家族(70/94項)仲有呢個變體,仲有中英文位值命名唔同呢個要注意(中文萬位=10000,同英文ten-thousand唔係同一個分組方式)。
  112. **數字砌數要留意「唔可以以0開頭」呢個陷阱**——例如用5,0,8,6,2砌最小5位數,唔可以係02568,要係20568。呢個係71項數字砌數功能嘅一個重要補充。
  113. **「來回游X次」呢類複合倍數word problem**——例:「泳池長25米,來回游咗2次,游咗幾多米?」(25×2×2=100,「來回」=×2,「X次」再×X)。
  114. **鐘面讀時間+經過時間計算組合題——同啱啱做完嘅第63項(鐘面）直接有關,值得優先擴展。** 例:睇鐘讀出3:15,話過咗7分鐘,問而家幾多點;或者反過來,話完成時間+用咗幾耐,倒推開始時間;仲有「同目標時間比較,遲到/早到幾多分鐘」。
  115. **鐘面靜態知識(純文字,唔使睇圖)**:「分針行1小格,秒針行幾多小格?」答案60(一分鐘=60秒,秒針行完一圈)。
  116. **relative比較鏈word problem**——例:「同樣路程,文文比心心多用3秒,但比妹妹少用2秒,邊個行得最快?」(關係式:文文=心心+3=妹妹-2,所以心心最快)。

  **重要備註(誠實講清楚一個限制)**:喺P3試卷入面見到真實老師批改,發現咗一個現有pipeline未必應付到嘅情況——**even本身條數計啱,如果冇跟指定格式(例如用直式代替題目要求嘅橫式),老師都會扣分**。呢個唔關「答案啱唔啱」事,係「格式跟唔跟指示」,而家嘅code/AI判斷主要係睇最終答案岩唔岩,好難完全複製呢種格式要求嘅扣分邏輯——留意呢個係已知限制,唔強行解決。

- ✅ **完成：Müller-Lyer視覺錯覺線段題(躍思p.39搵到,原本以為要跌落AI,而家用Photon做到)。** 用戶提出「幫手試下」,已經做咗真正嘅prototype同雙重驗證(跟返Tier V規矩):
  1. 對真實例子(p.39嗰3條直線P/Q/R)——喺每條線嘅垂直中心搵最長連續黑色像素(主幹,唔會撈埋斜嘅箭嘴裝飾),量到274/275/273px,啱啱好證實咗3條線一樣長。
  2. 對自己砌嘅反例(3條真係唔同長度嘅線:200/260/320px)——量到203/263/323px,證明個方法真係識分辨長短,唔係淨係盲目答「一樣」。
  暫時範圍好窄:淨係處理「3條線係咪一樣長」呢個MC形狀(唯一有真實例子嘅shape),如果線真係唔一樣長就會跌落AI(未驗證過嗰個情況)。
  8個新測試(用真實相+自己砌嘅反例相做永久fixture),462/462測試通過,已push、已deploy。

- 🔲 **第117-133項（新發現,未開始做）：由用戶提供嘅另外2份P2考卷(13頁+29頁,包括一份已經批改嘅版本)搵到嘅新嘢。**
  Tier A:
  117. **文字描述鐘面(唔使睇圖)——呢個發現價值好高。** 真實例子:「長針指住12,短針指住5,節目幾點開始?」答案5點。呢條題目用文字直接描述時針分針方向,唔使睇圖,純粹regex判斷,同而家嘅Tier V鐘面圖像判斷完全唔同,而家好可能被誤送咗去AI/Tier V處理。
  118. **N個數加埋(N≥3)嘅應用題——擴展現有得2個數嘅handler。** 3個引用:「42張藍色+36張紅色+15張黃色椅,共有幾多張?」(93)、波子27+11+5=43、玩具店330+116+80=526。
  119. **買嘢找續(2個名稱物品)——已有第一個引用,而家有第二個confirm。** 「三文治$3,果汁$7,俾$15,找返幾多?」15-(3+7)=5。
  120. **進位除法(至少要幾多箱)——第二個引用confirm呢個高價值。** 「一盒25粒朱古力,想要100粒,最少要買幾多盒?」=4。
  121. 限制資源「最多」應用題——「整條裙要2個蝴蝶結+3粒花鈕,而家有11個蝴蝶結+19粒花鈕,最多整到幾多條裙?」floor(min(11/2,19/3))=5
  122. 餘數推斷「可能係幾多」MC——「10人平分咁橙,剩返1個,盒入面可能有幾多個橙?」filter選項 mod 10==1
  123. 連續減法「仲剩返幾多」應用題——關鍵字「仍然/仲喺度」,同「相差/共」呢兩個已有trigger分開
  124. 中間有空格嘅連鎖兩步算式——「79-18-[]=10」,要先計79-18=61先解到blank
  125. 兩階段「夠唔夠錢」判斷鏈——「有$80,買咗$60嘅公仔,仲剩$20,想買$33嘅玩具熊,$20(多過/少過)$33,所以(有/冇)足夠錢」
  126. 硬幣面額直接印喺圖案上(唔使認真實貨幣)——新marker `LABELED_COINS:`,例如硬幣圖示上面印住"5"、"10"字樣,直接讀字加埋計
  127. 英文字母「淨係曲線組成」知識lookup——例:「圈出淨係由曲線組成嘅字母(Q/H/R/S)」答案S
  128. 跨單位距離/大小比較(米vs厘米)——要先統一單位先可以比較
  129. 直式數字連鎖(第二個space要用第一個answer嘅計算結果,唔係原題目數字)
  130. 直式減法缺位數字(第二個真實引用,值得優先做)——3個位(被減數/減數/差)分別缺一個數字
  131. 分階段化簡算式「A-B+C=?=?=?」——只有最尾一格有標準答案可以核對
  132. 換算等值紙幣(例如2張$500可換6張$50同幾多張$100)——新marker `NOTE_EXCHANGE:`
  133. 相框/相片尺寸夾啱與否(跨單位)——frame≥photo兩邊都要啱先夾到

  Tier V:方框/尺度視覺比較(照片/相框、粗細、遠近排位)、圓形/多邊形內角度數視覺判斷、認直線定曲線嘅圖形、砌矩形嘅間尺選擇、複合3D圖形分拆、垂直線圖案辨認、地圖方向連續轉向推理。

  靜態知識(2個真實引用,值得加):「垂直/直線係兩點之間最短距離」(兩份唔同卷都提到,其中一份仲有導師手寫備註confirm)、立體圖形嘅「底數量」+「係咪有彎曲面」呢兩個獨立資料(唔淨係面/邊/頂點總數)。

  另外發現:pdf1第10-13頁其實係另一個AI已經幫手批改好嘅答案(同之前P2_Maths_Shape.pdf個pattern一樣);pdf2第16-29頁係同一份卷嘅已批改版本,有真實學生手寫答案。

- 🔲 **第134-140項（新發現,未開始做）：由用戶提供嘅P1下學期測驗(11頁)搵到嘅新嘢,包括第一個完整嘅CALENDAR_GRID真實例子。**
  134. ✅ **完整月曆表格(CALENDAR_GRID)——已完成。** 加咗新標記「CALENDAR_GRID: 月份=X;首日星期=X;日數=X」,將整個月曆化簡做3個數字,之後所有日期/星期問題都變成純modular數學,唔使OCR逐格讀。用真實「五月」月曆(1號=星期六,31日)驗證晒4種問題形狀:(a)幾多個星期X(答案5個星期一)、(b)第N日係星期幾(19日=星期三)、(c)第K個星期X係邊日(第四個星期六=22日)、(d)下個月第一日係星期幾(6月1日=星期二)。9個新測試(手動逐一驗算過先寫測試),509/509測試通過,已push、已deploy。
  135. ✅ **星期幾嘅時間表(SCHEDULE_TABLE)——已完成。** 加咗「SCHEDULE_TABLE: 星期日=英文班;星期一=游泳班;...」標記,支援兩種問法:反查邊日有邊個活動(「邊日有游泳班」)、日子推算+正查(「如果聽日係星期五,今日活動係咩」)。9個新測試,515/515測試通過,已push、已deploy。
  136. **總數重新分組word problem**——「蛋糕每10個裝一盒可以裝2盒(即20個);如果每2個一盒,可以裝幾多盒?」20÷2=10。
  137. 經過時間嘅不等式MC——「3時開始做運動,做嘅時間比3小時長,幾點可能係結束時間?」要求 end-3:00 > 3小時。
  138. 「琴日/聽日」簡單星期推算(比第89項嘅"第N天"複雜寫法更簡單直接)——「如果琴日係星期二,聽日係星期___」(+2 mod 7)。
  139. **配對算式湊出目標數MC(第76項終於有真實citation)**——「邊組數可以合成13?A.6和5 B.8和5 C.4和7 D.9和3」答案B。
  140. 時間表duration加總——「工作時間9-12,3-6,媽媽每日工作幾多小時」(3+3=6)。

  另外**用戶今晚提出嘅「Photon可唔可以數清楚分開嘅物件」呢個問題,已經用真實相測試完**：喺13隻綿羊、9個蘋果(冇邊框)嘅相入面,Photon連接像素blob方法**準確數啱**;但喺12條魚(有邊框+圈選線)嘅相入面,**因為魚掂咗邊框撈埋一嚿而數少咗一條**。結論:淨係喺「肯定冇邊框/裝飾線」嘅簡單情況先可以用code,其餘要跌落AI,未有一個劃一嘅安全做法。

- ✅ **完成：物件計數（object counting）用Photon做,已接落生產環境。** 用戶主動問「Photon可唔可以幫手數清楚分開嘅物件」,已經做咗真正嘅實驗同雙重驗證:
  1. 用3張真實相測試(13隻綿羊、9個蘋果、12條魚有邊框)——冇邊框嘅2張全部數啱,有邊框嗰張(魚掂咗邊框)Photon**自己識到唔安全**,唔會亂咁答一個錯嘅數。
  2. 安全檢查方法:(a)最大嗰嚿墨跡面積如果係中位數嘅2.5倍以上,(b)任何一嚿墨跡嘅闊/高佔咗成張相85%以上——符合任何一個就唔信個結果,跌落AI。
  10個新測試(3張真實相做永久fixture),500/500測試通過,已push、已deploy。
  **老實講清楚範圍**:淨係喺「印刷題目有『數一數』或者『how many...are there』呢類字眼、學生答案係純數字」先會觸發,而且好多真實情況(圖案疊埋/貼埋邊框)都會識自己拒答,呢個係故意保守嘅設計,寧願跌落AI都唔可以亂答。
