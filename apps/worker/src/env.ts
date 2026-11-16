import path from 'path';
import dotenv from 'dotenv';

// Load root .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

export const env = {
  DATABASE_URL:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/codexray?schema=public',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
};
