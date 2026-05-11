import { getDB } from './schema.js';

export function insertTest({ initiated_by, scenario, max_calls, duration, ramp_rate, destination }) {
  const db = getDB();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO tests (initiated_by, scenario, max_calls, duration, ramp_rate, destination, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [initiated_by, scenario, max_calls, duration, ramp_rate, destination, new Date().toISOString()],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

export function finalizeTest(id, { result, summary }) {
  const db = getDB();
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE tests SET ended_at = ?, result = ?, summary = ? WHERE id = ?`,
      [new Date().toISOString(), result, JSON.stringify(summary), id],
      function(err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function insertSnapshot(test_id, data) {
  const db = getDB();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO metrics_snapshots (test_id, timestamp, data) VALUES (?, ?, ?)`,
      [test_id, new Date().toISOString(), JSON.stringify(data)],
      function(err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function listTests({ limit = 50, offset = 0 } = {}) {
  const db = getDB();
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, initiated_by, scenario, max_calls, duration, ramp_rate, destination, started_at, ended_at, result FROM tests ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      [limit, offset],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

export function getTest(id) {
  const db = getDB();
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM tests WHERE id = ?`, [id], (err, test) => {
      if (err) {
        reject(err);
        return;
      }
      if (!test) {
        resolve(null);
        return;
      }
      if (test.summary) test.summary = JSON.parse(test.summary);
      
      db.all(
        `SELECT timestamp, data FROM metrics_snapshots WHERE test_id = ? ORDER BY timestamp ASC`,
        [id],
        (err, snapshots) => {
          if (err) {
            reject(err);
          } else {
            test.snapshots = (snapshots || []).map(s => ({ 
              timestamp: s.timestamp, 
              ...JSON.parse(s.data) 
            }));
            resolve(test);
          }
        }
      );
    });
  });
}
