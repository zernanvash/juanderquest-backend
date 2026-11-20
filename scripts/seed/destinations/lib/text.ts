// Plan 116 destinations: name normalisation, pg_trgm-compatible similarity, slugs, generic names.

const ABBREVIATIONS: Record<string, string> = { mt: 'mount', sto: 'santo', sta: 'santa', ft: 'fort' };

/** Lower-case, accent-free, punctuation-free name with a few PH abbreviations expanded. */
export function normaliseName(name: string): string {
  const base = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return base
    .split(' ')
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(' ');
}

/** Trigram set the way pg_trgm builds it: each alphanumeric word padded as "  word ". */
export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  const words = String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (const w of words) {
    const padded = `  ${w} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm `similarity()` on two strings (after the caller's normalisation). */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function nameSimilarity(a: string, b: string): number {
  return trigramSimilarity(normaliseName(a), normaliseName(b));
}

/** URL slug: ASCII, lower-case, dash separated, at most 80 characters, no trailing dash. */
export function slugify(text: string): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

// Words that do not identify a place on their own ("Beach", "Church", "Park", "View Deck" ...).
const GENERIC_WORDS = new Set(
  (
    'a an the of and at in on sa ng de del la las los el ' +
    'beach beaches church chapel cathedral parish shrine mosque temple park plaza garden gardens ' +
    'falls fall waterfall waterfalls cave caves spring springs hot cold river lake island islet islands ' +
    'view viewpoint viewdeck deck lookout overlook point peak hill hills mount mountain mountains volcano ' +
    'monument marker memorial historical historic museum resort resorts beach resort pool pools ' +
    'tourist spot attraction site area eco park nature reserve forest trail summit top camp ' +
    'old new big small white sand national provincial municipal city town barangay public ' +
    'unnamed unknown noname'
  ).split(/\s+/),
);

/** True when every word of the name is generic (Plan 46 §5.6: −0.3). */
export function isGenericName(name: string): boolean {
  const words = normaliseName(name).split(' ').filter(Boolean);
  if (!words.length) return true;
  if (words.every((w) => /^\d+$/.test(w))) return true;
  return words.every((w) => GENERIC_WORDS.has(w) || /^\d+$/.test(w) || w.length <= 1);
}

/** Distinctive words (≥ 4 letters, not generic), used to match photo titles to a place. */
export function distinctiveWords(name: string): string[] {
  return normaliseName(name)
    .split(' ')
    .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
}

/** First `n` sentences of a plain-text extract (keeps abbreviations like "St." reasonably intact). */
export function firstSentences(text: string, n = 2): string {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const parts = clean.match(/[^.!?]+(?:[.!?]+(?=\s+[A-Z0-9"“(]|$)|$)/g) ?? [clean];
  const out: string[] = [];
  let buf = '';
  for (const p of parts) {
    buf += p;
    // Do not cut after single-letter initials or common abbreviations.
    if (/\b(?:St|Sto|Sta|Mt|Dr|Fr|Sr|Jr|No|Brgy|Gen|Sen|Pres|[A-Z])\.$/.test(buf.trim())) continue;
    out.push(buf.trim());
    buf = '';
    if (out.length >= n) break;
  }
  if (buf.trim() && out.length < n) out.push(buf.trim());
  return out.join(' ').trim();
}
