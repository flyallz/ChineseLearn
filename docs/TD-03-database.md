# TD-03：PostgreSQL 最小数据设计（V0.0）

**文档版本：** TD-03 v1.0
**日期：** 2026 年 11 月 23 日
**状态：** V0.0 开发前冻结
**上游契约：** `docs/TD-02-event-contract.md` v1.2（`seq` 同步游标、同一会话写入串行化、幂等规则、历史查询与 SSE 交接）
**需求基线：** `docs/PRD-V2.2.md`（V0.0 最小学习事件闭环）

## 0. 变更记录

- v1.0（2026-11-23）：首版。V0.0 三表完整定义：字段、类型、主键、外键、唯一约束、索引；写入流程含同一会话串行化（`pg_advisory_xact_lock`）与幂等；Alembic 迁移、种子数据、备份恢复、测试用例。与 TD-02 v1.2 成对完成。
- 实测核对（2026-11-23）：本文档的 DDL、种子数据与关键查询已在 PostgreSQL 16.2 本地实测通过：三表与三索引建表成功；种子 5 条事件插入成功；D-05 分页（`after_seq=2, limit=2` 返回 `seq` 3、4）、D-06 `latest_seq=5`、D-07 展示顺序 3、1、2、4、5 均符合预期；D-09 外键、D-10 CHECK、D-02 主键均正确拒绝；D-04 并发实测：后到的写事务被 advisory 锁挡住，直到先到的事务提交才继续，`seq` 单调无重复；D-08 备份恢复后序列值等于最大 `seq`，再插一条得 `seq=11` 不撞唯一索引。实测中失败插入会消耗序列值留空洞（`seq` 6、7、8 被三条失败插入消耗），属正常现象，`seq` 只保证单调递增、不保证连续，见第 4.3 节。

## 1. 目标与范围

- 本文档只定义 V0.0 需要的最小数据库：三张表。V0.0 只验证“模拟学生 → FastAPI → PostgreSQL → SSE → 模拟教师”这一条事件闭环。
- 不建完整用户、班级、AI、协作、研究表。那些是 V0.2 及以后的事，本版本一张也不建，不提前搭空架子。
- 本文档是设计文档：给出完整 SQL 与 Alembic 迁移代码，但不直接建 `backend/` 工程。工程骨架是 P0 的事，P0 建工程时按本文档的迁移文件落地。

### 1.1 环境

- PostgreSQL 16（与 PRD V2.2 一致，自托管，腾讯云 Ubuntu 24.04）。
- 一个数据库，V0.0 用一个 schema `public`。不分库，不分 schema。
- 编码 UTF-8，时区统一 UTC。所有时间戳存 `TIMESTAMPTZ`，写库时一律 UTC。

### 1.2 设计原则

- 身份由服务端确定：V0.0 没有真实账号，身份来自 `test_actors` 的模拟身份，客户端传的身份字段一律不信任（TD-02 第 5 节）。
- 事件是追加写，不改写：`learning_events` 只插不改不删（除测试清理外）。幂等冲突不覆盖旧行。
- 同步游标由服务端分配：`seq` 是 `BIGSERIAL`，只在写事务里分配，客户端不许传。
- 约束进数据库，不只放应用层：唯一键、外键、CHECK 约束都在表上建，应用层判断失败时数据库还能兜底。
- 能用索引回答的查询不全表扫：同步分页、展示排序、最新游标都有对应索引。

## 2. 表总览

| 表 | 用途 | 行数量级（V0.0） |
|---|---|---|
| `test_actors` | 模拟身份：模拟学生、模拟教师 | 个位数 |
| `learning_sessions` | 学习会话：一次模拟学习过程 | 个位数 |
| `learning_events` | 学习事件：一次会话里的全部事件 | 每次会话数十条 |

关系：`test_actors` 1—N `learning_sessions` 1—N `learning_events`。事件只属于一个会话，会话只属于一个模拟身份。

## 3. 表设计

### 3.1 `test_actors`（模拟身份）

