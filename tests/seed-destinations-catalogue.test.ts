import { buildCatalogue, entityIsPlace } from '../scripts/seed/destinations/lib/catalogue.js';
import { inPolygon, representativePoint } from '../scripts/seed/destinations/lib/geom.js';
import { fromBetaWikidata, fromCandidate, fromSupplementFeature } from '../scripts/seed/destinations/lib/sources.js';
import { classifyOsm } from '../scripts/seed/destinations/lib/taxonomy.js';
import type { Enrichment, WikidataEntity } from '../scripts/seed/destinations/enrich-wikidata.js';

const entity = (o: Partial<WikidataEntity> & { qid: string }): WikidataEntity => ({
  images: [],
  websites: [],
  heritage: [],
  sitelinks: 5,
  instance_of: ['Q16970'],
  retrieved_at: '2026-11-20T00:00:00Z',
  ...o,
});

const enrichment = (): Enrichment => ({
  generated_at: 'x',
  entities: {
    Q1: entity({
      qid: 'Q1',
      label_en: 'Paoay Church',
      description_en: 'church in Ilocos Norte, Philippines',
      images: ['File:Paoay Church.jpg'],
      heritage: ['National Cultural Treasure'],
      coord: { lat: 18.0612, lng: 120.5216 },
      enwiki_title: 'Paoay Church',
      province: 'Ilocos Norte',
      region: 'Ilocos Region',
      municipality: 'Paoay',
    }),
    Q2: entity({ qid: 'Q2', instance_of: ['Q5'], coord: { lat: 14.6, lng: 121 }, enwiki_title: 'A Person' }),
    Q3: entity({ qid: 'Q3', coord: { lat: 16.5, lng: 120.5 } }), // 2 km+ away from the OSM node below
  },
  extracts: {
    'Paoay Church': {
      title: 'Paoay Church',
      extract: 'The Church of St. Augustine, commonly known as the Paoay Church, is a church in Paoay. It is famous.',
      url: 'https://en.wikipedia.org/wiki/Paoay_Church',
      retrieved_at: 't',
    },
    'A Person': {
      title: 'A Person',
      extract: 'A Person was a hero of the revolution, born 1865.',
      url: 'u',
      retrieved_at: 't',
    },
  },
  images: {
    'File:Paoay Church.jpg': {
      title: 'File:Paoay Church.jpg',
      missing: false,
      width: 4000,
      height: 3000,
      mime: 'image/jpeg',
      licence: 'CC BY-SA 4.0',
      licence_raw: 'CC BY-SA 4.0',
      author: 'Someone',
      page_url: 'https://commons.wikimedia.org/wiki/File:Paoay_Church.jpg',
      retrieved_at: 't',
    },
    'File:Locator map.png': {
      title: 'File:Locator map.png',
      missing: false,
      width: 2000,
      height: 2000,
      mime: 'image/png',
      licence: 'CC0',
      retrieved_at: 't',
    },
    'File:NC photo.jpg': {
      title: 'File:NC photo.jpg',
      missing: false,
      width: 3000,
      height: 2000,
      mime: 'image/jpeg',
      licence: null,
      licence_raw: 'CC BY-NC 2.0',
      retrieved_at: 't',
    },
  },
  provinces: [],
  stats: {},
});

const candidate = (osm: string, tags: Record<string, string>, lat: number, lng: number) =>
  fromCandidate({
    external_refs: { osm },
    name: tags.name,
    gps_lat: lat,
    gps_lng: lng,
    field_sources: { osm_tags: tags },
  })!;

