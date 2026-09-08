// Explicit, additive fixture runner. No startup seeding and no balances or real votes.
require('dotenv').config();
const { Pool } = require('pg');
const apply = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured explicitly');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const towns = [
  ['Dagupan City',16.0431,120.3333], ['Lingayen',16.0218,120.2319],
  ['Bolinao',16.3377,119.8807], ['Alaminos City',16.1561,119.9811],
  ['Dasol',15.9896,119.8828], ['Manaoag',16.0436,120.4854],
  ['Bani',16.185,119.861], ['San Fabian',16.121,120.402],
];
const categories = [
  ['nature_outdoors','beach','Coastal picnic'], ['eat_drink','cafe','Local food stop'],
  ['culture_heritage','museum','Heritage walk'], ['activities_wellness','recreation','Community recreation'],
  ['shopping_local','market','Artisan market'], ['stay','homestay','Weekend homestay'],
];
async function run() {
  const client = await pool.connect();
  try {
    const info = await client.query('SELECT current_database() AS database, (SELECT count(*) FROM spots) AS spots');
    console.log({ ...info.rows[0], mode: apply ? 'apply' : 'dry-run', fixtureCount: 48 });
    if (!apply) return;
    await client.query('BEGIN');
    let inserted = 0;
    for (let i = 0; i < 48; i++) {
      const [town, lat, lng] = towns[i % towns.length];
      const [category, subcategory, title] = categories[i % categories.length];
      const id = `qa-ui-20260909-${String(i + 1).padStart(3, '0')}`;
      const result = await client.query(`INSERT INTO spots
        (id,slug,name,description,category,subcategory,tags,municipality,address,gps_lat,gps_lng,
         price_level,hours,amenities,image_url,source_type,source_name,trust_level,status,created_at)
        VALUES ($1::text,$1::text,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'editorial','QA Test Fixtures','community',$15,NOW()-($16::double precision * INTERVAL '1 hour'))
        ON CONFLICT DO NOTHING`, [id, `[TEST] ${title} ${i + 1} — ${town}`,
        `Synthetic testing post, not a real venue or verified travel recommendation. Approximate test pin only. ${i % 3 === 0 ? 'Long caption scenario: explore the card layout with accessibility information, a family itinerary, local crafts, and community activities. '.repeat(4) : 'Use this post to test bookmarks, map pins, discovery filters, and independent scrolling.'}`,
        category, subcategory, JSON.stringify(['qa_test','family', i % 2 ? 'budget' : 'scenic']), town,
        'TEST LOCATION — do not use for travel', lat + (i % 6) * .001, lng + (i % 4) * .001,
        i % 5, JSON.stringify({ daily: 'Test hours: 08:00–17:00' }), JSON.stringify(i % 2 ? ['parking'] : ['restroom','wheelchair_accessible']),
        i % 6 === 0 ? '' : `https://images.unsplash.com/photo-${i % 2 ? '1507525428034-b723cf961d3e' : '1441974231531-c6227db76b6e'}?auto=format&fit=crop&w=960&q=75`,
        i >= 44 ? 'needs_review' : 'published', i]);
      inserted += result.rowCount;
    }
    await client.query('COMMIT');
    console.log({ inserted, existingPreserved: true, batch: 'qa-ui-20260909', publicFixtures: 44, reviewFixtures: 4 });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
