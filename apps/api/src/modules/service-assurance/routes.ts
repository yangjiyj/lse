import { selectServiceAssuranceReadiness } from '@lse/shared';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import type {
  ServiceAssuranceMode,
  ServiceAssuranceReadinessResponse,
  ServiceAssuranceRunListItem,
} from '@lse/shared';
import { z } from 'zod';
import { prisma } from '../../db.js';
import {
  buildExecutionSummary,
  EXECUTION_EVIDENCE_TYPE,
  REQUEST_TOTAL_EVIDENCE_TYPE,
} from './execution-evidence.js';
import { redactString } from '../../lib/redact.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { enqueueServiceAssuranceRun, requestServiceAssuranceCancel } from '../../lib/queue.js';
import {
  previewScannerTarget,
  resolveAndAuthorizeTarget,
  ScannerScopeError,
  type ResolvedScannerTarget,
  type ScannerScopePolicy,
} from '../../lib/scanner-scope.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { SERVICE_ASSURANCE_REQUEST_BUDGET, serviceAssuranceCreateBodySchema } from './contracts.js';
import { probeServiceAssuranceReadiness } from './readiness.js';
import {
  reviewServiceAssuranceAssessment,
  serviceAssuranceRetestBodySchema,
  serviceAssuranceReviewBodySchema,
} from './review.js';
import { loadNucleiRuntimeFromEnv, loadTrivyRuntimeFromEnv } from './orchestrator.js';
import {
  deleteServiceAssuranceSbom,
  putServiceAssuranceSbom,
  type ServiceAssuranceSbomUpload,
} from './sbom-channel.js';
import {
  parseSbomUpload,
  SERVICE_ASSURANCE_SBOM_LIMITS,
  SbomInputError,
  type ParsedSbom,
} from './sbom.js';
import {
  assertAssurancePermission,
  assertRunAccess,
  assertTaskAccess,
  type TaskAccessOperation,
} from './task-access.js';
import { linkRunToTask, unlinkRunFromTask } from './link-task.js';
import {
  loadServiceAssuranceScopeSettings,
  resolveManagedScopePolicy,
  saveServiceAssuranceScopeSettings,
  scopePolicyDigest,
  scopePolicySnapshot,
  serviceAssuranceScopeSettingsInputSchema,
} from './scope-policies.js';

