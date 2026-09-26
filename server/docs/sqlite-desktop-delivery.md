# SQLite 与 macOS 桌面交付记录

> 历史报告：以下结果、包体积、哈希与依赖说明属于当时版本。当前版本已移除 Word 与 LibreOffice；导入页管理 AI 解析任务，ZIP 题库从“设置 → 恢复备份”导入。现行用法见 [项目说明](../../README.zh-CN.md) 和 [服务指南](service-guide.md)。历史证据不代表当前版本验收。

验证日期：2026-09-19。目标是 Apple Silicon macOS；本机系统 macOS 27.0，应用声明最低 macOS 14，尚未在最低版本系统验证。未提交、推送或发布，保留既有工作区修改和旧 PostgreSQL 数据。

## 本次范围

- 任务队列改为 aiosqlite，检查点与 Store 使用官方 SQLite 实现，分别位于三个数据库文件。所有服务连接使用 WAL、FULL 同步、外键和 5 秒忙等待；服务与离线维护共享 flock 独占锁。保留幂等、运行约束、预算、过期和恢复语义。
- 独立服务通过 AI_DATABASE_DIR 指定本地数据目录，显式 init-db；桌面自动初始化专用目录。旧 DATABASE_URI 明确报错，不迁移或删除旧数据。初始化中断可重试，未知库和版本拒绝接管。
- Rust 通过固定资源路径管理 PyInstaller onedir 服务，私有 stdin 传递随机令牌与 Keychain 密钥，Python 绑定随机 loopback 端口。WebView 仅使用类型化命令。退出/父进程消失触发关闭，隔离提取子进程随管道关闭退出。
- 桌面新增双模型配置、文档选择、分页任务、阶段和完成计数、失败详情、用量、暂停/继续/中断/补跑/部分结果接受，以及复用题库导入预览。配置修改停止旧服务；旧执行签名不兼容时拒绝恢复。重启后任务等待明确继续。
- 桌面 BLOB 图片逐张迁出到 SHA-256 文件，先写入并同步再提交数据库引用；先保留升级恢复副本。图片从 AI 目录复制进题库目录，练习快照不依赖 AI 保留期限。ZIP v2 包含清单、数据库和图片，保留 v1 恢复，不含 AI 任务、原文档、检查点或 Keychain 密钥。
- 按最新要求删除 Excel 源文件解析、工作表图、契约路由、评测样本与 openpyxl 依赖。XLS/XLSX 上传返回 422，文件选择器不再提供这些格式。旧 JSON/备份的废弃工作表归属字段只在桌面读取时忽略，不启用解析。历史验收记录保留并标注历史范围。

## 打包方式

Python 3.14.7、PyInstaller 6.22.3；LangGraph SQLite 3.1.1、aiosqlite 0.22.1。完整依赖锁为 server/uv.lock；实际包内分发清单位于 Contents/Resources/bundled/build-manifest.json。

完整 LibreOffice 26.2.6 arm64，固定下载地址与 SHA-256：94bb3248df074c225490a8a6d1d9dc87c7d6783dbb7a8e9f0d0c3d94348552af。保留完整上游应用、许可、第三方说明和源码获取链接；因此上游套件仍含 Calc，但 PractiQ 已没有 Excel 解析入口、实现或 Python 依赖。Word 使用内置 Writer，每次转换独立配置目录。服务容器只安装 Writer。

为保持 PyInstaller onedir 布局，使用 Tauri bundle.resources 加固定路径 Rust 子进程，而不是将可执行文件单独移入 externalBin。没有开放通用 shell 或 HTTP 命令。

复现命令：

```sh
make install-locked app-install-python AI_PYTHON=/path/to/python3.14
make app-install
make verify AI_PYTHON=/path/to/python3.14
make app-check AI_PYTHON=/path/to/python3.14
make app-build AI_PYTHON=/path/to/python3.14
/path/to/python3.14 app/scripts/check-bundle.py \
  --bundle app/src-tauri/target/release/bundle/macos/PractiQ.app/Contents/Resources/bundled
cargo test --manifest-path app/src-tauri/Cargo.toml native_keychain_roundtrip -- --ignored
```

## 工程验证

