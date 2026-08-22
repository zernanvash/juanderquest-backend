import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

export const appVersionRouter = Router();

export interface AppVersionData {
  versionCode: number;
  versionName: string;
  downloadUrl: string;
  changelog: string;
  publishedAt: string;
  forceUpdate: boolean;
  minSupportedVersionCode: number;
}

// Fallback version metadata if version.json is not yet uploaded
const DEFAULT_VERSION_DATA: AppVersionData = {
  versionCode: 1,
  versionName: '1.0.0',
  downloadUrl: 'https://jdq.zernanvash.dev/downloads/juanderquest-latest.apk',
  changelog: 'Initial public prototype release of JuanDerQuest for Pangasinan tourism.',
  publishedAt: new Date().toISOString(),
  forceUpdate: false,
  minSupportedVersionCode: 1,
};

const getVersionFilePath = (): string => {
  // Check in downloads folder or server root
  const customPath = process.env.APP_VERSION_FILE;
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const defaultLocations = [
    path.resolve(process.cwd(), 'downloads/version.json'),
    path.resolve(process.cwd(), '../downloads/version.json'),
    '/var/www/jdq-downloads/version.json',
  ];

  for (const loc of defaultLocations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  return path.resolve(process.cwd(), 'version.json');
};

export const getLatestAppVersion = (): AppVersionData => {
  try {
    const filePath = getVersionFilePath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        versionCode: typeof parsed.versionCode === 'number' ? parsed.versionCode : DEFAULT_VERSION_DATA.versionCode,
        versionName: parsed.versionName || DEFAULT_VERSION_DATA.versionName,
        downloadUrl: parsed.downloadUrl || DEFAULT_VERSION_DATA.downloadUrl,
        changelog: parsed.changelog || DEFAULT_VERSION_DATA.changelog,
        publishedAt: parsed.publishedAt || DEFAULT_VERSION_DATA.publishedAt,
        forceUpdate: Boolean(parsed.forceUpdate),
        minSupportedVersionCode: typeof parsed.minSupportedVersionCode === 'number' ? parsed.minSupportedVersionCode : 1,
      };
    }
  } catch (error) {
    console.warn('[AppVersion] Error reading version.json, falling back to default:', error);
  }

  return DEFAULT_VERSION_DATA;
};

// GET /api/v1/app/version -> Get latest app version info
appVersionRouter.get('/app/version', (_req: Request, res: Response) => {
  const versionData = getLatestAppVersion();
  res.json({
    success: true,
    data: versionData,
  });
});

// GET /api/v1/app/download -> Directly stream the APK file with attachment headers
appVersionRouter.get('/app/download', (_req: Request, res: Response) => {
  const possiblePaths = [
    '/var/www/jdq-downloads/juanderquest-latest.apk',
    '/var/www/jdq-downloads/juanderquest_beta_v1.0.0.apk',
    path.resolve(process.cwd(), 'downloads/juanderquest-latest.apk'),
    path.resolve(process.cwd(), '../downloads/juanderquest-latest.apk'),
  ];

  for (const apkPath of possiblePaths) {
    if (fs.existsSync(apkPath)) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="juanderquest_beta_v1.0.0.apk"');
      return res.sendFile(apkPath);
    }
  }

  // Fallback to redirection
  const versionData = getLatestAppVersion();
  return res.redirect(302, versionData.downloadUrl);
});

// GET /api/v1/app/latest -> Redirect to latest APK download URL
appVersionRouter.get('/app/latest', (_req: Request, res: Response) => {
  const versionData = getLatestAppVersion();
  res.redirect(302, versionData.downloadUrl);
});

export default appVersionRouter;
