import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME } from '../config.js';
import type { AgentAdapter, FileContext, NormalizedEvent } from './types.js';
import { asArray, asNumber, asString, collectText, isRecord, safeJson, toTs, truncate } from './util.js';

/**
 * Claude Code adapter。格式基线见 spec.md 附录 A.1（实测 2.1.206）。
 *
 * 路径：~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
 * slug 有损，项目路径一律取记录内的 cwd 字段（§9-R2）。
 */

const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');

/** 产生文件改动的工具，其 input 里带路径。 */
const EDIT_TOOLS: Record<string, string[]> = {
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

interface ClaudeState {
  lastTs?: number;
}

function state(ctx: FileContext): ClaudeState {
  return ctx.state as ClaudeState;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;

  async detect(): Promise<boolean> {
    return fs.existsSync(PROJECTS_DIR);
  }

  watchRoots(): string[] {
    return [PROJECTS_DIR];
  }

  matches(filePath: string): boolean {
    return filePath.startsWith(PROJECTS_DIR) && filePath.endsWith('.jsonl');
  }

  resumeCommand(externalId: string, cwd: string): string[] {
    return ['claude', '--resume', externalId, '--cwd', cwd];
  }

  parseLine(line: string, ctx: FileContext): NormalizedEvent[] {
    const d = safeJson(line);
    if (!isRecord(d)) return [];

    const sessionRef = asString(d.sessionId) ?? asString(d.session_id);
    if (!sessionRef) return [];

    const st = state(ctx);
    const ts = toTs(d.timestamp) ?? st.lastTs ?? 0;
    if (ts) st.lastTs = ts;

    const version = asString(d.version);
    const base = {
      actor: 'claude' as const,
      sessionRef,
      ts,
      cwd: asString(d.cwd),
      gitBranch: asString(d.gitBranch),
      sourceVersion: version ? `claude-code/${version}` : undefined,
      isSidechain: d.isSidechain === true,
      selfRef: asString(d.uuid),
      parentRef: asString(d.parentUuid),
      raw: d,
    };

    const type = asString(d.type);
    switch (type) {
      case 'assistant':
        return this.parseAssistant(d, base);
      case 'user':
        return this.parseUser(d, base);
      case 'system':
        return this.parseSystem(d, base);
      case 'ai-title': {
        const title = asString(d.aiTitle);
        return [{ ...base, kind: 'notification', metaOnly: true, title }];
      }
      case 'last-prompt': {
        const lastPrompt = asString(d.lastPrompt);
        return [{ ...base, kind: 'notification', metaOnly: true, title: undefined, text: lastPrompt }];
      }
      default:
        // mode / permission-mode / attachment / file-history-snapshot 等：
        // 不产生时间轴事件，但仍用于建立 session 记录。
        return [{ ...base, kind: 'notification', metaOnly: true }];
    }
  }

  private parseAssistant(
    d: Record<string, unknown>,
    base: Omit<NormalizedEvent, 'kind'>,
  ): NormalizedEvent[] {
    const msg = isRecord(d.message) ? d.message : {};
    const out: NormalizedEvent[] = [];

    const usage = isRecord(msg.usage) ? msg.usage : undefined;
    const text = collectText(msg.content);
    const model = asString(msg.model);

    // 每条 assistant 消息产出一条 response，承载 model 与 token 用量（成本看板的数据源）。
    if (usage || text) {
      out.push({
        ...base,
        kind: 'response',
        model,
        text,
        tokensIn: asNumber(usage?.input_tokens),
        tokensOut: asNumber(usage?.output_tokens),
        tokensCacheRead: asNumber(usage?.cache_read_input_tokens),
        tokensCacheWrite: asNumber(usage?.cache_creation_input_tokens),
      });
    }

    for (const block of asArray(msg.content)) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const name = asString(block.name) ?? 'unknown';
      const input = isRecord(block.input) ? block.input : {};
      const toolUseId = asString(block.id);

      if (name === 'Bash') {
        out.push({
          ...base,
          kind: 'command',
          toolName: name,
          command: truncate(asString(input.command)),
          text: asString(input.description),
          selfRef: toolUseId ?? base.selfRef,
        });
        continue;
      }

      const pathKeys = EDIT_TOOLS[name];
      if (pathKeys) {
        const filePath = pathKeys.map((k) => asString(input[k])).find(Boolean);
        out.push({
          ...base,
          kind: 'file_edit',
          toolName: name,
          filePath,
          selfRef: toolUseId ?? base.selfRef,
        });
        continue;
      }

      out.push({
        ...base,
        kind: 'tool_use',
        toolName: name,
        text: truncate(summarizeToolInput(input), 500),
        filePath: asString(input.file_path) ?? asString(input.path),
        selfRef: toolUseId ?? base.selfRef,
      });
    }

    return out;
  }

  private parseUser(
    d: Record<string, unknown>,
    base: Omit<NormalizedEvent, 'kind'>,
  ): NormalizedEvent[] {
    const msg = isRecord(d.message) ? d.message : {};
    const content = msg.content;

    // tool_result：回填对应 tool_use 的执行结果，而非新事件。
    const results: NormalizedEvent[] = [];
    for (const block of asArray(content)) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const target = asString(block.tool_use_id);
      if (!target) continue;
      results.push({
        ...base,
        kind: 'command',
        patchTarget: target,
        exitCode: block.is_error === true ? 1 : 0,
      });
    }
    if (results.length) return results;

    const text = collectText(content);
    if (!text) return [{ ...base, kind: 'notification', metaOnly: true }];
    return [{ ...base, kind: 'prompt', text }];
  }

  private parseSystem(
    d: Record<string, unknown>,
    base: Omit<NormalizedEvent, 'kind'>,
  ): NormalizedEvent[] {
    const subtype = asString(d.subtype);
    // turn_duration 只是统计信息，不进时间轴。
    if (subtype === 'turn_duration') {
      return [{ ...base, kind: 'notification', metaOnly: true }];
    }
    const text = asString(d.content) ?? collectText((d.message as Record<string, unknown>)?.content);
    if (!text) return [{ ...base, kind: 'notification', metaOnly: true }];
    return [{ ...base, kind: 'notification', text: truncate(text, 1000), toolName: subtype }];
  }
}

/** 把非 Bash 工具的入参压成一行可读摘要，供全文检索。 */
function summarizeToolInput(input: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') {
      parts.push(`${k}=${v.length > 120 ? `${v.slice(0, 120)}…` : v}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    }
    if (parts.length >= 4) break;
  }
  return parts.length ? parts.join(' ') : undefined;
}
