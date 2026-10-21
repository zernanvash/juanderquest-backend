import { createHash } from 'crypto';
import type { Pool } from 'pg';

export interface SpotListFilters {
  search?: string;
  categories?: string[];
  tags?: string[];
  municipality?: string;
  lat?: number;
  lng?: number;
  radius?: number;
  intent?: string;
  userId?: string;
  sort?: 'recommended' | 'newest' | 'nearest' | 'trending';
  hasQuest?: boolean;
  allowTest?: boolean;
  areaId?: string;
  bbox?: [number, number, number, number];
  limit?: number;
  cursor?: string;
}

export interface SpotListPage {
  items: Record<string, any>[];
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

interface CursorPayload {
  v: 1;
  filterHash: string;
  sort: string;
  score?: number;
  distance?: number;
  createdAt: string;
  id: string;
}

function filterHash(filters: SpotListFilters, sort: string): string {
  const { cursor: _cursor, limit: _limit, ...stable } = filters;
  return createHash('sha256').update(JSON.stringify({ ...stable, sort })).digest('hex').slice(0, 20);
}

function decodeCursor(value: string | undefined, expectedHash: string, sort: string): CursorPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CursorPayload;
    if (parsed.v !== 1 || parsed.filterHash !== expectedHash || parsed.sort !== sort ||
        typeof parsed.id !== 'string' || !parsed.id || !Number.isFinite(Date.parse(parsed.createdAt)) ||
        (sort === 'nearest' && !Number.isFinite(parsed.distance)) ||
        (sort !== 'newest' && sort !== 'nearest' && !Number.isFinite(parsed.score))) {
      throw new Error('INVALID_CURSOR');
    }
    return parsed;
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}

