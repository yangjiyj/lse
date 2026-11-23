import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerDefinitions } from '../src/workers.js';

test('评估任务与服务安全核验使用独立队列和处理器', async () => {
  const calls: string[] = [];
  const [evaluation, serviceAssurance] = createWorkerDefinitions({
    evalQueueName: 'eval-tasks',
    serviceAssuranceQueueName: 'service-assurance',
    evalConcurrency: '3',
    serviceAssuranceConcurrency: '2',
    runEvalTask: async (taskId) => {
      calls.push(`eval:${taskId}`);
    },
    executeServiceAssuranceRun: async (runId) => {
      calls.push(`assurance:${runId}`);
    },
  });

  assert.equal(evaluation.queueName, 'eval-tasks');
  assert.equal(evaluation.concurrency, 3);
  assert.equal(serviceAssurance.queueName, 'service-assurance');
  assert.equal(serviceAssurance.concurrency, 2);

  await evaluation.process({ id: 'job-eval', data: { taskId: 'task-1' } });
  await serviceAssurance.process({ id: 'job-assurance', data: { runId: 'run-1' } });
  assert.deepEqual(calls, ['eval:task-1', 'assurance:run-1']);
});

test('服务安全核验 worker 并发固定限制在 1 到 4', () => {
  const base = {
    evalQueueName: 'eval-tasks',
    serviceAssuranceQueueName: 'service-assurance',
    evalConcurrency: 'invalid',
    runEvalTask: async () => undefined,
    executeServiceAssuranceRun: async () => undefined,
  };

  assert.equal(
    createWorkerDefinitions({ ...base, serviceAssuranceConcurrency: '99' })[1].concurrency,
    4,
  );
  assert.equal(
    createWorkerDefinitions({ ...base, serviceAssuranceConcurrency: '0' })[1].concurrency,
    1,
  );
  assert.equal(
    createWorkerDefinitions({ ...base, serviceAssuranceConcurrency: 'invalid' })[1].concurrency,
    1,
  );
});

test('组合任务和检测策略各一个 worker，队列名固定', async () => {
  const { createDetectWorkers, closeQueue } = await import('@lse/api/queue');
  const workers = createDetectWorkers();
  try {
    assert.equal(workers.length, 2);
    assert.deepEqual(
      workers.map((w) => w.name),
      ['detect-jobs', 'detect-strategies'],
    );
  } finally {
    for (const w of workers) await w.close();
    await closeQueue();
  }
});