describe('catalogue build', () => {
  it('merges OSM + Wikidata, sources the description and ranks the photo', () => {
    const records = [
      candidate(
        'way/10',
        {
          name: 'Paoay Church',
          amenity: 'place_of_worship',
          religion: 'christian',
          historic: 'church',
          wikidata: 'Q1',
          image: 'File:Locator_map.png',
        },
        18.0615,
        120.5218,
      ),
      fromBetaWikidata({
        qid: 'Q1',
        name: 'Paoay Church',
        lat: 18.0612,
        lng: 120.5216,
        image_file: 'Paoay Church.jpg',
        category: 'culture_heritage',
        subcategory: 'church',
      })!,
    ];
    const { rows, stats } = buildCatalogue(records, enrichment());
    expect(rows).toHaveLength(1);
    expect(stats.merges.same_wikidata).toBe(1);
    const r = rows[0];
    expect(r.id).toBe('osm-w10');
    expect(r.refs).toEqual({ osm: 'way/10', wikidata: 'Q1' });
    expect(r.category).toBe('culture_heritage');
    expect(r.subcategory).toBe('church');
    expect(r.description).toBe(
      'The Church of St. Augustine, commonly known as the Paoay Church, is a church in Paoay. It is famous.',
    );
    expect(r.field_sources.description).toMatchObject({ source: 'wikipedia', license: 'CC BY-SA 4.0' });
    expect(r.photo_candidates[0]).toMatchObject({
      title: 'File:Paoay Church.jpg',
      origin: 'wikidata_p18',
      usable: true,
    });
    expect(r.photo_candidates.find((p) => p.title === 'File:Locator map.png')).toMatchObject({ usable: false });
    expect(r.confidence).toBe(0.85); // wikidata + photo + wikipedia + historic tag
    expect(r.computed_tier).toBe('featured');
    expect(r.hints).toMatchObject({ province: 'Ilocos Norte', island_group: 'luzon', island_group_source: 'region' });
    expect(r.slug_base).toBe('paoay-church');
  });

  it('drops a wikidata link to a person (memorial) and one more than 2 km away', () => {
    const records = [
      candidate(
        'node/1',
        { name: 'Gamboa Marker', historic: 'memorial', wikidata: 'Q2', wikipedia: 'en:A Person' },
        14.6,
        121,
      ),
      candidate('node/2', { name: 'Far Falls', waterway: 'waterfall', wikidata: 'Q3' }, 16.6, 120.5),
    ];
    const { rows, stats } = buildCatalogue(records, enrichment());
    expect(stats.wikidata_dropped_not_place).toBe(1);
    expect(stats.wikidata_dropped_far).toBe(1);
    const marker = rows.find((r) => r.id === 'osm-n1')!;
    expect(marker.refs.wikidata).toBeUndefined();
    expect(marker.description).toBe('');
    const far = rows.find((r) => r.id === 'osm-n2')!;
    expect(far.computed_tier).toBe('review');
    expect(far.tier_reasons[0]).toMatch(/^wikidata_far:Q3:/);
  });

  it('never uses NC photos and excludes hotels', () => {
    const records = [
      candidate('node/5', { name: 'Hotel Uno', tourism: 'hotel' }, 10, 123),
      candidate('node/6', { name: 'Tinago Falls', waterway: 'waterfall', image: 'File:NC photo.jpg' }, 8.2, 124.3),
    ];
    const { rows, stats } = buildCatalogue(records, enrichment());
    expect(stats.excluded.osm_not_destination).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].photo_candidates[0]).toMatchObject({ usable: false, reject_reason: 'licence:CC BY-NC 2.0' });
    expect(rows[0].confidence).toBe(0.1);
  });

  it('checks Wikidata entities are places', () => {
    expect(entityIsPlace(entity({ qid: 'Q9', coord: { lat: 1, lng: 1 } }))).toBe(true);
    expect(entityIsPlace(entity({ qid: 'Q9' }))).toBe(false);
    expect(entityIsPlace(entity({ qid: 'Q9', coord: { lat: 1, lng: 1 }, instance_of: ['Q178561'] }))).toBe(false);
  });

  it('excludes working institutions unless designated or a museum', () => {
    expect(classifyOsm({ amenity: 'school', historic: 'building' })).toBeNull();
    expect(classifyOsm({ amenity: 'school', heritage: '2' })).not.toBeNull();
    expect(classifyOsm({ amenity: 'townhall', tourism: 'museum' })).not.toBeNull();
  });
});

describe('geometry and supplement inputs', () => {
  const square: [number, number][][] = [
    [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0],
    ],
  ];
  it('returns a point inside polygons, even concave ones', () => {
    expect(representativePoint({ type: 'Polygon', coordinates: square })).toEqual([2, 2]);
    const u: [number, number][][] = [
      [
        [0, 0],
        [6, 0],
        [6, 6],
        [5, 6],
        [5, 1],
        [1, 1],
        [1, 6],
        [0, 6],
        [0, 0],
      ],
    ];
    const p = representativePoint({ type: 'Polygon', coordinates: u })!;
    expect(inPolygon(p, u)).toBe(true);
    expect(
      representativePoint({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      }),
    ).toEqual([1, 1]);
    expect(
      representativePoint({
        type: 'MultiPolygon',
        coordinates: [
          square,
          [
            [
              [10, 10],
              [10.1, 10],
              [10.1, 10.1],
              [10, 10],
            ],
          ],
        ],
      }),
    ).toEqual([2, 2]);
  });

  it('adds only in-scope features missing from the candidate extract', () => {
    const known = new Set(['node/1']);
    const f = (id: string, properties: Record<string, string>) =>
      fromSupplementFeature({ id, geometry: { type: 'Point', coordinates: [121, 14] }, properties }, known);
    expect(f('n2', { name: 'Hinulugang Taktak', waterway: 'waterfall' })).toMatchObject({
      osm: 'node/2',
      input: 'osm-supplement',
    });
    expect(f('n1', { name: 'Known Falls', waterway: 'waterfall' })).toBeNull();
    expect(f('n3', { waterway: 'waterfall' })).toBeNull();
    expect(f('n4', { name: 'Coast', natural: 'coastline' })).toBeNull();
  });
});
