import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * thousandEyes Web UI —— Phase 0 的四个视图。
 * 无框架，直接操作 DOM：数据量大时行渲染要可控，且这一层不值得引入构建复杂度。
 */

type View = 'live' | 'terminals' | 'timeline' | 'projects' | 'costs' | 'sessions' | 'files';

type AgentState = 'running' | 'waiting' | 'idle' | 'error';

interface AgentStatus {
  key: string;
  actor: string;
  sessionId: string;
  project: string;
  cwd?: string;
  title?: string;
  state: AgentState;
  detail?: string;
  since: number;
  lastEventAt: number;
  source: 'hook' | 'watch';
  toolCalls: number;
}

interface HookInfo {
  settingsFile: string;
  installed: string[];
  missing: string[];
}

interface TerminalMeta {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exitedAt?: number;
  exitCode?: number;
  clonedFrom?: string;
  lastCommand?: string;
  running: boolean;
  integrated: boolean;
  castFile?: string;
  recordingBytes: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  layout: string;
  panes: string;
  created_at: number;
  updated_at: number;
}

interface TimelineRow {
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

interface FileRow {
  file_path: string;
  events: number;
  first_ts: number;
  last_ts: number;
  actors: string;
  projects?: number;
}

interface ProjectRow {
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

interface CostRow {
  bucket: string;
  actor: string;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cr: number;
  responses: number;
}

interface SessionRow {
  id: string;
  actor: string;
  external_id: string;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  title: string | null;
  source_version: string | null;
  events: number;
  commands: number;
  failed: number;
  tokens_in: number;
  tokens_out: number;
}

interface Stats {
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
  daemon: { adapters: string[]; availableAdapters?: string[]; watchIngested: number; pid: number };
}

interface Facets {
  actors: string[];
  projects: string[];
  kinds: string[];
  models: string[];
}

const KIND_ICON: Record<string, string> = {
  command: '$',
  file_edit: '✎',
  prompt: '›',
  response: '◆',
  tool_use: '⚙',
  notification: '!',
  session_start: '▸',
  session_end: '▪',
};

const KIND_LABEL: Record<string, string> = {
  command: '命令',
  file_edit: '文件改动',
  prompt: '提问',
  response: '回复',
  tool_use: '工具',
  notification: '通知',
};

const state = {
  view: 'timeline' as View,
  q: '',
  actors: new Set<string>(),
  kinds: new Set<string>(['command', 'file_edit', 'prompt']),
  project: '',
  sessionId: '',
  filePath: '',
  failedOnly: false,
  includeSidechain: false,
  costGroupBy: 'day' as 'day' | 'project' | 'model' | 'session',
  sinceDays: 0,
  rows: [] as TimelineRow[],
  cursor: undefined as string | undefined,
  loading: false,
  sort: { key: 'last_ts', dir: -1 as 1 | -1 },
};

interface RouteSnapshot {
  view: View;
  q: string;
  actors: string[];
  kinds: string[];
  project: string;
  sessionId: string;
  filePath: string;
  failedOnly: boolean;
  includeSidechain: boolean;
  costGroupBy: 'day' | 'project' | 'model' | 'session';
  sinceDays: number;
  sort: { key: string; dir: 1 | -1 };
  scrollY: number;
}

interface RouteState {
  thousandEyes: true;
  position: number;
  route: RouteSnapshot;
}

let historyPosition = 0;
let highestHistoryPosition = 0;

function snapshotRoute(): RouteSnapshot {
  return {
    view: state.view,
    q: state.q,
    actors: [...state.actors],
    kinds: [...state.kinds],
    project: state.project,
    sessionId: state.sessionId,
    filePath: state.filePath,
    failedOnly: state.failedOnly,
    includeSidechain: state.includeSidechain,
    costGroupBy: state.costGroupBy,
    sinceDays: state.sinceDays,
    sort: { ...state.sort },
    scrollY: window.scrollY,
  };
}

function isRouteState(value: unknown): value is RouteState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RouteState>;
  return candidate.thousandEyes === true && typeof candidate.position === 'number' && Boolean(candidate.route);
}

function routeUrl(view = state.view): string {
  return `${location.pathname}${location.search}#${view}`;
}

function updateHistoryControls(): void {
  const back = document.getElementById('history-back') as HTMLButtonElement | null;
  const forward = document.getElementById('history-forward') as HTMLButtonElement | null;
  if (!back || !forward) return;
  back.disabled = historyPosition <= 0;
  forward.disabled = historyPosition >= highestHistoryPosition;
}

function persistHighestHistoryPosition(): void {
  sessionStorage.setItem(`thousandEyes.historyMax:${location.pathname}`, String(highestHistoryPosition));
}

function replaceRoute(): void {
  const entry: RouteState = { thousandEyes: true, position: historyPosition, route: snapshotRoute() };
  history.replaceState(entry, '', routeUrl());
  updateHistoryControls();
}

function pushRoute(): void {
  historyPosition++;
  highestHistoryPosition = historyPosition;
  persistHighestHistoryPosition();
  const entry: RouteState = { thousandEyes: true, position: historyPosition, route: snapshotRoute() };
  history.pushState(entry, '', routeUrl());
  updateHistoryControls();
}

function applyRoute(route: RouteSnapshot): void {
  state.view = route.view;
  state.q = route.q;
  state.actors = new Set(route.actors);
  state.kinds = new Set(route.kinds);
  state.project = route.project;
  state.sessionId = route.sessionId;
  state.filePath = route.filePath;
  state.failedOnly = route.failedOnly;
  state.includeSidechain = route.includeSidechain;
  state.costGroupBy = route.costGroupBy;
  state.sinceDays = route.sinceDays;
  state.sort = { ...route.sort };
}

let facets: Facets = { actors: [], projects: [], kinds: [], models: [] };
let stats: Stats | null = null;
interface FavoriteCommand { command: string; cwd?: string; label?: string; tags?: string[] }
const favoriteCommands: FavoriteCommand[] = (() => {
  try { return JSON.parse(localStorage.getItem('thousandEyes.commandFavorites') ?? '[]') as FavoriteCommand[]; } catch { return []; }
})();

function persistFavorites(): void {
  localStorage.setItem('thousandEyes.commandFavorites', JSON.stringify(favoriteCommands.slice(0, 100)));
}

/* ---------------- 工具 ---------------- */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function num(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(ts: number): string {
  const key = dayKey(ts);
  const today = dayKey(Date.now());
  const yest = dayKey(Date.now() - 864e5);
  if (key === today) return `今天 · ${key}`;
  if (key === yest) return `昨天 · ${key}`;
  return key;
}

function dur(ms: number | null): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function shortPath(p: string | null): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

function sinceTs(): string {
  return state.sinceDays > 0 ? String(Date.now() - state.sinceDays * 864e5) : '';
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function toast(msg: string): void {
  const t = el('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

/* ---------------- 筛选栏 ---------------- */

function chip(
  label: string,
  pressed: boolean,
  onClick: () => void,
  cls = '',
): HTMLButtonElement {
  const b = el('button', { class: `chip ${cls}`.trim(), 'aria-pressed': String(pressed) }, label);
  b.onclick = () => {
    replaceRoute();
    onClick();
    pushRoute();
    renderFilters();
    reload();
  };
  return b;
}

function renderFilters(): void {
  const bar = document.getElementById('filters')!;
  bar.replaceChildren();

  if (state.view === 'live') {
    // 状态墙由 SSE 推送，没有可筛的东西；给一条说明和快捷入口就够了
    bar.append(el('span', { class: 'proj' }, '实时推送 · waiting 排在最前'));
    bar.append(el('div', { class: 'grow' }));
    const pal = el('button', { class: 'btn' }, '命令面板  ⌘K');
    pal.onclick = openPalette;
    bar.append(pal);
    return;
  }

  if (state.view === 'terminals') {
    bar.append(el('span', { class: 'proj' }, 'daemon 持有 PTY；关掉浏览器不会结束终端'));
    for (const columns of [1, 2, 3]) {
      bar.append(chip(`${columns} 列`, terminalLayout.columns === columns, () => {
        terminalLayout.columns = columns;
        persistTerminalLayout();
      }));
    }
    if (terminalLayout.columns === 2) {
      bar.append(el('div', { class: 'sep' }));
      for (const ratio of [0.33, 0.5, 0.67]) {
        bar.append(chip(`${Math.round(ratio * 100)}:${Math.round((1 - ratio) * 100)}`, terminalLayout.primaryRatio === ratio, () => {
          terminalLayout.primaryRatio = ratio;
          persistTerminalLayout();
        }));
      }
    }
    const workspace = el('select', { title: '工作区模板' }) as HTMLSelectElement;
    workspace.append(el('option', { value: '' }, '工作区模板…'));
    for (const item of workspaceRows) workspace.append(el('option', { value: item.id }, item.name));
    workspace.value = selectedWorkspace;
    workspace.onchange = () => { selectedWorkspace = workspace.value; };
    bar.append(workspace);
    const restore = el('button', { class: 'btn' }, '恢复');
    restore.disabled = !selectedWorkspace;
    restore.onclick = () => void restoreWorkspace(selectedWorkspace);
    bar.append(restore);
    const save = el('button', { class: 'btn' }, '保存模板');
    save.onclick = () => void saveWorkspace();
    bar.append(save);
    bar.append(el('div', { class: 'grow' }));
    const add = el('button', { class: 'btn' }, '+ 新终端');
    add.onclick = () => void createTerminal();
    bar.append(add);
    return;
  }

  if (state.view === 'costs') {
    for (const [key, label] of [
      ['day', '按天'],
      ['project', '按项目'],
      ['model', '按模型'],
      ['session', '按会话'],
    ] as const) {
      bar.append(
        chip(label, state.costGroupBy === key, () => {
          state.costGroupBy = key;
        }),
      );
    }
    bar.append(el('div', { class: 'sep' }), rangeSelect());
    bar.append(el('div', { class: 'grow' }));
    return;
  }

  if (state.view === 'timeline' || state.view === 'sessions' || state.view === 'files') {
    const search = el('input', {
      type: 'search',
      placeholder: state.view === 'timeline' ? '搜索命令、文件、对话…' : state.view === 'files' ? '搜索文件路径…' : '搜索会话标题或项目…',
      value: state.q,
    }) as HTMLInputElement;
    let timer: number | undefined;
    search.oninput = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        state.q = search.value.trim();
        replaceRoute();
        reload();
      }, 260);
    };
    bar.append(search);
  }

  for (const a of facets.actors) {
    bar.append(
      chip(a, state.actors.has(a), () => (state.actors.has(a) ? state.actors.delete(a) : state.actors.add(a)), a),
    );
  }

  if (state.view === 'timeline') {
    bar.append(el('div', { class: 'sep' }));
    for (const k of ['command', 'file_edit', 'prompt', 'response', 'tool_use', 'notification']) {
      if (!facets.kinds.includes(k)) continue;
      bar.append(
        chip(KIND_LABEL[k] ?? k, state.kinds.has(k), () =>
          state.kinds.has(k) ? state.kinds.delete(k) : state.kinds.add(k),
        ),
      );
    }
    bar.append(el('div', { class: 'sep' }));
    bar.append(chip('只看失败', state.failedOnly, () => (state.failedOnly = !state.failedOnly), 'danger'));
    bar.append(
      chip('含 subagent', state.includeSidechain, () => (state.includeSidechain = !state.includeSidechain)),
    );
  }

  bar.append(el('div', { class: 'sep' }), projectSelect(), rangeSelect());

  if (state.sessionId) {
    const clear = el('button', { class: 'chip', 'aria-pressed': 'true' }, `会话筛选 ✕`);
    clear.onclick = () => {
      replaceRoute();
      state.sessionId = '';
      pushRoute();
      renderFilters();
      reload();
    };
    bar.append(clear);
  }
  if (state.filePath) {
    const clear = el('button', { class: 'chip', 'aria-pressed': 'true' }, `文件筛选 ✕`);
    clear.onclick = () => {
      replaceRoute();
      state.filePath = '';
      pushRoute();
      renderFilters();
      reload();
    };
    bar.append(clear);
  }
  bar.append(el('div', { class: 'grow' }));
}

function projectSelect(): HTMLSelectElement {
  const sel = el('select', { title: '项目' }) as HTMLSelectElement;
  sel.append(el('option', { value: '' }, '全部项目'));
  for (const p of facets.projects) {
    const opt = el('option', { value: p }, shortPath(p));
    if (p === state.project) opt.setAttribute('selected', '');
    sel.append(opt);
  }
  sel.value = state.project;
  sel.onchange = () => {
    replaceRoute();
    state.project = sel.value;
    pushRoute();
    reload();
  };
  return sel;
}

function rangeSelect(): HTMLSelectElement {
  const sel = el('select', { title: '时间范围' }) as HTMLSelectElement;
  for (const [d, label] of [
    [0, '全部时间'],
    [1, '近 24 小时'],
    [7, '近 7 天'],
    [30, '近 30 天'],
    [90, '近 90 天'],
  ] as const) {
    sel.append(el('option', { value: String(d) }, label));
  }
  sel.value = String(state.sinceDays);
  sel.onchange = () => {
    replaceRoute();
    state.sinceDays = Number(sel.value);
    pushRoute();
    reload();
  };
  return sel;
}

/* ---------------- 时间轴 ---------------- */

function eventRow(r: TimelineRow): HTMLElement {
  const row = el('div', { class: 'ev' });

  row.append(el('div', { class: 'time' }, hhmm(r.ts)));
  row.append(el('div', { class: 'icon' }, KIND_ICON[r.kind] ?? '·'));

  const body = el('div', { class: 'body' });
  const primary = r.command ?? r.file_path ?? r.text ?? '';
  if (primary) {
    const cmd = el('div', { class: 'cmd' }, primary);
    body.append(cmd);
    // 长内容默认截断，点击展开
    requestAnimationFrame(() => {
      if (cmd.scrollHeight > cmd.clientHeight + 2) {
        cmd.classList.add('clickable');
        cmd.title = '点击展开';
        cmd.onclick = () => row.classList.toggle('expanded');
      }
    });
  }
  if (r.command && r.text && r.kind === 'command') {
    body.append(el('div', { class: 'txt' }, r.text));
  }
  row.append(body);

  const meta = el('div', { class: 'meta' });
  if (r.is_sidechain) meta.append(el('span', { class: 'tag' }, 'sub'));
  if (r.tool_name && r.kind !== 'command') meta.append(el('span', { class: 'tag' }, r.tool_name));
  if (r.kind === 'response' && (r.tokens_in || r.tokens_out)) {
    meta.append(
      el('span', { class: 'tag' }, `↑${compact(r.tokens_in ?? 0)} ↓${compact(r.tokens_out ?? 0)}`),
    );
  }
  const d = dur(r.duration_ms);
  if (d) meta.append(el('span', {}, d));
  if (r.exit_code !== null && r.exit_code !== undefined) {
    meta.append(
      el('span', { class: `tag ${r.exit_code === 0 ? 'ok' : 'err'}` }, r.exit_code === 0 ? '✓' : `exit ${r.exit_code}`),
    );
  }
  meta.append(el('span', { class: `actor ${r.actor}` }, r.actor));
  const proj = el('span', { class: 'proj', title: r.cwd ?? r.project_path }, shortPath(r.project_path));
  proj.onclick = () => {
    replaceRoute();
    state.project = r.project_path;
    switchView('timeline');
  };
  proj.style.cursor = 'pointer';
  meta.append(proj);
  if ((r.actor === 'claude' || r.actor === 'codex') && r.session_id) {
    const resume = el('button', { class: 'event-action', title: '在一个新托管终端中恢复此 agent 会话' }, '接管');
    resume.onclick = (event) => {
      event.stopPropagation();
      void resumeSession(r.session_id);
    };
    meta.append(resume);
  }
  if (r.file_path) {
    const trace = el('button', { class: 'event-action', title: '查看这个文件的所有改动' }, '溯源');
    trace.onclick = (event) => {
      event.stopPropagation();
      replaceRoute();
      state.filePath = r.file_path ?? '';
      state.q = '';
      switchView('timeline');
    };
    meta.append(trace);
  }
  if (r.cast_ref) {
    const replay = el('button', { class: 'event-action', title: '从这条事件附近开始回放终端录像' }, '回放');
    replay.onclick = (event) => {
      event.stopPropagation();
      void openReplay(r.cast_ref!, r.cast_offset ?? 0);
    };
    meta.append(replay);
  }
  if (r.command) {
    const saved = favoriteCommands.some((item) => item.command === r.command && item.cwd === (r.cwd ?? r.project_path));
    const favorite = el('button', { class: 'event-action', title: saved ? '取消收藏命令' : '收藏命令' }, saved ? '★' : '☆');
    favorite.onclick = (event) => {
      event.stopPropagation();
      const index = favoriteCommands.findIndex((item) => item.command === r.command && item.cwd === (r.cwd ?? r.project_path));
      if (index >= 0) favoriteCommands.splice(index, 1);
      else {
        const label = window.prompt('收藏名称（可选）', r.command!.split('\n')[0]?.slice(0, 60));
        const tags = window.prompt('标签（逗号分隔，可选）', '');
        favoriteCommands.unshift({ command: r.command!, cwd: r.cwd ?? r.project_path, label: label || undefined, tags: tags?.split(',').map((tag) => tag.trim()).filter(Boolean) });
      }
      persistFavorites(); favorite.textContent = index >= 0 ? '☆' : '★';
    };
    meta.append(favorite);
  }
  row.append(meta);

  return row;
}

function renderTimeline(append = false): void {
  const main = document.getElementById('main')!;
  const container = append ? main.querySelector<HTMLDivElement>('.tl') : null;
  const tl = container ?? el('div', { class: 'tl' });
  if (!append) main.replaceChildren(tl);

  if (!state.rows.length && !append) {
    main.replaceChildren(el('div', { class: 'empty' }, '没有匹配的事件。试试放宽筛选条件。'));
    return;
  }

  let lastDay = append ? (tl.dataset.lastDay ?? '') : '';
  const start = append ? Number(tl.dataset.rendered ?? 0) : 0;
  for (let i = start; i < state.rows.length; i++) {
    const r = state.rows[i]!;
    const key = dayKey(r.ts);
    if (key !== lastDay) {
      tl.append(el('div', { class: 'daysep' }, dayLabel(r.ts)));
      lastDay = key;
    }
    tl.append(eventRow(r));
  }
  tl.dataset.lastDay = lastDay;
  tl.dataset.rendered = String(state.rows.length);

  main.querySelector('.more')?.remove();
  if (state.cursor) {
    const wrap = el('div', { class: 'more' });
    const btn = el('button', { class: 'btn' }, '加载更多');
    btn.onclick = () => loadMore();
    wrap.append(btn);
    main.append(wrap);
  }
}

async function loadTimeline(more = false): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  const p = new URLSearchParams();
  if (state.actors.size) p.set('actors', [...state.actors].join(','));
  if (state.kinds.size) p.set('kinds', [...state.kinds].join(','));
  if (state.project) p.set('project', state.project);
  if (state.sessionId) p.set('sessionId', state.sessionId);
  if (state.filePath) p.set('filePath', state.filePath);
  if (state.q) p.set('q', state.q);
  if (state.failedOnly) p.set('failedOnly', '1');
  if (state.includeSidechain) p.set('includeSidechain', '1');
  const since = sinceTs();
  if (since) p.set('since', since);
  p.set('limit', '120');
  if (more && state.cursor) p.set('cursor', state.cursor);

  try {
    const data = await api<{ rows: TimelineRow[]; nextCursor?: string }>(`/api/timeline?${p}`);
    state.rows = more ? [...state.rows, ...data.rows] : data.rows;
    state.cursor = data.nextCursor;
    renderTimeline(more);
  } catch (e) {
    document.getElementById('main')!.replaceChildren(el('div', { class: 'empty' }, `查询失败：${e}`));
  } finally {
    state.loading = false;
  }
}

function loadMore(): void {
  void loadTimeline(true);
}

/* ---------------- 录像回放 ---------------- */

type CastEvent = [number, 'o' | 'r', string];

async function openReplay(castRef: string, offsetMs = 0): Promise<void> {
  const file = castRef.split('/').pop();
  if (!file) return;
  try {
    const res = await fetch(`/api/casts/${encodeURIComponent(file)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    const lines = (await res.text()).trim().split('\n');
    const header = JSON.parse(lines.shift() ?? '{}') as { width?: number; height?: number; title?: string };
    const events = lines.flatMap((line) => {
      try {
        const value = JSON.parse(line) as CastEvent;
        return Array.isArray(value) && typeof value[0] === 'number' ? [value] : [];
      } catch { return []; }
    });
    if (!events.length) {
      toast('这段录像尚未写入终端输出');
      return;
    }
    const start = Math.max(0, offsetMs / 1000 - 2);
    const overlay = el('div', { class: 'replay-overlay' });
    const box = el('section', { class: 'replay-box' });
    const head = el('div', { class: 'replay-head' }, el('strong', {}, `回放 · ${header.title ?? file}`), el('span', { class: 'proj' }, `从 ${start.toFixed(1)}s 开始`));
    const download = el('a', { class: 'btn', href: `/api/casts/${encodeURIComponent(file)}`, download: file }, '下载 .cast');
    const close = el('button', { class: 'btn' }, '关闭');
    close.onclick = () => {
      if (timer) window.clearTimeout(timer);
      term.dispose();
      overlay.remove();
    };
    head.append(el('div', { class: 'grow' }), download, close);
    const host = el('div', { class: 'replay-terminal' });
    const controls = el('div', { class: 'replay-controls' });
    const play = el('button', { class: 'btn' }, '播放');
    const speed = el('select') as HTMLSelectElement;
    for (const value of ['1', '2', '4', '8']) speed.append(el('option', { value }, `${value}×`));
    const firstAt = events.findIndex((e) => e[0] >= start);
    const scrub = el('input', { type: 'range', min: '0', max: String(Math.max(1, events.length - 1)), value: String(Math.max(0, firstAt)) }) as HTMLInputElement;
    controls.append(play, speed, scrub);
    box.append(head, host, controls); overlay.append(box); document.body.append(overlay);
    const term = new XTerm({ fontFamily: 'var(--mono)', fontSize: 12, cols: header.width ?? 100, rows: header.height ?? 30, theme: { background: '#0d1117' }, disableStdin: true });
    term.open(host);
    let cursor = Number(scrub.value);
    let timer: number | undefined;
    let playing = false;
    const writeEvent = (event: CastEvent): void => {
      if (event[1] === 'o') {
        term.write(event[2]);
        return;
      }
      const [cols, rows] = event[2].split('x').map(Number);
      if (cols && rows) term.resize(cols, rows);
    };
    const drawTo = (target: number) => {
      term.reset();
      // xterm 的 write 是异步队列。把连续输出合并，避免跳转到长录像时排入数万次 write，
      // 否则画面会长期空白，播放也会被旧队列拖住。
      let output = '';
      const flush = () => {
        if (output) term.write(output);
        output = '';
      };
      for (let i = 0; i <= target; i++) {
        const event = events[i];
        if (!event) continue;
        if (event[1] === 'o') output += event[2];
        else {
          flush();
          writeEvent(event);
        }
      }
      flush();
      cursor = target; scrub.value = String(target);
    };
    drawTo(cursor);
    const stopPlayback = () => {
      if (timer) window.clearTimeout(timer);
      timer = undefined;
      playing = false;
      play.textContent = '播放';
    };
    const scheduleNext = () => {
      if (!playing) return;
      if (cursor >= events.length - 1) {
        stopPlayback();
        return;
      }
      const current = events[cursor]!;
      const next = events[cursor + 1]!;
      const delay = Math.max(8, ((next[0] - current[0]) * 1000) / Number(speed.value));
      timer = window.setTimeout(() => {
        cursor++;
        writeEvent(events[cursor]!);
        scrub.value = String(cursor);
        scheduleNext();
      }, delay);
    };
    play.onclick = () => {
      if (playing) {
        stopPlayback();
        return;
      }
      if (cursor >= events.length - 1) drawTo(0);
      playing = true;
      play.textContent = '暂停';
      scheduleNext();
    };
    scrub.oninput = () => {
      stopPlayback();
      drawTo(Number(scrub.value));
    };
  } catch (error) { toast(`无法读取录像：${error}`); }
}

/* ---------------- 表格通用 ---------------- */

function sortRows<T extends Record<string, unknown>>(rows: T[], key: string, dir: 1 | -1): T[] {
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x ?? '').localeCompare(String(y ?? '')) * dir;
  });
}

function sortableHeader(
  cols: { key: string; label: string; num?: boolean }[],
  onSort: (key: string) => void,
): HTMLTableSectionElement {
  const thead = el('thead');
  const tr = el('tr');
  for (const c of cols) {
    const arrow = state.sort.key === c.key ? (state.sort.dir === -1 ? ' ↓' : ' ↑') : '';
    const th = el('th', { class: c.num ? 'num' : '' }, c.label + arrow);
    th.onclick = () => onSort(c.key);
    tr.append(th);
  }
  thead.append(tr);
  return thead;
}

/* ---------------- 项目视图 ---------------- */

async function renderProjects(): Promise<void> {
  const main = document.getElementById('main')!;
  const since = sinceTs();
  const data = await api<{ rows: ProjectRow[] }>(`/api/projects${since ? `?since=${since}` : ''}`);
  let rows = data.rows.filter((r) => r.events > 0);
  if (state.actors.size) rows = rows.filter((r) => [...state.actors].some((a) => (r.actors ?? '').includes(a)));

  if (!rows.length) {
    main.replaceChildren(el('div', { class: 'empty' }, '这个时间范围内没有项目活动。'));
    return;
  }

  const cols = [
    { key: 'project_path', label: '项目' },
    { key: 'actors', label: 'agent' },
    { key: 'sessions', label: '会话', num: true },
    { key: 'commands', label: '命令', num: true },
    { key: 'failed', label: '失败', num: true },
    { key: 'edits', label: '文件改动', num: true },
    { key: 'tokens_in', label: '输入 token', num: true },
    { key: 'tokens_out', label: '输出 token', num: true },
    { key: 'last_ts', label: '最近活动', num: true },
  ];

  const sorted = sortRows(rows as unknown as Record<string, unknown>[], state.sort.key, state.sort.dir);
  const active = rows.filter((r) => r.last_ts >= Date.now() - 86_400_000).length;
  const failures = rows.reduce((sum, r) => sum + r.failed, 0);
  const totalTokens = rows.reduce((sum, r) => sum + r.tokens_in + r.tokens_out + r.tokens_cr, 0);
  const health = el('div', { class: 'cards' });
  const healthCard = (label: string, value: string, note: string) => el('div', { class: 'card' }, el('div', { class: 'k' }, label), el('div', { class: 'v' }, value), el('div', { class: 's' }, note));
  health.append(healthCard('活跃项目', num(active), '近 24 小时有事件'), healthCard('失败命令', num(failures), failures ? '需要关注' : '当前没有失败'), healthCard('Token 压力', compact(totalTokens), '输入 + 输出 + 缓存读取'));
  const table = el('table');
  table.append(
    sortableHeader(cols, (key) => {
      replaceRoute();
      state.sort = { key, dir: state.sort.key === key && state.sort.dir === -1 ? 1 : -1 };
      pushRoute();
      void renderProjects();
    }),
  );
  const tbody = el('tbody');
  for (const raw of sorted) {
    const r = raw as unknown as ProjectRow;
    const tr = el('tr');
    const link = el('a', { title: r.project_path }, shortPath(r.project_path));
    link.onclick = () => {
      replaceRoute();
      state.project = r.project_path;
      switchView('timeline');
    };
    tr.append(el('td', { class: 'path' }, link));
    const actors = el('td');
    for (const a of (r.actors ?? '').split(',').filter(Boolean)) {
      actors.append(el('span', { class: `actor ${a}` }, `${a} `));
    }
    tr.append(actors);
    tr.append(el('td', { class: 'num' }, num(r.sessions)));
    tr.append(el('td', { class: 'num' }, num(r.commands)));
    tr.append(
      el('td', { class: 'num' }, r.failed ? el('span', { class: 'tag err' }, num(r.failed)) : '—'),
    );
    tr.append(el('td', { class: 'num' }, num(r.edits)));
    tr.append(el('td', { class: 'num' }, compact(r.tokens_in)));
    tr.append(el('td', { class: 'num' }, compact(r.tokens_out)));
    tr.append(el('td', { class: 'num' }, r.last_ts ? new Date(r.last_ts).toLocaleDateString() : '—'));
    tbody.append(tr);
  }
  table.append(tbody);
  main.replaceChildren(health, el('div', { class: 'wrap' }, table));
}

/* ---------------- 成本视图 ---------------- */

async function renderCosts(): Promise<void> {
  const main = document.getElementById('main')!;
  const p = new URLSearchParams({ groupBy: state.costGroupBy });
  const since = sinceTs();
  if (since) p.set('since', since);
  if (state.project) p.set('project', state.project);
  const data = await api<{ rows: CostRow[] }>(`/api/costs?${p}`);

  let rows = data.rows;
  if (state.actors.size) rows = rows.filter((r) => state.actors.has(r.actor));
  if (!rows.length) {
    main.replaceChildren(el('div', { class: 'empty' }, '这个范围内没有 token 用量记录。'));
    return;
  }

  // 同一 bucket 下多 actor/model 会拆成多行，先按 bucket 合并出总量用于条形图比例
  const totals = new Map<string, number>();
  for (const r of rows) {
    const t = r.tokens_in + r.tokens_out + r.tokens_cr;
    totals.set(r.bucket, (totals.get(r.bucket) ?? 0) + t);
  }
  const max = Math.max(...totals.values(), 1);

  const sumIn = rows.reduce((a, r) => a + r.tokens_in, 0);
  const sumOut = rows.reduce((a, r) => a + r.tokens_out, 0);
  const sumCr = rows.reduce((a, r) => a + r.tokens_cr, 0);

  const cards = el('div', { class: 'cards' });
  const card = (k: string, v: string, s?: string) =>
    el('div', { class: 'card' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), s ? el('div', { class: 's' }, s) : null);
  cards.append(card('非缓存输入', compact(sumIn), num(sumIn)));
  cards.append(card('输出', compact(sumOut), num(sumOut)));
  cards.append(card('缓存读取', compact(sumCr), num(sumCr)));
  cards.append(card('计费口径', '已归一', 'Codex 已扣除 cached'));

  const legend = el(
    'div',
    { class: 'legend' },
    el('span', {}, el('i', { style: 'background:var(--accent)' }), '非缓存输入'),
    el('span', {}, el('i', { style: 'background:var(--claude)' }), '输出'),
    el('span', {}, el('i', { style: 'background:color-mix(in srgb, var(--fg-faint) 45%, transparent)' }), '缓存读取'),
  );

  const cols = [
    { key: 'bucket', label: state.costGroupBy === 'day' ? '日期' : state.costGroupBy === 'project' ? '项目' : state.costGroupBy === 'session' ? '会话' : '模型' },
    { key: 'actor', label: 'agent' },
    ...(state.costGroupBy === 'model' ? [] : [{ key: 'model', label: '模型' }]),
    { key: 'tokens_in', label: '非缓存输入', num: true },
    { key: 'tokens_out', label: '输出', num: true },
    { key: 'tokens_cr', label: '缓存读取', num: true },
    { key: 'responses', label: '轮次', num: true },
    { key: '_bar', label: '占比' },
  ];

  const table = el('table');
  table.append(
    sortableHeader(cols, (key) => {
      if (key === '_bar') return;
      replaceRoute();
      state.sort = { key, dir: state.sort.key === key && state.sort.dir === -1 ? 1 : -1 };
      pushRoute();
      void renderCosts();
    }),
  );
  const tbody = el('tbody');
  const sorted =
    state.sort.key === 'last_ts'
      ? rows
      : (sortRows(rows as unknown as Record<string, unknown>[], state.sort.key, state.sort.dir) as unknown as CostRow[]);

  for (const r of sorted) {
    const tr = el('tr');
    const label = state.costGroupBy === 'project' ? shortPath(r.bucket) : r.bucket;
    const bucket = el('td', { class: 'path', title: r.bucket }, label);
    if (state.costGroupBy === 'session') {
      const link = el('a', { title: r.bucket }, shortPath(r.bucket));
      link.onclick = () => void openSessionDetail(r.bucket);
      bucket.replaceChildren(link);
    }
    tr.append(bucket);
    tr.append(el('td', {}, el('span', { class: `actor ${r.actor}` }, r.actor)));
    if (state.costGroupBy !== 'model') tr.append(el('td', {}, r.model ?? '—'));
    tr.append(el('td', { class: 'num' }, compact(r.tokens_in)));
    tr.append(el('td', { class: 'num' }, compact(r.tokens_out)));
    tr.append(el('td', { class: 'num' }, compact(r.tokens_cr)));
    tr.append(el('td', { class: 'num' }, num(r.responses)));

    const total = r.tokens_in + r.tokens_out + r.tokens_cr;
    const w = (total / max) * 100;
    const bar = el('div', { class: 'bar' });
    const seg = (cls: string, part: number) =>
      el('i', { class: cls, style: `width:${total ? (part / total) * w : 0}%` });
    bar.append(seg('b-in', r.tokens_in), seg('b-out', r.tokens_out), seg('b-cr', r.tokens_cr));
    tr.append(el('td', {}, bar));
    tbody.append(tr);
  }
  table.append(tbody);
  main.replaceChildren(cards, legend, el('div', { class: 'wrap' }, table));
}

/* ---------------- 会话视图 ---------------- */

async function renderSessions(): Promise<void> {
  const main = document.getElementById('main')!;
  const p = new URLSearchParams({ limit: '300' });
  if (state.project) p.set('project', state.project);
  if (state.q) p.set('q', state.q);
  if (state.actors.size === 1) p.set('actor', [...state.actors][0]!);
  const data = await api<{ rows: SessionRow[] }>(`/api/sessions?${p}`);

  let rows = data.rows;
  if (state.actors.size > 1) rows = rows.filter((r) => state.actors.has(r.actor));
  if (state.sinceDays > 0) {
    const cut = Date.now() - state.sinceDays * 864e5;
    rows = rows.filter((r) => r.started_at >= cut);
  }
  if (!rows.length) {
    main.replaceChildren(el('div', { class: 'empty' }, '没有匹配的会话。'));
    return;
  }

  const cols = [
    { key: 'started_at', label: '开始时间', num: true },
    { key: 'actor', label: 'agent' },
    { key: 'title', label: '标题 / 项目' },
    { key: 'events', label: '事件', num: true },
    { key: 'commands', label: '命令', num: true },
    { key: 'failed', label: '失败', num: true },
    { key: 'tokens_out', label: '输出 token', num: true },
    { key: 'source_version', label: '版本' },
  ];

  const table = el('table');
  table.append(
    sortableHeader(cols, (key) => {
      replaceRoute();
      state.sort = { key, dir: state.sort.key === key && state.sort.dir === -1 ? 1 : -1 };
      pushRoute();
      void renderSessions();
    }),
  );
  const sortKey = state.sort.key === 'last_ts' ? 'started_at' : state.sort.key;
  const sorted = sortRows(rows as unknown as Record<string, unknown>[], sortKey, state.sort.dir);
  const tbody = el('tbody');
  for (const raw of sorted) {
    const r = raw as unknown as SessionRow;
    const tr = el('tr');
    tr.append(el('td', { class: 'num' }, new Date(r.started_at).toLocaleString()));
    tr.append(el('td', {}, el('span', { class: `actor ${r.actor}` }, r.actor)));
    const link = el('a', { title: r.external_id }, r.title || shortPath(r.project_path) || '(无标题)');
    link.onclick = () => void openSessionDetail(r.id);
    tr.append(el('td', { class: 'path' }, link));
    tr.append(el('td', { class: 'num' }, num(r.events)));
    tr.append(el('td', { class: 'num' }, num(r.commands)));
    tr.append(el('td', { class: 'num' }, r.failed ? el('span', { class: 'tag err' }, num(r.failed)) : '—'));
    tr.append(el('td', { class: 'num' }, compact(r.tokens_out)));
    tr.append(el('td', {}, el('span', { class: 'tag' }, r.source_version ?? '—')));
    tbody.append(tr);
  }
  table.append(tbody);
  main.replaceChildren(el('div', { class: 'wrap' }, table));
}

/* ---------------- 会话详情与文件溯源 ---------------- */

async function openSessionDetail(id: string): Promise<void> {
  try {
    const data = await api<{ session: SessionRow; events: TimelineRow[]; files: FileRow[] }>(`/api/sessions/${encodeURIComponent(id)}`);
    const overlay = el('div', { class: 'drawer-overlay' });
    const drawer = el('aside', { class: 'drawer' });
    const close = el('button', { class: 'btn' }, '关闭');
    close.onclick = () => overlay.remove();
    const summary = el('div', { class: 'detail-summary' },
      el('span', { class: `actor ${data.session.actor}` }, data.session.actor),
      el('strong', {}, data.session.title || shortPath(data.session.project_path) || '未命名会话'),
      el('span', { class: 'proj' }, data.session.project_path),
      el('span', { class: 'tag' }, `${num(data.session.events)} 事件`),
      el('span', { class: 'tag' }, `${num(data.session.commands)} 命令`),
      el('span', { class: data.session.failed ? 'tag err' : 'tag ok' }, data.session.failed ? `${data.session.failed} 失败` : '无失败'),
      el('span', { class: 'tag' }, `↓${compact(data.session.tokens_out)}`),
    );
    const timelineButton = el('button', { class: 'btn' }, '在时间轴打开');
    timelineButton.onclick = () => { overlay.remove(); replaceRoute(); state.sessionId = id; switchView('timeline'); };
    const head = el('div', { class: 'drawer-head' }, summary, el('div', { class: 'grow' }), timelineButton, close);
    const fileList = el('div', { class: 'detail-files' }, el('h3', {}, `改动文件 · ${data.files.length}`));
    for (const file of data.files) {
      const row = el('button', { class: 'file-link', title: file.file_path }, `${shortPath(file.file_path)} · ${file.events} 次`);
      row.onclick = () => { overlay.remove(); replaceRoute(); state.filePath = file.file_path; state.sessionId = ''; switchView('timeline'); };
      fileList.append(row);
    }
    const tree = el('div', { class: 'detail-files' }, el('h3', {}, '调用树（主会话 / 子调用）'));
    const byParent = new Map<string, TimelineRow[]>();
    for (const item of data.events) if (item.parent_uuid) byParent.set(item.parent_uuid, [...(byParent.get(item.parent_uuid) ?? []), item]);
    const roots = data.events.filter((item) => !item.parent_uuid || !data.events.some((candidate) => candidate.external_uuid === item.parent_uuid));
    const addTree = (item: TimelineRow, depth = 0) => {
      const label = item.command ?? item.file_path ?? item.text ?? item.kind;
      tree.append(el('button', { class: 'file-link', style: `margin-left:${Math.min(depth, 5) * 14}px` }, `${KIND_ICON[item.kind] ?? '·'} ${label.slice(0, 72)}`));
      for (const child of byParent.get(item.external_uuid ?? '') ?? []) addTree(child, depth + 1);
    };
    for (const root of roots.slice(0, 80)) addTree(root);
    const feed = el('div', { class: 'detail-events' });
    for (const item of data.events) feed.append(eventRow(item));
    drawer.append(head, fileList, tree, feed); overlay.append(drawer); document.body.append(overlay);
  } catch (error) { toast(`无法打开会话详情：${error}`); }
}

async function renderFiles(): Promise<void> {
  const main = document.getElementById('main')!;
  const p = new URLSearchParams({ limit: '500' });
  if (state.project) p.set('project', state.project);
  if (state.q) p.set('q', state.q);
  const data = await api<{ rows: FileRow[] }>(`/api/files?${p}`);
  if (!data.rows.length) { main.replaceChildren(el('div', { class: 'empty' }, '没有匹配的文件改动。')); return; }
  const table = el('table');
  table.append(sortableHeader([
    { key: 'file_path', label: '文件' }, { key: 'actors', label: '操作者' }, { key: 'events', label: '改动', num: true }, { key: 'last_ts', label: '最近改动', num: true }, { key: '_actions', label: '' },
  ], (key) => { replaceRoute(); state.sort = { key, dir: state.sort.key === key && state.sort.dir === -1 ? 1 : -1 }; pushRoute(); void renderFiles(); }));
  const body = el('tbody');
  const rows = sortRows(data.rows as unknown as Record<string, unknown>[], state.sort.key, state.sort.dir) as unknown as FileRow[];
  for (const file of rows) {
    const tr = el('tr');
    const link = el('a', { title: file.file_path }, file.file_path);
    link.onclick = () => { replaceRoute(); state.filePath = file.file_path; state.q = ''; switchView('timeline'); };
    tr.append(el('td', { class: 'path' }, link));
    const actors = el('td'); for (const actor of file.actors.split(',').filter(Boolean)) actors.append(el('span', { class: `actor ${actor}` }, `${actor} `));
    const action = el('td');
    if (state.project) {
      const diff = el('button', { class: 'event-action' }, 'Diff');
      diff.onclick = () => void openGitDiff(state.project, file.file_path);
      action.append(diff);
    }
    tr.append(actors, el('td', { class: 'num' }, num(file.events)), el('td', { class: 'num' }, new Date(file.last_ts).toLocaleString()), action);
    body.append(tr);
  }
  table.append(body); main.replaceChildren(el('div', { class: 'wrap' }, table));
}

async function openGitDiff(project: string, file: string): Promise<void> {
  try {
    const p = new URLSearchParams({ project, file });
    const data = await api<{ diff: string; available: boolean; error?: string }>(`/api/git/diff?${p}`);
    const overlay = el('div', { class: 'drawer-overlay' });
    const drawer = el('aside', { class: 'drawer' });
    const close = el('button', { class: 'btn' }, '关闭'); close.onclick = () => overlay.remove();
    drawer.append(el('div', { class: 'drawer-head' }, el('strong', {}, `Git Diff · ${shortPath(file)}`), el('div', { class: 'grow' }), close),
      el('pre', { class: 'diff-view' }, data.available ? (data.diff || '当前工作区没有未提交差异。') : `无法读取 Git diff：${data.error ?? '未知错误'}`));
    overlay.append(drawer); document.body.append(overlay);
  } catch (error) { toast(`无法读取 Git diff：${error}`); }
}

/* ---------------- 状态墙 ---------------- */

const agents = new Map<string, AgentStatus>();
let hookInfo: HookInfo | null = null;
let live: EventSource | null = null;
let notifyEnabled = false;

const STATE_LABEL: Record<AgentState, string> = {
  running: '运行中',
  waiting: '等待你',
  idle: '空闲',
  error: '出错',
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function agentCard(a: AgentStatus): HTMLElement {
  const card = el('div', { class: `agent ${a.state}` });

  const top = el('div', { class: 'top' });
  top.append(el('span', { class: 'pulse' }));
  top.append(el('span', { class: `actor ${a.actor}` }, a.actor));
  top.append(el('span', { class: 'state' }, STATE_LABEL[a.state]));
  top.append(el('div', { class: 'grow' }));
  // hook 是上报的事实，watch 只是从文件写入时间倒推，UI 必须让人看出区别
  top.append(
    el('span', { class: 'tag', title: a.source === 'hook' ? 'Claude hook 实时上报' : '由文件写入活动推断' },
      a.source === 'hook' ? 'hook' : 'watch'),
  );
  card.append(top);

  card.append(el('div', { class: 'detail' }, a.detail ?? '—'));

  const foot = el('div', { class: 'foot' });
  const p = el('span', { class: 'path', title: a.project }, shortPath(a.project) || '(未知项目)');
  p.style.cursor = 'pointer';
  p.onclick = () => {
    replaceRoute();
    state.project = a.project;
    switchView('timeline');
  };
  foot.append(p);
  foot.append(el('div', { class: 'grow' }));
  if (a.toolCalls) foot.append(el('span', {}, `${a.toolCalls} 次调用`));
  foot.append(el('span', { title: new Date(a.since).toLocaleString() }, `${ago(a.since)} 前`));

  const open = el('a', {}, '查看');
  open.onclick = () => {
    replaceRoute();
    state.sessionId = `${a.actor}:${a.sessionId}`;
    switchView('timeline');
  };
  open.style.cursor = 'pointer';
  open.style.color = 'var(--accent)';
  foot.append(open);
  card.append(foot);

  return card;
}

function renderLive(): void {
  const main = document.getElementById('main')!;
  const parts: Node[] = [];

  if (stats) {
    const enabled = stats.daemon.adapters;
    const known = stats.daemon.availableAdapters ?? enabled;
    const banner = el('div', { class: 'banner' }, el('span', {}, 'Adapter：'));
    for (const id of known) banner.append(el('span', { class: `tag ${enabled.includes(id) ? 'ok' : ''}` }, `${id} ${enabled.includes(id) ? '已监听' : '未检测到数据目录'}`));
    parts.push(banner);
  }

  if (hookInfo && hookInfo.installed.length === 0) {
    const banner = el('div', { class: 'banner' });
    banner.append(
      el('span', {}, '未安装 Claude Code hook——现在的状态是从文件写入活动倒推的，秒级且看不出「等待你批准」。'),
    );
    banner.append(el('code', {}, 'npm run hooks:install'));
    banner.append(el('span', { class: 'proj' }, '装完重启 Claude Code 即为毫秒级'));
    parts.push(banner);
  }

  if ('Notification' in window && Notification.permission === 'default') {
    const b = el('div', { class: 'banner' });
    b.append(el('span', {}, 'agent 等待你输入或本轮结束时发浏览器通知？'));
    const btn = el('button', { class: 'btn' }, '开启通知');
    btn.onclick = async () => {
      try {
        notifyEnabled = (await Notification.requestPermission()) === 'granted';
        if (!notifyEnabled) toast('浏览器未授予通知权限');
      } catch {
        notifyEnabled = false;
        toast('无法请求浏览器通知权限');
      }
      renderLive();
    };
    b.append(btn);
    parts.push(b);
  }

  if ('Notification' in window && Notification.permission === 'denied') {
    parts.push(el('div', { class: 'banner' }, '浏览器通知已被禁止；请在站点权限中允许通知后重新打开此页。'));
  }

  if (notifyEnabled) {
    const b = el('div', { class: 'banner' }, el('span', {}, '浏览器通知已开启。'));
    const btn = el('button', { class: 'btn' }, '发送测试通知');
    btn.onclick = () => {
      const sent = sendBrowserNotification('thousandEyes 通知测试', '浏览器通知工作正常。', `thousandEyes-test-${Date.now()}`);
      if (sent) toast('测试通知已触发');
    };
    b.append(btn);
    parts.push(b);
  }

  const rows = [...agents.values()].sort((a, b) => {
    const rank = (s: AgentState) => (s === 'waiting' ? 0 : s === 'error' ? 1 : s === 'running' ? 2 : 3);
    return rank(a.state) - rank(b.state) || b.lastEventAt - a.lastEventAt;
  });

  if (!rows.length) {
    parts.push(
      el(
        'div',
        { class: 'empty' },
        '当前没有活跃的 agent 会话。开一个 Claude Code 或 Codex，这里会立刻出现。',
      ),
    );
  } else {
    const wall = el('div', { class: 'wall' });
    for (const a of rows) wall.append(agentCard(a));
    parts.push(wall);
  }

  main.replaceChildren(...parts);
}

function updateLiveDot(): void {
  const dot = document.getElementById('livedot')!;
  const rows = [...agents.values()];
  const waiting = rows.some((a) => a.state === 'waiting');
  const running = rows.some((a) => a.state === 'running');
  dot.className = waiting ? 'wait' : running ? 'on' : '';
  dot.title = waiting ? '有 agent 在等你' : running ? '有 agent 在运行' : '';
}

function notifyTransition(a: AgentStatus, prev?: AgentState): void {
  if (!notifyEnabled) return;
  const waiting = a.state === 'waiting' && prev !== 'waiting';
  // hook 的 Stop 是确定的“本轮结束”；watch 的 idle 只是无写入推断，不能冒充完成。
  const completed = a.state === 'idle' && prev === 'running' && a.source === 'hook' && a.detail === '本轮结束';
  if (!waiting && !completed) return;
  sendBrowserNotification(
    waiting ? `${a.actor} 在等你` : `${a.actor} 已完成本轮`,
    `${a.detail ?? ''}\n${shortPath(a.project)}`.trim(),
    a.key,
  );
}

function sendBrowserNotification(title: string, body: string, tag: string): boolean {
  if (!('Notification' in window)) {
    toast('当前浏览器不支持系统通知');
    return false;
  }
  if (Notification.permission !== 'granted') {
    notifyEnabled = false;
    toast('浏览器通知权限未开启；请刷新页面后重新授权');
    if (state.view === 'live') renderLive();
    return false;
  }
  try {
    const options: NotificationOptions & { renotify?: boolean } = {
      body,
      tag,
      // 同一个 agent 再次进入等待状态时也应重新提示，不能只静默替换旧通知。
      renotify: true,
      // 浏览器支持时保持横幅，避免测试通知在用户看到前就自动消失。
      requireInteraction: true,
    };
    const notification = new Notification(title, options);
    notification.onerror = () => toast('浏览器未能显示通知；请检查系统的通知设置');
    return true;
  } catch {
    toast('浏览器未能显示通知；请检查系统的通知设置');
    return false;
  }
}

/** `?live=0` 关闭实时推送，退回轮询式的手动刷新——看板嵌入和截图调试都用得上。 */
function liveEnabled(): boolean {
  return new URLSearchParams(location.search).get('live') !== '0';
}

function connectLive(): void {
  if (!liveEnabled()) return;
  live?.close();
  live = new EventSource('/api/live');

  const apply = (a: AgentStatus) => {
    agents.set(a.key, a);
    updateLiveDot();
    if (state.view === 'live') renderLive();
  };

  live.addEventListener('snapshot', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { rows: AgentStatus[] };
    agents.clear();
    for (const a of d.rows) agents.set(a.key, a);
    updateLiveDot();
    if (state.view === 'live') renderLive();
  });
  live.addEventListener('change', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { status: AgentStatus; prev?: AgentState };
    notifyTransition(d.status, d.prev);
    apply(d.status);
  });
  live.addEventListener('tick', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { status: AgentStatus };
    agents.set(d.status.key, d.status);
    updateLiveDot();
  });
  live.addEventListener('remove', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { key: string };
    agents.delete(d.key);
    updateLiveDot();
    if (state.view === 'live') renderLive();
  });
  // EventSource 自带重连，出错交给它，不自己造轮子
}

async function loadAgents(): Promise<void> {
  const d = await api<{ rows: AgentStatus[]; hooks: HookInfo }>('/api/agents');
  agents.clear();
  for (const a of d.rows) agents.set(a.key, a);
  hookInfo = d.hooks;
  updateLiveDot();
  renderLive();
}

/* ---------------- 终端网格（Phase 2） ---------------- */

const terminals = new Map<string, TerminalMeta>();
const terminalViews = new Map<string, { term: XTerm; fit: FitAddon; host: HTMLElement; observer: ResizeObserver }>();
let terminalSocket: WebSocket | null = null;
let workspaceRows: WorkspaceRow[] = [];
let selectedWorkspace = '';
let terminalFocusId: string | undefined;
const terminalLayout: { columns: number; order: string[]; primaryRatio: number } = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('thousandEyes.terminalLayout') ?? '{}') as { columns?: number; order?: string[]; primaryRatio?: number };
    return { columns: [1, 2, 3].includes(saved.columns ?? 2) ? saved.columns ?? 2 : 2, order: Array.isArray(saved.order) ? saved.order : [], primaryRatio: [0.33, 0.5, 0.67].includes(saved.primaryRatio ?? 0.5) ? saved.primaryRatio ?? 0.5 : 0.5 };
  } catch { return { columns: 2, order: [], primaryRatio: 0.5 }; }
})();

function persistTerminalLayout(): void {
  localStorage.setItem('thousandEyes.terminalLayout', JSON.stringify(terminalLayout));
  if (state.view === 'terminals') renderTerminals();
}

function wsUrl(): string {
  const url = new URL('/api/terminal/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 首次打开带 token 时 cookie 尚未落地，保留 query 保证 WS 也能过鉴权。
  const token = new URLSearchParams(location.search).get('token');
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function socketSend(message: unknown): void {
  if (terminalSocket?.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify(message));
}

function connectTerminalSocket(): void {
  if (terminalSocket?.readyState === WebSocket.OPEN || terminalSocket?.readyState === WebSocket.CONNECTING) return;
  const socket = new WebSocket(wsUrl());
  terminalSocket = socket;
  socket.onopen = () => {
    for (const id of terminalViews.keys()) socketSend({ type: 'subscribe', id });
  };
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data) as { type: string; data: unknown };
      if (message.type === 'snapshot') {
        terminals.clear();
        for (const meta of message.data as TerminalMeta[]) {
          if (meta.running) terminals.set(meta.id, meta);
        }
        if (state.view === 'terminals') renderTerminals();
      } else if (message.type === 'data' || message.type === 'backlog') {
        const data = message.data as { id: string; data: string };
        terminalViews.get(data.id)?.term.write(data.data);
      } else if (message.type === 'terminal') {
        const data = message.data as { action: string; meta?: TerminalMeta; id?: string };
        if (data.action === 'remove' && data.id) {
          terminals.delete(data.id);
          if (state.view === 'terminals') renderTerminals();
        } else if (data.action === 'exit' && data.id) {
          terminals.delete(data.id);
          if (state.view === 'terminals') renderTerminals();
        } else if (data.meta) {
          if (data.meta.running) terminals.set(data.meta.id, data.meta);
          else terminals.delete(data.meta.id);
          // resize / shell marker 也会触发 meta。这里如果重建 xterm，会让 fit → resize →
          // meta → 重建形成闪烁循环，并把输入焦点抢走。已有卡片只保留内存中的最新状态；
          // 新建、退出和移除才真正改变网格结构。
          if (data.action === 'spawn' || data.action === 'exit') {
            if (state.view === 'terminals') renderTerminals();
          }
        }
      }
    } catch { /* 无效消息不影响已开的终端 */ }
  };
  socket.onclose = () => {
    if (terminalSocket === socket) terminalSocket = null;
    setTimeout(() => { if (document.visibilityState === 'visible') connectTerminalSocket(); }, 1000);
  };
}

function disposeTerminalViews(): void {
  for (const [id, view] of terminalViews) {
    socketSend({ type: 'unsubscribe', id });
    view.observer.disconnect();
    view.term.dispose();
  }
  terminalViews.clear();
}

function mountTerminal(meta: TerminalMeta): HTMLElement {
  const card = el('section', { class: `terminal-card${meta.running ? '' : ' exited'}`, draggable: 'true', 'data-terminal-id': meta.id });
  card.ondragstart = (event) => event.dataTransfer?.setData('text/plain', meta.id);
  card.ondragover = (event) => event.preventDefault();
  card.ondrop = (event) => {
    event.preventDefault();
    const from = event.dataTransfer?.getData('text/plain');
    if (!from || from === meta.id) return;
    const order = terminalLayout.order.filter((id) => id !== from);
    const target = order.indexOf(meta.id);
    order.splice(target < 0 ? order.length : target, 0, from);
    terminalLayout.order = order;
    persistTerminalLayout();
  };
  const title = el('span', { class: 'terminal-title', title: meta.cwd }, meta.title);
  const head = el('div', { class: 'terminal-head' }, title, el('span', { class: 'proj' }, shortPath(meta.cwd)));
  head.append(el('div', { class: 'grow' }));
  if (meta.integrated) head.append(el('span', { class: 'tag ok' }, '记录中'));
  else head.append(el('span', { class: 'tag' }, '无 shell 集成'));
  const rename = el('button', { class: 'terminal-action', title: '修改终端名称' }, '命名');
  rename.onclick = () => void renameTerminal(meta.id);
  head.append(rename);
  const clone = el('button', { class: 'terminal-action', title: '克隆终端' }, '复制');
  clone.onclick = () => void cloneTerminal(meta.id);
  head.append(clone);
  const cwd = el('button', { class: 'terminal-action', title: '复制当前工作目录' }, 'cwd');
  cwd.onclick = async () => {
    try { await navigator.clipboard.writeText(meta.cwd); toast('已复制 cwd'); } catch { toast(meta.cwd); }
  };
  head.append(cwd);
  if (meta.lastCommand) {
    const rerun = el('button', { class: 'terminal-action', title: '在新终端运行最近命令' }, '重跑');
    rerun.onclick = () => {
      if (window.confirm(`在新终端运行？\n\n${meta.lastCommand}`)) void createTerminal(meta.lastCommand, meta.cwd);
    };
    head.append(rerun);
  }
  if (meta.castFile) {
    const replay = el('button', { class: 'terminal-action', title: '回放本终端录像' }, '录像');
    replay.onclick = () => void openReplay(meta.castFile!);
    head.append(replay);
  }
  const close = el('button', { class: 'terminal-action danger', title: '结束终端' }, '结束');
  close.onclick = () => void killTerminal(meta.id);
  head.append(close);
  card.append(head);

  const host = el('div', { class: 'terminal-host' });
  card.append(host);
  if (!meta.running) host.append(el('div', { class: 'terminal-exit' }, `进程已退出（${meta.exitCode ?? '—'}）`));
  const term = new XTerm({ cursorBlink: true, fontFamily: 'var(--mono)', fontSize: 12, theme: { background: '#0d1117' }, scrollback: 10_000 });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  host.onclick = () => term.focus();
  term.onData((data) => {
    // 浏览器 xterm 会把 DSR/OSC 颜色查询的自动回复也放进 onData。
    // 它们经 WebSocket 往返已错过 zsh prompt theme 的同步等待窗口，只会被回显为乱码；
    // 过滤这两类安全的查询回复，真实键盘 ESC 序列（方向键、vim 等）仍会透传。
    if (/^\x1b\[\??[0-9;]*R$/.test(data) || /^\x1b\]1[01];(?:rgb:|#)/.test(data)) return;
    socketSend({ type: 'input', id: meta.id, data });
  });
  const resize = () => {
    try {
      fit.fit();
      socketSend({ type: 'resize', id: meta.id, cols: term.cols, rows: term.rows });
    } catch { /* 容器暂时不可见 */ }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  terminalViews.set(meta.id, { term, fit, host, observer });
  socketSend({ type: 'subscribe', id: meta.id });
  requestAnimationFrame(() => {
    resize();
    if (terminalFocusId === meta.id) {
      term.focus();
      terminalFocusId = undefined;
    }
  });
  return card;
}

function renderTerminals(): void {
  disposeTerminalViews();
  const main = document.getElementById('main')!;
  const natural = [...terminals.values()]
    .filter((meta) => meta.running)
    .sort((a, b) => b.createdAt - a.createdAt);
  const known = new Set(natural.map((item) => item.id));
  terminalLayout.order = [...terminalLayout.order.filter((id) => known.has(id)), ...natural.map((item) => item.id).filter((id) => !terminalLayout.order.includes(id))];
  const rows = terminalLayout.order.map((id) => terminals.get(id)).filter((item): item is TerminalMeta => Boolean(item));
  if (!rows.length) {
    const add = el('button', { class: 'btn' }, '打开第一个终端');
    add.onclick = () => void createTerminal();
    main.replaceChildren(el('div', { class: 'empty' }, '还没有由 thousandEyes 托管的终端。', el('br'), add));
    return;
  }
  const grid = el('div', { class: 'terminal-grid' });
  grid.style.setProperty('--terminal-columns', String(terminalLayout.columns));
  if (terminalLayout.columns === 2) {
    grid.style.gridTemplateColumns = `minmax(0, ${terminalLayout.primaryRatio}fr) minmax(0, ${1 - terminalLayout.primaryRatio}fr)`;
  }
  for (const meta of rows) grid.append(mountTerminal(meta));
  main.replaceChildren(grid);
}

async function createTerminal(bootCommand?: string, cwd?: string): Promise<void> {
  const targetCwd = cwd ?? (state.project || undefined);
  const meta = await api<TerminalMeta>('/api/terminals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: targetCwd, bootCommand }) });
  terminals.set(meta.id, meta);
  terminalFocusId = meta.id;
  if (state.view === 'terminals') renderTerminals();
  else switchView('terminals');
}
async function cloneTerminal(id: string): Promise<void> {
  const meta = await api<TerminalMeta>(`/api/terminals/${encodeURIComponent(id)}/clone`, { method: 'POST' });
  terminals.set(meta.id, meta);
  terminalFocusId = meta.id;
  renderTerminals();
}
async function killTerminal(id: string): Promise<void> {
  await api(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function renameTerminal(id: string): Promise<void> {
  const current = terminals.get(id);
  const title = window.prompt('终端名称', current?.title ?? '');
  if (!title?.trim()) return;
  try {
    const meta = await api<TerminalMeta>(`/api/terminals/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.trim() }),
    });
    terminals.set(meta.id, meta);
    renderTerminals();
  } catch (error) { toast(`重命名失败：${error}`); }
}

