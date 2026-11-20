import {
  distinctiveWords,
  firstSentences,
  isGenericName,
  nameSimilarity,
  normaliseName,
  slugify,
  trigramSimilarity,
} from '../scripts/seed/destinations/lib/text.js';
import { classifyOsm, classifyWikidata, TAXONOMY_SUBCATEGORIES } from '../scripts/seed/destinations/lib/taxonomy.js';
import { normaliseLicence } from '../scripts/seed/destinations/lib/licence.js';
import { commonsFileTitle, firstQid } from '../scripts/seed/destinations/lib/sources.js';
import {
  islandGroupApprox,
  islandGroupForPsgcRegion,
  islandGroupForRegion,
} from '../scripts/seed/destinations/lib/geo.js';
import { taxonomy } from '../src/spots/store.js';

describe('name normalisation', () => {
  it('strips accents, punctuation and expands PH abbreviations', () => {
    expect(normaliseName('Mt. Pinatubo')).toBe('mount pinatubo');
    expect(normaliseName('Sto. Niño Church')).toBe('santo nino church');
    expect(normaliseName('Bacon & Eggs!')).toBe('bacon and eggs');
  });

  it('matches pg_trgm similarity on known pairs', () => {
    // pg_trgm: similarity('word','word') = 1; 'abc' vs 'abd' = 0.333…
    expect(trigramSimilarity('word', 'word')).toBe(1);
    expect(trigramSimilarity('abc', 'abd')).toBeCloseTo(2 / 6, 5);
    expect(trigramSimilarity('', 'x')).toBe(0);
    expect(nameSimilarity('Hundred Islands National Park', 'Hundred Islands National Park')).toBe(1);
    expect(nameSimilarity('Patar Beach', 'Patar White Beach')).toBeGreaterThan(0.6);
    expect(nameSimilarity('Bolinao Falls', 'Manaoag Church')).toBeLessThan(0.2);
  });

  it('flags generic names', () => {
    expect(isGenericName('Beach')).toBe(true);
    expect(isGenericName('View Deck')).toBe(true);
    expect(isGenericName('Historical Marker')).toBe(true);
    expect(isGenericName('The Church')).toBe(true);
    expect(isGenericName('123')).toBe(true);
    expect(isGenericName('Patar Beach')).toBe(false);
    expect(isGenericName('Kawasan Falls')).toBe(false);
    expect(distinctiveWords('Mount Luho View Point')).toEqual(['luho']);
  });

  it('slugifies to ascii', () => {
    expect(slugify('Las Piñas Bamboo Organ')).toBe('las-pinas-bamboo-organ');
    expect(slugify('  --Hello, World--  ')).toBe('hello-world');
    expect(slugify('x'.repeat(100)).length).toBe(80);
  });

  it('keeps the first two sentences without cutting at abbreviations', () => {
    const t = 'St. Paul Church is old. It was built in 1700. It burned in 1900.';
    expect(firstSentences(t, 2)).toBe('St. Paul Church is old. It was built in 1700.');
    expect(firstSentences('One sentence only', 2)).toBe('One sentence only');
  });
});

describe('taxonomy mapping (D6)', () => {
  const sub = (tags: Record<string, string>) => {
    const c = classifyOsm(tags);
    return c ? `${c.category}/${c.subcategory}` : null;
  };

  it('stays inside the store taxonomy', () => {
    for (const cat of taxonomy) {
      const ours = TAXONOMY_SUBCATEGORIES[cat.id as keyof typeof TAXONOMY_SUBCATEGORIES];
      if (ours) expect([...ours].sort()).toEqual([...cat.subcategories].sort());
    }
  });

  it('maps nature, heritage and activities tags', () => {
    expect(sub({ natural: 'beach', name: 'Patar' })).toBe('nature_outdoors/beach');
    expect(sub({ waterway: 'waterfall', name: 'X' })).toBe('nature_outdoors/waterfall');
    expect(sub({ natural: 'volcano', name: 'Taal' })).toBe('nature_outdoors/trailhead');
    expect(sub({ natural: 'cave_entrance' })).toBe('nature_outdoors/cave');
    expect(sub({ tourism: 'viewpoint' })).toBe('nature_outdoors/viewpoint');
    expect(sub({ leisure: 'nature_reserve' })).toBe('nature_outdoors/park');
    expect(sub({ boundary: 'protected_area' })).toBe('nature_outdoors/park');
    expect(sub({ tourism: 'museum' })).toBe('culture_heritage/museum');
    expect(sub({ historic: 'ruins' })).toBe('culture_heritage/heritage_site');
    expect(sub({ amenity: 'place_of_worship', religion: 'christian', heritage: '2' })).toBe('culture_heritage/church');
    expect(sub({ amenity: 'place_of_worship', religion: 'muslim', tourism: 'attraction' })).toBe(
      'culture_heritage/heritage_site',
    );
    expect(sub({ natural: 'hot_spring' })).toBe('activities_wellness/recreation');
    expect(sub({ leisure: 'beach_resort' })).toBe('activities_wellness/water_activity');
    expect(sub({ tourism: 'attraction', name: 'Tinuy-an Falls' })).toBe('nature_outdoors/waterfall');
    expect(sub({ tourism: 'attraction', name: 'Fun Town' })).toBe('activities_wellness/recreation');
  });

  it('excludes restaurants, hotels and shops unless heritage-tagged', () => {
    expect(sub({ tourism: 'hotel', name: 'Hotel' })).toBeNull();
    expect(sub({ amenity: 'restaurant' })).toBeNull();
    expect(sub({ shop: 'souvenir', tourism: 'attraction' })).toBeNull();
    expect(sub({ tourism: 'hotel', historic: 'building' })).toBe('culture_heritage/heritage_site');
    expect(sub({ building: 'yes' })).toBeNull();
  });

  it('marks strong tags', () => {
    expect(classifyOsm({ natural: 'beach' })!.strong).toBe(true);
    expect(classifyOsm({ tourism: 'attraction' })!.strong).toBe(true);
    expect(classifyOsm({ leisure: 'park' })!.strong).toBe(false);
  });

  it('maps Plan 63 Wikidata classes', () => {
    expect(classifyWikidata('nature_outdoors', 'island', false)).toMatchObject({ subcategory: 'park', kind: 'island' });
    expect(classifyWikidata('culture_heritage', 'church', true)).toMatchObject({ subcategory: 'church', strong: true });
    expect(classifyWikidata('culture_heritage', 'church', false)!.strong).toBe(false);
    expect(classifyWikidata('shopping_local', 'market', false)).toBeNull();
    expect(classifyWikidata('shopping_local', 'market', true)).toMatchObject({ category: 'culture_heritage' });
  });
});

