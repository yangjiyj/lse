import { assertNonEndpointTaskTarget } from '../../lib/endpoint-task-policy.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { resolveInternalToken, assertControlPlaneAllowed } from '../../lib/gateway-access.js';
import { writeAudit } from '../../lib/audit.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import {
  fetchGatewayAuditEvents,
  normalizeGatewayAuditEvents,
  type GatewayLogFinding,
} from './client.js';
import { analyzeSessions } from './session-trajectory.js';
import { generateDrillScenario } from './drill.js';
import { randomUUID } from 'node:crypto';

const analyzeBody = z.object({
  modelTargetId: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  evalRunId: z.string().trim().min(1).max(128).optional(),
  taskId: z.string().trim().min(1).max(128).optional(),
  sampleId: z.string().trim().min(1).max(128).optional(),
  traceId: z.string().trim().min(1).max(128).optional(),
  clientId: z.string().trim().min(1).max(128).optional(),
  sourceIp: z.string().trim().min(1).max(64).optional(),
  canaryTokens: z.array(z.string().trim().min(1).max(256)).max(50).optional(),
});

type AnalyzeBody = z.infer<typeof analyzeBody>;

// 网关日志分析按时间窗驱动；条数不暴露给用户，内部固定封顶防拉爆。超过封顶则透明提示缩小时间范围分批分析。
const GATEWAY_ANALYZE_PAGE_SIZE = 500;
const GATEWAY_ANALYZE_MAX_PAGES = 4;
const GATEWAY_ANALYZE_EVENT_CAP = GATEWAY_ANALYZE_PAGE_SIZE * GATEWAY_ANALYZE_MAX_PAGES;

