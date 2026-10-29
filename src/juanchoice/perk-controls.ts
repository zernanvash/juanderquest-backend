// JuanChoice perk controls for JuanderQuest platform staff (not area admins). Settings apply when
// perks are read, so a change reaches reigning winners at once; new rounds' manifestos use them too.
// Every change needs a reason and is written to juanchoice_perk_control_audit.
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { JuanChoiceError } from './service.js';
import {
  JUANCHOICE_PERK_CATALOG, invalidateActiveJuanChoicePerks, revealAll,
  type ActivePerk, type ManifestoPerk, type PerkKey,
} from './perks.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Safe ranges per perk type. Fractions are 0.05 = 5%; daily stamps are whole stamps. */
export const PERK_VALUE_BOUNDS: Record<PerkKey, { min: number; max: number; unit: 'percent' | 'stamps' | 'fixed' }> = {
  spot_xp_boost: { min: 0.05, max: 1, unit: 'percent' },
  msme_partner_spotlight: { min: 1, max: 1, unit: 'fixed' },
  category_xp_boost: { min: 0.05, max: 1, unit: 'percent' },
  corridor_trail_discount: { min: 0.05, max: 0.5, unit: 'percent' },
  trail_completion_bonus: { min: 0.05, max: 1, unit: 'percent' },
  quiz_arcade_xp_boost: { min: 0.05, max: 1, unit: 'percent' },
  daily_stamp_bonus: { min: 1, max: 20, unit: 'stamps' },
  shop_cosmetic_discount: { min: 0.05, max: 0.5, unit: 'percent' },
};

export interface PerkSetting {
  perk_key: PerkKey; enabled: boolean; standard_value: number | null; festival_value: number | null;
  updated_by: string | null; updated_at: string | null;
}

const isPerkKey = (key: string): key is PerkKey => Object.prototype.hasOwnProperty.call(JUANCHOICE_PERK_CATALOG, key);

let settingsCache: { at: number; value: Map<PerkKey, PerkSetting> } | null = null;
const SETTINGS_TTL_MS = 30_000;

export function invalidatePerkControls(): void {
  settingsCache = null;
  invalidateActiveJuanChoicePerks();
}

/** Stored settings by key (missing keys = catalog defaults). Fails open to defaults on read errors. */
export async function loadPerkSettings(client: Queryable): Promise<Map<PerkKey, PerkSetting>> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const value = new Map<PerkKey, PerkSetting>();
  try {
    const rows = (await client.query('SELECT perk_key,enabled,standard_value,festival_value,updated_by,updated_at FROM juanchoice_perk_settings')).rows;
    for (const row of rows) {
      if (!isPerkKey(row.perk_key)) continue;
      value.set(row.perk_key, {
        perk_key: row.perk_key, enabled: Boolean(row.enabled),
        standard_value: row.standard_value == null ? null : Number(row.standard_value),
        festival_value: row.festival_value == null ? null : Number(row.festival_value),
        updated_by: row.updated_by ?? null, updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      });
    }
  } catch (error) {
    console.error('[juanchoice-perk-controls] settings unavailable; using catalog defaults', error);
  }
  settingsCache = { at: Date.now(), value };
  return value;
}

export function perkEnabled(settings: Map<PerkKey, PerkSetting>, key: PerkKey): boolean {
  return settings.get(key)?.enabled ?? true;
}

export function effectivePerkValue(settings: Map<PerkKey, PerkSetting>, key: PerkKey, festival: boolean): number {
  const setting = settings.get(key);
  const override = festival ? setting?.festival_value : setting?.standard_value;
  return override ?? (festival ? JUANCHOICE_PERK_CATALOG[key].festival : JUANCHOICE_PERK_CATALOG[key].standard);
}

/** Re-labels a perk for a (possibly overridden) value. */
export function withPerkValue<T extends ManifestoPerk>(perk: T, value: number, ctx: { spotName?: string; municipality?: string; category?: string }): T {
  if (perk.value === value) return perk;
  const entry = JUANCHOICE_PERK_CATALOG[perk.key];
  const context = { spotName: ctx.spotName ?? 'this destination', municipality: ctx.municipality ?? 'this town', category: ctx.category ?? '' };
  return { ...perk, value, label: entry.label(value, context), description: entry.description(value, context) };
}

