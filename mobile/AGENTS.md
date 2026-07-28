# PractiQ Mobile Agent Guide

## Runtime and Verification

- Use Node 24.18.0+ and npm 11.16.0; install with `npm ci`.
- Before changing Expo or React Native code, use the exact Expo SDK 57 documentation.
- Verify with `npm run typecheck && npm test`; run `npm run lint` for changed UI code.
- Use `npm start`, `npm run android`, and `npm run ios` for local development.

## Application Boundaries

- Preserve `index.ts` import order: `src/polyfills` must load before `expo-router/entry`.
- Expo Router routes and startup live in `app/`; PractiQ mobile behavior lives in `src/practiq/`.
- PostgreSQL through the PractiQ REST API is authoritative. `practiq-cache.db` contains only cached responses and the mutation outbox.
- Route replayable writes through `mutateOrQueue`; keep outbox replay sequential and preserve its `Idempotency-Key`.
- The retained PractiQ database is not uploaded or migrated into PractiQ automatically.
- Use HeroUI Native and keep `global.css`, `metro.config.js`, and the root provider aligned.

## Security and Native Builds

- Cloud session tokens belong only in Expo Secure Store, never in SQLite, app config, backups, or logs.
- Production API traffic must use HTTPS. Keep redirects rejected and validate all server response shapes at trust boundaries.
- `ios/` and `android/` are ignored Expo CNG outputs. Make durable native changes through `app.json` or config plugins.
