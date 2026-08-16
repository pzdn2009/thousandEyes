import fs from 'node:fs';
import path from 'node:path';
import { CODEX_HOME } from '../config.js';
import type { AgentAdapter, FileContext, NormalizedEvent } from './types.js';
import { asArray, asNumber, asString, collectText, isRecord, safeJson, toTs, truncate } from './util.js';

/**
 * Codex adapter。格式基线见 spec.md 附录 A.2（实测 codex_cli_rs 0.38.0）。
 *
 * 路径：~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl
 *
 * 与 Claude 的关键差异：只有首行 session_meta 带 session id，
 * 后续行全部不带——必须靠 ctx.state 缓存，并以文件名 uuid 兜底。
 */

const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const ROLLOUT_UUID = /rollout-[\dT:-]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface CodexState {
  sessionRef?: string;
  cwd?: string;
  version?: string;
  model?: string;
  lastTs?: number;
}

function state(ctx: FileContext): CodexState {
  return ctx.state as CodexState;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;

  async detect(): Promise<boolean> {
    return fs.existsSync(SESSIONS_DIR);
  }

  watchRoots(): string[] {
    return [SESSIONS_DIR];
  }

  matches(filePath: string): boolean {
    return filePath.startsWith(SESSIONS_DIR) && filePath.endsWith('.jsonl');
  }

  resumeCommand(externalId: string, _cwd: string): string[] {
    return ['codex', 'resume', externalId];
  }

  parseLine(line: string, ctx: FileContext): NormalizedEvent[] {
    const d = safeJson(line);
    if (!isRecord(d)) return [];

    const st = state(ctx);
    const payload = isRecord(d.payload) ? d.payload : {};
    const type = asString(d.type);

    if (type === 'session_meta') {
      st.sessionRef = asString(payload.id) ?? st.sessionRef;
      st.cwd = asString(payload.cwd) ?? st.cwd;
      const cli = asString(payload.cli_version);
      if (cli) st.version = `codex/${cli}`;
    }

    if (!st.sessionRef) {
      st.sessionRef = ROLLOUT_UUID.exec(ctx.filePath)?.[1];
    }
    if (!st.sessionRef) return [];

    const ts = toTs(d.timestamp) ?? st.lastTs ?? 0;
    if (ts) st.lastTs = ts;

    if (type === 'turn_context') {
      st.cwd = asString(payload.cwd) ?? st.cwd;
      st.model = asString(payload.model) ?? st.model;
    }

    const base = {
      actor: 'codex' as const,
      sessionRef: st.sessionRef,
      ts,
      cwd: st.cwd,
      sourceVersion: st.version,
      raw: d,
    };

    switch (type) {
      case 'session_meta':
        return [{ ...base, kind: 'session_start', metaOnly: true }];
      case 'turn_context':
        return [{ ...base, kind: 'notification', metaOnly: true }];
      case 'response_item':
        return this.parseResponseItem(payload, base, st);
      case 'event_msg':
        return this.parseEventMsg(payload, base, st);
      default:
        return [{ ...base, kind: 'notification', metaOnly: true }];
    }
  }

  private parseResponseItem(
    p: Record<string, unknown>,
    base: Omit<NormalizedEvent, 'kind'>,
    st: CodexState,
  ): NormalizedEvent[] {
    const ptype = asString(p.type);

    if (ptype === 'function_call') {
      const name = asString(p.name) ?? 'unknown';
      const callId = asString(p.call_id);
      const args = parseArgs(p.arguments);

      if (name === 'shell') {
        return [
          {
            ...base,
            kind: 'command',
            toolName: name,
            command: truncate(flattenShellCommand(args?.command)),
            selfRef: callId,
          },
        ];
      }
      if (name === 'exec_command') {
        return [
          {
            ...base,
            kind: 'command',
            toolName: name,
            command: truncate(asString(args?.cmd)),
            selfRef: callId,
          },
        ];
      }
      return [
        {
          ...base,
          kind: 'tool_use',
          toolName: name,
          text: truncate(summarizeArgs(args), 500),
          selfRef: callId,
        },
      ];
    }

    if (ptype === 'function_call_output') {
      const callId = asString(p.call_id);
      if (!callId) return [];
      const out = parseArgs(p.output);
      const meta = isRecord(out?.metadata) ? out.metadata : undefined;
      const exitCode = asNumber(meta?.exit_code);
      const secs = asNumber(meta?.duration_seconds);
      if (exitCode === undefined && secs === undefined) return [];
      return [
        {
          ...base,
          kind: 'command',
          patchTarget: callId,
          exitCode,
          durationMs: secs === undefined ? undefined : Math.round(secs * 1000),
        },
      ];
    }

    if (ptype === 'message') {
      const role = asString(p.role);
      const text = collectText(p.content);
      if (!text) return [];
      // response_item.message 与 event_msg 的 user_message/agent_message 内容重复，
      // 只保留 event_msg 一侧，这里仅用于补 session 元信息。
      return [{ ...base, kind: role === 'user' ? 'prompt' : 'response', metaOnly: true, text }];
    }

    // reasoning 等：与 event_msg.agent_reasoning 重复，跳过。
    return [];
  }

  private parseEventMsg(
    p: Record<string, unknown>,
    base: Omit<NormalizedEvent, 'kind'>,
    st: CodexState,
  ): NormalizedEvent[] {
    const ptype = asString(p.type);

    switch (ptype) {
      case 'user_message': {
        const text = asString(p.message);
        return text ? [{ ...base, kind: 'prompt', text: truncate(text) }] : [];
      }
      case 'agent_message': {
        const text = asString(p.message);
        return text ? [{ ...base, kind: 'response', model: st.model, text: truncate(text) }] : [];
      }
      case 'token_count': {
        const info = isRecord(p.info) ? p.info : undefined;
        const last = isRecord(info?.last_token_usage) ? info.last_token_usage : undefined;
        if (!last) return [];
        // 归一化：Codex 的 input_tokens 含 cached_input_tokens，Claude 的不含。
        // 统一按「非缓存输入」入库，两家的成本看板才可比（附录 A）。
        const rawIn = asNumber(last.input_tokens);
        const cached = asNumber(last.cached_input_tokens);
        const freshIn =
          rawIn === undefined ? undefined : cached === undefined ? rawIn : Math.max(0, rawIn - cached);
        return [
          {
            ...base,
            kind: 'response',
            model: st.model,
            tokensIn: freshIn,
            tokensOut: asNumber(last.output_tokens),
            tokensCacheRead: cached,
          },
        ];
      }
      case 'patch_apply_end': {
        const changes = isRecord(p.changes) ? p.changes : {};
        const success = p.success !== false;
        const events: NormalizedEvent[] = [];
        for (const [filePath, change] of Object.entries(changes)) {
          events.push({
            ...base,
            kind: 'file_edit',
            toolName: 'apply_patch',
            filePath,
            exitCode: success ? 0 : 1,
            text: isRecord(change) ? asString(change.type) : undefined,
            selfRef: asString(p.call_id),
          });
        }
        return events;
      }
      case 'exec_command_end': {
        // 只用于补 cwd，命令本体已由 function_call 记录。
        const cwd = asString(p.cwd);
        if (cwd) st.cwd = cwd;
        return [{ ...base, kind: 'notification', metaOnly: true, cwd: cwd ?? base.cwd }];
      }
      case 'thread_name_updated':
        return [{ ...base, kind: 'notification', metaOnly: true, title: asString(p.name) }];
      case 'error': {
        const text = asString(p.message) ?? asString(p.error);
        return [{ ...base, kind: 'notification', toolName: 'error', text: truncate(text, 1000) }];
      }
      case 'turn_aborted':
        return [{ ...base, kind: 'notification', toolName: 'turn_aborted', text: '任务被中断' }];
      default:
        // agent_reasoning / task_started / task_complete 等：不进时间轴。
        return [];
    }
  }
}

/** Codex 的 arguments 与 output 都是「字符串化的 JSON」，需要二次解析（附录 A.2）。 */
function parseArgs(v: unknown): Record<string, unknown> | undefined {
  if (isRecord(v)) return v;
  if (typeof v !== 'string') return undefined;
  const parsed = safeJson(v);
  return isRecord(parsed) ? parsed : undefined;
}

/**
 * shell 的 command 是数组，形如 ["bash","-lc","ls -la"]。
 * 取 -lc/-c 之后的真实命令，否则整体拼接。
 */
function flattenShellCommand(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const arr = asArray(v).filter((x): x is string => typeof x === 'string');
  if (!arr.length) return undefined;
  const flagIdx = arr.findIndex((x) => x === '-lc' || x === '-c' || x === '-lic');
  if (flagIdx >= 0 && arr[flagIdx + 1]) return arr[flagIdx + 1];
  return arr.join(' ');
}

function summarizeArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') parts.push(`${k}=${v.length > 120 ? `${v.slice(0, 120)}…` : v}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
    if (parts.length >= 4) break;
  }
  return parts.length ? parts.join(' ') : undefined;
}
