// Plan 116 destinations: confidence (Plan 46 §5.6), launch tier (Plan 116 §8.2) and featured score.

export type Tier = 'featured' | 'standard' | 'review';

export interface ScoreInput {
  hasWikidata: boolean; // a Wikidata item that survived the 2 km coordinate check
  hasCommonsPhoto: boolean; // a usable Commons image reference (allowed or not-yet-known licence, not a map/logo)
  hasWikipedia: boolean; // an English Wikipedia article
  strongTag: boolean; // tourism=attraction / natural=* / historic=* (or a Wikidata nature/heritage class)
  hasHoursOrWebsite: boolean;
  genericName: boolean;
}

export function confidence(input: ScoreInput): { value: number; reasons: string[] } {
  let v = 0;
  const reasons: string[] = [];
  const add = (cond: boolean, delta: number, label: string) => {
    if (!cond) return;
    v += delta;
    reasons.push(`${delta > 0 ? '+' : ''}${delta} ${label}`);
  };
  add(input.hasWikidata, 0.4, 'wikidata');
  add(input.hasCommonsPhoto, 0.2, 'commons_photo');
  add(input.hasWikipedia, 0.15, 'wikipedia');
  add(input.strongTag, 0.1, 'strong_tag');
  add(input.hasHoursOrWebsite, 0.1, 'hours_or_website');
  add(input.genericName, -0.3, 'generic_name');
  return { value: Math.round(Math.min(1, Math.max(0, v)) * 100) / 100, reasons };
}

export interface TierInput {
  confidence: number;
  photoLongSide: number | null; // best photo candidate's long side in px, null = unknown
  photoLicenceOk: boolean | null; // null = licence not known yet
  hasPhoto: boolean;
  descriptionSource: 'wikipedia' | 'wikidata' | null;
  forceReview: string[]; // reasons that always send a place to review
}

export function computeTier(input: TierInput): { tier: Tier; reasons: string[] } {
  if (input.forceReview.length) return { tier: 'review', reasons: input.forceReview };
  if (input.confidence < 0.6) return { tier: 'review', reasons: ['confidence<0.6'] };
  const missing: string[] = [];
  if (input.confidence < 0.8) missing.push('confidence<0.8');
  if (!input.hasPhoto) missing.push('no_photo');
  if (input.photoLicenceOk === false) missing.push('photo_licence');
  if (input.photoLongSide !== null && input.photoLongSide < 1000) missing.push('photo<1000px');
  if (!input.descriptionSource) missing.push('no_description');
  return missing.length ? { tier: 'standard', reasons: missing } : { tier: 'featured', reasons: [] };
}

/**
 * Featured ranking inside a province (quota 40): confidence + photo quality (≤ 0.2) + Wikipedia (0.1)
 * + heritage designation (0.1) + Wikidata sitelinks as a pageview proxy (≤ 0.1).
 */
export function launchScore(input: {
  confidence: number;
  photoLongSide: number | null;
  hasWikipedia: boolean;
  heritage: boolean;
  sitelinks: number;
}): number {
  const photo = input.photoLongSide ? (Math.min(input.photoLongSide, 4000) / 4000) * 0.2 : 0;
  const s =
    input.confidence +
    photo +
    (input.hasWikipedia ? 0.1 : 0) +
    (input.heritage ? 0.1 : 0) +
    (Math.min(Math.max(input.sitelinks, 0), 20) / 20) * 0.1;
  return Math.round(s * 1000) / 1000;
}

export function confidenceBucket(v: number): string {
  const lo = Math.min(0.9, Math.floor(v * 10 + 1e-9) / 10);
  return `${lo.toFixed(1)}-${(lo + 0.1).toFixed(1)}`;
}
