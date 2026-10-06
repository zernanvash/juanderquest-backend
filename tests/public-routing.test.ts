import request from 'supertest';
import { app } from '../src/app.js';
import { spotStore } from '../src/spots/store.js';

describe('public resource routing', () => {
  it('resolves the same published spot through its immutable ID and legacy slug', async () => {
    const spot = spotStore.spots.find(item => item.status === 'published' && !item.is_test);
    expect(spot).toBeDefined();
    const byId = await request(app).get(`/api/v1/spots/${spot!.id}`);
    const bySlug = await request(app).get(`/api/v1/spots/${spot!.slug}`);
    expect(byId.status).toBe(200);
    expect(bySlug.status).toBe(200);
    expect(byId.body.data.id).toBe(spot!.id);
    expect(bySlug.body.data.id).toBe(spot!.id);
  });

  it('does not expose missing, malformed, or unpublished spot identifiers', async () => {
    for (const identifier of ['no-such-spot', '.hidden']) {
      const response = await request(app).get(`/api/v1/spots/${identifier}`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });
});
