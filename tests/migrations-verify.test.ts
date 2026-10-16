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

  it('applies the single-completed-attempt backstop and rejects a second completion', async () => {
    const fixture = await createTestDb();
    try {
      await fixture.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email) VALUES
         ('completion-user', 'completion-user', 'Completion User', 'completion-user@example.test'),
         ('completion-author', 'completion-author', 'Completion Author', 'completion-author@example.test')`
      );
      await fixture.pool.query(
        `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, marker_code, marker_image_url, author_id)
         VALUES ('completion-quest', 'Completion test', 'Test quest', 'eco', 'Test place', 16, 120, 'completion-marker', '', 'completion-author')`
      );
      await fixture.pool.query(
        `INSERT INTO quest_attempts (id, quest_id, user_id, status) VALUES ('completion-attempt-1', 'completion-quest', 'completion-user', 'completed')`
      );
      await expect(fixture.pool.query(
        `INSERT INTO quest_attempts (id, quest_id, user_id, status) VALUES ('completion-attempt-2', 'completion-quest', 'completion-user', 'completed')`
      )).rejects.toThrow();
      const migration = await fixture.pool.query(
        "SELECT 1 FROM schema_migrations WHERE filename = '048_quest_attempts_single_completion.sql'"
      );
      expect(migration.rowCount).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
