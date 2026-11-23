import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signCallbackPayload, verifyCallbackSignature } from '../src/modules/batch-evaluations/callback.js';

const SECRET = 'unit-test-secret';
const KEY_ID = 'lse-batch-callback-v1';
const TIMESTAMP = '1759363200';
const BODY = JSON.stringify({ event: 'batch_evaluation.completed', planId: 'plan-1', status: 'COMPLETED' });

test('callback signature roundtrips and rejects tampering', () => {
  const signature = signCallbackPayload(SECRET, KEY_ID, TIMESTAMP, BODY);
  assert.equal(typeof signature, 'string');
  assert.equal(signature.length, 64);
  assert.ok(verifyCallbackSignature(SECRET, KEY_ID, TIMESTAMP, BODY, signature));
  assert.ok(!verifyCallbackSignature(SECRET, KEY_ID, TIMESTAMP, BODY + ' ', signature));
  assert.ok(!verifyCallbackSignature(SECRET, KEY_ID, TIMESTAMP + '1', BODY, signature));
  assert.ok(!verifyCallbackSignature('other-secret', KEY_ID, TIMESTAMP, BODY, signature));
  assert.ok(!verifyCallbackSignature(SECRET, 'other-key', TIMESTAMP, BODY, signature));
});
