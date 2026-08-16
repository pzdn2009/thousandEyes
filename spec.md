# thousandEyes — 规格说明

> 状态：需求讨论稿 v0.1 · 2026-08-16
> 本文档中的盘上数据格式均在本机实测核实（见附录 A），非推测。

---

## 1. 项目定位

一个本地常驻的**终端与 AI Agent 会话控制塔**。

它管两类东西，并把它们统一到一条时间轴上：

- **终端**：编排、克隆、分屏、快速开启、执行历史录制
- **AI Agent 会话**：Claude Code / Codex 的运行状态、执行了哪些命令、改了哪些文件、花了多少 token

一句话目标：**让"我和我的 agent 们在这台机器上做过什么"变成可搜索、可回放、可接管的结构化数据。**

### 1.1 形态

**本地 daemon + Web UI**（已确认）。

- 常驻后台进程持有 PTY、索引库、文件监听
- UI 是纯 Web 前端，通过 WebSocket 连 daemon
- 浏览器打开 `127.0.0.1` 即"本地版"；日后套 Tauri 壳即桌面版；加鉴权反代即远程版——**一套代码三种形态**
- 关掉界面不杀进程（终端管理器的刚需）

### 1.2 范围

- 只管**本机**终端，不做 SSH / 多机（已确认）
- 历史记录做到**命令级结构化 + 输出全量录制**两层（已确认）
- 编排语义：**工作区模板** + **全局热键命令面板**（已确认），不做任务依赖编排、不做命令广播

---

## 2. 非目标

明确不做，避免范围蔓延：

- ❌ 远程机器管理、SSH 连接池、凭据管理
- ❌ 任务依赖编排（`A 起来了再起 B` 这类 compose 语义）
- ❌ 命令广播到多终端
- ❌ 替代 tmux 的 detach/attach 协议兼容
- ❌ 团队协作、多用户、共享会话
- ❌ 自己实现 AI agent；本项目只**观察和调度**已有的 agent CLI

---

## 3. 核心架构主张

### 3.1 三层采集

整个项目唯一的架构主张：**执行历史有三个独立来源，语义层次完全不同，必须分开采集再归一。**

| 层 | 采集什么 | 手段 | 语义强度 |
|---|---|---|---|
| **L1 PTY** | 终端原始字节流 | daemon fork PTY，旁路 tee 到 `.cast` | 弱。视觉真相、可回放，但全是 ANSI 重绘，**无法提取语义** |
| **L2 Shell** | 人亲手敲的命令 | 注入 OSC 133 语义标记 | 强。命令 + cwd + 退出码 + 耗时 |
| **L3 Agent** | agent 跑的命令 | 解析 transcript JSONL + Claude hooks | 最强。命令 + 谁跑的 + 哪个 session + token + 父子链 |

**关键约束：单靠 L1 做不出这个产品。** Claude Code 和 Codex 都是全屏 TUI，PTY 字节流里只有光标移动和屏幕重绘，抠不出"它执行了什么"。**L3 是唯一可靠的语义真相来源，L1 只是给人看的画面。**

### 3.2 统一时间轴

三层归一为同一种事件。这是产品的核心数据资产，也是所有查询的基础。

有了它，能回答现在根本无法回答的问题：

- 今天这个仓库里，哪些命令是我敲的、哪些是 Claude 跑的、哪些是 Codex 跑的？
- 这个文件上周是谁改的——我，还是某个 agent 的哪次 session？
- 我让 Claude 干的这件事，它到底跑了多少条命令？哪条失败了？
- 上个月各项目分别烧了多少 token，哪个 session 最贵？

### 3.3 解耦优势：agent 不必跑在我们的终端里

因为 transcript 落在盘上，**用户在 iTerm 里手启的 `claude`，我们照样能完整索引**。

这带来一个重要的产品决策：可以先交付**零侵入的只读观察者**，不改用户任何习惯，第一周就产生价值；PTY 托管（工作量数倍）留到后面。见 §7 阶段划分。

---

## 4. 系统组成

