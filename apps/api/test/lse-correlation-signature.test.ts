import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import {
  LSE_CORRELATION_SIGNATURE_HEADER,
  canonicalLseCorrelation,
  withLseCorrelationSignature,
} from '../src/lib/lse-correlation-signature.js';

const headers = {
  'X-LSE-Eval-Run-Id': 'eval-1',
  'X-LSE-Task-Id': 'task-1',
  'X-LSE-Sample-Id': 'sample-1',
  'X-LSE-Target-Id': 'target-1',
  'X-LSE-Trace-Id': 'trace-1',
};

test('adds deterministic HMAC envelope with active key', () => {
  process.env.LSE_CORRELATION_HMAC_KEYS = 'old=old-secret,active=unit-secret';
  process.env.LSE_CORRELATION_HMAC_ACTIVE_KID = 'active';
  const signed = withLseCorrelationSignature(headers, {
    timestampMs: 1_700_000_000_000,
    nonce: 'nonce-1',
  });
  const signature = signed[LSE_CORRELATION_SIGNATURE_HEADER];
  assert.match(signature, /^v1\.active\.1700000000\.nonce-1\.[A-Za-z0-9_-]+$/);
  const expected = createHmac('sha256', 'unit-secret')
    .update(canonicalLseCorrelation(headers, 1_700_000_000, 'nonce-1'))
    .digest('base64url');
  assert.equal(signature, `v1.active.1700000000.nonce-1.${expected}`);
});

test('does not invent a signature without a configured keyring', () => {
  delete process.env.LSE_CORRELATION_HMAC_KEYS;
  delete process.env.LSE_CORRELATION_HMAC_ACTIVE_KID;
  assert.deepEqual(withLseCorrelationSignature(headers, { nonce: 'nonce-1' }), headers);
});

test('re-signs caller-provided signature from canonical correlation values', () => {
  process.env.LSE_CORRELATION_HMAC_KEYS = 'active=unit-secret';
  const signed = withLseCorrelationSignature(
    { ...headers, [LSE_CORRELATION_SIGNATURE_HEADER]: 'v1.active.1.bad.bad' },
    { timestampMs: 1_700_000_000_000, nonce: 'nonce-2' },
  );
  assert.match(signed[LSE_CORRELATION_SIGNATURE_HEADER], /^v1\.active\.1700000000\.nonce-2\./);
});
