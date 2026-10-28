// Plan 65: manifesto perks. A typed allowlist; candidates get a deterministic subset per round,
// and the reigning Champion (#1) plus Minister (#2) perks are what gameplay reads (checkpoint 1b).
import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';

export type PerkDomain = 'quests' | 'trails' | 'stamps_quiz' | 'shop_msme';
export type PerkKey =
  | 'spot_xp_boost' | 'msme_partner_spotlight'
  | 'category_xp_boost' | 'corridor_trail_discount' | 'trail_completion_bonus'
  | 'quiz_arcade_xp_boost' | 'daily_stamp_bonus' | 'shop_cosmetic_discount';

export interface ManifestoPerk {
  key: PerkKey; label: string; description: string; domain: PerkDomain;
  /** Fraction (0.5 = +50%) or a whole amount (stamps), per perk. */
  value: number; is_anchor: boolean; is_mystery: boolean; revealed: boolean;
}

interface CatalogEntry {
  domain: PerkDomain; anchor: boolean; standard: number; festival: number;
  label: (value: number, ctx: PerkContext) => string;
  description: (value: number, ctx: PerkContext) => string;
}
interface PerkContext { spotName: string; municipality: string; category: string }

const pct = (value: number) => `${Math.round(value * 100)}%`;
const CATEGORY_LABEL: Record<string, string> = {
  nature_outdoors: 'nature', culture_heritage: 'heritage', eat_drink: 'food', activities_wellness: 'activity',
  shopping_local: 'local shopping', stay: 'stay',
};

export const JUANCHOICE_PERK_CATALOG: Record<PerkKey, CatalogEntry> = {
  spot_xp_boost: { domain: 'quests', anchor: true, standard: 0.5, festival: 0.75,
    label: v => `+${pct(v)} quest XP here`,
    description: (v, c) => `+${pct(v)} Explorer XP for quests at ${c.spotName}, plus its supporter quest.` },
  msme_partner_spotlight: { domain: 'shop_msme', anchor: true, standard: 1, festival: 1,
    label: () => 'Local partner spotlight',
    description: (_v, c) => `Partner vouchers from ${c.municipality} are featured at the top of the Shop and JuanChoice.` },
  category_xp_boost: { domain: 'quests', anchor: false, standard: 0.25, festival: 0.4,
    label: (v, c) => `+${pct(v)} ${CATEGORY_LABEL[c.category] ?? 'category'} quest XP`,
    description: (v, c) => `+${pct(v)} Explorer XP on every ${CATEGORY_LABEL[c.category] ?? 'matching'} quest in the province.` },
  corridor_trail_discount: { domain: 'trails', anchor: false, standard: 0.25, festival: 0.4,
    label: v => `-${pct(v)} Hiyas Trail unlocks`,
    description: (v, c) => `Hiyas Trails passing through ${c.municipality} cost ${pct(v)} fewer points to unlock.` },
  trail_completion_bonus: { domain: 'trails', anchor: false, standard: 0.2, festival: 0.35,
    label: v => `+${pct(v)} trail rewards`,
    description: v => `Completing any trail pays ${pct(v)} more points.` },
  quiz_arcade_xp_boost: { domain: 'stamps_quiz', anchor: false, standard: 0.5, festival: 0.75,
    label: v => `+${pct(v)} quiz XP`,
    description: v => `+${pct(v)} Explorer XP on passed cultural quizzes.` },
  daily_stamp_bonus: { domain: 'stamps_quiz', anchor: false, standard: 5, festival: 10,
    label: v => `+${v} daily stamps`,
    description: v => `+${v} Passport Stamps on the daily claim (still within the weekly cap).` },
  shop_cosmetic_discount: { domain: 'shop_msme', anchor: false, standard: 0.15, festival: 0.25,
    label: v => `-${pct(v)} banners & frames`,
    description: v => `Banners and frames in the Shop cost ${pct(v)} fewer points.` },
};

const PROVINCIAL: PerkKey[] = ['category_xp_boost', 'corridor_trail_discount', 'trail_completion_bonus',
  'quiz_arcade_xp_boost', 'daily_stamp_bonus', 'shop_cosmetic_discount'];

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Progressive slots: 2 to start, +1 per consecutive loss, capped at 4. */
export function unlockedPerkCount(consecutiveLosses: number): number {
  return Math.min(4, Math.max(2, 2 + Math.max(0, Math.floor(consecutiveLosses))));
}

