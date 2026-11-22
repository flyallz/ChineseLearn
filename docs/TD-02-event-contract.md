# TD-02：学习事件与 API 契约

**文档版本：** TD-02 v1.2
**日期：** 2026 年 11 月 23 日（v1.2 修订）
**状态：** V0.0 开发前冻结
**依据：** `docs/PRD-V2.2.md` 第六章（学习事件与教学评价）、第十二章（数据库与基础事件设计）、第十八章验收 AT01–AT06
**前置关系：** 本文档是 V0.0 核心开发的前置条件；数据库实现见 TD-03，须与本文一致。
**范围：** 只定义 V0.0 必须实现的最小闭环。完整课程事件、录音、书写、协作、AI 事件不在本文实现范围，只在事件字典里占位，不展开 Payload。

**v1.1 变更记录（基于 2026-11-20 项目审查，V0.0 尚未开工，故为破坏性修正，无需兼容 v1.0 客户端）：**
1. 增加服务端递增序号 `seq` 做同步游标，教学时间线排序与同步游标分离，修复晚到事件补查遗漏问题。
2. 按状态码分重试表：409 / 422 / 400 / 403 / 404 不自动重试，只有网络断开、超时和 5xx 才重试。
3. SSE 不再首推全部历史，改为分页历史查询拿初始数据，SSE 只推新增与断点补偿。
4. 收紧 `answer` Schema：数组元素类型与数量、字符串长度均有明确上限，文字规则、Schema、测试三处对齐。
5. `schema_version` 仍为 `1`：客户端 Schema 未做不兼容变更，`seq` 为服务端新增字段。

**v1.2 变更记录（基于 2026-11-23 复审，V0.0 尚未开工，故为破坏性修正，无需兼容 v1.1 客户端）：**
1. 补 `seq` 的提交可见性缺口：同一会话写入串行化（`pg_advisory_xact_lock`），会话内提交顺序等于分配顺序；新增并发验收测试 T-16。
2. 补“先查历史、再连 SSE”的交接空档：写成明确的四步交接协议（历史查询返回 `latest_seq` → SSE 带 `after_seq` 建连 → 服务端补发 → 客户端按 `event_id` 去重）；新增空档验收测试 T-17。
3. V0.1 进度恢复范围澄清：V0.1 是“同一模拟身份、跨刷新恢复”，不是“跨设备、按真实学生恢复”（后者是 V0.2），见第 17 节。
4. 增加 V0.0 停止条件：AT01–AT06 + T-11 + T-16 + T-17 + 一次恢复演练全部通过即进入第一课迁移，不再扩展教师端展示或通用事件框架；时间盒 5–10 天，超时砍范围，见第 18 节。
5. 历史查询响应增加 `latest_seq` 字段，供 SSE 交接用；`schema_version` 仍为 `1`。

> 原则：原始事件只记录行为，学习状态（内容完成、评价达标、任务完成）由服务端规则另行计算，不在事件里直接写结论。身份由服务端可信上下文确定，客户端不许自报身份。

---

## 1. 事件信封（Envelope）

每条事件都是一个 JSON 对象。信封字段与 Payload 分开：信封管“这是什么事件、谁、在哪、什么时候”，Payload 管“这次行为的具体内容”。

| 字段 | 类型 | 必填 | 来源 | 说明 |
|---|---|---|---|---|
| `event_id` | string，UUID v4 | 是 | 客户端生成 | 全局唯一。同一 `event_id` 只能代表同一条事件，见第 8 节幂等与冲突。 |
| `event_type` | string，枚举 | 是 | 客户端 | 见第 2 节。未知类型直接拒绝，不存库。 |
| `schema_version` | integer | 是 | 客户端 | 当前为 `1`。事件字典升级时递增，见第 13 节。 |
| `session_id` | string，UUID v4 | 是 | 客户端 | 学习会话 ID。V0.0 为模拟会话，见 TD-03 `learning_sessions`。 |
| `lesson_id` | string 或 null | V0.0 可空 | 客户端 | 课程 ID，如 `pinyin-intro`。V0.0 模拟活动可为 null，但字段必须出现，不许省略。真实课程阶段必填。 |
| `lesson_version` | string 或 null | V0.0 可空 | 客户端 | 课程版本号，如 `1.0.0`。与 `lesson_id` 同进同出：`lesson_id` 为 null 时也为 null。 |
| `activity_id` | string | 是 | 客户端 | 活动稳定 ID，如 `act-001`。同一课程内唯一，改名即换 ID，不复用旧 ID。 |
| `occurred_at` | string，ISO 8601 UTC | 是 | 客户端 | 行为实际发生时间，见第 5 节。格式 `2026-11-20T09:00:00.123Z`，必须带 `Z`。 |
| `received_at` | string，ISO 8601 UTC | 否（客户端不许传） | 服务端生成 | 服务端收到并校验通过后生成。客户端若传此字段，直接拒绝。 |
| `seq` | integer，服务端递增 | 否（客户端不许传） | 服务端生成 | 全局单调递增的同步序号，见第 1.1 节。写入成功后才分配，永不复用。响应里必须带 `seq`。 |
| `payload` | object | 是 | 客户端 | 各事件的具体内容，见第 3 节。必须为对象，不许为 null、数组或字符串。 |

