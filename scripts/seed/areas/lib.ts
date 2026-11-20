// Plan 116 §7 / Plan 46 §4: pure logic for the national admin-area import.
// No I/O here: parsing, name normalisation, PSGC <-> COD-AB matching and id assignment,
// so all of it is unit-tested (tests/seed-areas-lib.test.ts).

export type Level = 'region' | 'province' | 'town' | 'barangay';

export const MIN_ZOOM: Record<Level, number> = { region: 5, province: 7, town: 9, barangay: 13 };
export const LEVEL_ORDER: Level[] = ['region', 'province', 'town', 'barangay'];

/** One PSGC row (PSA publication). `code` is the 10-digit code, `level` the PSA geographic level. */
export interface PsgcEntry {
  code: string;
  name: string;
  /** 'Reg' | 'Prov' | 'City' | 'Mun' | 'SubMun' | 'Bgy' | '' (SGA and "City of Isabela (Not a Province)") */
  level: string;
  oldName: string | null;
  cityClass: string | null;
}

/** One COD-AB feature from the bundle (geometry already validated and simplified by build-bundle.sql). */
export interface SourceFeature {
  /** COD-AB admin level: 2 province/district, 3 city/municipality, 4 barangay */
  lvl: 2 | 3 | 4;
  /** COD-AB pcode expanded to the 10-digit PSGC form (PH0105518 -> 0105518000) */
  pcode: string;
  name: string;
  /** expanded pcode of the COD-AB parent (adm2 for adm3, adm3 for adm4, adm1 region for adm2) */
  parent: string;
  /** matching-grade geometry (GeoJSON text) */
  geom: string;
  /** display geometry (GeoJSON text) */
  boundary: string;
}

/** A row of the existing Pangasinan import, copied verbatim from the old production copy. */
export interface OldArea {
  id: string;
  psgc_code: string | null;
  level: Level;
  name: string;
  display_name: string;
  parent_id: string | null;
  has_boundary: boolean;
  label_lat: number;
  label_lng: number;
  bbox: number[];
  min_zoom: number;
  shape_file: string | null;
  data_version: string;
  boundary: unknown;
}

export interface AreaRow {
  id: string;
  psgc_code: string | null;
  level: Level;
  name: string;
  display_name: string;
  parent_id: string | null;
  /** 10-digit PSGC code of the region this row belongs to (transaction unit) */
  region: string;
  min_zoom: number;
  shape_file: string | null;
  data_version: string;
  /** matching-grade GeoJSON; null for regions (built in SQL from provinces) or rows without a boundary */
  geom: string | null;
  /** display GeoJSON (text). For preserved Pangasinan rows the old JSON is kept as-is. */
  boundary: string | null;
  /** preserved rows keep label/bbox/has_boundary from the old copy; new rows derive them in SQL */
  preserved: null | { label_lat: number; label_lng: number; bbox: number[]; has_boundary: boolean };
  /** COD-AB pcode the geometry came from (for reports) */
  source_pcode: string | null;
}

export interface GapEntry {
  level: Level;
  code: string;
  name: string;
  parent: string | null;
  reason: string;
}

