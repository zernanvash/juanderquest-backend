import dotenv from 'dotenv';
import { cleanEnv, str, port } from 'envalid';

dotenv.config();

export const env = cleanEnv(process.env, {
  PORT: port({ default: 4000 }),
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  DATABASE_URL: str({ default: 'postgres://postgres:postgres@localhost:5432/juanderquest' }),
  // Fail fast in production when the real secret is missing; dev/test get a throwaway default.
  JWT_SECRET: process.env.NODE_ENV === 'production' ? str() : str({ default: 'dev_only_jwt_secret_do_not_use_in_production' }),
  CORS_ORIGIN: str({ default: '*' }),
});
