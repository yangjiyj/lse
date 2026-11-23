import { platformAppEnabled } from '../eval-targets/platform-adapters/index.js';
import {
  assertNonEndpointTaskTarget,
  ENDPOINT_TASK_ENTRY_MESSAGE,
} from '../../lib/endpoint-task-policy.js';
import type { PrismaClient } from '@prisma/client';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, forbidden, conflict, notFound } from '../../lib/errors.js';
import { enqueueEvalTask } from '../../lib/queue.js';
import { summarizeRetest } from './continuous-evaluation.js';

/** 失败用例复测：父任务里判定为 FAIL / ERROR 的题目进入复测清单（UNKNOWN 未判定不计入）。 */
export const RETEST_FAILED_VERDICTS = ['FAIL', 'ERROR'] as const;
export const RETEST_MODE_FAILED_ONLY = 'FAILED_ONLY';

const RETEST_PARENT_STATUSES = ['COMPLETED', 'FAILED', 'CANCELED'];
const RETIRED_AIG_ENGINE = 'ai-infra-guard';

export interface CreateFailedRetestOptions {
  actorId: string;
  actorName?: string | null;
  /** 复测改走另一评估对象（W4：经安全网关路由到同一被测模型）；默认沿用父任务对象。 */
  targetIdOverride?: string | null;
  /** 传入时回填该 Finding 的 remediationRetestTaskId（须属于父任务且未验证关闭）。 */
  findingId?: string | null;
  /** 任务名；默认「<父任务名>·失败用例复测」。 */
  name?: string | null;
}

export interface CreateFailedRetestResult {
  task: {
    id: string;
    name: string;
    status: string;
    modelTargetId: string;
    parentTaskId: string;
    retestMode: string;
    totalQuestions: number;
  };
  questionIds: string[];
  findingId: string | null;
}

type ParentShape = {
  status: string;
  engines: string[];
  standardRun: { id: string } | null;
};

function retestBlock(
  parent: ParentShape,
  failedQuestionCount: number,
): { code: string; status: 400 | 409; reason: string } | null {
  if (parent.engines.includes('endpoint-agent-eval'))
    return { code: 'RETEST_NOT_SUPPORTED', status: 400, reason: ENDPOINT_TASK_ENTRY_MESSAGE };
  if (parent.standardRun)
    return {
      code: 'RETEST_NOT_SUPPORTED',
      status: 400,
      reason: '标准专项任务请创建新的标准运行，不支持失败用例复测。',
    };
  if (parent.engines.includes(RETIRED_AIG_ENGINE))
    return {
      code: 'RETEST_NOT_SUPPORTED',
      status: 400,
      reason: '历史 AIG 任务仅供查看，不支持复测。',
    };
  if (parent.engines.includes('agent-fanout'))
    return {
      code: 'RETEST_NOT_SUPPORTED',
      status: 400,
      reason: '间接提示注入评估请在评估任务页重新发起。',
    };
  if (!RETEST_PARENT_STATUSES.includes(parent.status))
    return {
      code: 'RETEST_PARENT_NOT_FINISHED',
      status: 409,
      reason: '任务尚未结束，结束后才能重跑失败用例。',
    };
  if (failedQuestionCount === 0)
    return {
      code: 'RETEST_NO_FAILED_QUESTIONS',
      status: 409,
      reason: '本任务没有判定为失败或执行异常的用例。',
    };
  return null;
}

/** 父任务不能发起失败复测的原因（可发起时返回 null）；详情页按钮禁用提示与服务校验共用。 */
export function retestBlockReason(parent: ParentShape, failedQuestionCount: number): string | null {
  return retestBlock(parent, failedQuestionCount)?.reason ?? null;
}

async function failedQuestionIds(db: PrismaClient, taskId: string, setIds: string[]) {
  if (setIds.length === 0) return [];
  const rows = await db.evalResult.findMany({
    where: {
      taskId,
      finalVerdict: { in: [...RETEST_FAILED_VERDICTS] },
      question: { questionSetId: { in: setIds } },
    },
    select: { questionId: true },
    distinct: ['questionId'],
    orderBy: { questionId: 'asc' },
  });
  return rows.map((r) => r.questionId);
}

function blockError(parent: ParentShape, failedCount: number) {
  const block = retestBlock(parent, failedCount);
  if (!block) return null;
  return block.status === 409
    ? conflict(block.reason, block.code)
    : badRequest(block.reason, block.code);
}

