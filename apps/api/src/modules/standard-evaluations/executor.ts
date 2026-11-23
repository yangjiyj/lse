import { PrismaClient, Prisma } from '@prisma/client';
import { STANDARD_JUDGMENT_RULE_VERSION, type ChatMessage } from '@lse/shared';
import { prisma } from '../../db.js';
import { isEvalTaskCancelRequested } from '../../lib/queue.js';
import { invokeEvaluationTarget, type EvaluationTargetConfig } from '../eval-targets/invoker.js';
import { classifyTechnicalResponse } from './core.js';
import { standardGroupLabel, standardTaskCounters } from './task-evidence.js';
import { ensureAutoMeasures } from './gbt45654/measures-store.js';
import {
  isGbtMethodsPlan,
  judgeGbtSample,
  preflightGbtJudge,
  prepareGbtJudging,
  runGbtJudging,
  type GbtJudgingContext,
  type GbtJudgingDeps,
  type GbtJudgingSummary,
} from './gbt45654/pipeline.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface StandardEvaluationExecutorDeps {
  db?: PrismaClient;
  invoke?: typeof invokeEvaluationTarget;
  isCancelRequested?: (taskId: string) => Promise<boolean>;
  timeoutMs?: number;
  maxAttempts?: number;
  /** 按附录 B 方法抽样的运行：自动判定（关键词、分类模型、拒答）的注入点，测试用。 */
  gbtJudging?: GbtJudgingDeps;
}

type LogLevel = 'info' | 'warn' | 'error';

/** 写任务日志，best-effort，绝不抛出——日志失败不能带塌评估本身。 */
async function safeLog(
  db: PrismaClient,
  taskId: string,
  level: LogLevel,
  message: string,
  context?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await db.evalTaskLog.create({
      data: {
        taskId,
        level,
        message,
        ...(context !== undefined ? { context } : {}),
      },
    });
  } catch (err) {
    console.error(`[standard-executor] 写任务日志失败 taskId=${taskId}:`, (err as Error).message);
  }
}

function jsonInput(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  return value === null || value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function targetConfig(target: {
  targetType: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders: Prisma.JsonValue | null;
  defaultParams: Prisma.JsonValue | null;
  accessConfig: Prisma.JsonValue | null;
}): EvaluationTargetConfig {
  return {
    targetType: target.targetType,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    extraHeaders: target.extraHeaders,
    defaultParams: target.defaultParams,
    accessConfig: target.accessConfig,
  };
}

async function withConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, run),
  );
}

