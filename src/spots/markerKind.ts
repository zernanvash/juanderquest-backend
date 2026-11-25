import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { db } from '../db/index.js';

export type MarkerKind = 'spot' | 'merchant' | 'quest';

export interface LocalPartnerSummary {
  merchant_id: string;
  name: string;
  category: string;
  logo_url: string | null;
  is_published: boolean;
}

export interface SpotMarkerClassification {
  marker_kind: MarkerKind;
  is_local_partner: boolean;
  merchant_id: string | null;
  merchant_name: string | null;
  local_partner: LocalPartnerSummary | null;
  active_quest_count: number;
  active_quest_ids: string[];
}

export function classifySpotMarker(input: {
  activeQuestIds: string[];
  localPartner: LocalPartnerSummary | null;
  marketplaceEnabled?: boolean;
}): SpotMarkerClassification {
  const marketplaceEnabled = input.marketplaceEnabled ?? env.MARKETPLACE_ENABLED;
  const partner = marketplaceEnabled ? input.localPartner : null;
  const activeQuestIds = input.activeQuestIds;
  const markerKind: MarkerKind = activeQuestIds.length > 0 ? 'quest' : partner != null ? 'merchant' : 'spot';
  return {
    marker_kind: markerKind,
    is_local_partner: partner != null,
    merchant_id: partner?.merchant_id ?? null,
    merchant_name: partner?.name ?? null,
    local_partner: partner,
    active_quest_count: activeQuestIds.length,
    active_quest_ids: activeQuestIds,
  };
}

export function emptySpotMarkerClassification(): SpotMarkerClassification {
  return {
    marker_kind: 'spot',
    is_local_partner: false,
    merchant_id: null,
    merchant_name: null,
    local_partner: null,
    active_quest_count: 0,
    active_quest_ids: [],
  };
}

export interface SpotMarkerTarget {
  id: string;
  is_test?: boolean;
}

/**
 * Loads active quest bindings and active linked Local Partners for a batch of spots
 * in at most 2 queries (1 query when MARKETPLACE_ENABLED is false) — zero N+1.
 */