/** Live perks after platform controls: disabled types and suspended instances drop out; values follow overrides. */
export function applyPerkControls(perks: ActivePerk[], settings: Map<PerkKey, PerkSetting>, suspended: Set<string>, festival: boolean): ActivePerk[] {
  return perks
    .filter(perk => isPerkKey(perk.key) && perkEnabled(settings, perk.key) && !suspended.has(`${perk.candidate_id}:${perk.key}`))
    .map(perk => withPerkValue(perk, effectivePerkValue(settings, perk.key, festival), perk));
}

export async function loadActiveSuspensions(client: Queryable, campaignId: string): Promise<Set<string>> {
  try {
    const rows = (await client.query(
      'SELECT candidate_id,perk_key FROM juanchoice_perk_suspensions WHERE campaign_id=$1 AND active', [campaignId])).rows;
    return new Set(rows.map(row => `${row.candidate_id}:${row.perk_key}`));
  } catch (error) {
    console.error('[juanchoice-perk-controls] suspensions unavailable; none applied', error);
    return new Set();
  }
}

// --- Platform staff gate ----------------------------------------------------------------------

/** True only for admins whose admin_scope is 'platform' (JuanderQuest staff). Fails closed. */
export async function isPlatformStaff(userId: string, client: Queryable | null = getPool()): Promise<boolean> {
  if (!client) return false;
  const row = (await client.query("SELECT role, admin_scope FROM users WHERE id=$1", [userId])).rows[0];
  return row?.role === 'admin' && row?.admin_scope === 'platform';
}

// --- Mutations (all audited, all need a reason) -----------------------------------------------

function requireReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 10) throw new JuanChoiceError('REASON_REQUIRED', 400, 'Give a reason of at least 10 characters.');
  return text.slice(0, 500);
}

async function audit(client: PoolClient, action: string, target: unknown, before: unknown, after: unknown, reason: string, actorId: string) {
  await client.query(
    `INSERT INTO juanchoice_perk_control_audit(id,action,target,before_state,after_state,reason,actor_id)
     VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)`,
    [randomUUID(), action, JSON.stringify(target ?? {}), before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), reason, actorId]);
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  if (!pool) throw new JuanChoiceError('DATABASE_UNAVAILABLE', 503);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function checkValue(key: PerkKey, value: number | null | undefined, label: string): void {
  if (value == null) return;
  const bounds = PERK_VALUE_BOUNDS[key];
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    throw new JuanChoiceError('VALUE_OUT_OF_RANGE', 422, `${label} must be between ${bounds.min} and ${bounds.max}.`);
  }
}

export async function updatePerkSetting(input: {
  perkKey: string; enabled?: boolean; standardValue?: number | null; festivalValue?: number | null; reason: unknown; actorId: string;
}): Promise<PerkSetting> {
  if (!isPerkKey(input.perkKey)) throw new JuanChoiceError('PERK_NOT_FOUND', 404);
  const key = input.perkKey;
  const reason = requireReason(input.reason);
  checkValue(key, input.standardValue, 'Standard value');
  checkValue(key, input.festivalValue, 'Festival value');
  const result = await inTransaction(async client => {
    const before = (await client.query('SELECT * FROM juanchoice_perk_settings WHERE perk_key=$1 FOR UPDATE', [key])).rows[0] ?? null;
    const next = {
      enabled: input.enabled ?? (before ? Boolean(before.enabled) : true),
      standard_value: input.standardValue !== undefined ? input.standardValue : before?.standard_value ?? null,
      festival_value: input.festivalValue !== undefined ? input.festivalValue : before?.festival_value ?? null,
    };
    const row = (await client.query(
      `INSERT INTO juanchoice_perk_settings(perk_key,enabled,standard_value,festival_value,updated_by,updated_at)
       VALUES($1,$2,$3,$4,$5,NOW())
       ON CONFLICT(perk_key) DO UPDATE SET enabled=EXCLUDED.enabled,standard_value=EXCLUDED.standard_value,
         festival_value=EXCLUDED.festival_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING *`, [key, next.enabled, next.standard_value, next.festival_value, input.actorId])).rows[0];
    await audit(client, 'perk_setting.update', { perk_key: key }, before, next, reason, input.actorId);
    return row;
  });
  invalidatePerkControls();
  return {
    perk_key: key, enabled: Boolean(result.enabled),
    standard_value: result.standard_value == null ? null : Number(result.standard_value),
    festival_value: result.festival_value == null ? null : Number(result.festival_value),
    updated_by: result.updated_by, updated_at: new Date(result.updated_at).toISOString(),
  };
}

