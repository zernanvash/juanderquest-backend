import { db, RedemptionRow } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { governanceStore } from '../routes/proposals.js';
import { randomBytes, randomUUID } from 'crypto';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { canonicalSettings } from '../settings/schema.js';
import { env } from '../config/env.js';
import { movePoints } from '../funding/ledger.js';
import { publishFunding } from '../funding/transaction.js';

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  statusCode?: number;
  error?: {
    code: string;
    message: string;
  };
}

export class VouchersService {
  async redeemVoucher(
    voucherId: string,
    userId: string,
    idempotencyKey: string
  ): Promise<ServiceResult<{ redemption: RedemptionRow; replayed: boolean }>> {
    const pool = getPool();

    if (pool) {
      const client = await pool.connect();
      try {
        // 1. Transaction BEGIN
        await client.query('BEGIN');
        const accounting = await lockGovernanceSnapshot(client);
        if (accounting.controls?.pause_all_financial || accounting.controls?.pause_vouchers) {
          throw new Error('FINANCIAL_ACTIVITY_PAUSED');
        }

        // 2. Lock user account & verify point balance FIRST (serializes all redemptions for this user)
        const { rows: userRows } = await client.query(
          'SELECT demo_points,is_test FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        if (!userRows.length) {
          await client.query('ROLLBACK');
          return {
            success: false,
            statusCode: 404,
            error: { code: 'NOT_FOUND', message: 'User not found.' },
          };
        }
        const user = userRows[0];

        // 3. Idempotency check under the user lock
        const { rows: existingRows } = await client.query(
          'SELECT * FROM redemptions WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey]
        );
        if (existingRows.length > 0) {
          const existing = existingRows[0];
          await commitGovernanceTransaction(client);
          if (existing.voucher_id !== voucherId) {
            return {
              success: false,
              statusCode: 409,
              error: {
                code: 'IDEMPOTENCY_CONFLICT',
                message: 'This idempotency key was already used for a different voucher redemption.',
              },
            };
          }
          return {
            success: true,
            statusCode: 200,
            data: {
              redemption: this.mapRedemptionRow(existing),
              replayed: true,
            },
          };
        }

        // 4. One redemption per voucher per user rule under the user lock
        const { rows: userVoucherRows } = await client.query(
          'SELECT 1 FROM redemptions WHERE user_id = $1 AND voucher_id = $2 LIMIT 1',
          [userId, voucherId]
        );
        if (userVoucherRows.length > 0) {
          await client.query('ROLLBACK');
          return {
            success: false,
            statusCode: 409,
            error: { code: 'ALREADY_REDEEMED', message: 'You have already redeemed this voucher.' },
          };
        }

        // 5. Voucher existence check
        const { rows: voucherRows } = await client.query(
          `SELECT v.*,m.id AS owner_merchant_id,m.is_test AS merchant_is_test FROM vouchers v
            JOIN merchants m ON m.id=v.merchant_id WHERE v.id = $1 AND v.is_active = TRUE`,
          [voucherId]
        );
        if (!voucherRows.length) {
          await client.query('ROLLBACK');
          return {
            success: false,
            statusCode: 404,
            error: { code: 'NOT_FOUND', message: 'Voucher not found or inactive.' },
          };
        }
        const voucher = voucherRows[0];

        if (voucher.availability === 'preview') {
          await client.query('ROLLBACK');
          return { success:false,statusCode:409,error:{code:'NOT_REDEEMABLE',message:'This partner offer is coming soon.'} };
        }

        if (user.demo_points < voucher.cost_points) {
          await client.query('ROLLBACK');
          return {
            success: false,
            statusCode: 409,
            error: { code: 'INSUFFICIENT_POINTS', message: 'You do not have enough demo points for this voucher.' },
          };
        }

        // 6. Cryptographically strong unique code generation and insertion
        const code = `JDQ-${randomBytes(3).toString('hex').toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
        const redemptionId = `rdm_${Date.now()}_${randomUUID().slice(0, 6)}`;

        let createdRows: any[];
        try {
          const insertResult = await client.query(
            `INSERT INTO redemptions (id, voucher_id, user_id, code, cost_points, idempotency_key, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             RETURNING *`,
            [redemptionId, voucherId, userId, code, voucher.cost_points, idempotencyKey]
          );
          createdRows = insertResult.rows;
        } catch (insertErr: any) {
          if (insertErr.code === '23505') {
            // First roll back the aborted transaction so connection/pool is clean
            await client.query('ROLLBACK');

            // ROLLBACK restored this connection to an idle state. Reuse it:
            // acquiring another pool connection here can deadlock a saturated pool.
            const { rows: recheckIdemp } = await client.query(
              'SELECT * FROM redemptions WHERE user_id = $1 AND idempotency_key = $2',
              [userId, idempotencyKey]
            );
            if (recheckIdemp.length > 0) {
              if (recheckIdemp[0].voucher_id !== voucherId) {
                return { success: false, statusCode: 409, error: {
                  code: 'IDEMPOTENCY_CONFLICT',
                  message: 'This idempotency key was already used for a different voucher redemption.',
                } };
              }
              return {
                success: true,
                statusCode: 200,
                data: {
                  redemption: this.mapRedemptionRow(recheckIdemp[0]),
                  replayed: true,
                },
              };
            }

            const constraint = (insertErr.constraint || '').toLowerCase();
            if (constraint.includes('code')) {
              return {
                success: false,
                statusCode: 409,
                error: { code: 'CODE_COLLISION', message: 'Voucher barcode collision occurred. Please retry.' },
              };
            }

            // Duplicate user-voucher redemption
            return {
              success: false,
              statusCode: 409,
              error: { code: 'ALREADY_REDEEMED', message: 'You have already redeemed this voucher.' },
            };
          }
          await client.query('ROLLBACK');
          throw insertErr;
        }
        const redemption = this.mapRedemptionRow(createdRows[0]);

        // 7. Deduct traveler points and optionally route the matching amount to the merchant.
        const settings = await client.query('SELECT values FROM system_settings_document WHERE id=1');
        const voucherIncomeEnabled = env.QUEST_FUNDING_ENABLED && Boolean(canonicalSettings(settings.rows[0]?.values ?? {}).voucher_income_enabled);
        let newDemoPoints: number;
        let govResult: any = null;
        let fundingGroup: any;
        if (voucherIncomeEnabled) {
          if (Boolean(user.is_test) !== Boolean(voucher.merchant_is_test)) {
            await client.query('ROLLBACK');
            return { success:false,statusCode:409,error:{code:'SCOPE_MISMATCH',message:'Voucher and traveler environments do not match.'} };
          }
          await client.query(
            `INSERT INTO points_accounts(id,kind,merchant_id,is_test) VALUES($1,'merchant',$2,$3) ON CONFLICT(id) DO NOTHING`,
            [`merchant:${voucher.owner_merchant_id}`,voucher.owner_merchant_id,voucher.merchant_is_test]);
          const creditId=`mpc_${randomUUID()}`;
          await client.query(
            `INSERT INTO merchant_point_credits(id,merchant_id,source,points,reference,actor_id,idempotency_key,ledger_group_id)
             VALUES($1,$2,'voucher_income',$3,$4,$5,$6,$1)`,
            [creditId,voucher.owner_merchant_id,voucher.cost_points,`redemption:${redemption.id}`,userId,`voucher_income:${idempotencyKey}`]);
          fundingGroup=await movePoints(client,{from:{id:userId,userId,kind:'traveler'},to:{id:`merchant:${voucher.owner_merchant_id}`,kind:'merchant'},
            points:Number(voucher.cost_points),type:'merchant_points_voucher_income',referenceType:'voucher_redemption',referenceId:redemption.id,
            actorId:userId,idempotencyKey,metadata:{voucher_id:voucherId,merchant_id:voucher.owner_merchant_id}});
          await client.query('UPDATE merchant_point_credits SET ledger_group_id=$2 WHERE id=$1',[creditId,fundingGroup.entries[0].transaction_group_id]);
          newDemoPoints=fundingGroup.userBalanceUpdate?.demoPoints;
          if(newDemoPoints===undefined)throw new Error('VOUCHER_INCOME_BALANCE_UPDATE_MISSING');
        } else {
          const { rows: updateRows } = await client.query(
            'UPDATE users SET demo_points = demo_points - ($2)::int, updated_at = NOW() WHERE id = $1 AND demo_points >= ($2)::int RETURNING demo_points',
            [userId, voucher.cost_points]
          );
          if (!updateRows.length) {
            await client.query('ROLLBACK');
            return { success: false, statusCode: 409, error: { code: 'INSUFFICIENT_POINTS', message: 'You do not have enough demo points for this voucher.' } };
          }
          newDemoPoints = updateRows[0].demo_points;
          govResult = await governanceStore.consumePoints(userId, voucher.cost_points, voucherId, redemption.id, client);
        }

        // 9. COMMIT transaction
        try {
          await commitGovernanceTransaction(client);
        } catch (commitErr) {
          await client.query('ROLLBACK').catch(() => {});
          throw commitErr;
        }

        // 10. Authoritative post-commit synchronization:
        // Publish committed transaction-local entries and set in-memory demo_points.
        if(fundingGroup) publishFunding([fundingGroup]);
        if (govResult && govResult.entries) {
          governanceStore.publishCommittedTransaction({
            entries: govResult.entries,
            audit: [govResult.audit],
            userBalanceUpdate: { userId, demoPoints: newDemoPoints, balanceMjdq: govResult.balanceMjdq },
          });
        }
        const memUser = db.findUserById(userId);
        if (memUser) {
          memUser.demo_points = newDemoPoints;
        }
        db.redemptions.push(redemption);

        return {
          success: true,
          statusCode: 200,
          data: {
            redemption,
            replayed: false,
          },
        };
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // connection may already be rolled back
        }
        throw error;
      } finally {
        client.release();
      }
    }

    // In-memory fallback
    const replay = db.findRedemptionByIdempotency(idempotencyKey, userId);
    if (replay) {
      if (replay.voucher_id !== voucherId) {
        return {
          success: false,
          statusCode: 409,
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'This idempotency key was already used for a different voucher redemption.',
          },
        };
      }
      return { success: true, statusCode: 200, data: { redemption: replay, replayed: true } };
    }

    const result = db.redeemVoucher(voucherId, userId, idempotencyKey);
    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        return { success: false, statusCode: 404, error: { code: 'NOT_FOUND', message: 'Voucher not found.' } };
      }
      if (result.error === 'ALREADY_REDEEMED') {
        return { success: false, statusCode: 409, error: { code: 'ALREADY_REDEEMED', message: 'You have already redeemed this voucher.' } };
      }
      return { success: false, statusCode: 409, error: { code: 'INSUFFICIENT_POINTS', message: 'You do not have enough demo points for this voucher.' } };
    }

    governanceStore.consumePoints(result.redemption.user_id, result.redemption.cost_points, result.redemption.voucher_id, result.redemption.id);
    return {
      success: true,
      statusCode: 200,
      data: result,
    };
  }

  private mapRedemptionRow(row: any): RedemptionRow {
    return {
      id: row.id,
      voucher_id: row.voucher_id,
      user_id: row.user_id,
      code: row.code,
      cost_points: row.cost_points,
      idempotency_key: row.idempotency_key,
      created_at: new Date(row.created_at).toISOString(),
    };
  }
}

export const vouchersService = new VouchersService();
