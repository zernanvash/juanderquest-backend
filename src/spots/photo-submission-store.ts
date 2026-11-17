import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import { db } from '../db/index.js';
import { assetStore } from './asset-store.js';
import { spotStore } from './store.js';

export type SpotPhotoSubmissionStatus = 'pending' | 'approved' | 'rejected';

export interface SpotPhotoSubmissionRecord {
  id: string;
  spot_id: string;
  user_id: string;
  asset_id: string;
  caption: string | null;
  status: SpotPhotoSubmissionStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
  spot_name?: string;
  spot_slug?: string;
  spot_municipality?: string;
  uploader_name?: string;
  photo_url?: string;
}

export const MAX_PENDING_PHOTOS_PER_USER_SPOT = 3;
export const MAX_SPOT_GALLERY_PHOTOS = 5;

function iso(v: unknown): string {
  if (!v) return new Date().toISOString();
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function mapPgRow(r: any): SpotPhotoSubmissionRecord {
  return {
    id: r.id,
    spot_id: r.spot_id,
    user_id: r.user_id,
    asset_id: r.asset_id,
    caption: r.caption ?? null,
    status: r.status,
    reviewed_by: r.reviewed_by ?? null,
    reviewed_at: r.reviewed_at ? iso(r.reviewed_at) : null,
    reject_reason: r.reject_reason ?? null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    ...(r.spot_name ? { spot_name: r.spot_name } : {}),
    ...(r.spot_slug ? { spot_slug: r.spot_slug } : {}),
    ...(r.spot_municipality ? { spot_municipality: r.spot_municipality } : {}),
    ...(r.uploader_name ? { uploader_name: r.uploader_name } : {}),
    ...(r.photo_url ? { photo_url: r.photo_url } : {}),
  };
}

class SpotPhotoSubmissionStore {
  private mem = new Map<string, SpotPhotoSubmissionRecord>();

  clearMemory(): void {
    this.mem.clear();
  }

  private enrichMemory(rec: SpotPhotoSubmissionRecord): SpotPhotoSubmissionRecord {
    const spot = spotStore.spots.find((s) => s.id === rec.spot_id);
    const user = db.findUserById(rec.user_id);
    const asset = assetStore.getAssetById(rec.asset_id);
    return {
      ...rec,
      spot_name: spot?.name ?? rec.spot_name,
      spot_slug: spot?.slug ?? rec.spot_slug,
      spot_municipality: spot?.municipality ?? rec.spot_municipality,
      uploader_name: user?.display_name ?? rec.uploader_name,
      photo_url: asset?.url ?? rec.photo_url,
    };
  }

  async create(input: {
    spotId: string;
    userId: string;
    assetId: string;
    caption?: string | null;
  }): Promise<SpotPhotoSubmissionRecord> {
    const cleanCaption = input.caption?.trim() ? input.caption.trim() : null;
    const pool = getPool();

    if (pool) {
      const dupRes = await pool.query(
        `SELECT id FROM spot_photo_submissions
         WHERE user_id = $1 AND spot_id = $2 AND asset_id = $3 AND status = 'pending'
         LIMIT 1`,
        [input.userId, input.spotId, input.assetId],
      );
      if (dupRes.rows.length > 0) {
        const err = new Error('This photo is already pending review for this destination.');
        (err as any).code = 'DUPLICATE_PENDING';
        throw err;
      }

      const cntRes = await pool.query(
        `SELECT COUNT(*)::int AS count FROM spot_photo_submissions
         WHERE user_id = $1 AND spot_id = $2 AND status = 'pending'`,
        [input.userId, input.spotId],
      );
      if (Number(cntRes.rows[0]?.count ?? 0) >= MAX_PENDING_PHOTOS_PER_USER_SPOT) {
        const err = new Error('You already have 3 photos waiting for review at this destination.');
        (err as any).code = 'MAX_PENDING_REACHED';
        throw err;
      }

      const id = `sps_${randomUUID()}`;
      const { rows } = await pool.query(
        `INSERT INTO spot_photo_submissions (id, spot_id, user_id, asset_id, caption, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING *`,
        [id, input.spotId, input.userId, input.assetId, cleanCaption],
      );
      return this.enrichMemory(mapPgRow(rows[0]));
    }

    const pendingForPair = Array.from(this.mem.values()).filter(
      (r) => r.user_id === input.userId && r.spot_id === input.spotId && r.status === 'pending',
    );
    if (pendingForPair.some((r) => r.asset_id === input.assetId)) {
      const err = new Error('This photo is already pending review for this destination.');
      (err as any).code = 'DUPLICATE_PENDING';
      throw err;
    }
    if (pendingForPair.length >= MAX_PENDING_PHOTOS_PER_USER_SPOT) {
      const err = new Error('You already have 3 photos waiting for review at this destination.');
      (err as any).code = 'MAX_PENDING_REACHED';
      throw err;
    }

    const now = new Date().toISOString();
    const rec: SpotPhotoSubmissionRecord = {
      id: `sps_${randomUUID()}`,
      spot_id: input.spotId,
      user_id: input.userId,
      asset_id: input.assetId,
      caption: cleanCaption,
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      reject_reason: null,
      created_at: now,
      updated_at: now,
    };
    this.mem.set(rec.id, rec);
    return this.enrichMemory(rec);
  }

  async findById(id: string): Promise<SpotPhotoSubmissionRecord | null> {
    const pool = getPool();
    if (pool) {
      const { rows } = await pool.query(
        `SELECT sps.*, s.name AS spot_name, s.slug AS spot_slug, s.municipality AS spot_municipality,
                u.display_name AS uploader_name, sa.url AS photo_url
         FROM spot_photo_submissions sps
         LEFT JOIN spots s ON s.id = sps.spot_id
         LEFT JOIN users u ON u.id = sps.user_id
         LEFT JOIN spot_assets sa ON sa.id = sps.asset_id
         WHERE sps.id = $1
         LIMIT 1`,
        [id],
      );
      if (!rows.length) return null;
      return this.enrichMemory(mapPgRow(rows[0]));
    }
    const found = this.mem.get(id);
    return found ? this.enrichMemory(found) : null;
  }

  async list(options: {
    status?: SpotPhotoSubmissionStatus | 'all';
    allowedSpotIds?: Set<string>;
  }): Promise<SpotPhotoSubmissionRecord[]> {
    const pool = getPool();
    const filterStatus = options.status && options.status !== 'all' ? options.status : null;

    if (pool) {
      const params: unknown[] = [];
      let where = '';
      if (filterStatus) {
        params.push(filterStatus);
        where = 'WHERE sps.status = $1';
      }
      const { rows } = await pool.query(
        `SELECT sps.*, s.name AS spot_name, s.slug AS spot_slug, s.municipality AS spot_municipality,
                u.display_name AS uploader_name, sa.url AS photo_url
         FROM spot_photo_submissions sps
         LEFT JOIN spots s ON s.id = sps.spot_id
         LEFT JOIN users u ON u.id = sps.user_id
         LEFT JOIN spot_assets sa ON sa.id = sps.asset_id
         ${where}
         ORDER BY sps.created_at DESC`,
        params,
      );
      return rows
        .map((r: any) => this.enrichMemory(mapPgRow(r)))
        .filter((r) => !options.allowedSpotIds || options.allowedSpotIds.has(r.spot_id));
    }

    return Array.from(this.mem.values())
      .filter((r) => !filterStatus || r.status === filterStatus)
      .filter((r) => !options.allowedSpotIds || options.allowedSpotIds.has(r.spot_id))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map((r) => this.enrichMemory(r));
  }

  async countAttachedForSpot(spotId: string): Promise<number> {
    const pool = getPool();
    if (pool) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM spot_assets WHERE spot_id = $1 AND status = 'attached'`,
        [spotId],
      );
      return Number(rows[0]?.count ?? 0);
    }
    return Array.from(assetStore.assets.values()).filter((a) => a.spot_id === spotId && a.status === 'attached').length;
  }

  async markApproved(id: string, reviewerId: string): Promise<SpotPhotoSubmissionRecord | null> {
    const pool = getPool();
    if (pool) {
      const { rows } = await pool.query(
        `UPDATE spot_photo_submissions
         SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id, reviewerId],
      );
      return rows.length ? this.findById(rows[0].id) : null;
    }
    const existing = this.mem.get(id);
    if (!existing || existing.status !== 'pending') return null;
    const now = new Date().toISOString();
    const updated: SpotPhotoSubmissionRecord = {
      ...existing,
      status: 'approved',
      reviewed_by: reviewerId,
      reviewed_at: now,
      updated_at: now,
    };
    this.mem.set(id, updated);
    return this.enrichMemory(updated);
  }

  async markRejected(id: string, reviewerId: string, reason: string): Promise<SpotPhotoSubmissionRecord | null> {
    const pool = getPool();
    if (pool) {
      const { rows } = await pool.query(
        `UPDATE spot_photo_submissions
         SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), reject_reason = $3, updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id, reviewerId, reason],
      );
      return rows.length ? this.findById(rows[0].id) : null;
    }
    const existing = this.mem.get(id);
    if (!existing || existing.status !== 'pending') return null;
    const now = new Date().toISOString();
    const updated: SpotPhotoSubmissionRecord = {
      ...existing,
      status: 'rejected',
      reviewed_by: reviewerId,
      reviewed_at: now,
      reject_reason: reason,
      updated_at: now,
    };
    this.mem.set(id, updated);
    return this.enrichMemory(updated);
  }
}

export const spotPhotoSubmissionStore = new SpotPhotoSubmissionStore();
