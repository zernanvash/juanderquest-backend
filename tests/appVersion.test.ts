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
    expect(res.body.data.versionName).toBeDefined();
    expect(res.body.data.commitHash).toBeDefined();
    expect(res.body.data.fileName).toMatch(/^juanderquest-alpha-.*\.apk$/);
    expect(res.body.data.downloadUrl).toContain('.apk');
    expect(res.body.data.minimumBaseVersionCode).toBe(1);
    expect(res.body.data.baseReleaseRequired).toBe(false);
    expect(res.body.data.updatePolicy).toBe('optional');
  });

  it('GET /api/v1/app/version returns dynamic data when version.json exists', async () => {
    const mockData = {
      versionCode: 42,
      versionName: 'alpha-7a3b4c1',
      commitHash: '7a3b4c1',
      fileName: 'juanderquest-alpha-7a3b4c1.apk',
      downloadUrl: 'https://jdq.zernanvash.dev/downloads/juanderquest-alpha-7a3b4c1.apk',
      changelog: 'Added real-time map filters and battery optimizations.',
      publishedAt: '2026-08-22T12:00:00Z',
      forceUpdate: true,
      minSupportedVersionCode: 40,
      minimumBaseVersionCode: 40,
      baseReleaseRequired: false,
      updatePolicy: 'mandatory',
      content: {
        version: '2026.08.31.1',
        manifestUrl: 'https://jdq.zernanvash.dev/mobile-content/manifest.json',
        signature: 'mock-sig-abc',
      },
    };
    fs.writeFileSync(testVersionFilePath, JSON.stringify(mockData), 'utf-8');

    const res = await request(app).get('/api/v1/app/version');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.versionCode).toBe(42);
    expect(res.body.data.versionName).toBe('alpha-7a3b4c1');
    expect(res.body.data.commitHash).toBe('7a3b4c1');
    expect(res.body.data.fileName).toBe('juanderquest-alpha-7a3b4c1.apk');
    expect(res.body.data.downloadUrl).toBe(mockData.downloadUrl);
    expect(res.body.data.changelog).toBe(mockData.changelog);
    expect(res.body.data.forceUpdate).toBe(true);
    expect(res.body.data.minimumBaseVersionCode).toBe(40);
    expect(res.body.data.baseReleaseRequired).toBe(false);
    expect(res.body.data.updatePolicy).toBe('mandatory');
    expect(res.body.data.content).toBeDefined();
    expect(res.body.data.content.version).toBe('2026.08.31.1');
    expect(res.body.data.content.manifestUrl).toBe('https://jdq.zernanvash.dev/mobile-content/manifest.json');
    expect(res.body.data.content.signature).toBe('mock-sig-abc');
  });


  it('GET /api/v1/app/latest redirects (302) to downloadUrl', async () => {
    const res = await request(app).get('/api/v1/app/latest');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('.apk');
  });

  it('GET /api/v1/app/download redirects or serves APK with commit-based filename header', async () => {
    const res = await request(app).get('/api/v1/app/download');
    // If no local APK file exists on disk in test runner, it 302 redirects to downloadUrl
    if (res.status === 302) {
      expect(res.headers.location).toContain('.apk');
    } else {
      expect(res.headers['content-disposition']).toMatch(/juanderquest-alpha-.*\.apk/);
    }
  });
});

