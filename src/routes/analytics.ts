import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { requireAreaAdmin } from '../admin/scope.js';
import { getPool } from '../db/pool.js';

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

router.get('/admin/analytics', authenticateToken, requireAreaAdmin('analytics'), async (req: AuthRequest, res) => {
  const parsed = z.coerce.number().int().min(1).max(90).safeParse(req.query.days ?? 30);
  if (!parsed.success) { res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Days must be between 1 and 90.' } }); return; }
  if (req.adminScope!.platform) return res.json({ success: true, data: db.getWebAnalyticsSummary(parsed.data) });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Area analytics are unavailable.' } });
  const areaIds = [...new Set(req.adminScope!.grants.filter(grant => grant.powers.has('analytics')).flatMap(grant => [...grant.areaIds]))];
  const result = await pool.query(
    `SELECT COUNT(DISTINCT s.id)::int AS destinations,
            (SELECT COUNT(*)::int FROM spot_interactions si JOIN spots visit_spot ON visit_spot.id=si.spot_id
              WHERE (visit_spot.town_area_id = ANY($2::text[]) OR visit_spot.barangay_area_id = ANY($2::text[]))
                AND NOT visit_spot.is_test AND si.interaction_type='visit'
                AND si.created_at >= NOW() - ($1::int * INTERVAL '1 day')) AS visits,
            (SELECT COUNT(DISTINCT qa.id)::int FROM quest_attempts qa JOIN spots quest_spot ON quest_spot.quest_id=qa.quest_id
              WHERE (quest_spot.town_area_id = ANY($2::text[]) OR quest_spot.barangay_area_id = ANY($2::text[]))
                AND NOT quest_spot.is_test AND qa.status='completed'
                AND qa.completed_at >= NOW() - ($1::int * INTERVAL '1 day')) AS quest_completions
       FROM spots s
      WHERE (s.town_area_id = ANY($2::text[]) OR s.barangay_area_id = ANY($2::text[])) AND NOT s.is_test`, [parsed.data, areaIds]);
  return res.json({ success: true, data: { days: parsed.data, area_scoped: true,
    area_names: [...new Set(req.adminScope!.grants.filter(grant => grant.powers.has('analytics')).map(grant => grant.areaName))],
    destinations: Number(result.rows[0]?.destinations ?? 0), visits: Number(result.rows[0]?.visits ?? 0),
    quest_completions: Number(result.rows[0]?.quest_completions ?? 0) } });
});
export default router;
