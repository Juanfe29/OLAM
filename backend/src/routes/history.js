import { Router } from 'express';
import { listTests, getTest } from '../db/queries.js';

const router = Router();

router.get('/', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
  const offset = parseInt(req.query.offset || '0');
  res.json(listTests({ limit, offset }));
});

router.get('/:id', (req, res) => {
  const test = getTest(parseInt(req.params.id));
  if (!test) return res.status(404).json({ error: 'Test not found' });
  res.json(test);
});

export default router;
