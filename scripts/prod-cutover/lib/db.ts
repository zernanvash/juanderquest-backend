// Plan 116 §9: connection helpers for the carry-over scripts. URLs come from the
// environment only and are never printed; describeUrl() gives a password-free label.
import { Client, types } from 'pg';

/** Databases/ports the carry scripts must never write to (live production). */
export const FORBIDDEN_TARGET_DATABASES = ['juanderquest_alpha'];
export const FORBIDDEN_TARGET_PORTS = ['55433'];

export interface UrlFacts {
  host: string;
  port: string;
  database: string;
  user: string;
}

export function urlFacts(url: string): UrlFacts {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    user: decodeURIComponent(parsed.username),
  };
}

/** Password-free label for logs: user@host:port/db. */
export function describeUrl(url: string): string {
  const f = urlFacts(url);
  return `${f.user}@${f.host}:${f.port}/${f.database}`;
}

/**
 * Throws unless `targetUrl` is a database the carry may write to.
 * Live production (db juanderquest_alpha or port 55433) and the source itself are refused.
 */
export function assertWritableTarget(targetUrl: string, sourceUrl?: string): void {
  const t = urlFacts(targetUrl);
  if (FORBIDDEN_TARGET_DATABASES.includes(t.database)) {
    throw new Error(`Refusing target database "${t.database}" (live production).`);
  }
  if (FORBIDDEN_TARGET_PORTS.includes(t.port)) {
    throw new Error(`Refusing target port ${t.port} (live production container).`);
  }
  if (!['127.0.0.1', 'localhost'].includes(t.host)) {
    throw new Error('Refusing non-loopback target host.');
  }
  if (sourceUrl) {
    const s = urlFacts(sourceUrl);
    if (s.host === t.host && s.port === t.port && s.database === t.database) {
      throw new Error('Source and target are the same database.');
    }
  }
}

// Every value is read as the server's text representation, so nothing is
// re-interpreted in JavaScript (dates, numerics, int8, arrays, bytea stay exact).
const rawTypes = { getTypeParser: () => (value: string) => value } as unknown as typeof types;

export async function connect(url: string, applicationName: string): Promise<Client> {
  const client = new Client({
    connectionString: url,
    application_name: applicationName,
    connectionTimeoutMillis: 10_000,
    types: rawTypes,
  });
  await client.connect();
  await client.query(`SET TIME ZONE 'UTC'`);
  await client.query(`SET statement_timeout = '15min'`);
  return client;
}

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_$]*$/i.test(name)) throw new Error(`Unexpected identifier: ${name}`);
  return `"${name.replace(/"/g, '""')}"`;
}

export async function currentDatabase(client: Client): Promise<string> {
  const { rows } = await client.query(`SELECT current_database() AS db`);
  return rows[0].db;
}
