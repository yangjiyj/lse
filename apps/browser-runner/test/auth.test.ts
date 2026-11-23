import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRunnerApp } from '../src/app.js';
import type { BrowserRunner } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { TEST_TOKEN, testConfig } from './helpers.js';

test('loadConfig fails closed when token is missing or too short', () => {
  assert.throws(() => loadConfig({}), /at least 32 bytes/);
  assert.throws(() => loadConfig({ BROWSER_RUNNER_INTERNAL_TOKEN: 'short' }), /at least 32 bytes/);
});

test('protected routes require X-Internal-Token and healthz does not', async () => {
  const runner = {
    turn: async () => {
      throw new Error('must not be called without auth');
    },
    closeSession: async () => undefined,
    close: async () => undefined,
  } as unknown as BrowserRunner;
  const app = await buildRunnerApp({ config: testConfig(), runner });
  try {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);

    const missing = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turn',
      payload: { entryUrl: 'http://example.com', prompt: 'hi' },
    });
    assert.equal(missing.statusCode, 401);

    const wrong = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turn',
      headers: { 'x-internal-token': `${TEST_TOKEN}x` },
      payload: { entryUrl: 'http://example.com', prompt: 'hi' },
    });
    assert.equal(wrong.statusCode, 401);
  } finally {
    await app.close();
  }
});
