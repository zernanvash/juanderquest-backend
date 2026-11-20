// Plan 116 destinations: distances and island groups.

export type IslandGroup = 'luzon' | 'visayas' | 'mindanao';

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function insidePhilippines(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 4.2 && lat < 21.5 && lng > 116 && lng < 127.2;
}

const REGION_GROUP: Array<[RegExp, IslandGroup]> = [
  [/\b(ncr|national capital|metro manila)\b/i, 'luzon'],
  [/\b(car|cordillera)\b/i, 'luzon'],
  [/\b(ilocos|region i)\b/i, 'luzon'],
  [/\b(cagayan valley|region ii)\b/i, 'luzon'],
  [/\b(central luzon|region iii)\b/i, 'luzon'],
  [/\b(calabarzon|region iv-?a)\b/i, 'luzon'],
  [/\b(mimaropa|region iv-?b|southwestern tagalog)\b/i, 'luzon'],
  [/\b(bicol|region v)\b/i, 'luzon'],
  [/\b(western visayas|region vi)\b/i, 'visayas'],
  [/\b(central visayas|region vii)\b/i, 'visayas'],
  [/\b(eastern visayas|region viii)\b/i, 'visayas'],
  [/\b(negros island|nir)\b/i, 'visayas'],
  [/\b(zamboanga|region ix)\b/i, 'mindanao'],
  [/\b(northern mindanao|region x)\b/i, 'mindanao'],
  [/\b(davao|region xi)\b/i, 'mindanao'],
  [/\b(soccsksargen|region xii)\b/i, 'mindanao'],
  [/\b(caraga|region xiii)\b/i, 'mindanao'],
  [/\b(bangsamoro|barmm|armm|muslim mindanao)\b/i, 'mindanao'],
];

export function islandGroupForRegion(region: string | null | undefined): IslandGroup | null {
  if (!region) return null;
  for (const [re, group] of REGION_GROUP) if (re.test(region)) return group;
  return null;
}

/** 10-digit PSGC code (leading zero optional) → island group. 01-05, 13 (NCR), 14 (CAR), 17 (MIMAROPA) = Luzon. */
export function islandGroupForPsgcRegion(code: string | null | undefined): IslandGroup | null {
  if (!code) return null;
  const r = Number(String(code).padStart(10, '0').slice(0, 2));
  if ([1, 2, 3, 4, 5, 13, 14, 17].includes(r)) return 'luzon';
  if ([6, 7, 8, 18].includes(r)) return 'visayas';
  if ([9, 10, 11, 12, 15, 16, 19].includes(r)) return 'mindanao';
  return null;
}

/**
 * Coarse geographic fallback when no region is known. Palawan and Mindoro count as Luzon
 * (MIMAROPA), Bicol (north of 12.4°N, east of 122.9°E) as Luzon, the Sulu chain as Mindanao.
 */
export function islandGroupApprox(lat: number, lng: number): IslandGroup {
  if (lng < 121.0 && lat >= 7.6) return 'luzon'; // Palawan, Mindoro west coast, Zambales etc.
  if (lng < 122.3 && lat < 7.6) return 'mindanao'; // Sulu, Tawi-Tawi, Basilan
  if (lat >= 12.9) return 'luzon';
  if (lat >= 12.4 && lng >= 122.9 && lng < 124.2) return 'luzon'; // Bicol peninsula (Sorsogon)
  if (lat >= 12.1 && lng >= 121.9 && lng < 122.75) return 'luzon'; // Romblon (MIMAROPA)
  if (lat >= 11.8 && lng >= 123.2 && lng < 124.1) return 'luzon'; // Masbate (Bicol)
  if (lat < 10.5 && lng >= 125.45) return 'mindanao'; // Dinagat, Siargao (Caraga)
  if (lat < 9.9 && lng >= 122.3) {
    // Negros Oriental, Siquijor, Cebu and Bohol reach south of 9.9°N.
    if (lng < 123.6 && lat >= 9.0) return 'visayas';
    if (lng >= 123.6 && lng < 124.7 && lat >= 9.55) return 'visayas'; // Bohol
    return 'mindanao';
  }
  return 'visayas';
}
