import { Router } from 'express';
import { runTest, stopTest, getTestStatus, getScenarios } from '../services/sippManager.js';

const router = Router();

router.get('/scenarios', (req, res) => {
  res.json(getScenarios());
});

router.get('/status', (req, res) => {
  res.json(getTestStatus());
});

router.post('/run', async (req, res) => {
  try {
    const initiatedBy = req.ip || 'unknown';
    const result = await runTest(req.body, initiatedBy);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/stop', (req, res) => {
  try {
    stopTest();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

export default router;
