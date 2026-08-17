import type { DB } from './index.js';

/**
 * 读取层。所有 UI 视图的数据源。
 *
 * 时间轴用 (ts, id) 游标翻页，不用 OFFSET——事件表会持续增长，OFFSET 会越翻越慢。
 */

export interface TimelineFilter {
  actors?: string[];
  kinds?: string[];
  project?: string;
  sessionId?: string;
  /** 精确文件路径筛选（文件溯源用）。 */
  filePath?: string;
  /** 全文检索词 */
  q?: string;
  since?: number;
  until?: number;
  /** 只看失败的命令 */
  failedOnly?: boolean;
  /** 是否包含 subagent 产生的事件 */
  includeSidechain?: boolean;
  limit?: number;
  /** 游标：上一页最后一条的 `${ts}:${id}` */
  cursor?: string;
}

export interface TimelineRow {
  id: number;
  session_id: string;
  ts: number;
  actor: string;
  kind: string;
  cwd: string | null;
  command: string | null;
  tool_name: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  file_path: string | null;
  text: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cr: number | null;
  is_sidechain: number;
  project_path: string;
  git_branch: string | null;
  session_title: string | null;
  cast_ref: string | null;
  cast_offset: number | null;
  external_uuid: string | null;
  parent_uuid: string | null;
}

/**
 * FTS5 的 MATCH 语法对用户输入敏感（`-` `"` `*` 等都是操作符）。
 * 这里把输入拆成词、去掉语法字符、各自加引号后用 AND 连接，
 * 保证任何输入都不会让查询报错。
 */
