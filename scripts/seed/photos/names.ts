// Distinctive-name matching for geo-searched photos (Plan 116 §8.4: a Commons geosearch hit
// is only a candidate when its title/description/categories contain the place's distinctive name).

export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ñ/g, 'n')
    .replace(/[_]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Generic place words (English, Filipino, Spanish) that never identify a place by themselves.
const GENERIC = new Set(
  (
    'the of and in at de del la las los ng sa san santa santo sto sta st saint our lady ' +
    'falls fall waterfall waterfalls beach beaches resort island islands isla islet cove bay port point ' +
    'church parish cathedral basilica minor shrine chapel diocesan national archdiocesan ' +
    'mount mt mountain mountains hill hills peak peaks volcano range ridge ' +
    'park garden gardens plaza square monument memorial museum heritage house hall building tower lighthouse ' +
    'river lake lagoon spring springs hot cave caves rock rocks reef sanctuary marine protected area reserve ' +
    'natural landscape seascape nature eco ecopark view viewpoint deck spot site rice terraces terrace ' +
    'bridge dam fort fortress ruins old new city town municipal municipality provincial province capitol ' +
    'barangay poblacion philippines philippine pilipinas ilog bundok bulkan talon dagat simbahan ' +
    'tourism tourist center centre trail road street avenue boulevard baywalk ' +
    'photo photos picture image test upload sample'
  ).split(/\s+/),
);

/**
 * Tokens of a place name that can identify it (≥ 3 chars, not generic, not a number). Words of
 * `exclude` (the spot's town/province) are dropped too: "Dagupan Viewpoint" must not match every
 * photo taken in Dagupan.
 */
export function distinctiveTokens(name: string, exclude: string[] = []): string[] {
  const ex = new Set(exclude.flatMap((e) => fold(e).split(' ')));
  const out: string[] = [];
  for (const t of fold(name).split(' ')) {
    if (t.length < 3 || GENERIC.has(t) || ex.has(t) || /^\d+$/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * True when every distinctive token of `name` appears as a whole word in the haystack.
 * A name with no distinctive token ("White Beach") never matches: geosearch is too loose for it.
 */
export function nameMatches(name: string, haystack: string, exclude: string[] = []): boolean {
  const tokens = distinctiveTokens(name, exclude);
  if (tokens.length === 0) return false;
  const words = new Set(fold(haystack).split(' '));
  return tokens.every((t) => words.has(t));
}
