import { Router } from 'express';
import { listTests, getTest } from '../db/queries.js';
import { reportExists } from '../services/reportGenerator.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
    const offset = parseInt(req.query.offset || '0');
    const tests  = await listTests({ limit, offset });
    const enriched = tests.map(t => ({
      ...t,
      report_url: t.result && reportExists(t.id) ? `/reports/run-${t.id}.html` : null,
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const test = await getTest(parseInt(req.params.id));
    if (!test) return res.status(404).json({ error: 'Test not found' });
    test.report_url = reportExists(test.id) ? `/reports/run-${test.id}.html` : null;
    res.json(test);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
