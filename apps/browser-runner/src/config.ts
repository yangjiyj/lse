import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RunnerConfig } from './contracts.js';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const token = env.BROWSER_RUNNER_INTERNAL_TOKEN ?? env.INTERNAL_TOKEN ?? '';
  if (Buffer.byteLength(token, 'utf8') < 32) {
    throw new Error('BROWSER_RUNNER_INTERNAL_TOKEN must be at least 32 bytes');
  }

  const evidenceDir = resolve(env.BROWSER_RUNNER_EVIDENCE_DIR ?? '/tmp/runner-evidence');
  mkdirSync(evidenceDir, { recursive: true });

  return {
    port: intEnv('BROWSER_RUNNER_PORT', 8094),
    host: env.BROWSER_RUNNER_HOST ?? '0.0.0.0',
    internalToken: token,
    evidenceDir,
    concurrency: intEnv('BROWSER_CONCURRENCY', 3),
    defaultHardTimeoutMs: intEnv('BROWSER_RUNNER_HARD_TIMEOUT_MS', 75_000),
    defaultStableMs: intEnv('BROWSER_RUNNER_STABLE_MS', 2_000),
    maxConsoleLogs: intEnv('BROWSER_RUNNER_MAX_CONSOLE_LOGS', 100),
    maxConsoleLogLength: intEnv('BROWSER_RUNNER_MAX_CONSOLE_LOG_LENGTH', 2_000),
    maxResponseChars: intEnv('BROWSER_RUNNER_MAX_RESPONSE_CHARS', 20_000),
    sessionMaxAgeMs: intEnv('BROWSER_RUNNER_SESSION_MAX_AGE_MS', 10 * 60_000),
    headless: env.BROWSER_RUNNER_HEADFUL === 'true' ? false : true,
  };
}
