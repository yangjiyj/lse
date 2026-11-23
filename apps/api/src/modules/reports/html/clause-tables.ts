/**
 * 报告「标准条款对照」章节的数据：按测评线把条款观察值折成结论行。
 * 只展示主表里存在的条款；测过的逐条列出，没测的按原因合并成一句，不平铺长表。
 */
import {
  ANNEX_A_MAJORS,
  CLAUSE_CAPABILITY_LABELS,
  EVAL_LINE_LABELS,
  LINE_BASIS_STATEMENT,
  clauseCitation,
  evaluateLine,
  type ClauseResult,
  type EvalLine,
} from '@lse/shared';
import type { ClauseEvidenceSample, StandardClauseSnapshot } from '../standard-clauses.js';

export interface ClauseTableRow {
  citation: string;
  title: string;
  verdict: ClauseResult['verdict'];
  label: string;
  tested: number;
  failed: number;
  invalid: number;
  note: string;
  /** 代表性证据样本（智能体线，最多 3 条）。 */
  evidence?: ClauseEvidenceSample[];
}

export interface ClauseTableGroup {
  /** 分组名，例如「附录 A 风险类别」「附录 B 评估方法」「安全措施要求」。 */
  name: string;
  rows: ClauseTableRow[];
  /** 未测、不适用的条款合并成的说明（每种原因一句）。 */
  untested: string[];
}

export interface ClauseTable {
  line: EvalLine;
  lineLabel: string;
  statement: string;
  /** 附录 A 五大类汇总（只有内容线）。 */
  annexMajors?: Array<{ code: string; name: string; tested: number; failed: number; invalid: number; label: string }>;
  groups: ClauseTableGroup[];
  counts: { total: number; tested: number; nonconform: number };
}

/** 未测条款的说明：区分「需人工填报」与「平台暂不覆盖」，不笼统写未测。 */
function untestedNote(r: ClauseResult, manualNote?: string): string {
  if (r.verdict !== 'not_tested') return manualNote ? `${r.note}人工填报说明：${manualNote}` : r.note;
  const c = r.clause;
  if (c.capability === 'not_covered') {
    return c.automation === 'auto' ? `平台暂不覆盖。${c.capabilityNote ?? ''}` : `需人工填报：${c.capabilityNote ?? '平台只能取证，结论由人工确认。'}`;
  }
  if (c.automation !== 'auto') return `本次未测；其中需人工填报的部分：${c.capabilityNote ?? '黑盒测不了，由人工确认。'}`;
  return r.note;
}

function row(r: ClauseResult, snapshot?: StandardClauseSnapshot): ClauseTableRow {
  const evidence = snapshot?.evidence?.[r.clause.id];
  return {
    citation: clauseCitation(r.clause),
    title: r.clause.title,
    verdict: r.verdict,
    label: r.label,
    tested: r.tested,
    failed: r.failed,
    invalid: r.invalid,
    note: untestedNote(r, snapshot?.manualNotes?.[r.clause.id]),
    ...(evidence?.length ? { evidence } : {}),
  };
}

function groupOf(r: ClauseResult): string {
  const c = r.clause;
  if (c.basisId === 'gbt45654') {
    if (c.kind === 'risk') return '附录 A 风险类别（31 项）';
    if (c.id.startsWith('gbt45654.B.')) return '附录 B 评估方法与题库要求';
    return '正文要求（训练数据、模型安全、安全措施）';
  }
  if (c.basisId === 'gb45438') return 'GB 45438-2025 生成合成内容标识';
  if (c.basisId === 'anthropomorphic-measures') return '拟人化互动服务（仅情感陪伴类适用）';
  if (c.basisId === 'agent-app-security-plan') return '智能体应用安全 8 项要求（在研强制国标）';
  if (c.basisId === 'tc260-pg-20266a') return '智能体部署使用安全检查清单（TC260-PG-20266A 附录 A）';
  return '其他';
}

