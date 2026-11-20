// Plan 116 §8.4 licence normaliser. Output is exactly one of the forms the DB CHECK
// `chk_spot_assets_third_party_license` (migration 111) accepts: 'CC0' | 'PD' | 'PDM' |
// 'CC BY <v>' | 'CC BY-SA <v>'. Anything else (NC, ND, GFDL-only, FAL, "Attribution",
// "No known restrictions", fair use, unknown) is rejected with a reason.

export type NormalisedLicence = 'CC0' | 'PD' | 'PDM' | `CC BY ${string}` | `CC BY-SA ${string}`;

export type LicenceResult = { ok: true; license: NormalisedLicence } | { ok: false; reason: string };

export const DB_LICENCE_RE = /^CC BY(-SA)? [0-9]\.[0-9]$/;

export function isDbAcceptedLicence(value: string): boolean {
  return value === 'CC0' || value === 'PD' || value === 'PDM' || DB_LICENCE_RE.test(value);
}

function clean(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[_‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise one licence string (Commons LicenseShortName / License, Openverse
 * license+version, Flickr licence name). Ported CC licences ("CC BY-SA 2.0 de",
 * "CC BY 3.0 IGO") normalise to their base version; keep the ported deed in license_url.
 */
export function normaliseLicence(raw: string | null | undefined): LicenceResult {
  if (!raw || !raw.trim()) return { ok: false, reason: 'licence_missing' };
  const s = clean(raw);
  const words = s.replace(/-/g, ' ');
  if (/\b(nc|noncommercial|non commercial)\b/.test(words)) return { ok: false, reason: 'licence_nc' };
  if (/\b(nd|noderivs|noderivatives|no derivatives)\b/.test(words)) return { ok: false, reason: 'licence_nd' };
  if (/fair use|non-free|nonfree|copyrighted/.test(s)) return { ok: false, reason: 'licence_nonfree' };

  if (/^(cc0|cc zero|cc-zero|cc0 1\.0|cc0-1\.0|cc0 1\.0 universal)( universal)?$/.test(s) || /^cc ?0\b/.test(words))
    return { ok: true, license: 'CC0' };
  if (/^(public domain mark|pdm|pdm 1\.0|public domain mark 1\.0|pdm-1\.0)$/.test(s))
    return { ok: true, license: 'PDM' };
  if (/^(public domain|pd|pd-[a-z0-9-]+|publicdomain)$/.test(s)) return { ok: true, license: 'PD' };

  // "cc by-sa 4.0", "cc-by-sa-4.0", "cc by 2.5 au", "cc by-sa 3.0 igo", "cc by 4.0 international"
  const m = /^cc[- ]by(?:[- ](sa))?[- ]v?(\d)(?:\.(\d))?(?:[- ](?:[a-z]{2}|igo|international|unported|generic))?$/.exec(
    s,
  );
  if (m) {
    const version = `${m[2]}.${m[3] ?? '0'}`;
    return { ok: true, license: (m[1] ? `CC BY-SA ${version}` : `CC BY ${version}`) as NormalisedLicence };
  }
  if (/gfdl|gnu free/.test(s)) return { ok: false, reason: 'licence_gfdl_only' };
  if (/^cc[- ]by/.test(s)) return { ok: false, reason: 'licence_cc_unversioned' };
  return { ok: false, reason: 'licence_unsupported' };
}

/** Canonical deed URL when the source gave none. */
export function licenceUrl(license: NormalisedLicence): string {
  if (license === 'CC0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (license === 'PDM') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  if (license === 'PD') return 'https://commons.wikimedia.org/wiki/Help:Public_domain';
  const [, kind, v] = /^CC (BY(?:-SA)?) (.+)$/.exec(license)!;
  return `https://creativecommons.org/licenses/${kind.toLowerCase()}/${v}/`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Strip HTML from a Commons `Artist` value and decode entities. */
export function stripHtml(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (all, n) => ENTITIES[n.toLowerCase()] ?? all)
    .replace(/\s+/g, ' ')
    .trim();
}

const UNKNOWN_AUTHOR = /^(unknown( author| photographer)?|anonymous|anon\.?|author unknown|not provided|n\/a|-)$/i;

/** Returns the cleaned author, or null when none is usable (unknown/anonymous/empty). */
export function cleanAuthor(raw: string | null | undefined): string | null {
  let a = stripHtml(raw)
    .replace(/^(user|usuario|utilisateur|benutzer):/i, '')
    .replace(/\s*\((talk|contribs?)\)\s*/gi, ' ')
    .trim();
  if (a.length > 200) a = `${a.slice(0, 197)}...`;
  if (!a || UNKNOWN_AUTHOR.test(a)) return null;
  return a;
}