export function toFtsQuery(input: string): string | undefined {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.replace(/["'()^*:-]/g, ' ').trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return tokens.length ? tokens.join(' AND ') : undefined;
}

function decodeCursor(cursor?: string): { ts: number; id: number } | undefined {
  if (!cursor) return undefined;
  const [ts, id] = cursor.split(':');
  const n = Number(ts);
  const i = Number(id);
  if (!Number.isFinite(n) || !Number.isFinite(i)) return undefined;
  return { ts: n, id: i };
}

export function timeline(db: DB, f: TimelineFilter): { rows: TimelineRow[]; nextCursor?: string } {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (f.actors?.length) {
    where.push(`e.actor IN (${f.actors.map((_, i) => `@actor${i}`).join(',')})`);
    f.actors.forEach((a, i) => (params[`actor${i}`] = a));
  }
  if (f.kinds?.length) {
    where.push(`e.kind IN (${f.kinds.map((_, i) => `@kind${i}`).join(',')})`);
    f.kinds.forEach((k, i) => (params[`kind${i}`] = k));
  }
  if (f.project) {
    where.push(`s.project_path = @project`);
    params.project = f.project;
  }
  if (f.sessionId) {
    where.push(`e.session_id = @sessionId`);
    params.sessionId = f.sessionId;
  }
  if (f.filePath) {
    where.push(`e.file_path = @filePath`);
    params.filePath = f.filePath;
  }
  if (f.since !== undefined) {
    where.push(`e.ts >= @since`);
    params.since = f.since;
  }
  if (f.until !== undefined) {
    where.push(`e.ts <= @until`);
    params.until = f.until;
  }
  if (f.failedOnly) {
    where.push(`e.exit_code IS NOT NULL AND e.exit_code != 0`);
  }
  if (!f.includeSidechain) {
    where.push(`e.is_sidechain = 0`);
  }

  let from = `FROM events e JOIN sessions s ON s.id = e.session_id`;
  const fts = f.q ? toFtsQuery(f.q) : undefined;
  if (fts) {
    from += ` JOIN events_fts fts ON fts.rowid = e.id`;
    where.push(`events_fts MATCH @fts`);
    params.fts = fts;
  }

  const cur = decodeCursor(f.cursor);
  if (cur) {
    where.push(`(e.ts < @curTs OR (e.ts = @curTs AND e.id < @curId))`);
    params.curTs = cur.ts;
    params.curId = cur.id;
  }

  const sql = `
    SELECT e.id, e.session_id, e.ts, e.actor, e.kind, e.cwd, e.command, e.tool_name,
           e.exit_code, e.duration_ms, e.file_path, e.text, e.model,
           e.tokens_in, e.tokens_out, e.tokens_cr, e.is_sidechain,
           s.project_path, s.git_branch, s.title AS session_title,
           e.cast_ref, e.cast_offset, e.external_uuid, e.parent_uuid
    ${from}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.ts DESC, e.id DESC
    LIMIT @limit`;
  params.limit = limit + 1;

  const rows = db.prepare(sql).all(params) as TimelineRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? `${last.ts}:${last.id}` : undefined,
  };
}

export interface ProjectRow {
  project_path: string;
  sessions: number;
  events: number;
  commands: number;
  failed: number;
  edits: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cr: number;
  first_ts: number;
  last_ts: number;
  actors: string;
}

export function projects(db: DB, since?: number): ProjectRow[] {
  return db
    .prepare(
      `SELECT s.project_path,
              COUNT(DISTINCT s.id)                                            AS sessions,
              COUNT(e.id)                                                     AS events,
              SUM(CASE WHEN e.kind = 'command' THEN 1 ELSE 0 END)             AS commands,
              SUM(CASE WHEN e.exit_code IS NOT NULL AND e.exit_code != 0 THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN e.kind = 'file_edit' THEN 1 ELSE 0 END)           AS edits,
              COALESCE(SUM(e.tokens_in), 0)                                   AS tokens_in,
              COALESCE(SUM(e.tokens_out), 0)                                  AS tokens_out,
              COALESCE(SUM(e.tokens_cr), 0)                                   AS tokens_cr,
              MIN(e.ts)                                                       AS first_ts,
              MAX(e.ts)                                                       AS last_ts,
              GROUP_CONCAT(DISTINCT e.actor)                                  AS actors
         FROM sessions s
         LEFT JOIN events e ON e.session_id = s.id
        WHERE s.project_path != ''
          AND (@since IS NULL OR e.ts >= @since)
        GROUP BY s.project_path
        ORDER BY last_ts DESC`,
    )
    .all({ since: since ?? null }) as ProjectRow[];
}

export interface CostRow {
  bucket: string;
  actor: string;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cr: number;
  responses: number;
}

/** 成本聚合。groupBy: day | project | model。 */
export function costs(
  db: DB,
  groupBy: 'day' | 'project' | 'model' | 'session',
  since?: number,
  project?: string,
): CostRow[] {
  const bucketExpr =
    groupBy === 'day'
      ? `strftime('%Y-%m-%d', e.ts / 1000, 'unixepoch', 'localtime')`
      : groupBy === 'project'
        ? `s.project_path`
        : groupBy === 'session'
          ? `s.id`
          : `COALESCE(e.model, '(unknown)')`;

  return db
    .prepare(
      `SELECT ${bucketExpr} AS bucket,
              e.actor,
              COALESCE(e.model, '(unknown)') AS model,
              COALESCE(SUM(e.tokens_in), 0)  AS tokens_in,
              COALESCE(SUM(e.tokens_out), 0) AS tokens_out,
              COALESCE(SUM(e.tokens_cr), 0)  AS tokens_cr,
              COUNT(*)                       AS responses
         FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE e.kind = 'response'
          -- 只统计真正消耗了 token 的轮次，滤掉 <synthetic> 之类的零用量记录
          AND (COALESCE(e.tokens_in, 0) + COALESCE(e.tokens_out, 0) + COALESCE(e.tokens_cr, 0)) > 0
          AND (@since IS NULL OR e.ts >= @since)
          AND (@project IS NULL OR s.project_path = @project)
        GROUP BY bucket, e.actor${groupBy === 'model' || groupBy === 'session' ? '' : ', model'}
        ORDER BY bucket DESC`,
    )
    .all({ since: since ?? null, project: project ?? null }) as CostRow[];
}

export interface SessionRow {
  id: string;
  actor: string;
  external_id: string;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  ended_at: number | null;
  source_version: string | null;
  title: string | null;
  events: number;
  commands: number;
  failed: number;
  tokens_in: number;
  tokens_out: number;
}

export function sessions(
  db: DB,
  opts: { project?: string; actor?: string; limit?: number; q?: string } = {},
): SessionRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return db
    .prepare(
      `SELECT s.id, s.actor, s.external_id, s.project_path, s.git_branch,
              s.started_at, s.ended_at, s.source_version, s.title,
              COUNT(e.id) AS events,
              SUM(CASE WHEN e.kind = 'command' THEN 1 ELSE 0 END) AS commands,
              SUM(CASE WHEN e.exit_code IS NOT NULL AND e.exit_code != 0 THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(e.tokens_in), 0)  AS tokens_in,
              COALESCE(SUM(e.tokens_out), 0) AS tokens_out
         FROM sessions s
         LEFT JOIN events e ON e.session_id = s.id
        WHERE (@project IS NULL OR s.project_path = @project)
          AND (@actor IS NULL OR s.actor = @actor)
          AND (@q IS NULL OR s.title LIKE '%' || @q || '%' OR s.project_path LIKE '%' || @q || '%')
        GROUP BY s.id
        ORDER BY s.started_at DESC
        LIMIT @limit`,
    )
    .all({
      project: opts.project ?? null,
      actor: opts.actor ?? null,
      q: opts.q ?? null,
      limit,
    }) as SessionRow[];
}

