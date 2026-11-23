import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildRunnerApp } from '../src/app.js';
import type { RouteTransport } from '../src/browser.js';
import type { DnsResolver } from '../src/ip-guard.js';
import { TEST_TOKEN, testConfig } from './helpers.js';

class LocalResolver implements DnsResolver {
  async lookup(hostname: string): Promise<string[]> {
    if (hostname === 'locator.test') return ['93.184.216.34'];
    return [];
  }
}

test('heuristic locator runs a textarea plus button chat turn and records candidates', async (t) => {
  const fixture = startLocatorFixture('textarea-button');
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-heuristic-textarea/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/textarea-button'),
      prompt: 'hello locator',
      options: { stableMs: 150, hardTimeoutMs: 5_000 },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'OK');
  assert.equal(body.text, 'Bot: hello locator');
  assert.equal(body.evidence.selectors.source, 'heuristic');
  assert.equal(body.evidence.selectors.input, '#composer');
  assert.equal(body.evidence.selectors.send, '#send-message');
  assert.equal(body.evidence.selectors.bubble, '.message.bot');
  assert.ok(body.evidence.selectors.candidates.length >= 2);
  assert.ok(
    body.evidence.selectors.candidates.some((candidate: { el: string; reason: string }) =>
      candidate.reason.includes('placeholder'),
    ),
  );
});

test('heuristic locator can type into contenteditable and send with Enter', async (t) => {
  const fixture = startLocatorFixture('contenteditable-enter');
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-heuristic-contenteditable/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/contenteditable-enter'),
      prompt: 'editable prompt',
      options: { stableMs: 150, hardTimeoutMs: 5_000 },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'OK');
  assert.equal(body.text, 'Answer: editable prompt');
  assert.equal(body.evidence.selectors.source, 'heuristic');
  assert.equal(body.evidence.selectors.input, '#editable-composer');
  assert.equal(body.evidence.selectors.send, 'Enter');
  assert.equal(body.evidence.selectors.bubble, '.reply');
});

test('heuristic locator falls back to send button when Enter only inserts a newline', async (t) => {
  const fixture = startLocatorFixture('textarea-button-enter-newline');
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-heuristic-button-fallback/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/textarea-button-enter-newline'),
      prompt: 'button fallback',
      options: { stableMs: 150, hardTimeoutMs: 5_000 },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'OK');
  assert.equal(body.text, 'Button: button fallback');
  assert.equal(body.evidence.selectors.source, 'heuristic');
  assert.equal(body.evidence.selectors.input, '#newline-composer');
  assert.equal(body.evidence.selectors.send, '#newline-send');
  assert.equal(body.evidence.selectors.bubble, '.answer');
});

test('heuristic locator refuses to continue when send is not confirmed', async (t) => {
  const fixture = startLocatorFixture('unsent');
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-heuristic-unsent/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/unsent'),
      prompt: 'should not send',
      options: { stableMs: 150, hardTimeoutMs: 2_000 },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'SKIPPED');
  assert.equal(body.skipReason, 'locate_failed');
  assert.equal(body.evidence.selectors.source, 'heuristic');
  assert.equal(body.evidence.selectors.input, '#unsent-composer');
  assert.equal(body.evidence.selectors.send, 'Enter');
  assert.ok(body.evidence.selectors.candidates.length >= 1);
  assert.equal(body.evidence.timing.sentAt, null);
  assert.ok(body.evidence.screenshots.afterSend);
});

test('accessConfig.selectors wins over heuristic detection', async (t) => {
  const fixture = startLocatorFixture('config-selector');
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-config-selectors/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/config-selector'),
      prompt: 'configured',
      accessConfig: {
        selectors: {
          input: '#configured-input',
          send: '#configured-send',
          bubble: '.configured-reply',
        },
      },
      options: { stableMs: 150, hardTimeoutMs: 5_000 },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'OK');
  assert.equal(body.text, 'Configured: configured');
  assert.equal(body.evidence.selectors.source, 'config');
  assert.equal(body.evidence.selectors.input, '#configured-input');
  assert.equal(body.evidence.selectors.send, '#configured-send');
  assert.equal(body.evidence.selectors.bubble, '.configured-reply');
});

