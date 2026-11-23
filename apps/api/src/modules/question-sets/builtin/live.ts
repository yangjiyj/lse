// 内置题库「在用」口径：/question-sets/builtin/stats 与首页规则库统计共用，避免两处漂移。
import { Prisma } from '@prisma/client';
import { RETIRED_BUILTIN_SET_SOURCES } from '@lse/shared';
import { prisma } from '../../../db.js';

/** 仍在用的内置库：已下线的（信通院、能源行业）不算。 */
export const LIVE_BUILTIN_SET: Prisma.QuestionSetWhereInput = {
  isBuiltin: true,
  OR: [{ source: null }, { source: { notIn: [...RETIRED_BUILTIN_SET_SOURCES] } }],
};

/**
 * 题目不在用的 SQL 条件：按版本对齐下线（metadata.retired）或自动更新进行中、尚未生效
 * （metadata.pendingVersion），与 bank-meta.ts 的 isInactiveQuestion 同口径。结果不会是 NULL。
 * alias 是 SQL 里 questions 表的别名，只传代码里的常量。
 */
export function inactiveQuestionSql(alias = 'q'): Prisma.Sql {
  const metadata = Prisma.raw(`${alias}."metadata"`);
  return Prisma.sql`(COALESCE(${metadata}->>'retired', 'false') = 'true' OR (${metadata}->>'pendingVersion') IS NOT NULL)`;
}

/** 指定题集里不在用的题数。原始 SQL 不经过租户扩展，调用方传入的题集 id 须已按租户范围查出。 */
export async function countInactiveQuestions(setIds: readonly string[]): Promise<number> {
  if (setIds.length === 0) return 0;
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "questions" q
    WHERE q."questionSetId" = ANY(${[...setIds]}::text[]) AND ${inactiveQuestionSql('q')}`;
  return rows[0]?.n ?? 0;
}
