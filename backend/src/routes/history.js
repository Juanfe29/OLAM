import { Router } from 'express';
import { listTests, getTest } from '../db/queries.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
    const offset = parseInt(req.query.offset || '0');
    const tests = await listTests({ limit, offset });
    res.json(tests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const test = await getTest(parseInt(req.params.id));
    if (!test) return res.status(404).json({ error: 'Test not found' });
    res.json(test);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