async function loadWorkspaces(): Promise<void> {
  const data = await api<{ rows: WorkspaceRow[] }>('/api/workspaces');
  workspaceRows = data.rows;
}

async function saveWorkspace(): Promise<void> {
  if (!terminals.size) return toast('先打开至少一个终端，再保存模板');
  const name = window.prompt('工作区名称');
  if (!name?.trim()) return;
  const panes = terminalLayout.order
    .map((id) => terminals.get(id))
    .filter((meta): meta is TerminalMeta => Boolean(meta))
    .map((meta) => ({ cwd: meta.cwd, shell: meta.shell, title: meta.title }));
  try {
    const row = await api<WorkspaceRow>('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), layout: { columns: terminalLayout.columns, primaryRatio: terminalLayout.primaryRatio }, panes }) });
    workspaceRows = [row, ...workspaceRows.filter((item) => item.id !== row.id)];
    selectedWorkspace = row.id;
    renderFilters();
    toast(`已保存“${row.name}”`);
  } catch (error) { toast(`保存失败：${error}`); }
}

async function restoreWorkspace(id: string): Promise<void> {
  if (!id) return;
  try {
    const result = await api<{ rows: TerminalMeta[]; layout?: { columns?: number; primaryRatio?: number } }>(`/api/workspaces/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    for (const meta of result.rows) terminals.set(meta.id, meta);
    if ([1, 2, 3].includes(result.layout?.columns ?? 0)) terminalLayout.columns = result.layout!.columns!;
    if ([0.33, 0.5, 0.67].includes(result.layout?.primaryRatio ?? 0)) terminalLayout.primaryRatio = result.layout!.primaryRatio!;
    terminalLayout.order = [...result.rows.map((meta) => meta.id), ...terminalLayout.order];
    persistTerminalLayout();
    toast(`已恢复 ${result.rows.length} 个终端`);
  } catch (error) { toast(`恢复失败：${error}`); }
}

async function resumeSession(sessionId: string): Promise<void> {
  try {
    const meta = await api<TerminalMeta>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, { method: 'POST' });
    terminals.set(meta.id, meta);
    toast('已在新终端中启动恢复命令');
    switchView('terminals');
  } catch (error) { toast(`无法接管会话：${error}`); }
}

/* ---------------- 命令面板 ---------------- */

interface PaletteItem {
  main: string;
  side: string;
  run: () => void;
}

let paletteItems: PaletteItem[] = [];
let paletteSel = 0;

function openPalette(): void {
  const box = document.getElementById('palette')!;
  const input = document.getElementById('palette-input') as HTMLInputElement;
  box.hidden = false;
  input.value = '';
  input.focus();
  void refreshPalette('');
}

function closePalette(): void {
  document.getElementById('palette')!.hidden = true;
}

async function refreshPalette(q: string): Promise<void> {
  const items: PaletteItem[] = [];

  // 无输入时给导航与常用动作；有输入时先给动作，再拿检索结果补齐
  const nav: [string, View][] = [
    ['状态墙', 'live'],
    ['终端', 'terminals'],
    ['时间轴', 'timeline'],
    ['项目', 'projects'],
    ['成本', 'costs'],
    ['会话', 'sessions'],
    ['文件', 'files'],
  ];
  for (const [label, v] of nav) {
    if (!q || label.includes(q)) {
      items.push({ main: `跳到 ${label}`, side: '视图', run: () => switchView(v) });
    }
  }

  for (const item of favoriteCommands) {
    const label = item.label ?? item.command.split('\n')[0] ?? item.command;
    if (!q || `${label} ${(item.tags ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase())) {
      items.push({
        main: `★ ${label}`,
        side: `收藏 · ${shortPath(item.cwd ?? '')}`,
        run: () => {
          if (window.confirm(`在新终端运行收藏命令？\n\n${item.command}`)) void createTerminal(item.command, item.cwd);
        },
      });
    }
  }

  if (q) {
    items.push({
      main: `在时间轴中搜索 "${q}"`,
      side: '全文检索',
      run: () => {
        replaceRoute();
        state.q = q;
        switchView('timeline');
      },
    });
    try {
      const d = await api<{ rows: TimelineRow[] }>(`/api/timeline?limit=18&q=${encodeURIComponent(q)}`);
      for (const r of d.rows) {
        const cmd = (r.command ?? r.file_path ?? r.text ?? '').split('\n')[0] ?? '';
        items.push({
          main: cmd,
          side: `${KIND_LABEL[r.kind] ?? r.kind} · ${r.actor} · ${shortPath(r.project_path)}`,
          run: () => {
            if (r.kind === 'command' && r.command) {
              if (window.confirm(`在新托管终端中运行这条历史命令？\n\n${r.command}`)) void createTerminal(r.command, r.cwd ?? r.project_path);
            } else if (r.file_path) {
              replaceRoute(); state.filePath = r.file_path; state.sessionId = ''; switchView('timeline');
            } else {
              replaceRoute(); state.sessionId = r.session_id; switchView('timeline');
            }
          },
        });
      }
    } catch {
      /* 检索失败不影响面板可用 */
    }
  }

  paletteItems = items;
  paletteSel = 0;
  renderPalette();
}

function renderPalette(): void {
  const list = document.getElementById('palette-list')!;
  list.replaceChildren();
  paletteItems.forEach((item, i) => {
    const row = el(
      'div',
      { class: `palette-item${i === paletteSel ? ' sel' : ''}` },
      el('span', { class: 'p-main' }, item.main),
      el('span', { class: 'p-side' }, item.side),
    );
    row.onclick = () => {
      item.run();
      closePalette();
    };
    list.append(row);
  });
}

function bindPalette(): void {
  const input = document.getElementById('palette-input') as HTMLInputElement;
  const box = document.getElementById('palette')!;

  let timer: number | undefined;
  input.oninput = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refreshPalette(input.value.trim()), 200);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') return closePalette();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1);
      renderPalette();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteSel = Math.max(paletteSel - 1, 0);
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      paletteItems[paletteSel]?.run();
      closePalette();
    }
  };
  box.onclick = (e) => {
    if (e.target === box) closePalette();
  };
}