/** Deterministic manifesto for one candidate in one round: 1 anchor + (count - 1) provincial perks. */
export function buildManifesto(input: {
  seed: string; spotId: string; spotName: string; municipality: string; category: string;
  count: number; festival: boolean;
}): ManifestoPerk[] {
  const ctx: PerkContext = { spotName: input.spotName, municipality: input.municipality, category: input.category };
  const make = (key: PerkKey, isAnchor: boolean): ManifestoPerk => {
    const entry = JUANCHOICE_PERK_CATALOG[key];
    const value = input.festival ? entry.festival : entry.standard;
    return { key, label: entry.label(value, ctx), description: entry.description(value, ctx), domain: entry.domain,
      value, is_anchor: isAnchor, is_mystery: false, revealed: true };
  };
  const anchor: PerkKey = parseInt(hash(`${input.seed}:${input.spotId}:anchor`).slice(0, 8), 16) % 3 === 0
    ? 'msme_partner_spotlight' : 'spot_xp_boost';
  const provincial = [...PROVINCIAL].sort((a, b) =>
    hash(`${input.seed}:${input.spotId}:${a}`).localeCompare(hash(`${input.seed}:${input.spotId}:${b}`)));
  return [make(anchor, true), ...provincial.slice(0, Math.max(0, Math.min(4, input.count) - 1)).map(key => make(key, false))];
}

/** One non-anchor perk on one candidate per round becomes the mystery perk. */
export function pickMysteryCandidate(seed: string, candidateIds: string[]): string | null {
  if (!candidateIds.length) return null;
  return [...candidateIds].sort((a, b) => hash(`${seed}:mystery:${a}`).localeCompare(hash(`${seed}:mystery:${b}`)))[0];
}

export function markMystery(perks: ManifestoPerk[]): ManifestoPerk[] {
  const index = perks.findIndex(perk => !perk.is_anchor);
  if (index < 0) return perks;
  return perks.map((perk, i) => (i === index ? { ...perk, is_mystery: true, revealed: false } : perk));
}

/** What travelers may see: an unrevealed mystery perk keeps only its slot. */
export function publicManifesto(perks: unknown): Array<Partial<ManifestoPerk> & { is_mystery: boolean }> {
  if (!Array.isArray(perks)) return [];
  return (perks as ManifestoPerk[]).map(perk => (perk.is_mystery && !perk.revealed
    ? { is_mystery: true, revealed: false, label: '??? Mystery perk', description: 'Revealed when this destination wins.' }
    : perk));
}

export function revealAll(perks: unknown): ManifestoPerk[] {
  return Array.isArray(perks) ? (perks as ManifestoPerk[]).map(perk => ({ ...perk, revealed: true })) : [];
}

/** The Minister contributes its strongest provincial (non-anchor) perk. */
export function ministerPerk(perks: unknown): ManifestoPerk | null {
  const list = revealAll(perks).filter(perk => !perk.is_anchor);
  return list[0] ?? null;
}

export interface ActivePerk extends ManifestoPerk {
  role: 'champion' | 'minister'; campaign_id: string; candidate_id: string; spot_id: string; municipality: string; category: string;
  reign_starts_at: string; reign_ends_at: string;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;
const activeCache = new Map<string, { at: number; value: ActivePerk[] }>();
const ACTIVE_TTL_MS = 30_000;

export function invalidateActiveJuanChoicePerks(): void { activeCache.clear(); }

/**
 * Perks reigning right now: the latest finalized weekly round whose reign (its close + 7 days)
 * covers `now`. Only results that passed the safety gate carry active perks.
 */
export async function getActiveJuanChoicePerks(client: Queryable, isTest = false, now = new Date()): Promise<ActivePerk[]> {
  const key = String(isTest);
  const cached = activeCache.get(key);
  if (cached && now.getTime() - cached.at < ACTIVE_TTL_MS) return cached.value;
  const row = (await client.query(
    `SELECT r.campaign_id, r.active_perks, c.closes_at
     FROM juanchoice_results r JOIN juanchoice_campaigns c ON c.id = r.campaign_id
     WHERE c.is_test = $1 AND c.status = 'finalized' AND jsonb_array_length(r.active_perks) > 0
       AND c.closes_at <= $2 AND c.closes_at + INTERVAL '7 days' > $2
     ORDER BY c.closes_at DESC LIMIT 1`, [isTest, now])).rows[0];
  let value: ActivePerk[] = row && Array.isArray(row.active_perks) ? row.active_perks : [];
  if (value.length) {
    // An admin 'restricted' override suspends a reigning destination's perks mid-week (Plan 65 D10).
    const ids = [...new Set(value.map(perk => perk.candidate_id).filter(Boolean))];
    const restricted = new Set((await client.query(
      `SELECT DISTINCT ON (candidate_id) candidate_id, decision FROM juanchoice_promotion_assessments
       WHERE candidate_id = ANY($1::uuid[]) ORDER BY candidate_id, revision DESC`, [ids])).rows
      .filter(r => r.decision === 'restricted').map(r => String(r.candidate_id)));
    value = value.filter(perk => !restricted.has(String(perk.candidate_id)));
  }
  activeCache.set(key, { at: now.getTime(), value });
  return value;
}
