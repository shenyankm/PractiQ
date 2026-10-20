<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ 標誌">
</p>

# PractiQ

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

將文件轉成題庫，在 macOS、Windows 或 Android 上離線練習、自我測驗及模擬考。

- **匯入與檢查**：透過 AI 擷取文件中的題目，檢查品質提示，整理題庫。
- **練習與組卷**：跨題庫依題型、錯題、收藏或未作答題目篩選，進行練習、自我測驗或限時模擬考。
- **查看評分**：客觀題在本機評分，簡答題可由使用者主動要求 AI 評分，也可手動調整分數。
- **儲存與分享**：接續上次的練習、備份個人紀錄，將題庫連同圖片與音訊匯出為 ZIP 檔案，方便分享。

應用程式支援簡體中文與英文、淺色與深色主題、七種基本題型，以及英語聽力、閱讀、克漏字、翻譯及寫作等題型。離線練習資料儲存在本機，不需要帳號，也不提供雲端同步。獨立的 Web 匯入服務使用個人自行架設服務的存取權杖，不提供使用者管理或內建計費功能。

本文件採用台灣繁體中文用語；應用程式目前的介面語言仍為簡體中文與英文。下列操作名稱保留簡體中文介面的原文，方便對照畫面。

首次啟動時，應用程式會依系統語言偏好選擇支援的語言，也可從側邊欄切換。語言選擇會儲存在本機，並納入完整備份；儲存失敗時可重試。日期與數字會依介面語言，採用對應的系統地區偏好設定。切換語言不會變更題目原文或作答內容；材料若有可靠的語言資訊，會標示內容語言，供輔助工具使用。AI 評分會在開始時記錄回饋語言，接續同一筆請求時也會沿用。

