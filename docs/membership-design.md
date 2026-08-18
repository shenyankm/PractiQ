# PractiQ 会员体系设计

本文档是 PractiQ 会员体系的权威设计说明，覆盖三级会员（free / pro / organization）、新用户 3 天 Pro 试用、公共题库下载（克隆）与学习小组。数据模型以 `db/*/*.sql` 为准，服务端实现以 `server/` 为准。

## 1. 概述与术语

| 术语 | 含义 |
|------|------|
| membership | `users.membership`，RevenueCat 权益在数据库中的投影，取值 `free` / `pro` / `organization`，仅由计费同步（`/api/v1/billing/sync` 与 RevenueCat webhook）改写，不含试用状态 |
| effectiveMembership | 有效等级，由 membership 与 `trial_ends_at` 计算得出的实际生效等级，是所有权益门控的唯一判定依据 |
| trial | 新用户 3 天 Pro 试用，以 `users.trial_ends_at` 时间列表达；试用内有效等级视为 pro，不产生 organization |
| BYOK | Bring Your Own Key，AI 功能使用用户自配的 DashScope、DeepSeek 或 Moonshot Key，平台不代付 |

设计要点：

- membership 只是 RevenueCat 投影，不存在独立的「trial」枚举值；试用用时间列表达，计费同步逻辑零干扰。
- 等级有序：`free < pro < organization`，高等级包含低等级的全部权益。
- 所有付费权益在服务端按有效等级门控；系统角色（admin）不绕过付费权益。

## 2. 会员等级与权益矩阵

| 权益 | free | pro | organization |
|------|------|-----|--------------|
| 题库 / 练习 / 分析 / 搜索（现有全部基础功能） | ✓ | ✓ | ✓ |
| 内部升级推广（「广告」） | 显示 | 免 | 免 |
| 公共题库下载（`POST /api/v1/banks/{bankId}/clone` 克隆副本） | – | ✓ | ✓ |
| AI 功能（文档解析导入、题目答案解析生成、AI 学习报告，均 BYOK） | – | ✓ | ✓ |
| 学习小组（创建小组、管理成员、关联多个题库、查看成员学情） | – | – | ✓ |
| 加入他人学习小组 | ✓ | ✓ | ✓ |

说明：

- **公共题库下载**的语义是「克隆副本到我的题库」：服务端复制题库结构（新 bank 行 + 题目/题组链接，引用同一批 question 行，不深拷题目），克隆后即为用户的私有题库，可正常练习并走既有离线缓存链路。
- **AI 功能**维持 BYOK 模式不变：pro/organization 用户自配加密 LLM Key 后可调用云端 AI。
- **学习小组**仅 organization 用户可创建并管理；任何等级的用户都可被加入小组并阅读小组关联的题库。

## 3. 新用户 3 天 Pro 试用

### 3.1 存储

```sql
trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 days')
```

试用截止时间由数据库默认值在 INSERT 时自动写入，密码注册与 Google 注册两处入口的 INSERT 语句均零改动。试用状态不进 `membership` 列，因此 RevenueCat 同步可以随时覆盖 membership 而不影响试用。

### 3.2 有效等级判定规则

- paid tier 优先：membership 为 `pro` / `organization` 时，有效等级即原值（无论试用是否过期）。
- membership 为 `free` 且试用未过期（`trial_ends_at > now()`）时，有效等级视为 `pro`。
- 试用只给 pro，永不给 organization。
- 其余情况有效等级为 `free`。

伪代码（对应 `server/membership.py` 的 `effective_membership`）：

```python
TIER_RANK = {'free': 0, 'pro': 1, 'organization': 2}

def effective_membership(membership, trial_ends_at, now):
    if membership in ('pro', 'organization'):
        return membership            # paid tier 优先
    if trial_ends_at is not None and trial_ends_at > now:
        return 'pro'                 # 试用内视为 pro
    return 'free'

def tier_at_least(membership, minimum):
    return TIER_RANK[membership] >= TIER_RANK[minimum]
```

### 3.3 试用过期后行为

