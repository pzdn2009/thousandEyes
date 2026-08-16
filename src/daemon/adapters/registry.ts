import type { AgentAdapter } from './types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';

/**
 * Adapter 注册表。新增一家 agent CLI 只需在此加一行（spec.md §6 / D3）。
 */
export const ALL_ADAPTERS: AgentAdapter[] = [new ClaudeAdapter(), new CodexAdapter()];

export async function enabledAdapters(): Promise<AgentAdapter[]> {
  const flags = await Promise.all(
    ALL_ADAPTERS.map(async (a) => {
      try {
        return await a.detect();
      } catch {
        return false;
      }
    }),
  );
  return ALL_ADAPTERS.filter((_, i) => flags[i]);
}

export function adapterFor(adapters: AgentAdapter[], filePath: string): AgentAdapter | undefined {
  return adapters.find((a) => {
    try {
      return a.matches(filePath);
    } catch {
      return false;
    }
  });
}
