import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { currentTenantScope } from '../../lib/tenant-context.js';
import { visibleWhere as keywordVisibleWhere } from '../keyword-library/service.js';
import { kindWhere } from '../question-sets/kind.js';
import { LIVE_BUILTIN_SET, inactiveQuestionSql } from '../question-sets/builtin/live.js';

/** 规则库里的题集：在用的种子库 + 自有样本库；评估任务运行时落库的运行记录不算。 */
const LIBRARY_SET: Prisma.QuestionSetWhereInput = { OR: [LIVE_BUILTIN_SET, kindWhere('own')] };

export interface RuleLibraryStats {
  questionSets: number;
  questions: number;
  keywords: number;
  agentSamples: number;
}

/**
 * 首页「规则库」统计（2.2.1）。题集、智能体样本走租户查询扩展：本租户的 + 平台共享（内置库算平台的）。
 * 题目数扣掉内置库里已下线或尚未生效（自动更新进行中）的题，与内置题库统计一致；关键词只算生效的（候选、停用、已剔除的不算）。
 */
async function computeRuleLibraryStats(): Promise<RuleLibraryStats> {
  const [sets, keywords, agentSamples] = await Promise.all([
    prisma.questionSet.findMany({ where: LIBRARY_SET, select: { id: true, isBuiltin: true } }),
    prisma.standardKeyword.count({
      where: { ...keywordVisibleWhere(), reviewStatus: 'approved' },
    }),
    prisma.agentSample.count(),
  ]);
  if (sets.length === 0) return { questionSets: 0, questions: 0, keywords, agentSamples };
  // 原始 SQL 不经过租户扩展：题集 id 已是上面按租户范围查出来的，题目再照扩展的口径限定一次租户。
  const tenantId = currentTenantScope()?.tenantId;
  const tenant = tenantId
    ? Prisma.sql`AND (q."tenantId" IS NULL OR q."tenantId" = ${tenantId})`
    : Prisma.empty;
  const builtinIds = sets.filter((s) => s.isBuiltin).map((s) => s.id);
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT (count(*) FILTER (
      WHERE NOT (q."questionSetId" = ANY(${builtinIds}::text[]) AND ${inactiveQuestionSql('q')})
    ))::int AS n
    FROM "questions" q
    WHERE q."questionSetId" = ANY(${sets.map((s) => s.id)}::text[]) ${tenant}`;
  return { questionSets: sets.length, questions: rows[0]?.n ?? 0, keywords, agentSamples };
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expires: number; value: Promise<RuleLibraryStats> }>();

/** 清掉缓存（测试用；数据变化后要立即看到新数时也可调用）。 */
export function clearRuleLibraryCache(): void {
  cache.clear();
}

/**
 * 按租户范围缓存 60 秒：规则库题量大（十万级），统计不随统计周期变化，没必要每次刷新首页都重算。
 * 键是当前租户；全部租户视角与系统范围都不按租户过滤，共用一份。
 */
export function ruleLibraryStats(now = Date.now()): Promise<RuleLibraryStats> {
  const key = currentTenantScope()?.tenantId ?? '*';
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  const value = computeRuleLibraryStats();
  cache.set(key, { expires: now + CACHE_TTL_MS, value });
  // 失败的结果不缓存，下次重算。
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}