describe('licences', () => {
  it('normalises to the migration 111 forms', () => {
    expect(normaliseLicence('CC BY-SA 4.0')).toBe('CC BY-SA 4.0');
    expect(normaliseLicence('CC BY-SA 2.0 de')).toBe('CC BY-SA 2.0');
    expect(normaliseLicence('CC BY 2.5 au')).toBe('CC BY 2.5');
    expect(normaliseLicence('cc-by-4')).toBe('CC BY 4.0');
    expect(normaliseLicence('CC0')).toBe('CC0');
    expect(normaliseLicence('Public domain')).toBe('PD');
    expect(normaliseLicence('No restrictions')).toBe('PD');
    expect(normaliseLicence('Public Domain Mark 1.0')).toBe('PDM');
  });

  it('rejects NC/ND/unknown licences', () => {
    expect(normaliseLicence('CC BY-NC-SA 2.0')).toBeNull();
    expect(normaliseLicence('CC BY-ND 4.0')).toBeNull();
    expect(normaliseLicence('Attribution')).toBeNull();
    expect(normaliseLicence('FAL')).toBeNull();
    expect(normaliseLicence('GFDL')).toBeNull();
    expect(normaliseLicence('CC BY')).toBeNull();
    expect(normaliseLicence('')).toBeNull();
  });
});

describe('source helpers', () => {
  it('reads Commons titles from OSM tags', () => {
    expect(commonsFileTitle('File:Foo_bar.jpg')).toBe('File:Foo bar.jpg');
    expect(commonsFileTitle('https://commons.wikimedia.org/wiki/File:Caf%C3%A9_x.jpg')).toBe('File:Café x.jpg');
    expect(
      commonsFileTitle(
        'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Asik_Falls.jpg/1280px-Asik_Falls.jpg',
      ),
    ).toBe('File:Asik Falls.jpg');
    expect(commonsFileTitle('https://example.com/photo.jpg')).toBeNull();
    expect(firstQid('Q1;Q2')).toBe('Q1');
    expect(firstQid('none')).toBeUndefined();
  });

  it('assigns island groups', () => {
    expect(islandGroupForRegion('Central Visayas')).toBe('visayas');
    expect(islandGroupForRegion('Region I')).toBe('luzon');
    expect(islandGroupForRegion('Bangsamoro Autonomous Region in Muslim Mindanao')).toBe('mindanao');
    expect(islandGroupForRegion('Cagayan Valley')).toBe('luzon');
    expect(islandGroupForPsgcRegion('0105500000')).toBe('luzon');
    expect(islandGroupForPsgcRegion('105500000')).toBe('luzon');
    expect(islandGroupForPsgcRegion('0700000000')).toBe('visayas');
    expect(islandGroupForPsgcRegion('1900000000')).toBe('mindanao');
    expect(islandGroupApprox(14.6, 121.0)).toBe('luzon'); // Manila
    expect(islandGroupApprox(9.74, 118.74)).toBe('luzon'); // Puerto Princesa
    expect(islandGroupApprox(10.3, 123.9)).toBe('visayas'); // Cebu City
    expect(islandGroupApprox(9.65, 123.85)).toBe('visayas'); // Tagbilaran
    expect(islandGroupApprox(7.07, 125.6)).toBe('mindanao'); // Davao
    expect(islandGroupApprox(6.05, 121.0)).toBe('mindanao'); // Jolo
    expect(islandGroupApprox(9.85, 126.05)).toBe('mindanao'); // Siargao
    expect(islandGroupApprox(13.14, 123.74)).toBe('luzon'); // Legazpi
    expect(islandGroupApprox(11.97, 121.92)).toBe('visayas'); // Boracay
  });
});
