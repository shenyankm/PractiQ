# PractiQ Mobile

PractiQ 是 PractiQ 的 Expo SDK 57 移动端，保留原有品牌与原生包标识，支持 Android、iPhone 和 iPad。PostgreSQL/PractiQ REST API 是权威数据源；SQLite 保存离线缓存和待同步操作。

## 功能

- 云端注册、登录与安全会话存储
- 题库浏览、创建、收藏，题目创建、编辑和状态管理
- 在线练习、离线练习、答题同步与学习分析
- TXT、DOCX、PDF、XLSX 文档导入，离线时保留文件等待上传
- 缓存优先读取、顺序重放待同步操作、服务端幂等去重
- English、简体中文、繁體中文（由简体自动转换）与日本語（未翻译文案回退英文）界面

管理员功能只在 PractiQ Web 端提供。

## 本地开发

要求 Node.js 24.18.0+、npm 11.16.0，以及 Android Studio/Android SDK；iOS 构建还需要 macOS 与 Xcode。

```bash
cp .env.example .env
npm ci
npm start
```

按运行环境设置 `EXPO_PUBLIC_API_URL`：

- Android Emulator：`http://10.0.2.2:8080`
- iOS Simulator 或 Web：`http://127.0.0.1:8080`
- 真机：使用可从设备访问的 HTTPS API 地址

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动 Expo 开发服务器 |
| `npm run android` | 生成并运行 Android 开发构建 |
| `npm run ios` | 生成并运行 iOS 开发构建（仅 macOS） |
| `npm run lint` | 执行 Expo ESLint |
| `npm run typecheck` | 执行 TypeScript 类型检查 |
| `npm test` | 运行单元与 UI 测试 |

## 目录

```text
app/                  Expo Router 薄路由与根布局
src/practiq/         REST 客户端、认证、缓存、同步队列和云端页面
src/features/         从 PractiQ 保留的领域模块
src/database/         保留的本地数据库与迁移
assets/               PractiQ 品牌和应用商店资源
```

旧 PractiQ 本地题库不会自动上传或迁移；新移动端只同步用户在 PractiQ 账户下创建或读取的数据。会话令牌仅保存在 Expo Secure Store，不写入 SQLite、备份或日志。