PractiQ 仍在開發中，請依下列步驟從原始碼執行；已發布的安裝套件及其限制，請以 [GitHub Releases](https://github.com/shenyankm/PractiQ/releases) 為準。通過各平台的建置檢查，不代表已完成簽章發布或在全新系統上的驗收。

## 螢幕截圖

以下截圖均取自英文介面的桌面開發預覽。題庫名稱、說明、題目及練習紀錄皆為人工編寫的英文範例。所有資料只存放在記憶體中，未輸入憑證、上傳檔案或呼叫模型。點選圖片即可查看原始大小。

| 題庫 | 作答 |
| :---: | :---: |
| [![英文題庫首頁，包含範例題庫名稱與說明](docs/assets/screenshots/banks-en.png)](docs/assets/screenshots/banks-en.png) | [![英文作答畫面，包含選項與答案卡](docs/assets/screenshots/practice-en.png)](docs/assets/screenshots/practice-en.png) |
| **錯題** | **練習紀錄** |
| [![英文錯題清單，包含得分與所屬題庫](docs/assets/screenshots/mistakes-en.png)](docs/assets/screenshots/mistakes-en.png) | [![英文練習紀錄，包含進度與成績](docs/assets/screenshots/history-en.png)](docs/assets/screenshots/history-en.png) |

## 先試用：不需設定模型

[執行桌面應用程式](#執行桌面應用程式)後：

1. 「我的题库」尚無題庫時，點選**添加示例题库**；也可透過**设置 → 导入与恢复 → 导入题库 ZIP** 匯入 [sample.zip](app/fixtures/sample.zip)。其他範例包括[複合題](app/fixtures/composite.zip)與[所有題型](app/fixtures/all-types.zip)。
2. 開啟題庫，選擇**开始练习**，體驗即時回饋練習、不限時自我測驗或限時模擬考。
3. 提交答案，查看評分與解析。

全程不需要 API 金鑰。人工編寫的範例用於展示題型與待檢查標記，不代表模型的實際表現。

從題庫卡片選單匯出 ZIP，即可分享題目，不會包含個人作答內容或評分。匯入題庫會新增內容；還原完整學習資料備份，則會在確認後取代個人資料。作答、自評、草稿保護、失敗後重試、語言設定及主動要求 AI 評分的詳細規則，請參閱[練習指南（英文）](docs/guides/practice-guide.md)；匯入與備份的範圍，請參閱[題庫套件指南（英文）](docs/guides/question-bank-package.md)。

## 使用 AI 匯入文件

文件匯入作業在獨立 AI 服務的 Web 前端進行：

1. [啟動獨立 AI 服務](#獨立執行-ai-服務)，開啟 Web 前端，填入自行架設服務的存取權杖（`AI_SERVICE_TOKEN`）。模型設定及供應商金鑰皆保留在伺服器端。
2. 一次最多選擇 10 份來源檔案，再主動點選**开始导入**。僅選擇檔案不會上傳或呼叫模型。
3. 查看匯入進度、已儲存的題目、圖片、原文答案與待檢查提示，下載題庫 ZIP。
4. 在桌面應用程式中，透過**设置 → 导入与恢复 → 导入题库 ZIP** 建立題庫，或將內容加入既有題庫。

服務支援 **PDF、TXT、Markdown、PNG/JPEG、DOC、DOCX、PPT、PPTX、XLS 及 XLSX**，統一使用騰訊雲的[非同步多模態文件解析 `SubmitMultimodalDocParseJob`](https://cloud.tencent.com/document/product/866/139312)，再由 AI 整理題庫。騰訊雲目前於首次啟用時，一次提供 **1,000 頁免費額度，有效期限為一年**，實際條件以[官方額度說明](https://cloud.tencent.com/document/api/866/35945)為準。新匯入作業不支援 CSV，既有的已儲存資料與題庫則會保留。桌面安裝套件不內建 Python 服務或 LibreOffice。

預設保留本機目錄，透過 Base64 提交，每份輸入上限為 8 MiB，超過上限時由服務分割；XLS 與大型 Office 檔案的分割作業需要部署 LibreOffice。XLSX 會產生顯示隱藏工作表的副本，保留原始檔案。進階的私有 COS 暫存功能預設關閉；設定 `AI_TENCENT_COS_ENABLED=true` 並填入儲存貯體（Bucket）與區域後，所有輸入皆使用短效簽署 URL，本機來源檔案與結果仍會保留。憑證僅在伺服器端設定，模型端點必須支援 Responses API。詳見[騰訊解析設定（英文）](server/docs/tencent-document-parser.md)。

匯入紀錄、暫停、中斷、繼續執行、重試失敗單元、檢查部分結果及重新解析，皆在 Web 前端操作。讀取結果、檢查內容與下載 ZIP 不會呼叫模型；繼續執行、重試及重新解析須由使用者主動觸發，可能產生模型供應商費用。本專案不提供帳號、點數或儲值功能，模型費用由你直接支付給供應商。詳見[匯入任務指南（英文）](docs/guides/import-tasks.md)及[個人自架服務指南（英文）](server/docs/personal-use.md)。

解析只會擷取原文已有的答案與評分規準，不會替缺少答案的題目解題；缺漏內容會保留待檢查標記。請在 **180 天**內下載需要保留的結果，匯入作業到期不影響已匯入應用程式的題庫。

練習與本機評分可離線使用。若需要主觀題 AI 評分，請在 **设置 → AI 服务** 中選擇 **直连模型 API**，填入 OpenAI 相容的 API 位址（包含 `/v1` 或供應商要求的基礎路徑）、模型 ID 及自己的 API 金鑰。macOS、Windows 與 Android 共用 Rust `reqwest` 呼叫 `/chat/completions`，不需部署評分服務，也不依賴 SDK 或 curl。既有部署仍可選擇 **独立 AI 服务**，使用原有的服務位址及權杖。

評分必須有參考答案或評分規準，並會將目前的題目快照、相關材料、圖片及作答內容傳送給所選的模型供應商，可能產生費用。API 須支援 JSON 模式（`response_format: json_object`）與 `max_tokens`；含圖片的題目需要視覺模型。每次主動要求評分最多呼叫一次，逾時為 120 秒，輸出上限為 4,096 token。結果無效、遭拒或被截斷時，會維持未評分狀態，並保留既有分數與手動調整的結果。結果不明時不會自動重新傳送；查核僅會回傳本機紀錄，只有明確要求重新評分，才會建立新的付費請求。測試連線僅會讀取 `/models`，不會驗證評分能力。此功能供個人練習使用，不作為正式考試的閱卷依據。

應用程式的 API 金鑰與服務權杖，儲存在 macOS Keychain、Windows 認證管理員或 Android Keystore 保護的私有儲存空間中；Web 服務權杖只保存在瀏覽器記憶體中。非敏感的連線設定沿用 `v4/service-settings-v1.sqlite` 與完整備份還原機制，不包含憑證，練習資料庫仍使用 schema 11，舊的 schema-11 備份也繼續支援。儲存新的模型設定後，舊版應用程式會拒絕讀取對應的設定檔與備份，請繼續使用目前版本。舊有模型設定與金鑰會原樣保留，不會自動啟用。

關閉應用程式或電腦進入睡眠後，限時模擬考仍會繼續計時。重新進入已逾時的考試時，會依最後儲存的答案交卷。還原與相容性限制請參閱[資料模型（英文）](docs/reference/question-model.md#versions-and-directories)。

開發模式預設使用記憶體中的範例資料；預覽面板可切換情境，或選擇真實的本機資料，詳見[開發預覽（英文）](app/docs/development-preview.md)。

## 執行桌面應用程式

桌面資料使用新的 `v4/` 目錄與 SQLite schema 11。舊目錄（包括 `v3/`）會原樣保留，不再接受舊版完整備份；目前的題庫 ZIP 仍可匯入。詳見[資料格式限制（英文）](docs/reference/question-model.md#versions-and-directories)。

應用程式支援 macOS 14+（Apple Silicon）、Windows 10/11（x64）及 Android 8+（API 26+，arm64 APK）。Linux 應用程式安裝套件已移除，但 Linux 仍可用於執行 AI 服務與 CI。CI 會檢查 macOS/Windows 安裝套件、Android APK 與 API 35 模擬器；實體裝置、最低系統版本及簽章發布仍須個別驗收。

開發需要 Node.js 22.12+ 與 Rust。封裝準備及共用契約檢查還需要 uv 與既有的 Python 3.14+ 直譯器；Python 僅作為建置工具，不會隨桌面套件散布。請安裝 [Tauri 平台必要工具](https://v2.tauri.app/start/prerequisites/)：macOS 使用 Xcode，Windows 使用 MSVC 建置工具與 WebView2。Android 另需 JDK 21、SDK 36 及 NDK 28.2.13676358，詳見 [Android 指南（英文）](app/docs/android.md)。請勿建立專案 `.venv`。

複製儲存庫並進入根目錄：

```sh
git clone https://github.com/shenyankm/PractiQ.git
cd PractiQ
```

macOS 請從儲存庫根目錄執行，並將 Python 路徑替換為你的直譯器路徑：

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make app-install
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
make app-dev AI_PYTHON=/path/to/python3.14
# 建置本機應用程式安裝套件：
make app-build AI_PYTHON=/path/to/python3.14
```

Windows 請使用 PowerShell：

```powershell
npm --prefix app ci
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
python app/scripts/prepare-package.py
cd app
npm run desktop
# 建置 Windows 安裝套件：
npm run tauri -- build
```

`prepare-package.py` 使用 Python 3.14+，產生建置中繼資料與 Cargo/npm 授權聲明，不會下載或複製文件處理執行環境。產出檔案位於 `app/src-tauri/target/release/bundle`：macOS 為 `.app`/`.dmg`，Windows 為 NSIS `.exe`。Android APK 請使用個別的[建置與模擬器指令（英文）](app/docs/android.md)。封裝檢查會驗證版本、授權聲明及未內建處理引擎；這不代表已驗證簽章或桌面音訊播放功能。

## 獨立執行 AI 服務

獨立服務透過 Web 前端與 API 提供文件匯入，也接受桌面應用程式主動提出的評分請求。需要 Python 3.14+、uv、用於 Web 建置的 Node.js 22.12+，以及支援文字與圖片輸入的模型。複製設定範本，保留既有設定：

```sh
cp -n .env.example .env
```

在 `.env` 中設定服務權杖、模型憑證、`LLM_MODEL`、PostgreSQL 連線位址 `DATABASE_URI`、RabbitMQ 專用 vhost 位址 `RABBITMQ_URI` 及檔案儲存位置。先建立空白的專用 PostgreSQL 資料庫，再初始化服務資料表並啟動：

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make web-install
make web-build
make server-dev AI_PYTHON=/path/to/python3.14
```

FastAPI/LangGraph 服務監聽 `127.0.0.1:8090`，使用 RabbitMQ 傳遞訊息、PostgreSQL 儲存狀態，並將檔案儲存在本機，每個資料庫只執行一個處理程序。上傳、任務、資源與評分 API 均須通過身分驗證。開啟 `http://127.0.0.1:8090/` 即可使用已建置的 Web 前端；開發時可另外執行 `make web-dev`，其本機 Vite 伺服器會將 API 請求代理至獨立服務。需要 Office 支援時，僅在伺服器部署端設定 `AI_OFFICE_EXECUTABLE` 與 `AI_OFFICE_VERSION`。詳見[服務指南（英文）](server/docs/service-guide.md)。

AI 服務的 RabbitMQ 部署與升級，請參閱[傳遞與復原指南（英文）](server/docs/rabbitmq.md)。既有服務的 schema 1–4 必須先停止服務並備份，再明確執行升級至 schema 5；含有客戶任務或上傳紀錄的舊資料庫，須封存後另建個人資料庫與儲存空間。

個人自架服務共用一個存取權杖，不提供帳號、點數、儲值或付款系統。模型設定與供應商金鑰保留在伺服器端，費用由模型供應商直接收取。服務 schema 1–4 須明確執行離線升級至 5；含有客戶任務的舊資料庫須完整封存，另建個人資料庫與儲存目錄，避免個人權杖取得客戶資料的存取權。詳見[個人自架服務與升級指南（英文）](server/docs/personal-use.md)。

## 文件與開發

[文件索引（英文）](docs/README.md)依使用指南、技術參考、驗收工作表及歷史證據分類。[題型模型（英文）](docs/reference/question-model.md)說明題型與複合題規則，[文件任務 API（英文）](server/docs/document-tasks.md)說明請求內容與操作，[部署與維運（英文）](server/docs/operations.md)則說明部署、儲存與復原。

桌面檢查請在 macOS/Windows 執行 `make app-check`；Android 各開發主機的共用檢查、APK 建置與原生模擬器檢查，請參閱 [Android 指南（英文）](app/docs/android.md)。匯入 Web 前端請執行 `make web-check`，AI 服務請執行 `make verify`。Playwright Test 涵蓋雙語互動、瀏覽器預覽及豐富內容的顯示測試，使用模擬的原生指令，不會呼叫模型：

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```

測試執行器會自動啟動綁定本機回送位址的 Vite 伺服器。測試失敗時，執行追蹤與螢幕截圖會保存在 `app/test-results/browser/`；使用 `npx playwright show-trace /path/to/trace.zip` 查看追蹤紀錄。

## 取得協助與參與貢獻

請透過 [GitHub Issues](https://github.com/shenyankm/PractiQ/issues/new/choose) 回報可重現的問題或提出改善建議。程式碼與文件貢獻請參閱[貢獻指南（英文）](CONTRIBUTING.md)；安全漏洞請依[安全政策（英文）](SECURITY.md)私下回報。品質、發布、使用者試用與貢獻者工作流程中，尚未完成的驗收項目，請參閱[路線圖證據紀錄（英文）](docs/maintainers/roadmap-evidence.md)；實際進度以 GitHub 原生路線圖與子議題為準。

專案原始碼採用 [MIT 授權條款](LICENSE)，內建相依套件保留各自的[上游授權聲明（英文）](app/licenses/README.md)。
