import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildRunnerApp } from '../src/app.js';
import type { DnsResolver } from '../src/ip-guard.js';
import type { RouteTransport } from '../src/browser.js';
import { TEST_TOKEN, testConfig } from './helpers.js';

const selectors = {
  input: '#chat-input',
  send: '#send-button',
  bubble: '.agent-bubble',
};

class LocalResolver implements DnsResolver {
  async lookup(hostname: string): Promise<string[]> {
    if (hostname === 'fixture.test') return ['93.184.216.34'];
    return [];
  }
}

test('single page single turn returns full text and evidence', async (t) => {
  const fixture = await startFixture('ok');
  t.after(async () => fixture.close());
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-ok/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/ok'),
      prompt: 'hello',
      selectors,
      options: { stableMs: 200, hardTimeoutMs: 10_000 },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'OK');
  assert.equal(body.text, 'Echo: hello');
  assert.equal(body.doneReason, 'dom_idle');
  assert.equal(body.evidence.attack.prompt, 'hello');
  assert.equal(body.evidence.response.text, 'Echo: hello');
  assert.equal(body.evidence.selectors.source, 'config');
  assert.ok(body.evidence.screenshots.afterSend);
  assert.ok(body.evidence.screenshots.afterResponse);
  assert.ok(existsSync(join(config.evidenceDir, body.evidence.screenshots.afterResponse)));
});

test('locate failure returns SKIPPED locate_failed with screenshot', async (t) => {
  const fixture = await startFixture('missing');
  t.after(async () => fixture.close());
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-missing/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/missing'),
      prompt: 'hello',
      selectors,
      options: { stableMs: 200, hardTimeoutMs: 10_000 },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'SKIPPED');
  assert.equal(body.skipReason, 'locate_failed');
  assert.ok(body.evidence.screenshots.afterResponse);
});

test('response hard timeout returns truncated OK result', async (t) => {
  const fixture = await startFixture('timeout');
  t.after(async () => fixture.close());
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-timeout/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/timeout'),
      prompt: 'hello',
      selectors,
      options: { stableMs: 400, hardTimeoutMs: 700 },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'OK');
  assert.equal(body.doneReason, 'timeout');
  assert.equal(body.truncated, true);
  assert.equal(body.evidence.response.truncated, true);
});

test('session wall clock expiry closes and removes idle sessions', async (t) => {
  const fixture = await startFixture('ok');
  t.after(async () => fixture.close());
  const config = testConfig({ sessionMaxAgeMs: 500 });
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const first = await app.inject({
    method: 'POST',
    url: '/sessions/s-expire/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/ok'),
      prompt: 'first',
      selectors,
      options: { stableMs: 100, hardTimeoutMs: 5_000 },
    },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().evidence.turnIndex, 0);

  await new Promise((resolve) => setTimeout(resolve, 900));

  const second = await app.inject({
    method: 'POST',
    url: '/sessions/s-expire/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/ok'),
      prompt: 'second',
      selectors,
      options: { stableMs: 100, hardTimeoutMs: 5_000 },
    },
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().evidence.turnIndex, 0);
});

test('websocket requests to forbidden networks are aborted and recorded', async (t) => {
  const fixture = await startFixture('websocket');
  t.after(async () => fixture.close());
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-subresource/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/websocket'),
      prompt: 'hello',
      selectors,
      options: { stableMs: 200, hardTimeoutMs: 10_000 },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'OK');
  assert.ok(
    body.evidence.page.consoleLogs.some((line: string) => line.includes('169.254.169.254')),
    JSON.stringify(body.evidence.page.consoleLogs),
  );
});

test('subresource requests to forbidden networks are aborted and recorded', async (t) => {
  const fixture = await startFixture('subresource');
  t.after(async () => fixture.close());
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-subresource/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/subresource'),
      prompt: 'hello',
      selectors,
      options: { stableMs: 200, hardTimeoutMs: 10_000 },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'OK');
  assert.ok(
    body.evidence.page.consoleLogs.some((line: string) => line.includes('169.254.169.254')),
    JSON.stringify(body.evidence.page.consoleLogs),
  );
});

test('missing response bubble waits for timeout instead of returning empty dom_idle OK', async (t) => {
  const fixture = await startFixture('no-response');
  t.after(async () => fixture.close());
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-no-response/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/no-response'),
      prompt: 'hello',
      selectors,
      options: { stableMs: 200, hardTimeoutMs: 700 },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'OK');
  assert.equal(body.text, '');
  assert.equal(body.doneReason, 'timeout');
  assert.equal(body.truncated, true);
});

async function startFixture(
  mode: 'ok' | 'missing' | 'subresource' | 'timeout' | 'websocket' | 'no-response',
) {
  return {
    url: (path: string) => `http://fixture.test${path}`,
    transport: (async (route, context) => {
      const url = new URL(context.originalUrl);
      if (url.hostname !== 'fixture.test') return false;
      if (url.pathname === '/favicon.ico') {
        await route.fulfill({ status: 204, body: '' });
        return true;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: renderFixture(mode),
      });
      return true;
    }) satisfies RouteTransport,
    close: async () => undefined,
  };
}

function renderFixture(
  mode: 'ok' | 'missing' | 'subresource' | 'timeout' | 'websocket' | 'no-response',
): string {
  if (mode === 'missing') {
    return '<!doctype html><html><body><main>No chat controls here</main></body></html>';
  }
  const attack = mode === 'subresource' ? "fetch('http://169.254.169.254/');" : '';
  const wsAttack =
    mode === 'websocket'
      ? "const ws = new WebSocket('ws://169.254.169.254/socket'); ws.onerror = () => console.log('ws blocked 169.254.169.254');"
      : '';
  const interval = mode === 'timeout' ? 350 : 25;
  const suffix = mode === 'timeout' ? ' with a deliberately slow tail' : '';
  const replyScript =
    mode === 'no-response'
      ? ''
      : `const reply = document.createElement('div');
      reply.className = 'agent-bubble';
      messages.appendChild(reply);
      const text = 'Echo: ' + prompt + '${suffix}';
      let i = 0;
      const timer = setInterval(() => {
        reply.textContent = text.slice(0, ++i);
        if (i >= text.length) clearInterval(timer);
      }, ${interval});`;
  return `<!doctype html>
<html>
<body>
  <textarea id="chat-input"></textarea>
  <button id="send-button">Send</button>
  <div id="messages"></div>
  <img src="http://169.254.169.254/latest/meta-data">
  <script>
    ${attack}
    ${wsAttack}
    const input = document.querySelector('#chat-input');
    const messages = document.querySelector('#messages');
    document.querySelector('#send-button').addEventListener('click', () => {
      const prompt = input.value;
      input.value = '';
      const mine = document.createElement('div');
      mine.className = 'user-bubble';
      mine.textContent = prompt;
      messages.appendChild(mine);
      ${replyScript}
    });
  </script>
</body>
</html>`;
}
