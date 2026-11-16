import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

export const env = {
  PORT: Number(process.env.PORT || 4000),
  DATABASE_URL:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/codexray?schema=public',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || '',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || '',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  JWT_SECRET: process.env.JWT_SECRET || 'codexray-fallback-secret-key',
  WEB_URL: process.env.WEB_URL || 'http://localhost:3000',
  API_URL: process.env.API_URL || 'http://localhost:4000',
};
