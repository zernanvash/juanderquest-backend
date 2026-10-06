export type CrowdCapacityBand = 'low' | 'medium' | 'high';
export type CrowdStatus = 'quiet' | 'moderate' | 'estimated_busy' | 'unknown';
export type CrowdConfidence = 'none' | 'low' | 'medium' | 'high';
export type ActivityType = 'view' | 'directions' | 'save' | 'visit';

export interface ActivityEventInput {
  id?: string;
  user_id: string;
  spot_id: string;
  activity_type: ActivityType;
  created_at: string | Date;
  is_test?: boolean;
}

export interface CrowdMetrics {
  crowd_status: CrowdStatus;
  crowd_confidence: CrowdConfidence;
  crowd_updated_at: string | null;
  pressure_score: number;
}

const ACTIVITY_WEIGHTS: Record<ActivityType, number> = {
  view: 0.25,
  directions: 3,
  save: 2,
  visit: 5,
};

const CAPACITY_THRESHOLDS: Record<CrowdCapacityBand, [number, number]> = {
  low: [3, 8],
  medium: [6, 15],
  high: [12, 30],
};

const HALF_LIFE_MS = 6 * 3_600_000; // 6 hours
const WINDOW_24H_MS = 24 * 3_600_000;

function parseTimestampMs(value: string | Date): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Pure crowd pressure calculation based on 24-hr activity rows and 6-hr half-life decay.
 * Canonically shared between SpotStore in-memory model and promotion safety checks.
 * Scope-explicit: defaults to real scope (isTest = false) to preserve SpotStore behavior.
 */
export function calculateCrowdMetrics(
  events: ActivityEventInput[],
  capacityBand: CrowdCapacityBand = 'medium',
  now: number | Date = Date.now(),
  isTest = false
): CrowdMetrics {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(nowMs)) {
    return {
      crowd_status: 'unknown',
      crowd_confidence: 'none',
      crowd_updated_at: null,
      pressure_score: 0,
    };
  }

  const targetScope = Boolean(isTest);

  // Only evaluate events matching the exact target scope within trailing 24 hours up to `nowMs`
  const relevantEvents = events.flatMap((e) => {
    if (Boolean(e.is_test) !== targetScope) return [];
    const eventTime = parseTimestampMs(e.created_at);
    if (eventTime === null || eventTime > nowMs || nowMs - eventTime > WINDOW_24H_MS) {
      return [];
    }
    return [{ event: e, eventTime }];
  });

  if (!relevantEvents.length) {
    return {
      crowd_status: 'unknown',
      crowd_confidence: 'none',
      crowd_updated_at: null,
      pressure_score: 0,
    };
  }

  const score = relevantEvents.reduce((sum, item) => {
    const ageMs = nowMs - item.eventTime;
    const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
    return sum + (ACTIVITY_WEIGHTS[item.event.activity_type] || 0) * decay;
  }, 0);

  const [moderate, busy] = CAPACITY_THRESHOLDS[capacityBand] || CAPACITY_THRESHOLDS.medium;
  const uniqueUsers = new Set(relevantEvents.map((item) => item.event.user_id)).size;
  const roundedScore = Number(score.toFixed(2));

  const status: CrowdStatus =
    roundedScore >= busy ? 'estimated_busy' : roundedScore >= moderate ? 'moderate' : 'quiet';

  const confidence: CrowdConfidence =
    uniqueUsers >= 8 ? 'high' : uniqueUsers >= 3 ? 'medium' : 'low';

  const maxTimestamp = Math.max(...relevantEvents.map((item) => item.eventTime));

  return {
    crowd_status: status,
    crowd_confidence: confidence,
    crowd_updated_at: new Date(maxTimestamp).toISOString(),
    pressure_score: roundedScore,
  };
}
