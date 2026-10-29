// Plan 66: shared place recognition for map-first spot posting (web + mobile).
// PSGC admin areas (point-in-polygon) give the town/barangay offline; a cached, throttled
// Nominatim reverse lookup adds the POI name, road and OSM tags; a deterministic mapper turns
// those into suggestions that use the API's own vocabularies (see the POST /spots schema).
import type { Pool } from 'pg';
import { ensureAreaCache, getCachedAreas, matchSpotToAreas } from '../maps/areas-service.js';
import { distanceKm, spotStore } from './store.js';

export type SpotCategory = 'eat_drink' | 'nature_outdoors' | 'culture_heritage' | 'activities_wellness' | 'shopping_local' | 'stay';
export type GoodFor = 'families' | 'solo' | 'couples' | 'groups' | 'seniors_access';
export type BestTime = 'early_morning' | 'daytime' | 'sunset' | 'night' | 'weekdays' | 'dry_season' | 'rainy_season';
/** Amenity ids shared by the web and mobile posting composers. */
export type PostingAmenity = 'parking' | 'restrooms' | 'food_nearby' | 'guide_available' | 'cottage_rentals' | 'boat_service' | 'wifi_signal' | 'pwd_accessible';

export interface NearbyDuplicate { id: string; slug: string; name: string; category: string; municipality: string; distance_meters: number }

export interface SpotRecognition {
  recognized: boolean;
  source: 'osm' | 'areas' | 'none';
  place_name: string | null;
  name_suggestions: string[];
  formatted_address: string;
  municipality: string | null;
  barangay: string | null;
  province: string | null;
  road: string | null;
  outside_pangasinan: boolean;
  osm: { class: string; type: string } | null;
  suggested_category: SpotCategory;
  suggested_subcategory: string;
  suggested_details: { good_for: GoodFor[]; best_time: BestTime[]; amenities: PostingAmenity[]; daily_hours: string; contact_number: string };
  story_starters: string[];
  nearby_duplicates: NearbyDuplicate[];
}

export interface NominatimReverse {
  name?: string;
  category?: string;
  type?: string;
  display_name?: string;
  address?: Record<string, string | undefined>;
  extratags?: Record<string, string | undefined> | null;
  namedetails?: Record<string, string | undefined> | null;
}

interface Profile {
  category: SpotCategory; subcategory: string; noun: string;
  good_for: GoodFor[]; best_time: BestTime[]; amenities: PostingAmenity[]; hours: string;
}

