import type { PrismaClient } from '@prisma/client';
import { computePassRate } from '@lse/shared';
import { badRequest, notFound } from '../../lib/errors.js';
import { compareTaskFailRates, statisticsFromTaskRow } from '../../lib/eval-statistics.js';
import { weightedScoresByTask } from '../../lib/weighted-score.js';

export interface RegressionResultRow {
  questionId: string;
  category: string | null;
  verdict: string | null;
}

export interface RegressionItem {
  questionId: string;
  category: string;
  baseVerdict: string | null;
  headVerdict: string | null;
}

export interface RegressionCategory {
  category: string;
  aligned: number;
  basePassRate: number | null;
  headPassRate: number | null;
  passRateDelta: number | null;
  newlyFailed: number;
  fixed: number;
  stillFailing: number;
}

const FAILING = new Set(['FAIL', 'ERROR']);
/** 同题多条结果（多轮红队、A/B 对照）取最严重判定。 */
const SEVERITY: Record<string, number> = { FAIL: 3, ERROR: 2, UNKNOWN: 1, PASS: 0 };
const rank = (v: string | null) => SEVERITY[v ?? 'UNKNOWN'] ?? 1;

function collapse(rows: RegressionResultRow[]): Map<string, RegressionResultRow> {
  const map = new Map<string, RegressionResultRow>();
  for (const row of rows) {
    const prev = map.get(row.questionId);
    if (!prev || rank(row.verdict) > rank(prev.verdict)) map.set(row.questionId, row);
  }
  return map;
}

/** 通过率口径与 computePassRate 一致：PASS/(PASS+FAIL)，ERROR/UNKNOWN 不计入分母。 */
function rate(verdicts: Array<string | null>): number | null {
  return computePassRate(
    verdicts.filter((v) => v === 'PASS').length,
    verdicts.filter((v) => v === 'FAIL').length,
  );
}

interface Bucket {
  base: Array<string | null>;
  head: Array<string | null>;
  newlyFailed: number;
  fixed: number;
  stillFailing: number;
}

/** 按题目对齐两次运行：基线(base) → 本次(head)。失败口径 = FAIL 或 ERROR。 */
export function alignRegression(base: RegressionResultRow[], head: RegressionResultRow[]) {
  const b = collapse(base);
  const h = collapse(head);
  const newlyFailed: RegressionItem[] = [];
  const fixed: RegressionItem[] = [];
  const stillFailing: RegressionItem[] = [];
  const buckets = new Map<string, Bucket>();
  let aligned = 0;
  for (const [questionId, hr] of h) {
    const br = b.get(questionId);
    if (!br) continue;
    aligned += 1;
    const category = hr.category || br.category || '未分类';
    const bucket = buckets.get(category) ?? {
      base: [],
      head: [],
      newlyFailed: 0,
      fixed: 0,
      stillFailing: 0,
    };
    bucket.base.push(br.verdict);
    bucket.head.push(hr.verdict);
    const item = { questionId, category, baseVerdict: br.verdict, headVerdict: hr.verdict };
    const wasFail = FAILING.has(br.verdict ?? '');
    const isFail = FAILING.has(hr.verdict ?? '');
    if (!wasFail && isFail) {
      newlyFailed.push(item);
      bucket.newlyFailed += 1;
    } else if (wasFail && hr.verdict === 'PASS') {
      fixed.push(item);
      bucket.fixed += 1;
    } else if (wasFail && isFail) {
      stillFailing.push(item);
      bucket.stillFailing += 1;
    }
    buckets.set(category, bucket);
  }
  const categories: RegressionCategory[] = [...buckets.entries()]
    .map(([category, v]) => {
      const basePassRate = rate(v.base);
      const headPassRate = rate(v.head);
      return {
        category,
        aligned: v.base.length,
        basePassRate,
        headPassRate,
        passRateDelta:
          basePassRate === null || headPassRate === null ? null : headPassRate - basePassRate,
        newlyFailed: v.newlyFailed,
        fixed: v.fixed,
        stillFailing: v.stillFailing,
      };
    })
    .sort((x, y) => x.category.localeCompare(y.category, 'zh-CN'));
  const sortItems = (list: RegressionItem[]) =>
    list.sort(
      (x, y) =>
        x.category.localeCompare(y.category, 'zh-CN') || x.questionId.localeCompare(y.questionId),
    );
  return {
    newlyFailed: sortItems(newlyFailed),
    fixed: sortItems(fixed),
    stillFailing: sortItems(stillFailing),
    categories,
    summary: {
      aligned,
      onlyInBase: [...b.keys()].filter((id) => !h.has(id)).length,
      onlyInHead: [...h.keys()].filter((id) => !b.has(id)).length,
    },
  };
}

/** 每类明细列表返回上限；summary 中给出完整计数。 */
export const REGRESSION_ITEM_LIMIT = 500;

const taskSelect = {
  id: true,
  name: true,
  status: true,
  planId: true,
  createdAt: true,
  finishedAt: true,
  passedCount: true,
  failedCount: true,
  errorCount: true,
  processedQuestions: true,
  modelTarget: { select: { id: true, name: true } },
} as const;

