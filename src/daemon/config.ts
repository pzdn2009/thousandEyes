import os from 'node:os';
import path from 'node:path';

/** 所有运行时状态的根目录。 */
export const HOME = os.homedir();
export const DATA_DIR = process.env.THOUSANDEYES_HOME ?? path.join(HOME, '.thousandEyes');

export const DB_PATH = path.join(DATA_DIR, 'index.db');
export const CAST_DIR = path.join(DATA_DIR, 'casts');
export const TOKEN_PATH = path.join(DATA_DIR, 'token');
export const SOCKET_PATH = path.join(DATA_DIR, 'hook.sock');
export const LOG_PATH = path.join(DATA_DIR, 'daemon.log');

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? path.join(HOME, '.claude');
export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HOME, '.codex');

export const PORT = Number(process.env.THOUSANDEYES_PORT ?? 7317);
export const HOST = '127.0.0.1';

/** §8 保留策略默认值（D4，待实际用量后调整）。 */
export const RETENTION = {
  castDays: 30,
  castTotalBytes: 5 * 1024 * 1024 * 1024,
};
