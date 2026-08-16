import fs from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';
import type { DB } from '../db/index.js';
import {
  getIngestState,
  makeInsertEvent,
  makePatchEvent,
  purgeFileEvents,
  sessionId,
  setIngestState,
  upsertSession,
} from '../db/store.js';
import type { AgentAdapter, FileContext, NormalizedEvent } from '../adapters/types.js';
import { adapterFor } from '../adapters/registry.js';
import { isProjectDenied, redactEvent } from '../redact.js';

/** 单次读取上限，避免首次全量扫描时把整个大文件读进内存。 */
const CHUNK = 4 * 1024 * 1024;
const NL = 0x0a;

/** 本次摄取碰到的会话，供实时状态墙从 file watch 侧推断活跃度。 */
export interface TouchedSession {
  actor: string;
  sessionRef: string;
  project?: string;
  detail?: string;
}

export interface IngestResult {
  file: string;
  linesRead: number;
  eventsInserted: number;
  patched: number;
  rotated: boolean;
  touched: Map<string, TouchedSession>;
  error?: string;
}

export class Ingestor {
  private contexts = new Map<string, FileContext>();
  private insert: ReturnType<typeof makeInsertEvent>;
  private patch: ReturnType<typeof makePatchEvent>;

  constructor(
    private db: DB,
    private adapters: AgentAdapter[],
  ) {
    this.insert = makeInsertEvent(db);
    this.patch = makePatchEvent(db);
  }

  /** dedupe_key 与 ingest_state 的稳定前缀：相对 HOME 的路径。 */
  private fileKey(filePath: string): string {
    const rel = path.relative(HOME, filePath);
    return rel.startsWith('..') ? filePath : rel;
  }

  ingestFile(filePath: string): IngestResult {
    const result: IngestResult = {
      file: filePath,
      linesRead: 0,
      eventsInserted: 0,
      patched: 0,
      rotated: false,
      touched: new Map(),
    };

    const adapter = adapterFor(this.adapters, filePath);
    if (!adapter) return result;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return result;
    }
    if (!stat.isFile()) return result;

    const key = this.fileKey(filePath);
    const prev = getIngestState(this.db, filePath);

    // 轮转/截断检测：inode 变化或体积缩小 → 此前索引的内容已不可信，清掉重来（§5.2）。
    let offset = prev?.byte_offset ?? 0;
    if (prev && (prev.inode !== stat.ino || stat.size < prev.size)) {
      purgeFileEvents(this.db, key);
      this.contexts.delete(filePath);
      offset = 0;
      result.rotated = true;
    }

    if (stat.size <= offset) {
      setIngestState(this.db, filePath, stat.ino, stat.size, offset);
      return result;
    }

    const ctx = this.contextFor(filePath, adapter, offset);
    const fallbackTs = stat.mtimeMs;

    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (e) {
      result.error = String(e);
      return result;
    }

    try {
      const apply = this.db.transaction((batch: { ev: NormalizedEvent; dk: string }[]) => {
        for (const { ev, dk } of batch) {
          this.applyEvent(ev, dk, fallbackTs, result);
        }
      });

      while (offset < stat.size) {
        const want = Math.min(CHUNK, stat.size - offset);
        const buf = Buffer.allocUnsafe(want);
        const read = fs.readSync(fd, buf, 0, want, offset);
        if (read <= 0) break;

        const slice = buf.subarray(0, read);
        const lastNl = slice.lastIndexOf(NL);
        if (lastNl < 0) {
          // 整块没有换行：要么是超长单行，要么是尚未写完的尾部。
          if (read < CHUNK) break; // 半行，等下次
          offset += read; // 超长行，跳过以免卡死
          continue;
        }

        const batch: { ev: NormalizedEvent; dk: string }[] = [];
        let lineStart = 0;
        while (lineStart <= lastNl) {
          const nl = slice.indexOf(NL, lineStart);
          if (nl < 0) break;
          const lineBuf = slice.subarray(lineStart, nl);
          const absStart = offset + lineStart;
          if (lineBuf.length > 0) {
            result.linesRead++;
            const events = this.parseSafely(adapter, lineBuf.toString('utf8'), ctx);
            events.forEach((ev, idx) => batch.push({ ev, dk: `${key}@${absStart}#${idx}` }));
          }
          lineStart = nl + 1;
        }

        apply(batch);
        offset += lastNl + 1;
      }
    } finally {
      fs.closeSync(fd);
    }

