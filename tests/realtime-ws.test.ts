import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { signSessionToken } from '../src/auth/tokens.js';
import { attachRealtime, REALTIME_PATH } from '../src/realtime/server.js';
import { publishBroadcast } from '../src/realtime/bus.js';
import { notify } from '../src/social/notify.js';

type Msg = Record<string, any>;

function open(url: string) {
  const socket = new WebSocket(url);
  const messages: Msg[] = [];
  const waiters: Array<() => void> = [];
  socket.on('message', (data) => {
    messages.push(JSON.parse(String(data)));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  const next = async (type: string): Promise<Msg> => {
    for (;;) {
      const found = messages.find((m) => m.type === type);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, messages, next, closed, opened };
}

describe('realtime WebSocket endpoint', () => {
  let server: http.Server;
  let realtime: ReturnType<typeof attachRealtime>;
  let url: string;
  const user = db.users.find((u) => u.id === '11111111-1111-1111-1111-111111111111')!;
  const other = db.users.find((u) => u.id !== user.id)!;

  beforeAll(async () => {
    server = http.createServer(app);
    realtime = attachRealtime(server, { authTimeoutMs: 300, maxPerUser: 2 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${REALTIME_PATH}`;
  });

  afterAll(async () => {
    realtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('authenticates and pushes the owner a notification event after notify()', async () => {
    const mine = open(url);
    const theirs = open(url);
    await Promise.all([mine.opened, theirs.opened]);
    mine.socket.send(JSON.stringify({ type: 'auth', token: signSessionToken(user) }));
    theirs.socket.send(JSON.stringify({ type: 'auth', token: signSessionToken(other) }));
    await Promise.all([mine.next('ready'), theirs.next('ready')]);

    // Fake autocommit queryable: echoes the generated id so notify() treats the row as inserted.
    const fakeDb = { query: async (_text: string, params?: any[]) => ({ rows: [{ id: params?.[0] }] }) };
    const id = await notify(fakeDb, {
      userId: user.id,
      kind: 'follow',
      eventKey: 'realtime-test:1',
      title: 'Ana followed you',
      message: 'Say hi',
      href: '/people/ana',
      isTest: false,
    });
    const event = await mine.next('notification');
    expect(event).toEqual({ type: 'notification', id, kind: 'follow', title: 'Ana followed you', href: '/people/ana' });

    publishBroadcast({ type: 'plaza_activity', id: 'act_x' });
    await Promise.all([mine.next('plaza_activity'), theirs.next('plaza_activity')]);
    expect(theirs.messages.some((m) => m.type === 'notification')).toBe(false);

    mine.socket.close();
    theirs.socket.close();
    await Promise.all([mine.closed, theirs.closed]);
  });

  it('closes an unauthenticated socket after the auth timeout and rejects a bad token', async () => {
    const silent = open(url);
    await silent.opened;
    expect(await silent.closed).toBe(4401);

    const forged = open(url);
    await forged.opened;
    forged.socket.send(JSON.stringify({ type: 'auth', token: 'not-a-jwt' }));
    expect(await forged.closed).toBe(4401);
  });

  it('keeps only the newest sockets per user and never broadcasts to unauthenticated sockets', async () => {
    const token = signSessionToken(user);
    const sockets = [open(url), open(url), open(url)];
    for (const s of sockets) {
      await s.opened;
      s.socket.send(JSON.stringify({ type: 'auth', token }));
      await s.next('ready');
    }
    expect(await sockets[0].closed).toBe(4429);

    const anonymous = open(url);
    await anonymous.opened;
    publishBroadcast({ type: 'plaza_activity', id: 'act_y' });
    await sockets[2].next('plaza_activity');
    expect(anonymous.messages).toEqual([]);
    for (const s of [sockets[1], sockets[2], anonymous]) s.socket.close();
    await Promise.all([sockets[1].closed, sockets[2].closed, anonymous.closed]);
  });

  it('refuses upgrades on other paths', async () => {
    const port = (server.address() as AddressInfo).port;
    const wrong = new WebSocket(`ws://127.0.0.1:${port}/api/v1/other`);
    await expect(
      new Promise((resolve, reject) => {
        wrong.on('open', resolve);
        wrong.on('error', reject);
      }),
    ).rejects.toBeTruthy();
  });
});
