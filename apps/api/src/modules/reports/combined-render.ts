// 组合报告（2.6.3）的版面内容：PDF、HTML、Word 共用同一份，避免三种格式各说各话。
import {
  DETECT_CATEGORIES,
  DETECT_CATEGORY_LABELS,
  DETECT_RECORD_KIND_LABELS,
  DETECT_TASK_STATUS_LABELS,
  type DetectCategory,
} from '@lse/shared';
import { DEFAULT_PLATFORM_TITLE_TEXT } from '../../lib/product-name.js';
import {
  COMBINED_REPORT_KIND_LABEL,
  severityEntries,
  type CombinedSnapshot,
  type CombinedTaskView,
} from './combined.js';
import { SEVERITY_ORDER, SEVERITY_ZH, formatPercent } from './html/derive.js';
import { reportPageStyle } from './html/render.js';
import { esc } from './html/sections.js';
import { formatDateTime, riskDomainLabel } from './labels.js';
import type { ReportPageOptions, ReportTemplateRenderOptions } from './report-template.js';
import type { PdfBlock, ReportPdfDoc } from './pdf.js';

export const DELETED_TASK_MARK = '任务已删除';
export const MOVED_TASK_MARK = '任务已移出本租户';

export interface CombinedRenderInput {
  title: string;
  reportId: string;
  createdAt: Date;
  snapshot: CombinedSnapshot;
  tasks: CombinedTaskView[];
  /** 报告模板（2.4.7）：封面、密级、页眉页脚 */
  template?: ReportTemplateRenderOptions;
}

export interface CombinedTable {
  headers: string[];
  rows: string[][];
  weights: number[];
}

export interface CombinedView {
  platform: string;
  title: string;
  subtitle: string;
  meta: Array<{ k: string; v: string }>;
  reportId: string;
  conclusion: string[];
  taskTable: CombinedTable;
  taskNote: string;
  severityTable: CombinedTable | null;
  domainTable: CombinedTable | null;
  taskSeverityTable: CombinedTable | null;
  topRiskTable: CombinedTable | null;
  /** note：任务已删除或已迁走时的提示，排在小结最前面。 */
  taskSummaries: Array<{ heading: string; note: string | null; lines: string[] }>;
  notes: string[];
  /** 报告模板的页眉页脚；不给用默认。 */
  page?: ReportPageOptions;
  /** 综合检测报告（从组合任务生成）的其他检测项：检测项、类别、状态、风险数 */
  recordTable: CombinedTable | null;
  /** 其他检测项的小结和主要发现 */
  recordSummaries: Array<{ heading: string; lines: string[] }>;
}

/** 结论里按类别列风险数的顺序：内容、模型、数据、应用与环境。 */
const CATEGORY_ORDER: DetectCategory[] = ['content', 'model', 'data', 'app_env'];

/** 按类别的风险数用的短名（结论里一句话列四类）。 */
const CATEGORY_SHORT: Record<DetectCategory, string> = {
  content: '内容',
  model: '模型',
  data: '数据',
  app_env: '应用与环境',
};

const shortTime = (iso: string | null) => (iso ? formatDateTime(new Date(iso)).slice(0, 16) : '—');
const taskMark = (t: CombinedTaskView) =>
  t.deleted ? DELETED_TASK_MARK : t.movedOut ? MOVED_TASK_MARK : null;
const taskLabel = (t: CombinedTaskView) => {
  const mark = taskMark(t);
  return mark ? `${t.name}（${mark}）` : t.name;
};
const MAIN_SEVERITIES = SEVERITY_ORDER.filter((s) => s !== 'UNSPECIFIED' && s !== 'INFO');

function severityText(dist: Record<string, number>): string {
  return severityEntries(dist)
    .map(([k, n]) => `${SEVERITY_ZH[k]} ${n} 项`)
    .join('、');
}

function topDomains(dist: Record<string, number>, limit: number): string {
  return Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => `${riskDomainLabel(k)}（${n} 项）`)
    .join('、');
}