校验失败一律不存库，返回 4xx，见第 7.4 节。

**禁止字段：** Payload 与信封里不许出现 `user_id`、`student_id`、`teacher_id`、`role`、`is_admin`、`seq`、`received_at` 等字段。身份只从服务端会话 / 测试身份上下文取，见第 6 节。客户端传了这些字段也一律忽略并拒绝——不静默丢弃，以免掩盖越权尝试。

### 1.1 同步序号 `seq`（v1.1 新增）

教学时间线排序与同步游标是两回事，必须分开，这是 v1.0 最大的可靠性问题。

- `seq` 由服务端在写入时分配，建议用 PostgreSQL `BIGSERIAL` / sequence，全局单调递增，按写入顺序分配，不按 `occurred_at`。
- 同一会话内 `seq` 严格递增，不同会话之间也递增（全局序列）。不保证连续——事务回滚会留空洞，客户端不许假设连续、不许用 `seq + 1` 推算下一条。
- `seq` 只用于同步（历史分页、SSE 断点），不用于教学排序。教学时间线排序仍按 `occurred_at`（见第 5 节）。
- 晚到的事件也会分到一个更大的 `seq`：例如事件 B 发生得早（`occurred_at` 09:00:05）但晚上传，事件 A 发生得晚（09:00:10）但先上传，B 的 `seq` 仍大于 A 的 `seq`。用 `after_seq` 补查时一定能拿到 B，用 `occurred_at` 或 `event_id` 做断点则会漏掉 B。
- 客户端不许传 `seq`，传了直接 422。服务端响应、历史查询、SSE 消息里都必须带 `seq`。
- 备份与恢复后 `seq` 的单调性不变，序列值必须恢复到不小于当前最大 `seq`，永不复用旧值（见 TD-03）。

### 1.2 同一会话写入串行化（v1.2 新增，P0）

v1.1 只保证了 `seq` 的分配顺序，没保证提交后可见的顺序，这是 v1.1 的漏洞。

- 数据库序列（`nextval`）在事务提交前就分配序号，只保证分配顺序，不保证提交顺序。反例：事务 A 先拿到 `seq=41` 尚未提交，事务 B 拿到 `seq=42` 并先提交；教师端看到 42 后把游标记为 42，A 随后提交的 41 再查 `after_seq=42` 就永远拿不到。
- 修正：同一会话的事件写入必须串行化。实现方式为在写事务内对 `session_id` 加 `pg_advisory_xact_lock(hashtext(session_id))`，锁随事务提交或回滚释放。同一会话内提交顺序因此等于分配顺序；不同会话互不影响。
- 跨会话的 `seq` 空洞不影响任何读者：历史查询与 SSE 都按 `session_id` 过滤，只看本会话的 `seq`，其他会话的序号跳号与本会话无关。
- V0.0 每个会话只有一个模拟学生，串行化的吞吐代价基本是零。先保证正确，吞吐以后再评估。
- 替代方案（已考虑，暂不采用）：把 `seq` 改成按会话的计数器（每个会话从 1 开始），语义更干净，但要改 v1.1 定下的全局 `seq` 定义。留待 TD-03 实施时复议，若改则在 TD-02 v1.3 中同步更新。
- 验收见测试 T-16。

---

## 2. 事件类型字典（v1）

### 2.1 V0.0 必须实现（3 个）

这 3 个只用于验证接口、存储、查询和实时通知，不代表已完成第一课的真实教学规则。

| `event_type` | 含义 | V0.0 触发点 |
|---|---|---|
| `activity_entered` | 进入活动 | 模拟学生页面进入一个模拟活动时发一次 |
| `answer_submitted` | 提交答案 | 模拟学生在模拟活动中提交一次作答 |
| `hint_requested` | 请求提示 | 模拟学生点一次“提示” |

### 2.2 已定义、V0.0 不实现（占位）

来自 V2.2 第六章 6.3 节。TD-02 只登记类型名，不展开 Payload，不写实现。真实课程阶段（V0.1 起）按需逐个补 Payload Schema 并升级 `schema_version`。

`session_started`、`lesson_entered`、`audio_started`、`audio_progress`、`audio_seeked`、`audio_completed`、`audio_validated`、`feedback_viewed`、`activity_completed`、`lesson_completed`、`session_ended`

教师 / 任务事件（V0.2 起才展开）：`assignment_created`、`assignment_assigned`、`assignment_completed`、`teacher_feedback_created`、`teacher_feedback_published`、`teacher_feedback_viewed`

书写、情境、协作、AI 事件不在 v1 字典里，需要时另开版本，不许在 V0.0 里自造类型名。

---

## 3. Payload Schema（V0.0 三个事件）

以下用 JSON Schema 草案写法描述。`additionalProperties: false`：多余字段直接拒绝，不静默忽略。

