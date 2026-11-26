# Cognee 现有功能清单（官方文档核对）

> 目的：在讨论“要自己写什么”之前，先把 Cognee 已经提供的能力列清楚。
> 依据：docs.cognee.ai 官方文档 + 仓库代码（2026-11-26）。每条都标注“自带 / 需确认 / 不自带”。

---

## 0. 一句话结论

Cognee 已经提供：**三存储记忆（关系+向量+图）、remember/recall/improve/forget、会话缓存、
dataset + 权限 + 多用户隔离、JWT/API key、图/向量检索、冲突复核、会话蒸馏、个性化排序、
MCP、可选的 Next.js 前端**。

Cognee **不提供**：**“私有知识 → 抽象 → 团队/组织公共知识”的晋升工作流**、
SSO/OIDC、AGENTS.md 策略分层、OpenCode 插件、定时任务、备份。

---

## 1. 核心记忆模型（自带）

| 能力 | 说明 | 状态 |
|---|---|---|
| 三存储 | relational（文档/chunk/溯源）+ vector（语义）+ graph（实体关系） | ✅ |
| DataPoints / Tasks / Pipelines | 可组合的处理单元；支持自定义 pipeline | ✅ |
| 主操作 | `remember` / `recall` / `improve` / `forget` | ✅ |
| 兼容旧操作 | `add` / `cognify` / `search`；`memify` 已弃用 | ✅/弃用 |
| 去重 | 同一 dataset 内入库去重（content hash） | ✅ |
| 增量加载 | `incremental_loading` 只处理新增/变更 | ✅ |

---

## 2. Remember（自带）

| 能力 | 说明 |
|---|---|
| 永久记忆 | 不传 `session_id`：add + cognify（默认再跑 improve） |
| 会话记忆 | 传 `session_id`：先写缓存，快；可选后台桥接到图 |
| 目标 dataset | `dataset_name` 或 `dataset_id`（共享 dataset 必须用 id） |
| 关闭自动 improve | `self_improvement=False`（add+cognify 仍跑） |
| 后台执行 | `background=True`，用 `cognify_status` 查进度 |
| 标签 | `node_set`（项目/类型/日期） |
| 自定义抽取 | `custom_prompt`、`ontology_key`、`graph_model`、`extractor`（llm/gliner） |
| 分块 | `chunk_size` / `chunker` |
| 结构化导入 | dlt：CSV/数据库连接串（受 `ALLOW_DATABASE_INGESTION` 控制） |
| 文件/URL | 文本、文件、http(s)、S3、git 仓库（代码图） |

---

## 3. Recall（自带）

| 能力 | 说明 |
|---|---|
| 自动路由 | 5 条规则（引号短语/编码规则/代码问题/计数/时间）；默认 `HYBRID_COMPLETION` |
| 显式检索类型 | 见下表 |
| 会话优先 | 有 `session_id` 时先查会话缓存，未命中再查图 |
| 结果溯源 | 每条带 `source`（graph/session/trace/session_context） |
| 作用域 | `datasets`（仅自己的名字）/ `dataset_ids`（共享 dataset）/ `node_name` / `node_type` |
| 只取上下文 | `only_context=True`：不生成答案，返回将送给 LLM 的 prompt |
| 结构化输出 | `response_model`（Pydantic） |
| 反馈影响排序 | `feedback_influence` |
| 数据集路由 | 不指定 dataset 时按 global context index 选最相关的 dataset |
| 共享 dataset | **必须用 `dataset_ids`**；用名字会 404（名字是 owner-scoped） |

**检索类型（官方）**：

- 生成答案：`GRAPH_COMPLETION`（及 COT / context-extension / decomposition / summary）、
  `RAG_COMPLETION`、`HYBRID_COMPLETION`（及 decomposition）、`TEMPORAL`、`BROAD`、
  `AGENTIC_COMPLETION`、`FEELING_LUCKY`
- 仅检索（无 LLM）：`CHUNKS`、`CHUNKS_LEXICAL`、`SUMMARIES`、`SKILLS`、`CODE`、`CODING_RULES`
- 默认关闭：`CYPHER`、`NATURAL_LANGUAGE`（需 `ALLOW_CYPHER_QUERY=true`）

---

## 4. Improve（自带，9 个阶段）

固定顺序：`feedback_weights` → `persist_session_qa` → `persist_agent_traces` →
`extract_agent_context` → `distill_sessions` → `update_user_preferences` →
`build_truth_subspace`（opt-in）→ `review_conflicts` → `global_context_index`。

