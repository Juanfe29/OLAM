import { getDB } from './schema.js';

export function insertTest({ initiated_by, scenario, max_calls, duration, ramp_rate, destination }) {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO tests (initiated_by, scenario, max_calls, duration, ramp_rate, destination, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(initiated_by, scenario, max_calls, duration, ramp_rate, destination, new Date().toISOString());
  return result.lastInsertRowid;
}

export function finalizeTest(id, { result, summary }) {
  const db = getDB();
  db.prepare(`
    UPDATE tests SET ended_at = ?, result = ?, summary = ? WHERE id = ?
  `).run(new Date().toISOString(), result, JSON.stringify(summary), id);
}

export function insertSnapshot(test_id, data) {
  const db = getDB();
  db.prepare(`
    INSERT INTO metrics_snapshots (test_id, timestamp, data) VALUES (?, ?, ?)
  `).run(test_id, new Date().toISOString(), JSON.stringify(data));
}

export function listTests({ limit = 50, offset = 0 } = {}) {
  return getDB()
    .prepare(`SELECT id, initiated_by, scenario, max_calls, duration, ramp_rate, destination, started_at, ended_at, result FROM tests ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

export function getTest(id) {
  const db = getDB();
  const test = db.prepare(`SELECT * FROM tests WHERE id = ?`).get(id);
  if (!test) return null;
  if (test.summary) test.summary = JSON.parse(test.summary);
  const snapshots = db.prepare(`SELECT timestamp, data FROM metrics_snapshots WHERE test_id = ? ORDER BY timestamp ASC`).all(id);
  test.snapshots = snapshots.map(s => ({ timestamp: s.timestamp, ...JSON.parse(s.data) }));
  return test;
}