```
┌─────────────────────────────────────────────────────────┐
│  Web UI  (TypeScript + xterm.js)                        │
│  时间轴 / 状态墙 / 终端网格 / 成本看板 / 命令面板         │
└───────────────┬─────────────────────────────────────────┘
                │ WebSocket (127.0.0.1) + REST
┌───────────────┴─────────────────────────────────────────┐
│  daemon                                                  │
│                                                          │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ PTY 管理器  │  │ Ingest 引擎   │  │ Hook 接收器      │ │
│  │ (L1 + L2)  │  │ (L3 文件监听) │  │ (L3 实时事件)    │ │
│  └─────┬──────┘  └──────┬───────┘  └────────┬────────┘ │
│        │                 │                    │          │
│        └────────┬────────┴────────────────────┘          │
│                 ▼                                        │
│         ┌───────────────┐      ┌──────────────────┐     │
│         │ 事件归一化层   │─────▶│ SQLite + FTS5    │     │
│         └───────────────┘      └──────────────────┘     │
│                                 ┌──────────────────┐     │
│                                 │ .cast 录像存储    │     │
│                                 └──────────────────┘     │
└──────────────────────────────────────────────────────────┘
        │                    │                  │
   本地 PTY 进程      ~/.claude/projects   ~/.codex/sessions
```

### 4.1 daemon 职责

- 持有所有 PTY 进程，转发输入输出到 WebSocket
- 旁路录制 PTY 流为 asciicast 格式
- 监听 agent transcript 目录，增量摄取
- 接收 Claude Code hook 回调（unix socket）
- 维护 SQLite 索引，提供查询 API
- 保存/恢复工作区模板

### 4.2 UI 视图

| 视图 | 内容 |
|---|---|
| **时间轴** | 统一事件流，按项目/actor/时间/关键词筛选，全文搜索 |
| **状态墙** | 所有活跃 agent：running / **等待批准** / idle / 出错 |
| **终端网格** | 分屏布局的实时终端，xterm.js 渲染 |
| **成本看板** | 按项目/日期/模型聚合的 token 消耗 |
| **命令面板** | 全局热键唤出，模糊搜索历史命令、会话、工作区模板 |
| **回放** | 选中一段历史，回放当时的终端画面 |

---

## 5. 数据模型

### 5.1 事件 schema（归一化后）

所有采集层产出同一种事件：

```ts
interface NormalizedEvent {
  ts: number;              // epoch ms
  actor: 'human' | 'claude' | 'codex';
  sessionRef: string;      // 外部 session id
  kind: 'session_start' | 'session_end' | 'prompt' | 'response'
      | 'command' | 'file_edit' | 'notification';
  cwd?: string;
  gitBranch?: string;

  command?: string;        // kind=command
  exitCode?: number;
  durationMs?: number;

  filePath?: string;       // kind=file_edit

  model?: string;          // kind=response
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;

  isSidechain?: boolean;   // subagent 产生的事件
  parentRef?: string;      // 父事件 uuid，还原调用链

  castRef?: string;        // 关联录像文件
  castOffsetMs?: number;   // 录像内偏移

  raw: unknown;            // 原始记录，容错兜底
}
```

### 5.2 SQLite schema

```sql
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,   -- 内部 uuid
  kind              TEXT NOT NULL,      -- 'terminal' | 'agent'
  actor             TEXT NOT NULL,      -- 'human' | 'claude' | 'codex'
  external_id       TEXT,               -- claude sessionId / codex rollout uuid
  project_path      TEXT NOT NULL,      -- 以记录内 cwd 字段为准，不反解目录名
  git_branch        TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  source_version    TEXT,               -- 'claude-code/2.1.206' | 'codex/0.38.0'
  parent_session_id TEXT REFERENCES sessions(id),
  title             TEXT,
  UNIQUE(actor, external_id)
);

CREATE TABLE events (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  ts           INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  cwd          TEXT,
  command      TEXT,
  exit_code    INTEGER,
  duration_ms  INTEGER,
  file_path    TEXT,
  model        TEXT,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  tokens_cr    INTEGER,   -- cache read
  tokens_cw    INTEGER,   -- cache write
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  cast_ref     TEXT,
  cast_offset  INTEGER,
  raw          TEXT       -- 原始 JSON
);

CREATE INDEX idx_events_ts       ON events(ts DESC);
CREATE INDEX idx_events_session  ON events(session_id, ts);
CREATE INDEX idx_events_kind_ts  ON events(kind, ts DESC);
CREATE INDEX idx_sessions_proj   ON sessions(project_path, started_at DESC);

CREATE VIRTUAL TABLE events_fts USING fts5(
  command, file_path, content='events', content_rowid='id'
);

-- 增量摄取断点：daemon 重启后从 offset 续读
CREATE TABLE ingest_state (
  file_path        TEXT PRIMARY KEY,
  inode            INTEGER,
  size             INTEGER,
  byte_offset      INTEGER NOT NULL,
  last_ingested_at INTEGER
);

-- 工作区模板
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  layout      TEXT NOT NULL,   -- JSON：分屏树
  panes       TEXT NOT NULL,   -- JSON：每格的 cwd / 启动命令 / 是否 agent
  created_at  INTEGER,
  updated_at  INTEGER
);
```

