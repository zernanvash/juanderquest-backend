import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';

describe('Social Follow Graph & Traveler Discovery API (/api/v1/users)', () => {
  const juanId = '11111111-1111-1111-1111-111111111111'; // Public user
  const mariaId = '33333333-3333-3333-3333-333333333333'; // Public user
  const privateId = '44444444-4444-4444-4444-444444444444'; // Private user

  const juanToken = jwt.sign(
    { id: juanId, seed_id: 'user-1', role: 'user' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const mariaToken = jwt.sign(
    { id: mariaId, seed_id: 'user-2', role: 'user' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const privateToken = jwt.sign(
    { id: privateId, seed_id: 'user-3', role: 'user' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  describe('GET /api/v1/users (Public Traveler Directory)', () => {
    it('lets a private owner read connections without exposing them publicly', async () => {
      const saved = [...db.follows];
      try {
        db.follows.push({ follower_id: juanId, following_id: privateId, created_at: new Date().toISOString() });
        const own = await request(app).get('/api/v1/users/me/followers').set('Authorization', `Bearer ${privateToken}`);
        expect(own.status).toBe(200);
        expect(own.body.data.items.some((u: any) => u.id === juanId)).toBe(true);
        expect(own.headers['cache-control']).toContain('no-store');
        expect((await request(app).get(`/api/v1/users/${privateId}/followers`)).status).toBe(404);
        expect((await request(app).get('/api/v1/users/me/followers')).status).toBe(401);
        expect((await request(app).get('/api/v1/users/me/following').set('Authorization', `Bearer ${privateToken}`)).status).toBe(200);
      } finally { db.follows = saved; }
    });
    it('returns a list of public travelers with counts and safe identity fields', async () => {
      const res = await request(app).get('/api/v1/users?limit=3');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const items = res.body.data.items;
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(2);

      // Verify no private user leaked
      const hasPrivate = items.some((u: any) => u.id === privateId);
      expect(hasPrivate).toBe(false);

      // Verify shape of traveler items
      const sample = items[0];
      expect(sample.id).toBeDefined();
      expect(sample.display_name).toBeDefined();
      expect(sample.follower_count).toBeDefined();
      expect(sample.following_count).toBeDefined();
      expect(sample.email).toBeUndefined();
      expect(sample.wallet_address).toBeUndefined();
    });

    it('clamps limit between 1 and 6', async () => {
      const res = await request(app).get('/api/v1/users?limit=100');
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeLessThanOrEqual(6);
    });
  });

  describe('GET /api/v1/users/me/profile (Authenticated Self Profile)', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/api/v1/users/me/profile');
      expect(res.status).toBe(401);
    });

    it('returns own profile including visibility and counts', async () => {
      const res = await request(app)
        .get('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${juanToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(juanId);
      expect(res.body.data.email).toBe('juan@juanderquest.ph');
      expect(res.body.data.is_public).toBe(true);
      expect(res.body.data.follower_count).toBeDefined();
      expect(res.body.data.following_count).toBeDefined();
    });
  });

  describe('GET /api/v1/users/:id/relationship', () => {
    it('returns 404 for non-existent or private users', async () => {
      const res = await request(app)
        .get(`/api/v1/users/${privateId}/relationship`)
        .set('Authorization', `Bearer ${juanToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns relationship between two public users', async () => {
      const res = await request(app)
        .get(`/api/v1/users/${mariaId}/relationship`)
        .set('Authorization', `Bearer ${juanToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.can_follow).toBe(true);
      expect(typeof res.body.data.is_following).toBe('boolean');
      expect(typeof res.body.data.follows_you).toBe('boolean');
    });

    it('reports CANNOT_FOLLOW_SELF for own relationship check', async () => {
      const res = await request(app)
        .get(`/api/v1/users/${juanId}/relationship`)
        .set('Authorization', `Bearer ${juanToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.can_follow).toBe(false);
      expect(res.body.data.reason).toBe('CANNOT_FOLLOW_SELF');
    });
  });

  describe('PUT /api/v1/users/:id/follow & DELETE /api/v1/users/:id/follow', () => {
    it('rejects self-follow with 422 CANNOT_FOLLOW_SELF', async () => {
      const res = await request(app)
        .put(`/api/v1/users/${juanId}/follow`)
        .set('Authorization', `Bearer ${juanToken}`);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CANNOT_FOLLOW_SELF');
    });

    it('rejects following when actor has a private profile with 403 PROFILE_VISIBILITY_REQUIRED', async () => {
      const res = await request(app)
        .put(`/api/v1/users/${mariaId}/follow`)
        .set('Authorization', `Bearer ${privateToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PROFILE_VISIBILITY_REQUIRED');
    });

    it('returns 404 when attempting to follow private target', async () => {
      const res = await request(app)
        .put(`/api/v1/users/${privateId}/follow`)
        .set('Authorization', `Bearer ${juanToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('successfully follows and unfollows idempotently', async () => {
      // Unfollow first to ensure clean state
      const delRes1 = await request(app)
        .delete(`/api/v1/users/${mariaId}/follow`)
        .set('Authorization', `Bearer ${juanToken}`);
      expect(delRes1.status).toBe(204);

      // Follow Maria
      const followRes = await request(app)
        .put(`/api/v1/users/${mariaId}/follow`)
        .set('Authorization', `Bearer ${juanToken}`);

      expect(followRes.status).toBe(200);
      expect(followRes.body.success).toBe(true);
      expect(followRes.body.data.is_following).toBe(true);

      // Verify relationship reflects follow
      const relRes = await request(app)
        .get(`/api/v1/users/${mariaId}/relationship`)
        .set('Authorization', `Bearer ${juanToken}`);
      expect(relRes.body.data.is_following).toBe(true);

      // Unfollow Maria
      const delRes2 = await request(app)
        .delete(`/api/v1/users/${mariaId}/follow`)
        .set('Authorization', `Bearer ${juanToken}`);
      expect(delRes2.status).toBe(204);

      // Verify relationship reflects unfollow
      const relRes2 = await request(app)
        .get(`/api/v1/users/${mariaId}/relationship`)
        .set('Authorization', `Bearer ${juanToken}`);
      expect(relRes2.body.data.is_following).toBe(false);

      // Restore Juan following Maria
      await request(app)
        .put(`/api/v1/users/${mariaId}/follow`)
        .set('Authorization', `Bearer ${juanToken}`);
    });
  });

  describe('Followers & Following Lists Pagination (/api/v1/users/:id/followers & following)', () => {
    it('returns 404 for private target user lists', async () => {
      const followersRes = await request(app).get(`/api/v1/users/${privateId}/followers`);
      expect(followersRes.status).toBe(404);

      const followingRes = await request(app).get(`/api/v1/users/${privateId}/following`);
      expect(followingRes.status).toBe(404);
    });

    it('returns paginated followers list for public user', async () => {
      const res = await request(app).get(`/api/v1/users/${juanId}/followers?limit=10`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(typeof res.body.data.has_more).toBe('boolean');
    });

    it('rejects invalid cursor with 400 INVALID_CURSOR', async () => {
      const res = await request(app).get(`/api/v1/users/${juanId}/followers?cursor=invalid_base64`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });

    it('lists authenticated user outgoing following including unavailable placeholders', async () => {
      const res = await request(app)
        .get('/api/v1/users/me/following')
        .set('Authorization', `Bearer ${privateToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
    });
  });
});
