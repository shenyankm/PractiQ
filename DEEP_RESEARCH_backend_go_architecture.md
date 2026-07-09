# Deep Research: Backend Go Architecture
> Generated 2026-07-09 | Depth: standard | Sources: 8

## TL;DR

`backend/` 的大方向是对的：`cmd/` 放可执行入口，`internal/` 放非公开实现，`db/` 放产品 schema，这符合 Go 官方对服务端项目的建议 [1][3]。主要问题不是目录名，而是 `internal/httpserver` 和 `internal/services` 已经开始变成横向“大包”：路由表、handler 构造、请求解析、业务调用和部分外部 SDK 集成都集中在少数文件中，新增业务会继续推高耦合。数据库 SQL 当前是按业务分片的 schema bootstrap，不是标准可回滚 migration；这适合早期快速迭代，但扩展到多人/多环境发布时风险最高 [8]。

## Executive Summary

OpenWook 后端目前处于“可运行、可测试、但包边界开始吃紧”的阶段。项目使用单 Go module `openwook`，`backend/cmd/openwook-api`、`backend/cmd/openwook-admin`、`backend/cmd/openwook-worker` 分别承担 HTTP API、数据库管理命令和导入 worker 入口，这种多命令布局与 Go 官方模块布局建议一致 [1]。业务实现放在 `backend/internal` 下，也受 Go `internal` 导入边界保护，外部模块不能直接导入这些包 [3]。

现有可维护性优点很明确。HTTP 层返回 `http.Handler`，没有自定义框架抽象；`api` 包统一 envelope/error；`auth` 独立管理 session 和当前用户；`db` 封装连接池和 schema apply/ensure/seed；`imports`、`redisx`、`aiclient`、`billing` 分别承载外部系统边界。测试覆盖也不只停留在纯 helper，例如 `internal/db/runtime_test.go` 验证 SQL 文件按数字前缀执行，`internal/httpserver/*_test.go` 覆盖路由行为，说明工程已经有回归保护。

主要瓶颈集中在两个方向。第一，`internal/httpserver/route_slices.go` 把多个业务域的 handler struct 与路由注册函数放在一个文件，并通过大量 nil 判断兼容 subtree fallback；同时 `internal/httpserver/content.go` 还保留手写 path split 的旧路由分发。chi 官方文档支持用 `Route`、`Group`、`Mount` 和 scoped middleware stack 表达模块化路由 [6]，当前实现只使用了平铺 `router.Method`，没有充分利用这些机制。第二，`internal/services` 是一个大包，包含 banks/questions/groups/practice/imports/analytics/admin/search/users 等多个业务域，所有服务函数共享同一个包命名空间；Go 官方包命名建议反对无边界的 `api`、`types`、`interfaces` 等聚合包 [4]，当前 `services` 虽不是这些名字，但正在承担同类“所有业务都进来”的压力。

建议采用最小可行重构，而不是一次性 Clean Architecture 大搬家。短期只做三件事：删除 `route_slices.go` 中旧 subtree fallback，按资源拆分注册函数；把 `ImportsBillingAIHandlers` 拆成 imports、ai、billing 三组；把数据库 bootstrap 明确命名为 schema apply，并在需要环境升级/回滚时再引入 `db/migrations/*.up.sql` / `*.down.sql`。这比新增 repository/interface/factory 层更符合当前项目规模。

## 1. Status Quo [Confidence: High]

### 1.1 顶层布局基本符合 Go 服务端项目惯例

Go 官方模块布局文档建议服务端项目通常没有对外导出的库包，服务器逻辑可放在 `internal/`，命令入口可放在 `cmd/` [1]。OpenWook 后端正是这个形态：`backend/cmd/openwook-api/main.go` 启动 API server，`backend/cmd/openwook-admin/main.go` 分发 `db apply/ensure/seed`，`backend/cmd/openwook-worker/main.go` 启动 Redis-backed import worker。`backend/internal` 下包含 `aiclient`、`api`、`auth`、`billing`、`config`、`db`、`httpserver`、`imports`、`logx`、`redisx`、`services`、`storage` 等实现包。

