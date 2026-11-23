import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReportInputData } from '../src/modules/reports/report-builder.js';
import { gatherServiceAssuranceReportData } from '../src/modules/reports/service-assurance-data.js';
import { applicableReportKinds } from '../src/modules/reports/specialized/applicability.js';
import {
  REPORT_KINDS,
  REPORT_KIND_LABELS,
  buildSpecializedReport,
} from '../src/modules/reports/specialized/index.js';
import { buildServiceAssuranceReport } from '../src/modules/reports/specialized/service-assurance.js';
import {
  buildReportHtmlModel,
  reportIdentifierForDelivery,
} from '../src/modules/reports/html/model.js';
import { renderReportHtmlString } from '../src/modules/reports/html/render.js';
import { buildReportPdfDoc } from '../src/modules/reports/pdf.js';

const now = new Date('2026-08-30T08:00:00.000Z');

const fixture: ReportInputData = {
  task: {
    id: 'task-internal-id',
    name: '政务知识问答服务核验',
    description: null,
    status: 'COMPLETED',
    concurrency: 1,
    engines: [],
    totalQuestions: 0,
    processedQuestions: 0,
    passedCount: 0,
    failedCount: 0,
    errorCount: 0,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    modelTarget: null,
    questionSets: [],
  },
  verdictCounts: {},
  findings: [],
  engineRuns: [],
  wrongAnswers: [],
  results: [],
  generatedAt: now,
  serviceAssurance: {
    schemaVersion: 1,
    runs: [
      {
        targetName: '政务问答 API',
        mode: 'SAFE',
        status: 'COMPLETED',
        coverageStatus: 'COMPLETE',
        rulesBaseline: '规则基线 2026.08',
        vulnerabilityBaseline: null,
        startedAt: now,
        endedAt: now,
        skippedItems: [],
        limitations: [],
      },
      {
        targetName: '组件清单',
        mode: 'SBOM',
        status: 'PARTIAL',
        coverageStatus: 'INCOMPLETE',
        rulesBaseline: null,
        vulnerabilityBaseline: '漏洞库 2026.05',
        startedAt: now,
        endedAt: now,
        skippedItems: ['部分依赖缺少版本'],
        limitations: [
          'Trivy session ID 123e4567-e89b-12d3-a456-426614174000 at /opt/lse/internal',
          'sk-service-report-sentinel-1234567890',
        ],
      },
    ],
    assessments: [
      {
        targetName: '政务问答 API',
        assetName: '问答服务',
        componentName: '示例组件',
        componentVersion: '1.2.3',
        advisoryId: 'CVE-2026-10001',
        title: '示例高影响风险',
        severity: 'CRITICAL',
        confidence: 0.98,
        priority: 'P0',
        impactStatus: 'AFFECTED',
        evidenceLabel: '组件和版本证据',
        reason: '组件版本位于受影响范围。',
        remediation: '升级至 1.2.4。',
        fixedVersion: '1.2.4',
        retestedAt: null,
      },
      {
        targetName: '政务问答 API',
        assetName: '问答服务',
        componentName: '未知版本组件',
        componentVersion: null,
        advisoryId: 'CVE-2026-10002',
        title: '未知严重度风险',
        severity: null,
        confidence: 0.81,
        priority: 'UNKNOWN',
        impactStatus: 'AFFECTED',
        evidenceLabel: '配置命中证据',
        reason: '已复现安全配置问题。',
        remediation: null,
        fixedVersion: null,
        retestedAt: null,
      },
      {
        targetName: '政务问答 API',
        assetName: '问答服务',
        componentName: '疑似推理组件',
        componentVersion: null,
        advisoryId: null,
        title: '疑似组件、待核验线索',
        severity: 'CRITICAL',
        confidence: 0.45,
        priority: 'P3',
        impactStatus: 'UNDER_INVESTIGATION',
        evidenceLabel: '待核验线索',
        reason: '仅识别到组件名称，未确认版本。',
        remediation: null,
        fixedVersion: null,
        retestedAt: null,
      },
      {
        targetName: '组件清单',
        assetName: '离线组件清单',
        componentName: '已核验组件',
        componentVersion: '3.0.0',
        advisoryId: 'CVE-2025-20001',
        title: '版本不受影响',
        severity: 'HIGH',
        confidence: 1,
        priority: 'P2',
        impactStatus: 'NOT_AFFECTED',
        evidenceLabel: '组件和版本证据',
        reason: '当前版本不在受影响范围。',
        remediation: null,
        fixedVersion: null,
        retestedAt: null,
      },
      {
        targetName: '组件清单',
        assetName: '离线组件清单',
        componentName: '已整改组件',
        componentVersion: '4.0.1',
        advisoryId: 'CVE-2024-30001',
        title: '风险已修复',
        severity: 'CRITICAL',
        confidence: 1,
        priority: 'P1',
        impactStatus: 'FIXED',
        evidenceLabel: '复测证据',
        reason: '整改后完整复测未再次观察到风险。',
        remediation: '保持当前修复版本。',
        fixedVersion: '4.0.1',
        retestedAt: now,
      },
    ],
  },
};

