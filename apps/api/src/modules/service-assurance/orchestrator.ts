import { Prisma } from '@prisma/client';
import { getServiceAssurancePlannedChecks } from '@lse/shared';
import { prisma } from '../../db.js';
import { isServiceAssuranceCancelRequested } from '../../lib/queue.js';
import {
  resolveAndAuthorizeTarget,
  ScannerScopeError,
  type ResolvedScannerTarget,
  type ScannerScopePolicy,
} from '../../lib/scanner-scope.js';
import { ScannerClientError } from './adapters/client.js';
import {
  buildNucleiScanRequest,
  executeNucleiScan,
  type NucleiRulesetBaseline,
  type NucleiScanRequest,
  type NucleiScanResponse,
} from './adapters/nuclei.js';
import {
  buildTrivyScanRequest,
  executeTrivyScan,
  type TrivyScanRequest,
  type TrivyScanResponse,
  type TrivyVulnerabilityDbBaseline,
} from './adapters/trivy.js';
import {
  buildZapScanRequest,
  executeZapScan,
  ZAP_ACTIVE_RULE_IDS,
  type ZapScanRequest,
  type ZapScanResponse,
} from './adapters/zap.js';
import type { NucleiNormalizationResult } from './contracts.js';
import { normalizeNucleiJsonl } from './normalize/nuclei.js';
import { normalizeTrivyJson } from './normalize/trivy.js';
import { normalizeZapJson } from './normalize/zap.js';
import {
  persistServiceAssuranceResult,
  persistServiceAssuranceResults,
  type PersistServiceAssuranceResultInput,
  type ServiceAssuranceEngineName,
} from './persist.js';
import {
  SbomChannelError,
  takeServiceAssuranceSbom,
  type ServiceAssuranceSbomUpload,
} from './sbom-channel.js';
import { parseScopePolicySnapshot, resolveManagedScopePolicy } from './scope-policies.js';

const NUCLEI_ENGINE_NAME = 'service-assurance-nuclei';
const TRIVY_ENGINE_NAME = 'service-assurance-trivy';
const ZAP_ENGINE_NAME = 'service-assurance-zap';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface NucleiRuntime {
  baseUrl: string;
  expectedEngineDigest: string;
  ruleset: NucleiRulesetBaseline;
}

export interface TrivyRuntime {
  baseUrl: string;
  expectedEngineDigest: string;
  vulnerabilityDb: TrivyVulnerabilityDbBaseline;
}

export interface ZapRuntime {
  baseUrl: string;
  expectedEngineDigest: string;
  ruleset: NucleiRulesetBaseline;
}

export interface ServiceAssuranceOrchestratorDependencies {
  loadNucleiRuntime: () => NucleiRuntime;
  resolveScopePolicy: (ref: string) => ScannerScopePolicy | Promise<ScannerScopePolicy>;
  resolveTarget: (rawUrl: string, policy: ScannerScopePolicy) => Promise<ResolvedScannerTarget>;
  executeNuclei: (
    request: NucleiScanRequest,
    runtime: NucleiRuntime,
  ) => Promise<NucleiScanResponse>;
  loadTrivyRuntime: () => TrivyRuntime;
  executeTrivy: (request: TrivyScanRequest, runtime: TrivyRuntime) => Promise<TrivyScanResponse>;
  loadZapRuntime: () => ZapRuntime;
  executeZap: (request: ZapScanRequest, runtime: ZapRuntime) => Promise<ZapScanResponse>;
  takeSbom: (runId: string) => Promise<ServiceAssuranceSbomUpload>;
  isCancelRequested: (runId: string) => Promise<boolean>;
  now?: () => Date;
}

export class ServiceAssuranceExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceAssuranceExecutionError';
  }
}

function scannerRuntime(input: {
  baseUrl: string;
  expectedEngineDigest: string;
  baselineVersion: string;
  baselineDigest: string;
}): {
  baseUrl: string;
  expectedEngineDigest: string;
  baseline: NucleiRulesetBaseline;
} {
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !input.baselineVersion ||
    !DIGEST_PATTERN.test(input.expectedEngineDigest) ||
    !DIGEST_PATTERN.test(input.baselineDigest)
  ) {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID');
  }
  return {
    baseUrl: url.toString(),
    expectedEngineDigest: input.expectedEngineDigest,
    baseline: {
      version: input.baselineVersion,
      digest: input.baselineDigest,
    },
  };
}