这比把所有代码放在 module 根目录更清楚。`internal` 不是纯约定，Go 1.4 起由 `go` command 强制导入规则：`internal` 下包只能被其父目录树内代码导入 [3]。对 OpenWook 这种前后端同仓库、后端暂不作为公共 SDK 暴露的项目，这个边界是合适的。

不建议新增顶层 `pkg/`。社区 “Standard Go Project Layout” 仓库本身声明不是 Go 核心团队定义的官方标准，并提示简单项目照搬会 overkill [5]。OpenWook 当前没有明确要给外部模块复用的 Go 库 API；把代码留在 `internal/` 更简单。

### 1.2 HTTP server 采用 stdlib handler，方向正确

`backend/internal/httpserver/router.go` 的 `NewServer` 返回 `http.Handler`，内部创建 `chi.NewRouter()`，注册健康检查、metrics、auth、reference、admin、media、content、imports/billing/AI、practice/analytics/search 路由，然后包裹 `SPAGuardWithResolver`、`SameOriginProtection`、`RequestID`、`SecurityHeaders` middleware。chi 文档强调它兼容 `net/http`，支持普通 middleware、route groups 和 sub-router mounting [6]；OpenWook 选择 `http.Handler` 作为 handler 注入单位，是轻量且可测试的。

`ServerDependencies` 在 `server.go` 中列出外部依赖和 handler group：health checks、metrics、current user resolver、各业务 handler group。API 入口 `cmd/openwook-api/main.go` 负责组装真实依赖：Postgres pool、Redis check、AI client、handler builders。这个方向比在 handler 内到处读取全局配置更好。

但 `ServerDependencies` 已经暴露出横向扩张趋势。每新增业务域都要改 `ServerDependencies`、`cmd/openwook-api/main.go`、`router.go` 和 `route_slices.go`。这不是立刻的 bug，但它会让“加一组路由”变成跨文件重复编辑。

### 1.3 内部包职责现状

`internal/api` 负责响应 envelope、错误模型和 schema validation。它被 `auth`、`services`、`httpserver` 广泛导入，是当前错误类型的事实基础包。这个基础包的职责较窄，基本合理。

`internal/auth` 同时包含 HTTP auth handlers、session cookie、当前用户解析和部分数据库访问。`auth/handlers.go` 暴露 `Register`、`Login`、`Logout`、`Me` handler 构造函数，也定义 `User`、`CurrentUserResolver`、`RequireUser`。`httpserver/auth_routes.go` 用 `BuildAuthHandlers` 把 pgx pool 适配给 auth handler dependencies。这个包边界可以接受，因为 auth 是横切领域，但它已经同时承担 transport 与 runtime 两类职责；如果后续增加 OAuth、service token 或 mobile bearer token，可再拆 `auth/http` 与 `auth/session`，现在不必。

`internal/services` 是最大维护风险。它按文件分了业务主题，但包仍是一个：`banks.go`、`questions.go`、`groups.go`、`practice.go`、`imports.go`、`analytics.go`、`admin.go`、`search.go`、`users.go` 等都在 `package services`。这让跨领域复用很方便，也避免了过早抽象；但它也让函数、类型、helper 在同一命名空间膨胀。比如 `banks.go` 定义通用 `withTx`、`rowScanner`，`shared_types.go` 放跨银行/练习共享类型，imports 相关函数又直接导入 `internal/imports` 和 `internal/redisx`。随着业务增多，`services` 会越来越像“业务上帝包”。

`internal/db` 当前不是 repository 层，而是运行时 DB 工具包：配置、连接池、SQL 文件收集、schema apply/ensure/seed。`CollectSQLFiles` 只匹配 `db/*/*.sql`，再按文件名前缀数字排序；测试明确验证了数字顺序。这个实现简单直接，适合当前 schema bootstrap 模式。

