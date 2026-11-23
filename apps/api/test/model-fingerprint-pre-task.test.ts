import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LlmCallResult } from '@lse/shared';
import { prisma } from '../src/db.js';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';
import { collectFingerprint } from '../src/modules/model-fingerprint/collect.js';
import type { FingerprintCheck } from '../src/modules/model-fingerprint/pre-task.js';

const PREFIX = '__fppretask_';
const SECRET = 'sk-fp-pretask-secret-555'; // pragma: allowlist secret
const origAllow = process.env.LSE_TARGET_EGRESS_ALLOWLIST;
const origPriv = process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
let server: http.Server;
let baseUrl = '';
let mode: 'A' | 'B' | 'fail' = 'A';

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (mode === 'fail') {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: 'unavailable' } }));
        return;
      }
      const msgs = (JSON.parse(raw) as { messages: { content: string }[] }).messages;
      const p = msgs[msgs.length - 1]!.content;
      const content =
        mode === 'A'
          ? `我是模型甲，这是对「${p.slice(0, 12)}」的稳定回答。`
          : '{"totally":"different","x":[1,2,3,4,5,6,7,8,9]}';
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = new URL(baseUrl).origin;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
  await cleanup();
});

after(async () => {
  await cleanup();
  await new Promise<void>((r) => server.close(() => r()));
  if (origAllow === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  else process.env.LSE_TARGET_EGRESS_ALLOWLIST = origAllow;
  if (origPriv === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  else process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = origPriv;
  await prisma.$disconnect();
});

function okResult(): LlmCallResult {
  return {
    status: 'SUCCESS',
    content: '这是一个普通的回答。',
    finishReason: 'stop',
    model: 'mock',
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    latencyMs: 1,
    httpStatus: 200,
    error: null,
    raw: null,
  };
}

async function setup(suffix: string, withBaseline: boolean) {
  const t = await prisma.modelTarget.create({
    data: { name: `${PREFIX}${suffix}`, provider: 'openai-compatible', baseUrl, apiKey: SECRET, model: 'mock' },
  });
  if (withBaseline) {
    mode = 'A';
    const fp = await collectFingerprint(prisma, t.id, { source: 'MANUAL' });
    await prisma.modelFingerprint.update({ where: { id: fp.id }, data: { isBaseline: true } });
  }
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}set_${suffix}`,
      type: 'GENERAL',
      source: 'test',
      questions: { create: { content: `${PREFIX}普通题`, type: 'GENERAL', severity: 'INFO', shouldRefuse: false } },
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}task_${suffix}`,
      modelTargetId: t.id,
      engines: [],
      dimensions: [],
      concurrency: 1,
      questionSets: { create: [{ questionSetId: set.id }] },
    },
  });
  return { targetId: t.id, taskId: task.id };
}

async function run(taskId: string) {
  let calls = 0;
  await runEvalTask(taskId, {
    callModel: async () => {
      calls += 1;
      return okResult();
    },
    judgeTarget: null,
  });
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId }, include: { logs: true } });
  return { task, check: task.fingerprintCheck as unknown as FingerprintCheck, calls };
}

test('有基线且模型未变：OK，任务照常完成', async () => {
  const { taskId } = await setup('ok', true);
  mode = 'A';
  const { task, check, calls } = await run(taskId);
  assert.equal(check.status, 'OK');
  assert.equal(check.similarity, 1);
  assert.equal(check.threshold, 0.6);
  assert.ok(check.baselineId && check.fingerprintId);
  assert.equal(task.status, 'COMPLETED');
  assert.equal(calls, 1);
  const fp = await prisma.modelFingerprint.findUniqueOrThrow({ where: { id: check.fingerprintId! } });
  assert.equal(fp.source, 'PRE_TASK');
});

test('有基线且模型被替换：DRIFT，写告警日志，不阻断任务', async () => {
  const { taskId } = await setup('drift', true);
  mode = 'B';
  const { task, check } = await run(taskId);
  assert.equal(check.status, 'DRIFT');
  assert.ok(check.similarity! < 0.6);
  assert.equal(task.status, 'COMPLETED');
  const warn = task.logs.find((l) => l.level === 'warn' && l.message.includes('模型指纹告警'));
  assert.ok(warn);
  assert.ok(!JSON.stringify(task.logs).includes(SECRET));
});

test('无基线：NO_BASELINE，不发探针，任务照常完成', async () => {
  const { targetId, taskId } = await setup('nobase', false);
  const { task, check } = await run(taskId);
  assert.equal(check.status, 'NO_BASELINE');
  assert.equal(check.similarity, null);
  assert.equal(task.status, 'COMPLETED');
  assert.equal(await prisma.modelFingerprint.count({ where: { modelTargetId: targetId } }), 0);
});

test('采集失败：FAILED，不阻断任务，失败原因不含凭据', async () => {
  const { taskId } = await setup('fail', true);
  mode = 'fail';
  const { task, check } = await run(taskId);
  assert.equal(check.status, 'FAILED');
  assert.ok(check.reason && check.reason.includes('指纹采集失败'));
  assert.ok(!check.reason!.includes(SECRET));
  assert.equal(task.status, 'COMPLETED');
});