export function loadNucleiRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): NucleiRuntime {
  const runtime = scannerRuntime({
    baseUrl: env.SERVICE_ASSURANCE_NUCLEI_URL?.trim() ?? '',
    expectedEngineDigest: env.SERVICE_ASSURANCE_NUCLEI_ENGINE_DIGEST?.trim() ?? '',
    baselineVersion: env.SERVICE_ASSURANCE_NUCLEI_RULESET_VERSION?.trim() ?? '',
    baselineDigest: env.SERVICE_ASSURANCE_NUCLEI_RULESET_DIGEST?.trim() ?? '',
  });
  return { ...runtime, ruleset: runtime.baseline };
}

export function loadZapRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): ZapRuntime {
  const runtime = scannerRuntime({
    baseUrl: env.SERVICE_ASSURANCE_ZAP_URL?.trim() ?? '',
    expectedEngineDigest: env.SERVICE_ASSURANCE_ZAP_ENGINE_DIGEST?.trim() ?? '',
    baselineVersion:
      env.SERVICE_ASSURANCE_ZAP_RULESET_VERSION?.trim() ??
      env.SERVICE_ASSURANCE_NUCLEI_RULESET_VERSION?.trim() ??
      '',
    baselineDigest:
      env.SERVICE_ASSURANCE_ZAP_RULESET_DIGEST?.trim() ??
      env.SERVICE_ASSURANCE_NUCLEI_RULESET_DIGEST?.trim() ??
      '',
  });
  return { ...runtime, ruleset: runtime.baseline };
}

export function loadTrivyRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): TrivyRuntime {
  const baseUrl = env.SERVICE_ASSURANCE_TRIVY_URL?.trim() ?? '';
  const expectedEngineDigest = env.SERVICE_ASSURANCE_TRIVY_ENGINE_DIGEST?.trim() ?? '';
  const vulnerabilityDbVersion = env.SERVICE_ASSURANCE_TRIVY_DB_VERSION?.trim() ?? '';
  const vulnerabilityDbDigest = env.SERVICE_ASSURANCE_TRIVY_DB_DIGEST?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !vulnerabilityDbVersion ||
    !DIGEST_PATTERN.test(expectedEngineDigest) ||
    !DIGEST_PATTERN.test(vulnerabilityDbDigest)
  ) {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID');
  }
  return {
    baseUrl: url.toString(),
    expectedEngineDigest,
    vulnerabilityDb: {
      version: vulnerabilityDbVersion,
      digest: vulnerabilityDbDigest,
    },
  };
}

const defaultDependencies: ServiceAssuranceOrchestratorDependencies = {
  loadNucleiRuntime: loadNucleiRuntimeFromEnv,
  resolveScopePolicy: (ref) => resolveManagedScopePolicy(ref),
  resolveTarget: (rawUrl, policy) => resolveAndAuthorizeTarget(rawUrl, policy),
  executeNuclei: (request, runtime) =>
    executeNucleiScan(request, {
      baseUrl: runtime.baseUrl,
      expectedEngineDigest: runtime.expectedEngineDigest,
    }),
  loadTrivyRuntime: loadTrivyRuntimeFromEnv,
  executeTrivy: (request, runtime) =>
    executeTrivyScan(request, {
      baseUrl: runtime.baseUrl,
      expectedEngineDigest: runtime.expectedEngineDigest,
    }),
  loadZapRuntime: loadZapRuntimeFromEnv,
  executeZap: (request, runtime) =>
    executeZapScan(request, {
      baseUrl: runtime.baseUrl,
      expectedEngineDigest: runtime.expectedEngineDigest,
    }),
  takeSbom: takeServiceAssuranceSbom,
  isCancelRequested: isServiceAssuranceCancelRequested,
};

function safeFailure(error: unknown): { code: string; message: string; exposed: Error } {
  if (
    error instanceof ScannerClientError ||
    error instanceof ScannerScopeError ||
    error instanceof SbomChannelError ||
    error instanceof ServiceAssuranceExecutionError
  ) {
    return { code: error.code, message: error.message, exposed: error };
  }
  const exposed = new ServiceAssuranceExecutionError(
    'SERVICE_ASSURANCE_EXECUTION_FAILED',
    '核验执行失败，覆盖不完整。',
  );
  return { code: exposed.code, message: exposed.message, exposed };
}