### 3.1 `activity_entered`

```json
{
  "type": "object",
  "required": ["activity_kind"],
  "additionalProperties": false,
  "properties": {
    "activity_kind": {
      "type": "string",
      "enum": ["simulation", "choice", "match", "flashcard", "input"]
    },
    "entry_source": {
      "type": "string",
      "enum": ["lesson_flow", "retry", "resume"]
    }
  }
}
```

- `activity_kind` 必填。V0.0 模拟活动用 `simulation`。
- `entry_source` 可选：`lesson_flow`（正常进入）、`retry`（重做）、`resume`（恢复进度）。

### 3.2 `answer_submitted`

```json
{
  "type": "object",
  "required": ["question_id", "answer"],
  "additionalProperties": false,
  "properties": {
    "question_id": { "type": "string", "minLength": 1, "maxLength": 128 },
    "answer": {
      "anyOf": [
        { "type": "string", "maxLength": 2000 },
        { "type": "number" },
        { "type": "boolean" },
        {
          "type": "array",
          "maxItems": 10,
          "items": {
            "anyOf": [
              { "type": "string", "maxLength": 500 },
              { "type": "number" },
              { "type": "boolean" }
            ]
          }
        }
      ],
      "description": "作答内容。V0.0 不判对错，只原样记录。"
    },
    "attempt_no": { "type": "integer", "minimum": 1 },
    "time_spent_ms": { "type": "integer", "minimum": 0 }
  }
}
```

- `question_id` 必填，同一活动内稳定。
- `answer` 必填，只许四种形式：字符串（≤2000 字符）、数字、布尔，或数组（≤10 项，每项只许字符串 ≤500 字符 / 数字 / 布尔）。不许为 null，不许为对象，不许嵌套数组或对象。超过限制直接 422，见测试 T-14。
- `attempt_no` 可选，从 1 开始，同一题多次提交递增。客户端不传时服务端不补——不猜第几次。
- `time_spent_ms` 可选，≥0，从进入本题到提交的毫秒数。客户端自己计时，服务端不校验真实性，只校验范围。
- **V0.0 不判对错。** 是否正确、得分多少是评价规则的事，不在事件里写 `is_correct`、`score`。V0.1 起如需判题，另加评价事件，不改本事件。

### 3.3 `hint_requested`

```json
{
  "type": "object",
  "required": ["question_id"],
  "additionalProperties": false,
  "properties": {
    "question_id": { "type": "string", "minLength": 1, "maxLength": 128 },
    "hint_level": { "type": "integer", "minimum": 1, "maximum": 3 }
  }
}
```

- `question_id` 必填，与 `answer_submitted` 的同一题 ID 对应。
- `hint_level` 可选，1–3，表示第几次提示。不传即视为第 1 级，服务端不推断。

---

## 4. 字段校验规则

服务端对每条事件按以下顺序校验，任一步失败即拒绝，不存库：

1. **JSON 合法：** 请求体必须是合法 JSON 对象，不是对象直接 400。
2. **信封完整：** 第 1 节必填字段缺失、类型错误、空字符串，一律 422。
3. **枚举与范围：** `event_type` 不在字典里、Payload 枚举值不在列表里、整数越界，一律 422。
4. **Payload 结构：** 按第 3 节 Schema 校验，多余字段、缺必填字段、类型错误，一律 422。
5. **时间戳：** 按第 5 节校验，超差一律 422。
6. **会话存在：** `session_id` 在 `learning_sessions` 里不存在，一律 404（不是 422，避免把“会话不对”和“字段不对”混成一类）。
7. **身份与权限：** 按第 6 节校验，未授权一律 401 / 403。

校验错误响应必须包含 `code`、`message`、`field`（定位到具体字段，如 `payload.question_id`），不许只返回一句含糊的 `invalid request`。

---

## 5. 时间戳规则

- `occurred_at` 必须为 ISO 8601 UTC，带毫秒可有可无，但必须带 `Z`，不接受 `+08:00` 这种带时区的写法——客户端统一转成 UTC 再发。
- `received_at` 由服务端在校验通过、写入前生成，格式同上。`received_at >= occurred_at` 正常情况下成立；若客户端时钟超前，允许 `occurred_at` 比服务端当前时间最多超前 5 分钟，超过即 422（时钟偏差过大）。
- `occurred_at` 早于服务端当前时间 7 天以上，直接 422（过期事件不补传，见第 10 节）。
- 同一会话内事件的 `occurred_at` 不要求严格单调递增——允许乱序到达。教学时间线排序与同步游标分开：
  - 教学时间线排序（展示用）：按 `(occurred_at ASC, received_at ASC, event_id ASC)`，展示给教师看。
  - 同步游标排序（分页与断点用）：按 `seq ASC`，见第 1.1 节、第 7.3 节。不要用 `occurred_at` 或 `event_id` 做断点——晚到的早发事件会被漏掉。
