import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_HOME, DATA_DIR } from '../config.js';

/**
 * Claude Code hook 安装器。spec.md §7 Phase 1。
 *
 * 这是 thousandEyes 唯一会写入用户配置的操作，所以：
 *  - 每次改动前先备份到 ~/.thousandEyes/backups/
 *  - 只增删带 MARKER 的条目，用户自己的 hook 一律原样保留
 *  - 原子写入（先写临时文件再 rename），避免写一半把 settings.json 弄坏
 */

const MARKER = '# thousandEyes';

/**
 * 注册哪些事件是个取舍：每个 hook 触发都会 spawn 一个 node 进程（约几十毫秒）。
 * PostToolUse 与 SubagentStop 对状态墙没有额外信息量，却会让每次工具调用多一次 spawn，
 * 因此不注册。PreToolUse 提供「正在执行什么」，Stop 提供「结束了」，已经够用。
 */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'] as const;

/** 需要 matcher 字段的事件（工具类 hook）。 */
const NEEDS_MATCHER = new Set(['PreToolUse', 'PostToolUse']);

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type HookMap = Record<string, HookGroup[]>;

export function hookClientPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 源码运行 src/daemon/live/ 与打包后 dist/daemon/ 层级不同，逐级向上找
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'bin', 'te-hook.mjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(here, '../../../bin/te-hook.mjs');
}

function settingsPath(): string {
  return path.join(CLAUDE_HOME, 'settings.json');
}

function readSettings(file: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function backup(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `settings.json.${Date.now()}`);
  fs.copyFileSync(file, dest);
  return dest;
}

function writeAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.te-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function isOurs(entry: HookEntry): boolean {
  return typeof entry?.command === 'string' && entry.command.includes(MARKER);
}

/** 剥掉所有属于我们的 hook 条目，返回清理后的 hook 表。 */
function stripOurs(hooks: HookMap): { hooks: HookMap; removed: number } {
  let removed = 0;
  const out: HookMap = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups: HookGroup[] = [];
    for (const g of groups) {
      const inner = Array.isArray(g?.hooks) ? g.hooks : [];
      const kept = inner.filter((h) => {
        if (isOurs(h)) {
          removed++;
          return false;
        }
        return true;
      });
      if (kept.length) keptGroups.push({ ...g, hooks: kept });
    }
    if (keptGroups.length) out[event] = keptGroups;
  }
  return { hooks: out, removed };
}

export interface InstallResult {
  settingsFile: string;
  backupFile?: string;
  events: string[];
  command: string;
  removed: number;
}

export function installHooks(): InstallResult {
  const file = settingsPath();
  const client = hookClientPath();
  if (!fs.existsSync(client)) {
    throw new Error(`找不到 hook 客户端脚本：${client}`);
  }

  const settings = readSettings(file);
  const backupFile = backup(file);
  const existing = (settings.hooks ?? {}) as HookMap;
  const { hooks, removed } = stripOurs(existing);

  for (const event of EVENTS) {
    const command = `${process.execPath} ${JSON.stringify(client)} ${event} ${MARKER}`;
    const group: HookGroup = NEEDS_MATCHER.has(event)
      ? { matcher: '*', hooks: [{ type: 'command', command }] }
      : { hooks: [{ type: 'command', command }] };
    hooks[event] = [...(hooks[event] ?? []), group];
  }

  settings.hooks = hooks;
  writeAtomic(file, settings);

  return {
    settingsFile: file,
    backupFile,
    events: [...EVENTS],
    command: `${process.execPath} ${client} <event> ${MARKER}`,
    removed,
  };
}

export function uninstallHooks(): { settingsFile: string; backupFile?: string; removed: number } {
  const file = settingsPath();
  const settings = readSettings(file);
  const backupFile = backup(file);
  const { hooks, removed } = stripOurs((settings.hooks ?? {}) as HookMap);
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  writeAtomic(file, settings);
  return { settingsFile: file, backupFile, removed };
}

export function hookStatus(): { settingsFile: string; installed: string[]; missing: string[] } {
  const file = settingsPath();
  const settings = readSettings(file);
  const hooks = (settings.hooks ?? {}) as HookMap;
  const installed: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    if (groups.some((g) => (g?.hooks ?? []).some(isOurs))) installed.push(event);
  }
  return {
    settingsFile: file,
    installed,
    missing: EVENTS.filter((e) => !installed.includes(e)),
  };
}
