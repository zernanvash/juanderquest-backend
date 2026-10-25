import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';

export type CosmeticSlot = { id: string; kind: string; asset: Record<string, unknown>; seed?: number } | null;
export type CosmeticRenderData = { banner: CosmeticSlot; frame: CosmeticSlot; title: CosmeticSlot; nameColor: CosmeticSlot };
export const emptyCosmetics = (): CosmeticRenderData => ({ banner:null, frame:null, title:null, nameColor:null });

/** FNV-1a 32-bit hash shared with the approved banner lab and client ports. */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Cosmetics are optional decoration: a failed lookup must not fail its owning response. */
export async function safeCosmeticsFor(userIds: string[], client?: Pool | PoolClient): Promise<Map<string, CosmeticRenderData>> {
  try { return await cosmeticsFor(userIds, client); }
  catch (error) {
    console.error('[shop] cosmetic render enrichment failed:', error);
    return new Map(userIds.filter(Boolean).map((id) => [id, emptyCosmetics()]));
  }
}

/** Resolve equipped cosmetics in one query for a set of public actors. */
export async function cosmeticsFor(userIds: string[], client?: Pool | PoolClient): Promise<Map<string, CosmeticRenderData>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, CosmeticRenderData>();
  if (!unique.length) return out;
  const pg = client ?? getPool();
  if (!pg) return out;
  const rows = await pg.query(
    `SELECT l.user_id, i.id, i.kind, i.asset
       FROM user_cosmetic_loadout l
       LEFT JOIN cosmetic_items i ON i.id IN (l.banner_id,l.frame_id,l.title_id,l.name_color_id) AND i.is_active=TRUE
      WHERE l.user_id = ANY($1::text[])`, [unique]);
  for (const id of unique) out.set(id, { banner:null, frame:null, title:null, nameColor:null });
  for (const row of rows.rows) {
    const data = out.get(row.user_id);
    if (!data || !row.id) continue;
    const slot = row.kind === 'name_color' ? 'nameColor' : row.kind as keyof CosmeticRenderData;
    if (slot in data) {
      data[slot] = row.kind === 'banner'
        ? { id: row.id, kind: row.kind, asset: row.asset, seed: fnv1a32(`${row.user_id}|${row.id}`) }
        : { id: row.id, kind: row.kind, asset: row.asset };
    }
  }
  return out;
}
