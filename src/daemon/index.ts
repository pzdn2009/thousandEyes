#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { HOST, PORT } from './config.js';
import { closeDb, dataDir, openDb } from './db/index.js';
import { stats } from './db/queries.js';
import { ALL_ADAPTERS, enabledAdapters } from './adapters/registry.js';
import { Ingestor } from './ingest/pipeline.js';
import { scanAll } from './ingest/scanner.js';
import { TranscriptWatcher } from './ingest/watcher.js';
import { loadRedactConfig } from './redact.js';
import { createServer } from './server/http.js';
import { LiveTracker } from './live/tracker.js';
import { HookServer } from './live/hookServer.js';
import { hookStatus, installHooks, uninstallHooks } from './live/install.js';
import { ensureToken } from './server/auth.js';
import { PtyManager } from './pty/manager.js';
import { attachTerminalSocket } from './pty/socket.js';
import { enforceCastRetention } from './pty/retention.js';

/**
 * thousandEyes daemon。
 *
 *   te scan            全量扫描一次并退出
 *   te stats           打印索引概况
 *   te serve           扫描 + 监听 + hook 接收 + Web UI（默认）
 *   te hooks <子命令>   status / install / uninstall —— Claude Code 实时 hook
 */

const startedAt = Date.now();

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

async function boot() {
  dataDir();
  loadRedactConfig();
  const db = openDb();
  const adapters = await enabledAdapters();
  if (!adapters.length) {
    console.error('未检测到任何 agent CLI 的数据目录（~/.claude/projects、~/.codex/sessions）。');
  }
  const ingestor = new Ingestor(db, adapters);
  return { db, adapters, ingestor };
}

async function cmdScan() {
  const { db, adapters, ingestor } = await boot();
  process.stdout.write('扫描中…');
  const s = scanAll(ingestor, adapters, (done) => {
    if (done % 25 === 0) process.stdout.write('.');
  });
  process.stdout.write('\n');
  console.log(
    `扫描完成：${fmt(s.files)} 个文件 / ${fmt(s.lines)} 行 / 新增 ${fmt(s.events)} 事件 / 回填 ${fmt(s.patched)} 条结果，用时 ${fmt(s.ms)}ms`,
  );
  const st = stats(db);
  console.log(`索引现状：${fmt(st.sessions)} sessions · ${fmt(st.events)} events · ${fmt(st.projects)} 个项目`);
  closeDb();
}

async function cmdStats() {
  const { db } = await boot();
  const st = stats(db);
  console.log(`sessions      ${fmt(st.sessions)}`);
  console.log(`events        ${fmt(st.events)}`);
  console.log(`  commands    ${fmt(st.commands)}（失败 ${fmt(st.failedCommands)}）`);
  console.log(`  file_edits  ${fmt(st.fileEdits)}`);
  console.log(`projects      ${fmt(st.projects)}`);
  console.log(`db size       ${(st.dbBytes / 1024 / 1024).toFixed(1)} MB`);
  for (const a of st.byActor) {
    console.log(`  ${a.actor.padEnd(8)} ${fmt(a.sessions)} sessions · ${fmt(a.events)} events`);
  }
  if (st.firstTs && st.lastTs) {
    console.log(
      `时间跨度      ${new Date(st.firstTs).toLocaleDateString()} → ${new Date(st.lastTs).toLocaleDateString()}`,
    );
  }
  closeDb();
}