```sql
CREATE TABLE test_actors (
    actor_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_type  TEXT NOT NULL CHECK (actor_type IN ('simulated_student', 'simulated_teacher')),
    display_name TEXT NOT NULL,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `actor_id` | UUID | PK，默认 `gen_random_uuid()` | 模拟身份 ID |
| `actor_type` | TEXT | NOT NULL，CHECK 只能是 `simulated_student` 或 `simulated_teacher` | 身份类型 |
| `display_name` | TEXT | NOT NULL | 显示名，如“模拟学生 A”、“模拟教师 A” |
| `notes` | TEXT | 可空 | 备注，如“V0.0 测试用” |
| `created_at` | TIMESTAMPTZ | NOT NULL，默认 `now()` | 创建时间（UTC） |

- V0.0 只需要两行：一个模拟学生、一个模拟教师。种子数据见第 7 节。
- `actor_type` 的 CHECK 约束把类型收死在两个值，V0.2 真实账号另建表，不往这张表里加类型。

### 3.2 `learning_sessions`（学习会话）

```sql
CREATE TABLE learning_sessions (
    session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        UUID NOT NULL REFERENCES test_actors(actor_id) ON DELETE RESTRICT,
    lesson_id       TEXT,
    lesson_version  TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'ended')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);
```

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `session_id` | UUID | PK，默认 `gen_random_uuid()` | 会话 ID，对应 TD-02 的 `session_id` |
| `actor_id` | UUID | NOT NULL，FK → `test_actors`，`ON DELETE RESTRICT` | 所属模拟身份 |
| `lesson_id` | TEXT | 可空 | V0.0 可空（模拟会话不绑定真实课程）；V0.1 起必填 |
| `lesson_version` | TEXT | 可空 | 同上，V0.1 起必填 |
| `status` | TEXT | NOT NULL，默认 `active`，CHECK 只能是 `active` 或 `ended` | 会话状态 |
| `started_at` | TIMESTAMPTZ | NOT NULL，默认 `now()` | 会话开始时间（UTC） |
| `ended_at` | TIMESTAMPTZ | 可空，CHECK `ended_at >= started_at` | 会话结束时间 |
| `created_at` | TIMESTAMPTZ | NOT NULL，默认 `now()` | 创建时间（UTC） |

- `actor_id` 用 `ON DELETE RESTRICT`：有会话的模拟身份不许删，避免孤儿会话。
- `lesson_id` / `lesson_version` 在 V0.0 可空，因为模拟会话不绑定真实课程。V0.1 第一课真实迁移时再收紧（另起迁移加 NOT NULL），不在本版本提前收紧。

### 3.3 `learning_events`（学习事件）

```sql
CREATE TABLE learning_events (
    event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq         BIGINT GENERATED ALWAYS AS IDENTITY,
    session_id  UUID NOT NULL REFERENCES learning_sessions(session_id) ON DELETE RESTRICT,
    event_type  TEXT NOT NULL CHECK (event_type IN ('activity_entered', 'answer_submitted', 'hint_requested')),
    activity_id TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX ux_learning_events_seq ON learning_events (seq);
CREATE INDEX ix_learning_events_session_seq ON learning_events (session_id, seq);
CREATE INDEX ix_learning_events_session_occurred ON learning_events (session_id, occurred_at, received_at, event_id);
```

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `event_id` | UUID | PK，默认 `gen_random_uuid()` | 事件 ID，对应 TD-02 的 `event_id`。客户端传的 UUID v4 存这里；不传时服务端生成 |
| `seq` | BIGINT | `GENERATED ALWAYS AS IDENTITY`，唯一索引 | 服务端同步游标，全局单调递增，按写入顺序分配。客户端不许传、不许改 |
| `session_id` | UUID | NOT NULL，FK → `learning_sessions`，`ON DELETE RESTRICT` | 所属会话 |
| `event_type` | TEXT | NOT NULL，CHECK 只能是 V0.0 三种事件 | `activity_entered` / `answer_submitted` / `hint_requested` |
| `activity_id` | TEXT | 可空 | 活动 ID。V0.0 可空；V0.1 第一课迁移后按课程数据填 |
| `occurred_at` | TIMESTAMPTZ | NOT NULL | 客户端声称的发生时间（UTC，ISO8601 带 Z）。只用于教学时间线展示，不用于同步游标 |
| `received_at` | TIMESTAMPTZ | NOT NULL，默认 `now()` | 服务端接收时间（UTC）。服务端生成，客户端不许传 |
| `payload` | JSONB | NOT NULL，默认 `{}` | 事件内容。结构按 TD-02 第 3 节 Schema 校验，应用层校验，数据库只存 JSONB |

#### 3.3.1 `seq` 的关键规则（与 TD-02 v1.2 第 1.1、1.2 节对应）

- `seq` 用 `GENERATED ALWAYS AS IDENTITY`（PostgreSQL 16 推荐写法，等价于 `BIGSERIAL`，但不许客户端显式插入，语义更严）。值全局单调递增，永不复用，永不回填。
- `seq` 的分配顺序不等于提交顺序。修正办法是第 4 节的同一会话写入串行化：写事务内先加 `pg_advisory_xact_lock`，同一会话内提交顺序等于分配顺序。
- 备份恢复后 `seq` 的序列值必须恢复到不小于当前最大 `seq`，见第 8 节。序列值回落会造成 `seq` 重复，唯一索引会直接报错，恢复演练必须测这一项。
- 替代方案（已考虑，暂不采用）：把 `seq` 改成按会话的计数器（每个会话从 1 开始）。语义更干净，但要改 TD-02 v1.2 定下的全局 `seq` 定义。留待 V0.1 前复议，若改则 TD-02 与 TD-03 同步发新版。

#### 3.3.2 索引说明

| 索引 | 覆盖的查询 |
|---|---|
| `ux_learning_events_seq`（`seq` 唯一） | 保证 `seq` 不重复；按 `seq` 单点查 |
| `ix_learning_events_session_seq`（`session_id, seq`） | 同步分页：`WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`（TD-02 §7.3、§11） |
| `ix_learning_events_session_occurred`（`session_id, occurred_at, received_at, event_id`） | 展示排序：教学时间线按 `occurred_at, received_at, event_id` 排序（TD-02 §7.3） |

- `event_id` 是主键，自带唯一索引，不用另建。
- `session_id` 的 FK 不用另建单列索引：上面两个复合索引的首列都是 `session_id`，已覆盖按会话查。
- V0.0 数据量极小，索引主要是把查询形状定下来，不是为性能。以后事件量大了再评估分区，不在本版本做。

---

## 4. 写入流程（事件入库）

一次事件写入是一个数据库事务，按以下顺序执行，缺一步都不行。

```sql
BEGIN;

-- 第 1 步：同一会话写入串行化（TD-02 v1.2 第 1.2 节）
-- 锁随事务提交或回滚释放；不同会话的锁互不影响。
SELECT pg_advisory_xact_lock(hashtext(:session_id));

-- 第 2 步：会话存在性检查。会话不存在则回滚，API 返回 404（TD-02 第 6 节）。
SELECT 1 FROM learning_sessions WHERE session_id = :session_id;

-- 第 3 步：幂等检查。event_id 已存在时不插新行：
--   内容相同 → 返回已存行，API 返回 200；
--   内容不同 → 回滚，API 返回 409，不覆盖旧行。
SELECT event_id, event_type, activity_id, occurred_at, payload
  FROM learning_events WHERE event_id = :event_id;

-- 第 4 步：插入事件行。seq 由 IDENTITY 自动分配，不许显式传值。
-- received_at 由服务端 now() 生成，不许用客户端时间。
INSERT INTO learning_events (event_id, session_id, event_type, activity_id, occurred_at, payload)
VALUES (:event_id, :session_id, :event_type, :activity_id, :occurred_at, :payload::jsonb)
RETURNING event_id, seq, received_at;

COMMIT;
```

### 4.1 为什么要这个顺序

- 锁必须在分配 `seq` 之前加：先加锁再插入，同一会话的两个并发事务就排队了，提交顺序等于分配顺序，T-16 的反例（A 拿 41 未提交、B 拿 42 先提交）不会发生。锁加晚了就没用。
- 幂等检查必须在同一个事务里做：检查和插入之间没有别的事务能插进来，否则两个相同 `event_id` 的并发请求可能同时通过检查、同时插入，主键冲突变成 500，而不是预期的 200/409。主键是最后一道兜底，不是第一道。
- `seq` 必须由 IDENTITY 自动分配：`GENERATED ALWAYS` 拒绝客户端显式插入 `seq`，写错了直接报错，不会悄悄接受。

### 4.2 幂等比较规则（TD-02 第 6 节）

- “内容相同”的比较字段：`event_type`、`activity_id`、`occurred_at`、`payload` 四项全等，且 `session_id` 相同。五项全等 → 200，返回已存行；任一项不同 → 409。
- `occurred_at` 比较按时间戳值，不按字符串写法：`2026-11-23T10:00:00Z` 与 `2026-11-23T10:00:00+00:00` 是同一个时刻，算相同。
- `payload` 比较按 JSONB 相等（键顺序无关）：`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 算相同。

### 4.3 失败与回滚

| 情况 | 处理 | API 返回 |
|---|---|---|
| 会话不存在 | 回滚 | 404 |
| `event_id` 已存在且内容相同 | 回滚（不插新行），返回已存行 | 200 |
| `event_id` 已存在且内容不同 | 回滚 | 409 |
| `event_type` 不在三种之内 / 字段不合法 | 回滚 | 422（CHECK 约束报错时应用层翻译成 422，不许把数据库原生错误直接返回给客户端） |
| 事务中途失败（如连接断开） | 回滚，`seq` 已分配的值作废，序列不回退 | 客户端按 TD-02 第 9 节重试（只重试网络/超时/5xx，409/422 不重试） |

- `seq` 作废后留下的空洞是正常的：`seq` 只保证单调递增，不保证连续。读者按 `after_seq` 补查时空洞不影响结果，因为查询条件是 `seq > ?`，不是 `seq = ? + 1`。

---

## 5. 查询

### 5.1 同步分页（TD-02 §7.3）

```sql
-- 拉取某会话 seq 大于 :after_seq 的事件，按 seq 升序，每页 :limit 条。
SELECT event_id, seq, session_id, event_type, activity_id,
       occurred_at, received_at, payload
  FROM learning_events
 WHERE session_id = :session_id AND seq > :after_seq
 ORDER BY seq ASC
 LIMIT :limit;
```

- 走索引 `ix_learning_events_session_seq`。
- `next_after_seq` 为本页最后一条的 `seq`，没有下一页时为 `null`。

### 5.2 最新游标（SSE 交接起点，TD-02 §7.3、§11）

```sql
-- 查询时刻本会话最大的 seq；会话无事件时返回 null。
SELECT MAX(seq) AS latest_seq
  FROM learning_events
 WHERE session_id = :session_id;
```

- 教师端历史查询的响应里直接带 `latest_seq`，不用另发一次查询。SSE 建连时把 `latest_seq` 作为 `after_seq` 传给服务端，服务端从它之后补发（TD-02 v1.2 四步交接协议）。

### 5.3 展示排序（教学时间线）

```sql
-- 某会话的事件按教学时间线排序展示：先 occurred_at，再 received_at，最后 event_id。
SELECT event_id, seq, event_type, activity_id,
       occurred_at, received_at, payload
  FROM learning_events
 WHERE session_id = :session_id
 ORDER BY occurred_at ASC, received_at ASC, event_id ASC;
```

- 走索引 `ix_learning_events_session_occurred`。
- 展示排序与同步游标是两套顺序，不许混用：时间线按 `occurred_at` 排，同步按 `seq` 补查。晚到的早发事件在时间线上会排在前面，但 `seq` 更大，补查不会漏（TD-02 T-11）。

### 5.4 单条事件查询（TD-02 §7.2）

```sql
SELECT event_id, seq, session_id, event_type, activity_id,
       occurred_at, received_at, payload
  FROM learning_events
 WHERE event_id = :event_id;
```

- 走主键索引。事件不存在返回 404。

---

## 6. Alembic 迁移

- 迁移文件位置（P0 建工程时落地）：`backend/alembic/versions/001_create_v00_tables.py`。
- 一个迁移建三张表加全部索引，不拆多个迁移。V0.0 之后改表一律新起迁移，不直接改本文件。
- `down_revision` 为 `None`（首个迁移）。`revision` 用固定值 `001_v00_tables`，不用随机串，方便人工核对。

```python
"""V0.0: create test_actors, learning_sessions, learning_events.

Revision ID: 001_v00_tables
Revises:
Create Date: 2026-11-23
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "001_v00_tables"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "test_actors",
        sa.Column("actor_id", postgresql.UUID(as_uuid=True),
                  primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("actor_type", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint(
            "actor_type IN ('simulated_student', 'simulated_teacher')",
            name="ck_test_actors_type"),
    )

    op.create_table(
        "learning_sessions",
        sa.Column("session_id", postgresql.UUID(as_uuid=True),
                  primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("lesson_id", sa.Text(), nullable=True),
        sa.Column("lesson_version", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("started_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["actor_id"], ["test_actors.actor_id"],
                                ondelete="RESTRICT"),
        sa.CheckConstraint(
            "status IN ('active', 'ended')", name="ck_learning_sessions_status"),
        sa.CheckConstraint(
            "ended_at IS NULL OR ended_at >= started_at",
            name="ck_learning_sessions_ended_after_started"),
    )

    op.create_table(
        "learning_events",
        sa.Column("event_id", postgresql.UUID(as_uuid=True),
                  primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("seq", sa.BigInteger(),
                  sa.Identity(always=True), nullable=False),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("activity_id", sa.Text(), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()),
                  nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.ForeignKeyConstraint(["session_id"], ["learning_sessions.session_id"],
                                ondelete="RESTRICT"),
        sa.CheckConstraint(
            "event_type IN ('activity_entered', 'answer_submitted', 'hint_requested')",
            name="ck_learning_events_type"),
    )
    op.create_index("ux_learning_events_seq", "learning_events", ["seq"], unique=True)
    op.create_index("ix_learning_events_session_seq",
                    "learning_events", ["session_id", "seq"])
    op.create_index("ix_learning_events_session_occurred",
                    "learning_events",
                    ["session_id", "occurred_at", "received_at", "event_id"])


def downgrade():
    op.drop_table("learning_events")
    op.drop_table("learning_sessions")
    op.drop_table("test_actors")
```

- 迁移执行前必须先在本地开发库跑通 `alembic upgrade head` 再 `alembic downgrade base` 再 `upgrade head`，确认可升可降。只升不降的迁移不合入。
- 迁移只建表结构，不插种子数据。种子数据用第 7 节的 SQL 单独执行，不写进迁移文件。

---

## 7. 种子数据（测试用）

以下 SQL 只用于本地开发库与 V0.0 测试，不进迁移，不上生产。

```sql
-- 模拟学生与模拟教师
INSERT INTO test_actors (actor_id, actor_type, display_name, notes) VALUES
  ('11111111-1111-4111-8111-111111111111', 'simulated_student', '模拟学生 A', 'V0.0 测试用'),
  ('22222222-2222-4222-8222-222222222222', 'simulated_teacher', '模拟教师 A', 'V0.0 测试用');

-- 一个模拟学习会话（V0.0 不绑定真实课程，lesson_id 为空）
INSERT INTO learning_sessions (session_id, actor_id, lesson_id, lesson_version, status) VALUES
  ('9b1a2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d',
   '11111111-1111-4111-8111-111111111111', NULL, NULL, 'active');

-- 五条事件：第三条是晚到的早发事件（occurred_at 最早，但 seq 排第三），专供 T-11 回归。
-- 注意：seq 由 IDENTITY 自动分配，以下 INSERT 不写 seq，顺序即 seq 顺序。
INSERT INTO learning_events (event_id, session_id, event_type, activity_id, occurred_at, payload) VALUES
  ('a0000000-0000-4000-8000-000000000001', '9b1a2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d',
   'activity_entered', 'act-l01-s1', '2026-11-23T10:00:00Z', '{"step": 1}'),
  ('a0000000-0000-4000-8000-000000000002', '9b1a2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d',
   'answer_submitted', 'act-l01-s2', '2026-11-23T10:00:10Z', '{"answer": "a", "correct": true}'),
  ('a0000000-0000-4000-8000-000000000003', '9b1a2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d',
   'hint_requested', 'act-l01-s1', '2026-11-23T09:59:55Z', '{"hint_id": "h1"}'),
  ('a0000000-0000-4000-8000-000000000004', '9b1a2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d',
   'answer_submitted', 'act-l01-s3', '2026-11-23T10:00:20Z', '{"answer": ["a", "o"], "correct": false}'),
  ('a0000000-0000-4000-8000-000000000005', '9b1a2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d',
   'activity_entered', 'act-l01-s4', '2026-11-23T10:00:30Z', '{"step": 4}');
```

- 种子数据里的 UUID 是固定值，方便测试代码直接引用。真实环境不许用这些固定值。
- 晚到事件的核对方法：按 `seq` 查应为 1、2、3、4、5；按 `occurred_at` 展示排序应为 3（09:59:55）、1、2、4、5。两套顺序不同是正确的，见 TD-02 T-11。

---

## 8. 备份与恢复

### 8.1 备份

```bash
# 逻辑备份（V0.0 用 pg_dump 就够了，不上物理备份）
pg_dump -h <host> -U <user> -d chineselearn -F c -f chineselearn-$(date +%Y%m%d).dump
```

- 备份范围：三张表 + `seq` 的 IDENTITY 序列状态。`pg_dump -F c` 默认包含序列当前值，恢复后序列不会回落。
- 频率按 PRD V2.2：数据库每日备份；重大升级前做一次完整备份。V0.0 只有测试数据，频率从低起步，流程先跑通。

### 8.2 恢复与序列校验（关键）

```bash
# 恢复到空库
pg_restore -h <host> -U <user> -d chineselearn_new chineselearn-20261123.dump

# 恢复后必须校验：序列值不小于当前最大 seq，否则下次插入会撞唯一索引。
SELECT MAX(seq) FROM learning_events;  -- 记为 M
SELECT last_value FROM learning_events_seq_seq;  -- 应 >= M，否则执行下一条
SELECT setval('learning_events_seq_seq', (SELECT MAX(seq) FROM learning_events));
```

- 序列名以实际建表后的名字为准（`GENERATED ALWAYS AS IDENTITY` 生成的序列名形如 `learning_events_seq_seq`，以 `\d learning_events` 核对为准，不许猜）。
- 恢复演练每月一次（PRD V2.2），V0.0 完成标准里要求至少做一次（TD-02 第 18 节）。演练只算恢复出数据不够，必须连同上面这条序列校验一起通过。

### 8.3 恢复后的一致性检查

```sql
-- 孤儿事件：应为 0 行
SELECT COUNT(*) FROM learning_events e
 LEFT JOIN learning_sessions s ON e.session_id = s.session_id
 WHERE s.session_id IS NULL;

-- seq 重复：应为 0 行
SELECT seq, COUNT(*) FROM learning_events GROUP BY seq HAVING COUNT(*) > 1;

-- event_id 重复：主键保证，应为 0 行（复核用）
SELECT event_id, COUNT(*) FROM learning_events GROUP BY event_id HAVING COUNT(*) > 1;
```

---

## 9. 数据库测试用例

下表是数据库层的测试，编号 D-01 起，与 TD-02 的 AT/T 测试对应。V0.0 完成前全部通过。

| 编号 | 测试 | 预期 | 对应 TD-02 测试 |
|---|---|---|---|
| D-01 | 插入三条事件到同一会话 | `seq` 严格递增（1、2、3），`received_at` 由服务端生成，与 `occurred_at` 不同 | AT01 |
| D-02 | 同一 `event_id`、同一内容插两次 | 第二次不插新行，返回已存行（API 层返回 200） | AT03 |
| D-03 | 同一 `event_id`、不同内容插两次 | 第二次拒绝，不覆盖旧行（API 层返回 409） | AT03 |
| D-04 | 两个事务并发向同一会话写事件，一个延迟提交 | 全部提交后 `after_seq=0` 全量查到两条，按 `seq` 排序；无跳号、无丢失 | T-16 |
| D-05 | 会话里有 5 条事件，`after_seq=2, limit=2` | 返回 `seq` 3、4，`next_after_seq=4`，`has_more=true` | AT02 |
| D-06 | `MAX(seq)` 查询 | 返回当前最大 `seq`；空会话返回 `null` | §7.3 `latest_seq` |
| D-07 | 种子数据按 `occurred_at` 展示排序 | 顺序为 3、1、2、4、5（晚到的早发事件排前面） | T-11 |
| D-08 | 备份后恢复到空库，校验序列 | 恢复后 `seq` 序列值 ≥ 最大 `seq`；再插一条，新 `seq` 为最大 `seq` + 1，不撞唯一索引 | TD-02 §18 恢复演练 |
| D-09 | 删有会话的 `test_actors` 行；插 `session_id` 不存在的事件 | 两者都被外键拦住（`ON DELETE RESTRICT` / FK 报错） | §3 |
| D-10 | 插 `event_type` 为 `audio_progress` 的事件 | CHECK 约束拒绝（V0.0 只有三种事件） | §3.3 |

- 测试在本地开发库跑，用种子数据或测试专用库，不在腾讯云测试库跑破坏性测试。
- D-04 必须用两个真实并发事务测，顺序执行两个 INSERT 不算通过。

---

## 10. 与 TD-02 的对应关系

| TD-02 要求 | TD-03 落点 |
|---|---|
| `event_id` 唯一（§3、§6） | `learning_events.event_id` 主键 |
| `seq` 全局单调递增、唯一、有索引（§1.1） | `seq` 为 `GENERATED ALWAYS AS IDENTITY`，`ux_learning_events_seq` 唯一索引 |
| 同一会话写入串行化（§1.2） | 第 4 节写事务第 1 步 `pg_advisory_xact_lock` |
| 幂等：同 ID 同内容 200，不同内容 409（§6） | 第 4 节第 3 步幂等检查 + 第 4.2 节比较规则 |
| 历史查询按 `(session_id, seq)` 分页（§7.3） | 第 5.1 节 + `ix_learning_events_session_seq` |
| 展示按 `occurred_at` 排序（§7.3） | 第 5.3 节 + `ix_learning_events_session_occurred` |
| `latest_seq` 供 SSE 交接（§7.3、§11） | 第 5.2 节 `MAX(seq)` |
| 备份恢复后 `seq` 单调性不变（§1.1） | 第 8.2 节序列校验 + D-08 |
| 客户端身份字段不信任（§5） | 身份来自 `test_actors`，事件表不存客户端身份字段 |

---

## 11. 未决事项（不阻塞 V0.0）

- `seq` 改按会话计数器的替代方案：TD-02 v1.2 第 1.2 节已记，留待 V0.1 前复议。若改，TD-02 与 TD-03 同步发新版，本版不改。
- `payload` 的 JSON Schema 校验放在应用层（FastAPI + Pydantic），数据库只存 JSONB，不加 CHECK 约束。事件类型增加时应用层先改，数据库不用动。
- 事件量大了以后的分区、归档与保留期限：V0.0 只有测试数据，不做。真实学生数据采集前按 PRD V2.2 第 17 章的待决策表处理。
- `lesson_id` / `lesson_version` 在 V0.1 第一课真实迁移时收紧为 NOT NULL，另起迁移，不改本版。