test('正式报告分别统计五类结果且只有 AFFECTED 进入风险和评分', () => {
  const report = buildServiceAssuranceReport(fixture);

  assert.equal(report.kind, 'service_assurance');
  assert.equal(report.title, 'AI 服务安全核验报告');
  assert.equal(report.summary.findingCount, 2);
  assert.equal(report.summary.findingSamples.length, 2);
  assert.equal(report.summary.remediationItems.length, 2);
  assert.equal(report.summary.securityScore.activeFindingCount, 2);
  assert.equal(report.summary.severityDistribution.CRITICAL, 1);
  assert.equal(report.summary.severityDistribution.UNKNOWN, 1);
  assert.equal(report.summary.severityDistribution.HIGH, undefined);
  assert.deepEqual(report.summary.metrics, {
    confirmedRiskCount: 2,
    underInvestigationCount: 1,
    notAffectedCount: 1,
    fixedCount: 1,
    incompleteRunCount: 1,
    highImpactRiskCount: 1,
  });
  assert.equal(report.summary.conclusionSnapshot.coverageComplete, false);
  assert.match(report.content, /核验未完成|覆盖不完整/);
  assert.match(report.content, /疑似组件、待核验线索/);
  assert.match(report.content, /当前版本不在受影响范围/);
  assert.match(report.content, /整改后完整复测/);
});

test('客户报告序列化结果不包含内部名称、标识、原始结构、路径或哨兵', () => {
  const report = buildServiceAssuranceReport(fixture);
  const serialized = JSON.stringify({
    title: report.title,
    content: report.content,
    summary: report.summary,
  });

  assert.doesNotMatch(
    serialized,
    /AI-Infra-Guard|\bAIG\b|Nuclei|Trivy|\bZAP\b|service-assurance|rawOutput|session(?: ID)?|容器名|123e4567-e89b-12d3-a456-426614174000|\/opt\/lse\/internal|sk-service-report-sentinel/i,
  );
});

test('服务核验 HTML/PDF 交付保留正式风险和整改且隐藏数据库 UUID', () => {
  const internalId = '123e4567-e89b-42d3-a456-426614174000';
  const report = buildServiceAssuranceReport(fixture);
  const deliveryId = reportIdentifierForDelivery(report.kind, internalId);
  const html = renderReportHtmlString(buildReportHtmlModel(report, { reportId: deliveryId }));
  const pdfModelText = JSON.stringify(buildReportPdfDoc(report));

  assert.equal(deliveryId, '');
  assert.doesNotMatch(html, new RegExp(internalId));
  assert.match(html, /示例高影响风险/);
  assert.match(html, /升级至 1\.2\.4/);
  assert.match(pdfModelText, /示例高影响风险/);
  assert.match(pdfModelText, /升级至 1\.2\.4/);
  assert.equal(reportIdentifierForDelivery('comprehensive', internalId), internalId);
});

test('服务核验报告种类完成目录、适用性和构建器穷举注册', () => {
  assert.ok(REPORT_KINDS.includes('service_assurance'));
  assert.equal(REPORT_KIND_LABELS.service_assurance, 'AI 服务安全核验报告');
  assert.deepEqual(applicableReportKinds(fixture), ['service_assurance']);
  assert.equal(buildSpecializedReport('service_assurance', fixture).title, 'AI 服务安全核验报告');
});

