import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';

export type CpuProfileMode = 'request_window';

export interface InspectorSessionLike {
  connect(): void;
  post(method: string, callback?: (err: Error | null, params?: unknown) => void): void;
  post(method: string, params?: Record<string, unknown>, callback?: (err: Error | null, params?: unknown) => void): void;
  disconnect(): void;
}

export interface CpuProfileArtifactMeta {
  readonly profilePath: string;
  readonly relativeProfilePath: string;
  readonly mode: CpuProfileMode;
  readonly nodeCount: number;
  readonly sampleCount: number;
  readonly fileSizeBytes: number;
}

export interface CpuProfileStopResult {
  readonly enabled: boolean;
  readonly artifact?: CpuProfileArtifactMeta;
}

export interface CpuProfileSessionOptions {
  readonly session?: InspectorSessionLike;
  readonly profilesDir?: string;
  readonly maxFileSizeBytes?: number;
}

export const MAX_PROFILE_BYTES = 16 * 1024 * 1024; // 16 MiB
const DEFAULT_RELATIVE_PROFILES_DIR = path.join('.local', 'capacity-cpu-profiles');

/**
 * Validates the CPU profile mode environment variable.
 * Off by default when undefined or empty.
 * Requires exact 'request_window'.
 * Any other nonempty value throws an error.
 */
export function resolveCpuProfileMode(envValue: string | undefined): CpuProfileMode | null {
  if (envValue === undefined || envValue === '') {
    return null;
  }
  if (envValue === 'request_window') {
    return 'request_window';
  }
  throw new Error('JDQ_CAPACITY_CPU_PROFILE must be "request_window" or unset');
}

function postAsync<T = unknown>(session: InspectorSessionLike, method: string, params?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Inspector ${method} timed out`)); }
    }, 10_000);
    const callback = (err: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) {
        reject(err);
      } else {
        resolve(result as T);
      }
    };
    try {
      if (params !== undefined) {
        session.post(method, params, callback);
      } else {
        session.post(method, callback);
      }
    } catch (error) {
      if (!settled) { settled = true; clearTimeout(timeout); reject(error); }
    }
  });
}

export class CapacityCpuProfiler {
  private readonly mode: CpuProfileMode | null;
  private readonly session: InspectorSessionLike;
  private readonly profilesDir: string;
  private readonly maxFileSizeBytes: number;
  private connected = false;
  private started = false;

  constructor(envValue: string | undefined, options?: CpuProfileSessionOptions) {
    this.mode = resolveCpuProfileMode(envValue);
    this.session = options?.session ?? new inspector.Session();
    this.profilesDir = options?.profilesDir ?? path.resolve(process.cwd(), DEFAULT_RELATIVE_PROFILES_DIR);
    this.maxFileSizeBytes = options?.maxFileSizeBytes ?? MAX_PROFILE_BYTES;
    if (!Number.isSafeInteger(this.maxFileSizeBytes) || this.maxFileSizeBytes < 1 || this.maxFileSizeBytes > MAX_PROFILE_BYTES) {
      throw new Error('CPU profile size bound must be between 1 byte and 16 MiB');
    }
  }

  isEnabled(): boolean {
    return this.mode !== null;
  }

  getMode(): CpuProfileMode | null {
    return this.mode;
  }

  async start(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    if (this.started) {
      throw new Error('CapacityCpuProfiler has already been started');
    }

    try {
      this.session.connect();
      this.connected = true;
      await postAsync(this.session, 'Profiler.enable');
      await postAsync(this.session, 'Profiler.start');
      this.started = true;
    } catch (err) {
      await this.disconnectSilently();
      throw err;
    }
  }

  async stop(): Promise<CpuProfileStopResult> {
    if (!this.isEnabled() || !this.started) {
      await this.disconnectSilently();
      return { enabled: false };
    }

    let profileResult: { profile?: { nodes?: unknown[]; samples?: unknown[] } } | undefined;
    let primaryError: unknown;
    try {
      profileResult = await postAsync<{ profile?: { nodes?: unknown[]; samples?: unknown[] } }>(
        this.session,
        'Profiler.stop'
      );
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        await postAsync(this.session, 'Profiler.disable');
      } catch (error) {
        primaryError ??= error;
      }
      this.started = false;
      await this.disconnectSilently();
    }
    if (primaryError) throw primaryError;

    const profileData = profileResult?.profile;
    assert(profileData, 'Profiler.stop did not return profile data');

    const nodes = Array.isArray(profileData.nodes) ? profileData.nodes : [];
    const samples = Array.isArray(profileData.samples) ? profileData.samples : [];

    const serialized = JSON.stringify(profileData);
    const byteLength = Buffer.byteLength(serialized, 'utf8');

    if (byteLength > this.maxFileSizeBytes) {
      throw new Error(
        `Serialized CPU profile size (${byteLength} bytes) exceeds maximum allowed size (${this.maxFileSizeBytes} bytes)`
      );
    }

    fs.mkdirSync(this.profilesDir, { recursive: true });
    assert(!fs.lstatSync(this.profilesDir).isSymbolicLink(), 'CPU profile directory must not be a symlink');

    const randomSuffix = randomBytes(12).toString('hex');
    const filename = `capacity-request-window-${Date.now()}-${randomSuffix}.cpuprofile`;
    const fullPath = path.join(this.profilesDir, filename);

    // Exclusive file creation flag 'wx' ensures no clobber
    fs.writeFileSync(fullPath, serialized, { flag: 'wx', mode: 0o600, encoding: 'utf8' });

    const stats = fs.statSync(fullPath);
    const relativeProfilePath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');

    const artifact: CpuProfileArtifactMeta = {
      profilePath: fullPath,
      relativeProfilePath,
      mode: this.mode!,
      nodeCount: nodes.length,
      sampleCount: samples.length,
      fileSizeBytes: stats.size,
    };

    return {
      enabled: true,
      artifact,
    };
  }

  async cleanup(): Promise<void> {
    if (this.started) {
      try { await postAsync(this.session, 'Profiler.stop'); } catch { /* preserve the original workload failure */ }
      try { await postAsync(this.session, 'Profiler.disable'); } catch { /* preserve the original workload failure */ }
    }
    this.started = false;
    await this.disconnectSilently();
  }

  private async disconnectSilently(): Promise<void> {
    if (this.connected) {
      this.connected = false;
      try {
        this.session.disconnect();
      } catch {
        // Disconnect failures should not shadow primary errors
      }
    }
  }
}

/**
 * Format a human-readable diagnostic log line for the CPU profile artifact.
 * Never prints tokens, secrets, or URLs.
 */
export function formatCpuProfileSummaryLine(artifact: CpuProfileArtifactMeta): string {
  return `CAPACITY_CPU_PROFILE mode=${artifact.mode} path=${artifact.relativeProfilePath} nodes=${artifact.nodeCount} samples=${artifact.sampleCount} bytes=${artifact.fileSizeBytes}\n`;
}
