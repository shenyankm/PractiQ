---
name: remove-feature
description: >-
  从项目中彻底移除功能/配置/子系统，清理所有关联引用、脚本、文档、测试和已损坏的遗留断言，
  确保项目自洽、零残留。
source: auto-skill
extracted_at: '2026-06-28T08:32:44.769Z'
---

# 移除功能/配置/子系统

当用户要求删除项目中的功能、配置或子系统时，遵循这个工作流。也适用于"清理生产部署冗余"等
多类别并行删除场景。关键模式都是相同的：发现 → 分类 → 征询 → 执行 → 验证。

## 步骤

### 1. 搜寻前置：发现上次清理遗留的回归

**在开始新清理之前**，先检查是否有**上次不完整的清理留下的已损坏测试**。
这是一个极容易被忽略的陷阱：

```bash
# 全工作区搜索所有可能的已删除路径/名称，确认没有测试在断言它们
grep -r 'deleted-feature-name|deleted-file-path' tests/ --ignore-node-modules
```

如果找到，记录为 **C 类回归**并在清理计划中一并修复——用户选择范围时告知
"这个测试当前已经是失败的，无论是否清理都会被修复"。

### 2. 发现完整文件范围

不要只看用户提到的那几个文件。用 grep 扫描所有文件类型（不限 glob）：

```bash
# 不限文件类型，全工作区扫描
grep -r '<关键词>' . --ignore-node-modules

# 或使用工具的 grep_search 不限定 glob
```

同时用 glob 找文件名含关键词的文件：

```bash
# 文件名含关键词
find . -name '*<关键词>*'
```

### 3. 将所有命中分为两类

| 类别 | 怎么处理 |
|------|---------|
| **A. 专属文件** | 删除。这些文件是该功能的专属文件，删除后不影响其他逻辑。 |
| **B. 引用文件** | 修改（不是删除）。这些文件引用了该功能但本身是其他功能的一部分。删除后这些文件会坏掉或不一致。 |

#### 3a. 特殊模式："混合关注点"的测试文件

一个测试文件可能混合了好几个 `it()` 块，其中一些断言被删功能，另一些断言的
是应该保留的应用代码。这时**不要自动删整个文件**——提供一个选项给用户：

- **推荐：保留应用层断言**（只删无关的 it 块）
- **可选：整个文件删除**（如果用户认为不需要这些断言）

用 `ask_user_question` 询问。"该文件还有 N 个与应用代码无关的 it 块，是否保留？"

### 4. 让用户选择删除范围

删除是不可逆的。提供至少两个范围的选项：

- **选项 A：只删专属文件** —— 快，但会留下坏掉的脚本和过时的文档
- **选项 B：彻底移除（含脚本文档）** —— 删专属文件 + 改所有引用文件（脚本/文档/测试/配置等），结果自洽
- **选项 C：替换方案** —— 如果需要用其他方案替代，先讨论方案再动手

如果是**多类别并行清理**（如同时移除生产部署链 + 运维配置 + 性能工具），
用一个多选问题一次性问用户，然后把这些类别的引用图合并到一个计划中。

使用 `ask_user_question` 让用户选择。

### 5. 执行清理

#### 5a. 删除专属文件

用 `git rm`（这些文件是 git 跟踪的），`-f` 仅当工作区有未提交修改时：

```bash
git rm -f <file1> <file2> ...
```

如果是子目录下的所有文件，用 `git rm -rf <dir>/`。

#### 5b. 修改引用文件

逐个处理 B 类命中，不遗漏：

- **脚本**（`.sh`、`.mjs`、`.ts`）：去掉调用被删功能的命令、变量、校验逻辑
- **文档**（`README.md`、`docs/*`、`*README.md`）：去掉架构描述、示例命令、配置指南
- **配置**（`.gitignore`、`.conf`、`docker-compose.yml`、`fluent-bit.conf` 等）：去掉相关段落
- **测试**（`.test.ts`）：删除断言被删功能的 it 块，或修改引用了被删功能的断言
- **AGENTS.md / QWEN.md**：去掉或替换例子中的被删功能名

对所有修改使用 `write_file`（整体重写）或 `edit`（精确替换）。

对于 `edit` 的长 old_string 匹配失败（常见于跨页读取的文本含不可见差异），
用 `grep` 验证关键短语确实存在于文件中，然后缩小 old_string 到只含必要行。

#### 5c. 清理空目录

删除文件后检查上级目录是否变空：

```bash
ls <dir>/    # 如果为空
rmdir <dir>/  # 或者 git 会自动清理跟踪的空目录
```

### 6. 验证完整性

#### 6a. 残留扫描——多模式并行

再次全工作区 grep。如果是多类别并行清理，**同时搜索多个模式**：

```bash
# 每个被删类别一个模式
grep -r 'pattern-categoryA' . --ignore-node-modules
grep -r 'pattern-categoryB' . --ignore-node-modules
```

