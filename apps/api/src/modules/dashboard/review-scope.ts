import type { FindingReviewStatus, Prisma } from '@prisma/client';

/**
 * 「待复核」的唯一口径：首页「待复核」卡、我的待办合计、风险处置台的待复核列表都从这里取条件，
 * 三处数字必然一致。
 *
 * - 状态：未复核（UNREVIEWED）+ 待人工复核（NEEDS_REVIEW）。
 * - 排除来自没有真正执行的任务的条目：失败、已取消（终端测评被驳回、过期时任务也会落成失败/已取消，
 *   根本没有执行样本，其风险项不是可复核的结论）。
 */
export const PENDING_REVIEW_STATUSES: readonly FindingReviewStatus[] = [
  'UNREVIEWED',
  'NEEDS_REVIEW',
];

export const NON_EXECUTED_TASK_STATUSES = ['FAILED', 'CANCELED'] as const;

export function isPendingReviewStatus(status: FindingReviewStatus): boolean {
  return PENDING_REVIEW_STATUSES.includes(status);
}

/** 任务确实执行过：限定任务状态，并可再叠加调用方自己的任务条件（如统计周期）。 */
function executedTaskWhere(extra?: Prisma.EvalTaskWhereInput): Prisma.EvalTaskWhereInput {
  const base: Prisma.EvalTaskWhereInput = {
    status: { notIn: [...NON_EXECUTED_TASK_STATUSES] },
  };
  return extra ? { AND: [base, extra] } : base;
}

/** 待复核风险项的 Prisma 条件。taskWhere 可限定任务范围（如首页所选周期）。 */
export function pendingReviewFindingWhere(
  taskWhere?: Prisma.EvalTaskWhereInput,
): Prisma.FindingWhereInput {
  return {
    reviewStatus: { in: [...PENDING_REVIEW_STATUSES] },
    task: executedTaskWhere(taskWhere),
  };
}

/**
 * 按复核状态筛选风险项（风险处置台的「复核状态」筛选）。
 * 其中属于待复核的状态沿用上面的「任务已执行」限定，其余状态（已确认、误报等）不加限定。
 */
export function reviewStatusFindingWhere(
  statuses: readonly FindingReviewStatus[],
): Prisma.FindingWhereInput {
  const pending = statuses.filter(isPendingReviewStatus);
  const others = statuses.filter((s) => !isPendingReviewStatus(s));
  const branches: Prisma.FindingWhereInput[] = [];
  if (pending.length > 0) {
    branches.push({ reviewStatus: { in: pending }, task: executedTaskWhere() });
  }
  if (others.length > 0) branches.push({ reviewStatus: { in: others } });
  if (branches.length === 0) return {};
  return branches.length === 1 ? branches[0]! : { OR: branches };
}