**增量摄取规则**：按 `byte_offset` 续读；每次读取前校验 `inode + size`——size 变小或 inode 变化视为文件轮转，从 0 重读。最后一行可能是半行（正在写入），必须等到完整换行才解析。

### 5.3 录像存储

- 格式：asciicast v2（`.cast`），每个终端会话一个文件
- 路径：`~/.thousandEyes/casts/<session-id>.cast`
- 压缩：会话结束后 zstd 压缩
- 配额与保留策略见 §8

---

## 6. Agent Adapter 接口

L3 采集设计成插件式，每家 agent CLI 一个 adapter。目前实现 `claude` 和 `codex`，为 Gemini CLI / opencode 等预留接口。

```ts
interface AgentAdapter {
  id: string;                               // 'claude' | 'codex'

  /** 数据目录是否存在，决定是否启用该 adapter */
  detect(): Promise<boolean>;

  /** 需要递归监听的目录 */
  watchRoots(): string[];

  /** 该文件是否属于本 adapter */
  matches(filePath: string): boolean;

  /**
   * 解析单行。必须容错：
   * - 未知字段忽略
   * - 缺字段降级而非抛错
   * - 解析失败返回 []，并记 warn，绝不中断 pipeline
   */
  parseLine(line: string, ctx: FileContext): NormalizedEvent[];

  /** 拼出恢复该 session 的命令行 */
  resumeCommand(externalId: string, cwd: string): string[];

  /** 可选：实时 hook 支持 */
  installHooks?(socketPath: string): Promise<void>;
}
```

**已知实现要点：**

| | Claude Code | Codex |
|---|---|---|
| 数据根 | `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` |
| 命令提取 | `message.content[].tool_use`，`name=="Bash"` → `input.command` | `payload.type=="function_call"`，`name=="shell"` → `arguments.command[]` |
| session 元信息 | 每行都带 `sessionId`/`cwd`/`gitBranch`/`version` | 首行 `session_meta` 带 `id`/`cwd`/`cli_version` |
| token | `message.usage` 完整 | 需从 `event_msg` 提取（待细查） |
| 调用链 | `uuid` / `parentUuid` / `isSidechain` | `call_id` 关联 |
| 实时 hook | ✅ `SessionStart`/`PreToolUse`/`PostToolUse`/`Notification`/`Stop`/`SubagentStop` | ❌ 无，只能 file watch |
| resume | `claude --resume <session-id>` | `codex resume <id>` |

**实时性策略**：Claude 走 hook（毫秒级，尤其 `Notification` 精确对应"agent 在等你"）；Codex 走 fs watch（秒级）。**两者都必须有 file watch 兜底**，保证 daemon 重启期间漏掉的事件能补齐。

---

## 7. 阶段划分

### Phase 0 — 只读观察者（零侵入） ✅ 已完成

**目标：不动用户任何习惯，最快验证"统一时间轴"这个核心假设。**

- [x] Claude / Codex adapter，全量扫描历史 transcript 建库
- [x] 增量 file watch + 断点续读
- [x] SQLite + FTS5 索引
- [x] UI：统一时间轴（筛选 + 全文搜索）
- [x] UI：按项目聚合视图
- [x] UI：token 成本看板
- [x] 附加：会话视图、本地令牌鉴权、脱敏、手动重扫