- 服务端不信任客户端时间做任何业务判定（比如会话超时、有效听音）。V0.0 只记录，判定留给后续规则引擎。

---

## 6. 身份与授权（V0.0）

- V0.0 没有真实账号。身份来自 TD-03 的 `test_actors`：模拟学生、模拟教师各一个测试身份，由服务端测试会话上下文绑定。
- 客户端请求时不传身份字段。服务端从测试会话里取 `actor_id`，写入事件的内部归属字段（不暴露在客户端可见的信封里，见 TD-03）。
- 模拟学生只能写自己会话的事件，模拟教师只能读、不能写学生事件。越权写一律 403。
- 真实账号阶段（V0.2 起）：身份改为服务端 session + HttpOnly Cookie 校验，规则不变——客户端身份字段依然禁止，教师只能读授权班级 / 任务的数据，见 V2.2 第三章。TD-02 不在此展开真实鉴权细节，只冻结“身份不来自客户端”这一条。

---

## 7. API 契约（V0.0）

基础地址：`/api/v1`。全部返回 JSON，`Content-Type: application/json; charset=utf-8`。

### 7.1 提交事件 `POST /api/v1/events`

V0.0 一次只收一条事件，不收批量。批量是后续需求，不许在 V0.0 里自加。

**请求：**

```http
POST /api/v1/events
Content-Type: application/json

{
  "event_id": "3f8a2c1e-7b4d-4a9e-8c1f-2d5e6a7b8c9d",
  "event_type": "answer_submitted",
  "schema_version": 1,
  "session_id": "9b1a2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d",
  "lesson_id": null,
  "lesson_version": null,
  "activity_id": "act-001",
  "occurred_at": "2026-11-20T09:00:00.123Z",
  "payload": {
    "question_id": "q-001",
    "answer": "a",
    "attempt_no": 1,
    "time_spent_ms": 4200
  }
}
```

**成功响应：**

- 首次写入：`201 Created`
- 重复提交同一 `event_id` 且内容完全一致：`200 OK`，返回已存的那条，不重复计分（见第 8 节）

```json
{
  "event_id": "3f8a2c1e-7b4d-4a9e-8c1f-2d5e6a7b8c9d",
  "event_type": "answer_submitted",
  "schema_version": 1,
  "session_id": "9b1a2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d",
  "lesson_id": null,
  "lesson_version": null,
  "activity_id": "act-001",
  "occurred_at": "2026-11-20T09:00:00.123Z",
  "received_at": "2026-11-20T09:00:00.350Z",
  "seq": 42,
  "status": "stored"
}
```

响应里必须带 `seq`。客户端收到后把 `seq` 存为本会话的同步检查点（不是 `occurred_at`），断线重连和分页续查都用它。

**关键点：** 只有数据库持久化成功后才返回 201 / 200。写库失败、SSE 推送失败都不影响这个顺序——SSE 失败不导致事件写入失败，事件写入失败不许先返回成功再后台补写。

### 7.2 查询单条事件 `GET /api/v1/events/{event_id}`

- 存在：`200`，返回与 7.1 相同的事件对象。
- 不存在：`404`，`{"code": "event_not_found", "message": "event not found"}`。

### 7.3 查询会话历史 `GET /api/v1/sessions/{session_id}/events`

用于教师端历史查询、SSE 断线补查、服务器重启后恢复。

查询参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `after_seq` | 否 | 只返回 `seq` 大于该值的事件，用于断点续查（同步用）。不传即从头查。 |
| `after_occurred_at` | 否 | 只返回 `occurred_at` 晚于该时间的事件，用于教学时间过滤，不用于同步断点。 |
| `event_type` | 否 | 按类型过滤，逗号分隔，如 `answer_submitted,hint_requested` |
| `limit` | 否 | 默认 100，最大 500，超过按 500 截断并在响应里注明 |

响应：

```json
{
  "session_id": "9b1a2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d",
  "events": [ { "event_id": "...", "seq": 42, "...": "..." } ],
  "next_after_seq": 42,
  "latest_seq": 42,
  "has_more": false
}
```

- 同步分页固定按 `seq ASC`。`next_after_seq` 为本页最后一条的 `seq`，没有下一页时为 `null`。
- `latest_seq` 为查询时刻本会话最大的 `seq`（会话无事件时为 `null`）。它是 SSE 交接的起点，见第 11 节：客户端拿它去建 SSE 连接，服务端从它之后补发。
- 展示层拿到事件后，再按 `(occurred_at ASC, received_at ASC, event_id ASC)` 重排为教学时间线。同步顺序与展示顺序分开，不混用。
- 不许用 `after_event_id` 做断点（v1.0 已废除）：晚到的早发事件排在断点之前，会被漏掉，见第 1.1 节。

会话不存在返回 404。无权限返回 403。

### 7.4 错误码表