- make verify：447 项通过，覆盖率 91%；锁文件、Ruff、Pyright、23 个评测样本的结构检查、恢复探针、sdist/wheel 构建通过。没有调用真实模型。
- SQLite 回归包含初始化中断重试、重复请求、并发队列、暂停审核顺序、失败补跑、预算/未知用量、过期清理、独占锁拒绝、写锁等待、SQLITE_FULL 回滚和实际服务进程强杀后恢复。
- make app-check：9 项前端测试、10 项 Rust 测试和 Clippy 通过；默认跳过的原生 Keychain 测试另行执行通过，仅使用随机命名临时条目，测试后删除。
- Rust 检查包含 BLOB 升级、共享图片、不可变练习快照、图片损坏、ZIP 路径/链接/大小/校验和、旧备份和恢复失败保护。并非完整的断电故障矩阵。
- 实际原生界面已检查解析入口、双模型设置、缺配置提示和既有题库保留；没有修改用户模型凭据。
- 最终安装包的执行结果见 ../reports/checks/desktop-bundle.json；验证只采用本机合成模型，PATH 限制为 /usr/bin:/bin，临时 HOME，调用实际 .app 内的 Python、隔离解析器和 LibreOffice。

原始检查输出保存在 server/reports/checks/。早期整包检查曾因模型桩未覆盖工作表协议失败；该能力现已删除。一次重负载下转换超时测试失败，最终完整回归通过。失败记录不用于质量或分发承诺。

## 同负载数据库对比

基线为 cf0b1768b51ab79ac56fac1cc6cc8f75ea090646 的隔离 git archive；旧 PostgreSQL 16 使用本轮临时 Docker 容器，测试后仅删除该容器，未接触原有数据库或数据卷。使用同一 scripts/benchmark_runtime.py、相同文本、40 个任务、并发 8、模型桩每次等待 0.1 秒，交替运行 3 轮。每轮 40 次调用、40 项完成。

| 三轮中位数 | PostgreSQL 基线 | SQLite |
| --- | ---: | ---: |
| 总用时（秒） | 5.639 | 2.971 |
| 成功文档/分钟 | 425.58 | 807.85 |
| 排队等待（毫秒） | 1553.06 | 1264.11 |
| /ok P95（毫秒） | 7.35 | 3.06 |

完整逐轮数据见 ../reports/checks/sqlite-comparison.json。健康检查使用 ASGI 进程内请求；旧 PostgreSQL 经 Docker 端口，SQLite 直接访问本机文件，拓扑不同。该结果只刻画本机短文本合成负载，不能承诺真实模型吞吐、长文档容量或生产 SLO。

单轮复现：在对应源码目录安装对应依赖，用 PYTHONPATH 指向该版本的 server/src 和 server，执行当前 server/scripts/benchmark_runtime.py --output /absolute/result.json。PostgreSQL 基线另需 TEST_DATABASE_URI 指向专用可销毁测试实例；当前 SQLite 自动创建临时数据库。不要指向业务数据库。

## 本地构建产物

- app/src-tauri/target/release/bundle/macos/PractiQ.app
- app/src-tauri/target/release/bundle/dmg/PractiQ_0.1.0_aarch64.dmg
- DMG 大小：363.6 MiB；SHA-256：`28988327a2848648bb2fcdafce5bf2c711b7565b892e965bd8997ee7ac9e8b0c`。
- 实际 .app 五格式检查通过，XLSX 拒绝检查通过，鉴权、分页查询、图片 checksum 和退出清理通过。包内不含 openpyxl 或 PostgreSQL Python 后端。
- Python 与完整 LibreOffice 资源约 935 MiB；体积主要来自未裁剪的 LibreOffice 套件。

## 验收边界

本轮交付本地验证包。已修复结构纠错、桌面模型参数与诊断；保留版本正常执行 63/63、严格内容质量 60/63，尚未全部通过。高分辨率候选因完整回归失败撤回，见 [最终修复报告](../reports/evaluations/vision-fix-delivery-20260919-230113/acceptance.md)；未验证最低 macOS 14、全新系统、全部输入变体和完整断电恢复矩阵。合成模型结果不能代替题目、答案和图片关联质量。

未提供 Apple Developer ID / 公证凭据，未执行正式签名、公证或发布。scripts/sign-release.sh 提供嵌套二进制签名、应用签名、公证、staple 和 spctl 验证流程，需在有凭据的分发环境另行运行并验证。当前 .app/.dmg 不视为正式分发验收通过。
