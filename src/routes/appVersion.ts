import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { SettingsService } from '../settings/service.js';
import { log } from '../utils/logger.js';

export const appVersionRouter = Router();
const appSettingsService = new SettingsService();
const LATEST_ANDROID_APK =
  'https://github.com/zernanvash/juanderquest-mobile/releases/latest/download/juanderquest-latest.apk';

export interface ContentManifestMetadata {
  version: string;
  manifestUrl: string;
  signature?: string;
  publishedAt?: string;
}

export interface AppVersionData {
  schemaVersion?: number;
  packageName?: string;
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
  sha256?: string;
  sizeBytes?: number;
  signingKeyGeneration?: number;
  legacyInstallRequiresReinstall?: boolean;
  content?: ContentManifestMetadata;
  // Manifest v2 (per-ABI releases): base build number and its floor.
  buildNumber?: number;
  minSupportedBuildNumber?: number;
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
  const customPath = process.env.APP_VERSION_FILE;
  if (customPath) {
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
    schemaVersion: 1,
    packageName: 'dev.zernanvash.juanderquest',
    versionCode: 1,
    versionName: `alpha-${currentCommit}`,
    commitHash: currentCommit,
    fileName: defaultFileName,
    downloadUrl: LATEST_ANDROID_APK,
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
      const minimumBase =
        typeof parsed.minimumBaseVersionCode === 'number' ? parsed.minimumBaseVersionCode : minSupported;

      return {
        schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
        packageName: parsed.packageName || 'dev.zernanvash.juanderquest',
        versionCode: typeof parsed.versionCode === 'number' ? parsed.versionCode : fallback.versionCode,
        versionName: parsed.versionName || `alpha-${commit}`,
        commitHash: commit,
        fileName,
        downloadUrl: parsed.downloadUrl || LATEST_ANDROID_APK,
        changelog: parsed.changelog || fallback.changelog,
        publishedAt: parsed.publishedAt || fallback.publishedAt,
        forceUpdate: isForce,
        minSupportedVersionCode: minSupported,
        minimumBaseVersionCode: minimumBase,
        baseReleaseRequired: typeof parsed.baseReleaseRequired === 'boolean' ? parsed.baseReleaseRequired : false,
        updatePolicy: parsed.updatePolicy || (isForce ? 'mandatory' : 'optional'),
        sha256: parsed.sha256,
        sizeBytes: typeof parsed.sizeBytes === 'number' ? parsed.sizeBytes : undefined,
        signingKeyGeneration: typeof parsed.signingKeyGeneration === 'number' ? parsed.signingKeyGeneration : undefined,
        legacyInstallRequiresReinstall:
          typeof parsed.legacyInstallRequiresReinstall === 'boolean'
            ? parsed.legacyInstallRequiresReinstall
            : undefined,
        buildNumber: typeof parsed.buildNumber === 'number' ? parsed.buildNumber : undefined,
        minSupportedBuildNumber:
          typeof parsed.minSupportedBuildNumber === 'number' ? parsed.minSupportedBuildNumber : undefined,
        content: parsed.content
          ? {
              version: String(parsed.content.version || ''),
              manifestUrl: String(parsed.content.manifestUrl || ''),
              signature: parsed.content.signature ? String(parsed.content.signature) : undefined,
              publishedAt: parsed.content.publishedAt ? String(parsed.content.publishedAt) : undefined,
            }
          : undefined,
      };
    }
  } catch (error) {
    log.warn('[AppVersion] Error reading version.json, falling back to default:', { error: error });
  }

  return fallback;
};

export interface AppPromoPanel {
  campaign_id: string;
  title: string;
  body: string;
  cta_label: string;
  url: string;
  until: string | null;
}

const isHttpsUrl = (raw: string): boolean => {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && parsed.host.length > 0;
  } catch {
    return false;
  }
};

// GET /api/v1/app/version -> Get latest app version info + dynamic min build, announcement & promo panel
appVersionRouter.get('/app/version', async (_req: Request, res: Response) => {
  const versionData = getLatestAppVersion();
  let minSupportedBuild = versionData.minSupportedBuildNumber ?? versionData.minSupportedVersionCode ?? 1;
  let announcement: { text: string; severity: 'info' | 'warning'; until: string | null } | null = null;
  let promoPanel: AppPromoPanel | null = null;
  try {
    const settings = await appSettingsService.getSettings();
    const configuredMin = Number(settings.values.app_min_supported_build ?? 1);
    if (Number.isInteger(configuredMin) && configuredMin >= 1) {
      minSupportedBuild = configuredMin;
    }
    const text = String(settings.values.app_announcement_text ?? '').trim();
    const severity = settings.values.app_announcement_severity === 'warning' ? 'warning' : 'info';
    const untilRaw = String(settings.values.app_announcement_until ?? '').trim();
    const untilMs = untilRaw ? Date.parse(untilRaw) : NaN;
    const isExpired = Boolean(untilRaw) && Number.isFinite(untilMs) && untilMs <= Date.now();
    if (text && !isExpired) {
      announcement = { text, severity, until: untilRaw || null };
    }

    const promoEnabled = settings.values.app_promo_enabled === true;
    const promoTitle = String(settings.values.app_promo_title ?? '').trim();
    const promoBody = String(settings.values.app_promo_body ?? '').trim();
    const promoCtaLabel = String(settings.values.app_promo_cta_label ?? '').trim() || 'Open Form';
    const promoUrl = String(settings.values.app_promo_url ?? '').trim();
    const promoUntilRaw = String(settings.values.app_promo_until ?? '').trim();
    const promoUntilMs = promoUntilRaw ? Date.parse(promoUntilRaw) : NaN;
    const isPromoExpired = Boolean(promoUntilRaw) && (!Number.isFinite(promoUntilMs) || promoUntilMs <= Date.now());
    if (promoEnabled && promoTitle && isHttpsUrl(promoUrl) && !isPromoExpired) {
      const configuredCampaignId = String(settings.values.app_promo_campaign_id ?? '').trim();
      const campaignId =
        configuredCampaignId ||
        `promo-${createHash('sha256').update(`${promoTitle}|${promoUrl}`).digest('hex').slice(0, 12)}`;
      promoPanel = {
        campaign_id: campaignId,
        title: promoTitle,
        body: promoBody,
        cta_label: promoCtaLabel,
        url: promoUrl,
        until: promoUntilRaw || null,
      };
    }
  } catch {
    // Settings table or pool unavailable (e.g. unit test without PG) - preserve fallback behavior.
  }

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({
    success: true,
    data: {
      ...versionData,
      min_supported_build: minSupportedBuild,
      announcement,
      promo_panel: promoPanel,
    },
  });
});

// GET /api/v1/app/download -> Directly stream the APK file with attachment headers
appVersionRouter.get('/app/download', (_req: Request, res: Response) => {
  const versionData = getLatestAppVersion();
  const targetFileName = versionData.fileName || `juanderquest-alpha-${versionData.commitHash}.apk`;

  // Serve strictly promoted, immutable release APKs.
  // Never serve debug or unverified development artifacts.
  const possiblePaths = [
    `/var/www/jdq-downloads/${targetFileName}`,
    path.resolve(process.cwd(), `downloads/${targetFileName}`),
    path.resolve(process.cwd(), '../downloads', targetFileName),
    path.resolve(process.cwd(), 'downloads/juanderquest-latest.apk'),
    '/var/www/jdq-downloads/juanderquest-latest.apk',
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
