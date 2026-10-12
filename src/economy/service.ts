import { createHash, randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';

export const SIM_ASSET = 'EXPLORER_COIN_SIM';
const ISSUANCE_ACCOUNT = 'sim:issuance';
const RETIRED_ACCOUNT = 'sim:retired';
const MAX_MINOR = 9_223_372_036_854_775_807n;

type Queryable = Pick<PoolClient, 'query'>;

export class EconomyError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface PilotPoolInput {
  id: string;
  questId: string;
  scopeKey: string;
  policyVersion: string;
  rewardMinor: bigint;
  allocationMinor: bigint;
  reservationSeconds: number;
  appealSeconds: number;
  adminId: string;
  scopeId?: string;
  policyId?: string;
}

export interface ReviewedPilotAuthorityInput {
  questId: string;
  scopeId: string;
  scopeKey: string;
  policyId: string;
  policyKey: string;
  policyVersion: number;
  proposedBy: string;
  reviewedBy: string;
  countryCode: string;
  regionName?: string;
  provinceName?: string;
  municipalityName?: string;
  destinationSpotId?: string;
  activityKind: 'visit' | 'photo' | 'qr' | 'ar' | 'multi_step';
  activityFingerprint: string;
  summary: string;
  rationale: string;
  rewardMinor: bigint;
  reservationSeconds: number;
  appealSeconds: number;
}

export interface RewardReservation {
  id: string;
  poolId: string;
  userId: string;
  scopeKey: string;
  amountMinor: string;
  expiresAt: string;
  status: string;
  attemptId?: string;
}

export interface EconomicReceipt {
  transactionId: string;
  amountMinor: string;
  asset: typeof SIM_ASSET;
  businessEvent: string;
}

export interface RewardAppealReceipt {
  id: string;
  reservationId: string;
  status: 'submitted' | 'approved' | 'rejected';
  requestedAt: string;
}

function asPositiveMinor(value: bigint): string {
  if (value <= 0n || value > MAX_MINOR) throw new EconomyError('INVALID_AMOUNT');
  return value.toString();
}

function dateString(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function pilotOnly(): void {
  if (process.env.NODE_ENV !== 'test' && process.env.JDQ_ENV !== 'dev') {
    throw new EconomyError('SIMULATION_PROFILE_REQUIRED');
  }
}

function usesDatabasePosting(): boolean {
  return process.env.NODE_ENV !== 'test' || Boolean(process.env.JDQ_REAL_PG_URL);
}

async function inTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new EconomyError('TRANSACTION_ABORTED');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function reservation(row: Record<string, unknown>): RewardReservation {
  return {
    id: String(row.id), poolId: String(row.pool_id), userId: String(row.user_id),
    scopeKey: String(row.scope_key), amountMinor: String(row.amount_minor),
    expiresAt: dateString(row.expires_at), status: String(row.status),
    attemptId: row.attempt_id ? String(row.attempt_id) : undefined,
  };
}

async function travelerAccount(client: Queryable, userId: string): Promise<string> {
  const id = `sim:traveler:${userId}`;
  await client.query(
    `INSERT INTO economic_accounts (id, asset_code, kind, user_id)
     VALUES ($1, $2, 'traveler', $3) ON CONFLICT (id) DO NOTHING`,
    [id, SIM_ASSET, userId]
  );
  const result = await client.query(
    // The security-definer posting function takes the account row lock. A
    // restricted caller needs SELECT here, not direct account UPDATE rights.
    'SELECT user_id FROM economic_accounts WHERE id = $1 AND asset_code = $2',
    [id, SIM_ASSET]
  );
  if (result.rows[0]?.user_id !== userId) throw new EconomyError('ACCOUNT_ID_CONFLICT');
  return id;
}

async function writeTransfer(
  client: Queryable,
  input: { event: string; operation: 'reward' | 'spend'; actorId: string; policyVersion: string;
    from: string; to: string; amount: bigint; subjectId: string; submissionId?: string;
    idempotencyKey?: string; requestHash?: string }
): Promise<EconomicReceipt> {
  const amount = asPositiveMinor(input.amount);
  const transactionId = randomUUID();
  // pg-mem cannot execute the security-definer function. All actual PostgreSQL
  // runtimes and real-PG tests use the restricted posting entry point.
  if (usesDatabasePosting()) {
    if (process.env.NODE_ENV !== 'test') {
      const privileges = await client.query(
        `SELECT
          has_table_privilege(current_user, 'economic_accounts', 'UPDATE') AS accounts_update,
          has_table_privilege(current_user, 'economic_transactions', 'INSERT') AS transactions_insert,
          has_table_privilege(current_user, 'economic_transfers', 'INSERT') AS transfers_insert`
      );
      const grants = privileges.rows[0];
      if (!grants || grants.accounts_update || grants.transactions_insert || grants.transfers_insert) {
        throw new EconomyError('RESTRICTED_ECONOMY_ROLE_REQUIRED');
      }
    }
    try {
      await client.query(
        `SELECT economic_post_transfer($1,$2,$3,$4,$5,$6,$7,($8)::bigint,$9,$10,$11,$12)`,
        [transactionId, input.event, input.operation, input.actorId,
          input.policyVersion, input.from, input.to, amount,
          input.subjectId, input.submissionId ?? null,
          input.idempotencyKey ?? null, input.requestHash ?? null]
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'INSUFFICIENT_COINS') {
        throw new EconomyError('INSUFFICIENT_COINS');
      }
      throw error;
    }
    return { transactionId, amountMinor: amount, asset: SIM_ASSET, businessEvent: input.event };
  }
  // Every posting takes its two account locks in the same order, including
  // future compensating transfers that reverse the direction of a reward.
  const locked = await client.query(
    `SELECT id FROM economic_accounts
     WHERE asset_code = $3 AND (id = $1 OR id = $2)
     ORDER BY id FOR UPDATE`,
    [input.from, input.to, SIM_ASSET]
  );
  if (locked.rowCount !== 2) throw new EconomyError('ACCOUNT_UNAVAILABLE');
  await client.query(
    `INSERT INTO economic_transactions (id, asset_code, business_event, operation, actor_id, policy_version)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transactionId, SIM_ASSET, input.event, input.operation, input.actorId, input.policyVersion]
  );
  const debit = await client.query(
    `UPDATE economic_accounts SET balance_minor = balance_minor - ($2)::bigint
     WHERE id = $1 AND asset_code = $3 AND (kind = 'issuance' OR balance_minor >= ($2)::bigint)
     RETURNING balance_minor`, [input.from, amount, SIM_ASSET]
  );
  if (!debit.rowCount) throw new EconomyError('INSUFFICIENT_COINS');
  const credit = await client.query(
    `UPDATE economic_accounts SET balance_minor = balance_minor + ($2)::bigint
     WHERE id = $1 AND asset_code = $3 AND balance_minor <= 9223372036854775807 - ($2)::bigint
     RETURNING balance_minor`, [input.to, amount, SIM_ASSET]
  );
  if (!credit.rowCount) throw new EconomyError('DESTINATION_ACCOUNT_UNAVAILABLE');
  await client.query(
    `INSERT INTO economic_transfers
     (transaction_id, sequence, asset_code, from_account_id, to_account_id, amount_minor)
     VALUES ($1, 1, $2, $3, $4, ($5)::bigint)`,
    [transactionId, SIM_ASSET, input.from, input.to, amount]
  );
  await client.query(
    `INSERT INTO economic_outbox (id, transaction_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), transactionId, input.operation, JSON.stringify({ business_event: input.event, asset: SIM_ASSET, amount_minor: amount })]
  );
  return { transactionId, amountMinor: amount, asset: SIM_ASSET, businessEvent: input.event };
}

export class EconomyService {
  constructor(private readonly pool: Pool) {}

  // Local pilot review command. The requester and reviewer are distinct durable
  // users; a quest author cannot approve their own canonical reward scope.
  async createReviewedPilotAuthority(input: ReviewedPilotAuthorityInput): Promise<void> {
    pilotOnly();
    if (!usesDatabasePosting()) throw new EconomyError('REAL_POSTGRES_REQUIRED');
    const reward = asPositiveMinor(input.rewardMinor);
    if (!/^[A-Z]{2}$/.test(input.countryCode) || !input.scopeId || !input.scopeKey ||
        !input.policyId || !input.policyKey || !input.activityFingerprint || !input.summary ||
        !input.rationale || input.proposedBy === input.reviewedBy ||
        !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1 ||
        !Number.isInteger(input.reservationSeconds) || input.reservationSeconds < 300 ||
        input.reservationSeconds > 604800 || !Number.isInteger(input.appealSeconds) ||
        input.appealSeconds < 0 || input.appealSeconds > 2592000) {
      throw new EconomyError('INVALID_REVIEWED_AUTHORITY');
    }
    await inTransaction(this.pool, async (client) => {
      const reviewer = await client.query('SELECT role FROM users WHERE id = $1', [input.reviewedBy]);
      if (reviewer.rows[0]?.role !== 'admin') throw new EconomyError('ADMIN_REVIEW_REQUIRED');
      const proposer = await client.query('SELECT id FROM users WHERE id = $1', [input.proposedBy]);
      if (!proposer.rowCount) throw new EconomyError('PROPOSER_NOT_FOUND');
      const quest = await client.query('SELECT version, author_id FROM quests WHERE id = $1 FOR SHARE', [input.questId]);
      if (!quest.rows[0]) throw new EconomyError('QUEST_NOT_FOUND');
      if (quest.rows[0].author_id && quest.rows[0].author_id !== input.proposedBy) {
        throw new EconomyError('QUEST_AUTHOR_MISMATCH');
      }
      await client.query(
        `INSERT INTO economic_activity_scopes
         (id, scope_key, country_code, region_name, province_name, municipality_name,
          destination_spot_id, activity_kind, activity_fingerprint, summary, evidence,
          proposed_by, reviewed_by, status, reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb,$11,$12,'approved',now())`,
        [input.scopeId, input.scopeKey, input.countryCode, input.regionName ?? null,
          input.provinceName ?? null, input.municipalityName ?? null,
          input.destinationSpotId ?? null, input.activityKind, input.activityFingerprint,
          input.summary, input.proposedBy, input.reviewedBy]
      );
      await client.query(
        `INSERT INTO economic_reward_policies
         (id, policy_key, version, asset_code, reward_minor, reservation_seconds,
          appeal_seconds, effective_at, terms_snapshot, proposed_by, approved_by)
         VALUES ($1,$2,$3,$4,($5)::bigint,$6,$7,now(),$8::jsonb,$9,$10)`,
        [input.policyId, input.policyKey, input.policyVersion, SIM_ASSET, reward,
          input.reservationSeconds, input.appealSeconds,
          JSON.stringify({ reward_minor: reward, reservation_seconds: input.reservationSeconds,
            appeal_seconds: input.appealSeconds, asset: SIM_ASSET }), input.proposedBy, input.reviewedBy]
      );
      await client.query(
        `INSERT INTO economic_quest_scope_bindings
         (id, quest_id, quest_version, scope_id, proposed_by, reviewed_by, rationale)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), input.questId, quest.rows[0].version, input.scopeId,
          input.proposedBy, input.reviewedBy, input.rationale]
      );
    });
  }

  async bindReviewedQuestRevision(input: {
    questId: string; scopeId: string; proposedBy: string; reviewedBy: string; rationale: string;
  }): Promise<void> {
    pilotOnly();
    if (!usesDatabasePosting()) throw new EconomyError('REAL_POSTGRES_REQUIRED');
    if (!input.rationale.trim() || input.proposedBy === input.reviewedBy) {
      throw new EconomyError('INVALID_SCOPE_REVIEW');
    }
    await inTransaction(this.pool, async (client) => {
      const reviewer = await client.query('SELECT role FROM users WHERE id = $1', [input.reviewedBy]);
      if (reviewer.rows[0]?.role !== 'admin') throw new EconomyError('ADMIN_REVIEW_REQUIRED');
      const quest = await client.query('SELECT version, author_id FROM quests WHERE id = $1 FOR SHARE', [input.questId]);
      if (!quest.rows[0]) throw new EconomyError('QUEST_NOT_FOUND');
      if (quest.rows[0].author_id && quest.rows[0].author_id !== input.proposedBy) {
        throw new EconomyError('QUEST_AUTHOR_MISMATCH');
      }
      const scope = await client.query('SELECT status FROM economic_activity_scopes WHERE id = $1 FOR SHARE', [input.scopeId]);
      if (scope.rows[0]?.status !== 'approved') throw new EconomyError('APPROVED_ACTIVITY_SCOPE_REQUIRED');
      await client.query(
        `INSERT INTO economic_quest_scope_bindings
         (id, quest_id, quest_version, scope_id, proposed_by, reviewed_by, rationale)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), input.questId, quest.rows[0].version, input.scopeId,
          input.proposedBy, input.reviewedBy, input.rationale]
      );
    });
  }

  async receiptForApprovedSubmissionInTx(
    client: Queryable,
    submission: { id: string; user_id: string; quest_id: string }
  ): Promise<EconomicReceipt | null> {
    const result = await client.query(
      `SELECT a.transaction_id, a.awarded_minor, r.id AS reservation_id
       FROM reward_reservations r
       JOIN reward_awards a ON a.reservation_id = r.id
       JOIN reward_pools p ON p.id = r.pool_id
       WHERE r.submission_id = $1 AND r.user_id = $2 AND p.quest_id = $3
         AND r.status = 'paid' AND p.asset_code = $4`,
      [submission.id, submission.user_id, submission.quest_id, SIM_ASSET]
    );
    const prior = result.rows[0];
    return prior ? {
      transactionId: prior.transaction_id,
      amountMinor: String(prior.awarded_minor),
      asset: SIM_ASSET,
      businessEvent: `reward:${prior.reservation_id}`,
    } : null;
  }

  async reserveForQuestIfActive(questId: string, userId: string): Promise<RewardReservation | null> {
    pilotOnly();
    const result = await this.pool.query(
      `SELECT id FROM reward_pools WHERE quest_id = $1 AND asset_code = $2 AND status = 'active'`,
      [questId, SIM_ASSET]
    );
    if (!result.rows[0]) return null;
    return this.reserveReward(result.rows[0].id, userId);
  }

  async createPilotPool(input: PilotPoolInput): Promise<void> {
    pilotOnly();
    const reward = asPositiveMinor(input.rewardMinor);
    const allocation = asPositiveMinor(input.allocationMinor);
    if (input.allocationMinor < input.rewardMinor || !input.id || !input.scopeKey || !input.policyVersion ||
        !Number.isInteger(input.reservationSeconds) || input.reservationSeconds < 300 || input.reservationSeconds > 604800 ||
        !Number.isInteger(input.appealSeconds) || input.appealSeconds < 0 || input.appealSeconds > 2592000) {
      throw new EconomyError('INVALID_POOL_POLICY');
    }
    const admin = await this.pool.query('SELECT role FROM users WHERE id = $1', [input.adminId]);
    if (admin.rows[0]?.role !== 'admin') throw new EconomyError('ADMIN_REQUIRED');
    if (usesDatabasePosting()) {
      if (!input.scopeId || !input.policyId || input.policyVersion !== input.policyId) {
        throw new EconomyError('REVIEWED_AUTHORITY_REQUIRED');
      }
      const authority = await this.pool.query(
        `SELECT s.id FROM economic_activity_scopes s
         JOIN economic_reward_policies p ON p.id = $2
         JOIN economic_quest_scope_bindings b ON b.scope_id = s.id
         JOIN quests q ON q.id = b.quest_id AND q.version = b.quest_version
         WHERE s.id = $1 AND s.status = 'approved' AND s.scope_key = $3
           AND b.quest_id = $4 AND p.asset_code = $5 AND p.reward_minor = ($6)::bigint
           AND p.reservation_seconds = $7 AND p.appeal_seconds = $8
           AND p.effective_at <= now() AND (p.expires_at IS NULL OR p.expires_at > now())`,
        [input.scopeId, input.policyId, input.scopeKey, input.questId, SIM_ASSET,
          reward, input.reservationSeconds, input.appealSeconds]
      );
      if (!authority.rowCount) throw new EconomyError('REVIEWED_AUTHORITY_REQUIRED');
    }
    const poolColumns = usesDatabasePosting() ? ', scope_id, policy_id' : '';
    const poolValues = usesDatabasePosting() ? ', $10, $11' : '';
    await this.pool.query(
      `INSERT INTO reward_pools
       (id, quest_id, asset_code, scope_key, policy_version, reward_minor, reservation_seconds,
        appeal_seconds, allocated_minor, available_minor, status${poolColumns})
       VALUES ($1, $2, $3, $4, $5, ($6)::bigint, $7, $8, ($9)::bigint, ($9)::bigint, 'draft'${poolValues})`,
      usesDatabasePosting()
        ? [input.id, input.questId, SIM_ASSET, input.scopeKey, input.policyVersion, reward,
          input.reservationSeconds, input.appealSeconds, allocation, input.scopeId, input.policyId]
        : [input.id, input.questId, SIM_ASSET, input.scopeKey, input.policyVersion, reward,
          input.reservationSeconds, input.appealSeconds, allocation]
    );
  }

  async activatePilotPool(poolId: string, adminId: string): Promise<void> {
    pilotOnly();
    await inTransaction(this.pool, async (client) => {
      const admin = await client.query('SELECT role FROM users WHERE id = $1', [adminId]);
      if (admin.rows[0]?.role !== 'admin') throw new EconomyError('ADMIN_REQUIRED');
      const result = await client.query(
        `UPDATE reward_pools SET status = 'active'
         WHERE id = $1 AND asset_code = $2 AND status = 'draft' RETURNING id`, [poolId, SIM_ASSET]
      );
      if (!result.rowCount) {
        const existing = await client.query(
          'SELECT status FROM reward_pools WHERE id = $1 AND asset_code = $2', [poolId, SIM_ASSET]
        );
        if (existing.rows[0]?.status !== 'active') throw new EconomyError('POOL_NOT_DRAFT');
      }
    });
  }

  async reserveReward(poolId: string, userId: string): Promise<RewardReservation> {
    pilotOnly();
    return inTransaction(this.pool, async (client) => {
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!user.rowCount) throw new EconomyError('USER_NOT_FOUND');
      const pool = await client.query('SELECT * FROM reward_pools WHERE id = $1 FOR UPDATE', [poolId]);
      const p = pool.rows[0];
      if (!p || p.asset_code !== SIM_ASSET || p.status !== 'active') throw new EconomyError('POOL_NOT_ACTIVE');
      const quest = await client.query('SELECT version, status, is_active, steps FROM quests WHERE id = $1', [p.quest_id]);
      if (!quest.rows[0] || quest.rows[0].status !== 'published' || !quest.rows[0].is_active) {
        throw new EconomyError('QUEST_NOT_PUBLISHED');
      }
      let bindingId: string | undefined;
      if (usesDatabasePosting()) {
        if (!p.scope_id || !p.policy_id) throw new EconomyError('REVIEWED_AUTHORITY_REQUIRED');
        const binding = await client.query(
          `SELECT b.id FROM economic_quest_scope_bindings b
           JOIN economic_activity_scopes s ON s.id = b.scope_id
           JOIN economic_reward_policies policy ON policy.id = $4
           WHERE b.quest_id = $1 AND b.quest_version = $2 AND b.scope_id = $3
             AND s.status = 'approved' AND policy.effective_at <= now()
             AND (policy.expires_at IS NULL OR policy.expires_at > now())`,
          [p.quest_id, quest.rows[0].version, p.scope_id, p.policy_id]
        );
        if (!binding.rows[0]) throw new EconomyError('QUEST_REVISION_UNREVIEWED');
        bindingId = binding.rows[0].id;
      }
      const awarded = await client.query(
        'SELECT id FROM reward_awards WHERE user_id = $1 AND scope_key = $2', [userId, p.scope_key]
      );
      if (awarded.rowCount) throw new EconomyError('ALREADY_AWARDED');
      const existing = await client.query(
        `SELECT * FROM reward_reservations WHERE user_id = $1 AND scope_key = $2
         AND status IN ('reserved', 'submitted', 'appeal')`, [userId, p.scope_key]
      );
      if (existing.rows[0]) return reservation(existing.rows[0]);
      let attemptId: string | undefined;
      if (usesDatabasePosting()) {
        const current = await client.query(
          `SELECT id, version FROM quest_attempts
           WHERE quest_id = $1 AND user_id = $2 AND status = 'in_progress' FOR UPDATE`,
          [p.quest_id, userId]
        );
        if (current.rows[0]) {
          if (Number(current.rows[0].version) !== Number(quest.rows[0].version)) {
            throw new EconomyError('QUEST_REVISION_STALE');
          }
          attemptId = current.rows[0].id;
        } else {
          attemptId = `attempt_${randomUUID()}`;
          const steps = Array.isArray(quest.rows[0].steps) ? quest.rows[0].steps.length : 0;
          await client.query(
            `INSERT INTO quest_attempts
             (id, quest_id, user_id, version, current_step, total_steps, status)
             VALUES ($1,$2,$3,$4,1,$5,'in_progress')`,
            [attemptId, p.quest_id, userId, quest.rows[0].version, Math.max(1, steps)]
          );
        }
      }
      const amount = BigInt(String(p.reward_minor));
      const remaining = await client.query(
        `UPDATE reward_pools SET available_minor = available_minor - ($2)::bigint,
          reserved_minor = reserved_minor + ($2)::bigint
         WHERE id = $1 AND available_minor >= ($2)::bigint RETURNING id`,
        [poolId, amount.toString()]
      );
      if (!remaining.rowCount) throw new EconomyError('NO_FUNDED_SLOT');
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + Number(p.reservation_seconds) * 1000);
      const inserted = usesDatabasePosting()
        ? await client.query(
          `INSERT INTO reward_reservations
           (id, pool_id, user_id, scope_key, quest_version, amount_minor, status, expires_at,
            attempt_id, scope_id, policy_id, quest_binding_id)
           VALUES ($1,$2,$3,$4,$5,($6)::bigint,'reserved',$7,$8,$9,$10,$11) RETURNING *`,
          [id, poolId, userId, p.scope_key, quest.rows[0].version, amount.toString(), expiresAt,
            attemptId, p.scope_id, p.policy_id, bindingId]
        )
        : await client.query(
          `INSERT INTO reward_reservations
           (id, pool_id, user_id, scope_key, quest_version, amount_minor, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, ($6)::bigint, 'reserved', $7) RETURNING *`,
          [id, poolId, userId, p.scope_key, quest.rows[0].version, amount.toString(), expiresAt]
        );
      return reservation(inserted.rows[0]);
    });
  }

  async settleApprovedSubmissionInTx(
    client: Queryable,
    submission: { id: string; user_id: string; quest_id: string; created_at: string },
    reviewerId: string
  ): Promise<EconomicReceipt | null> {
    const reviewed = await client.query(
      'SELECT status, user_id, quest_id FROM submissions WHERE id = $1', [submission.id]
    );
    if (reviewed.rows[0]?.status !== 'approved' ||
        reviewed.rows[0]?.user_id !== submission.user_id ||
        reviewed.rows[0]?.quest_id !== submission.quest_id) {
      throw new EconomyError('APPROVED_SUBMISSION_REQUIRED');
    }
    const completed = await this.receiptForApprovedSubmissionInTx(client, submission);
    if (completed) return completed;
    const candidates = await client.query(
      `SELECT r.id, r.pool_id FROM reward_reservations r
       JOIN reward_pools p ON p.id = r.pool_id
       WHERE r.user_id = $1 AND p.quest_id = $2
         AND r.status IN ('reserved', 'submitted', 'appeal') ORDER BY r.created_at ASC`,
      [submission.user_id, submission.quest_id]
    );
    for (const candidate of candidates.rows) {
      const poolResult = await client.query('SELECT * FROM reward_pools WHERE id = $1 FOR UPDATE', [candidate.pool_id]);
      const pool = poolResult.rows[0];
      if (!pool || pool.quest_id !== submission.quest_id || pool.asset_code !== SIM_ASSET) continue;
      const locked = await client.query('SELECT * FROM reward_reservations WHERE id = $1 FOR UPDATE', [candidate.id]);
      const r = locked.rows[0];
      if (!r || !['reserved', 'submitted', 'appeal'].includes(r.status)) continue;
      if (usesDatabasePosting() && (r.status !== 'submitted' && r.status !== 'appeal' ||
          r.submission_id !== submission.id || !r.attempt_id || !r.submitted_at)) {
        throw new EconomyError('ATTEMPT_PROOF_MISMATCH');
      }
      const event = `reward:${r.id}`;
      const prior = await client.query('SELECT id FROM economic_transactions WHERE business_event = $1', [event]);
      if (prior.rows[0]) return { transactionId: prior.rows[0].id, amountMinor: String(r.amount_minor), asset: SIM_ASSET, businessEvent: event };
      if (new Date(submission.created_at).getTime() > new Date(r.expires_at).getTime() ||
          new Date(submission.created_at).getTime() < new Date(r.created_at).getTime()) {
        throw new EconomyError('SUBMISSION_OUTSIDE_RESERVATION');
      }
      const other = await client.query(
        'SELECT id FROM reward_awards WHERE user_id = $1 AND scope_key = $2', [submission.user_id, r.scope_key]
      );
      if (other.rowCount) throw new EconomyError('ALREADY_AWARDED');
      const account = await travelerAccount(client, submission.user_id);
      const amount = BigInt(String(r.amount_minor));
      const receipt = await writeTransfer(client, {
        event, operation: 'reward', actorId: reviewerId, policyVersion: pool.policy_version,
        from: ISSUANCE_ACCOUNT, to: account, amount,
        subjectId: r.id, submissionId: submission.id,
      });
      if (!usesDatabasePosting()) {
        await client.query(
          `UPDATE reward_pools SET reserved_minor = reserved_minor - ($2)::bigint,
            paid_minor = paid_minor + ($2)::bigint WHERE id = $1`, [pool.id, amount.toString()]
        );
        await client.query(
          `UPDATE reward_reservations SET status = 'paid', submission_id = $2, updated_at = now()
           WHERE id = $1`, [r.id, submission.id]
        );
        await client.query(
          `INSERT INTO reward_awards
           (id, reservation_id, user_id, scope_key, transaction_id, awarded_minor)
           VALUES ($1, $2, $3, $4, $5, ($6)::bigint)`,
          [randomUUID(), r.id, submission.user_id, r.scope_key, receipt.transactionId, amount.toString()]
        );
      }
      return receipt;
    }
    return null;
  }

  async holdRejectedSubmissionInTx(
    client: Queryable,
    submission: { id: string; user_id: string; quest_id: string }
  ): Promise<void> {
    const reviewed = await client.query(
      'SELECT status, user_id, quest_id FROM submissions WHERE id = $1', [submission.id]
    );
    if (reviewed.rows[0]?.status !== 'rejected' ||
        reviewed.rows[0]?.user_id !== submission.user_id ||
        reviewed.rows[0]?.quest_id !== submission.quest_id) {
      throw new EconomyError('REJECTED_SUBMISSION_REQUIRED');
    }
    const candidates = await client.query(
      `SELECT r.id, r.pool_id FROM reward_reservations r
       JOIN reward_pools p ON p.id = r.pool_id
       WHERE r.user_id = $1 AND p.quest_id = $2
         AND r.status IN ('reserved', 'submitted') ORDER BY r.created_at ASC`,
      [submission.user_id, submission.quest_id]
    );
    for (const candidate of candidates.rows) {
      const poolResult = await client.query('SELECT * FROM reward_pools WHERE id = $1 FOR UPDATE', [candidate.pool_id]);
      const p = poolResult.rows[0];
      if (!p || p.quest_id !== submission.quest_id || p.asset_code !== SIM_ASSET) continue;
      const r = await client.query(
        usesDatabasePosting()
          ? 'SELECT status, submission_id, attempt_id, submitted_at FROM reward_reservations WHERE id = $1 FOR UPDATE'
          : 'SELECT status, submission_id FROM reward_reservations WHERE id = $1 FOR UPDATE',
        [candidate.id]
      );
      if (!r.rows[0] || !['reserved', 'submitted'].includes(r.rows[0].status)) return;
      if (usesDatabasePosting() && (r.rows[0].status !== 'submitted' ||
          r.rows[0].submission_id !== submission.id || !r.rows[0].attempt_id || !r.rows[0].submitted_at)) {
        throw new EconomyError('ATTEMPT_PROOF_MISMATCH');
      }
      const appealUntil = new Date(Date.now() + Number(p.appeal_seconds) * 1000);
      await client.query(
        `UPDATE reward_reservations SET status = 'appeal', submission_id = $2,
          appeal_until = $3, updated_at = now() WHERE id = $1`,
        [candidate.id, submission.id, appealUntil]
      );
      return;
    }
  }

  async submitAppeal(reservationId: string, userId: string, reason: string): Promise<RewardAppealReceipt> {
    pilotOnly();
    if (!usesDatabasePosting()) throw new EconomyError('REAL_POSTGRES_REQUIRED');
    if (reason.trim().length < 10 || reason.trim().length > 2000) {
      throw new EconomyError('INVALID_APPEAL_REASON');
    }
    return inTransaction(this.pool, async (client) => {
      const held = await client.query(
        `SELECT r.id, r.user_id, r.status, r.submission_id, r.appeal_until,
                s.status AS proof_status, s.reviewed_by AS original_reviewer_id
         FROM reward_reservations r LEFT JOIN submissions s ON s.id = r.submission_id
         WHERE r.id = $1 FOR UPDATE OF r`, [reservationId]
      );
      const row = held.rows[0];
      if (!row || row.user_id !== userId) throw new EconomyError('RESERVATION_NOT_FOUND');
      const prior = await client.query(
        `SELECT id, reservation_id, status, reason, requested_at
         FROM reward_appeals WHERE reservation_id = $1`, [reservationId]
      );
      if (prior.rows[0]) {
        if (prior.rows[0].reason !== reason.trim()) throw new EconomyError('APPEAL_REPLAY_CONFLICT');
        return { id: prior.rows[0].id, reservationId,
          status: prior.rows[0].status, requestedAt: dateString(prior.rows[0].requested_at) };
      }
      const now = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
      if (row.status !== 'appeal' || row.proof_status !== 'rejected' ||
          !row.appeal_until || new Date(now).getTime() > new Date(row.appeal_until).getTime()) {
        throw new EconomyError('APPEAL_WINDOW_CLOSED');
      }
      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO reward_appeals
         (id,reservation_id,submission_id,user_id,original_reviewer_id,reason,requested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING requested_at`,
        [id, reservationId, row.submission_id, userId, row.original_reviewer_id, reason.trim(), now]
      );
      return { id, reservationId, status: 'submitted', requestedAt: dateString(inserted.rows[0].requested_at) };
    });
  }

  async denyAppeal(appealId: string, adminId: string, reason: string): Promise<RewardAppealReceipt> {
    pilotOnly();
    if (!usesDatabasePosting()) throw new EconomyError('REAL_POSTGRES_REQUIRED');
    if (reason.trim().length < 10 || reason.trim().length > 2000) {
      throw new EconomyError('INVALID_APPEAL_DECISION');
    }
    return inTransaction(this.pool, async (client) => {
      const identity = await client.query(
        `SELECT a.reservation_id, a.submission_id, a.user_id, r.pool_id
         FROM reward_appeals a JOIN reward_reservations r ON r.id = a.reservation_id
         WHERE a.id = $1`, [appealId]
      );
      const target = identity.rows[0];
      if (!target) throw new EconomyError('APPEAL_NOT_FOUND');
      await client.query('SELECT id FROM submissions WHERE id = $1 FOR UPDATE', [target.submission_id]);
      const appeal = await client.query('SELECT * FROM reward_appeals WHERE id = $1 FOR UPDATE', [appealId]);
      const a = appeal.rows[0];
      if (a.status === 'rejected') {
        if (a.decided_by !== adminId || a.decision_reason !== reason.trim()) {
          throw new EconomyError('APPEAL_REPLAY_CONFLICT');
        }
        return { id: appealId, reservationId: a.reservation_id,
          status: 'rejected', requestedAt: dateString(a.requested_at) };
      }
      if (a.status !== 'submitted') throw new EconomyError('APPEAL_REVIEW_CONFLICT');
      const reviewer = await client.query('SELECT role FROM users WHERE id = $1', [adminId]);
      const quest = await client.query(
        `SELECT q.author_id FROM submissions s JOIN quests q ON q.id = s.quest_id WHERE s.id = $1`,
        [target.submission_id]
      );
      if (reviewer.rows[0]?.role !== 'admin' || adminId === a.user_id ||
          adminId === a.original_reviewer_id || adminId === quest.rows[0]?.author_id) {
        throw new EconomyError('INDEPENDENT_APPEAL_REVIEW_REQUIRED');
      }
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [target.user_id]);
      const pool = await client.query('SELECT id FROM reward_pools WHERE id = $1 FOR UPDATE', [target.pool_id]);
      const held = await client.query('SELECT * FROM reward_reservations WHERE id = $1 FOR UPDATE', [target.reservation_id]);
      const r = held.rows[0];
      if (!pool.rowCount || !r || r.status !== 'appeal' ||
          r.submission_id !== target.submission_id) throw new EconomyError('APPEAL_REVIEW_CONFLICT');
      await client.query(
        `UPDATE reward_appeals SET status = 'rejected', decided_by = $2,
         decided_at = clock_timestamp(), decision_reason = $3 WHERE id = $1`,
        [appealId, adminId, reason.trim()]
      );
      await client.query(
        `UPDATE reward_pools SET reserved_minor = reserved_minor - ($2)::bigint,
         available_minor = available_minor + ($2)::bigint WHERE id = $1`,
        [target.pool_id, String(r.amount_minor)]
      );
      await client.query(
        `UPDATE reward_reservations SET status = 'released', updated_at = clock_timestamp()
         WHERE id = $1`, [r.id]
      );
      if (r.attempt_id) {
        await client.query(
          `UPDATE quest_attempts SET status = 'abandoned', updated_at = clock_timestamp()
           WHERE id = $1 AND status IN ('submitted','in_progress')`, [r.attempt_id]
        );
      }
      return { id: appealId, reservationId: r.id,
        status: 'rejected', requestedAt: dateString(a.requested_at) };
    });
  }

  async releaseExpiredReservation(reservationId: string): Promise<boolean> {
    pilotOnly();
    return inTransaction(this.pool, async (client) => {
      const lookup = await client.query('SELECT user_id, pool_id FROM reward_reservations WHERE id = $1', [reservationId]);
      if (!lookup.rows[0]) return false;
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [lookup.rows[0].user_id]);
      const pool = await client.query('SELECT * FROM reward_pools WHERE id = $1 FOR UPDATE', [lookup.rows[0].pool_id]);
      const row = await client.query('SELECT * FROM reward_reservations WHERE id = $1 FOR UPDATE', [reservationId]);
      const r = row.rows[0];
      if (!r || !pool.rows[0] || !['reserved', 'appeal'].includes(r.status)) return false;
      const deadline = r.status === 'appeal' ? r.appeal_until : r.expires_at;
      if (!deadline || new Date(deadline).getTime() > Date.now()) return false;
      if (usesDatabasePosting() && r.status === 'appeal') {
        const appeal = await client.query('SELECT status FROM reward_appeals WHERE reservation_id = $1', [r.id]);
        if (appeal.rows[0]?.status === 'submitted' || appeal.rows[0]?.status === 'approved') return false;
      }
      if (r.status === 'reserved') {
        const timely = await client.query(
          usesDatabasePosting()
            ? `SELECT id, status, reviewed_at, created_at FROM submissions WHERE user_id = $1 AND quest_id = $2
               AND economic_attempt_id = $5 AND created_at >= $3 AND created_at <= $4
               ORDER BY created_at ASC LIMIT 1`
            : `SELECT id, status, reviewed_at, created_at FROM submissions WHERE user_id = $1 AND quest_id = $2
               AND created_at >= $3 AND created_at <= $4 ORDER BY created_at ASC LIMIT 1`,
          usesDatabasePosting()
            ? [r.user_id, pool.rows[0].quest_id, r.created_at, r.expires_at, r.attempt_id]
            : [r.user_id, pool.rows[0].quest_id, r.created_at, r.expires_at]
        );
        if (timely.rows[0]) {
          const submitted = timely.rows[0];
          const rejected = submitted.status === 'rejected';
          const appealUntil = rejected
            ? new Date(new Date(submitted.reviewed_at ?? Date.now()).getTime() + Number(pool.rows[0].appeal_seconds) * 1000)
            : null;
          if (usesDatabasePosting()) {
            await client.query(
              `UPDATE reward_reservations SET status = $2, submission_id = $3,
                appeal_until = $4, submitted_at = $5, updated_at = now() WHERE id = $1`,
              [r.id, rejected ? 'appeal' : 'submitted', submitted.id, appealUntil, submitted.created_at]
            );
          } else {
            await client.query(
              `UPDATE reward_reservations SET status = $2, submission_id = $3,
                appeal_until = $4, updated_at = now() WHERE id = $1`,
              [r.id, rejected ? 'appeal' : 'submitted', submitted.id, appealUntil]
            );
          }
          return false;
        }
      }
      const amount = String(r.amount_minor);
      await client.query(
        `UPDATE reward_pools SET reserved_minor = reserved_minor - ($2)::bigint,
          available_minor = available_minor + ($2)::bigint WHERE id = $1`, [r.pool_id, amount]
      );
      await client.query(
        `UPDATE reward_reservations SET status = 'released', updated_at = now() WHERE id = $1`, [r.id]
      );
      if (usesDatabasePosting() && r.attempt_id) {
        await client.query(
          `UPDATE quest_attempts SET status = 'abandoned', updated_at = now()
           WHERE id = $1 AND status IN ('in_progress','submitted')`, [r.attempt_id]
        );
      }
      return true;
    });
  }

  async purchaseCosmetic(userId: string, cosmeticId: string, idempotencyKey: string): Promise<EconomicReceipt> {
    pilotOnly();
    if (!idempotencyKey || idempotencyKey.length > 120) throw new EconomyError('INVALID_IDEMPOTENCY_KEY');
    return inTransaction(this.pool, async (client) => {
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!user.rowCount) throw new EconomyError('USER_NOT_FOUND');
      const hash = createHash('sha256').update(cosmeticId).digest('hex');
      const command = await client.query(
        `SELECT request_hash, transaction_id FROM economic_commands
         WHERE actor_id = $1 AND operation = 'spend' AND idempotency_key = $2`, [userId, idempotencyKey]
      );
      if (command.rows[0]) {
        if (command.rows[0].request_hash !== hash) throw new EconomyError('IDEMPOTENCY_CONFLICT');
        const original = await client.query(
          'SELECT amount_minor FROM economic_transfers WHERE transaction_id = $1 AND sequence = 1',
          [command.rows[0].transaction_id]
        );
        return { transactionId: command.rows[0].transaction_id,
          amountMinor: String(original.rows[0].amount_minor), asset: SIM_ASSET,
          businessEvent: `cosmetic:${userId}:${cosmeticId}` };
      }
      const item = await client.query(
        'SELECT * FROM economic_cosmetics WHERE id = $1 AND asset_code = $2 AND active = true',
        [cosmeticId, SIM_ASSET]
      );
      if (!item.rows[0]) throw new EconomyError('COSMETIC_UNAVAILABLE');
      const existing = await client.query(
        'SELECT transaction_id FROM economic_entitlements WHERE user_id = $1 AND cosmetic_id = $2',
        [userId, cosmeticId]
      );
      if (existing.rows[0]) throw new EconomyError('ALREADY_OWNED');
      const account = await travelerAccount(client, userId);
      const receipt = await writeTransfer(client, {
        event: `cosmetic:${userId}:${cosmeticId}`, operation: 'spend', actorId: userId,
        policyVersion: 'cosmetic-pilot-v1', from: account, to: RETIRED_ACCOUNT,
        amount: BigInt(String(item.rows[0].cost_minor)), subjectId: cosmeticId,
        idempotencyKey, requestHash: hash,
      });
      if (!usesDatabasePosting()) {
        await client.query(
          `INSERT INTO economic_entitlements (id, user_id, cosmetic_id, transaction_id)
           VALUES ($1, $2, $3, $4)`, [randomUUID(), userId, cosmeticId, receipt.transactionId]
        );
        await client.query(
          `INSERT INTO economic_commands (actor_id, operation, idempotency_key, request_hash, transaction_id)
           VALUES ($1, 'spend', $2, $3, $4)`, [userId, idempotencyKey, hash, receipt.transactionId]
        );
      }
      return receipt;
    });
  }

  async refundSimulatedCosmetic(
    originalTransactionId: string, adminId: string, reason: string, idempotencyKey: string
  ): Promise<EconomicReceipt> {
    pilotOnly();
    if (!usesDatabasePosting()) throw new EconomyError('REAL_POSTGRES_REQUIRED');
    const normalizedReason = reason.trim();
    if (!originalTransactionId || !idempotencyKey || idempotencyKey.length > 120 ||
        normalizedReason.length < 10 || normalizedReason.length > 2000) {
      throw new EconomyError('INVALID_SIMULATED_REFUND');
    }
    const hash = createHash('sha256')
      .update(`${originalTransactionId}\0${normalizedReason}`).digest('hex');
    return inTransaction(this.pool, async (client) => {
      const prior = await client.query(
        `SELECT request_hash, transaction_id FROM economic_commands
         WHERE actor_id = $1 AND operation = 'refund' AND idempotency_key = $2`,
        [adminId, idempotencyKey]
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash) throw new EconomyError('IDEMPOTENCY_CONFLICT');
        const original = await client.query(
          `SELECT amount_minor FROM economic_transfers WHERE transaction_id = $1 AND sequence = 1`,
          [prior.rows[0].transaction_id]
        );
        if (!original.rows[0]) throw new EconomyError('REFUND_RECEIPT_UNAVAILABLE');
        return { transactionId: prior.rows[0].transaction_id,
          amountMinor: String(original.rows[0].amount_minor), asset: SIM_ASSET,
          businessEvent: `refund:${originalTransactionId}` };
      }
      const correctingTransactionId = randomUUID();
      try {
        await client.query(
          `SELECT economic_refund_cosmetic($1,$2,$3,$4,$5,$6,$7)`,
          [originalTransactionId, correctingTransactionId, randomUUID(), adminId,
            normalizedReason, idempotencyKey, hash]
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'SIMULATED_SPEND_NOT_REFUNDABLE') {
          throw new EconomyError('ALREADY_REFUNDED_OR_INELIGIBLE');
        }
        throw error;
      }
      const posted = await client.query(
        `SELECT amount_minor FROM economic_transfers WHERE transaction_id = $1 AND sequence = 1`,
        [correctingTransactionId]
      );
      if (!posted.rows[0]) throw new EconomyError('REFUND_RECEIPT_UNAVAILABLE');
      return { transactionId: correctingTransactionId,
        amountMinor: String(posted.rows[0].amount_minor), asset: SIM_ASSET,
        businessEvent: `refund:${originalTransactionId}` };
    });
  }

  async balance(userId: string): Promise<string> {
    const result = await this.pool.query(
      `SELECT balance_minor FROM economic_accounts
       WHERE asset_code = $1 AND user_id = $2 AND kind = 'traveler'`, [SIM_ASSET, userId]
    );
    return String(result.rows[0]?.balance_minor ?? '0');
  }
}
