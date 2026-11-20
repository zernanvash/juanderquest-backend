// Wikimedia Commons + Wikidata via the MediaWiki Action API (identified User-Agent, 1 req/s,
// cached). Licence/author come from imageinfo `extmetadata`.
import { getJson } from '../http.js';
import { cleanAuthor, licenceUrl, normaliseLicence, stripHtml } from '../licence.js';
import type { PhotoCandidate, Via } from '../types.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
export const DOWNLOAD_WIDTH = 1280;

const EXTMETA = [
  'LicenseShortName',
  'License',
  'LicenseUrl',
  'Artist',
  'Credit',
  'UsageTerms',
  'AttributionRequired',
  'Categories',
  'Assessments',
  'ImageDescription',
  'NonFree',
  'Restrictions',
  'GPSLatitude',
  'GPSLongitude',
].join('|');

const IMAGEINFO_PARAMS = {
  prop: 'imageinfo|coordinates',
  iiprop: 'url|size|mime|extmetadata',
  iiurlwidth: String(DOWNLOAD_WIDTH),
  iiextmetadatafilter: EXTMETA,
  iiextmetadatalanguage: 'en',
  coprop: 'type',
  colimit: 'max',
  format: 'json',
  formatversion: '2',
  redirects: '1',
};

type ExtMeta = Record<string, { value?: unknown } | undefined>;

export interface CommonsPage {
  title: string;
  missing?: boolean;
  invalid?: boolean;
  coordinates?: Array<{ lat: number; lon: number }>;
  imageinfo?: Array<{
    url: string;
    descriptionurl: string;
    width: number;
    height: number;
    mime: string;
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    extmetadata?: ExtMeta;
  }>;
}

function meta(m: ExtMeta | undefined, k: string): string {
  const v = m?.[k]?.value;
  return v == null ? '' : String(v);
}

export function normaliseFileTitle(raw: string): string | null {
  let t = raw.trim();
  if (!t) return null;
  try {
    if (/^https?:\/\//i.test(t)) {
      const u = new URL(t);
      if (/(^|\.)wikimedia\.org$/.test(u.host) || /(^|\.)wikipedia\.org$/.test(u.host)) {
        const m = /\/wiki\/((?:File|Image):.+)$/i.exec(decodeURIComponent(u.pathname));
        if (m) t = m[1];
        else {
          // upload.wikimedia.org/wikipedia/commons/a/ab/Name.jpg (or …/thumb/a/ab/Name.jpg/1280px-Name.jpg)
          const p = decodeURIComponent(u.pathname).split('/');
          const i = p.indexOf('commons');
          if (u.host !== 'upload.wikimedia.org' || i < 0) return null;
          const rest = p.slice(i + 1);
          const name = rest[0] === 'thumb' ? rest[3] : rest[2];
          if (!name) return null;
          t = `File:${name}`;
        }
      } else return null;
    }
  } catch {
    return null;
  }
  t = t.replace(/^(image|file):/i, '');
  if (/^category:/i.test(t)) return null;
  t = t.replace(/_/g, ' ').trim();
  if (!t || !/\.[a-z0-9]{2,5}$/i.test(t)) return null;
  return `File:${t.charAt(0).toUpperCase()}${t.slice(1)}`;
}