`internal/imports` 是队列运行时，`cmd/openwook-worker` 使用它创建 worker runtime，再调用 `processQueuedJob`。Worker 处理逻辑目前在 `cmd/openwook-worker/process.go` 中，直接依赖 `aiclient`、`auth`、`imports`、`redisx`、`services`。这让入口命令有较多业务逻辑；如果需要从 HTTP 端复用同样的导入处理，应该把 `processQueuedJob` 移到 `internal/imports` 或 `internal/services/imports` 的更明确位置。现在只有 worker 使用，暂时不是优先级最高的问题。

### 1.4 数据库 SQL 是 schema fragments，不是迁移系统

`backend/db` 当前按业务目录组织：`core/00_functions.sql`、`users/10_users.sql`、`banks/20_question_banks.sql`、`study-groups/30_study_groups.sql`、`imports/40_question_import_jobs.sql`、`questions/50_questions.sql`、`media/60_media.sql`、`practice/70_user_answers.sql`、`study-groups/80_study_group_analytics.sql`。每个文件有 purpose comment，命名有数字前缀，`db.CollectSQLFiles` 按数字前缀排序执行。

这个结构利于阅读产品模型，也与 `docs/system-design.md` 保持一致：文档明确说应把 `backend/db/*/*.sql` 作为题库系统权威数据模型，不要重新引入并行 ORM schema。问题是它不是可回滚 migration。golang-migrate 的标准迁移文件是成对的 `{version}_{title}.up.sql` 和 `{version}_{title}.down.sql`，按版本升序 apply、降序 rollback，并强烈建议包含 down migration [8]。OpenWook 的 SQL 文件没有 `down`，也没有 migration history table；`db apply` 重放整个 schema 文件集，依赖 SQL 内部 `CREATE TABLE`、`ALTER TABLE` 是否幂等。

早期本地开发可以接受这种 bootstrap 模式。生产环境持续演进时，它会遇到三类问题：无法知道某环境已应用到哪个版本；无法自动回滚失败变更；无法表达 destructive migration 的审查边界。

## 2. Emerging Trends [Confidence: Medium]

这里的“趋势”不是引入更多架构层，而是 Go 后端在项目增长时常见的轻量演进路径。

第一，Go 官方文档本身强调从简单布局开始，根据包是否可复用、命令是否多个、服务端逻辑是否内部化来组织模块 [1]。这支持 OpenWook 继续保持 `cmd` + `internal`，而不是套一个复杂标准布局。所谓 Standard Go Project Layout 只是社区模式集合，不是官方标准 [5]。

第二，HTTP 路由趋向“按资源子路由组织”，而不是全局平铺 route registry。chi 的 `Route` 可定义共享前缀，`Group` 可创建独立 middleware stack，`Mount` 可挂载独立 `http.Handler` 子路由 [6]。OpenWook 当前已经使用 chi，却没有利用 `Route("/api/v1/banks", ...)`、`Route("/api/v1/questions", ...)`、`Group` 等方式表达权限和资源边界；未来扩展 admin、billing、AI、imports 时，继续平铺会让路由冲突和 middleware 作用域更难审查。

第三，数据库治理通常从 schema bootstrap 过渡到 migration history。golang-migrate 的命名和 up/down 机制是 Go 生态中常见选择 [8]。但这不意味着现在必须重写所有 SQL。更低成本的做法是保留 `db/*/*.sql` 作为“新环境全量 schema”，另建 `db/migrations` 只承载发布后增量变更；等生产数据真实存在后，再把 `db apply` 限定为本地/CI bootstrap。

## 3. Critical Assessment [Confidence: High]

### 3.1 `route_slices.go` 的核心问题是“注册表 + 兼容层”混在一起

`backend/internal/httpserver/route_slices.go` 定义了 `ContentHandlers`、`AdminHandlers`、`MediaHandlers`、`ImportsBillingAIHandlers`、`PracticeHandlers`、`AnalyticsHandlers`、`SearchHandlers`，然后在同一文件里注册所有业务路由。这个文件名也不准确：它没有 slice，实际是 route registry 和 handler group definitions。

