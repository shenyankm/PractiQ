# PractiQ Desktop

Apple Silicon macOS 桌面题库与练习应用。React/Vite/shadcn/ui 提供界面，Tauri Rust 管理题库、文件、钥匙串和内置 Python 服务。离线练习无需模型；文档解析会将内容发送到用户配置的模型服务，可能产生费用。

## 开发、检查与打包

使用已有 Python 3.14+（不创建项目 `.venv`）、Node.js 22.12+、Rust 和 Xcode。首版构建架构为 arm64，最低系统版本为 macOS 14。

```sh
make install-locked app-install-python AI_PYTHON=/path/to/python3.14
make app-install
make app-bundle AI_PYTHON=/path/to/python3.14
make app-dev
make app-check AI_PYTHON=/path/to/python3.14
make app-build AI_PYTHON=/path/to/python3.14
```

`app-bundle` 使用锁定的 PyInstaller 构建 onedir Python，资源位于 `src-tauri/bundled/`，生成资源不进入 Git。依赖清单和 Python 许可说明随包保存；PDF 使用内置 PDFium 渲染。构建会清理该目录中旧版 LibreOffice 资源，不下载或依赖办公软件，也不卸载用户软件。开发解析同样使用内置 Python 服务。

Python 进程由 Rust 通过固定资源路径启动，因此使用 Tauri `bundle.resources` 保持整个 onedir 目录布局，不把 Python 可执行文件单独移动到 `Contents/MacOS`。无需通用 shell 插件或 WebView 执行权限。

产物位于 `src-tauri/target/release/bundle/macos/PractiQ.app` 和 `bundle/dmg/`。构建后验证实际应用里的资源：

```sh
/path/to/python3.14 app/scripts/check-bundle.py \
  --bundle app/src-tauri/target/release/bundle/macos/PractiQ.app/Contents/Resources/bundled
```

该检查使用本机合成模型桩，验证文本、CSV、图片、PDF、Word 拒绝、资源读取与正常退出；它不证明真实模型的识别质量。正式签名、公证流程见 `scripts/sign-release.sh`；未提供开发者证书时只是本地测试包。

## 解析与导入

从左侧“导入题库”进入统一管理页；题库或题目页的导入按钮也跳转到这里，从具体题库进入时默认追加到该题库。

- **已有题库：** 选择 PractiQ `.json`，离线导入，不需要模型配置；解析服务不可用也不影响此入口。
- **文档解析：** 支持 `.pdf`、`.txt`、`.csv` 和 `.png`、`.jpg`、`.jpeg` 图片。
- **Word：** 暂不支持 `.doc`、`.docx`。排版可能随字体和软件变化，影响题目、公式和图片位置。请在 Word 或 WPS 中“导出为 PDF”或“另存为 PDF”后上传。

1. 需要解析文档时，在设置中填写兼容 OpenAI 的 Base URL、文本模型、视觉模型和 API Key；可选择供应商地址预设。旧单模型配置不会自动补齐两种模型。
2. “导入题库”中选择原文件并明确开始。查看任务阶段、完成/失败数量及已知和未知用量；按状态执行暂停、继续、中断、失败补跑或接受部分结果。
3. 完成后“预览并导入题库”，确认警告和审核标记，再选择新建题库或追加。
4. 同页可读取已有 AI JSON 和本地图片目录，包括旧版 Word 解析生成的合法 JSON。支持裸结果和带 `result` 的任务输出；导入时忽略旧版工作表归属字段，保留题目和图片。图片按原引用的大小、摘要和格式核验。

Python 在随机 loopback 端口提供已有 API。Rust 持有随机鉴权令牌，模型密钥由 Keychain 读取，经私有 stdin 管道传入。WebView 不能访问令牌、本地 HTTP 或任意文件路径。更改模型配置会停止服务；旧任务继续受执行版本和配置签名校验。重启应用不会自动继续产生模型费用，必须点击“继续”。旧 Word 任务不再继续或补跑，会提示转 PDF 后重新导入；不删除原题库、历史任务或素材。

同一题库内重复导入相同结果会跳过；不同批次不会凭题干去重或覆盖旧题。最大 JSON 32 MiB、单图 20 MiB、单次图片 256 MiB、源文档 25 MiB。HTML 不执行，Markdown 外部资源不自动加载。

页面操作与自动加载失败统一在右下角通知，相同错误不重复堆叠。

WebP 和 GIF 不再作为源图片上传；请先转换为 PNG 或 JPEG。已有题库和备份中的历史图片仍可读取。

## 练习与存储

支持题库和题目管理、搜索、收藏、错题、七种题型、顺序/随机练习、草稿、断点续练和历史记录。没有参考答案或关键资源时不自动判错；简答与缺答案题可自评。题目编辑、删除不改变已有练习快照。

