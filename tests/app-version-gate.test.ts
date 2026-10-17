import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { app } from '../src/app';
import { resetAppVersionGateCache } from '../src/middleware/appVersionGate';

describe('Android app version gate (426 UPGRADE_REQUIRED)', () => {
  const fixturePath = path.join(os.tmpdir(), `jdq-version-gate-${process.pid}.json`);
  const previousVersionFile = process.env.APP_VERSION_FILE;

  beforeAll(() => {
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        schemaVersion: 2,
        packageName: 'dev.zernanvash.juanderquest',
        versionCode: 175,
        buildNumber: 175,
        minSupportedVersionCode: 150,
        minSupportedBuildNumber: 150,
        downloadUrl: 'https://api.juanderquest.app/api/v1/app/download',
      })
    );
    process.env.APP_VERSION_FILE = fixturePath;
    resetAppVersionGateCache();
  });

  afterAll(() => {
    if (previousVersionFile === undefined) {
      delete process.env.APP_VERSION_FILE;
    } else {
      process.env.APP_VERSION_FILE = previousVersionFile;
    }
    resetAppVersionGateCache();
    fs.rmSync(fixturePath, { force: true });
  });

  it('blocks mutations from Android builds below the supported build', async () => {
    const res = await request(app)
      .post('/api/v1/spots')
      .set('X-App-Platform', 'android')
      .set('X-App-Build', '100')
      .send({});
    expect(res.status).toBe(426);
    expect(res.body.error.code).toBe('UPGRADE_REQUIRED');
    expect(res.body.data.minSupportedBuildNumber).toBe(150);
    expect(res.body.data.downloadUrl).toContain('/app/download');
  });

  it('allows reads from outdated Android builds', async () => {
    const res = await request(app)
      .get('/api/v1/spots')
      .set('X-App-Platform', 'android')
      .set('X-App-Build', '100');
    expect(res.status).not.toBe(426);
  });

  it('allows mutations from supported builds', async () => {
    const res = await request(app)
      .post('/api/v1/spots')
      .set('X-App-Platform', 'android')
      .set('X-App-Build', '175')
      .send({});
    expect(res.status).not.toBe(426);
  });

  it('leaves non-Android and header-less clients untouched', async () => {
    const web = await request(app).post('/api/v1/spots').send({});
    expect(web.status).not.toBe(426);

    const iosish = await request(app)
      .post('/api/v1/spots')
      .set('X-App-Platform', 'ios')
      .set('X-App-Build', '1')
      .send({});
    expect(iosish.status).not.toBe(426);
  });
});
