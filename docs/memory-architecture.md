# Memory Architecture — Long-Term Design

> Status: RFC (for review) · Owner: opencode-cognee · Supersedes: 早期“最小可用版”草案
>
> 目标：给 OpenCode 一套**可长期使用、可审计、可迁移**的记忆系统。
> 基线不是“能用就行”，而是对齐 Claude Code / Codex 的官方做法，并补上多实例与治理能力。

---

## 1. 官方做法：我们到底该学什么

### 1.1 Claude Code（官方文档：How Claude remembers your project）

Claude Code 把记忆拆成**两种作者、两层机制**：

| | CLAUDE.md（人写） | Auto memory（Claude 写） |
|---|---|---|
| 作者 | 人 | Claude |
| 内容 | 指令、规则、约定 | 学到的偏好、纠正、项目上下文 |
| 作用域 | managed / user / project / local | 每个 git 仓库一份，worktree 共享 |
| 加载 | 每次会话 | 每次会话，**只加载 `MEMORY.md` 前 200 行或 25KB** |
| 用于 | 编码规范、工作流、架构 | 偏好、纠正、代码推不出的项目事实 |

关键细节（直接决定我们的设计）：

1. **分层与优先级**：managed policy → user → project → local；目录树从根到 cwd 依次拼接，
   **离 cwd 越近越后加载**；子目录的 CLAUDE.md 在读到该目录文件时才按需加载。
2. **大小纪律**：单个 CLAUDE.md 目标 <200 行；>4MiB 直接跳过；长的拆 `.claude/rules/*.md`，
   规则可用 `paths:` 只对匹配文件生效；多步流程放 **skills**（按需加载）。
3. **Auto memory 是文件，不是黑盒**：目录 `<config>/projects/<project>/memory/`，
   `MEMORY.md` 是索引，其余是主题文件；**纯 Markdown，可读、可编辑、可删除**；
   写入时记录 `modified` 时间戳；`/memory` 可审计。
4. **选择性**：代码能推出的（架构、路径、debug 修复）**不记**；CLAUDE.md 已写的**不重复记**。
5. **定位**：CLAUDE.md / auto memory 都是**上下文/建议**，不是强制；硬约束用 hooks /
   permissions 实现。
6. **子 agent 不继承主会话的 auto memory**（fork 除外），各自独立。

### 1.2 Claude API Memory Tool（官方 docs：memory_20250818）

- 文件系统隐喻：`/memories` 目录；命令 `view` / `create` / `str_replace` / `insert` /
  `delete` / `rename`；**客户端执行**，存储由你自己掌控。
- 工具描述里明确要求 Claude **动手前先 view memory 目录**；`create` 是“创建或覆盖”，
  追加要先 view 再 create。
- 启示：**记忆的读写原语应该像文件操作**（可定位、可局部改、可删），而不是只能 append 的向量库。

### 1.3 Codex（官方 AGENTS.md / Codex docs）

- `AGENTS.md` 是“给 agent 的 README”：全局 `~/.codex/AGENTS.md` → 仓库根 → cwd，
  合并后注入（每条是独立 user-role 消息，靠近顶部）；**越近优先级越高**；
  默认 **32 KiB 上限**（`project_doc_max_bytes`），支持 `AGENTS.override.md` 与 fallback 文件名。
- `skills/` 与 `.codex/skills/` 提供**按需**的任务知识；`/init` 可生成 AGENTS.md。
- **Memories**：可选的生成层（本地默认关闭），把历史会话总结成文件（摘要、持久条目、
  近期输入、证据），后续会话注入；官方把它当**状态**而不是配置。
- 启示：**静态指令与生成记忆分离**；生成记忆要能“被看见、被关掉、被清理”。

### 1.4 结论（六条硬原则）

1. **两种作者分离**：人写的策略（AGENTS.md/rules）与 agent 写的记忆（auto memory）不能混。
2. **文件优先**：持久知识必须是人类可读的 Markdown；向量/图谱是索引与检索，不是唯一副本。
3. **小核心 + 渐进披露**：常驻的只有“索引 + 画像 + 当前项目策略”；细节按需加载（rules/skills/检索）。
4. **显式作用域与优先级**：org → user → project → local；冲突有确定规则，不靠模型猜。
5. **写入在后台、读取要便宜**：捕获/蒸馏异步；默认召回不调 LLM。
6. **全生命周期**：去重、合并、衰减、取代、删除、导出、审计；没有这些就不是长期方案。

