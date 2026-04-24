import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function initDB() {
  const dbPath = process.env.DB_PATH || './data/olam.db';
  const resolvedPath = path.resolve(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      initiated_by TEXT NOT NULL DEFAULT 'unknown',
      scenario   TEXT NOT NULL,
      max_calls  INTEGER NOT NULL,
      duration   INTEGER NOT NULL,
      ramp_rate  INTEGER NOT NULL,
      destination TEXT NOT NULL DEFAULT '100',
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      result     TEXT,
      summary    TEXT
    );

    CREATE TABLE IF NOT EXISTS metrics_snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id    INTEGER NOT NULL,
      timestamp  TEXT NOT NULL,
      data       TEXT NOT NULL,
      FOREIGN KEY (test_id) REFERENCES tests(id)
    );
  `);

  console.log(`[DB] Initialized at ${resolvedPath}`);
  return db;
}

export function getDB() {
  if (!db) throw new Error('DB not initialized — call initDB() first');
  return db;
}
