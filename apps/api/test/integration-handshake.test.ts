import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app!: FastifyInstance;
const ORIG = process.env.NEWAPI_EVAL_INTEGRATION_TOKEN;

before(async () => {
  process.env.NEWAPI_EVAL_INTEGRATION_TOKEN = 'handshake-secret';
  app = await buildApp();
  await app.ready();
});
after(async () => {
  if (ORIG === undefined) delete process.env.NEWAPI_EVAL_INTEGRATION_TOKEN;
  else process.env.NEWAPI_EVAL_INTEGRATION_TOKEN = ORIG;
  await app.close();
});

test('握手端点：无密钥 → 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/integration/handshake' });
  assert.equal(res.statusCode, 401, res.body);
});

test('握手端点：错误密钥 → 401', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/integration/handshake',
    headers: { authorization: 'Bearer wrong-secret' },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test('握手端点：正确密钥 → 200 + service lse-api + paired', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/integration/handshake',
    headers: { authorization: 'Bearer handshake-secret' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  assert.equal(b.service, 'lse-api');
  assert.equal(b.paired, true);
});

test('/api/health 仍公开（无密钥 200）', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200, res.body);
});

test('握手端点：带合法 nonce 时原样回显（互证用）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/integration/handshake?nonce=abc123XYZ789',
    headers: { authorization: 'Bearer handshake-secret' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().nonce, 'abc123XYZ789');
});

test('握手端点：非法 nonce 不回显（防注入/防伪造回显）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/integration/handshake?nonce=bad%20nonce',
    headers: { authorization: 'Bearer handshake-secret' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().nonce, undefined);
});