**验收结果**（本机实跑）：67 个 transcript 文件 → 70 sessions / 8,700+ events / 11 个项目，首次索引 1.1s；
全文检索可按 `项目 + actor + 关键词` 精确命中命令，带 cwd、时间、退出码、所属 session；
重复扫描新增 0 条（幂等）；watcher 秒级摄取到正在进行的会话。

**此阶段不碰 PTY，不改 shell 配置。**

### Phase 1 — 实时状态墙 ✅ 已完成

- [x] Claude hook 安装器（写 settings，指向 daemon unix socket）
- [x] Hook 接收器 + 事件归一
- [x] UI：状态墙（running / 等待批准 / idle / 出错）
- [x] 全局热键唤出 —— **部分**，见下方说明
- [x] 系统通知（agent 等待输入时）
- [x] 附加：⌘K 命令面板、SSE 实时推送、hook/watch 来源标注

**验收结果**：hook 事件序列 → 状态墙毫秒级反映，`waiting` 自动置顶；SSE 推送经实测可用；
安装器幂等、可逆、自动备份，且**只增删带 `# thousandEyes` 标记的条目，用户自己的 hook 原样保留**。

**「全局热键」的诚实边界**：浏览器页面无法注册操作系统级快捷键。因此拆成两半——
页内 **⌘K 命令面板**（窗口已打开时）+ **`te open` 命令**（供 Raycast / Alfred / skhd / 快捷指令绑定，实现真正的全局唤出）。
真正的进程内全局热键要等 Phase 2 之后的 Tauri 壳。

**状态来源的可靠性差异必须暴露给用户**：Claude 走 hook（毫秒级、状态迁移明确），
Codex 无 hook 机制只能靠 file watch 倒推（秒级、看不出「等待批准」）。UI 上用 `hook` / `watch` 标签区分，
不把推断当事实。

### Phase 2 — 终端托管

- [ ] daemon PTY 管理器（fork / resize / kill / 输入转发）
- [ ] xterm.js 前端 + WebSocket 流
- [ ] 分屏布局（可拖拽调整）
- [ ] 会话克隆（继承 cwd / env / shell 历史）
- [ ] L1 asciicast 录制
- [ ] L2 shell 集成（OSC 133 注入，zsh / bash / fish）
- [ ] 工作区模板保存与一键恢复
- [ ] 回放视图

**shell 集成注入方式**：用 `ZDOTDIR` 重定向或 source 片段，**不直接改写用户的 `.zshrc`**。

### Phase 3 — 缝合：从历史直接接管

- [ ] 时间轴上任意历史 session → 一键在新终端 resume
- [ ] 工作区模板升级：一键起 N 个终端 + M 个预设 agent
- [ ] 命令面板统一入口（历史命令 / session / 模板 三合一）

**这一步把"只读观察"和"终端管理"焊成一个产品，而不是两个功能。**

---

## 8. 安全与隐私

daemon 只绑 `127.0.0.1`，但仍需要：

| 措施 | 说明 |
|---|---|
| **绑定与鉴权** | 只监听 `127.0.0.1`；WebSocket 握手校验本地 token 文件（`~/.thousandEyes/token`，权限 0600） |
| **脱敏** | 可配置正则规则集，默认覆盖常见 token / `export *_SECRET=` / `Authorization:` / 私钥块；写库前脱敏 |
| **禁录开关** | 单个终端可标记"不记录"；也支持按项目路径黑名单 |
| **保留策略** | 结构化事件默认永久（体积小）；`.cast` 录像默认保留 30 天 + 总量上限 5 GB，超限 LRU 淘汰 |
| **导出与清除** | 提供按项目/时间范围一键清除的入口 |

> 注意：**全量录制会涨得比预期快**，配额和淘汰策略必须在 Phase 2 第一版就有，不能事后补。

---

## 9. 风险

### R1 — transcript 格式无稳定性承诺 【高】

它是 agent CLI 的内部实现，随时可能变。本机实测就已看到 `attributionSkill`、`iterations`、`inference_geo` 这类字段。

