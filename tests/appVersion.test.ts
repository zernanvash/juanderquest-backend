import request from 'supertest';
import { app } from '../src/app';
import fs from 'fs';
import path from 'path';

describe('App Version Endpoint (OTA Updates)', () => {
  const testVersionFilePath = path.resolve(process.cwd(), 'test-version.json');

  beforeEach(() => {
    process.env.APP_VERSION_FILE = testVersionFilePath;
  });

  afterEach(() => {
    delete process.env.APP_VERSION_FILE;
    if (fs.existsSync(testVersionFilePath)) {
      fs.unlinkSync(testVersionFilePath);
    }
  });

  it('GET /api/v1/app/version returns default version data when no file exists', async () => {
    const res = await request(app).get('/api/v1/app/version');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.versionCode).toBe(1);
    expect(res.body.data.versionName).toBe('1.0.0');
    expect(res.body.data.downloadUrl).toContain('.apk');
  });

  it('GET /api/v1/app/version returns dynamic data when version.json exists', async () => {
    const mockData = {
      versionCode: 42,
      versionName: '2.1.0',
      downloadUrl: 'https://jdq.zernanvash.dev/downloads/juanderquest-v2.1.0.apk',
      changelog: 'Added real-time map filters and battery optimizations.',
      publishedAt: '2026-08-22T12:00:00Z',
      forceUpdate: true,
      minSupportedVersionCode: 40,
    };
    fs.writeFileSync(testVersionFilePath, JSON.stringify(mockData), 'utf-8');

    const res = await request(app).get('/api/v1/app/version');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.versionCode).toBe(42);
    expect(res.body.data.versionName).toBe('2.1.0');
    expect(res.body.data.downloadUrl).toBe(mockData.downloadUrl);
    expect(res.body.data.changelog).toBe(mockData.changelog);
    expect(res.body.data.forceUpdate).toBe(true);
  });

  it('GET /api/v1/app/latest redirects (302) to downloadUrl', async () => {
    const res = await request(app).get('/api/v1/app/latest');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('.apk');
  });
});
