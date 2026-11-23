import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerConfig } from '../src/contracts.js';

export const TEST_TOKEN = '0123456789abcdef0123456789abcdef'; // pragma: allowlist secret

export function testConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'lse-browser-runner-evidence-'));
  mkdirSync(evidenceDir, { recursive: true });
  return {
    port: 0,
    host: '127.0.0.1',
    internalToken: TEST_TOKEN,
    evidenceDir,
    concurrency: 3,
    defaultHardTimeoutMs: 10_000,
    defaultStableMs: 250,
    maxConsoleLogs: 20,
    maxConsoleLogLength: 500,
    maxResponseChars: 5_000,
    sessionMaxAgeMs: 60_000,
    headless: true,
    ...overrides,
  };
}
