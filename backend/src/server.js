import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

import { initDB } from './db/schema.js';
import { startSSH, isConnected } from './services/sshClient.js';
import { startLogReader } from './services/logReader.js';
import { startMetricsCollection, getCurrentMetrics } from './services/metricsCollector.js';
import { startAnomalyDetector, evaluate, getActiveAlerts } from './services/anomalyDetector.js';
import { initSippManager } from './services/sippManager.js';

import statusRoutes from './routes/status.js';
import testsRoutes  from './routes/tests.js';
import historyRoutes from './routes/history.js';

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

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

startMetricsCollection((metrics) => {
  evaluate(metrics);
  io.emit('metrics:update', metrics);
});

initSippManager({
  onTestProgress: (progress) => io.emit('test:progress', progress),
  onTestComplete: (result)   => io.emit('test:complete', result),
});

const PORT = parseInt(process.env.PORT || '3000');
httpServer.listen(PORT, () => {
  console.log(`[OLAM] Backend running on http://localhost:${PORT}`);
});
