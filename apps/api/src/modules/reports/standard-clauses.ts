/**
 * 评估结果 → 标准条款观察值（packages/shared/src/standards）。
 *
 * 归条款的优先级：
 * 1. 题目元数据里显式写的 clauseIds（各测评线新样本应当写，见 docs/standards/README.md）；
 * 2. 题目类别是附录 A 小项编号（A.1.a … A.5.b）→ 对应 31 项之一；
 * 3. 题目类别归一到风险域：智能体行为类风险域经危害后果落到智能体 8 项要求；
 *    内容类风险域只能落到附录 A 大类（不能推到某一小项），单独汇总为 annexMajors。
 * 通过、发现风险计入有效判定；无法判定、执行异常计入 invalid。
 */
import {
  CONTENT_DOMAIN_TO_ANNEX_MAJOR,
  annexAClauseId,
  clausesForAgentHarm,
  getClause,
  legacyRiskDomainHarms,
  outcomeLabelFromVerdictOnly,
  type ClauseObservation,
  type ClauseVerdict,
  type EvalLine,
} from '@lse/shared';
import { resolveReportRiskDomain } from './labels.js';
import { selectPrimaryReportResults } from './report-primary-results.js';

export interface StandardClauseResultInput {
  finalVerdict: string | null;
  /** 模型或智能体的回答，取证据摘要用；没有则不出摘要。 */
  response?: string | null;
  /** 统一结局的中文标签（识破、被拦截（产品拦截）、照做、无效…）；没有时按最终判定给保守说法。 */
  outcomeLabel?: string | null;
  question: {
    category: string | null;
    content?: string;
    displayTitle?: string | null;
    clauseIds?: readonly string[] | null;
  };
}

/** 条款下的代表性证据样本：样本名、结局、证据摘要。 */
export interface ClauseEvidenceSample {
  sampleName: string;
  outcomeLabel: string;
  summary: string;
  failed: boolean;
}

/**
 * 人工填报的条款结论（接口约定）：由内容线方法车道的填报表单提供数据，
 * 报告层只按条款编号和结论合并进观察值（manualVerdict），不另建表。
 */
export interface ManualClauseFill {
  clauseId: string;
  verdict: Extract<ClauseVerdict, 'conform' | 'nonconform' | 'not_applicable'>;
  note?: string;
}

export interface AnnexMajorTally {
  tested: number;
  failed: number;
  invalid: number;
}

export interface StandardClauseSnapshot {
  lines: EvalLine[];
  observations: ClauseObservation[];
  /** 附录 A 五大类汇总（含只能归到大类的题）。只有内容线才有。 */
  annexMajors?: Record<string, AnnexMajorTally>;
  /** 智能体线、终端线：每项要求最多 3 条代表性证据样本（不合格的优先）。 */
  evidence?: Record<string, ClauseEvidenceSample[]>;
  /** 人工填报的结论说明（结论本身已合并进 observations 的 manualVerdict）。 */
  manualNotes?: Record<string, string>;
}

const MAX_EVIDENCE_PER_CLAUSE = 3;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const ANNEX_ITEM = /^A\.[1-5]\.[a-i]$/;

function clauseIdsForResult(r: StandardClauseResultInput, lines: readonly EvalLine[]): {
  clauseIds: string[];
  annexMajors: string[];
} {
  const explicit = (r.question.clauseIds ?? []).filter((id) => getClause(id));
  if (explicit.length) {
    const majors = explicit
      .map((id) => id.match(/^gbt45654\.(A\.[1-5])\.[a-i]$/)?.[1])
      .filter((x): x is string => Boolean(x));
    return { clauseIds: explicit, annexMajors: [...new Set(majors)] };
  }
  const category = r.question.category?.trim() ?? '';
  if (ANNEX_ITEM.test(category)) {
    const id = annexAClauseId(category);
    return { clauseIds: id ? [id] : [], annexMajors: [category.slice(0, 3)] };
  }
  const domain = resolveReportRiskDomain({
    riskCategory: category || undefined,
    questionContent: r.question.content ?? '',
  });
  const clauseIds: string[] = [];
  if (lines.includes('agent') || lines.includes('endpoint')) {
    const line = lines.includes('endpoint') ? 'endpoint' : 'agent';
    for (const harm of legacyRiskDomainHarms(domain)) clauseIds.push(...clausesForAgentHarm(harm, line));
  }
  const annexMajors = lines.includes('content') ? [...(CONTENT_DOMAIN_TO_ANNEX_MAJOR[domain] ?? [])] : [];
  return { clauseIds: [...new Set(clauseIds)], annexMajors };
}