function assertPinnedBaseline(
  stored: { version: string | null; digest: string | null },
  runtime: { version: string; digest: string },
): void {
  if (stored.version !== runtime.version || stored.digest !== runtime.digest) {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH');
  }
}

async function markCanceled(
  runId: string,
  engineRunIds: string[],
  startedAt: Date,
  endedAt: Date,
): Promise<void> {
  await prisma.$transaction([
    prisma.serviceAssuranceRun.updateMany({
      where: { id: runId, status: { in: ['PENDING', 'RUNNING'] } },
      data: {
        status: 'CANCELED',
        coverageStatus: 'INCOMPLETE',
        failureCode: 'SERVICE_ASSURANCE_CANCELED',
        failureMessage: '核验已取消，覆盖不完整。',
        canceledAt: endedAt,
        endedAt,
      },
    }),
    prisma.engineRun.updateMany({
      where: { id: { in: engineRunIds }, status: { in: ['PENDING', 'RUNNING'] } },
      data: {
        status: 'SKIPPED',
        endedAt,
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        rawOutput: null,
        normalizedCount: 0,
        errorMessage: null,
      },
    }),
  ]);
}

async function markFailed(
  runId: string,
  engineRunIds: string[],
  startedAt: Date,
  endedAt: Date,
  failure: { code: string; message: string },
): Promise<void> {
  await prisma.$transaction([
    prisma.serviceAssuranceRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        coverageStatus: 'INCOMPLETE',
        failureCode: failure.code,
        failureMessage: failure.message,
        endedAt,
      },
    }),
    prisma.engineRun.updateMany({
      where: { id: { in: engineRunIds }, status: { in: ['PENDING', 'RUNNING'] } },
      data: {
        status: 'ERROR',
        endedAt,
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        rawOutput: null,
        normalizedCount: 0,
        errorMessage: failure.message,
      },
    }),
  ]);
}

function failedNormalization(
  mode: 'SAFE' | 'DEEP' | 'SBOM',
  failure: { code: string; message: string },
): NucleiNormalizationResult {
  return {
    mode,
    coverageStatus: 'INCOMPLETE',
    invalidLineCount: 0,
    eventsProcessed: 0,
    assets: [],
    components: [],
    assessments: [],
    evidence: [],
    notices: [{ code: failure.code, message: failure.message }],
    customerSummary: {
      confirmed: 0,
      underInvestigation: 0,
      notAffected: 0,
      fixed: 0,
      incomplete: true,
      statusMessage: '核验未完成或覆盖不完整。',
    },
  };
}

function failedResult(input: {
  runId: string;
  taskId: string | null;
  mode: 'SAFE' | 'DEEP';
  engineRunId: string | null;
  engineName: ServiceAssuranceEngineName;
  baseline: NucleiRulesetBaseline;
  failure: { code: string; message: string };
  durationMs: number;
}): PersistServiceAssuranceResultInput {
  return {
    runId: input.runId,
    taskId: input.taskId,
    engineRunId: input.engineRunId,
    normalized: failedNormalization(input.mode, input.failure),
    execution: {
      engineName: input.engineName,
      baselineKind: 'RULESET',
      completed: false,
      durationMs: input.durationMs,
      engineVersion: null,
      engineDigest: null,
      baselineVersion: input.baseline.version,
      baselineDigest: input.baseline.digest,
      errorCode: input.failure.code,
      errorMessage: input.failure.message,
    },
  };
}

