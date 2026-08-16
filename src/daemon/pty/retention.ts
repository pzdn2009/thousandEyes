import fs from 'node:fs';
import path from 'node:path';
import { CAST_DIR, RETENTION } from '../config.js';

/**
 * 录像是唯一可能快速膨胀的数据。结构化索引可以长期保留，cast 则严格执行
 * 「30 天且 5 GB」：过期优先删除；仍超限时按最后访问/修改时间 LRU 淘汰。
 */
export function enforceCastRetention(now = Date.now()): { removed: number; bytes: number } {
  let entries: { file: string; size: number; mtime: number }[];
  try {
    entries = fs.readdirSync(CAST_DIR)
      .filter((name) => name.endsWith('.cast') || name.endsWith('.cast.zst'))
      .flatMap((name) => {
        const file = path.join(CAST_DIR, name);
        try {
          const stat = fs.statSync(file);
          return stat.isFile() ? [{ file, size: stat.size, mtime: stat.mtimeMs }] : [];
        } catch { return []; }
      });
  } catch { return { removed: 0, bytes: 0 }; }

  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  let removed = 0;
  const cutoff = now - RETENTION.castDays * 86_400_000;
  const remove = (entry: { file: string; size: number }) => {
    try { fs.unlinkSync(entry.file); total -= entry.size; removed++; } catch { /* best effort */ }
  };

  for (const entry of entries.filter((e) => e.mtime < cutoff)) remove(entry);
  if (total > RETENTION.castTotalBytes) {
    for (const entry of entries.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= RETENTION.castTotalBytes) break;
      if (fs.existsSync(entry.file)) remove(entry);
    }
  }
  return { removed, bytes: Math.max(0, total) };
}
