// Plan 116 §9 / §11: the carry engine end to end on real PostgreSQL, using a small
// source schema and target schema in the test database (fail-closed manifest, dry-run
// rollback, FK closure, NULL-on-drop, deferred cycle columns, refusal of a second full run,
// delta run, deterministic digests, reverse carry into an old-shape scratch schema).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'pg';
import { runCarry } from '../scripts/prod-cutover/carry';
import { connect } from '../scripts/prod-cutover/lib/db';
import { type Manifest, isCarriedUser } from '../scripts/prod-cutover/lib/manifest';
import { buildScratchSchema } from '../scripts/prod-cutover/make-reverse-scratch';
import { runReverse } from '../scripts/prod-cutover/reverse-carry';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

const real = JSON.parse(
  readFileSync(join(__dirname, '..', 'scripts', 'prod-cutover', 'carry-manifest.json'), 'utf8'),
) as Manifest;
const USER_FILTER = real.tables.users.filter as string;

const ddl = (s: string, target: boolean) => `
  CREATE SCHEMA ${s};
  CREATE TABLE ${s}.users (id text PRIMARY KEY, email text NOT NULL UNIQUE, role text NOT NULL, is_test boolean NOT NULL DEFAULT false,
    handle text UNIQUE, demo_points integer NOT NULL DEFAULT 0, prefs jsonb NOT NULL DEFAULT '{}', tags text[] NOT NULL DEFAULT '{}',
    favorite_spot_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE ${s}.quests (id text PRIMARY KEY, title text NOT NULL, is_test boolean NOT NULL DEFAULT false, author_id text REFERENCES ${s}.users);
  CREATE TABLE ${s}.spots (id text PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL, created_by text REFERENCES ${s}.users,
    quest_id text REFERENCES ${s}.quests, lat double precision NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()${target ? ', launch_tier text' : ''});
  ALTER TABLE ${s}.users ADD FOREIGN KEY (favorite_spot_id) REFERENCES ${s}.spots;
  CREATE TABLE ${s}.auth_identities (id text PRIMARY KEY, user_id text NOT NULL REFERENCES ${s}.users, provider text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE ${s}.spot_reports (id text PRIMARY KEY, spot_id text NOT NULL REFERENCES ${s}.spots, user_id text REFERENCES ${s}.users,
    status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE ${s}.audit_log (id bigserial PRIMARY KEY, note text);
  ${target ? `CREATE TABLE ${s}.seed_runs (id text PRIMARY KEY);` : ''}`;

function miniManifest(): Manifest {
  return {
    version: 1,
    plan: 'test',
    groups: ['accounts', 'content', 'community'],
    confirmGroups: {
      quests: { table: 'quests', description: 'q', eligible: 'NOT s.is_test', list: { id: 's.id', title: 's.title' } },
    },
    ownerLists: {
      users: {
        table: 'users',
        description: 'u',
        orderBy: '1',
        list: { handle: 's.handle', email_domain: "split_part(s.email, '@', 2)", has_email_login: 'TRUE' },
      },
    },
    tables: {
      users: {
        mode: 'carry-filtered',
        group: 'accounts',
        reason: 'D2 users',
        columns: [
          'id',
          'email',
          'role',
          'is_test',
          'handle',
          'demo_points',
          'prefs',
          'tags',
          'favorite_spot_id',
          'created_at',
          'updated_at',
        ],
        filter: USER_FILTER,
        transform: { demo_points: '0' },
        onParentMissing: { favorite_spot_id: 'null' },
        deferred: ['favorite_spot_id'],
      },
      auth_identities: {
        mode: 'carry-filtered',
        group: 'accounts',
        reason: 'identities',
        columns: ['id', 'user_id', 'provider', 'created_at', 'updated_at'],
        filter: "s.provider <> 'wallet'",
      },
      quests: {
        mode: 'carry-filtered',
        group: 'content',
        reason: 'confirmed quests',
        columns: ['id', 'title', 'is_test', 'author_id'],
        filter: 'NOT s.is_test AND s.id = ANY({{confirm:quests}})',
      },
      spots: {
        mode: 'carry',
        group: 'content',
        reason: 'all spots',
        columns: ['id', 'slug', 'name', 'created_by', 'quest_id', 'lat', 'created_at', 'updated_at'],
        existing: 'update',
        onParentMissing: { created_by: 'null', quest_id: 'null' },
      },
      spot_reports: {
        mode: 'carry-filtered',
        group: 'community',
        reason: 'open reports',
        columns: ['id', 'spot_id', 'user_id', 'status', 'created_at', 'updated_at'],
        filter: "s.status = 'pending'",
      },
      audit_log: { mode: 'empty', reason: 'history stays behind' },
      seed_runs: { mode: 'ignore', reason: 'target only' },
    },
    reverse: {
      description: 'r',
      tables: {
        users: {
          columns: ['id', 'email', 'role', 'is_test', 'handle', 'prefs', 'tags', 'created_at', 'updated_at'],
          filter: '(s.created_at >= {{since}} OR s.updated_at >= {{since}})',
        },
        auth_identities: {
          columns: ['id', 'user_id', 'provider', 'created_at', 'updated_at'],
          filter: "s.provider <> 'wallet' AND (s.created_at >= {{since}} OR s.updated_at >= {{since}})",
        },
      },
    },
  };
}

