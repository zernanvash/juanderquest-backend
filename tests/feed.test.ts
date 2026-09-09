import request from 'supertest';
import { app } from '../src/app.js';
import { applyMunicipalDiversity } from '../src/routes/feed.js';

describe('Ranked Home Feed API (GET /api/v1/feed)', () => {
  describe('applyMunicipalDiversity algorithm unit tests', () => {
    it('ensures no more than 2 consecutive items from the same municipality when alternatives exist', () => {
      const input = [
        { id: '1', municipality: 'Bolinao' },
        { id: '2', municipality: 'Bolinao' },
        { id: '3', municipality: 'Bolinao' },
        { id: '4', municipality: 'Dagupan' },
        { id: '5', municipality: 'Dagupan' },
        { id: '6', municipality: 'Lingayen' },
      ];

      const result = applyMunicipalDiversity(input, 2);
      expect(result.length).toBe(input.length);

      // Verify no 3 consecutive items have identical municipality
      for (let i = 2; i < result.length; i++) {
        const tripleIdentical =
          result[i].municipality === result[i - 1].municipality &&
          result[i - 1].municipality === result[i - 2].municipality;
        expect(tripleIdentical).toBe(false);
      }
    });

    it('gracefully handles homogeneous lists where alternatives are exhausted', () => {
      const input = [
        { id: '1', municipality: 'Bolinao' },
        { id: '2', municipality: 'Bolinao' },
        { id: '3', municipality: 'Bolinao' },
      ];

      const result = applyMunicipalDiversity(input, 2);
      expect(result.length).toBe(3);
    });
  });

  describe('GET /api/v1/feed endpoint integration tests', () => {
    it('returns published destinations ranked by server algorithm', async () => {
      const res = await request(app).get('/api/v1/feed');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toBeDefined();
      expect(res.body.data.items.length).toBeGreaterThan(0);

      const firstItem = res.body.data.items[0];
      expect(firstItem.feed_score).toBeDefined();
      expect(firstItem.recommendation_reasons).toBeDefined();
      expect(Array.isArray(firstItem.recommendation_reasons)).toBe(true);
      expect(firstItem.recommendation_reasons.length).toBeGreaterThan(0);
    });

    it('guest requests include truthful reasons and indicate guest_mode', async () => {
      const res = await request(app).get('/api/v1/feed');
      expect(res.status).toBe(200);
      expect(res.body.meta.guest_mode).toBe(true);
      expect(res.body.meta.personalized).toBe(false);

      // Ensure no fake "Matches your ... interests" for guests without preferences
      for (const item of res.body.data.items) {
        for (const reason of item.recommendation_reasons) {
          expect(reason.startsWith('Matches your')).toBe(false);
        }
      }
    });

    it('supports cursor-based pagination', async () => {
      const res = await request(app).get('/api/v1/feed').query({ limit: 3 });
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeLessThanOrEqual(3);

      if (res.body.data.has_more) {
        expect(res.body.data.cursor).toBeDefined();
        const nextRes = await request(app)
          .get('/api/v1/feed')
          .query({ cursor: res.body.data.cursor, limit: 3 });
        expect(nextRes.status).toBe(200);
        expect(nextRes.body.data.items).toBeDefined();
      }
    });

    it('rejects invalid cursor with 400 INVALID_CURSOR', async () => {
      const res = await request(app).get('/api/v1/feed').query({ cursor: 'not-a-valid-cursor-string' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });
  });
});