function untestedSentence(list: ClauseResult[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const r of list) {
    const reason =
      r.verdict === 'not_applicable'
        ? '不适用于黑盒测评，需被测方提供材料'
        : r.clause.capability === 'not_covered'
          ? r.clause.automation === 'auto' ? '平台暂不覆盖' : '需人工填报'
          : '本次未测';
    const arr = byReason.get(reason) ?? [];
    // 附录 A 风险项写编号即可（例如「A.2 e)」）；其余条款的位置可能重名（同一章节下多条），写条款名称。
    arr.push(r.clause.kind === 'risk' && r.clause.basisId === 'gbt45654' ? r.clause.ref.replace(/^附录 /, '') : r.clause.title);
    byReason.set(reason, arr);
  }
  return [...byReason.entries()].map(([reason, refs]) => `${reason}（${refs.length} 项）：${refs.join('、')}。`);
}

export function buildClauseTables(
  lines: readonly EvalLine[],
  snapshot: StandardClauseSnapshot | undefined,
): ClauseTable[] {
  return lines
    .filter((l) => l !== 'endpoint') // 终端报告走专用版式，由终端线自己渲染
    .map((line) => {
      const results = evaluateLine(line, snapshot?.observations ?? []);
      const groups = new Map<string, ClauseResult[]>();
      for (const r of results) {
        const g = groupOf(r);
        groups.set(g, [...(groups.get(g) ?? []), r]);
      }
      const table: ClauseTable = {
        line,
        lineLabel: EVAL_LINE_LABELS[line],
        statement: LINE_BASIS_STATEMENT[line],
        groups: [...groups.entries()].map(([name, list]) => {
          const shown = list.filter((r) => r.tested > 0 || r.verdict === 'nonconform' || (line === 'agent'));
          const rest = list.filter((r) => !shown.includes(r));
          return { name, rows: shown.map((r) => row(r, snapshot)), untested: untestedSentence(rest) };
        }),
        counts: {
          total: results.length,
          tested: results.filter((r) => r.tested > 0).length,
          nonconform: results.filter((r) => r.verdict === 'nonconform').length,
        },
      };
      if (line === 'content') {
        const majors = snapshot?.annexMajors ?? {};
        table.annexMajors = (Object.keys(ANNEX_A_MAJORS) as Array<keyof typeof ANNEX_A_MAJORS>).map((code) => {
          const t = majors[code] ?? { tested: 0, failed: 0, invalid: 0 };
          return {
            code,
            name: ANNEX_A_MAJORS[code],
            ...t,
            label: t.tested === 0 ? '未测' : t.failed > 0 ? '发现风险' : '未发现风险',
          };
        });
      }
      return table;
    });
}

/**
 * 管理层摘要里的一句覆盖说明：等级与通过率只反映所测范围，必须同时说清标准条款测到了多少。
 * 内容线按附录 A 31 项与 5 大类说；智能体线按 8 项要求说。
 */
export function clauseCoverageNotes(tables: readonly ClauseTable[]): string[] {
  return tables.map((t) => {
    if (t.line === 'content') {
      const riskGroup = t.groups.find((g) => g.name.startsWith('附录 A'));
      const itemsTested = riskGroup ? riskGroup.rows.filter((r) => r.tested > 0).length : 0;
      const majorsUntested = (t.annexMajors ?? []).filter((m) => m.tested === 0).length;
      return `标准覆盖：GB/T 45654-2025 附录 A 的 31 项风险中，本次有逐项测试数据的 ${itemsTested} 项；5 个大类中 ${majorsUntested} 类未测。上述等级与通过率只反映所测范围，逐条结论见第 6 章。`;
    }
    const tested = t.groups.flatMap((g) => g.rows).filter((r) => r.tested > 0).length;
    return `标准覆盖：${t.lineLabel} ${t.counts.total} 项条款中，本次有测试数据的 ${tested} 项。上述等级与通过率只反映所测范围，逐条结论见第 6 章。`;
  });
}

/** 未测条款里「平台暂不覆盖」的说明，供页面提示。 */
export function capabilityLabel(cap: keyof typeof CLAUSE_CAPABILITY_LABELS): string {
  return CLAUSE_CAPABILITY_LABELS[cap];
}