/**
 * 只重跑失败用例：以父任务 FAIL + ERROR 的题目为显式题目清单新建任务，复制父任务参数快照
 * （对象/引擎/维度/并发/关联样本库），关联 parentTaskId、retestMode=FAILED_ONLY，入队并写审计。
 * 没有失败题时抛 409 RETEST_NO_FAILED_QUESTIONS，不建任务。
 */
export async function createFailedRetestTask(
  db: PrismaClient,
  parentTaskId: string,
  opts: CreateFailedRetestOptions,
): Promise<CreateFailedRetestResult> {
  const parent = await db.evalTask.findUnique({
    where: { id: parentTaskId },
    include: {
      questionSets: { select: { questionSetId: true } },
      standardRun: { select: { id: true } },
      modelTarget: { select: { targetType: true } },
    },
  });
  if (!parent) throw notFound('评估任务不存在', 'EVAL_TASK_NOT_FOUND');
  assertNonEndpointTaskTarget(parent.modelTarget);
  const setIds = parent.questionSets.map((s) => s.questionSetId);
  const questionIds = await failedQuestionIds(db, parent.id, setIds);

  if (opts.findingId) {
    const f = await db.finding.findUnique({
      where: { id: opts.findingId },
      select: { taskId: true, remediationStatus: true },
    });
    if (!f || f.taskId !== parent.id) {
      throw conflict('风险发现不属于该评估任务', 'RETEST_FINDING_SCOPE_MISMATCH');
    }
    if (f.remediationStatus === 'VERIFIED_CLOSED') {
      throw conflict('已验证关闭的整改项需先重新打开', 'REMEDIATION_CLOSED_IMMUTABLE');
    }
  }

  const err = blockError(parent, questionIds.length);
  if (err) throw err;

  const modelTargetId = opts.targetIdOverride ?? parent.modelTargetId;
  {
    const t = await db.modelTarget.findUnique({ where: { id: modelTargetId } });
    if (!t) throw badRequest('复测评估对象不存在', 'MODEL_TARGET_NOT_FOUND');
    assertNonEndpointTaskTarget(t);
    if (!t.isActive) throw badRequest('复测评估对象已禁用', 'MODEL_TARGET_INACTIVE');
    if (t.targetType === 'PLATFORM_APP' && !platformAppEnabled())
      throw forbidden('平台智能体测评功能未启用', 'PLATFORM_APP_DISABLED');
    if (t.targetType === 'GATEWAY_LOG' || t.targetType === 'JUDGE') {
      throw badRequest('该类评估对象不能用于主动评估', 'RETEST_TARGET_NOT_EXECUTABLE');
    }
  }

  const name = (opts.name?.trim() || `${parent.name}·失败用例复测`).slice(0, 200);
  const task = await db.$transaction(async (tx) => {
    const created = await tx.evalTask.create({
      data: {
        name,
        description: `复测父任务 ${parent.id} 中判定为失败或执行异常的 ${questionIds.length} 道用例。`,
        status: 'PENDING',
        modelTargetId,
        engines: parent.engines,
        dimensions: parent.dimensions,
        concurrency: parent.concurrency,
        totalQuestions: questionIds.length,
        sampleSize: null,
        sampleSeed: null,
        createdById: opts.actorId,
        parentTaskId: parent.id,
        retestMode: RETEST_MODE_FAILED_ONLY,
        questionSets: { create: setIds.map((questionSetId) => ({ questionSetId })) },
        pinnedQuestions: { create: questionIds.map((questionId) => ({ questionId })) },
      },
    });
    if (opts.findingId) {
      await tx.finding.update({
        where: { id: opts.findingId },
        data: { remediationRetestTaskId: created.id },
      });
    }
    return created;
  });

  await enqueueEvalTask(task.id);
  await writeAudit({
    actorId: opts.actorId,
    actorName: opts.actorName ?? null,
    action: 'eval_task.retest_failed',
    targetType: 'eval_task',
    targetId: task.id,
    detail: {
      parentTaskId: parent.id,
      questionCount: questionIds.length,
      modelTargetId,
      targetOverridden: Boolean(opts.targetIdOverride),
      findingId: opts.findingId ?? null,
    },
  });

  return {
    task: {
      id: task.id,
      name: task.name,
      status: task.status,
      modelTargetId: task.modelTargetId,
      parentTaskId: parent.id,
      retestMode: RETEST_MODE_FAILED_ONLY,
      totalQuestions: task.totalQuestions,
    },
    questionIds,
    findingId: opts.findingId ?? null,
  };
}

const VERDICT_RANK: Record<string, number> = { PASS: 0, UNKNOWN: 1, ERROR: 2, FAIL: 3 };

