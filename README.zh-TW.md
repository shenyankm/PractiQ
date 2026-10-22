<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ 標誌">
</p>

# PractiQ

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

將文件轉成題庫，在 macOS、Windows 或 Android 上離線練習與模擬考。

- **匯入與複核**：用 AI 從文件中擷取題目，檢查需要複核的內容，整理自己的題庫。
- **練習與組卷**：跨題庫依題型、錯題、收藏或未作答題目挑選題目，進行練習、自我測驗或限時模擬考。
- **查看評分**：客觀題立即在本機評分，簡答題可交由 AI 評分，也可以自行調整分數。
- **儲存與分享**：下次接續上次的進度練習，備份個人紀錄，將題庫連同圖片與音訊匯出為 ZIP 分享。

應用程式提供簡體中文、繁體中文與英文介面，支援淺色與深色主題、七種基本題型，以及英語聽力、閱讀、克漏字、翻譯與寫作。練習資料只儲存在你的裝置上，不需要帳號，也不會同步到雲端。文件匯入使用你自行架設的服務，只需填寫該服務的存取權杖，不提供使用者管理或內建計費功能。

本文件採用台灣繁體中文用語；應用程式提供繁體中文介面，下列操作名稱以繁體中文介面為準。

首次啟動時，應用程式依系統語言選擇介面語言，並記住你的選擇；之後也可隨時從側邊欄切換。語言選擇會納入完整備份，日期與數字會依介面語言採用對應的地區格式。切換語言不會變更題目原文，也不會影響你的作答。

