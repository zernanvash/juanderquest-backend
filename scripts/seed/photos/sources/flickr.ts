// Flickr API, only when FLICKR_API_KEY is set (owner-provided). Licence ids are read from
// flickr.photos.licenses.getInfo at run time and mapped by their deed URL; only CC BY,
// CC BY-SA, CC0 and the Public Domain Mark are used. Search: has_geo, radius ≤ 1 km, name match.
import { getJson } from '../http.js';
import { cleanAuthor, normaliseLicence, type NormalisedLicence } from '../licence.js';
import { nameMatches } from '../names.js';
import { haversineM } from '../select.js';
import type { PhotoCandidate, SpotRef } from '../types.js';

const API = 'https://api.flickr.com/services/rest/';

export interface FlickrLicenceInfo {
  id: number | string;
  name: string;
  url: string;
}

/** Maps a Flickr licence (by its deed URL, falling back to its name) to an allowed licence or null. */
export function flickrLicence(info: FlickrLicenceInfo): NormalisedLicence | null {
  const url = (info.url ?? '').toLowerCase();
  let m = /creativecommons\.org\/licenses\/(by|by-sa)\/(\d\.\d)\/?/.exec(url);
  if (m) return m[1] === 'by-sa' ? (`CC BY-SA ${m[2]}` as NormalisedLicence) : (`CC BY ${m[2]}` as NormalisedLicence);
  if (/creativecommons\.org\/publicdomain\/zero\//.test(url)) return 'CC0';
  if (/creativecommons\.org\/publicdomain\/mark\//.test(url)) return 'PDM';
  if (url) return null; // NC / ND / other deeds
  m = /^(public domain mark|public domain dedication \(cc0\))$/i.exec(info.name.trim());
  if (m) return /cc0/i.test(info.name) ? 'CC0' : 'PDM';
  const n = normaliseLicence(info.name);
  return n.ok && n.license !== 'PD' ? n.license : null; // "No known copyright restrictions", "US Gov work" → no
}

type FlickrPhoto = {
  id: string;
  owner: string;
  title: string;
  license: string;
  ownername?: string;
  tags?: string;
  description?: { _content?: string };
  latitude?: number | string;
  longitude?: number | string;
  o_width?: string | number;
  o_height?: string | number;
  url_h?: string;
  width_h?: number | string;
  height_h?: number | string;
  url_b?: string;
  width_b?: number | string;
  height_b?: number | string;
  url_o?: string;
  width_o?: number | string;
  height_o?: number | string;
  originalformat?: string;
};

export function flickrToCandidate(
  p: FlickrPhoto,
  spot: SpotRef,
  licences: Map<string, { license: NormalisedLicence; url: string }>,
): PhotoCandidate | null {
  const lic = licences.get(String(p.license));
  if (!lic) return null;
  if (!nameMatches(spot.name, `${p.title} ${p.tags ?? ''} ${p.description?._content ?? ''}`)) return null;
  const pick = p.url_h ? 'h' : p.url_b ? 'b' : null;
  if (!pick) return null;
  const dl = pick === 'h' ? [p.url_h!, p.width_h, p.height_h] : [p.url_b!, p.width_b, p.height_b];
  const w = Number(p.o_width ?? p.width_o ?? dl[1] ?? 0);
  const h = Number(p.o_height ?? p.height_o ?? dl[2] ?? 0);
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  return {
    source: 'flickr',
    source_id: p.id,
    via: 'flickr_geo',
    title: p.title,
    description: (p.description?._content ?? '').slice(0, 500),
    categories: (p.tags ?? '').split(' ').filter(Boolean),
    assessments: [],
    mime: 'image/jpeg',
    width: w,
    height: h,
    download_url: String(dl[0]),
    download_width: Number(dl[1] ?? 0),
    download_height: Number(dl[2] ?? 0),
    license_raw: String(p.license),
    license: lic.license,
    license_url: lic.url,
    author: cleanAuthor(p.ownername),
    attribution_url: `https://www.flickr.com/photos/${p.owner}/${p.id}`,
    distance_m:
      Number.isFinite(lat) && Number.isFinite(lng) ? Math.round(haversineM(spot.lat, spot.lng, lat, lng)) : null,
  };
}

export function flickrEnabled(): boolean {
  return !!process.env.FLICKR_API_KEY;
}

function apiUrl(method: string, params: Record<string, string>): { url: string; cacheKey: string } {
  const q = new URLSearchParams({ method, format: 'json', nojsoncallback: '1', ...params });
  const cacheKey = `${API}?${q}`;
  q.set('api_key', process.env.FLICKR_API_KEY ?? '');
  return { url: `${API}?${q}`, cacheKey };
}

export async function flickrLicences(
  cacheDir: string,
): Promise<Map<string, { license: NormalisedLicence; url: string }>> {
  const { url, cacheKey } = apiUrl('flickr.photos.licenses.getInfo', {});
  const body = await getJson<{ licenses?: { license?: FlickrLicenceInfo[] } }>(url, {
    cacheDir,
    cacheKey,
    maxAgeMs: 24 * 3600 * 1000,
  });
  const out = new Map<string, { license: NormalisedLicence; url: string }>();
  for (const l of body.licenses?.license ?? []) {
    const n = flickrLicence(l);
    if (n) out.set(String(l.id), { license: n, url: l.url });
  }
  return out;
}

export async function flickrSearch(
  spot: SpotRef,
  cacheDir: string,
  licences: Map<string, { license: NormalisedLicence; url: string }>,
): Promise<PhotoCandidate[]> {
  if (licences.size === 0) return [];
  const { url, cacheKey } = apiUrl('flickr.photos.search', {
    lat: spot.lat.toFixed(6),
    lon: spot.lng.toFixed(6),
    radius: '1',
    radius_units: 'km',
    has_geo: '1',
    license: [...licences.keys()].join(','),
    content_type: '1',
    safe_search: '1',
    per_page: '50',
    extras: 'license,owner_name,tags,description,geo,o_dims,url_h,url_b,original_format',
  });
  const body = await getJson<{ stat: string; photos?: { photo?: FlickrPhoto[] } }>(url, { cacheDir, cacheKey });
  return (body.photos?.photo ?? [])
    .map((p) => flickrToCandidate(p, spot, licences))
    .filter((c): c is PhotoCandidate => !!c);
}
