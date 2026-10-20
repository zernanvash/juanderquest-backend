import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Pool } from 'pg';
import { getPool } from '../db/pool.js';
import { spotStore } from '../spots/store.js';
import { createCirclePolygon } from '../maps/geometry.js';

export const areasRouter = Router();

async function queryWithRetry(pool: Pool, text: string, values?: any[], retries = 6) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await pool.query(text, values);
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      const isTransientTimeout =
        msg.includes('timeout') ||
        msg.includes('connection terminated') ||
        msg.includes('econnreset');
      if (!isTransientTimeout || attempt === retries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

function resolveGeoJsonPath(filename: string): string {
  const candidates = [
    process.env.JDQ_MAPS_DIR ? path.join(process.env.JDQ_MAPS_DIR, filename) : null,
    path.resolve(process.cwd(), 'data/maps', filename),
    path.resolve(__dirname, '../../data/maps', filename),
    path.join(os.homedir(), 'jdq-maps/areas', filename),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const townsPath = resolveGeoJsonPath('towns.geojson');
const barangaysPath = resolveGeoJsonPath('barangays.geojson');
const provincePath = resolveGeoJsonPath('province.geojson');

let cachedTownFeatures: Map<string, any> | null = null;
let cachedBgyFeatures: Map<string, any> | null = null;
let cachedProvinceFeature: any | null = null;

function loadGeoJsonFeatures() {
  if (!cachedProvinceFeature && fs.existsSync(provincePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(provincePath, 'utf8'));
      cachedProvinceFeature = data.features ? data.features[0] : data;
    } catch (e) {
      console.error('[areas] failed to load province.geojson', e);
    }
  }

  if (!cachedTownFeatures && fs.existsSync(townsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(townsPath, 'utf8'));
      cachedTownFeatures = new Map();
      for (const feat of data.features || []) {
        const psgc = String(feat.properties?.adm3_psgc);
        cachedTownFeatures.set(psgc, feat);
      }
    } catch (e) {
      console.error('[areas] failed to load towns.geojson', e);
    }
  }

  if (!cachedBgyFeatures && fs.existsSync(barangaysPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(barangaysPath, 'utf8'));
      cachedBgyFeatures = new Map();
      for (const feat of data.features || []) {
        const psgc = String(feat.properties?.adm4_psgc);
        cachedBgyFeatures.set(psgc, feat);
      }
    } catch (e) {
      console.error('[areas] failed to load barangays.geojson', e);
    }
  }
}

/**
 * GET /api/v1/areas?bbox=minLng,minLat,maxLng,maxLat&zoom=10
 */
areasRouter.get('/areas', async (req: Request, res: Response) => {
  const pool = getPool();
  res.setHeader('Cache-Control', 'public, max-age=300');

  const zoomStr = req.query.zoom as string | undefined;
  const zoom = zoomStr ? Number(zoomStr) : 9;

  let minLng = -180, minLat = -90, maxLng = 180, maxLat = 90;
  if (typeof req.query.bbox === 'string') {
    const parts = req.query.bbox.split(',').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      [minLng, minLat, maxLng, maxLat] = parts;
    }
  }

  if (pool) {
    try {
      // Filter by min_zoom and spatial bbox intersection (overlap condition):
      // a.bbox is [minLng, minLat, maxLng, maxLat]
      // Viewport is [minLng, minLat, maxLng, maxLat]
      // Overlap: a.bbox[1] <= :maxLng AND a.bbox[3] >= :minLng AND a.bbox[2] <= :maxLat AND a.bbox[4] >= :minLat
      const query = `
        SELECT a.id, a.level, a.name, a.display_name, a.label_lat, a.label_lng,
               a.has_boundary, a.bbox, a.min_zoom, a.parent_id,
               COUNT(s.id) FILTER (WHERE s.status = 'published' AND NOT s.is_test) AS published_spot_count
        FROM admin_areas a
        LEFT JOIN spots s ON (s.town_area_id = a.id OR s.barangay_area_id = a.id)
        WHERE a.min_zoom <= $1
          AND a.bbox[1] <= $2 AND a.bbox[3] >= $3
          AND a.bbox[2] <= $4 AND a.bbox[4] >= $5
        GROUP BY a.id
        ORDER BY published_spot_count DESC, a.name ASC
        LIMIT 500
      `;
      const result = await queryWithRetry(pool, query, [zoom, maxLng, minLng, maxLat, minLat]);
      const items = result.rows.map((r) => ({
        id: r.id,
        level: r.level,
        name: r.name,
        display_name: r.display_name,
        label_lat: Number(r.label_lat),
        label_lng: Number(r.label_lng),
        has_boundary: Boolean(r.has_boundary),
        bbox: r.bbox,
        parent_id: r.parent_id,
        published_spot_count: Number(r.published_spot_count),
      }));

      return res.json({ success: true, data: items, meta: { count: items.length } });
    } catch (error) {
      console.error('[areas] Error querying admin_areas from database:', error);
      return res.status(500).json({
        success: false,
        error: { code: 'DATABASE_ERROR', message: 'Failed to query admin areas from database.' },
      });
    }
  }

  // When database pool is unavailable, return 503 Service Unavailable
  return res.status(503).json({
    success: false,
    error: { code: 'SERVICE_UNAVAILABLE', message: 'Database pool is unavailable.' },
  });
});

