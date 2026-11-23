import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import {
  buildRiskDomainTested,
  withLazyRiskDomainTested,
} from '../src/modules/reports/risk-domain-tested.js';
import { selectPrimaryReportResults } from '../src/modules/reports/report-primary-results.js';
import {
  buildRiskItemsBySeverity,
  type BuiltReport,
  type ReportEvalResult,
  type ReportWrongAnswer,
} from '../src/modules/reports/report-builder.js';

const PREFIX = 'LAZYDOM-';

function wa(severity: 'HIGH' | 'MEDIUM', riskCategory: string, n: number): ReportWrongAnswer {
  return {
    questionContent: `测试输入 ${n}`,
    modelResponse: `回答 ${n}`,
    riskCategory,
    severity,
    engine: 'rule-judge',
    reason: '模型直接输出了被诱导的内容。',
  } as unknown as ReportWrongAnswer;
}

/** 旧快照：只有风险项明细，没有 riskDomainTested。 */
function legacyReport(): BuiltReport {
  const groups = buildRiskItemsBySeverity([
    wa('HIGH', 'prompt_injection', 1),
    wa('HIGH', 'prompt_injection', 2),
    wa('MEDIUM', 'fraud_social_engineering', 3),
  ]);
  return {
    title: '旧报告',
    format: 'markdown',
    content: '',
    passRate: 0.5,
    totalQuestions: 10,
    riskDistribution: { bySeverity: {}, byRiskCategory: {}, byRiskDomain: {} },
    summary: {
      totalQuestions: 10,
      passedCount: 7,
      failedCount: 3,
      riskItemsBySeverity: groups,
      comprehensiveModules: [],
    },
  } as unknown as BuiltReport;
}

const ids: { taskId: string; emptyTaskId: string } = { taskId: '', emptyTaskId: '' };
let rows: Array<{
  verdict: 'PASS' | 'FAIL' | 'ERROR' | 'UNKNOWN';
  category: string;
  side: string | null;
  group: string | null;
}> = [];

async function cleanup() {
  const tasks = await prisma.evalTask.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const taskIds = tasks.map((t) => t.id);
  if (taskIds.length > 0) {
    await prisma.evalResult.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.evalTaskQuestionSet.deleteMany({ where: { taskId: { in: taskIds } } });
  }
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const sets = await prisma.questionSet.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  if (sets.length > 0)
    await prisma.question.deleteMany({ where: { questionSetId: { in: sets.map((s) => s.id) } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  await cleanup();
  const model = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}模型`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'k',
      model: 'fake',
    },
  });
  const set = await prisma.questionSet.create({ data: { name: `${PREFIX}题集`, type: 'GENERAL' } });
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}任务`,
      modelTargetId: model.id,
      totalQuestions: 9,
      status: 'COMPLETED',
      questionSets: { create: { questionSetId: set.id } },
    },
  });
  const empty = await prisma.evalTask.create({
    data: { name: `${PREFIX}空任务`, modelTargetId: model.id, status: 'COMPLETED' },
  });
  ids.taskId = task.id;
  ids.emptyTaskId = empty.id;
  rows = [
    { verdict: 'PASS', category: 'prompt_injection', side: null, group: null },
    { verdict: 'PASS', category: 'prompt_injection', side: null, group: null },
    { verdict: 'PASS', category: 'fraud_social_engineering', side: null, group: null },
    { verdict: 'ERROR', category: 'prompt_injection', side: null, group: null },
    { verdict: 'UNKNOWN', category: 'fraud_social_engineering', side: null, group: null },
    { verdict: 'FAIL', category: 'prompt_injection', side: null, group: null },
    // 红队对照：同一对照组有 B 时，A 不计（只取 B）
    { verdict: 'PASS', category: 'fraud_social_engineering', side: 'A', group: 'g1' },
    { verdict: 'PASS', category: 'fraud_social_engineering', side: 'B', group: 'g1' },
    { verdict: 'PASS', category: 'prompt_injection', side: 'A', group: 'g2' },
  ];
  for (const [i, r] of rows.entries()) {
    const q = await prisma.question.create({
      data: { questionSetId: set.id, content: `${PREFIX}题 ${i}`, category: r.category },
    });
    await prisma.evalResult.create({
      data: {
        taskId: task.id,
        questionId: q.id,
        modelTargetId: model.id,
        prompt: q.content,
        status: r.verdict === 'ERROR' ? 'ERROR' : 'SUCCESS',
        finalVerdict: r.verdict,
        side: r.side,
        controlGroupId: r.group,
      },
    });
  }
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test('旧快照缺 riskDomainTested：按任务结果懒计算，口径与生成时一致、不改写快照', async () => {
  const old = legacyReport();
  const before = JSON.stringify(old);
  const lazy = await withLazyRiskDomainTested(prisma, old, ids.taskId);
  assert.equal(JSON.stringify(old), before, '不得改写原快照对象');
  assert.notEqual(lazy, old);

  // 同一任务「生成时」路径：用等价的内存结果 + 同一份风险项明细
  const inMemory = rows.map(
    (r, i) =>
      ({
        id: `r${i}`,
        finalVerdict: r.verdict,
        status: 'SUCCESS',
        side: r.side,
        controlGroupId: r.group,
        question: { content: `${PREFIX}题 ${i}`, category: r.category },
      }) as unknown as ReportEvalResult,
  );
  const generated = buildRiskDomainTested(
    selectPrimaryReportResults(inMemory),
    old.summary.riskItemsBySeverity!,
  );
  assert.deepEqual(lazy.summary.riskDomainTested, generated);
  // 明确数值：注入 = 2 发现 + 2 通过；诈骗 = 1 发现 + 1(无对照) + 1(B) 通过；A 被对照组 B 取代、g2 的 A 无 B 故保留
  assert.deepEqual(lazy.summary.riskDomainTested, {
    prompt_injection: 2 + 2 + 1,
    fraud_social_engineering: 1 + 1 + 1,
  });
  // 除新增字段外，快照其余内容逐字不变
  const { riskDomainTested: _ignored, ...rest } = lazy.summary;
  assert.equal(JSON.stringify(rest), JSON.stringify(old.summary));
});

test('任务数据已删除/无结果/查询失败：静默回退为原报告，不抛错', async () => {
  const old = legacyReport();
  assert.equal(await withLazyRiskDomainTested(prisma, old, ids.emptyTaskId), old);
  assert.equal(
    await withLazyRiskDomainTested(prisma, old, '00000000-0000-0000-0000-000000000000'),
    old,
  );
  assert.equal(await withLazyRiskDomainTested(prisma, old, null), old);
  const warned: unknown[] = [];
  const broken = {
    evalResult: {
      findMany: async () => {
        throw new Error('db down');
      },
    },
  };
  assert.equal(
    await withLazyRiskDomainTested(broken, old, ids.taskId, { warn: (o) => warned.push(o) }),
    old,
  );
  assert.equal(warned.length, 1);
});

test('快照已带 riskDomainTested 时不再查询；只用一次聚合查询', async () => {
  const done = legacyReport();
  done.summary.riskDomainTested = { prompt_injection: 9 };
  let calls = 0;
  const counting = {
    evalResult: {
      findMany: async () => {
        calls += 1;
        return [];
      },
    },
  };
  assert.equal(await withLazyRiskDomainTested(counting, done, ids.taskId), done);
  assert.equal(calls, 0);
  await withLazyRiskDomainTested(counting, legacyReport(), ids.taskId);
  assert.equal(calls, 1);
});