| HTTP | `code` | 含义 |
|---|---|---|
| 400 | `invalid_json` | 请求体不是合法 JSON 对象 |
| 401 | `unauthorized` | 未提供有效测试会话 / 登录会话 |
| 403 | `forbidden` | 身份无权写此会话 / 读此会话 |
| 404 | `session_not_found` / `event_not_found` | 会话或事件不存在 |
| 409 | `event_conflict` | 同一 `event_id` 内容不一致，见第 8 节 |
| 422 | `validation_failed` | 字段、枚举、范围、时间戳校验失败，响应里带 `field` |
| 500 | `internal_error` | 服务端异常，不暴露堆栈 |

所有错误响应统一为 `{"code": "...", "message": "...", "field": "..."}`，`field` 只在 422 时必填。

---

## 8. 幂等与冲突（AT02、AT03）

- `event_id` 在 `learning_events` 里是唯一键（见 TD-03）。数据库层兜底，不只靠应用层判断。
- 客户端重试同一条事件时，必须原样重发同一个 `event_id` 和同一份内容，不许换新 ID——换 ID 就是新事件，会重复计分。
- 服务端收到已存在的 `event_id` 时：
  - 内容逐字段完全一致（含 `occurred_at`、Payload 每个字段）：返回 `200 OK`，返回已存事件，不写新行，不触发重复 SSE 推送。
  - 内容有任何不一致：返回 `409 Conflict`，`code: event_conflict`，不覆盖、不更新、不写新行。客户端收到 409 后不许自动改 ID 重发——那是新事件，会掩盖冲突。要由人工 / 日志排查。
- 比较“内容一致”时不比较 `received_at` 和 `seq`（都是服务端生成的，每次都不一样），只比较客户端提交的全部字段。
- 并发重复提交时以数据库唯一约束为准，先写入的胜出，后到的按上述规则返回 200 或 409，不许出现两条同 ID 的行。

---

## 9. 服务端确认与重试分表（v1.1 修正）

v1.0 把 4xx、5xx 都归为未确认进补传队列，与第 10 节只重试网络错误、超时和 5xx 自相矛盾。v1.1 按状态码分表，不许把所有错误都放进补传队列。

| 结果 | 是否确认 | 客户端动作 |
|---|---|---|
| 201 / 200 | 已确认 | 出队，记录 `seq` 为同步检查点 |
| 409 `event_conflict` | 不确认，但不重试 | 停止，从队列移出到死信日志并报告冲突。不许改 ID 重发（那是新事件，会掩盖冲突） |
| 422 `validation_failed` | 不确认，不重试 | 停止，从队列移出并记日志（含 `field`），修客户端后再发。不许自动重发同一份错误内容 |
| 400 `invalid_json` | 不确认，不重试 | 停止，修客户端 |
| 401 `unauthorized` | 不确认 | 重新认证一次，仍 401 则停止并提示用户重新登录 |
| 403 `forbidden` / 404 | 不确认，不重试 | 停止并报告，不许重试 |
| 5xx / 超时 / 断网 | 未确认，可重试 | 进补传队列，按第 10 节指数退避重试 |

- 服务端确认只代表“事件已持久化”，不代表“学习状态已更新”“教师已看到”“判题已完成”。V0.0 没有这些后置动作，不许把确认语义扩大。
- 响应里的 `received_at` 是服务端写入时间，客户端收到后可用于本地排序参考，不许用它代替 `occurred_at` 做业务判定。`seq` 才是同步检查点。

---

## 10. 客户端补传（AT06）

- 客户端维护一个本地未确认事件队列（内存即可，V0.0 不要求 IndexedDB 持久化）。事件先入队、再发送，收到确认后出队。
- 只有可重试错误才留在队列里重试：网络断开、超时、5xx。按指数退避重试：1s、2s、4s、8s，上限 30s，超过 5 次仍失败即停止自动重试并在页面上提示用户，不许无限重试打爆服务端。
- 不可重试错误（400、403、404、409、422，以及重新认证后仍 401）不进重试队列，直接从队列移出到死信日志并报告，不许自动重发。
- 网络恢复后按 `occurred_at` 顺序补传，不许乱序插队。补传时仍用原 `event_id`，服务端按第 8 节去重。补传的事件会分到更大的 `seq`，教师端用 `after_seq` 补查不会漏，见第 1.1 节。
- 超过 7 天未确认的事件直接丢弃并记一条本地日志，不许再发（服务端也会 422 拒绝，见第 5 节）。
- 页面关闭 / 刷新时未确认事件在 V0.0 允许丢失——V0.0 是模拟验证，不要求跨页面持久化。真实课程阶段（V0.1 起）再做持久化队列。
- 补传不许改 `occurred_at`。那是行为发生时间，不是发送时间。

---

## 11. SSE 实时推送（AT05）

### 11.1 端点

```
GET /api/v1/sessions/{session_id}/stream
Accept: text/event-stream
```

