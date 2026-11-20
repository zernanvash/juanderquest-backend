import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSpotPhotoStorageProvider, SpotMediaSaveResult } from '../storage/spot-photos.js';
import { MediaType } from '../utils/media-mime.js';
import { recordActivity } from '../social/activity.js';

export interface SpotAssetRecord {
  id: string;
  user_id: string;
  storage_provider: 'local' | 'azure';
  object_key: string;
  url: string;
  mime_type: string;
  media_type: MediaType;
  width: number;
  height: number;
  size_bytes: number;
  // 'approved' = licensed catalog photo (Plan 116, migration 111); never counts as a user upload.
  status: 'pending' | 'attached' | 'deleted' | 'approved';
  spot_id?: string | null;
  created_at: string;
  updated_at: string;
  source?: string | null;
  license?: string | null;
  license_url?: string | null;
  author?: string | null;
  attribution_url?: string | null;
  blurhash?: string | null;
  dominant_color?: string | null;
  variants?: Record<string, string> | null;
  is_primary?: boolean;
  sort_order?: number | null;
}

/** Plan 116 §6.3 spot payload photo (licensed catalog photo with its required credit). */
export interface SpotCatalogPhoto {
  id: string;
  url: string;
  variants: Record<string, string>;
  width: number;
  height: number;
  blurhash: string | null;
  dominant_color: string | null;
  is_primary: boolean;
  author: string;
  license: string;
  license_url: string | null;
  attribution_url: string | null;
  source: string;
  attribution: string;
  // Same credit under the names the mobile app already renders (SpotPhoto.sourceName/sourceUrl),
  // so CC BY / BY-SA credit shows without an app update.
  source_name: string;
  source_url: string | null;
  mime_type: string;
  media_type: 'image';
}

export class SpotAssetStore {
  assets = new Map<string, SpotAssetRecord>();
  private pg: Pool | null = null;

  async hydrateFromPg(pool: Pool) {
    this.pg = pool;
    const { rows } = await pool.query('SELECT * FROM spot_assets ORDER BY created_at');
    for (const r of rows) {
      const isVideo = r.mime_type?.startsWith('video/') || r.object_key?.includes('video');
      this.assets.set(r.id, {
        ...r,
        media_type: r.media_type || (isVideo ? 'video' : 'image'),
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      });
    }
  }

  /** Licensed catalog photos for a spot: primary first, then sort_order. */
  catalogPhotos(spotId: string): SpotCatalogPhoto[] {
    return Array.from(this.assets.values())
      .filter((a) => a.spot_id === spotId && a.status === 'approved' && a.source && a.license && a.author)
      .sort(
        (a, b) =>
          Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)) ||
          (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .map((a) => {
        const attribution = `Photo: ${a.author} / ${a.source === 'commons' ? 'Wikimedia Commons' : a.source}, ${a.license}`;
        return {
        id: a.id,
        url: a.variants?.w640 || a.url,
        variants: a.variants || {},
        width: a.width,
        height: a.height,
        blurhash: a.blurhash ?? null,
        dominant_color: a.dominant_color ?? null,
        is_primary: Boolean(a.is_primary),
        author: a.author!,
        license: a.license!,
        license_url: a.license_url ?? null,
        attribution_url: a.attribution_url ?? null,
        source: a.source!,
        attribution,
        source_name: attribution,
        source_url: a.attribution_url ?? a.license_url ?? null,
        mime_type: 'image/webp',
        media_type: 'image' as const,
        };
      });
  }