const PROFILES: Record<string, Profile> = {
  beach: { category: 'nature_outdoors', subcategory: 'beach', noun: 'Beach', good_for: ['families', 'groups', 'couples'], best_time: ['early_morning', 'sunset', 'dry_season'], amenities: ['parking', 'restrooms', 'cottage_rentals'], hours: '06:00 AM - 06:00 PM' },
  waterfall: { category: 'nature_outdoors', subcategory: 'waterfall', noun: 'Falls', good_for: ['groups', 'solo'], best_time: ['early_morning', 'daytime', 'dry_season'], amenities: ['parking', 'guide_available'], hours: '07:00 AM - 05:00 PM' },
  viewpoint: { category: 'nature_outdoors', subcategory: 'viewpoint', noun: 'Viewpoint', good_for: ['groups', 'solo', 'couples'], best_time: ['early_morning', 'sunset'], amenities: ['parking'], hours: '06:00 AM - 06:00 PM' },
  cave: { category: 'nature_outdoors', subcategory: 'cave', noun: 'Cave', good_for: ['groups', 'solo'], best_time: ['daytime', 'dry_season'], amenities: ['guide_available'], hours: '08:00 AM - 05:00 PM' },
  park: { category: 'nature_outdoors', subcategory: 'park', noun: 'Park', good_for: ['families', 'seniors_access', 'couples'], best_time: ['early_morning', 'daytime', 'sunset'], amenities: ['parking', 'restrooms'], hours: '06:00 AM - 08:00 PM' },
  cafe: { category: 'eat_drink', subcategory: 'cafe', noun: 'Café', good_for: ['groups', 'solo', 'couples'], best_time: ['early_morning', 'daytime', 'night'], amenities: ['restrooms', 'wifi_signal'], hours: '08:00 AM - 09:00 PM' },
  restaurant: { category: 'eat_drink', subcategory: 'restaurant', noun: 'Eatery', good_for: ['families', 'groups'], best_time: ['daytime', 'night'], amenities: ['restrooms', 'parking'], hours: '09:00 AM - 09:00 PM' },
  street_food: { category: 'eat_drink', subcategory: 'street_food', noun: 'Food Stop', good_for: ['groups', 'solo'], best_time: ['daytime', 'night'], amenities: ['food_nearby'], hours: '10:00 AM - 10:00 PM' },
  bakery: { category: 'eat_drink', subcategory: 'bakery', noun: 'Bakery', good_for: ['families', 'solo'], best_time: ['early_morning', 'daytime'], amenities: ['parking'], hours: '06:00 AM - 08:00 PM' },
  bar: { category: 'eat_drink', subcategory: 'bar', noun: 'Night Spot', good_for: ['groups', 'couples'], best_time: ['night'], amenities: ['restrooms'], hours: '05:00 PM - 12:00 AM' },
  church: { category: 'culture_heritage', subcategory: 'church', noun: 'Church', good_for: ['families', 'seniors_access', 'solo'], best_time: ['early_morning', 'daytime'], amenities: ['parking', 'restrooms'], hours: '06:00 AM - 07:00 PM' },
  museum: { category: 'culture_heritage', subcategory: 'museum', noun: 'Museum', good_for: ['families', 'solo', 'groups'], best_time: ['daytime', 'weekdays'], amenities: ['restrooms', 'pwd_accessible'], hours: '08:00 AM - 05:00 PM' },
  heritage: { category: 'culture_heritage', subcategory: 'heritage_site', noun: 'Heritage Site', good_for: ['families', 'solo', 'groups'], best_time: ['early_morning', 'daytime'], amenities: ['parking'], hours: '08:00 AM - 05:00 PM' },
  stay_resort: { category: 'stay', subcategory: 'resort', noun: 'Resort', good_for: ['families', 'couples', 'groups'], best_time: ['dry_season', 'weekdays'], amenities: ['parking', 'restrooms', 'wifi_signal'], hours: 'Open 24 hours' },
  stay_hotel: { category: 'stay', subcategory: 'hotel', noun: 'Hotel', good_for: ['families', 'couples', 'solo'], best_time: ['weekdays'], amenities: ['parking', 'wifi_signal', 'pwd_accessible'], hours: 'Open 24 hours' },
  stay_homestay: { category: 'stay', subcategory: 'homestay', noun: 'Homestay', good_for: ['families', 'groups'], best_time: ['weekdays', 'dry_season'], amenities: ['wifi_signal'], hours: 'Open 24 hours' },
  campsite: { category: 'stay', subcategory: 'campsite', noun: 'Campsite', good_for: ['groups', 'couples'], best_time: ['dry_season'], amenities: ['restrooms'], hours: 'Open 24 hours' },
  market: { category: 'shopping_local', subcategory: 'market', noun: 'Market', good_for: ['families', 'solo'], best_time: ['early_morning', 'daytime'], amenities: ['food_nearby'], hours: '06:00 AM - 07:00 PM' },
  souvenir: { category: 'shopping_local', subcategory: 'souvenir', noun: 'Pasalubong Shop', good_for: ['families', 'solo'], best_time: ['daytime'], amenities: ['parking'], hours: '08:00 AM - 08:00 PM' },
  water_activity: { category: 'activities_wellness', subcategory: 'water_activity', noun: 'Water Park', good_for: ['families', 'groups'], best_time: ['daytime', 'dry_season'], amenities: ['restrooms', 'parking'], hours: '08:00 AM - 05:00 PM' },
  recreation: { category: 'activities_wellness', subcategory: 'recreation', noun: 'Recreation Spot', good_for: ['families', 'groups'], best_time: ['daytime', 'sunset'], amenities: ['restrooms', 'parking'], hours: '08:00 AM - 08:00 PM' },
  sports: { category: 'activities_wellness', subcategory: 'sports_venue', noun: 'Sports Venue', good_for: ['groups', 'solo'], best_time: ['early_morning', 'sunset'], amenities: ['parking', 'restrooms'], hours: '06:00 AM - 09:00 PM' },
};
/** Unnamed or unmatched pins: a scenic spot is the most common community post. */
const DEFAULT_PROFILE = PROFILES.viewpoint;

