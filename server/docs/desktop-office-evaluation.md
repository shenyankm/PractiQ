# 本机 LibreOffice 接入评估（2026-09-28）

> Historical evidence from 2026-09-28: the initial system-install evaluation and appended embedded-engine evaluation both describe retired desktop builds. Current Office import runs in the independent service; the practice app includes no LibreOffice or Python. Follow the [service Office guide](desktop-office.md), not the historical setup below.

> Archived evaluation of the initial implementation at `730a381`. Review fixes and validation for that build are recorded in [PR #70](https://github.com/shenyankm/PractiQ/pull/70); the measurements below describe the original build.

已接入桌面原生选文件、LibreOffice 检测、独立导出和确认后 AI 导入。独立服务的上传类型与解析图不变。当前场景无需引入 `python-docx`、`openpyxl` 或 Python UNO；相对现有版本，可以直接删除的大依赖为 **0**。

## 实际转换

本次使用 macOS 27.0 arm64、Python 3.14.7，以及官方 LibreOffice **26.8.0.3**。验证的是重建后 `.app` 内的私有 `office` 命令，清除了模型配置，没有启动 HTTP 服务或调用模型。LibreOffice 为临时挂载的测试程序，没有放入产品资源，也没有修改系统安装或用户的 LibreOffice 配置。

安装介质取自[官方镜像清单](https://download.documentfoundation.org/libreoffice/stable/26.8.0/mac/aarch64/LibreOffice_26.8.0_MacOS_aarch64.dmg.mirrorlist)，下载后验证 SHA-256 为 `8858d8058da4f862f47559486814e65efc27294da67c5e4bb56b006b1ee59f89`。

| 输入 | 模式 | 输出 | 耗时（秒） | 自动检查 |
| --- | --- | --- | ---: | --- |
| DOC | PDF | 3 页 | 2.322 | 通过 |
| DOC | TXT | 1 个文件 | 2.072 | 通过 |
| DOCX | PDF | 3 页 | 2.284 | 通过 |
| DOCX | TXT | 1 个文件 | 2.202 | 通过 |
| XLS | PDF | 1 页 | 1.993 | 通过 |
| XLS | CSV | 2 个工作表 | 1.972 | 通过 |
| XLSX | PDF | 1 页 | 1.990 | 通过 |
| XLSX | CSV | 2 个工作表 | 1.959 | 通过 |

八项检查全部通过，单次中位数 2.033 秒；这些是一次本机执行的观测值，不是性能基准，也不包括安装探测的耗时。检查覆盖中文和空格路径、文件完整性、输出摘要、原文件不变、表格末行、隐藏工作表、`001` 前导零、日期显示值、公式结果 `3`、打印范围内外的内容差异。另用本机 HTTP 探针检查 Word 外链图片和 Calc `WEBSERVICE` 公式，收到 **0 次**外链请求。

原始数据文件为 `server/reports/checks/office-installed.json`；PDF、TXT、CSV 和逐页 PNG 保存在 `server/reports/checks/office-installed-artifacts/`。这些本机评估输出不纳入仓库。合成输入及来源说明见 [Office fixtures](../../app/fixtures/office/README.md)，复现命令见 [使用说明](desktop-office.md)。

## 视觉观察与保真边界

渲染后的 DOCX 中，中文、章鱼图片、分式和跨页表格可见，末页包含第 069 行及结束标记。Excel PDF 遵循打印范围，仅显示可见表的指定区域；CSV 包含两张表、隐藏数据及打印范围外的行。CSV 不包含公式表达式，TXT 不保留公式和图片结构。

**DOC 样本中的分式仅显示横线，未通过该项保真验收。** 使用没有隔离安全设置的全新 LibreOffice 配置重新转换也出现相同结果，因而不能把问题归于禁用宏/外链的配置。该 DOC 是从合成 DOCX 转出的旧格式样本，本次未证明所有旧式公式/OLE 对象的兼容性；正式使用仍需核对原文和转换 PDF。转换检查通过不等于视觉内容全部保真。

初次测试发现两项实际问题并保留了失败记录：通用 headless 渲染器未加载中文字体；以表格结束的合成 DOCX 在 TXT 导出时重复输出末单元格。前者通过在 macOS 使用原生 `osx` 渲染器解决；后者被 25 MiB 限制终止，最终常规样本包含表格后的结束段落。程序仍会明确报告此类引擎失败，不会切换模式或创建 AI 任务。

## 重建前后资源清单

统计对象为 `app/src-tauri/bundled/python` 中普通文件的逻辑字节数，不计符号链接。基准是执行前已经存在的打包产物，并非从基准提交重新构建的可重复测量。完整的逐文件前后大小、增减量及目录汇总见 [office-bundle-files.json](../reports/office-bundle-files.json)。

| 项目 | 重建前 | 重建后 | 本次处理 |
| --- | ---: | ---: | --- |
| Python 资源总计 | 97,270,818 B / 92.7647 MiB | 97,302,759 B / 92.7951 MiB | 增加 31,941 B（约 31.2 KiB） |
| 普通文件数 | 983 | 984 | 增加私有 `office.py` |
| PDFium 原生目录 | 6.923 MiB | 6.923 MiB | 保留 PDF 渲染 |
| Pillow 目录 | 10.985 MiB | 10.985 MiB | 保留图像处理、视觉解析和评分 |
| `uvloop` | 1.860 MiB | 1.860 MiB | 独立精简候选，未删除 |
| `watchfiles` | 0.868 MiB | 0.868 MiB | 独立精简候选，未删除 |
| `httptools` | 0.320 MiB | 0.320 MiB | 独立精简候选，未删除 |

变化集中于私有 Office 模块、桌面启动分支、父进程监测及冻结的 Python 入口。打包元数据中没有 `python-docx`、`openpyxl` 或 UNO；没有附带 LibreOffice 程序。Python、LangGraph、模型客户端和存储依赖继续保留，Office 无法替代这些功能。最终本机 DMG 为 63,454,777 B；没有同条件 DMG 基准，因此不报告其节省比例。

## 验证结果

| 检查 | 本地结果 |
| --- | --- |
| `make verify` | 596 个测试通过，2 个 Windows 专用测试跳过；覆盖率 92%；Ruff、Pyright、锁文件、评测样本、恢复探针和 Python 构建通过 |
| `make app-check` | 172 个前端测试、96 个 Rust 测试通过；凭据交互及合成性能测试按原规则忽略；契约、格式检查、Clippy 通过 |
| 补充备份回归 | 旧设置表恢复、备份中伪造的程序路径清除测试通过；补充后 Clippy 通过 |
| 前端覆盖率 | statements 84.57%、branches 79.51%、functions 77.42%、lines 88.70%，达到现有门槛 |
| 浏览器回归 | 通过；使用原生命令模拟，覆盖无模型配置时独立导出、模式提示、历史任务、ZIP 入口及中英文桌面布局 |
| `make app-package-check` | `.app` / DMG 构建和实际打包服务检查通过；使用本机模拟模型 |
| 实际打包 Office worker | 四种格式、两种模式 8/8 通过；两个外链探针均无请求 |
| 视觉检查 | 已查看渲染页；DOC 分式保真问题见上文，不宣称全部视觉验收通过 |

自动回归还覆盖冻结程序启动外部 Office 时的库搜索路径还原、无安装、组件缺失、Windows 注册表与空格路径、损坏/加密容器拒绝、文件数量与体积上限、符号链接、输出缺失、超时、取消/父进程退出及临时快照清理；前端无法指定可执行路径/文档路径，备份不能授权程序。分表请求先落盘，断线后沿用请求 ID 恢复；未确认请求阻止重复导入，重新解析保留来源关联。原 PDF/TXT/CSV 导入、旧任务读取、备份和恢复机制继续通过现有回归。

三平台 CI 已配置安装测试用 LibreOffice；Linux/Windows 额外准备中文测试字体，并检查打包程序的实际转换；**本次没有运行远端 Windows/Linux/macOS CI**。Windows/Linux 真机行为、系统原生文件/保存对话框、平台凭据交互和更多真实用户文档仍需人工验收。本次未调用真实模型，不能据此声明 AI 提取准确率。


## 内置重构后的 macOS 验证（2026-09-28）

改为官方 LibreOffice 26.8.0（实际版本 26.8.0.3），运行资源仅来自安装包。下载锁覆盖 macOS arm64/x86_64、Windows x86_64 和 Linux x86_64；本次实际构建、执行的是 macOS arm64，未安装系统 LibreOffice。

- `make verify`：670 通过、2 个 Windows 专用测试跳过；Ruff、Pyright、22 个评估夹具、恢复探针和 Python 包构建通过，总覆盖率 92%。
- 桌面检查：213 个前端测试、125 个 Rust 测试通过（2 个原有忽略项），TypeScript、ESLint、Clippy 与共享契约检查通过；最后的 Office Rust 回归 8/8 通过。
- 中英文浏览器检查通过，确认无外部程序选择或下载入口，未配置模型仍可独立导出。
- 超时与取消由 Python/Rust 回归覆盖；未把超时注入到真实 LibreOffice 最终包中。
- 最终 `.app` 的私有 worker：DOC/DOCX/XLS/XLSX 两种模式共 8/8 通过；含中文与空格的迁移目录、只读资源通过；两个外链探针共 0 个请求。报告为 `server/reports/checks/office.json`。
- 在 macOS sandbox 拒绝所有入站/出站 IP 网络（保留本机 Unix socket）的条件下，DOCX/XLSX 的 PDF/文本四种组合通过，转换前后全部 Office 资源哈希相同且签名仍有效。报告为 `server/reports/checks/office-offline.json`，没有真实模型调用。
- 通用安装包检查通过，合成模型测试及只读重启行为正常。使用原生目录复制保留 LibreOffice 框架符号链接后，内置 LibreOffice 的 `codesign --verify --deep --strict` 通过。禁用其嵌入 Python 的字节码写入，避免可写安装目录里的缓存修改破坏签名。

普通文件逻辑体积（不重复计算符号链接）：

| 项目 | 字节 | MiB |
| --- | ---: | ---: |
| LibreOffice 资源净增加 | 801,662,388 | 764.52 |
| 完整 PractiQ.app | 931,385,365 | 888.24 |
| DMG | 360,992,576 | 344.27 |

历史未内置 DMG 的 63,454,777 B 不是同条件基准，不能据此声称精确压缩增量。当前保持完整 LibreOffice 运行目录，没有做组件裁剪。

Windows/Linux CI 已改为验证安装包内置资源并取消系统 LibreOffice 安装步骤，但本次未推送或运行远端 CI，不能声称其包已通过运行验收。尚未执行 Developer ID 发布签名或 Apple 公证；上游内置程序签名通过不等于整个 PractiQ 发布签名通过。旧 DOC 分式保真限制仍然存在。
