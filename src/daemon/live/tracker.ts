import { EventEmitter } from 'node:events';

/**
 * 实时状态跟踪。spec.md §7 Phase 1。
 *
 * 状态来源有二，可靠性不同：
 *  - hook（Claude Code）：毫秒级，状态迁移明确，尤其 Notification 精确对应「agent 在等你」
 *  - watch（Codex 等无 hook 的 CLI）：只能从「transcript 文件刚被写过」倒推正在运行，秒级且粗糙
 *
 * 所以 source 字段要暴露给 UI——watch 推断出的状态不该和 hook 上报的状态被同等看待。
 */

export type AgentState = 'running' | 'waiting' | 'idle' | 'error';

export interface AgentStatus {
  key: string;
  actor: string;
  sessionId: string;
  project: string;
  cwd?: string;
  gitBranch?: string;
  title?: string;
  state: AgentState;
  /** 当前在做什么：工具名、通知内容、错误信息 */
  detail?: string;
  /** 进入当前状态的时间 */
  since: number;
  lastEventAt: number;
  source: 'hook' | 'watch';
  /** 本次会话累计的工具调用次数 */
  toolCalls: number;
}

/** watch 推断：文件停止写入这么久就认为不在跑了。 */
const WATCH_IDLE_MS = 45_000;
/** hook 上报的 running 状态超过这个时长没有后续，视为失联转 idle。 */
const HOOK_STALE_MS = 15 * 60_000;
/** 完全没有活动这么久就从状态墙移除。 */
const EVICT_MS = 12 * 60 * 60_000;

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  message?: string;
  [k: string]: unknown;
}

export class LiveTracker extends EventEmitter {
  private agents = new Map<string, AgentStatus>();
  private timer?: NodeJS.Timeout;

  start(): void {
    this.timer = setInterval(() => this.sweep(), 5000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): AgentStatus[] {
    return [...this.agents.values()].sort((a, b) => {
      // 等待中的排最前——这是状态墙存在的理由
      const rank = (s: AgentState) => (s === 'waiting' ? 0 : s === 'error' ? 1 : s === 'running' ? 2 : 3);
      const d = rank(a.state) - rank(b.state);
      return d !== 0 ? d : b.lastEventAt - a.lastEventAt;
    });
  }

  private upsert(key: string, patch: Partial<AgentStatus> & Pick<AgentStatus, 'actor' | 'sessionId'>): void {
    const now = Date.now();
    const prev = this.agents.get(key);
    const nextState = patch.state ?? prev?.state ?? 'idle';
    const status: AgentStatus = {
      key,
      actor: patch.actor,
      sessionId: patch.sessionId,
      project: patch.project ?? prev?.project ?? '',
      cwd: patch.cwd ?? prev?.cwd,
      gitBranch: patch.gitBranch ?? prev?.gitBranch,
      title: patch.title ?? prev?.title,
      state: nextState,
      detail: patch.detail !== undefined ? patch.detail : prev?.detail,
      since: prev && prev.state === nextState ? prev.since : now,
      lastEventAt: now,
      source: patch.source ?? prev?.source ?? 'watch',
      toolCalls: patch.toolCalls ?? prev?.toolCalls ?? 0,
    };
    this.agents.set(key, status);

    const changed = !prev || prev.state !== status.state || prev.detail !== status.detail;
    if (changed) this.emit('change', status, prev?.state);
    this.emit('tick', status);
  }

  /** Claude Code hook 上报。 */
  onHook(p: HookPayload): AgentStatus | undefined {
    const sessionId = p.session_id;
    if (!sessionId) return undefined;
    const key = `claude:${sessionId}`;
    const event = p.hook_event_name ?? '';
    const prev = this.agents.get(key);

    let state: AgentState | undefined;
    let detail: string | undefined;

    switch (event) {
      case 'SessionStart':
        state = 'idle';
        detail = '会话已启动';
        break;
      case 'UserPromptSubmit':
        state = 'running';
        detail = '思考中';
        break;
      case 'PreToolUse':
        state = 'running';
        detail = p.tool_name ? `执行 ${p.tool_name}` : '执行工具';
        break;
      case 'PostToolUse':
        state = 'running';
        detail = p.tool_name ? `${p.tool_name} 完成` : undefined;
        break;
      case 'Notification':
        // 这一个 hook 撑起整面状态墙：它触发的时机就是 agent 在等人
        state = 'waiting';
        detail = typeof p.message === 'string' ? p.message : '等待你的输入';
        break;
      case 'Stop':
        state = 'idle';
        detail = '本轮结束';
        break;
      case 'SubagentStop':
        state = 'running';
        detail = 'subagent 结束';
        break;
      case 'SessionEnd':
        this.agents.delete(key);
        this.emit('remove', key);
        return undefined;
      default:
        state = prev?.state ?? 'idle';
    }

    this.upsert(key, {
      actor: 'claude',
      sessionId,
      cwd: p.cwd,
      project: p.cwd ?? prev?.project ?? '',
      state,
      detail,
      source: 'hook',
      toolCalls: (prev?.toolCalls ?? 0) + (event === 'PreToolUse' ? 1 : 0),
    });
    return this.agents.get(key);
  }

  /**
   * 来自 file watch 的活动信号。
   *
   * 只能推断「刚写过 → 大概在跑」。若该 session 已有 hook 来源的状态，
   * 不要用 watch 覆盖——hook 更准，尤其不能把 waiting 误判回 running。
   */
  onWatchActivity(info: {
    actor: string;
    sessionId: string;
    project?: string;
    title?: string;
    detail?: string;
  }): void {
    const key = `${info.actor}:${info.sessionId}`;
    const prev = this.agents.get(key);
    if (prev?.source === 'hook') {
      // 仅刷新活跃时间，不改状态
      prev.lastEventAt = Date.now();
      this.emit('tick', prev);
      return;
    }
    this.upsert(key, {
      actor: info.actor,
      sessionId: info.sessionId,
      project: info.project ?? prev?.project ?? '',
      title: info.title ?? prev?.title,
      state: 'running',
      detail: info.detail ?? '有新的写入',
      source: 'watch',
    });
  }

  /** 定期把长时间没有信号的会话降级或移除。 */
  private sweep(): void {
    const now = Date.now();
    for (const [key, a] of this.agents) {
      if (now - a.lastEventAt > EVICT_MS) {
        this.agents.delete(key);
        this.emit('remove', key);
        continue;
      }
      const staleAfter = a.source === 'watch' ? WATCH_IDLE_MS : HOOK_STALE_MS;
      // waiting 不做超时降级：agent 可以合理地等你很久
      if (a.state === 'running' && now - a.lastEventAt > staleAfter) {
        const prevState = a.state;
        a.state = 'idle';
        a.detail = a.source === 'watch' ? '无写入活动' : '长时间无 hook 上报';
        a.since = now;
        this.emit('change', a, prevState);
      }
    }
  }
}
