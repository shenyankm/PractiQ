# 文档导入验收报告（2026-10-15）

本轮完成了真实模型调用、固定大文件导入、来源核对、重复题处理和原生 SQLite 导入验证。**工程检查通过，严格提取质量门未通过；最终 99 次回归因用户要求停止而未完成。** 本报告记录已产生的证据，不将任务完成、结构化响应通过或 ZIP 导入成功等同于提取质量通过。

用户停止后仅整理既有档案；没有追加模型调用、优化或测试。以下链接均相对于仓库文件。`server/reports/checks/` 是保留的本地忽略档案，详细链接供完整工作区复核，不表示原始档案已经发布到公共仓库。

可公开复核的计算口径见[机器摘要](evidence/import-20261015-summary.json)；简历表述见[量化指标说明](import-resume-metrics-20261015.md)。本报告不构成发布、远端 CI 或生产部署验收。

## 四类文件的答案匹配结果

下表按本轮默认保留重复题时的**最高已观测严格答案匹配值**整理。四行来自不同阶段、不同源码快照，各文件各运行一次；它们不是同一最终版本的四格式正式验收。计分包含本应保留为 `null` 的答案，也要求严格题目对齐，不能表述为“有参考答案的正确率”或“整文质量通过率”。

| 格式与固定规模 | 阶段 | 严格答案匹配 | 其中应为 null 的匹配 | 严格结构匹配 | 实际文档状态 | 质量门 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| TXT，100,000 Unicode 字符 | [S5](../reports/checks/import-optimization-20261014/quality/s5-large-text-preserve-independent.json) | **432/432，100%** | 48/48 | 362/432，83.80% | SUCCEEDED | FAILED |
| Excel，1,000 数据行 | [S6](../reports/checks/import-optimization-20261014/quality/s6-large-xlsx-preserve-independent.json) | **750/751，99.87%** | 83/83 | 628/749，83.85% | SUCCEEDED | FAILED |
| DOCX，100 页，经默认 PDF 归一化 | [S9](../reports/checks/import-optimization-20261014/quality/s9-large-docx-pdf-preserve-independent.json) | **202/212，95.28%** | 23/23 | 155/221，70.14% | PARTIAL | FAILED |
| PDF，100 页 | [S7](../reports/checks/import-optimization-20261014/quality/s7-large-pdf-preserve-independent.json) | **193/212，91.04%** | 23/23 | 143/230，62.17% | PARTIAL | FAILED |

这些百分比不能相加、取平均或改称整体生产准确率。答案字段匹配较高，仍可能存在材料角色、父子关系、共享选项、顺序题项目、题干表示及来源保留问题。原始 gold、scorer 6.2.0 和失败门槛均保留。

严格题干对齐与独立来源核对是两个口径。例如 S9 DOCX 的严格答案匹配为 202/212；来源核对确认已保存的 187 个有源答案均正确，但完整来源实际提供 189 个答案，因此完整来源口径为 **187/189**。该补充结果不替换严格质量门。详见[来源字段报告](../reports/checks/import-optimization-20261014/quality/s9-docx-pdf-full-source-fidelity-review.json)。

## 测量范围与完整性

模型请求配置为 `deepseek-v4.1-flash`，使用实际 Responses API；返回的 `deepseek-flash` 别名未独立验证具体权重版本。任务通过实际 loopback HTTP、独立 PostgreSQL/RabbitMQ、文件存储、持久化结果和 ZIP 导出执行。模型输入为固定合成语料，不是生产用户样本。

| 语料 | 固定分母 | 用途与限制 |
| --- | --- | --- |
| 原始 S0 正式矩阵 | 33 份文档 × 3 = 99 次；其中 96 次正常输入、3 次预期损坏输入拒绝 | TXT、CSV、PDF、图片；历史严格整文质量通过 80/96，**83.33%**；整体门 FAILED |
| S1 定向复测 | 9 份既有失败文档 × 3 = 27 次 | 失败筛选样本，不能替代完整矩阵的通过率 |
| 大文件固定语料 | 4 文件，2,142 节点、1,607 可作答叶题 | TXT 576/432、DOCX 283/212、PDF 283/212、XLSX 1,000/751；每阶段每文件一次 |
| 最终 MAIN99 | 99 次计划，12 条完整记录、1 条未完成记录 | 用户中断；**不能作为完整 99 次正式评估** |
| 独立 S9b PDF 复测 | 1 次计划 | 未执行，停止后取消 |

