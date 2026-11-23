import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { toFormalFindingDraft } from './decision.js';
import {
  encodeExecutionCheck,
  EXECUTION_EVIDENCE_TYPE,
  encodeRequestTotal,
  REQUEST_TOTAL_EVIDENCE_TYPE,
} from './execution-evidence.js';
import type { NucleiNormalizationResult } from './contracts.js';

export type FormalFindingSource = Parameters<typeof toFormalFindingDraft>[0];

export type ServiceAssuranceEngineName =
  | 'service-assurance-nuclei'
  | 'service-assurance-trivy'
  | 'service-assurance-zap';

export interface PersistServiceAssuranceResultInput {
  runId: string;
  /** 未关联评估任务时为 null：此时不写 EngineRun / Finding，结论只保存在核验自身的表里。 */
  taskId: string | null;
  engineRunId: string | null;
  normalized: NucleiNormalizationResult;
  execution: {
    engineName: ServiceAssuranceEngineName;
    baselineKind: 'RULESET' | 'VULNERABILITY_DB';
    completed: boolean;
    durationMs: number;
    engineVersion: string | null;
    engineDigest: string | null;
    baselineVersion: string;
    baselineDigest: string;
    errorCode: string | null;
    errorMessage?: string | null;
  };
}

function stableFindingId(taskId: string, engine: string, suppressionKey: string): string {
  const bytes = createHash('sha256')
    .update(taskId)
    .update('\0')
    .update(engine)
    .update('\0')
    .update(suppressionKey)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function engineVersionKey(engineName: ServiceAssuranceEngineName): 'nuclei' | 'trivy' | 'zap' {
  if (engineName === 'service-assurance-trivy') return 'trivy';
  if (engineName === 'service-assurance-zap') return 'zap';
  return 'nuclei';
}

function runOutcome(inputs: PersistServiceAssuranceResultInput[]): {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  coverageStatus: 'COMPLETE' | 'INCOMPLETE' | 'NOT_READY';
} {
  const executionComplete = inputs.every(
    (input) => input.execution.completed && input.execution.errorCode === null,
  );
  const coverageStatus = inputs.every((input) => input.normalized.coverageStatus === 'COMPLETE')
    ? 'COMPLETE'
    : inputs.every((input) => input.normalized.coverageStatus === 'NOT_READY')
      ? 'NOT_READY'
      : 'INCOMPLETE';
  if (executionComplete) return { status: 'COMPLETED', coverageStatus };
  const hasCompletedScope = inputs.some(
    (input) => input.execution.completed || input.normalized.eventsProcessed > 0,
  );
  return { status: hasCompletedScope ? 'PARTIAL' : 'FAILED', coverageStatus };
}

/**
 * 为一条核验结论写入（或复用）评估任务下的正式 Finding。
 * 同一任务、同一引擎、同一抑制键共用稳定 ID；已被其他结论占用时记为历史关联。
 */
export async function attachFormalFinding(
  tx: Prisma.TransactionClient,
  taskId: string,
  assessmentId: string,
  assessment: FormalFindingSource,
): Promise<boolean> {
  const findingDraft = toFormalFindingDraft(assessment);
  if (!findingDraft) return false;
  const id = stableFindingId(taskId, findingDraft.engine, findingDraft.suppressionKey);
  const finding = await tx.finding.upsert({
    where: { id },
    create: {
      id,
      taskId,
      engine: findingDraft.engine,
      riskCategory: findingDraft.riskCategory,
      severity: findingDraft.severity,
      score: findingDraft.score,
      verdict: findingDraft.verdict,
      confidence: findingDraft.confidence,
      reviewStatus: findingDraft.reviewStatus,
      suppressionKey: findingDraft.suppressionKey,
      title: findingDraft.title,
      evidence: findingDraft.evidence,
      detail: findingDraft.detail as unknown as Prisma.InputJsonObject,
    },
    update: {},
    include: { assuranceAssessment: { select: { id: true } } },
  });
  const owned = finding.assuranceAssessment === null || finding.assuranceAssessment.id === assessmentId;
  await tx.vulnerabilityAssessment.update({
    where: { id: assessmentId },
    data: owned ? { findingId: finding.id } : { legacyFindingId: finding.id },
  });
  return true;
}

async function persistNormalizedResult(
  tx: Prisma.TransactionClient,
  input: PersistServiceAssuranceResultInput,
  endedAt: Date,
): Promise<void> {
  const assetIds = new Map<string, string>();
  for (const asset of input.normalized.assets) {
    const stored = await tx.serviceAsset.upsert({
      where: { runId_assetKey: { runId: input.runId, assetKey: asset.assetKey } },
      create: {
        runId: input.runId,
        customerName: asset.customerName,
        normalizedAddress: asset.normalizedAddress,
        protocol: asset.protocol,
        host: asset.host,
        port: asset.port,
        title: asset.title,
        assetKey: asset.assetKey,
      },
      update: {
        customerName: asset.customerName,
        normalizedAddress: asset.normalizedAddress,
        protocol: asset.protocol,
        host: asset.host,
        port: asset.port,
        title: asset.title,
      },
      select: { id: true },
    });
    assetIds.set(asset.assetKey, stored.id);
  }

  const componentIds = new Map<string, string>();
  for (const component of input.normalized.components) {
    const stored = await tx.serviceComponent.upsert({
      where: {
        runId_componentKey: { runId: input.runId, componentKey: component.componentKey },
      },
      create: {
        runId: input.runId,
        assetId: assetIds.get(component.assetKey) ?? null,
        name: component.name,
        vendor: component.vendor,
        version: component.version,
        purl: component.purl,
        cpe: component.cpe,
        hashes: component.hashes ?? Prisma.DbNull,
        source: component.source,
        confidence: component.confidence,
        evidenceLevel: component.evidenceLevel,
        componentKey: component.componentKey,
      },
      update: {
        assetId: assetIds.get(component.assetKey) ?? null,
        name: component.name,
        vendor: component.vendor,
        version: component.version,
        purl: component.purl,
        cpe: component.cpe,
        hashes: component.hashes ?? Prisma.DbNull,
        source: component.source,
        confidence: component.confidence,
        evidenceLevel: component.evidenceLevel,
      },
      select: { id: true },
    });
    componentIds.set(component.componentKey, stored.id);
  }

  const assessmentIds = new Map<string, string>();
  for (const assessment of input.normalized.assessments) {
    const values = {
      assetId: assetIds.get(assessment.assetKey) ?? null,
      componentId: assessment.componentKey
        ? (componentIds.get(assessment.componentKey) ?? null)
        : null,
      advisoryId: assessment.advisoryId,
      title: assessment.title,
      severity: assessment.severity,
      cvss: assessment.cvss,
      fixedVersion: assessment.fixedVersion,
      kev: assessment.kev,
      epss: assessment.epss,
      impactStatus: assessment.impactStatus,
      evidenceLevel: assessment.evidenceLevel,
      confidence: assessment.confidence,
      priority: assessment.priority,
      reason: assessment.reason,
      remediation: assessment.remediation,
    } satisfies Prisma.VulnerabilityAssessmentUncheckedUpdateInput;
    const stored = await tx.vulnerabilityAssessment.upsert({
      where: {
        runId_assessmentKey: { runId: input.runId, assessmentKey: assessment.assessmentKey },
      },
      create: {
        runId: input.runId,
        assessmentKey: assessment.assessmentKey,
        ...values,
      },
      update: values,
      select: { id: true },
    });
    assessmentIds.set(assessment.assessmentKey, stored.id);

    if (input.taskId) {
      await attachFormalFinding(tx, input.taskId, stored.id, assessment);
    }
  }

  for (const evidence of input.normalized.evidence) {
    const values = {
      assessmentId: assessmentIds.get(evidence.assessmentKey) ?? null,
      componentId: evidence.componentKey ? (componentIds.get(evidence.componentKey) ?? null) : null,
      sourceTool: evidence.sourceTool,
      ruleId: evidence.ruleId,
      ruleSummary: evidence.ruleSummary,
      matchedLocation: evidence.matchedLocation,
      extractedValue: evidence.extractedValue,
      customerSummary: evidence.customerSummary,
      requestSummary: evidence.requestSummary,
      responseSummary: evidence.responseSummary,
      visibility: evidence.visibility,
    } satisfies Prisma.ServiceEvidenceUncheckedUpdateInput;
    await tx.serviceEvidence.upsert({
      where: {
        runId_contentSha256_evidenceType: {
          runId: input.runId,
          contentSha256: evidence.contentSha256,
          evidenceType: evidence.evidenceType,
        },
      },
      create: {
        runId: input.runId,
        contentSha256: evidence.contentSha256,
        evidenceType: evidence.evidenceType,
        ...values,
      },
      update: values,
    });
  }

  for (const check of input.normalized.execution?.checks ?? []) {
    const encoded = encodeExecutionCheck(check);
    const contentSha256 = createHash('sha256')
      .update(`${input.execution.engineName}\0${check.id}`)
      .digest('hex');
    const values = {
      sourceTool: input.execution.engineName,
      ruleId: check.id,
      ruleSummary: JSON.parse(encoded).label as string,
      customerSummary: JSON.parse(encoded).detail as string,
      extractedValue: encoded,
      visibility: 'CUSTOMER' as const,
    };
    await tx.serviceEvidence.upsert({
      where: {
        runId_contentSha256_evidenceType: {
          runId: input.runId,
          contentSha256,
          evidenceType: EXECUTION_EVIDENCE_TYPE,
        },
      },
      create: {
        runId: input.runId,
        contentSha256,
        evidenceType: EXECUTION_EVIDENCE_TYPE,
        ...values,
      },
      update: values,
    });
  }

  if (!input.engineRunId) return;
  await tx.engineRun.update({
    where: { id: input.engineRunId },
    data: {
      status: input.execution.completed && input.execution.errorCode === null ? 'SUCCESS' : 'ERROR',
      endedAt,
      durationMs: input.execution.durationMs,
      rawOutput: null,
      normalizedCount: input.normalized.assessments.length,
      errorMessage: input.execution.errorMessage ?? input.execution.errorCode,
    },
  });
}

export async function persistServiceAssuranceResult(
  input: PersistServiceAssuranceResultInput,
): Promise<void> {
  await persistServiceAssuranceResults([input]);
}

export async function persistServiceAssuranceResults(
  inputs: PersistServiceAssuranceResultInput[],
): Promise<void> {
  const first = inputs[0];
  if (!first) throw new Error('服务安全核验没有可持久化的引擎结果');
  if (inputs.some((input) => input.runId !== first.runId || input.taskId !== first.taskId)) {
    throw new Error('服务安全核验多引擎结果不属于同一运行');
  }
  const endedAt = new Date();
  const outcome = runOutcome(inputs);

  await prisma.$transaction(async (tx) => {
    const run = await tx.serviceAssuranceRun.findFirst({
      where: { id: first.runId, taskId: first.taskId },
      select: { id: true, status: true, engineVersions: true },
    });
    if (!run) throw new Error('服务安全核验运行与评估任务不匹配');

    for (const input of inputs) {
      if (input.taskId === null && input.engineRunId === null) continue;
      if (!input.taskId || !input.engineRunId) {
        throw new Error('服务安全核验运行与评估任务不匹配');
      }
      const engineRun = await tx.engineRun.findFirst({
        where: {
          id: input.engineRunId,
          taskId: input.taskId,
          engine: input.execution.engineName,
        },
        select: { id: true },
      });
      if (!engineRun) throw new Error('服务安全核验运行与评估任务不匹配');
    }

    if (run.status === 'CANCELED') {
      await tx.engineRun.updateMany({
        where: {
          id: { in: inputs.flatMap((input) => (input.engineRunId ? [input.engineRunId] : [])) },
          status: { in: ['PENDING', 'RUNNING'] },
        },
        data: {
          status: 'SKIPPED',
          endedAt,
          rawOutput: null,
          normalizedCount: 0,
          errorMessage: null,
        },
      });
      return;
    }

    for (const input of inputs) {
      await persistNormalizedResult(tx, input, endedAt);
    }

    const observedCounts = inputs.map((input) => input.normalized.execution?.requestCount);
    const total = observedCounts.every((count) => typeof count === 'number')
      ? observedCounts.reduce<number>((sum, count) => sum + count!, 0)
      : null;
    const totalEvidence = {
      sourceTool: 'service-assurance',
      ruleId: null,
      ruleSummary: '本次运行实际请求总数',
      customerSummary:
        total === null
          ? '存在未采集计数的引擎，不能确认请求总数。'
          : `各引擎实际观测的请求共 ${total} 次；请求数量不代表检查覆盖完整。`,
      extractedValue: encodeRequestTotal(total),
      visibility: 'CUSTOMER' as const,
    };
    const totalHash = createHash('sha256').update(`${first.runId}:request-total`).digest('hex');
    await tx.serviceEvidence.upsert({
      where: {
        runId_contentSha256_evidenceType: {
          runId: first.runId,
          contentSha256: totalHash,
          evidenceType: REQUEST_TOTAL_EVIDENCE_TYPE,
        },
      },
      create: {
        runId: first.runId,
        contentSha256: totalHash,
        evidenceType: REQUEST_TOTAL_EVIDENCE_TYPE,
        ...totalEvidence,
      },
      update: totalEvidence,
    });

    const engineVersions: Record<string, { version: string; digest: string }> = {};
    if (
      run.engineVersions &&
      typeof run.engineVersions === 'object' &&
      !Array.isArray(run.engineVersions)
    ) {
      for (const [key, value] of Object.entries(run.engineVersions)) {
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          typeof value.version === 'string' &&
          typeof value.digest === 'string'
        ) {
          engineVersions[key] = { version: value.version, digest: value.digest };
        }
      }
    }
    for (const input of inputs) {
      if (input.execution.engineVersion && input.execution.engineDigest) {
        engineVersions[engineVersionKey(input.execution.engineName)] = {
          version: input.execution.engineVersion,
          digest: input.execution.engineDigest,
        };
      }
    }
    const ruleset = inputs.find((input) => input.execution.baselineKind === 'RULESET');
    const vulnerabilityDb = inputs.find(
      (input) => input.execution.baselineKind === 'VULNERABILITY_DB',
    );
    const failure = inputs.find((input) => input.execution.errorCode !== null);
    const incomplete = inputs.find((input) => input.normalized.coverageStatus !== 'COMPLETE');
    await tx.serviceAssuranceRun.updateMany({
      where: { id: first.runId, status: { not: 'CANCELED' } },
      data: {
        status: outcome.status,
        coverageStatus: outcome.coverageStatus,
        failureCode: failure?.execution.errorCode ?? null,
        failureMessage:
          outcome.status === 'COMPLETED'
            ? null
            : outcome.status === 'FAILED'
              ? (failure?.execution.errorMessage ??
                incomplete?.normalized.customerSummary.statusMessage ??
                '核验未完成。')
              : (incomplete?.normalized.customerSummary.statusMessage ??
                '核验未完成或覆盖不完整。'),
        rulesetVersion: ruleset?.execution.baselineVersion ?? null,
        rulesetDigest: ruleset?.execution.baselineDigest ?? null,
        vulnerabilityDbVersion: vulnerabilityDb?.execution.baselineVersion ?? null,
        vulnerabilityDbDigest: vulnerabilityDb?.execution.baselineDigest ?? null,
        engineVersions: engineVersions as Prisma.InputJsonObject,
        endedAt,
      },
    });
  });
}