/* ---------------- 壳 ---------------- */

function renderSummary(): void {
  const box = document.getElementById('summary')!;
  if (!stats) return;
  box.replaceChildren();
  const item = (label: string, value: string) =>
    el('span', {}, el('b', {}, value), ` ${label}`);
  box.append(item('事件', num(stats.events)));
  box.append(item('命令', num(stats.commands)));
  box.append(item('会话', num(stats.sessions)));
  box.append(item('项目', num(stats.projects)));
  if (stats.failedCommands) {
    box.append(el('span', { class: 'tag err' }, `${num(stats.failedCommands)} 失败`));
  }
}

function switchView(v: View, fromHistory = false, restoreScrollY?: number): void {
  if (!fromHistory) replaceRoute();
  if (state.view === 'terminals' && v !== 'terminals') disposeTerminalViews();
  state.view = v;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#nav button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === v));
  }
  if (!fromHistory) {
    state.sort =
      v === 'projects'
        ? { key: 'last_ts', dir: -1 }
        : v === 'sessions'
          ? { key: 'started_at', dir: -1 }
          : state.sort;
    pushRoute();
  }
  renderFilters();
  reload();
  if (restoreScrollY !== undefined) requestAnimationFrame(() => window.scrollTo({ top: restoreScrollY }));
}

