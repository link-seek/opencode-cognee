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

### 1.4 这四件事的官方最佳实践（不是我们拍的）

| 关注点 | 官方实践（来源） | 我们的落点 |
|---|---|---|
| **蒸馏质量** | Anthropic *Context Engineering*：compaction 保留架构决策、未解 bug、实现细节，丢弃冗余工具输出；先最大化 recall 再提 precision；structured note-taking；subagent 只回 1–2K token 摘要 | episode schema 固定 Request/Outcome/Decisions/Errors；**工具原文不入库**；蒸馏 prompt 先 recall 后 precision；子会话只交摘要 |
| **记什么** | Claude Code *Best Practices*：只写模型从仓库看不到的；同一个纠正出现两次才写；CLAUDE.md <200 行；能给检查就给检查命令 | 写入前“可推导性”过滤；**corrected-twice 作为晋升信号**；`MEMORY.md` 硬上限；验证命令写进 episode |
| **对账** | Claude memory：定期审计矛盾、合并/删除过期、`/doctor prompt-audit`；memory 是建议不是强制 | reconcile 增加 **contradiction audit**；冲突进 review；规则变更只出 PR；policy 与 memory 分离 |
| **评估** | Anthropic *Demystifying evals*：20–50 个真实任务起步；code/model/human 三类 grader；capability vs regression；pass@k / pass^k；balanced sets；读 transcript；稳定环境；partial credit | 黄金集 20–50/项目起步；命中用 deterministic grader，答案用 LLM rubric + 人工校准；回归集近 100%；**每周读失败 transcript** |
| **治理** | Claude Code：deterministic（hooks/deny/managed settings）vs non-deterministic（memory）；硬规则不放 memory。Codex：managed hooks only、32KiB 上限、closest wins | 安全/权限/禁止事项走 hooks/permissions；memory 只做建议；org policy 只读；容量上限与 override 规则 |

**一句话**：官方已经把“怎么蒸馏、记什么、怎么对账、怎么评估、怎么治理”写成可执行规范；
我们只是把它们落到 OpenCode 的 hook 与 cognee 的存储上。任何“我们自己发明”的规则，
都应该先在这四份文档里找依据，找不到才新增。

来源：
- Anthropic — Context engineering: <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic — Claude Code best practices: <https://www.anthropic.com/engineering/claude-code-best-practices>
- Anthropic — Demystifying evals for AI agents: <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
- OpenAI — Codex best practices: <https://learn.chatgpt.com/guides/best-practices>

### 1.5 结论（六条硬原则）

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

### 2.5 分层：记忆协议（vendor-neutral）vs 适配器

**蒸馏质量、对账规则、评估、治理，和接 OpenCode / cognee / 任何具体工具无关**。
它们属于“记忆协议”层；工具只提供执行原语。正确的切分是：

| 层 | 内容 | 是否依赖工具 |
|---|---|---|
| **记忆协议** | 分类、写入/读取规则、对账、取代、生命周期、评估、治理 | **否** |
| **能力契约** | 后端必须提供的最小原语（下表） | 只依赖“能力”，不依赖品牌 |
| **适配器** | OpenCode plugin hooks；cognee MCP/REST；文件 vault | 是 |

**能力契约（后端最小要求）**：

| 原语 | 用途 | 缺失时的降级 |
|---|---|---|
| append(episode, id, ts, scope, provenance) | 捕获 | 无法做，直接不可用 |
| retrieve(query, scope, top_k) → 稳定 id | 召回/对账 | 只能全量扫文件 |
| update / supersede / delete by id | 对账、取代、清理 | 只能“时间戳 + 过滤”，取代不可追溯 |
| filter by scope/project/type | 隔离与精度 | 检索后客户端过滤（成本更高） |
| export / import | 迁移、备份 | 锁死单一后端 |
| （增强，非必需）graph / temporal / conflict / importance | 提升蒸馏与排序 | 用文件索引 + 规则替代 |

**结论**：
- 协议层可以独立成文、独立测试；换宿主或换后端只改适配器。
- 但“无关”不等于“零成本”：如果后端只有 append+retrieve（纯向量库），
  对账会降级为“时间戳+过滤”，取代/冲突不可追溯——这时要么用文件层做权威副本，
  要么换一个满足契约的后端。**约束来自能力，不来自品牌。**

### 2.6 Build vs Buy：优先用现成组件，不自己写引擎

**结论先说：不自己写记忆引擎。** 2026 年已经有多个可直接用于 OpenCode 2 的组件，
覆盖自动捕获、自动注入、混合检索、查看器；我们只保留“策略 + 治理 + 评估”这些无法外包的部分。

候选（数据截至 2026-11-26，GitHub API / npm）：