/**
 * GET /api/v1/areas/:id
 */
areasRouter.get('/areas/:id', async (req: Request, res: Response) => {
  const areaId = req.params.id;
  const pool = getPool();
  res.setHeader('Cache-Control', 'public, max-age=300');

  if (pool) {
    try {
      const result = await queryWithRetry(
        pool,
        `SELECT a.id, a.psgc_code, a.level, a.name, a.display_name, a.parent_id,
                a.has_boundary, a.label_lat, a.label_lng, a.bbox,
                COUNT(s.id) FILTER (WHERE s.status = 'published' AND NOT s.is_test) AS published_spot_count
         FROM admin_areas a
         LEFT JOIN spots s ON (s.town_area_id = a.id OR s.barangay_area_id = a.id)
         WHERE a.id = $1
         GROUP BY a.id`,
        [areaId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: { code: 'AREA_NOT_FOUND', message: `Area ${areaId} not found.` },
        });
      }

      const area = result.rows[0];

      // Build parent chain breadcrumb
      const parents: any[] = [];
      let currentParentId = area.parent_id;
      while (currentParentId) {
        const pRes = await queryWithRetry(pool, `SELECT id, name, level, parent_id FROM admin_areas WHERE id = $1`, [currentParentId]);
        if (pRes.rows.length === 0) break;
        const p = pRes.rows[0];
        parents.unshift({ id: p.id, name: p.name, level: p.level });
        currentParentId = p.parent_id;
      }

      return res.json({
        success: true,
        data: {
          id: area.id,
          psgc_code: area.psgc_code,
          level: area.level,
          name: area.name,
          display_name: area.display_name,
          parent_id: area.parent_id,
          has_boundary: Boolean(area.has_boundary),
          label_lat: Number(area.label_lat),
          label_lng: Number(area.label_lng),
          bbox: area.bbox,
          published_spot_count: Number(area.published_spot_count),
          parents,
        },
      });
    } catch (error) {
      console.error(`[areas] Error querying admin_area ${areaId} from database:`, error);
      return res.status(500).json({
        success: false,
        error: { code: 'DATABASE_ERROR', message: `Failed to query area ${areaId} from database.` },
      });
    }
  }

  return res.status(404).json({
    success: false,
    error: { code: 'AREA_NOT_FOUND', message: `Area ${areaId} not found.` },
  });
});

/**
 * GET /api/v1/areas/:id/shape
 */