**缓解**：
- 解析器从第一行代码就写成容错的：未知字段忽略、缺字段降级、解析失败跳过单行并 warn，绝不中断 pipeline
- `raw` 列保留原始 JSON，格式变化后可离线重建索引
- 记录 `source_version`，为版本相关的解析分支留位置
- adapter 层做契约测试，锁定样本文件回归

这是本项目**最大的长期维护成本**，必须正视。

### R2 — 目录名 slug 有损 【中】

`~/.claude/projects/<cwd-slug>` 的 slug 把 `/` 换成 `-`，路径本身含 `-` 时无法反解。

**缓解**：**永远以记录内的 `cwd` 字段为准**，目录名仅用于定位文件，不参与语义。

### R3 — L1 录制体积与隐私 【中】

见 §8 保留策略。

### R4 — PTY 跨平台差异 【中】

Phase 2 起涉及 shell 集成，zsh / bash / fish 三套注入方式各异；Windows 暂不支持（本项目只面向本机 macOS 场景）。

---

## 10. 待定决策

| # | 问题 | 现状 |
|---|---|---|
| **D1** | **技术栈** | 已定：**Node/TypeScript**（daemon + 前端同语言）。SQLite 用 `better-sqlite3`（Node 22 内置的 `node:sqlite` 未编入 FTS5，实测 `CREATE VIRTUAL TABLE … fts5` 直接报错）。前端零框架 + esbuild。 |
| **D2** | **阶段顺序** | 已定：Phase 0 先行，已完成。 |
| **D3** | **其他 agent 覆盖** | 暂只做 Claude Code + Codex。`AgentAdapter` 接口已是插件式，`registry.ts` 里加一行即可扩展。 |
| **D4** | **录像保留默认值** | 暂定 30 天 / 5 GB，待 Phase 2 实际用量数据后调整 |

---

## 11. 实现与本规格的差异

实现过程中发现的规格遗漏，均已按下述方式落地：

| 位置 | 差异 | 原因 |
|---|---|---|
| §5.1 `EventKind` | 新增 `tool_use` | 非 Bash、非文件编辑的工具调用（Read/Grep/WebSearch/update_plan…）既不该混进 `command`，又不该丢弃 |
| §5.1 `NormalizedEvent` | 新增 `patchTarget` | 两家 CLI 都是**先记录调用、后记录结果**。结果行需要回填到既有事件的 `exit_code` / `duration_ms`，而不是新建事件 |
| §5.1 `NormalizedEvent` | 新增 `metaOnly` | `mode` / `ai-title` / `turn_context` 这类行只更新 session 元信息，不该产生时间轴条目 |
| §5.2 `events` | 新增 `text` 列并纳入 FTS | prompt 与 response 正文也需可检索 |
| §5.2 `events` | 新增 `dedupe_key TEXT UNIQUE` | 摄取幂等的实现手段。取值 `<相对 HOME 路径>@<行起始字节偏移>#<行内序号>`——用字节偏移而非行号，续读时无需维护累计行计数 |
| §6 token 语义 | Codex 的 `tokens_in` 入库前减去 `cached_input_tokens` | **Claude 的 `input_tokens` 不含缓存读，Codex 的包含**。不归一则成本看板两家不可比 |
| §6 Codex adapter | 新增文件名 uuid 兜底 + 首行回暖 | Codex 只有首行 `session_meta` 带 session id，断点续读会丢失该状态 |

---

## 12. Phase 3 — 工作流增强（2026-08-16）

Phase 3 的目标是把“看见历史”升级为“基于历史继续工作”。保持本地优先、零侵入和不接管用户既有终端三个约束。

