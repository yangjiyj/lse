import type { Severity } from '@lse/shared';
import type {
  BuiltReport,
  BuiltReportCharts,
  BuiltReportSummary,
  ChartDatum,
} from '../report-builder.js';

export const REPORT_KINDS = [
  'comprehensive',
  'safety_overview',
  'refusal_capability',
  'prompt_injection_resilience',
  'component_vulnerability',
  'service_assurance',
  'multilingual_coverage',
  'agent_tool_abuse',
  'usability_over_refusal',
  'gbt45654_content',
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  comprehensive: '综合评估报告',
  safety_overview: '安全评估总览',
  refusal_capability: '拒答能力专项',
  prompt_injection_resilience: '提示注入对抗专项',
  component_vulnerability: '组件漏洞专项',
  service_assurance: 'AI 服务安全核验报告',
  multilingual_coverage: '多语言覆盖专项',
  agent_tool_abuse: '智能体工具调用安全专项',
  usability_over_refusal: '可用性与过度拒答专项',
  gbt45654_content: '生成内容安全评估报告（GB/T 45654）',
};

export interface SpecializedTopFinding {
  title: string;
  severity: Severity | null;
  evidence: string | null;
}

export interface SpecializedCharts extends BuiltReportCharts {
  byLanguage?: ChartDatum[];
}

export interface SpecializedReportSummary extends BuiltReportSummary {
  kind: ReportKind;
  headline: string;
  metrics: Record<string, number | string | null>;
  charts: SpecializedCharts;
  topFindings: SpecializedTopFinding[];
}

export interface SpecializedReport extends Omit<BuiltReport, 'summary'> {
  kind: ReportKind;
  summary: SpecializedReportSummary;
}
