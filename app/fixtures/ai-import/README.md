# Question-type import samples

Select **all-question-types.txt** in the independent service's import Web frontend to exercise all 16 user-facing question types in one document. Starting import explicitly calls the configured model; file selection alone does not. Download the resulting question-bank ZIP and append it in the practice app under Settings > Restore backup. The source contains 24 structured question rows: six composite parents and 18 answerable rows. Parent rows are material containers, not additional questions to score. The file contains supplied answers where stated and deliberately omits answers for two writing tasks. No real-person data or externally fetched content is included.

The combined file concatenates these existing or focused regression inputs in this order. Expected structures and answers live in `server/evals/cases.json` under the listed case IDs. Use individual files to isolate a failed type; the combined file is for manual service extraction followed by offline practice acceptance and is not an extra default live-evaluation case.

| Section / case | Types | Expected content |
| --- | --- | --- |
| 1 / `text-basic` | Single choice, true/false | 2 + 3: B (5); water-freezing statement: true. |
| 2 / `text-multiple-choice` | Multiple choice | Prime numbers: A and B (2 and 3); retain multiple-choice mode. |
| 3 / `text-fill-blank` | Fill blank | 12 + 8: 20; one blank. |
| 4 / `text-grading-evidence` | Short answer, writing | Evaporation definition, 5 points and supplied rubric. The invitation sentence has no answer, score or rubric. Evaporation must have no writing/translation kind; the invitation is English writing, not translation, with no source-language direction. |
| 5 / `text-composites` | Reading, word bank, cloze, ordering, matching | Reading child: true. Word-bank gaps: A/B with parent-owned options. Cloze gap: A with child-owned options. Ordering: item IDs 1,0. Matching: 0→0 and 1→1, one-to-one. |
| 6 / `text-listening-evidence` | Listening | Listening parent plus one choice child, answer A (Nine); preserve supplied transcript and play count 2. No audio is supplied: flag missing audio; do not fabricate an audio reference. This sample does not verify audio playback. |
| 7 / `text-grammar-evidence` | Grammar fill | Gap-fill parent plus one fill child; preserve hint “read”, answer “reading”. |
| 8 / `text-sentence-selection` | Sentence selection | Word-bank parent with complete sentence options; one child, answer A, shared options and no reuse. |
| 9 / `text-paragraph-matching` | Paragraph matching | Both statements map to paragraph A; preserve full paragraph text, printed labels and many-to-one mapping. |
| 10 / `text-translation-writing` | Translation, writing | Chinese-to-English supplied translation, 10 points; English invitation, 80–120 words, 15 points, supplied rubric, no sample answer. |

For composite types, verify parent/child links, blank references, shared-option ownership and material visibility after import and during practice. For ordering/matching, compare item identity rather than printed position alone. Missing answers must remain ungraded; parent containers must not be automatically marked wrong. Preserve original review flags.

All samples are synthetic regression material. Adding them or validating their gold schema does **not** establish successful model extraction, desktop import, or practice acceptance. The prior failed native results remain recorded in `docs/ai-import-acceptance-20260929.md`.

## 全格式混合题型测试集

`formats/` 中的 **10 份 `all-types*` 文件**均包含上表 16 类题型，并增加一道带复杂公式、表格和曲线图的行列式题。预期为 **25 个结构化记录：6 个材料父项、19 个可作答项**。Excel 的富内容文字、数据表和图像是同一道题的不同表示，不应重复生成题目。

| 文件 | 公式、表格与图片的表达 |
| --- | --- |
| `all-types.txt` / `all-types.csv` | LaTeX 源码、表格文字、图的坐标与本地图片引用；无法内嵌图片，导入器不会自动读取引用路径。CSV 含带引号的多行字段。 |
| `all-types.pdf` | 4 页可检索 PDF；末页含矩阵与逆矩阵、积分、无穷级数、分段函数、4×4 表格和曲线图。 |
| `all-types-scanned.pdf` | 同样 4 页，只有扫描图像，无文字层。 |
| `all-types.png` / `all-types.jpg` | 每张均包含完整 4 页，采用 2×2 排列，1908×2698 像素。 |
| `all-types.docx` / `all-types.doc` | 全题型可编辑文字，富内容页作为嵌入图片；不把这些公式声称为原生 Word 公式。 |
| `all-types.xlsx` / `all-types.xls` | 11 个题目工作表、原生单元格数据表、嵌入富内容图像；保留完整文字和 LaTeX。 |

富内容验收重点：答案为 −2；保留矩阵二维布局、积分上下限、级数、分段条件、中文表格、单元格内的竖线、负号与科学计数法；曲线图的坐标轴、标签、网格和曲线完整可见，并关联到该题。听力仍是刻意缺少音频的回归样本，不能据此验收音频播放。写作缺失答案仍须保持缺失，不允许模型补写答案。

`formats-expected.json` 保存基础案例 ID、富内容预期、行数、图片尺寸、生成所用 Office 版本和各文件 SHA-256。`resources/preview.png` 是总览，`resources/chart.png` 是文本样本引用的图，不是独立的全题型输入。

生成脚本为 `app/scripts/build-import-corpus.py`，在 macOS 使用已有的 artifact Python（ReportLab、Pillow、pypdf、PDFium）和服务端显式配置的 LibreOffice。按[服务 Office 指南](../../../server/docs/desktop-office.md)设置 `AI_OFFICE_EXECUTABLE` 和精确 `AI_OFFICE_VERSION`；离线再生成设置 `AI_READ_ONLY=1` 与合成的 `AI_SERVICE_TOKEN=local-corpus-generation`，从仓库根目录以 `PYTHONPATH=server/src` 运行该脚本。它会覆盖该测试集的生成文件，须显式再生成并核对源文件、版本和校验和；无需真实模型，不增加产品依赖。运行后用 `server/tests/test_import_corpus.py` 检查交付文件。Office 的分页由格式和转换器决定，可能附带空白页；验收以完整内容为准。

本轮已在 macOS 使用打包的 Office worker 验证 DOC/DOCX/XLS/XLSX → PDF，并检查渲染结果。真实模型重跑已完成，结果为 **6 份失败、4 份部分成功、完整通过 0/10**；详见[中文验收报告](../../../docs/ai-import-all-formats-acceptance-20260929.zh-CN.md)。原生 Office 公式、跨页表格、合并单元格等专项仍使用 `app/fixtures/office/` 与 `app/fixtures/rich-content/`，避免混合测试替代专项回归。

修复后的全格式复测及缺失内容导出规则见 [中文修复报告](../../../docs/ai-import-repairs-20260929.zh-CN.md)。缺失不阻断导出，不等于完整识别通过。
