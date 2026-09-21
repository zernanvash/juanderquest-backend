import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { db, UserRow } from '../db/index.js';
import { progressionRepo } from './repository.js';
import { getExplorerLevel, getCivicLevel, getScoutLevel } from './levels.js';
import {
  TravelerPassport,
  AchievementAward,
  CuratedCollection,
} from './types.js';

export class ProgressionService {
  /**
   * Called within the submission approval transaction to emit an approval outbox event.
   * Ensures that unmapped, ambiguous, or scope-mismatched submissions do NOT silently convert to visits.
   */
  async recordApprovalOutboxEvent(
    submission: {
      id: string;
      user_id: string;
      quest_id: string;
      created_at: string | Date;
      reviewed_at?: string | Date | null;
      is_test?: boolean;
    },
    client: PoolClient
  ): Promise<void> {
    // 1. Verify actor and quest scope from database
    const { rows: scopeRows } = await client.query(
      `SELECT sub.is_test AS sub_test, u.is_test AS user_test, q.is_test AS quest_test
       FROM submissions sub
       JOIN users u ON u.id = sub.user_id
       JOIN quests q ON q.id = sub.quest_id
       WHERE sub.id = $1`,
      [submission.id]
    );

    const subTest = Boolean(submission.is_test ?? scopeRows[0]?.sub_test);
    const userTest = Boolean(scopeRows[0]?.user_test);
    const questTest = Boolean(scopeRows[0]?.quest_test);

    const binding = await progressionRepo.getActiveBindingForQuest(submission.quest_id, client);
    let spotTest = questTest;
    let rawMunicipality = '';
    if (binding && binding.spot_id) {
      const { rows: spotRows } = await client.query(
        'SELECT municipality, is_test FROM spots WHERE id = $1',
        [binding.spot_id]
      );
      rawMunicipality = spotRows[0]?.municipality || '';
      if (spotRows.length) {
        spotTest = Boolean(spotRows[0].is_test);
      }
    }

    // Comprehensive scope check: user, submission, quest, binding, and spot must have matching scope
    const isScopeMismatched =
      userTest !== questTest ||
      subTest !== questTest ||
      (binding ? Boolean(binding.is_test) !== questTest : false) ||
      (binding ? spotTest !== questTest : false);

    // Note: occurred_at records submission creation/receipt time, not proven physical capture time.
    const occurredAt = submission.created_at instanceof Date
      ? submission.created_at.toISOString()
      : new Date(submission.created_at).toISOString();

    const verifiedAt = submission.reviewed_at
      ? (submission.reviewed_at instanceof Date ? submission.reviewed_at.toISOString() : new Date(submission.reviewed_at).toISOString())
      : new Date().toISOString();

    if (isScopeMismatched) {
      // Mixed-scope evidence: quarantine as unresolved audit record
      await progressionRepo.insertOutboxEvent(
        {
          id: randomUUID(),
          event_key: `submission_approval_unresolved_${submission.id}`,
          event_type: 'submission_approved_unresolved',
          payload: {
            submission_id: submission.id,
            user_id: submission.user_id,
            quest_id: submission.quest_id,
            reason: 'SCOPE_MISMATCH',
            occurred_at: occurredAt,
            verified_at: verifiedAt,
            is_test: true,
          },
        },
        client
      );
      return;
    }

    const effectiveIsTest = subTest || userTest || questTest || Boolean(binding?.is_test);

    if (binding && binding.spot_id) {
      const municipalityId = await progressionRepo.resolveCanonicalMunicipalityId(rawMunicipality, client);

      // Unambiguous active reviewed binding exists
      await progressionRepo.insertOutboxEvent(
        {
          id: randomUUID(),
          event_key: `submission_approval_${submission.id}`,
          event_type: 'submission_approved',
          payload: {
            submission_id: submission.id,
            user_id: submission.user_id,
            quest_id: submission.quest_id,
            binding_id: binding.id,
            spot_id: binding.spot_id,
            municipality_id: municipalityId,
            binding_version: binding.binding_version,
            occurred_at: occurredAt,
            verified_at: verifiedAt,
            is_test: effectiveIsTest,
          },
        },
        client
      );
    } else {
      // Unmapped or ambiguous quest: emit unresolved evidence record for review, NOT a visit award
      await progressionRepo.insertOutboxEvent(
        {
          id: randomUUID(),
          event_key: `submission_approval_unresolved_${submission.id}`,
          event_type: 'submission_approved_unresolved',
          payload: {
            submission_id: submission.id,
            user_id: submission.user_id,
            quest_id: submission.quest_id,
            reason: binding ? 'BINDING_NOT_ACTIVE' : 'NO_REVIEWED_BINDING',
            occurred_at: occurredAt,
            verified_at: verifiedAt,
            is_test: effectiveIsTest,
          },
        },
        client
      );
    }
  }