const TAG_RULES: Array<[RegExp, keyof typeof PROFILES]> = [
  [/^natural=(beach|coastline|shoal|bay)$/, 'beach'],
  [/^waterway=waterfall$|^natural=waterfall$/, 'waterfall'],
  [/^natural=(cave_entrance|cave)$/, 'cave'],
  [/^tourism=viewpoint$|^natural=(peak|hill|cliff|volcano|ridge|island|islet|cape)$/, 'viewpoint'],
  [/^leisure=(park|garden|nature_reserve)$|^boundary=protected_area$/, 'park'],
  [/^amenity=(cafe|ice_cream)$|^shop=(coffee|tea)$/, 'cafe'],
  [/^amenity=(restaurant|food_court)$|^shop=seafood$/, 'restaurant'],
  [/^amenity=fast_food$/, 'street_food'],
  [/^shop=(bakery|pastry|confectionery)$/, 'bakery'],
  [/^amenity=(bar|pub|biergarten|nightclub)$/, 'bar'],
  [/^amenity=place_of_worship$|^building=(church|cathedral|chapel)$/, 'church'],
  [/^tourism=(museum|gallery)$/, 'museum'],
  [/^historic=|^tourism=(attraction|artwork)$/, 'heritage'],
  [/^tourism=(resort)$|^leisure=resort$/, 'stay_resort'],
  [/^tourism=(hotel|motel)$/, 'stay_hotel'],
  [/^tourism=(guest_house|hostel|chalet|apartment)$/, 'stay_homestay'],
  [/^tourism=(camp_site|caravan_site)$/, 'campsite'],
  [/^amenity=marketplace$|^shop=(mall|supermarket)$/, 'market'],
  [/^shop=(gift|souvenir|craft|farm)$/, 'souvenir'],
  [/^leisure=(water_park|swimming_pool|marina|beach_resort)$/, 'water_activity'],
  [/^leisure=(playground|amusement_arcade)$|^tourism=(theme_park|zoo)$/, 'recreation'],
  [/^leisure=(sports_centre|pitch|stadium|fitness_centre)$/, 'sports'],
];
const NAME_RULES: Array<[RegExp, keyof typeof PROFILES]> = [
  [/\b(beach|beachfront|cove|shore)\b/i, 'beach'],
  [/\b(falls|waterfall)\b/i, 'waterfall'],
  [/\b(cave|caves)\b/i, 'cave'],
  [/\b(caf[eé]|coffee)\b/i, 'cafe'],
  [/\b(grill|restaurant|eatery|kainan|carinderia|seafood)\b/i, 'restaurant'],
  [/\b(church|parish|cathedral|basilica|chapel|shrine)\b/i, 'church'],
  [/\b(museum|gallery)\b/i, 'museum'],
  [/\b(resort)\b/i, 'stay_resort'],
  [/\b(hotel|inn)\b/i, 'stay_hotel'],
  [/\b(market|palengke)\b/i, 'market'],
  [/\b(park|garden|eco[- ]?park)\b/i, 'park'],
  [/\b(lighthouse|capitol|heritage|ruins|monument)\b/i, 'heritage'],
];

export function pickProfile(osm: { class: string; type: string } | null, name: string | null): Profile {
  if (osm) {
    const key = `${osm.class}=${osm.type}`;
    const hit = TAG_RULES.find(([pattern]) => pattern.test(key));
    if (hit) return PROFILES[hit[1]];
  }
  if (name) {
    const hit = NAME_RULES.find(([pattern]) => pattern.test(name));
    if (hit) return PROFILES[hit[1]];
  }
  return DEFAULT_PROFILE;
}

/** "Patar" -> "Brgy. Patar"; keeps names that already read as a barangay. */
export function barangayLabel(raw: string | null | undefined): string | null {
  const name = raw?.trim();
  if (!name) return null;
  return /^(brgy\.?|barangay|poblacion)\b/i.test(name) ? name.replace(/^barangay\s+/i, 'Brgy. ') : `Brgy. ${name}`;
}

