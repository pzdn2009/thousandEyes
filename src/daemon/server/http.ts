import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAST_DIR, HOST, PORT } from '../config.js';
import type { DB } from '../db/index.js';
import { costs, deleteWorkspace, facets, files, projects, sessionById, sessionDetail, sessions, stats, timeline, upsertWorkspace, workspaces } from '../db/queries.js';
import { authenticate, ensureToken, hostAllowed } from './auth.js';
import type { AgentState, AgentStatus, LiveTracker } from '../live/tracker.js';
import type { PtyManager, SpawnOptions } from '../pty/manager.js';
import { ALL_ADAPTERS } from '../adapters/registry.js';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 定位前端资源目录。
 *
 * 源码运行（tsx）时本文件在 src/daemon/server/，打包后在 dist/daemon/，层级不同，
 * 所以逐级向上找 `web/index.html` 或 `dist/web/index.html`，两种布局都能命中。
 */
function findWebDirs(): string[] {
  const out: string[] = [];
  let dir = HERE;
  for (let i = 0; i < 5; i++) {
    out.push(path.join(dir, 'web'), path.join(dir, 'dist', 'web'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  out.push(path.resolve(process.cwd(), 'dist', 'web'));
  return out;
}

const WEB_DIRS = findWebDirs();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export interface ServerDeps {
  db: DB;
  /** 手动触发一次全量重扫。 */
  rescan: () => Promise<{ files: number; events: number; ms: number }>;
  /** daemon 运行时信息。 */
  info: () => Record<string, unknown>;
  /** 实时状态跟踪。 */
  tracker: LiveTracker;
  /** Claude hook 安装状态。 */
  hookStatus: () => { settingsFile: string; installed: string[]; missing: string[] };
  terminals: PtyManager;
}

function nums(v: string | null): number | undefined {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function list(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function json(res: http.ServerResponse, status: number, body: unknown, extra?: string): void {
  const payload = JSON.stringify(body);
  const headers: http.OutgoingHttpHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (extra) headers['set-cookie'] = extra;
  res.writeHead(status, headers);
  res.end(payload);
}

function webRoot(): string | undefined {
  return WEB_DIRS.find((d) => fs.existsSync(path.join(d, 'index.html')));
}

function serveStatic(res: http.ServerResponse, urlPath: string, setCookie?: string): boolean {
  const root = webRoot();
  if (!root) return false;
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root))) return false; // 目录穿越
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;

  const headers: http.OutgoingHttpHeaders = {
    'content-type': MIME[path.extname(full)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (setCookie) headers['set-cookie'] = setCookie;
  res.writeHead(200, headers);
  res.end(fs.readFileSync(full));
  return true;
}

/** 录像仅从专用目录按文件名读取，不能把 events.cast_ref 直接暴露给浏览器。 */
function serveCast(res: http.ServerResponse, name: string, setCookie?: string): boolean {
  const safe = path.basename(name);
  if (safe !== name || !/^[a-zA-Z0-9_.-]+\.cast$/.test(safe)) return false;
  const full = path.join(CAST_DIR, safe);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  res.writeHead(200, {
    'content-type': 'application/x-asciicast; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(setCookie ? { 'set-cookie': setCookie } : {}),
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

/** Git diff 只在已索引项目目录内执行，文件路径以 `--` 分隔避免被解释为参数。 */
function projectDiff(db: DB, project: string, file?: string): { diff: string; available: boolean; error?: string } {
  const known = db.prepare(`SELECT 1 FROM sessions WHERE project_path = ? LIMIT 1`).get(project);
  if (!known || !project || !fs.existsSync(project)) return { diff: '', available: false, error: 'project not indexed' };
  const args = ['diff', '--no-ext-diff', '--', ...(file ? [file] : [])];
  const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', timeout: 4_000, maxBuffer: 1_000_000 });
  if (result.error || result.status !== 0) return { diff: '', available: false, error: result.stderr?.trim() || String(result.error ?? 'not a git repository') };
  return { diff: result.stdout, available: true };
}

export function createServer(deps: ServerDeps): { server: http.Server; token: string; url: string } {
  const token = ensureToken();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);

    if (!hostAllowed(req)) {
      json(res, 403, { error: 'forbidden host' });
      return;
    }
    if (url.pathname === '/api/health') {
      json(res, 200, { ok: true });
      return;
    }

    const auth = authenticate(req, url, token);
    if (!auth.ok) {
      json(res, 401, { error: 'unauthorized', hint: '用 daemon 启动时打印的带 token 的地址访问' });
      return;
    }

    try {
      if (handleApi(req, res, url, deps, auth.setCookie)) return;
      if (req.method === 'GET' && serveStatic(res, url.pathname, auth.setCookie)) return;
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        // SPA 回退
        if (serveStatic(res, '/', auth.setCookie)) return;
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e instanceof Error ? e.message : e) });
    }
  });

  return { server, token, url: `http://${HOST}:${PORT}/?token=${token}` };
}

function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: ServerDeps,
  setCookie?: string,
): boolean {
  const { db } = deps;
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;
  const q = url.searchParams;

  if (req.method === 'GET' && p === '/api/stats') {
    json(res, 200, { ...stats(db), daemon: deps.info() }, setCookie);
    return true;
  }

  if (req.method === 'GET' && p === '/api/facets') {
    json(res, 200, facets(db), setCookie);
    return true;
  }

  if (req.method === 'GET' && p === '/api/timeline') {
    json(
      res,
      200,
      timeline(db, {
        actors: list(q.get('actors')),
        kinds: list(q.get('kinds')),
        project: q.get('project') ?? undefined,
        sessionId: q.get('sessionId') ?? undefined,
        filePath: q.get('filePath') ?? undefined,
        q: q.get('q') ?? undefined,
        since: nums(q.get('since')),
        until: nums(q.get('until')),
        failedOnly: q.get('failedOnly') === '1',
        includeSidechain: q.get('includeSidechain') === '1',
        limit: nums(q.get('limit')),
        cursor: q.get('cursor') ?? undefined,
      }),
      setCookie,
    );
    return true;
  }

  if (req.method === 'GET' && p === '/api/projects') {
    json(res, 200, { rows: projects(db, nums(q.get('since'))) }, setCookie);
    return true;
  }

  if (req.method === 'GET' && p === '/api/costs') {
    const groupBy = q.get('groupBy');
    const g = groupBy === 'project' || groupBy === 'model' || groupBy === 'session' ? groupBy : 'day';
    json(
      res,
      200,
      { groupBy: g, rows: costs(db, g, nums(q.get('since')), q.get('project') ?? undefined) },
      setCookie,
    );
    return true;
  }

  if (req.method === 'GET' && p === '/api/sessions') {
    json(
      res,
      200,
      {
        rows: sessions(db, {
          project: q.get('project') ?? undefined,
          actor: q.get('actor') ?? undefined,
          q: q.get('q') ?? undefined,
          limit: nums(q.get('limit')),
        }),
      },
      setCookie,
    );
    return true;
  }

  const detailMatch = /^\/api\/sessions\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && detailMatch) {
    const detail = sessionDetail(db, decodeURIComponent(detailMatch[1]!));
    if (!detail.session) json(res, 404, { error: 'session not found' }, setCookie);
    else json(res, 200, detail, setCookie);
    return true;
  }

  if (req.method === 'GET' && p === '/api/files') {
    json(res, 200, {
      rows: files(db, {
        project: q.get('project') ?? undefined,
        q: q.get('q') ?? undefined,
        limit: nums(q.get('limit')),
      }),
    }, setCookie);
    return true;
  }

  if (req.method === 'GET' && p === '/api/git/diff') {
    const project = q.get('project') ?? '';
    json(res, 200, projectDiff(db, project, q.get('file') ?? undefined), setCookie);
    return true;
  }

  const castMatch = /^\/api\/casts\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && castMatch) {
    if (!serveCast(res, decodeURIComponent(castMatch[1]!), setCookie)) {
      json(res, 404, { error: 'cast not found' }, setCookie);
    }
    return true;
  }

  if (req.method === 'GET' && p === '/api/agents') {
    json(res, 200, { rows: deps.tracker.list(), hooks: deps.hookStatus() }, setCookie);
    return true;
  }

  if (req.method === 'GET' && p === '/api/terminals') {
    json(res, 200, { rows: deps.terminals.list() }, setCookie);
    return true;
  }

  if (req.method === 'GET' && p === '/api/workspaces') {
    json(res, 200, { rows: workspaces(db) }, setCookie);
    return true;
  }
  if (req.method === 'POST' && p === '/api/workspaces') {
    readJson(req).then((body) => {
      const input = body as { id?: unknown; name?: unknown; layout?: unknown; panes?: unknown };
      if (typeof input.name !== 'string' || !input.name.trim() || !Array.isArray(input.panes)) throw new Error('name and panes are required');
      json(res, 201, upsertWorkspace(db, { id: typeof input.id === 'string' ? input.id : randomUUID(), name: input.name.trim(), layout: input.layout ?? {}, panes: input.panes }), setCookie);
    }).catch((e) => json(res, 400, { error: String(e) }, setCookie));
    return true;
  }
  const workspaceMatch = /^\/api\/workspaces\/([^/]+)(?:\/(restore))?$/.exec(p);
  if (workspaceMatch) {
    const id = decodeURIComponent(workspaceMatch[1]!);
    if (req.method === 'DELETE' && !workspaceMatch[2]) {
      if (!deleteWorkspace(db, id)) json(res, 404, { error: 'workspace not found' }, setCookie);
      else json(res, 200, { ok: true }, setCookie);
      return true;
    }
    if (req.method === 'POST' && workspaceMatch[2] === 'restore') {
      const workspace = workspaces(db).find((row) => row.id === id);
      if (!workspace) { json(res, 404, { error: 'workspace not found' }, setCookie); return true; }
      let panes: Array<{ cwd?: string; shell?: string; title?: string; bootCommand?: string; noRecord?: boolean }>;
      try { panes = JSON.parse(workspace.panes); } catch { panes = []; }
      const rows = panes.slice(0, 12).map((pane) => deps.terminals.spawn({ cwd: pane.cwd, shell: pane.shell, title: pane.title, bootCommand: pane.bootCommand, noRecord: pane.noRecord === true }));
      json(res, 201, { rows, layout: JSON.parse(workspace.layout) }, setCookie);
      return true;
    }
  }

  if (req.method === 'POST' && p === '/api/terminals') {
    readJson(req).then((body) => {
      const o = body as SpawnOptions;
      const meta = deps.terminals.spawn({
        cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
        shell: typeof o.shell === 'string' ? o.shell : undefined,
        title: typeof o.title === 'string' ? o.title : undefined,
        bootCommand: typeof o.bootCommand === 'string' ? o.bootCommand : undefined,
        noRecord: o.noRecord === true,
      });
      json(res, 201, meta, setCookie);
    }).catch((e) => json(res, 400, { error: String(e) }, setCookie));
    return true;
  }

  const termMatch = /^\/api\/terminals\/([^/]+)(?:\/(clone))?$/.exec(p);
  if (termMatch) {
    const id = decodeURIComponent(termMatch[1]!);
    if (req.method === 'POST' && termMatch[2] === 'clone') {
      const meta = deps.terminals.clone(id);
      if (!meta) json(res, 404, { error: 'terminal not found' }, setCookie);
      else json(res, 201, meta, setCookie);
      return true;
    }
    if (req.method === 'DELETE' && !termMatch[2]) {
      if (!deps.terminals.kill(id)) json(res, 404, { error: 'terminal not found' }, setCookie);
      else json(res, 202, { ok: true }, setCookie);
      return true;
    }
    if (req.method === 'PATCH' && !termMatch[2]) {
      readJson(req).then((body) => {
        const title = (body as { title?: unknown }).title;
        if (typeof title !== 'string' || !title.trim()) throw new Error('title is required');
        if (!deps.terminals.rename(id, title.trim())) { json(res, 404, { error: 'terminal not found' }, setCookie); return; }
        json(res, 200, deps.terminals.get(id), setCookie);
      }).catch((e) => json(res, 400, { error: String(e) }, setCookie));
      return true;
    }
  }

  const resumeMatch = /^\/api\/sessions\/([^/]+)\/resume$/.exec(p);
  if (req.method === 'POST' && resumeMatch) {
    const session = sessionById(db, decodeURIComponent(resumeMatch[1]!));
    const adapter = session ? ALL_ADAPTERS.find((a) => a.id === session.actor) : undefined;
    if (!session || !adapter || session.actor === 'human') {
      json(res, 400, { error: 'only agent sessions can be resumed' }, setCookie);
    } else {
      const command = adapter.resumeCommand(session.external_id, session.project_path)
        .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
      json(res, 201, deps.terminals.spawn({ cwd: session.project_path, title: session.title ?? `${session.actor} resume`, bootCommand: command }), setCookie);
    }
    return true;
  }

  if (req.method === 'GET' && p === '/api/live') {
    streamLive(req, res, deps.tracker);
    return true;
  }

  if (req.method === 'POST' && p === '/api/rescan') {
    deps
      .rescan()
      .then((r) => json(res, 200, r, setCookie))
      .catch((e) => json(res, 500, { error: String(e) }));
    return true;
  }

  return false;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 32_768) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * 状态墙的实时推送。用 SSE 而非 WebSocket：单向广播、自带断线重连、
 * 不需要额外协议层——Phase 2 的终端流才真正需要 WebSocket。
 */
function streamLive(req: http.IncomingMessage, res: http.ServerResponse, tracker: LiveTracker): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('snapshot', { rows: tracker.list() });

  const onChange = (status: AgentStatus, prev?: AgentState) => send('change', { status, prev });
  const onTick = (status: AgentStatus) => send('tick', { status });
  const onRemove = (key: string) => send('remove', { key });

  tracker.on('change', onChange);
  tracker.on('tick', onTick);
  tracker.on('remove', onRemove);

  // 心跳，防止中间层掐掉空闲连接
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 25_000);

  const cleanup = () => {
    clearInterval(beat);
    tracker.off('change', onChange);
    tracker.off('tick', onTick);
    tracker.off('remove', onRemove);
    if (!res.writableEnded) res.end();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}