TXT 的规模是 100,000 **Unicode 字符**，不是 100,000 个汉字；Excel 有 1,000 数据行和一个表头。DOCX/PDF 均已核实为 100 页、每页两个根任务，其题目内容同源，不是两个独立题目总体。四文件均涵盖普通与英语复合题型，并包含非相邻重复题和答案、选项、分值不同的近似题。参见[冻结语料 manifest](../reports/checks/import-optimization-20261014/corpus/manifest-large.json)及[来源与重复组 gold](../reports/checks/import-optimization-20261014/corpus/dedup-source.json)。

S0 的有源答案字段正确为 **143/147，97.28%**，39/39 次缺失答案保留 null；历史结构评分为 47.14%。这些分母与上表的大文件答案匹配不同。最终 MAIN99 叫停，因此本轮**没有证据宣称整体质量相对 S0 提升或完成非回归验收**。参见[S0 完整报告](../reports/checks/live-import-responses-20261014/report.md)。

## 大文件与重复题处理

去重布尔选项默认 **false**，此时仅识别重复候选、保留所有解析出的题目。用户在导入前选择是否删除已确认副本，第一次显式 **Start** 一并携带该选项；该选择按本次导入冻结。显式开启选项的试验以另行冻结的删除后 gold 评分，不能将默认保留的副本视为自动删除成功。

| 已完成的显式删除试验 | TXT | XLSX |
| --- | ---: | ---: |
| 原始来源节点 | 576 | 1,000 |
| 删除前实际解析节点 | 574 | 1,000 |
| 实际删除的已核实重复节点 | 8 | 7 |
| 删除后保存节点 | 566 | 993 |
| 完整来源预期删除后节点 | 568 | 992 |
| 观察到的误删节点／部分复合树删除 | 0／0 | 0／0 |
| 仍保留的应删除重复节点 | 0 | 1，物理题号 625 |
| 保护的近似变体对 | 1/1 保留 | 1/1 保留 |
| 严格／来源人工复核／并集识别的重复对 | 6/6；6/6；6/6 | 4/6；6/6；6/6 |
| 真实已知调用 | 65 | 82 |
| 最终文档状态／严格质量门 | PARTIAL／FAILED | SUCCEEDED／FAILED |

两文件实际删除节点中，**15/15 为正确来源重复节点，删除了计划 16 个重复节点中的 15 个**。这是两份合成文件的观察，不是总体“零误删”保证。TXT 在删除前已经缺失两个节点，不能归因于去重；XLSX 的来源人工候选也不自动获得删除资格。原严格删除验收分别为 TXT 答案 424/426、结构 376/426；XLSX 答案 745/745、另保留一个重复叶题、结构 627/743，质量门仍 FAILED。

原转换器因保留题目的 `confidence` 从 0.95 变为 0.9 而标记 NOT_ASSESSED，原输出未修补。补充来源审查核对了实际删除身份及其余保留字段；这不等同于证明全部 groups、visuals、资源重映射和整文质量通过。两个 ZIP 均已有 CRC 和最终 detail 一致性核对。详见[停止后的显式删除归档](../reports/checks/import-optimization-20261014/quality/s9-optin2-stopped-final-review.md)及[独立节点删除审查](../reports/checks/import-optimization-20261014/quality/s9-optin-completed-node-removal-independent-review.json)。

100 页 DOCX 的 S9 试验虽然 100 个页单元均通过逐调用校验，最终合并仍丢弃第 **16 页的题号 44、45、46**，保存 280/283 节点。该页共享选项子题缺少 parentId，父材料也未形成合法 typed passage。三个缺失节点发生于合并，不是去重。S7 PDF 同样为 PARTIAL，不能用页单元通过数代替完整文档验收。详见[DOCX 合并诊断](../reports/checks/import-optimization-20261014/quality/s9-docx-pdf-unit15-postmerge-failure-diagnosis.json)。

## 原生导入与源忠实度

