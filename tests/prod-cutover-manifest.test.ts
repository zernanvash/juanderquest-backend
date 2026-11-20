// Plan 116 §9: pure logic of the fail-closed carry manifest (no database).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertWritableTarget, describeUrl } from '../scripts/prod-cutover/lib/db';
import type { SchemaInfo, TableInfo } from '../scripts/prod-cutover/lib/introspect';
import { parseTextArray } from '../scripts/prod-cutover/lib/introspect';
import {
  type Manifest,
  type TableSpec,
  bindPlaceholders,
  csv,
  emailDomain,
  isCarriedUser,
  parseConfirmFile,
  transferOrder,
  validateManifest,
} from '../scripts/prod-cutover/lib/manifest';
import { REVERSE_FORBIDDEN_COLUMNS, assertReverseTarget, reverseTables } from '../scripts/prod-cutover/reverse-carry';
import { parseArgs, parseTimestamp } from '../scripts/prod-cutover/carry';

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'scripts', 'prod-cutover', 'carry-manifest.json'), 'utf8'),
) as Manifest;

const col = (name: string, extra: Partial<TableInfo['columns'][number]> = {}) => ({
  name,
  type: 'text',
  notNull: false,
  generated: false,
  identity: '' as const,
  hasDefault: false,
  ...extra,
});
function table(name: string, cols: string[], fks: [string, string][] = [], extra: Partial<TableInfo> = {}): TableInfo {
  return {
    name,
    columns: cols.map((c) => col(c, c === 'id' ? { notNull: true } : {})),
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys: fks.map(([c, ref]) => ({
      name: `${name}_${c}_fkey`,
      columns: [c],
      refTable: ref,
      refColumns: ['id'],
      deferrable: false,
    })),
    ...extra,
  };
}
const schema = (...tables: TableInfo[]): SchemaInfo => ({
  tables: new Map(tables.map((t) => [t.name, t])),
  sequences: [],
});

describe('carry-manifest.json', () => {
  it('classifies every table with a known mode and a reason', () => {
    const entries = Object.entries(manifest.tables);
    expect(entries.length).toBeGreaterThanOrEqual(160);
    for (const [name, spec] of entries) {
      expect([name, ['carry', 'carry-filtered', 'regenerate', 'empty', 'ignore'].includes(spec.mode)]).toEqual([
        name,
        true,
      ]);
      expect(spec.reason.length).toBeGreaterThan(10);
      if (spec.mode === 'carry' || spec.mode === 'carry-filtered') {
        expect(manifest.groups).toContain(spec.group);
        expect(spec.columns?.length).toBeGreaterThan(0);
        expect(JSON.stringify(spec.columns)).not.toContain('*');
      }
    }
  });

  it('never carries progression, ledgers, wallets, social, devices or analytics', () => {
    for (const t of [
      'achievement_awards',
      'progression_events',
      'progression_totals',
      'stamp_ledger',
      'governance_ledger',
      'user_streaks',
      'user_follows',
      'social_activities',
      'user_notifications',
      'user_devices',
      'push_deliveries',
      'web_analytics_events',
      'spot_activity_events',
      'chain_commands',
      'economic_transactions',
      'quest_attempts',
      'daily_claims',
    ])
      expect([t, manifest.tables[t].mode]).toEqual([t, 'empty']);
    const users = manifest.tables.users;
    expect(users.transform).toMatchObject({
      demo_points: '0',
      scout_reputation: '0',
      wallet_address: 'NULL',
      featured_badges: "'{}'::text[]",
    });
    expect(users.deferred).toEqual(['favorite_spot_id']);
    expect(manifest.tables.auth_identities.filter).toContain("provider <> 'wallet'");
  });

  it('gates community spots, quests, merchants, festivals and collections behind the confirm file', () => {
    expect(Object.keys(manifest.confirmGroups).sort()).toEqual([
      'community_spots',
      'curated_collections',
      'festivals',
      'merchants',
      'quests',
    ]);
    for (const [g, cg] of Object.entries(manifest.confirmGroups))
      expect(manifest.tables[cg.table].filter).toContain(`{{confirm:${g}}}`);
  });

  it('reverse section writes only account tables and never the sanitised columns', () => {
    const tables = reverseTables(manifest);
    expect(Object.keys(tables).sort()).toEqual(
      [
        'account_emails',
        'auth_identities',
        'discovery_preferences',
        'password_credentials',
        'user_engagement_preferences',
        'user_notification_preferences',
        'users',
      ].sort(),
    );
    for (const c of REVERSE_FORBIDDEN_COLUMNS.users) expect(tables.users.columns).not.toContain(c);
    const bad = structuredClone(manifest);
    bad.reverse.tables.users.columns.push('demo_points');
    expect(() => reverseTables(bad)).toThrow(/must not write back demo_points/);
    const bad2 = structuredClone(manifest);
    (bad2.reverse.tables as Record<string, unknown>).spots = { columns: ['id'], filter: '{{since}}' };
    expect(() => reverseTables(bad2)).toThrow(/not an account table/);
  });
});

