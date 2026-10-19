# PractiQ 三端截图验收

- 源码版本：`b20b937a60973d86179d03e866c6e08adbb80ce9`
- 截图总数：83 张（桌面 App 13，Android 51，Web 导入 10，响应式预览补充 9）
- 浏览入口：[打开截图图库](index.html)
- 完整清单与 SHA-256：[capture-manifest.json](capture-manifest.json)

## 采集范围

- **桌面 App：** 13 张，来自采集版本源码的 React design preview 与合成题库数据，仅包含 1024px 及以上的桌面宽度。预览检查无错误；这组不是原生 Tauri 桌面进程截图。
- **Android：** 51 张，采集时 APK 安装在 Android 15 / API 35 arm64 AVD 上逐页运行采集，分辨率 1080 × 2400；使用 `adb install -r` 保留了 AVD 数据。系统文件选择器已打开但未选中文件。
- **Web 导入端：** 10 张，覆盖 1440px 与 390px 两种宽度和导入、结果查看、下载流程。接口与 ZIP 均为合成数据，截图验收用例通过 2 项，模型启动数为 0。
- **响应式预览补充：** 9 张，单独存放在 `responsive-preview/`，来自 desktop React design preview 的平板、窄屏和横屏布局，不属于 Android 模拟器运行截图。

## 安全与数据状态

没有导入题库、启动练习、提交答案、恢复备份或调用 AI 服务。新建/编辑页面和练习设置仅用于截图，并在未保存状态下关闭。Android 服务地址与令牌字段已遮挡。其他历史证据目录未改动。