数据目录：`~/Library/Application Support/com.practiq.desktop/`。

- `practiq.sqlite`：题库、原始导入、练习快照、作答、图片元数据和非敏感设置。
- `assets/<sha256>`：不可变图片文件。先写盘和同步，再提交数据库引用。删除题目不立即删除文件，避免损坏历史快照。
- `ai/database/`：独立任务、检查点和 Store SQLite 文件；`ai/files/` 保存解析源文件和图片。
- `recoveries/`：升级/恢复前的回退副本，不自动删除。

首次升级自动将旧 BLOB 图片迁出，校验成功后才切换 schema；旧数据先保存一致性数据库副本。旧备份可继续恢复。当前 schema 为 v5。

## 备份与密钥

设置中导出 ZIP，包含清单、一致性题库 SQLite 快照和图片，解压总数据上限 512 MiB。不包含 AI 任务、原文档、检查点或 API Key。恢复前验证路径、链接、大小、schema、外键、图片摘要及题目契约；先备份当前数据，再切换数据库。恢复不修改 AI 目录或 Keychain。

API Key 按 Base URL 隔离保存在 macOS Keychain，不回显；留空保持原值，明确勾选移除才删除。地址要求 HTTPS，本机 loopback 允许 HTTP；禁止 URL 内嵌凭据、查询参数和片段。恢复到另一台机器后需重新填写密钥。

`request` 与 `ai_request` 均是类型化 Tauri 命令，不暴露通用 SQL、HTTP 或 shell 接口。`make app-check` 验证共享 AI 契约、React 交互、Rust 集成测试和 Clippy；桌面窗口与完整安装包需另行验收。

桌面 CI 在每次推送和 PR 时同时运行 Windows 与 macOS。Windows 检查共享契约、前端构建与交互、Rust 全目标编译及 Clippy；macOS 另跑完整存储/备份测试、Python 打包和安装包检查。Windows 检查不代表已支持 Windows 安装或原生运行；当前发布目标仍为 Apple Silicon macOS。源码检查不需要预先生成 `bundled` 目录，正式打包仍包含内置服务。

## 自测、模考与合并题库

从题库页“练习 / 自测 / 模考”或题目页“开始练习”进入组卷。可组合多个题库，按单选、多选、判断、填空、简答、排序、匹配筛选，并选择错题、收藏或未做题。支持顺序/随机抽取总题数、题型数量配额或手动勾选题目；不足时必须调整，不自动缩减。

考试先生成题目与分值预览。默认总分 100，各题等分；可按题型预算重新分配或逐题修改，分数精确到 0.01，之和必须等于总分。更改选题或总分需重新生成预览。导入的 sourceScore、scoringRubric、scoreSourceText 仅记录原卷依据，原卷分值不锁定本次考试分值；旧 JSON 可不提供这些字段。每道题至少 0.01 分，总分上限 100 万分。

即时练习逐题显示答案；自测/模考统一交卷后显示。模考默认 60 分钟，可设置 1–1440 分钟，最多 1000 题。休眠、后台和关闭应用均不暂停截止时间；重新进入超时考试会按最后成功保存的答案交卷。确认结束普通练习时，可选择提交草稿或记为跳过。题目快照与考试分值在开始时冻结。

交卷后，客观题本地判分。点击“AI 评分 / 继续”才逐题发送有依据的简答题作答和必要材料给已配置模型，可能产生费用。图片来自经过校验的本地资源；单次评分最多 32 张图片，原始请求最多 31 MiB。没有参考答案且没有评分细则、缺失必要材料或结构不完整的题保持未判定。AI 可给部分分；原细则满分不同时按比例换算。人工评分必须填写原因，并优先于迟到的 AI 响应。

评分进行时可停止后续题目；当前请求可能仍完成。失败或结果未知不会当作零分，重新启动不会自动评分。“继续”读取相同请求的结果，“重新评分当前题”创建新请求，可能重复收费；供应商侧不保证恰好一次调用。未完成全部评分时只显示暂定成绩。完整题目的空白作答单列未答，缺关键依据的题不自动判错。

题库页可选择至少两个库复制到新库，保留原库、重复题、收藏、素材和来源，不复制历史作答、错题状态或导入去重记录。源库删除不影响副本；历史快照和不可变图片继续保留。

备份包含考试、评分及人工改分记录；不包含服务的 `subjective-grades.sqlite` 请求缓存或模型密钥。评分是个人自测辅助，不是已校准的正式考试阅卷系统；图中或题干内混入的答案需自行复核。

本次实现与验收证据见 [EXAM_ACCEPTANCE.md](EXAM_ACCEPTANCE.md)。
