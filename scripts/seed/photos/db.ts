import { Pool } from 'pg';
import type { SpotRef } from './types.js';

export const CATALOG_SOURCES = ['commons', 'openverse', 'flickr', 'mapillary'];

export function pool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString: url, max: 4 });
}

export interface SpotRow extends SpotRef {
  municipality: string;
}

/** Spots that may get catalog photos: not test rows, not rejected/archived. */
export async function loadSpots(db: Pool, ids?: string[]): Promise<SpotRow[]> {
  const r = await db.query<{
    id: string;
    name: string;
    gps_lat: number;
    gps_lng: number;
    municipality: string;
    external_refs: Record<string, string>;
  }>(
    `SELECT id, name, gps_lat, gps_lng, municipality, external_refs
       FROM spots
      WHERE NOT is_test AND status NOT IN ('rejected', 'archived')
        AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL
        AND ($1::text[] IS NULL OR id = ANY($1))
      ORDER BY id`,
    [ids && ids.length ? ids : null],
  );
  return r.rows.map((s) => ({
    spot_id: s.id,
    name: s.name,
    lat: Number(s.gps_lat),
    lng: Number(s.gps_lng),
    municipality: s.municipality,
    wikidata: s.external_refs?.wikidata,
    osm: s.external_refs?.osm,
  }));
}