export function buildStandardClauseSnapshot(
  results: readonly StandardClauseResultInput[] | undefined,
  lines: readonly EvalLine[],
  manualFills: readonly ManualClauseFill[] = [],
): StandardClauseSnapshot | undefined {
  if (!results || lines.length === 0) return undefined;
  const evidence: Record<string, ClauseEvidenceSample[]> = {};
  const wantEvidence = lines.includes('agent') || lines.includes('endpoint');
  const obs = new Map<string, ClauseObservation>();
  const majors: Record<string, AnnexMajorTally> = {};
  for (const r of results) {
    const valid = r.finalVerdict === 'PASS' || r.finalVerdict === 'FAIL';
    const failed = r.finalVerdict === 'FAIL';
    const { clauseIds, annexMajors } = clauseIdsForResult(r, lines);
    for (const id of clauseIds) {
      const clause = getClause(id);
      if (!clause || !clause.lines.some((l) => lines.includes(l))) continue;
      const o = obs.get(id) ?? { clauseId: id, tested: 0, failed: 0, invalid: 0 };
      if (valid) o.tested += 1;
      else o.invalid = (o.invalid ?? 0) + 1;
      if (failed) o.failed += 1;
      obs.set(id, o);
      if (wantEvidence && valid && clause.lines.some((l) => l !== 'content')) {
        const list = (evidence[id] ??= []);
        const sample: ClauseEvidenceSample = {
          sampleName: clip(r.question.displayTitle || r.question.content || '未命名样本', 60),
          outcomeLabel: r.outcomeLabel || outcomeLabelFromVerdictOnly(r.finalVerdict),
          summary: r.response ? clip(r.response, 120) : '无回答文本记录',
          failed,
        };
        // 不合格的优先；同类里先到先得，最多 3 条。
        if (list.length < MAX_EVIDENCE_PER_CLAUSE) list.push(sample);
        else if (failed) {
          const passIdx = list.findIndex((x) => !x.failed);
          if (passIdx >= 0) list[passIdx] = sample;
        }
      }
    }
    for (const m of annexMajors) {
      const t = (majors[m] ??= { tested: 0, failed: 0, invalid: 0 });
      if (valid) t.tested += 1;
      else t.invalid += 1;
      if (failed) t.failed += 1;
    }
  }
  const manualNotes: Record<string, string> = {};
  for (const fill of manualFills) {
    const clause = getClause(fill.clauseId);
    if (!clause || !clause.lines.some((l) => lines.includes(l))) continue;
    const o = obs.get(fill.clauseId) ?? { clauseId: fill.clauseId, tested: 0, failed: 0, invalid: 0 };
    o.manualVerdict = fill.verdict;
    obs.set(fill.clauseId, o);
    if (fill.note) manualNotes[fill.clauseId] = clip(fill.note, 200);
  }
  return {
    lines: [...lines],
    observations: [...obs.values()],
    ...(lines.includes('content') ? { annexMajors: majors } : {}),
    ...(Object.keys(evidence).length ? { evidence } : {}),
    ...(Object.keys(manualNotes).length ? { manualNotes } : {}),
  };
}

/** 懒计算只读取这几列。 */
interface LazyClauseDb {
  evalResult: {
    findMany(args: {
      where: { taskId: string };
      select: {
        finalVerdict: true;
        response: true;
        side: true;
        controlGroupId: true;
        question: { select: { category: true; content: true; metadata: true } };
      };
    }): Promise<
      Array<{
        finalVerdict: string | null;
        response: string | null;
        side: string | null;
        controlGroupId: string | null;
        question: { category: string | null; content: string; metadata: unknown };
      }>
    >;
  };
}

/** 题目元数据里的一句话样本标题（智能体样本才有）。 */
function displayTitleFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const v = (metadata as { displayTitle?: unknown }).displayTitle;
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** 题目元数据里显式写的条款编号。 */
export function clauseIdsFromMetadata(metadata: unknown): string[] | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = (metadata as { clauseIds?: unknown }).clauseIds;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : undefined;
}

/**
 * 存量报告快照没有 standardClauses：下载时按任务结果懒算，只用于本次渲染，不改快照；失败原样返回。
 */
export async function withLazyStandardClauses<
  T extends { summary: { standardClauses?: StandardClauseSnapshot } },
>(
  db: LazyClauseDb,
  built: T,
  taskId: string | null | undefined,
  lines: readonly EvalLine[],
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<T> {
  try {
    if (!taskId || built.summary.standardClauses || lines.length === 0) return built;
    const rows = await db.evalResult.findMany({
      where: { taskId },
      select: {
        finalVerdict: true,
        response: true,
        side: true,
        controlGroupId: true,
        question: { select: { category: true, content: true, metadata: true } },
      },
    });
    if (rows.length === 0) return built;
    const primary = selectPrimaryReportResults(rows);
    const snapshot = buildStandardClauseSnapshot(
      primary.map((r) => ({
        finalVerdict: r.finalVerdict,
        response: r.response,
        question: {
          category: r.question.category,
          content: r.question.content,
          displayTitle: displayTitleFromMetadata(r.question.metadata) ?? null,
          clauseIds: clauseIdsFromMetadata(r.question.metadata) ?? null,
        },
      })),
      lines,
    );
    if (!snapshot) return built;
    return { ...built, summary: { ...built.summary, standardClauses: snapshot } };
  } catch (err) {
    log?.warn({ err, taskId }, 'lazy standardClauses failed');
    return built;
  }
}
