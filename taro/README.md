# PractiQ 微信小程序

这是 PractiQ 当前的 Taro 4.2.1 微信小程序基线；目前暂不保存会话或访问业务 API。

## 环境

- Node.js 24.18.0+
- npm 11.16.0
- 微信开发者工具

```bash
cp ../.env.example ../.env.local
npm ci
npm run verify
```

开发模式：

```bash
npm run dev:weapp
```

将 `dist/` 导入微信开发者工具。

## 当前边界

- 已接入：类型检查与微信小程序构建。
- 未迁移：登录、题库、练习、离线缓存、导入和购买。
- 不保留其他平台的配置或占位实现。
- 不直接复制已删除客户端的 Expo、SQLite、Expo Router、HeroUI Native 或 RevenueCat 实现。

完整顺序和验收门禁见 [`docs/taro-migration.md`](../docs/taro-migration.md)。