test('服务核验报告查询只读取归一化客户字段且快照不含内部证据', async () => {
  const captured: unknown[] = [];
  const db = {
    evalTask: {
      findUnique: async (args: unknown) => {
        captured.push(args);
        return {
          id: 'task-db-id',
          name: '政务服务任务',
          description: null,
          status: 'COMPLETED',
          concurrency: 1,
          engines: ['internal-engine'],
          dimensions: ['component_vulnerability'],
          totalQuestions: 0,
          processedQuestions: 0,
          passedCount: 0,
          failedCount: 0,
          errorCount: 0,
          createdAt: now,
          startedAt: now,
          finishedAt: now,
          modelTarget: { id: 'model-target-db-id' },
        };
      },
    },
    serviceAssuranceRun: {
      findMany: async (args: unknown) => {
        captured.push(args);
        return [
          {
            id: 'run-db-id',
            targetName: '政务问答 API',
            mode: 'SBOM',
            status: 'FAILED',
            coverageStatus: 'NOT_READY',
            rulesetVersion: null,
            vulnerabilityDbVersion: '漏洞库 2026.05',
            rulesetDigest: 'sha256:must-not-leave-query',
            rawOutput: 'sk-raw-output-sentinel-1234567890',
            startedAt: now,
            endedAt: now,
            failureMessage: null,
            assessments: [
              {
                title: '组件版本受影响',
                advisoryId: 'CVE-2026-40001',
                severity: 'HIGH',
                confidence: 0.95,
                priority: 'P1',
                impactStatus: 'AFFECTED',
                evidenceLevel: 'VERSION_MATCH',
                findingId: 'finding-db-id',
                reason: '版本位于受影响范围。',
                remediation: '升级至修复版本。',
                fixedVersion: '2.0.1',
                asset: { customerName: '问答服务' },
                component: { name: '示例组件', version: '2.0.0' },
                fixedByRun: null,
                evidence: [{ sourceTool: 'Trivy', responseSummary: '{raw:true}' }],
              },
              {
                title: '未形成正式问题的孤立判断',
                advisoryId: 'CVE-2026-40002',
                severity: 'HIGH',
                confidence: 0.9,
                priority: 'P1',
                impactStatus: 'AFFECTED',
                evidenceLevel: 'VERSION_MATCH',
                findingId: null,
                reason: '判断记录未关联正式问题。',
                remediation: '补齐证据后重新核验。',
                fixedVersion: null,
                asset: { customerName: '问答服务' },
                component: { name: '示例组件', version: '2.0.0' },
                fixedByRun: null,
                evidence: [],
              },
              {
                title: '证据等级不足的异常判断',
                advisoryId: 'CVE-2026-40003',
                severity: 'CRITICAL',
                confidence: 0.5,
                priority: 'P2',
                impactStatus: 'AFFECTED',
                evidenceLevel: 'LEAD',
                findingId: 'weak-finding-db-id',
                reason: '只有组件名称线索。',
                remediation: '补充版本或配置证据。',
                fixedVersion: null,
                asset: { customerName: '问答服务' },
                component: { name: '疑似组件', version: null },
                fixedByRun: null,
                evidence: [],
              },
            ],
          },
        ];
      },
    },
  };

  const gathered = await gatherServiceAssuranceReportData(db as never, 'task-db-id', now);
  assert.equal(gathered.evaluatedTargetId, 'model-target-db-id');
  assert.equal(gathered.data.findings.length, 0);
  assert.equal(gathered.data.engineRuns.length, 0);
  assert.deepEqual(gathered.data.serviceAssurance?.assessments[0], {
    targetName: '政务问答 API',
    assetName: '问答服务',
    componentName: '示例组件',
    componentVersion: '2.0.0',
    advisoryId: 'CVE-2026-40001',
    title: '组件版本受影响',
    severity: 'HIGH',
    confidence: 0.95,
    priority: 'P1',
    impactStatus: 'AFFECTED',
    evidenceLabel: '组件和版本证据',
    reason: '版本位于受影响范围。',
    remediation: '升级至修复版本。',
    fixedVersion: '2.0.1',
    retestedAt: null,
  });
  assert.equal(gathered.data.serviceAssurance?.assessments[1]?.impactStatus, 'UNDER_INVESTIGATION');
  assert.equal(gathered.data.serviceAssurance?.assessments[2]?.impactStatus, 'UNDER_INVESTIGATION');
  assert.deepEqual(gathered.data.serviceAssurance?.runs[0]?.skippedItems, ['核验模式未就绪']);

  const queryText = JSON.stringify(captured);
  assert.match(queryText, /"findingId":true/);
  assert.doesNotMatch(
    queryText,
    /rawOutput|requestPayload|sourceTool|responseSummary|rulesetDigest|vulnerabilityDbDigest|engineVersions|credentialRef/,
  );
  const snapshotText = JSON.stringify(gathered.data.serviceAssurance);
  assert.doesNotMatch(
    snapshotText,
    /task-db-id|run-db-id|model-target-db-id|finding-db-id|weak-finding-db-id|raw-output-sentinel|Trivy|sha256:|\{raw:true\}/,
  );
});