export function sessionById(db: DB, id: string): SessionRow | undefined {
  return db.prepare(
    `SELECT s.id, s.actor, s.external_id, s.project_path, s.git_branch, s.started_at, s.ended_at,
            s.source_version, s.title, COUNT(e.id) AS events,
            SUM(CASE WHEN e.kind = 'command' THEN 1 ELSE 0 END) AS commands,
            SUM(CASE WHEN e.exit_code IS NOT NULL AND e.exit_code != 0 THEN 1 ELSE 0 END) AS failed,
            COALESCE(SUM(e.tokens_in), 0) AS tokens_in, COALESCE(SUM(e.tokens_out), 0) AS tokens_out
       FROM sessions s LEFT JOIN events e ON e.session_id = s.id WHERE s.id = ? GROUP BY s.id`,
  ).get(id) as SessionRow | undefined;
}

/** 会话详情把摘要、完整时间线和改动文件一次交给 UI，避免前端拼多次查询。 */
export function sessionDetail(db: DB, id: string): { session?: SessionRow; events: TimelineRow[]; files: FileRow[] } {
  const session = sessionById(db, id);
  if (!session) return { events: [], files: [] };
  const events = timeline(db, { sessionId: id, includeSidechain: true, limit: 500 }).rows.reverse();
  const files = db.prepare(
    `SELECT e.file_path, COUNT(*) AS events, MIN(e.ts) AS first_ts, MAX(e.ts) AS last_ts,
            GROUP_CONCAT(DISTINCT e.actor) AS actors
       FROM events e WHERE e.session_id = ? AND e.file_path IS NOT NULL
      GROUP BY e.file_path ORDER BY last_ts DESC`,
  ).all(id) as FileRow[];
  return { session, events, files };
}

export interface FileRow {
  file_path: string;
  events: number;
  first_ts: number;
  last_ts: number;
  actors: string;
  projects?: number;
}

/** 文件视图：按路径聚合，点击后可继续追溯每一次编辑与命令关联。 */
export function files(db: DB, opts: { project?: string; q?: string; limit?: number } = {}): FileRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 1000);
  return db.prepare(
    `SELECT e.file_path, COUNT(*) AS events, MIN(e.ts) AS first_ts, MAX(e.ts) AS last_ts,
            GROUP_CONCAT(DISTINCT e.actor) AS actors, COUNT(DISTINCT s.project_path) AS projects
       FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE e.file_path IS NOT NULL
        AND (@project IS NULL OR s.project_path = @project)
        AND (@q IS NULL OR e.file_path LIKE '%' || @q || '%')
      GROUP BY e.file_path ORDER BY last_ts DESC LIMIT @limit`,
  ).all({ project: opts.project ?? null, q: opts.q ?? null, limit }) as FileRow[];
}

export interface WorkspaceRow {
  id: string;
  name: string;
  layout: string;
  panes: string;
  created_at: number;
  updated_at: number;
}

export function workspaces(db: DB): WorkspaceRow[] {
  return db.prepare(`SELECT id, name, layout, panes, created_at, updated_at FROM workspaces ORDER BY updated_at DESC`).all() as WorkspaceRow[];
}

export function upsertWorkspace(db: DB, workspace: { id: string; name: string; layout: unknown; panes: unknown }): WorkspaceRow {
  const now = Date.now();
  const layout = JSON.stringify(workspace.layout);
  const panes = JSON.stringify(workspace.panes);
  db.prepare(
    `INSERT INTO workspaces (id, name, layout, panes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, layout = excluded.layout, panes = excluded.panes, updated_at = excluded.updated_at`,
  ).run(workspace.id, workspace.name.slice(0, 100), layout, panes, now, now);
  return db.prepare(`SELECT id, name, layout, panes, created_at, updated_at FROM workspaces WHERE id = ?`).get(workspace.id) as WorkspaceRow;
}

