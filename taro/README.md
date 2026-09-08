# PractiQ Taro client

This package targets the WeChat Mini Program. It uses Taro 4.2.1, React 18, TypeScript, Vite, plain CSS, and the native Mini Program tab bar. H5 is available only for layout previews; real login and production behavior must be tested in WeChat.

## Implemented pages

- `pages/login/index`: user-triggered `Taro.login()` and `POST /api/v1/auth/wechat-login`.
- `pages/home/index`: `GET /api/v1/analytics/me/snapshot`, with loading, empty, error, retry, and pull-to-refresh states.
- `pages/banks/index`: mine/favorites segments backed by `GET /api/v1/banks`, with refresh, cursor pagination, and stale-response rejection.

`home` and `banks` use the native tab bar. Details, creation, editing, favorite writes, profile, privacy, and the remaining PRD pages are not registered as placeholders.

Access and refresh tokens are held only by `MemorySessionStore`; the client never writes them to Mini Program storage. A near-expiry access token or the first `401` triggers a single-flight refresh. Refresh failure, an inactive user, or a second `401` clears the session and reopens login. Logout notifies the API when possible and always clears local memory.

## Commands

```bash
npm ci
npm run dev:weapp
npm run dev:h5
npm run build:weapp
npm run upload:weapp
npm run test
npm run typecheck
npm run verify
```

`dev:weapp` and `build:weapp` read `../.env.local`. Taro exposes the `TARO_APP_*` variables according to its mode rules. Every production build requires an HTTPS `TARO_APP_API_URL`; the test build uses `.env.test`. At build completion, `TARO_APP_ID` is written to `dist/project.config.json`, so `taro/dist/` can be imported directly in WeChat DevTools.

The default `touristappid` supports build and visual checks but not real WeChat identity exchange. For live login, configure a real AppID in both `TARO_APP_ID` and the backend `WECHAT_APP_ID`, plus `WECHAT_APP_SECRET` on the backend.

`upload:weapp` first creates a production WeChat build and then uploads it with the official `miniprogram-ci` package. Configure an HTTPS `TARO_APP_API_URL`, `WECHAT_CI_PRIVATE_KEY_PATH`, and optionally `WECHAT_CI_ROBOT`, `WECHAT_CI_VERSION`, and `WECHAT_CI_DESC` in `../.env.local`. Generate the upload key and configure the IP allowlist in WeChat Public Platform under Management → Development Management → Development Settings → Mini Program Code Upload. Never commit the upload key.

## Dependency audit note

With the committed lockfile, `npm audit --omit=dev` currently reports 10 upstream findings (6 moderate, 1 high, 3 critical) through Taro 4.2.1, Vite 4, esbuild, and the H5-only Swiper dependency. The suggested automated fixes downgrade Taro or require an incompatible Vite major, so no forced audit fix is applied. The generated WeChat output was checked: it contains Taro's native `Swiper` component metadata, but does not emit the H5 Swiper package implementation or `webpack-dev-server`. Reassess these advisories when Taro supports updated compatible dependencies.