| 组件 | License | OpenCode 2 | 自动捕获/注入 | **多用户/隔离** | 存储/共享 | 状态 |
|---|---|---|---|---|---|---|
| **AgentMemory** (`rohitg00/agentmemory`) | Apache-2.0 | ✅ full plugin（22 hooks） | ✅（12 auto hooks） | `USER_ID`/`TEAM_ID`/`AGENT_ID` **标签隔离** + team share；**无角色/ACL** | 本地 server + file state；`--instance` | 30.6k★，活跃，477 issues |
| **CodeMem** (`kunickiaj/codemem`) | MIT | ✅（beta，按 2.0.24 验证） | ✅（每 prompt 注入） | 项目/团队共享 + P2P；**无 per-user ACL** | SQLite + sqlite-vec | 83★，活跃 |
| **opencode-supermemory** | MIT（插件） | ✅（V2 `server`） | ✅ | **namespace 硬隔离 + scoped key**；多成员/角色仅 Enterprise/云，自托管 local 单租户 | Supermemory 云/自托管 | 1.68k★ |
| **Cognee**（已部署 trial） | Apache-2.0 | ❌ 需薄适配 | 需写 | **EBAC 默认开：users/roles/tenants + dataset 级 read/write/delete/share；每 user/dataset 独立存储** | 图+向量+关系，集中式 | 已跑通 MCP |
| **Mnemon** | Apache-2.0 | ✅ native plugin | ✅ | 待验证 | 图/单二进制 | 747★ |
| **Basic Memory** | AGPL-3.0 | 仅 MCP | ❌ | 单用户文件 | Markdown | 4.7k★ |
| **ByteRover / Cipher** | Elastic-2.0 | ✅ | MCP/skill | 云/本地 | 云 | archived，排除 |

**多用户 + 私有→公共晋升，直接改变排序：**

- **Cognee 领先**：它是自托管开源里唯一做到 **dataset 级 ACL（read/write/delete/share）+ 每用户/每 dataset 独立存储** 的；
  官方文档明确 `ENABLE_BACKEND_ACCESS_CONTROL=true` 时数据按 `<user_uuid>/<dataset_uuid>` 落盘，
  且 dataset 参数在关闭 EBAC 时会被忽略（= 不能靠“约定”隔离）。
- **AgentMemory / CodeMem 只适合“一人一实例、无跨用户 ACL”**：它们的 user/team 是标签与共享工具，
  没有角色、没有权限校验，不能作为“多用户硬隔离”的底座。
- **Supermemory** 的 namespace 是硬隔离，但多成员/角色/治理在 **Enterprise/云**；自托管 local 是单租户。
- 因此：**如果“多用户 + 私有/公共分层”是硬需求，Cognee 是默认选型**；
  AgentMemory/CodeMem 退居“单用户/单团队”候选，Supermemory 仅在允许云/企业版时考虑。

**bake-off 评分权重（按本需求调整）**：隔离/权限 40%、召回 25%、捕获 15%、成本/体积 10%、维护 10%。
入围：**Cognee**、Supermemory（若允许云/企业版）、AgentMemory（仅验证标签隔离是否够用）。

**无论选谁，这几件事仍要自己写**：

- `AGENTS.md` 分层与注入顺序；
- **私有 → 抽象 → 公共的晋升流水线**（见 §7.3）；
- 评估黄金集与回归；
- 迁移与回滚。

> 这也修正了早期设计的默认假设：自研 `opencode-cognee` 是**兜底方案**；但“多用户 ACL”这一条让 Cognee 从兜底变成首选引擎。

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
│  u_<user> (private) / t_<team> / org_common│   │  memory diff / conflict /      │
│  node_set: project/type/date/scope       │   │  promotion review / policy PR  │
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
scope: private | team | org
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
| dataset | 三层：`u_<user_id>`（private）/ `t_<team_id>`（team）/ `org_common`（org）；Cognee 每 dataset 独立存储 |
| node_set | `project:<hash>` / `type:<episode\|semantic\|reference>` / `date:<YYYY-MM-DD>` / `scope:<private\|team\|org>` |
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
  wal.put(ep); remember(ep, dataset=u_<user>, node_set, background=true, self_improvement=false)
```

- **默认写入用户私有 dataset `u_<user>`**；team/org 只在显式分享/晋升时写（§7.3）。
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
| 同一偏好/纠正出现两次 | 晋升为 profile/topic（Claude Code 的 corrected-twice 规则） |
| 与现有条目矛盾但无法判定 | 进 review，标 `conflict`；不静默覆盖 |
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

- 会话首条：总是检索（private + team + org scope）；
- 后续轮：仅当 query 命中“过去/上次/之前/为什么/决定”等意图，或用户显式调用；
- 子 agent：不继承主记忆（对齐 Claude），需要时显式传 scope；
- `context` hook 每请求会多次触发 → **按 messageID 去重，每轮最多一次**。

### 6.3 检索栈

```
recall(query, dataset, search_type="CHUNKS", top_k=20, include_references=true)
  → 过滤 scope（private / team / org；按权限）
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

