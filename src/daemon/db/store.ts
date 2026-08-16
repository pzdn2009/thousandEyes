import type { DB } from './index.js';
import type { NormalizedEvent } from '../adapters/types.js';

/**
 * 写入层。摄取必须幂等：dedupe_key 为 `<file>@<行起始字节偏移>#<行内序号>`。
 * 用字节偏移而非行号，是因为增量续读时不需要维护累计行计数；
 * 对 append-only 的 JSONL 这是确定性的。文件轮转时由 pipeline 先清理再重读。
 */

export interface SessionUpsert {
  actor: string;
  externalId: string;
  kind: 'terminal' | 'agent';
  projectPath: string;
  gitBranch?: string;
  startedAt: number;
  endedAt?: number;
  sourceVersion?: string;
  title?: string;
  parentSessionId?: string;
}

export function sessionId(actor: string, externalId: string): string {
  return `${actor}:${externalId}`;
}

export function upsertSession(db: DB, s: SessionUpsert): string {
  const id = sessionId(s.actor, s.externalId);
  db.prepare(
    `INSERT INTO sessions (id, kind, actor, external_id, project_path, git_branch,
                           started_at, ended_at, source_version, title, parent_session_id)
     VALUES (@id, @kind, @actor, @externalId, @projectPath, @gitBranch,
             @startedAt, @endedAt, @sourceVersion, @title, @parentSessionId)
     ON CONFLICT(id) DO UPDATE SET
       project_path   = COALESCE(NULLIF(excluded.project_path, ''), sessions.project_path),
       git_branch     = COALESCE(excluded.git_branch, sessions.git_branch),
       started_at     = MIN(sessions.started_at, excluded.started_at),
       ended_at       = MAX(COALESCE(sessions.ended_at, 0), COALESCE(excluded.ended_at, 0)),
       source_version = COALESCE(excluded.source_version, sessions.source_version),
       title          = COALESCE(excluded.title, sessions.title)`,
  ).run({
    id,
    kind: s.kind,
    actor: s.actor,
    externalId: s.externalId,
    projectPath: s.projectPath,
    gitBranch: s.gitBranch ?? null,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    sourceVersion: s.sourceVersion ?? null,
    title: s.title ?? null,
    parentSessionId: s.parentSessionId ?? null,
  });
  return id;
}

export interface EventRow extends NormalizedEvent {
  dedupeKey: string;
}

export function makeInsertEvent(db: DB) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO events (
       session_id, ts, actor, kind, cwd, command, tool_name, exit_code, duration_ms,
       file_path, text, model, tokens_in, tokens_out, tokens_cr, tokens_cw,
       is_sidechain, external_uuid, parent_uuid, cast_ref, cast_offset, dedupe_key, raw
     ) VALUES (
       @sessionId, @ts, @actor, @kind, @cwd, @command, @toolName, @exitCode, @durationMs,
       @filePath, @text, @model, @tokensIn, @tokensOut, @tokensCr, @tokensCw,
       @isSidechain, @externalUuid, @parentUuid, @castRef, @castOffset, @dedupeKey, @raw
     )`,
  );
  return (e: EventRow) =>
    stmt.run({
      sessionId: sessionId(e.actor, e.sessionRef),
      ts: e.ts,
      actor: e.actor,
      kind: e.kind,
      cwd: e.cwd ?? null,
      command: e.command ?? null,
      toolName: e.toolName ?? null,
      exitCode: e.exitCode ?? null,
      durationMs: e.durationMs ?? null,
      filePath: e.filePath ?? null,
      text: e.text ?? null,
      model: e.model ?? null,
      tokensIn: e.tokensIn ?? null,
      tokensOut: e.tokensOut ?? null,
      tokensCr: e.tokensCacheRead ?? null,
      tokensCw: e.tokensCacheWrite ?? null,
      isSidechain: e.isSidechain ? 1 : 0,
      externalUuid: e.selfRef ?? null,
      parentUuid: e.parentRef ?? null,
      castRef: e.castRef ?? null,
      castOffset: e.castOffsetMs ?? null,
      dedupeKey: e.dedupeKey,
      raw: e.raw === undefined ? null : JSON.stringify(e.raw),
    });
}

/** 文件轮转/截断后，清掉该文件此前产生的全部事件，避免 dedupe_key 冲突吃掉新数据。 */
export function purgeFileEvents(db: DB, fileKey: string): number {
  const info = db.prepare(`DELETE FROM events WHERE dedupe_key LIKE ? || '@%'`).run(fileKey);
  return info.changes;
}

/** 回填命令执行结果（exit code / 耗时）。两家 CLI 都是先记调用、后记结果。 */
export function makePatchEvent(db: DB) {
  const stmt = db.prepare(
    `UPDATE events
        SET exit_code   = COALESCE(@exitCode, exit_code),
            duration_ms = COALESCE(@durationMs, duration_ms)
      WHERE external_uuid = @target AND session_id = @sessionId`,
  );
  return (sid: string, target: string, exitCode?: number, durationMs?: number) =>
    stmt.run({
      sessionId: sid,
      target,
      exitCode: exitCode ?? null,
      durationMs: durationMs ?? null,
    });
}

export function getIngestState(
  db: DB,
  filePath: string,
): { inode: number; size: number; byte_offset: number } | undefined {
  return db
    .prepare(`SELECT inode, size, byte_offset FROM ingest_state WHERE file_path = ?`)
    .get(filePath) as { inode: number; size: number; byte_offset: number } | undefined;
}

export function setIngestState(
  db: DB,
  filePath: string,
  inode: number,
  size: number,
  byteOffset: number,
): void {
  db.prepare(
    `INSERT INTO ingest_state (file_path, inode, size, byte_offset, last_ingested_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       inode = excluded.inode, size = excluded.size,
       byte_offset = excluded.byte_offset, last_ingested_at = excluded.last_ingested_at`,
  ).run(filePath, inode, size, byteOffset, Date.now());
}
