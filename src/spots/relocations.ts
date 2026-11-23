import { randomUUID } from 'crypto';
import { db } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { spotStore } from './store.js';

export interface SpotAuthorSummary {
  id: string;
  handle: string | null;
  display_name: string;
  avatar_url: string;
}

export type RelocationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface SpotRelocationRequest {
  id: string;
  spot_id: string;
  requested_by: string;
  from_lat: number;
  from_lng: number;
  to_lat: number;
  to_lng: number;
  distance_m: number;
  accuracy_m: number | null;
  status: RelocationStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface SpotRelocationListItem extends SpotRelocationRequest {
  spot_name: string;
  spot_slug: string;
  municipality: string;
  town_area_id: string | null;
  author_handle: string | null;
  author_display_name: string;
}

/**
 * Batch-resolve public author summaries for a set of user IDs.
 * Never returns email or private fields. Returns null for missing/deleted users.
 */
export async function resolveSpotAuthors(
  userIds: Array<string | null | undefined>,
): Promise<Map<string, SpotAuthorSummary>> {
  const uniqueIds = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  const result = new Map<string, SpotAuthorSummary>();
  if (uniqueIds.length === 0) return result;

  const pool = getPool();
  if (pool) {
    const queryRes = await pool.query(
      `SELECT id, handle, display_name, avatar_url
       FROM users
       WHERE id = ANY($1::text[])`,
      [uniqueIds],
    );
    for (const row of queryRes.rows) {
      result.set(String(row.id), {
        id: String(row.id),
        handle: row.handle ? String(row.handle) : null,
        display_name: String(row.display_name || 'Traveler'),
        avatar_url: String(row.avatar_url || ''),
      });
    }
    return result;
  }

  for (const id of uniqueIds) {
    const user = db.findUserById(id);
    if (user) {
      result.set(id, {
        id: user.id,
        handle: user.handle ?? null,
        display_name: user.display_name || 'Traveler',
        avatar_url: user.avatar_url || '',
      });
    }
  }
  return result;
}

function mapRelocationRow(row: any): SpotRelocationRequest {
  return {
    id: String(row.id),
    spot_id: String(row.spot_id),
    requested_by: String(row.requested_by),
    from_lat: Number(row.from_lat),
    from_lng: Number(row.from_lng),
    to_lat: Number(row.to_lat),
    to_lng: Number(row.to_lng),
    distance_m: Number(row.distance_m),
    accuracy_m: row.accuracy_m === null || row.accuracy_m === undefined ? null : Number(row.accuracy_m),
    status: String(row.status) as RelocationStatus,
    reviewed_by: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    review_note: row.review_note ? String(row.review_note) : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

class SpotRelocationStore {
  private memory: SpotRelocationRequest[] = [];

  resetMemory(): void {
    this.memory = [];
  }

  async createOrReplacePending(input: {
    spotId: string;
    requestedBy: string;
    fromLat: number;
    fromLng: number;
    toLat: number;
    toLng: number;
    distanceM: number;
    accuracyM?: number | null;
  }): Promise<SpotRelocationRequest> {
    const id = `reloc_${randomUUID()}`;
    const accuracyM = input.accuracyM ?? null;
    const pool = getPool();

    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE spot_relocation_requests
           SET status = 'cancelled'
           WHERE spot_id = $1 AND status = 'pending'`,
          [input.spotId],
        );
        const inserted = await client.query(
          `INSERT INTO spot_relocation_requests (
             id, spot_id, requested_by, from_lat, from_lng, to_lat, to_lng, distance_m, accuracy_m, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
           RETURNING *`,
          [
            id,
            input.spotId,
            input.requestedBy,
            input.fromLat,
            input.fromLng,
            input.toLat,
            input.toLng,
            input.distanceM,
            accuracyM,
          ],
        );
        await client.query('COMMIT');
        return mapRelocationRow(inserted.rows[0]);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    for (const item of this.memory) {
      if (item.spot_id === input.spotId && item.status === 'pending') {
        item.status = 'cancelled';
      }
    }
    const record: SpotRelocationRequest = {
      id,
      spot_id: input.spotId,
      requested_by: input.requestedBy,
      from_lat: input.fromLat,
      from_lng: input.fromLng,
      to_lat: input.toLat,
      to_lng: input.toLng,
      distance_m: input.distanceM,
      accuracy_m: accuracyM,
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      created_at: new Date().toISOString(),
    };
    this.memory.unshift(record);
    return record;
  }

  async findById(id: string): Promise<SpotRelocationRequest | null> {
    const pool = getPool();
    if (pool) {
      const res = await pool.query('SELECT * FROM spot_relocation_requests WHERE id = $1', [id]);
      return res.rows.length ? mapRelocationRow(res.rows[0]) : null;
    }
    return this.memory.find((r) => r.id === id) ?? null;
  }

  async list(options: {
    status: RelocationStatus | 'all';
    allowedSpotIds: Set<string>;
  }): Promise<SpotRelocationListItem[]> {
    const pool = getPool();
    let rows: SpotRelocationRequest[] = [];
    if (pool) {
      const sql =
        options.status === 'all'
          ? 'SELECT * FROM spot_relocation_requests ORDER BY created_at DESC, id DESC LIMIT 200'
          : 'SELECT * FROM spot_relocation_requests WHERE status = $1 ORDER BY created_at DESC, id DESC LIMIT 200';
      const params = options.status === 'all' ? [] : [options.status];
      const res = await pool.query(sql, params);
      rows = res.rows.map(mapRelocationRow);
    } else {
      rows = this.memory
        .filter((r) => options.status === 'all' || r.status === options.status)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    }

    const filtered = rows.filter((r) => options.allowedSpotIds.has(r.spot_id));
    const authors = await resolveSpotAuthors(filtered.map((r) => r.requested_by));
    const spotMap = new Map(spotStore.spots.map((s) => [s.id, s]));

    return filtered.map((r) => {
      const spot = spotMap.get(r.spot_id);
      const author = authors.get(r.requested_by);
      return {
        ...r,
        spot_name: spot?.name ?? r.spot_id,
        spot_slug: spot?.slug ?? r.spot_id,
        municipality: spot?.municipality ?? '',
        town_area_id: spot?.town_area_id ?? null,
        author_handle: author?.handle ?? null,
        author_display_name: author?.display_name ?? 'Traveler',
      };
    });
  }

  async markApproved(id: string, adminId: string): Promise<SpotRelocationRequest | null> {
    const pool = getPool();
    if (pool) {
      const res = await pool.query(
        `UPDATE spot_relocation_requests
         SET status = 'approved', reviewed_by = $2, reviewed_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id, adminId],
      );
      return res.rows.length ? mapRelocationRow(res.rows[0]) : null;
    }
    const found = this.memory.find((r) => r.id === id && r.status === 'pending');
    if (!found) return null;
    found.status = 'approved';
    found.reviewed_by = adminId;
    found.reviewed_at = new Date().toISOString();
    return found;
  }

  async markRejected(id: string, adminId: string, note: string): Promise<SpotRelocationRequest | null> {
    const pool = getPool();
    if (pool) {
      const res = await pool.query(
        `UPDATE spot_relocation_requests
         SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), review_note = $3
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id, adminId, note],
      );
      return res.rows.length ? mapRelocationRow(res.rows[0]) : null;
    }
    const found = this.memory.find((r) => r.id === id && r.status === 'pending');
    if (!found) return null;
    found.status = 'rejected';
    found.reviewed_by = adminId;
    found.reviewed_at = new Date().toISOString();
    found.review_note = note;
    return found;
  }
}

export const spotRelocationStore = new SpotRelocationStore();
