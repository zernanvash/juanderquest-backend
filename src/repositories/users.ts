import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { UserRow, decodeFollowCursor, encodeFollowCursor } from '../db/index.js';

export interface CreateUserData {
  id?: string;
  seed_id: string;
  display_name: string;
  email: string;
  avatar_url?: string;
  role?: 'user' | 'admin';
  demo_points?: number;
  mjdq_balance?: number;
  jdq_governance_balance?: number;
  scout_reputation?: number;
  is_public?: boolean;
  handle?: string | null;
  bio?: string | null;
  status_text?: string | null;
}

export class UsersRepository {
  constructor(private pool: Pool | null) {}

  setPool(pool: Pool | null) {
    this.pool = pool;
  }

  getPool(): Pool | null {
    return this.pool;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    if (!this.pool) return undefined;
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (!rows.length) return undefined;
    return this.mapRow(rows[0]);
  }

  async findBySeedId(seedId: string): Promise<UserRow | undefined> {
    if (!this.pool) return undefined;
    const { rows } = await this.pool.query('SELECT * FROM users WHERE seed_id = $1', [seedId]);
    if (!rows.length) return undefined;
    return this.mapRow(rows[0]);
  }

  async findOrCreateBySeedId(data: CreateUserData): Promise<UserRow> {
    const id = data.id || randomUUID();
    const role = data.role || 'user';
    const demoPoints = data.demo_points ?? 100;
    const isPublic = Boolean(data.is_public);
    const avatarUrl =
      data.avatar_url ||
      `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(data.seed_id)}`;

    if (!this.pool) {
      const now = new Date().toISOString();
      return {
        id,
        seed_id: data.seed_id,
        display_name: data.display_name,
        email: data.email,
        avatar_url: avatarUrl,
        role,
        demo_points: demoPoints,
        mjdq_balance: data.mjdq_balance ?? demoPoints * 1000,
        jdq_governance_balance: data.jdq_governance_balance ?? 15,
        scout_reputation: data.scout_reputation ?? 250,
        is_public: isPublic,
        handle: data.handle ?? null,
        bio: data.bio ?? null,
        status_text: data.status_text ?? null,
        created_at: now,
        updated_at: now,
      };
    }

    // Atomic ON CONFLICT DO UPDATE ensures concurrent create-or-find resolves to the single committed row
    const query = `
      INSERT INTO users (
        id, seed_id, display_name, email, avatar_url, role, demo_points, is_public, handle, bio, status_text, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
      ON CONFLICT (seed_id) DO UPDATE
      SET updated_at = NOW()
      RETURNING *
    `;

    const values = [
      id,
      data.seed_id,
      data.display_name,
      data.email,
      avatarUrl,
      role,
      demoPoints,
      isPublic,
      data.handle ?? null,
      data.bio ?? null,
      data.status_text ?? null,
    ];

    const { rows } = await this.pool.query(query, values);
    return this.mapRow(rows[0]);
  }