areasRouter.get('/areas/:id/shape', async (req: Request, res: Response) => {
  const areaId = req.params.id;
  const pool = getPool();
  res.setHeader('Cache-Control', 'public, max-age=86400');

  loadGeoJsonFeatures();

  let areaRow: any = null;
  if (pool) {
    try {
      const result = await queryWithRetry(pool, `SELECT * FROM admin_areas WHERE id = $1`, [areaId]);
      if (result.rows.length > 0) {
        areaRow = result.rows[0];
      }
    } catch (error) {
      console.error(`[areas] Error querying admin_area shape for ${areaId}:`, error);
      return res.status(500).json({
        success: false,
        error: { code: 'DATABASE_ERROR', message: `Failed to query shape for area ${areaId}.` },
      });
    }
  }

  if (!areaRow) {
    return res.status(404).json({
      success: false,
      error: { code: 'AREA_NOT_FOUND', message: `Area ${areaId} not found.` },
    });
  }

  const psgcStr = String(areaRow.psgc_code);

  if (areaRow.has_boundary) {
    if (areaRow.level === 'province' || areaRow.id === 'pangasinan') {
      if (cachedProvinceFeature) {
        return res.json({
          type: 'Feature',
          properties: {
            id: areaRow.id,
            name: areaRow.name,
            display_name: areaRow.display_name,
            level: areaRow.level,
            has_boundary: true,
          },
          geometry: cachedProvinceFeature.geometry,
        });
      }
    }

    let feature = cachedTownFeatures?.get(psgcStr) || cachedBgyFeatures?.get(psgcStr);
    if (feature) {
      return res.json({
        type: 'Feature',
        properties: {
          id: areaRow.id,
          name: areaRow.name,
          display_name: areaRow.display_name,
          level: areaRow.level,
          has_boundary: true,
        },
        geometry: feature.geometry,
      });
    }
  }

  // §4 fallback: return a 600m circular polygon for places without exact polygons
  const circleCoords = createCirclePolygon(Number(areaRow.label_lng), Number(areaRow.label_lat), 600);
  return res.json({
    type: 'Feature',
    properties: {
      id: areaRow.id,
      name: areaRow.name,
      display_name: areaRow.display_name,
      level: areaRow.level,
      has_boundary: false,
      is_fallback_circle: true,
    },
    geometry: {
      type: 'Polygon',
      coordinates: circleCoords,
    },
  });
});

/**
 * GET /api/v1/areas/:id/spots
 */
areasRouter.get('/areas/:id/spots', async (req: Request, res: Response) => {
  const areaId = req.params.id;
  const pool = getPool();
  res.setHeader('Cache-Control', 'public, max-age=300');

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  if (pool) {
    try {
      const isProvince = areaId === 'pangasinan';
      const countRes = await queryWithRetry(
        pool,
        isProvince
          ? `SELECT COUNT(*) FROM spots WHERE status = 'published' AND NOT is_test`
          : `SELECT COUNT(*) FROM spots WHERE (town_area_id = $1 OR barangay_area_id = $1) AND status = 'published' AND NOT is_test`,
        isProvince ? [] : [areaId]
      );
      const total = Number(countRes.rows[0]?.count || 0);

      const spotsRes = await queryWithRetry(
        pool,
        isProvince
          ? `SELECT * FROM spots WHERE status = 'published' AND NOT is_test
             ORDER BY created_at DESC
             LIMIT $1 OFFSET $2`
          : `SELECT * FROM spots WHERE (town_area_id = $1 OR barangay_area_id = $1) AND status = 'published' AND NOT is_test
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
        isProvince ? [limit, offset] : [areaId, limit, offset]
      );

      return res.json({
        success: true,
        data: spotsRes.rows,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error(`[areas] Error querying spots for area ${areaId}:`, error);
      return res.status(500).json({
        success: false,
        error: { code: 'DATABASE_ERROR', message: `Failed to query spots for area ${areaId}.` },
      });
    }
  }

  // Store in-memory fallback
  const matching = spotStore.spots.filter(
    (s) =>
      (s.town_area_id === areaId || s.barangay_area_id === areaId || s.municipality.toLowerCase() === areaId.toLowerCase()) &&
      s.status === 'published' &&
      !s.is_test
  );

  return res.json({
    success: true,
    data: matching.slice(offset, offset + limit),
    meta: {
      total: matching.length,
      page,
      limit,
      totalPages: Math.ceil(matching.length / limit),
    },
  });
});
