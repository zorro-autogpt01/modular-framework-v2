import { Router } from 'express';
import { logs } from '../logger.js';

const router = Router();

router.get('/logs', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit || 200), 2000));
  const start = Math.max(0, logs.length - limit);
  res.json(logs.slice(start));
});

router.post('/logs/clear', (_req, res) => {
  logs.length = 0;
  res.json({ ok: true });
});

export default router;