- 有效等级回落为 `free`：全部 PRO 门控入口（AI 路由、导入任务创建/上传/解析/重试、公共题库克隆、LLM Key 托管）开始返回 `403 PRO_REQUIRED`。
- 已配置的用户 LLM Key 保留在库（加密存储），重新获得 pro 后可直接复用。
- 试用期间已克隆的题库、已导入的题目、已生成的内容全部保留，仅新操作被门控。
- 边界：试用期间创建的导入任务若在过期后仍处于进行中，worker 复检权益时同样按有效等级判定并拒绝；对失败任务发起 retry 也会被 `403 PRO_REQUIRED` 拒绝。

## 4. 数据模型

### 4.1 users 表变更（`db/users/10_users.sql`）

| 变更 | 说明 |
|------|------|
| `chk_users_membership` | 扩展为三值：`CHECK (membership IN ('free', 'pro', 'organization'))` |
| `trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 days')` | 新用户 Pro 试用截止时间；试用内有效等级视为 pro |

`membership` 列注释同步为「RevenueCat 权益投影，free / pro / organization（不含试用，试用见 trial_ends_at）」。

### 4.2 学习小组三表（`db/users/60_study_groups.sql`）

`study_groups` — 学习小组主表：

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | BIGINT IDENTITY PK | 小组 ID |
| `name` | VARCHAR(100) NOT NULL | 小组名称（非空白 CHECK） |
| `description` | VARCHAR(500) | 小组简介 |
| `created_by` | BIGINT NOT NULL → `users(id)` ON DELETE CASCADE | 创建者（owner）用户 ID |
| `created_at` / `updated_at` | TIMESTAMPTZ | `set_updated_at` 触发器维护 |

`study_group_members` — 成员表：

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | BIGINT IDENTITY PK | 成员行 ID |
| `group_id` | BIGINT NOT NULL → `study_groups(id)` ON DELETE CASCADE | 所属小组 |
| `user_id` | BIGINT NOT NULL → `users(id)` ON DELETE CASCADE | 成员用户 |
| `role` | TEXT NOT NULL DEFAULT 'member' | 组内角色，`CHECK (role IN ('owner', 'member'))` |
| `joined_at` | TIMESTAMPTZ | 加入时间 |

约束：`UNIQUE (group_id, user_id)`。创建小组时由服务层在同一事务内插入创建者的 owner 成员行。索引：`idx_study_group_members_user (user_id)`。

`study_group_banks` — 小组关联题库表：

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | BIGINT IDENTITY PK | 关联行 ID |
| `group_id` | BIGINT NOT NULL → `study_groups(id)` ON DELETE CASCADE | 所属小组 |
| `bank_id` | BIGINT NOT NULL → `question_banks(id)` ON DELETE CASCADE | 关联题库 |
| `linked_by` | BIGINT NOT NULL → `users(id)` ON DELETE CASCADE | 执行关联操作的用户 |
| `linked_at` | TIMESTAMPTZ | 关联时间 |

约束：`UNIQUE (group_id, bank_id)`。索引：`idx_study_group_banks_bank (bank_id)`、`idx_study_groups_created_by (created_by)`。

级联规则：删除用户级联删除其创建的小组、成员行与关联行；删除小组级联删除其成员与题库关联；删除题库级联删除小组关联。小组成员获得小组关联题库的读权限（视同公开题库：仅 active 题目、剥离答案），该读权限在 `server/services/banks.py` 的 `get_bank` 读权限谓词中扩展，题库详情、题目列表、练习启动共用此一处判定。

## 5. 服务端判定入口

| 位置 | 内容 |
|------|------|
| `server/membership.py` | `TIER_RANK`、`effective_membership(membership, trial_ends_at)`、`tier_at_least(membership, minimum)` — 有效等级单点计算 |
| `server/services/users.py` | `require_pro_entitlement(conn, user, feature)`（有效等级 ≥ pro，否则 `403 PRO_REQUIRED`）；`require_organization_entitlement(conn, user, feature)`（有效等级 = organization，否则 `403 ORGANIZATION_REQUIRED`） |

