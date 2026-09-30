# PractiQ @TAG@

> 草稿：当前自动构建产物未完成发布者签名、干净系统验收和冻结版本的真实模型验收。
> 发布前完成下列待办；预发布标记不能豁免保真度或许可证门禁。

## 本版变化 / Highlights

<!-- Replace with user-visible additions and fixes. For the first release, introduce the core workflows. Add a short English summary. -->

## 下载与安装 / Downloads

| 系统 | 最低要求 | 文件 | 最终包自动检查 | 发布者签名 | 干净系统验收 |
| --- | --- | --- | --- | --- | --- |
| macOS | macOS 14+，Apple Silicon | `PractiQ_@VERSION@_macos_arm64.dmg` | 通过 | 未签名／未公证 | 待完成 |
| Windows | Windows 10/11 x64，WebView2 | `PractiQ_@VERSION@_windows_x64_setup.exe` | 通过 | 未签名 | 待完成 |
| Linux | Ubuntu 22.04+ x64 | `PractiQ_@VERSION@_linux_amd64.deb` | 通过 | 无包签名 | 待完成 |

桌面包内置 Python AI 服务和 LibreOffice，无需另装 Python 或 Office。
Linux 需要 WebKitGTK 4.1、GStreamer 音频插件；保存 API Key 需要已解锁的 Secret Service。
GitHub 的 Source code 附件是源码，不是安装包。安装说明应分别记录实际验证的系统版本及步骤。

## 升级与数据 / Data compatibility

- 数据目录 `v4/`，SQLite schema 11；完整备份容器版本 4、schema 11。
- 题库 ZIP 版本 2，AI JSON schema 3。题库导入追加内容，完整恢复需要替换确认。
- 旧目录原样保留；旧数据库和旧完整备份不自动迁移且会被拒绝。升级前保留备份；不承诺旧版可读取新版数据。
- API Key 保存在系统凭据存储；完整备份不含密钥和 AI 任务状态。
<!-- Update these values from the tagged source whenever formats change. Describe any migration and downgrade restrictions. -->

## 已知限制 / Known limitations

<!-- List concrete limitations and failed or untested flows. Do not substitute a commit log or claim three-platform acceptance from CI. -->

离线练习无需账号。解析和 AI 评分需要用户主动操作，会向配置的模型提供方发送内容，可能产生费用。
AI 评分需要参考答案或评分细则，缺少依据或调用失败时保持未判定，仅用于个人练习。
独立服务接受 PDF、TXT、CSV、PNG/JPEG；桌面 Word/Excel 文件由内置 LibreOffice 转换。

## 验证情况 / Validation

- [x] 同一候选提交的服务、桌面、浏览器、依赖及构建检查通过；模型响应使用替代实现，浏览器 IPC 使用模拟。
- [x] 各最终安装包的内置服务、Office、严格保真度和许可证来源检查通过。
- [ ] 每个公开平台完成干净系统安装、升级／卸载、文件选择、练习、交卷、音频、凭据和备份恢复验收；填写系统、日期、结果和证据链接。
- [ ] macOS Developer ID 签名和公证、Windows 发布者签名状态已核验；附上实际结果。测试版本可以披露未签名状态，不能将其标为 Stable。
- [ ] 冻结候选版本的真实解析与评分、失败注入和代表性人工复核证据已记录，失败和限制已披露。
- [ ] 补全本版变化、安装步骤、已知限制和下方比较链接，移除占位注释。
- [ ] 从草稿下载所有附件，确认大小、SHA-256 和最终验收文件一致。

未完成项必须具体说明。正式版本只在全部适用验收要求满足后发布；测试版本只能明确披露允许延期的签名、平台／人工验收项目，严格保真度和许可证门禁不得延期。

## 开发者信息 / Provenance

- Commit: `@COMMIT@`
- Desktop: `@VERSION@`; bundled AI service: `@AI_VERSION@`
- `release-manifest.json`: 文件、大小、SHA-256、组件版本、构建链接与验收状态。
- `release-evidence.zip`: 服务及各平台最终包检查、构建清单与许可证文本。
- `SHA256SUMS.txt`: 所有其他公开附件的 SHA-256；哈希不能代替发布者签名。
- Full changelog: <!-- Link previous tag...@TAG@, or the tagged source for the first release. -->

Unsigned automated candidates have passed package gates, but CI does not establish clean-machine acceptance or live-model accuracy. Check the platform table and known limitations before installation.
