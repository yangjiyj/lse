import { platformAppEnabled } from '../eval-targets/platform-adapters/index.js';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type ModelTarget } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { loadEnabledQuestionSets } from '../question-sets/enabled.js';
import { pickJudgeTarget } from '../engines/judge-target.js';
import {
  BATCH_POLICY_VERSION,
  buildSummary,
  fingerprint,
  selectSamples,
  targetFingerprint,
  type BatchStrategy,
} from './core.js';

export interface CreateBatchInput {
  name: string;
  targetIds: string[];
  questionSetIds: string[];
  sampleCount: number;
  seed: string;
  judgeMode: 'MODEL' | 'RULES';
  strategy: BatchStrategy;
  concurrency: number;
  targetConcurrency: number;
  batchSize: number;
  rpm: number;
  maxAttempts: number;
  maxRequests?: number;
  maxDurationMinutes: number;
  callbackUrl?: string;
}

function publicTargetSnapshot(target: ModelTarget): Prisma.InputJsonValue {
  const source = (target.defaultParams ?? {}) as Record<string, unknown>;
  const parameters: Record<string, number> = {};
  for (const key of [
    'temperature',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'frequency_penalty',
    'presence_penalty',
  ]) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key]))
      parameters[key] = source[key];
  }
  return {
    name: target.name,
    model: target.model,
    provider: target.provider,
    targetType: target.targetType,
    parameters,
  };
}

function snapshotDescription(value: Prisma.JsonValue): string {
  const snapshot = (value ?? {}) as { model?: string; parameters?: Record<string, number> };
  const labels: Record<string, string> = {
    temperature: '采样温度',
    top_p: '核采样比例',
    max_tokens: '输出长度上限',
    max_completion_tokens: '生成长度上限',
    frequency_penalty: '频率惩罚',
    presence_penalty: '重复惩罚',
  };
  const parameters = Object.entries(snapshot.parameters ?? {}).map(
    ([key, number]) => `${labels[key] ?? '生成参数'} ${number}`,
  );
  return [`模型 ${snapshot.model ?? '未记录'}`, ...parameters].join('；');
}

const QUESTION_LABEL: Record<string, string> = {
  GENERAL: '通用能力',
  COMPLIANCE: '内容安全',
  SHOULD_REFUSE: '应拒答能力',
  PROMPT_INJECTION: '提示注入防御',
};

function independentJudge(judge: ModelTarget, target: ModelTarget) {
  const normalize = (base: string) => {
    try {
      return new URL(base).href.replace(/\/+$/, '');
    } catch {
      return base.trim().replace(/\/+$/, '');
    }
  };
  return pickJudgeTarget(
    {
      ...judge,
      baseUrl: normalize(judge.baseUrl),
      extraHeaders: judge.extraHeaders as Record<string, string> | null,
      defaultParams: judge.defaultParams as Record<string, unknown> | null,
    },
    { ...target, baseUrl: normalize(target.baseUrl) },
  );
}

export function planAccess(user: CurrentUser) {
  return user.isBuiltin ? {} : { createdById: user.id };
}

export async function requirePlan(id: string, user: CurrentUser) {
  const plan = await prisma.batchEvaluation.findFirst({ where: { id, ...planAccess(user) } });
  if (!plan) throw notFound('评估计划不存在或无权访问');
  return plan;
}