describe('validateManifest (fail-closed)', () => {
  const users = table('users', ['id', 'email', 'fav']);
  const spots = table('spots', ['id', 'created_by'], [['created_by', 'users']]);
  const base = (): Pick<Manifest, 'groups' | 'tables' | 'confirmGroups'> => ({
    groups: ['a'],
    confirmGroups: {},
    tables: {
      users: { mode: 'carry', group: 'a', reason: 'r', columns: ['id', 'email', 'fav'] },
      spots: {
        mode: 'carry',
        group: 'a',
        reason: 'r',
        columns: ['id', 'created_by'],
        onParentMissing: { created_by: 'null' },
      },
    },
  });

  it('accepts a matching manifest', () => {
    expect(validateManifest(base(), schema(users, spots), schema(users, spots))).toEqual([]);
  });

  it('refuses a table that exists in source or target but not in the manifest', () => {
    const errs = validateManifest(
      base(),
      schema(users, spots, table('new_src', ['id'])),
      schema(users, spots, table('new_tgt', ['id'])),
    );
    expect(errs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/new_src: present in source/),
        expect.stringMatching(/new_tgt: present in target/),
      ]),
    );
  });

  it('refuses unknown columns, uncovered columns and stale tables', () => {
    const m = base();
    m.tables.users.columns = ['id', 'email', 'nope'];
    m.tables.ghost = { mode: 'empty', reason: 'gone' };
    const errs = validateManifest(m, schema(users, spots), schema(users, spots));
    expect(errs).toEqual(
      expect.arrayContaining([
        'table ghost: in the manifest but in neither database',
        'table users: column nope does not exist in the target',
        'table users: column nope does not exist in the source and has no transform',
        'table users: column fav exists in source and target but is neither carried nor omitted',
      ]),
    );
  });

  it('refuses NULL-on-drop for NOT NULL or non-FK columns, and NOT NULL target columns left unwritten', () => {
    const strictSpots = table('spots', ['id', 'created_by', 'must'], [['created_by', 'users']]);
    strictSpots.columns[1].notNull = true;
    strictSpots.columns[2].notNull = true;
    const m = base();
    m.tables.users.onParentMissing = { email: 'null' };
    m.tables.spots.omit = { must: 'test' };
    const errs = validateManifest(m, schema(users, strictSpots), schema(users, strictSpots));
    expect(errs).toEqual(
      expect.arrayContaining([
        'table users: onParentMissing column email is not a single-column foreign key in the target',
        'table spots: onParentMissing column created_by is NOT NULL in the target',
        'table spots: target column must is NOT NULL without default but is not written',
      ]),
    );
  });

  it('refuses generated target columns and non-carry modes with column lists', () => {
    const gen = table('spots', ['id', 'created_by', 'geog'], [['created_by', 'users']]);
    gen.columns[2].generated = true;
    const m = base();
    m.tables.spots.columns = ['id', 'created_by', 'geog'];
    m.tables.users = { mode: 'empty', reason: 'x', columns: ['id'] } as TableSpec;
    const errs = validateManifest(m, schema(users, gen), schema(users, gen));
    expect(errs).toEqual(
      expect.arrayContaining([
        'table spots: column geog is generated in the target',
        'table users: "columns" is only allowed for carry modes',
      ]),
    );
  });
});

describe('transferOrder', () => {
  const users = table('users', ['id', 'fav'], [['fav', 'spots']]);
  const spots = table('spots', ['id', 'created_by'], [['created_by', 'users']]);
  const ids = table('ids', ['id', 'user_id'], [['user_id', 'users']]);
  const tgt = schema(users, spots, ids);
  const tables: Record<string, TableSpec> = {
    users: { mode: 'carry', group: 'a', reason: 'r', columns: ['id', 'fav'], deferred: ['fav'] },
    spots: { mode: 'carry', group: 'b', reason: 'r', columns: ['id', 'created_by'] },
    ids: { mode: 'carry', group: 'a', reason: 'r', columns: ['id', 'user_id'] },
  };

  it('puts parents first, groups in order, deferred columns break cycles', () => {
    expect(transferOrder(tables, ['a', 'b'], tgt).map((t) => t.name)).toEqual(['users', 'ids', 'spots']);
  });

  it('throws on an undeclared cycle', () => {
    const t = structuredClone(tables);
    delete t.users.deferred;
    t.spots.group = 'a';
    expect(() => transferOrder(t, ['a', 'b'], tgt)).toThrow(/cycle/);
  });

  it('throws when a parent sits in a later group', () => {
    const t = structuredClone(tables);
    t.users.group = 'b';
    t.ids.group = 'a';
    expect(() => transferOrder(t, ['a', 'b'], tgt)).toThrow(/later group/);
  });
});