async function saveAutomaticJudgment(
  db: PrismaClient,
  sample: { id: string; group: string; selectedResponse: string | null },
): Promise<void> {
  if (!sample.selectedResponse?.trim()) return;
  const existing = await db.standardJudgment.findFirst({
    where: { sampleId: sample.id, source: 'TECHNICAL' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (existing) return;

  const outcome = classifyTechnicalResponse(sample.selectedResponse);
  await db.standardJudgment.create({
    data: {
      sampleId: sample.id,
      source: 'TECHNICAL',
      ruleVersion: STANDARD_JUDGMENT_RULE_VERSION,
      safetyOutcome:
        sample.group === 'MANUAL_SAFETY' || sample.group === 'TECHNICAL_SAFETY'
          ? outcome.safetyOutcome
          : null,
      refusalOutcome:
        sample.group === 'SHOULD_REFUSE' || sample.group === 'NON_REFUSAL'
          ? outcome.refusalOutcome
          : null,
      reason: outcome.reason,
      evidence: '自动技术规则判定 / 参考指标；本次未进行人工抽检。',
    },
  });
}

/**
 * 进度与判定计数一起回写：详情页的概览、任务列表和报告快照读的都是这几个字段，
 * 只更新 progress 会让"跑完了但一条都没有"这种假象留在界面上。
 */
async function updateProgress(db: PrismaClient, taskId: string, total: number): Promise<void> {
  const counters = await standardTaskCounters(db, taskId);
  await db.evalTask.update({
    where: { id: taskId },
    data: {
      processedQuestions: counters.processed,
      passedCount: counters.passed,
      failedCount: counters.failed,
      errorCount: counters.error,
      progress: total > 0 ? counters.processed / total : 1,
    },
  });
}

/**
 * 标准专项 worker：复用现有模型 API invoker 和 eval-tasks BullMQ 队列。
 * 每个样本的尝试记录只追加不覆盖；已成功样本恢复执行时跳过，避免重复证据。
 */
export async function runStandardEvaluation(
  runId: string,
  deps: StandardEvaluationExecutorDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  const invoke = deps.invoke ?? invokeEvaluationTarget;
  const isCancelRequested = deps.isCancelRequested ?? isEvalTaskCancelRequested;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const run = await db.standardRun.findUnique({
    where: { id: runId },
    include: {
      task: { include: { modelTarget: true } },
      samples: { orderBy: [{ group: 'asc' }, { sequence: 'asc' }] },
    },
  });
  if (!run) {
    console.error(`[standard-executor] 标准专项不存在 runId=${runId}`);
    return;
  }
  if (run.status === 'COMPLETED') return;
  if (run.task.status === 'CANCELED') return;

  await db.$transaction([
    db.standardRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', evidenceCompleteness: 'PARTIAL' },
    }),
    db.evalTask.update({
      where: { id: run.taskId },
      data: { status: 'RUNNING', startedAt: run.task.startedAt ?? new Date() },
    }),
  ]);

  const groupCounts: Record<string, number> = {};
  for (const sample of run.samples) {
    groupCounts[sample.group] = (groupCounts[sample.group] ?? 0) + 1;
  }
  await safeLog(
    db,
    run.taskId,
    'info',
    `国标输出安全专项开始执行：${run.samples.length} 条样本，评估对象 ${run.task.modelTarget.name}（${run.task.modelTarget.model}），并发 ${run.task.concurrency}。`,
    {
      runId: run.id,
      sampleCount: run.samples.length,
      concurrency: run.task.concurrency,
      groups: Object.fromEntries(
        Object.entries(groupCounts).map(([group, count]) => [standardGroupLabel(group), count]),
      ),
      maxAttempts,
      timeoutMs,
    },
  );

  const target = targetConfig(run.task.modelTarget);
  // 按附录 B 方法抽样的运行：不用旧版正则技术判定，每取得一条回答就做关键词、分类模型或拒答判定，
  // 进度和结果可信度随取样一起更新；中途取消时，已取得的回答也已判过。
  const gbtRun = isGbtMethodsPlan(run.samplePlan);
  let gbtContext: GbtJudgingContext | null = null;
  if (gbtRun) {
    try {
      gbtContext = await prepareGbtJudging(db, run, {
        ...deps.gbtJudging,
        log: (level, message) => safeLog(db, run.taskId, level, message, { runId: run.id }),
      });
      const kw = gbtContext.keyword;
      const cls = gbtContext.classifier;
      await safeLog(
        db,
        run.taskId,
        kw.status === 'done' && cls.status === 'done' ? 'info' : 'warn',
        `判定条件：技术抽检的关键词部分${kw.status === 'done' ? `使用生效词 ${kw.approved} 个` : `不可用（${kw.reason}）`}，分类模型部分${cls.status === 'done' ? `由裁判模型 ${cls.model} 判定` : `不可用（${cls.reason}）`}；拒答题${gbtContext.judge ? '由裁判模型判定' : '按规则判定'}（人工复核做满 300 题时以人工结论为准）。每取得一条回答即判定。`,
        { runId: run.id, keyword: kw.status, classifier: cls.status },
      );
      // 开跑前预检裁判模型：连不通就进入故障状态，但不终止任务——取样是最贵的部分，照常收回答。
      const pre = await preflightGbtJudge(gbtContext);
      if (pre && !pre.ok) {
        await safeLog(
          db,
          run.taskId,
          'error',
          `裁判模型连不通：${pre.error}。回答照常收集、关键词照常判定；技术抽检的分类模型部分和拒答预判等裁判模型恢复后点「补跑判定」。`,
          { runId: run.id, judgeModel: gbtContext.judge?.model ?? null },
        );
      }
    } catch (error) {
      await safeLog(
        db,
        run.taskId,
        'error',
        `判定准备失败：${(error as Error).message}。回答照常收集，取样结束后再补判。`,
        { runId: run.id },
      );
    }
  }
  /** 逐条判定：失败只记日志，取样结束后的补判会再试一次。返回是否已判。 */
  const judgeInline = async (
    sample: { id: string; group: string; inputSnapshot: string },
    response: string,
    label: string,
  ): Promise<boolean> => {
    if (!gbtContext) return false;
    try {
      const judgments = await db.standardJudgment.findMany({
        where: { sampleId: sample.id },
        select: { source: true, safetyOutcome: true, refusalOutcome: true, evidence: true },
      });
      // 回答已经取到，判定不因取消而中断：取消只停止继续向被测对象提问。
      await judgeGbtSample(db, gbtContext, {
        id: sample.id,
        group: sample.group,
        inputSnapshot: sample.inputSnapshot,
        selectedResponse: response,
        judgments,
      });
      return true;
    } catch (error) {
      await safeLog(
        db,
        run.taskId,
        'warn',
        `${label}自动判定失败：${(error as Error).message}。取样结束后补判。`,
        { sampleId: sample.id, group: sample.group },
      );
      return false;
    }
  };
  let canceled = false;
  let done = 0;
  const total = run.samples.length;
  const processSample = async (sample: (typeof run.samples)[number]): Promise<void> => {
    if (canceled || (await isCancelRequested(run.taskId))) {
      canceled = true;
      return;
    }

    const label = `${standardGroupLabel(sample.group)} 第 ${sample.sequence} 条`;
    const finish = async (level: LogLevel, message: string, context: Prisma.InputJsonValue) => {
      done += 1;
      await safeLog(db, run.taskId, level, `[${done}/${total}] ${label}${message}`, context);
    };

    const latestSuccess = await db.standardSampleAttempt.findFirst({
      where: { sampleId: sample.id, status: 'SUCCESS', response: { not: null } },
      orderBy: { attemptNo: 'desc' },
    });
    if (latestSuccess?.response?.trim()) {
      if (!sample.selectedResponse) {
        await db.standardSample.update({
          where: { id: sample.id },
          data: {
            responseStatus: 'SUCCESS',
            selectedAttemptNo: latestSuccess.attemptNo,
            selectedResponse: latestSuccess.response,
            selectedRawResponse:
              latestSuccess.rawResponse === null ? Prisma.JsonNull : latestSuccess.rawResponse,
            selectedAt: new Date(),
          },
        });
      }
      const reusedResponse = sample.selectedResponse ?? latestSuccess.response;
      if (!gbtRun) {
        await saveAutomaticJudgment(db, {
          id: sample.id,
          group: sample.group,
          selectedResponse: reusedResponse,
        });
      } else {
        await judgeInline(sample, reusedResponse, label);
      }
      await updateProgress(db, run.taskId, run.samples.length);
      await finish('info', '沿用已有成功证据，未重复调用模型。', {
        sampleId: sample.id,
        group: sample.group,
        attemptNo: latestSuccess.attemptNo,
        reused: true,
      });
      return;
    }

    const latestAttempt = await db.standardSampleAttempt.findFirst({
      where: { sampleId: sample.id },
      orderBy: { attemptNo: 'desc' },
      select: { attemptNo: true },
    });
    const firstAttempt = (latestAttempt?.attemptNo ?? 0) + 1;
    let success = false;
    let lastError: string | null = null;
    let attemptsUsed = 0;
    for (let offset = 0; offset < maxAttempts; offset += 1) {
      if (canceled || (await isCancelRequested(run.taskId))) {
        canceled = true;
        break;
      }
      const attemptNo = firstAttempt + offset;
      const messages: ChatMessage[] = [{ role: 'user', content: sample.inputSnapshot }];
      const result = await invoke(target, messages, { timeoutMs });
      const hasContent = result.status === 'SUCCESS' && Boolean(result.content?.trim());
      const status = hasContent ? 'SUCCESS' : 'ERROR';
      let attempt;
      try {
        attempt = await db.standardSampleAttempt.create({
          data: {
            sampleId: sample.id,
            attemptNo,
            status,
            response: hasContent ? result.content : null,
            rawResponse: jsonInput(result.raw),
            latencyMs: result.latencyMs,
            httpStatus: result.httpStatus,
            errorMessage: hasContent ? null : result.error || '模型 API 返回空响应或调用失败',
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // 并发恢复时另一 worker 已写入同一尝试；交给已写入者继续处理。
          continue;
        }
        throw error;
      }
      attemptsUsed += 1;

      if (hasContent) {
        await db.standardSample.update({
          where: { id: sample.id },
          data: {
            responseStatus: 'SUCCESS',
            selectedAttemptNo: attempt.attemptNo,
            selectedResponse: result.content,
            selectedRawResponse: jsonInput(result.raw),
            selectedAt: new Date(),
          },
        });
        let judgedNote = '已取得模型响应并完成技术判定。';
        if (!gbtRun) {
          await saveAutomaticJudgment(db, {
            id: sample.id,
            group: sample.group,
            selectedResponse: result.content,
          });
        } else {
          const judged = await judgeInline(sample, result.content, label);
          judgedNote = judged ? '已取得模型响应并完成自动判定。' : '已取得模型响应，判定待取样结束后补判。';
        }
        success = true;
        await updateProgress(db, run.taskId, run.samples.length);
        await finish('info', judgedNote, {
          sampleId: sample.id,
          group: sample.group,
          attemptNo: attempt.attemptNo,
          latencyMs: result.latencyMs,
          httpStatus: result.httpStatus,
        });
        break;
      }

      lastError = attempt.errorMessage;
      await safeLog(
        db,
        run.taskId,
        'warn',
        `${label}第 ${attemptNo} 次调用未取得有效响应：${lastError}`,
        {
          sampleId: sample.id,
          group: sample.group,
          attemptNo,
          httpStatus: result.httpStatus,
          latencyMs: result.latencyMs,
        },
      );

      if (offset === maxAttempts - 1) {
        await db.standardSample.update({
          where: { id: sample.id },
          data: { responseStatus: 'ERROR' },
        });
      }
    }
    if (!success && !canceled) {
      await updateProgress(db, run.taskId, run.samples.length);
      await finish(
        'error',
        `连续 ${attemptsUsed} 次调用失败，记为执行异常：${lastError ?? '未知原因'}`,
        {
          sampleId: sample.id,
          group: sample.group,
          attempts: attemptsUsed,
        },
      );
    }
  };

  await withConcurrency(run.samples, run.task.concurrency, processSample);

  if (canceled) {
    await db.$transaction([
      db.standardRun.update({
        where: { id: run.id },
        data: { status: 'CANCELED', evidenceCompleteness: 'PARTIAL' },
      }),
      db.evalTask.update({
        where: { id: run.taskId },
        data: { status: 'CANCELED', finishedAt: new Date() },
      }),
    ]);
    if (gbtRun) {
      // 记下判定条件，并对漏判样本补做本地关键词判定；取消后不再调用裁判模型，需要时在详情页「补跑判定」。
      try {
        await runGbtJudging(db, run.id, {
          ...deps.gbtJudging,
          ...(gbtContext ? { context: gbtContext } : {}),
          isCancelRequested: async () => true,
        });
      } catch (error) {
        await safeLog(db, run.taskId, 'error', `取消后记录判定状态失败：${(error as Error).message}`, {
          runId: run.id,
        });
      }
    }
    // 取消当时的计数落库（GET summary 已改为纯读，不再靠打开详情页来"自愈"）。
    await updateProgress(db, run.taskId, run.samples.length);
    await safeLog(db, run.taskId, 'warn', '收到取消请求，标准专项已停止；已取得的回答已判定，证据保留。', {
      runId: run.id,
      processed: done,
      total,
    });
    return;
  }

  if (gbtRun) {
    try {
      const judged = await runGbtJudging(db, run.id, {
        isCancelRequested: () => isCancelRequested(run.taskId),
        ...deps.gbtJudging,
        ...(gbtContext ? { context: gbtContext } : {}),
      });
      await safeLog(db, run.taskId, 'info', '自动判定完成（技术抽检的关键词与分类模型判定、拒答预判），漏判样本已补判。', {
        runId: run.id,
        keyword: judged.keyword?.status ?? null,
        classifier: judged.classifier?.status ?? null,
        refusal: judged.refusal ?? null,
      } as Prisma.InputJsonValue);
    } catch (error) {
      // 判定失败不能带塌整次评估：回答证据已落库，复核后可用「补跑判定」重来。
      await safeLog(
        db,
        run.taskId,
        'error',
        `自动判定失败：${(error as Error).message}。回答证据已保留，可在任务详情里补跑判定。`,
        { runId: run.id },
      );
    }
    await autoMeasures(db, run.id, run.taskId, target, invoke);
  }

  const final = await db.standardSample.findMany({
    where: { standardRunId: run.id },
    select: { responseStatus: true },
  });
  const terminal = final.every(
    (sample) => sample.responseStatus === 'SUCCESS' || sample.responseStatus === 'ERROR',
  );
  await db.$transaction([
    db.standardRun.update({
      where: { id: run.id },
      data: { status: terminal ? 'COMPLETED' : 'WAITING_REVIEW' },
    }),
    db.evalTask.update({
      where: { id: run.taskId },
      data: {
        status: terminal ? 'COMPLETED' : 'RUNNING',
        finishedAt: terminal ? new Date() : null,
      },
    }),
  ]);
  await updateProgress(db, run.taskId, run.samples.length);

  const counters = await standardTaskCounters(db, run.taskId);
  // 过度拒答按安全口径算通过，但必须在收尾行里点名，否则这个偏差只剩国标指标块能看到。
  const overRefusalNote =
    counters.overRefusal > 0
      ? `；其中 ${counters.overRefusal} 条非拒答样本被拒答，计入国标非拒答率，未计为安全不合格`
      : '';
  await safeLog(
    db,
    run.taskId,
    counters.error > 0 || counters.failed > 0 ? 'warn' : 'info',
    terminal
      ? `国标输出安全专项执行完成：${counters.processed}/${counters.total} 条已执行，合格 ${counters.passed} 条，不合格 ${counters.failed} 条，执行异常 ${counters.error} 条${overRefusalNote}。`
      : `国标输出安全专项暂停等待复核：${counters.processed}/${counters.total} 条已执行。`,
    {
      runId: run.id,
      status: terminal ? 'COMPLETED' : 'WAITING_REVIEW',
      ...counters,
    },
  );
}

/**
 * 自动取证（第 6.5 条 a) 违规输入处置、GB 45438 显式标识）：失败只记日志，不影响评估结论。
 */
async function autoMeasures(
  db: PrismaClient,
  runId: string,
  taskId: string,
  target: EvaluationTargetConfig,
  invoke: typeof invokeEvaluationTarget,
): Promise<void> {
  try {
    const done = await ensureAutoMeasures(db, { runId, target, invoke });
    if (done.length > 0) {
      await safeLog(db, taskId, 'info', `已自动取证：${done.map((id) => (id.startsWith('gb45438') ? '生成内容显式标识' : '违规输入处置')).join('、')}。`, { runId });
    }
  } catch (error) {
    await safeLog(db, taskId, 'warn', `自动取证失败：${(error as Error).message}。可在任务详情点「补跑判定」重试。`, { runId });
  }
}

/**
 * 补跑判定：对已取得回答、尚缺判定的样本补判（取消的运行、判定失败的样本、复核后重跑），
 * 再刷新任务计数，让详情页「结果可信度」和任务列表同步。题目不重新提问；违规输入处置没取证时补测（向被测对象发 6 条）。
 */
export async function rejudgeGbtRun(
  runId: string,
  deps: StandardEvaluationExecutorDeps = {},
): Promise<GbtJudgingSummary> {
  const db = deps.db ?? prisma;
  const run = await db.standardRun.findUnique({
    where: { id: runId },
    select: { taskId: true, task: { select: { modelTarget: true } } },
  });
  if (!run) throw new Error(`标准专项运行不存在：${runId}`);
  await safeLog(db, run.taskId, 'info', '开始补跑判定：对已取得回答、尚缺判定的样本补判；违规输入处置、显式标识没取证的一并补测。', {
    runId,
  });
  try {
    const { isCancelRequested: _ignored, ...judgingDeps } = deps.gbtJudging ?? {};
    const summary = await runGbtJudging(db, runId, {
      ...judgingDeps,
      log: (level, message) => safeLog(db, run.taskId, level, message, { runId }),
    });
    await autoMeasures(db, runId, run.taskId, targetConfig(run.task.modelTarget), deps.invoke ?? invokeEvaluationTarget);
    const before = await standardTaskCounters(db, run.taskId);
    await updateProgress(db, run.taskId, before.total);
    const counters = await standardTaskCounters(db, run.taskId);
    const unknown = Math.max(counters.processed - counters.passed - counters.failed - counters.error, 0);
    await safeLog(
      db,
      run.taskId,
      unknown > 0 ? 'warn' : 'info',
      `补跑判定完成：已取得回答 ${counters.processed} 条，合格 ${counters.passed} 条，不合格 ${counters.failed} 条，执行异常 ${counters.error} 条，仍未判定 ${unknown} 条。`,
      { runId, ...counters, unknown },
    );
    return summary;
  } catch (error) {
    await safeLog(db, run.taskId, 'error', `补跑判定失败：${(error as Error).message}`, { runId });
    throw error;
  }
}

export async function runStandardEvaluationByTaskId(
  taskId: string,
  deps: StandardEvaluationExecutorDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  const run = await db.standardRun.findUnique({ where: { taskId }, select: { id: true } });
  if (!run) return;
  await runStandardEvaluation(run.id, deps);
}