export async function executeServiceAssuranceRun(
  runId: string,
  dependencies: Partial<ServiceAssuranceOrchestratorDependencies> = {},
): Promise<void> {
  const deps = { ...defaultDependencies, ...dependencies };
  const now = deps.now ?? (() => new Date());
  const run = await prisma.serviceAssuranceRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      taskId: true,
      mode: true,
      targetKind: true,
      normalizedTarget: true,
      scopePolicyRef: true,
      scopePolicySnapshot: true,
      scopePolicyDigest: true,
      authorizationConfirmed: true,
      rulesetVersion: true,
      rulesetDigest: true,
      vulnerabilityDbVersion: true,
      vulnerabilityDbDigest: true,
      status: true,
    },
  });
  if (!run) {
    throw new ServiceAssuranceExecutionError(
      'SERVICE_ASSURANCE_RUN_NOT_FOUND',
      '服务安全核验运行不存在。',
    );
  }
  if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELED', 'RUNNING'].includes(run.status)) return;

  const startedAt = now();
  const claimed = await prisma.serviceAssuranceRun.updateMany({
    where: { id: run.id, status: 'PENDING' },
    data: {
      status: 'RUNNING',
      coverageStatus: 'INCOMPLETE',
      failureCode: null,
      failureMessage: null,
      startedAt,
    },
  });
  if (claimed.count !== 1) return;

  const engineNames: ServiceAssuranceEngineName[] =
    run.mode === 'SBOM'
      ? [TRIVY_ENGINE_NAME]
      : run.targetKind === 'OPENAPI'
        ? [NUCLEI_ENGINE_NAME, ZAP_ENGINE_NAME]
        : [NUCLEI_ENGINE_NAME];
  // 未关联评估任务的核验不写 EngineRun（其 taskId 非空），执行记录只保存在核验自身的证据中。
  const taskId = run.taskId;
  const engineRuns = !taskId
    ? []
    : await prisma.$transaction(
    engineNames.map((engine) =>
      prisma.engineRun.create({
        data: {
          taskId,
          engine,
          status: 'RUNNING',
          startedAt,
          requestPayload: {
            schemaVersion: 1,
            serviceAssuranceRunId: run.id,
            mode: run.mode,
            targetKind: run.targetKind,
          } as Prisma.InputJsonObject,
          rawOutput: null,
        },
      }),
    ),
  );
  const engineRunIds = new Map(engineRuns.map((item) => [item.engine, item.id]));
  const engineRunId = { get: (engine: string): string | null => engineRunIds.get(engine) ?? null };
  const allEngineRunIds = engineRuns.map((item) => item.id);

  if (await deps.isCancelRequested(run.id)) {
    if (run.mode === 'SBOM') {
      try {
        await deps.takeSbom(run.id);
      } catch {
        // The short TTL remains the fallback if the cleanup channel is unavailable.
      }
    }
    await markCanceled(run.id, allEngineRunIds, startedAt, now());
    return;
  }

  if (run.mode === 'SBOM') {
    const trivyEngineRunId = engineRunId.get(TRIVY_ENGINE_NAME);
    try {
      if (run.targetKind !== 'SBOM' || run.normalizedTarget !== null) {
        throw new ServiceAssuranceExecutionError(
          'SERVICE_ASSURANCE_MODE_NOT_READY',
          '当前核验模式尚未就绪。',
        );
      }
      const runtime = deps.loadTrivyRuntime();
      assertPinnedBaseline(
        {
          version: run.vulnerabilityDbVersion,
          digest: run.vulnerabilityDbDigest,
        },
        runtime.vulnerabilityDb,
      );
      const upload = await deps.takeSbom(run.id);
      const request = buildTrivyScanRequest({
        sbom: upload.parsed,
        content: upload.content,
        vulnerabilityDb: runtime.vulnerabilityDb,
      });
      const response = await deps.executeTrivy(request, runtime);
      const normalized = normalizeTrivyJson(response.outputJson, upload.parsed, {
        completed: response.completed,
        vulnerabilityDbStatus: response.vulnerabilityDbStatus,
        vulnerabilityDbVersion: response.vulnerabilityDbVersion,
        vulnerabilityDbDigest: response.vulnerabilityDbDigest,
        advisoryQueryCompleted: response.advisoryQueryCompleted,
        advisoryRecords: response.advisoryRecords,
        advisoryRecordsSha256: response.advisoryRecordsSha256,
      });
      normalized.execution = {
        requestCount: 0,
        checks: [
          {
            id: 'sbom-components',
            label: '组件身份与版本核对',
            status: 'COMPLETED',
            requestCount: 0,
            detail: `已解析上传清单中的 ${upload.parsed.components.length} 个组件条目；身份或版本缺失会在结果中单独标记。`,
          },
          {
            id: 'sbom-advisories',
            label: '已知漏洞匹配',
            status: !response.completed
              ? 'FAILED'
              : response.advisoryQueryCompleted
                ? 'COMPLETED'
                : 'UNKNOWN',
            requestCount: 0,
            detail: !response.completed
              ? '固定漏洞库核对未完整执行。'
              : response.advisoryQueryCompleted
                ? '已完成固定本地漏洞库查询；没有匹配公告不代表已证明不受影响。'
                : '未取得完整公告查询证据，相关组件需补充核验。',
          },
        ],
      };
      if (await deps.isCancelRequested(run.id)) {
        await markCanceled(run.id, allEngineRunIds, startedAt, now());
        return;
      }
      await persistServiceAssuranceResult({
        runId: run.id,
        taskId: run.taskId,
        engineRunId: trivyEngineRunId,
        normalized,
        execution: {
          engineName: TRIVY_ENGINE_NAME,
          baselineKind: 'VULNERABILITY_DB',
          completed: response.completed,
          durationMs: response.durationMs,
          engineVersion: response.engineVersion,
          engineDigest: response.engineDigest,
          baselineVersion: response.vulnerabilityDbVersion,
          baselineDigest: response.vulnerabilityDbDigest,
          errorCode: response.errorCode,
        },
      });
      return;
    } catch (error) {
      const failure = safeFailure(error);
      await markFailed(run.id, allEngineRunIds, startedAt, now(), failure);
      throw failure.exposed;
    }
  }

  if (
    run.targetKind === 'SBOM' ||
    !run.normalizedTarget ||
    !run.rulesetVersion ||
    !run.rulesetDigest
  ) {
    const failure = safeFailure(
      new ServiceAssuranceExecutionError(
        'SERVICE_ASSURANCE_MODE_NOT_READY',
        '当前核验模式尚未就绪。',
      ),
    );
    await markFailed(run.id, allEngineRunIds, startedAt, now(), failure);
    throw failure.exposed;
  }

  const baseline = { version: run.rulesetVersion, digest: run.rulesetDigest };
  const results: PersistServiceAssuranceResultInput[] = [];
  const failures: Array<{ code: string; message: string; exposed: Error }> = [];
  let nucleiRuntime: NucleiRuntime | null = null;
  let zapRuntime: ZapRuntime | null = null;

  try {
    const candidate = deps.loadNucleiRuntime();
    assertPinnedBaseline(baseline, candidate.ruleset);
    nucleiRuntime = candidate;
  } catch (error) {
    const failure = safeFailure(error);
    failures.push(failure);
    results.push(
      failedResult({
        runId: run.id,
        taskId: run.taskId,
        mode: run.mode,
        engineRunId: engineRunId.get(NUCLEI_ENGINE_NAME),
        engineName: NUCLEI_ENGINE_NAME,
        baseline,
        failure,
        durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
      }),
    );
  }

  if (run.targetKind === 'OPENAPI') {
    try {
      const candidate = deps.loadZapRuntime();
      assertPinnedBaseline(baseline, candidate.ruleset);
      zapRuntime = candidate;
    } catch (error) {
      const failure = safeFailure(error);
      failures.push(failure);
      results.push(
        failedResult({
          runId: run.id,
          taskId: run.taskId,
          mode: run.mode,
          engineRunId: engineRunId.get(ZAP_ENGINE_NAME),
          engineName: ZAP_ENGINE_NAME,
          baseline,
          failure,
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
        }),
      );
    }
  }

  if (!nucleiRuntime && !zapRuntime) {
    await persistServiceAssuranceResults(results);
    throw failures[0]!.exposed;
  }

  let target: ResolvedScannerTarget;
  try {
    const policy = run.scopePolicySnapshot
      ? parseScopePolicySnapshot(run.scopePolicyRef, run.scopePolicySnapshot, run.scopePolicyDigest)
      : await deps.resolveScopePolicy(run.scopePolicyRef);
    target = await deps.resolveTarget(run.normalizedTarget, policy);
  } catch (error) {
    const failure = safeFailure(error);
    await markFailed(run.id, allEngineRunIds, startedAt, now(), failure);
    throw failure.exposed;
  }

  if (nucleiRuntime) {
    try {
      const request = buildNucleiScanRequest({
        mode: run.mode,
        targetKind: run.targetKind,
        authorizationConfirmed: run.authorizationConfirmed,
        target,
        ruleset: nucleiRuntime.ruleset,
      });
      const response = await deps.executeNuclei(request, nucleiRuntime);
      const normalized = normalizeNucleiJsonl(response.outputJsonl, {
        mode: run.mode,
        authorizationConfirmed: run.authorizationConfirmed,
        completed: response.completed,
        rulesetStatus: response.rulesetStatus,
        execution: response.execution,
      });
      results.push({
        runId: run.id,
        taskId: run.taskId,
        engineRunId: engineRunId.get(NUCLEI_ENGINE_NAME),
        normalized,
        execution: {
          engineName: NUCLEI_ENGINE_NAME,
          baselineKind: 'RULESET',
          completed: response.completed,
          durationMs: response.durationMs,
          engineVersion: response.engineVersion,
          engineDigest: response.engineDigest,
          baselineVersion: response.rulesetVersion,
          baselineDigest: response.rulesetDigest,
          errorCode: response.errorCode,
        },
      });
    } catch (error) {
      const failure = safeFailure(error);
      failures.push(failure);
      results.push(
        failedResult({
          runId: run.id,
          taskId: run.taskId,
          mode: run.mode,
          engineRunId: engineRunId.get(NUCLEI_ENGINE_NAME),
          engineName: NUCLEI_ENGINE_NAME,
          baseline,
          failure,
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
        }),
      );
    }
  }

  if (await deps.isCancelRequested(run.id)) {
    await markCanceled(run.id, allEngineRunIds, startedAt, now());
    return;
  }

  if (zapRuntime) {
    try {
      const request = buildZapScanRequest({
        mode: run.mode,
        targetKind: run.targetKind,
        authorizationConfirmed: run.authorizationConfirmed,
        target,
        ruleset: zapRuntime.ruleset,
      });
      const response = await deps.executeZap(request, zapRuntime);
      const normalized = normalizeZapJson(response.outputJson, {
        mode: run.mode,
        authorizationConfirmed: run.authorizationConfirmed,
        completed: response.completed,
        rulesetStatus: response.rulesetStatus,
        allowedActiveRuleIds: [...ZAP_ACTIVE_RULE_IDS],
      });
      normalized.execution = {
        requestCount: response.execution?.requestCount ?? null,
        checks: getServiceAssurancePlannedChecks(run.mode, 'OPENAPI')
          .filter((check) => check.id.startsWith('zap-'))
          .map((check) => {
            const observations =
              response.execution?.checks.filter((item) => item.id === check.id) ?? [];
            const observed = observations.length === 1 ? observations[0] : undefined;
            const failed = observed?.status === 'FAILED' || !response.completed;
            return {
              id: check.id,
              label: check.label,
              status: failed ? ('FAILED' as const) : ('UNKNOWN' as const),
              requestCount: null,
              detail: failed
                ? '接口检查未完整执行，无法确认该阶段的检查覆盖。'
                : '扫描进程已结束，但未取得该阶段逐规则执行证据；请求总数仅在网关实际观测后显示。',
            };
          }),
      };
      // ZAP process exit and aggregate gateway traffic do not establish which
      // passive/active rules actually executed. Keep that limitation explicit.
      if (normalized.execution.checks.some((check) => check.status !== 'COMPLETED')) {
        if (normalized.coverageStatus === 'COMPLETE') normalized.coverageStatus = 'INCOMPLETE';
        normalized.customerSummary.incomplete = true;
        normalized.customerSummary.statusMessage = '接口检查缺少逐项执行证据，请查看执行记录。';
        normalized.notices.push({
          code: 'SERVICE_ASSURANCE_EXECUTION_UNVERIFIED',
          message: normalized.customerSummary.statusMessage,
        });
      }
      results.push({
        runId: run.id,
        taskId: run.taskId,
        engineRunId: engineRunId.get(ZAP_ENGINE_NAME),
        normalized,
        execution: {
          engineName: ZAP_ENGINE_NAME,
          baselineKind: 'RULESET',
          completed: response.completed,
          durationMs: response.durationMs,
          engineVersion: response.engineVersion,
          engineDigest: response.engineDigest,
          baselineVersion: response.rulesetVersion,
          baselineDigest: response.rulesetDigest,
          errorCode: response.errorCode,
        },
      });
    } catch (error) {
      const failure = safeFailure(error);
      failures.push(failure);
      results.push(
        failedResult({
          runId: run.id,
          taskId: run.taskId,
          mode: run.mode,
          engineRunId: engineRunId.get(ZAP_ENGINE_NAME),
          engineName: ZAP_ENGINE_NAME,
          baseline,
          failure,
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
        }),
      );
    }
  }

  if (await deps.isCancelRequested(run.id)) {
    await markCanceled(run.id, allEngineRunIds, startedAt, now());
    return;
  }
  await persistServiceAssuranceResults(results);
  const completedScope = results.some(
    (result) => result.execution.completed || result.normalized.eventsProcessed > 0,
  );
  if (!completedScope && failures[0]) throw failures[0].exposed;
}