---

## 2. 记忆分类（对齐 Claude / Codex / LangMem）

| 类型 | 作者 | 存放 | 加载方式 | 生命周期 | 例子 |
|---|---|---|---|---|---|
| **procedural / policy** | 人 | git：`AGENTS.md`、`rules/*.md`、`skills/*/SKILL.md` | 常驻或按路径/按需 | 永久（PR 变更） | 构建命令、禁止事项、部署流程 |
| **profile** | agent 生成 + 人可改 | `memory/profile.md` | 每轮常驻（≤2KB） | 30 天衰减 | 偏好、沟通风格、工作习惯 |
| **semantic（事实/决策）** | agent 蒸馏 + 人审 | `memory/topics/**` + cognee | 索引常驻，正文检索 | 180 天零命中回收 | “为什么选 A 不选 B” |
| **episodic（会话）** | agent 自动 | cognee（episode） | 仅检索 | 90 天转 archive | 某次排障全过程 |
| **reference** | agent | `memory/topics/reference/**` | 索引 + 按需 | 180 天 | “看板在 Grafana 哪个面板” |

> 与 Claude 的 `user/feedback/project/reference` 对应：profile≈user，semantic≈feedback+project，
> reference 同名；episodic 是 Claude 不显式存、但 Codex Memories 会总结的那层。

---

## 3. 总体架构

```
┌────────────────────────── Policy Vault（人写，git）──────────────────────────┐
│ AGENTS.md（org/user/repo/cwd 链） · rules/*.md（path-scoped） · skills/*/SKILL.md │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │ 只读注入 / 按需加载
┌───────────────────────────────────▼──────────────────────────────────────────┐
│                        opencode-cognee plugin（纯 TS）                        │
│                                                                              │
│  Context Assembler（每请求）                                                  │
│    policy 链 → profile → MEMORY.md 索引 → 检索结果 → 触发的 skill              │
│                                                                              │
│  Memory Vault（agent 写，卷 + 备份；纯 Markdown）                              │
│    MEMORY.md（索引，≤200 行/25KB） · profile.md · topics/<type>/<slug>.md      │
│    archive/ · .index.json（hash/命中/来源/游标）                               │
│                                                                              │
│  Lifecycle                                                                   │
│    Capture(idle) → Distill(nightly) → Review/Apply → Consolidate/Decay       │
└───────────────┬──────────────────────────────────────────────┬───────────────┘
                │ episode（append-only，带溯源）                 │ 检索（默认 CHUNKS）
┌───────────────▼──────────────────────────┐   ┌───────────────▼───────────────┐
│ cognee（单写者 + PVC）                    │   │ Review CLI / PR               │
│  dataset: opencode_<instance>            │   │  memory diff / conflict /      │
│  node_set: project/type/date/scope       │   │  policy 变更建议（人合）        │
│  graph + vector + temporal + conflict    │   └───────────────────────────────┘
└──────────────────────────────────────────┘
```

**为什么不是“只用一个向量库”**：Claude 和 Codex 的长期实践都表明——
**常驻的必须是短小、结构化、可审计的文件**；检索层解决“量大了以后找得到”，不解决“该不该记、记成什么”。

**为什么不是“只用文件”**：episode 数量会线性增长（我们现状 2252 条/月级），
文件索引扛不住跨会话的“相似问题/历史决策”检索；图谱还能做时间有效性与冲突。

---

## 4. 数据模型

### 4.1 Policy Vault（git，人写）

```
AGENTS.md                      # 仓库根：项目概述、构建/测试、边界
packages/*/AGENTS.md           # 子项目就近覆盖（Codex 风格）
.opencode/rules/*.md           # 可选：path-scoped 规则（frontmatter: paths）
.opencode/skills/*/SKILL.md    # 多步流程，按需加载
~/.config/opencode/AGENTS.md   # 用户级（个人偏好）
/etc/opencode/AGENTS.md        # 组织级（managed，只读）
```

