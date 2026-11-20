// Storage drivers for catalog photo variants.
//  - local: files under <PHOTO_ROOT>/media/catalog/…, URLs root-relative under the backend's
//    existing static mount (/api/v1/uploads/spot-photos → LOCAL_UPLOAD_DIR, src/app.ts), i.e.
//    /api/v1/uploads/spot-photos/catalog/<key>. Deploying = copying media/catalog into LOCAL_UPLOAD_DIR.
//  - r2: Cloudflare R2 through its S3-compatible API (owner decision D3), SigV4 signed with node
//    crypto (no SDK dependency). UNTESTED: no bucket/credentials exist yet.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { USER_AGENT } from './http.js';

export const LOCAL_URL_PREFIX = '/api/v1/uploads/spot-photos/';

export interface PhotoStorage {
  readonly name: 'local' | 'r2';
  /** Public URL for an object key (no I/O). */
  url(key: string): string;
  exists(key: string): Promise<boolean>;
  put(key: string, file: string, contentType: string): Promise<void>;
}

export function assertSafeKey(key: string): void {
  if (!/^catalog\/[a-z0-9/_-]+\.webp$/.test(key) || key.includes('..')) throw new Error(`unsafe object key ${key}`);
}

/** Deterministic object key for a variant of one source file. */
export function variantKey(source: string, sourceId: string, label: string): string {
  const h = crypto.createHash('sha1').update(`${source}:${sourceId}`).digest('hex');
  return `catalog/${h.slice(0, 2)}/${h.slice(0, 20)}-${label}.webp`;
}

export class LocalPhotoStorage implements PhotoStorage {
  readonly name = 'local' as const;
  constructor(private readonly root: string) {}

  private file(key: string): string {
    assertSafeKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('PATH_TRAVERSAL_ATTEMPT');
    return p;
  }
  url(key: string): string {
    assertSafeKey(key);
    return `${LOCAL_URL_PREFIX}${key}`;
  }
  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.file(key));
  }
  async put(key: string, file: string): Promise<void> {
    const dest = this.file(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, `${dest}.part`);
    fs.renameSync(`${dest}.part`, dest);
  }
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** AWS Signature V4 headers for one S3 request (region 'auto' for R2). Exported for tests. */
export function signS3(opts: {
  method: string;
  host: string;
  path: string;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
  region?: string;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const region = opts.region ?? 'auto';
  const amzDate = opts.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: opts.host,
    'x-amz-content-sha256': opts.payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(opts.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    opts.method,
    opts.path
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/'),
    '',
    names.map((n) => `${n}:${headers[n].trim()}\n`).join(''),
    names.join(';'),
    opts.payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

/** UNTESTED against a live bucket. Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL. */
export class R2PhotoStorage implements PhotoStorage {
  readonly name = 'r2' as const;
  private readonly host: string;
  private readonly bucket: string;
  private readonly publicBase: string;
  private readonly keyId: string;
  private readonly secret: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const missing = [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_PUBLIC_BASE_URL',
    ].filter((k) => !env[k]);
    if (missing.length) throw new Error(`STORAGE_CONFIG_ERROR: missing ${missing.join(', ')}`);
    this.host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    this.bucket = env.R2_BUCKET!;
    this.publicBase = env.R2_PUBLIC_BASE_URL!.replace(/\/+$/, '');
    this.keyId = env.R2_ACCESS_KEY_ID!;
    this.secret = env.R2_SECRET_ACCESS_KEY!;
  }

  url(key: string): string {
    assertSafeKey(key);
    return `${this.publicBase}/${key}`;
  }

  private async send(method: 'HEAD' | 'PUT', key: string, body?: Buffer, contentType?: string): Promise<Response> {
    assertSafeKey(key);
    const p = `/${this.bucket}/${key}`;
    const payloadHash = body ? sha256(body) : sha256('');
    const extra: Record<string, string> = body
      ? {
          'content-type': contentType ?? 'application/octet-stream',
          'cache-control': 'public, max-age=31536000, immutable',
        }
      : {};
    const headers = signS3({
      method,
      host: this.host,
      path: p,
      payloadHash,
      accessKeyId: this.keyId,
      secretAccessKey: this.secret,
      now: new Date(),
      extraHeaders: extra,
    });
    const { host: _host, ...sendHeaders } = headers;
    void _host;
    return fetch(`https://${this.host}${p}`, {
      method,
      headers: { ...sendHeaders, 'user-agent': USER_AGENT },
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.send('HEAD', key);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`R2 HEAD HTTP ${res.status}`);
    return true;
  }

  async put(key: string, file: string, contentType: string): Promise<void> {
    const res = await this.send('PUT', key, fs.readFileSync(file), contentType);
    if (!res.ok) throw new Error(`R2 PUT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export function getStorage(name: string, photoRoot: string): PhotoStorage {
  if (name === 'local') return new LocalPhotoStorage(path.join(photoRoot, 'media'));
  if (name === 'r2') return new R2PhotoStorage();
  throw new Error(`unknown storage ${name}`);
}
