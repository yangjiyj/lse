import { randomUUID } from 'node:crypto';
import { notifyBatchCallback } from './callback.js';
import {
  Prisma,
  type BatchEvaluation,
  type BatchEvaluationResult,
  type ModelTarget,
} from '@prisma/client';
import type {
  EngineResult,
  JudgeInput,
  LlmCallResult,
  LlmTargetConfig,
  Severity,
  Verdict,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { chatComplete } from '../../lib/llm-client.js';
import { assertLicensedFeature } from '../../lib/license-enforcement.js';
import { AppError } from '../../lib/errors.js';
import { invokeEvaluationTarget } from '../eval-targets/invoker.js';
import { createLlmJudgeEngine, type ChatCaller } from '../engines/llm-judge.js';
import { runBuiltinJudges, parseJudgeRules, SEVERITY_RANK } from '../eval-tasks/judge.js';
import { sensitiveInfoScan, isRefusal } from '../eval-tasks/rule-judge.js';
import {
  batchVerdict,
  fingerprint,
  pickRuns,
  strictJudgeContent,
  type BatchStrategy,
  type SampleInput,
} from './core.js';
import { generateBatchReport, validatePlanConfiguration } from './service.js';
import { acquireBatchRateSlot } from './limiter.js';

const LEASE_MS = 180000;
class Stopped extends Error {}
export interface BatchExecutorDeps {
  invoke?: typeof invokeEvaluationTarget;
  chat?: ChatCaller;
  acquireRateSlot?: typeof acquireBatchRateSlot;
  sleep?: (ms: number) => Promise<void>;
}
const tokens = (result: LlmCallResult) =>
  Math.min(10000000, Math.max(0, Math.floor(result.usage.totalTokens ?? 0)));
const errorText = (status: number | null) =>
  status ? `模型调用失败（HTTP ${status}），未计入有效判定` : '模型调用失败或超时，未计入有效判定';
const retryable = (status: number | null) =>
  status === null || status === 408 || status === 429 || status >= 500;

async function pool<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>) {
  let index = 0;
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++]!;
        await run(item);
      }
    }),
  );
  const failed = settled.find((r) => r.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

export async function runBatchEvaluation(id: string, deps: BatchExecutorDeps = {}): Promise<void> {
  const owner = randomUUID();
  const claim = await prisma.batchEvaluation.updateMany({
    where: {
      id,
      status: { in: ['PENDING', 'RUNNING'] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
    },
    data: { status: 'RUNNING', leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
  if (!claim.count) return;
  let lostLease = false;
  let plan: BatchEvaluation;
  const heartbeat = setInterval(() => {
    void prisma.batchEvaluation
      .updateMany({
        where: { id, leaseOwner: owner, leaseUntil: { gt: new Date() } },
        data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
      })
      .then((r) => {
        if (!r.count) lostLease = true;
      })
      .catch(() => {
        lostLease = true;
      });
  }, 10000);
  heartbeat.unref();
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const acquire = deps.acquireRateSlot ?? acquireBatchRateSlot;
  const invoke = deps.invoke ?? invokeEvaluationTarget;
  let inFlight = 0;
  const slotWaiters: (() => void)[] = [];
  const globalSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (inFlight >= plan.concurrency)
      await new Promise<void>((resolve) => slotWaiters.push(resolve));
    else inFlight++;
    try {
      return await work();
    } finally {
      const next = slotWaiters.shift();
      if (next) next();
      else inFlight--;
    }
  };
  const pause = async (reason: string) => {
    await prisma.batchEvaluation.updateMany({
      where: { id, leaseOwner: owner, leaseUntil: { gt: new Date() }, status: 'RUNNING' },
      data: { status: 'PAUSED', stopReason: reason },
    });
  };
  const canContinue = async () => {
    if (lostLease) return false;
    const current = await prisma.batchEvaluation.findUnique({ where: { id } });
    if (
      !current ||
      current.leaseOwner !== owner ||
      current.status !== 'RUNNING' ||
      !current.leaseUntil ||
      current.leaseUntil <= new Date()
    )
      return false;
    if (
      current.startedAt &&
      Date.now() - current.startedAt.getTime() >= current.maxDurationMinutes * 60000
    ) {
      await pause('DURATION_BUDGET_EXHAUSTED');
      return false;
    }
    return true;
  };
  const ensureActive = async () => {
    if (!(await canContinue())) throw new Stopped();
  };
  const owned = async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx) => {
      const lock = await tx.batchEvaluation.updateMany({
        where: { id, leaseOwner: owner, leaseUntil: { gt: new Date() } },
        data: { updatedAt: new Date() },
      });
      if (!lock.count) throw new Stopped();
      return work(tx);
    });
  const updateRun = async (runId: string, data: Prisma.BatchEvaluationRunUpdateInput) =>
    owned((tx) => tx.batchEvaluationRun.update({ where: { id: runId }, data }));
  const saveResult = async (
    resultId: string,
    data: Prisma.BatchEvaluationResultUpdateManyMutationInput,
  ) => {
    await owned((tx) =>
      tx.batchEvaluationResult.updateMany({ where: { id: resultId, run: { planId: id } }, data }),
    );
  };
  const call = async (
    resultId: string,
    role: 'TARGET' | 'JUDGE',
    target: ModelTarget,
    perform: () => Promise<LlmCallResult>,
  ) => {
    if (!(await acquire(target, plan.rpm, canContinue))) throw new Stopped();
    await ensureActive();
    const attempt = await prisma.$transaction(async (tx) => {
      const reserved = await tx.batchEvaluation.updateMany({
        where: {
          id,
          leaseOwner: owner,
          leaseUntil: { gt: new Date() },
          status: 'RUNNING',
          requestsUsed: { lt: plan.maxRequests },
        },
        data: { requestsUsed: { increment: 1 } },
      });
      if (!reserved.count) return null;
      const result = await tx.batchEvaluationResult.update({
        where: { id: resultId },
        data:
          role === 'TARGET' ? { attempts: { increment: 1 } } : { judgeAttempts: { increment: 1 } },
      });
      return tx.batchEvaluationAttempt.create({
        data: {
          resultId,
          role,
          attemptNo: role === 'TARGET' ? result.attempts : result.judgeAttempts,
        },
      });
    });
    if (!attempt) {
      if (await canContinue()) await pause('REQUEST_BUDGET_EXHAUSTED');
      throw new Stopped();
    }
    let response: LlmCallResult;
    try {
      response = await perform();
    } catch {
      response = {
        status: 'ERROR',
        content: '',
        finishReason: null,
        model: null,
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        latencyMs: 0,
        httpStatus: null,
        error: '调用异常',
        raw: null,
      };
    }
    await owned(async (tx) => {
      await tx.batchEvaluationResult.update({
        where: { id: resultId },
        data: { totalTokens: { increment: tokens(response) } },
      });
      await tx.batchEvaluationAttempt.update({
        where: { id: attempt.id },
        data: {
          status: response.status === 'SUCCESS' && response.content.trim() ? 'SUCCESS' : 'ERROR',
          response:
            role === 'JUDGE' && response.status === 'SUCCESS'
              ? strictJudgeContent(response.content)
              : null,
          httpStatus: response.httpStatus,
          latencyMs: Math.max(0, Math.round(response.latencyMs)),
          totalTokens: tokens(response),
          errorCode:
            response.status === 'ERROR' ? `HTTP_${response.httpStatus ?? 'UNKNOWN'}` : null,
        },
      });
      if (role === 'TARGET' && response.status === 'SUCCESS' && response.content.trim())
        await tx.batchEvaluationResult.update({
          where: { id: resultId },
          data: {
            response: response.content,
            latencyMs: Math.max(0, Math.round(response.latencyMs)),
            errorMessage: null,
          },
        });
    });
    return response;
  };
  const processResult = async (
    item: BatchEvaluationResult & { sample: { snapshot: Prisma.JsonValue; id: string } },
    target: ModelTarget,
    judge: ModelTarget | null,
  ) => {
    try {
      await ensureActive();
      const run = await prisma.batchEvaluationRun.findUnique({
        where: { id: item.runId },
        select: { status: true },
      });
      if (run?.status === 'FAILED') return;
      await saveResult(item.id, { status: 'RUNNING' });
      const limit = item.targetAttemptLimit;
      let response = item.response;
      let lastStatus: number | null = null;
      let attemptNo = item.attempts;
      while (!response && attemptNo < limit) {
        const q = item.sample.snapshot as unknown as SampleInput;
        const res = await call(item.id, 'TARGET', target, () =>
          invoke(target, [{ role: 'user', content: q.content }], {
            timeoutMs: 60000,
            correlationHeaders: {
              'X-LSE-Eval-Run-Id': id,
              'X-LSE-Task-Id': item.runId,
              'X-LSE-Sample-Id': item.sample.id,
              'X-LSE-Target-Id': target.id,
              'X-LSE-Trace-Id': item.id,
            },
          }),
        );
        attemptNo++;
        lastStatus = res.httpStatus;
        if (res.status === 'SUCCESS' && res.content.trim()) response = res.content;
        else if (res.status === 'SUCCESS') {
          await saveResult(item.id, {
            status: 'DONE',
            verdict: 'UNKNOWN',
            errorMessage: '模型返回空响应，需补测或复核',
          });
          return;
        } else if (res.httpStatus === 401 || res.httpStatus === 403) {
          await saveResult(item.id, {
            status: 'DONE',
            verdict: 'ERROR',
            errorMessage: '评估对象鉴权失败，请检查接入配置',
          });
          await updateRun(item.runId, { status: 'FAILED' });
          return;
        } else if (!retryable(res.httpStatus)) break;
        else if (attemptNo < limit) {
          await ensureActive();
          await sleep(Math.min(8000, 500 * 2 ** Math.min(attemptNo - 1, 4)));
        }
      }
      if (!response) {
        await saveResult(item.id, {
          status: 'DONE',
          verdict: 'ERROR',
          errorMessage: errorText(lastStatus),
        });
        return;
      }
      await ensureActive();
      const q = item.sample.snapshot as unknown as SampleInput;
      const input: JudgeInput = {
        taskId: item.runId,
        questionId: item.sampleId,
        questionType: q.type as JudgeInput['questionType'],
        prompt: q.content,
        response,
        shouldRefuse: q.shouldRefuse,
        expectedBehavior: q.expectedBehavior,
        referenceAnswer: q.referenceAnswer,
        severity: q.severity as Severity | null,
        rules: parseJudgeRules(q.metadata),
      };
      let engines: EngineResult[];
      let verdict: Verdict;
      if (plan.judgeMode === 'MODEL') {
        if (!judge)
          throw new AppError(
            409,
            '独立评审模型不可用，不能改用规则判定',
            'JUDGE_CONFIGURATION_CHANGED',
          );
        let result: EngineResult | null = null;
        let stopped = false;
        let lastCall: LlmCallResult | null = null;
        let judgeAttempt = item.judgeAttempts;
        let replay =
          item.status === 'RUNNING'
            ? ((
                await prisma.batchEvaluationAttempt.findFirst({
                  where: {
                    resultId: item.id,
                    role: 'JUDGE',
                    status: 'SUCCESS',
                    attemptNo: { gt: Math.max(0, item.judgeAttemptLimit - plan.maxAttempts) },
                    response: { not: null },
                  },
                  orderBy: { attemptNo: 'desc' },
                })
              )?.response ?? null)
            : null;
        const cfg: LlmTargetConfig = {
          baseUrl: judge.baseUrl,
          apiKey: judge.apiKey,
          model: judge.model,
          extraHeaders: judge.extraHeaders as Record<string, string> | null,
          defaultParams: judge.defaultParams as Record<string, unknown> | null,
        };
        const engine = createLlmJudgeEngine({
          target: cfg,
          enabled: true,
          rubricEnabled: true,
          timeoutMs: 60000,
          chat: async (targetCfg, messages, opts) => {
            try {
              if (replay) {
                const content = replay;
                replay = null;
                lastCall = {
                  status: 'SUCCESS',
                  content,
                  finishReason: 'stop',
                  model: judge.model,
                  usage: { promptTokens: null, completionTokens: null, totalTokens: null },
                  latencyMs: 0,
                  httpStatus: 200,
                  error: null,
                  raw: null,
                };
              } else
                lastCall = await call(item.id, 'JUDGE', judge, () =>
                  (deps.chat ?? chatComplete)(targetCfg, messages, opts),
                );
              return { ...lastCall, content: strictJudgeContent(lastCall.content) ?? '' };
            } catch (error) {
              if (error instanceof Stopped) stopped = true;
              throw error;
            }
          },
        });
        while (replay || judgeAttempt < item.judgeAttemptLimit) {
          await ensureActive();
          const replayed = Boolean(replay);
          result = await engine.judge(input);
          if (!replayed) judgeAttempt++;
          if (stopped) throw new Stopped();
          const raw = result.rawOutput as { fallback?: boolean } | null;
          if (!raw?.fallback) break;
          if (judgeAttempt < item.judgeAttemptLimit)
            await sleep(Math.min(8000, 500 * 2 ** Math.min(judgeAttempt - 1, 4)));
        }
        const fallback = !result || (result.rawOutput as { fallback?: boolean } | null)?.fallback;
        if (fallback) {
          const callFailed = !lastCall || (lastCall as LlmCallResult).status === 'ERROR';
          await saveResult(item.id, {
            status: 'DONE',
            verdict: callFailed ? 'ERROR' : 'UNKNOWN',
            errorMessage: callFailed
              ? '独立评审调用失败，已保存被测响应，可仅重试判定'
              : '独立评审输出无法判定，已保存被测响应，请复核或重试判定',
            evidence: [],
          });
          return;
        }
        engines = [result!, sensitiveInfoScan(input)];
        verdict = batchVerdict(engines);
      } else {
        engines = runBuiltinJudges(input);
        verdict = batchVerdict(engines);
      }
      await ensureActive();
      const highest = engines
        .filter((r) => r.verdict === 'FAIL')
        .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
      await saveResult(item.id, {
        status: 'DONE',
        verdict,
        severity: highest?.severity ?? null,
        refused: isRefusal(response, input.rules?.refusalMarkers),
        evidence: engines.map((r) => r.evidence).filter((s): s is string => Boolean(s)),
        errorMessage: verdict === 'UNKNOWN' ? '自动判定证据不足，请复核或补测' : null,
      });
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
    }
  };
  try {
    await assertLicensedFeature('web_ai');
    let validated = await validatePlanConfiguration(id);
    plan = validated.plan;
    if (
      plan.policyVersion !== 'batch-evaluation-v1' ||
      !['MODEL', 'RULES'].includes(plan.judgeMode)
    )
      throw new AppError(409, '评估方法版本已变化，请创建新计划', 'TARGET_CONFIGURATION_CHANGED');
    if (!plan.startedAt) {
      plan = await prisma.batchEvaluation.update({
        where: { id },
        data: { startedAt: new Date() },
      });
    }
    const hash = fingerprint(
      (
        await prisma.batchEvaluationSample.findMany({
          where: { planId: id },
          orderBy: { sequence: 'asc' },
          select: { snapshot: true },
        })
      ).map((s) => s.snapshot),
    );
    if (hash !== plan.samplePlanHash)
      throw new AppError(409, '样本快照完整性校验失败', 'TARGET_CONFIGURATION_CHANGED');
    while (await canContinue()) {
      validated = await validatePlanConfiguration(id);
      const runs = validated.plan.runs.sort((a, b) => a.position - b.position);
      const remaining = await prisma.batchEvaluationResult.groupBy({
        by: ['runId'],
        where: { run: { planId: id }, status: { not: 'DONE' } },
        _count: true,
      });
      const eligible = runs.map((r) => ({
        id: r.id,
        remaining:
          r.status === 'FAILED' ? 0 : (remaining.find((g) => g.runId === r.id)?._count ?? 0),
      }));
      const picked = pickRuns(
        eligible,
        plan.strategy as BatchStrategy,
        validated.plan.nextRunIndex,
      );
      if (!picked.length) {
        const hasUnfinished = remaining.some((r) => r._count > 0);
        await owned((tx) =>
          tx.batchEvaluationRun.updateMany({
            where: { planId: id, status: { not: 'FAILED' } },
            data: { status: 'COMPLETED' },
          }),
        );
        const finished = await prisma.batchEvaluation.updateMany({
          where: { id, leaseOwner: owner, leaseUntil: { gt: new Date() }, status: 'RUNNING' },
          data: {
            status: hasUnfinished ? 'FAILED' : 'COMPLETED',
            stopReason: hasUnfinished ? 'TARGET_AUTHENTICATION_FAILED' : null,
            finishedAt: new Date(),
          },
        });
        if (finished.count) {
          await generateBatchReport(id);
          void notifyBatchCallback(id);
        }
        break;
      }
      const judge = validated.judge;
      const settled = await Promise.allSettled(
        picked.map(async (runId) => {
          const run = runs.find((r) => r.id === runId)!;
          const target = validated.targets.find((t) => t.id === run.targetId)!;
          await updateRun(runId, { status: 'RUNNING' });
          const items = await prisma.batchEvaluationResult.findMany({
            where: { runId, status: { not: 'DONE' } },
            include: { sample: { select: { snapshot: true, id: true } } },
            orderBy: { sample: { sequence: 'asc' } },
            take: plan.batchSize,
          });
          await pool(items, Math.min(plan.targetConcurrency, plan.concurrency), (item) =>
            globalSlot(() => processResult(item, target, judge)),
          );
          const pending = await prisma.batchEvaluationResult.count({
            where: { runId, status: { not: 'DONE' } },
          });
          if (!pending)
            await owned((tx) =>
              tx.batchEvaluationRun.updateMany({
                where: { id: runId, status: { not: 'FAILED' } },
                data: { status: 'COMPLETED' },
              }),
            );
        }),
      );
      const failed = settled.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const lastPosition = runs.findIndex((r) => r.id === picked[picked.length - 1]);
      await prisma.batchEvaluation.updateMany({
        where: { id, leaseOwner: owner, leaseUntil: { gt: new Date() } },
        data: { nextRunIndex: (lastPosition + 1) % runs.length },
      });
    }
  } catch (error) {
    if (!(error instanceof Stopped)) {
      const reason =
        error instanceof AppError &&
        ['TARGET_CONFIGURATION_CHANGED', 'JUDGE_CONFIGURATION_CHANGED'].includes(error.code)
          ? error.code
          : 'EXECUTION_FAILED';
      await prisma.batchEvaluation.updateMany({
        where: { id, leaseOwner: owner, leaseUntil: { gt: new Date() }, status: 'RUNNING' },
        data: { status: reason === 'EXECUTION_FAILED' ? 'FAILED' : 'PAUSED', stopReason: reason },
      });
      if (reason === 'EXECUTION_FAILED') throw error;
    }
  } finally {
    clearInterval(heartbeat);
    const current = await prisma.batchEvaluation.findUnique({
      where: { id },
      select: { status: true, leaseOwner: true },
    });
    if (
      current?.leaseOwner === owner &&
      ['PAUSED', 'CANCELED', 'FAILED'].includes(current.status)
    ) {
      try {
        await owned((tx) =>
          tx.batchEvaluationRun.updateMany({
            where: { planId: id, status: 'RUNNING' },
            data: { status: current.status },
          }),
        );
      } catch (error) {
        if (!(error instanceof Stopped)) throw error;
      }
    }
    await prisma.batchEvaluation.updateMany({
      where: { id, leaseOwner: owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}
