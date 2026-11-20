import { buildCommonsCandidates, geoNameMatches } from '../scripts/seed/photos/candidates';
import { distinctiveTokens, nameMatches } from '../scripts/seed/photos/names';
import { metadataRejection, qualityScore, screenCandidates } from '../scripts/seed/photos/quality';
import type { CommonsPage } from '../scripts/seed/photos/sources/commons';
import type { PhotoCandidate } from '../scripts/seed/photos/types';

function cand(over: Partial<PhotoCandidate> = {}): PhotoCandidate {
  return {
    source: 'commons',
    source_id: 'File:Hundred Islands 01.jpg',
    via: 'geosearch',
    title: 'File:Hundred Islands 01.jpg',
    description: '',
    categories: [],
    assessments: [],
    mime: 'image/jpeg',
    width: 4000,
    height: 3000,
    download_url: 'https://upload.wikimedia.org/x.jpg',
    download_width: 1280,
    download_height: 960,
    license_raw: 'CC BY-SA 4.0',
    license: 'CC BY-SA 4.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/4.0',
    author: 'Someone',
    attribution_url: 'https://commons.wikimedia.org/wiki/File:Hundred_Islands_01.jpg',
    distance_m: 100,
    ...over,
  };
}

describe('metadataRejection', () => {
  it('passes a normal photo', () => expect(metadataRejection(cand())).toBeNull());
  it.each([
    [{ license: null, rejected: 'licence_nc' }, 'licence_nc'],
    [{ author: null }, 'no_author'],
    [{ mime: 'image/svg+xml' }, 'mime_svg'],
    [{ mime: 'image/gif' }, 'mime_unsupported'],
    [{ width: 700, height: 500 }, 'too_small'],
    [{ width: 4000, height: 1000 }, 'aspect_extreme'],
    [{ title: 'File:Pangasinan Locator map.png' }, 'non_photo_map'],
    [{ title: 'File:Seal of Alaminos.jpg' }, 'non_photo_seal'],
    [{ title: 'File:Flag of Pangasinan.jpg' }, 'non_photo_flag'],
    [{ title: 'File:Alaminos City logo.png' }, 'non_photo_logo'],
    [{ title: 'File:Coat of arms of Bolinao.jpg' }, 'non_photo_coat_of_arms'],
    [{ title: 'File:Church floor plan.jpg' }, 'non_photo_diagram'],
    [{ title: 'File:Hundred Islands historical marker.jpg' }, 'signage_only'],
    [{ categories: ['Historical markers in Pangasinan'] }, 'signage_only'],
    [{ categories: ['Maps of Pangasinan'] }, 'non_photo_map'],
  ])('rejects %j as %s', (over, reason) => {
    expect(metadataRejection(cand(over as Partial<PhotoCandidate>))).toBe(reason);
  });
  it('allows wide images when panorama-tagged, but not "panoramio" uploads', () => {
    expect(metadataRejection(cand({ width: 4000, height: 1000, title: 'File:Bay panorama.jpg' }))).toBeNull();
    expect(metadataRejection(cand({ width: 4000, height: 1000, title: 'File:Bay - panoramio.jpg' }))).toBe(
      'aspect_extreme',
    );
  });
  it('accepts 800 px gallery images', () => expect(metadataRejection(cand({ width: 800, height: 600 }))).toBeNull());
});

describe('qualityScore', () => {
  it('prefers Featured/Quality images, higher resolution and stronger links', () => {
    const base = qualityScore(cand());
    expect(qualityScore(cand({ assessments: ['quality'] }))).toBeGreaterThan(base);
    expect(qualityScore(cand({ via: 'wikidata_p18' }))).toBeGreaterThan(base);
    expect(qualityScore(cand({ width: 1200, height: 900 }))).toBeLessThan(base);
    expect(
      qualityScore(cand({ assessments: ['featured', 'quality'], via: 'wikidata_p18', width: 8000 })),
    ).toBeLessThanOrEqual(1);
  });
  it('sorts accepted first, best first', () => {
    const out = screenCandidates([
      cand({ source_id: 'a', author: null }),
      cand({ source_id: 'b' }),
      cand({ source_id: 'c', assessments: ['featured'] }),
    ]);
    expect(out.map((c) => c.source_id)).toEqual(['c', 'b', 'a']);
    expect(out[2].rejected).toBe('no_author');
  });
});

