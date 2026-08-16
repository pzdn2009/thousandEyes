/**
 * SQLite schema。spec.md §5.2。
 *
 * 相对 spec 的两处增补，均为实现必需：
 *  - events.text / events_fts.text：prompt 与 response 文本也要可检索
 *  - events.dedupe_key UNIQUE：让摄取幂等，文件轮转或手动重建索引时不会产生重复事件
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,      -- 'terminal' | 'agent'
  actor             TEXT NOT NULL,      -- 'human' | 'claude' | 'codex'
  external_id       TEXT,
  project_path      TEXT NOT NULL,      -- 以记录内 cwd 为准，不反解目录名（§9-R2）
  git_branch        TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  source_version    TEXT,
  parent_session_id TEXT REFERENCES sessions(id),
  title             TEXT,
  UNIQUE(actor, external_id)
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  ts            INTEGER NOT NULL,
  actor         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  cwd           TEXT,
  command       TEXT,
  tool_name     TEXT,
  exit_code     INTEGER,
  duration_ms   INTEGER,
  file_path     TEXT,
  text          TEXT,
  model         TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  tokens_cr     INTEGER,
  tokens_cw     INTEGER,
  is_sidechain  INTEGER NOT NULL DEFAULT 0,
  external_uuid TEXT,
  parent_uuid   TEXT,
  cast_ref      TEXT,
  cast_offset   INTEGER,
  dedupe_key    TEXT UNIQUE,
  raw           TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_actor   ON events(actor, ts DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_proj  ON sessions(project_path, started_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  command, file_path, text,
  content='events', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, command, file_path, text)
  VALUES (new.id, new.command, new.file_path, new.text);
END;

CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, command, file_path, text)
  VALUES ('delete', old.id, old.command, old.file_path, old.text);
END;

CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, command, file_path, text)
  VALUES ('delete', old.id, old.command, old.file_path, old.text);
  INSERT INTO events_fts(rowid, command, file_path, text)
  VALUES (new.id, new.command, new.file_path, new.text);
END;

-- 增量摄取断点：daemon 重启后从 byte_offset 续读（§5.2）
CREATE TABLE IF NOT EXISTS ingest_state (
  file_path        TEXT PRIMARY KEY,
  inode            INTEGER,
  size             INTEGER,
  byte_offset      INTEGER NOT NULL DEFAULT 0,
  last_ingested_at INTEGER
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  layout     TEXT NOT NULL,
  panes      TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
`;
