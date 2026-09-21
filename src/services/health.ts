import fs from 'fs';
import path from 'path';
import { BlobServiceClient } from '@azure/storage-blob';
import { env } from '../config/env.js';
import { getPool, MIGRATIONS } from '../db/pool.js';

export type DependencyState = 'up' | 'down' | 'degraded';

export interface DependencyHealth {
  status: DependencyState;
  required: boolean;
  latency_ms: number;
  message?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'degraded' | 'not_ready';
  ready: boolean;
  degraded: boolean;
  timestamp: string;
  service: 'juanderquest-backend';
  dependencies: {
    postgres: DependencyHealth;
    valhalla: DependencyHealth;
    storage: DependencyHealth;
  };
}

export interface ReadinessProbes {
  postgres: () => Promise<void>;
  valhalla: () => Promise<void>;
  storage: () => Promise<void>;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probePostgres(): Promise<void> {
  const pool = getPool();
  if (!pool) {
    if (env.ALLOW_IN_MEMORY_FALLBACK && env.NODE_ENV !== 'production') {
      return;
    }
    throw new Error('PostgreSQL pool is not initialized');
  }
  const result = await withTimeout(pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations'), 1500, 'PostgreSQL readiness check');
  const applied = Number(result.rows[0]?.count ?? 0);
  if (applied < MIGRATIONS.length) {
    throw new Error(`Migration ledger incomplete: ${applied}/${MIGRATIONS.length}`);
  }
}

async function probeValhalla(): Promise<void> {
  const response = await fetch(`${env.VALHALLA_URL}/status`, {
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`Valhalla returned HTTP ${response.status}`);
}

async function probeStorage(): Promise<void> {
  if (env.SPOT_PHOTO_STORAGE === 'local') {
    const uploadDir = path.resolve(process.cwd(), env.LOCAL_UPLOAD_DIR || 'uploads/spot-photos');
    const stat = await fs.promises.stat(uploadDir);
    if (!stat.isDirectory()) throw new Error('Local upload path is not a directory');
    await fs.promises.access(uploadDir, fs.constants.R_OK | fs.constants.W_OK);
    return;
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient(env.AZURE_STORAGE_CONTAINER_NAME);
  const exists = await withTimeout(containerClient.exists(), 1500, 'Azure Blob Storage readiness check');
  if (!exists) throw new Error('Azure Blob Storage container does not exist');
}

export const defaultReadinessProbes: ReadinessProbes = {
  postgres: probePostgres,
  valhalla: probeValhalla,
  storage: probeStorage,
};

async function runProbe(
  required: boolean,
  dependencyName: string,
  probe: () => Promise<void>
): Promise<DependencyHealth> {
  const startedAt = Date.now();
  try {
    await probe();
    return {
      status: 'up',
      required,
      latency_ms: Date.now() - startedAt,
    };
  } catch {
    return {
      status: required ? 'down' : 'degraded',
      required,
      latency_ms: Date.now() - startedAt,
      message: `${dependencyName} dependency is unavailable.`,
    };
  }
}

export async function buildReadinessReport(
  probes: ReadinessProbes = defaultReadinessProbes
): Promise<ReadinessReport> {
  const [postgres, valhalla, storage] = await Promise.all([
    runProbe(true, 'PostgreSQL', probes.postgres),
    runProbe(false, 'Valhalla', probes.valhalla),
    runProbe(false, 'Spot photo storage', probes.storage),
  ]);

  const ready = postgres.status === 'up';
  const degraded = !ready || valhalla.status !== 'up' || storage.status !== 'up';

  return {
    status: ready ? (degraded ? 'degraded' : 'ready') : 'not_ready',
    ready,
    degraded,
    timestamp: new Date().toISOString(),
    service: 'juanderquest-backend',
    dependencies: { postgres, valhalla, storage },
  };
}
