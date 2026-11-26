import { readdirSync } from 'fs';
import { join } from 'path';
import { MIGRATIONS, discoverMigrations } from '../src/db/migrations.js';

// Plan 125d: migrations numbered 119+ are discovered from migrations/ instead of listed by hand.
describe('Plan 125d migration discovery', () => {
  const historic = ['001_init.sql', '096_b.sql', '092_a.sql', '118_last.sql'];

  it('returns the historic list unchanged when there are no 119+ files', () => {
    expect(discoverMigrations(historic, [...historic].reverse())).toEqual(historic);
    expect(discoverMigrations(historic, [])).toEqual(historic);
  });

  it('appends 119+ files after the historic list, sorted by number, ignoring non-sql files', () => {
    const files = [...historic, '121_c.sql', 'README.md', '119_a.sql', '120_b.sql'];
    expect(discoverMigrations(historic, files)).toEqual([...historic, '119_a.sql', '120_b.sql', '121_c.sql']);
  });

  it('throws on two files sharing a number', () => {
    expect(() => discoverMigrations(historic, ['119_a.sql', '119_b.sql'])).toThrow(/Duplicate migration number 119/);
  });

  it('throws on a stray file below 119 that is not in the historic list', () => {
    expect(() => discoverMigrations(historic, ['118_other.sql'])).toThrow(/Stray migration 118_other\.sql/);
    expect(() => discoverMigrations(historic, ['050_new.sql'])).toThrow(/Stray migration/);
  });

  it('throws on a badly named sql file', () => {
    expect(() => discoverMigrations(historic, ['119-Bad Name.sql'])).toThrow(/NNN_lower_snake/);
  });

  it('MIGRATIONS covers every file in migrations/ exactly once', () => {
    const onDisk = readdirSync(join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql'));
    expect([...MIGRATIONS].sort()).toEqual(onDisk.sort());
    expect(new Set(MIGRATIONS).size).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.indexOf('118_spot_feed_impressions.sql')).toBeGreaterThan(-1);
  });
});
