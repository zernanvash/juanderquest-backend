// Plan 116 §8.4 rule-based quality filter (cheap, metadata only) and quality score.
import type { PhotoCandidate, Via } from './types.js';

export const MIN_GALLERY_LONG_SIDE = 800;
export const MIN_HERO_LONG_SIDE = 1000;
export const MAX_ASPECT = 3;
export const MAX_PHOTOS_PER_SPOT = 5;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']);

// Whole-word hits in the file title that mark a non-photo or signage-only image.
const TITLE_REJECT: Array<[RegExp, string]> = [
  [/\b(locator|location) maps?\b|\bmaps?\b|\bkarte\b|\bmapa\b/, 'non_photo_map'],
  [/\blogos?\b|\bemblems?\b|\binsignia\b|\bicons?\b/, 'non_photo_logo'],
  [/\bseals?\b|\bofficial seal\b|\bselyo\b/, 'non_photo_seal'],
  [/\bflags?\b|\bwatawat\b/, 'non_photo_flag'],
  [/\bcoats? of arms\b|\bcoa\b|\bescudo\b/, 'non_photo_coat_of_arms'],
  [/\bdiagrams?\b|\bcharts?\b|\bfloor ?plans?\b|\bblueprints?\b|\bschematic\b|\bgraph\b/, 'non_photo_diagram'],
  [
    /\bdrawing\b|\bsketch\b|\bengraving\b|\billustration\b|\bclipart\b|\bscreenshot\b|\brender(ing)?\b/,
    'non_photo_artwork',
  ],
  [
    /\bsignage\b|\bsignboards?\b|\broad ?signs?\b|\bsigns?\b|\bhistorical markers?\b|\bmarkers?\b|\bplaques?\b/,
    'signage_only',
  ],
];

// Category names (lower-cased) that mark the same classes.
const CATEGORY_REJECT: Array<[RegExp, string]> = [
  [/\blocator maps\b|^maps (of|in|showing)\b|\bmaps of\b|openstreetmap|^location maps/, 'non_photo_map'],
  [/^logos\b|\blogos of\b|^emblems\b/, 'non_photo_logo'],
  [/^seals\b|\bseals of\b/, 'non_photo_seal'],
  [/^flags\b|\bflags of\b/, 'non_photo_flag'],
  [/coats? of arms/, 'non_photo_coat_of_arms'],
  [/^diagrams\b|\bdiagrams of\b|^charts\b|\bfloor plans\b|^architectural drawings/, 'non_photo_diagram'],
  [
    /^(signs|signage|road signs|information signs)\b|\bhistorical markers\b|\bnhcp markers\b|\bmarkers in\b/,
    'signage_only',
  ],
];

function words(s: string): string {
  return s
    .toLowerCase()
    .replace(/^file:/, '')
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/[_\-.,()]+/g, ' ');
}

export function isPanorama(c: Pick<PhotoCandidate, 'title' | 'categories'>): boolean {
  const hay = `${words(c.title)} ${c.categories.join(' ').toLowerCase()}`;
  return /\bpanoram(a|as|ic|ics)\b|\b360\b/.test(hay);
}

/** First reason this candidate fails the metadata rules, or null when it passes. */
export function metadataRejection(c: PhotoCandidate): string | null {
  if (!c.license) return c.rejected ?? 'licence_unsupported';
  if (!c.author) return 'no_author';
  if (!c.attribution_url) return 'no_file_page';
  if (c.mime === 'image/svg+xml') return 'mime_svg';
  if (!ALLOWED_MIME.has(c.mime)) return 'mime_unsupported';
  const long = Math.max(c.width, c.height);
  const short = Math.min(c.width, c.height);
  if (!long || !short) return 'size_unknown';
  if (long < MIN_GALLERY_LONG_SIDE) return 'too_small';
  if (long / short > MAX_ASPECT && !isPanorama(c)) return 'aspect_extreme';
  const t = words(c.title);
  for (const [re, reason] of TITLE_REJECT) if (re.test(t)) return reason;
  for (const cat of c.categories) {
    const lc = cat.toLowerCase().replace(/^category:/, '');
    for (const [re, reason] of CATEGORY_REJECT) if (re.test(lc)) return reason;
  }
  return null;
}

const VIA_WEIGHT: Record<Via, number> = {
  wikidata_p18: 0.25,
  osm_file_tag: 0.2,
  seed_image: 0.15,
  commons_category: 0.15,
  osm_category_tag: 0.15,
  geosearch: 0.05,
  openverse_search: 0.05,
  flickr_geo: 0.05,
};

/** Link strength, used to decide which spot owns a file that matched several. */
export function viaRank(via: Via): number {
  return VIA_WEIGHT[via];
}

export function assessmentBonus(assessments: string[]): number {
  const a = new Set(assessments.map((s) => s.toLowerCase()));
  let b = 0;
  if (a.has('featured') || a.has('poty')) b = Math.max(b, 0.3);
  if (a.has('quality')) b = Math.max(b, 0.2);
  if (a.has('valued')) b = Math.max(b, 0.15);
  if (a.has('poty')) b += 0.05;
  return Math.min(b, 0.35);
}

/**
 * Score in [0, 1]: resolution (0.3) + Commons Featured/Quality/Valued (≤0.35) + link
 * strength (≤0.25) + landscape orientation (0.05, heroes are shown wide) + hero-size (0.05).
 */
export function qualityScore(c: PhotoCandidate): number {
  const long = Math.max(c.width, c.height);
  const res = Math.min(1, Math.max(0, (long - MIN_GALLERY_LONG_SIDE) / (4000 - MIN_GALLERY_LONG_SIDE))) * 0.3;
  const land = c.width >= c.height ? 0.05 : 0;
  const hero = long >= MIN_HERO_LONG_SIDE ? 0.05 : 0;
  const s = res + assessmentBonus(c.assessments) + VIA_WEIGHT[c.via] + land + hero;
  return Math.round(Math.min(1, s) * 1000) / 1000;
}

export function heroEligible(c: Pick<PhotoCandidate, 'width' | 'height'>): boolean {
  return Math.max(c.width, c.height) >= MIN_HERO_LONG_SIDE;
}

/**
 * Applies the metadata rules (keeping an earlier rejection such as a licence or name-match
 * failure) and scores; returns a new array sorted best-first (rejected last).
 */
export function screenCandidates(cands: PhotoCandidate[]): PhotoCandidate[] {
  const out = cands.map((c) => {
    const rejected = c.rejected ?? metadataRejection(c);
    return rejected ? { ...c, rejected } : { ...c, rejected: undefined, quality_score: qualityScore(c) };
  });
  return out.sort((a, b) => {
    if (!!a.rejected !== !!b.rejected) return a.rejected ? 1 : -1;
    return (b.quality_score ?? 0) - (a.quality_score ?? 0) || a.source_id.localeCompare(b.source_id);
  });
}
