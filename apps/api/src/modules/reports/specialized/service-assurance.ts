import type { Severity } from '@lse/shared';
import {
  type BuiltReportCharts,
  type BuiltReportRiskDistribution,
  type ReportEngineRun,
  type ReportFindingSample,
  type ReportInputData,
  type ReportServiceAssuranceAssessmentSnapshot,
  type ReportServiceAssuranceRunSnapshot,
} from '../report-builder.js';
import { formatDateTime, severityLabel } from '../labels.js';
import type { ReportRemediationItem } from '../remediation.js';
import { buildReportConclusionSnapshot } from '../report-conclusion.js';
import { redactReportString } from '../report-redaction.js';
import { buildSecurityScore } from '../scoring.js';
import type { SpecializedReport } from './types.js';

const MODE_LABELS = {
  SAFE: '安全检查',
  DEEP: '授权深度核验',
  SBOM: '组件清单核验',
} as const;

const STATUS_LABELS: Record<string, string> = {
  PENDING: '等待执行',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  PARTIAL: '部分完成',
  FAILED: '执行失败',
  CANCELED: '已取消',
  SUCCESS: '已完成',
  ERROR: '核验未完成',
};

const INTERNAL_NAME_RE = /AI-Infra-Guard|\bAIG\b|Nuclei|Trivy|\bZAP\b|service-assurance/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const INTERNAL_PATH_RE = /\/(?:home|opt|var|tmp)\/[^\s,，;；)）\]}]+/gi;
const SENTINEL_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function customerText(value: string | null | undefined, fallback = '—'): string {
  const sanitized = redactReportString(value ?? '')
    .replace(INTERNAL_NAME_RE, '内部核验组件')
    .replace(/rawOutput/gi, '内部原始字段')
    .replace(/session(?:\s*ID)?/gi, '内部执行标识')
    .replace(/容器名/g, '内部运行单元')
    .replace(UUID_RE, '（内部标识已隐藏）')
    .replace(INTERNAL_PATH_RE, '（内部路径已隐藏）')
    .replace(SENTINEL_RE, '（敏感信息已脱敏）')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || fallback;
}

function cell(value: unknown): string {
  return customerText(String(value ?? '—')).replace(/\|/g, '\\|');
}

function table(headers: string[], rows: string[][]): string {
  const body = rows.length > 0 ? rows : [headers.map(() => '—')];
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function safeRun(run: ReportServiceAssuranceRunSnapshot): ReportServiceAssuranceRunSnapshot {
  return {
    ...run,
    targetName: customerText(run.targetName),
    rulesBaseline: run.rulesBaseline ? customerText(run.rulesBaseline) : null,
    vulnerabilityBaseline: run.vulnerabilityBaseline
      ? customerText(run.vulnerabilityBaseline)
      : null,
    skippedItems: run.skippedItems.map((item) => customerText(item)),
    limitations: run.limitations.map((item) => customerText(item)),
  };
}

function safeAssessment(
  assessment: ReportServiceAssuranceAssessmentSnapshot,
): ReportServiceAssuranceAssessmentSnapshot {
  return {
    ...assessment,
    targetName: customerText(assessment.targetName),
    assetName: customerText(assessment.assetName),
    componentName: assessment.componentName ? customerText(assessment.componentName) : null,
    componentVersion: assessment.componentVersion
      ? customerText(assessment.componentVersion)
      : null,
    advisoryId: assessment.advisoryId ? customerText(assessment.advisoryId) : null,
    title: customerText(assessment.title),
    evidenceLabel: customerText(assessment.evidenceLabel),
    reason: customerText(assessment.reason),
    remediation: assessment.remediation ? customerText(assessment.remediation) : null,
    fixedVersion: assessment.fixedVersion ? customerText(assessment.fixedVersion) : null,
  };
}

function reportRun(run: ReportServiceAssuranceRunSnapshot): ReportEngineRun {
  const complete = run.status === 'COMPLETED' && run.coverageStatus === 'COMPLETE';
  const status =
    run.status === 'PENDING' || run.status === 'RUNNING'
      ? run.status
      : complete
        ? 'SUCCESS'
        : 'ERROR';
  return {
    engine: '安全核验',
    status,
    normalizedCount: null,
    skippedCount: run.skippedItems.length + (!complete && run.skippedItems.length === 0 ? 1 : 0),
    durationMs:
      run.startedAt && run.endedAt
        ? Math.max(0, run.endedAt.getTime() - run.startedAt.getTime())
        : null,
    errorMessage: complete ? null : '部分检查未完成',
  };
}

function severityDistribution(
  assessments: readonly ReportServiceAssuranceAssessmentSnapshot[],
): Record<string, number> {
  const distribution: Record<string, number> = {};
  for (const assessment of assessments) {
    const key = assessment.severity ?? 'UNKNOWN';
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  return distribution;
}

function assessmentRows(assessments: readonly ReportServiceAssuranceAssessmentSnapshot[]) {
  return assessments.map((assessment) => [
    assessment.title,
    [assessment.assetName, assessment.componentName, assessment.componentVersion]
      .filter(Boolean)
      .join(' / '),
    assessment.advisoryId ?? '—',
    severityLabel(assessment.severity),
    assessment.confidence == null ? '—' : `${Math.round(assessment.confidence * 100)}%`,
    assessment.priority === 'UNKNOWN' ? '未定' : assessment.priority,
    assessment.evidenceLabel,
    assessment.reason,
  ]);
}

function assessmentEvidence(assessment: ReportServiceAssuranceAssessmentSnapshot): string {
  return [
    `资产：${assessment.assetName}`,
    assessment.componentName
      ? `组件：${assessment.componentName}${assessment.componentVersion ? ` ${assessment.componentVersion}` : ''}`
      : null,
    assessment.advisoryId ? `漏洞编号：${assessment.advisoryId}` : null,
    `证据：${assessment.evidenceLabel}`,
  ]
    .filter(Boolean)
    .join('；');
}

function statusChart(runs: readonly ReportEngineRun[]) {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, value]) => ({
    key: STATUS_LABELS[status] ?? '其他状态',
    label: STATUS_LABELS[status] ?? '其他状态',
    value,
  }));
}

