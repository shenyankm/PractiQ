# OpenWook Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove current production blockers and security risks, then converge OpenWook’s data layer, routing structure, and delivery pipeline onto the actual product architecture.

**Architecture:** Keep Next.js App Router, direct HeroUI usage, `lib/openwook/*` as the primary server-side domain layer, and `db/*/*.sql` as the authoritative product schema. Fix the highest-risk issues first, then progressively split oversized modules and formalize the database and deployment workflows.

**Tech Stack:** Next.js 16 App Router, TypeScript, HeroUI, postgres.js, Drizzle ORM, PostgreSQL, Redis, BullMQ, Vitest, ESLint.

## Global Constraints

- Keep App Router as the routing model; do not regress to Pages Router.
- Keep direct HeroUI component usage; do not add a local wrapper component layer.
- Keep server-only business logic in `lib/openwook/*` and preserve `import 'server-only'` where relevant.
- Treat `db/*/*.sql` as the authoritative product schema unless and until the repo is fully re-aligned to a regenerated Drizzle schema.
- Prefer narrow, source-level fixes over broad refactors while closing P0 issues.
- Every task must end with targeted verification commands and a clean result before moving on.

---

## Priority-Ordered Remediation Backlog

### P0 — Must fix first

#### Task P0-1: Unblock production build

**Files:**
- Modify: `app/pricing/page.tsx`
- Test: `app/pricing/page.tsx`

**Why first:** `pnpm build` currently fails, which blocks production deployment and invalidates the repo’s `verify` script.

**Execution checklist:**
- [ ] Replace HeroUI `Button asChild` usage with a supported HeroUI/Next Link composition.
- [ ] Keep the public pricing page behavior identical.
- [ ] Re-run production build.

**Verify:**
- Run: `pnpm build`
- Expected: build passes this file without the `ButtonRootProps` / `asChild` type error.

---

#### Task P0-2: Fix host-header/open-redirect trust boundaries

**Files:**
- Modify: `proxy.ts`
- Modify: `lib/openwook/request-origin.ts`
- Test: `tests/proxy.test.ts`
- Test: `tests/request-origin.test.ts` (create or extend if absent)

**Why first:** Current redirect/origin logic trusts `Host` / `X-Forwarded-*` values directly, which is a real security issue.

**Execution checklist:**
- [ ] Introduce one canonical trusted origin source (prefer `NEXT_PUBLIC_APP_URL` or a dedicated `APP_ORIGIN`).
- [ ] Make unauthenticated redirects derive from the canonical origin or a validated allowlist, not raw forwarded headers.
- [ ] Make same-origin checks compare against the canonical origin or a validated allowlist.
- [ ] Add tests for hostile forwarded host/proto input.

**Verify:**
- Run: `pnpm test tests/proxy.test.ts tests/request-origin.test.ts`
- Expected: redirect and origin-validation tests pass; no redirect uses untrusted host header input.

---

#### Task P0-3: Converge on one PostgreSQL client/pool

**Files:**
- Modify: `lib/openwook/db.ts`
- Modify: `lib/db/drizzle.ts`
- Check: `lib/db/queries.ts`

**Why first:** The repo currently creates two independent postgres.js clients/pools.

**Execution checklist:**
- [ ] Pick one postgres.js client initialization point.
- [ ] Reuse that client in both the raw SQL layer and the Drizzle layer.
- [ ] Keep telemetry and slow-query logging behavior intact.
- [ ] Confirm existing imports continue to work.

**Verify:**
- Run: `pnpm lint`
- Run: `OPENWOOK_SKIP_DB_TESTS=1 pnpm test`
- Expected: lint/test pass with no import/runtime regressions.

---