## 7. 多用户、隔离与“私有 → 公共”晋升

### 7.1 三层作用域

| Scope | dataset | 所有者 | 读 | 写 | 用途 |
|---|---|---|---|---|---|
| **private** | `u_<user_id>` | 用户本人 | 本人 | 本人 | 个人偏好、项目细节、未验证结论 |
| **team** | `t_<team_id>` | team 服务账号 | team 成员 | team 成员/审核者 | 团队内共享的项目知识 |
| **org** | `org_common` | org 服务账号 | 所有已认证用户 | 仅 `knowledge_reviewer` | 抽象后的公共知识 |

- 默认写入 **private**；任何跨用户可见都必须**显式晋升**，不存在“自动共享”。
- 读取优先级：private > team > org。个人事实以 private 为准；策略/规范类以 org 为准（policy 另走 AGENTS.md）。
- 项目维度是 dataset 内的 `project` 标签；用户/团队维度是 dataset 边界（Cognee 的物理隔离）。

### 7.2 权限矩阵（Cognee EBAC）

| 角色 | private | team | org_common |
|---|---|---|---|
| user | read/write/delete | read（成员） | read |
| team_lead | — | read/write/share | read |
| knowledge_reviewer | — | read | read/write/share |
| admin | — | — | read/write/delete/share |

- 开 `ENABLE_BACKEND_ACCESS_CONTROL=true` + `REQUIRE_AUTHENTICATION=true`。
- 数据按 `<user_uuid>/<dataset_uuid>` 落盘（官方文档），**不是查询期过滤**。
- 共享 dataset 用 `share` 权限授予；**禁止用同名 dataset 约定隔离**。

### 7.3 私有 → 公共的晋升流水线

```
private episode/topic
   │ ① 候选：蒸馏出可复用结论（去人名/路径/一次性细节）
   ▼
candidate (private, status=pending)
   │ ② 抽象：泛化措辞、去标识、只保留证据哈希（不复制原文）
   │ ③ 门槛：≥2 个独立来源 或 同一结论重复 ≥3 次；置信度 ≥0.8
   ▼
review queue
   │ ④ 审核：owner + knowledge_reviewer；看 diff 与证据
   ▼
org_common (status=published, derived_from_hash, reviewed_by, published_at)
   │ ⑤ 可撤销：tombstone + 从 org 移除；private 源不受影响
```

硬规则：

- 晋升**只写抽象后的文本**，不复制 private 原文；`derived_from` 只存哈希，避免反查。
- 晋升**必须人工审核**；模型只能生成候选，不能直接写 `org_common`。
- 撤销/删除要传播：org 条目 tombstone，召回不再返回；审计记录保留。
- 冲突：org 与 private 冲突时，个人回答以 private 为准；org 条目标 `conflicted` 进复核。

### 7.4 身份来源（必须先解决）

OpenCode OSS 的 server auth 是**单账号**（`OPENCODE_SERVER_USERNAME/PASSWORD`），没有内建多用户。
“多用户隔离”必须在部署层建立身份，二选一：

| 方案 | 做法 | 隔离强度 | 成本 |
|---|---|---|---|
| **A. 一人一实例** | 每用户一个 OpenCode pod/namespace，注入该用户的 Cognee token | 强（入口即隔离） | 高（每用户一套 pod） |
| **B. 共享实例 + SSO 网关** | oauth2-proxy/Authentik 在前，按 SSO 身份注入用户头/短期 token；插件按 token 调 Cognee | 强（前提：头不可伪造，插件不信任客户端传的 user_id） | 中（网关 + token 映射） |

**不接受**：共享实例里靠 `USER_ID` 环境变量或模型传参区分用户——那是“约定隔离”，不是权限隔离。

> 如果 team 实例是多人共用同一个登录，必须先做方案 B，或在 team 内改成一人一 pod。

### 7.5 子 agent、用户生命周期与密钥

- 子 agent 默认不继承主记忆；父会话显式传 scope/token。
- **用户生命周期**：创建/禁用/删除；token 轮换与吊销；删除用户时删除其 private dataset，
  team/org 中由该用户贡献的条目按“撤销/保留”策略处理（默认撤销，保留审计）。
- 密钥永不入记忆；scrub + 拒写 + 扫描。
- 审计：每次晋升/撤销记录 `actor / source_hash / reviewer / ts`。

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
- `sensitivity: private` 的条目只在 private/team 检索，不晋升 org；
- 静态加密（卷）+ 传输 TLS（集群内可 mTLS）；
- 最小权限：每实例 token、EBAC、NetworkPolicy；
- 删除权：`forget` + 备份清除 + 导出可验证；
- 审计：谁在何时写入/修改/删除了哪条记忆（episode 溯源 + diff 报告）。