const drillPrepareBody = z.object({
  canaryToken: z.string().trim().min(4).max(128).optional(),
  channels: z.array(z.enum(['document', 'webpage', 'ticket'])).optional(),
  collectorUrl: z.string().trim().url().max(512).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return '';
  const field = value[key];
  return typeof field === 'string' ? field.trim() : '';
}

function resolveGatewayAccessConfig(accessConfig: unknown): {
  controlPlaneBaseUrl: string;
  tenantId: string;
} {
  const controlPlaneBaseUrl = stringField(accessConfig, 'controlPlaneBaseUrl');
  if (!controlPlaneBaseUrl) {
    throw badRequest(
      '智能体安全网关对象缺少 Control Plane API 地址',
      'GATEWAY_CONTROL_PLANE_REQUIRED',
    );
  }
  assertControlPlaneAllowed(controlPlaneBaseUrl);
  const tenantId =
    stringField(accessConfig, 'tenantId') ||
    process.env.NEWAPI_TENANT_ID?.trim() ||
    process.env.PROXY_DEFAULT_TENANT_ID?.trim() ||
    'tenant_default';
  return { controlPlaneBaseUrl, tenantId };
}

function assertValidTimeRange(body: AnalyzeBody): void {
  const start = new Date(body.startTime);
  const end = new Date(body.endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw badRequest('时间范围格式不合法', 'GATEWAY_LOG_TIME_RANGE_INVALID');
  }
  if (start.getTime() > end.getTime()) {
    throw badRequest('开始时间不能晚于结束时间', 'GATEWAY_LOG_TIME_RANGE_INVALID');
  }
}

function defaultTaskName(): string {
  return `网关日志风险分析 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
}

function findingRows(
  taskId: string,
  findings: GatewayLogFinding[],
): Prisma.FindingCreateManyInput[] {
  return findings.map((finding) => ({
    taskId,
    resultId: null,
    questionId: null,
    engine: finding.engine,
    riskCategory: finding.riskCategory,
    severity: finding.severity,
    score: finding.score,
    verdict: finding.verdict,
    title: finding.title,
    evidence: finding.evidence,
    detail: finding.detail as Prisma.InputJsonValue,
  }));
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function serializeTask(task: {
  id: string;
  name: string;
  status: string;
  totalQuestions: number;
  processedQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  progress: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  modelTargetId: string;
}) {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    modelTargetId: task.modelTargetId,
    totalQuestions: task.totalQuestions,
    processedQuestions: task.processedQuestions,
    passedCount: task.passedCount,
    failedCount: task.failedCount,
    errorCount: task.errorCount,
    progress: task.progress,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

/**
 * 网关集成（Control Plane 地址、内部令牌、网关租户）是全平台共用的一份，
 * 这一期只给平台租户使用：其他租户既读不到别人的审计事件，也不会误用别人的网关租户。
 */
function assertPlatformTenant(user: { tenantIsPlatform: boolean }): void {
  if (!user.tenantIsPlatform) {
    throw forbidden('网关日志分析目前只在平台租户开放', 'PLATFORM_TENANT_ONLY');
  }
}

export async function gatewayLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.post(
    '/analyze',
    {
      preHandler: [requirePermission('gateway_log:analyze'), requireLicensedFeature('agent_audit')],
    },
    async (request, reply) => {
      assertPlatformTenant(request.currentUser!);
      const body = analyzeBody.parse(request.body);
      assertValidTimeRange(body);

      const target = await prisma.modelTarget.findUnique({ where: { id: body.modelTargetId } });
      if (!target) throw notFound('网关日志源不存在');
      assertNonEndpointTaskTarget(target);
      if (target.targetType !== 'GATEWAY_LOG') {
        throw badRequest('只能分析智能体安全网关日志源', 'GATEWAY_LOG_TARGET_REQUIRED');
      }
      if (!target.isActive) {
        throw badRequest('智能体安全网关日志源已禁用', 'GATEWAY_LOG_TARGET_INACTIVE');
      }

      const access = resolveGatewayAccessConfig(target.accessConfig);
      const internalToken = resolveInternalToken();
      const startedAt = new Date();
      const startedMs = Date.now();
      let events;
      try {
        events = await fetchGatewayAuditEvents({
          controlPlaneBaseUrl: access.controlPlaneBaseUrl,
          internalToken,
          tenantId: access.tenantId,
          startTime: body.startTime,
          endTime: body.endTime,
          evalRunId: body.evalRunId,
          taskId: body.taskId,
          sampleId: body.sampleId,
          traceId: body.traceId,
          clientId: (body.clientId ?? stringField(target.accessConfig, 'clientId')) || undefined,
          sourceIp: (body.sourceIp ?? stringField(target.accessConfig, 'sourceIp')) || undefined,
          limit: GATEWAY_ANALYZE_PAGE_SIZE,
          maxPages: GATEWAY_ANALYZE_MAX_PAGES,
          // 请求对话原文做内容级智能体风险分析（网关侧需开启受控开关才生效；分析即弃，不落库）。
          includeContent: true,
        });
      } catch (err) {
        throw new AppError(502, '拉取智能体安全网关审计日志失败', 'GATEWAY_AUDIT_FETCH_FAILED', {
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const truncated = events.length >= GATEWAY_ANALYZE_EVENT_CAP;
      const { findings: perRequestFindings, summary } = normalizeGatewayAuditEvents(events, {
        canaryTokens: body.canaryTokens,
      });
      // 会话级智能体轨迹分析：把事件按会话拼成时序轨迹，判 per-request 分析漏掉的【跨步】风险
      // （如第 i 步读敏感数据、第 j 步另一条请求才外带）。有 session_id 走精确会话；无 session_id 按
      // client_id+紧时间窗拼「伪会话」兜底（判定封顶到疑似、标清楚）。与 per-request finding 合并。
      const { findings: sessionFindings, sessionCount, pseudoCount } = analyzeSessions(events);
      const findings = [...perRequestFindings, ...sessionFindings];
      const finishedAt = new Date();
      const task = await prisma.$transaction(async (tx) => {
        const created = await tx.evalTask.create({
          data: {
            name: body.name ?? defaultTaskName(),
            description: '从智能体安全网关流量日志生成的风险分析任务',
            status: 'COMPLETED',
            modelTargetId: target.id,
            engines: ['newapi-agent-security-gateway'],
            dimensions: ['gateway_traffic_log'],
            concurrency: 1,
            totalQuestions: summary.totalEvents,
            processedQuestions: summary.totalEvents,
            passedCount: summary.passedEvents,
            failedCount: summary.riskEvents,
            errorCount: 0,
            progress: 1,
            startedAt,
            finishedAt,
            createdById: request.currentUser!.id,
          },
        });
        if (findings.length > 0) {
          await tx.finding.createMany({ data: findingRows(created.id, findings) });
        }
        await tx.engineRun.create({
          data: {
            taskId: created.id,
            resultId: null,
            engine: 'newapi-agent-security-gateway',
            status: 'SUCCESS',
            startedAt,
            endedAt: finishedAt,
            durationMs: Date.now() - startedMs,
            requestPayload: {
              modelTargetId: target.id,
              tenantId: access.tenantId,
              startTime: body.startTime,
              endTime: body.endTime,
              evalRunId: body.evalRunId ?? null,
              taskId: body.taskId ?? null,
              sampleId: body.sampleId ?? null,
              traceId: body.traceId ?? null,
              clientId: body.clientId ?? null,
              sourceIp: body.sourceIp ?? null,
              canaryTokenCount: body.canaryTokens?.length ?? 0,
              eventCap: GATEWAY_ANALYZE_EVENT_CAP,
              truncated,
            },
            rawOutput: safeJson({ summary, eventCount: events.length }),
            normalizedCount: findings.length,
          },
        });
        await tx.evalTaskLog.create({
          data: {
            taskId: created.id,
            level: findings.length > 0 ? 'warn' : 'info',
            message:
              `网关日志分析完成：共 ${summary.totalEvents} 条流量，风险 ${summary.riskEvents} 条，阻断 ${summary.blockedEvents} 条` +
              (sessionCount > 0 || pseudoCount > 0
                ? `；智能体会话轨迹 ${sessionCount} 个${pseudoCount > 0 ? `（另伪会话 ${pseudoCount} 个）` : ''}，跨步风险 ${sessionFindings.length} 条`
                : '') +
              (truncated
                ? `（已达单次分析上限 ${GATEWAY_ANALYZE_EVENT_CAP} 条，所选时间范围内还有更多日志未覆盖，请缩小时间范围分批分析）`
                : ''),
            context: { summary, findingCount: findings.length } as unknown as Prisma.InputJsonValue,
          },
        });
        return created;
      });

      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'gateway_log.analyze',
        targetType: 'eval_task',
        targetId: task.id,
        detail: {
          modelTargetId: target.id,
          tenantId: access.tenantId,
          startTime: body.startTime,
          endTime: body.endTime,
          clientId: body.clientId ?? null,
          sourceIp: body.sourceIp ?? null,
          totalEvents: summary.totalEvents,
          riskEvents: summary.riskEvents,
          findingCount: findings.length,
        },
      });

      reply.code(201);
      return { task: serializeTask(task), summary, findingCount: findings.length };
    },
  );

  // mode3 honeytoken 演练：生成诱饵 + 投毒工件 + 建议网关检测规则（不执行、不动 DB）。
  app.post(
    '/drill/prepare',
    {
      preHandler: [requirePermission('gateway_log:analyze'), requireLicensedFeature('agent_audit')],
    },
    async (request, reply) => {
      assertPlatformTenant(request.currentUser!);
      const body = drillPrepareBody.parse(request.body);
      const canaryToken = body.canaryToken ?? `LSE-DRILL-${randomUUID().slice(0, 8)}`;
      const drill = generateDrillScenario({
        canaryToken,
        channels: body.channels,
        collectorUrl: body.collectorUrl,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'gateway_log.drill_prepare',
        targetType: 'gateway_drill',
        targetId: canaryToken,
        detail: { canaryToken, channels: drill.artifacts.map((a) => a.channel) },
      });
      reply.code(201);
      return {
        drill,
        hint: '将工件交业务部门用其真 agent 处理；在网关策略中心按 drill.gatewayRule 加一条 keyword/audit 规则；事后用 /gateway-logs/analyze 传 canaryTokens=[canaryToken] + 该 agent 的 clientId/sourceIp + 时间窗回判。',
      };
    },
  );
}
