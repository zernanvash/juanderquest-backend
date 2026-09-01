import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export const appVersionRouter = Router();

export interface ContentManifestMetadata {
  version: string;
  manifestUrl: string;
  signature?: string;
  publishedAt?: string;
}

export interface AppVersionData {
  versionCode: number;
  versionName: string;
  commitHash: string;
  fileName: string;
  downloadUrl: string;
  changelog: string;
  publishedAt: string;
  forceUpdate: boolean;
  minSupportedVersionCode: number;
  minimumBaseVersionCode?: number;
  baseReleaseRequired?: boolean;
  updatePolicy?: 'optional' | 'mandatory' | 'silent';
  content?: ContentManifestMetadata;
}


let cachedGitCommit: string | null = null;

export const getGitCommitHead = (): string => {
  if (process.env.GIT_COMMIT) {
    return process.env.GIT_COMMIT.substring(0, 7);
  }
  if (process.env.COMMIT_HASH) {
    return process.env.COMMIT_HASH.substring(0, 7);
  }
  if (cachedGitCommit) {
    return cachedGitCommit;
  }
  try {
    const stdout = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (stdout && /^[a-f0-9]+$/i.test(stdout)) {
      cachedGitCommit = stdout;
      return stdout;
    }
  } catch {
    // ignore git error when outside a repo
  }
  return 'latest';
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
  const currentCommit = getGitCommitHead();
  const defaultFileName = `juanderquest-alpha-${currentCommit}.apk`;

  const fallback: AppVersionData = {
    versionCode: 1,
    versionName: `alpha-${currentCommit}`,
    commitHash: currentCommit,
    fileName: defaultFileName,
    downloadUrl: `https://jdq.zernanvash.dev/downloads/${defaultFileName}`,
    changelog: 'Automated alpha release build of JuanDerQuest for Pangasinan tourism.',
    publishedAt: new Date().toISOString(),
    forceUpdate: false,
    minSupportedVersionCode: 1,
    minimumBaseVersionCode: 1,
    baseReleaseRequired: false,
    updatePolicy: 'optional',
  };

  try {
    const filePath = getVersionFilePath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const commit = parsed.commitHash || currentCommit;
      const fileName = parsed.fileName || `juanderquest-alpha-${commit}.apk`;
      const isForce = Boolean(parsed.forceUpdate);
      const minSupported = typeof parsed.minSupportedVersionCode === 'number' ? parsed.minSupportedVersionCode : 1;
      const minimumBase = typeof parsed.minimumBaseVersionCode === 'number' ? parsed.minimumBaseVersionCode : minSupported;

      return {
        versionCode: typeof parsed.versionCode === 'number' ? parsed.versionCode : fallback.versionCode,
        versionName: parsed.versionName || `alpha-${commit}`,
        commitHash: commit,
        fileName,
        downloadUrl: parsed.downloadUrl || `https://jdq.zernanvash.dev/downloads/${fileName}`,
        changelog: parsed.changelog || fallback.changelog,
        publishedAt: parsed.publishedAt || fallback.publishedAt,
        forceUpdate: isForce,
        minSupportedVersionCode: minSupported,
        minimumBaseVersionCode: minimumBase,
        baseReleaseRequired: typeof parsed.baseReleaseRequired === 'boolean' ? parsed.baseReleaseRequired : false,
        updatePolicy: parsed.updatePolicy || (isForce ? 'mandatory' : 'optional'),
        content: parsed.content ? {
          version: String(parsed.content.version || ''),
          manifestUrl: String(parsed.content.manifestUrl || ''),
          signature: parsed.content.signature ? String(parsed.content.signature) : undefined,
          publishedAt: parsed.content.publishedAt ? String(parsed.content.publishedAt) : undefined,
        } : undefined,
      };
    }
  } catch (error) {
    console.warn('[AppVersion] Error reading version.json, falling back to default:', error);
  }

  return fallback;
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
  const versionData = getLatestAppVersion();
  const targetFileName = versionData.fileName || `juanderquest-alpha-${versionData.commitHash}.apk`;

  const possiblePaths = [
    `/var/www/jdq-downloads/${targetFileName}`,
    '/var/www/jdq-downloads/juanderquest-latest.apk',
    path.resolve(process.cwd(), `downloads/${targetFileName}`),
    path.resolve(process.cwd(), 'downloads/juanderquest-latest.apk'),
    path.resolve(process.cwd(), '../downloads/juanderquest-latest.apk'),
  ];


  for (const apkPath of possiblePaths) {
    if (fs.existsSync(apkPath)) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${targetFileName}"`);
      return res.sendFile(apkPath);
    }
  }

  // Fallback to redirection
  return res.redirect(302, versionData.downloadUrl);
});

// GET /api/v1/app/latest -> Redirect to latest APK download URL
appVersionRouter.get('/app/latest', (_req: Request, res: Response) => {
  const versionData = getLatestAppVersion();
  res.redirect(302, versionData.downloadUrl);
});

export default appVersionRouter;

