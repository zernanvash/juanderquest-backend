import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { validateAsset } from '../src/shop/cosmetics.js';

describe('Shop v1 cosmetics', () => {
  let fixture: TestDbInstance;
  beforeAll(async () => { fixture = await createTestDb(); });
  afterAll(async () => { await fixture?.close(); });

  it('validates the self-describing asset shapes for each slot', () => {
    expect(validateAsset('banner', { style: 'gradient', colors: ['#f4a261', '#e76f51'], angle: 135, pattern: 'sun' })).toBe(true);
    expect(validateAsset('banner', { style: 'gradient', colors: ['#fff'], angle: 135, pattern: 'sun' })).toBe(false);
    expect(validateAsset('frame', { style: 'ring', colors: ['#95d5b2'], width: 3, animated: false })).toBe(true);
    expect(validateAsset('frame', { style: 'ring', colors: ['#95d5b2'], width: 1, animated: false })).toBe(false);
    expect(validateAsset('title', { text: 'Island Hopper' })).toBe(true);
    expect(validateAsset('title', { text: 'x'.repeat(25) })).toBe(false);
    expect(validateAsset('name_color', { color: '#2d6a4f' })).toBe(true);
    expect(validateAsset('name_color', { color: '#ffffff' })).toBe(false);
  });

  it('migrates and seeds the catalog, preview offers and teaser cards', async () => {
    const [items, previews, teasers] = await Promise.all([
      fixture.pool.query('SELECT count(*)::int AS count FROM cosmetic_items'),
      fixture.pool.query("SELECT count(*)::int AS count FROM vouchers WHERE availability='preview'"),
      fixture.pool.query('SELECT count(*)::int AS count FROM shop_teasers'),
    ]);
    expect(items.rows[0].count).toBe(20);
    expect(previews.rows[0].count).toBe(8);
    expect(teasers.rows[0].count).toBe(4);
  });
});
