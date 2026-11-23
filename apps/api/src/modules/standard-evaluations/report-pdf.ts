import { renderReportPdf, type ReportPdfDoc } from '../reports/pdf.js';

type Metric = {
  numerator: number;
  denominator: number;
  planned: number;
  ratioPercent: number | null;
  conclusion: string;
  threshold: { operator: string; percent: number };
};

type StandardReportContent = {
  title?: string;
  scope?: {
    standard?: string;
    profileVersion?: string;
    boundary?: string;
    language?: string;
    modality?: string;
  };
  conclusion?: string;
  metrics?: { groups?: Record<string, Metric> };
  limitations?: string[];
  evidence?: {
    releaseHash?: string | null;
    samplePlanHash?: string;
    formulaVersion?: string;
    judgmentRule?: string;
  };
};

function metricLabel(group: string): string {
  return (
    {
      MANUAL_SAFETY: '生成内容安全（人工抽检项）',
      TECHNICAL_SAFETY: '生成内容安全（自动技术参考）',
      SHOULD_REFUSE: '应拒答命中率（自动参考）',
      NON_REFUSAL: '非拒答误拒率（自动参考）',
    }[group] ?? group
  );
}

function metricValue(metric: Metric | undefined): string {
  if (!metric || metric.ratioPercent === null) return '证据不足';
  return `${metric.ratioPercent.toFixed(2)}% (${metric.numerator}/${metric.denominator})`;
}

export function buildStandardReportPdfDoc(content: StandardReportContent): ReportPdfDoc {
  const groups = content.metrics?.groups ?? {};
  const rows = Object.entries(groups).map(([group, metric]) => [
    metricLabel(group),
    metricValue(metric),
    `${metric.threshold.operator} ${metric.threshold.percent}%`,
    metric.conclusion,
  ]);
  const limitations = content.limitations ?? [];
  return {
    title: content.title ?? '模型 API 输出安全测评 / GB/T 45654 指标对标',
    blocks: [
      {
        type: 'title',
        text: content.title ?? '模型 API 输出安全测评 / GB/T 45654 指标对标',
        subtitle: '客户仅提供模型 API；自动技术判定参考报告',
      },
      { type: 'heading', text: '结论与范围' },
      { type: 'paragraph', text: `结论：${content.conclusion ?? 'INSUFFICIENT_EVIDENCE'}` },
      {
        type: 'paragraph',
        text: `标准依据：${content.scope?.standard ?? 'GB/T 45654-2025'} / profile ${content.scope?.profileVersion ?? '—'}`,
      },
      { type: 'paragraph', text: `测评边界：${content.scope?.boundary ?? '—'}` },
      {
        type: 'paragraph',
        text: `范围：${content.scope?.language ?? '—'} / ${content.scope?.modality ?? '—'}；训练数据总体、专业样本集与人工抽检本次未评估。`,
      },
      { type: 'heading', text: '自动指标（技术判定 / 参考指标）' },
      {
        type: 'table',
        headers: ['指标组', '结果', '阈值', '状态'],
        rows,
      },
      { type: 'heading', text: '证据索引' },
      {
        type: 'paragraph',
        text: `样本集发布版哈希：${content.evidence?.releaseHash ?? '—'}\n抽样计划哈希：${content.evidence?.samplePlanHash ?? '—'}\n指标公式：${content.evidence?.formulaVersion ?? '—'}；判定规则：${content.evidence?.judgmentRule ?? '—'}`,
      },
      { type: 'heading', text: '缺口与限制' },
      {
        type: 'paragraph',
        text: limitations.length > 0 ? limitations.map((item) => `• ${item}`).join('\n') : '—',
      },
    ],
  };
}

export function renderStandardReportPdf(
  content: StandardReportContent,
  options: { cjkFontPath?: string; cjkFontFamily?: string; watermark?: string } = {},
): Promise<Buffer> {
  return renderReportPdf(buildStandardReportPdfDoc(content), options);
}
