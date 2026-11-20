import { parseCredit } from '../scripts/seed/photos/backfill-pangasinan';
import { samePlace } from '../scripts/seed/photos/load-test-spots';
import { seededSample } from '../scripts/seed/photos/visual-check';

describe('parseCredit (migrations 038–040 source_name)', () => {
  it('splits author and licence', () => {
    expect(parseCredit('Photo: Ralff Nestor Nacor · CC BY-SA 4.0')).toEqual({
      author: 'Ralff Nestor Nacor',
      license: 'CC BY-SA 4.0',
    });
    expect(parseCredit('Photo: User:Beltugade · Public domain')).toEqual({ author: 'Beltugade', license: 'PD' });
    expect(parseCredit('Photo: JasDolt · CC0')).toEqual({ author: 'JasDolt', license: 'CC0' });
    expect(parseCredit('Pangasinan PTCAO')).toEqual({ author: null, license: null });
  });
});

describe('samePlace', () => {
  it('matches identical names up to 10 km and distinctive names within 500 m', () => {
    const a = { name: 'Hundred Islands National Park', lat: 16.2063, lng: 119.9706 };
    expect(samePlace(a, { name: 'Hundred Islands National Park', lat: 16.2, lng: 120.0333 })).toBe(true);
    expect(
      samePlace(
        { name: 'Cape Bolinao Lighthouse', lat: 16.33, lng: 119.79 },
        { name: 'Bolinao Lighthouse', lat: 16.331, lng: 119.79 },
      ),
    ).toBe(true);
    expect(
      samePlace(
        { name: 'Cape Bolinao Lighthouse', lat: 16.33, lng: 119.79 },
        { name: 'Bolinao Falls', lat: 16.331, lng: 119.79 },
      ),
    ).toBe(false);
    expect(samePlace({ name: 'Beach', lat: 16.33, lng: 119.79 }, { name: 'Beach', lat: 16.5, lng: 119.79 })).toBe(
      false,
    );
  });
});

describe('seededSample', () => {
  it('is reproducible and bounded', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    expect(seededSample(xs, 10, 116)).toEqual(seededSample(xs, 10, 116));
    expect(new Set(seededSample(xs, 10, 116)).size).toBe(10);
    expect(seededSample(xs, 500, 1)).toHaveLength(100);
  });
});
