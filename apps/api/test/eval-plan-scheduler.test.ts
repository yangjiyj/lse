import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from '../src/db.js';
import {
  createBullmqPlanScheduler,
  createEvalPlanWorker,
  evalPlanSchedulerId,
  reconcilePlanSchedulers,
  type EvalPlanJobData,
} from '../src/modules/eval-plans/scheduler.js';

// 真实 Valkey（.env REDIS_URL）上验证 Job Scheduler 注册/移除与消费者触发；独立队列名，结束清理。
const PREFIX = '__eval_plan_sched_';
const QUEUE = `test-eval-plans-${randomUUID().slice(0, 8)}`;
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:16380';

let connection!: Redis;
let queue!: Queue<EvalPlanJobData>;
let planId = '';

before(async () => {
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  queue = new Queue<EvalPlanJobData>(QUEUE, { connection });
  await prisma.evalPlan.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}model`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy', // pragma: allowlist secret
      model: 'fake',
    },
  });
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}set`,
      type: 'COMPLIANCE',
      questions: { create: [{ content: 'q1', type: 'COMPLIANCE', category: '隐私保护' }] },
    },
  });
  const plan = await prisma.evalPlan.create({
    data: {
      name: `${PREFIX}plan`,
      targetId: target.id,
      templateParams: { questionSetIds: [set.id], engines: [], dimensions: [], concurrency: 1 },
      cron: '0 3 * * *',
      timezone: 'Asia/Shanghai',
    },
  });
  planId = plan.id;
});

after(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: `${PREFIX}plan` } } });
  await prisma.evalPlan.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

test('启用计划注册 Job Scheduler（cron+时区），停用后移除', async () => {
  const scheduler = createBullmqPlanScheduler(queue);
  await scheduler.sync({ id: planId, cron: '0 3 * * *', timezone: 'Asia/Shanghai', enabled: true });
  const list = await queue.getJobSchedulers(0, -1);
  const found = list.find((s) => s.key === evalPlanSchedulerId(planId));
  assert.ok(found, '应注册 scheduler');
  assert.equal(found.pattern, '0 3 * * *');
  assert.equal(found.tz, 'Asia/Shanghai');
  assert.ok(found.next && found.next > Date.now());

  await scheduler.sync({ id: planId, cron: '0 3 * * *', timezone: 'Asia/Shanghai', enabled: false });
  const after = await queue.getJobSchedulers(0, -1);
  assert.equal(after.some((s) => s.key === evalPlanSchedulerId(planId)), false);
});

test('reconcile 按库对齐：补注册启用计划，移除孤儿 scheduler', async () => {
  const orphan = evalPlanSchedulerId(randomUUID());
  await queue.upsertJobScheduler(orphan, { pattern: '0 4 * * *' }, { name: 'trigger', data: { planId: 'x' } });
  const res = await reconcilePlanSchedulers(prisma, queue);
  assert.ok(res.upserted >= 1);
  assert.ok(res.removed >= 1);
  const keys = (await queue.getJobSchedulers(0, -1)).map((s) => s.key);
  assert.ok(keys.includes(evalPlanSchedulerId(planId)));
  assert.equal(keys.includes(orphan), false);
  await createBullmqPlanScheduler(queue).remove(planId);
});

test('消费者收到触发 job 后调用 triggerEvalPlan 生成关联 planId 的任务', async () => {
  const events = new QueueEvents(QUEUE, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) });
  const worker = createEvalPlanWorker(prisma, {
    queueName: QUEUE,
    connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
  });
  try {
    await events.waitUntilReady();
    const job = await queue.add('trigger', { planId });
    const result = (await job.waitUntilFinished(events, 20_000)) as { status: string; taskId?: string };
    assert.equal(result.status, 'triggered');
    const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: result.taskId! } });
    assert.equal(task.planId, planId);
    const run = await prisma.evalPlanRun.findFirstOrThrow({ where: { planId, taskId: task.id } });
    assert.equal(run.triggeredBy, 'schedule');
  } finally {
    await worker.close();
    await events.close();
  }
});