- V0.0 只给模拟教师端用：教师页面打开即订阅某一个模拟会话的流。
- 连接后服务端不推全部历史（v1.0 的做法，数据长了会撑不住）。交接必须写成明确协议，否则历史查询结束和 SSE 建立之间的空档会丢事件（v1.2 新增，P0）。四步交接协议：
  1. 教师端先走 7.3 分页历史查询拿初始数据（`after_seq` 从 0 或上次已知的 `seq` 开始，`limit` 分页拉完），展示层按 `occurred_at` 重排为教学时间线。记下响应里的 `latest_seq`（记为 `S0`）。
  2. 用 `GET /api/v1/sessions/{session_id}/stream?after_seq=S0` 建立 SSE 连接。服务端连接成功后先发一条 `ready` 消息，带当前最新 `seq`（`data: {"latest_seq": 42}`），告诉客户端同步起点。
  3. 服务端在 `ready` 之后，先补发 `seq` 大于 `S0` 的全部事件（按 `seq` 排序），再推新增事件。空档里提交的事件因此一定会被补发，不会两头都漏。
  4. 客户端收到事件后按 `event_id` 去重：补发与补查可能重复投递同一条事件，重复的只展示一次。去重是客户端的责任，服务端不保证恰好一次投递，只保证至少一次。
- 每个 SSE 消息格式：

```
event: learning_event
id: 42
data: {"event_id": "...", "seq": 42, "event_type": "answer_submitted", "...": "..."}
```

`id:` 就是 `seq`（整数转字符串），不是 `event_id`。客户端断线重连时用它做断点。

- 心跳：每 15 秒发一次 `event: heartbeat`，`data: {}`，防止中间代理断开空闲连接。心跳不是学习事件，不写库、不计分。
- SSE 只做通知，不做权威数据源。教师端收到 SSE 后仍以 7.3 的历史查询为准做最终展示——SSE 丢了、乱了、重复了，都靠历史查询纠正。

### 11.2 断线与重连

- 客户端断线后自动重连，重连时带 `Last-Event-ID`（浏览器原生支持，值为 `seq`）或查询参数 `after_seq=<最后收到的 seq>`。
- 服务端收到重连请求后，补推 `seq` 大于该断点的缺失事件（按 `seq` 排序），再继续推新增事件。不许跳号。
- 若断点 `seq` 已过期 / 无法定位，服务端发一条 `resync: true` 消息，客户端改走 7.3 分页历史查询重新同步，不许服务端一次性推全部历史。
- 初始交接与断线重连用同一套游标逻辑，区别只在起点：初始交接的起点是历史查询返回的 `latest_seq`（见 11.1 四步协议），重连的起点是最后收到的 `seq`。两种情况都必须补发断点之后的事件并按 `event_id` 去重，只测“连上后断开再重连”是不够的，见测试 T-17。
- V0.0 验收标准（AT05）：断线 5 秒内重连并补查完成，教师端最终看到的事件列表与数据库一致，不多不少。

---

## 12. 历史补查与恢复（AT04）

- 服务器重启后，事件不丢失、不重复、不乱序，`seq` 不复用、不回退。重启后教师端重新打开历史查询（7.3）或重连 SSE（11.2），看到的内容与重启前一致。
- 客户端不许把 SSE 当唯一历史来源。任何“教师端看到的列表”都必须能从 `GET /sessions/{id}/events` 复现，否则就是实现错误。
- 数据库备份与恢复见 TD-03 与 V2.2 第十三章。恢复后 `event_id` 唯一性、`seq` 单调性、排序、去重规则不变。

---

## 13. 版本管理

- `schema_version` 当前为 `1`。每一次事件字典或 Payload Schema 的不兼容变更（删字段、改必填、改枚举、改类型）都必须递增版本号，并记入变更记录。
- 兼容变更（只加可选字段）不强制升级版本号，但必须在变更记录里写清，且旧客户端不传新字段时服务端不报错。
- 服务端必须同时接受当前版本和上一个版本（N 与 N-1），不接受更早的版本——更早的直接 422，`code: validation_failed`，`field: schema_version`。
- 事件字典、Payload Schema、API 的唯一事实来源是本文 + `contracts/` 里的 Schema 文件（V0.0 起建）。代码里的校验逻辑必须从 Schema 生成或与 Schema 逐项对过，不许代码与文档各写一套。
- 任何人改事件字典、Payload、API 契约，都必须先提 Issue、负责人同意（见 CONTRIBUTING.md 第 5 节），改完同步更新本文、`contracts/` 与测试，缺一不可。

---

## 14. 契约测试（对应 V2.2 第十八章）

以下测试在 V0.0 开发完成前必须全部通过。测试用模拟学生页面 + 模拟教师页面 + 真实 PostgreSQL 跑，不用 Mock 数据库代替。