`require_pro_entitlement` 保持函数名与 `PRO_REQUIRED` 错误码不变，既有 AI/导入/LLM Key 调用点零改动；organization 因 rank 更高而天然放行全部 PRO 门控。

### 错误码

| 错误码 | HTTP | 含义 |
|--------|------|------|
| `PRO_REQUIRED` | 403 | 该功能需要有效等级 ≥ pro（含试用内） |
| `ORGANIZATION_REQUIRED` | 403 | 该功能需要 organization 会员（试用不含） |
| `STUDY_GROUP_NOT_FOUND` | 404 | 小组不存在或对当前用户不可见 |
| `FORBIDDEN` | 403 | 非小组 owner 执行管理操作 |
| `MEMBER_NOT_FOUND` | 404 | 目标用户不存在或不是小组成员 |
| `MEMBER_CONFLICT` | 409 | 该用户已是小组成员 |
| `CANNOT_REMOVE_OWNER` | 409 | 不能移除小组 owner |
| `BANK_NOT_OWNED` | 403 | 关联题库时 owner 并非该题库所有者 |
| `BANK_LINK_CONFLICT` | 409 | 题库已关联到该小组 |
| `BANK_LINK_NOT_FOUND` | 404 | 题库未关联到该小组 |

## 6. API 一览

### 公共题库下载

| Method | Route | 权益 | 说明 |
|--------|-------|------|------|
| `POST` | `/api/v1/banks/{bankId}/clone` | pro（有效等级） | 把公开题库克隆为我的私有题库：新 bank 行（`is_public=false`，名称加「（副本）」后缀）+ 复制题目/题组链接（引用同一批 question 行）+ `user_bank_links(is_owner=true)`；私有题库拒绝克隆 |

### 学习小组（`/api/v1/study-groups`）

| Method | Route | 权益 | 说明 |
|--------|-------|------|------|
| `GET` | `/api/v1/study-groups` | User | 列出我拥有的与我加入的小组 |
| `POST` | `/api/v1/study-groups` | organization | 创建小组，同事务写入 owner 成员行 |
| `GET` | `/api/v1/study-groups/{groupId}` | 小组成员 | 小组详情：基本信息 + 成员列表 + 题库列表 |
| `PATCH` | `/api/v1/study-groups/{groupId}` | owner | 更新名称/简介 |
| `DELETE` | `/api/v1/study-groups/{groupId}` | owner | 删除小组（级联成员与题库关联） |
| `POST` | `/api/v1/study-groups/{groupId}/members` | owner | 按用户名添加成员，body `{"username": "..."}` |
| `DELETE` | `/api/v1/study-groups/{groupId}/members/{userId}` | owner | 移除成员（不能移除 owner） |
| `PUT` | `/api/v1/study-groups/{groupId}/banks/{bankId}` | owner | 关联题库（owner 必须是该题库所有者） |
| `DELETE` | `/api/v1/study-groups/{groupId}/banks/{bankId}` | owner | 解除题库关联 |
| `GET` | `/api/v1/study-groups/{groupId}/members/{userId}/stats` | owner | 查看任一成员的学情快照（复用 `analytics.get_user_stats_snapshot`） |

### 计费同步响应变更

`POST /api/v1/billing/sync` 的响应现在返回更新后的完整 user dict，包含 `trialEndsAt`（ISO 时间）与 `effectiveMembership` 两个新字段，客户端可直接消费，无需自行计算有效等级。`GET /api/v1/auth/me` 等返回 user dict 的接口同样包含这两个字段。

## 7. RevenueCat 映射

| 项 | 说明 |
|----|------|
| pro entitlement | 已有，`REVENUECAT_PRO_ENTITLEMENT_ID`（v2 资源 ID `entl…`） |
| organization entitlement | 服务端 env `REVENUECAT_ORGANIZATION_ENTITLEMENT_ID`，默认 `'organization'`；移动端从服务端的 `effectiveMembership` 获取 organization 权益，不维护第二个 entitlement lookup key |
| 判定顺序 | 查询 v2 active-entitlements 后**先判 organization 再判 pro**（org rank 更高）；未配置 org entitlement 时跳过该判定，行为与现状一致 |
| webhook | 不变：仅按事件中的 app user id 触发主动重查，事件负载从不作为当前权益状态，重复或乱序事件安全 |

