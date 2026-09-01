import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = Router();
const eventSchema = z.object({ eventType: z.enum(['page_view', 'cta_click']), path: z.string().trim().min(1).max(300).startsWith('/'), label: z.string().trim().min(1).max(80).optional(), sessionId: z.string().uuid() }).refine((value) => value.eventType !== 'cta_click' || Boolean(value.label), { message: 'CTA events require a label.' });
const counters = new Map<string, { minute: number; count: number }>();

router.post('/analytics/events', (req, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid analytics event.' } }); return; }
  const minute = Math.floor(Date.now() / 60000); const current = counters.get(parsed.data.sessionId);
  if (current?.minute === minute && current.count >= 120) { res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many analytics events.' } }); return; }
  counters.set(parsed.data.sessionId, current?.minute === minute ? { minute, count: current.count + 1 } : { minute, count: 1 });
  db.recordWebAnalyticsEvent({ id: randomUUID(), event_type: parsed.data.eventType, path: parsed.data.path, label: parsed.data.label, session_id: parsed.data.sessionId, occurred_at: new Date().toISOString() });
  res.status(202).json({ success: true });
});

router.get('/admin/analytics', authenticateToken, requireAdmin, (req, res) => {
  const parsed = z.coerce.number().int().min(1).max(90).safeParse(req.query.days ?? 30);
  if (!parsed.success) { res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Days must be between 1 and 90.' } }); return; }
  res.json({ success: true, data: db.getWebAnalyticsSummary(parsed.data) });
});
export default router;