| 编号 | 验收项 | 测试用例 |
|---|---|---|
| AT01 | 学习事件写入 | 依次发 `activity_entered`、`answer_submitted`、`hint_requested` 各 1 条，全部返回 201；查库三条都在，字段与发送一致；`GET /sessions/{id}/events` 能查到三条，顺序正确。 |
| AT02 | 重复事件 | 同一条 `answer_submitted` 用同一 `event_id` 发两次：第一次 201，第二次 200；库里只有一条；教师端计数只算一次；SSE 只推一次。 |
| AT03 | 同 ID 不同内容 | 同一 `event_id`，第一次发 `answer: "a"`，第二次发 `answer: "b"`：第二次返回 409，`code: event_conflict`；库里仍是第一次的内容，未被覆盖。 |
| AT04 | 服务器重启 | 写 3 条事件后重启 FastAPI 与 PostgreSQL，再查历史：3 条都在，内容、顺序不变；`GET /events/{id}` 逐条可查。 |
| AT05 | SSE 中断与初始交接 | 教师端先分页查历史拿到 2 条（记下 `latest_seq`），按四步协议建 SSE，断开 5 秒，期间再写 1 条，重连时带 `after_seq` 补推 1 条，最终看到 3 条，不多不少；展示按 `occurred_at` 排序，同步按 `seq` 补查；初始交接的空档覆盖见 T-17。 |
| AT06 | 网络失败补传 | 断网后在客户端发 2 条事件（未确认），恢复网络后自动补传，全部返回 201 / 200；库里 2 条都在，无重复；`occurred_at` 仍是断网时的原始时间。 |

**补充边界测试（V0.0 必做，不占 AT 编号）：**

- T-01 未知类型：`event_type: "foo"` 返回 422，不存库。
- T-02 多余字段：Payload 多传一个 `score: 100` 返回 422，不存库。
- T-03 身份字段：信封或 Payload 里传 `user_id` 返回 422，不存库。
- T-04 时间戳超差：`occurred_at` 比服务端时间超前 10 分钟返回 422；早于 7 天前返回 422。
- T-05 会话不存在：`session_id` 随机 UUID 返回 404，不存库。
- T-06 客户端传 `received_at` 返回 422，不存库。
- T-07 排序乱序到达：先发 `occurred_at` 较晚的事件，再发较早的，展示层仍按 `occurred_at` 排序；同步分页按 `seq` 排序，两者分开。
- T-08 越权写：模拟教师身份调用 `POST /events` 返回 403，不存库。
- T-09 `limit` 越界：`limit=1000` 按 500 返回，并在响应里注明已截断。
- T-10 空 `answer`：`answer: null` 返回 422；`answer: ""` 允许（空字符串是合法作答，判题时再处理）。
- T-11 晚到事件不遗漏（P0-1 回归）：先发事件 A（`occurred_at` 09:00:10），再发事件 B（`occurred_at` 09:00:05，发生得早但晚上传）。客户端在收到 A 后以 `after_seq=A.seq` 续查，必须拿到 B；若用 `occurred_at` 做断点会漏 B，本测试即失败。
- T-12 409 不重试：同一 `event_id` 发冲突内容得 409 后，客户端不许自动重发，队列里不许再有这条，死信日志里有记录。
- T-13 422 不重试：发非法 Payload 得 422 后，客户端不许自动重发，队列里不许再有这条。
- T-14 `answer` 上限：数组 11 项返回 422；数组里嵌对象返回 422；字符串超过 2000 字符返回 422；字符串数组单项超过 500 字符返回 422。
- T-15 SSE 不推全量历史：会话里已有 150 条事件时新连 SSE，服务端不许一次推 150 条；教师端必须先走分页历史查询（`limit` 100 分两页）拿初始数据，SSE 只推之后的新增事件。
- T-16 并发提交不漏查（P0-1 回归）：两个写事务并发向同一会话提交事件，其中一个延迟提交。全部提交后，查 `after_seq=40` 必须同时拿到两条，按 `seq` 排序，不多不少。等价的反例表述：若实现不做串行化，事务 A 先拿 `seq=41` 未提交、事务 B 拿 `seq=42` 先提交，读者看到 42 后推进游标就会永远丢 41——本测试就是要证伪这种情况。串行化实现下 B 会等 A 提交后才继续，`seq` 的分配顺序与提交顺序一致，游标推进不得跳过任何已提交序号。
- T-17 初始交接空档不漏不多（P0-2 回归）：教师端完成分页历史查询（记下 `latest_seq=S0`）后、SSE 建立之前，刻意写入 1 条新事件；按四步协议建连后，该事件必须出现，且恰好出现一次（补发与补查重复时按 `event_id` 去重）。只测“连上后断开再重连”不算通过本测试。

---

## 15. 与 TD-03 的接口

TD-03 实现数据库时必须满足本文的要求，缺一不可：

- `learning_events.event_id` 唯一键，`learning_sessions.session_id` 主键。
- `learning_events.seq` 为 `BIGSERIAL` / sequence 生成的全局单调递增整数，非空、唯一、有索引，写入时分配，永不复用；备份恢复后序列值不小于当前最大 `seq`。
- 同一会话写入串行化（第 1.2 节）：写事务内先执行 `SELECT pg_advisory_xact_lock(hashtext(session_id))`，再分配 `seq`、插入事件行、提交。锁随事务结束释放。TD-03 必须把这一步写进写入流程，缺了它 T-16 一定失败。
- 事件全字段入库：信封 11 个字段（含 `seq`）+ Payload 原样 JSONB + 服务端归属的 `actor_id`（内部字段，不在 API 响应里暴露）。
- 查询支持：按 `session_id` + `seq ASC` 分页（同步用）；展示排序按 `(occurred_at, received_at, event_id)`（展示用）；按 `event_id` 单查；按 `event_type` 过滤。
- 写入必须是事务：校验通过 → 写入 → 返回确认，中间失败即回滚，不许“写了一半返回成功”。
- 具体字段类型、索引、Alembic 迁移见 TD-03，本文只定契约，不定表结构。