export function normaliseCategory(raw: string): string | null {
  const t = raw.trim().replace(/_/g, ' ');
  const m = /^category:(.+)$/i.exec(t);
  const name = (m ? m[1] : t).trim();
  if (!name || /\.[a-z]{3,4}$/i.test(name)) return null;
  return `Category:${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** Turns one imageinfo page into a candidate (licence normalised, not yet screened). */
export function pageToCandidate(page: CommonsPage, via: Via, distanceM: number | null): PhotoCandidate | null {
  const ii = page.imageinfo?.[0];
  if (!ii) return null;
  const m = ii.extmetadata;
  const shortName = meta(m, 'LicenseShortName');
  let lic = normaliseLicence(shortName);
  if (!lic.ok) {
    const alt = normaliseLicence(meta(m, 'License'));
    if (alt.ok) lic = alt;
  }
  const nonFree = /^true$/i.test(meta(m, 'NonFree'));
  const author = cleanAuthor(meta(m, 'Artist')) ?? cleanAuthor(meta(m, 'Credit'));
  const useThumb = !!ii.thumburl && !!ii.thumbwidth && ii.thumbwidth < ii.width;
  const c: PhotoCandidate = {
    source: 'commons',
    source_id: page.title,
    via,
    title: page.title,
    description: stripHtml(meta(m, 'ImageDescription')).slice(0, 500),
    categories: meta(m, 'Categories').split('|').filter(Boolean),
    assessments: meta(m, 'Assessments').split('|').filter(Boolean),
    mime: ii.mime,
    width: ii.width,
    height: ii.height,
    download_url: useThumb ? ii.thumburl! : ii.url,
    download_width: useThumb ? ii.thumbwidth! : ii.width,
    download_height: useThumb ? ii.thumbheight! : ii.height,
    license_raw: shortName,
    license: lic.ok && !nonFree ? lic.license : null,
    license_url: null,
    author,
    attribution_url: ii.descriptionurl,
    distance_m: distanceM,
  };
  if (c.license) c.license_url = meta(m, 'LicenseUrl') || licenceUrl(c.license);
  if (!lic.ok) c.rejected = lic.reason;
  else if (nonFree) c.rejected = 'licence_nonfree';
  return c;
}

function qs(params: Record<string, string>): string {
  return new URLSearchParams({ action: 'query', ...params }).toString();
}

export interface CommonsClient {
  imageInfo(titles: string[]): Promise<Map<string, CommonsPage>>;
  categoryFiles(category: string, limit?: number): Promise<CommonsPage[]>;
  geosearch(lat: number, lng: number, radiusM: number, limit?: number): Promise<CommonsPage[]>;
}

export function commonsClient(cacheDir: string): CommonsClient {
  return {
    async imageInfo(titles) {
      const out = new Map<string, CommonsPage>();
      for (let i = 0; i < titles.length; i += 50) {
        const batch = titles.slice(i, i + 50);
        const body = await getJson<{
          query?: {
            pages?: CommonsPage[];
            normalized?: Array<{ from: string; to: string }>;
            redirects?: Array<{ from: string; to: string }>;
          };
        }>(`${COMMONS_API}?${qs({ ...IMAGEINFO_PARAMS, titles: batch.join('|') })}`, { cacheDir });
        const alias = new Map<string, string>();
        for (const n of [...(body.query?.normalized ?? []), ...(body.query?.redirects ?? [])]) alias.set(n.from, n.to);
        const byTitle = new Map((body.query?.pages ?? []).map((p) => [p.title, p]));
        for (const t of batch) {
          let k = t;
          for (let hops = 0; hops < 3 && alias.has(k); hops++) k = alias.get(k)!;
          const p = byTitle.get(k);
          if (p) out.set(t, p);
        }
      }
      return out;
    },
    async categoryFiles(category, limit = 50) {
      const body = await getJson<{ query?: { pages?: CommonsPage[] } }>(
        `${COMMONS_API}?${qs({ ...IMAGEINFO_PARAMS, generator: 'categorymembers', gcmtitle: category, gcmtype: 'file', gcmlimit: String(limit) })}`,
        { cacheDir },
      );
      return body.query?.pages ?? [];
    },
    async geosearch(lat, lng, radiusM, limit = 50) {
      const body = await getJson<{ query?: { pages?: CommonsPage[] } }>(
        `${COMMONS_API}?${qs({
          ...IMAGEINFO_PARAMS,
          generator: 'geosearch',
          ggscoord: `${lat.toFixed(6)}|${lng.toFixed(6)}`,
          ggsradius: String(radiusM),
          ggsnamespace: '6',
          ggslimit: String(limit),
        })}`,
        { cacheDir },
      );
      return body.query?.pages ?? [];
    },
  };
}

export interface WikidataPhotoClaims {
  p18: string[];
  p373: string | null;
}

/** P18 (image) values and P373 (Commons category) for up to 50 QIDs per request. */
export async function wikidataPhotoClaims(qids: string[], cacheDir: string): Promise<Map<string, WikidataPhotoClaims>> {
  const out = new Map<string, WikidataPhotoClaims>();
  type Snak = { mainsnak?: { datavalue?: { value?: unknown } }; rank?: string };
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const body = await getJson<{ entities?: Record<string, { claims?: Record<string, Snak[]> }> }>(
      `${WIKIDATA_API}?${new URLSearchParams({ action: 'wbgetentities', ids: batch.join('|'), props: 'claims', format: 'json' })}`,
      { cacheDir },
    );
    for (const [qid, e] of Object.entries(body.entities ?? {})) {
      const vals = (p: string) =>
        (e.claims?.[p] ?? [])
          .filter((s) => s.rank !== 'deprecated')
          .map((s) => s.mainsnak?.datavalue?.value)
          .filter((v): v is string => typeof v === 'string');
      out.set(qid, { p18: vals('P18'), p373: vals('P373')[0] ?? null });
    }
  }
  return out;
}