/** 同题多行结果（如对照组 A/B 侧）按最差判定合并为该题的复测判定。 */
function worstVerdictByQuestion(rows: Array<{ questionId: string; finalVerdict: string | null }>) {
  const map = new Map<string, string | null>();
  for (const r of rows) {
    const prev = map.get(r.questionId);
    const cur = r.finalVerdict;
    if (
      prev === undefined ||
      (VERDICT_RANK[cur ?? 'UNKNOWN'] ?? 1) > (VERDICT_RANK[prev ?? 'UNKNOWN'] ?? 1)
    )
      map.set(r.questionId, cur);
  }
  return map;
}

export interface RetestInfo {
  /** 本任务是失败复测任务时：按题目对齐父任务的复测结论；否则为 null。 */
  retestOf: {
    parentTaskId: string;
    parentTaskName: string | null;
    retestMode: string | null;
    total: number;
    fixed: number;
    stillFailing: number;
    notRetested: number;
    closureEligible: boolean;
    cases: Array<{ questionId: string; originalVerdict: string | null; verdict: string | null }>;
  } | null;
  /** 本任务中 FAIL + ERROR 的题数（可发起复测的用例数）。 */
  failedQuestionCount: number;
  /** 不能发起失败复测的原因；可发起时为 null。 */
  retestBlockedReason: string | null;
  /** 以本任务为父任务发起过的复测任务（新→旧）。 */
  retestTasks: Array<{ id: string; name: string; status: string; createdAt: Date }>;
}

export async function buildRetestInfo(db: PrismaClient, taskId: string): Promise<RetestInfo> {
  const task = await db.evalTask.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      id: true,
      status: true,
      engines: true,
      parentTaskId: true,
      createdById: true,
      retestMode: true,
      parentTask: { select: { name: true, createdById: true } },
      standardRun: { select: { id: true } },
      modelTarget: { select: { targetType: true } },
      questionSets: { select: { questionSetId: true } },
      pinnedQuestions: { select: { questionId: true } },
      retestTasks: {
        select: { id: true, name: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });
  const failed = await failedQuestionIds(
    db,
    task.id,
    task.questionSets.map((s) => s.questionSetId),
  );
  let retestOf: RetestInfo['retestOf'] = null;
  if (task.parentTaskId) {
    const pinned = task.pinnedQuestions.map((p) => p.questionId);
    const [parentRows, retestRows] = await Promise.all([
      db.evalResult.findMany({
        where: { taskId: task.parentTaskId },
        select: { questionId: true, finalVerdict: true, status: true },
      }),
      db.evalResult.findMany({
        where: { taskId: task.id, questionId: { in: pinned } },
        select: { questionId: true, finalVerdict: true, status: true },
      }),
    ]);
    const parentByQ = worstVerdictByQuestion(parentRows);
    const retestByQ = worstVerdictByQuestion(retestRows);
    // 按题目对齐：只统计父任务中确为 FAIL/ERROR 的冻结题。
    const aligned = [...parentByQ.keys()].filter((id) => {
      const v = parentByQ.get(id);
      return v === 'FAIL' || v === 'ERROR';
    });
    const summary = summarizeRetest(
      aligned.map((id) => ({ verdict: parentByQ.get(id) ?? null })),
      aligned.map((id) => ({ verdict: retestByQ.get(id) ?? null })),
    );
    const notRetested = aligned.filter((id) => !retestByQ.has(id)).length;
    const stillFailing = aligned.filter((id) => {
      const v = retestByQ.get(id);
      return v === 'FAIL' || v === 'ERROR';
    }).length;
    retestOf = {
      parentTaskId: task.parentTaskId,
      parentTaskName: task.parentTask?.name ?? null,
      retestMode: task.retestMode,
      total: summary.total,
      fixed: summary.fixed,
      stillFailing,
      notRetested,
      closureEligible: task.status === 'COMPLETED' && task.retestMode === RETEST_MODE_FAILED_ONLY &&
        Boolean(task.createdById) && task.createdById === task.parentTask?.createdById && aligned.length > 0 &&
        aligned.every(id => pinned.includes(id) && retestByQ.get(id) === 'PASS') &&
        retestRows.every(row => row.status === 'SUCCESS' && row.finalVerdict === 'PASS'),
      cases: aligned.map(questionId => ({ questionId, originalVerdict: parentByQ.get(questionId) ?? null,
        verdict: retestByQ.get(questionId) ?? null })),
    };
  }
  return {
    retestOf,
    failedQuestionCount: failed.length,
    retestBlockedReason: retestBlockReason(task, failed.length),
    retestTasks: task.retestTasks,
  };
}
