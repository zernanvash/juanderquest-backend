import type { NormalisedLicence } from './licence.js';

export type PhotoSource = 'commons' | 'openverse' | 'flickr';

/** How a candidate was linked to the place; stronger links win cross-spot conflicts. */
export type Via =
  | 'wikidata_p18'
  | 'osm_file_tag'
  | 'seed_image'
  | 'commons_category'
  | 'osm_category_tag'
  | 'geosearch'
  | 'openverse_search'
  | 'flickr_geo';

export interface SpotRef {
  /** spots.id in the DB. */
  spot_id: string;
  name: string;
  lat: number;
  lng: number;
  wikidata?: string;
  osm?: string;
}

/** Metadata-only candidate, as written by discover.ts. */
export interface PhotoCandidate {
  source: PhotoSource;
  /** Commons: 'File:Title.jpg'; Openverse: uuid; Flickr: photo id. */
  source_id: string;
  via: Via;
  title: string;
  description: string;
  categories: string[];
  assessments: string[];
  mime: string;
  width: number;
  height: number;
  /** URL that is downloaded (a ≤1280 px rendition when the source offers one). */
  download_url: string;
  download_width: number;
  download_height: number;
  license_raw: string;
  license: NormalisedLicence | null;
  license_url: string | null;
  author: string | null;
  attribution_url: string;
  distance_m: number | null;
  /** Filled by the metadata filter. */
  rejected?: string;
  quality_score?: number;
}

export interface SpotCandidates {
  spot: SpotRef;
  candidates: PhotoCandidate[];
  discovered_at: string;
  errors?: string[];
}
