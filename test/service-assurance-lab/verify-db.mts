import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

interface LabState {
  taskId: string;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const state = JSON.parse(
  await readFile(required('SERVICE_ASSURANCE_E2E_STATE_FILE'), 'utf8'),
) as LabState;
const sentinel = required('SERVICE_ASSURANCE_E2E_SENTINEL');
const runtimeDir = required('SERVICE_ASSURANCE_E2E_RUNTIME_DIR');
const prisma = new PrismaClient();

try {
  const [runs, evidence, engineRuns, findings, audits, reports] = await Promise.all([
    prisma.serviceAssuranceRun.findMany({
      where: { taskId: state.taskId },
      select: {
        mode: true,
        status: true,
        coverageStatus: true,
        targetName: true,
        credentialRef: true,
        failureCode: true,
        failureMessage: true,
        requestBudget: true,
        engineVersions: true,
      },
    }),
    prisma.serviceEvidence.findMany({
      where: { run: { taskId: state.taskId } },
      select: {
        evidenceType: true,
        ruleId: true,
        ruleSummary: true,
        matchedLocation: true,
        extractedValue: true,
        customerSummary: true,
        requestSummary: true,
        responseSummary: true,
        contentSha256: true,
      },
    }),
    prisma.engineRun.findMany({
      where: { taskId: state.taskId, engine: { startsWith: 'service-assurance-' } },
      select: {
        status: true,
        requestPayload: true,
        rawOutput: true,
        errorMessage: true,
        normalizedCount: true,
      },
    }),
    prisma.finding.findMany({
      where: { taskId: state.taskId },
      select: {
        title: true,
        evidence: true,
        detail: true,
        reviewReason: true,
        severity: true,
      },
    }),
    prisma.auditLog.findMany({
      where: {
        OR: [
          { action: { startsWith: 'service_assurance.' } },
          { action: 'report.generate', detail: { path: ['taskId'], equals: state.taskId } },
        ],
      },
      select: { action: true, targetType: true, detail: true, userAgent: true },
    }),
    prisma.report.findMany({
      where: { taskId: state.taskId, kind: 'service_assurance' },
      select: {
        title: true,
        content: true,
        summary: true,
        listSummary: true,
        riskDistribution: true,
      },
    }),
  ]);

  assert.ok(runs.some((run) => run.mode === 'SAFE'));
  assert.ok(runs.some((run) => run.mode === 'DEEP'));
  assert.ok(runs.some((run) => run.mode === 'SBOM'));
  assert.ok(runs.every((run) => run.credentialRef === null));
  assert.ok(engineRuns.length > 0);
  assert.ok(engineRuns.every((run) => run.rawOutput === null));
  assert.ok(findings.length > 0);
  assert.ok(reports.length > 0);

  const persistedBoundary = JSON.stringify({
    runs,
    evidence,
    engineRuns,
    findings,
    audits,
    reports,
  });
  assert.ok(!persistedBoundary.includes(sentinel), 'sentinel leaked into persisted assurance data');
  const deliveryBoundary = JSON.stringify(reports);
  assert.doesNotMatch(
    deliveryBoundary,
    /\b(?:AIG|Nuclei|ZAP|Trivy)\b|service-assurance|raw\s*json|session\s*id|container|\/opt\/|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );

  const modeCounts = Object.fromEntries(
    ['SAFE', 'DEEP', 'SBOM'].map((mode) => [mode, runs.filter((run) => run.mode === mode).length]),
  );
  await writeFile(
    path.join(runtimeDir, 'database-verification.json'),
    `${JSON.stringify(
      {
        modeCounts,
        runCount: runs.length,
        evidenceCount: evidence.length,
        findingCount: findings.length,
        reportCount: reports.length,
        rawOutputNonNull: engineRuns.filter((run) => run.rawOutput !== null).length,
        sentinelMatches: 0,
      },
      null,
      2,
    )}\n`,
  );
  console.log('[ok] database, report and sentinel persistence boundaries passed');
} finally {
  await prisma.$disconnect();
}
