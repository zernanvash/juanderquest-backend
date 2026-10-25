import type { Pool } from 'pg';
import { fundingCommand, FundingError } from '../funding/transaction.js';
import { loadTrailEconomy } from './economy.js';
import { parseTrailPreferences } from './ai/service.js';
import { generateTrail } from './generate.js';

export interface PersonalTrailRequest {
  text?: string;
  themes?: string[];
  good_for?: string[];
  municipalities?: string[];
  budget_min?: number;
  pace?: 'relaxed' | 'balanced' | 'packed';
  start?: { lat: number; lng: number };
}

export class PersonalTrailError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

function manilaWeekId(now = new Date()): string {
  const manila = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = (manila.getUTCDay() + 6) % 7;
  manila.setUTCDate(manila.getUTCDate() - day);
  return manila.toISOString().slice(0, 10);
}

export async function createPersonalTrail(pool: Pool, userId: string, key: string, request: PersonalTrailRequest) {
  if (!key || key.length < 8 || key.length > 200) throw new PersonalTrailError('IDEMPOTENCY_KEY_REQUIRED', 400, 'A valid Idempotency-Key header is required.');
  const themeChips = request.themes ?? [];
  const goodFor = request.good_for ?? [];
  const towns = request.municipalities ?? [];
  const parsed = request.text
    ? await parseTrailPreferences(pool, { text: request.text, categories: themeChips, good_for: goodFor, municipalities: towns })
    : null;
  const themes = themeChips.length ? themeChips : parsed?.value.themes ?? [];
  const municipalities = towns.length ? towns : parsed?.value.municipalities ?? [];
  if (!municipalities.length && !request.start) {
    throw new PersonalTrailError('AREA_REQUIRED', 400, 'Choose a municipality or start location to keep the trail within a 60 km area.');
  }
  const budgetMin = request.budget_min ?? parsed?.value.budget_min ?? 240;
  const maxLegMin = request.pace === 'relaxed' || parsed?.value.pace === 'relaxed' ? 45
    : request.pace === 'packed' || parsed?.value.pace === 'packed' ? 90 : parsed?.value.max_leg_min ?? 60;
  const theme = themes[0] ?? goodFor[0] ?? 'Pangasinan discoveries';
  const weekId = manilaWeekId();

  try {
    return await fundingCommand(pool, userId, 'personal_trail_generation', key,
      { text: request.text ?? null, themes, good_for: goodFor, municipalities, budget_min: budgetMin, pace: request.pace ?? parsed?.value.pace ?? 'balanced', week_id: weekId },
      async tx => {
        const user = await tx.client.query('SELECT id,is_test FROM users WHERE id=$1 FOR UPDATE', [userId]);
        if (!user.rows[0]) throw new PersonalTrailError('USER_NOT_FOUND', 404, 'Traveler account was not found.');
        const isTest = Boolean(user.rows[0].is_test);
        const economy = await loadTrailEconomy(tx.client);
        const used = await tx.client.query(`SELECT COUNT(*)::int AS count FROM trail_generations
          WHERE kind='personal' AND requested_by=$1 AND created_at >= (date_trunc('week', clock_timestamp() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila')`, [userId]);
        const isFree = Number(used.rows[0]?.count ?? 0) < economy.personalFreePerWeek;
        const price = isFree ? 0 : economy.personalGenerationPoints;
        const result = await generateTrail(pool, {
          kind: 'personal', tier: 'personal', status: 'published', requestedBy: userId, ownerUserId: userId,
          isTest, theme, constraints: { themes, goodFor, trendThemes: [] }, budgetMin,
          maxLegMin, minStops: 2, maxStops: 6, maxPerCategory: 2,
          allowedMunicipalities: municipalities, startNode: request.start, transactionClient: tx.client,
        });
        if (price > 0) {
          const sinkId = `trail_sink:${isTest ? 'test' : 'live'}`;
          await tx.client.query(`INSERT INTO points_accounts(id,kind,is_test) VALUES($1,'treasury',$2) ON CONFLICT(id) DO NOTHING`, [sinkId, isTest]);
          await tx.transfer({ from: { id: userId, kind: 'traveler', userId }, to: { id: sinkId, kind: 'treasury' },
            points: price, type: 'trail_unlock_debit', referenceType: 'personal_generation', referenceId: result.trail.id,
            actorId: userId, idempotencyKey: `${userId}:${key}`, metadata: { trail_id: result.trail.id, week_id: weekId, is_test: isTest } });
        }
        return { ...result, charged_points: price, free_generation_remaining: isFree ? Math.max(0, economy.personalFreePerWeek - Number(used.rows[0]?.count ?? 0) - 1) : 0 };
      });
  } catch (error) {
    if (error instanceof PersonalTrailError) throw error;
    if ((error instanceof FundingError && error.code === 'INSUFFICIENT_TRAVELER_POINTS') ||
        (error instanceof Error && error.message === 'INSUFFICIENT_TRAVELER_POINTS')) {
      throw new PersonalTrailError('INSUFFICIENT_POINTS', 409, 'You do not have enough points for another personal trail this week.');
    }
    throw error;
  }
}