/** 把冻结快照整理成三种格式共用的版面内容。 */
export function buildCombinedView(input: CombinedRenderInput): CombinedView {
  const { snapshot, tasks } = input;
  const totals = snapshot.totals;
  const dist = snapshot.riskDistribution;
  const names = new Map(tasks.map((t) => [t.id, taskLabel(t)]));
  const targets = new Set(tasks.map((t) => t.targetName));
  const deletedCount = tasks.filter((t) => t.deleted).length;
  const movedCount = tasks.filter((t) => t.movedOut).length;

  const conclusion = [
    `本报告组合 ${tasks.length} 个评估任务，涉及 ${targets.size} 个评估对象，共 ${totals.totalQuestions} 个测试项：通过 ${totals.passedCount} 项、未通过 ${totals.failedCount} 项、执行异常 ${totals.errorCount} 项。`,
    totals.findingCount > 0
      ? `合并后共有 ${totals.findingCount} 项风险：${severityText(dist.bySeverity)}。`
      : '所选任务均未发现风险。',
  ];
  if (totals.findingCount > 0) {
    conclusion.push(`风险最集中的类别：${topDomains(dist.byRiskDomain, 3)}。`);
    const worst = [...tasks].sort((a, b) => b.findingCount - a.findingCount)[0];
    if (worst && worst.findingCount > 0) {
      conclusion.push(`风险最多的任务：${taskLabel(worst)}（${worst.findingCount} 项）。`);
    }
  }
  if (deletedCount > 0) {
    conclusion.push(
      `其中 ${deletedCount} 个任务已被删除，相关内容按生成报告时的结果保留，无法再跳转查看。`,
    );
  }
  if (movedCount > 0) {
    conclusion.push(
      `其中 ${movedCount} 个任务已移出本租户，相关内容按生成报告时的结果保留，无法再跳转查看。`,
    );
  }
  const job = snapshot.job;
  const records = snapshot.records ?? [];
  if (job) {
    // 综合检测报告：结论加一句按四类的风险数（评估任务按所属类别，其他检测项按记录类别）。
    const byCategory = Object.fromEntries(DETECT_CATEGORIES.map((c) => [c, 0])) as Record<
      DetectCategory,
      number
    >;
    for (const t of tasks) byCategory[job.taskCategories?.[t.id] ?? 'content'] += t.findingCount;
    for (const r of records) byCategory[r.category] += r.riskCount;
    conclusion.push(
      `按类别的风险数：${CATEGORY_ORDER.map((c) => `${CATEGORY_SHORT[c]} ${byCategory[c]} 项`).join('、')}。`,
    );
  }
  const recordTable: CombinedTable | null = records.length
    ? {
        headers: ['序号', '检测项', '类型', '类别', '状态', '风险数'],
        rows: records.map((r, i) => [
          String(i + 1),
          r.name,
          DETECT_RECORD_KIND_LABELS[r.kind] ?? r.kind,
          DETECT_CATEGORY_LABELS[r.category] ?? r.category,
          DETECT_TASK_STATUS_LABELS[r.status] ?? r.status,
          r.status === 'COMPLETED' ? String(r.riskCount) : '—',
        ]),
        weights: [7, 30, 16, 16, 11, 9],
      }
    : null;
  const recordSummaries = records.map((r, i) => ({
    heading: `${i + 1}. ${r.name}（${DETECT_RECORD_KIND_LABELS[r.kind] ?? r.kind}）`,
    lines: [
      ...r.lines,
      ...(r.topFindings.length
        ? [
            `主要发现：${r.topFindings.map((f) => `【${SEVERITY_ZH[f.severity]}】${f.title}`).join('；')}`,
          ]
        : []),
    ],
  }));

  const taskTable: CombinedTable = {
    headers: ['序号', '任务', '评估对象', '模型', '完成时间', '得分', '风险数'],
    rows: tasks.map((t, i) => [
      String(i + 1),
      taskLabel(t),
      t.targetName,
      t.model,
      shortTime(t.finishedAt),
      t.score === null ? '—' : t.score.toFixed(1),
      String(t.findingCount),
    ]),
    weights: [7, 22, 17, 15, 15, 8, 8],
  };

  const total = totals.findingCount;
  const severities = severityEntries(dist.bySeverity);
  const severityTable: CombinedTable | null = severities.length
    ? {
        headers: ['风险等级', '风险项', '占比'],
        rows: severities.map(([k, n]) => [
          SEVERITY_ZH[k],
          `${n} 项`,
          formatPercent(total > 0 ? n / total : 0, 1),
        ]),
        weights: [4, 2, 2],
      }
    : null;
  const domainEntries = Object.entries(dist.byRiskDomain).sort((a, b) => b[1] - a[1]);
  const domainTable: CombinedTable | null = domainEntries.length
    ? {
        headers: ['风险类别', '风险项', '占比'],
        rows: domainEntries.map(([k, n]) => [
          riskDomainLabel(k),
          `${n} 项`,
          formatPercent(total > 0 ? n / total : 0, 1),
        ]),
        weights: [4, 2, 2],
      }
    : null;
  const taskSeverityTable: CombinedTable | null =
    total > 0
      ? {
          headers: ['任务', ...MAIN_SEVERITIES.map((k) => SEVERITY_ZH[k]), '其他', '合计'],
          rows: [
            ...tasks.map((t) => {
              const d = t.riskDistribution.bySeverity;
              const main = MAIN_SEVERITIES.map((k) => d[k] ?? 0);
              const other = t.findingCount - main.reduce((a, b) => a + b, 0);
              return [taskLabel(t), ...main.map(String), String(other), String(t.findingCount)];
            }),
            (() => {
              const main = MAIN_SEVERITIES.map((k) => dist.bySeverity[k] ?? 0);
              const other = total - main.reduce((a, b) => a + b, 0);
              return ['合计', ...main.map(String), String(other), String(total)];
            })(),
          ],
          weights: [28, 8, 8, 8, 8, 8, 8],
        }
      : null;

  const topRiskTable: CombinedTable | null = snapshot.topRisks.length
    ? {
        headers: ['序号', '严重度', '风险类别', '典型问题', '数量', '来源任务'],
        rows: snapshot.topRisks.map((r, i) => [
          String(i + 1),
          r.severityLabel,
          r.domainLabel,
          r.title,
          String(r.count),
          r.taskIds.map((id) => names.get(id) ?? DELETED_TASK_MARK).join('、'),
        ]),
        weights: [7, 9, 16, 25, 7, 28],
      }
    : null;

  const taskSummaries = tasks.map((t, i) => {
    const mark = taskMark(t);
    const lines: string[] = [];
    lines.push(
      `评估对象 ${t.targetName}（模型 ${t.model}），${t.finishedAt ? `完成于 ${shortTime(t.finishedAt)}` : '完成时间未记录'}。`,
      `共 ${t.totalQuestions} 个测试项：通过 ${t.passedCount} 项、未通过 ${t.failedCount} 项、执行异常 ${t.errorCount} 项；有效判定通过率 ${formatPercent(t.passRate, 1)}；得分 ${t.score === null ? '—（评估不完整，不给分）' : t.score.toFixed(1)}。`,
      t.findingCount > 0
        ? `风险 ${t.findingCount} 项：${severityText(t.riskDistribution.bySeverity)}；主要集中在${topDomains(t.riskDistribution.byRiskDomain, 2)}。`
        : '未发现风险。',
    );
    return {
      heading: `${i + 1}. ${taskLabel(t)}`,
      note: mark ? `${mark}。以下为生成报告时的结果，不能再跳转查看任务详情。` : null,
      lines,
    };
  });

  const tpl = input.template;
  return {
    platform: tpl?.cover.kicker ?? DEFAULT_PLATFORM_TITLE_TEXT,
    title: tpl?.cover.title ?? input.title,
    subtitle: job
      ? `综合检测 · ${job.itemCount} 项`
      : `${COMBINED_REPORT_KIND_LABEL} · ${tasks.length} 个评估任务`,
    meta: [
      { k: '报告编号', v: input.reportId },
      { k: '生成日期', v: formatDateTime(input.createdAt).slice(0, 10) },
      { k: '任务数', v: `${tasks.length} 个` },
      { k: '密级', v: tpl?.classification ?? '内部使用' },
      ...(tpl?.cover.organization ? [{ k: '检测单位', v: tpl.cover.organization }] : []),
      ...(tpl?.cover.client ? [{ k: '委托单位', v: tpl.cover.client }] : []),
    ],
    ...(tpl ? { page: tpl.page } : {}),
    recordTable,
    recordSummaries,
    reportId: input.reportId,
    conclusion,
    taskTable,
    taskNote: '得分为综合评估得分，与任务列表「评估得分」同一口径；评估不完整的任务不给分。',
    severityTable,
    domainTable,
    taskSeverityTable,
    topRiskTable,
    taskSummaries,
    notes: [
      '数据来源：各评估任务在生成本报告时的结果；之后任务被修改、复测或删除，本报告内容不随之变化。',
      '各任务的风险数和分布与该任务单独出具的报告同一口径：同一测试项被多个检测引擎判为风险时只算一项，不含已标记为误报和模型判定为疑似误报的项；合并后的分布为各任务分布逐项相加。',
      '主要风险按「严重度 + 风险类别」归为一行，按严重度由高到低排列，列出典型问题和来源任务。',
    ],
  };
}

