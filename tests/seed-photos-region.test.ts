import fs from 'fs';
import os from 'os';
import path from 'path';
import { areaContains, inScope, loadScope, toArea } from '../scripts/seed/photos/region';

const square = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

describe('region scope', () => {
  const geom = (coords: unknown) => JSON.stringify({ type: 'MultiPolygon', coordinates: coords });
  const bundle = [
    { lvl: 1, pcode: '0100000000', name: 'Ilocos Region', parent: null, geom: geom([[square(119, 15, 121, 19)]]) },
    {
      lvl: 2,
      pcode: '0105500000',
      name: 'Pangasinan',
      parent: '0100000000',
      geom: geom([[square(119.7, 15.6, 120.9, 16.5)]]),
    },
    // La Union with a hole (a lake) in it
    {
      lvl: 2,
      pcode: '0103300000',
      name: 'La Union',
      parent: '0100000000',
      geom: geom([[square(120.2, 16.5, 120.6, 17.0), square(120.3, 16.6, 120.4, 16.7)]]),
    },
    {
      lvl: 2,
      pcode: '0201500000',
      name: 'Cagayan',
      parent: '0200000000',
      geom: geom([[square(121, 17, 122.5, 18.6)]]),
    },
    {
      lvl: 3,
      pcode: '0105503000',
      name: 'Alaminos',
      parent: '0105500000',
      geom: geom([[square(119.9, 16.1, 120.0, 16.2)]]),
    },
  ];
  const file = path.join(os.tmpdir(), `codab-test-${process.pid}.ndjson`);
  beforeAll(() =>
    fs.writeFileSync(
      file,
      bundle
        .map(
          (b) =>
            `{"lvl" : ${b.lvl}, "pcode" : "${b.pcode}", "name" : "${b.name}", "parent" : ${JSON.stringify(b.parent)}, "geom" : ${JSON.stringify(b.geom)}}`,
        )
        .join('\n'),
    ),
  );
  afterAll(() => fs.rmSync(file, { force: true }));

  it('selects a region by pcode or name, or provinces by name', () => {
    expect(loadScope(file, { region: '0100000000' }).map((a) => a.name)).toEqual(['Pangasinan', 'La Union']);
    expect(loadScope(file, { region: 'Ilocos Region' }).map((a) => a.name)).toEqual(['Pangasinan', 'La Union']);
    expect(loadScope(file, { provinces: ['Cagayan'] }).map((a) => a.name)).toEqual(['Cagayan']);
    expect(() => loadScope(file, { region: 'Atlantis' })).toThrow();
  });

  it('uses point-in-polygon with holes', () => {
    const lu = toArea(bundle[2] as never);
    expect(areaContains(lu, 16.55, 120.25)).toBe(true);
    expect(areaContains(lu, 16.65, 120.35)).toBe(false); // in the hole
    expect(areaContains(lu, 18, 120.25)).toBe(false);
  });

  it('falls back to a province hint only near the province', () => {
    const areas = loadScope(file, { region: '0100000000' });
    expect(inScope(areas, 16.2, 120.0)).toBe(true);
    expect(inScope(areas, 16.2, 119.68)).toBe(false); // just offshore, no hint
    expect(inScope(areas, 16.2, 119.68, 'Pangasinan')).toBe(true); // within ~5 km of the bbox
    expect(inScope(areas, 10.0, 124.0, 'Pangasinan')).toBe(false); // wrong hint far away
    expect(inScope(areas, 18, 121.5, 'Ilocos Norte;Cagayan')).toBe(false);
  });
});
