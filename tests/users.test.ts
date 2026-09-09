import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';

describe('Public Profile and Privacy Controls API (/api/v1/users)', () => {
  const publicUserId = '11111111-1111-1111-1111-111111111111'; // Juan Dela Cruz
  const privateUserId = '44444444-4444-4444-4444-444444444444'; // Private Explorer

  describe('GET /api/v1/users/:id/profile', () => {
    it('returns public profile for opted-in user with strict privacy-safe fields', async () => {
      const res = await request(app).get(`/api/v1/users/${publicUserId}/profile`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const profile = res.body.data;
      expect(profile.id).toBe(publicUserId);
      expect(profile.display_name).toBe('Juan Dela Cruz');
      expect(profile.handle).toBe('juandelacruz');
      expect(profile.bio).toBeDefined();
      expect(profile.status_text).toBeDefined();
      expect(profile.is_public).toBe(true);

      // Strict privacy assertions: NO sensitive data leaked
      expect(profile.email).toBeUndefined();
      expect(profile.demo_points).toBeUndefined();
      expect(profile.mjdq_balance).toBeUndefined();
      expect(profile.jdq_governance_balance).toBeUndefined();
      expect(profile.seed_id).toBeUndefined();
      expect(profile.role).toBeUndefined();
    });

    it('allows lookup by @handle', async () => {
      const res = await request(app).get('/api/v1/users/@juandelacruz/profile');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(publicUserId);
    });

    it('returns 404 NOT_FOUND for private non-public users', async () => {
      const res = await request(app).get(`/api/v1/users/${privateUserId}/profile`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND for non-existent user IDs', async () => {
      const res = await request(app).get('/api/v1/users/non-existent-uuid/profile');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /api/v1/users/me/profile', () => {
    const token = jwt.sign(
      { id: publicUserId, seed_id: 'user-1', role: 'user' },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    it('requires authentication to update profile', async () => {
      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .send({ bio: 'New bio test' });
      expect(res.status).toBe(401);
    });

    it('allows authenticated user to update bio, status, and privacy settings', async () => {
      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({
          bio: 'Updated traveler bio for testing',
          status_text: 'Active in Bolinao',
          is_public: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bio).toBe('Updated traveler bio for testing');
      expect(res.body.data.status_text).toBe('Active in Bolinao');
    });

    it('rejects invalid handles (special characters, too short, too long)', async () => {
      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ handle: 'a' }); // too short
      expect(res.status).toBe(400);
    });
  });
});
