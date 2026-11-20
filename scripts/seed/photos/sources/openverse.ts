// Openverse API (https://api.openverse.org/v1/images/) with license_type=commercial.
// Openverse allows anonymous requests at a low rate limit; registered clients
// (OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET, owner-provided) get the "standard" tier.
// Openverse has no geo search, so a hit needs the distinctive name AND a Philippine place word.
// Results from Wikimedia are skipped (the Commons API path covers them with richer metadata).
import { getJson } from '../http.js';
import { cleanAuthor, licenceUrl, normaliseLicence } from '../licence.js';
import { fold, nameMatches } from '../names.js';
import type { PhotoCandidate, SpotRef } from '../types.js';

const API = 'https://api.openverse.org/v1';

export interface OpenverseResult {
  id: string;
  title?: string | null;
  foreign_landing_url?: string | null;
  url?: string | null;
  creator?: string | null;
  license?: string | null;
  license_version?: string | null;
  license_url?: string | null;
  provider?: string | null;
  source?: string | null;
  filetype?: string | null;
  width?: number | null;
  height?: number | null;
  tags?: Array<{ name: string }> | null;
  mature?: boolean | null;
}

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** "by-sa" + "4.0" → normalise('cc by-sa 4.0'); "cc0" / "pdm" pass through. */
export function openverseLicence(license: string | null | undefined, version: string | null | undefined) {
  const l = (license ?? '').toLowerCase();
  if (l === 'cc0') return normaliseLicence('CC0');
  if (l === 'pdm') return normaliseLicence('PDM');
  return normaliseLicence(`cc ${l} ${version ?? ''}`.trim());
}

export function openverseToCandidate(r: OpenverseResult, spot: SpotRef, context: string[]): PhotoCandidate | null {
  if ((r.provider ?? '').toLowerCase() === 'wikimedia' || (r.source ?? '').toLowerCase() === 'wikimedia') return null;
  if (r.mature) return null;
  const hay = `${r.title ?? ''} ${(r.tags ?? []).map((t) => t.name).join(' ')}`;
  if (!nameMatches(spot.name, hay, context)) return null;
  const words = new Set(fold(hay).split(' '));
  const placeWords = [
    'philippines',
    'pilipinas',
    ...context.flatMap((c) =>
      fold(c)
        .split(' ')
        .filter((w) => w.length >= 4),
    ),
  ];
  if (!placeWords.some((w) => words.has(w))) return null;
  if (!r.url || !r.foreign_landing_url) return null;
  const lic = openverseLicence(r.license, r.license_version);
  const c: PhotoCandidate = {
    source: 'openverse',
    source_id: r.id,
    via: 'openverse_search',
    title: r.title ?? '',
    description: '',
    categories: (r.tags ?? []).map((t) => t.name),
    assessments: [],
    mime: MIME[(r.filetype ?? '').toLowerCase()] ?? 'image/jpeg',
    width: r.width ?? 0,
    height: r.height ?? 0,
    download_url: r.url,
    download_width: r.width ?? 0,
    download_height: r.height ?? 0,
    license_raw: `${r.license ?? ''} ${r.license_version ?? ''}`.trim(),
    license: lic.ok ? lic.license : null,
    license_url: lic.ok ? r.license_url || licenceUrl(lic.license) : null,
    author: cleanAuthor(r.creator),
    attribution_url: r.foreign_landing_url,
    distance_m: null,
  };
  if (!lic.ok) c.rejected = lic.reason;
  return c;
}

export async function openverseToken(): Promise<string | null> {
  const id = process.env.OPENVERSE_CLIENT_ID;
  const secret = process.env.OPENVERSE_CLIENT_SECRET;
  if (!id || !secret) return null;
  const res = await fetch(`${API}/auth_tokens/token/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'JuanderQuestSeed/1.0 (+https://juanderquest.app)',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`Openverse token HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function openverseSearch(
  spot: SpotRef,
  context: string[],
  cacheDir: string,
  token: string | null,
): Promise<PhotoCandidate[]> {
  const params = new URLSearchParams({
    q: `${spot.name} ${context[0] ?? 'Philippines'}`,
    license_type: 'commercial',
    page_size: '20',
    mature: 'false',
  });
  const body = await getJson<{ results?: OpenverseResult[] }>(`${API}/images/?${params}`, {
    cacheDir,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return (body.results ?? [])
    .map((r) => openverseToCandidate(r, spot, context))
    .filter((c): c is PhotoCandidate => !!c);
}