export interface Plan {
  rows: AreaRow[];
  psgcWithoutBoundary: GapEntry[];
  boundariesWithoutPsgc: GapEntry[];
  matchedBy: Record<string, number>;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Parsing

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF/LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parses the PSGC CSV written from the psgc R package (columns psgc_code, area_name, ..., NA = null). */
export function parsePsgcCsv(text: string): PsgcEntry[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  const col = (n: string) => {
    const i = header.indexOf(n);
    if (i < 0) throw new Error(`PSGC CSV lacks column ${n}`);
    return i;
  };
  const [ci, ni, li, oi, cc] = ['psgc_code', 'area_name', 'geographic_level', 'old_name', 'city_class'].map(col);
  const na = (v: string | undefined) => (v === undefined || v === 'NA' ? null : v);
  return rows
    .filter((r) => r.length > 1)
    .map((r) => {
      const code = r[ci].padStart(10, '0');
      if (!/^\d{10}$/.test(code)) throw new Error(`Bad PSGC code ${r[ci]}`);
      return { code, name: r[ni].trim(), level: na(r[li]) ?? '', oldName: na(r[oi]), cityClass: na(r[cc]) };
    });
}

/** COD-AB pcode (PH01, PH01055, PH0105518, PH0105518001) -> 10-digit PSGC form. */
export function expandPcode(pcode: string): string {
  const digits = pcode.replace(/^PH/i, '');
  if (!/^\d+$/.test(digits) || ![2, 5, 7, 10].includes(digits.length)) throw new Error(`Bad pcode ${pcode}`);
  return digits.padEnd(10, '0');
}

// ---------------------------------------------------------------------------
// Names and slugs

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function slugify(text: string): string {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Removes every parenthetical: "Lingayen (Capital)" -> "Lingayen". */
export function stripParens(s: string): string {
  return s
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Display name of a city/municipality: PSGC "City of Dagupan" -> "Dagupan", drops "(Capital)". */
export function cleanTownName(name: string): string {
  return name
    .replace(/\s*\(capital\)/gi, '')
    .replace(/^city of\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Display name of a province-level unit: drops "(Not a Province)". */
export function cleanProvinceName(name: string): string {
  return name
    .replace(/\s*\(not a province\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Region id slug: "Region I (Ilocos Region)" -> "ilocos", "National Capital Region (NCR)" -> "ncr". */
export function regionSlug(name: string): string {
  const paren = /\(([^)]+)\)/.exec(name);
  const base = paren ? paren[1] : name;
  return slugify(base).replace(/-region$/, '') || slugify(name);
}

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bsto\.?(?=\s|$)/g, 'santo'],
  [/\bsta\.?(?=\s|$)/g, 'santa'],
  [/\bgen\.?(?=\s|$)/g, 'general'],
  [/\bpres\.?(?=\s|$)/g, 'president'],
  [/\bsen\.?(?=\s|$)/g, 'senator'],
  [/\bdr\.?(?=\s|$)/g, 'doctor'],
  [/\bbrgy\.?(?=\s|$)/g, 'barangay'],
  [/\bbgy\.?(?=\s|$)/g, 'barangay'],
  [/\bpob\.?(?=\s|$)/g, 'poblacion'],
  [/\bnat'?l\.?(?=\s|$)/g, 'national'],
];

const ROMAN: Record<string, string> = {
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
};

/** "Aniban II" and "Aniban 2" share a key: whole-word roman numerals I..X become digits. */
export function romanToDigits(s: string): string {
  return s.replace(/\b(viii|vii|iii|ii|iv|vi|ix|i|v|x)\b/g, (m) => ROMAN[m]);
}

/**
 * Key for name matching between PSGC and COD-AB: lower case, no accents, no parentheticals,
 * no "City of"/"City" decoration, common abbreviations expanded, letters and digits only.
 */
export function normName(name: string): string {
  let s = stripAccents(name).toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/^\s*city of\s+/, '').replace(/\s+city\s*$/, '');
  s = s.replace(/\bmetropolitan manila\b/, 'ncr');
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  s = romanToDigits(s);
  return s.replace(/[^a-z0-9]+/g, '');
}

/** Second key that keeps parenthetical text, for names that differ only inside the parentheses. */
export function normNameFull(name: string): string {
  let s = stripAccents(name).toLowerCase();
  s = s.replace(/^\s*city of\s+/, '').replace(/\s+city\s*$/, '');
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  s = romanToDigits(s);
  return s.replace(/[^a-z0-9]+/g, '');
}

// ---------------------------------------------------------------------------
// PSGC hierarchy helpers (10-digit codes RR PPP MM BBB)

export const regionCodeOf = (code: string) => `${code.slice(0, 2)}00000000`;
export const provinceCodeOf = (code: string) => `${code.slice(0, 5)}00000`;
export const townCodeOf = (code: string) => `${code.slice(0, 7)}000`;

export const isTownLevel = (e: PsgcEntry) => e.level === 'City' || e.level === 'Mun';
export const isProvinceLevel = (e: PsgcEntry) => e.level === 'Prov' || (e.level === '' && e.code.endsWith('00000'));

/** Pick a unique candidate whose key equals the target key; null if none or ambiguous. */
function uniqueBy<T>(cands: T[], key: (c: T) => string, target: string): T | null {
  const hits = cands.filter((c) => key(c) === target);
  return hits.length === 1 ? hits[0] : null;
}

/** Sørensen–Dice coefficient on character bigrams. */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let hit = 0;
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) ?? 0);
  return (2 * hit) / (a.length - 1 + (b.length - 1));
}

/**
 * Whether a PSGC name and a COD-AB name plausibly denote the same unit. Used to reject code
 * matches after renumbering (e.g. Maguindanao del Sur, where code 1908803000 is "Datu Abdullah
 * Sangki" in PSGC Q3 2026 but "Buluan" in COD-AB).
 */
export function namesCompatible(entry: PsgcEntry, featureName: string): boolean {
  const nb = normName(featureName);
  const na = normName(entry.name);
  if (na === nb || normNameFull(entry.name) === normNameFull(featureName)) return true;
  // Numbered siblings ("Aniban 1" / "Aniban 2", "Barangay 176-B" / "Barangay 176") are different units.
  const digits = (s: string) => (s.match(/\d+/g) ?? []).join(',');
  if (digits(na) !== digits(nb)) return false;
  if (entry.oldName && entry.oldName.split(/[,;]/).some((o) => normName(o) === nb)) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  return dice(na, nb) >= 0.8;
}

export interface Match {
  feature: SourceFeature;
  by: string;
}

/**
 * Match one PSGC entry to a feature: the same code with a compatible name, then a unique name
 * among the candidates (normalised, then with parentheticals, then the PSGC old name), then the
 * same code even though the name differs ('code-renamed', listed for review).
 */
export function matchFeature(
  entry: PsgcEntry,
  byCode: Map<string, SourceFeature>,
  candidates: SourceFeature[],
  taken: Set<string>,
): Match | null {
  const direct = byCode.get(entry.code);
  if (direct && !taken.has(direct.pcode) && namesCompatible(entry, direct.name)) return { feature: direct, by: 'code' };
  const byName = matchByName(entry, candidates, taken);
  if (byName) return byName;
  if (direct && !taken.has(direct.pcode)) return { feature: direct, by: 'code-renamed' };
  return null;
}

/**
 * Matches a whole level in three passes so that one entry's weak match cannot steal the feature
 * another entry matches strongly: (1) code + compatible name, (2) unique name within each
 * candidate list in turn, (3) code with a different name.
 */
export function matchLevel(
  entries: PsgcEntry[],
  byCode: Map<string, SourceFeature>,
  candidateLists: (e: PsgcEntry) => SourceFeature[][],
  taken: Set<string>,
  /** extra condition for code matches (e.g. the barangay feature must lie in the matched town) */
  codeOk: (e: PsgcEntry, f: SourceFeature) => boolean = () => true,
): Map<string, Match> {
  const out = new Map<string, Match>();
  const take = (e: PsgcEntry, m: Match) => {
    out.set(e.code, m);
    taken.add(m.feature.pcode);
  };
  for (const e of entries) {
    const f = byCode.get(e.code);
    if (f && !taken.has(f.pcode) && codeOk(e, f) && namesCompatible(e, f.name)) take(e, { feature: f, by: 'code' });
  }
  for (const e of entries) {
    if (out.has(e.code)) continue;
    for (const cands of candidateLists(e)) {
      const m = matchByName(e, cands, taken);
      if (m) {
        take(e, m);
        break;
      }
    }
  }
  for (const e of entries) {
    if (out.has(e.code)) continue;
    const f = byCode.get(e.code);
    if (f && !taken.has(f.pcode) && codeOk(e, f)) take(e, { feature: f, by: 'code-renamed' });
  }
  return out;
}

function matchByName(entry: PsgcEntry, candidates: SourceFeature[], taken: Set<string>): Match | null {
  const free = candidates.filter((c) => !taken.has(c.pcode));
  const n = uniqueBy(free, (c) => normName(c.name), normName(entry.name));
  if (n) return { feature: n, by: 'name' };
  const f = uniqueBy(free, (c) => normNameFull(c.name), normNameFull(entry.name));
  if (f) return { feature: f, by: 'name-full' };
  if (entry.oldName) {
    for (const old of entry.oldName.split(/[,;]/)) {
      const o = uniqueBy(free, (c) => normName(c.name), normName(old));
      if (o) return { feature: o, by: 'old-name' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan builder

export interface PlanInput {
  psgc: PsgcEntry[];
  features: SourceFeature[];
  old: OldArea[];
  dataVersion: string;
  /** PSGC region that receives the preserved Pangasinan rows */
  pangasinanRegion?: string;
}

class IdRegistry {
  private used = new Set<string>();
  reserve(id: string): void {
    if (this.used.has(id)) throw new Error(`Duplicate preserved id ${id}`);
    this.used.add(id);
  }
  /** `base` unless taken, then `base-<code>` (Plan 46 §4: on a duplicate slug append the PSGC code). */
  claim(base: string, code: string | null): string {
    let id = base;
    if (this.used.has(id)) id = `${base}-${code ?? 'x'}`;
    let n = 2;
    while (this.used.has(id)) id = `${base}-${code ?? 'x'}-${n++}`;
    this.used.add(id);
    return id;
  }
}

export function buildPlan(input: PlanInput): Plan {
  const { psgc, features, old, dataVersion } = input;
  const pangasinanRegion = input.pangasinanRegion ?? '0100000000';
  const notes: string[] = [];
  const matchedBy: Record<string, number> = {};
  const count = (k: string) => (matchedBy[k] = (matchedBy[k] ?? 0) + 1);

  const byCode = new Map<string, PsgcEntry>(psgc.map((e) => [e.code, e]));
  const featByLvl = (l: 2 | 3 | 4) => features.filter((f) => f.lvl === l);
  const featCode = (l: 2 | 3 | 4) => new Map(featByLvl(l).map((f) => [f.pcode, f]));
  const f2 = featByLvl(2);
  const f3 = featByLvl(3);
  const f4 = featByLvl(4);
  const f2Code = featCode(2);
  const f3Code = featCode(3);
  const f4Code = featCode(4);
  const childrenOf = new Map<string, SourceFeature[]>();
  for (const f of [...f3, ...f4]) {
    const list = childrenOf.get(f.parent) ?? [];
    list.push(f);
    childrenOf.set(f.parent, list);
  }
  const taken = new Set<string>();

  const ids = new IdRegistry();
  const oldByCode = new Map<string, OldArea>();
  for (const o of old) {
    ids.reserve(o.id);
    if (o.psgc_code) oldByCode.set(String(o.psgc_code).padStart(10, '0'), o);
  }
  const oldUsed = new Set<string>();

  const rows: AreaRow[] = [];
  const psgcWithoutBoundary: GapEntry[] = [];
  const rowByCode = new Map<string, AreaRow>();
  const featureOfRow = new Map<AreaRow, SourceFeature | null>();

  const pushRow = (row: AreaRow, feature: SourceFeature | null) => {
    rows.push(row);
    if (row.psgc_code) rowByCode.set(row.psgc_code, row);
    featureOfRow.set(row, feature);
    if (feature) taken.add(feature.pcode);
  };

  // Preserved rows keep their parent; only the province gains the region as parent.
  const preservedRow = (
    o: OldArea,
    region: string,
    parentId: string | null,
    feature: SourceFeature | null,
  ): AreaRow => {
    oldUsed.add(o.id);
    if (o.level !== 'province' && parentId !== o.parent_id) {
      notes.push(`preserved ${o.id}: PSGC parent ${parentId} differs from old parent ${o.parent_id}; old parent kept`);
      parentId = o.parent_id;
    }
    return {
      id: o.id,
      psgc_code: o.psgc_code ? String(o.psgc_code).padStart(10, '0') : null,
      level: o.level,
      name: o.name,
      display_name: o.display_name,
      parent_id: parentId,
      region,
      min_zoom: o.min_zoom,
      shape_file: o.shape_file,
      data_version: o.data_version,
      geom: feature ? feature.geom : o.boundary ? JSON.stringify(o.boundary) : null,
      boundary: o.boundary == null ? null : JSON.stringify(o.boundary),
      preserved: { label_lat: o.label_lat, label_lng: o.label_lng, bbox: o.bbox, has_boundary: o.has_boundary },
      source_pcode: feature ? feature.pcode : null,
    };
  };

  // 1. Regions (geometry is the union of their provinces, built in SQL).
  const regions = psgc.filter((e) => e.level === 'Reg').sort((a, b) => a.code.localeCompare(b.code));
  const regionRow = new Map<string, AreaRow>();
  for (const r of regions) {
    const row: AreaRow = {
      id: ids.claim(`region-${regionSlug(r.name)}`, r.code),
      psgc_code: r.code,
      level: 'region',
      name: r.name,
      display_name: r.name,
      parent_id: null,
      region: r.code,
      min_zoom: MIN_ZOOM.region,
      shape_file: null,
      data_version: dataVersion,
      geom: null,
      boundary: null,
      preserved: null,
      source_pcode: null,
    };
    regionRow.set(r.code, row);
    pushRow(row, null);
  }

  // 2. Province-level units: PSGC provinces (+ SGA / City of Isabela pseudo-provinces).
  const provinces = psgc.filter(isProvinceLevel).sort((a, b) => a.code.localeCompare(b.code));
  const provinceDisplay = new Map<string, string>(); // row id -> label used in town display names
  const provinceMatches = matchLevel(provinces, f2Code, () => [f2], taken);
  for (const p of provinces) {
    const region = regionRow.get(regionCodeOf(p.code));
    if (!region) throw new Error(`Province ${p.code} ${p.name} has no region`);
    const m = provinceMatches.get(p.code);
    if (m) count(`province:${m.by}`);
    const o = oldByCode.get(p.code);
    let row: AreaRow;
    if (o) {
      row = preservedRow(o, region.region, region.id, m?.feature ?? null);
    } else {
      const name = cleanProvinceName(p.name);
      row = newRow(
        ids.claim(slugify(name), p.code),
        p.code,
        'province',
        name,
        name,
        region.id,
        region.region,
        m?.feature ?? null,
        dataVersion,
      );
    }
    if (!m && !o) {
      psgcWithoutBoundary.push({
        level: 'province',
        code: p.code,
        name: p.name,
        parent: region.id,
        reason: 'no COD-AB adm2 match',
      });
      continue;
    }
    provinceDisplay.set(row.id, row.name);
    pushRow(row, m?.feature ?? null);
  }

  // NCR districts: COD-AB adm2 units with no PSGC row (PSGC Q3 2026 lists NCR cities directly under the region).
  const ncrRegion = regionRow.get('1300000000');
  const ncrDistrictRow = new Map<string, AreaRow>(); // COD-AB pcode -> row
  if (ncrRegion) {
    for (const f of f2.filter((x) => x.pcode.startsWith('13') && !taken.has(x.pcode))) {
      const name = f.name.replace(/^Metropolitan Manila\b/, 'Metro Manila');
      const row = newRow(
        ids.claim(slugify(name), null),
        null,
        'province',
        name,
        name,
        ncrRegion.id,
        ncrRegion.region,
        f,
        dataVersion,
      );
      count('province:ncr-district');
      provinceDisplay.set(row.id, 'Metro Manila');
      ncrDistrictRow.set(f.pcode, row);
      pushRow(row, f);
    }
  }
  const provinceRowOfFeature = new Map<string, AreaRow>();
  for (const row of rows) {
    const f = featureOfRow.get(row);
    if (row.level === 'province' && f) provinceRowOfFeature.set(f.pcode, row);
  }

  // 3. Cities / municipalities.
  const towns = psgc.filter(isTownLevel).sort((a, b) => a.code.localeCompare(b.code));
  const psgcProvOf = (t: PsgcEntry) => {
    const provCode = provinceCodeOf(t.code);
    return provCode !== t.code ? rowByCode.get(provCode) : undefined;
  };
  const townMatches = matchLevel(
    towns,
    f3Code,
    (t) => {
      const pf = psgcProvOf(t) ? featureOfRow.get(psgcProvOf(t)!) : null;
      // PSGC province's COD-AB children first; then (moved units, HUCs, NCR) the same region, then anywhere.
      const own = pf ? (childrenOf.get(pf.pcode) ?? []).filter((c) => c.lvl === 3) : [];
      return [own, f3.filter((f) => f.pcode.slice(0, 2) === t.code.slice(0, 2)), f3];
    },
    taken,
  );
  for (const t of towns) {
    const region = regionRow.get(regionCodeOf(t.code));
    if (!region) throw new Error(`Town ${t.code} has no region`);
    const psgcProv = psgcProvOf(t);
    const m = townMatches.get(t.code);
    if (m) count(`town:${m.by}${psgcProv ? '' : ':independent'}`);
    // Parent: PSGC province, else the COD-AB province/district that contains the city (HUCs, NCR).
    let parent = psgcProv;
    if (!parent && m) parent = provinceRowOfFeature.get(m.feature.parent);
    if (parent && parent.region !== region.region && !psgcProv) {
      notes.push(`${t.code} ${t.name}: geographic province ${parent.id} is in another region; parented to the region`);
      parent = undefined;
    }
    const parentRow = parent ?? region;
    const o = oldByCode.get(t.code);
    let row: AreaRow;
    if (o) {
      row = preservedRow(o, region.region, parentRow.id, m?.feature ?? null);
    } else {
      const name = cleanTownName(t.name);
      const label = provinceDisplay.get(parentRow.id) ?? parentRow.name;
      const base = `${parentRow.id}--${slugify(name)}`;
      row = newRow(
        ids.claim(base, t.code),
        t.code,
        'town',
        name,
        `${name}, ${label}`,
        parentRow.id,
        region.region,
        m?.feature ?? null,
        dataVersion,
      );
    }
    if (!m && !o) {
      psgcWithoutBoundary.push({
        level: 'town',
        code: t.code,
        name: t.name,
        parent: parentRow.id,
        reason: 'no COD-AB adm3 match (no row; its barangays are listed too)',
      });
      continue;
    }
    if (!parent) notes.push(`${t.code} ${t.name}: no province-level parent; parented to ${region.id}`);
    pushRow(row, m?.feature ?? null);
  }

  // 4. Barangays (only those with a boundary get a row; the rest go to the gap report).
  const barangays = psgc.filter((e) => e.level === 'Bgy').sort((a, b) => a.code.localeCompare(b.code));
  const townOf = (code: string): AreaRow | undefined => {
    const direct = byCode.get(townCodeOf(code));
    if (direct && isTownLevel(direct)) return rowByCode.get(direct.code);
    if (direct && direct.level === 'SubMun') return rowByCode.get(provinceCodeOf(code)); // Manila sub-municipalities
    return undefined;
  };
  const barangayMatches = matchLevel(
    barangays,
    f4Code,
    (b) => {
      const town = townOf(b.code);
      const tf = town ? featureOfRow.get(town) : null;
      return tf ? [(childrenOf.get(tf.pcode) ?? []).filter((c) => c.lvl === 4)] : [];
    },
    taken,
    (b, f) => {
      const town = townOf(b.code);
      return !!town && featureOfRow.get(town)?.pcode === f.parent;
    },
  );
  for (const b of barangays) {
    const town = townOf(b.code);
    if (!town) {
      psgcWithoutBoundary.push({
        level: 'barangay',
        code: b.code,
        name: b.name,
        parent: null,
        reason: byCode.has(townCodeOf(b.code)) ? 'parent town has no boundary (no row)' : 'no parent town in PSGC',
      });
      continue;
    }
    const tf = featureOfRow.get(town);
    const m = barangayMatches.get(b.code) ?? null;
    const o = oldByCode.get(b.code);
    if (!m && !o) {
      psgcWithoutBoundary.push({
        level: 'barangay',
        code: b.code,
        name: b.name,
        parent: town.id,
        reason: tf ? 'no COD-AB adm4 match in parent town' : 'parent town has no boundary',
      });
      continue;
    }
    if (m) count(`barangay:${m.by}`);
    const row = o
      ? preservedRow(o, town.region, town.id, m?.feature ?? null)
      : newRow(
          ids.claim(`${town.id}--${slugify(b.name) || 'barangay'}`, b.code),
          b.code,
          'barangay',
          b.name,
          `${b.name}, ${town.name}`,
          town.id,
          town.region,
          m!.feature,
          dataVersion,
        );
    if (o && !m)
      psgcWithoutBoundary.push({
        level: 'barangay',
        code: b.code,
        name: b.name,
        parent: town.id,
        reason: 'preserved row; old boundary kept as geom',
      });
    pushRow(row, m?.feature ?? null);
  }

  // 5. Preserved rows the PSGC no longer lists (kept unchanged so spot references survive).
  const featByLevel: Record<Level, Map<string, SourceFeature>> = {
    region: new Map(),
    province: f2Code,
    town: f3Code,
    barangay: f4Code,
  };
  for (const o of old) {
    if (oldUsed.has(o.id)) continue;
    const code = o.psgc_code ? String(o.psgc_code).padStart(10, '0') : null;
    const f = code ? featByLevel[o.level].get(code) : undefined;
    const feature = f && !taken.has(f.pcode) ? f : null;
    const parentId = o.level === 'province' ? (regionRow.get(pangasinanRegion)?.id ?? null) : o.parent_id;
    const parent = rows.find((r) => r.id === parentId);
    if (parentId && !parent) throw new Error(`Preserved ${o.id} lost its parent ${parentId}`);
    notes.push(`preserved ${o.id} (${o.psgc_code}) is not in the PSGC release; kept`);
    pushRow(preservedRow(o, parent?.region ?? pangasinanRegion, parentId, feature), feature);
  }

  // Parents must precede children inside a level-ordered upsert; preserved rows can arrive late.
  rows.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));

  const boundariesWithoutPsgc: GapEntry[] = features
    .filter((f) => !taken.has(f.pcode))
    .map((f) => ({
      level: f.lvl === 2 ? 'province' : f.lvl === 3 ? 'town' : 'barangay',
      code: f.pcode,
      name: f.name,
      parent: f.parent,
      reason: 'COD-AB feature not matched to a PSGC entry',
    }));

  return { rows, psgcWithoutBoundary, boundariesWithoutPsgc, matchedBy, notes };
}

function newRow(
  id: string,
  code: string | null,
  level: Level,
  name: string,
  displayName: string,
  parentId: string | null,
  region: string,
  feature: SourceFeature | null,
  dataVersion: string,
): AreaRow {
  return {
    id,
    psgc_code: code,
    level,
    name,
    display_name: displayName,
    parent_id: parentId,
    region,
    min_zoom: MIN_ZOOM[level],
    shape_file: null,
    data_version: dataVersion,
    geom: feature ? feature.geom : null,
    boundary: feature ? feature.boundary : null,
    preserved: null,
    source_pcode: feature ? feature.pcode : null,
  };
}

/** Counts per region and level, for the dry-run table. */
export function countsByRegion(rows: AreaRow[]): Map<string, Record<Level, number>> {
  const out = new Map<string, Record<Level, number>>();
  for (const r of rows) {
    const c = out.get(r.region) ?? { region: 0, province: 0, town: 0, barangay: 0 };
    c[r.level]++;
    out.set(r.region, c);
  }
  return out;
}

/** --region accepts 'all', a 10-digit PSGC region code, a 2-digit prefix or a region id. */
export function regionFilter(arg: string, regionRows: AreaRow[]): string[] {
  if (arg === 'all') return regionRows.map((r) => r.region);
  const hit = regionRows.find(
    (r) =>
      r.region === arg || r.region === `${arg.padStart(2, '0')}00000000` || r.id === arg || r.id === `region-${arg}`,
  );
  if (!hit) throw new Error(`Unknown region ${arg}`);
  return [hit.region];
}