function reload(): void {
  const main = document.getElementById('main')!;
  if (state.view === 'live') {
    loadAgents().catch((e) => main.replaceChildren(el('div', { class: 'empty' }, `查询失败：${e}`)));
    return;
  }
  if (state.view === 'terminals') {
    connectTerminalSocket();
    loadWorkspaces().then(() => { renderFilters(); renderTerminals(); }).catch(() => renderTerminals());
    renderTerminals();
    return;
  }
  if (state.view === 'timeline') {
    state.rows = [];
    state.cursor = undefined;
    main.replaceChildren(el('div', { class: 'loading' }, '查询中…'));
    void loadTimeline(false);
    return;
  }
  main.replaceChildren(el('div', { class: 'loading' }, '查询中…'));
  const job =
    state.view === 'projects' ? renderProjects() : state.view === 'costs' ? renderCosts() : state.view === 'files' ? renderFiles() : renderSessions();
  job.catch((e) => main.replaceChildren(el('div', { class: 'empty' }, `查询失败：${e}`)));
}

async function refreshStats(): Promise<void> {
  try {
    stats = await api<Stats>('/api/stats');
    renderSummary();
  } catch {
    /* 顶栏统计失败不影响主视图 */
  }
}

function bindShell(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#nav button')) {
    b.onclick = () => switchView(b.dataset.view as View);
  }
  const rescan = document.getElementById('rescan') as HTMLButtonElement;
  const back = document.getElementById('history-back') as HTMLButtonElement;
  const forward = document.getElementById('history-forward') as HTMLButtonElement;
  back.onclick = () => history.back();
  forward.onclick = () => history.forward();
  rescan.onclick = async () => {
    rescan.disabled = true;
    rescan.textContent = '扫描中…';
    try {
      const r = await api<{ files: number; events: number; ms: number }>('/api/rescan', { method: 'POST' });
      toast(`重扫完成：${r.files} 个文件，新增 ${r.events} 条事件，用时 ${r.ms}ms`);
      await refreshStats();
      facets = await api<Facets>('/api/facets');
      renderFilters();
      reload();
    } catch (e) {
      toast(`重扫失败：${e}`);
    } finally {
      rescan.disabled = false;
      rescan.textContent = '重扫';
    }
  };

  // 滚到底自动加载下一页
  window.addEventListener('scroll', () => {
    if (state.view !== 'timeline' || !state.cursor || state.loading) return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 400) loadMore();
  });

  bindPalette();

  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      history.back();
      return;
    }
    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      history.forward();
      return;
    }
    // ⌘K / Ctrl-K 唤出命令面板
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const box = document.getElementById('palette')!;
      if (box.hidden) openPalette();
      else closePalette();
      return;
    }
    if (e.key === 'Escape') {
      closePalette();
      return;
    }
    // / 聚焦当前视图的搜索框
    if (e.key === '/' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      document.querySelector<HTMLInputElement>('input[type=search]')?.focus();
    }
  });
}

