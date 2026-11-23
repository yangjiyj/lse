import { type AssuranceEvidenceLevel, type Prisma } from '@prisma/client';
import { notFound } from '../../lib/errors.js';
import type { ReportInputData } from './report-builder.js';

const TASK_SELECT = {
  id: true,
  name: true,
  description: true,
  status: true,
  concurrency: true,
  totalQuestions: true,
  processedQuestions: true,
  passedCount: true,
  failedCount: true,
  errorCount: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  modelTarget: { select: { id: true } },
} as const;

export const SERVICE_ASSURANCE_REPORT_RUN_SELECT = {
  targetName: true,
  mode: true,
  status: true,
  coverageStatus: true,
  rulesetVersion: true,
  vulnerabilityDbVersion: true,
  startedAt: true,
  endedAt: true,
  failureMessage: true,
  assessments: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      title: true,
      advisoryId: true,
      severity: true,
      confidence: true,
      priority: true,
      impactStatus: true,
      evidenceLevel: true,
      findingId: true,
      reason: true,
      remediation: true,
      fixedVersion: true,
      asset: { select: { customerName: true } },
      component: { select: { name: true, version: true } },
      fixedByRun: { select: { endedAt: true } },
    },
  },
} as const;

function evidenceLabel(level: AssuranceEvidenceLevel): string {
  switch (level) {
    case 'LEAD':
      return '待核验线索';
    case 'VERSION_MATCH':
      return '组件和版本证据';
    case 'CONFIG_MATCH':
      return '配置命中证据';
    case 'ACTIVE_VERIFIED':
      return '授权主动验证证据';
  }
}

export interface GatheredServiceAssuranceReportData {
  data: ReportInputData;
  evaluatedTargetId: string;
}

export async function gatherServiceAssuranceReportData(
  db: Prisma.TransactionClient,
  taskId: string,
  generatedAt: Date,
): Promise<GatheredServiceAssuranceReportData> {
  const task = await db.evalTask.findUnique({
    where: { id: taskId },
    select: TASK_SELECT,
  });
  if (!task) throw notFound('评估任务不存在');

  const runs = await db.serviceAssuranceRun.findMany({
    where: { taskId },
    select: SERVICE_ASSURANCE_REPORT_RUN_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  return {
    evaluatedTargetId: task.modelTarget.id,
    data: {
      task: {
        id: task.id,
        name: task.name,
        description: task.description,
        status: task.status,
        concurrency: task.concurrency,
        engines: [],
        expectedEngines: [],
        dimensions: [],
        totalQuestions: task.totalQuestions,
        processedQuestions: task.processedQuestions,
        passedCount: task.passedCount,
        failedCount: task.failedCount,
        errorCount: task.errorCount,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        modelTarget: null,
        questionSets: [],
      },
      verdictCounts: {},
      findings: [],
      engineRuns: [],
      wrongAnswers: [],
      results: [],
      generatedAt,
      serviceAssurance: {
        schemaVersion: 1,
        runs: runs.map((run) => ({
          targetName: run.targetName,
          mode: run.mode,
          status: run.status,
          coverageStatus: run.coverageStatus,
          rulesBaseline: run.rulesetVersion,
          vulnerabilityBaseline: run.vulnerabilityDbVersion,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          skippedItems:
            run.coverageStatus === 'NOT_READY'
              ? ['核验模式未就绪']
              : run.status === 'PARTIAL' || run.coverageStatus === 'INCOMPLETE'
                ? ['部分检查项未完成']
                : [],
          limitations: run.failureMessage ? [run.failureMessage] : [],
        })),
        assessments: runs.flatMap((run) =>
          run.assessments.map((assessment) => ({
            targetName: run.targetName,
            assetName: assessment.asset?.customerName ?? run.targetName,
            componentName: assessment.component?.name ?? null,
            componentVersion: assessment.component?.version ?? null,
            advisoryId: assessment.advisoryId,
            title: assessment.title,
            severity: assessment.severity,
            confidence: assessment.confidence,
            priority: assessment.priority,
            impactStatus:
              assessment.impactStatus === 'AFFECTED' &&
              (assessment.evidenceLevel === 'LEAD' || !assessment.findingId)
                ? 'UNDER_INVESTIGATION'
                : assessment.impactStatus,
            evidenceLabel: evidenceLabel(assessment.evidenceLevel),
            reason: assessment.reason,
            remediation: assessment.remediation,
            fixedVersion: assessment.fixedVersion,
            retestedAt: assessment.fixedByRun?.endedAt ?? null,
          })),
        ),
      },
    },
  };
}
