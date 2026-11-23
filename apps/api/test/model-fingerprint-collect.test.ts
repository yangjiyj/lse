import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../src/db.js';
import {
  collectFingerprint,
  FingerprintCollectError,
  FINGERPRINT_SEED,
} from '../src/modules/model-fingerprint/collect.js';
import { FINGERPRINT_PROBES_V1 } from '../src/modules/model-fingerprint/similarity.js';

const PREFIX = '__fpcollect_';
const SECRET = 'sk-fp-collect-secret-000'; // pragma: allowlist secret
const origAllow = process.env.LSE_TARGET_EGRESS_ALLOWLIST;
const origPriv = process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;

interface Seen {
  body: Record<string, unknown>;
  auth: string | undefined;
}
const seen: Seen[] = [];
let mode: 'ok' | 'reject-seed' | 'fail' = 'ok';
let server: http.Server;
let baseUrl = '';

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ body, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (mode === 'fail' || (mode === 'reject-seed' && body.seed !== undefined)) {
        res.statusCode = mode === 'fail' ? 500 : 400;
        res.end(JSON.stringify({ error: { message: 'bad request' } }));
        return;
      }
      const msgs = body.messages as { content: string }[];
      const prompt = msgs[msgs.length - 1]!.content;
      const content = prompt.includes('JSON') ? '{"name":"lse","n":3}' : `回答：${prompt.slice(0, 8)}`;
      res.end(
        JSON.stringify({
          model: 'mock',
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = new URL(baseUrl).origin;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
});

after(async () => {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await new Promise<void>((r) => server.close(() => r()));
  if (origAllow === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  else process.env.LSE_TARGET_EGRESS_ALLOWLIST = origAllow;
  if (origPriv === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  else process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = origPriv;
  await prisma.$disconnect();
});

async function mkTarget(suffix: string) {
  return prisma.modelTarget.create({
    data: { name: `${PREFIX}${suffix}`, provider: 'openai-compatible', baseUrl, apiKey: SECRET, model: 'mock' },
  });
}

test('采集 10 道探针，temperature=0 且固定 seed，落库且不含凭据', async () => {
  mode = 'ok';
  seen.length = 0;
  const t = await mkTarget('ok');
  const fp = await collectFingerprint(prisma, t.id, { source: 'MANUAL', actor: { id: null, name: 'tester' } });
  assert.equal(seen.length, FINGERPRINT_PROBES_V1.length);
  for (const s of seen) {
    assert.equal(s.body.temperature, 0);
    assert.equal(s.body.seed, FINGERPRINT_SEED);
    assert.equal(s.auth, `Bearer ${SECRET}`);
  }
  assert.equal(fp.probeVersion, 'v1');
  assert.equal(fp.source, 'MANUAL');
  assert.equal(fp.isBaseline, false);
  assert.equal(fp.createdByName, 'tester');
  const outputs = fp.outputs as { probeId: string; output: string }[];
  assert.equal(outputs.length, 10);
  const features = fp.features as { probeId: string; jsonParsable: boolean }[];
  assert.equal(features.find((f) => f.probeId === 'p03')!.jsonParsable, true);
  assert.ok(!JSON.stringify(fp).includes(SECRET));
});

test('接口拒绝 seed 时去掉 seed 重试', async () => {
  mode = 'reject-seed';
  seen.length = 0;
  const t = await mkTarget('noseed');
  const fp = await collectFingerprint(prisma, t.id, { source: 'PRE_TASK' });
  assert.equal(fp.source, 'PRE_TASK');
  assert.equal(seen.length, FINGERPRINT_PROBES_V1.length + 1);
  assert.ok(seen.slice(1).every((s) => s.body.seed === undefined));
});

test('调用失败时抛错且不落库', async () => {
  mode = 'fail';
  const t = await mkTarget('fail');
  await assert.rejects(
    collectFingerprint(prisma, t.id, { source: 'MANUAL' }),
    (e: unknown) => e instanceof FingerprintCollectError && !String((e as Error).message).includes(SECRET),
  );
  assert.equal(await prisma.modelFingerprint.count({ where: { modelTargetId: t.id } }), 0);
});

test('对象不存在时抛错', async () => {
  await assert.rejects(
    collectFingerprint(prisma, '00000000-0000-0000-0000-000000000000', { source: 'MANUAL' }),
    FingerprintCollectError,
  );
});
