/** 容错解析工具。§9-R1：任何一处解析失败都不得中断 pipeline。 */

export function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** ISO 字符串或 epoch 数值 → epoch ms。无法识别返回 undefined。 */
export function toTs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e12 ? v : v * 1000;
  }
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const MAX_TEXT = 8000;

export function truncate(s: string | undefined, max = MAX_TEXT): string | undefined {
  if (s === undefined) return undefined;
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max}]` : s;
}

/** 从 content 块数组里抽取纯文本。 */
export function collectText(content: unknown): string | undefined {
  if (typeof content === 'string') return truncate(content);
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (isRecord(block)) {
      const t = asString(block.text);
      if (t) parts.push(t);
    }
  }
  return parts.length ? truncate(parts.join('\n')) : undefined;
}