---

## 16. 未决事项（不阻塞 V0.0）

| 事项 | 说明 | 处理阶段 |
|---|---|---|
| 批量提交 | V0.0 一次一条。批量接口是否要、一次最多几条 | V0.1 前 |
| 客户端持久化队列 | V0.0 内存队列即可，页面关闭允许丢失 | V0.1 前 |
| 音频事件 Payload | `audio_*` 系列的具体字段（播放区间、覆盖率计算） | V0.1 有效听音实现前 |
| 录音事件 | 录音上传与 COS 的关联字段 | V0.2 前 |
| 真实鉴权 | session + Cookie + CSRF 的具体实现 | V0.2 前 |
| 事件保留期限 | 普通学习事件存多久、什么时候归档 / 删除 | 真实学生数据采集前 |
| SSE 鉴权 | 教师订阅流时如何校验授权班级 | V0.2 前 |

---

## 17. V0.1 进度恢复范围澄清（v1.2 新增）

PRD V2.2 路线图要求 V0.1“学习进度恢复”，但真实账号到 V0.2 才建设，两处合起来容易误读，特此澄清（PRD 冻结版不重写，以本节为准）：

- V0.1 的“进度可恢复”指：**同一模拟身份、跨刷新恢复**。同一个测试身份在同一设备上刷新页面后，能回到第一课的学习进度，事件历史可查。
- 不是“跨设备、按真实学生恢复”。跨设备恢复需要真实账号与服务端身份，那是 V0.2 的验收，不写进 V0.1。
- V0.1 验收时只测前者：同一测试身份刷新后进度仍在；跨设备恢复在 V0.1 不测、不算缺口。

---

## 18. V0.0 停止条件（v1.2 新增）

V0.0 是最小学习事件闭环，一人开发最容易把它做成长期基建。停止条件写死：

- 完成标准：AT01–AT06 全部通过，加 T-11、T-16、T-17 三个回归测试通过，加一次数据库备份恢复演练通过。
- 通过后立即进入第一课迁移（V0.1），不再扩展教师端展示，不再扩通用事件框架，不再加批量接口或新事件类型。
- 时间盒：V0.0 按 V1.3 估计为 5–10 天。超时了砍范围，不延长：先砍教师端展示的丰富程度，再砍非核心测试，最后才考虑延时间——延时间需要负责人明确同意。
- 任何超出 V0.0 范围的需求（完整账号、COS、AI、协作）都不进入 V0.0，走 Issue 记到对应版本。

---

## 附录 A：完整示例（一次模拟学习）

```http
POST /api/v1/events
```

```json
{
  "event_id": "11111111-1111-4111-8111-111111111111",
  "event_type": "activity_entered",
  "schema_version": 1,
  "session_id": "22222222-2222-4222-8222-222222222222",
  "lesson_id": null,
  "lesson_version": null,
  "activity_id": "act-001",
  "occurred_at": "2026-11-20T09:00:00.000Z",
  "payload": { "activity_kind": "simulation", "entry_source": "lesson_flow" }
}
```

```json
{
  "event_id": "33333333-3333-4333-8333-333333333333",
  "event_type": "hint_requested",
  "schema_version": 1,
  "session_id": "22222222-2222-4222-8222-222222222222",
  "lesson_id": null,
  "lesson_version": null,
  "activity_id": "act-001",
  "occurred_at": "2026-11-20T09:00:05.000Z",
  "payload": { "question_id": "q-001", "hint_level": 1 }
}
```

```json
{
  "event_id": "44444444-4444-4444-8444-444444444444",
  "event_type": "answer_submitted",
  "schema_version": 1,
  "session_id": "22222222-2222-4222-8222-222222222222",
  "lesson_id": null,
  "lesson_version": null,
  "activity_id": "act-001",
  "occurred_at": "2026-11-20T09:00:12.000Z",
  "payload": { "question_id": "q-001", "answer": "a", "attempt_no": 1, "time_spent_ms": 7000 }
}
```

三条都返回 201 后，响应里的 `seq` 依次为 1、2、3（按写入顺序）。教师端 `GET /api/v1/sessions/22222222-2222-4222-8222-222222222222/events` 应返回三条，同步按 `seq` 分页，展示按 `occurred_at` 排序；SSE 只推连接后新增的事件，初始数据走分页历史查询。

---

> 本文件冻结后，改动走 Issue + 负责人同意 + 同步更新 `contracts/` 与测试。V0.0 开发以本文为准，不以口头约定为准。
