import { computeTier, confidence, confidenceBucket, launchScore } from '../scripts/seed/destinations/lib/score.js';
import { assignSlugs, baseSlug, osmRefFromOsmiumKey, spotIdFor } from '../scripts/seed/destinations/lib/ids.js';
import { dedupe, type MergeInput } from '../scripts/seed/destinations/lib/merge.js';
import { psgcRegionPrefix } from '../scripts/seed/destinations/lib/areas-sql.js';

describe('confidence (Plan 46 §5.6)', () => {
  const none = {
    hasWikidata: false,
    hasCommonsPhoto: false,
    hasWikipedia: false,
    strongTag: false,
    hasHoursOrWebsite: false,
    genericName: false,
  };
  it('adds the plan weights', () => {
    expect(confidence(none).value).toBe(0);
    expect(confidence({ ...none, hasWikidata: true, hasCommonsPhoto: true }).value).toBe(0.6);
    expect(
      confidence({ ...none, hasWikidata: true, hasCommonsPhoto: true, hasWikipedia: true, strongTag: true }).value,
    ).toBe(0.85);
    expect(confidence({ ...none, strongTag: true, genericName: true }).value).toBe(0);
    expect(
      confidence({
        hasWikidata: true,
        hasCommonsPhoto: true,
        hasWikipedia: true,
        strongTag: true,
        hasHoursOrWebsite: true,
        genericName: false,
      }).value,
    ).toBe(0.95);
  });

  it('buckets', () => {
    expect(confidenceBucket(0)).toBe('0.0-0.1');
    expect(confidenceBucket(0.6)).toBe('0.6-0.7');
    expect(confidenceBucket(0.95)).toBe('0.9-1.0');
    expect(confidenceBucket(1)).toBe('0.9-1.0');
  });
});

describe('tiers (Plan 116 §8.2)', () => {
  const ok = {
    confidence: 0.85,
    hasPhoto: true,
    photoLongSide: 3000,
    photoLicenceOk: true,
    descriptionSource: 'wikipedia' as const,
    forceReview: [],
  };
  it('featured needs confidence ≥ 0.8, a ≥ 1000 px photo with a usable licence and a sourced description', () => {
    expect(computeTier(ok).tier).toBe('featured');
    expect(computeTier({ ...ok, photoLongSide: null }).tier).toBe('featured'); // size unknown
    expect(computeTier({ ...ok, photoLongSide: 800 })).toEqual({ tier: 'standard', reasons: ['photo<1000px'] });
    expect(computeTier({ ...ok, descriptionSource: null }).tier).toBe('standard');
    expect(computeTier({ ...ok, hasPhoto: false }).tier).toBe('standard');
    expect(computeTier({ ...ok, confidence: 0.75 }).tier).toBe('standard');
  });
  it('review below 0.6 or when forced', () => {
    expect(computeTier({ ...ok, confidence: 0.55 }).tier).toBe('review');
    expect(computeTier({ ...ok, forceReview: ['access_private'] })).toEqual({
      tier: 'review',
      reasons: ['access_private'],
    });
  });
  it('ranks featured candidates', () => {
    const base = { confidence: 0.85, photoLongSide: 2000, hasWikipedia: true, heritage: false, sitelinks: 4 };
    expect(launchScore({ ...base, heritage: true })).toBeGreaterThan(launchScore(base));
    expect(launchScore({ ...base, sitelinks: 50 })).toBe(launchScore({ ...base, sitelinks: 20 }));
  });
});

