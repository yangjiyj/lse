import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeTestDatabaseUrl } from './test-db-safety.js';

// tsx does not auto-load .env. Load the repo-root .env as a side effect so that
// process.env is populated before config.ts runs its zod validation and before
// Prisma reads DATABASE_URL. In containers env is injected directly and the file
// may be absent, so failure to load is non-fatal.
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '../../../.env');
try {
  process.loadEnvFile(envPath);
} catch {
  // .env optional — ignore when not present
}

if (process.env.LSE_TEST === '1') {
  assertSafeTestDatabaseUrl(process.env.DATABASE_URL ?? '');
}
