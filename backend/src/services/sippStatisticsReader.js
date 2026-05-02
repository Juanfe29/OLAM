// Lee el `_statistics.csv` final de SIPp y construye un summary confiable.
//
// Contexto (BLOCK-02 / Phase 1):
// El parser previo leía stderr en vivo con regex frágil — los snapshots
// salían vacíos en muchos runs. SIPp ya escribe un CSV de stats robusto
// cuando se invoca con `-trace_stat`. Este módulo lo lee al final del
// proceso y devuelve métricas confiables.
//
// CSV layout esperado (SIPp 3.7+):
//   StartTime;LastResetTime;CurrentTime;ElapsedTime(P);ElapsedTime(C);
//   TargetRate;CallRate(P);CallRate(C);IncomingCall(P);IncomingCall(C);
//   OutgoingCall(P);OutgoingCall(C);TotalCallCreated;CurrentCall;
//   SuccessfulCall(P);SuccessfulCall(C);FailedCall(P);FailedCall(C);
//   FailedCannotSendMessage(P);FailedCannotSendMessage(C);
//   ... (~80 columnas más)
//
// Las columnas que necesitamos para buildSummary:
//   - TotalCallCreated         → total intentado
//   - SuccessfulCall(C)        → cumulativo exitosos
//   - FailedCall(C)            → cumulativo fallidos
//   - CurrentCall              → max concurrentes (lo trackeamos por línea)
//   - ResponseTime1Avg         → PDD promedio (si está)

import chokidar from 'chokidar';
import { parseFile } from 'fast-csv';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

// SIPp escribe su CSV en el cwd del proceso. Con `cwd: tmpDir` controlamos
// dónde aparece y evitamos basura en el repo.
export function newSippWorkingDir() {
  return path.join(os.tmpdir(), `olam-sipp-${Date.now()}`);
}

// Encuentra el `*_statistics.csv` más reciente en `dir`.
// SIPp lo nombra como `<scenario>_<pid>_<timestamp>_statistics.csv`.
export async function findStatisticsFile(dir) {
  try {
    const entries = await fs.readdir(dir);
    const stats = entries
      .filter(name => name.endsWith('_statistics.csv') || name.endsWith('_stat.csv'))
      .map(name => path.join(dir, name));
    if (stats.length === 0) return null;
    // Si hay más de uno (raro), tomar el más reciente
    const withMtime = await Promise.all(
      stats.map(async p => ({ p, mtime: (await fs.stat(p)).mtimeMs })),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime[0].p;
  } catch {
    return null;
  }
}

// Espera a que SIPp termine de escribir el CSV.
// Resuelve con la ruta cuando el archivo aparece y queda estable >grace ms,
// o con null si hay timeout.
export function waitForStatisticsFile(dir, { timeoutMs = 5000, graceMs = 500 } = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    let lastSize = -1;
    let stableTimer = null;

    const watcher = chokidar.watch(dir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: graceMs, pollInterval: 100 },
      depth: 0,
    });

    const cleanup = (result) => {
      if (resolved) return;
      resolved = true;
      if (stableTimer) clearTimeout(stableTimer);
      watcher.close().catch(() => {});
      resolve(result);
    };

    const onPath = (p) => {
      if (!p.endsWith('_statistics.csv') && !p.endsWith('_stat.csv')) return;
      cleanup(p);
    };

    watcher.on('add', onPath);
    watcher.on('change', onPath);

    // Plan B: chequear si ya existe (chokidar dispara `add` igual,
    // pero hacemos un read explícito por las dudas — el dir se crea
    // justo antes de invocar SIPp, suele estar vacío).
    findStatisticsFile(dir).then(p => { if (p) cleanup(p); });

    setTimeout(() => cleanup(null), timeoutMs);
  });
}

// Parsea el CSV completo y extrae el summary final.
// Devuelve null si el CSV no se puede leer / está vacío.
export async function readStatistics(csvPath) {
  if (!csvPath) return null;

  return new Promise((resolve) => {
    const rows = [];
    let header = null;

    parseFile(csvPath, { delimiter: ';', headers: true, ignoreEmpty: true })
      .on('headers', (h) => { header = h; })
      .on('error', () => resolve(null))
      .on('data', (row) => rows.push(row))
      .on('end', () => {
        if (rows.length === 0) return resolve(null);
        // La última fila tiene los cumulativos finales.
        const last = rows[rows.length - 1];
        // SIPp incluye una fila de headers como string en row 0 a veces;
        // si las claves están en el primer row literal, ajustar:
        const pick = (key) => {
          const v = last[key];
          if (v === undefined || v === '') return undefined;
          const n = Number(v);
          return Number.isNaN(n) ? v : n;
        };
        const summary = {
          totalCalls:      pick('TotalCallCreated'),
          successful:      pick('SuccessfulCall(C)'),
          failed:          pick('FailedCall(C)'),
          maxConcurrent:   Math.max(0, ...rows.map(r => Number(r.CurrentCall) || 0)),
          callRate:        pick('CallRate(C)'),
          responseAvgMs:   pick('ResponseTime1Avg(C)') || pick('ResponseTime1Avg'),
          rowsCount:       rows.length,
        };
        resolve(summary);
      });
  });
}

// Wrapper: espera el CSV y lo parsea. Devuelve null si no apareció a tiempo.
export async function readSippStatistics(dir, opts = {}) {
  const csvPath = await waitForStatisticsFile(dir, opts);
  if (!csvPath) return null;
  return readStatistics(csvPath);
}