realPg('prod-cutover carry engine (real PostgreSQL)', () => {
  const tag = randomUUID().replace(/-/g, '').slice(0, 10);
  const SRC = `carry_src_${tag}`;
  const TGT = `carry_tgt_${tag}`;
  const REV = `reverse_scratch_${tag}`;
  const out = mkdtempSync(join(tmpdir(), 'carry-test-'));
  let source: Client;
  let target: Client;
  const manifest = miniManifest();
  const text = JSON.stringify(manifest);
  const quiet = () => undefined;
  const carry = (apply: boolean, extra: { deltaSince?: string; confirm?: unknown; manifest?: Manifest } = {}) =>
    runCarry({
      source,
      target,
      manifest: extra.manifest ?? manifest,
      manifestText: text,
      args: { apply, deltaSince: extra.deltaSince ?? null, out },
      confirmRaw: extra.confirm === undefined ? { quests: ['q1'] } : extra.confirm,
      sourceSchema: SRC,
      targetSchema: TGT,
      skipVerifyMigrations: true,
      log: quiet,
    });
  const count = async (sql: string) => Number((await target.query(sql)).rows[0].n);

  beforeAll(async () => {
    source = await connect(process.env.JDQ_REAL_PG_URL as string, 'carry-test-src');
    target = await connect(process.env.JDQ_REAL_PG_URL as string, 'carry-test-tgt');
    await source.query(ddl(SRC, false));
    await target.query(ddl(TGT, true));
    await source.query(`
      INSERT INTO ${SRC}.users (id, email, role, is_test, handle, demo_points, prefs, tags, created_at, updated_at) VALUES
        ('a1', 'boss@example.test', 'admin', false, 'boss', 50, '{"k":[1,"two"]}', '{x,"y z"}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('u1', 'ana@gmail.com', 'user', false, 'ana', 900, '{}', '{}', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('g1', 'g@guest.invalid', 'user', false, NULL, 1, '{}', '{}', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
        ('s1', 's@wallet.juanderquest.local', 'user', false, 'sim', 1, '{}', '{}', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
        ('t1', 't@gmail.com', 'user', true, 'tester', 1, '{}', '{}', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
        ('qa', 'qa@cdd.edu.ph', 'qa', false, 'qa', 1, '{}', '{}', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z');
      INSERT INTO ${SRC}.quests VALUES ('q1', 'Confirmed', false, 'a1'), ('q2', 'Not confirmed', false, 'a1');
      INSERT INTO ${SRC}.spots (id, slug, name, created_by, quest_id, lat, created_at, updated_at) VALUES
        ('sp1', 'sp-1', 'By guest', 'g1', NULL, 16.1, '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z'),
        ('sp2', 'sp-2', 'With quest', 'u1', 'q1', 16.123456789012345, '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z'),
        ('sp3', 'sp-3', 'Unconfirmed quest', 'a1', 'q2', 16.3, '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z');
      UPDATE ${SRC}.users SET favorite_spot_id = 'sp2' WHERE id IN ('u1', 'g1');
      INSERT INTO ${SRC}.auth_identities (id, user_id, provider, created_at, updated_at) VALUES
        ('i1', 'u1', 'email', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('i2', 'u1', 'wallet', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('i3', 'g1', 'email', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
      INSERT INTO ${SRC}.spot_reports (id, spot_id, user_id, status, created_at, updated_at) VALUES
        ('r1', 'sp1', 'u1', 'pending', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z'),
        ('r2', 'sp1', 'g1', 'pending', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z'),
        ('r3', 'sp1', 'u1', 'reviewed', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z');
      INSERT INTO ${SRC}.audit_log (note) VALUES ('old');`);
    // A migration-seeded spot already in the target (policy "update": live values win).
    await target.query(
      `INSERT INTO ${TGT}.spots (id, slug, name, lat, launch_tier) VALUES ('sp3', 'sp-3', 'Seeded name', 16.3, 'featured')`,
    );
  });

  afterAll(async () => {
    await target?.query(
      `DROP SCHEMA IF EXISTS ${SRC} CASCADE; DROP SCHEMA IF EXISTS ${TGT} CASCADE; DROP SCHEMA IF EXISTS ${REV} CASCADE`,
    );
    await source?.end();
    await target?.end();
  });

  it('the users filter SQL matches isCarriedUser()', async () => {
    const { rows } = await source.query(
      `SELECT id, email, role, is_test, (${USER_FILTER}) AS sel FROM ${SRC}.users s ORDER BY id`,
    );
    for (const r of rows)
      expect([r.id, r.sel === 't']).toEqual([
        r.id,
        isCarriedUser({ email: r.email, role: r.role, is_test: r.is_test === 't' }),
      ]);
    expect(rows.filter((r) => r.sel === 't').map((r) => r.id)).toEqual(['a1', 'u1']);
  });

  it('dry-run computes everything, writes the report and leaves the target untouched', async () => {
    const { report, engine } = await carry(false);
    expect(await count(`SELECT count(*) AS n FROM ${TGT}.users`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM ${TGT}.spots WHERE name = 'Seeded name'`)).toBe(1);
    const t = engine.tables;
    expect(t.users).toMatchObject({ sourceRows: 6, filteredOut: 4, staged: 2, carried: 2, inserted: 2 });
    expect(t.auth_identities).toMatchObject({
      sourceRows: 3,
      filteredOut: 1,
      carried: 1,
      fkDropped: { 'user_id->users': 1 },
    });
    expect(t.quests).toMatchObject({ carried: 1 });
    expect(t.spots).toMatchObject({ carried: 3, inserted: 2, updated: 1, fkNulled: { created_by: 1, quest_id: 1 } });
    expect(t.spot_reports).toMatchObject({ filteredOut: 1, carried: 1, fkDropped: { 'user_id->users': 1 } });
    expect(report.mode).toBe('dry-run');
    expect(report.tables.audit_log).toMatchObject({ mode: 'empty', sourceRows: 1, targetRows: 0 });
    expect(report.tables.seed_runs).toMatchObject({ mode: 'ignore', sourceRows: null, targetRows: 0 });
    const csvText = readFileSync(join(out, 'users.csv'), 'utf8');
    expect(csvText).not.toContain('@'); // domains only, never full emails
    expect(csvText).toContain('gmail.com');
    expect(readFileSync(join(out, 'confirm-quests.csv'), 'utf8')).toContain('q2,Not confirmed,t,f');
  });

  it('dry-runs are deterministic', async () => {
    const a = (await carry(false)).engine.tables;
    const b = (await carry(false)).engine.tables;
    for (const n of Object.keys(a))
      expect([n, a[n].keyDigest, a[n].rowDigest]).toEqual([n, b[n].keyDigest, b[n].rowDigest]);
  });

  it('refuses a manifest that misses a table or names a missing column', async () => {
    await source.query(`CREATE TABLE ${SRC}.surprise (id text PRIMARY KEY)`);
    await expect(carry(false)).rejects.toThrow(/surprise: present in source but not in the manifest/);
    await source.query(`DROP TABLE ${SRC}.surprise`);
    const bad = miniManifest();
    bad.tables.spots.columns = [...(bad.tables.spots.columns as string[]), 'nope'];
    await expect(carry(false, { manifest: bad })).rejects.toThrow(/column nope does not exist/);
    await expect(carry(false, { confirm: { quests: ['q404'] } })).rejects.toThrow(/not eligible: q404/);
  });

  let applyDigests: Record<string, string> = {};
  it('--apply carries the rows with FK closure, sanitising and deferred columns', async () => {
    const { engine, report } = await carry(true);
    applyDigests = Object.fromEntries(Object.entries(engine.tables).map(([n, r]) => [n, r.rowDigest]));
    expect(report.run.committedGroups).toEqual(['accounts', 'content', 'community', 'deferred+sequences']);
    const users = (
      await target.query(
        `SELECT id, demo_points, favorite_spot_id, prefs::text, tags::text FROM ${TGT}.users ORDER BY id`,
      )
    ).rows;
    expect(users).toEqual([
      { id: 'a1', demo_points: '0', favorite_spot_id: null, prefs: '{"k": [1, "two"]}', tags: '{x,"y z"}' },
      { id: 'u1', demo_points: '0', favorite_spot_id: 'sp2', prefs: '{}', tags: '{}' },
    ]);
    const spots = (
      await target.query(`SELECT id, created_by, quest_id, name, lat::text, launch_tier FROM ${TGT}.spots ORDER BY id`)
    ).rows;
    // Doubles travel as their exact text form: the target prints the same value as the source.
    const srcLat = (await source.query(`SELECT lat::text FROM ${SRC}.spots WHERE id = 'sp2'`)).rows[0].lat;
    expect(srcLat).toMatch(/^16\.12345678901234/);
    expect(spots).toEqual([
      { id: 'sp1', created_by: null, quest_id: null, name: 'By guest', lat: '16.1', launch_tier: null },
      { id: 'sp2', created_by: 'u1', quest_id: 'q1', name: 'With quest', lat: srcLat, launch_tier: null },
      { id: 'sp3', created_by: 'a1', quest_id: null, name: 'Unconfirmed quest', lat: '16.3', launch_tier: 'featured' },
    ]);
    expect(await count(`SELECT count(*) AS n FROM ${TGT}.audit_log`)).toBe(0);
    expect(readdirSync(join(out, 'runs')).some((f) => f.endsWith('-apply.json'))).toBe(true);
  });

  it('a second full --apply is refused and changes nothing', async () => {
    await expect(carry(true)).rejects.toThrow(
      /already holds carried rows \(users=2, auth_identities=1, quests=1, spot_reports=1\)/,
    );
    expect(await count(`SELECT count(*) AS n FROM ${TGT}.users`)).toBe(2);
  });

  it('--delta-since picks up new and changed rows only, and a repeat is a no-op', async () => {
    const since = '2026-06-01T00:00:00.000Z';
    await source.query(`
      INSERT INTO ${SRC}.users (id, email, role, handle, created_at, updated_at) VALUES ('u2', 'ben@yahoo.com', 'user', 'ben', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
      UPDATE ${SRC}.users SET handle = 'ana2', updated_at = '2026-07-02T00:00:00Z' WHERE id = 'u1';
      INSERT INTO ${SRC}.auth_identities (id, user_id, provider, created_at, updated_at) VALUES ('i4', 'u2', 'email', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');`);
    const first = await carry(true, { deltaSince: since });
    expect(first.engine.tables.users).toMatchObject({ inserted: 1, updated: 1, outsideDeltaWindow: 0 });
    expect(first.engine.tables.auth_identities).toMatchObject({ inserted: 1, updated: 0 });
    expect(first.engine.tables.spots).toMatchObject({ inserted: 0, updated: 0, unchanged: 3 });
    expect(first.engine.tables.spots.rowDigest).toBe(applyDigests.spots); // unchanged tables diff clean
    expect(first.engine.tables.users.rowDigest).not.toBe(applyDigests.users);
    expect((await target.query(`SELECT handle FROM ${TGT}.users WHERE id = 'u1'`)).rows[0].handle).toBe('ana2');
    const again = await carry(true, { deltaSince: since });
    expect(again.engine.totals.changes).toBe(0);
    // A change older than the window is still applied but flagged.
    await source.query(`UPDATE ${SRC}.spots SET name = 'Renamed quietly' WHERE id = 'sp1'`);
    const stale = await carry(false, { deltaSince: since });
    expect(stale.engine.tables.spots).toMatchObject({ updated: 1, outsideDeltaWindow: 1 });
    expect(stale.report.warnings).toContain('spots: 1 new/changed row(s) older than --delta-since');
    await source.query(`UPDATE ${SRC}.spots SET name = 'By guest' WHERE id = 'sp1'`);
  });

  it('reverse carry copies new-DB accounts back into an old-shape scratch schema (dry-run default, idempotent)', async () => {
    await buildScratchSchema(source, target, REV, true, SRC);
    // The old DB already holds a1 with its real points; reverse must not clobber them.
    await target.query(
      `INSERT INTO ${REV}.users (id, email, role, handle, demo_points) VALUES ('a1', 'boss@example.test', 'admin', 'boss', 50)`,
    );
    const reverse = (apply: boolean, since = '2026-06-01T00:00:00.000Z') =>
      runReverse({
        source,
        target,
        manifest,
        manifestText: text,
        since,
        apply,
        sourceSchema: TGT,
        targetSchema: REV,
        log: quiet,
      });
    const dry = await reverse(false);
    expect(dry.engine.tables.users).toMatchObject({ staged: 2, inserted: 2 }); // u1 (changed) + u2 (new) in the window
    expect(await count(`SELECT count(*) AS n FROM ${REV}.users`)).toBe(1);
    const applied = await reverse(true);
    expect(applied.engine.tables.users).toMatchObject({ inserted: 2 });
    expect(applied.engine.tables.auth_identities).toMatchObject({ inserted: 1 });
    expect((await reverse(true)).engine.totals.changes).toBe(0);
    await target.query(`UPDATE ${TGT}.users SET handle = 'boss2', updated_at = '2026-08-01T00:00:00Z' WHERE id = 'a1'`);
    expect((await reverse(true)).engine.tables.users).toMatchObject({ updated: 1 });
    expect((await target.query(`SELECT handle, demo_points FROM ${REV}.users WHERE id = 'a1'`)).rows[0]).toEqual({
      handle: 'boss2',
      demo_points: '50',
    });
  });
});
