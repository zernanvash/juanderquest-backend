import dotenv from 'dotenv';
import { bool, cleanEnv, str, port, num } from 'envalid';
import { validateAndParseCorsOrigin } from './cors.js';

dotenv.config();

const isLocalRuntime = process.env.NODE_ENV !== 'production';

const rawEnv = cleanEnv(process.env, {
  PORT: port({ default: process.env.NODE_ENV === 'production' ? 4000 : 4100 }),
  HOST: str({ default: '127.0.0.1' }),
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  DATABASE_URL: str({ default: 'postgres://postgres:postgres@localhost:5432/juanderquest' }),
  // Local development/test keeps the prototype fallback; production always fails closed.
  ALLOW_IN_MEMORY_FALLBACK: bool({ default: isLocalRuntime }),
  // Prototype fixtures are local-only and can never be enabled in production.
  SEED_DEVELOPMENT_DATA: bool({ default: isLocalRuntime }),
  // Fail fast in production when the real secret is missing; dev/test get a throwaway default.
  JWT_SECRET: process.env.NODE_ENV === 'production' ? str() : str({ default: 'dev_only_jwt_secret_do_not_use_in_production' }),
  CORS_ORIGIN: process.env.NODE_ENV === 'production' ? str() : str({ default: '*' }),
  WALLET_AUTH_MODE: str({
    choices: ['local', 'signature'],
    default: process.env.NODE_ENV === 'test' ? 'local' : 'signature',
  }),
  ALLOW_INSECURE_LOCAL_WALLET_AUTH: bool({ default: false }),
  // Demo accounts include an admin fixture; never enable them by default in development.
  ALLOW_DEMO_LOGIN: bool({ default: process.env.NODE_ENV === 'test' }),
  GUEST_LOGIN_ENABLED: bool({ default: isLocalRuntime }),
  ALPHA_WALLET_SIMULATION_ENABLED: bool({ default: false }),
  // Merchant offers in the prototype migrations are fixtures, not live deals.
  MARKETPLACE_ENABLED: bool({ default: isLocalRuntime }),
  SPOT_PHOTO_STORAGE: str({ choices: ['local', 'azure'], default: 'local' }),
  AZURE_STORAGE_CONNECTION_STRING: str({ default: '' }),
  AZURE_STORAGE_CONTAINER_NAME: str({ default: 'spot-photos' }),
  LOCAL_UPLOAD_DIR: str({ default: 'uploads/spot-photos' }),
  VALHALLA_URL: str({ default: 'http://127.0.0.1:8002' }),
  PROGRESSION_ENABLED: bool({ default: true }),
  PROGRESSION_EMIT_OUTBOX_ENABLED: bool({ default: true }),
  PROGRESSION_OUTBOX_WORKER_ENABLED: bool({ default: false }),
  PROGRESSION_OUTBOX_WORKER_INTERVAL_MS: num({ default: 5000 }),
  PROGRESSION_OUTBOX_WORKER_BATCH_SIZE: num({ default: 20 }),
  JUANCHOICE_ENABLED: bool({ default: false }),
  JUANCHOICE_WRITES_ENABLED: bool({ default: false }),
  JUANCHOICE_BATCH_WRITES_ENABLED: bool({ default: false }),
  JUANCHOICE_PROMOTION_ENABLED: bool({ default: false }),
  JUANCHOICE_ECONOMY_ENABLED: bool({ default: false }),
  JUANCHOICE_FINALIZER_WORKER_ENABLED: bool({ default: false }),
  JUANCHOICE_FINALIZER_INTERVAL_MS: num({ default: 30000 }),
  JUANCHOICE_SCHEDULER_ENABLED: bool({ default: false }),
  JUANCHOICE_SCHEDULER_INTERVAL_MS: num({ default: 60000 }),
  JUANCHOICE_SCHEDULER_BATCH_SIZE: num({ default: 20 }),
  JUANCHOICE_PRESENTATION_MODE: bool({ default: false }),
  JUANCHOICE_PRESENTATION_CAMPAIGN_ID: str({ default: '' }),
  JUANCHOICE_PRESENTATION_DB_NAME: str({ default: '' }),
  JDQ_PRESENTATION_PROFILE: str({ default: 'local' }),
});

const flagOverrides: Record<string, any> = {};