export interface RegressionQuery {
  planId?: string;
  baseTaskId?: string;
  headTaskId?: string;
}

/** 解析对比对象：base+head 任选两任务；否则 planId → 本次（默认最新或 headTaskId）与其前一次。 */
async function resolvePair(db: PrismaClient, q: RegressionQuery) {
  if (q.baseTaskId && q.headTaskId) {
    if (q.baseTaskId === q.headTaskId) {
      throw badRequest('请选择两个不同的任务', 'REGRESSION_SAME_TASK');
    }
    const [base, head] = await Promise.all([
      db.evalTask.findUnique({ where: { id: q.baseTaskId }, select: taskSelect }),
      db.evalTask.findUnique({ where: { id: q.headTaskId }, select: taskSelect }),
    ]);
    if (!base || !head) throw notFound('对比任务不存在');
    return { base, head };
  }
  if (q.planId) {
    const plan = await db.evalPlan.count({ where: { id: q.planId } });
    if (!plan) throw notFound('评估计划不存在');
    const tasks = await db.evalTask.findMany({
      where: { planId: q.planId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: taskSelect,
      take: 500,
    });
    let headIndex = 0;
    if (q.headTaskId) {
      headIndex = tasks.findIndex((t) => t.id === q.headTaskId);
      if (headIndex < 0) throw notFound('该计划下不存在指定运行');
    }
    const head = tasks[headIndex];
    const base = tasks[headIndex + 1];
    if (!head || !base) {
      throw badRequest('该计划运行次数不足两次，暂无可对比的相邻运行', 'REGRESSION_NOT_ENOUGH_RUNS');
    }
    return { base, head };
  }
  throw badRequest(
    '请指定 planId，或同时指定 baseTaskId 与 headTaskId',
    'REGRESSION_PAIR_REQUIRED',
  );
}

type TaskRow = Awaited<ReturnType<typeof resolvePair>>['base'];

function serializeTask(t: TaskRow, score: number | null | undefined) {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    planId: t.planId,
    modelName: t.modelTarget?.name ?? '—',
    createdAt: t.createdAt.toISOString(),
    finishedAt: t.finishedAt?.toISOString() ?? null,
    passedCount: t.passedCount,
    failedCount: t.failedCount,
    errorCount: t.errorCount,
    passRate: computePassRate(t.passedCount, t.failedCount),
    evalScore: score ?? null,
    statistics: statisticsFromTaskRow(t),
  };
}

/** 回归对比：按题目对齐两次任务，输出新增失败/已修复/仍失败/分数变化/各类别变化。 */
export async function compareRegression(db: PrismaClient, q: RegressionQuery) {
  const { base, head } = await resolvePair(db, q);
  const load = (taskId: string) =>
    db.evalResult.findMany({
      where: { taskId },
      select: { questionId: true, finalVerdict: true, question: { select: { category: true } } },
    });
  const [baseRows, headRows, scores] = await Promise.all([
    load(base.id),
    load(head.id),
    weightedScoresByTask([base.id, head.id]),
  ]);
  const toRow = (r: Awaited<ReturnType<typeof load>>[number]): RegressionResultRow => ({
    questionId: r.questionId,
    category: r.question?.category ?? null,
    verdict: r.finalVerdict,
  });
  const aligned = alignRegression(baseRows.map(toRow), headRows.map(toRow));
  const pick = (list: RegressionItem[]) => list.slice(0, REGRESSION_ITEM_LIMIT);
  const shownIds = [aligned.newlyFailed, aligned.fixed, aligned.stillFailing].flatMap((l) =>
    pick(l).map((i) => i.questionId),
  );
  const questions = await db.question.findMany({
    where: { id: { in: shownIds } },
    select: { id: true, externalId: true, content: true, severity: true },
  });
  const qmap = new Map(questions.map((x) => [x.id, x]));
  const enrich = (list: RegressionItem[]) =>
    pick(list).map((i) => ({
      ...i,
      externalId: qmap.get(i.questionId)?.externalId ?? null,
      content: qmap.get(i.questionId)?.content ?? '',
      severity: qmap.get(i.questionId)?.severity ?? null,
    }));
  const baseTask = serializeTask(base, scores.get(base.id));
  const headTask = serializeTask(head, scores.get(head.id));
  return {
    base: baseTask,
    head: headTask,
    newlyFailed: enrich(aligned.newlyFailed),
    fixed: enrich(aligned.fixed),
    stillFailing: enrich(aligned.stillFailing),
    categories: aligned.categories,
    summary: {
      ...aligned.summary,
      newlyFailed: aligned.newlyFailed.length,
      fixed: aligned.fixed.length,
      stillFailing: aligned.stillFailing.length,
      itemLimit: REGRESSION_ITEM_LIMIT,
      scoreDelta:
        baseTask.evalScore === null || headTask.evalScore === null
          ? null
          : Math.round((headTask.evalScore - baseTask.evalScore) * 10) / 10,
      passRateDelta:
        baseTask.passRate === null || headTask.passRate === null
          ? null
          : headTask.passRate - baseTask.passRate,
      failRateDifference: compareTaskFailRates(baseTask.statistics, headTask.statistics),
    },
  };
}
