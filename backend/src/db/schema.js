import sqlite3 from 'sqlite3';
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

  db = new sqlite3.Database(resolvedPath);

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_mode = WAL');

  const schema = `
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
  `;

  // Split and execute each statement
  schema.split(';').filter(s => s.trim()).forEach(statement => {
    db.run(statement);
  });

  console.log(`[DB] Initialized at ${resolvedPath}`);
  return db;
}

export function getDB() {
  if (!db) throw new Error('DB not initialized — call initDB() first');
  return db;
}
