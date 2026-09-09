import { randomUUID } from 'crypto';

type Session = { owner: string; ids: string[]; expires: number };
const sessions = new Map<string, Session>();
const TTL = 60 * 60 * 1000;

// Bounded process-local sessions. Restarts/expiry require an explicit feed refresh.
export function rankedFeedPage<T extends { id: string }>(
  ranked: T[], owner: string, cursor: string | undefined, limit: number,
) {
  const now = Date.now();
  for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
  let id: string;
  let offset = 0;
  let session: Session;
  if (cursor) {
    let decoded: { id?: string; offset?: number };
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); }
    catch { throw new Error('INVALID_CURSOR'); }
    const existing = decoded && typeof decoded.id === 'string' ? sessions.get(decoded.id) : undefined;
    if (!existing || existing.owner !== owner || !Number.isSafeInteger(decoded.offset) ||
        decoded.offset! < 0 || decoded.offset! > existing.ids.length) throw new Error('INVALID_CURSOR');
    id = decoded.id!;
    offset = decoded.offset!;
    session = existing;
  } else {
    if (sessions.size >= 200) sessions.delete(sessions.keys().next().value!);
    id = randomUUID();
    session = { owner, ids: [], expires: now + TTL };
    sessions.set(id, session);
  }
  const seen = new Set(session.ids);
  if (offset === session.ids.length) {
    const unseen = ranked.filter(item => !seen.has(item.id));
    session.ids.push(...unseen.slice(0, Math.min(limit, 5000 - session.ids.length)).map(item => item.id));
  }
  const byId = new Map(ranked.map(item => [item.id, item]));
  const ids = session.ids.slice(offset, offset + limit);
  const items = ids.flatMap(itemId => { const item = byId.get(itemId); return item ? [item] : []; });
  const nextOffset = offset + ids.length;
  const served = new Set(session.ids);
  const hasMore = nextOffset < session.ids.length ||
    (session.ids.length < 5000 && ranked.some(item => !served.has(item.id)));
  return { items, cursor: Buffer.from(JSON.stringify({ id, offset: nextOffset })).toString('base64url'),
    has_more: hasMore, total: ranked.length, offset, limit };
}
