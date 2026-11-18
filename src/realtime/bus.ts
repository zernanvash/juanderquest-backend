/**
 * In-process realtime event bus (v0.3.8). Events are refresh hints: the client
 * re-reads the authoritative REST endpoint, so payloads stay small and never
 * carry another user's private data. Production runs one API process, so an
 * in-memory bus is enough; a PostgreSQL LISTEN/NOTIFY transport could replace
 * `subscribe` delivery later without changing the publish call sites.
 */
export type RealtimeEvent =
  | { type: 'notification'; id: string; kind: string; title: string; href: string }
  | { type: 'points'; balance?: number }
  | { type: 'submission'; id: string; quest_id: string; status: string }
  | { type: 'quest_published'; id: string; title: string; town: string | null }
  | { type: 'plaza_activity'; id: string }
  | { type: 'funding'; plan_id: string; quest_id: string };

export type RealtimeTarget = { userId: string } | 'all';
export type RealtimeListener = (target: RealtimeTarget, event: RealtimeEvent) => void;

const listeners = new Set<RealtimeListener>();

export function subscribe(listener: RealtimeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(target: RealtimeTarget, event: RealtimeEvent): void {
  for (const listener of listeners) {
    try {
      listener(target, event);
    } catch (err) {
      console.error('[realtime] listener failed:', err);
    }
  }
}

/** Never throws: a realtime failure must not break the request that caused it. */
export function publishToUser(userId: string, event: RealtimeEvent): void {
  if (!userId) return;
  emit({ userId }, event);
}

export function publishBroadcast(event: RealtimeEvent): void {
  emit('all', event);
}

const pending = new WeakMap<object, Array<() => void>>();

function run(fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error('[realtime] publish failed:', err);
  }
}

function sqlVerb(arg: unknown): string {
  const text = typeof arg === 'string' ? arg : (arg as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text.trim().replace(/;$/, '').toUpperCase() : '';
}

/**
 * Publishes once the caller's transaction commits. `client` is whatever the
 * caller queries through: a checked-out pool client (has `release`) waits for
 * COMMIT, is dropped on ROLLBACK, and flushes on release if no transaction
 * statement was seen (autocommit) unless released with an error. Anything else (Pool, fakes) autocommits, so
 * the event goes out immediately.
 */
export function publishAfterCommit(client: unknown, fn: () => void): void {
  const c = client as { query?: (...args: any[]) => any; release?: (...args: any[]) => any } | null;
  if (!c || typeof c.query !== 'function' || typeof c.release !== 'function') {
    run(fn);
    return;
  }
  const queued = pending.get(c);
  if (queued) {
    queued.push(fn);
    return;
  }
  const queue = [fn];
  pending.set(c, queue);
  const originalQuery = c.query;
  const originalRelease = c.release;
  const finish = (flush: boolean) => {
    if (pending.get(c) !== queue) return;
    pending.delete(c);
    c.query = originalQuery;
    c.release = originalRelease;
    if (flush) queue.forEach(run);
  };
  c.query = function (this: unknown, ...args: any[]) {
    const result = originalQuery.apply(this, args);
    const verb = sqlVerb(args[0]);
    if (verb === 'COMMIT' || verb === 'END' || verb === 'ROLLBACK') {
      Promise.resolve(result).then(
        (r: any) => finish(verb !== 'ROLLBACK' && r?.command !== 'ROLLBACK'),
        () => finish(false),
      );
    }
    return result;
  };
  c.release = function (this: unknown, ...args: any[]) {
    finish(!args[0]); // release(err) destroys the connection: the transaction did not commit

    return originalRelease.apply(this, args);
  };
}