| 能力 | 说明 |
|---|---|
| 会话桥接 | 把会话 Q&A / trace 写进图（`user_sessions_from_cache`） |
| 会话蒸馏 | 把会话里的 guidance 蒸馏成 `session_learnings` 文档；每个会话一份 summary |
| 事实冲突复核 | `FactConflict` 节点；事实标 current/superseded/conflicting |
| 全局上下文索引 | 每文档 bucket + dataset root；用于检索和 dataset 路由（0 LLM） |
| 反馈权重 | 按会话反馈调整图元素权重 |
| 个性化 | `PERSONALIZATION_ENABLED=true` 时更新 per-(user,dataset) 偏好节点 |
| truth-subspace | opt-in，用于 hybrid rerank |
| 结果报告 | `ImproveResult` 每阶段 completed/skipped/errored |

> 注意：这里的“蒸馏”是**会话内 guidance → 该 dataset 的永久记忆**，
> 不是“个人 dataset → 团队/组织公共 dataset”的晋升。

---

## 5. Forget（自带）

- 单条：`data_id` + `dataset`/`dataset_id`
- 整个 dataset：`dataset`
- 用户全部：`everything=True`
- 清历史：`clean_history=True`
- `memory_only=True`：只删图/向量，保留原始数据
- 删除会传播：污染会话条目按 provenance 清理；distilled lessons 需另行 forget

---

## 6. Datasets / NodeSets / Ontology（自带）

| 能力 | 说明 |
|---|---|
| dataset 名 vs id | 名字 owner-scoped；id 是 uuid5(name+owner+tenant)；共享必须用 id |
| dataset 权限 | read / write / delete / share |
| node_set | 标签；会话可 pin 一个 set；recall 可按 node_name 过滤 |
| ontology | OWL/RDF 上传，`ontology_key` 接地实体抽取 |
| loaders | txt/md/json/pdf/docx/xlsx/pptx/图片/音频/代码等 |
| chunkers | 文本/CSV/JSON/自定义 |

---

## 7. 多用户与权限（自带）

| 能力 | 说明 |
|---|---|
| EBAC | `ENABLE_BACKEND_ACCESS_CONTROL=true` 默认；开启后强制认证 |
| 用户 | email + password；`create_user`；`is_active/is_verified/is_superuser`；`parent_user_id`（agent 用户） |
| 租户/角色 | users / tenants / roles；权限继承（direct + role + tenant） |
| ACL | dataset 级四项权限；按需计算 effective permissions |
| 隔离 | 每 user + dataset 独立存储：`.cognee_system/databases/<user_uuid>/<dataset_uuid>.*` |
| 认证 | `POST /api/v1/auth/login` 换 JWT；`X-Api-Key` 也可；`JWT_LIFETIME_SECONDS` |
| API key | 可哈希存储（`HASH_API_KEY=true`） |
| 支持的隔离后端 | relational: SQLite/Postgres；vector: LanceDB/PGVector；graph: Ladybug/Neo4j Aura |
| 共享 | 按 `dataset_id` 授予 read/write/delete/share；名字不能跨用户解析 |

**没有**：OIDC/SAML/SSO 集成（官方只描述 email/password + JWT + API key）；
用户管理 API 有，但没有“企业目录同步”。

---

## 8. 会话与缓存（自带）

| 能力 | 说明 |
|---|---|
| 会话键 | `(user_id, session_id)` |
| TTL | 默认 7 天（最后写入滑动）；`0` = 不过期 |
| 内容 | Q&A、trace、session context、feedback、summary |
| 类型 | `QAEntry` / `TraceEntry` / `FeedbackEntry` / `SkillRunEntry` |
| 历史窗口 | 最近 10 条 Q&A（固定） |
| node_set pin | 会话首个带 set 的写入会 pin；一个会话只能一个 set |
| 默认会话 | `default_session_<dataset_id>`（按 dataset 隔离） |
| 会话 API | list/get/stats/cost-by-model/delete |

---

## 9. 前端（自带，WIP）

- 代码：`cognee-frontend`（Next.js）；镜像 `cognee/cognee-ui`；端口 3000；
  docker-compose `--profile ui` / `ui-dev`。
- 页面：登录、dashboard、datasets（列表/详情/上传）、graph / knowledge-graph、
  search、sessions、settings、api-keys、activity、analytics、connections、
  integrations、skills、business、releases、memory-gap-analysis、onboarding。
- 权限 UI：`ShareAccessModal`、dataset access、groups、workspace admins/capabilities。
- 官方注：**UI 仍是 WIP，只覆盖最小功能**。
- 另有 `cognee-cli visualize` 生成单文件离线 HTML 图。

**需要实测**：前端是否覆盖完整用户管理（创建/禁用/角色）、共享 dataset 的 id 解析、
以及多租户切换。文档没有承诺企业级管理台。

---

## 10. MCP（自带）

| 工具 | 说明 |
|---|---|
| `remember` | 文本/文件；`dataset_name`、`session_id`、`self_improvement`、`background`、`node_set` |
| `recall` | `search_type`、`datasets`（名字）、`top_k`、`scope`、`include_references` |
| `forget` | data/dataset/everything |
| `code_search` | 代码图查询 |
| `cognify_status` | 后台入库进度 |
| `search_tools` / `call_tool` | 工具发现 |

