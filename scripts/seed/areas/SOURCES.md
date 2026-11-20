# National admin areas: sources and licences (Plan 116 §7)

Recorded 2026-11-20 by the Plan 116 "areas" subagent. Raw downloads live in WSL
`~/jdq-seed/national-116/areas/raw/` (never in git).

## Codes and names: PSA PSGC, 3rd quarter 2026 (`Q3_2026`)

- Publisher: Philippine Statistics Authority (PSA), Philippine Standard Geographic Code.
  Official page: https://psa.gov.ph/classification/psgc
- `psa.gov.ph` answered our identified client (`JuanderQuestSeed/1.0`) with a Cloudflare
  "Just a moment..." challenge (HTTP 403) on 2026-11-20. We did not try to get past it.
- Copy used: the `Q3_2026` release bundled in the CRAN package **psgc 0.2.0**
  (Bhas Abdulsamad, MIT licence for the package; the data is PSA's official classification),
  file `R/sysdata.rda` from https://github.com/cran/psgc (commit
  `495c85ae246abdc47313d6d8eecb1eaf323e0771`, published on CRAN 2026-11-17). It was converted to
  CSV with `rocker/r-ver:4.4.2` (`psgc_releases$Q3_2026` -> `psgc-Q3_2026.csv`).
- Q3 2026 contents: 18 regions (including the Negros Island Region, NIR, code 18), 82 provinces,
  149 cities + 1,493 municipalities, 14 Manila sub-municipalities, 42,010 barangays, plus two
  province-level pseudo-units with an empty level: Special Geographic Area (1999900000) and
  City of Isabela (Not a Province) (0990100000). PSGC Q3 2026 has no NCR district rows.
- The orchestrator should compare this file with the PSA original when psa.gov.ph is reachable
  in a normal browser (owner action), and replace it if they differ.

## Boundaries: PSA / NAMRIA COD-AB on HDX (`cod-ab-phl`), version v03

- Dataset: "Philippines - Subnational Administrative Boundaries",
  https://data.humdata.org/dataset/cod-ab-phl (OCHA FISS; source NAMRIA and PSA).
  HDX metadata last modified 2026-05-28; features `version = v03`, `valid_on = 2025-02-13`.
  File used: `phl_admin_boundaries.gdb.zip` (360,586,879 bytes), layers `phl_admin2..4`
  (88 province-level, 1,642 city/municipality, 42,048 barangay polygons).
- **Licence: Creative Commons Attribution for Intergovernmental Organisations 3.0 (CC BY-IGO 3.0)**,
  `license_id = cc-by-igo`, legal code http://creativecommons.org/licenses/by/3.0/igo/legalcode.
  Section 3 grants "a worldwide, royalty-free, non-exclusive license to exercise the rights in
  the Work ... to Reproduce, Distribute and Publicly Perform the Work, to incorporate the Work
  into one or more Collections", and for adaptations "provided that You clearly label, demarcate
  or otherwise identify that changes were made to the original Work". There is no non-commercial
  restriction. Section 4(b) requires keeping attributions the licensor asks for and "a credit
  identifying the use of the Work in the Adaptation".
- Decision: **COD-AB is used** (commercial reuse with attribution is allowed). OSM boundaries
  were not needed.
- HDX caveat: the NIR province polygons were restored to Regions VI/VII in COD-AB; PSGC Q3 2026
  has NIR again, so NIR, Sulu (now Region IX in PSGC) and the renumbered areas are matched by name
  (see `lib.ts`).
- Changes we make (must be labelled per the licence): geometries are made valid and
  coverage-simplified (`build-bundle.sql`); region polygons are the union of their provinces;
  names and codes come from PSGC, not COD-AB.

## Attribution text (web/app)

Plan 46 §11 already shows "Boundaries: PSA / NAMRIA (indicative)". To meet CC BY-IGO the
credit should read:

> Administrative boundaries: PSA and NAMRIA via OCHA HDX (COD-AB, CC BY-IGO 3.0), simplified and
> adapted by JuanderQuest. Codes and names: PSA PSGC (Q3 2026).

## Launch scope (owner, 2026-11-20)

Launch is Region I (Ilocos Region, PSGC 0100000000) only. The bundle and the plan are built
for the whole country (matching needs the national COD-AB set), but only `--region 01` was
applied and validated. Other regions are added later with `--region <psgc>`; their dry-run
counts and gap report were produced once but not reviewed.

## Preserved rows

The 1,413 Pangasinan rows (1 province, 48 towns, 1,364 barangays) are copied from the old
production copy (`jdq_old_copy.admin_areas`, data version `2023-psa-namria`, faeldon/
philippines-json-maps 2023 = PSA/NAMRIA COD-AB). Their id, name, display name, parent, label,
bbox, min zoom, shape file, data version and `boundary` JSON stay as they were; `geom` comes from
the COD-AB v03 polygon with the same PSGC code, and `pangasinan` gets `region-ilocos` as parent.