function encodeCursor(row: Record<string, any>, hash: string, sort: string): string {
  const payload: CursorPayload = {
    v: 1,
    filterHash: hash,
    sort,
    score: sort === 'trending' ? Number(row.trend_score) : Number(row.recommendation_score),
    distance: row.distance_km === null ? undefined : Number(row.distance_km),
    // Preserve PostgreSQL microseconds; converting through JS Date truncates to
    // milliseconds and can skip rows sharing that timestamp millisecond.
    createdAt: String(row.cursor_created_at),
    id: String(row.id),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

const distanceExpression = `(6371 * 2 * asin(sqrt(
  power(sin(radians(s.gps_lat - $LAT$) / 2), 2) +
  cos(radians($LAT$)) * cos(radians(s.gps_lat)) * power(sin(radians(s.gps_lng - $LNG$) / 2), 2)
)))`;

/** Bounded, database-backed list path. It never hydrates or scans every spot in Node. */
export async function listSpotsPage(pool: Pick<Pool, 'query'>, filters: SpotListFilters): Promise<SpotListPage> {
  const sort = filters.sort || 'recommended';
  const limit = Math.max(1, Math.min(200, Math.floor(filters.limit || 50)));
  const hash = filterHash(filters, sort);
  const cursor = decodeCursor(filters.cursor, hash, sort);
  const values: any[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const where = ["s.status = 'published'"];
  let distanceLatParam: string | undefined;
  let distanceLngParam: string | undefined;
  if (!filters.allowTest) where.push('NOT COALESCE(s.is_test, FALSE)');
  if (filters.search?.trim()) {
    const q = bind(filters.search.trim());
    where.push(`(s.name ILIKE '%' || ${q} || '%' OR s.name % ${q})`);
  }
  if (filters.categories?.length) where.push(`s.category = ANY(${bind(filters.categories)}::text[])`);
  if (filters.tags?.length) where.push(`s.tags ?| ${bind(filters.tags)}::text[]`);
  if (filters.municipality?.trim()) where.push(`lower(s.municipality) = lower(${bind(filters.municipality.trim())})`);
  if (filters.hasQuest) where.push('s.quest_id IS NOT NULL');
  if (filters.lat !== undefined && filters.lng !== undefined) {
    distanceLatParam = bind(filters.lat);
    distanceLngParam = bind(filters.lng);
    const expr = distanceExpression.replaceAll('$LAT$', distanceLatParam).replaceAll('$LNG$', distanceLngParam);
    if (filters.radius !== undefined) where.push(`${expr} <= ${bind(filters.radius)}`);
  }
  if (filters.bbox) {
    const [west, south, east, north] = filters.bbox;
    where.push(`s.gps_lng BETWEEN ${bind(west)} AND ${bind(east)} AND s.gps_lat BETWEEN ${bind(south)} AND ${bind(north)}`);
  }
  if (filters.areaId) {
    const area = bind(filters.areaId);
    where.push(`EXISTS (
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM admin_areas WHERE id = ${area}
        UNION ALL SELECT child.id FROM admin_areas child JOIN descendants parent ON child.parent_id = parent.id
      )
      SELECT 1 FROM descendants d WHERE d.id = s.town_area_id OR d.id = s.barangay_area_id
    )`);
  }

  const hasDistance = filters.lat !== undefined && filters.lng !== undefined;
  const distanceSql = hasDistance
    ? distanceExpression.replaceAll('$LAT$', distanceLatParam!).replaceAll('$LNG$', distanceLngParam!)
    : 'NULL::double precision';
  const trendSql = `(SELECT COUNT(*)::integer FROM spot_activity_events e WHERE e.spot_id = s.id AND e.created_at >= NOW() - INTERVAL '24 hours')`;
  const intentParam = filters.intent?.trim() ? bind(filters.intent.trim()) : undefined;
  const intentScore = intentParam
    ? `(CASE WHEN s.name ILIKE '%' || ${intentParam} || '%' OR s.subcategory ILIKE '%' || ${intentParam} || '%' OR s.category ILIKE '%' || ${intentParam} || '%' OR s.tags::text ILIKE '%' || ${intentParam} || '%' THEN 0.3 ELSE 0 END)`
    : '0::double precision';
  const scoreSql = `(${intentScore} + (CASE s.trust_level WHEN 'lgu_verified' THEN 1.0 WHEN 'editorial' THEN 0.9 WHEN 'open_data' THEN 0.75 ELSE 0.6 END) * 0.55 + (GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - s.created_at)) / 2592000) * 0.1) + (LEAST(1, ${trendSql} / 20.0) * 0.05))`;
  if (cursor) {
    if (sort === 'newest') {
      const created = bind(cursor.createdAt), id = bind(cursor.id);
      where.push(`(s.created_at, s.id) < (${created}::timestamptz, ${id})`);
    } else if (sort === 'nearest') {
      if (!hasDistance) throw new Error('INVALID_CURSOR');
      const dist = bind(cursor.distance), id = bind(cursor.id);
      where.push(`(${distanceSql}, s.id) > (${dist}::double precision, ${id})`);
    } else {
      const score = bind(cursor.score), created = bind(cursor.createdAt), id = bind(cursor.id);
      const orderingScore = sort === 'trending' ? trendSql : scoreSql;
      where.push(`(${orderingScore} < ${score} OR (${orderingScore} = ${score} AND (s.created_at, s.id) < (${created}::timestamptz, ${id})))`);
    }
  }
  const limitParam = bind(limit + 1);
  const orderBy = sort === 'newest'
    ? 's.created_at DESC, s.id DESC'
    : sort === 'nearest' && hasDistance
      ? 'distance_km ASC, s.id ASC'
      : sort === 'trending'
        ? 'trend_score DESC, s.created_at DESC, s.id DESC'
        : 'recommendation_score DESC, s.created_at DESC, s.id DESC';

  const { rows } = await pool.query(
    `SELECT s.*, s.created_at::text AS cursor_created_at,
            ${distanceSql} AS distance_km,
            ${trendSql} AS trend_score,
            ${scoreSql} AS recommendation_score,
            EXISTS (SELECT 1 FROM spot_interactions si WHERE si.spot_id=s.id AND si.interaction_type='save' AND si.user_id=$ACTOR$) AS saved,
            EXISTS (SELECT 1 FROM spot_interactions li WHERE li.spot_id=s.id AND li.interaction_type='like' AND li.user_id=$ACTOR$) AS liked
       FROM spots s
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${limitParam}`.replaceAll('$ACTOR$', bind(filters['userId'] || '')),
    values,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row: Record<string, any>) => {
    const { field_sources: _fieldSources, cursor_created_at: _cursorCreatedAt, ...publicSpot } = row;
    return {
    ...publicSpot,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags || [],
    amenities: typeof row.amenities === 'string' ? JSON.parse(row.amenities) : row.amenities || [],
    good_for: typeof row.good_for === 'string' ? JSON.parse(row.good_for) : row.good_for || [],
    best_time: typeof row.best_time === 'string' ? JSON.parse(row.best_time) : row.best_time || [],
    hours: typeof row.hours === 'string' ? JSON.parse(row.hours) : row.hours || {},
    gps_lat: Number(row.gps_lat), gps_lng: Number(row.gps_lng),
    distance_km: row.distance_km === null ? undefined : Number(row.distance_km),
    trend_score: Number(row.trend_score),
    recommendation_score: Number(Number(row.recommendation_score).toFixed(4)),
  }; });
  return { items, limit, hasMore, nextCursor: hasMore && items.length ? encodeCursor(rows[items.length - 1], hash, sort) : null };
}