合并顺序（低→高）：managed → user → repo root → … → cwd；同目录下 `*.local.md` 最后。
**冲突规则**：更具体的作用域覆盖更宽的；同层冲突 → 视为配置错误，CI 检查并报警。

### 4.2 Memory Vault（卷，agent 写）

```
<data>/memory/
  MEMORY.md                 # 索引：一行一条，<=200 行 / 25KB
  profile.md                # 常驻画像，<=2KB
  topics/
    semantic/<slug>.md
    reference/<slug>.md
  archive/<yyyy-mm>/...     # 过期/被取代
  .index.json               # hash、created/modified、hits、last_hit、source_session、supersedes
  .cursor.json              # 蒸馏游标（上次处理到哪个 episode）
```

主题文件 frontmatter（固定 schema）：

```yaml
---
id: mem_01J...
type: semantic | reference | profile
scope: org | user | project
project: <repo-hash>          # scope=org 时为空
created: 2026-11-26T10:00:00Z
modified: 2026-11-26T10:00:00Z
confidence: 0.0-1.0
evidence: [ep_..., ep_...]    # 溯源到 episode
supersedes: mem_01H...        # 被本条目取代的旧条目
sensitivity: normal | private # secret 永不入库
---
```

`MEMORY.md` 一行格式：`- [title](topics/semantic/slug.md) — 一句话 · type · modified · hits`

### 4.3 Episode（cognee）

一次会话一篇，append-only，带 `episode_id` / `session_id` / `project` / `scope` / `date` /
`types`。检索时作为**证据层**；稳定结论才升格为 topic 文件。

### 4.4 cognee 组织

| 项 | 值 |
|---|---|
| dataset | `opencode_<instance>`（每实例一个；不建多库） |
| node_set | `project:<hash>` / `type:<episode\|semantic\|reference>` / `date:<YYYY-MM-DD>` / `scope:<project\|org>` |
| 重要度 | 决策/教训用 `importance_weight` 提升；临时排障降低 |
| 时间 | 用 cognee 的 temporal / 版本能力表达“当时为真、后来被取代” |
| 冲突 | 开 conflict review；未决冲突进 Review 队列，不静默覆盖 |

---

## 5. 写入路径（Capture → Distill → Publish）

### 5.1 Stage 1：Capture（会话 idle，后台）

```
on idle(sessionID):
  msgs = ctx.session.context({sessionID})
  if len(msgs) < 2: return
  ep = generate.text(session model, EPISODE_PROMPT, last 60 msgs / 32KB)
  ep = scrub(ep)                      # 凭据/PEM/token
  if near_dup(ep, recent): return
  wal.put(ep); remember(ep, dataset, node_set, background=true, self_improvement=false)
```

- 只捕获**会话级** episode；不逐工具灌（噪声 + token）。
- `self_improvement=false`：避免每条都跑 improve；改善收敛到夜间。
- 写入前 redaction；`sensitivity` 标记；secret 形态直接拒写。
- WAL 落 `ctx.storage`，失败退避重试；Pod 重启不丢。

### 5.2 Stage 2：Distill（夜间，按项目）

```
for project in active_projects:
  eps = episodes_since(.cursor[project])
  cands = generate.text(DISTILL_PROMPT, eps + current_topics)   # 输出结构化候选
  for c in cands:
    action = reconcile(c, existing)   # add / update / merge / supersede / no-op
    route(action, c)                  # auto-apply | review | policy-PR
  rebuild_index_if_needed()
  .cursor[project] = last_episode
  write_diff_report()                 # 可审计
```

**Reconcile 规则**（对齐 Claude 的“别记代码能推出的/别重复”）：

| 情况 | 动作 |
|---|---|
| 与现有条目语义重复（hash/相似度 >0.9） | merge（补 evidence，不新增） |
| 新事实推翻旧事实 | 新条目 `supersedes` 旧条目；旧条目移 archive |
| 代码/AGENTS.md 已能推出 | 丢弃 |
| 只对一次会话有效 | 留在 episode，不升格 |
| 涉及偏好/纠正 | 进 review（人确认后写 profile/topic） |
| 涉及规则/流程变更 | 生成 **policy PR 建议**，绝不自动改 AGENTS.md |

