import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { DB } from '../db/index.js';
import { makeInsertEvent, upsertSession } from '../db/store.js';
import { redactText } from '../redact.js';
import { CastRecorder } from './recorder.js';
import { ShellMarkerParser } from './shellMarkers.js';
import { shellLaunch } from './shellIntegration.js';

/**
 * PTY 管理器。spec.md §7 Phase 2。
 *
 * daemon 持有所有终端进程，UI 只是它的视图——关掉浏览器不杀终端，这是终端管理器的刚需。
 */

/** 回放缓冲：新客户端接入时先补这一段，才能看到「当前屏幕」而不是空白。 */
const SCROLLBACK_BYTES = 256 * 1024;

export interface TerminalMeta {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exitedAt?: number;
  exitCode?: number;
  /** 派生自哪个终端（克隆） */
  clonedFrom?: string;
  /** 最近一条命令，供列表展示 */
  lastCommand?: string;
  running: boolean;
  /** shell 集成是否已握手（收到过 OSC 133） */
  integrated: boolean;
  castFile?: string;
  recordingBytes: number;
}

interface CommandInFlight {
  command?: string;
  startedAt?: number;
  castOffsetMs?: number;
  cwd?: string;
}

interface Terminal {
  meta: TerminalMeta;
  proc: pty.IPty;
  recorder?: CastRecorder;
  parser: ShellMarkerParser;
  scrollback: string;
  env: Record<string, string>;
  inflight: CommandInFlight;
  /** 已写入 events 的命令数 */
  commandCount: number;
}

export interface SpawnOptions {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  title?: string;
  env?: Record<string, string>;
  /** 启动后自动敲入的命令（工作区模板用） */
  bootCommand?: string;
  clonedFrom?: string;
  /** 该终端不写录像也不记录命令 */
  noRecord?: boolean;
}

export class PtyManager extends EventEmitter {
  private terms = new Map<string, Terminal>();
  private insertEvent: ReturnType<typeof makeInsertEvent>;

  constructor(private db: DB) {
    super();
    this.insertEvent = makeInsertEvent(db);
  }

  list(): TerminalMeta[] {
    return [...this.terms.values()].map((t) => ({ ...t.meta }));
  }

  get(id: string): TerminalMeta | undefined {
    const t = this.terms.get(id);
    return t ? { ...t.meta } : undefined;
  }

  scrollback(id: string): string {
    return this.terms.get(id)?.scrollback ?? '';
  }

  defaultShell(): string {
    return process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
  }

  spawn(opts: SpawnOptions = {}): TerminalMeta {
    const id = randomUUID();
    const shell = opts.shell ?? this.defaultShell();
    const cwd = resolveCwd(opts.cwd);
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;

    const launch = shellLaunch(shell, id);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...launch.env,
      ...(opts.env ?? {}),
    };

