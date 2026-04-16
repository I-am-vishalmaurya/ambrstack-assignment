import { Router } from 'express';
import { getAuditLog } from '../audit/store.js';

export const auditRouter = Router();

auditRouter.get('/', (_req, res) => {
  try {
    const entries = getAuditLog();
    res.json({ entries, total: entries.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[audit]', msg);
    res.status(500).json({ error: msg });
  }
});