/** Simple OSM opening_hours ("Mo-Su 08:00-17:00" or "08:00-17:00") -> "08:00 AM - 05:00 PM". */
export function hoursFromOsm(value: string | undefined): string | null {
  if (!value) return null;
  if (/^24\/7$/.test(value.trim())) return 'Open 24 hours';
  const match = /(?:^|\s)(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(value.trim());
  if (!match || value.includes(';')) return null;
  const fmt = (h: number, m: string) => `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0')}:${m} ${h % 24 < 12 ? 'AM' : 'PM'}`;
  return `${fmt(Number(match[1]), match[2])} - ${fmt(Number(match[3]), match[4])}`;
}

function storyStarters(profile: Profile, where: string, placeName: string | null): string[] {
  const byCategory: Record<SpotCategory, string[]> = {
    nature_outdoors: [
      `${placeName ? placeName : `A scenic ${profile.noun.toLowerCase()}`} in ${where} with relaxing views and fresh air.`,
      'Great stop for photos and sunset watching, and easy to reach from the main road.',
      'Best visited in the early morning or late afternoon; bring water and sun protection.',
      'Please keep it clean: take your trash home and follow local guides and signs.',
    ],
    eat_drink: [
      `${placeName ? `${placeName} is a` : 'A'} local favorite in ${where} for a hearty, budget-friendly meal.`,
      'Try their best-selling dish and ask the staff what is fresh and in season today.',
      'Good stop for families and barkadas; it can get busy around lunch and dinner.',
      `A handy food stop when exploring ${where}, with friendly service and fair prices.`,
    ],
    culture_heritage: [
      `${placeName ? placeName : `A meaningful ${profile.noun.toLowerCase()}`} in ${where} with a story worth learning about.`,
      'Take a quiet moment to look at the architecture, old details and local history here.',
      'Please dress modestly and keep voices low, especially during masses and events.',
      'Best visited in the morning when it is cooler and there are fewer visitors around.',
    ],
    activities_wellness: [
      `${placeName ? placeName : `A fun ${profile.noun.toLowerCase()}`} in ${where} for an active day out with friends.`,
      'Good for groups and families looking for something to do beyond sightseeing.',
      'Bring extra clothes, water and sun protection, and check the rates before going.',
      'Weekdays are less crowded, so you get more time and space to enjoy it.',
    ],
    shopping_local: [
      `${placeName ? placeName : `A local ${profile.noun.toLowerCase()}`} in ${where} for pasalubong and everyday finds.`,
      'Support local makers and vendors; many products here are made in the province.',
      'Come early in the morning for the freshest goods and the widest selection.',
      'Bring small bills and a reusable bag, and do not be shy to ask for the suki price.',
    ],
    stay: [
      `${placeName ? placeName : `A comfortable ${profile.noun.toLowerCase()}`} in ${where} as a base for exploring the area.`,
      'Good for families and groups who want a relaxed stay close to local spots.',
      'Book ahead on weekends and holidays, and ask about inclusions when reserving.',
      `A convenient place to rest after a full day of trips around ${where}.`,
    ],
  };
  return byCategory[profile.category];
}

function nameSuggestions(profile: Profile, placeName: string | null, barangay: string | null, municipality: string | null): string[] {
  const names = [
    placeName,
    barangay ? `${barangay.replace(/^Brgy\.\s*/, '')} ${profile.noun}` : null,
    municipality ? `${municipality} ${profile.noun}` : null,
    barangay ? `${barangay} ${profile.noun}` : null,
  ].filter((value): value is string => Boolean(value && value.trim().length >= 3));
  return [...new Set(names.map(value => value.trim()))].slice(0, 3);
}

export function findNearbyDuplicates(lat: number, lng: number, radiusMeters = 80): NearbyDuplicate[] {
  const box = 0.001;
  return spotStore.spots
    .filter(spot => spot.status === 'published' && !spot.is_test
      && Math.abs(spot.gps_lat - lat) <= box && Math.abs(spot.gps_lng - lng) <= box)
    .map(spot => ({ spot, meters: Math.round(distanceKm(lat, lng, spot.gps_lat, spot.gps_lng) * 1000) }))
    .filter(entry => entry.meters <= radiusMeters)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, 3)
    .map(({ spot, meters }) => ({ id: spot.id, slug: spot.slug, name: spot.name, category: spot.category, municipality: spot.municipality, distance_meters: meters }));
}

// --- Nominatim: 24 h cache on a ~22 m grid, max 2,000 entries, at most 1 upstream request per second.
const NOMINATIM_TTL_MS = 24 * 60 * 60 * 1000;
const NOMINATIM_MAX = 2000;
const nominatimCache = new Map<string, { at: number; data: NominatimReverse | null }>();
let lastUpstream = 0;
let queue: Promise<void> = Promise.resolve();
type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Tests replace the upstream; pass null to restore global fetch. */
export function setRecognizeFetch(next: FetchLike | null): void {
  fetchImpl = next ?? ((url, init) => fetch(url, init));
  nominatimCache.clear();
  lastUpstream = 0;
}

function gridKey(lat: number, lng: number) {
  const step = 0.0002;
  return `${(Math.round(lat / step) * step).toFixed(4)},${(Math.round(lng / step) * step).toFixed(4)}`;
}