| 能力 | 用户可见行为 | 验收标准 |
|---|---|---|
| 终端协议兼容 | 不把主题的终端能力查询回显到 shell | 浏览器 xterm 的协议回复可被识别/抑制；普通键盘输入仍透传 |
| 可保存布局 | 终端网格可调整列数、排序并随工作区恢复 | 布局与 panes 一起持久化 |
| 事件锚定回放 | 从时间轴事件回放对应 `.cast` | 可从 `cast_offset` 前后开始、暂停、倍速、拖动 |
| 录像导出 | 用户可下载原始 asciicast | 仅可读取 `casts/` 下的安全文件名 |
| 会话调用树 | 详情展示 session 事件与 sidechain 关系 | 可跳转完整时间轴和相关文件 |
| 文件 Git 上下文 | 文件溯源可获取当前仓库 diff | 非 Git/不可读目录优雅降级 |
| 项目健康 | 每项目显示活跃度、失败与 token 风险 | 复用项目/成本聚合，不引入远端服务 |
| 命令收藏 | 收藏、命名和标签历史命令 | 收藏项可在命令面板置顶并在新终端执行 |
| 终端快捷操作 | 卡片提供 cwd、最近命令、录像的快捷入口 | 不影响 PTY 生命周期 |
| Adapter 诊断/SDK | 显示每个 adapter 的探测、目录、解析统计；提供最小 adapter 模板 | 新 adapter 只需实现标准契约并在注册表登记 |

### 12.1 兼容性边界

浏览器终端的设备查询响应需要跨 WebSocket 往返，不能承诺满足要求同步回复的 prompt theme。daemon 必须标识并抑制可安全抑制的颜色/光标查询响应；对需要完整终端协议的程序，保留原生终端作为推荐入口。

### 12.2 数据与安全

收藏的命令沿用入库时的脱敏结果；执行历史命令必须由用户显式选择。录像、diff 与 adapter 诊断接口均遵循既有本地令牌鉴权，且不得允许任意路径读取。

---

## 附录 A — 盘上数据格式核实结果

于 2026-08-16 在本机实测，非推测。

### A.1 Claude Code

- 版本：`2.1.206`
- 路径：`~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`
- 每行一条记录，`type` 取值实测包含：`user` / `assistant` / `system` / `attachment` / `mode` / `permission-mode` / `file-history-snapshot` / `last-prompt` / `ai-title`

顶层字段：

```
attributionSkill, cwd, entrypoint, gitBranch, isSidechain, message,
parentUuid, requestId, sessionId, session_id, timestamp, type,
userType, uuid, version
```

工具调用（`type: assistant`）：

```json
{ "type": "tool_use", "name": "Bash",
  "input": { "command": "ls -la ...", "description": "Check if ... exists" } }
```

实测出现的工具名：`Bash` / `Write` / `Edit` / `WebSearch` / `ToolSearch`。

token 用量（`message.usage`）字段完整到 cache 分级：

```json
{ "input_tokens": 5303, "output_tokens": 340,
  "cache_creation_input_tokens": 5232, "cache_read_input_tokens": 11066,
  "cache_creation": { "ephemeral_1h_input_tokens": 5232,
                      "ephemeral_5m_input_tokens": 0 },
  "service_tier": "standard", "speed": "standard",
  "iterations": [ ... ] }
```

`message.model` 形如 `claude-opus-4-8`。

其他相关路径：`~/.claude/history.jsonl`、`~/.claude/settings.json`、`~/.claude/shell-snapshots/`、`~/.claude/agents/`。

### A.2 Codex

- 版本：`0.38.0`（`codex_cli_rs`）
- 路径：`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`
- 每行 `type` 实测取值：`session_meta`(1) / `response_item`(67) / `event_msg`(40) / `turn_context`(23)

首行 `session_meta`：

```json
{ "timestamp": "...", "type": "session_meta",
  "payload": { "id": "<uuid>", "cwd": "/Users/zhenpeng/git/my-admin",
               "originator": "codex_cli_rs", "cli_version": "0.38.0",
               "instructions": "<AGENTS.md 内容>" } }
```

命令执行（`response_item`）：

```json
{ "type": "response_item",
  "payload": { "type": "function_call", "name": "shell",
               "arguments": "{\"command\":[\"bash\",\"-lc\",\"ls -la\"]}",
               "call_id": "call_gP2Aj..." } }
```

注意 `arguments` 是**字符串化的 JSON**，需二次解析；`command` 是数组形式。

其他相关路径：`~/.codex/history.jsonl`、`~/.codex/config.toml`、`~/.codex/AGENTS.md`。
