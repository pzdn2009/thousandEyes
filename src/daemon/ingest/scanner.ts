import fs from 'node:fs';
import path from 'node:path';
import type { AgentAdapter } from '../adapters/types.js';
import type { Ingestor } from './pipeline.js';

/** 全量扫描：把历史 transcript 一次性建库。断点续读保证重复运行是廉价的。 */

export interface ScanSummary {
  files: number;
  lines: number;
  events: number;
  patched: number;
  ms: number;
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export function scanAll(
  ingestor: Ingestor,
  adapters: AgentAdapter[],
  onProgress?: (done: number, file: string) => void,
): ScanSummary {
  const started = Date.now();
  const summary: ScanSummary = { files: 0, lines: 0, events: 0, patched: 0, ms: 0 };

  const seen = new Set<string>();
  for (const adapter of adapters) {
    for (const root of adapter.watchRoots()) {
      if (!fs.existsSync(root)) continue;
      for (const file of walk(root)) {
        if (seen.has(file) || !adapter.matches(file)) continue;
        seen.add(file);
        const r = ingestor.ingestFile(file);
        summary.files++;
        summary.lines += r.linesRead;
        summary.events += r.eventsInserted;
        summary.patched += r.patched;
        onProgress?.(summary.files, file);
      }
    }
  }

  summary.ms = Date.now() - started;
  return summary;
}