**路由策略**：
- `project` / `reference` 低风险 → 自动应用；
- `feedback` / `user`（偏好）→ Review 队列（默认待审，可配置自动）；
- 任何冲突 / 敏感 / 规则变更 → 必须人审。

### 5.3 Stage 3：Publish

- 写 topic 文件（原子替换 + `modified`）；
- 更新 `MEMORY.md`：超 200 行/25KB 时合并/降级/归档，**绝不截断丢条目**；
- 更新 `.index.json`（hash、hits、来源）；
- 产出 `distill-report.md`（新增/更新/取代/丢弃 + 理由），供审计。

### 5.4 不记什么

- 代码能推出的：目录结构、依赖版本、显而易见的修复；
- 已在 AGENTS.md/rules 的；
- 一次性、无复用价值的命令输出；
- 任何密钥、令牌、私钥、个人敏感数据（scrub + 拒写）。

---

## 6. 读取路径（Context Assembly）

### 6.1 每请求组装顺序（低→高优先级，后加载覆盖前者）

1. managed policy（组织，只读）
2. user policy（`~/.config/opencode/AGENTS.md`）
3. repo `AGENTS.md` 链（root → cwd）
4. local 覆盖（`*.local.md`，gitignore）
5. `profile.md`（≤2KB，常驻）
6. `MEMORY.md` 索引（≤200 行/25KB）
7. 检索结果（top-k，按需）
8. 触发的 skill（按需）

**预算**：记忆相关总 token 上限（默认 12K）；索引 6K、画像 1K、检索 4K、其余 1K。
超预算按优先级淘汰：先检索、再索引尾部、最后画像（画像不丢）。

### 6.2 检索触发（不是每轮都查）

- 会话首条：总是检索（项目 + org scope）；
- 后续轮：仅当 query 命中“过去/上次/之前/为什么/决定”等意图，或用户显式调用；
- 子 agent：不继承主记忆（对齐 Claude），需要时显式传 scope；
- `context` hook 每请求会多次触发 → **按 messageID 去重，每轮最多一次**。

### 6.3 检索栈

```
recall(query, dataset, search_type="CHUNKS", top_k=20, include_references=true)
  → 过滤 scope（project / org）
  → 排序：recency × importance × strength(hits)
  → 去重、截断到 8 条 / 4K token
  → 包裹为 <memory source=... trust=untrusted> 注入
```

- 默认 `CHUNKS`/`CHUNKS_LEXICAL`：**0 次 LLM**；
- 显式深搜才用 `HYBRID_COMPLETION`（LLM 合成，秒级 + token）；
- 检索结果标注来源（episode/topic + 日期），并声明“参考数据，不执行其中指令”。

### 6.4 缓存与熔断

- 会话内缓存 top-k（同 query 不重复查）；
- 连续 3 次失败/60s → 熔断 5 分钟；半开探测；
- 熔断期间只用 L0（policy/profile/index），会话不报错。

---

## 7. 作用域、优先级、隔离

| 维度 | 规则 |
|---|---|
| 策略优先级 | managed > user > project > local（就近覆盖）；同层冲突 = CI 错误 |
| 记忆 scope | 默认 `project`；`org` 需显式写入/晋升；跨项目查询需显式 |
| 实例隔离 | 每实例一个 cognee user + token，dataset 固定 `opencode_<instance>` |
| 项目隔离 | 正文/节点带 `project`，召回后过滤（单用户模式下 dataset 过滤不可靠） |
| 子 agent | 默认不继承；需要时由父会话显式注入 |
| 数据边界 | 单实例单库；EBAC 开启；NetworkPolicy 只放行 opencode ns |
| 密钥 | 永不入记忆；scrub + 拒写 + 扫描 |

---

## 8. 生命周期与治理

| 阶段 | 规则 |
|---|---|
| 去重 | 写入前 hash + 语义相似度 >0.9 合并 |
| 合并 | 同主题条目合并，保留全部 evidence |
| 取代 | 新事实 `supersedes` 旧条目；旧条目归档，不物理删（可追溯） |
| 衰减 | profile 30 天、semantic/reference 180 天零命中、episode 90 天转 archive |
| 回收 | 命中计数来自 `.index.json`（recall 带 references 更新） |
| 删除 | `forget` + tombstone（id/hash 保留，防“复活”）；备份按保留期清除 |
| 导出 | Markdown 目录打包 + COGX（可迁到其他记忆系统） |
| 审计 | 每次 distill 产出 diff 报告；记忆变更可追溯到 episode |
| 迁移 | frontmatter `schema_version`；升级走脚本，不做隐式改写 |

