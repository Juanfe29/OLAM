import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

import { initDB } from './db/schema.js';
import { startSSH, isConnected } from './services/sshClient.js';
import { startLogReader } from './services/logReader.js';
import { startMetricsCollection, getCurrentMetrics } from './services/metricsCollector.js';
import { startAnomalyDetector, evaluate, getActiveAlerts } from './services/anomalyDetector.js';
import { initSippManager, getTestStatus } from './services/sippManager.js';
import { insertSnapshot } from './db/queries.js';

import statusRoutes from './routes/status.js';
import testsRoutes  from './routes/tests.js';
import historyRoutes from './routes/history.js';

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Serve generated HTML reports as static files
const REPORTS_DIR = path.resolve('data/reports');
fs.mkdirSync(REPORTS_DIR, { recursive: true });
app.use('/reports', express.static(REPORTS_DIR));

app.use('/api/status',  statusRoutes);
app.use('/api/tests',   testsRoutes);
app.use('/api/history', historyRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    ssh:       isConnected(),
    timestamp: new Date().toISOString(),
  });
});

// WebSocket
io.on('connection', (socket) => {
  const metrics = getCurrentMetrics();
  if (metrics) socket.emit('metrics:update', metrics);
  socket.emit('alerts:current', getActiveAlerts());
});

// Boot sequence
initDB();

await startSSH();

startLogReader((alert) => {
  io.emit('alert:new', alert);
});

startAnomalyDetector((alert) => {
  io.emit('alert:new', alert);
});

let lastSnapshotAt = 0;
const SNAPSHOT_EVERY = 10_000; // save one row per 10s while a test is running

startMetricsCollection((metrics) => {
  evaluate(metrics);
  io.emit('metrics:update', metrics);

  const now    = Date.now();
  const status = getTestStatus();
  if (status.running && status.id && now - lastSnapshotAt >= SNAPSHOT_EVERY) {
    lastSnapshotAt = now;
    insertSnapshot(status.id, metrics).catch(e => console.error('[DB] snapshot:', e.message));
  }
});

initSippManager({
  onTestProgress: (progress) => {
    io.emit('test:progress', progress);
    // Fusionar activeCalls del test con las métricas actuales y re-emitir
    // para que el chart se actualice cada ~1s durante la prueba, no cada 2-5s.
    const m = getCurrentMetrics();
    if (m) {
      io.emit('metrics:update', {
        ...m,
        calls: { ...m.calls, active: progress.activeCalls },
      });
    }
  },
  onTestComplete:      (result)  => io.emit('test:complete',    result),
  onBatteryProgress:   (progress) => io.emit('battery:progress', progress),
  onBatteryComplete:   (report)   => io.emit('battery:complete', report),
  getMetrics:          getCurrentMetrics,
});

const PORT = parseInt(process.env.PORT || '3000');
httpServer.listen(PORT, () => {
  console.log(`[OLAM] Backend running on http://localhost:${PORT}`);
});
