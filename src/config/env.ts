import dotenv from 'dotenv';
import { bool, cleanEnv, str, port } from 'envalid';

dotenv.config();

export const env = cleanEnv(process.env, {
  PORT: port({ default: 4000 }),
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  DATABASE_URL: str({ default: 'postgres://postgres:postgres@localhost:5432/juanderquest' }),
  // Fail fast in production when the real secret is missing; dev/test get a throwaway default.
  JWT_SECRET: process.env.NODE_ENV === 'production' ? str() : str({ default: 'dev_only_jwt_secret_do_not_use_in_production' }),
  CORS_ORIGIN: str({ default: '*' }),
  WALLET_AUTH_MODE: str({
    choices: ['local', 'signature'],
    default: process.env.NODE_ENV === 'production' ? 'signature' : 'local',
  }),
  ALLOW_INSECURE_LOCAL_WALLET_AUTH: bool({ default: false }),
});

if (env.NODE_ENV === 'production' && env.WALLET_AUTH_MODE === 'local' && !env.ALLOW_INSECURE_LOCAL_WALLET_AUTH) {
  throw new Error('Production local wallet auth requires ALLOW_INSECURE_LOCAL_WALLET_AUTH=true');
}
