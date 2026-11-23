import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RUNTIME_AVG_SCENARIO_SECONDS,
  RUNTIME_JOB_WORST_CASE_SECONDS,
  RUNTIME_MAX_ESTIMATE_SECONDS,
  RUNTIME_MAX_JOB_SCENARIOS,
  RUNTIME_SCENARIO_MARGIN_SECONDS,
  type RuntimeArm,
  type RuntimeTemplate,
} from '../../../../../packages/shared/src/runtime-eval.js';
import type { CatalogEntry } from '../agent-samples/catalog.js';
import { buildRuntimePack } from '../endpoint-evals/samples/build-pack.js';
import { ALL_SAMPLES } from '../endpoint-evals/samples/registry.js';
import { estimateAgentJobs } from './estimate.js';
import { splitScenarioIds } from './runtime-batches.js';

const catalog: CatalogEntry[] = ALL_SAMPLES.map((sample) => ({
  id: sample.id, suite: 'runtime_v2', source: 'builtin', enabled: true, version: 1, digest: `sha256:${sample.id}`, content: sample,
}));
const select = (count: number, repeat = 1) => ({
  products: ['claude-code'], sampleIds: ALL_SAMPLES.slice(0, count).map((s) => s.id),
  arms: ['observe', 'enforce'], repeat, templates: ['py-service-v1', 'node-api-v1'],
});
const runtimeJobs = (plan: Awaited<ReturnType<typeof estimateAgentJobs>>) => plan.jobs.filter((job) => job.suite === 'runtime_v2');

test('超过单任务上限的运行态选择被拆成多个任务，每个任务不超过上限', async () => {
  const plan = await estimateAgentJobs(select(30), catalog);
  const jobs = runtimeJobs(plan);
  assert.ok(jobs.length >= 2, `应拆成多个任务，实际 ${jobs.length}`);
  for (const job of jobs) {
    assert.ok(job.scenarioCount <= RUNTIME_MAX_JOB_SCENARIOS, `单个任务 ${job.scenarioCount} 个场景超过上限`);
    assert.ok(job.estimateSeconds <= RUNTIME_MAX_ESTIMATE_SECONDS);
    assert.equal(job.estimateSeconds, Math.ceil(job.scenarioCount * RUNTIME_AVG_SCENARIO_SECONDS));
    assert.equal(job.scenarios.length, job.scenarioCount);
  }
});

test('每个任务带「第几批/共几批」，序号连续', async () => {
  const jobs = runtimeJobs(await estimateAgentJobs(select(30), catalog));
  jobs.forEach((job, i) => assert.deepEqual((job as { batch?: unknown }).batch, { index: i + 1, total: jobs.length }));
});

test('拆批后场景不丢不重，总数与总耗时和不拆时一致', async () => {
  const plan = await estimateAgentJobs(select(30), catalog);
  const ids = runtimeJobs(plan).flatMap((job) => job.scenarios.map((s) => s.scenarioId));
  assert.equal(new Set(ids).size, ids.length, '场景编号重复');
  assert.equal(plan.scenarioCount, ids.length);
  assert.equal(plan.estimateSeconds, runtimeJobs(plan).reduce((sum, job) => sum + job.estimateSeconds, 0));
});

test('同一个样本的所有运行在同一个任务里', async () => {
  const jobs = runtimeJobs(await estimateAgentJobs(select(30), catalog));
  const home = new Map<string, number>();
  jobs.forEach((job, index) => {
    for (const s of job.scenarios) {
      assert.ok(!home.has(s.sampleId) || home.get(s.sampleId) === index, `${s.sampleId} 被拆到多个任务`);
      home.set(s.sampleId, index);
    }
  });
});

test('选择较小时仍是一个任务，不带批次信息', async () => {
  const jobs = runtimeJobs(await estimateAgentJobs(select(3), catalog));
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0] as { batch?: unknown }).batch, undefined);
});

test('原来超过 6 小时估算上限被拒绝的大选择，现在拆批后可以发起', async () => {
  // 40 个样本 × 双项目 × 双防护臂 × 3 次，估算远超单任务 6 小时；拆批后每批都在上限内
  const plan = await estimateAgentJobs(select(40, 3), catalog);
  assert.ok(plan.estimateSeconds > RUNTIME_MAX_ESTIMATE_SECONDS);
  for (const job of runtimeJobs(plan)) assert.ok(job.estimateSeconds <= RUNTIME_MAX_ESTIMATE_SECONDS);
});

test('估算返回的每一批按最坏耗时都不超过 5 小时，批数和场景归属与实际拆批一致', async () => {
  for (const [count, repeat] of [[30, 1], [40, 3]] as const) {
    const input = select(count, repeat);
    const jobs = runtimeJobs(await estimateAgentJobs(input, catalog));
    // 发起任务时用的就是这个场景包和这个拆批函数。
    const pack = await buildRuntimePack({
      tier: 'full', sampleIds: input.sampleIds, arms: input.arms as RuntimeArm[], repeat: input.repeat,
      templates: input.templates as RuntimeTemplate[], sinkBaseUrl: 'https://sink.invalid', samples: ALL_SAMPLES,
    });
    const timeout = new Map(pack.scenarios.map((s) => [s.scenario_id, s.timeout_sec]));
    assert.ok([...timeout.values()].every((t) => t >= 600 && t <= 900), '运行态场景超时在 600–900 秒');
    for (const job of jobs) {
      const worst = job.scenarios.reduce((sum, s) => sum + timeout.get(s.scenarioId)! + RUNTIME_SCENARIO_MARGIN_SECONDS, 0);
      assert.ok(worst <= RUNTIME_JOB_WORST_CASE_SECONDS, `${count} 个样本 × ${repeat} 次：一批最坏 ${worst} 秒`);
      assert.ok(job.scenarioCount <= RUNTIME_MAX_JOB_SCENARIOS);
    }
    assert.deepEqual(jobs.map((job) => job.scenarios.map((s) => s.scenarioId)), splitScenarioIds(pack.scenarios));
  }
});

test('整个请求的场景数仍受 240 个的总上限约束', async () => {
  await assert.rejects(() => estimateAgentJobs(select(60, 5), catalog), /超过上限|240/);
});