membership 的写入入口仍然只有两个：已认证的 `/api/v1/billing/sync` 与带 Authorization 校验的 RevenueCat webhook；客户端上报的权益状态从不被信任。

## 8. 免广告说明

项目无第三方广告 SDK。「广告」指 FREE 用户在产品内看到的**内部升级推广**（如主标签页升级横幅、设置页推广文案）。pro 与 organization 用户不展示这些推广；FREE 用户在试用期内（有效等级为 pro）同样不展示。客户端按 `effectiveMembership !== 'free'`（或 RevenueCat pro/org entitlement 命中）控制显隐。

## 9. 存量数据库迁移

`python -m server.admin db apply` 顺序执行 `db/*/*.sql`，面向全新库，**非幂等**。对已存在的数据库，执行以下幂等迁移：

```sql
-- users：新增试用列（新行默认 3 天试用）
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 days');

-- 存量用户不补发试用：按注册时间回填，即视为已过期
UPDATE users SET trial_ends_at = created_at + INTERVAL '3 days';

-- users：membership CHECK 扩展为三值
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_membership;
ALTER TABLE users
    ADD CONSTRAINT chk_users_membership CHECK (membership IN ('free', 'pro', 'organization'));

-- 学习小组三表
CREATE TABLE IF NOT EXISTS study_groups (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500),
    created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_study_groups_name_not_blank CHECK (btrim(name) <> '')
);

CREATE TABLE IF NOT EXISTS study_group_members (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_study_group_members_group_user UNIQUE (group_id, user_id),
    CONSTRAINT chk_study_group_members_role CHECK (role IN ('owner', 'member'))
);

CREATE TABLE IF NOT EXISTS study_group_banks (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    bank_id BIGINT NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
    linked_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_study_group_banks_group_bank UNIQUE (group_id, bank_id)
);

CREATE INDEX IF NOT EXISTS idx_study_group_members_user ON study_group_members (user_id);
CREATE INDEX IF NOT EXISTS idx_study_group_banks_bank ON study_group_banks (bank_id);
CREATE INDEX IF NOT EXISTS idx_study_groups_created_by ON study_groups (created_by);

DROP TRIGGER IF EXISTS trg_study_groups_set_updated_at ON study_groups;
CREATE TRIGGER trg_study_groups_set_updated_at
BEFORE UPDATE ON study_groups
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
```

权威 DDL（含中文 COMMENT）以 `db/users/10_users.sql` 与 `db/users/60_study_groups.sql` 为准；上述迁移仅用于不便重建的存量库。

## 10. 边界情形

| 情形 | 行为 |
|------|------|
| owner 降级为 pro/free | 小组数据（小组、成员、题库关联）全部保留；owner 的管理操作（改/删小组、增删成员、关联题库、查看成员学情）返回 `403 ORGANIZATION_REQUIRED`；成员仍可读小组关联题库 |
| 克隆题库引用原题 | 克隆复制链接而不深拷题目行：源题库被删除后题目行仍在，克隆副本不受影响；但若源题目被其作者删除，克隆副本中的对应题目同步消失 |
| 试用与 RC 订阅叠加 | paid tier 优先：试用内购买 pro/organization 即按付费等级生效；订阅到期回落后，若试用仍未过期则继续按试用 pro 生效 |
| 试用过期时进行中的导入 | worker 复检与 retry 均按有效等级重新判定，过期后拒绝（`403 PRO_REQUIRED`）；已产出的题目保留 |
| admin 系统角色 | 不绕过付费权益：admin 使用 AI / 克隆 / 学习小组管理同样需要相应有效等级 |
| organization 判定的防御行为 | 未配置 `REVENUECAT_ORGANIZATION_ENTITLEMENT_ID` 时按默认 `'organization'` 匹配，计费链路保持可运行 |