describe('helpers', () => {
  it('D2 user rule', () => {
    const u = (email: string, role = 'user', is_test = false) => isCarriedUser({ email, role, is_test });
    expect(u('ana@gmail.com')).toBe(true);
    expect(u('x@cdd.edu.ph')).toBe(true);
    expect(u('x@lgu.pangasinan.gov.ph', 'admin')).toBe(true);
    expect(u('x@example.test', 'admin')).toBe(true); // admins carry regardless of domain
    expect(u('x@guest.invalid')).toBe(false);
    expect(u('x@simulation.invalid')).toBe(false);
    expect(u('x@example.test')).toBe(false);
    expect(u('x@juanderquest.local')).toBe(false);
    expect(u('x@wallet.juanderquest.local')).toBe(false);
    expect(u('x@GUEST.INVALID')).toBe(false);
    expect(u('x@gmail.com', 'user', true)).toBe(false);
    expect(u('x@gmail.com', 'qa')).toBe(false);
    expect(u('no-at-sign')).toBe(false);
    expect(emailDomain('a@b@Example.COM ')).toBe('example.com');
  });

  it('binds placeholders and refuses unknown ones', () => {
    expect(
      bindPlaceholders('s.id = ANY({{confirm:quests}}) AND s.t >= {{since}}', {
        confirm: { quests: ['q1'] },
        since: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({
      text: 's.id = ANY($1::text[]) AND s.t >= $2::timestamptz',
      params: [['q1'], '2026-01-01T00:00:00.000Z'],
    });
    expect(() => bindPlaceholders('{{confirm:nope}}', { confirm: {} })).toThrow(/no confirm list/);
    expect(() => bindPlaceholders('{{since}}', {})).toThrow(/without a since/);
    expect(() => bindPlaceholders('{{drop}}', {})).toThrow(/unknown placeholder/);
  });

  it('parses confirm files strictly', () => {
    expect(parseConfirmFile({ _comment: 'x', quests: ['b', 'a'] }, ['quests', 'merchants'])).toEqual({
      quests: ['a', 'b'],
    });
    expect(() => parseConfirmFile({ spots: [] }, ['quests'])).toThrow(/unknown group/);
    expect(() => parseConfirmFile({ quests: 'q1' }, ['quests'])).toThrow(/array of ids/);
    expect(() => parseConfirmFile({ quests: ['a', 'a'] }, ['quests'])).toThrow(/duplicate/);
    expect(() => parseConfirmFile([], ['quests'])).toThrow(/JSON object/);
  });

  it('refuses live production and same-database targets', () => {
    const url = (db: string, port = 55461) => `postgres://u:secret@127.0.0.1:${port}/${db}`;
    expect(() => assertWritableTarget(url('juanderquest_alpha'))).toThrow(/live production/);
    expect(() => assertWritableTarget(url('jdq_r_carry', 55433))).toThrow(/port 55433/);
    expect(() => assertWritableTarget('postgres://u:p@10.0.0.5:55461/jdq_r_carry')).toThrow(/non-loopback/);
    expect(() => assertWritableTarget(url('jdq_r_carry'), url('jdq_r_carry'))).toThrow(/same database/);
    expect(() => assertWritableTarget(url('jdq_r_carry'), url('jdq_old_copy'))).not.toThrow();
    expect(describeUrl(url('jdq_r_carry'))).toBe('u@127.0.0.1:55461/jdq_r_carry');
    expect(describeUrl(url('jdq_r_carry'))).not.toContain('secret');
  });

  it('reverse carry refuses jdq_old_copy and unapproved live targets', () => {
    const url = (db: string, port = 55461) => `postgres://u:p@127.0.0.1:${port}/${db}`;
    expect(() => assertReverseTarget(url('jdq_old_copy'), url('jdq_r_carry'), 'public', 'public')).toThrow(
      /jdq_old_copy/,
    );
    delete process.env.JDQ_OWNER_APPROVED_REVERSE_CARRY;
    expect(() =>
      assertReverseTarget(url('juanderquest_alpha', 55433), url('juanderquest_prod'), 'public', 'public'),
    ).toThrow(/owner OK/);
    expect(() => assertReverseTarget(url('jdq_r_carry'), url('jdq_r_carry'), 'public', 'public')).toThrow(
      /same schema/,
    );
    expect(() =>
      assertReverseTarget(url('jdq_r_carry'), url('jdq_r_carry'), 'public', 'reverse_scratch'),
    ).not.toThrow();
  });

  it('parses CLI arguments (dry-run by default)', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(() => parseArgs(['--apply', '--dry-run'])).toThrow(/exclusive/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
    expect(parseArgs(['--delta-since', '2026-11-20T08:00:00+08:00']).deltaSince).toBe('2026-11-20T00:00:00.000Z');
    expect(() => parseTimestamp('2026-11-20')).toThrow(/ISO timestamp/);
  });

  it('writes CSV with quoting and parses text[] literals', () => {
    expect(csv([{ a: 'x,y', b: 'say "hi"', c: null }], ['a', 'b', 'c'])).toBe('a,b,c\n"x,y","say ""hi""",\n');
    expect(parseTextArray('{id,"user_id"}')).toEqual(['id', 'user_id']);
    expect(parseTextArray('{}')).toEqual([]);
  });
});
