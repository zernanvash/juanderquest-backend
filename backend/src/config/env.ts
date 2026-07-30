import dotenv from 'dotenv';
import { cleanEnv, str, port } from 'envalid';

dotenv.config();

export const env = cleanEnv(process.env, {
  PORT: port({ default: 4000 }),
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  DATABASE_URL: str({ default: 'postgres://postgres:postgres@localhost:5432/juanderquest' }),
  JWT_SECRET: str({ default: 'juanderquest_prototype_secret_key_2026_super_secure' }),
  CORS_ORIGIN: str({ default: '*' }),
});
