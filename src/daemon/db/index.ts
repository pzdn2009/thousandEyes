import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DB_PATH, DATA_DIR } from '../config.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type DB = Database.Database;

let db: DB | null = null;

export function openDb(dbPath: string = DB_PATH): DB {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const handle = new Database(dbPath);
  handle.exec(SCHEMA_SQL);

  const row = handle.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!row) {
    handle
      .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`)
      .run(String(SCHEMA_VERSION));
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    // 迁移在此分派。当前只有 v1，故仅记录。
    handle
      .prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`)
      .run(String(SCHEMA_VERSION));
  }

  db = handle;
  return handle;
}

export function getDb(): DB {
  if (!db) return openDb();
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function dataDir(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}