export async function validatePlanConfiguration(id: string, db: PrismaClient = prisma) {
  const plan = await db.batchEvaluation.findUniqueOrThrow({
    where: { id },
    include: { runs: true },
  });
  const creator = await db.user.findUnique({
    where: { id: plan.createdById },
    select: { isBuiltin: true, isActive: true },
  });
  if (!creator?.isActive)
    throw conflict('计划创建用户已停用或不存在', 'TARGET_CONFIGURATION_CHANGED');
  const targets = await db.modelTarget.findMany({
    where: { id: { in: plan.runs.map((r) => r.targetId) } },
  });
  for (const run of plan.runs) {
    const target = targets.find((t) => t.id === run.targetId);
    if (!target?.isActive || targetFingerprint(target) !== run.targetFingerprint)
      throw conflict(
        '评估对象配置已变更或不可用，请创建新计划以保持比较口径一致',
        'TARGET_CONFIGURATION_CHANGED',
      );
    if (target.targetType === 'PLATFORM_APP' && !platformAppEnabled())
      throw forbidden('平台智能体测评功能未启用', 'PLATFORM_APP_DISABLED');
    if (!target.isGlobal && target.createdById !== plan.createdById && !creator.isBuiltin)
      throw conflict('评估对象的访问范围已变更', 'TARGET_CONFIGURATION_CHANGED');
  }
  let judge: ModelTarget | null = null;
  if (plan.judgeMode === 'MODEL') {
    judge = plan.judgeTargetId
      ? await db.modelTarget.findUnique({ where: { id: plan.judgeTargetId } })
      : null;
    if (
      !judge?.isActive ||
      judge.targetType !== 'JUDGE' ||
      targetFingerprint(judge) !== plan.judgeFingerprint
    )
      throw conflict('独立评审模型配置已变更或不可用，请创建新计划', 'JUDGE_CONFIGURATION_CHANGED');
    if (!judge.isGlobal && judge.createdById !== plan.createdById && !creator.isBuiltin)
      throw conflict('独立评审模型的访问范围已变更', 'JUDGE_CONFIGURATION_CHANGED');
    for (const target of targets) {
      if (!independentJudge(judge, target))
        throw conflict('评审模型不能与被测对象使用相同接口和模型', 'JUDGE_CONFIGURATION_CHANGED');
    }
  }
  return { plan, targets, judge };
}

export async function createBatchPlan(input: CreateBatchInput, user: CurrentUser) {
  const targetIds = [...new Set(input.targetIds)];
  if (targetIds.length !== input.targetIds.length) throw badRequest('评估对象不能重复选择');
  if (targetIds.length * input.sampleCount > 1000000)
    throw badRequest('单计划最多包含 100 万个对象与样本组合');
  const targets = await prisma.modelTarget.findMany({ where: { id: { in: targetIds } } });
  if (targets.length !== targetIds.length) throw notFound('部分评估对象不存在');
  for (const target of targets) {
    if (target.targetType === 'PLATFORM_APP' && !platformAppEnabled())
      throw forbidden('平台智能体测评功能未启用', 'PLATFORM_APP_DISABLED');
    if (!target.isGlobal && target.createdById !== user.id && !user.isBuiltin)
      throw forbidden('无权使用所选评估对象');
    if (!target.isActive || !['MODEL', 'PLATFORM_APP'].includes(target.targetType))
      throw badRequest('请选择已启用的标准 API 模型对象');
  }
  await loadEnabledQuestionSets(prisma, input.questionSetIds, () => notFound('部分样本库不存在'));
  const questions = await prisma.question.findMany({
    where: { questionSetId: { in: input.questionSetIds } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      content: true,
      type: true,
      language: true,
      category: true,
      shouldRefuse: true,
      expectedBehavior: true,
      referenceAnswer: true,
      severity: true,
      metadata: true,
    },
  });
  let selected;
  try {
    selected = selectSamples(questions, input.sampleCount, input.seed);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : '样本选择失败');
  }
  const judge =
    input.judgeMode === 'MODEL'
      ? await prisma.modelTarget.findFirst({
          where: {
            targetType: 'JUDGE',
            isActive: true,
            ...(user.isBuiltin ? {} : { OR: [{ isGlobal: true }, { createdById: user.id }] }),
          },
          orderBy: { updatedAt: 'desc' },
        })
      : null;
  if (input.judgeMode === 'MODEL') {
    if (!judge?.baseUrl || !judge.apiKey || !judge.model)
      throw badRequest('请先配置可用的独立评审模型，或选择规则初筛');
    for (const target of targets) {
      if (!independentJudge(judge, target))
        throw badRequest('评审模型不能与被测对象使用相同接口和模型');
    }
  }
  const maxRequests =
    input.maxRequests ??
    targetIds.length *
      input.sampleCount *
      (input.judgeMode === 'MODEL' ? 2 : 1) *
      input.maxAttempts;
  const minimum = targetIds.length * input.sampleCount * (input.judgeMode === 'MODEL' ? 2 : 1);
  if (maxRequests < minimum) throw badRequest(`调用预算至少需为 ${minimum} 次，包含被测与评审调用`);
  const id = randomUUID();
  await prisma.$transaction(
    async (tx) => {
      await tx.batchEvaluation.create({
        data: {
          id,
          name: input.name,
          createdById: user.id,
          strategy: input.strategy,
          judgeMode: input.judgeMode,
          judgeTargetId: judge?.id,
          judgeFingerprint: judge ? targetFingerprint(judge) : null,
          judgeSnapshot: judge ? publicTargetSnapshot(judge) : Prisma.JsonNull,
          sampleCount: selected.length,
          seed: input.seed,
          samplePlanHash: fingerprint(selected),
          policyVersion: BATCH_POLICY_VERSION,
          concurrency: input.concurrency,
          targetConcurrency: input.targetConcurrency,
          batchSize: input.batchSize,
          rpm: input.rpm,
          maxAttempts: input.maxAttempts,
          maxRequests,
          maxDurationMinutes: input.maxDurationMinutes,
          callbackUrl: input.callbackUrl ?? null,
        },
      });
      const samples = selected.map((q, sequence) => ({
        id: randomUUID(),
        planId: id,
        sequence: sequence + 1,
        snapshot: q as Prisma.InputJsonValue,
      }));
      for (let i = 0; i < samples.length; i += 1000)
        await tx.batchEvaluationSample.createMany({ data: samples.slice(i, i + 1000) });
      for (const [position, targetId] of targetIds.entries()) {
        const target = targets.find((t) => t.id === targetId)!;
        const run = await tx.batchEvaluationRun.create({
          data: {
            planId: id,
            targetId,
            targetName: target.name,
            targetFingerprint: targetFingerprint(target),
            targetSnapshot: publicTargetSnapshot(target),
            position,
          },
        });
        for (let i = 0; i < samples.length; i += 1000)
          await tx.batchEvaluationResult.createMany({
            data: samples.slice(i, i + 1000).map((s) => {
              const q = selected[s.sequence - 1]!;
              return {
                runId: run.id,
                sampleId: s.id,
                category: q.category || QUESTION_LABEL[q.type] || '专项安全',
                shouldRefuse: q.shouldRefuse,
                evidence: [],
                targetAttemptLimit: input.maxAttempts,
                judgeAttemptLimit: input.maxAttempts,
              };
            }),
          });
      }
    },
    { timeout: 120000 },
  );
  return getBatchDetail(id);
}

