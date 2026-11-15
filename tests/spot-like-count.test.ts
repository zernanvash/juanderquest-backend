import request from 'supertest';
import { app } from '../src/app';
import { spotStore } from '../src/spots/store';

// Plan 93b WP-13: like counts are real counts of travelers' likes, never invented.
describe('spot like_count', () => {
  const spotId = () => spotStore.spots.find((spot) => !spot.is_test)!.id;

  it('counts each device once and drops the like on unlike', async () => {
    const id = spotId();
    const before = (await request(app).get(`/api/v1/spots/${id}`).set('x-device-id', 'like-a')).body.data;
    expect(typeof before.like_count).toBe('number');
    expect(before.liked).toBe(false);

    const likeA = await request(app).put(`/api/v1/spots/${id}/like`).set('x-device-id', 'like-a');
    expect(likeA.status).toBe(200);
    expect(likeA.body.data).toMatchObject({ liked: true, like_count: before.like_count + 1 });

    // A repeated like from the same device does not count twice.
    const again = await request(app).put(`/api/v1/spots/${id}/like`).set('x-device-id', 'like-a');
    expect(again.body.data.like_count).toBe(before.like_count + 1);

    await request(app).put(`/api/v1/spots/${id}/like`).set('x-device-id', 'like-b');
    const detailB = (await request(app).get(`/api/v1/spots/${id}`).set('x-device-id', 'like-b')).body.data;
    expect(detailB).toMatchObject({ liked: true, like_count: before.like_count + 2 });

    const unlike = await request(app).delete(`/api/v1/spots/${id}/like`).set('x-device-id', 'like-a');
    expect(unlike.body.data).toMatchObject({ liked: false, like_count: before.like_count + 1 });
    await request(app).delete(`/api/v1/spots/${id}/like`).set('x-device-id', 'like-b');
  });

  it('includes like_count on the spot list', async () => {
    const list = await request(app).get('/api/v1/spots').set('x-device-id', 'like-list');
    expect(list.status).toBe(200);
    const items = Array.isArray(list.body.data) ? list.body.data : list.body.data.items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(typeof item.like_count).toBe('number');
  });
});