  /**
   * Processes a batch of pending outbox events.
   * Safely idempotent: duplicate deliveries do not duplicate visits, XP, or awards.
   */
  async processOutboxBatch(batchSize = 20, leaseOwner = `worker-${process.pid}`): Promise<{ processed: number; failed: number }> {
    const pool = getPool();
    if (!pool) return { processed: 0, failed: 0 };

    const events = await progressionRepo.claimPendingOutboxEvents(batchSize, 30, leaseOwner, pool);
    let processed = 0;
    let failed = 0;

    for (const event of events) {
      const client = await pool.connect();
      const activeOwner = event.lease_owner || leaseOwner;
      const claimToken = event.claim_token || undefined;
      try {
        await client.query('BEGIN');

        if (event.event_type === 'submission_approved') {
          const payload = event.payload;

          // 1. Lock submission row FOR SHARE to stabilize source evidence against concurrent modifications
          const { rows: verifiedSub } = await client.query(
            "SELECT id, user_id, quest_id, status, is_test FROM submissions WHERE id = $1 AND status = 'approved' FOR SHARE",
            [payload.submission_id]
          );

          if (!verifiedSub.length) {
            // Submission is revoked or not approved; fail outbox delivery safely
            await progressionRepo.markOutboxFailed(event.id, activeOwner, 'SUBMISSION_NOT_APPROVED', 3600, client, claimToken);
            await client.query('COMMIT');
            failed++;
            continue;
          }

          const sub = verifiedSub[0];
          if (sub.user_id !== payload.user_id || sub.quest_id !== payload.quest_id) {
            await progressionRepo.markOutboxFailed(event.id, activeOwner, 'IDENTITY_MISMATCH', 3600, client, claimToken);
            await client.query('COMMIT');
            failed++;
            continue;
          }

          // 2. Require an explicit valid reviewed binding evidence before any award
          if (!payload.binding_id) {
            await progressionRepo.markOutboxFailed(event.id, activeOwner, 'BINDING_MISSING', 3600, client, claimToken);
            await client.query('COMMIT');
            failed++;
            continue;
          }

          // Lock user row FOR UPDATE early to serialize with progression totals updates and prevent deadlock
          const { rows: userRows } = await client.query('SELECT id, is_test FROM users WHERE id = $1 FOR UPDATE', [payload.user_id]);
          const { rows: questRows } = await client.query('SELECT id, is_test FROM quests WHERE id = $1 FOR SHARE', [payload.quest_id]);
          const { rows: spotRows } = await client.query('SELECT id, is_test, status, municipality FROM spots WHERE id = $1 FOR SHARE', [payload.spot_id]);
          const { rows: bindingRows } = await client.query(
            'SELECT id, quest_id, spot_id, status, is_test FROM reviewed_quest_spot_bindings WHERE id = $1 FOR SHARE',
            [payload.binding_id]
          );

          if (!userRows.length || !questRows.length || !spotRows.length || !bindingRows.length) {
            await progressionRepo.markOutboxFailed(event.id, activeOwner, 'SOURCE_ENTITY_MISSING', 3600, client, claimToken);
            await client.query('COMMIT');
            failed++;
            continue;
          }

          if (spotRows[0].status !== 'published') {
            await progressionRepo.markOutboxFailed(event.id, activeOwner, 'SPOT_NOT_PUBLISHED', 3600, client, claimToken);
            await client.query('COMMIT');
            failed++;
            continue;
          }

          if (bindingRows[0].status !== 'active') {
            await progressionRepo.markOutboxFailed(event.id, activeOwner, 'BINDING_NOT_ACTIVE', 3600, client, claimToken);
            await client.query('COMMIT');
            failed++;
            continue;
          }

          if (bindingRows[0].quest_id !== payload.quest_id || bindingRows[0].spot_id !== payload.spot_id) {
            await progressionRepo.markOutboxFailed(event.id, activeOwner, 'BINDING_MISMATCH', 3600, client, claimToken);
            await client.query('COMMIT');
            failed++;
            continue;
          }

          const subTest = Boolean(sub.is_test);
          const userTest = Boolean(userRows[0].is_test);
          const questTest = Boolean(questRows[0].is_test);
          const spotTest = Boolean(spotRows[0].is_test);
          const bindingTest = Boolean(bindingRows[0].is_test);
          const payloadTest = Boolean(payload.is_test);

          // All entities in source chain (submission, actor, quest, spot, binding, and event payload)
          // MUST strictly agree in scope (all real or all test). Any mixed-scope evidence is rejected.
          const allTest = subTest && userTest && questTest && spotTest && bindingTest && payloadTest;
          const allReal = !subTest && !userTest && !questTest && !spotTest && !bindingTest && !payloadTest;

          if (!allTest && !allReal) {
            await progressionRepo.markOutboxFailed(event.id, activeOwner, 'SCOPE_MISMATCH', 3600, client, claimToken);
            await client.query('COMMIT');
            failed++;
            continue;
          }

          const currentEffectiveIsTest = allTest;

          // 3. Preserve snapshot or unresolved geography honestly without substituting current spot geography
          const municipalityId = payload.municipality_id || null;

          // 4. Record verified visit (checks for revoked visit)
          try {
            await progressionRepo.recordVerifiedVisit(
              {
                id: randomUUID(),
                user_id: payload.user_id,
                spot_id: payload.spot_id,
                binding_id: payload.binding_id || null,
                municipality_id: municipalityId,
                source_submission_id: payload.submission_id,
                occurred_at: payload.occurred_at,
                verified_at: payload.verified_at || new Date().toISOString(),
                evidence_version: payload.binding_version || 'v1',
                is_test: currentEffectiveIsTest,
              },
              client
            );
          } catch (visitErr: any) {
            if (visitErr?.message?.includes('VISIT_REVOKED')) {
              await progressionRepo.markOutboxFailed(event.id, activeOwner, 'VISIT_REVOKED', 3600, client, claimToken);
              await client.query('COMMIT');
              failed++;
              continue;
            }
            throw visitErr;
          }

          // 5. Award Explorer XP (+50 XP per verified visit, rule version explorer-v1)
          const xpEvent = await progressionRepo.recordProgressionEvent(
            {
              id: randomUUID(),
              user_id: payload.user_id,
              track: 'explorer',
              delta: 50,
              source_type: 'submission_approval',
              source_id: payload.submission_id,
              award_kind: 'xp',
              rule_version: 'explorer-v1',
              earned_at: payload.occurred_at,
              is_test: currentEffectiveIsTest,
            },
            client
          );

          // Only increment totals if this XP event was newly inserted (not duplicate replay)
          if (xpEvent) {
            await progressionRepo.updateProgressionTotals(
              payload.user_id,
              { explorerXp: 50 },
              client
            );
          }

          // 6. Evaluate milestone achievements
          await this.evaluateAchievementsForUser(
            payload.user_id,
            payload.spot_id,
            payload.submission_id,
            currentEffectiveIsTest,
            client
          );
        } else if (event.event_type === 'submission_approved_unresolved') {
          // No-op for unresolved events; recorded for audit inspection
        }

        const completed = await progressionRepo.markOutboxCompleted(event.id, activeOwner, client, claimToken);
        if (completed) {
          await client.query('COMMIT');
          processed++;
        } else {
          // Stale worker lost lease ownership during execution; rollback transaction cleanly
          await client.query('ROLLBACK');
          failed++;
        }
      } catch (err: any) {
        await client.query('ROLLBACK');
        await progressionRepo.markOutboxFailed(event.id, activeOwner, err?.message || 'unknown error', 10, pool, claimToken);
        failed++;
      } finally {
        client.release();
      }
    }

    return { processed, failed };
  }