async function reverseNominatim(lat: number, lng: number): Promise<NominatimReverse | null> {
  const key = gridKey(lat, lng);
  const cached = nominatimCache.get(key);
  if (cached && Date.now() - cached.at < NOMINATIM_TTL_MS) return cached.data;
  const slot = queue.then(async () => {
    const wait = 1000 - (Date.now() - lastUpstream);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastUpstream = Date.now();
  });
  queue = slot.catch(() => undefined);
  await slot;
  let data: NominatimReverse | null = null;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&extratags=1&namedetails=1&accept-language=en`;
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'JuanDerQuest/1.0 (travel@juanderquest.app; +https://juanderquest.app)', Accept: 'application/json' },
      signal: AbortSignal.timeout(3500),
    });
    data = response.ok ? (await response.json()) as NominatimReverse : null;
  } catch {
    data = null;
  }
  // Failures are cached briefly (5 min) so a slow upstream is not hammered while a user pans.
  if (nominatimCache.size >= NOMINATIM_MAX) nominatimCache.delete(nominatimCache.keys().next().value as string);
  nominatimCache.set(key, { at: data ? Date.now() : Date.now() - NOMINATIM_TTL_MS + 5 * 60 * 1000, data });
  return data;
}

const provinceNames = new Map<string, string>();
async function provinceFor(pool: Pick<Pool, 'query'> | null, provinceId: string | null): Promise<string | null> {
  if (!pool || !provinceId) return null;
  if (provinceNames.has(provinceId)) return provinceNames.get(provinceId)!;
  try {
    const row = (await pool.query('SELECT name FROM admin_areas WHERE id=$1', [provinceId])).rows[0];
    if (row?.name) provinceNames.set(provinceId, row.name);
    return row?.name ?? null;
  } catch {
    return null;
  }
}

export async function recognizeSpotLocation(lat: number, lng: number, pool: Pick<Pool, 'query'> | null): Promise<SpotRecognition> {
  // A. PSGC areas (offline, fast).
  await ensureAreaCache(pool);
  const match = matchSpotToAreas(lat, lng);
  const areas = getCachedAreas() ?? [];
  const town = areas.find(area => area.id === match.townAreaId) ?? null;
  const barangayArea = areas.find(area => area.id === match.barangayAreaId) ?? null;
  const [osmData, provinceFromAreas] = await Promise.all([reverseNominatim(lat, lng), provinceFor(pool, town?.parent_id ?? null)]);

  // B. Nominatim enrichment.
  const address = osmData?.address ?? {};
  const road = address.road?.trim() || null;
  const osmTown = (address.city || address.town || address.municipality || address.county || '').trim() || null;
  const osmBarangay = (address.village || address.suburb || address.quarter || address.neighbourhood || address.hamlet || '').trim() || null;
  const municipality = town?.name ?? osmTown;
  const barangay = barangayLabel(barangayArea?.name ?? osmBarangay);
  const province = provinceFromAreas ?? ((address.state || address.province || '').trim() || null);
  const osm = osmData?.category && osmData.type ? { class: osmData.category, type: osmData.type } : null;
  const rawName = (osmData?.namedetails?.name || osmData?.name || '').trim();
  const generic = [road, municipality, osmTown, osmBarangay, barangayArea?.name, province].filter(Boolean).map(value => value!.toLowerCase());
  const placeName = rawName && !generic.includes(rawName.toLowerCase()) && osm && osm.class !== 'highway' && osm.class !== 'boundary' && osm.class !== 'place'
    ? rawName : null;

  // C. Suggestions in the API's vocabularies.
  const profile = pickProfile(osm, placeName);
  const extra = osmData?.extratags ?? {};
  const amenities = new Set<PostingAmenity>(profile.amenities);
  if (extra.wheelchair === 'yes') amenities.add('pwd_accessible');
  if (extra.internet_access && ['yes', 'wlan', 'wifi'].includes(extra.internet_access)) amenities.add('wifi_signal');
  const where = [barangay, municipality].filter(Boolean).join(', ') || province || 'this area';
  const formattedAddress = [road, barangay, municipality, province && province !== municipality ? province : null].filter(Boolean).join(', ');
  const outside = province ? !/pangasinan/i.test(province) : !town;

  return {
    recognized: Boolean(municipality || placeName),
    source: osmData ? 'osm' : town ? 'areas' : 'none',
    place_name: placeName,
    name_suggestions: nameSuggestions(profile, placeName, barangay, municipality),
    formatted_address: formattedAddress || (municipality ? `${municipality}${province ? `, ${province}` : ''}` : 'Selected spot on the map'),
    municipality,
    barangay,
    province,
    road,
    outside_pangasinan: outside,
    osm,
    suggested_category: profile.category,
    suggested_subcategory: profile.subcategory,
    suggested_details: {
      good_for: profile.good_for,
      best_time: profile.best_time,
      amenities: [...amenities],
      daily_hours: hoursFromOsm(extra.opening_hours) ?? profile.hours,
      contact_number: (extra.phone || extra['contact:phone'] || '').trim(),
    },
    story_starters: storyStarters(profile, where, placeName),
    nearby_duplicates: findNearbyDuplicates(lat, lng),
  };
}
