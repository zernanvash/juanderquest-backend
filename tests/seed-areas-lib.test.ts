import {
  OldArea,
  PsgcEntry,
  SourceFeature,
  buildPlan,
  cleanTownName,
  expandPcode,
  matchFeature,
  matchLevel,
  namesCompatible,
  normName,
  parseCsv,
  parsePsgcCsv,
  regionFilter,
  regionSlug,
  slugify,
} from '../scripts/seed/areas/lib.js';

const sq = (x: number, y: number, d = 1) =>
  JSON.stringify({
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [x, y],
          [x + d, y],
          [x + d, y + d],
          [x, y + d],
          [x, y],
        ],
      ],
    ],
  });

const feat = (lvl: 2 | 3 | 4, pcode: string, name: string, parent: string): SourceFeature => ({
  lvl,
  pcode,
  name,
  parent,
  geom: sq(120, 15),
  boundary: sq(120, 15),
});
const p = (code: string, name: string, level: string, extra: Partial<PsgcEntry> = {}): PsgcEntry => ({
  code,
  name,
  level,
  oldName: null,
  cityClass: null,
  ...extra,
});

describe('parsing', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  it('parses the PSGC CSV with NA as null', () => {
    const csv =
      '"psgc_code","area_name","correspondence_code","geographic_level","old_name","city_class","income_classification","urban_rural","island_region"\n' +
      '"0105518000","City of Dagupan","015518000","City",NA,"ICC","1st",NA,"L"\n' +
      '"1999900000","Special Geographic Area",NA,"",NA,NA,NA,NA,"M"\n';
    expect(parsePsgcCsv(csv)).toEqual([
      { code: '0105518000', name: 'City of Dagupan', level: 'City', oldName: null, cityClass: 'ICC' },
      { code: '1999900000', name: 'Special Geographic Area', level: '', oldName: null, cityClass: null },
    ]);
  });

  it('expands COD-AB pcodes to 10 digits', () => {
    expect(expandPcode('PH01')).toBe('0100000000');
    expect(expandPcode('PH01055')).toBe('0105500000');
    expect(expandPcode('PH0105518')).toBe('0105518000');
    expect(expandPcode('PH0105518022')).toBe('0105518022');
    expect(() => expandPcode('PH123')).toThrow();
  });
});

describe('names', () => {
  it('slugifies like the Pangasinan import', () => {
    expect(slugify('Sto. Niño')).toBe('sto-nino');
    expect(slugify('M. H. del Pilar')).toBe('m-h-del-pilar');
    expect(slugify('Luciente 1.0')).toBe('luciente-1-0');
  });

  it('makes region slugs', () => {
    expect(regionSlug('Region I (Ilocos Region)')).toBe('ilocos');
    expect(regionSlug('National Capital Region (NCR)')).toBe('ncr');
    expect(regionSlug('MIMAROPA Region')).toBe('mimaropa');
    expect(regionSlug('Region IV-A (CALABARZON)')).toBe('calabarzon');
    expect(regionSlug('Negros Island Region (NIR)')).toBe('nir');
  });

  it('cleans town names', () => {
    expect(cleanTownName('City of Dagupan')).toBe('Dagupan');
    expect(cleanTownName('Lingayen (Capital)')).toBe('Lingayen');
    expect(cleanTownName('Quezon City')).toBe('Quezon City');
  });

  it('normalises names for matching', () => {
    expect(normName('City of Dagupan')).toBe(normName('Dagupan City'));
    expect(normName('Sto. Niño (Pob.)')).toBe(normName('Santo Nino'));
    expect(normName('Samar (Western Samar)')).toBe(normName('Samar'));
    expect(normName('Gen. Santos')).toBe('generalsantos');
    expect(normName('Aniban II')).toBe(normName('Aniban 2'));
    expect(normName('Poblacion IV (Pob.)')).toBe('poblacion4');
  });
});

