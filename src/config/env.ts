import dotenv from 'dotenv';
import { bool, cleanEnv, str, port, num } from 'envalid';

dotenv.config();

const isLocalRuntime = process.env.NODE_ENV !== 'production';

const rawEnv = cleanEnv(process.env, {
  PORT: port({ default: 4000 }),
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  DATABASE_URL: str({ default: 'postgres://postgres:postgres@localhost:5432/juanderquest' }),
  // Local development/test keeps the prototype fallback; production always fails closed.
  ALLOW_IN_MEMORY_FALLBACK: bool({ default: isLocalRuntime }),
  // Prototype fixtures are local-only and can never be enabled in production.
  SEED_DEVELOPMENT_DATA: bool({ default: isLocalRuntime }),
  // Fail fast in production when the real secret is missing; dev/test get a throwaway default.
  JWT_SECRET: process.env.NODE_ENV === 'production' ? str() : str({ default: 'dev_only_jwt_secret_do_not_use_in_production' }),
  CORS_ORIGIN: str({ default: '*' }),
  WALLET_AUTH_MODE: str({
    choices: ['local', 'signature'],
    default: process.env.NODE_ENV === 'production' ? 'signature' : 'local',
  }),
  ALLOW_INSECURE_LOCAL_WALLET_AUTH: bool({ default: false }),
  ALLOW_DEMO_LOGIN: bool({ default: isLocalRuntime }),
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
  JUANCHOICE_PROMOTION_ENABLED: bool({ default: false }),
  JUANCHOICE_ECONOMY_ENABLED: bool({ default: false }),
  JUANCHOICE_FINALIZER_WORKER_ENABLED: bool({ default: false }),
  JUANCHOICE_FINALIZER_INTERVAL_MS: num({ default: 30000 }),
});

const flagOverrides: Record<string, any> = {};

export const env: typeof rawEnv = new Proxy({} as any, {
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

if (env.NODE_ENV === 'production' && env.WALLET_AUTH_MODE === 'local' && !env.ALLOW_INSECURE_LOCAL_WALLET_AUTH) {
  throw new Error('Production local wallet auth requires ALLOW_INSECURE_LOCAL_WALLET_AUTH=true');
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