PractiQ 仍在開發中。請依[安裝](#安裝)說明從原始碼安裝，或查看 [GitHub Releases](https://github.com/shenyankm/PractiQ/releases) 了解已發布的安裝套件及其已知限制。通過建置檢查，不代表已完成簽章發布或在全新系統上試用過。

## 螢幕截圖

以下截圖取自英文介面的桌面開發預覽，題庫與練習紀錄皆為人工編寫的範例。所有資料只存放在記憶體中，未輸入憑證、上傳檔案或呼叫模型。點選圖片即可查看原始大小。

| 題庫 | 作答 |
| :---: | :---: |
| [![英文題庫首頁，包含範例題庫名稱與說明](docs/assets/screenshots/banks-en.png)](docs/assets/screenshots/banks-en.png) | [![英文作答畫面，包含選項與答案卡](docs/assets/screenshots/practice-en.png)](docs/assets/screenshots/practice-en.png) |
| **錯題** | **練習紀錄** |
| [![英文錯題清單，包含得分與所屬題庫](docs/assets/screenshots/mistakes-en.png)](docs/assets/screenshots/mistakes-en.png) | [![英文練習紀錄，包含進度與成績](docs/assets/screenshots/history-en.png)](docs/assets/screenshots/history-en.png) |

## 先試用：不需設定模型

[安裝 PractiQ](#安裝)後：

1. 「我的題庫」尚無題庫時，點選**新增範例題庫**；也可依序開啟**設定 → 匯入與還原 → 匯入題庫 ZIP**，匯入 [sample.zip](app/fixtures/sample.zip)。其他範例包括[複合題](app/fixtures/composite.zip)與[所有題型](app/fixtures/all-types.zip)。
2. 開啟題庫並點選**開始練習**，體驗即時回饋練習、不限時自我測驗或限時模擬考。
3. 提交答案，查看評分與解析。

全程不需要 API 金鑰。這些範例由人工編寫，用於展示題型與待複核標記，不代表模型的實際表現。

在題庫卡片的選單中匯出，即可產生不含個人作答與評分的 ZIP 供分享。匯入題庫會將內容加入現有題庫；還原完整學習資料備份，則會在你確認後取代個人資料。作答、草稿保護、語言設定及主動要求 AI 評分的詳細規則，請參閱[練習指南（英文）](docs/guides/practice-guide.md)；匯入與備份的範圍，請參閱[題庫套件指南（英文）](docs/guides/question-bank-package.md)。

## 使用 AI 匯入文件

文件匯入在自行架設的 AI 服務網頁中進行：

1. [啟動 AI 服務](#自架匯入服務)，開啟網頁並填入服務存取權杖（`AI_SERVICE_TOKEN`）。模型設定與供應商金鑰保留在伺服器端。
2. 一次最多選擇 10 份檔案，然後點選**开始导入**。僅選擇檔案不會上傳或解析。
3. 查看匯入進度，檢查題目、圖片、原文答案與需要複核的內容，再下載題庫 ZIP。
4. 在桌面應用程式中依序開啟**設定 → 匯入與還原 → 匯入題庫 ZIP**，建立題庫或將內容加入既有題庫。

服務透過騰訊雲的[非同步多模態文件解析](https://cloud.tencent.com/document/product/866/139312)讀取 **PDF、TXT、Markdown、PNG/JPEG、DOC、DOCX、PPT、PPTX、XLS 及 XLSX**，再由 AI 整理成題目。騰訊雲憑證請在伺服器端設定。新的匯入作業不再支援 CSV，已儲存的資料與題庫不受影響。桌面安裝套件不包含 Python 服務或 LibreOffice。

騰訊雲於首次啟用時一次提供 **1,000 頁免費額度，有效期限一年**，實際條件以[官方額度說明](https://cloud.tencent.com/document/api/866/35945)為準。各種格式的大小上限、超大檔案的切割方式與可選的私有 COS 暫存，請參閱[騰訊解析設定（英文）](server/docs/tencent-document-parser.md)。

查看紀錄、暫停、中止、接續、重試失敗部分、複核部分結果與重新解析，都在網頁中操作。查看、複核與下載結果不會呼叫模型；接續、重試與重新解析需要你主動觸發，可能產生模型供應商費用。詳見[匯入任務指南（英文）](docs/guides/import-tasks.md)與[個人自架服務指南（英文）](server/docs/personal-use.md)。

解析只擷取文件中既有的答案與評分規準，不會替沒有答案的題目作答；缺漏的內容會保留待複核標記。請在 **180 天**內下載需要保留的結果；匯入作業到期不影響已匯入應用程式的題庫。

## 使用 AI 批改主觀題

練習與本機評分可完全離線使用。需要用 AI 批改簡答題時，依序開啟**設定 → AI 服務**，選擇**直連模型 API**，填入相容 OpenAI 的 API 位址（包含 `/v1` 或供應商要求的基礎路徑）、模型 ID 及自己的 API 金鑰。macOS、Windows 與 Android 皆由應用程式直接請求模型供應商，不需要另外部署評分服務。已經在使用自行架設服務的使用者，可選擇**獨立 AI 服務**，繼續使用原有的服務位址與權杖。

批改必須有參考答案或評分規準。批改會將目前題目、相關材料、圖片與你的作答傳送給你選擇的供應商，可能產生費用。該 API 需支援 JSON 模式與輸出長度上限；含圖片的題目需要視覺模型。每次主動批改最多請求一次，逾時 120 秒，輸出上限 4,096 token。結果無效、遭拒或被截斷時維持未評分，既有分數與手動調整不受影響。結果不明時不會自動重新傳送：查看只會讀取本機紀錄，只有明確要求重新批改才會產生新的付費請求。測試連線只讀取可用模型清單，不驗證批改效果。此功能供個人練習使用，不作為正式考試的閱卷依據。

API 金鑰與服務權杖儲存在系統憑證存放區，不會納入備份。連線設定不含金鑰，與練習資料分開存放，因此練習紀錄與舊備份仍可相容。舊版應用程式無法讀取新版本儲存的設定，啟用後請繼續使用目前版本。舊有模型設定與金鑰會原樣保留，不會自動啟用。

關閉應用程式或電腦進入睡眠後，限時模擬考仍會繼續計時；回到已逾時的考試時，會依最後儲存的作答交卷。批改與考試規則的細節請參閱[練習指南（英文）](docs/guides/practice-guide.md)，備份與還原的限制請參閱[資料格式說明（英文）](docs/reference/question-model.md#versions-and-directories)。

開發模式預設使用記憶體中的範例資料；預覽面板可切換情境，或改用真實的本機資料，詳見[開發預覽（英文）](app/docs/development-preview.md)。

## 安裝

PractiQ 目前需要從原始碼安裝。你不需要自己輸入指令：開啟儲存庫根目錄，讓 AI 程式設計助理依下列提示安裝。

> 閱讀 `docs/guides/installation.md`，在這台電腦上安裝 PractiQ。先檢查環境需求，只執行適合我系統的步驟，完成後告訴我執行了哪些指令、安裝套件在哪裡，以及哪些步驟失敗。安裝系統軟體前先問我。

[安裝指南（英文）](docs/guides/installation.md)同時面向使用者與 AI 助理，包含 macOS、Windows 與 Android 的環境需求與指令、如何確認應用程式能正常啟動，以及可選的 AI 服務安裝。

應用程式支援 macOS 14+（Apple Silicon）、Windows 10/11（x64）與 Android 8+（API 26+，arm64 APK）。不提供 Linux 安裝套件，Linux 僅用於執行 AI 服務與 CI。建置檢查涵蓋 macOS/Windows 安裝套件、Android APK 與 API 35 模擬器；實體裝置、最低系統版本及簽章發布另行驗收。

桌面資料儲存在新的 `v4/` 目錄中，使用 SQLite schema 11。舊目錄（包括 `v3/`）會原樣保留，舊版完整備份不再接受，目前格式的題庫 ZIP 仍可匯入。詳見[資料格式說明（英文）](docs/reference/question-model.md#versions-and-directories)。

## 自架匯入服務

文件匯入需要自行架設的 AI 服務，離線練習則不需要。服務需要 Python 3.14+、uv、Node.js 22.12+、一個空白的 PostgreSQL 資料庫、專用的 RabbitMQ vhost，以及支援文字與圖片輸入的模型。可讓 AI 助理依[安裝指南（英文）](docs/guides/installation.md)的服務部分完成設定與啟動。

服務的部署、升級、儲存與復原請參閱[服務指南（英文）](server/docs/service-guide.md)、[傳遞與復原指南（英文）](server/docs/rabbitmq.md)與[個人自架服務指南（英文）](server/docs/personal-use.md)。既有服務的資料庫版本 1–4 需要停機備份後手動升級至 5；保存過客戶任務的舊資料庫請另建個人資料庫與儲存目錄。模型設定由你自行提供，費用直接支付給模型供應商，PractiQ 不提供計費或使用者管理。

## 文件與開發

[文件索引（英文）](docs/README.md)依使用指南、技術參考、驗收紀錄與歷史證據分類。[題型模型（英文）](docs/reference/question-model.md)說明題型與複合題規則，[文件任務 API（英文）](server/docs/document-tasks.md)說明任務請求與操作，[部署與維運（英文）](server/docs/operations.md)說明部署、儲存與復原。

桌面端的檢查請在 macOS/Windows 執行 `make app-check`；Android 各開發主機的共用檢查、APK 建置與模擬器檢查請參閱 [Android 指南（英文）](app/docs/android.md)。匯入網頁的檢查請執行 `make web-check`，AI 服務的檢查請執行 `make verify`。Playwright Test 涵蓋雙語互動、瀏覽器預覽與豐富內容顯示，使用模擬的原生命令，不會呼叫模型：

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```

測試執行器會自行啟動本機 Vite 伺服器。測試失敗時，執行追蹤與螢幕截圖會保存在 `app/test-results/browser/`；可使用 `npx playwright show-trace /path/to/trace.zip` 查看追蹤紀錄。

## 取得協助與參與貢獻

請透過 [GitHub Issues](https://github.com/shenyankm/PractiQ/issues/new/choose) 回報可重現的問題或提出改善建議。程式碼與文件貢獻請閱讀[貢獻指南（英文）](CONTRIBUTING.md)，安全漏洞請依[安全政策（英文）](SECURITY.md)私下回報。品質、發布、試用與貢獻流程中尚未完成的驗收項目，記錄在[路線圖證據紀錄（英文）](docs/maintainers/roadmap-evidence.md)，以 GitHub 上的路線圖與子議題為準。

專案原始碼採用 [MIT 授權條款](LICENSE)，內建相依套件保留各自的[上游授權聲明（英文）](app/licenses/README.md)。
