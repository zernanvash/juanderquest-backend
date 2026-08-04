import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSpotPhotoStorageProvider, SpotPhotoSaveResult } from '../storage/spot-photos.js';

export interface SpotAssetRecord {
  id: string;
  user_id: string;
  storage_provider: 'local' | 'azure';
  object_key: string;
  url: string;
  mime_type: string;
  width: number;
  height: number;
  size_bytes: number;
  status: 'pending' | 'attached' | 'deleted';
  spot_id?: string | null;
  created_at: string;
  updated_at: string;
}

export class SpotAssetStore {
  assets = new Map<string, SpotAssetRecord>();
  private pg: Pool | null = null;

  async hydrateFromPg(pool: Pool) {
    this.pg = pool;
    const { rows } = await pool.query('SELECT * FROM spot_assets ORDER BY created_at');
    for (const r of rows) {
      this.assets.set(r.id, {
        ...r,
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      });
    }
  }

  async createPendingAsset(
    userId: string,
    saveResult: SpotPhotoSaveResult,
    providerName: 'local' | 'azure'
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
        ]
      );
    }

    return record;
  }

  getAssetById(id: string): SpotAssetRecord | undefined {
    return this.assets.get(id);
  }

  async attachAssetsToSpot(assetIds: string[], userId: string, spotId: string): Promise<SpotAssetRecord[]> {
    if (assetIds.length > 5) {
      const err = new Error('A spot can have at most 5 images.');
      (err as any).code = 'MAX_IMAGES_EXCEEDED';
      throw err;
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
        await this.pg.query(
          `UPDATE spot_assets SET status = $1, spot_id = $2, updated_at = $3 WHERE id = $4`,
          [asset.status, asset.spot_id, asset.updated_at, asset.id]
        );
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
        } catch (e) {
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