// The proxy intentionally supports scoped test overrides; cleanEnv's readonly
// type does not describe that existing runtime behavior.
type MutableEnv = { -readonly [K in keyof typeof rawEnv]: typeof rawEnv[K] };
export const env: MutableEnv = new Proxy({} as any, {
  get(_target, prop: string) {
    if (prop in flagOverrides) {
      return flagOverrides[prop];
    }
    return (rawEnv as any)[prop];
  },
  set(_target, prop: string, value) {
    flagOverrides[prop] = value;
    return true;
  },
  has(_target, prop: string) {
    return prop in flagOverrides || prop in rawEnv;
  },
  ownKeys(_target) {
    return Reflect.ownKeys(rawEnv);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return {
      enumerable: true,
      configurable: true,
      writable: true,
      value: (env as any)[prop],
    };
  },
});

if (env.NODE_ENV === 'production' && env.WALLET_AUTH_MODE === 'local') {
  throw new Error('Production requires signature wallet authentication');
}

if (env.NODE_ENV === 'development' && env.PORT === 4000) {
  throw new Error('Port 4000 is reserved for the public alpha API. Use development port 4100.');
}

if (env.NODE_ENV === 'production' && env.ALLOW_IN_MEMORY_FALLBACK) {
  throw new Error('ALLOW_IN_MEMORY_FALLBACK cannot be enabled in production');
}

if (env.NODE_ENV === 'production' && env.SEED_DEVELOPMENT_DATA) {
  throw new Error('SEED_DEVELOPMENT_DATA cannot be enabled in production');
}

if (env.SPOT_PHOTO_STORAGE === 'azure' && !env.AZURE_STORAGE_CONNECTION_STRING) {
  throw new Error('AZURE_STORAGE_CONNECTION_STRING is required when SPOT_PHOTO_STORAGE=azure');
}

if (!Number.isInteger(env.PROGRESSION_OUTBOX_WORKER_INTERVAL_MS) || env.PROGRESSION_OUTBOX_WORKER_INTERVAL_MS <= 0) {
  throw new Error('PROGRESSION_OUTBOX_WORKER_INTERVAL_MS must be a positive integer');
}

if (!Number.isInteger(env.PROGRESSION_OUTBOX_WORKER_BATCH_SIZE) || env.PROGRESSION_OUTBOX_WORKER_BATCH_SIZE <= 0) {
  throw new Error('PROGRESSION_OUTBOX_WORKER_BATCH_SIZE must be a positive integer');
}

if (!Number.isInteger(env.JUANCHOICE_FINALIZER_INTERVAL_MS) || env.JUANCHOICE_FINALIZER_INTERVAL_MS <= 0) {
  throw new Error('JUANCHOICE_FINALIZER_INTERVAL_MS must be a positive integer');
}

if (!Number.isInteger(env.JUANCHOICE_SCHEDULER_INTERVAL_MS) || env.JUANCHOICE_SCHEDULER_INTERVAL_MS <= 0) {
  throw new Error('JUANCHOICE_SCHEDULER_INTERVAL_MS must be a positive integer');
}
if (!Number.isInteger(env.JUANCHOICE_SCHEDULER_BATCH_SIZE) || env.JUANCHOICE_SCHEDULER_BATCH_SIZE < 1 || env.JUANCHOICE_SCHEDULER_BATCH_SIZE > 100) {
  throw new Error('JUANCHOICE_SCHEDULER_BATCH_SIZE must be an integer from 1 to 100');
}

// Fail-closed validation for CORS_ORIGIN across environments
validateAndParseCorsOrigin(env.CORS_ORIGIN, env.NODE_ENV, env.JUANCHOICE_PRESENTATION_MODE);

export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function extractDatabaseName(databaseUrl: string): string | null {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return null;
    const dbName = parsed.pathname.replace(/^\//, '').trim();
    return /^[a-z][a-z0-9_]*$/.test(dbName) ? dbName : null;
  } catch {
    return null;
  }
}

