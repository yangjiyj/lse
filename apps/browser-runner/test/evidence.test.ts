import assert from 'node:assert/strict';
import test from 'node:test';
import { turnRequestSchema, type TurnEvidence } from '../src/contracts.js';
import { makeEvidence, createTelemetry } from '../src/evidence.js';
import { redactEvidenceText } from '../src/redact.js';
import { TEST_TOKEN } from './helpers.js';

test('redactEvidenceText removes internal token and token-like fields', () => {
  const redacted = redactEvidenceText(
    `console leaked x-internal-token=${TEST_TOKEN} url=http://example.com/?api_key=secret123 token=abc`, // pragma: allowlist secret
    TEST_TOKEN,
  );
  assert.doesNotMatch(redacted, new RegExp(TEST_TOKEN));
  assert.doesNotMatch(redacted, /secret123/);
  assert.doesNotMatch(redacted, /token=abc/); // pragma: allowlist secret
  assert.match(redacted, /example\.com/);
});

test('turn request accepts per-site accessConfig selectors', () => {
  const parsed = turnRequestSchema.parse({
    entryUrl: 'https://example.com/chat',
    prompt: 'hello',
    accessConfig: {
      selectors: {
        input: '#input',
        send: '#send',
        bubble: '.reply',
      },
    },
  });

  assert.equal(parsed.accessConfig?.selectors?.input, '#input');
  assert.equal(parsed.accessConfig?.selectors?.send, '#send');
  assert.equal(parsed.accessConfig?.selectors?.bubble, '.reply');
});

test('selector evidence preserves heuristic candidates', () => {
  const selectors: TurnEvidence['selectors'] = {
    source: 'heuristic',
    input: '#composer',
    send: 'Enter',
    bubble: '.message.bot',
    candidates: [{ el: '#composer', score: 83, reason: 'textarea, placeholder/label keyword' }],
  };

  const evidence = makeEvidence(
    {
      sessionId: 's1',
      turnIndex: 0,
      prompt: 'hello',
      text: 'world',
      doneReason: 'dom_idle',
      truncated: false,
      afterSend: null,
      afterResponse: null,
      finalUrl: 'https://example.com/chat',
      title: 'Chat',
      selectors,
      sentAt: '2026-06-24T00:00:00.000Z',
      respondedAt: '2026-06-24T00:00:01.000Z',
      elapsedMs: 1000,
      status: 'OK',
      skipReason: null,
      telemetry: createTelemetry(),
    },
    TEST_TOKEN,
  );

  assert.deepEqual(evidence.selectors, selectors);
});