export async function suspendLivePerk(input: { campaignId: string; candidateId: string; perkKey: string; reason: unknown; actorId: string }) {
  if (!isPerkKey(input.perkKey)) throw new JuanChoiceError('PERK_NOT_FOUND', 404);
  const reason = requireReason(input.reason);
  const row = await inTransaction(async client => {
    const result = (await client.query('SELECT active_perks FROM juanchoice_results WHERE campaign_id=$1 FOR UPDATE', [input.campaignId])).rows[0];
    const perks: ActivePerk[] = Array.isArray(result?.active_perks) ? result.active_perks : [];
    if (!perks.some(perk => perk.candidate_id === input.candidateId && perk.key === input.perkKey)) {
      throw new JuanChoiceError('PERK_NOT_ACTIVE', 404, 'That perk is not part of this round\'s winners.');
    }
    const existing = (await client.query(
      'SELECT id FROM juanchoice_perk_suspensions WHERE campaign_id=$1 AND candidate_id=$2 AND perk_key=$3 AND active',
      [input.campaignId, input.candidateId, input.perkKey])).rows[0];
    if (existing) throw new JuanChoiceError('ALREADY_SUSPENDED', 409);
    const inserted = (await client.query(
      `INSERT INTO juanchoice_perk_suspensions(id,campaign_id,candidate_id,perk_key,reason,created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), input.campaignId, input.candidateId, input.perkKey, reason, input.actorId])).rows[0];
    await audit(client, 'live_perk.suspend', { campaign_id: input.campaignId, candidate_id: input.candidateId, perk_key: input.perkKey }, null, { suspension_id: inserted.id }, reason, input.actorId);
    return inserted;
  });
  invalidatePerkControls();
  return row;
}

export async function liftSuspension(input: { suspensionId: string; reason: unknown; actorId: string }) {
  const reason = requireReason(input.reason);
  const row = await inTransaction(async client => {
    const updated = (await client.query(
      `UPDATE juanchoice_perk_suspensions SET active=FALSE,lifted_by=$2,lifted_reason=$3,lifted_at=NOW()
       WHERE id=$1 AND active RETURNING *`, [input.suspensionId, input.actorId, reason])).rows[0];
    if (!updated) throw new JuanChoiceError('SUSPENSION_NOT_FOUND', 404);
    await audit(client, 'live_perk.restore', { suspension_id: input.suspensionId, campaign_id: updated.campaign_id, candidate_id: updated.candidate_id, perk_key: updated.perk_key }, null, null, reason, input.actorId);
    return updated;
  });
  invalidatePerkControls();
  return row;
}

/** Replace a contender's perks before voting opens (draft/scheduled rounds only). */
export async function editCandidateManifesto(input: {
  campaignId: string; candidateId: string; perkKeys: string[]; mysteryKey?: string | null; reason: unknown; actorId: string;
}) {
  const reason = requireReason(input.reason);
  const keys = [...new Set(input.perkKeys)];
  if (keys.length < 1 || keys.length > 4 || !keys.every(isPerkKey)) {
    throw new JuanChoiceError('INVALID_PERKS', 422, 'Choose 1 to 4 perks from the catalog.');
  }
  if (input.mysteryKey && !(keys as string[]).includes(input.mysteryKey)) throw new JuanChoiceError('INVALID_PERKS', 422, 'The mystery perk must be one of the chosen perks.');
  const updated = await inTransaction(async client => {
    const row = (await client.query(
      `SELECT n.manifesto_perks, c.status, c.opens_at, c.round_tier, s.name AS spot_name, s.municipality, s.category
       FROM juanchoice_candidates n JOIN juanchoice_campaigns c ON c.id=n.campaign_id JOIN spots s ON s.id=n.spot_id
       WHERE n.id=$1 AND n.campaign_id=$2 FOR UPDATE OF n`, [input.candidateId, input.campaignId])).rows[0];
    if (!row) throw new JuanChoiceError('CANDIDATE_NOT_FOUND', 404);
    if (!['draft', 'scheduled'].includes(row.status) || new Date(row.opens_at).getTime() <= Date.now()) {
      throw new JuanChoiceError('ROUND_ALREADY_OPEN', 409, 'Perks can only be edited before voting opens.');
    }
    const settings = await loadPerkSettings(client);
    const festival = row.round_tier === 'special_festival';
    const ctx = { spotName: row.spot_name, municipality: row.municipality ?? 'this town', category: row.category ?? '' };
    const perks: ManifestoPerk[] = (keys as PerkKey[]).map((key, index) => {
      const entry = JUANCHOICE_PERK_CATALOG[key];
      const value = effectivePerkValue(settings, key, festival);
      return {
        key, label: entry.label(value, ctx), description: entry.description(value, ctx), domain: entry.domain, value,
        is_anchor: index === 0 && entry.anchor, is_mystery: key === input.mysteryKey, revealed: key !== input.mysteryKey,
      };
    });
    await client.query('UPDATE juanchoice_candidates SET manifesto_perks=$1::jsonb WHERE id=$2', [JSON.stringify(perks), input.candidateId]);
    await audit(client, 'manifesto.edit', { campaign_id: input.campaignId, candidate_id: input.candidateId }, revealAll(row.manifesto_perks), perks, reason, input.actorId);
    return perks;
  });
  return updated;
}

/** Everything the control panel shows. */
export async function perkControlState(client: Queryable) {
  const settings = await loadPerkSettings(client);
  const catalog = (Object.keys(JUANCHOICE_PERK_CATALOG) as PerkKey[]).map(key => ({
    key, domain: JUANCHOICE_PERK_CATALOG[key].domain, anchor: JUANCHOICE_PERK_CATALOG[key].anchor,
    default_standard: JUANCHOICE_PERK_CATALOG[key].standard, default_festival: JUANCHOICE_PERK_CATALOG[key].festival,
    bounds: PERK_VALUE_BOUNDS[key],
    enabled: perkEnabled(settings, key),
    standard_value: effectivePerkValue(settings, key, false), festival_value: effectivePerkValue(settings, key, true),
    overridden: settings.has(key), updated_by: settings.get(key)?.updated_by ?? null, updated_at: settings.get(key)?.updated_at ?? null,
    sample_label: JUANCHOICE_PERK_CATALOG[key].label(effectivePerkValue(settings, key, false), { spotName: 'the winner', municipality: 'its town', category: 'nature_outdoors' }),
  }));
  const reign = (await client.query(
    `SELECT r.campaign_id, r.active_perks, c.theme, c.round_tier, c.closes_at
     FROM juanchoice_results r JOIN juanchoice_campaigns c ON c.id=r.campaign_id
     WHERE c.is_test=FALSE AND c.status='finalized' AND c.policy_version='juanchoice-weekly-v1'
       AND c.closes_at <= NOW() AND c.closes_at + INTERVAL '7 days' > NOW()
     ORDER BY c.closes_at DESC LIMIT 1`)).rows[0] ?? null;
  let live: Array<ActivePerk & { suspension_id: string | null; paused_by_setting: boolean; effective_value: number }> = [];
  if (reign) {
    const suspensions = (await client.query(
      'SELECT id,candidate_id,perk_key FROM juanchoice_perk_suspensions WHERE campaign_id=$1 AND active', [reign.campaign_id])).rows;
    const festival = reign.round_tier === 'special_festival';
    live = (Array.isArray(reign.active_perks) ? reign.active_perks as ActivePerk[] : []).map(perk => {
      const value = isPerkKey(perk.key) ? effectivePerkValue(settings, perk.key, festival) : perk.value;
      return {
        ...withPerkValue(perk, value, perk),
        suspension_id: suspensions.find(s => s.candidate_id === perk.candidate_id && s.perk_key === perk.key)?.id ?? null,
        paused_by_setting: isPerkKey(perk.key) && !perkEnabled(settings, perk.key),
        effective_value: value,
      };
    });
  }
  const auditRows = (await client.query(
    'SELECT action,target,reason,actor_id,created_at FROM juanchoice_perk_control_audit ORDER BY created_at DESC LIMIT 30')).rows;
  return {
    catalog,
    reign: reign ? { campaign_id: reign.campaign_id, theme: reign.theme, round_tier: reign.round_tier, reign_ends_at: new Date(new Date(reign.closes_at).getTime() + 7 * 86_400_000).toISOString() } : null,
    live,
    audit: auditRows,
  };
}
