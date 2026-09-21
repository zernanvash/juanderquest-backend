import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import { JuanChoiceError } from './service.js';

function pool() {
  const value = getPool();
  if (!value) throw new JuanChoiceError('DATABASE_OUTAGE', 503);
  return value;
}

export async function listActiveMerchantOffers(campaignId: string, allowTest = false) {
  return (await pool().query(
    `SELECT o.id,o.campaign_id,o.merchant_id,m.name AS merchant_name,o.voucher_id,v.title AS voucher_title,
            o.terms_snapshot,o.starts_at,o.ends_at
     FROM juanchoice_merchant_offers o JOIN merchants m ON m.id=o.merchant_id
     JOIN vouchers v ON v.id=o.voucher_id AND v.merchant_id=o.merchant_id
     JOIN juanchoice_campaigns c ON c.id=o.campaign_id AND c.is_test=o.is_test
     WHERE o.campaign_id=$1 AND c.status IN ('scheduled','voting','finalized','archived')
       AND o.status='approved' AND o.starts_at<=NOW() AND o.ends_at>NOW()
       AND ($2::boolean OR o.is_test=FALSE) ORDER BY o.ends_at,o.id`, [campaignId, allowTest])).rows;
}

export async function createMerchantOffer(input: { campaignId: string; merchantId: string; voucherId: string;
  termsSnapshot: Record<string, unknown>; startsAt: string; endsAt: string; isTest: boolean; }) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const campaign = (await client.query('SELECT is_test,status FROM juanchoice_campaigns WHERE id=$1 FOR UPDATE', [input.campaignId])).rows[0];
    if (!campaign || campaign.is_test !== input.isTest || !['scheduled', 'voting', 'finalized', 'archived'].includes(campaign.status)) {
      throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
    }
    const voucher = (await client.query('SELECT id,merchant_id,is_active FROM vouchers WHERE id=$1', [input.voucherId])).rows[0];
    if (!voucher || voucher.merchant_id !== input.merchantId || !voucher.is_active) throw new JuanChoiceError('INVALID_VOUCHER', 422);
    if (new Date(input.endsAt) <= new Date(input.startsAt)) throw new JuanChoiceError('INVALID_WINDOW', 400);
    const row = (await client.query(
      `INSERT INTO juanchoice_merchant_offers(id,campaign_id,merchant_id,voucher_id,terms_snapshot,status,partner_consent_at,starts_at,ends_at,is_test)
       VALUES($1,$2,$3,$4,$5::jsonb,'approved',NOW(),$6,$7,$8) RETURNING *`,
      [randomUUID(), input.campaignId, input.merchantId, input.voucherId, JSON.stringify(input.termsSnapshot), input.startsAt, input.endsAt, input.isTest])).rows[0];
    await client.query('COMMIT');
    return row;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function createPromotionBudget(input: { campaignId: string; budgetMjdq: number; approvalReference: string; isTest: boolean; }) {
  const campaign = (await pool().query('SELECT is_test,status FROM juanchoice_campaigns WHERE id=$1', [input.campaignId])).rows[0];
  if (!campaign || campaign.is_test !== input.isTest || campaign.status === 'cancelled') {
    throw new JuanChoiceError('CAMPAIGN_NOT_FOUND', 404);
  }
  return (await pool().query(
    `INSERT INTO juanchoice_promotion_budgets(id,campaign_id,authorized_budget_mjdq,status,approval_reference,is_test)
     VALUES($1,$2,$3,'approved',$4,$5) RETURNING *`,
    [randomUUID(), input.campaignId, input.budgetMjdq, input.approvalReference, input.isTest])).rows[0];
}