  async findPublicById(id: string, allowTest = false): Promise<UserRow | undefined> {
    if (!this.pool) return undefined;
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE id = $1 AND is_public = TRUE AND ($2 = TRUE OR COALESCE(is_test, FALSE) = FALSE)',
      [id, allowTest]
    );
    if (!rows.length) return undefined;
    return this.mapRow(rows[0]);
  }

  async findPublicByHandle(rawHandle: string, allowTest = false): Promise<UserRow | undefined> {
    if (!this.pool) return undefined;
    const clean = rawHandle.replace(/^@/, '').toLowerCase().trim();
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE LOWER(handle) = $1 AND is_public = TRUE AND ($2 = TRUE OR COALESCE(is_test, FALSE) = FALSE)',
      [clean, allowTest]
    );
    if (!rows.length) return undefined;
    return this.mapRow(rows[0]);
  }

  async updateProfile(
    userId: string,
    updates: {
      display_name?: string;
      is_public?: boolean;
      handle?: string | null;
      bio?: string | null;
      status_text?: string | null;
    }
  ): Promise<UserRow | undefined> {
    if (!this.pool) return undefined;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: locked } = await client.query('SELECT id, is_public FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!locked.length) {
        await client.query('ROLLBACK');
        return undefined;
      }

      const setClauses: string[] = ['updated_at = NOW()'];
      const values: any[] = [userId];
      let pIdx = 2;

      if (updates.display_name !== undefined) {
        setClauses.push(`display_name = $${pIdx++}`);
        values.push(updates.display_name);
      }
      if (updates.is_public !== undefined) {
        setClauses.push(`is_public = $${pIdx++}`);
        values.push(Boolean(updates.is_public));
      }
      if (updates.handle !== undefined) {
        setClauses.push(`handle = $${pIdx++}`);
        const norm = updates.handle ? updates.handle.replace(/^@/, '').toLowerCase().trim() : null;
        values.push(norm || null);
      }
      if (updates.bio !== undefined) {
        setClauses.push(`bio = $${pIdx++}`);
        values.push(updates.bio);
      }
      if (updates.status_text !== undefined) {
        setClauses.push(`status_text = $${pIdx++}`);
        values.push(updates.status_text);
      }

      const query = `
        UPDATE users
        SET ${setClauses.join(', ')}
        WHERE id = $1
        RETURNING *
      `;
      const { rows } = await client.query(query, values);
      await client.query('COMMIT');
      return this.mapRow(rows[0]);
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err?.code === '23505') {
        const conflict = new Error('HANDLE_TAKEN');
        (conflict as any).code = 'HANDLE_TAKEN';
        throw conflict;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getFollowCounts(userId: string, ownerView = false, allowTest = false): Promise<{ follower_count: number; following_count: number }> {
    if (!this.pool) {
      return { follower_count: 0, following_count: 0 };
    }

    if (!ownerView) {
      const { rows: userRows } = await this.pool.query(
        'SELECT is_public FROM users WHERE id = $1 AND ($2 = TRUE OR COALESCE(is_test, FALSE) = FALSE)',
        [userId, allowTest]
      );
      if (!userRows.length || !userRows[0].is_public) {
        return { follower_count: 0, following_count: 0 };
      }
    }

    const query = `
      SELECT
        (SELECT COUNT(*)::int FROM user_follows uf JOIN users u ON u.id = uf.follower_id WHERE uf.following_id = $1 AND u.is_public = TRUE AND ($2 = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)) AS follower_count,
        (SELECT COUNT(*)::int FROM user_follows uf JOIN users u ON u.id = uf.following_id WHERE uf.follower_id = $1 AND u.is_public = TRUE AND ($2 = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)) AS following_count
    `;
    const { rows } = await this.pool.query(query, [userId, allowTest]);
    return {
      follower_count: rows[0]?.follower_count || 0,
      following_count: rows[0]?.following_count || 0,
    };
  }

  async getRelationship(
    actorId: string,
    targetId: string
  ): Promise<{
    is_following: boolean;
    follows_you: boolean;
    can_follow: boolean;
    reason?: 'PROFILE_VISIBILITY_REQUIRED' | 'CANNOT_FOLLOW_SELF' | 'TARGET_NOT_FOUND';
  }> {
    if (!this.pool) {
      return { is_following: false, follows_you: false, can_follow: false, reason: 'TARGET_NOT_FOUND' };
    }
    const { rows: users } = await this.pool.query('SELECT id, is_public FROM users WHERE id IN ($1, $2)', [actorId, targetId]);
    const actor = users.find((u: any) => u.id === actorId);
    const target = users.find((u: any) => u.id === targetId);

    if (!target || !target.is_public) {
      return { is_following: false, follows_you: false, can_follow: false, reason: 'TARGET_NOT_FOUND' };
    }
    if (actorId === targetId) {
      return { is_following: false, follows_you: false, can_follow: false, reason: 'CANNOT_FOLLOW_SELF' };
    }

    const { rows: follows } = await this.pool.query(
      'SELECT follower_id, following_id FROM user_follows WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)',
      [actorId, targetId]
    );
    const is_following = follows.some((f: any) => f.follower_id === actorId && f.following_id === targetId);
    const follows_you = follows.some((f: any) => f.follower_id === targetId && f.following_id === actorId);

    if (!actor || !actor.is_public) {
      return { is_following, follows_you, can_follow: false, reason: 'PROFILE_VISIBILITY_REQUIRED' };
    }

    return { is_following, follows_you, can_follow: true };
  }

  async followUser(
    actorId: string,
    targetId: string
  ): Promise<{
    success: boolean;
    error?: 'CANNOT_FOLLOW_SELF' | 'PROFILE_VISIBILITY_REQUIRED' | 'NOT_FOUND';
    follower_count?: number;
    following_count?: number;
  }> {
    if (actorId === targetId) {
      return { success: false, error: 'CANNOT_FOLLOW_SELF' };
    }
    if (!this.pool) {
      return { success: false, error: 'NOT_FOUND' };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const [firstId, secondId] = [actorId, targetId].sort();
      const { rows: locked } = await client.query(
        'SELECT id, is_public FROM users WHERE id IN ($1, $2) FOR UPDATE',
        [firstId, secondId]
      );
      const lockedActor = locked.find((r: any) => r.id === actorId);
      const lockedTarget = locked.find((r: any) => r.id === targetId);

      if (!lockedActor || !lockedActor.is_public) {
        await client.query('ROLLBACK');
        return { success: false, error: 'PROFILE_VISIBILITY_REQUIRED' };
      }
      if (!lockedTarget || !lockedTarget.is_public) {
        await client.query('ROLLBACK');
        return { success: false, error: 'NOT_FOUND' };
      }

      await client.query(
        `INSERT INTO user_follows (follower_id, following_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (follower_id, following_id) DO NOTHING`,
        [actorId, targetId]
      );
      await client.query('COMMIT');

      const counts = await this.getFollowCounts(targetId);
      return {
        success: true,
        follower_count: counts.follower_count,
        following_count: counts.following_count,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async unfollowUser(
    actorId: string,
    targetId: string
  ): Promise<{
    success: boolean;
    follower_count: number;
    following_count: number;
  }> {
    if (!this.pool) return { success: true, follower_count: 0, following_count: 0 };
    await this.pool.query(
      'DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2',
      [actorId, targetId]
    );
    const counts = await this.getFollowCounts(targetId);
    return {
      success: true,
      follower_count: counts.follower_count,
      following_count: counts.following_count,
    };
  }

  private async populateFollowCounts(users: any[]): Promise<any[]> {
    if (!this.pool || users.length === 0) return users;
    const userIds = users.map((u) => u.id).filter(Boolean);
    if (userIds.length === 0) return users;
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');

    const { rows: followerRows } = await this.pool.query(
      `SELECT uf.following_id AS user_id, COUNT(uf.follower_id)::int AS cnt
       FROM user_follows uf
       JOIN users u ON u.id = uf.follower_id AND u.is_public = TRUE AND COALESCE(u.is_test, FALSE) = FALSE
       WHERE uf.following_id IN (${placeholders})
       GROUP BY uf.following_id`,
      userIds
    );

    const { rows: followingRows } = await this.pool.query(
      `SELECT uf.follower_id AS user_id, COUNT(uf.following_id)::int AS cnt
       FROM user_follows uf
       JOIN users u ON u.id = uf.following_id AND u.is_public = TRUE AND COALESCE(u.is_test, FALSE) = FALSE
       WHERE uf.follower_id IN (${placeholders})
       GROUP BY uf.follower_id`,
      userIds
    );

    const followerMap = new Map<string, number>();
    for (const r of followerRows) {
      followerMap.set(r.user_id, Number(r.cnt));
    }

    const followingMap = new Map<string, number>();
    for (const r of followingRows) {
      followingMap.set(r.user_id, Number(r.cnt));
    }

    return users.map((u) => ({
      ...u,
      follower_count: followerMap.get(u.id) || 0,
      following_count: followingMap.get(u.id) || 0,
    }));
  }

  async listFollowers(
    targetId: string,
    limit: number = 20,
    cursor?: string,
    ownerView = false,
    allowTest = false
  ): Promise<{ items: any[]; next_cursor: string | null; has_more: boolean } | null> {
    if (!this.pool) return null;

    const { rows: targetRows } = await this.pool.query(
      'SELECT id, is_public FROM users WHERE id = $1 AND ($2 = TRUE OR COALESCE(is_test, FALSE) = FALSE)',
      [targetId, allowTest]
    );
    if (!targetRows.length || (!targetRows[0].is_public && !ownerView)) {
      return null;
    }

    let cursorPredicate = '';
    const params: any[] = [targetId, allowTest];
    if (cursor) {
      const parsed = decodeFollowCursor(cursor, targetId, 'followers');
      params.push(new Date(parsed.created_at), parsed.last_id);
      cursorPredicate = `AND (uf.created_at < $3 OR (uf.created_at = $3 AND uf.follower_id < $4))`;
    }

    const cappedLimit = Math.min(50, Math.max(1, limit));
    params.push(cappedLimit + 1);
    const limitParam = `$${params.length}`;

    const query = `
      SELECT
        u.id, u.display_name, u.handle, u.avatar_url, u.bio, u.status_text,
        COALESCE(u.demo_points, 0) AS scout_reputation,
        uf.created_at AS follow_created_at,
        uf.follower_id
      FROM user_follows uf
      JOIN users u ON u.id = uf.follower_id
      WHERE uf.following_id = $1 AND u.is_public = TRUE
        AND ($2 = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)
        ${cursorPredicate}
      ORDER BY uf.created_at DESC, uf.follower_id DESC
      LIMIT ${limitParam}
    `;

    const { rows } = await this.pool.query(query, params);
    const has_more = rows.length > cappedLimit;
    const pageRows = rows.slice(0, cappedLimit);

    const next_cursor =
      has_more && pageRows.length > 0
        ? encodeFollowCursor({
            target_id: targetId,
            direction: 'followers',
            created_at: new Date(pageRows[pageRows.length - 1].follow_created_at).toISOString(),
            last_id: pageRows[pageRows.length - 1].follower_id,
            version: 'follow-v1',
          })
        : null;

    const populated = await this.populateFollowCounts(pageRows);
    const items = populated.map((r: any) => ({
      id: r.id,
      display_name: r.display_name,
      handle: r.handle || null,
      avatar_url: r.avatar_url,
      bio: r.bio || null,
      status_text: r.status_text || null,
      scout_reputation: r.scout_reputation ?? 0,
      follower_count: r.follower_count ?? 0,
      following_count: r.following_count ?? 0,
    }));

    return { items, next_cursor, has_more };
  }

  async listFollowing(
    targetId: string,
    limit: number = 20,
    cursor?: string,
    allowTest = false
  ): Promise<{ items: any[]; next_cursor: string | null; has_more: boolean } | null> {
    if (!this.pool) return null;

    const { rows: targetRows } = await this.pool.query(
      'SELECT id, is_public FROM users WHERE id = $1 AND ($2 = TRUE OR COALESCE(is_test, FALSE) = FALSE)',
      [targetId, allowTest]
    );
    if (!targetRows.length || !targetRows[0].is_public) {
      return null;
    }

    let cursorPredicate = '';
    const params: any[] = [targetId, allowTest];
    if (cursor) {
      const parsed = decodeFollowCursor(cursor, targetId, 'following');
      params.push(new Date(parsed.created_at), parsed.last_id);
      cursorPredicate = `AND (uf.created_at < $3 OR (uf.created_at = $3 AND uf.following_id < $4))`;
    }

    const cappedLimit = Math.min(50, Math.max(1, limit));
    params.push(cappedLimit + 1);
    const limitParam = `$${params.length}`;

    const query = `
      SELECT
        u.id, u.display_name, u.handle, u.avatar_url, u.bio, u.status_text,
        COALESCE(u.demo_points, 0) AS scout_reputation,
        uf.created_at AS follow_created_at,
        uf.following_id
      FROM user_follows uf
      JOIN users u ON u.id = uf.following_id
      WHERE uf.follower_id = $1 AND u.is_public = TRUE
        AND ($2 = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)
        ${cursorPredicate}
      ORDER BY uf.created_at DESC, uf.following_id DESC
      LIMIT ${limitParam}
    `;

    const { rows } = await this.pool.query(query, params);
    const has_more = rows.length > cappedLimit;
    const pageRows = rows.slice(0, cappedLimit);

    const next_cursor =
      has_more && pageRows.length > 0
        ? encodeFollowCursor({
            target_id: targetId,
            direction: 'following',
            created_at: new Date(pageRows[pageRows.length - 1].follow_created_at).toISOString(),
            last_id: pageRows[pageRows.length - 1].following_id,
            version: 'follow-v1',
          })
        : null;

    const populated = await this.populateFollowCounts(pageRows);
    const items = populated.map((r: any) => ({
      id: r.id,
      display_name: r.display_name,
      handle: r.handle || null,
      avatar_url: r.avatar_url,
      bio: r.bio || null,
      status_text: r.status_text || null,
      scout_reputation: r.scout_reputation ?? 0,
      follower_count: r.follower_count ?? 0,
      following_count: r.following_count ?? 0,
    }));

    return { items, next_cursor, has_more };
  }

  async listMyFollowing(
    actorId: string,
    limit: number = 20,
    cursor?: string
  ): Promise<{ items: any[]; next_cursor: string | null; has_more: boolean }> {
    if (!this.pool) return { items: [], next_cursor: null, has_more: false };

    let cursorPredicate = '';
    const params: any[] = [actorId];
    if (cursor) {
      const parsed = decodeFollowCursor(cursor, actorId, 'following');
      params.push(new Date(parsed.created_at), parsed.last_id);
      cursorPredicate = `AND (uf.created_at < $2 OR (uf.created_at = $2 AND uf.following_id < $3))`;
    }

    const cappedLimit = Math.min(50, Math.max(1, limit));
    params.push(cappedLimit + 1);
    const limitParam = `$${params.length}`;

    const query = `
      SELECT
        uf.following_id,
        uf.created_at AS follow_created_at,
        u.id, u.display_name, u.handle, u.avatar_url, u.bio, u.status_text,
        COALESCE(u.demo_points, 0) AS scout_reputation,
        u.is_public
      FROM user_follows uf
      LEFT JOIN users u ON u.id = uf.following_id
      WHERE uf.follower_id = $1
        ${cursorPredicate}
      ORDER BY uf.created_at DESC, uf.following_id DESC
      LIMIT ${limitParam}
    `;

    const { rows } = await this.pool.query(query, params);
    const has_more = rows.length > cappedLimit;
    const pageRows = rows.slice(0, cappedLimit);

    const next_cursor =
      has_more && pageRows.length > 0
        ? encodeFollowCursor({
            target_id: actorId,
            direction: 'following',
            created_at: new Date(pageRows[pageRows.length - 1].follow_created_at).toISOString(),
            last_id: pageRows[pageRows.length - 1].following_id,
            version: 'follow-v1',
          })
        : null;

    const publicUsers = pageRows.filter((r: any) => r.id && r.is_public);
    const populated = await this.populateFollowCounts(publicUsers);
    const populatedMap = new Map(populated.map((p) => [p.id, p]));

    const items = pageRows.map((r: any) => {
      if (!r.id || !r.is_public) {
        return {
          id: r.following_id,
          display_name: 'Unavailable traveler',
          handle: null,
          avatar_url: '',
          bio: null,
          status_text: null,
          scout_reputation: 0,
          is_unavailable: true,
        };
      }
      const pop = populatedMap.get(r.id);
      return {
        id: r.id,
        display_name: r.display_name,
        handle: r.handle || null,
        avatar_url: r.avatar_url,
        bio: r.bio || null,
        status_text: r.status_text || null,
        scout_reputation: r.scout_reputation ?? 0,
        follower_count: pop?.follower_count ?? 0,
        following_count: pop?.following_count ?? 0,
        is_unavailable: false,
      };
    });

    return { items, next_cursor, has_more };
  }

  async listPublicUsers(limit: number = 3, allowTest = false): Promise<any[]> {
    if (!this.pool) return [];
    const capped = Math.min(6, Math.max(1, limit));
    const query = `
      SELECT
        u.id, u.display_name, u.handle, u.avatar_url, u.bio, u.status_text,
        COALESCE(u.demo_points, 0) AS scout_reputation
      FROM users u
      WHERE u.is_public = TRUE
        AND ($2 = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)
      ORDER BY u.display_name ASC, u.id ASC
      LIMIT $1
    `;
    const { rows } = await this.pool.query(query, [capped, allowTest]);
    const populated = await this.populateFollowCounts(rows);
    return populated.map((r: any) => ({
      id: r.id,
      display_name: r.display_name,
      handle: r.handle || null,
      avatar_url: r.avatar_url,
      bio: r.bio || null,
      status_text: r.status_text || null,
      scout_reputation: r.scout_reputation ?? 0,
      follower_count: r.follower_count ?? 0,
      following_count: r.following_count ?? 0,
    }));
  }

  async searchPeople(query: string, isHandleIntent: boolean, allowTest = false): Promise<any[]> {
    if (!this.pool) return [];
    const qLower = query.toLowerCase();
    const sql = `
      SELECT id, display_name, handle, avatar_url, bio, status_text
      FROM users
      WHERE is_public = TRUE
        AND ($2 = TRUE OR COALESCE(is_test, FALSE) = FALSE)
        AND (
          LOWER(display_name) LIKE '%' || $1 || '%'
          OR LOWER(handle) LIKE '%' || $1 || '%'
          OR LOWER(bio) LIKE '%' || $1 || '%'
          OR LOWER(status_text) LIKE '%' || $1 || '%'
        )
    `;
    const { rows } = await this.pool.query(sql, [qLower, allowTest]);
    const results: any[] = [];

    for (const user of rows) {
      let score = 0;
      const nameLower = (user.display_name || '').toLowerCase();
      const handleLower = (user.handle || '').toLowerCase();
      const bioLower = (user.bio || '').toLowerCase();
      const statusLower = (user.status_text || '').toLowerCase();

      if (handleLower && handleLower === qLower) score = isHandleIntent ? 1.0 : 0.95;
      else if (nameLower === qLower) score = isHandleIntent ? 0.9 : 1.0;
      else if (handleLower && handleLower.startsWith(qLower)) score = isHandleIntent ? 0.95 : 0.85;
      else if (nameLower.startsWith(qLower)) score = isHandleIntent ? 0.85 : 0.9;
      else if (handleLower && handleLower.includes(qLower)) score = 0.75;
      else if (nameLower.includes(qLower)) score = 0.7;
      else if (statusLower.includes(qLower) || bioLower.includes(qLower)) score = 0.45;

      if (score > 0) {
        results.push({
          id: user.id,
          display_name: user.display_name,
          handle: user.handle || null,
          avatar_url: user.avatar_url,
          bio: user.bio || null,
          status_text: user.status_text || null,
          score: Number(score.toFixed(2)),
        });
      }
    }

    return results.sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name));
  }

  private mapRow(row: any): UserRow {
    return {
      id: row.id,
      seed_id: row.seed_id,
      display_name: row.display_name,
      email: row.email,
      avatar_url: row.avatar_url,
      role: row.role,
      demo_points: row.demo_points,
      mjdq_balance: row.mjdq_balance ?? row.demo_points * 1000,
      jdq_governance_balance: row.jdq_governance_balance ?? 15,
      scout_reputation: row.scout_reputation ?? 250,
      is_public: Boolean(row.is_public),
      handle: row.handle ?? null,
      bio: row.bio ?? null,
      status_text: row.status_text ?? null,
      is_test: Boolean(row.is_test),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }
}
