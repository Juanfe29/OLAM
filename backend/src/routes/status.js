import { Router } from 'express';
import { getCurrentMetrics } from '../services/metricsCollector.js';
import { getActiveAlerts } from '../services/anomalyDetector.js';
import { isConnected } from '../services/sshClient.js';

const router = Router();

router.get('/', (req, res) => {
  const metrics = getCurrentMetrics();
  if (!metrics) return res.status(503).json({ error: 'Metrics not yet available' });

  res.json({
    ...metrics,
    ssh: { connected: isConnected() },
    alerts: getActiveAlerts(),
    mock: process.env.MOCK_MODE === 'true',
  });
});

router.get('/trunk', (req, res) => {
  const metrics = getCurrentMetrics();
  if (!metrics) return res.status(503).json({ error: 'Metrics not yet available' });
  res.json(metrics.trunk);
});

router.get('/host', (req, res) => {
  const metrics = getCurrentMetrics();
  if (!metrics) return res.status(503).json({ error: 'Metrics not yet available' });
  res.json(metrics.host);
});

export default router;