| 实际默认导出产物 | ZIP 大小 | 原生临时 Store 往返 | 验证的范围 |
| --- | ---: | ---: | --- |
| [S5 TXT](../reports/checks/import-optimization-20261014/app/s5-text-native-summary-20261014.md) | 67,197 B | 3/3 | 576 节点、432 叶题，保留 384 个非空及 48 个空答案 |
| [S6 XLSX](../reports/checks/import-optimization-20261014/app/s6-xlsx-native-summary-20261014.md) | 91,510 B | 3/3 | 1,000 节点、751 叶题；非空答案数不等于答案正确数 |
| [S9 DOCX PARTIAL](../reports/checks/import-optimization-20261014/app/s9-docx-native-summary-20261014.md) | 177,011 B | 3/3 | 保存的部分题库及一个 205,136 B 未解析原页 PNG |
| [S7 PDF PARTIAL](../reports/checks/import-optimization-20261014/app/s7-pdf-native-summary-20261014.md) | 121,692 B | 3/3 | 保存的部分题库及一个 149,583 B 未解析原页 PNG |

往返核对 15 个选定来源字段、warnings、每题来源关联，检查 SQLite 提交、关闭重开、资源 SHA/大小和同 ZIP 重复导入零新增。每行是**一个既有模型产物导入三个新 Store**，不是三个独立模型试验。原生通过证明 App 保留实际输出，不证明输出相对来源正确，也不构成浏览器、picker、IPC、WebView 或三平台手工验收。

两份部分题库的原页 PNG 均为 `questionIds=[]`；资源字节保存通过不能称为成功题图裁剪或语义题图关联。TXT/XLSX 无资源，不提供非空图像资源的证据。

另有在复测前密封的 4 文档 × 3 = **12 次源忠实度诊断**，分别检查 detail 与自身 ZIP，共 24 个视图：完整 typed 材料、翻译/写作角色、整组 matching 项目及保存裁图的源像素边界。`sourceText` 出处引用、后台 PNG 或模型 complete 标志不代替练习材料。最终 MAIN99 中断后，该工具**未运行**，不能声称最终材料和裁图通过。历史 S1 自检仍保留：PDF 三次均只有 0/72 typed observations，唯一保存裁图漏掉数字 4 的 9 个源墨迹像素。该单图诊断还缺独立完整 JPEG 正例和语义题图关联 gold，不构成整体视觉准确率。

实际 PDF 中提供的解释为 12 项；149、173 是题号而非分母。S7 保存 10/12，S8 保存 12/12。源格式核对下，S7/S8 rubric 均为 32/34 字面一致、34/34 去除诊断空白后同词；不据此宣称 rubric 文字丢失，且不改原严格评分。参见[字段分母澄清](../reports/checks/import-optimization-20261014/quality/s7-s8-source-field-projection-clarification.md)。

## 阶段账目与停止范围

下表统计各阶段新增的真实调用，**不能累加每份 report 内的累计 budget**。已知用量包括失败校验、纠正和截断响应；unknown 始终单列。

| 优化阶段 | 新增实际调用 | 已知／未知 | 主要结果 |
| --- | ---: | ---: | --- |
| S1 定向复测 | 45 | 45／0 | 27 次：25 SUCCEEDED、2 PARTIAL |
| S1b 大 TXT | 16 | 16／0 | 四粗块、四次尝试均截断，无最终题目 |
| S2a XLSX 启动 | 0 | 0／0 | 环境启动失败，未准入 |
| S2a XLSX 重试 | 8 | 8／0 | PARTIAL，41 节点 |
| S2b 大文件 | 60 | 59／1 | TXT、DOCX text 完成；PDF 暂停；XLSX 未运行 |
| S3 XLSX／TXT | 74＋39 | 74＋39／0 | 保存 1,000／576 节点；质量门 FAILED |
| S4 XLSX | 116 | 115／1 | 1,800 秒截止，无最终 detail/ZIP；空评分集不能算通过 |
| S5 TXT | 55 | 55／0 | 默认最高 TXT 答案匹配；质量门 FAILED |
| S6 XLSX | 78 | 78／0 | 默认最高 XLSX 答案匹配；质量门 FAILED |
| S7 PDF | 109 | 109／0 | PARTIAL，质量门 FAILED |
| S8 DOCX PDF | 106 | 106／0 | PARTIAL，合并丢八节点；质量门 FAILED |
| S9 PDF | 25 | 24／1 | 第 23 页未知用量，PAUSED，最终 result/status 为 null、无 ZIP |
| S9 DOCX PDF | 107 | 107／0 | PARTIAL，丢三节点；质量门 FAILED |
| S9 显式删除 TXT＋XLSX | 147 | 147／0 | 两任务完成，严格质量门 0/2、FAILED |
| S9 MAIN99 中断 | 15 | 14／1 | 12 完整记录＋1 未完成记录；完整正式回归未完成 |
| **优化总计** | **1,000** | **996／4** | 用户停止；保留所有未知与中断记录 |