export function deleteWorkspace(db: DB, id: string): boolean {
  return db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id).changes > 0;
}

export interface ProjectRootRow {
  path: string;
  sort_order: number;
  created_at: number;
}

export function projectRoots(db: DB): ProjectRootRow[] {
  return db.prepare(`SELECT path, sort_order, created_at FROM project_roots ORDER BY sort_order ASC, created_at ASC`).all() as ProjectRootRow[];
}

export function addProjectRoot(db: DB, rootPath: string): ProjectRootRow {
  const existing = db.prepare(`SELECT path, sort_order, created_at FROM project_roots WHERE path = ?`).get(rootPath) as ProjectRootRow | undefined;
  if (existing) return existing;
  const count = db.prepare(`SELECT COUNT(*) AS count FROM project_roots`).get() as { count: number };
  if (count.count >= 5) throw new Error('at most 5 project roots are allowed');
  const now = Date.now();
  db.prepare(`INSERT INTO project_roots (path, sort_order, created_at) VALUES (?, ?, ?)`).run(rootPath, count.count, now);
  return db.prepare(`SELECT path, sort_order, created_at FROM project_roots WHERE path = ?`).get(rootPath) as ProjectRootRow;
}

export function deleteProjectRoot(db: DB, rootPath: string): boolean {
  return db.prepare(`DELETE FROM project_roots WHERE path = ?`).run(rootPath).changes > 0;
}

export interface Stats {
  sessions: number;
  events: number;
  commands: number;
  failedCommands: number;
  fileEdits: number;
  projects: number;
  byActor: { actor: string; sessions: number; events: number }[];
  firstTs: number | null;
  lastTs: number | null;
  dbBytes: number;
}

export function stats(db: DB): Stats {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const base = one<{
    sessions: number;
    projects: number;
  }>(
    `SELECT COUNT(*) AS sessions, COUNT(DISTINCT project_path) AS projects FROM sessions`,
  );
  const ev = one<{
    events: number;
    commands: number;
    failedCommands: number;
    fileEdits: number;
    firstTs: number | null;
    lastTs: number | null;
  }>(
    `SELECT COUNT(*) AS events,
            SUM(kind = 'command')   AS commands,
            SUM(exit_code IS NOT NULL AND exit_code != 0) AS failedCommands,
            SUM(kind = 'file_edit') AS fileEdits,
            MIN(ts) AS firstTs, MAX(ts) AS lastTs
       FROM events`,
  );
  const byActor = db
    .prepare(
      `SELECT s.actor, COUNT(DISTINCT s.id) AS sessions, COUNT(e.id) AS events
         FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        GROUP BY s.actor ORDER BY events DESC`,
    )
    .all() as { actor: string; sessions: number; events: number }[];
  const page = one<{ page_count: number }>(`PRAGMA page_count`);
  const size = one<{ page_size: number }>(`PRAGMA page_size`);

  return {
    sessions: base.sessions,
    projects: base.projects,
    events: ev.events,
    commands: ev.commands ?? 0,
    failedCommands: ev.failedCommands ?? 0,
    fileEdits: ev.fileEdits ?? 0,
    byActor,
    firstTs: ev.firstTs,
    lastTs: ev.lastTs,
    dbBytes: (page.page_count ?? 0) * (size.page_size ?? 0),
  };
}

/** 筛选器可选项。 */
export function facets(db: DB): {
  actors: string[];
  projects: string[];
  kinds: string[];
  models: string[];
} {
  const col = (sql: string): string[] =>
    db
      .prepare(sql)
      .all()
      .map((r: unknown) => Object.values(r as object)[0] as string)
      .filter((v): v is string => typeof v === 'string');
  return {
    actors: col(`SELECT DISTINCT actor FROM sessions ORDER BY actor`),
    projects: col(
      `SELECT project_path FROM sessions WHERE project_path != ''
        GROUP BY project_path ORDER BY MAX(started_at) DESC LIMIT 200`,
    ),
    kinds: col(`SELECT DISTINCT kind FROM events ORDER BY kind`),
    models: col(`SELECT DISTINCT model FROM events WHERE model IS NOT NULL ORDER BY model`),
  };
}