export async function loadSpotMarkerMeta(
  pool: Pick<Pool, 'query'> | null,
  spots: SpotMarkerTarget[],
  options?: { allowTest?: boolean; marketplaceEnabled?: boolean },
): Promise<Map<string, SpotMarkerClassification>> {
  const result = new Map<string, SpotMarkerClassification>();
  if (spots.length === 0) return result;

  const marketplaceEnabled = options?.marketplaceEnabled ?? env.MARKETPLACE_ENABLED;
  const allowTest = Boolean(options?.allowTest);
  const spotIsTest = new Map<string, boolean>();
  const spotIds: string[] = [];
  for (const s of spots) {
    if (!spotIsTest.has(s.id)) {
      spotIsTest.set(s.id, Boolean(s.is_test));
      spotIds.push(s.id);
    }
  }

  const questsBySpot = new Map<string, string[]>();
  const partnerBySpot = new Map<string, LocalPartnerSummary>();

  if (pool) {
    const questPromise = pool
      .query(
        allowTest
          ? `SELECT b.spot_id, q.id AS quest_id, q.is_test
               FROM reviewed_quest_spot_bindings b
               JOIN quests q ON q.id = b.quest_id
              WHERE b.status = 'active'
                AND q.status = 'published'
                AND q.is_active = TRUE
                AND b.spot_id = ANY($1::text[])
              ORDER BY q.created_at ASC, q.id ASC`
          : `SELECT b.spot_id, q.id AS quest_id, q.is_test
               FROM reviewed_quest_spot_bindings b
               JOIN quests q ON q.id = b.quest_id
              WHERE b.status = 'active'
                AND q.status = 'published'
                AND q.is_active = TRUE
                AND q.is_test = FALSE
                AND b.spot_id = ANY($1::text[])
              ORDER BY q.created_at ASC, q.id ASC`,
        [spotIds],
      )
      .catch(() => ({ rows: [] as any[] }));

    const merchantPromise = marketplaceEnabled
      ? pool
          .query(
            allowTest
              ? `SELECT id, name, category, logo_url, is_published, spot_id, is_test
                   FROM merchants
                  WHERE status = 'active'
                    AND spot_id = ANY($1::text[])`
              : `SELECT id, name, category, logo_url, is_published, spot_id, is_test
                   FROM merchants
                  WHERE status = 'active'
                    AND is_test = FALSE
                    AND spot_id = ANY($1::text[])`,
            [spotIds],
          )
          .catch(() => ({ rows: [] as any[] }))
      : Promise.resolve({ rows: [] as any[] });

    const [questRes, merchantRes] = await Promise.all([questPromise, merchantPromise]);

    for (const row of questRes.rows) {
      const sid = String(row.spot_id);
      const qid = String(row.quest_id);
      if (Boolean(row.is_test) !== (spotIsTest.get(sid) ?? false)) continue;
      let list = questsBySpot.get(sid);
      if (!list) {
        list = [];
        questsBySpot.set(sid, list);
      }
      if (!list.includes(qid)) list.push(qid);
    }

    if (marketplaceEnabled) {
      for (const row of merchantRes.rows) {
        const sid = String(row.spot_id);
        if (Boolean(row.is_test) !== (spotIsTest.get(sid) ?? false)) continue;
        partnerBySpot.set(sid, {
          merchant_id: String(row.id),
          name: String(row.name),
          category: String(row.category ?? 'Local Business'),
          logo_url: row.logo_url ? String(row.logo_url) : null,
          is_published: Boolean(row.is_published),
        });
      }
    }
  } else if (marketplaceEnabled) {
    for (const m of db.listMerchants()) {
      if ((m.status ?? 'active') !== 'active' || !m.spot_id) continue;
      if (!spotIsTest.has(m.spot_id)) continue;
      if (Boolean(m.is_test) !== (spotIsTest.get(m.spot_id) ?? false)) continue;
      partnerBySpot.set(m.spot_id, {
        merchant_id: m.id,
        name: m.name,
        category: m.category ?? 'Local Business',
        logo_url: m.logo_url ?? null,
        is_published: Boolean(m.is_published),
      });
    }
  }

  for (const sid of spotIds) {
    result.set(
      sid,
      classifySpotMarker({
        activeQuestIds: questsBySpot.get(sid) ?? [],
        localPartner: partnerBySpot.get(sid) ?? null,
        marketplaceEnabled,
      }),
    );
  }
  return result;
}

/**
 * Returns the set of spot IDs currently linked to an active merchant (for GET /spots?local_partner=true).
 * Always empty when MARKETPLACE_ENABLED is false.
 */
export async function loadActiveLocalPartnerSpotIds(
  pool: Pick<Pool, 'query'> | null,
  options?: { allowTest?: boolean; marketplaceEnabled?: boolean },
): Promise<Set<string>> {
  const marketplaceEnabled = options?.marketplaceEnabled ?? env.MARKETPLACE_ENABLED;
  if (!marketplaceEnabled) return new Set();
  const allowTest = Boolean(options?.allowTest);

  if (pool) {
    const res = await pool
      .query(
        allowTest
          ? `SELECT spot_id FROM merchants WHERE status = 'active' AND spot_id IS NOT NULL`
          : `SELECT spot_id FROM merchants WHERE status = 'active' AND is_test = FALSE AND spot_id IS NOT NULL`,
      )
      .catch(() => ({ rows: [] as any[] }));
    return new Set(res.rows.map((r: any) => String(r.spot_id)));
  }

  const out = new Set<string>();
  for (const m of db.listMerchants()) {
    if ((m.status ?? 'active') !== 'active' || !m.spot_id) continue;
    if (!allowTest && m.is_test) continue;
    out.add(m.spot_id);
  }
  return out;
}