    const proc = pty.spawn(shell, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });

    const meta: TerminalMeta = {
      id,
      title: opts.title ?? (path.basename(cwd) || 'shell'),
      shell,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      running: true,
      integrated: false,
      clonedFrom: opts.clonedFrom,
      recordingBytes: 0,
    };

    let recorder: CastRecorder | undefined;
    if (!opts.noRecord) {
      recorder = new CastRecorder({ id, cols, rows, shell, title: meta.title });
      recorder.start();
      meta.castFile = recorder.file;
    }

    const term: Terminal = {
      meta,
      proc,
      recorder,
      parser: new ShellMarkerParser(),
      scrollback: '',
      env,
      inflight: {},
      commandCount: 0,
    };
    this.terms.set(id, term);

    this.registerSession(term);

    proc.onData((data) => this.onData(term, data));
    proc.onExit(({ exitCode, signal }) => this.onExit(term, exitCode, signal));

    if (opts.bootCommand) {
      // 等 shell 起来并加载完集成脚本再敲命令，否则会被吞掉
      setTimeout(() => {
        if (this.terms.has(id)) proc.write(`${opts.bootCommand}\r`);
      }, 350);
    }

    this.emit('spawn', { ...meta });
    return { ...meta };
  }

  /**
   * 克隆一个终端：继承 cwd、shell、环境变量，但**不是**同一个进程。
   * 这是「复制」在终端语境下的正确语义——你要的是「再来一个一样的」，
   * 而不是共享同一个 tty。
   */
  clone(id: string, overrides: SpawnOptions = {}): TerminalMeta | undefined {
    const src = this.terms.get(id);
    if (!src) return undefined;
    // 只继承用户自定义的环境，集成变量由新终端自己生成
    const inherited = { ...src.env };
    delete inherited.THOUSANDEYES_TERM_ID;
    return this.spawn({
      shell: src.meta.shell,
      cwd: src.meta.cwd,
      cols: src.meta.cols,
      rows: src.meta.rows,
      title: `${src.meta.title} 副本`,
      env: inherited,
      clonedFrom: id,
      ...overrides,
    });
  }

  write(id: string, data: string): boolean {
    const t = this.terms.get(id);
    if (!t || !t.meta.running) return false;
    t.proc.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const t = this.terms.get(id);
    if (!t || !t.meta.running) return false;
    if (cols < 1 || rows < 1) return false;
    // xterm 的 ResizeObserver 在布局稳定期间也可能重复通知。尺寸没有变化时不碰
    // node-pty、更不广播 meta，避免无意义的 WebSocket 抖动。
    if (t.meta.cols === cols && t.meta.rows === rows) return true;
    try {
      t.proc.resize(cols, rows);
    } catch {
      return false;
    }
    t.meta.cols = cols;
    t.meta.rows = rows;
    t.recorder?.resize(cols, rows);
    this.emit('meta', { ...t.meta });
    return true;
  }

  rename(id: string, title: string): boolean {
    const t = this.terms.get(id);
    if (!t) return false;
    t.meta.title = title.slice(0, 80);
    try {
      this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(t.meta.title, `human:${id}`);
    } catch {
      // 名称只是展示信息，索引不可写时不能影响终端。
    }
    this.emit('meta', { ...t.meta });
    return true;
  }

  kill(id: string): boolean {
    const t = this.terms.get(id);
    if (!t) return false;
    try {
      t.proc.kill();
    } catch {
      /* 已经死了 */
    }
    return true;
  }

  /** 关闭并从列表移除（终端已退出时用）。 */
  remove(id: string): boolean {
    const t = this.terms.get(id);
    if (!t) return false;
    if (t.meta.running) this.kill(id);
    t.recorder?.stop();
    this.terms.delete(id);
    this.emit('remove', id);
    return true;
  }

  shutdown(): void {
    for (const t of this.terms.values()) {
      try {
        t.proc.kill();
      } catch {
        /* 忽略 */
      }
      t.recorder?.stop();
    }
    this.terms.clear();
  }

  /* ---------------- 内部 ---------------- */

  private onData(term: Terminal, data: string): void {
    const parsed = term.parser.consume(data);
    const visible = parsed.output;

    // shell 集成标记只给 daemon 消费，不能污染 xterm 画面和录像。
    term.recorder?.data(visible);
    if (term.recorder) term.meta.recordingBytes = term.recorder.sizeBytes;

    term.scrollback += visible;
    if (term.scrollback.length > SCROLLBACK_BYTES) {
      term.scrollback = term.scrollback.slice(-SCROLLBACK_BYTES);
    }

    for (const marker of parsed.markers) {
      this.onMarker(term, marker);
    }

    if (visible) this.emit('data', term.meta.id, visible);
  }

  private onMarker(term: Terminal, marker: ReturnType<ShellMarkerParser['push']>[number]): void {
    switch (marker.type) {
      case 'prompt-start':
        if (!term.meta.integrated) {
          term.meta.integrated = true;
          this.emit('meta', { ...term.meta });
        }
        break;

      case 'cwd':
        if (marker.cwd && marker.cwd !== term.meta.cwd) {
          term.meta.cwd = marker.cwd;
          this.emit('meta', { ...term.meta });
        }
        break;

      case 'command-line':
        term.inflight.command = marker.command;
        break;

      case 'output-start':
        term.inflight.startedAt = Date.now();
        term.inflight.castOffsetMs = term.recorder?.offsetMs();
        term.inflight.cwd = term.meta.cwd;
        break;

      case 'command-done':
        this.recordCommand(term, marker.exitCode);
        break;

      case 'command-start':
        break;
    }
  }

  /** 一条命令跑完，写进统一时间轴（actor = human）。 */
  private recordCommand(term: Terminal, exitCode: number): void {
    const f = term.inflight;
    term.inflight = {};

    const command = (f.command ?? '').trim();
    if (!command) return; // 空回车不记
    if (!term.recorder) return; // 该终端被标记为不记录

    const startedAt = f.startedAt ?? Date.now();
    const meta = term.meta;
    term.commandCount++;
    meta.lastCommand = command.length > 120 ? `${command.slice(0, 120)}…` : command;

    try {
      this.insertEvent({
        actor: 'human',
        sessionRef: meta.id,
        ts: startedAt,
        kind: 'command',
        cwd: f.cwd ?? meta.cwd,
        command: redactText(command),
        exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        toolName: path.basename(meta.shell),
        castRef: meta.castFile,
        castOffsetMs: f.castOffsetMs,
        dedupeKey: `term:${meta.id}#${term.commandCount}`,
        raw: undefined,
      });
    } catch {
      // 落库失败不能影响终端
    }

    this.emit('meta', { ...meta });
    this.emit('command', { terminalId: meta.id, command, exitCode });
  }

  private onExit(term: Terminal, exitCode: number, signal?: number): void {
    term.meta.running = false;
    term.meta.exitedAt = Date.now();
    term.meta.exitCode = exitCode;
    term.recorder?.stop();
    this.emit('exit', { id: term.meta.id, exitCode, signal });
    this.emit('meta', { ...term.meta });
  }

  private registerSession(term: Terminal): void {
    try {
      upsertSession(this.db, {
        actor: 'human',
        externalId: term.meta.id,
        kind: 'terminal',
        projectPath: term.meta.cwd,
        startedAt: term.meta.createdAt,
        title: term.meta.title,
        sourceVersion: `shell/${path.basename(term.meta.shell)}`,
      });
    } catch {
      // 索引不可用时终端仍应能开
    }
  }
}

function resolveCwd(cwd?: string): string {
  const home = os.homedir();
  if (!cwd) return process.cwd();
  const expanded = cwd.startsWith('~') ? path.join(home, cwd.slice(1)) : cwd;
  try {
    if (fs.statSync(expanded).isDirectory()) return expanded;
  } catch {
    /* 目录不存在则退回 home */
  }
  return home;
}
