import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';

describe('Unified Search API (GET /api/v1/search)', () => {
  describe('Query Gating & Input Validation', () => {
    it('rejects empty query with 400 QUERY_TOO_SHORT', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: '' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('QUERY_TOO_SHORT');
    });

    it('rejects whitespace-only queries with 400', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: '     ' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('QUERY_TOO_SHORT');
    });

    it('rejects single character queries with 400', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: 'a' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('QUERY_TOO_SHORT');
    });

    it('rejects punctuation-only or bare symbol queries with 400', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: '@@@' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('QUERY_TOO_SHORT');
    });

    it('accepts queries with at least 2 alphanumeric characters', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: 'bo' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.groups).toBeDefined();
    });

    it('rejects queries exceeding 100 characters with 400 QUERY_TOO_LONG', async () => {
      const longQuery = 'a'.repeat(101);
      const res = await request(app).get('/api/v1/search').query({ q: longQuery });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('QUERY_TOO_LONG');
    });
  });

  describe('Preview Budget & Allocation (mode=preview)', () => {
    it('enforces maximum 8 total preview items and at most 4 items per group', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: 'Pangasinan' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const groups = res.body.data.groups;
      let totalItems = 0;
      for (const group of groups) {
        expect(group.items.length).toBeLessThanOrEqual(4);
        totalItems += group.items.length;
      }
      expect(totalItems).toBeLessThanOrEqual(8);
    });

    it('does not return groups with zero matches', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: 'NonexistentPlace12345' });
      expect(res.status).toBe(200);
      expect(res.body.data.groups).toEqual([]);
    });

    it('reserves at least 1 slot per nonempty group in all mode', async () => {
      // "a" in many places, people, and quests
      const res = await request(app).get('/api/v1/search').query({ q: 'an' });
      expect(res.status).toBe(200);
      const groups = res.body.data.groups;
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) {
        expect(g.items.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('Intent Weighting & Prioritization', () => {
    it('strongly prioritizes People group when searching with @handle prefix', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: '@juandelacruz' });
      expect(res.status).toBe(200);
      const groups = res.body.data.groups;
      expect(groups.length).toBeGreaterThan(0);
      expect(groups[0].type).toBe('people');
      expect(groups[0].items[0].display_name).toBe('Juan Dela Cruz');
      expect(groups[0].items[0].handle).toBe('juandelacruz');
    });

    it('prioritizes Places when query matches known destination names', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: 'Hundred Islands' });
      expect(res.status).toBe(200);
      const groups = res.body.data.groups;
      expect(groups.length).toBeGreaterThan(0);
      expect(groups[0].type).toBe('places');
      expect(groups[0].items[0].name).toContain('Hundred Islands');
    });

    it('finds quests when query matches quest titles', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: 'Trek' });
      expect(res.status).toBe(200);
      const questGroup = res.body.data.groups.find((g: any) => g.type === 'quests');
      expect(questGroup).toBeDefined();
      expect(questGroup.items.length).toBeGreaterThan(0);
    });
  });

  describe('Privacy Guardrails in Search', () => {
    it('NEVER returns non-public or private users in search results', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: 'Private Explorer' });
      expect(res.status).toBe(200);
      const peopleGroup = res.body.data.groups.find((g: any) => g.type === 'people');
      expect(peopleGroup).toBeUndefined();
    });

    it('NEVER leaks email, balance, or private keys in people search results', async () => {
      const res = await request(app).get('/api/v1/search').query({ q: 'Juan' });
      expect(res.status).toBe(200);
      const peopleGroup = res.body.data.groups.find((g: any) => g.type === 'people');
      expect(peopleGroup).toBeDefined();
      const person = peopleGroup.items[0];
      expect(person.email).toBeUndefined();
      expect(person.demo_points).toBeUndefined();
      expect(person.mjdq_balance).toBeUndefined();
      expect(person.jdq_governance_balance).toBeUndefined();
      expect(person.seed_id).toBeUndefined();
    });
  });

  describe('Results Mode & Cursor Pagination', () => {
    it('supports type-specific results mode with cursor pagination', async () => {
      const res = await request(app).get('/api/v1/search').query({
        q: 'an',
        type: 'places',
        mode: 'results',
        limit: 2,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.items).toBeDefined();
      expect(res.body.data.items.length).toBeLessThanOrEqual(2);

      if (res.body.data.has_more) {
        expect(res.body.data.cursor).toBeDefined();
        // Request next page with cursor
        const nextRes = await request(app).get('/api/v1/search').query({
          q: 'an',
          type: 'places',
          mode: 'results',
          cursor: res.body.data.cursor,
        });
        expect(nextRes.status).toBe(200);
        expect(nextRes.body.data.items).toBeDefined();
      }
    });

    it('rejects mismatched cursor with 400 INVALID_CURSOR', async () => {
      const validCursor = Buffer.from(
        JSON.stringify({ offset: 2, q: 'an', type: 'places' })
      ).toString('base64');

      const res = await request(app).get('/api/v1/search').query({
        q: 'bolinao', // different query than cursor
        type: 'places',
        mode: 'results',
        cursor: validCursor,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });
  });
});
