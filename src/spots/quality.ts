import type { Spot } from './store.js';

export interface SpotQualitySignals {
  uniqueEngagers: number;
  p95LogEngagers: number;
  upheldReportCount: number;
  photoCount?: number;
}

export interface SpotQualityResult {
  score: number;
  parts: {
    completeness: number;
    engagement: number;
    trust: number;
    reportPenalty: number;
  };
}

const TRUST_SCORES: Record<string, number> = {
  lgu_verified: 1.0,
  editorial: 0.85,
  community: 0.65,
  open_data: 0.5,
};

export function computeP95LogEngagers(counts: Iterable<number>): number {
  const logs: number[] = [];
  for (const c of counts) {
    if (c > 0) logs.push(Math.log1p(c));
  }
  if (logs.length === 0) return Math.log1p(1);
  logs.sort((a, b) => a - b);
  const idx = Math.min(logs.length - 1, Math.floor(logs.length * 0.95));
  return Math.max(Math.log1p(1), logs[idx]);
}

/**
 * Pure destination quality score in [0, 1].
 * Strictly ignores sponsor, VIP, or merchant status (R2: no pay-to-win).
 */
export function spotQuality(spot: Spot, signals: SpotQualitySignals, _nowMs = Date.now()): SpotQualityResult {
  const hasPhoto = Boolean(spot.image_url && spot.image_url.trim().length > 0) || (signals.photoCount ?? 0) > 0;
  const descLen = (spot.description || '').trim().length;
  const descScore = descLen >= 120 ? 1 : descLen >= 40 ? 0.5 : 0;
  let hasHours = false;
  if (spot.hours) {
    for (const _ in spot.hours) {
      hasHours = true;
      break;
    }
  }
  const hasCategoryAndTags = Boolean(spot.category) && Array.isArray(spot.tags) && spot.tags.length > 0;

  const completeness = ((hasPhoto ? 1 : 0) + descScore + (hasHours ? 1 : 0) + (hasCategoryAndTags ? 1 : 0)) / 4;

  const uniqueEngagers = Math.max(0, signals.uniqueEngagers || 0);
  const p95 = Math.max(Math.log1p(1), signals.p95LogEngagers || Math.log1p(1));
  const engagement = uniqueEngagers > 0 ? Math.min(1, Math.log1p(uniqueEngagers) / p95) : 0;

  const trust = TRUST_SCORES[spot.trust_level] ?? 0.2;

  const upheld = Math.max(0, signals.upheldReportCount || 0);
  const reportPenalty = Math.max(0.4, Math.pow(0.8, upheld));

  const raw = (0.35 * completeness + 0.35 * engagement + 0.3 * trust) * reportPenalty;
  const score = Math.max(0, Math.min(1, raw));

  return {
    score,
    parts: {
      completeness,
      engagement,
      trust,
      reportPenalty,
    },
  };
}

export function spotQualityScore(
  spot: Spot,
  uniqueEngagers: number,
  p95LogEngagers: number,
  upheldReportCount: number,
  photoCount = 0,
): number {
  const hasPhoto = Boolean(spot.image_url && spot.image_url.trim().length > 0) || photoCount > 0;
  const descLen = (spot.description || '').trim().length;
  const descScore = descLen >= 120 ? 1 : descLen >= 40 ? 0.5 : 0;
  let hasHours = false;
  if (spot.hours) {
    for (const _ in spot.hours) {
      hasHours = true;
      break;
    }
  }
  const hasCategoryAndTags = Boolean(spot.category) && Array.isArray(spot.tags) && spot.tags.length > 0;
  const completeness = ((hasPhoto ? 1 : 0) + descScore + (hasHours ? 1 : 0) + (hasCategoryAndTags ? 1 : 0)) / 4;
  const engagement = uniqueEngagers > 0 ? Math.min(1, Math.log1p(uniqueEngagers) / p95LogEngagers) : 0;
  const trust = TRUST_SCORES[spot.trust_level] ?? 0.2;
  const reportPenalty = upheldReportCount > 0 ? Math.max(0.4, Math.pow(0.8, upheldReportCount)) : 1;
  const raw = (0.35 * completeness + 0.35 * engagement + 0.3 * trust) * reportPenalty;
  return raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
}
