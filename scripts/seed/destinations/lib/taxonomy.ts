// Plan 116 destinations: OSM tags / Wikidata classes → our taxonomy (src/spots/store.ts `taxonomy`).
// National scope is attractions / nature / heritage / activities only (owner decision D6): OSM restaurants,
// hotels and shops are excluded unless they carry a heritage/historic tag (Wikidata-notable heritage).

export type Category = 'nature_outdoors' | 'culture_heritage' | 'activities_wellness';

export interface Classification {
  category: Category;
  subcategory: string; // always one of the store taxonomy subcategories
  kind: string; // finer OSM/Wikidata kind kept as a tag (e.g. 'volcano', 'island', 'memorial')
  strong: boolean; // Plan 46 §5.6 "strong tag": tourism=attraction, natural=*, historic=*
}

/** Subcategories allowed per category; mirrors src/spots/store.ts (do not edit that file). */
export const TAXONOMY_SUBCATEGORIES: Record<Category, readonly string[]> = {
  nature_outdoors: ['beach', 'waterfall', 'cave', 'park', 'trailhead', 'viewpoint'],
  culture_heritage: ['church', 'museum', 'heritage_site', 'arts_crafts'],
  activities_wellness: ['sports_venue', 'running_spot', 'gym', 'recreation', 'water_activity'],
};

export type Tags = Record<string, string | undefined>;

const EXCLUDED_TOURISM = new Set([
  'hotel',
  'guest_house',
  'hostel',
  'motel',
  'apartment',
  'chalet',
  'camp_site',
  'caravan_site',
  'information',
  'alpine_hut',
  'wilderness_hut',
]);
const EXCLUDED_AMENITY = new Set([
  'restaurant',
  'cafe',
  'fast_food',
  'bar',
  'pub',
  'food_court',
  'marketplace',
  'bank',
  'fuel',
]);
const INSTITUTION_AMENITY = new Set([
  'school',
  'university',
  'college',
  'kindergarten',
  'hospital',
  'clinic',
  'townhall',
  'police',
  'fire_station',
  'post_office',
  'courthouse',
  'prison',
  'library',
]);
const CHRISTIAN = /christian|catholic|^$/;

function has(tags: Tags, key: string): boolean {
  const v = tags[key];
  return v !== undefined && v !== '' && v !== 'no';
}

function byName(name: string): Omit<Classification, 'strong'> | null {
  const n = name.toLowerCase();
  if (/\b(falls?|waterfalls?|talon)\b/.test(n))
    return { category: 'nature_outdoors', subcategory: 'waterfall', kind: 'waterfall' };
  if (/\bhot ?springs?\b/.test(n))
    return { category: 'activities_wellness', subcategory: 'recreation', kind: 'hot_spring' };
  if (/\bbeach\b/.test(n)) return { category: 'nature_outdoors', subcategory: 'beach', kind: 'beach' };
  if (/\b(cave|caves|kweba)\b/.test(n)) return { category: 'nature_outdoors', subcategory: 'cave', kind: 'cave' };
  if (/\b(view ?deck|viewpoint|view point|lookout|overlook|viewing deck)\b/.test(n))
    return { category: 'nature_outdoors', subcategory: 'viewpoint', kind: 'viewpoint' };
  if (/\b(church|cathedral|basilica|parish|chapel|shrine)\b/.test(n))
    return { category: 'culture_heritage', subcategory: 'church', kind: 'church' };
  if (/\bmuseum\b/.test(n)) return { category: 'culture_heritage', subcategory: 'museum', kind: 'museum' };
  return null;
}

