# thousandEyes

终端与 AI Agent 会话的控制塔。本地常驻 daemon + Web UI。

它把三处互不相通的执行历史归到一条时间轴上：你亲手敲的命令、Claude Code 跑的命令、Codex 跑的命令。

完整设计见 [spec.md](./spec.md)。

## 现在能做什么（Phase 0 + Phase 1 + Phase 2 基础版）

零侵入的只读观察者——**不改你的 shell，不接管你的终端**，只读 agent CLI 落在盘上的 transcript。

- **统一时间轴**：命令 / 文件改动 / 提问 / 回复，按 agent、事件类型、项目、时间范围筛选，FTS5 全文检索
- **项目视图**：每个仓库有多少会话、跑了多少命令、失败几条、改了多少文件、烧了多少 token
- **成本看板**：按天 / 按项目 / 按模型聚合 token 用量（两家 CLI 的口径已归一）
- **会话视图**：所有历史会话，点进去看它到底做了什么
- **实时状态墙**：Claude hook 毫秒级上报 running / waiting / idle；Codex 保持 file-watch 推断并明确标注来源
- **托管终端**：浏览器内 xterm 终端、克隆、实时 PTY 流，以及由 shell OSC 133 标记采集的人类命令
- **录像**：每个托管终端写为 asciicast v2；默认 30 天 / 5 GB 保留，超限按最旧录像淘汰

能回答的问题：*这个文件是谁改的，我还是某个 agent？* *上周那条 docker 命令是什么？* *哪个项目最烧 token？* *昨天 Claude 跑的 47 条命令里哪几条失败了？*

## 快速开始

```bash
npm install
npm run build
npm start          # 索引 + 监听 + 起 Web UI
```

启动后终端会打印一个带令牌的地址，形如 `http://127.0.0.1:7317/?token=…`，浏览器打开即可。
令牌存在 `~/.thousandEyes/token`（权限 0600），首次访问后写入 cookie，之后直接开 `http://127.0.0.1:7317` 就行。

其它命令：

```bash
npm run scan       # 只全量扫描一次，不起服务
npm run stats      # 打印索引概况
npm run dev        # 构建 + 用 tsx 直跑源码
npm run typecheck
```

## 数据都放在哪

| 路径 | 内容 |
|---|---|
| `~/.thousandEyes/index.db` | SQLite 索引（events / sessions / FTS5） |
| `~/.thousandEyes/token` | 本地访问令牌，0600 |
| `~/.thousandEyes/redact.json` | 脱敏与项目黑名单配置（可选） |

transcript 采集保持**只读**：daemon 从不写入 `~/.claude` 或 `~/.codex`。托管终端的 shell 集成通过启动时 `ZDOTDIR` / `--init-file` 注入，不改用户 rc 文件。

## 隐私

- 只监听 `127.0.0.1`，校验 Host 防 DNS rebinding，全部请求需要本地令牌
- 命令与文本写库前过一遍脱敏规则（私钥块、`Authorization:`、`sk-*` / `ghp_*` / `AKIA*` / JWT 等）
- 想完全排除某些项目，在 `~/.thousandEyes/redact.json` 里配 `projectDenyList`：

```json
{
  "enabled": true,
  "projectDenyList": ["/Users/you/work/secret-repo"],
  "extra": [{ "name": "internal-id", "pattern": "EMP-\\d{6}" }]
}
```

## 支持的 agent

| | 数据来源 | 实时性 |
|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` | file watch（Phase 1 接 hook 后为毫秒级） |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | file watch，秒级 |

新增一家 CLI：实现 `AgentAdapter`（`src/daemon/adapters/types.ts`），在 `registry.ts` 注册。

> transcript 格式是各家 CLI 的内部实现，无稳定性承诺。解析器按容错设计：未知字段忽略、缺字段降级、单行解析失败跳过且不中断摄取，原始 JSON 存在 `events.raw` 里以便格式变化后重建索引。

## 结构

```
src/daemon/
  adapters/   AgentAdapter 契约与 claude / codex 实现
  db/         schema、写入层、查询层
  ingest/     全量扫描、增量监听、摄取管线
  server/     HTTP API 与本地令牌鉴权
  redact.ts   脱敏
src/web/      前端（无框架，esbuild 打包）
```
