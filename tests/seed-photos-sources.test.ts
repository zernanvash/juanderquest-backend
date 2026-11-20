import { retryAfterMs } from '../scripts/seed/photos/http';
import { osmKeyToRef, seedLinks, type SeedIndex } from '../scripts/seed/photos/seed-index';
import { normaliseCategory, normaliseFileTitle, pageToCandidate } from '../scripts/seed/photos/sources/commons';
import { flickrLicence } from '../scripts/seed/photos/sources/flickr';
import { openverseLicence, openverseToCandidate } from '../scripts/seed/photos/sources/openverse';
import { LOCAL_URL_PREFIX, LocalPhotoStorage, signS3, variantKey } from '../scripts/seed/photos/storage';

describe('Commons titles', () => {
  it.each([
    ['Asik-Asik Falls, Alamada.jpg', 'File:Asik-Asik Falls, Alamada.jpg'],
    ['File:Bolinao_Lighthouse_001.JPG', 'File:Bolinao Lighthouse 001.JPG'],
    ['https://commons.wikimedia.org/wiki/File:Patar_white_beach.jpg', 'File:Patar white beach.jpg'],
    ['https://upload.wikimedia.org/wikipedia/commons/8/85/Some_Photo.jpg', 'File:Some Photo.jpg'],
    [
      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Some_Photo.jpg/1280px-Some_Photo.jpg',
      'File:Some Photo.jpg',
    ],
  ])('%s', (raw, want) => expect(normaliseFileTitle(raw)).toBe(want));
  it('rejects non-Commons URLs and categories', () => {
    expect(normaliseFileTitle('https://lh3.googleusercontent.com/abc.jpg')).toBeNull();
    expect(normaliseFileTitle('Category:Ayala Museum')).toBeNull();
    expect(normaliseCategory('Category:Ayala_Museum')).toBe('Category:Ayala Museum');
  });
});

describe('pageToCandidate', () => {
  const page = (lic: string, nonFree = false) => ({
    title: 'File:X.jpg',
    imageinfo: [
      {
        url: 'https://upload.wikimedia.org/x.jpg',
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
        width: 1000,
        height: 800,
        mime: 'image/jpeg',
        extmetadata: {
          LicenseShortName: { value: lic },
          Artist: { value: 'Ann' },
          NonFree: { value: nonFree ? 'true' : '' },
        },
      },
    ],
  });
  it('downloads the original when it is not larger than the thumbnail', () => {
    const c = pageToCandidate(page('CC BY 4.0'), 'wikidata_p18', null)!;
    expect(c.download_url).toBe('https://upload.wikimedia.org/x.jpg');
    expect(c.license).toBe('CC BY 4.0');
    expect(c.license_url).toBe('https://creativecommons.org/licenses/by/4.0/');
  });
  it('rejects NC and NonFree files', () => {
    expect(pageToCandidate(page('CC BY-NC 2.0'), 'geosearch', null)!.rejected).toBe('licence_nc');
    expect(pageToCandidate(page('CC BY 4.0', true), 'geosearch', null)!.rejected).toBe('licence_nonfree');
  });
});

