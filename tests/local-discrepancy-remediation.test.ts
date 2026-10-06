import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/db/index';
import type { Pool } from 'pg';

describe('local-only discrepancy guardrails', () => {
  it('disables legacy event mutations without issuing rewards or reservations', async () => {
    const login = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'user-1' });
    expect(login.status).toBe(200);
    const beforeReservations = db.campaign_reservations.length;
    const beforePoints = db.findUserById(login.body.data.user.id)?.demo_points;
    const response = await request(app)
      .post('/api/v1/campaigns/any-campaign/claim')
      .set('Authorization', `Bearer ${login.body.data.token}`)
      .send({});
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('FEATURE_UNDER_DEVELOPMENT');
    expect(db.campaign_reservations).toHaveLength(beforeReservations);
    expect(db.findUserById(login.body.data.user.id)?.demo_points).toBe(beforePoints);
  });

  it('does not let a stale legacy mjdq_balance override the spendable points balance', async () => {
    const login = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'user-1' });
    expect(login.status).toBe(200);
    const user = db.findUserById(login.body.data.user.id)!;
    const previousPoints = user.demo_points;
    const previousLegacyBalance = user.mjdq_balance;
    try {
      user.demo_points = 20;
      user.mjdq_balance = 100000;
      const response = await request(app)
        .get('/api/v1/wallet')
        .set('Authorization', `Bearer ${login.body.data.token}`);
      expect(response.status).toBe(200);
      expect(response.body.data.demo_points).toBe(20);
      expect(response.body.data.balance_mjdq).toBe(20000);
    } finally {
      user.demo_points = previousPoints;
      user.mjdq_balance = previousLegacyBalance;
    }
  });

  it('reads persisted points and a fractional mJDQ remainder from one SQL snapshot', async () => {
    const login = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'user-1' });
    expect(login.status).toBe(200);
    const userId = login.body.data.user.id as string;
    const previousPool = db.usersRepo.getPool();
    const query = jest.fn().mockResolvedValue({ rows: [{
      demo_points: 20,
      scout_reputation: 42,
      data: { balances: { [userId]: 20550 } },
    }] });
    db.usersRepo.setPool({ query } as unknown as Pool);
    try {
      const response = await request(app)
        .get('/api/v1/wallet')
        .set('Authorization', `Bearer ${login.body.data.token}`);
      expect(response.status).toBe(200);
      expect(response.body.data.balance_mjdq).toBe(20550);
      expect(response.body.data.demo_points).toBe(20);
      expect(response.body.data.scout_reputation).toBe(42);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      db.usersRepo.setPool(previousPool);
    }
  });
});