export function isPresentationDatabaseName(
  dbName: string,
  nodeEnv: string,
  profile: string = process.env.JDQ_PRESENTATION_PROFILE || 'local'
): boolean {
  if (dbName === 'juanderquest_presentation') return true;
  if (profile === 'public' && process.env.JDQ_TEST_HARNESS_SCOPE !== 'isolated_script_drill') {
    return false;
  }
  return (
    (nodeEnv === 'test' || process.env.JDQ_ALLOW_PRESENTATION_TEST_DB === 'true') &&
    (dbName === 'juanderquest_presentation_test' ||
      dbName.startsWith('juanderquest_presentation_test') ||
      dbName.startsWith('test_db_') ||
      dbName.startsWith('juanderquest_presentation_drill_'))
  );
}

export function validatePresentationModeConfig(targetEnv: typeof env = env): void {
  if (!targetEnv.JUANCHOICE_PRESENTATION_MODE) {
    return;
  }

  if (targetEnv.ALLOW_IN_MEMORY_FALLBACK) {
    throw new Error('JUANCHOICE_PRESENTATION_MODE cannot be enabled when ALLOW_IN_MEMORY_FALLBACK is true.');
  }

  if (targetEnv.NODE_ENV === 'production' && targetEnv.WALLET_AUTH_MODE !== 'signature') {
    throw new Error('JUANCHOICE_PRESENTATION_MODE requires signature wallet authentication in production.');
  }

  const presentationProfile = targetEnv.JDQ_PRESENTATION_PROFILE?.trim() || 'local';
  if (presentationProfile !== 'local' && presentationProfile !== 'public') {
    throw new Error('JDQ_PRESENTATION_PROFILE must be "local" or "public".');
  }

  const expectedCorsOrigin = presentationProfile === 'public'
    ? 'https://presentation.juanderquest.app'
    : 'http://127.0.0.1:3200';

  if (targetEnv.NODE_ENV === 'production' &&
    (targetEnv.HOST !== '127.0.0.1' || targetEnv.PORT !== 4200 || targetEnv.CORS_ORIGIN !== expectedCorsOrigin)) {
    throw new Error(`JUANCHOICE_PRESENTATION_MODE in ${presentationProfile} profile requires dedicated loopback API port 4200 and web origin ${expectedCorsOrigin}.`);
  }

  const campaignId = targetEnv.JUANCHOICE_PRESENTATION_CAMPAIGN_ID?.trim();
  if (!campaignId || !UUID_V4_REGEX.test(campaignId)) {
    throw new Error('JUANCHOICE_PRESENTATION_MODE requires a valid UUID for JUANCHOICE_PRESENTATION_CAMPAIGN_ID.');
  }

  const dbNameSetting = targetEnv.JUANCHOICE_PRESENTATION_DB_NAME?.trim();
  if (presentationProfile === 'public' && process.env.JDQ_TEST_HARNESS_SCOPE !== 'isolated_script_drill') {
    if (process.env.JDQ_ALLOW_PRESENTATION_TEST_DB === 'true') {
      throw new Error('JDQ_ALLOW_PRESENTATION_TEST_DB is forbidden in public presentation profile outside isolated script drill harness.');
    }
    if (dbNameSetting !== 'juanderquest_presentation') {
      throw new Error(`Public presentation profile requires canonical database "juanderquest_presentation", got "${dbNameSetting}".`);
    }
  }

  if (!dbNameSetting || !isPresentationDatabaseName(dbNameSetting, targetEnv.NODE_ENV, presentationProfile)) {
    throw new Error('JUANCHOICE_PRESENTATION_MODE requires a dedicated presentation database name.');
  }

  const actualDbName = extractDatabaseName(targetEnv.DATABASE_URL);
  if (!actualDbName) {
    throw new Error('JUANCHOICE_PRESENTATION_MODE: DATABASE_URL must be a valid connection string containing a database name.');
  }

  if (actualDbName !== dbNameSetting) {
    throw new Error(
      `JUANCHOICE_PRESENTATION_MODE database mismatch: configured allowlist "${dbNameSetting}" does not match DATABASE_URL database "${actualDbName}".`
    );
  }

  if (targetEnv.NODE_ENV === 'production') {
    const databaseUrl = new URL(targetEnv.DATABASE_URL);
    if (databaseUrl.hostname !== '127.0.0.1' || databaseUrl.port !== '55434' ||
        databaseUrl.username !== 'jdq_presentation' || databaseUrl.search || databaseUrl.hash) {
      throw new Error('JUANCHOICE_PRESENTATION_MODE requires dedicated loopback PostgreSQL on port 55434.');
    }
  }
}

validatePresentationModeConfig(env);
