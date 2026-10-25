import { createTestDb } from '../src/db/testHarness.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { randomUUID } from 'crypto';

describe('Migration 060 (WP2) — Polygon Amoy Chain Registry', () => {
  it('lists 060_polygon_amoy_chain_registry.sql in MIGRATIONS in sequential order', () => {
    const idx059 = MIGRATIONS.indexOf('059_push_account_category.sql');
    const idx060 = MIGRATIONS.indexOf('060_polygon_amoy_chain_registry.sql');
    expect(idx059).toBeGreaterThan(-1);
    expect(idx060).toBe(idx059 + 1);
  });

  it('migrates cleanly on real PostgreSQL and verifies widened constraints + seed data', async () => {
    const fixture = await createTestDb();
    const pool = fixture.pool;

    try {
      // 1. Verify widened chain_id constraints (both 84532 and 80002 insert, while 1 or 137 reject)
      // Test chain_commands
      const dummyUserId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, role) VALUES ($1, $2, 'Admin User', $3, 'admin')`,
        [dummyUserId, `seed-${dummyUserId.substring(0, 8)}`, `admin-${dummyUserId}@test.local`]
      );

      const makeEntitlement = (hexDigit: string) => '0x' + hexDigit.repeat(64);

      // Insert command for Base Sepolia (84532)
      await pool.query(`
        INSERT INTO chain_commands (id, chain_id, entitlement_id, operation, recipient_address, status, expected_amount_wei)
        VALUES ('cmd-base', 84532, $1, 'test_token_claim', '0x1111111111111111111111111111111111111111', 'queued', 1000)
      `, [makeEntitlement('1')]);

      // Insert command for Polygon Amoy (80002)
      await pool.query(`
        INSERT INTO chain_commands (id, chain_id, entitlement_id, operation, recipient_address, status, expected_amount_wei)
        VALUES ('cmd-amoy', 80002, $1, 'test_token_claim', '0x2222222222222222222222222222222222222222', 'queued', 1000)
      `, [makeEntitlement('2')]);

      // Reject non-whitelisted chain IDs (e.g. 1 or 137)
      await expect(pool.query(`
        INSERT INTO chain_commands (id, chain_id, entitlement_id, operation, recipient_address, status, expected_amount_wei)
        VALUES ('cmd-eth', 1, $1, 'test_token_claim', '0x3333333333333333333333333333333333333333', 'queued', 1000)
      `, [makeEntitlement('3')])).rejects.toThrow();

      await expect(pool.query(`
        INSERT INTO chain_commands (id, chain_id, entitlement_id, operation, recipient_address, status, expected_amount_wei)
        VALUES ('cmd-polygon', 137, $1, 'test_token_claim', '0x4444444444444444444444444444444444444444', 'queued', 1000)
      `, [makeEntitlement('4')])).rejects.toThrow();

      // 2. Verify chain_alert notification kind is accepted
      await pool.query(`
        INSERT INTO user_notifications (id, user_id, kind, title, message, event_key, href)
        VALUES ('notif-1', $1, 'chain_alert', 'Low POL', 'Alert message', 'chain-low:test:2026-10-22', '/admin')
      `, [dummyUserId]);

      // 3. Verify seeded contracts
      const contracts = await pool.query('SELECT name, address, chain_id, active FROM chain_contracts WHERE chain_id = 80002');
      expect(contracts.rows.length).toBe(3);
      const names = contracts.rows.map(r => r.name).sort();
      expect(names).toEqual(['badge', 'distributor', 'token']);

      // 4. Verify seeded wallets
      const wallets = await pool.query('SELECT role, address, label, needs_gas FROM chain_wallets WHERE chain_id = 80002');
      expect(wallets.rows.length).toBe(7);
      const adminWallet = wallets.rows.find(r => r.role === 'admin');
      expect(adminWallet?.needs_gas).toBe(true);
      const signerWallet = wallets.rows.find(r => r.role === 'signer');
      expect(signerWallet?.needs_gas).toBe(false);

      // 5. Hard rule check: information_schema columns for chain registry tables have NO key/secret columns
      const cols = await pool.query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('chain_wallets', 'chain_contracts', 'chain_wallet_audit')
      `);
      for (const row of cols.rows) {
        expect(row.column_name).not.toMatch(/key|secret|mnemonic|seed_phrase|private/i);
      }
    } finally {
      await fixture.close();
    }
  }, 90000);
});
