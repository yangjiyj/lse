import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, type AppError } from '../../lib/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** 建任务前取到的样本库摘要。 */
export interface UsableQuestionSet {
  id: string;
  name: string;
  enabled: boolean;
  questionCount: number;
}

export interface QuestionSetCheck {
  sets: UsableQuestionSet[];
  /** 不存在或当前租户看不到的样本库 ID。 */
  missing: string[];
  disabled: UsableQuestionSet[];
}

/**
 * 按 ID 取样本库并检查能否用来建任务：存在、当前租户可见、已启用。
 * 租户可见由查询扩展按当前请求（或计划调度时的 runInTenant）的租户范围过滤，
 * 所以这里必须在请求处理函数或租户范围内调用。已有任务不经过这里，不受禁用影响。
 */
export async function checkQuestionSets(db: Db, ids: readonly string[]): Promise<QuestionSetCheck> {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await db.questionSet.findMany({
        where: { id: { in: unique } },
        select: { id: true, name: true, enabled: true, _count: { select: { questions: true } } },
      })
    : [];
  const sets = rows.map((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    questionCount: s._count.questions,
  }));
  const found = new Set(sets.map((s) => s.id));
  return {
    sets,
    missing: unique.filter((id) => !found.has(id)),
    disabled: sets.filter((s) => !s.enabled),
  };
}

export function questionSetDisabledError(
  disabled: ReadonlyArray<{ id: string; name: string }>,
): AppError {
  return badRequest(
    `样本库「${disabled.map((s) => s.name).join('」「')}」已禁用，请重新选择`,
    'QUESTION_SET_DISABLED',
    { ids: disabled.map((s) => s.id) },
  );
}

/** 建任务、建评估计划时用到的样本库都必须是启用的。 */
export function assertQuestionSetsEnabled(
  sets: ReadonlyArray<{ id: string; name: string; enabled: boolean }>,
): void {
  const disabled = sets.filter((s) => !s.enabled);
  if (disabled.length > 0) throw questionSetDisabledError(disabled);
}

/**
 * 建任务入口统一用：样本库都要存在（当前租户可见）且已启用，否则 400。
 * notFound 给各入口保留原有的错误码和提示。
 */
export async function loadEnabledQuestionSets(
  db: Db,
  ids: readonly string[],
  notFound: (missing: string[]) => AppError = (missing) =>
    badRequest('部分所选样本库不存在，请刷新后重新选择。', 'QUESTION_SET_NOT_FOUND', { missing }),
): Promise<UsableQuestionSet[]> {
  const check = await checkQuestionSets(db, ids);
  if (check.missing.length > 0) throw notFound(check.missing);
  if (check.disabled.length > 0) throw questionSetDisabledError(check.disabled);
  return check.sets;
}
