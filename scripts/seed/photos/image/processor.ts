// Image processing behind one interface so the backend can swap engines:
//  - 'sharp'  : preferred; needs the npm dependency `sharp` (NOT in package.json today).
//  - 'pillow' : works now; shells out to system python3 + Pillow (python3-pil, WebP enabled).
// Both return WebP variants (no upscaling) plus small raw buffers; dHash, BlurHash and the
// dominant colour are computed in TypeScript (pixels.ts) so the result is engine-independent.
import { execFile } from 'child_process';
import { createRequire } from 'module';
import path from 'path';

export const VARIANT_WIDTHS = [320, 640, 1280] as const;

export interface Variant {
  label: string;
  width: number;
  height: number;
  path: string;
  bytes: number;
}

export interface ProcessedImage {
  width: number;
  height: number;
  variants: Variant[];
  gray9x8: Buffer;
  small: { width: number; height: number; rgb: Buffer };
}

export interface ImageProcessor {
  readonly name: 'pillow' | 'sharp';
  process(input: string, outDir: string, baseName: string): Promise<ProcessedImage>;
}

export class PillowProcessor implements ImageProcessor {
  readonly name = 'pillow' as const;
  private readonly worker = path.join(__dirname, 'pillow_worker.py');

  process(input: string, outDir: string, baseName: string): Promise<ProcessedImage> {
    return new Promise((resolve, reject) => {
      execFile(
        'python3',
        ['-I', this.worker, input, outDir, baseName, VARIANT_WIDTHS.join(',')],
        { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
        (err, stdout) => {
          let out: {
            error?: string;
            width: number;
            height: number;
            variants: Variant[];
            gray9x8: string;
            small: { width: number; height: number; rgb: string };
          };
          try {
            out = JSON.parse(stdout.trim().split('\n').pop() || '{}');
          } catch {
            return reject(new Error(`decode_failed: ${err?.message ?? 'no output'}`));
          }
          if (out.error || err) return reject(new Error(`decode_failed: ${out.error ?? err?.message}`));
          resolve({
            width: out.width,
            height: out.height,
            variants: out.variants,
            gray9x8: Buffer.from(out.gray9x8, 'base64'),
            small: { width: out.small.width, height: out.small.height, rgb: Buffer.from(out.small.rgb, 'base64') },
          });
        },
      );
    });
  }
}

/** Plugs in once the orchestrator adds `sharp` to package.json (untested until then). */
export class SharpProcessor implements ImageProcessor {
  readonly name = 'sharp' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sharp: any;

  constructor() {
    const req = createRequire(__filename);
    try {
      this.sharp = req('sharp');
    } catch {
      throw new Error('DEPENDENCY_MISSING: npm package "sharp" is not installed (use --processor pillow)');
    }
  }

  async process(input: string, outDir: string, baseName: string): Promise<ProcessedImage> {
    const fs = await import('fs');
    fs.mkdirSync(outDir, { recursive: true });
    const base = this.sharp(input, { limitInputPixels: 120_000_000 }).rotate().flatten({ background: '#ffffff' });
    const { width, height } = await base
      .clone()
      .toBuffer({ resolveWithObject: true })
      .then((r: { info: { width: number; height: number } }) => r.info);
    const variants: Variant[] = [];
    for (const w of VARIANT_WIDTHS) {
      if (w > width) continue;
      const p = path.join(outDir, `${baseName}-w${w}.webp`);
      const info = await base.clone().resize({ width: w }).webp({ quality: 78, effort: 4 }).toFile(p);
      variants.push({ label: `w${w}`, width: info.width, height: info.height, path: p, bytes: info.size });
    }
    const gray9x8 = await base.clone().resize(9, 8, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer();
    const sw = width >= height ? 32 : Math.max(1, Math.round((32 * width) / height));
    const sh = width >= height ? Math.max(1, Math.round((sw * height) / width)) : 32;
    const rgb = await base.clone().resize(sw, sh, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    return { width, height, variants, gray9x8, small: { width: sw, height: sh, rgb } };
  }
}

export function getProcessor(name: string): ImageProcessor {
  if (name === 'sharp') return new SharpProcessor();
  if (name === 'pillow') return new PillowProcessor();
  throw new Error(`unknown processor ${name}`);
}
