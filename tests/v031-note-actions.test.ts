import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';

// v0.3.1: the author edits or deletes their note; other travelers report it.
describe('destination note actions', () => {
  const ids = ['v031-author', 'v031-r1', 'v031-r2', 'v031-r3'];
  const token = (id: string) => jwt.sign({ id, seed_id: `${id}-seed`, role: 'user', typ: 'session' }, env.JWT_SECRET);
  const auth = (id: string) => ({ Authorization: `Bearer ${token(id)}` });
  const spotId = () => spotStore.spots.find((spot) => !spot.is_test)!.id;

  beforeAll(() => {
    const now = new Date().toISOString();
    for (const id of ids) {
      db.users.push({
        id,
        seed_id: `${id}-seed`,
        display_name: id,
        handle: id.replace(/-/g, ''),
        email: `${id}@example.test`,
        role: 'user',
        is_public: true,
        is_test: false,
        demo_points: 0,
        created_at: now,
        updated_at: now,
      } as any);
    }
  });
  afterAll(() => {
    db.users = db.users.filter((u) => !ids.includes(u.id));
  });

  const post = async (content: string) =>
    (await request(app).post(`/api/v1/spots/${spotId()}/comments`).set(auth('v031-author')).send({ content })).body
      .data;

  it('only the author edits and deletes', async () => {
    const note = await post('Bring cash for the boat.');
    const url = `/api/v1/spots/${spotId()}/comments/${note.id}`;

    const other = await request(app).patch(url).set(auth('v031-r1')).send({ content: 'hacked' });
    expect(other.status).toBe(403);
    const anon = await request(app).patch(url).send({ content: 'hacked' });
    expect(anon.status).toBe(401);

    const edited = await request(app).patch(url).set(auth('v031-author')).send({ content: 'Bring cash and water.' });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ content: 'Bring cash and water.' });
    expect(edited.body.data.edited_at).toBeTruthy();

    expect((await request(app).delete(url).set(auth('v031-r1'))).status).toBe(403);
    expect((await request(app).delete(url).set(auth('v031-author'))).status).toBe(200);
    const list = (await request(app).get(`/api/v1/spots/${spotId()}/comments`)).body.data;
    expect(list.find((n: any) => n.id === note.id)).toBeUndefined();
  });

  it('others report once; the author cannot; three reports hide the note', async () => {
    const note = await post('Visit before noon.');
    const url = `/api/v1/spots/${spotId()}/comments/${note.id}/report`;

    expect((await request(app).post(url).set(auth('v031-author')).send({ reason: 'spam' })).status).toBe(403);
    const first = await request(app).post(url).set(auth('v031-r1')).send({ reason: 'spam' });
    expect(first.status).toBe(201);
    expect(first.body.data).toEqual({ reports: 1, hidden: false });
    expect((await request(app).post(url).set(auth('v031-r1')).send({ reason: 'spam' })).status).toBe(409);
    expect((await request(app).post(url).send({ reason: 'spam' })).status).toBe(401);

    await request(app).post(url).set(auth('v031-r2')).send({ reason: 'offensive' });
    const third = await request(app).post(url).set(auth('v031-r3')).send({});
    expect(third.body.data).toEqual({ reports: 3, hidden: true });
    const list = (await request(app).get(`/api/v1/spots/${spotId()}/comments`)).body.data;
    expect(list.find((n: any) => n.id === note.id)).toBeUndefined();
  });
});