    setIngestState(this.db, filePath, stat.ino, stat.size, offset);
    return result;
  }

  /**
   * 取得（或建立）文件上下文。
   *
   * Codex 只有首行 session_meta 带 session id 与 cwd，daemon 重启后从断点续读会丢失这些状态，
   * 所以断点非零且上下文是新的时候，先用首行把状态回暖（产出的事件丢弃）。
   */
  private contextFor(filePath: string, adapter: AgentAdapter, offset: number): FileContext {
    const existing = this.contexts.get(filePath);
    if (existing) return existing;

    const ctx: FileContext = { filePath, state: {} };
    if (offset > 0) {
      try {
        const fd = fs.openSync(filePath, 'r');
        try {
          const head = Buffer.allocUnsafe(Math.min(256 * 1024, offset));
          const read = fs.readSync(fd, head, 0, head.length, 0);
          const nl = head.subarray(0, read).indexOf(NL);
          if (nl > 0) this.parseSafely(adapter, head.subarray(0, nl).toString('utf8'), ctx);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // 回暖失败不影响后续解析，adapter 有文件名兜底。
      }
    }
    this.contexts.set(filePath, ctx);
    return ctx;
  }

  private parseSafely(adapter: AgentAdapter, line: string, ctx: FileContext): NormalizedEvent[] {
    try {
      return adapter.parseLine(line, ctx) ?? [];
    } catch {
      // §9-R1：单行解析失败不得中断 pipeline。
      return [];
    }
  }

  private applyEvent(raw: NormalizedEvent, dedupeKey: string, fallbackTs: number, result: IngestResult): void {
    if (isProjectDenied(raw.cwd)) return;
    const e = redactEvent(raw);
    const ts = e.ts && e.ts > 0 ? e.ts : fallbackTs;
    const sid = sessionId(e.actor, e.sessionRef);

    if (e.patchTarget) {
      const info = this.patch(sid, e.patchTarget, e.exitCode, e.durationMs);
      result.patched += info.changes;
      return;
    }

    upsertSession(this.db, {
      actor: e.actor,
      externalId: e.sessionRef,
      kind: 'agent',
      projectPath: e.cwd ?? '',
      gitBranch: e.gitBranch,
      startedAt: ts,
      sourceVersion: e.sourceVersion,
      title: e.title,
    });

    if (e.metaOnly) return;

    const info = this.insert({ ...e, ts, dedupeKey });
    result.eventsInserted += info.changes;

    if (info.changes) {
      result.touched.set(sid, {
        actor: e.actor,
        sessionRef: e.sessionRef,
        project: e.cwd,
        detail: describe(e),
      });
    }
  }
}

/** 给状态墙用的一句话描述：最近这条事件在做什么。 */
function describe(e: NormalizedEvent): string {
  switch (e.kind) {
    case 'command': {
      const first = (e.command ?? '').split('\n')[0] ?? '';
      return first.length > 60 ? `${first.slice(0, 60)}…` : first || '执行命令';
    }
    case 'file_edit':
      return `编辑 ${(e.filePath ?? '').split('/').pop() ?? '文件'}`;
    case 'tool_use':
      return `调用 ${e.toolName ?? '工具'}`;
    case 'prompt':
      return '收到新指令';
    case 'response':
      return '生成回复';
    default:
      return e.toolName ?? e.kind;
  }
}
