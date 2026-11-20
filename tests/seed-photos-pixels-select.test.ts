import {
  blurhashEncode,
  dHash,
  dominantColor,
  hamming,
  toSignedInt64,
  toUnsignedInt64,
} from '../scripts/seed/photos/pixels';
import { assignOwnership, choosePhotos, haversineM } from '../scripts/seed/photos/select';
import type { PhotoCandidate, SpotCandidates } from '../scripts/seed/photos/types';

describe('dHash', () => {
  it('sets a bit where the left pixel is brighter', () => {
    const g = new Uint8Array(72);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) g[y * 9 + x] = 255 - x * 20; // decreasing → all 1s
    expect(dHash(g)).toBe((1n << 64n) - 1n);
    const flat = new Uint8Array(72).fill(100);
    expect(dHash(flat)).toBe(0n);
  });
  it('round-trips through signed BIGINT', () => {
    const u = (1n << 63n) + 5n;
    expect(toSignedInt64(u) < 0n).toBe(true);
    expect(toUnsignedInt64(toSignedInt64(u))).toBe(u);
  });
  it('counts differing bits', () => {
    expect(hamming(0n, 0b1011n)).toBe(3);
    expect(hamming(-1n, 0n)).toBe(64);
  });
});

describe('blurhash + dominant colour', () => {
  it('encodes a uniform image with zero AC terms and the right length', () => {
    const w = 8;
    const h = 6;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) rgb.set([200, 100, 50], i * 3);
    const hash = blurhashEncode(rgb, w, h, 4, 3);
    expect(hash).toHaveLength(1 + 1 + 4 + 2 * 11);
    expect(hash[0]).toBe('L'); // (4-1) + (3-1)*9 = 21 → 'L'
    expect(dominantColor(rgb)).toBe('#c86432');
  });
  it('is stable for the same pixels', () => {
    const rgb = new Uint8Array(4 * 4 * 3).map((_, i) => (i * 37) % 256);
    expect(blurhashEncode(rgb, 4, 4)).toBe(blurhashEncode(rgb, 4, 4));
  });
  it('ignores near-white/black when choosing the dominant colour', () => {
    const rgb = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 10, 120, 200]);
    expect(dominantColor(rgb)).toBe('#0a78c8');
  });
});

const photo = (id: string, score: number, phash: bigint, w = 2000, h = 1500) => ({
  source_id: id,
  quality_score: score,
  width: w,
  height: h,
  phash,
});

describe('choosePhotos', () => {
  it('dedupes near-identical photos, caps at 5, one primary at sort 0', () => {
    const ps = [
      photo('a', 0.9, 0n),
      photo('a-dup', 0.8, 0b111n), // 3 bits from a
      photo('b', 0.7, 0xffffn),
      photo('c', 0.6, 0xffff0000n),
      photo('d', 0.5, 0xffff00000000n),
      photo('e', 0.4, 0xffff000000000000n),
      photo('f', 0.3, 0xf0f0f0f0f0f0f0f0n),
    ];
    const { accepted, rejected } = choosePhotos(ps);
    expect(accepted.map((p) => p.source_id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(accepted.filter((p) => p.is_primary)).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ source_id: 'a', is_primary: true, sort_order: 0 });
    expect(rejected.map((r) => [r.photo.source_id, r.reason])).toEqual([
      ['a-dup', 'phash_dup_spot'],
      ['f', 'over_limit'],
    ]);
  });
  it('picks a hero-sized primary over a better-scored small photo', () => {
    const { accepted } = choosePhotos([photo('small', 0.9, 0n, 900, 700), photo('big', 0.5, -1n, 3000, 2000)]);
    expect(accepted[0].source_id).toBe('big');
    expect(accepted[0].is_primary).toBe(true);
    expect(accepted[1]).toMatchObject({ source_id: 'small', is_primary: false, sort_order: 1 });
  });
  it('rejects duplicates of a neighbouring spot photo', () => {
    const { accepted, rejected } = choosePhotos([photo('x', 0.9, 0n)], [1n]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe('phash_dup_neighbour');
  });
});

describe('assignOwnership', () => {
  const c = (id: string, via: PhotoCandidate['via'], dist: number) =>
    ({ source: 'commons', source_id: id, via, distance_m: dist }) as PhotoCandidate;
  const sc = (spot: string, cands: PhotoCandidate[]): SpotCandidates => ({
    spot: { spot_id: spot, name: spot, lat: 0, lng: 0 },
    candidates: cands,
    discovered_at: '',
  });
  it('gives a shared file to the strongest link, then the nearest spot', () => {
    const own = assignOwnership([
      sc('s1', [c('F1', 'geosearch', 10), c('F2', 'geosearch', 300)]),
      sc('s2', [c('F1', 'wikidata_p18', 400), c('F2', 'geosearch', 50)]),
    ]);
    expect(own.get('commons:F1')).toBe('s2');
    expect(own.get('commons:F2')).toBe('s2');
  });
});

describe('haversineM', () => {
  it('is about 111 km per degree of latitude', () => {
    expect(Math.round(haversineM(16, 120, 17, 120) / 1000)).toBe(111);
  });
});
