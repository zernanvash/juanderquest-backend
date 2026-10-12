import { createTestDb } from '../src/db/testHarness';
import { verifyMigrations } from '../src/db/migrations';

describe('read-only runtime migration gate', () => {
  it('accepts an exact ledger and rejects missing, altered, and unknown migrations', async () => {
    const fixture = await createTestDb();
    try {
      await expect(verifyMigrations(fixture.pool)).resolves.toBeUndefined();
      const original = await fixture.pool.query(
        "SELECT checksum FROM schema_migrations WHERE filename = '029_economic_ledger_integrity.sql'"
      );
      const checksum = String(original.rows[0].checksum);
      await fixture.pool.query(
        "UPDATE schema_migrations SET checksum = 'altered' WHERE filename = '029_economic_ledger_integrity.sql'"
      );
      await expect(verifyMigrations(fixture.pool)).rejects.toThrow(/checksum mismatch/);
      await fixture.pool.query(
        "UPDATE schema_migrations SET checksum = $1 WHERE filename = '029_economic_ledger_integrity.sql'",
        [checksum]
      );
      await fixture.pool.query("INSERT INTO schema_migrations(filename, checksum) VALUES ('999_unknown.sql', 'x')");
      await expect(verifyMigrations(fixture.pool)).rejects.toThrow(/unknown migrations/);
      await fixture.pool.query("DELETE FROM schema_migrations WHERE filename = '999_unknown.sql'");
      await fixture.pool.query("DELETE FROM schema_migrations WHERE filename = '029_economic_ledger_integrity.sql'");
      await expect(verifyMigrations(fixture.pool)).rejects.toThrow(/missing or has no checksum/);
    } finally {
      await fixture.close();
    }
  });
});