  async createPendingAsset(
    userId: string,
    saveResult: SpotMediaSaveResult,
    providerName: 'local' | 'azure',
  ): Promise<SpotAssetRecord> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    const record: SpotAssetRecord = {
      id,
      user_id: userId,
      storage_provider: providerName,
      object_key: saveResult.object_key,
      url: saveResult.url,
      mime_type: saveResult.mime_type,
      media_type: saveResult.media_type || 'image',
      width: saveResult.width,
      height: saveResult.height,
      size_bytes: saveResult.size_bytes,
      status: 'pending',
      spot_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    this.assets.set(id, record);

    if (this.pg) {
      await this.pg.query(
        `INSERT INTO spot_assets (id, user_id, storage_provider, object_key, url, mime_type, width, height, size_bytes, status, spot_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          record.id,
          record.user_id,
          record.storage_provider,
          record.object_key,
          record.url,
          record.mime_type,
          record.width,
          record.height,
          record.size_bytes,
          record.status,
          record.spot_id,
          record.created_at,
          record.updated_at,
        ],
      );
    }

    return record;
  }

  getAssetById(id: string): SpotAssetRecord | undefined {
    return this.assets.get(id);
  }

  async resolveAssetById(id: string, pool?: Pool | null): Promise<SpotAssetRecord | undefined> {
    const cached = this.assets.get(id);
    if (cached) return cached;
    const pg = pool ?? this.pg;
    if (!pg) return undefined;
    this.pg = pg;
    const { rows } = await pg.query('SELECT * FROM spot_assets WHERE id = $1 LIMIT 1', [id]);
    if (!rows.length) return undefined;
    const r = rows[0];
    const isVideo = r.mime_type?.startsWith('video/') || r.object_key?.includes('video');
    const record: SpotAssetRecord = {
      ...r,
      media_type: r.media_type || (isVideo ? 'video' : 'image'),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
    this.assets.set(record.id, record);
    return record;
  }

  async attachAssetsToSpot(
    assetIds: string[],
    userId: string,
    spotId: string,
    pool?: Pool | null,
  ): Promise<SpotAssetRecord[]> {
    if (pool && !this.pg) {
      this.pg = pool;
    }
    if (assetIds.length > 5) {
      const err = new Error('A spot can have at most 5 media attachments.');
      (err as any).code = 'MAX_IMAGES_EXCEEDED';
      throw err;
    }

    let priorPhotoCount = 0;
    if (this.pg) {
      const priorRes = await this.pg.query(
        `SELECT COUNT(*)::int AS count FROM spot_assets WHERE spot_id = $1 AND status = 'attached'`,
        [spotId],
      );
      priorPhotoCount = Number(priorRes.rows[0]?.count || 0);
    }

    const attachedRecords: SpotAssetRecord[] = [];

    for (const assetId of assetIds) {
      const asset = this.assets.get(assetId);
      if (!asset || asset.status === 'deleted') {
        const err = new Error(`Asset ${assetId} not found.`);
        (err as any).code = 'NOT_FOUND';
        throw err;
      }

      if (asset.user_id !== userId) {
        const err = new Error(`Unauthorized: asset ${assetId} belongs to another user.`);
        (err as any).code = 'UNAUTHORIZED_ATTACHMENT';
        throw err;
      }

      asset.status = 'attached';
      asset.spot_id = spotId;
      asset.updated_at = new Date().toISOString();

      attachedRecords.push(asset);

      if (this.pg) {
        await this.pg.query(`UPDATE spot_assets SET status = $1, spot_id = $2, updated_at = $3 WHERE id = $4`, [
          asset.status,
          asset.spot_id,
          asset.updated_at,
          asset.id,
        ]);
      }
    }

    if (this.pg && priorPhotoCount === 0 && attachedRecords.length > 0) {
      try {
        const spotRes = await this.pg.query(
          `SELECT id, name, slug, municipality, is_test FROM spots WHERE id = $1 LIMIT 1`,
          [spotId],
        );
        if (spotRes.rows.length) {
          const s = spotRes.rows[0];
          await recordActivity(this.pg, {
            eventKey: `first_photo:${spotId}`,
            actorId: userId,
            verb: 'first_photo',
            subjectType: 'spot',
            subjectId: spotId,
            subjectTitle: s.name,
            subjectHref: `/spots/${s.slug || spotId}`,
            municipality: s.municipality || null,
            payload: {},
            isTest: Boolean(s.is_test),
          });
        }
      } catch (err) {
        console.error('[social:producer] Failed to record first_photo activity:', err);
      }
    }

    return attachedRecords;
  }

  async cleanupAbandonedSpotPhotos(expirationHours = 24): Promise<number> {
    const cutoffTime = Date.now() - expirationHours * 60 * 60 * 1000;
    const storageProvider = getSpotPhotoStorageProvider();
    let count = 0;

    for (const asset of Array.from(this.assets.values())) {
      if (asset.status === 'pending' && Date.parse(asset.created_at) < cutoffTime) {
        try {
          await storageProvider.deletePhoto(asset.object_key);
        } catch (_e) {
          // Continue cleanup even if physical deletion throws
        }
        asset.status = 'deleted';
        asset.updated_at = new Date().toISOString();
        count++;

        if (this.pg) {
          await this.pg.query(`UPDATE spot_assets SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [
            asset.id,
          ]);
        }
      }
    }

    return count;
  }
}

export const assetStore = new SpotAssetStore();
