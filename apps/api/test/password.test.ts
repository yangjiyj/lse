import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/lib/password.js';

test('argon2id hash verifies correct password', async () => {
  const hash = await hashPassword('Sup3r$ecret');
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(hash, 'Sup3r$ecret'), true);
});

test('argon2id rejects wrong password', async () => {
  const hash = await hashPassword('Sup3r$ecret');
  assert.equal(await verifyPassword(hash, 'wrong'), false);
});

test('verifyPassword returns false on malformed hash', async () => {
  assert.equal(await verifyPassword('not-a-hash', 'x'), false);
});