const runParamsSchema = z.object({ runId: z.string().uuid() }).strict();
const assessmentParamsSchema = z.object({ id: z.string().uuid() }).strict();
const RUN_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELED'] as const;
const listQuerySchema = z
  .object({
    taskId: z.string().uuid().optional(),
    keyword: z.string().trim().max(200).optional(),
    status: z.enum(RUN_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const linkBodySchema = z.object({ taskId: z.string().uuid() }).strict();
const scopePreviewSchema = z.object({ targetUrl: z.string().trim().min(1).max(2_048) }).strict();

export interface ServiceAssuranceBaseline {
  kind: 'RULESET' | 'VULNERABILITY_DB';
  version: string;
  digest: string;
}

export interface ServiceAssuranceRoutesOptions {
  getReadiness?: () => Promise<ServiceAssuranceReadinessResponse>;
  resolveScopePolicy?: (ref: string) => ScannerScopePolicy | Promise<ScannerScopePolicy>;
  resolveTarget?: (rawUrl: string, policy: ScannerScopePolicy) => Promise<ResolvedScannerTarget>;
  baselineForMode?: (mode: ServiceAssuranceMode) => ServiceAssuranceBaseline | null;
  putSbom?: (runId: string, upload: ServiceAssuranceSbomUpload) => Promise<void>;
  deleteSbom?: (runId: string) => Promise<void>;
  enqueueRun?: (runId: string) => Promise<void>;
  requestCancel?: (runId: string) => Promise<void>;
}

interface CustomerRun {
  id: string;
  taskId: string | null;
  task?: { name: string } | null;
  linkedAt?: Date | null;
  mode: ServiceAssuranceMode;
  targetKind: 'ENDPOINT' | 'OPENAPI' | 'MCP' | 'SBOM';
  targetName: string;
  normalizedTarget?: string | null;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELED';
  coverageStatus: 'COMPLETE' | 'INCOMPLETE' | 'NOT_READY';
  failureMessage: string | null;
  createdAt: Date;
  endedAt: Date | null;
  assessments: Array<{
    impactStatus: 'UNDER_INVESTIGATION' | 'AFFECTED' | 'NOT_AFFECTED' | 'FIXED';
  }>;
}

const RUN_LIST_INCLUDE = {
  task: { select: { name: true } },
  assessments: { select: { impactStatus: true } },
} as const;

async function taskNameOf(taskId: string | null): Promise<{ name: string } | null> {
  if (!taskId) return null;
  return prisma.evalTask.findUnique({ where: { id: taskId }, select: { name: true } });
}

function runVisibilityWhere(user: CurrentUser): Prisma.ServiceAssuranceRunWhereInput {
  if (user.isBuiltin) return {};
  // 与 assertRunAccess 的读取规则一致：未关联记录仅发起人可见；已关联记录按任务对象权限。
  return {
    OR: [
      { taskId: null, createdById: user.id },
      { task: { createdById: user.id } },
      { task: { createdById: null } },
    ],
  };
}

function defaultReadiness(): Promise<ServiceAssuranceReadinessResponse> {
  return probeServiceAssuranceReadiness();
}

function defaultBaseline(mode: ServiceAssuranceMode): ServiceAssuranceBaseline | null {
  if (mode === 'SBOM') {
    const runtime = loadTrivyRuntimeFromEnv();
    return {
      kind: 'VULNERABILITY_DB',
      version: runtime.vulnerabilityDb.version,
      digest: runtime.vulnerabilityDb.digest,
    };
  }
  const runtime = loadNucleiRuntimeFromEnv();
  return {
    kind: 'RULESET',
    version: runtime.ruleset.version,
    digest: runtime.ruleset.digest,
  };
}

function accessOperation(mode: ServiceAssuranceMode): TaskAccessOperation {
  return mode === 'DEEP' ? 'verify' : 'scan';
}

function statusMessage(run: CustomerRun): string {
  if (run.failureMessage) return run.failureMessage;
  if (run.status === 'PENDING') return '核验任务已创建。';
  if (run.status === 'RUNNING') return '核验正在执行。';
  if (run.status === 'CANCELED') return '核验已取消，覆盖不完整。';
  if (run.status === 'FAILED') return '核验未完成。';
  if (run.status === 'PARTIAL') return '部分检查执行失败，请查看执行明细。';
  if (run.coverageStatus !== 'COMPLETE') return '执行已结束，部分检查范围仍无法确认。';
  return '本次检查执行完成，结论仅适用于已记录的检查范围。';
}

function customerTargetAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return redactString(`${url.origin}${url.pathname}`);
  } catch {
    return null;
  }
}

function assertSupportedTarget(targetKind: string, credentialRef?: string | null): void {
  if (targetKind === 'MCP') {
    throw badRequest(
      '当前尚未提供 MCP 协议及工具行为专项检查，请选择在线 HTTP 服务检查。',
      'SERVICE_ASSURANCE_TARGET_UNSUPPORTED',
    );
  }
  if (credentialRef) {
    throw badRequest(
      '当前核验不支持携带访问凭据，请使用无凭据的服务检查；鉴权后接口不在检查范围内。',
      'SERVICE_ASSURANCE_CREDENTIAL_UNSUPPORTED',
    );
  }
}

function serializeRun(run: CustomerRun): ServiceAssuranceRunListItem {
  const count = (status: CustomerRun['assessments'][number]['impactStatus']): number =>
    run.assessments.filter((item) => item.impactStatus === status).length;
  return {
    runId: run.id,
    taskId: run.taskId,
    taskName: run.taskId ? (run.task?.name ?? null) : null,
    linkedAt: run.linkedAt?.toISOString() ?? null,
    mode: run.mode,
    targetKind: run.targetKind,
    targetName: run.targetName,
    targetAddress: customerTargetAddress(run.normalizedTarget),
    status: run.status,
    coverageStatus: run.coverageStatus,
    statusMessage: statusMessage(run),
    summary: {
      confirmed: count('AFFECTED'),
      underInvestigation: count('UNDER_INVESTIGATION'),
      notAffected: count('NOT_AFFECTED'),
      fixed: count('FIXED'),
      incomplete: run.coverageStatus !== 'COMPLETE',
      statusMessage: statusMessage(run),
    },
    createdAt: run.createdAt.toISOString(),
    completedAt: run.endedAt?.toISOString() ?? null,
  };
}

function evidenceLabel(level: string): string {
  if (level === 'VERSION_MATCH') return '版本证据';
  if (level === 'CONFIG_MATCH') return '配置证据';
  if (level === 'ACTIVE_VERIFIED') return '授权验证证据';
  return '待核验线索';
}

async function findRunForAccess(
  runId: string,
  operation: TaskAccessOperation,
): Promise<{
  id: string;
  taskId: string | null;
  createdById: string | null;
  mode: ServiceAssuranceMode;
  status: CustomerRun['status'];
}> {
  const run = await prisma.serviceAssuranceRun.findUnique({
    where: { id: runId },
    select: { id: true, taskId: true, createdById: true, mode: true, status: true },
  });
  if (!run) throw notFound('服务安全核验运行不存在', 'SERVICE_ASSURANCE_RUN_NOT_FOUND');
  return run;
}

async function findAssessmentForAccess(assessmentId: string): Promise<{
  id: string;
  taskId: string | null;
  createdById: string | null;
  run: {
    id: string;
    mode: ServiceAssuranceMode;
    targetKind: 'ENDPOINT' | 'OPENAPI' | 'MCP' | 'SBOM';
    targetName: string;
    normalizedTarget: string | null;
    scopePolicyRef: string;
    scopePolicySnapshot: Prisma.JsonValue | null;
    scopePolicyDigest: string | null;
    credentialRef: string | null;
    authorizationConfirmed: boolean;
    authorizationConfirmedAt: Date | null;
  };
}> {
  const assessment = await prisma.vulnerabilityAssessment.findUnique({
    where: { id: assessmentId },
    select: {
      id: true,
      run: {
        select: {
          id: true,
          taskId: true,
          createdById: true,
          mode: true,
          targetKind: true,
          targetName: true,
          normalizedTarget: true,
          scopePolicyRef: true,
          scopePolicySnapshot: true,
          scopePolicyDigest: true,
          credentialRef: true,
          authorizationConfirmed: true,
          authorizationConfirmedAt: true,
        },
      },
    },
  });
  if (!assessment) {
    throw notFound('服务安全核验结论不存在', 'SERVICE_ASSURANCE_ASSESSMENT_NOT_FOUND');
  }
  return {
    id: assessment.id,
    taskId: assessment.run.taskId,
    createdById: assessment.run.createdById,
    run: assessment.run,
  };
}

function scopeError(error: unknown): never {
  if (error instanceof ScannerScopeError) {
    throw badRequest(error.message, error.code);
  }
  throw error;
}

function parseSbom(body: { contentType: string; content: string }): ParsedSbom {
  try {
    return parseSbomUpload(body);
  } catch (error) {
    if (error instanceof SbomInputError) {
      throw badRequest(error.message, error.code);
    }
    throw error;
  }
}

export async function serviceAssuranceRoutes(
  app: FastifyInstance,
  options: ServiceAssuranceRoutesOptions = {},
): Promise<void> {
  const getReadiness = options.getReadiness ?? defaultReadiness;
  const resolveScopePolicy = options.resolveScopePolicy ?? resolveManagedScopePolicy;
  const resolveTarget = options.resolveTarget ?? resolveAndAuthorizeTarget;
  const baselineForMode = options.baselineForMode ?? defaultBaseline;
  const putSbom = options.putSbom ?? putServiceAssuranceSbom;
  const deleteSbom = options.deleteSbom ?? deleteServiceAssuranceSbom;
  const enqueueRun = options.enqueueRun ?? enqueueServiceAssuranceRun;
  const requestCancel = options.requestCancel ?? requestServiceAssuranceCancel;

  app.addHook('preHandler', authenticate);

  app.get('/readiness', { preHandler: requirePermission('service_assurance:read') }, async () =>
    getReadiness(),
  );

  app.get(
    '/scope-policies',
    {
      preHandler: requirePermission(
        'service_assurance:read',
        'platform_setting:read',
        'platform_setting:update',
        'system_setting:update',
      ),
    },
    async () => loadServiceAssuranceScopeSettings(),
  );

  app.post(
    '/scope-policies/preview',
    { preHandler: requirePermission('platform_setting:update', 'system_setting:update') },
    async (request) => {
      const body = scopePreviewSchema.parse(request.body);
      try {
        return await previewScannerTarget(body.targetUrl);
      } catch (error) {
        scopeError(error);
      }
    },
  );

  app.put(
    '/scope-policies',
    { preHandler: requirePermission('platform_setting:update', 'system_setting:update') },
    async (request) => {
      const body = serviceAssuranceScopeSettingsInputSchema.parse(request.body);
      let settings;
      try {
        settings = await saveServiceAssuranceScopeSettings(body, request.currentUser!.id);
      } catch (error) {
        scopeError(error);
      }
      await writeAudit({
        actorId: request.currentUser!.id,
        action: 'service_assurance.scope_policies.update',
        targetType: 'system_setting',
        targetId: 'service_assurance.scope_policies',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        detail: {
          policyCount: settings.policies.length,
          defaultPolicyRef: settings.defaultPolicyRef,
          policyRefs: settings.policies.map((policy) => policy.ref),
        },
      });
      return settings;
    },
  );

  app.post(
    '/runs',
    {
      bodyLimit: SERVICE_ASSURANCE_SBOM_LIMITS.maxRequestBytes,
      preHandler: requirePermission('service_assurance:scan', 'service_assurance:verify'),
    },
    async (request, reply) => {
      const body = serviceAssuranceCreateBodySchema.parse(request.body);
      if (body.mode === 'DEEP' && !body.authorizationConfirmed) {
        throw badRequest(
          '授权深度核验必须确认已取得目标授权。',
          'SERVICE_ASSURANCE_AUTHORIZATION_REQUIRED',
        );
      }
      if (body.taskId) {
        await assertTaskAccess(request.currentUser!, body.taskId, accessOperation(body.mode));
      } else {
        assertAssurancePermission(request.currentUser!, accessOperation(body.mode));
      }
      const readiness = await getReadiness();
      assertSupportedTarget(body.targetKind, body.credentialRef);
      const modeReadiness = selectServiceAssuranceReadiness(readiness, body.mode, body.targetKind);
      if (!modeReadiness?.ready) {
        throw conflict(
          modeReadiness?.message ?? '当前核验模式尚未就绪。',
          'SERVICE_ASSURANCE_MODE_NOT_READY',
        );
      }

      let normalizedTarget: string | null = null;
      let resolvedScopePolicy: ScannerScopePolicy | null = null;
      if (body.targetUrl) {
        try {
          const policy = await resolveScopePolicy(body.scopePolicyRef);
          resolvedScopePolicy = policy;
          normalizedTarget = (await resolveTarget(body.targetUrl, policy)).url.toString();
        } catch (error) {
          scopeError(error);
        }
      }
      let baseline: ServiceAssuranceBaseline | null;
      try {
        baseline = baselineForMode(body.mode);
      } catch {
        throw new AppError(
          503,
          '安全核验服务配置无效。',
          'SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID',
        );
      }
      if (!baseline) {
        throw new AppError(503, '当前核验模式尚未就绪。', 'SERVICE_ASSURANCE_MODE_NOT_READY');
      }
      const parsedSbom = body.sbom ? parseSbom(body.sbom) : null;

      const created = await prisma.serviceAssuranceRun.create({
        data: {
          taskId: body.taskId ?? null,
          linkedAt: body.taskId ? new Date() : null,
          createdById: request.currentUser!.id,
          mode: body.mode,
          targetKind: body.targetKind,
          targetName: body.targetName,
          normalizedTarget,
          scopePolicyRef: body.scopePolicyRef,
          ...(resolvedScopePolicy
            ? {
                scopePolicySnapshot: scopePolicySnapshot(
                  resolvedScopePolicy,
                ) as unknown as Prisma.InputJsonObject,
                scopePolicyDigest: scopePolicyDigest(resolvedScopePolicy),
              }
            : {}),
          credentialRef: body.credentialRef,
          authorizationConfirmed: body.authorizationConfirmed,
          authorizationConfirmedAt: body.authorizationConfirmed ? new Date() : null,
          requestBudget: SERVICE_ASSURANCE_REQUEST_BUDGET,
          rulesetVersion: baseline.kind === 'RULESET' ? baseline.version : null,
          rulesetDigest: baseline.kind === 'RULESET' ? baseline.digest : null,
          vulnerabilityDbVersion: baseline.kind === 'VULNERABILITY_DB' ? baseline.version : null,
          vulnerabilityDbDigest: baseline.kind === 'VULNERABILITY_DB' ? baseline.digest : null,
          status: 'PENDING',
          coverageStatus: 'NOT_READY',
        },
      });
      let sbomStored = false;
      if (body.sbom && parsedSbom) {
        try {
          await putSbom(created.id, {
            contentType: body.sbom.contentType,
            content: body.sbom.content,
            parsed: parsedSbom,
          });
          sbomStored = true;
        } catch {
          await prisma.serviceAssuranceRun.update({
            where: { id: created.id },
            data: {
              status: 'FAILED',
              coverageStatus: 'NOT_READY',
              failureCode: 'SERVICE_ASSURANCE_SBOM_CHANNEL_UNAVAILABLE',
              failureMessage: '组件清单暂时无法提交。',
              endedAt: new Date(),
            },
          });
          throw new AppError(
            503,
            '组件清单暂时无法提交。',
            'SERVICE_ASSURANCE_SBOM_CHANNEL_UNAVAILABLE',
          );
        }
      }
      try {
        await enqueueRun(created.id);
      } catch {
        if (sbomStored) {
          try {
            await deleteSbom(created.id);
          } catch {
            // 短 TTL 通道会自动清理；保留原始入队错误。
          }
        }
        await prisma.serviceAssuranceRun.update({
          where: { id: created.id },
          data: {
            status: 'FAILED',
            coverageStatus: 'NOT_READY',
            failureCode: 'SERVICE_ASSURANCE_QUEUE_UNAVAILABLE',
            failureMessage: '核验任务暂时无法启动。',
            endedAt: new Date(),
          },
        });
        throw new AppError(503, '核验任务暂时无法启动。', 'SERVICE_ASSURANCE_QUEUE_UNAVAILABLE');
      }
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'service_assurance.run.create',
        targetType: 'service_assurance_run',
        targetId: created.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        detail: {
          taskId: body.taskId ?? null,
          mode: body.mode,
          targetKind: body.targetKind,
          targetName: body.targetName,
          authorizationConfirmed: body.authorizationConfirmed,
        },
      });

      reply.code(201);
      return {
        run: serializeRun({
          ...created,
          task: await taskNameOf(created.taskId),
          assessments: [],
        }),
      };
    },
  );

  app.get('/runs', { preHandler: requirePermission('service_assurance:read') }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const user = request.currentUser!;
    // 传 taskId：保持原行为（按任务对象鉴权后列出该任务下全部记录）。
    if (query.taskId) {
      await assertTaskAccess(user, query.taskId, 'read');
    }
    const where: Prisma.ServiceAssuranceRunWhereInput = {
      AND: [
        query.taskId ? { taskId: query.taskId } : runVisibilityWhere(user),
        query.status ? { status: query.status } : {},
        query.keyword
          ? {
              OR: [
                { targetName: { contains: query.keyword, mode: 'insensitive' } },
                { normalizedTarget: { contains: query.keyword, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [runs, total] = await Promise.all([
      prisma.serviceAssuranceRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: RUN_LIST_INCLUDE,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.serviceAssuranceRun.count({ where }),
    ]);
    return { items: runs.map(serializeRun), total, page: query.page, pageSize: query.pageSize };
  });

  app.post(
    '/runs/:runId/link-task',
    { preHandler: requirePermission('service_assurance:scan', 'service_assurance:verify') },
    async (request) => {
      const { runId } = runParamsSchema.parse(request.params);
      const body = linkBodySchema.parse(request.body);
      const user = request.currentUser!;
      const run = await findRunForAccess(runId, 'scan');
      // 对核验记录本身须有操作权，对目标任务须有写权限（非发起人/非管理员返回 403）。
      await assertRunAccess(user, run, accessOperation(run.mode));
      await assertTaskAccess(user, body.taskId, 'scan');
      const result = await linkRunToTask(run.id, body.taskId);
      await writeAudit({
        actorId: user.id,
        actorName: user.username,
        action: 'service_assurance.run.link_task',
        targetType: 'service_assurance_run',
        targetId: run.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        detail: { taskId: body.taskId, findingCount: result.findingCount },
      });
      const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
        where: { id: run.id },
        include: RUN_LIST_INCLUDE,
      });
      return { run: serializeRun(stored), findingCount: result.findingCount };
    },
  );

  app.post(
    '/runs/:runId/unlink-task',
    { preHandler: requirePermission('service_assurance:scan', 'service_assurance:verify') },
    async (request) => {
      const { runId } = runParamsSchema.parse(request.params);
      const user = request.currentUser!;
      const run = await findRunForAccess(runId, 'scan');
      if (!run.taskId) {
        throw conflict('该核验记录尚未关联评估任务。', 'SERVICE_ASSURANCE_RUN_NOT_LINKED');
      }
      await assertTaskAccess(user, run.taskId, accessOperation(run.mode));
      const previousTaskId = run.taskId;
      const result = await unlinkRunFromTask(run.id);
      await writeAudit({
        actorId: user.id,
        actorName: user.username,
        action: 'service_assurance.run.unlink_task',
        targetType: 'service_assurance_run',
        targetId: run.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        detail: { taskId: previousTaskId, removedFindingCount: result.removedFindingCount },
      });
      const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
        where: { id: run.id },
        include: RUN_LIST_INCLUDE,
      });
      return { run: serializeRun(stored) };
    },
  );

  app.get(
    '/runs/:runId',
    { preHandler: requirePermission('service_assurance:read') },
    async (request) => {
      const { runId } = runParamsSchema.parse(request.params);
      const accessRun = await findRunForAccess(runId, 'read');
      await assertRunAccess(request.currentUser!, accessRun, 'read');
      const run = await prisma.serviceAssuranceRun.findUniqueOrThrow({
        where: { id: runId },
        include: {
          task: { select: { name: true } },
          assets: true,
          components: true,
          assessments: true,
          evidence: {
            where: { evidenceType: { in: [EXECUTION_EVIDENCE_TYPE, REQUEST_TOTAL_EVIDENCE_TYPE] } },
          },
        },
      });
      return {
        run: serializeRun(run),
        execution: buildExecutionSummary(run.mode, run.targetKind, run.evidence),
        assets: run.assets.map((asset) => ({
          assetId: asset.id,
          name: asset.customerName,
          address: asset.normalizedAddress,
          protocol: asset.protocol,
          host: asset.host,
          port: asset.port,
          title: asset.title,
        })),
        components: run.components.map((component) => ({
          componentId: component.id,
          name: component.name,
          vendor: component.vendor,
          version: component.version,
          confidence: component.confidence,
          evidenceLabel: evidenceLabel(component.evidenceLevel),
        })),
        results: run.assessments.map((assessment) => ({
          assessmentId: assessment.id,
          title: assessment.title,
          advisoryId: assessment.advisoryId,
          severity: assessment.severity,
          impactStatus: assessment.impactStatus,
          confidence: assessment.confidence,
          priority: assessment.priority,
          reason: assessment.reason,
          remediation: assessment.remediation,
          evidenceLabel: evidenceLabel(assessment.evidenceLevel),
        })),
      };
    },
  );

  app.get(
    '/runs/:runId/evidence',
    { preHandler: requirePermission('service_assurance:review') },
    async (request) => {
      const { runId } = runParamsSchema.parse(request.params);
      const run = await findRunForAccess(runId, 'review');
      await assertRunAccess(request.currentUser!, run, 'review');
      const evidence = await prisma.serviceEvidence.findMany({
        where: { runId, visibility: 'TECHNICAL' },
        orderBy: { createdAt: 'asc' },
      });
      return {
        items: evidence.map((item) => ({
          evidenceId: item.id,
          assessmentId: item.assessmentId,
          evidenceType: item.evidenceType,
          ruleId: item.ruleId,
          ruleSummary: item.ruleSummary,
          matchedLocation: item.matchedLocation,
          customerSummary: item.customerSummary,
          requestSummary: item.requestSummary,
          responseSummary: item.responseSummary,
          contentSha256: item.contentSha256,
          visibility: item.visibility,
        })),
      };
    },
  );

  app.post(
    '/assessments/:id/review',
    { preHandler: requirePermission('service_assurance:review') },
    async (request) => {
      const { id } = assessmentParamsSchema.parse(request.params);
      const body = serviceAssuranceReviewBodySchema.parse(request.body);
      const assessment = await findAssessmentForAccess(id);
      await assertRunAccess(request.currentUser!, assessment, 'review');
      const reviewed = await reviewServiceAssuranceAssessment({
        assessmentId: assessment.id,
        actorId: request.currentUser!.id,
        body,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'service_assurance.assessment.review',
        targetType: 'service_assurance_assessment',
        targetId: assessment.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        detail: {
          impactStatus: body.impactStatus,
          statement: body.statement,
        },
      });
      return {
        result: {
          impactStatus: reviewed.impactStatus,
          reason: reviewed.reason,
          reviewedAt: reviewed.reviewedAt?.toISOString() ?? null,
        },
      };
    },
  );

  app.post(
    '/assessments/:id/retest',
    {
      bodyLimit: SERVICE_ASSURANCE_SBOM_LIMITS.maxRequestBytes,
      preHandler: requirePermission('service_assurance:scan', 'service_assurance:verify'),
    },
    async (request, reply) => {
      const { id } = assessmentParamsSchema.parse(request.params);
      const body = serviceAssuranceRetestBodySchema.parse(request.body ?? {});
      const assessment = await findAssessmentForAccess(id);
      await assertRunAccess(request.currentUser!, assessment, accessOperation(assessment.run.mode));
      if (assessment.run.mode === 'SBOM' && !body.sbom) {
        throw badRequest(
          '组件清单复测必须提交新的标准组件清单。',
          'SERVICE_ASSURANCE_SBOM_REQUIRED',
        );
      }
      if (assessment.run.mode !== 'SBOM' && body.sbom) {
        throw badRequest('当前核验模式不能提交组件清单。', 'SERVICE_ASSURANCE_SBOM_NOT_ALLOWED');
      }
      const readiness = await getReadiness();
      assertSupportedTarget(assessment.run.targetKind, assessment.run.credentialRef);
      const modeReadiness = selectServiceAssuranceReadiness(
        readiness,
        assessment.run.mode,
        assessment.run.targetKind,
      );
      if (!modeReadiness?.ready) {
        throw conflict(
          modeReadiness?.message ?? '当前核验模式尚未就绪。',
          'SERVICE_ASSURANCE_MODE_NOT_READY',
        );
      }
      let baseline: ServiceAssuranceBaseline | null;
      try {
        baseline = baselineForMode(assessment.run.mode);
      } catch {
        throw new AppError(
          503,
          '安全核验服务配置无效。',
          'SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID',
        );
      }
      if (!baseline) {
        throw new AppError(503, '当前核验模式尚未就绪。', 'SERVICE_ASSURANCE_MODE_NOT_READY');
      }
      const parsedSbom = body.sbom ? parseSbom(body.sbom) : null;
      const created = await prisma.serviceAssuranceRun.create({
        data: {
          taskId: assessment.taskId,
          linkedAt: assessment.taskId ? new Date() : null,
          createdById: request.currentUser!.id,
          mode: assessment.run.mode,
          targetKind: assessment.run.targetKind,
          targetName: assessment.run.targetName,
          normalizedTarget: assessment.run.normalizedTarget,
          scopePolicyRef: assessment.run.scopePolicyRef,
          scopePolicySnapshot: assessment.run.scopePolicySnapshot ?? undefined,
          scopePolicyDigest: assessment.run.scopePolicyDigest,
          credentialRef: assessment.run.credentialRef,
          authorizationConfirmed: assessment.run.authorizationConfirmed,
          authorizationConfirmedAt: assessment.run.authorizationConfirmedAt,
          requestBudget: SERVICE_ASSURANCE_REQUEST_BUDGET,
          rulesetVersion: baseline.kind === 'RULESET' ? baseline.version : null,
          rulesetDigest: baseline.kind === 'RULESET' ? baseline.digest : null,
          vulnerabilityDbVersion: baseline.kind === 'VULNERABILITY_DB' ? baseline.version : null,
          vulnerabilityDbDigest: baseline.kind === 'VULNERABILITY_DB' ? baseline.digest : null,
          status: 'PENDING',
          coverageStatus: 'NOT_READY',
          retestOfRunId: assessment.run.id,
        },
      });
      let sbomStored = false;
      if (body.sbom && parsedSbom) {
        try {
          await putSbom(created.id, {
            contentType: body.sbom.contentType,
            content: body.sbom.content,
            parsed: parsedSbom,
          });
          sbomStored = true;
        } catch {
          await prisma.serviceAssuranceRun.update({
            where: { id: created.id },
            data: {
              status: 'FAILED',
              coverageStatus: 'NOT_READY',
              failureCode: 'SERVICE_ASSURANCE_SBOM_CHANNEL_UNAVAILABLE',
              failureMessage: '组件清单暂时无法提交。',
              endedAt: new Date(),
            },
          });
          throw new AppError(
            503,
            '组件清单暂时无法提交。',
            'SERVICE_ASSURANCE_SBOM_CHANNEL_UNAVAILABLE',
          );
        }
      }
      try {
        await enqueueRun(created.id);
      } catch {
        if (sbomStored) {
          try {
            await deleteSbom(created.id);
          } catch {
            // 短 TTL 通道会自动清理。
          }
        }
        await prisma.serviceAssuranceRun.update({
          where: { id: created.id },
          data: {
            status: 'FAILED',
            coverageStatus: 'NOT_READY',
            failureCode: 'SERVICE_ASSURANCE_QUEUE_UNAVAILABLE',
            failureMessage: '核验任务暂时无法启动。',
            endedAt: new Date(),
          },
        });
        throw new AppError(503, '核验任务暂时无法启动。', 'SERVICE_ASSURANCE_QUEUE_UNAVAILABLE');
      }
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'service_assurance.assessment.retest',
        targetType: 'service_assurance_assessment',
        targetId: assessment.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        detail: {
          mode: assessment.run.mode,
          targetKind: assessment.run.targetKind,
        },
      });
      reply.code(201);
      return {
        run: serializeRun({
          ...created,
          task: await taskNameOf(created.taskId),
          assessments: [],
        }),
      };
    },
  );

  app.post(
    '/runs/:runId/cancel',
    {
      preHandler: requirePermission('service_assurance:scan', 'service_assurance:verify'),
    },
    async (request) => {
      const { runId } = runParamsSchema.parse(request.params);
      const run = await findRunForAccess(runId, 'scan');
      await assertRunAccess(request.currentUser!, run, accessOperation(run.mode));
      const canceledAt = new Date();
      const canceled = await prisma.serviceAssuranceRun.updateMany({
        where: { id: run.id, status: { in: ['PENDING', 'RUNNING'] } },
        data: {
          status: 'CANCELED',
          coverageStatus: 'INCOMPLETE',
          failureCode: 'SERVICE_ASSURANCE_CANCELED',
          failureMessage: '核验已取消，覆盖不完整。',
          canceledAt,
          endedAt: canceledAt,
        },
      });
      if (canceled.count === 1) {
        await requestCancel(run.id);
        await writeAudit({
          actorId: request.currentUser!.id,
          actorName: request.currentUser!.username,
          action: 'service_assurance.run.cancel',
          targetType: 'service_assurance_run',
          targetId: run.id,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          detail: { status: 'CANCELED' },
        });
      }
      const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
        where: { id: run.id },
        include: RUN_LIST_INCLUDE,
      });
      return { run: serializeRun(stored) };
    },
  );
}