async function cmdServe() {
  const { db, adapters, ingestor } = await boot();
  enforceCastRetention();

  process.stdout.write('首次索引…');
  const initial = scanAll(ingestor, adapters, (done) => {
    if (done % 25 === 0) process.stdout.write('.');
  });
  process.stdout.write('\n');
  console.log(
    `索引完成：${fmt(initial.files)} 个文件 / 新增 ${fmt(initial.events)} 事件，用时 ${fmt(initial.ms)}ms`,
  );

  const tracker = new LiveTracker();
  tracker.start();
  const hookServer = new HookServer(tracker);
  hookServer.start();

  let watchIngested = 0;
  const watcher = new TranscriptWatcher(ingestor, adapters, {
    onIngested: (r) => {
      watchIngested += r.eventsInserted;
      for (const t of r.touched.values()) {
        tracker.onWatchActivity({
          actor: t.actor,
          sessionId: t.sessionRef,
          project: t.project,
          detail: t.detail,
        });
      }
    },
  });
  watcher.start();
  const terminals = new PtyManager(db);

  const { server, url } = createServer({
    db,
    tracker,
    hookStatus,
    terminals,
    rescan: async () => {
      const s = scanAll(ingestor, adapters);
      return { files: s.files, events: s.events, ms: s.ms };
    },
    info: () => ({
      adapters: adapters.map((a) => a.id),
      availableAdapters: ALL_ADAPTERS.map((a) => a.id),
      uptimeMs: Date.now() - startedAt,
      watchIngested,
      pid: process.pid,
    }),
  });
  const closeTerminalSocket = attachTerminalSocket(server, terminals, ensureToken());

  server.listen(PORT, HOST, () => {
    const hs = hookStatus();
    console.log(`\n  thousandEyes 已启动`);
    console.log(`  ${url}\n`);
    console.log(`  监听中：${adapters.map((a) => a.id).join(', ')}`);
    if (hs.installed.length) {
      console.log(`  Claude hook：已装 ${hs.installed.length}/${hs.installed.length + hs.missing.length} 个事件`);
    } else {
      console.log(`  Claude hook：未安装（运行 \`te hooks install\` 开启毫秒级状态墙）`);
    }
  });

  const shutdown = async () => {
    console.log('\n正在关闭…');
    await watcher.stop();
    hookServer.stop();
    tracker.stop();
    closeTerminalSocket();
    terminals.shutdown();
    server.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * 打开 Web UI。
 *
 * 网页无法注册操作系统级全局热键，所以「全局热键唤出」这一步要落在 OS 层：
 * 把这条命令绑到 Raycast / Alfred / skhd / macOS 快捷指令上即可。
 * 页内的 ⌘K 命令面板负责窗口已经打开之后的部分。
 */
async function cmdOpen() {
  const token = ensureToken();
  const url = `http://${HOST}:${PORT}/?token=${token}#${process.argv[3] ?? 'live'}`;

  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/health`);
    if (!res.ok) throw new Error('unhealthy');
  } catch {
    console.error(`daemon 未在 ${HOST}:${PORT} 运行，先执行 \`te serve\`。`);
    process.exit(1);
  }

  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  console.log(url);
}

async function cmdHooks() {
  const sub = process.argv[3] ?? 'status';

  if (sub === 'status') {
    const s = hookStatus();
    console.log(`配置文件：${s.settingsFile}`);
    console.log(`已安装：${s.installed.length ? s.installed.join(', ') : '无'}`);
    console.log(`未安装：${s.missing.length ? s.missing.join(', ') : '无'}`);
    return;
  }

  if (sub === 'install') {
    const r = installHooks();
    console.log(`已写入 ${r.settingsFile}`);
    if (r.backupFile) console.log(`原文件已备份到 ${r.backupFile}`);
    if (r.removed) console.log(`替换了 ${r.removed} 条旧的 thousandEyes hook`);
    console.log(`注册事件：${r.events.join(', ')}`);
    console.log(`\n只增删带 "# thousandEyes" 标记的条目，你自己的 hook 不受影响。`);
    console.log(`重启 Claude Code 后生效；撤销执行 \`te hooks uninstall\`。`);
    return;
  }

  if (sub === 'uninstall') {
    const r = uninstallHooks();
    console.log(`已从 ${r.settingsFile} 移除 ${r.removed} 条 hook`);
    if (r.backupFile) console.log(`原文件已备份到 ${r.backupFile}`);
    return;
  }

  console.error(`未知子命令：${sub}\n可用：status / install / uninstall`);
  process.exit(1);
}

const cmd = process.argv[2] ?? 'serve';
const commands: Record<string, () => Promise<void>> = {
  scan: cmdScan,
  stats: cmdStats,
  serve: cmdServe,
  hooks: cmdHooks,
  open: cmdOpen,
};

const run = commands[cmd];
if (!run) {
  console.error(`未知命令：${cmd}\n可用：${Object.keys(commands).join(' / ')}`);
  process.exit(1);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