最明显的复杂度来自 content 路由的 nil fallback。`registerContentRoutes` 先判断细粒度 handler 是否存在；如果不存在但 `BankSubtree`、`QuestionSubtree`、`GroupSubtree` 存在，就用 `router.Handle("/api/v1/banks/*", handlers.BankSubtree)` 这类兜底。与此同时，`BuildContentHandlers` 同时提供细粒度 handler 和 subtree handler，`content.go` 的 `handleBankSubtree` 又手动 `pathParts`、`parseID`、`switch len(parts)`。也就是说，同一组资源路由同时存在 chi path param 模式和手写 URL path split 模式。

这会带来维护问题。新增一个 bank 子路由时，开发者需要判断该改细粒度注册、subtree switch，还是两者都改。测试注入 nil handler 的便利不值得长期保留两个路由系统。最小修复是删除 subtree fallback，只保留 `registerMethodRoute` + `r.PathValue` 路径参数；测试需要注入部分 handler 时，nil handler 已经会被 `registerMethodRoute` 忽略，不需要 subtree。

### 3.2 `ImportsBillingAIHandlers` 是三个边界被并包

`ImportsBillingAIHandlers` 把导入任务、AI 调用和 billing webhook/checkout 放在一个 struct 中。对应实现文件 `imports_billing_ai_handlers.go` 超过千行，导入 Paddle SDK、AI client、Redis、imports queue、services、auth、api。这个组合名称本身就是信号：它不是一个业务域，而是三个业务域为了减少文件数被合并。

这种合并短期省事，长期会让变更影响面变大。导入 SSE、AI parse、Paddle webhook 的错误处理、安全边界和测试关注点不同。建议拆成三个 handler group：`ImportHandlers`、`AIHandlers`、`BillingHandlers`。这不需要新增接口层，只是把现有 struct 和 register 函数拆开。

### 3.3 middleware 作用域过粗

`NewServer` 现在先注册所有路由，再把整个 router 包在 `SPAGuardWithResolver`、`SameOriginProtection`、`RequestID`、`SecurityHeaders` 中。全局安全 header 和 request id 合理；same-origin 对所有 mutating method 也可接受；但 auth 仍主要在每个 handler 内部重复调用 `RequireUser`。chi 支持用 `Group` 为受保护路由加局部 middleware [6]。当前项目不一定要马上改成全局 auth middleware，因为服务函数还需要完整 `auth.User`；但 admin-only、user-only、public 路由边界最好在 route group 上可见。

最小改法是先不改 handler 签名，只在路由注册层用 `r.Route("/api/v1", ...)` 分 public/user/admin 三段，保持 handler 内 `RequireUser` 作为最终校验。这样路由可读性上升，权限安全不依赖单点重构。

### 3.4 `services` 包会成为扩展瓶颈，但现在不需要上 repository/interface 模板

`internal/services` 中大量函数直接接收 `*pgxpool.Pool`，执行 SQL 并返回 API DTO。这让代码直观，少了 repository boilerplate；对当前团队和规模是优点。问题是所有业务都在同一个 package 内，helper 容易互相可见，领域边界靠文件名而不是编译器维护。

Go 官方包命名文章强调包名要短且有意义，并警惕无意义聚合包 [4]。`services` 不是官方点名的坏名字，但当它包含 users、banks、questions、groups、imports、practice、analytics、media、admin、search 时，它已经接近“所有业务服务”的聚合包。下一步不是新增 `Repository` interface，而是按实际业务域拆包，例如 `internal/banks`、`internal/questions`、`internal/practice`、`internal/importjobs`。只有当某个服务真的有两种实现或测试替身痛苦时，再局部引入小接口。

### 3.5 `api` 包既是好基础，也可能向错误方向膨胀

