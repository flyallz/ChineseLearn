# 开发规范 CONTRIBUTING — 汉语起步 Hanyu Start

适用：当前 1 人开发，未来最多 4 人。负责人保留最终架构决策和生产发布权。

执行基线见 `docs/PRD-V2.2.md`（V2.2 冻结版，执行基线 V1.5）。有冲突以 V2.2 为准，V2.2 没写的按本文件走。

## 1. 你能做什么，不能做什么

**能做：** 本地开发、提 Issue、开功能分支、提 PR、写测试、整理课程内容、做 TD 文档。

**不能做（未经负责人同意）：**
- 直接推 `main`、不经 PR 合并、不 `force push`
- 给生产环境部署、动腾讯云 SSH、数据库、COS 密钥
- 改事件字典、API 契约、数据库迁移（见第 5 节）
- 把真实密码、密钥、真实学生数据、真实录音提交到 GitHub
- 把 `docs/PRD-V2.2.md` 当草稿改——需求变更走 Issue + 变更记录，PRD 只在版本冻结时更新

## 2. 仓库结构（目标 Monorepo）

```
flyallz/ChineseLearn
├── index.html              # 原型单文件版（已冻结，做回归对照用，别删）
├── README.md               # 项目入口：这是什么、怎么跑、去哪看文档
├── CONTRIBUTING.md         # 本文件
├── docs/
│   ├── PRD-V2.2.md         # 冻结版需求基线
│   ├── TD-01-first-lesson-audit.md
│   ├── TD-02-event-contract.md
│   ├── TD-03-database.md
│   └── decisions/          # ADR：一条决策一小段，写清为什么
├── frontend/               # React + TypeScript + Vite（V0.0 起）
├── backend/                # FastAPI + Alembic（V0.0 起）
├── courses/                # 课程 JSON：内容与组件分离
├── contracts/              # 事件与 API 的 Schema（唯一事实来源）
├── infra/                  # Nginx、备份/恢复脚本、部署说明
└── .github/                # PR 模板、CI 检查
```

现在只有原型 + docs 是正常的，`frontend/`、`backend/` 按路线图 P0 / V0.0 再建，不提前搭空架子。

## 3. 本地怎么跑

原型阶段：双击打开 `index.html` 即可，无需安装。

重构阶段（P0 / V0.0 起）：

```bash
# 前端
cd frontend && npm install && npm run dev
# 后端
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && uvicorn app.main:app --reload
# 数据库（本地）
# 用本地 PostgreSQL，库名 hanyu_start_dev，只放模拟数据
alembic upgrade head
```

环境变量只用 `.env`，模板是 `.env.example`，真实值自己本地配，绝不提交 `.env`。

本地数据库只放模拟数据（`test_actors` 那种），真实学生数据不上本地、不进 Git。

## 4. 分支与 PR 流程

分支：
- `main`：稳定版。原型冻结版在这里，新功能合进来前必须通过验收。
- `dev`：开发版。两个人并行时开，`main` 只从 `dev` 合稳定内容。
- 功能分支：从 `dev`（或当前开发分支）切，命名 `feat/xxx`、`fix/xxx`、`docs/xxx`，例如 `feat/audio-progress`。一个分支只做一件事。

流程：
1. 先在 GitHub Issue 里领任务，写清要做什么、验收标准是什么（对照 V2.2 第十八章 AT01–AT20）。
2. 切分支开发，本地跑通类型检查和测试。
3. 提 PR，写清：改了什么、为什么改、怎么测的、影响了哪些验收项。
4. 负责人 review 通过才能合。没通过就按意见改，别自己合。
5. 部署由负责人做，PR 合了不等于上线了。

提交信息：中文即可，一行说清，例如 `feat: 事件 API 增加幂等写入（AT02）`。别用 `update`、`fix bug` 这种空词。

## 5. 冻结项：改之前先提 Issue

这三样是全项目的事实来源，改动会影响历史数据和教师端，**必须先提 Issue、负责人同意后才能改**：

- 事件字典：`event_type`、字段、`schema_version`、`contracts/` 里的 Schema
- API 契约：`TD-02` 里的接口、返回、错误码、幂等与冲突规则
- 数据库迁移：`TD-03` 的表结构，一律走 Alembic 新建迁移，不直接改已合入的迁移文件

其他冻结默认值（改也要先说一声）：有效听音覆盖率 ≥90%（`audio_coverage_v1`）、会话超时 30 分钟无有效活动（`session_activity_v1`）、普通录音默认保留 7 天。

课程内容规则：`lesson_completed`、`assignment_completed`、评价达标是三个独立状态，别混成一个字段。

## 6. 代码与测试要求

- 前端：TypeScript 严格模式，`npm run typecheck` 必须过；组件只做当前课程实际需要的，不提前建组件库。
- 后端：Python 用 Ruff + Black，`ruff check`、`black --check` 过；身份一律从服务端可信上下文取，不信任客户端传的 `user_id`。
- 测试：提 PR 前本地跑通相关测试。事件类必测：重复事件不重复计分（AT02）、同 ID 不同内容冲突拒绝（AT03）、重启后历史可查（AT04）、断线后可补查（AT05）。
- 录音/媒体：上传失败、解码失败、COS 失败时一律不标记成功（AT12、AT13）。本地只用模拟文件，别传真实录音上 GitHub。

## 7. 文档怎么写

- 新人先读：`README.md` → `docs/PRD-V2.2.md` → 对应 `TD-0X` → 本文件。
- 改了实现，顺手改对应的 TD 文档和 `contracts/`，别只改代码不改文档。
- 决策要留痕：在 `docs/decisions/` 里加一小段 ADR，写清：决定了什么、为什么、放弃了什么、什么时候复议。
- 需求本身要改：提 Issue，说明改哪条、为什么、影响哪些版本，负责人确认后记入变更记录，不直接重写 PRD 全文。

## 8. 安全与隐私

- 密钥、密码、Token、COS 密钥、数据库密码只放本地 `.env` 和负责人的密码管理，不进代码、不进 Issue、不进 PR 描述、不进聊天截图。
- 测试账号、测试数据和真实账号、真实学生数据分开。真实数据只在腾讯云私有测试/生产环境出现，且按 V2.2 第十章单独授权。
- 发现泄露（比如不小心提交了密钥）：立刻告诉负责人，别自己悄悄删提交——Git 历史还在，要按负责人的流程处理。

## 9. 新人加入清单（给新同学的 30 分钟版）

1. 负责人把你加为 Collaborator（Write，不给 Admin），你在 GitHub 通知里接受。
2. 克隆 `flyallz/ChineseLearn`，读 `README.md` + `docs/PRD-V2.2.md` + 本文件。
3. 本地跑通原型（打开 `index.html`）和当前开发分支的最小示例。
4. 从 Issue 领一个小任务（建议先做测试或单个组件，别先动核心事件/数据库）。
5. 按第 4 节走分支 + PR，负责人 review 后合并。

---

有拿不准的，先在 Issue 里问，别猜。问一句比合错一次便宜得多。
