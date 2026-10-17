import type { NextFunction, Request, Response } from 'express';
import { getLatestAppVersion } from '../routes/appVersion.js';

let cachedMinSupportedBuild: { value: number; downloadUrl: string; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

/** Test hook: clears the manifest cache so fixtures take effect immediately. */
export const resetAppVersionGateCache = (): void => {
  cachedMinSupportedBuild = null;
};

function manifestGate(): { minSupportedBuild: number; downloadUrl: string } {
  const now = Date.now();
  if (cachedMinSupportedBuild && now - cachedMinSupportedBuild.at < CACHE_TTL_MS) {
    return {
      minSupportedBuild: cachedMinSupportedBuild.value,
      downloadUrl: cachedMinSupportedBuild.downloadUrl,
    };
  }
  let minSupportedBuild = 0;
  let downloadUrl = '';
  try {
    const manifest = getLatestAppVersion();
    minSupportedBuild = manifest.minSupportedBuildNumber ?? manifest.minSupportedVersionCode ?? 0;
    downloadUrl = manifest.downloadUrl;
  } catch {
    minSupportedBuild = 0;
  }
  cachedMinSupportedBuild = { value: minSupportedBuild, downloadUrl, at: now };
  return { minSupportedBuild, downloadUrl };
}

/**
 * Server-enforced minimum (Plan 40 §B7): Android clients older than the
 * manifest's supported build number may read but not mutate. Legacy clients
 * that do not send X-App-Platform/X-App-Build pass through unchanged.
 */
export const appVersionGate = (req: Request, res: Response, next: NextFunction): void => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  if (req.headers['x-app-platform'] !== 'android') {
    next();
    return;
  }
  const buildHeader = req.headers['x-app-build'];
  const build = typeof buildHeader === 'string' ? Number.parseInt(buildHeader, 10) : Number.NaN;
  if (!Number.isFinite(build)) {
    next();
    return;
  }

  const { minSupportedBuild, downloadUrl } = manifestGate();
  if (minSupportedBuild > 0 && build < minSupportedBuild) {
    res.status(426).json({
      success: false,
      error: {
        code: 'UPGRADE_REQUIRED',
        message: 'This app version is no longer supported. Please update to continue.',
      },
      data: { minSupportedBuildNumber: minSupportedBuild, downloadUrl },
    });
    return;
  }
  next();
};
