import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { getActiveJuanChoicePerks, perkBonus, buildManifesto } from '../src/juanchoice/perks.js';
import { invalidatePerkControls } from '../src/juanchoice/perk-controls.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

// JuanChoice perk controls: JuanderQuest platform staff only, every change audited, effective at once.
realPg('JuanChoice perk controls (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const staff = `perk-staff-${randomUUID()}`;
  const areaAdmin = `perk-area-${randomUUID()}`;
  const traveler = `perk-traveler-${randomUUID()}`;
  const campaignId = randomUUID();
  const championId = randomUUID();
  const upcomingId = randomUUID();
  const upcomingCandidate = randomUUID();
  const token = (id: string, role: string) => jwt.sign({ id, seed_id: id, role }, env.JWT_SECRET, { expiresIn: '1h' });
  const asStaff = (req: request.Test) => req.set('Authorization', `Bearer ${token(staff, 'admin')}`);
  const perk = (key: string, value: number) => ({
    key, value, label: key, description: key, domain: 'quests', is_anchor: false, is_mystery: false, revealed: true,
    role: 'champion', campaign_id: campaignId, candidate_id: championId, spot_id: 'ctl-spot', municipality: 'Bolinao',
    category: 'nature_outdoors', reign_starts_at: new Date().toISOString(), reign_ends_at: new Date().toISOString() });
  const reason = 'Incident review: adjusting perks for this week.';

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    // Writes stay OFF: perk controls must still work during a write pause; the manifesto test turns writes on.
    Object.assign(env, { JUANCHOICE_ENABLED: true, JUANCHOICE_WRITES_ENABLED: false });
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,admin_scope,is_test) VALUES
      ($1::text,$1::text,'JDQ staff',$1::text||'@example.test','admin','platform',FALSE),
      ($2::text,$2::text,'Area admin',$2::text||'@example.test','admin','area',FALSE),
      ($3::text,$3::text,'Traveler',$3::text||'@example.test','user',NULL,FALSE)`, [staff, areaAdmin, traveler]);
    await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,
      source_type,source_name,status,is_test) VALUES('ctl-spot','ctl-spot','Control Beach','A perk control spot.','nature_outdoors','beach',
      'Bolinao','Bolinao, Pangasinan',16,120,'lgu','Fixture','published',FALSE)`);
    const closed = new Date(Date.now() - 3_600_000);
    await fixture.pool.query(`INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version)
      VALUES($1,$2,'Pangasinan','Control round','finalized',$3,$4,FALSE,'juanchoice-weekly-v1')`,
      [campaignId, `ctl-${campaignId}`, new Date(closed.getTime() - 7 * 86_400_000), closed]);
    await fixture.pool.query(`INSERT INTO juanchoice_results(campaign_id,standings,co_winner_ids,valid_ballots,policy_version,active_perks)
      VALUES($1,'[]'::jsonb,$2::jsonb,1,'juanchoice-weekly-v1',$3::jsonb)`,
      [campaignId, JSON.stringify([championId]), JSON.stringify([perk('spot_xp_boost', 0.5), perk('daily_stamp_bonus', 5), perk('shop_cosmetic_discount', 0.15)])]);
    // An upcoming round (opens tomorrow) with one contender.
    const opens = new Date(Date.now() + 86_400_000);
    await fixture.pool.query(`INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version)
      VALUES($1,$2,'Pangasinan','Upcoming','scheduled',$3,$4,FALSE,'juanchoice-weekly-v1')`,
      [upcomingId, `ctl-up-${upcomingId}`, opens, new Date(opens.getTime() + 7 * 86_400_000)]);
    await fixture.pool.query(`INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,is_test,manifesto_perks) VALUES($1,$2,'ctl-spot',FALSE,'[]'::jsonb)`,
      [upcomingCandidate, upcomingId]);
    invalidatePerkControls();
  });

  afterAll(async () => {
    invalidatePerkControls();
    setPool(null);
    db.attachDurabilityPool(null);
    db.usersRepo.setPool(null);
    await fixture?.close();
  });

  it('lets only JuanderQuest platform staff in (area admins and travelers are refused)', async () => {
    expect((await asStaff(request(app).get('/api/v1/juanchoice/admin/perk-controls/access'))).body.data).toEqual({ platform: true });
    const area = await request(app).get('/api/v1/juanchoice/admin/perk-controls/access').set('Authorization', `Bearer ${token(areaAdmin, 'admin')}`);
    expect(area.body.data).toEqual({ platform: false });
    for (const [id, role, status] of [[areaAdmin, 'admin', 403], [traveler, 'user', 403]] as const) {
      const res = await request(app).put('/api/v1/juanchoice/admin/perk-controls/settings/daily_stamp_bonus')
        .set('Authorization', `Bearer ${token(id, role)}`).send({ enabled: false, reason });
      expect(res.status).toBe(status);
    }
    const state = await asStaff(request(app).get('/api/v1/juanchoice/admin/perk-controls'));
    expect(state.status).toBe(200);
    expect(state.body.data.catalog).toHaveLength(8);
    expect(state.body.data.live.map((p: { key: string }) => p.key)).toEqual(['spot_xp_boost', 'daily_stamp_bonus', 'shop_cosmetic_discount']);
  });

  it('switches a perk type off everywhere at once, and back on', async () => {
    const off = await asStaff(request(app).put('/api/v1/juanchoice/admin/perk-controls/settings/daily_stamp_bonus')).send({ enabled: false, reason });
    expect(off.status).toBe(200);
    expect((await getActiveJuanChoicePerks(fixture.pool)).map(p => p.key)).not.toContain('daily_stamp_bonus');
    expect((await perkBonus(fixture.pool, false, p => p.key === 'daily_stamp_bonus')).value).toBe(0);
    const manifesto = buildManifesto({ seed: 's', spotId: 'x', spotName: 'X', municipality: 'Bolinao', category: 'nature_outdoors', count: 4, festival: false,
      controls: { enabled: key => key !== 'daily_stamp_bonus', value: () => 0.3 } });
    expect(manifesto.map(p => p.key)).not.toContain('daily_stamp_bonus');
    await asStaff(request(app).put('/api/v1/juanchoice/admin/perk-controls/settings/daily_stamp_bonus')).send({ enabled: true, reason });
    expect((await getActiveJuanChoicePerks(fixture.pool)).map(p => p.key)).toContain('daily_stamp_bonus');
  });

  it('changes a live perk value within safe limits and relabels it', async () => {
    const tooHigh = await asStaff(request(app).put('/api/v1/juanchoice/admin/perk-controls/settings/spot_xp_boost')).send({ standard_value: 3, reason });
    expect(tooHigh.status).toBe(422);
    expect(tooHigh.body.error.code).toBe('VALUE_OUT_OF_RANGE');
    const lowered = await asStaff(request(app).put('/api/v1/juanchoice/admin/perk-controls/settings/spot_xp_boost')).send({ standard_value: 0.2, reason });
    expect(lowered.status).toBe(200);
    const live = (await getActiveJuanChoicePerks(fixture.pool)).find(p => p.key === 'spot_xp_boost');
    expect(live).toMatchObject({ value: 0.2, label: '+20% quest XP here' });
    expect((await perkBonus(fixture.pool, false, p => p.key === 'spot_xp_boost')).value).toBe(0.2);
    // Back to the catalog default.
    await asStaff(request(app).put('/api/v1/juanchoice/admin/perk-controls/settings/spot_xp_boost')).send({ standard_value: null, reason });
    expect((await getActiveJuanChoicePerks(fixture.pool)).find(p => p.key === 'spot_xp_boost')?.value).toBe(0.5);
  });

  it('pauses one live perk of one winner and restores it', async () => {
    const suspended = await asStaff(request(app).post('/api/v1/juanchoice/admin/perk-controls/suspensions'))
      .send({ campaign_id: campaignId, candidate_id: championId, perk_key: 'shop_cosmetic_discount', reason });
    expect(suspended.status).toBe(201);
    expect((await getActiveJuanChoicePerks(fixture.pool)).map(p => p.key)).toEqual(['spot_xp_boost', 'daily_stamp_bonus']);
    const twice = await asStaff(request(app).post('/api/v1/juanchoice/admin/perk-controls/suspensions'))
      .send({ campaign_id: campaignId, candidate_id: championId, perk_key: 'shop_cosmetic_discount', reason });
    expect(twice.status).toBe(409);
    const notLive = await asStaff(request(app).post('/api/v1/juanchoice/admin/perk-controls/suspensions'))
      .send({ campaign_id: campaignId, candidate_id: championId, perk_key: 'quiz_arcade_xp_boost', reason });
    expect(notLive.status).toBe(404);
    const state = (await asStaff(request(app).get('/api/v1/juanchoice/admin/perk-controls'))).body.data;
    expect(state.live.find((p: { key: string }) => p.key === 'shop_cosmetic_discount').suspension_id).toBe(suspended.body.data.id);
    const lifted = await asStaff(request(app).post(`/api/v1/juanchoice/admin/perk-controls/suspensions/${suspended.body.data.id}/lift`)).send({ reason });
    expect(lifted.status).toBe(200);
    expect((await getActiveJuanChoicePerks(fixture.pool)).map(p => p.key)).toContain('shop_cosmetic_discount');
  });

  it('edits an upcoming contender\'s perks before voting opens, never after', async () => {
    const edited = await asStaff(request(app).put(`/api/v1/juanchoice/admin/campaigns/${upcomingId}/candidates/${upcomingCandidate}/manifesto`))
      .send({ perk_keys: ['spot_xp_boost', 'quiz_arcade_xp_boost'], mystery_key: 'quiz_arcade_xp_boost', reason });
    expect(edited.status).toBe(200);
    const stored = (await fixture.pool.query('SELECT manifesto_perks FROM juanchoice_candidates WHERE id=$1', [upcomingCandidate])).rows[0].manifesto_perks;
    expect(stored.map((p: { key: string }) => p.key)).toEqual(['spot_xp_boost', 'quiz_arcade_xp_boost']);
    expect(stored[0]).toMatchObject({ is_anchor: true, label: '+50% quest XP here' });
    expect(stored[1]).toMatchObject({ is_mystery: true, revealed: false });
    const closed = await asStaff(request(app).put(`/api/v1/juanchoice/admin/campaigns/${campaignId}/candidates/${championId}/manifesto`))
      .send({ perk_keys: ['spot_xp_boost'], reason });
    expect(closed.status).toBe(404); // the finalized round's winner is not an editable contender row
    const bad = await asStaff(request(app).put(`/api/v1/juanchoice/admin/campaigns/${upcomingId}/candidates/${upcomingCandidate}/manifesto`))
      .send({ perk_keys: ['free_money'], reason });
    expect(bad.status).toBe(422);
  });

  it('requires a reason and audits every change with its actor', async () => {
    const noReason = await asStaff(request(app).put('/api/v1/juanchoice/admin/perk-controls/settings/daily_stamp_bonus')).send({ enabled: false, reason: 'short' });
    expect(noReason.status).toBe(400);
    const rows = (await fixture.pool.query('SELECT action,actor_id,reason FROM juanchoice_perk_control_audit ORDER BY created_at')).rows;
    expect(rows.map(row => row.action)).toEqual([
      'perk_setting.update', 'perk_setting.update', 'perk_setting.update', 'perk_setting.update',
      'live_perk.suspend', 'live_perk.restore', 'manifesto.edit',
    ]);
    expect(rows.every(row => row.actor_id === staff && row.reason === reason)).toBe(true);
  });
});