describe('distinctive names', () => {
  it('drops generic words', () => {
    expect(distinctiveTokens('Hundred Islands National Park')).toEqual(['hundred']);
    expect(distinctiveTokens('Minor Basilica of Our Lady of Manaoag')).toEqual(['manaoag']);
    expect(distinctiveTokens('White Beach')).toEqual(['white']);
    expect(distinctiveTokens('Beach')).toEqual([]);
  });
  it('matches folded whole words only', () => {
    expect(nameMatches('Peñafrancia Shrine', 'Basilica of Penafrancia, Naga')).toBe(true);
    expect(nameMatches('Manaoag Church', 'Manaoagan street')).toBe(false);
    expect(nameMatches('Beach', 'Beach in Bolinao')).toBe(false);
  });
  it('never treats the town name as the distinctive name', () => {
    expect(nameMatches('Dagupan Viewpoint', 'Dagupan City downtown', ['Dagupan'])).toBe(false);
    expect(nameMatches('Tondaligan Beach', 'Tondaligan, Dagupan', ['Dagupan'])).toBe(true);
    expect(distinctiveTokens('photo upload test')).toEqual([]);
  });
});

describe('geoNameMatches', () => {
  const c = (title: string, categories: string[] = []) => ({ title, description: '', categories });
  it('needs the type word when only a category carries the name', () => {
    const tapuac = { name: 'Tapuac Viewpoint' };
    expect(
      geoNameMatches(tapuac, c('File:8307Dagupan City Downtown District 01.jpg', ['Tapuac, Dagupan']), ['Dagupan']),
    ).toBe(false);
    expect(geoNameMatches(tapuac, c('File:Tapuac viewpoint at dusk.jpg'), ['Dagupan'])).toBe(true);
    const listy = {
      title: 'File:8307Dagupan 01.jpg',
      description: 'Malimgas Market, Tapuac, Dagupan City',
      categories: [],
    };
    expect(geoNameMatches(tapuac, listy, ['Dagupan'])).toBe(false);
    const park = { name: 'Hundred Islands National Park' };
    expect(geoNameMatches(park, c('File:IMG 1.jpg', ['Hundred Islands National Park']))).toBe(true);
    expect(geoNameMatches({ name: 'Manaoag' }, c('File:IMG 2.jpg', ['Manaoag']))).toBe(true);
  });
});

describe('buildCommonsCandidates', () => {
  const page = (title: string, extra: Record<string, string> = {}): CommonsPage => ({
    title,
    coordinates: [{ lat: 16.2, lon: 120.0 }],
    imageinfo: [
      {
        url: `https://upload.wikimedia.org/${title}`,
        descriptionurl: `https://commons.wikimedia.org/wiki/${title}`,
        width: 3000,
        height: 2000,
        mime: 'image/jpeg',
        thumburl: `https://upload.wikimedia.org/thumb/${title}`,
        thumbwidth: 1280,
        thumbheight: 853,
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          Artist: { value: '<a href="x">Ann</a>' },
          Categories: { value: extra.cats ?? '' },
          Assessments: { value: extra.assess ?? '' },
          ImageDescription: { value: extra.desc ?? '' },
        },
      },
    ],
  });
  const spot = { spot_id: 's1', name: 'Hundred Islands National Park', lat: 16.2, lng: 120.0 };

  it('requires the distinctive name for geosearch hits but not for P18/category links', () => {
    const out = buildCommonsCandidates(spot, {
      named: [{ page: page('File:P18.jpg'), via: 'wikidata_p18' }],
      category: [{ page: page('File:Cat.jpg'), via: 'commons_category' }],
      geo: [page('File:Random boat.jpg'), page('File:Lucap.jpg', { cats: 'Hundred Islands' })],
    });
    const by = Object.fromEntries(out.map((c) => [c.source_id, c]));
    expect(by['File:P18.jpg'].rejected).toBeUndefined();
    expect(by['File:Cat.jpg'].rejected).toBeUndefined();
    expect(by['File:Random boat.jpg'].rejected).toBe('geo_name_mismatch');
    expect(by['File:Lucap.jpg'].rejected).toBeUndefined();
    expect(by['File:P18.jpg'].author).toBe('Ann');
    expect(by['File:P18.jpg'].download_width).toBe(1280);
    expect(by['File:P18.jpg'].distance_m).toBe(0);
  });

  it('keeps the strongest link when a file is found twice', () => {
    const out = buildCommonsCandidates(spot, {
      named: [{ page: page('File:Same.jpg'), via: 'wikidata_p18' }],
      category: [],
      geo: [page('File:Same.jpg')],
    });
    expect(out).toHaveLength(1);
    expect(out[0].via).toBe('wikidata_p18');
  });
});