---

## 11. 评估（按 Anthropic evals 方法论，不自己发明）

- **任务来源**：从真实失败/纠正里取，**20–50 个/项目起步**（官方：不要等“几百个”）。
- **结构**：task / trial / grader / transcript / outcome；每个 task 有明确成功标准与参考解。
- **Grader 组合**：
  - code-based：命中、引用、格式、延迟、token（快、可复现）；
  - model-based：答案忠实度、是否有据可查（rubric，需人工校准）；
  - human：抽样盲评，校准 LLM grader。
- **capability vs regression**：能力集允许低通过率（爬坡）；回归集要求接近 100%。
- **非确定性**：多次 trial，报 pass@k（至少一次对）与 pass^k（每次都对），不只看单次。
- **平衡集**：既测“该召回”，也测“不该召回”（避免过度触发）。
- **读 transcript**：每周抽失败样本读，区分“模型错”与“grader 错”；指标下降 >10% 阻断发布。
- **影子对比**：按 §12.2 的 A/B/C 三段跑，不做长期双注入。
- **漂移审计**：每月 review 记忆 diff + `prompt-audit`（对齐 Claude 的 `/doctor prompt-audit`）。
- **成本**：统计 LLM token/会话，设预算告警。

---

## 12. 从 opencode-mem 迁移与影子验证

### 12.1 迁移

1. 导出 SQLite：content/type/tags/project/session/created_at（现状 2252 条 / 876KB，2022 条 capture）。
2. 按**原 owner** 归位：既然旧库是单实例本地库，先按实例/用户映射到 `u_<user_id>`；
   不把任何个人数据直接写进 `org_common`。
3. 分流：
   - curated（~230 条）→ 蒸馏成 topic 文件（semantic/reference），进该用户 `MEMORY.md`；
     其中确实通用的，走 §7.3 晋升流程（抽象 + 审核）后才进 `org_common`；
   - capture（2022 条）→ 合成 episode 批次（每 50 条/篇），标 `legacy`，写回该用户私有库；
   - 原文存 `legacy-export.jsonl`（本地，可回溯）。
4. 一次性 `remember(background=true, self_improvement=false)`，控制批次。
5. 校验：以用户 A 的 token 读不到用户 B 的 dataset（越权测试必须失败）。

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
| **P0 选型** | AgentMemory / CodeMem / Cognee bake-off（同一批 20–50 任务） | 有数据支撑的选型结论；许可/维护/降级评估通过 |
| **P1 Foundation** | 采用选型结果：组件接入 或 Cognee 薄适配；policy 链、索引、捕获、首条召回 | 捕获成功率 ≥99%；召回 p95 <300ms；重启不丢 |
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
7. **隔离**：用户间、项目间、子 agent 间不串；越权读写必须被 Cognee 拒绝（不是靠过滤）。
8. **成本**：≤2 次 LLM/会话（摘要 + distill 摊销）；召回 0 LLM。
9. **晋升**：private → org 只能经抽象 + 人工审核；每次晋升可追溯到 reviewer 与证据哈希；可撤销。
10. **身份**：共享实例必须走 SSO 网关或一人一 pod；不接受 `USER_ID` 约定隔离。

---

## 15. 待决问题（需要团队拍板）

1. **身份方案（阻塞项）**：一人一 pod（A）还是共享实例 + SSO 网关（B）？team 实例是否多人共用登录？
2. 晋升审批：`knowledge_reviewer` 由谁担任？是否需要 owner + reviewer 双人同意？
3. auto memory 是否进 git？建议：**不进**（噪声大），走卷 + 每日导出；policy 变更走 PR。
4. 蒸馏模型：会话模型 vs 更便宜的小模型？（建议 distill 用小模型，摘要用会话模型）
5. 保留期默认值：episode 90 天 / semantic 180 天 / profile 30 天衰减，是否合适？
6. 是否开启 Discussions 作为 RFC 讨论区（当前仓库未开启）。

---

## 16. 参考（官方）

- Anthropic — Context engineering: <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic — Claude Code best practices: <https://www.anthropic.com/engineering/claude-code-best-practices>
- Anthropic — Demystifying evals for AI agents: <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
- Claude Code — How Claude remembers your project: <https://code.claude.com/docs/en/memory>
- Claude API — Memory tool (`memory_20250818`): <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>
- Codex — AGENTS.md 指南: <https://developers.openai.com/codex/guides/agents-md>
- Codex — Best practices: <https://learn.chatgpt.com/guides/best-practices>
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