export function buildServiceAssuranceReport(data: ReportInputData): SpecializedReport {
  if (!data.serviceAssurance) {
    throw new TypeError('服务安全核验报告缺少归一化客户快照');
  }

  const runs = data.serviceAssurance.runs.map(safeRun);
  const assessments = data.serviceAssurance.assessments.map(safeAssessment);
  const confirmed = assessments.filter((item) => item.impactStatus === 'AFFECTED');
  const underInvestigation = assessments.filter(
    (item) => item.impactStatus === 'UNDER_INVESTIGATION',
  );
  const notAffected = assessments.filter((item) => item.impactStatus === 'NOT_AFFECTED');
  const fixed = assessments.filter((item) => item.impactStatus === 'FIXED');
  const engineRuns = runs.map(reportRun);
  const incompleteRunCount = runs.filter(
    (run) => run.status !== 'COMPLETED' || run.coverageStatus !== 'COMPLETE',
  ).length;
  const coverageIncomplete = runs.length === 0 || incompleteRunCount > 0;
  const conclusionSnapshot = buildReportConclusionSnapshot({
    scopeKind: 'ENGINE_RUN_SET',
    activeRiskCount: confirmed.length,
    results: [],
    engineRuns,
  });
  const bySeverity = severityDistribution(confirmed);
  const highImpactRiskCount = confirmed.filter(
    (item) => item.severity === 'CRITICAL' || item.severity === 'HIGH',
  ).length;
  const findingSamples: ReportFindingSample[] = confirmed.map((item) => ({
    engineLabel: '安全核验',
    riskCategoryLabel: '服务安全风险',
    riskTypeLabel: item.title,
    ruleActionLabel: '确认存在风险',
    severityLabel: severityLabel(item.severity),
    verdictLabel: '需要整改',
    evidence: assessmentEvidence(item),
    riskExplanation: item.reason,
  }));
  const remediationItems: ReportRemediationItem[] = confirmed.map((item) => ({
    priority: item.priority,
    title: item.title,
    riskCategoryLabel: '服务安全风险',
    evidence: assessmentEvidence(item),
    action: item.remediation ?? '请结合业务影响制定整改措施。',
    verification: '在相同授权范围和基线下复测，确认风险不再出现并记录复测结论。',
  }));
  const metrics = {
    confirmedRiskCount: confirmed.length,
    underInvestigationCount: underInvestigation.length,
    notAffectedCount: notAffected.length,
    fixedCount: fixed.length,
    incompleteRunCount,
    highImpactRiskCount,
  };
  const securityScore = buildSecurityScore({
    findings: confirmed.map((item) => ({ severity: item.severity, reviewStatus: 'CONFIRMED' })),
    engineRuns,
    coverageIncomplete: !conclusionSnapshot.coverageComplete,
  });
  const charts: BuiltReportCharts = {
    severity: Object.entries(bySeverity).map(([key, value]) => ({
      key,
      label: key === 'UNKNOWN' ? '未知' : severityLabel(key as Severity),
      value,
    })),
    verdict: [],
    riskCategory:
      confirmed.length > 0 ? [{ key: '正式风险', label: '正式风险', value: confirmed.length }] : [],
    riskDomain: [],
    engineStatus: statusChart(engineRuns),
    engineRuns: engineRuns.map((run) => ({
      engine: run.engine,
      engineLabel: run.engine,
      status: run.status,
      statusLabel: STATUS_LABELS[run.status] ?? '其他状态',
      normalizedCount: run.normalizedCount,
      skippedCount: run.skippedCount,
      durationMs: run.durationMs,
    })),
    passRatePercent: null,
  };
  const headline = coverageIncomplete
    ? `发现正式风险 ${confirmed.length} 项；本次核验覆盖不完整。`
    : `发现正式风险 ${confirmed.length} 项；本次核验已按既定范围完成。`;
  const scopeRows = runs.map((run) => [
    run.targetName,
    MODE_LABELS[run.mode],
    STATUS_LABELS[run.status] ?? '其他状态',
    run.coverageStatus === 'COMPLETE' ? '完整' : '不完整',
    [run.rulesBaseline, run.vulnerabilityBaseline].filter(Boolean).join('；') || '—',
    run.skippedItems.join('；') || '—',
    run.limitations.join('；') || '—',
  ]);
  const content = [
    '# AI 服务安全核验报告',
    '',
    `> 任务名称：${customerText(data.task.name)}`,
    `> 生成时间：${formatDateTime(data.generatedAt)}`,
    '',
    '## 管理摘要',
    '',
    headline,
    '',
    table(
      ['正式风险', '待核验线索', '不受影响', '已修复', '未完成运行', '高影响风险'],
      [
        [
          String(confirmed.length),
          String(underInvestigation.length),
          String(notAffected.length),
          String(fixed.length),
          String(incompleteRunCount),
          String(highImpactRiskCount),
        ],
      ],
    ),
    ...(coverageIncomplete
      ? [
          '',
          '> 核验未完成：本次覆盖不完整，以下结论仅适用于已完成的检查项，不能据此判断目标整体安全。',
        ]
      : []),
    '',
    '## 正式风险',
    '',
    table(
      ['风险', '资产与组件', '漏洞编号', '严重度', '可信度', '整改优先级', '证据', '判断依据'],
      assessmentRows(confirmed),
    ),
    '',
    '## 待核验线索',
    '',
    table(
      ['线索', '资产与组件', '判断依据'],
      underInvestigation.map((item) => [
        item.title,
        [item.assetName, item.componentName, item.componentVersion].filter(Boolean).join(' / '),
        item.reason,
      ]),
    ),
    '',
    '## 不受影响',
    '',
    table(
      ['结论', '资产与组件', '依据'],
      notAffected.map((item) => [
        item.title,
        [item.assetName, item.componentName, item.componentVersion].filter(Boolean).join(' / '),
        item.reason,
      ]),
    ),
    '',
    '## 已修复',
    '',
    table(
      ['原风险', '当前版本', '复测时间', '复测结论'],
      fixed.map((item) => [
        item.title,
        item.fixedVersion ?? item.componentVersion ?? '—',
        item.retestedAt ? formatDateTime(item.retestedAt) : '—',
        item.reason,
      ]),
    ),
    '',
    '## 整改建议',
    '',
    table(
      ['风险', '建议'],
      confirmed.map((item) => [
        item.title,
        item.remediation ?? '请结合业务影响制定整改与复测计划。',
      ]),
    ),
    '',
    '## 核验范围与限制',
    '',
    table(['目标范围', '核验模式', '执行状态', '覆盖情况', '基线', '跳过项', '限制'], scopeRows),
    '',
    '> 本报告仅说明本次授权范围、既定基线和执行时间内观察到的结果，不代表绝对安全或合规认证。',
    '',
  ].join('\n');
  const riskDistribution: BuiltReportRiskDistribution = {
    bySeverity,
    byRiskCategory: confirmed.length > 0 ? { 正式风险: confirmed.length } : {},
    byRiskDomain: confirmed.length > 0 ? { 服务安全风险: confirmed.length } : {},
  };

  return {
    kind: 'service_assurance',
    title: 'AI 服务安全核验报告',
    format: 'markdown',
    content,
    summary: {
      totalQuestions: conclusionSnapshot.counts.expected,
      processedQuestions: conclusionSnapshot.counts.observed,
      passedCount: conclusionSnapshot.counts.pass,
      failedCount: conclusionSnapshot.counts.fail,
      errorCount: conclusionSnapshot.counts.error,
      wrongAnswerCount: 0,
      evidenceFindingCount: confirmed.length,
      findingCount: confirmed.length,
      securityScore,
      conclusionSnapshot,
      verdictDistribution: {},
      severityDistribution: bySeverity,
      charts,
      findingSamples,
      wrongAnswerSamples: [],
      riskItemsBySeverity: [],
      remediationItems,
      kind: 'service_assurance',
      headline,
      metrics,
      topFindings: confirmed.slice(0, 5).map((item) => ({
        title: item.title,
        severity: item.severity,
        evidence: item.reason,
      })),
    },
    passRate: conclusionSnapshot.passRate,
    totalQuestions: conclusionSnapshot.counts.expected,
    riskDistribution,
  };
}
