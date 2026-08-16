import fs from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { AgentAdapter } from '../adapters/types.js';
import type { IngestResult, Ingestor } from './pipeline.js';

/**
 * 增量监听。Codex 没有 hook 机制，只能靠 fs watch（秒级）；
 * Claude 虽然 Phase 1 会走 hook，这里仍保留 file watch 作为兜底，
 * 保证 daemon 停机期间漏掉的事件能在重启后补齐（spec.md §6）。
 */

const DEBOUNCE_MS = 300;

export interface WatcherEvents {
  onIngested?: (result: IngestResult) => void;
}

export class TranscriptWatcher {
  private watcher?: FSWatcher;
  private pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private ingestor: Ingestor,
    private adapters: AgentAdapter[],
    private events: WatcherEvents = {},
  ) {}

  start(): void {
    const roots = this.adapters.flatMap((a) => a.watchRoots()).filter((r) => fs.existsSync(r));
    if (!roots.length) return;

    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      // transcript 会被频繁 append，深度足够覆盖 codex 的 YYYY/MM/DD 三层
      depth: 6,
    });

    const onChange = (file: string) => this.schedule(file);
    this.watcher.on('add', onChange).on('change', onChange);
  }

  private schedule(file: string): void {
    const existing = this.pending.get(file);
    if (existing) clearTimeout(existing);
    this.pending.set(
      file,
      setTimeout(() => {
        this.pending.delete(file);
        try {
          const r = this.ingestor.ingestFile(file);
          if (r.eventsInserted || r.patched) this.events.onIngested?.(r);
        } catch {
          // 单文件失败不影响监听继续
        }
      }, DEBOUNCE_MS),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    await this.watcher?.close();
    this.watcher = undefined;
  }
}