#### Task P0-4: Resolve database source-of-truth split

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/queries.ts`
- Modify: `drizzle.config.ts`
- Check: `db/*/*.sql`
- Check: `docs/system-design.md`

**Why first:** The current Drizzle schema/queries still model starter team tables while product truth lives in `db/*/*.sql`.

**Execution checklist:**
- [ ] Choose and document the path forward: align Drizzle to product schema (recommended) or explicitly retire product-facing Drizzle usage.
- [ ] Remove invalid assumptions like `users.deletedAt` / `users.name` where they conflict with the split SQL files.
- [ ] Ensure `drizzle.config.ts` does not point at a knowingly stale schema.
- [ ] Update docs if the chosen ownership model changes.

**Verify:**
- Run: `pnpm lint`
- Run: `OPENWOOK_SKIP_DB_TESTS=1 pnpm test`
- Run: `pnpm build`
- Expected: no code path relies on columns/tables that do not exist in the product SQL schema.

---

### P1 — High-value structural work

#### Task P1-1: Split the catch-all API route by resource

**Files:**
- Modify: `app/api/v1/[[...path]]/route.ts`
- Create/modify: resource-specific route files under `app/api/v1/*`
- Test: existing API route tests under `tests/`

**Execution checklist:**
- [ ] Move bank endpoints into `app/api/v1/banks/...`.
- [ ] Move question/group endpoints into their own route trees.
- [ ] Move practice/import/media/analytics endpoints into their own route trees.
- [ ] Leave only compatibility glue temporarily if needed, then remove it.

**Verify:**
- Run: `OPENWOOK_SKIP_DB_TESTS=1 pnpm test`
- Run: `pnpm build`
- Expected: existing API tests remain green; route organization becomes resource-local.

---

#### Task P1-2: Split `lib/openwook/services.ts` by business domain

**Files:**
- Modify: `lib/openwook/services.ts`
- Create: `lib/openwook/services/*.ts`
- Test: `tests/services.test.ts` and related feature tests

**Execution checklist:**
- [ ] Extract bank services.
- [ ] Extract question/group services.
- [ ] Extract practice/import/analytics/media services.
- [ ] Keep exported public signatures stable while splitting.

**Verify:**
- Run: `OPENWOOK_SKIP_DB_TESTS=1 pnpm test tests/services.test.ts`
- Run: `pnpm build`
- Expected: service call sites remain unchanged while the implementation surface gets smaller and clearer.

---

#### Task P1-3: Shrink `lib/db/ensure-openwook.ts` to true bootstrap-only work

**Files:**
- Modify: `lib/db/ensure-openwook.ts`
- Check: `db/*/*.sql`
- Check: Drizzle migration strategy

**Execution checklist:**
- [ ] Classify each current `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS` as either one-time migration debt or still-required bootstrap.
- [ ] Move long-lived schema ownership into formal migrations/schema files.
- [ ] Leave only minimal environment bootstrap or emergency reconciliation logic.

**Verify:**
- Run: `pnpm lint`
- Run: `pnpm build`
- Expected: the runtime ensure script is no longer the de facto schema manager.

---

#### Task P1-4: Optimize analytics hotspots and group analytics view usage

**Files:**
- Modify: `lib/openwook/services.ts` (or split analytics module)
- Modify: `db/study-groups/80_study_group_analytics.sql`

**Execution checklist:**
- [ ] Cache high-cost bank analytics queries behind existing Redis version-key patterns.
- [ ] Ensure group learning analytics queries are always filtered by `group_id` and `bank_id`.
- [ ] Evaluate whether the dynamic study-group view should stay a view or move to a materialized/snapshot strategy as data grows.

**Verify:**
- Run: targeted analytics tests if present
- Run: `OPENWOOK_SKIP_DB_TESTS=1 pnpm test`
- Expected: no regression in analytics responses; expensive scans are reduced or bounded.

---

#### Task P1-5: Investigate and remove NFT tracing warnings from the build

**Files:**
- Check/modify: `lib/openwook/object-storage.ts`
- Check/modify: any importing server actions/pages in the build trace
- Check: `next.config.ts`

**Execution checklist:**
- [ ] Trace the import chain causing `next.config.ts` / whole-project NFT warnings.
- [ ] Narrow or isolate filesystem/path operations from render-time server component graphs.
- [ ] Apply static scoping or `turbopackIgnore` only if justified by the actual warning source.

**Verify:**
- Run: `pnpm build`
- Expected: current NFT tracing warnings are eliminated or reduced with a documented reason.

---

#### Task P1-6: Add repo-local CI for the actual verification path

**Files:**
- Create: `.github/workflows/*.yml` (or the chosen CI provider equivalent)
- Check: `package.json`

**Execution checklist:**
- [ ] Add a basic CI workflow that runs install, lint, non-DB tests, and build.
- [ ] Keep the first workflow small and deterministic.
- [ ] Add a second integration lane later only if the DB/Redis setup becomes stable.

**Verify:**
- Manual dry run or YAML validation
- Expected: the repo has an explicit automated path for `pnpm lint`, `OPENWOOK_SKIP_DB_TESTS=1 pnpm test`, and `pnpm build`.

---

### P2 — Medium-term hardening

#### Task P2-1: Split server-only and public env access

**Files:**
- Modify: `lib/openwook/env.ts`
- Modify: `lib/openwook/env.server.ts`
- Create: `lib/openwook/env.public.ts`

**Execution checklist:**
- [ ] Move sensitive variables behind `server-only` imports.
- [ ] Expose only `NEXT_PUBLIC_*` values to shared/public modules.
- [ ] Decide which env vars should be required at startup instead of optional.

**Verify:**
- Run: `pnpm lint`
- Run: `pnpm build`

---

#### Task P2-2: Add Redis-enabled integration coverage

**Files:**
- Modify: `tests/setup.ts`
- Create/extend: tests for auth rate limits, cache invalidation, queue/event behavior

**Execution checklist:**
- [ ] Keep the default no-Redis fast test mode.
- [ ] Add an opt-in Redis-backed test lane for behavior that currently only runs in fallback mode.

**Verify:**
- Run: the Redis-enabled test command/lane once introduced

---

#### Task P2-3: Tighten TypeScript compiler settings gradually

**Files:**
- Modify: `tsconfig.json`

**Execution checklist:**
- [ ] Add `noImplicitReturns`.
- [ ] Add `noUnusedLocals` / `noUnusedParameters`.
- [ ] Evaluate `exactOptionalPropertyTypes` last.
- [ ] Fix newly surfaced violations incrementally, not all at once.

**Verify:**
- Run: `pnpm lint`
- Run: `pnpm build`

---

#### Task P2-4: Revisit HTTP caching for safe public read endpoints

**Files:**
- Modify: selected route handlers / response helpers if needed
- Check: `lib/openwook/observability.ts`

**Execution checklist:**
- [ ] Identify truly public, low-risk read endpoints.
- [ ] Decide whether HTTP/CDN caching should complement the current Redis cache-aside layer.
- [ ] Override the default `no-store` only where the data model and invalidation semantics are safe.

**Verify:**
- Run: targeted route tests if present
- Run: `pnpm build`

---

## Suggested Execution Order

1. P0-1 Build unblock
2. P0-2 Redirect/origin security fix
3. P0-3 Single postgres client
4. P0-4 Database source-of-truth convergence
5. P1-1 API route split
6. P1-2 Service split
7. P1-3 Runtime schema patch shrink
8. P1-4 Analytics optimization
9. P1-5 NFT warning cleanup
10. P1-6 CI introduction
11. P2 hardening tasks

## Recommended Workstreams

- **Workstream A — Release & Security:** P0-1, P0-2, P1-6
- **Workstream B — Data Layer:** P0-3, P0-4, P1-3, P1-4
- **Workstream C — Architecture Cleanup:** P1-1, P1-2, P1-5, P2-x