function tableHtml(t: CombinedTable): string {
  const sum = t.weights.reduce((a, b) => a + b, 0) || 1;
  const cols = t.weights
    .map((w) => `<col style="width:${((w / sum) * 100).toFixed(1)}%">`)
    .join('');
  return `<table class="t"><colgroup>${cols}</colgroup><thead><tr>${t.headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join('')}</tr></thead><tbody>${t.rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function sectionHeader(no: string, title: string): string {
  return `<div class="sec-h">${no ? `<span class="no">${esc(no)}</span>` : ''}<h2>${esc(title)}</h2></div>`;
}

/** 组合报告 HTML（与通用报告同一套样式，PDF 用同一份 HTML 经 chromium 渲染）。 */
export function renderCombinedHtml(view: CombinedView): string {
  const chapters: string[] = [];
  let no = 0;
  const chap = (title: string, inner: string, cls = '') => {
    no += 1;
    chapters.push(
      `<section class="chap ${cls}">${sectionHeader(String(no), title)}${inner}</section>`,
    );
  };
  chap(
    '结论',
    `<ol class="plain">${view.conclusion.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`,
  );
  chap('任务清单', `${tableHtml(view.taskTable)}<p class="small-note">${esc(view.taskNote)}</p>`);
  const dist = [
    view.severityTable
      ? `<h3 class="sub-h first">风险等级分布</h3>${tableHtml(view.severityTable)}`
      : '',
    view.domainTable ? `<h3 class="sub-h">风险类别分布</h3>${tableHtml(view.domainTable)}` : '',
    view.taskSeverityTable
      ? `<h3 class="sub-h">各任务风险等级</h3>${tableHtml(view.taskSeverityTable)}`
      : '',
  ].join('');
  chap('风险分布', dist || '<p class="lead">所选任务均未发现风险。</p>');
  chap(
    '主要风险',
    view.topRiskTable ? tableHtml(view.topRiskTable) : '<p class="lead">所选任务均未发现风险。</p>',
  );
  chap(
    '各任务小结',
    view.taskSummaries
      .map(
        (s) =>
          `<div class="keep"><h3 class="sub-h">${esc(s.heading)}</h3>${
            s.note ? `<p class="note-box">${esc(s.note)}</p>` : ''
          }${s.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`,
      )
      .join(''),
  );
  if (view.recordTable) {
    chap(
      '其他检测项',
      `${tableHtml(view.recordTable)}${view.recordSummaries
        .map(
          (s) =>
            `<div class="keep"><h3 class="sub-h">${esc(s.heading)}</h3>${s.lines
              .map((l) => `<p>${esc(l)}</p>`)
              .join('')}</div>`,
        )
        .join('')}`,
    );
  }
  const appendix = `<section class="chap appendix">${sectionHeader('', '附录　统计口径')}<ul class="plain">${view.notes
    .map((n) => `<li>${esc(n)}</li>`)
    .join('')}</ul></section>`;
  const cover = `<div class="cover">
    <div class="cover-body">
      <div class="cover-kicker">${esc(view.platform)}</div>
      <div class="accent-rule"></div>
      <h1>${esc(view.title)}</h1>
      <div class="sub">${esc(view.subtitle)}</div>
    </div>
    <div class="cover-meta">${view.meta
      .map((m) => `<div><div class="k">${esc(m.k)}</div><div class="v">${esc(m.v)}</div></div>`)
      .join('')}</div>
  </div>`;
  const style = reportPageStyle(`报告编号 ${esc(view.reportId)}`, view.page);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(view.title)}</title><style>${style}</style></head>
<body>${cover}<div class="pb">${chapters.join('')}${appendix}</div></body></html>`;
}

/** 组合报告的 pdfkit 版（REPORT_RENDERER=pdfkit 时用）：与 HTML、Word 同一份版面内容。 */
export function buildCombinedPdfDoc(view: CombinedView): ReportPdfDoc {
  const blocks: PdfBlock[] = [{ type: 'title', text: view.title, subtitle: view.subtitle }];
  const table = (title: string, t: CombinedTable): PdfBlock => ({
    type: 'table',
    title,
    headers: t.headers,
    rows: t.rows,
  });
  blocks.push({
    type: 'table',
    hideTitle: true,
    headers: ['项目', '内容'],
    rows: view.meta.map((m) => [m.k, m.v]),
  });
  const chapter = (no: number, title: string) =>
    blocks.push({ type: 'heading', text: `${no}. ${title}` });
  chapter(1, '结论');
  blocks.push(...view.conclusion.map((text): PdfBlock => ({ type: 'paragraph', text })));
  chapter(2, '任务清单');
  blocks.push(table('任务清单', view.taskTable), { type: 'paragraph', text: view.taskNote });
  chapter(3, '风险分布');
  if (view.severityTable) blocks.push(table('风险等级分布', view.severityTable));
  if (view.domainTable) blocks.push(table('风险类别分布', view.domainTable));
  if (view.taskSeverityTable) blocks.push(table('各任务风险等级', view.taskSeverityTable));
  if (!view.severityTable && !view.domainTable)
    blocks.push({ type: 'paragraph', text: '所选任务均未发现风险。' });
  chapter(4, '主要风险');
  blocks.push(
    view.topRiskTable
      ? table('主要风险', view.topRiskTable)
      : { type: 'paragraph', text: '所选任务均未发现风险。' },
  );
  chapter(5, '各任务小结');
  for (const s of view.taskSummaries) {
    blocks.push(
      { type: 'paragraph', text: s.heading },
      ...[...(s.note ? [s.note] : []), ...s.lines].map(
        (text): PdfBlock => ({ type: 'paragraph', text }),
      ),
    );
  }
  if (view.recordTable) {
    chapter(6, '其他检测项');
    blocks.push(table('其他检测项', view.recordTable));
    for (const s of view.recordSummaries) {
      blocks.push(
        { type: 'paragraph', text: s.heading },
        ...s.lines.map((text): PdfBlock => ({ type: 'paragraph', text })),
      );
    }
  }
  blocks.push({ type: 'heading', text: '附录　统计口径' });
  blocks.push(...view.notes.map((text): PdfBlock => ({ type: 'paragraph', text: `· ${text}` })));
  return { title: view.title, blocks };
}