export async function getBatchDetail(id: string) {
  const plan = await prisma.batchEvaluation.findUnique({
    where: { id },
    include: { runs: { orderBy: { position: 'asc' } } },
  });
  if (!plan) throw notFound('评估计划不存在');
  const grouped = await prisma.batchEvaluationResult.groupBy({
    by: ['runId', 'verdict', 'severity'],
    where: { run: { planId: id }, status: 'DONE' },
    _count: { _all: true, latencyMs: true },
    _sum: { latencyMs: true, totalTokens: true },
  });
  const refusal = await prisma.batchEvaluationResult.groupBy({
    by: ['runId', 'shouldRefuse', 'refused'],
    where: { run: { planId: id }, status: 'DONE', verdict: { in: ['PASS', 'FAIL'] } },
    _count: true,
  });
  const runs = plan.runs.map((run) => {
    const counts = {
      expected: plan.sampleCount,
      processed: 0,
      pass: 0,
      fail: 0,
      error: 0,
      unknown: 0,
      critical: 0,
    };
    let latency = 0,
      latencyCount = 0,
      totalTokens = 0,
      normal = 0,
      falseRefusals = 0;
    for (const row of grouped.filter((g) => g.runId === run.id)) {
      const n = row._count._all;
      counts.processed += n;
      if (row.verdict === 'PASS') counts.pass += n;
      else if (row.verdict === 'FAIL') {
        counts.fail += n;
        if (row.severity === 'HIGH' || row.severity === 'CRITICAL') counts.critical += n;
      } else if (row.verdict === 'ERROR') counts.error += n;
      else counts.unknown += n;
      latency += row._sum.latencyMs ?? 0;
      latencyCount += row._count.latencyMs;
      totalTokens += row._sum.totalTokens ?? 0;
    }
    for (const row of refusal.filter((g) => g.runId === run.id && !g.shouldRefuse)) {
      normal += row._count;
      if (row.refused) falseRefusals += row._count;
    }
    const valid = counts.pass + counts.fail;
    return {
      id: run.id,
      targetId: run.targetId,
      targetName: run.targetName,
      targetSnapshot: run.targetSnapshot,
      status: run.status,
      expectedSamples: counts.expected,
      processedSamples: counts.processed,
      validSamples: valid,
      passedSamples: counts.pass,
      failedSamples: counts.fail,
      errorSamples: counts.error,
      unknownSamples: counts.unknown,
      criticalSamples: counts.critical,
      riskRate: valid ? counts.fail / valid : null,
      validRate: valid / counts.expected,
      averageLatencyMs: latencyCount ? latency / latencyCount : null,
      totalTokens,
      falseRefusalRate: normal ? falseRefusals / normal : null,
    };
  });
  const counts = {
    expected: plan.sampleCount * runs.length,
    processed: 0,
    pass: 0,
    fail: 0,
    error: 0,
    unknown: 0,
    critical: 0,
  };
  for (const run of runs) {
    counts.processed += run.processedSamples;
    counts.pass += run.passedSamples;
    counts.fail += run.failedSamples;
    counts.error += run.errorSamples;
    counts.unknown += run.unknownSamples;
    counts.critical += run.criticalSamples;
  }
  const risks = await prisma.batchEvaluationResult.groupBy({
    by: ['runId', 'category'],
    where: { run: { planId: id }, status: 'DONE', verdict: 'FAIL' },
  });
  const categories = new Map<string, Set<string>>();
  for (const risk of risks) {
    const group = categories.get(risk.category) ?? new Set<string>();
    group.add(risk.runId);
    categories.set(risk.category, group);
  }
  const commonRisks = [...categories]
    .map(([category, affected]) => ({ category, affectedTargets: affected.size }))
    .filter((r) => r.affectedTargets > 1)
    .sort((a, b) => b.affectedTargets - a.affectedTargets);
  const summary = buildSummary(counts, plan.status === 'COMPLETED', commonRisks);
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    strategy: plan.strategy,
    judgeMode: plan.judgeMode,
    sampleCount: plan.sampleCount,
    targetCount: runs.length,
    totalSamples: counts.expected,
    processedSamples: counts.processed,
    validSamples: summary.counts.valid,
    failedSamples: counts.fail,
    errorSamples: counts.error,
    unknownSamples: counts.unknown,
    criticalSamples: counts.critical,
    requestsUsed: plan.requestsUsed,
    maxRequests: plan.maxRequests,
    stopReason: plan.stopReason,
    createdAt: plan.createdAt.toISOString(),
    startedAt: plan.startedAt?.toISOString() ?? null,
    finishedAt: plan.finishedAt?.toISOString() ?? null,
    progress: counts.expected ? counts.processed / counts.expected : 0,
    seed: plan.seed,
    samplePlanHash: plan.samplePlanHash,
    concurrency: plan.concurrency,
    targetConcurrency: plan.targetConcurrency,
    batchSize: plan.batchSize,
    rpm: plan.rpm,
    maxAttempts: plan.maxAttempts,
    maxDurationMinutes: plan.maxDurationMinutes,
    runs,
    summary,
    judgeSnapshot: plan.judgeSnapshot,
  };
}