async function main(): Promise<void> {
  bindShell();
  try {
    facets = await api<Facets>('/api/facets');
  } catch (e) {
    document.getElementById('main')!.replaceChildren(
      el('div', { class: 'empty' }, `无法连接 daemon：${e}`),
    );
    return;
  }
  await refreshStats();

  notifyEnabled = 'Notification' in window && Notification.permission === 'granted';
  try {
    const d = await api<{ rows: AgentStatus[]; hooks: HookInfo }>('/api/agents');
    for (const a of d.rows) agents.set(a.key, a);
    hookInfo = d.hooks;
    updateLiveDot();
  } catch {
    /* 状态墙拿不到不影响其它视图 */
  }
  connectLive();

  // 通知由 SSE 状态变更触发；页面退到后台时也必须保持连接。
  // EventSource 会自行重连，不能因页面隐藏而主动关闭它。

  const fromHash = location.hash.slice(1) as View;
  const known: View[] = ['live', 'terminals', 'timeline', 'projects', 'costs', 'sessions', 'files'];
  const existingRoute = isRouteState(history.state) ? history.state : undefined;
  if (existingRoute) {
    historyPosition = existingRoute.position;
    highestHistoryPosition = Math.max(
      historyPosition,
      Number(sessionStorage.getItem(`thousandEyes.historyMax:${location.pathname}`) ?? 0),
    );
    applyRoute(existingRoute.route);
    switchView(existingRoute.route.view, true, existingRoute.route.scrollY);
  } else if (known.includes(fromHash)) {
    state.view = fromHash;
    replaceRoute();
    switchView(fromHash, true);
  }
  else {
    replaceRoute();
    renderFilters();
    reload();
  }

  window.addEventListener('popstate', (event) => {
    if (!isRouteState(event.state)) return;
    const route = event.state.route;
    if (state.view === 'terminals' && route.view !== 'terminals') disposeTerminalViews();
    historyPosition = event.state.position;
    highestHistoryPosition = Math.max(highestHistoryPosition, historyPosition);
    applyRoute(route);
    updateHistoryControls();
    switchView(route.view, true, route.scrollY);
  });

  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1) as View;
    if (known.includes(v) && v !== state.view) {
      switchView(v, true);
      replaceRoute();
    }
  });

  setInterval(refreshStats, 15000);
}

void main();
