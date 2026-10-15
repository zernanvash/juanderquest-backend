import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { getPool } from '../db/pool.js';
import {
  SETTINGS_BY_KEY,
  SETTINGS_DEFINITIONS,
  SettingDefinition,
  SettingValue,
  canonicalSettings,
  validateSettingValue,
} from './schema.js';

export class SettingsError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface SettingsSnapshot {
  revision: number;
  updated_by: string | null;
  updated_at: string | null;
  values: Record<string, SettingValue>;
  definitions: readonly SettingDefinition[];
}

export interface SettingsAuditEntry {
  id: string;
  actor_id: string | null;
  changed_keys: string[];
  before_values: Record<string, SettingValue>;
  after_values: Record<string, SettingValue>;
  reason: string | null;
  request_id: string | null;
  revision: number;
  created_at: string;
}

export interface UpdateSettingsParams {
  changes: Record<string, unknown>;
  expectedRevision: number;
  actorId: string;
  reason?: string;
  requestId?: string;
}

export class SettingsService {
  constructor(private readonly poolProvider: () => Pool | null = getPool) {}

  private requirePool(): Pool {
    const pool = this.poolProvider();
    if (!pool) {
      throw new SettingsError('STORAGE_UNAVAILABLE', 503, 'Settings require durable PostgreSQL storage and are unavailable without it.');
    }
    return pool;
  }

  async getSettings(): Promise<SettingsSnapshot> {
    const pool = this.requirePool();
    const { rows } = await pool.query(
      'SELECT values, revision, updated_by, updated_at FROM system_settings_document WHERE id = 1'
    );
    const row = rows[0];
    return {
      revision: Number(row?.revision ?? 0),
      updated_by: row?.updated_by ?? null,
      updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      values: canonicalSettings(row?.values ?? {}),
      definitions: SETTINGS_DEFINITIONS,
    };
  }

  async updateSettings(params: UpdateSettingsParams): Promise<{
    revision: number;
    values: Record<string, SettingValue>;
    changed_keys: string[];
  }> {
    if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 0) {
      throw new SettingsError('VALIDATION_ERROR', 400, 'expected_revision must be a non-negative integer.');
    }

    const changeEntries = Object.entries(params.changes ?? {});
    if (changeEntries.length === 0) {
      throw new SettingsError('VALIDATION_ERROR', 400, 'At least one setting change is required.');
    }

    const normalized: Record<string, SettingValue> = {};
    for (const [key, raw] of changeEntries) {
      const definition = SETTINGS_BY_KEY.get(key);
      if (!definition) {
        throw new SettingsError('UNKNOWN_SETTING', 400, `Unknown or non-editable setting key: ${key}`);
      }
      const validation = validateSettingValue(definition, raw);
      if (!validation.ok) {
        throw new SettingsError('VALIDATION_ERROR', 400, validation.message);
      }
      normalized[key] = validation.value;
    }

    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO system_settings_document (id, values, revision) VALUES (1, '{}'::jsonb, 0) ON CONFLICT (id) DO NOTHING`
      );
      const { rows } = await client.query(
        'SELECT values, revision FROM system_settings_document WHERE id = 1 FOR UPDATE'
      );
      const current = rows[0];
      const currentRevision = Number(current?.revision ?? 0);
      if (currentRevision !== params.expectedRevision) {
        throw new SettingsError(
          'REVISION_CONFLICT',
          409,
          'Another editor saved settings since this form was loaded. Review the latest values and apply again.',
          { revision: currentRevision, values: canonicalSettings(current?.values ?? {}) }
        );
      }

      const beforeValues = canonicalSettings(current?.values ?? {});
      const afterValues = { ...beforeValues, ...normalized };
      const changedKeys = changeEntries.map(([key]) => key);
      const nextRevision = currentRevision + 1;

      await client.query(
        `UPDATE system_settings_document
         SET values = $1::jsonb, revision = $2, updated_by = $3, updated_at = NOW()
         WHERE id = 1`,
        [JSON.stringify(afterValues), nextRevision, params.actorId]
      );

      await client.query(
        `INSERT INTO system_settings_audit
           (id, actor_id, changed_keys, before_values, after_values, reason, request_id, revision)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8)`,
        [
          randomUUID(),
          params.actorId,
          JSON.stringify(changedKeys),
          JSON.stringify(Object.fromEntries(changedKeys.map((key) => [key, beforeValues[key]]))),
          JSON.stringify(Object.fromEntries(changedKeys.map((key) => [key, afterValues[key]]))),
          params.reason ?? null,
          params.requestId ?? null,
          nextRevision,
        ]
      );

      await client.query('COMMIT');
      return { revision: nextRevision, values: afterValues, changed_keys: changedKeys };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listAudit(limit = 25): Promise<SettingsAuditEntry[]> {
    const pool = this.requirePool();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 25, 1), 100);
    const { rows } = await pool.query(
      `SELECT id, actor_id, changed_keys, before_values, after_values, reason, request_id, revision, created_at
       FROM system_settings_audit
       ORDER BY created_at DESC, revision DESC
       LIMIT $1`,
      [boundedLimit]
    );
    return rows.map((row) => ({
      id: row.id,
      actor_id: row.actor_id ?? null,
      changed_keys: Array.isArray(row.changed_keys) ? row.changed_keys.map(String) : [],
      before_values: (row.before_values ?? {}) as Record<string, SettingValue>,
      after_values: (row.after_values ?? {}) as Record<string, SettingValue>,
      reason: row.reason ?? null,
      request_id: row.request_id ?? null,
      revision: Number(row.revision),
      created_at: new Date(row.created_at).toISOString(),
    }));
  }
}