`internal/api` 目前负责 envelope/error/schema，是良性的基础包。Go 包命名博客反对单一 `api` 包装下所有 API 类型 [4]；OpenWook 现在还没有这个问题，但要避免把所有 request/response DTO 都迁入 `api`。DTO 应靠近 handler 或领域服务，`api` 保持只做协议 envelope、错误和通用 validation。

### 3.6 数据库 apply 缺少发布语义

`db apply` 会收集 `db/*/*.sql` 并执行。该模式没有 down migration，也没有 schema version table。golang-migrate 文档中的 up/down pair 解决的是“每个版本变更如何应用/回滚”的问题 [8]。OpenWook 现在的文件更像 declarative-ish bootstrap fragment。它可以保留，但应明确边界：本地新库、CI ephemeral DB、开发环境 reset 可以用；生产升级不要靠重跑全量 SQL。

## 4. Action Plan

- [ ] 把 `backend/internal/httpserver/route_slices.go` 改名或拆分为 `routes_content.go`、`routes_admin.go`、`routes_imports.go`、`routes_ai.go`、`routes_billing.go`；先不改 handler 行为。
- [ ] 删除 content subtree fallback：移除 `BankSubtree`、`QuestionSubtree`、`GroupSubtree` 字段和 `handle*Subtree` 手写 path switch，只保留 chi path params。
- [ ] 拆 `ImportsBillingAIHandlers` 为 `ImportHandlers`、`AIHandlers`、`BillingHandlers`，同时把 `registerImportsBillingAIRoutes` 拆成三个注册函数。
- [ ] 在 `router.go` 中引入 `/api/v1` 层级 `Route`，把 public、user、admin、webhook 路由分区；先保持 handler 内 auth 校验不变。
- [ ] 给 `backend/db` 写明语义：`db/*/*.sql` 是 bootstrap schema fragments，不是 migration；在 `docs/system-design.md` 或后端 README 中补一句运行边界。
- [ ] 当出现第一个需要保留生产数据的 schema 变更时，新增 `backend/db/migrations`，采用 `{version}_{title}.up.sql` / `{version}_{title}.down.sql`，保留 `db/*/*.sql` 作为 fresh install schema。
- [ ] 暂缓把 `services` 全量拆包；只在某个文件继续明显膨胀时按业务域搬迁，例如先拆 imports 或 questions。不要新增一堆单实现 interface。

## 5. Open Questions & Caveats

本报告没有运行 Go 测试，也没有做完整 import graph 静态分析；结论基于文件读取、grep 和外部资料验证。源码证据足以支撑结构性判断，但重构前仍应先跑 `go test ./...`。

`go.mod` 声明 `go 1.26`。如果本地工具链确实支持该版本，这不是架构问题；如果不是，构建会失败。该点不在本次架构评估重点内。

`internal/services` 是否拆包取决于团队变更频率。如果当前只有少数人开发，保持一个包还能减少循环依赖和导出类型数量。等到同一 PR 经常同时改 banks/questions/practice/imports，或测试 fixture 开始互相污染，再拆更划算。

## Methodology

本次研究按标准深度执行。外部资料检索覆盖 Go 官方模块布局、Go `internal` 机制、Go 包命名、Standard Go Project Layout caveat、chi 路由组织、golang-migrate migration 命名。随后读取仓库关键文件：`backend/cmd/openwook-api/main.go`、`backend/cmd/openwook-admin/main.go`、`backend/cmd/openwook-worker/main.go`、`backend/internal/httpserver/router.go`、`server.go`、`route_slices.go`、`content.go`、`imports_billing_ai_handlers.go`、`middleware.go`、`route_helpers.go`、`backend/internal/services/*.go` 摘要、`backend/internal/db/config.go`、`runtime.go`、`backend/db/*/*.sql` 以及 `docs/system-design.md`。

引用抽查结果：6 个核心外部 claim 全部 SUPPORTED。Context7 也确认 chi 文档包含 `Route`、`Group`、`Mount`、scoped middleware 示例，golang-migrate 文档包含 `.up.sql` / `.down.sql` 命名格式。

## Bibliography

