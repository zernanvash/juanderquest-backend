# Map Data Generation Pipeline & Scripts

This directory contains the reproducible scripts for generating vector map basemaps, administrative boundary extracts, and importing administrative boundaries into the JuanDerQuest database.

---

## 1. Pipeline Overview

```
                      OSM PBF Source (~/valhalla-ph/philippines-latest.osm.pbf)
                                            │
                                            ▼
                               [build-vector-tiles.sh]
                                            │
                                            ▼
                      Planetiler Vector PMTiles (~/jdq-maps/philippines.pmtiles)
                                            │
                                            ▼
                        Martin Vector Tile Server (Port 3011 preview / 3010 prod)

-----------------------------------------------------------------------------------------

                 PSA / NAMRIA COD-AB via faeldon/philippines-json-maps
                                            │
                                            ▼
                               [fetch-psa-barangays.cjs]
                                            │
                                            ▼
                         mapshaper Simplification (5% retained)
                                            │
                                            ▼
                       Simplified GeoJSON (~/jdq-maps/areas/{towns,barangays}.geojson)
                                            │
                                            ▼
                      [import-admin-areas.sh / import-admin-areas.ts]
                                            │
                                            ▼
                     PostgreSQL `admin_areas` & `spots` foreign keys
```

---

## 2. Scripts Reference

### `build-vector-tiles.sh`
- Runs Planetiler inside Docker to convert `philippines-latest.osm.pbf` into `philippines.pmtiles` (zoom 0–15).
- Output: `~/jdq-maps/philippines.pmtiles` (~829 MB).

### `fetch-psa-barangays.cjs`
- Downloads official PSA/NAMRIA administrative boundaries from `faeldon/philippines-json-maps` for all 48 Pangasinan LGUs and 1,364 barangays.
- Runs `mapshaper` to retain 5% vertex detail for optimal client streaming while preserving accurate boundary topology.
- Output: `~/jdq-maps/areas/towns.geojson` (~70 KB) and `~/jdq-maps/areas/barangays.geojson` (~857 KB).

### `extract-admin-boundaries.sh`
- OSM boundary extraction pipeline using Dockerized `osmium-tool`. Extracts administrative boundaries into `admin-boundaries.osm.pbf`.

### `generate-coverage-report.cjs` & `detailed-lgu-report.cjs`
- Analyzes administrative boundary coverage across the 48 Pangasinan LGUs and outputs summary statistics for `docs/02-architecture/vector-map-coverage.md`.

### `import-admin-areas.sh` & `import-admin-areas.ts`
- Idempotently imports administrative areas into the `admin_areas` table inside a single PostgreSQL transaction.
- Associates existing spots with their corresponding town and barangay via ray-casting point-in-polygon matching.
- **Usage:**
  ```bash
  # Dry-run check:
  DATABASE_URL=postgres://... ./scripts/maps/import-admin-areas.sh --dry-run [--input <path-to-areas-dir>]

  # Apply changes:
  DATABASE_URL=postgres://... ./scripts/maps/import-admin-areas.sh --apply [--input <path-to-areas-dir>]
  ```
- Requires explicit `DATABASE_URL` and enforces `DB_MIGRATION_MODE=verify`.