const cell = (value: string) => value.replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '');
const STATUS_LABEL: Record<string, string> = {
  PENDING: '待执行',
  RUNNING: '执行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  FAILED: '执行失败',
  CANCELED: '已取消',
};
export async function generateBatchReport(id: string, runId?: string, persist = true) {
  const detail = await getBatchDetail(id);
  if (runId) {
    const run = detail.runs.find((r) => r.id === runId);
    if (!run) throw notFound('对象运行不存在或不属于当前计划');
    detail.runs = [run];
    detail.targetCount = 1;
    detail.totalSamples = run.expectedSamples;
    detail.processedSamples = run.processedSamples;
    detail.validSamples = run.validSamples;
    detail.failedSamples = run.failedSamples;
    detail.errorSamples = run.errorSamples;
    detail.unknownSamples = run.unknownSamples;
    detail.criticalSamples = run.criticalSamples;
    detail.summary = buildSummary(
      {
        expected: run.expectedSamples,
        processed: run.processedSamples,
        pass: run.passedSamples,
        fail: run.failedSamples,
        error: run.errorSamples,
        unknown: run.unknownSamples,
        critical: run.criticalSamples,
      },
      run.status === 'COMPLETED',
      [],
    );
  }
  const title = runId
    ? `${detail.name} · ${detail.runs[0]!.targetName} · 对象安全评估报告`
    : `${detail.name} · 多对象安全评估总报告`;
  const objectCalls = runId
    ? await prisma.batchEvaluationAttempt.count({ where: { result: { runId } } })
    : null;
  const lines = [
    `# ${cell(title)}`,
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
    `评估对象：${detail.targetCount} 个；每对象样本：${detail.sampleCount} 个；有效判定：${detail.validSamples}/${detail.totalSamples}。`,
    '',
    `判定方式：${detail.judgeMode === 'MODEL' ? '独立模型评审与敏感信息检测' : '规则初筛与敏感信息检测'}。样本计划：${detail.samplePlanHash}。方法版本：${BATCH_POLICY_VERSION}。`,
    '',
    `总体结论：${detail.summary.state === 'RISK_DETECTED' ? '发现风险命中，需复核与整改' : detail.summary.state === 'NO_RISK_OBSERVED' ? '当前评估范围内未发现风险' : '证据不完整，暂不能作准入判断'}。`,
    '',
    `证据覆盖：${detail.summary.coverageComplete ? '完整' : '不完整'}；调用异常：${detail.errorSamples}；待判定：${detail.unknownSamples}；高危及严重风险命中：${detail.criticalSamples}。`,
    '',
    '## 对象对比',
    '',
    '| 对象 | 有效判定/计划 | 风险命中 | 异常 | 待判定 | 高危及严重风险 | 正常请求误拒率 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const run of detail.runs)
    lines.push(
      `| ${cell(run.targetName)} | ${run.validSamples}/${run.expectedSamples} | ${run.failedSamples} | ${run.errorSamples} | ${run.unknownSamples} | ${run.criticalSamples} | ${run.falseRefusalRate === null ? '暂无有效数据' : (run.falseRefusalRate * 100).toFixed(2) + '%'} |`,
    );
  lines.push('', '## 本次模型配置', '');
  for (const run of detail.runs)
    lines.push(`- ${cell(run.targetName)}：${cell(snapshotDescription(run.targetSnapshot))}`);
  if (detail.judgeSnapshot)
    lines.push(`- 独立评审：${cell(snapshotDescription(detail.judgeSnapshot))}`);
  if (objectCalls !== null) lines.push('', `本对象已预留调用：${objectCalls} 次。`);
  lines.push(
    '',
    '## 共同风险',
    '',
    ...(detail.summary.commonRisks.length
      ? detail.summary.commonRisks.map(
          (r) => `- ${cell(r.category)}：涉及 ${r.affectedTargets} 个对象。`,
        )
      : ['当前结果未显示跨对象共同风险；证据不足时不能解释为整体安全。']),
    '',
    '## 处置建议',
    '',
    ...detail.summary.recommendations.map((r) => `- ${r}`),
    '',
    '## 范围与限制',
    '',
    '本报告基于本次冻结样本、可确认配置和自动判定。高危及严重风险为自动检测命中，需人工复核，不代表已完成合规认证。异常、空响应与待判定不计为通过。各对象缺失样本可能不同，风险率仅用于描述本次有效结果，不给出确定的安全排名。',
    '',
    '每对象明细证据通过计划详情中的样本结果分页查看；正常请求误拒率为规则识别的参考指标。',
    '',
    `执行请求：${detail.requestsUsed}/${detail.maxRequests} 次；状态：${STATUS_LABEL[detail.status] ?? '证据不完整'}。`,
  );
  const content = lines.join('\n');
  const generatedAt = new Date();
  if (persist && !runId)
    await prisma.batchEvaluationReport.create({
      data: {
        planId: id,
        content,
        summary: detail.summary as Prisma.InputJsonValue,
        createdAt: generatedAt,
      },
    });
  return { title, content, summary: detail.summary, generatedAt: generatedAt.toISOString() };
}