逐类检查每个命中是**合理的代码引用**（如 tracer 名称字符串）还是**残留引用**。
合理的代码引用（如 OTel tracer name 含被删服务名）无需处理。

#### 6b. 运行受影响的测试

先跑只与清理相关的测试文件，确认通过：

```bash
pnpm test tests/<affected-test-file>.test.ts
```

确认减少的测试数合理（表明删了对应 case）且通过。如果之前有 C 类回归，确认它已修复。

#### 6c. 运行 lint

```bash
pnpm lint
```

#### 6d. 运行全量测试（可选但推荐）

如果环境支持，跑全量 `pnpm test`。分析失败项：

- **本次改动导致的**：立即修复
- **本地环境问题**（如 PostgreSQL/Redis 未运行）：告知用户，不影响清理验证
- **既有问题**（如 shadcn 覆盖检查）：确认未碰影响文件则不是自己引入

#### 6e. 确认 `git status` 没有意外改动

检查 `git status --short` 中的 ` D`（工作区删除）或 `M ` 行，确认只有
自己意图内的文件受到改动。发现意外的 Modified/Deleted（如 `.githooks/pre-commit`、
`.qoder/` 等）属于会话前就存在的工作区状态，**不要处理**，在总结中告知用户即可。

### 7. 告知用户架构影响

删除一个功能可能影响架构平衡。在总结中清晰告知：

> 原本 X 承担 A、B、C 三个职责。移除后，C 不再由 X 提供。——需要外部方案补位吗？

## 案例 1：移除 Caddy 配置

项目 `openwook` 用 Caddy 做 TLS 终止 + 负载均衡 + 静态资源服务。被要求"删除项目中的 caddy 配置"。

| 类别 | 文件 | 处理方式 |
|------|------|---------|
| A. 专属(6个) | `Caddyfile.openwook`、`caddy-openwook.service`、`caddy-manage.sh`、`CADDY.md`、`CADDY-IP.md`、`check-openwook-caddy.sh` | `git rm -f` 删除 |
| B. 脚本 | `scripts/deploy/openwook-systemd.sh` | 去掉 Caddy 安装/启动/端口校验 |
| B. 脚本 | `scripts/perf/observe-run.sh`、`stress-runner.mjs` | 去掉 caddy pid 采集 |
| B. 配置 | `ops/observability/fluent-bit.conf` | 去掉 Caddy 日志 INPUT |
| B. 文档 | `README.md`、`docs/observability.md`、`ops/observability/README.md` | 去掉 Caddy 描述 |
| B. 文档 | `AGENTS.md` | commit 示例 `refactor(caddy)` → `refactor(db)` |
| B. 配置 | `.gitignore` | 去掉头部注释 + Caddy 忽略段 |
| B. 测试 | `tests/deployment-hardening.test.ts` | 删 2 个 Caddy 断言测试 + 1 处 Caddyfile 校验断言 |
| B. 测试 | `tests/request-origin.test.ts` | 测试名 "behind Caddy" → "behind a reverse proxy" |

## 案例 2：清除生产部署冗余（本地开发模式）

用户状态"我目前只在本地开发"，要求分析并清理项目中不需要的生产基础设施。

**多类别并行清理**——不是移除一个功能，而是分别移除三个独立的生产关注点。

### 分类

| 关注点 | 专属文件 | 引用文件 |
|--------|---------|---------|
| **A. 生产部署链** | `openwook.service`、`openwook@.service`、`openwook-import-worker.service`、`scripts/deploy/openwook-systemd.sh` | `deployment-hardening.test.ts`(前 3 it 块)、`README.md` |
| **B. 运维观测配置** | `ops/observability/` 整目录(9 文件)、`docs/observability.md` | `observability.test.ts`(最后一个 it 块)、`README.md` |
| **D. 性能压测工具** | `scripts/perf/` 整目录(5 文件) | `package.json`(3 条 perf:* 脚本)、`deployment-hardening.test.ts`(2 行 perf 断言) |

### 发现 C 类回归

在搜索 B 类文件时，发现 `observability.test.ts:74` 断言 `fluent-bit.conf` 包含
`openwook-access.log`——但上一轮 Caddy 清理已移除该行。**该测试当前已失败**纳入清理计划。

### 决策

- 用户选择 A+B+D 全部清理 + `deployment-hardening.test.ts` 整个删除
- `observability.test.ts`：删最后一个 it 块（修复 C 类回归），保留前 4 块应用代码断言
- `README.md`：删 systemd 说明 + 推荐生产栈 + Performance Operations 整节
- `package.json`：删 perf:* 脚本

### 验证

- 三组 grep 模式并行扫描 → 零残留
- `observability.test.ts` → 4 passed（回归已修复）
- `deployment-hardening.test.ts` → 文件已不存在
- `pnpm lint` → pass