| 记账口径 | 实际请求 | 已知／未知 | 已知输入 tokens | 已知输出 tokens |
| --- | ---: | ---: | ---: | ---: |
| 优化及停止时中断 | 1,000 | 996／4 | 11,042,841 | 2,823,708 |
| 独立 S0：3 协议探测＋4 烟测＋116 正式调用 | 123 | 123／0 | 957,946 | 59,935 |
| **合并记账，非质量样本分母** | **1,123** | **1,119／4** | **12,000,787** | **2,883,643** |

四条 unknown 的实际输入、输出和费用都未确定；不能记成零或免费。新的独立任务、`blocked=null` 或终止进程不代表旧调用已结算。合并已知 token 数只是已知部分；保守预算 reservation 不计入实际用量。账单使用合成整数点费率，**货币成本为 null**，没有依据报人民币、美元成本或节省比例。MAIN99 终止时的在途调用保留为未知，未自动重放或恢复；S9b PDF 未执行。

停止后的 PostgreSQL 只读归档保存 **15 条 MAIN 调用 receipt：14 settled、1 pending**；在途项为 dispatched、usage=null，且无对应模型扣款。另保留 12 个已完成 run 和一个未完成 run。独立 S0 的 123 次请求与优化阶段分别记账。原账本容器已停止而未删除，数据库压缩归档 SHA-256 为 `a9bad46ddea02e3bdf859c61a660b52242e0e1f745507e7ce5829c0843e506d1`。参见[停止时记账报告](../reports/checks/import-optimization-20261014/quality/user-stopped-campaign-accounting-20261015.json)及[只读账本快照](../reports/checks/import-optimization-20261014/quality/stopped-run-archive/main99-accounting-snapshot.json)。这保留未知状态，不代表最终用量已补齐或允许继续模型工作。

## 工程检查与可引用边界

| 已有检查 | 结果 | 证据及边界 |
| --- | --- | --- |
| 最终 S9 `make verify` | **2,468 passed，516.10 秒** | [封存摘要](../reports/checks/import-optimization-20261014/quality/verify-s9-final-artifacts/summary.json)；模型替身和确定性恢复检查，非真实模型质量 |
| Python 行／分支覆盖 | **6,519/6,889，94.63%**／2,292/2,554，XML rate 0.8974 | 原始 coverage XML 保留；未因停止而重测 |
| 服务源码与包 | 39 个 Python 文件在源码、S9 快照、wheel、sdist 中字节一致 | [独立包核对](../reports/checks/import-optimization-20261014/quality/final-phase-offline-s9-evidence-proof.json)；本地构建，不表示已发布或远端 CI 通过 |
| App 前端 | **392 passed，1 skipped** | [原日志](../reports/checks/import-optimization-20261014/app/final-app-check.log) |
| 主机 Rust | **185 passed，12 ignored** | 同一原日志；不当作 Windows/Android 真机验收 |
| Web 前端 | **85 passed** | [原日志](../reports/checks/import-optimization-20261014/app/web-opt-in-dedup-check.log)；停测后未追加 |

本报告可用于说明固定文件规模、可复核评测体系、已知调用账目、原生持久化和工程检查。简历中的质量数字必须保留格式、阶段和分母；上表是历史最佳观测，不是最终总体提升。不能据本轮声明整体生产准确率、稳定完成全部 100 页、完整 MAIN99 验收、普遍零误删、最终裁图完整、货币节省或生产 P95。单文件运行与原生单次操作耗时均是 n=1 观察。

清理仅移除本轮生成的冗余自检产物和缓存：**546 文件、6,306,435 B**，包含 70 个缓存文件及 9 个本地替身自检目录的内容。真实模型 stage、来源文件、gold、原始 ZIP/PNG、日志、失败与账本记录、源码快照和包验证证据均保留，见[清理清单](../reports/checks/import-optimization-20261014/quality/cleanup-manifest-20261015.json)。

此次新增公开文档不包含账号、凭据、私人绝对路径或生产数据库内容；私人账本和原始调用档案继续保留在本地忽略目录。