/** Classify an OSM feature; null = not a national destination (excluded or unknown). */
export function classifyOsm(tags: Tags): Classification | null {
  const name = tags['name:en'] || tags.name || '';
  const heritage = has(tags, 'heritage') || has(tags, 'historic');
  const tourism = tags.tourism ?? '';
  const amenity = tags.amenity ?? '';
  const natural = tags.natural ?? '';
  const leisure = tags.leisure ?? '';
  const strongNatural = has(tags, 'natural');
  const strong = tourism === 'attraction' || strongNatural || has(tags, 'historic');

  // D6: no restaurants, hotels or shops nationally, unless heritage-tagged.
  if (!heritage && (EXCLUDED_TOURISM.has(tourism) || EXCLUDED_AMENITY.has(amenity) || has(tags, 'shop'))) return null;
  // Working institutions (schools, hospitals, offices) are not destinations; a formal heritage=* designation,
  // a museum or an explicit tourism=attraction keeps them (historic=building alone does not).
  if (INSTITUTION_AMENITY.has(amenity) && !has(tags, 'heritage') && !['attraction', 'museum'].includes(tourism))
    return null;

  if (heritage) {
    const worship =
      amenity === 'place_of_worship' || ['church', 'cathedral', 'chapel', 'basilica'].includes(tags.building ?? '');
    if (worship && CHRISTIAN.test(tags.religion ?? ''))
      return { category: 'culture_heritage', subcategory: 'church', kind: tags.historic || 'church', strong };
    if (tourism === 'museum') return { category: 'culture_heritage', subcategory: 'museum', kind: 'museum', strong };
    return { category: 'culture_heritage', subcategory: 'heritage_site', kind: tags.historic || 'heritage', strong };
  }
  if (tourism === 'museum') return { category: 'culture_heritage', subcategory: 'museum', kind: 'museum', strong };
  if (tourism === 'gallery' || tourism === 'artwork')
    return { category: 'culture_heritage', subcategory: 'arts_crafts', kind: tourism, strong };
  if (amenity === 'place_of_worship') {
    return CHRISTIAN.test(tags.religion ?? '')
      ? { category: 'culture_heritage', subcategory: 'church', kind: 'church', strong }
      : {
          category: 'culture_heritage',
          subcategory: 'heritage_site',
          kind: tags.religion || 'place_of_worship',
          strong,
        };
  }
  if (natural === 'beach') return { category: 'nature_outdoors', subcategory: 'beach', kind: 'beach', strong };
  if (natural === 'waterfall' || tags.waterway === 'waterfall')
    return { category: 'nature_outdoors', subcategory: 'waterfall', kind: 'waterfall', strong: true };
  if (natural === 'cave_entrance') return { category: 'nature_outdoors', subcategory: 'cave', kind: 'cave', strong };
  if (['peak', 'volcano', 'hill', 'ridge', 'saddle'].includes(natural))
    return { category: 'nature_outdoors', subcategory: 'trailhead', kind: natural, strong };
  if (natural === 'hot_spring' || natural === 'spring' || natural === 'geyser')
    return { category: 'activities_wellness', subcategory: 'recreation', kind: natural, strong };
  if (natural === 'reef')
    return { category: 'activities_wellness', subcategory: 'water_activity', kind: 'reef', strong };
  if (['cape', 'cliff', 'arch', 'rock', 'stone', 'coastline', 'bay', 'dune'].includes(natural))
    return { category: 'nature_outdoors', subcategory: 'viewpoint', kind: natural, strong };
  if (tourism === 'viewpoint')
    return { category: 'nature_outdoors', subcategory: 'viewpoint', kind: 'viewpoint', strong };
  if (['theme_park', 'zoo', 'aquarium'].includes(tourism))
    return { category: 'activities_wellness', subcategory: 'recreation', kind: tourism, strong };
  if (leisure === 'water_park' || leisure === 'beach_resort' || leisure === 'bathing_place' || leisure === 'marina')
    return { category: 'activities_wellness', subcategory: 'water_activity', kind: leisure, strong };
  if (
    ['park', 'garden', 'nature_reserve'].includes(leisure) ||
    ['protected_area', 'national_park'].includes(tags.boundary ?? '')
  )
    return { category: 'nature_outdoors', subcategory: 'park', kind: leisure || tags.boundary || 'park', strong };
  if (strongNatural) return { category: 'nature_outdoors', subcategory: 'park', kind: natural, strong };
  if (tourism === 'attraction') {
    const named = byName(name);
    if (named) return { ...named, strong };
    return { category: 'activities_wellness', subcategory: 'recreation', kind: 'attraction', strong };
  }
  if (['pitch', 'sports_centre', 'stadium', 'track'].includes(leisure))
    return { category: 'activities_wellness', subcategory: 'sports_venue', kind: leisure, strong };
  if (tourism === 'picnic_site')
    return { category: 'nature_outdoors', subcategory: 'park', kind: 'picnic_site', strong };
  return null;
}

/**
 * Classify a Wikidata-only item from the Plan 63 beta set (its category/subcategory came from the
 * P31 class used in the query). `heritage` = has a P1435 designation.
 */
export function classifyWikidata(category: string, subcategory: string, heritage: boolean): Classification | null {
  const nature = new Set(['beach', 'waterfall', 'cave', 'park', 'trailhead', 'viewpoint']);
  if (category === 'nature_outdoors') {
    if (nature.has(subcategory)) return { category, subcategory, kind: subcategory, strong: true };
    if (subcategory === 'hot_spring')
      return { category: 'activities_wellness', subcategory: 'recreation', kind: 'hot_spring', strong: true };
    return { category, subcategory: 'park', kind: subcategory || 'nature', strong: true }; // island, lake, ...
  }
  if (category === 'culture_heritage') {
    const sub = TAXONOMY_SUBCATEGORIES.culture_heritage.includes(subcategory) ? subcategory : 'heritage_site';
    return { category, subcategory: sub, kind: subcategory || 'heritage', strong: heritage || sub === 'museum' };
  }
  if (category === 'activities_wellness') {
    const sub = TAXONOMY_SUBCATEGORIES.activities_wellness.includes(subcategory) ? subcategory : 'recreation';
    return { category, subcategory: sub, kind: subcategory, strong: false };
  }
  // eat_drink / shopping_local / stay: only Wikidata-notable heritage places (D6).
  if (heritage) return { category: 'culture_heritage', subcategory: 'heritage_site', kind: subcategory, strong: true };
  return null;
}
