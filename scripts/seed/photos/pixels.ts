// Pure pixel maths on small raw buffers produced by the image processor: 64-bit dHash
// (perceptual dedupe), BlurHash encoding and dominant colour. No image library needed.

/** dHash from a 9x8 grayscale buffer (72 bytes, row-major): bit = left pixel brighter than right. */
export function dHash(gray9x8: Uint8Array | Buffer): bigint {
  if (gray9x8.length !== 72) throw new Error(`dHash needs 72 bytes, got ${gray9x8.length}`);
  let h = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      h = (h << 1n) | (gray9x8[y * 9 + x] > gray9x8[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return h;
}

/** Unsigned 64-bit hash → signed BIGINT for PostgreSQL (and back). */
export function toSignedInt64(u: bigint): bigint {
  return BigInt.asIntN(64, u);
}
export function toUnsignedInt64(s: bigint): bigint {
  return BigInt.asUintN(64, s);
}

export function hamming(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/** Hamming distance at or below this is treated as the same picture (near-duplicate). */
export const DUPLICATE_HAMMING = 10;

// ---------------------------------------------------------------- BlurHash (woltapp spec)
const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function encode83(value: number, length: number): string {
  let out = '';
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / Math.pow(83, length - i)) % 83;
    out += B83[digit];
  }
  return out;
}

function sRGBToLinear(v: number): number {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToSRGB(v: number): number {
  const x = Math.max(0, Math.min(1, v));
  return x <= 0.0031308
    ? Math.round(x * 12.92 * 255 + 0.5)
    : Math.round((1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255 + 0.5);
}

function signPow(v: number, e: number): number {
  return Math.sign(v) * Math.pow(Math.abs(v), e);
}

/** Encode an RGB (3 bytes/pixel) buffer as a BlurHash string. */
export function blurhashEncode(rgb: Uint8Array | Buffer, width: number, height: number, cx = 4, cy = 3): string {
  if (rgb.length !== width * height * 3) throw new Error('blurhash: buffer size mismatch');
  if (cx < 1 || cx > 9 || cy < 1 || cy > 9) throw new Error('blurhash: components must be 1..9');
  const factors: Array<[number, number, number]> = [];
  for (let j = 0; j < cy; j++) {
    for (let i = 0; i < cx; i++) {
      const norm = i === 0 && j === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const basis = norm * Math.cos((Math.PI * i * x) / width) * Math.cos((Math.PI * j * y) / height);
          const p = (y * width + x) * 3;
          r += basis * sRGBToLinear(rgb[p]);
          g += basis * sRGBToLinear(rgb[p + 1]);
          b += basis * sRGBToLinear(rgb[p + 2]);
        }
      }
      const scale = 1 / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }
  const [dc, ...ac] = factors;
  let hash = encode83(cx - 1 + (cy - 1) * 9, 1);
  let maxValue = 1;
  if (ac.length > 0) {
    const actualMax = Math.max(...ac.map((f) => Math.max(Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2]))));
    const quantisedMax = Math.floor(Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5))));
    maxValue = (quantisedMax + 1) / 166;
    hash += encode83(quantisedMax, 1);
  } else {
    hash += encode83(0, 1);
  }
  hash += encode83((linearToSRGB(dc[0]) << 16) + (linearToSRGB(dc[1]) << 8) + linearToSRGB(dc[2]), 4);
  for (const f of ac) {
    const q = (v: number) => Math.floor(Math.max(0, Math.min(18, Math.floor(signPow(v / maxValue, 0.5) * 9 + 9.5))));
    hash += encode83(q(f[0]) * 19 * 19 + q(f[1]) * 19 + q(f[2]), 2);
  }
  return hash;
}

/**
 * Dominant colour as '#rrggbb': the most populated 4-bit-per-channel bucket, averaged.
 * Near-white/near-black pixels are ignored unless they are all there is.
 */
export function dominantColor(rgb: Uint8Array | Buffer): string {
  const buckets = new Map<number, [number, number, number, number]>();
  const add = (skipExtremes: boolean) => {
    for (let p = 0; p + 2 < rgb.length; p += 3) {
      const r = rgb[p];
      const g = rgb[p + 1];
      const b = rgb[p + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (skipExtremes && (max < 24 || min > 235)) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = buckets.get(key) ?? [0, 0, 0, 0];
      e[0] += r;
      e[1] += g;
      e[2] += b;
      e[3] += 1;
      buckets.set(key, e);
    }
  };
  add(true);
  if (buckets.size === 0) add(false);
  let best: [number, number, number, number] | null = null;
  for (const e of buckets.values()) if (!best || e[3] > best[3]) best = e;
  if (!best) return '#000000';
  const n = best[3];
  const hex = (v: number) =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(best[0])}${hex(best[1])}${hex(best[2])}`;
}
