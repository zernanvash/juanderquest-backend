import { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { env, extractDatabaseName, isPresentationDatabaseName, UUID_V4_REGEX } from '../config/env.js';
import { JuanChoiceError } from './service.js';

export interface PresentationOverviewResult {
  server_time: string;
  region: {
    key: string;
    label: string;
    timezone: string;
  };
  view: 'open' | 'between';
  availability: {
    voting_enabled: boolean;
    reason: string | null;
  };
  current: {
    id: string;
    slug: string;
    region: string;
    theme: string;
    status: string;
    opens_at: string;
    closes_at: string;
    policy_version: string;
    period_start: string;
  } | null;
  next: {
    opens_at: string;
    closes_at: string;
    theme: string | null;
    schedule_status: 'scheduled';
  } | null;
  previous: {
    campaign_id: string;
    period_label: string;
    opens_at: string;
    closes_at: string;
    finalized_at: string;
    theme: string;
    valid_ballots: number;
    co_winner_ids: string[];
    standings: unknown[];
  } | null;
  notice: {
    code: string;
    message: string;
  } | null;
  environment: 'presentation_demo';
}

function safeClosedResponse(
  now: Date,
  regionKey: string,
  reason: string,
  notice?: { code: string; message: string } | null
): PresentationOverviewResult {
  return {
    server_time: now.toISOString(),
    region: {
      key: regionKey,
      label: regionKey === 'pangasinan' ? 'Pangasinan' : regionKey,
      timezone: 'Asia/Manila',
    },
    view: 'between',
    availability: {
      voting_enabled: false,
      reason,
    },
    current: null,
    next: null,
    previous: null,
    notice: notice ?? {
      code: 'PRESENTATION_ROUND_UNAVAILABLE',
      message: 'The presentation demo round is not currently active.',
    },
    environment: 'presentation_demo',
  };
}

async function queryPresentationOverview(regionKey: string): Promise<PresentationOverviewResult> {
  const pool = getPool();
  if (!pool) throw new JuanChoiceError('DATABASE_OUTAGE', 503);

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const clockResult = await client.query('SELECT clock_timestamp() AS now, current_database() AS current_db');
    const now = new Date(clockResult.rows[0].now);
    const currentDb: string = clockResult.rows[0].current_db ?? '';

    // Verify connected database identity
    if (!isPresentationDatabaseName(currentDb, env.NODE_ENV)) {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'INVALID_PRESENTATION_DATABASE');
    }

    const configuredDbName = env.JUANCHOICE_PRESENTATION_DB_NAME?.trim();
    if (!configuredDbName || configuredDbName !== currentDb) {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'INVALID_PRESENTATION_DATABASE');
    }

    const actualDbFromUrl = extractDatabaseName(env.DATABASE_URL);
    if (!actualDbFromUrl || actualDbFromUrl !== currentDb) {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'INVALID_PRESENTATION_DATABASE');
    }

    // Disallow in-memory fallback flag
    if (env.ALLOW_IN_MEMORY_FALLBACK) {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'INVALID_PRESENTATION_CONFIG');
    }

    // In production, signature wallet auth is mandatory
    if (env.NODE_ENV === 'production' && env.WALLET_AUTH_MODE !== 'signature') {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'INVALID_PRESENTATION_CONFIG');
    }

    // Verify configured allowlisted campaign ID
    const configuredCampaignId = env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID?.trim();
    if (!configuredCampaignId || !UUID_V4_REGEX.test(configuredCampaignId)) {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'CAMPAIGN_NOT_CONFIGURED');
    }

    // Query exact allowlisted campaign: must have is_test=false
    const campaignRow = (
      await client.query(
        `SELECT id, slug, region, theme, status, opens_at, closes_at, policy_version,
                series_key, round_number, counts_for_streak
         FROM juanchoice_campaigns
         WHERE id = $1 AND is_test = FALSE`,
        [configuredCampaignId]
      )
    ).rows[0];

    if (!campaignRow) {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'CAMPAIGN_NOT_FOUND');
    }

    // Fail closed if campaign has official streak / series identity or round number
    if (
      campaignRow.series_key !== null ||
      campaignRow.round_number !== null ||
      campaignRow.counts_for_streak !== false
    ) {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'OFFICIAL_SERIES_NOT_PERMITTED');
    }

    // Fail closed if associated with any monthly schedule period
    const periodCheck = await client.query(
      `SELECT 1 FROM juanchoice_schedule_periods WHERE campaign_id = $1 LIMIT 1`,
      [configuredCampaignId]
    );
    if ((periodCheck.rowCount ?? 0) > 0) {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'SCHEDULE_RELATION_NOT_PERMITTED');
    }

    // Check region match (e.g. Pangasinan vs pangasinan)
    const normalizedCampaignRegion = String(campaignRow.region).toLowerCase().trim();
    if (normalizedCampaignRegion !== regionKey.toLowerCase().trim()) {
      await client.query('COMMIT');
      return safeClosedResponse(now, regionKey, 'CAMPAIGN_REGION_MISMATCH');
    }

    const opensAt = new Date(campaignRow.opens_at);
    const closesAt = new Date(campaignRow.closes_at);
    const isOpenWindow = opensAt <= now && closesAt > now;
    const isFutureWindow = opensAt > now;
    const isPastWindow = closesAt <= now;

    const campaignStatus: string = campaignRow.status;

    let current = null;
    let next = null;
    let previous = null;
    let view: 'open' | 'between' = 'between';
    let notice: { code: string; message: string } | null = null;

    if (isOpenWindow && (campaignStatus === 'scheduled' || campaignStatus === 'voting')) {
      view = 'open';
      current = {
        id: campaignRow.id,
        slug: campaignRow.slug,
        region: campaignRow.region,
        theme: campaignRow.theme,
        status: campaignRow.status,
        opens_at: campaignRow.opens_at,
        closes_at: campaignRow.closes_at,
        policy_version: campaignRow.policy_version,
        period_start: campaignRow.opens_at,
      };
    } else if (isFutureWindow && campaignStatus === 'scheduled') {
      view = 'between';
      next = {
        opens_at: campaignRow.opens_at,
        closes_at: campaignRow.closes_at,
        theme: campaignRow.theme,
        schedule_status: 'scheduled' as const,
      };
      notice = {
        code: 'PRESENTATION_ROUND_SCHEDULED',
        message: 'The presentation demo round is scheduled to open soon.',
      };
    } else if (isPastWindow || campaignStatus === 'closed' || campaignStatus === 'finalized' || campaignStatus === 'archived') {
      view = 'between';
      // Query result snapshot if finalized
      const resultRow = (
        await client.query(
          `SELECT finalized_at, valid_ballots, co_winner_ids, standings
           FROM juanchoice_results
           WHERE campaign_id = $1`,
          [configuredCampaignId]
        )
      ).rows[0];

      if (resultRow && (campaignStatus === 'finalized' || campaignStatus === 'archived')) {
        previous = {
          campaign_id: campaignRow.id,
          period_label: new Intl.DateTimeFormat('en-PH', {
            timeZone: 'Asia/Manila',
            month: 'long',
            year: 'numeric',
          }).format(opensAt),
          opens_at: campaignRow.opens_at,
          closes_at: campaignRow.closes_at,
          finalized_at: resultRow.finalized_at,
          theme: campaignRow.theme,
          valid_ballots: resultRow.valid_ballots,
          co_winner_ids: resultRow.co_winner_ids,
          standings: resultRow.standings,
        };
      } else {
        notice = {
          code: 'RESULTS_PENDING',
          message: 'Voting has closed. Demo results are being finalized.',
        };
      }
    }

    const isVotingActive = view === 'open' && (campaignStatus === 'scheduled' || campaignStatus === 'voting');

    const votingEnabled = Boolean(
      isVotingActive &&
      env.JUANCHOICE_ENABLED &&
      env.JUANCHOICE_WRITES_ENABLED &&
      env.PROGRESSION_ENABLED
    );

    let availabilityReason: string | null = null;
    if (!isVotingActive) {
      availabilityReason = isFutureWindow
        ? 'ROUND_NOT_OPEN'
        : 'ROUND_CLOSED';
    } else if (!env.JUANCHOICE_ENABLED) {
      availabilityReason = 'FEATURE_DISABLED';
    } else if (!env.JUANCHOICE_WRITES_ENABLED) {
      availabilityReason = 'WRITES_DISABLED';
    } else if (!env.PROGRESSION_ENABLED) {
      availabilityReason = 'PROGRESSION_DISABLED';
    }

    const dto: PresentationOverviewResult = {
      server_time: now.toISOString(),
      region: {
        key: regionKey,
        label: regionKey === 'pangasinan' ? 'Pangasinan' : campaignRow.region,
        timezone: 'Asia/Manila',
      },
      view,
      availability: {
        voting_enabled: votingEnabled,
        reason: availabilityReason,
      },
      current,
      next,
      previous,
      notice,
      environment: 'presentation_demo',
    };

    await client.query('COMMIT');
    return dto;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const presentationOverviewInFlight = new Map<string, Promise<PresentationOverviewResult>>();

export function getPresentationOverview(regionKey: string): Promise<PresentationOverviewResult> {
  const key = JSON.stringify([
    regionKey,
    env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID,
    env.JUANCHOICE_ENABLED,
    env.JUANCHOICE_WRITES_ENABLED,
    env.PROGRESSION_ENABLED,
  ]);
  const existing = presentationOverviewInFlight.get(key);
  if (existing) return existing;

  const pending = queryPresentationOverview(regionKey);
  presentationOverviewInFlight.set(key, pending);
  const clear = () => {
    if (presentationOverviewInFlight.get(key) === pending) {
      presentationOverviewInFlight.delete(key);
    }
  };
  void pending.then(clear, clear);
  return pending;
}