  /**
   * Catches up approved submissions that missed outbox emission (e.g. during disabled emission periods).
   * Durable watermark/sync policy guaranteeing no historical progression is lost.
   */
  async catchUpApprovedSubmissions(
    options: { since?: string; limit?: number } = {}
  ): Promise<{ enqueued: number }> {
    const pool = getPool();
    if (!pool) return { enqueued: 0 };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const limit = options.limit || 100;
      const sinceClause = options.since ? 'AND s.reviewed_at >= $2' : '';
      const params: any[] = [limit];
      if (options.since) params.push(options.since);

      const { rows: missedSubmissions } = await client.query(
        `SELECT s.* FROM submissions s
         WHERE s.status = 'approved'
           AND s.id NOT IN (
             SELECT payload->>'submission_id' FROM outbox_events
             WHERE event_type IN ('submission_approved', 'submission_approved_unresolved')
               AND payload->>'submission_id' IS NOT NULL
           )
           AND s.id NOT IN (
             SELECT source_submission_id FROM verified_visits
           )
           ${sinceClause}
         ORDER BY s.reviewed_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        params
      );

      let enqueued = 0;
      for (const sub of missedSubmissions) {
        await this.recordApprovalOutboxEvent(
          {
            id: sub.id,
            user_id: sub.user_id,
            quest_id: sub.quest_id,
            created_at: sub.created_at,
            reviewed_at: sub.reviewed_at,
            is_test: sub.is_test,
          },
          client
        );
        enqueued++;
      }
      await client.query('COMMIT');
      return { enqueued };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async evaluateAchievementsForUser(
    userId: string,
    spotId: string,
    submissionId: string,
    isTest = false,
    client: PoolClient
  ): Promise<void> {
    // 1. First Footstep (1 verified visit)
    const { rows: firstVisitRows } = await client.query(
      'SELECT id FROM verified_visits WHERE user_id = $1 AND is_test = $2 AND revoked_at IS NULL LIMIT 1',
      [userId, isTest]
    );
    if (firstVisitRows.length >= 1) {
      await progressionRepo.awardAchievement(
        {
          id: randomUUID(),
          user_id: userId,
          achievement_id: 'first_footstep',
          season: 'all_time',
          source_evidence_id: `submission_${submissionId}`,
          awarded_at: new Date().toISOString(),
          is_test: isTest,
        },
        client
      );
    }

    // 2. Pangasinan Pioneer (5 UNIQUE destinations / spots)
    const { rows: uniqueSpotsRows } = await client.query(
      `SELECT COUNT(DISTINCT spot_id) AS unique_spots
       FROM verified_visits
       WHERE user_id = $1 AND is_test = $2 AND revoked_at IS NULL`,
      [userId, isTest]
    );
    const uniqueSpotsCount = Number(uniqueSpotsRows[0]?.unique_spots || 0);

    if (uniqueSpotsCount >= 5) {
      await progressionRepo.awardAchievement(
        {
          id: randomUUID(),
          user_id: userId,
          achievement_id: 'pangasinan_pioneer',
          season: 'all_time',
          source_evidence_id: `unique_spots_5_${spotId}`,
          awarded_at: new Date().toISOString(),
          is_test: isTest,
        },
        client
      );
    }

    // 3. Curated Trail completions
    const collections = await progressionRepo.getCuratedCollections(userId, isTest, client);
    for (const coll of collections) {
      if (coll.completed && coll.badge_id) {
        await progressionRepo.awardAchievement(
          {
            id: randomUUID(),
            user_id: userId,
            achievement_id: coll.badge_id,
            season: 'all_time',
            source_evidence_id: `collection_${coll.id}_completed`,
            awarded_at: new Date().toISOString(),
            is_test: isTest,
          },
          client
        );
      }
    }
  }

  async getTravelerPassport(
    targetUserId: string,
    requestingUserId?: string,
    allowTest = false
  ): Promise<TravelerPassport | null> {
    const pool = getPool();
    let targetUser: UserRow | null = null;

    if (pool) {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [targetUserId]);
      if (rows.length) {
        targetUser = rows[0] as UserRow;
      }
    } else {
      targetUser = db.findUserById(targetUserId) || null;
    }

    if (!targetUser) return null;

    // Synthetic QA quarantine: non-test requests must never view synthetic test users
    if (targetUser.is_test && !allowTest) {
      return null;
    }

    // Privacy rule: private users can only be inspected by themselves
    const isOwner = requestingUserId === targetUserId;
    if (!targetUser.is_public && !isOwner) {
      return null;
    }

    // Totals
    const totals = await progressionRepo.getTotalsForUser(targetUserId);
    const explorerXp = totals?.explorer_xp || 0;
    const civicXp = totals?.civic_xp || 0;
    const civicStamps = totals?.civic_stamps || 0;
    const scoutRep = targetUser.scout_reputation || 0;

    // Explorer, Civic, Scout calculations
    const explorer = getExplorerLevel(explorerXp);
    const civic = getCivicLevel(civicXp, civicStamps);
    const scout = getScoutLevel(scoutRep);

    // LGU progress
    const exploredLgus = await progressionRepo.getExploredLguCount(targetUserId, allowTest);
    const totalLgus = await progressionRepo.getTotalLguCount();
    const percentage = totalLgus > 0
      ? Number(((exploredLgus / totalLgus) * 100).toFixed(1))
      : 0;

    // Recent visits & achievements (only owner gets full visit trail; public gets achievements)
    const recentVisits = isOwner
      ? await progressionRepo.getVerifiedVisitsForUser(targetUserId, { limit: 10, allowTest })
      : [];

    const recentAchievements = await progressionRepo.getAwardsForUser(targetUserId, allowTest);

    return {
      user_id: targetUser.id,
      display_name: targetUser.display_name,
      avatar_url: targetUser.avatar_url || '',
      role: targetUser.role,
      is_public: Boolean(targetUser.is_public),
      explorer,
      civic: {
        ...civic,
        stamps: civicStamps,
      },
      scout,
      lgu_progress: {
        explored: exploredLgus,
        total: totalLgus,
        percentage,
      },
      recent_visits: recentVisits,
      recent_achievements: recentAchievements,
    };
  }

  async getPublicAchievements(
    targetUserId: string,
    allowTest = false
  ): Promise<{ user_id: string; display_name: string; is_public: boolean; achievements: AchievementAward[] } | null> {
    const pool = getPool();
    let targetUser: UserRow | null = null;

    if (pool) {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [targetUserId]);
      if (rows.length) targetUser = rows[0] as UserRow;
    } else {
      targetUser = db.findUserById(targetUserId) || null;
    }

    if (!targetUser) return null;
    if (targetUser.is_test && !allowTest) return null;
    if (!targetUser.is_public) return null;

    const achievements = await progressionRepo.getAwardsForUser(targetUserId, allowTest);

    return {
      user_id: targetUser.id,
      display_name: targetUser.display_name,
      is_public: true,
      achievements,
    };
  }
}

export const progressionService = new ProgressionService();