describe('Flickr licences (mapped from getInfo, never hard-coded ids)', () => {
  it.each([
    [{ id: 4, name: 'Attribution License', url: 'https://creativecommons.org/licenses/by/2.0/' }, 'CC BY 2.0'],
    [
      { id: 5, name: 'Attribution-ShareAlike License', url: 'https://creativecommons.org/licenses/by-sa/2.0/' },
      'CC BY-SA 2.0',
    ],
    [{ id: 11, name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }, 'CC BY 4.0'],
    [
      { id: 9, name: 'Public Domain Dedication (CC0)', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
      'CC0',
    ],
    [{ id: 10, name: 'Public Domain Mark', url: 'https://creativecommons.org/publicdomain/mark/1.0/' }, 'PDM'],
    [
      { id: 2, name: 'Attribution-NonCommercial License', url: 'https://creativecommons.org/licenses/by-nc/2.0/' },
      null,
    ],
    [{ id: 6, name: 'Attribution-NoDerivs License', url: 'https://creativecommons.org/licenses/by-nd/2.0/' }, null],
    [{ id: 7, name: 'No known copyright restrictions', url: 'https://www.flickr.com/commons/usage/' }, null],
    [{ id: 8, name: 'United States Government Work', url: 'http://www.usa.gov/copyright.shtml' }, null],
    [{ id: 0, name: 'All Rights Reserved', url: '' }, null],
  ])('%j → %s', (info, want) => expect(flickrLicence(info)).toBe(want));
});

describe('Openverse', () => {
  it('normalises licences', () => {
    expect(openverseLicence('by-sa', '4.0')).toEqual({ ok: true, license: 'CC BY-SA 4.0' });
    expect(openverseLicence('cc0', '1.0')).toEqual({ ok: true, license: 'CC0' });
    expect(openverseLicence('pdm', '1.0')).toEqual({ ok: true, license: 'PDM' });
    expect(openverseLicence('by-nc', '2.0').ok).toBe(false);
  });
  const spot = { spot_id: 's', name: 'Hinulugang Taktak', lat: 14.6, lng: 121.2 };
  const r = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    title: 'Hinulugang Taktak falls',
    foreign_landing_url: 'https://www.flickr.com/photos/a/1',
    url: 'https://live.staticflickr.com/1.jpg',
    creator: 'Bob',
    license: 'by',
    license_version: '2.0',
    provider: 'flickr',
    width: 2000,
    height: 1500,
    tags: [{ name: 'philippines' }],
    ...over,
  });
  it('needs the name and a Philippine place word; skips Wikimedia results', () => {
    expect(openverseToCandidate(r(), spot, ['Antipolo'])!.license).toBe('CC BY 2.0');
    expect(openverseToCandidate(r({ tags: [] }), spot, ['Antipolo'])).toBeNull();
    expect(openverseToCandidate(r({ tags: [{ name: 'antipolo' }] }), spot, ['Antipolo'])).not.toBeNull();
    expect(openverseToCandidate(r({ title: 'Some falls' }), spot, [])).toBeNull();
    expect(openverseToCandidate(r({ provider: 'wikimedia' }), spot, [])).toBeNull();
  });
});

describe('seed index', () => {
  it('maps osm keys', () => {
    expect(osmKeyToRef('osm-n25767747')).toBe('node/25767747');
    expect(osmKeyToRef('osm-w12')).toBe('way/12');
    expect(osmKeyToRef('Q1')).toBeNull();
  });
  it('builds links from P18, OSM tags and nearby files', () => {
    const idx: SeedIndex = {
      byQid: new Map([['Q1', { image_file: 'A.jpg', commons_tag: 'Category:Place A', municipality: 'Bolinao' }]]),
      byOsm: new Map([
        ['node/5', { image_file: 'Near.jpg', image_dist_m: 30, image_tag: 'File:Tagged.jpg;File:A.jpg' }],
      ]),
    };
    const l = seedLinks({ spot_id: 's', name: 'Place A', lat: 0, lng: 0, wikidata: 'Q1', osm: 'node/5' }, idx);
    expect(l.files).toEqual([
      { title: 'File:A.jpg', via: 'wikidata_p18' },
      { title: 'File:Tagged.jpg', via: 'osm_file_tag' },
    ]);
    expect(l.categories).toEqual([{ category: 'Category:Place A', via: 'osm_category_tag' }]);
    expect(l.geoFiles).toEqual([{ title: 'File:Near.jpg', distance_m: 30 }]);
    expect(l.context).toEqual(['Bolinao']);
  });
});

describe('http', () => {
  it('parses Retry-After seconds and dates, with bounds', () => {
    expect(retryAfterMs('120', 5000)).toBe(120_000);
    expect(retryAfterMs(null, 5000)).toBe(5000);
    expect(retryAfterMs('0', 5000)).toBe(1000);
  });
});

describe('storage', () => {
  it('uses deterministic, safe keys under the existing static mount', () => {
    const k = variantKey('commons', 'File:X.jpg', 'w640');
    expect(k).toMatch(/^catalog\/[0-9a-f]{2}\/[0-9a-f]{20}-w640\.webp$/);
    expect(variantKey('commons', 'File:X.jpg', 'w640')).toBe(k);
    const s = new LocalPhotoStorage('/tmp/jdq-photos-test-media');
    expect(s.url(k)).toBe(`${LOCAL_URL_PREFIX}${k}`);
    expect(s.url(k).startsWith('/api/v1/uploads/spot-photos/catalog/')).toBe(true);
    expect(() => s.url('catalog/../../etc/passwd.webp')).toThrow();
  });
  it('signs S3 requests (AWS SigV4 GET Object example)', () => {
    const h = signS3({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
      region: 'us-east-1',
      extraHeaders: { Range: 'bytes=0-9' },
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});
