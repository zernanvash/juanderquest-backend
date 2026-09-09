// Explicit synthetic QA batch. No real accounts, money, votes, or startup seeding.
require('dotenv').config();
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const batch = 'qa-social-20260909';
const apply = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const people = ['Juan Coastal', 'Maya Heritage', 'Pao Food Scout', 'Private Scout'];
const towns = [['Bolinao', 16.3377, 119.8807], ['Lingayen', 16.0218, 120.2319], ['Dagupan City', 16.0431, 120.3333]];
async function run() {
  const client = await pool.connect();
  try {
    console.log({ batch, mode: apply ? 'apply' : 'dry-run', users: 4, spots: 24, quests: 3, submissions: 9, follows: 5, preferences: 3, interactions: 6 });
    if (!apply) return;
    await client.query('BEGIN');
    // Serialize repeat invocations and refuse to silently reuse foreign IDs.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [batch]);
    for (let i = 0; i < people.length; i++) {
      const id = `${batch}-user-${i}`;
      const existing = await client.query('SELECT email FROM users WHERE id=$1', [id]);
      if (existing.rowCount && existing.rows[0].email !== `${id}@example.invalid`) throw new Error('Fixture identity collision');
      await client.query(`INSERT INTO users (id,seed_id,display_name,email,avatar_url,role,demo_points,is_public,handle,bio,status_text)
        VALUES ($1,$2,$3,$4,'','user',0,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [id, `qa-disabled-${randomUUID()}`, `[TEST] ${people[i]}`, `${id}@example.invalid`, i < 3,
        ['qa_juan_coastal','qa_maya_heritage','qa_pao_food','qa_private_scout'][i],
        'Synthetic QA traveler. Activity is test data, not evidence of real visits.',
        i === 3 ? 'Private-profile test case' : 'Testing Pangasinan discovery and community posts']);
    }
    for (let i = 0; i < 3; i++) {
      const [town, lat, lng] = towns[i];
      const quest = `${batch}-quest-${i}`;
      await client.query(`INSERT INTO quests (id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,marker_code,marker_image_url,is_active)
        VALUES ($1::text,$2,$3,$4,$5,$6,$7,100,0,$1::text,'',false) ON CONFLICT (id) DO NOTHING`,
      [quest, `[TEST] ${town} practice activity`, 'Synthetic inactive quest for history and moderation QA. Not a real visit or payable reward.', ['eco','cultural','food_trade'][i], `[TEST] ${town}`, lat, lng]);
      for (let j = 0; j < 3; j++) {
        const status = ['approved','pending','rejected'][j];
        const id = `${batch}-submission-${i}-${j}`;
        await client.query(`INSERT INTO submissions (id,idempotency_key,user_id,quest_id,scanned_marker_code,captured_lat,captured_lng,captured_accuracy,status,rejection_reason)
          VALUES ($1::text,$1::text,$2,$3::text,$3::text,$4,$5,10,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [id, `${batch}-user-${(i+j)%3}`, quest, lat, lng, status, status === 'rejected' ? '[TEST] Synthetic rejection to exercise feedback UI.' : null]);
      }
      await client.query(`INSERT INTO discovery_preferences (user_id,categories,tags,onboarding_state)
        VALUES ($1,$2,$3,'completed') ON CONFLICT (user_id) DO NOTHING`,
      [`${batch}-user-${i}`, JSON.stringify([['nature_outdoors','culture_heritage','eat_drink'][i]]), JSON.stringify(['qa_test','family'])]);
    }
    for (let i = 0; i < 24; i++) {
      const [town, lat, lng] = towns[i%3];
      const id = `${batch}-spot-${String(i).padStart(2,'0')}`;
      const activity = ['Coastal itinerary notes','Heritage walking stop','Local food discovery'][i%3];
      await client.query(`INSERT INTO spots (id,slug,name,description,category,subcategory,tags,municipality,address,gps_lat,gps_lng,source_type,source_name,trust_level,status,created_by,image_url)
        VALUES ($1::text,$1::text,$2,$3,$4,$5,$6,$7,'TEST PIN - not a travel recommendation',$8,$9,'community','QA Social Fixtures','community',$10,$11,'') ON CONFLICT (id) DO NOTHING`,
      [id, `[TEST] ${activity} ${i+1} - ${town}`,
        `Synthetic post by ${people[i%3]} for QA only. ${activity}: compare transport options, shade, accessibility and family rest stops before planning a trip. No venue facts or visit claims are verified. ${i%4 === 0 ? 'Long-caption layout case. '.repeat(25) : 'Text-only post to test media collapse, saving and sharing.'}`,
        ['nature_outdoors','culture_heritage','eat_drink'][i%3], ['beach','museum','cafe'][i%3], JSON.stringify(['qa_test',batch]), town,lat,lng,
        i >= 21 ? 'needs_review' : 'published', `${batch}-user-${i%3}`]);
    }
    for (const [a,b] of [[0,1],[1,0],[2,0],[0,2],[3,0]]) {
      await client.query('INSERT INTO user_follows (follower_id,following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [`${batch}-user-${a}`,`${batch}-user-${b}`]);
    }
    for (let i=0;i<3;i++) for (const kind of ['like','save']) {
      await client.query('INSERT INTO spot_interactions (user_id,spot_id,interaction_type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [`${batch}-user-${i}`,`${batch}-spot-0${i}`,kind]);
    }
    await client.query('COMMIT');
    console.log({ batch, committed: true, realAccountsUnchanged: true, rewardsGranted: 0 });
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}
run().catch(err => { console.error(err.message); process.exitCode=1; }).finally(() => pool.end());