- 工具模式：`default` / `minimal` / `all`。
- 两种部署：standalone（自带存储）/ API mode（连中心后端）。
- **一个 token = 一个用户**；多用户不能靠 MCP 按请求切用户。
- **recall 只接受 dataset 名字**，共享 dataset 需 `dataset_ids` → MCP 不适用，走 REST/SDK。

---

## 11. 部署与配置（自带）

| 能力 | 说明 |
|---|---|
| Docker Compose | 核心 + `ui`/`ui-dev` profiles；可选 Neo4j |
| Helm chart | 官方仓库有 Kubernetes 部署 |
| 内嵌默认 | SQLite + LanceDB + Ladybug；**单进程**，不能多进程共享 |
| 外部存储 | Postgres + PGVector + Neo4j（多用户支持的组合） |
| 安全开关 | JWT secret、`HASH_API_KEY`、`FILE_ENCRYPTION_*`、`COGNEE_LOG_SEARCH_HISTORY`、`TELEMETRY_DISABLED`、SSRF 限制 |
| 备份 | **无内置**；靠卷/数据库备份 |

---

## 12. 集成与扩展（自带）

- Connectors：Slack、GitHub、Notion、Linear、Gmail、Google Drive、Google Calendar（OAuth）。
- Web URL 抓取（SSRF 限制）、S3、git 仓库代码图（enola）。
- COGX：从 Mem0 / LangMem / Letta / Zep / Graphiti 导入/导出。
- 自定义 pipeline / task / DataPoint / graph model / ontology。

---

## 13. 明确“不自带”的（我们才需要写）

| 需求 | Cognee 是否提供 | 结论 |
|---|---|---|
| 私有 dataset / 团队 dataset / 公共 dataset | ✅ 三个 dataset + ACL 即可 | 不自写 |
| 谁能读哪个 dataset | ✅ read/write/delete/share | 不自写 |
| **哪条私有知识该进团队/组织** | ❌ | 写策略 |
| **抽象/去标识（去人名、路径、一次性细节）** | ❌（PII presort 只扫描） | 写一个 prompt + 人工确认 |
| **晋升审核 / 发布 / 撤销 / 审计** | ❌ | 写 `promote` 命令 + 一行审计 |
| 多用户身份与 SSO | ❌（只有 email/password+JWT） | 写 token broker / 接 SSO 网关 |
| AGENTS.md 策略分层 | ❌ | OpenCode/host 侧 |
| OpenCode 插件 / 自动捕获注入 | ❌ | 写插件 |
| 定时任务 | ❌ | CronJob / 外部调度 |
| 备份/恢复 | ❌ | 卷/数据库备份 |
| 评估黄金集 | ❌ | 自己写 |

---

## 14. 对我们的直接结论

1. **存储、隔离、检索、会话、冲突、蒸馏原语**：直接用 Cognee，不自研。
2. **“私有 → 团队 → 组织”的晋升**：Cognee 只有 dataset ACL，没有工作流；
   我们只需要 `promote` 命令 + 一次抽象 + 人工确认，不是一套服务。
3. **多用户 B 方案**：Cognee 没有 SSO；需要 token broker 把 SSO 用户映射成 Cognee 用户/JWT，
   插件走 REST（不能用 MCP，因为 MCP 一 token 一用户）。
4. **前端**：有，但 WIP；可以用于浏览/分享，不要把晋升流程押在它上面。
5. **不要 fork Cognee**：升级耦合；我们的逻辑放在插件/CLI 这一层。

---

## 15. 官方来源

- 概览/架构：<https://docs.cognee.ai/core-concepts/overview>
- Remember：<https://docs.cognee.ai/core-concepts/main-operations/remember>
- Recall：<https://docs.cognee.ai/core-concepts/main-operations/recall>
- Improve：<https://docs.cognee.ai/core-concepts/main-operations/improve>
- Forget：<https://docs.cognee.ai/core-concepts/main-operations/forget>
- Sessions：<https://docs.cognee.ai/core-concepts/sessions-and-caching>
- Datasets：<https://docs.cognee.ai/core-concepts/further-concepts/datasets>
- 多用户隔离：<https://docs.cognee.ai/core-concepts/multi-user-mode/data-isolation-and-multi-tenancy>
- 权限/ACL：<https://docs.cognee.ai/core-concepts/multi-user-mode/permissions-system/overview>
- 用户：<https://docs.cognee.ai/core-concepts/multi-user-mode/permissions-system/users>
- 安全/认证：<https://docs.cognee.ai/setup-configuration/security>
- MCP：<https://docs.cognee.ai/cognee-mcp/mcp-tools>
- 前端（仓库）：<https://github.com/topoteretes/cognee/tree/main/cognee-frontend>
- 部署（compose）：<https://docs.cognee.ai/how-to-guides/cognee-sdk/deployment/docker-compose-reference>