[1] Go Project - Organizing a Go module - https://go.dev/doc/modules/layout - Accessed 2026-07-09 - Tier: 1

[2] Go Project - Effective Go: Package names - https://go.dev/doc/effective_go#package-names - Accessed 2026-07-09 - Tier: 1, foundational

[3] Go Project - Go 1.4 Release Notes: Internal packages - https://go.dev/doc/go1.4#internalpackages - Accessed 2026-07-09 - Tier: 1, foundational

[4] Sameer Ajmani / Go Blog - Package names - https://go.dev/blog/package-names - Accessed 2026-07-09 - Tier: 1, foundational

[5] golang-standards community - Standard Go Project Layout README - https://github.com/golang-standards/project-layout - Accessed 2026-07-09 - Tier: 3

[6] go-chi project - chi README / docs - https://github.com/go-chi/chi and https://github.com/go-chi/docs/blob/master/pages/routing.md - Accessed 2026-07-09 - Tier: 1

[7] golang-migrate project - Getting Started - https://github.com/golang-migrate/migrate/blob/master/GETTING_STARTED.md - Accessed 2026-07-09 - Tier: 1

[8] golang-migrate project - MIGRATIONS.md - https://github.com/golang-migrate/migrate/blob/master/MIGRATIONS.md - Accessed 2026-07-09 - Tier: 1

## Source Extracts

### [1] Organizing a Go module

- **Summary:** Go 官方模块布局指南。服务端项目建议把 commands 放在 `cmd`，把服务器实现逻辑放在 `internal`。
- **Key points:** Server project 通常不需要导出包；`internal` 适合非公开服务器逻辑。
- **Source type:** official docs
- **Credibility tier:** 1

### [2] Effective Go: Package names

- **Summary:** Go 官方风格文档的包命名章节。强调包名应短、小写、单词化。
- **Key points:** 包名参与调用方 API 语义；导出名不应重复包名信息。
- **Source type:** official docs
- **Credibility tier:** 1

### [3] Go 1.4 Internal packages

- **Summary:** 官方 release notes 介绍 `internal` 目录语义。`go` command 强制 internal 导入边界。
- **Key points:** `.../internal/...` 只能被 internal 父目录树内代码导入。
- **Source type:** official docs
- **Credibility tier:** 1

### [4] Package names

- **Summary:** Go Blog 对包命名的官方扩展说明。强调 short and clear，反对无意义聚合包。
- **Key points:** 避免 `util`、`common`、`misc`；不要把所有 API 放到单一 `api`、`types`、`interfaces` 包。
- **Source type:** official blog
- **Credibility tier:** 1

### [5] Standard Go Project Layout README

- **Summary:** 社区 Go 项目布局模式集合，不是官方标准。可参考，但不应机械套用。
- **Key points:** README 明确声明不是 Go 核心团队定义的官方标准，并提示简单项目使用可能 overkill。
- **Source type:** community repo
- **Credibility tier:** 3

### [6] chi README / routing docs

- **Summary:** chi 官方项目文档。支持 `Route`、`Group`、`Mount`、`Use`、`With` 组织路由和 middleware。
- **Key points:** chi 兼容 `net/http`；可用 sub-router 和 scoped middleware 表达资源边界。
- **Source type:** project docs
- **Credibility tier:** 1

### [7] golang-migrate Getting Started

- **Summary:** golang-migrate 入门文档。示例用 CLI 生成迁移文件到 `db/migrations`。
- **Key points:** `migrate create -ext sql -dir db/migrations -seq create_users_table` 生成 sequential SQL migration。
- **Source type:** project docs
- **Credibility tier:** 1

### [8] golang-migrate MIGRATIONS.md

- **Summary:** golang-migrate 迁移文件格式说明。逻辑迁移由 up/down 两个文件表示。
- **Key points:** 文件名格式为 `{version}_{title}.up.{extension}` 和 `{version}_{title}.down.{extension}`；建议包含 down migration。
- **Source type:** project docs
- **Credibility tier:** 1