**Review 界面**：提供 CLI（`memory list/show/diff/approve/reject`）与 `/memory` 等价能力，
让“agent 写了什么”随时可见、可改、可删（对齐 Claude 的 `/memory`）。

---

## 9. 可靠性 / 运维

| 项 | 方案 |
|---|---|
| 写入不丢 | WAL（ctx.storage）+ 幂等 episode_id + 退避重试 |
| 读取降级 | 后端挂 → L0 照常；召回跳过；0 报错 |
| 存储 | cognee 单写者 + PVC；内嵌库单进程（官方约束），不跑多副本 |
| 备份 |  nightly 备份到 OBS；RPO 24h；每季度恢复演练 |
| 扩展 | 超过单实例/容量阈值 → Postgres + pgvector + Neo4j（官方支持路径） |
| 观测 | capture 成功率、distill 延迟、recall p95、hit rate、token/会话、冲突数、后端错误率 |
| 告警 | capture 连续失败、distill 积压、recall p95 超 SLA、备份失败 |
| 变更 | 记忆 schema 版本化；部署前跑迁移 dry-run |

---

## 10. 安全与合规

- 写入前脱敏：PEM、`api_key/token/secret/password`、云 AK/SK、`.env` 形态；
- `sensitivity: private` 的条目只在 project scope 检索，不晋升 org；
- 静态加密（卷）+ 传输 TLS（集群内可 mTLS）；
- 最小权限：每实例 token、EBAC、NetworkPolicy；
- 删除权：`forget` + 备份清除 + 导出可验证；
- 审计：谁在何时写入/修改/删除了哪条记忆（episode 溯源 + diff 报告）。

---

## 11. 评估（长期方案必须可度量）

- **黄金集**：每项目 50 个问题（决策、事故、偏好、引用），人工标注期望命中；
- **离线指标**：hit@8、MRR、答案忠实度、token/会话、p95 延迟；
- **影子对比**：与 opencode-mem 双写 2–4 周，按周对比同一批问题；
- **回归**：每周 CI 跑黄金集，指标下降 >10% 阻断发布；
- **漂移审计**：每月 review 记忆 diff + `prompt-audit`（对齐 Claude 的 `/doctor prompt-audit`）；
- **成本**：统计 LLM token/会话，设定预算告警。

---

## 12. 从 opencode-mem 迁移与影子验证

### 12.1 迁移

1. 导出 SQLite：content/type/tags/project/session/created_at（现状 2252 条 / 876KB，2022 条 capture）。
2. 分流：
   - curated（~230 条）→ 蒸馏成 topic 文件（semantic/reference），进 `MEMORY.md`；
   - capture（2022 条）→ 合成 episode 批次（每 50 条/篇），标 `legacy`；
   - 原文存 `legacy-export.jsonl`（本地，可回溯）。
3. 一次性 `remember(background=true, self_improvement=false)`，控制批次。

### 12.2 影子验证（只让一套生效，不是长期并跑）

目标：用有限时间证明“新系统不劣于 mem”，而不是维护两套记忆。

| 阶段 | 时长 | 写入 | 注入 | 看什么 |
|---|---|---|---|---|
| **A 离线回放** | 2–3 天 | 只导入 mem 历史 | 无（脚本对比） | 每项目 50 问：hit@8、MRR、答案忠实度、token |
| **B 影子双写** | 1–2 周 | mem + cognee 都写 | **只有 mem 注入**；cognee 只在影子评估会话注入 | 捕获质量、召回质量、成本、失败率 |
| **C 灰度切流** | 1 周 | cognee 为主，mem 停写 | **只有 cognee 注入**（先 team 一个实例） | 真实体验、延迟、误召回 |

规则：