describe('matchFeature', () => {
  const a = feat(4, '0105518001', 'Bacayao Norte', '0105518000');
  const b = feat(4, '0105518002', 'Sto. Niño', '0105518000');
  const c = feat(4, '0105518003', 'San Jose', '0105518000');
  const d = feat(4, '0105518004', 'San Jose', '0105518000');
  const byCode = new Map([a, b, c, d].map((f) => [f.pcode, f]));

  it('prefers the code, then a unique name', () => {
    expect(matchFeature(p('0105518001', 'Bacayao Norte', 'Bgy'), byCode, [a, b], new Set())?.by).toBe('code');
    expect(matchFeature(p('1805518099', 'Santo Nino', 'Bgy'), byCode, [a, b], new Set())?.feature).toBe(b);
  });

  it('rejects a code match whose name differs when the name matches elsewhere (renumbering)', () => {
    // PSGC 0105518001 is "Sto. Niño" now; COD-AB still has Bacayao Norte under that code.
    expect(matchFeature(p('0105518001', 'Sto. Niño', 'Bgy'), byCode, [a, b], new Set())?.feature).toBe(b);
    expect(matchFeature(p('0105518001', 'Totally Renamed', 'Bgy'), byCode, [a, b], new Set())?.by).toBe('code-renamed');
  });

  it('matches a level in passes so strong matches win', () => {
    // Swapped codes: each entry's own code points at the other's polygon.
    const x = feat(3, '1908803000', 'Buluan', '1908800000');
    const y = feat(3, '1908802000', 'Datu Abdullah Sangki', '1908800000');
    const codes = new Map([x, y].map((f) => [f.pcode, f]));
    const entries = [p('1908802000', 'Buluan', 'Mun'), p('1908803000', 'Datu Abdullah Sangki', 'Mun')];
    const m = matchLevel(entries, codes, () => [[x, y]], new Set());
    expect(m.get('1908802000')?.feature).toBe(x);
    expect(m.get('1908803000')?.feature).toBe(y);
  });

  it('judges name compatibility', () => {
    expect(namesCompatible(p('1', 'Barangay II (Nueva)', 'Bgy'), 'Barangay II')).toBe(true);
    expect(namesCompatible(p('1', 'Datu Abdullah Sangki', 'Mun'), 'Buluan')).toBe(false);
    expect(namesCompatible(p('1', 'Aniban 2', 'Bgy'), 'Aniban I')).toBe(false);
    expect(namesCompatible(p('1', 'Aniban 1', 'Bgy'), 'Aniban I')).toBe(true);
    expect(namesCompatible(p('1', 'City of Lapu-Lapu', 'City', { oldName: 'Opon' }), 'Opon')).toBe(true);
  });

  it('refuses ambiguous names and taken features', () => {
    expect(matchFeature(p('1805518099', 'San Jose', 'Bgy'), byCode, [c, d], new Set())).toBeNull();
    expect(matchFeature(p('0105518001', 'Bacayao Norte', 'Bgy'), byCode, [a], new Set([a.pcode]))).toBeNull();
  });

  it('falls back to the old name', () => {
    expect(
      matchFeature(p('1805518099', 'New Name', 'Bgy', { oldName: 'Bacayao Norte' }), byCode, [a], new Set())?.by,
    ).toBe('old-name');
  });
});