describe('ids and slugs', () => {
  it('derives stable ids from external refs', () => {
    expect(spotIdFor({ osm: 'node/21717872', wikidata: 'Q2110963' })).toBe('osm-n21717872');
    expect(spotIdFor({ osm: 'relation/5' })).toBe('osm-r5');
    expect(spotIdFor({ wikidata: 'Q122958743' })).toBe('wd-q122958743');
    expect(() => spotIdFor({})).toThrow();
  });
  it('reads osmium keys including area ids', () => {
    expect(osmRefFromOsmiumKey('osm-n25767747')).toBe('node/25767747');
    expect(osmRefFromOsmiumKey('w12')).toBe('way/12');
    expect(osmRefFromOsmiumKey('osm-a246')).toBe('way/123');
    expect(osmRefFromOsmiumKey('osm-a247')).toBe('relation/123');
    expect(osmRefFromOsmiumKey('x1')).toBeNull();
  });
  it('adds the town unless the name has it, and suffixes collisions in id order', () => {
    expect(baseSlug('Kawasan Falls', 'Badian')).toBe('kawasan-falls-badian');
    expect(baseSlug('Bolinao Falls 1', 'Bolinao')).toBe('bolinao-falls-1');
    expect(baseSlug('Beach', undefined)).toBe('beach');
    const taken = new Set(['beach']);
    const out = assignSlugs(
      [
        { id: 'osm-n2', base: 'beach' },
        { id: 'osm-n1', base: 'beach' },
        { id: 'wd-q1', base: 'church' },
      ],
      taken,
    );
    expect(out.get('osm-n1')).toBe('beach-2');
    expect(out.get('osm-n2')).toBe('beach-3');
    expect(out.get('wd-q1')).toBe('church');
  });
  it('reads PSGC region prefixes', () => {
    expect(psgcRegionPrefix('105500000')).toBe('01'); // Pangasinan as stored (BIGINT drops the zero)
    expect(psgcRegionPrefix('0105500000')).toBe('01');
    expect(psgcRegionPrefix('1300000000')).toBe('13');
    expect(psgcRegionPrefix('7')).toBe('07');
    expect(() => psgcRegionPrefix('x')).toThrow();
  });
});

describe('within-import dedupe', () => {
  const rec = (o: Partial<MergeInput>): MergeInput => ({ source: 'osm', name: 'X', lat: 10, lng: 120, ...o });
  it('merges same OSM / same Wikidata', () => {
    const { groups, merges } = dedupe([
      rec({ osm: 'node/1', name: 'A' }),
      rec({ osm: 'node/1', name: 'A', lat: 11 }),
      rec({ osm: 'way/2', wikidata: 'Q5', name: 'B', lat: 12 }),
      rec({ source: 'wikidata', wikidata: 'Q5', name: 'B', lat: 12.01 }),
    ]);
    expect(groups.length).toBe(2);
    expect(merges.same_osm).toBe(1);
    expect(merges.same_wikidata).toBe(1);
  });
  it('merges near-identical names within 150 m but not further', () => {
    const near = dedupe([
      rec({ osm: 'node/1', name: 'Kawasan Falls' }),
      rec({ osm: 'way/1', name: 'Kawasan Falls', lat: 10.001 }), // ≈ 111 m
    ]);
    expect(near.groups.length).toBe(1);
    const far = dedupe([
      rec({ osm: 'node/1', name: 'Kawasan Falls' }),
      rec({ osm: 'way/1', name: 'Kawasan Falls', lat: 10.002 }), // ≈ 222 m
    ]);
    expect(far.groups.length).toBe(2);
  });
  it('joins a Wikidata-only item to an untagged OSM feature within 300 m (trigram ≥ 0.6)', () => {
    const r = dedupe([
      rec({ osm: 'node/1', name: 'San Agustin Church' }),
      rec({ source: 'wikidata', wikidata: 'Q1', name: 'San Agustin Church Paoay', lat: 10.0025 }),
    ]);
    expect(r.groups.length).toBe(1);
    expect(r.merges.wikidata_to_osm).toBe(1);
  });
  it('never merges two different Wikidata items', () => {
    const r = dedupe([
      rec({ osm: 'node/1', wikidata: 'Q1', name: 'Twin Church' }),
      rec({ osm: 'node/2', wikidata: 'Q2', name: 'Twin Church', lat: 10.0001 }),
    ]);
    expect(r.groups.length).toBe(2);
  });
});
