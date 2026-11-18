import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { verifySessionToken } from '../auth/tokens.js';
import { getSessionScope } from '../middleware/auth.js';
import { subscribe, type RealtimeEvent, type RealtimeTarget } from './bus.js';

export const REALTIME_PATH = '/api/v1/realtime';

export interface RealtimeOptions {
  authTimeoutMs?: number;
  heartbeatMs?: number;
  maxPerUser?: number;
}

interface Conn {
  socket: WebSocket;
  userId: string | null;
  alive: boolean;
}

/**
 * WebSocket endpoint on the existing HTTP server. Protocol: the client's first
 * message is `{"type":"auth","token":"<session JWT>"}`; the server answers
 * `{"type":"ready"}` and then pushes bus events as JSON. Unauthenticated
 * sockets close (4401) after `authTimeoutMs`.
 */
export function attachRealtime(server: Server, options: RealtimeOptions = {}) {
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const maxPerUser = options.maxPerUser ?? 5;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  const byUser = new Map<string, Conn[]>();
  const conns = new Set<Conn>();

  const send = (conn: Conn, event: RealtimeEvent) => {
    if (conn.socket.readyState === WebSocket.OPEN) conn.socket.send(JSON.stringify(event));
  };

  const unsubscribe = subscribe((target: RealtimeTarget, event: RealtimeEvent) => {
    if (target === 'all') {
      for (const conn of conns) if (conn.userId) send(conn, event);
    } else {
      for (const conn of byUser.get(target.userId) ?? []) send(conn, event);
    }
  });

  const drop = (conn: Conn) => {
    conns.delete(conn);
    if (!conn.userId) return;
    const list = (byUser.get(conn.userId) ?? []).filter((c) => c !== conn);
    if (list.length) byUser.set(conn.userId, list);
    else byUser.delete(conn.userId);
  };

  const authenticate = async (conn: Conn, token: unknown) => {
    const claims = typeof token === 'string' ? verifySessionToken(token) : null;
    const scope = claims ? await getSessionScope(claims.id) : null;
    if (!claims || !scope || (claims.sep ?? 0) !== scope.session_epoch) {
      conn.socket.close(4401, 'unauthorized');
      return;
    }
    if (conn.socket.readyState !== WebSocket.OPEN) return;
    conn.userId = claims.id;
    const list = byUser.get(claims.id) ?? [];
    list.push(conn);
    // Keep the newest sockets: a reconnecting phone must never lock itself out.
    while (list.length > maxPerUser) list.shift()!.socket.close(4429, 'too many connections');
    byUser.set(claims.id, list);
    conn.socket.send(JSON.stringify({ type: 'ready' }));
  };

  wss.on('connection', (socket: WebSocket) => {
    const conn: Conn = { socket, userId: null, alive: true };
    conns.add(conn);
    const authTimer = setTimeout(() => {
      if (!conn.userId) socket.close(4401, 'auth timeout');
    }, authTimeoutMs);
    let authStarted = false;
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (data) => {
      let message: any;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message?.type === 'auth' && !authStarted) {
        authStarted = true;
        authenticate(conn, message.token).catch(() => socket.close(1013, 'try again later'));
      } else if (message?.type === 'ping' && conn.userId) {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      drop(conn);
    });
    socket.on('error', () => socket.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== REALTIME_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  return {
    connectionCount: () => conns.size,
    close() {
      clearInterval(heartbeat);
      unsubscribe();
      server.off('upgrade', onUpgrade);
      for (const conn of conns) conn.socket.terminate();
      wss.close();
    },
  };
}
