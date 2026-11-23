import type { RiskDomain } from '@lse/shared';
import { resolveReportRiskDomain } from './labels.js';
import type { BuiltReport, ReportEvalResult, RiskItemSeverityGroup } from './report-builder.js';
import { selectPrimaryReportResults } from './report-primary-results.js';

/**
 * 每个风险域的已判定测试题数（通过 + 发现风险），供报告按风险类别计算发现率。
 *
 * - 发现风险：取风险项明细里各项的风险域，与结果页热力图、发现清单同一口径；
 * - 通过：按题目自身类别归入风险域；
 * - 执行异常、无法判定的题目不计入「已判定」。
 * 分子（该域发现数）因此恒不大于分母，发现率不会超过 100%。
 * 没有可用结果时返回 undefined，报告回退为按评估模块展示。
 */
export function buildRiskDomainTested(
  results: ReportEvalResult[] | undefined,
  groups: RiskItemSeverityGroup[],
): Record<string, number> | undefined {
  if (!results) return undefined;
  const tested = new Map<RiskDomain, number>();
  for (const group of groups) {
    for (const item of group.items) {
      tested.set(item.riskDomain, (tested.get(item.riskDomain) ?? 0) + 1);
    }
  }
  for (const result of results) {
    if (result.finalVerdict !== 'PASS') continue;
    const domain = resolveReportRiskDomain({
      riskCategory: result.question.category ?? undefined,
      questionContent: result.question.content,
    });
    tested.set(domain, (tested.get(domain) ?? 0) + 1);
  }
  if (tested.size === 0) return undefined;
  return Object.fromEntries([...tested.entries()].sort((a, b) => b[1] - a[1]));
}

/** 懒计算只读取这几列：一次查询取回任务的全部结果，不逐题查询。 */
export interface LazyResultRow {
  finalVerdict: string | null;
  side: string | null;
  controlGroupId: string | null;
  question: { category: string | null; content: string };
}

export interface LazyResultDb {
  evalResult: {
    findMany(args: {
      where: { taskId: string };
      select: {
        finalVerdict: true;
        side: true;
        controlGroupId: true;
        question: { select: { category: true; content: true } };
      };
    }): Promise<LazyResultRow[]>;
  };
}

interface Warnable {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * 存量报告的快照没有 summary.riskDomainTested：下载/渲染时按与生成时相同的口径懒计算，
 * 仅用于本次渲染——返回新对象，不修改已冻结的快照，也不改变快照里的任何其他数字。
 * - 发现数：取快照里风险项明细（与生成时同源）；
 * - 通过数：任务结果按「主评估结果」口径去重（红队同对照组优先 B）后，通过题按题目类别归域；
 * - 任务结果已被删除、查询失败或没有可计数的内容时，原样返回（回退为按模块发现率），绝不抛错。
 */
export async function withLazyRiskDomainTested(
  db: LazyResultDb,
  built: BuiltReport,
  taskId: string | null | undefined,
  log?: Warnable,
): Promise<BuiltReport> {
  try {
    if (!taskId || built.summary.riskDomainTested) return built;
    const groups = built.summary.riskItemsBySeverity;
    if (!Array.isArray(groups) || groups.length === 0) return built;
    const rows = await db.evalResult.findMany({
      where: { taskId },
      select: {
        finalVerdict: true,
        side: true,
        controlGroupId: true,
        question: { select: { category: true, content: true } },
      },
    });
    if (rows.length === 0) return built;
    const results = selectPrimaryReportResults(rows).map(
      (row) =>
        ({
          finalVerdict: row.finalVerdict,
          status: '',
          side: row.side,
          controlGroupId: row.controlGroupId,
          question: row.question,
        }) as unknown as ReportEvalResult,
    );
    const riskDomainTested = buildRiskDomainTested(results, groups);
    if (!riskDomainTested) return built;
    return { ...built, summary: { ...built.summary, riskDomainTested } };
  } catch (err) {
    log?.warn({ err, taskId }, 'lazy riskDomainTested failed; falling back to module rates');
    return built;
  }
}
