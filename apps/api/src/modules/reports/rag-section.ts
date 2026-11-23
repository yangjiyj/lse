/**
 * 报告中的「RAG 专项评估」章节：取任务关联的 RAG 运行摘要（ragEvalRun.summary.groups），
 * 按生成质量 / 检索质量 / 安全项分组列出指标，未评估的指标写明原因，并列出对齐方式与清理残留。
 * 只读取已冻结的运行摘要，不含任何凭据或被测接入配置。
 */
export interface ReportRagMetric {
  label: string;
  applicable: number;
  samples: number;
  passRate: number | null;
  average: number | null;
  notEvaluatedReasons: Array<{ reason: string; count: number }>;
  extra?: Record<string, number>;
}

export interface ReportRagSection {
  testSetName: string;
  alignmentModeLabel: string;
  alignmentConfirmedByName: string | null;
  packageImported: boolean;
  groups: {
    generation: ReportRagMetric[];
    retrieval: ReportRagMetric[];
    security: ReportRagMetric[];
  } | null;
  cleanup: { ok: boolean; reason: string | null; residual: Array<{ filename: string; knowledgeBaseId: string }> } | null;
}

function cell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function metricValue(m: ReportRagMetric, useAverage: boolean): string {
  if (m.applicable === 0) return '不适用（测试集不含该类题目）';
  if (m.samples === 0) {
    const r = m.notEvaluatedReasons[0]?.reason.replace(/^未评估[:：]?/, '') ?? '原因未记录';
    return `未评估（${r}）`;
  }
  return useAverage ? (m.average === null ? '—' : m.average.toFixed(3)) : pct(m.passRate);
}

function groupTable(title: string, rows: ReportRagMetric[], averageLabels: string[] = []): string[] {
  const body = rows.map((m) => {
    const reasons = m.notEvaluatedReasons.map((r) => `${r.reason}（${r.count}）`).join('；') || '—';
    const review = m.extra?.needsReview ? `；需人工复核 ${m.extra.needsReview}` : '';
    return `| ${cell(m.label)} | ${cell(metricValue(m, averageLabels.includes(m.label)))} | ${m.samples}/${m.applicable}${review} | ${cell(reasons)} |`;
  });
  return [`#### ${title}`, '', '| 指标 | 结果 | 已评估/适用 | 未评估原因 |', '| --- | --- | --- | --- |', ...body, ''];
}

export function renderRagSection(sections: ReportRagSection[]): string[] {
  if (sections.length === 0) return [];
  const out: string[] = ['### RAG 专项评估', ''];
  for (const s of sections) {
    const align = [
      `知识对齐模式：${s.alignmentModeLabel}`,
      s.alignmentConfirmedByName ? `对齐确认人：${s.alignmentConfirmedByName}` : null,
      s.packageImported ? '测试知识库包：人工导入' : null,
    ]
      .filter(Boolean)
      .join('；');
    out.push(`测试集：${cell(s.testSetName)}。${align}。`, '');
    if (!s.groups) {
      out.push('本次运行未产生指标摘要（运行未完成或失败）。', '');
      continue;
    }
    out.push(...groupTable('生成质量', s.groups.generation));
    out.push(...groupTable('检索质量', s.groups.retrieval, ['MRR']));
    out.push(...groupTable('安全项', s.groups.security));
    if (s.cleanup && !s.cleanup.ok) {
      out.push(`测试文档清理：${cell(s.cleanup.reason ?? '未完成')}`);
      for (const r of s.cleanup.residual.slice(0, 20)) out.push(`- 残留：${cell(r.filename)}（知识库 ${cell(r.knowledgeBaseId || '—')}）`);
      out.push('');
    }
  }
  out.push('> 说明：未评估的样本不计入通过率；“未评估”表示知识对齐或被测接口能力不满足该指标的前提，而非通过。', '');
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 从 ragEvalRun 行（summary / cleanup 为 JSON）转换为报告章节数据；不合法的 JSON 视为缺失。 */
export function toReportRagSection(run: {
  alignmentMode: string;
  alignmentConfirmedByName: string | null;
  packageImported: boolean;
  summary: unknown;
  cleanup: unknown;
  testSet: { name: string };
}): ReportRagSection {
  const summary = isRecord(run.summary) ? run.summary : {};
  const groups = isRecord(summary.groups) ? (summary.groups as unknown as ReportRagSection['groups']) : null;
  const cleanup = isRecord(run.cleanup) ? (run.cleanup as unknown as ReportRagSection['cleanup']) : null;
  const label = typeof summary.alignmentModeLabel === 'string' ? summary.alignmentModeLabel : run.alignmentMode;
  return {
    testSetName: run.testSet.name,
    alignmentModeLabel: label,
    alignmentConfirmedByName: run.alignmentConfirmedByName,
    packageImported: run.packageImported,
    groups,
    cleanup,
  };
}
