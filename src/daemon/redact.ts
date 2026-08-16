import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import type { NormalizedEvent } from './adapters/types.js';

/**
 * 脱敏。spec.md §8。
 *
 * 事件在写库前经过这里；规则可由 ~/.thousandEyes/redact.json 覆盖。
 * 目标是防止 token / 私钥 长期沉淀在索引里，不追求完备——不是安全边界。
 */

const MASK = '«redacted»';

interface Rule {
  name: string;
  pattern: RegExp;
  /** 替换时保留的捕获组序号（如 key 名），其余替换为 MASK。 */
  keepGroup?: number;
}

const DEFAULT_RULES: Rule[] = [
  {
    name: 'private-key-block',
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'kv-secret',
    pattern:
      /\b((?:api[_-]?key|secret[_-]?\w*|access[_-]?token|auth[_-]?token|password|passwd|pwd|client[_-]?secret)\s*[=:]\s*)(["']?[^\s"'&;]{6,}["']?)/gi,
    keepGroup: 1,
  },
  { name: 'authorization-header', pattern: /\b(Authorization\s*:\s*)(\S+)/gi, keepGroup: 1 },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{20,}/g },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

export interface RedactConfig {
  enabled: boolean;
  /** 额外规则，形如 { name, pattern, flags }。 */
  extra: { name: string; pattern: string; flags?: string }[];
  /** 这些路径前缀下的项目完全不索引。 */
  projectDenyList: string[];
}

let rules: Rule[] = DEFAULT_RULES;
let config: RedactConfig = { enabled: true, extra: [], projectDenyList: [] };

export function loadRedactConfig(dir: string = DATA_DIR): RedactConfig {
  const file = path.join(dir, 'redact.json');
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RedactConfig>;
      config = {
        enabled: parsed.enabled !== false,
        extra: Array.isArray(parsed.extra) ? parsed.extra : [],
        projectDenyList: Array.isArray(parsed.projectDenyList) ? parsed.projectDenyList : [],
      };
      rules = [
        ...DEFAULT_RULES,
        ...config.extra.flatMap((e) => {
          try {
            return [{ name: e.name, pattern: new RegExp(e.pattern, e.flags ?? 'g') }];
          } catch {
            return [];
          }
        }),
      ];
    }
  } catch {
    // 配置坏了就退回默认规则，不影响摄取。
  }
  return config;
}

export function isProjectDenied(projectPath: string | undefined): boolean {
  if (!projectPath) return false;
  return config.projectDenyList.some((p) => p && projectPath.startsWith(p));
}

export function redactText(input: string | undefined): string | undefined {
  if (!input || !config.enabled) return input;
  let out = input;
  for (const r of rules) {
    r.pattern.lastIndex = 0;
    out = out.replace(r.pattern, (...args) => {
      const groups = args.slice(1, -2) as (string | undefined)[];
      if (r.keepGroup) {
        const kept = groups[r.keepGroup - 1] ?? '';
        return `${kept}${MASK}`;
      }
      return MASK;
    });
  }
  return out;
}

/** 就地脱敏事件中会落库的自由文本字段。 */
export function redactEvent(e: NormalizedEvent): NormalizedEvent {
  if (!config.enabled) return e;
  return {
    ...e,
    command: redactText(e.command),
    text: redactText(e.text),
    title: redactText(e.title),
  };
}