describe('buildPlan', () => {
  const psgc: PsgcEntry[] = [
    p('0100000000', 'Region I (Ilocos Region)', 'Reg'),
    p('0105500000', 'Pangasinan', 'Prov'),
    p('0105518000', 'City of Dagupan', 'City'),
    p('0105518022', 'Pantal', 'Bgy'),
    p('0105518023', 'Brand New', 'Bgy'),
    p('0128000000', 'Ilocos Norte', 'Prov'),
    p('0128001000', 'Adams', 'Mun'),
    p('0128001001', 'Adams', 'Bgy'),
    p('0128001002', 'Poblacion', 'Bgy'),
    p('0128002000', 'Bacarra', 'Mun'),
    p('0128002001', 'Poblacion', 'Bgy'),
    p('0128002002', 'Poblacion', 'Bgy'),
    p('1300000000', 'National Capital Region (NCR)', 'Reg'),
    p('1380600000', 'City of Manila', 'City', { cityClass: 'HUC' }),
    p('1380601000', 'Tondo I/II', 'SubMun'),
    p('1380601001', 'Barangay 1', 'Bgy'),
    p('1800000000', 'Negros Island Region (NIR)', 'Reg'),
    p('1804500000', 'Negros Occidental', 'Prov'),
    p('1804501000', 'City of Bago', 'City'),
    p('1804501001', 'Abuanan', 'Bgy'),
  ];
  const features: SourceFeature[] = [
    feat(2, '0105500000', 'Pangasinan', '0100000000'),
    feat(3, '0105518000', 'Dagupan City', '0105500000'),
    feat(4, '0105518022', 'Pantal', '0105518000'),
    feat(2, '0128000000', 'Ilocos Norte', '0100000000'),
    feat(3, '0128001000', 'Adams', '0128000000'),
    feat(4, '0128001001', 'Adams', '0128001000'),
    feat(4, '0128001002', 'Poblacion', '0128001000'),
    feat(3, '0128002000', 'Bacarra', '0128000000'),
    feat(4, '0128002001', 'Poblacion', '0128002000'),
    feat(4, '0128002002', 'Poblacion', '0128002000'),
    feat(2, '1303900000', 'Metropolitan Manila First District', '1300000000'),
    feat(3, '1303901000', 'City of Manila', '1303900000'),
    feat(4, '1303901001', 'Barangay 1', '1303901000'),
    feat(2, '0604500000', 'Negros Occidental', '0600000000'),
    feat(3, '0604501000', 'Bago City', '0604500000'),
    feat(4, '0604501001', 'Abuanan', '0604501000'),
    feat(4, '0604501999', 'Orphan', '0604501000'),
  ];
  const oldRow = (id: string, code: string, level: OldArea['level'], name: string, parent: string | null): OldArea => ({
    id,
    psgc_code: code,
    level,
    name,
    display_name: name,
    parent_id: parent,
    has_boundary: true,
    label_lat: 16,
    label_lng: 120,
    bbox: [120, 16, 121, 17],
    min_zoom: level === 'province' ? 7 : level === 'town' ? 9 : 13,
    shape_file: null,
    data_version: '2023-psa-namria',
    boundary: { type: 'Polygon', coordinates: [] },
  });
  const old = [
    oldRow('pangasinan', '105500000', 'province', 'Pangasinan', null),
    oldRow('dagupan', '105518000', 'town', 'Dagupan', 'pangasinan'),
    oldRow('dagupan--pantal', '105518022', 'barangay', 'Pantal', 'dagupan'),
  ];
  const plan = buildPlan({ psgc, features, old, dataVersion: 'test' });
  const byId = new Map(plan.rows.map((r) => [r.id, r]));

  it('keeps Pangasinan ids and parents, attaching the province to Region I', () => {
    expect(byId.get('pangasinan')?.parent_id).toBe('region-ilocos');
    expect(byId.get('dagupan')?.parent_id).toBe('pangasinan');
    expect(byId.get('dagupan--pantal')?.parent_id).toBe('dagupan');
    expect(byId.get('dagupan--pantal')?.preserved?.label_lat).toBe(16);
    expect(byId.get('dagupan--pantal')?.boundary).toBe(JSON.stringify(old[2].boundary));
    expect(byId.get('dagupan--pantal')?.geom).toBe(features[2].geom);
  });

  it('builds new ids from the parent chain and appends the PSGC code on a clash', () => {
    expect(byId.get('ilocos-norte--adams')?.parent_id).toBe('ilocos-norte');
    expect(byId.get('ilocos-norte--adams--adams')).toBeDefined();
    expect(byId.get('ilocos-norte--bacarra--poblacion')?.psgc_code).toBe('0128002001');
    expect(byId.get('ilocos-norte--bacarra--poblacion-0128002002')?.psgc_code).toBe('0128002002');
  });

  it('puts NCR cities under COD-AB districts and Manila barangays under Manila', () => {
    const manila = plan.rows.find((r) => r.psgc_code === '1380600000');
    expect(manila?.parent_id).toBe('metro-manila-first-district');
    expect(manila?.id).toBe('metro-manila-first-district--manila');
    expect(manila?.display_name).toBe('Manila, Metro Manila');
    expect(plan.rows.find((r) => r.psgc_code === '1380601001')?.parent_id).toBe(manila?.id);
  });

  it('matches renumbered NIR areas by name', () => {
    const bago = plan.rows.find((r) => r.psgc_code === '1804501000');
    expect(bago?.source_pcode).toBe('0604501000');
    expect(bago?.parent_id).toBe('negros-occidental');
    expect(plan.rows.find((r) => r.psgc_code === '1804501001')?.source_pcode).toBe('0604501001');
  });

  it('reports gaps both ways', () => {
    expect(plan.psgcWithoutBoundary.map((g) => g.code)).toContain('0105518023');
    expect(plan.rows.some((r) => r.psgc_code === '0105518023')).toBe(false);
    expect(plan.boundariesWithoutPsgc.map((g) => g.code)).toEqual(['0604501999']);
  });

  it('orders parents before children and filters regions', () => {
    const order = ['region', 'province', 'town', 'barangay'];
    for (let i = 1; i < plan.rows.length; i++) {
      expect(order.indexOf(plan.rows[i].level)).toBeGreaterThanOrEqual(order.indexOf(plan.rows[i - 1].level));
    }
    const regions = plan.rows.filter((r) => r.level === 'region');
    expect(regionFilter('01', regions)).toEqual(['0100000000']);
    expect(regionFilter('region-ncr', regions)).toEqual(['1300000000']);
    expect(regionFilter('all', regions)).toHaveLength(3);
    expect(() => regionFilter('99', regions)).toThrow();
  });
});