- **任何阶段都不允许两套同时注入**：上下文冲突、token 翻倍、模型不知道信谁。
- 影子评估会话用独立 dataset/标记，不污染生产记忆。
- 双写期间多一次 cognify/会话，设预算告警；保留 kill switch。
- 退出标准：C 阶段连续 1 周（或 50 个会话）不劣于 mem 基线；否则回滚。
- 回滚：恢复 mem 插件 + 旧卷（保留 30 天）；cognee 侧数据保留不删。
- 优先做 A：离线回放能提前暴露 80% 的召回质量问题，避免盲目双写 2–4 周。

---

## 13. 路线图（按能力，不按“最小版”）

| 阶段 | 交付 | 退出标准 |
|---|---|---|
| **P1 Foundation** | policy 链、Memory Vault、索引、episode 捕获、首条召回 | 捕获成功率 ≥99%；召回 p95 <300ms；重启不丢 |
| **P2 Distill & Review** | 夜间蒸馏、reconcile、review CLI、profile 更新 | 每条 topic 有 evidence；冲突 100% 进队列 |
| **P3 Governance** | EBAC、备份/恢复、审计、删除/导出 | 越权测试通过；恢复演练通过 |
| **P4 Scale & Eval** | 外部存储（PG+pgvector+Neo4j）、黄金集、CI 回归 | 多实例；指标达标 |
| **P5 Cutover** | 离线回放 → 影子双写 → 灰度切流 → 下线 mem | C 阶段 1 周不劣于 mem |

---

## 14. 验收标准（长期）

1. **功能**：自动捕获、首条注入、画像、去重、取代、清理、scope、引用溯源 全部可用。
2. **可审计**：任意一条记忆能追到 episode；每次蒸馏有 diff 报告。
3. **可编辑**：纯 Markdown，人可改可删；agent 不改 policy。
4. **可迁移**：Markdown + COGX 导出，能换后端。
5. **性能**：召回 p95 <300ms（CHUNKS）；捕获不影响会话延迟。
6. **可靠**：后端挂 0 报错；WAL 不丢；RPO 24h / RTO 1h。
7. **隔离**：实例间、项目间、子 agent 间不串。
8. **成本**：≤2 次 LLM/会话（摘要 + distill 摊销）；召回 0 LLM。

---

## 15. 待决问题（需要团队拍板）

1. auto memory 是否进 git？建议：**不进**（噪声大），走卷 + 每日导出；policy 变更走 PR。
2. 蒸馏模型：会话模型 vs 更便宜的小模型？（建议 distill 用小模型，摘要用会话模型）
3. 保留期默认值：episode 90 天 / semantic 180 天 / profile 30 天衰减，是否合适？
4. `org` 级记忆的晋升门槛：谁有权晋升？建议：人工 review + 双人同意。
5. 是否需要 Discussions 作为 RFC 讨论区（当前仓库未开启）。

---

## 16. 参考（官方）

- Claude Code — How Claude remembers your project: <https://code.claude.com/docs/en/memory>
- Claude API — Memory tool (`memory_20250818`): <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>
- Codex — AGENTS.md 指南: <https://developers.openai.com/codex/guides/agents-md>
- AGENTS.md 开放格式: <https://agents.md/>
- Codex CLI — config / `project_doc_max_bytes`: <https://developers.openai.com/codex/config-reference>
- Cognee — Remember / Recall / Improve / Forget: <https://docs.cognee.ai/core-concepts/main-operations/remember>
- Cognee — MCP tools: <https://docs.cognee.ai/cognee-mcp/mcp-tools>
- Cognee — Data isolation & multi-tenancy: <https://docs.cognee.ai/core-concepts/multi-user-mode/data-isolation-and-multi-tenancy>
- Cognee — Session distillation: <https://docs.cognee.ai/guides/session-distillation>
- Cognee — Personalized memory: <https://docs.cognee.ai/core-concepts/further-concepts/personalized-memory>
- Mem0 — How Mem0 works: <https://docs.mem0.ai/core-concepts/memory-types>
- Graphiti — temporal context graphs: <https://github.com/getzep/graphiti>
- Letta — memory blocks: <https://docs.letta.com/guides/agents/memory-blocks>
- LangMem — conceptual guide: <https://langchain-ai.github.io/langmem/concepts/conceptual_guide/>
- OpenCode — plugin server / hooks: <https://opencode.ai/docs/build/plugins/server>
