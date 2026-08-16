/**
 * L3 采集层的统一契约。spec.md §5.1 / §6。
 *
 * 所有 adapter 把各家 agent CLI 的私有 transcript 格式归一成 NormalizedEvent。
 * 解析必须容错——见 spec.md §9-R1：transcript 格式无稳定性承诺。
 */

export type Actor = 'human' | 'claude' | 'codex';

export type EventKind =
  | 'session_start'
  | 'session_end'
  | 'prompt'
  | 'response'
  | 'command'
  | 'tool_use'
  | 'file_edit'
  | 'notification';

export interface NormalizedEvent {
  ts: number;
  actor: Actor;
  /** 外部 session id（claude sessionId / codex rollout uuid）。 */
  sessionRef: string;
  kind: EventKind;
  cwd?: string;
  gitBranch?: string;

  /** kind=command */
  command?: string;
  exitCode?: number;
  durationMs?: number;
  /** 工具名，用于区分 Bash / Write / Edit / WebSearch 等。 */
  toolName?: string;

  /** kind=file_edit */
  filePath?: string;

  /** kind=response */
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;

  /** kind=prompt/response 的文本摘要，用于全文检索。 */
  text?: string;

  isSidechain?: boolean;
  /** 父事件 uuid，用于还原调用链。 */
  parentRef?: string;
  /** 本事件自身的外部 uuid。 */
  selfRef?: string;

  castRef?: string;
  castOffsetMs?: number;

  /**
   * 若存在，本条不是新事件，而是对既有事件（external_uuid = patchTarget）的补丁。
   * 用于命令执行完毕后回填 exitCode / durationMs——两家 CLI 都是先记录调用、后记录结果。
   */
  patchTarget?: string;

  /** 若为 true，只用于更新 session 元信息，不写入 events 表。 */
  metaOnly?: boolean;

  /** 产生该事件的 CLI 版本，写入 sessions.source_version。 */
  sourceVersion?: string;
  /** session 标题（如果记录里带）。 */
  title?: string;

  raw: unknown;
}

/** 解析单行时的文件上下文。adapter 可在其中缓存跨行状态。 */
export interface FileContext {
  filePath: string;
  /** 同一文件内跨行共享的可变状态（如 codex 的 session_meta、call_id → command 映射）。 */
  state: Record<string, unknown>;
}

export interface AgentAdapter {
  readonly id: Actor;

  /** 数据目录是否存在，决定是否启用该 adapter。 */
  detect(): Promise<boolean>;

  /** 需要递归监听 / 扫描的目录。 */
  watchRoots(): string[];

  /** 该文件是否属于本 adapter。 */
  matches(filePath: string): boolean;

  /**
   * 解析单行。契约：
   *  - 未知字段忽略
   *  - 缺字段降级而非抛错
   *  - 解析失败返回 []，绝不抛出
   */
  parseLine(line: string, ctx: FileContext): NormalizedEvent[];

  /** 拼出恢复该 session 的命令行（Phase 3 用）。 */
  resumeCommand(externalId: string, cwd: string): string[];
}