test('locator failure returns SKIPPED locate_failed with screenshot and candidates', async (t) => {
  const fixture = startLocatorFixture('missing');
  const config = testConfig();
  const app = await buildRunnerApp({
    config,
    resolver: new LocalResolver(),
    routeTransport: fixture.transport,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/sessions/s-heuristic-missing/turn',
    headers: { 'x-internal-token': TEST_TOKEN },
    payload: {
      entryUrl: fixture.url('/missing'),
      prompt: 'hello',
      options: { stableMs: 150, hardTimeoutMs: 2_000 },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.status, 'SKIPPED');
  assert.equal(body.skipReason, 'locate_failed');
  assert.equal(body.evidence.selectors.source, 'heuristic');
  assert.ok(Array.isArray(body.evidence.selectors.candidates));
  assert.ok(body.evidence.screenshots.afterResponse);
  assert.ok(existsSync(join(config.evidenceDir, body.evidence.screenshots.afterResponse)));
});

type LocatorFixtureMode =
  | 'textarea-button'
  | 'textarea-button-enter-newline'
  | 'contenteditable-enter'
  | 'config-selector'
  | 'unsent'
  | 'missing';

function startLocatorFixture(mode: LocatorFixtureMode) {
  return {
    url: (path: string) => `http://locator.test${path}`,
    transport: (async (route, context) => {
      const url = new URL(context.originalUrl);
      if (url.hostname !== 'locator.test') return false;
      if (url.pathname === '/favicon.ico') {
        await route.fulfill({ status: 204, body: '' });
        return true;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: renderLocatorFixture(mode),
      });
      return true;
    }) satisfies RouteTransport,
  };
}

function renderLocatorFixture(mode: LocatorFixtureMode): string {
  if (mode === 'missing') {
    return `<!doctype html><html><body><header>Help center</header><main><p>No composer here.</p></main></body></html>`;
  }
  if (mode === 'contenteditable-enter') {
    return `<!doctype html>
<html>
<body>
  <main style="height: 720px; display: flex; flex-direction: column;">
    <section id="thread" style="flex: 1;">
      <article class="reply">Earlier answer</article>
    </section>
    <div id="editable-composer" contenteditable="true" role="textbox" aria-label="Ask a question" style="min-height: 44px; width: 620px;"></div>
  </main>
  <script>
    const input = document.querySelector('#editable-composer');
    const thread = document.querySelector('#thread');
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const prompt = input.textContent.trim();
      input.textContent = '';
      const mine = document.createElement('article');
      mine.className = 'mine';
      mine.textContent = prompt;
      thread.appendChild(mine);
      setTimeout(() => {
        const reply = document.createElement('article');
        reply.className = 'reply';
        reply.textContent = 'Answer: ' + prompt;
        thread.appendChild(reply);
      }, 40);
    });
  </script>
</body>
</html>`;
  }
  if (mode === 'config-selector') {
    return `<!doctype html>
<html>
<body>
  <textarea id="decoy-input" placeholder="Message"></textarea>
  <button id="decoy-send" disabled>Send</button>
  <textarea id="configured-input"></textarea>
  <button id="configured-send">Go</button>
  <div id="configured-thread"></div>
  <script>
    const input = document.querySelector('#configured-input');
    const thread = document.querySelector('#configured-thread');
    document.querySelector('#configured-send').addEventListener('click', () => {
      const prompt = input.value;
      input.value = '';
      const mine = document.createElement('p');
      mine.className = 'configured-mine';
      mine.textContent = prompt;
      thread.appendChild(mine);
      const reply = document.createElement('p');
      reply.className = 'configured-reply';
      reply.textContent = 'Configured: ' + prompt;
      thread.appendChild(reply);
    });
  </script>
</body>
</html>`;
  }
  if (mode === 'unsent') {
    return `<!doctype html>
<html>
<body>
  <main style="height: 720px; display: flex; flex-direction: column;">
    <section id="unsent-thread" style="flex: 1;">
      <p class="answer">Waiting</p>
    </section>
    <textarea id="unsent-composer" placeholder="Ask anything" style="width: 640px; height: 48px;"></textarea>
  </main>
</body>
</html>`;
  }
  if (mode === 'textarea-button-enter-newline') {
    return `<!doctype html>
<html>
<body>
  <main style="height: 720px; display: flex; flex-direction: column;">
    <section id="newline-thread" style="flex: 1;">
      <p class="answer">Ready</p>
    </section>
    <div style="display: flex; gap: 8px;">
      <textarea id="newline-composer" placeholder="Send a message" style="width: 660px; height: 48px;"></textarea>
      <button id="newline-send" aria-label="Send message" title="Send">Send</button>
    </div>
  </main>
  <script>
    const input = document.querySelector('#newline-composer');
    const thread = document.querySelector('#newline-thread');
    document.querySelector('#newline-send').addEventListener('click', () => {
      const prompt = input.value.trim();
      input.value = '';
      const mine = document.createElement('p');
      mine.className = 'mine';
      mine.textContent = prompt;
      thread.appendChild(mine);
      setTimeout(() => {
        const reply = document.createElement('p');
        reply.className = 'answer';
        reply.textContent = 'Button: ' + prompt;
        thread.appendChild(reply);
      }, 40);
    });
  </script>
</body>
</html>`;
  }
  return `<!doctype html>
<html>
<body>
  <main style="height: 720px; display: flex; flex-direction: column;">
    <nav><button>Docs</button><button>Settings</button></nav>
    <section id="messages" style="flex: 1;">
      <div class="message bot">Welcome</div>
    </section>
    <form id="composer-form" style="display: flex; gap: 8px;">
      <textarea id="composer" placeholder="Type a message" style="width: 680px; height: 48px;"></textarea>
      <button id="send-message" aria-label="Send message" title="Send">
        <svg aria-label="send icon" viewBox="0 0 16 16"><path d="M1 8l14-7-4 14-3-5z"></path></svg>
      </button>
    </form>
  </main>
  <script>
    const form = document.querySelector('#composer-form');
    const input = document.querySelector('#composer');
    const messages = document.querySelector('#messages');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const prompt = input.value;
      input.value = '';
      const mine = document.createElement('div');
      mine.className = 'message mine';
      mine.textContent = prompt;
      messages.appendChild(mine);
      setTimeout(() => {
        const reply = document.createElement('div');
        reply.className = 'message bot';
        reply.textContent = 'Bot: ' + prompt;
        messages.appendChild(reply);
      }, 40);
    });
  </script>
</body>
</html>`;
}
