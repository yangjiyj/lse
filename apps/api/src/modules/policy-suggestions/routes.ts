import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PolicySuggestion, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { isGatewaySupportedType, rowMatcher, toGatewayBody } from './export.js';
import { resolveGatewayConn } from './gateway-config.js';

import { probePolicyCapability } from './gateway-client.js';
import { defaultRetestLauncher, type RetestLauncher } from './retest-launcher.js';
import {
  DISPATCHABLE,
  REVIEWABLE,
  backfillRetest,
  dispatchOne,
  generateAndStore,
  launchRetest,
  pollOne,
  recomputeImpact,
} from './service.js';
import type { Matcher } from './regex-safety.js';

/**
 * 网关集成（地址、内部令牌、网关租户）是全平台共用的一份，所有租户会落到同一个网关租户。
 * 这一期策略下发只给平台租户用；其他租户导出后手工导入。
 */
function assertGatewayTenant(user: CurrentUser): void {
  if (!user.tenantIsPlatform) {
    throw forbidden('策略下发目前只在平台租户开放，可先导出再手工导入', 'PLATFORM_TENANT_ONLY');
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PolicySuggestionRoutesOptions {
  retestLauncher?: RetestLauncher;
  /** 测试注入：网关环境（allowlist/令牌/地址），生产取 process.env。 */
  gatewayEnv?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
}

const idParams = z.object({ id: z.string().uuid() });
const STATUSES = [
  'DRAFT',
  'ACCEPTED',
  'MODIFIED',
  'REJECTED',
  'DISPATCHED',
  'GATEWAY_PENDING',
  'PUBLISHED',
  'GATEWAY_REJECTED',
] as const;

const listQuery = z.object({
  taskId: z.string().uuid().optional(),
  modelTargetId: z.string().uuid().optional(),
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

const generateBody = z
  .object({ taskId: z.string().uuid().optional(), modelTargetId: z.string().uuid().optional() })
  .strict()
  .refine((b) => Boolean(b.taskId) !== Boolean(b.modelTargetId), {
    message: '需且仅需指定 taskId 或 modelTargetId 之一',
  });

const matcherBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('regex'), value: z.string().trim().min(1).max(1024) }),
  z.object({
    kind: z.literal('keywords'),
    value: z.array(z.string().trim().min(1).max(1024)).min(1).max(200),
  }),
  z.object({
    kind: z.literal('field_names'),
    value: z.array(z.string().trim().min(1).max(1024)).min(1).max(200),
  }),
]);

const reviewBody = z.discriminatedUnion('decision', [
  z
    .object({ decision: z.literal('accept'), note: z.string().trim().max(2000).optional() })
    .strict(),
  z
    .object({
      decision: z.literal('modify'),
      matcher: matcherBody,
      action: z.enum(['block', 'alert', 'mask']).optional(),
      note: z.string().trim().max(2000).optional(),
    })
    .strict(),
  z.object({ decision: z.literal('reject'), note: z.string().trim().max(2000) }).strict(),
]);

const idsBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).strict();

function visibleTaskFilter(user: CurrentUser): Prisma.EvalTaskWhereInput {
  if (user.isBuiltin) return {};
  return { OR: [{ createdById: user.id }, { createdById: null }] };
}

function writableTaskFilter(user: CurrentUser): Prisma.EvalTaskWhereInput {
  return user.isBuiltin ? {} : { createdById: user.id };
}

function auditBase(request: FastifyRequest) {
  return {
    actorId: request.currentUser!.id,
    actorName: request.currentUser!.username,
    targetType: 'policy_suggestion',
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

async function loadWritable(user: CurrentUser, id: string): Promise<PolicySuggestion> {
  const row = await prisma.policySuggestion.findUnique({
    where: { id },
    include: { task: { select: { createdById: true } } },
  });
  if (!row) throw notFound('策略建议不存在');
  if (!user.isBuiltin && row.task.createdById !== user.id) {
    throw forbidden('仅任务创建人或管理员可操作该策略建议');
  }
  const { task: _task, ...rest } = row;
  return rest;
}

function serialize(row: PolicySuggestion) {
  return {
    ...row,
    matcher: rowMatcher(row),
    gatewaySupported: isGatewaySupportedType(row.type),
    dispatchable: (DISPATCHABLE as readonly string[]).includes(row.status),
  };
}

export async function policySuggestionRoutes(
  app: FastifyInstance,
  options: PolicySuggestionRoutesOptions = {},
): Promise<void> {
  const launcher = options.retestLauncher ?? defaultRetestLauncher;
  const env = options.gatewayEnv ?? process.env;
  const gatewayConn = () => resolveGatewayConn(prisma, env, options.fetchFn);

  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: [requirePermission('remediation:read')] }, async (request) => {
    const q = listQuery.parse(request.query);
    const where: Prisma.PolicySuggestionWhereInput = {
      task: visibleTaskFilter(request.currentUser!),
    };
    if (q.taskId) where.taskId = q.taskId;
    if (q.modelTargetId) where.modelTargetId = q.modelTargetId;
    if (q.status) where.status = q.status;
    const [items, total] = await Promise.all([
      prisma.policySuggestion.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.policySuggestion.count({ where }),
    ]);
    return { items: items.map(serialize), total, page: q.page, pageSize: q.pageSize };
  });

  app.get(
    '/gateway-capability',
    { preHandler: [requirePermission('remediation:read')] },
    async () => {
      const resolved = await gatewayConn();
      if (!resolved.ok) {
        return { configured: false, reachable: false, supported: false, message: resolved.message };
      }
      const cap = await probePolicyCapability(resolved.conn);
      return {
        configured: true,
        reachable: cap.reachable,
        supported: cap.supported,
        message: cap.supported
          ? '网关已开放策略下发接口'
          : cap.reachable
            ? '当前网关版本未开放策略下发接口'
            : (cap.error ?? '无法连接网关'),
      };
    },
  );

  app.post(
    '/export',
    { preHandler: [requirePermission('remediation:read')] },
    async (request, reply) => {
      const { ids } = idsBody.parse(request.body);
      const rows = await prisma.policySuggestion.findMany({
        where: { id: { in: ids }, task: visibleTaskFilter(request.currentUser!) },
        orderBy: { createdAt: 'asc' },
      });
      if (rows.length !== ids.length) throw notFound('部分策略建议不存在或无权访问');
      await writeAudit({
        ...auditBase(request),
        action: 'policy_suggestion.export',
        detail: { count: rows.length, ids },
      });
      reply.header('content-disposition', 'attachment; filename="lse-policy-suggestions.json"');
      return rows.map(toGatewayBody);
    },
  );

  app.get('/:id', { preHandler: [requirePermission('remediation:read')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    let row = await prisma.policySuggestion.findFirst({
      where: { id, task: visibleTaskFilter(request.currentUser!) },
    });
    if (!row) throw notFound('策略建议不存在');
    row = await backfillRetest(prisma, row);
    const findings = await prisma.finding.findMany({
      where: { id: { in: row.sourceFindingIds } },
      select: {
        id: true,
        title: true,
        riskCategory: true,
        severity: true,
        evidence: true,
        result: { select: { prompt: true, response: true } },
      },
      take: 50,
    });
    return { ...serialize(row), sourceFindings: findings, payloadPreview: toGatewayBody(row) };
  });

  app.post(
    '/generate',
    { preHandler: [requirePermission('remediation:update')] },
    async (request) => {
      const body = generateBody.parse(request.body);
      const user = request.currentUser!;
      const scope = body.taskId ? { taskId: body.taskId } : { modelTargetId: body.modelTargetId! };
      if (body.taskId) {
        const task = await prisma.evalTask.findUnique({
          where: { id: body.taskId },
          select: { createdById: true },
        });
        if (!task) throw notFound('评估任务不存在');
        if (!user.isBuiltin && task.createdById !== user.id) {
          throw forbidden('仅任务创建人或管理员可生成策略建议');
        }
      }
      const result = await generateAndStore(prisma, scope, user.id, writableTaskFilter(user));
      await writeAudit({
        ...auditBase(request),
        action: 'policy_suggestion.generate',
        targetId: body.taskId ?? body.modelTargetId ?? null,
        detail: {
          scope,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
        },
      });
      return {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        items: result.items.map(serialize),
      };
    },
  );

  app.post(
    '/:id/review',
    { preHandler: [requirePermission('remediation:update')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = reviewBody.parse(request.body);
      const user = request.currentUser!;
      const row = await loadWritable(user, id);
      if (!(REVIEWABLE as readonly string[]).includes(row.status)) {
        throw conflict('该建议已下发或已驳回，不能再审核', 'POLICY_SUGGESTION_NOT_REVIEWABLE');
      }
      const now = new Date();
      let data: Prisma.PolicySuggestionUpdateInput;
      if (body.decision === 'reject') {
        if (!body.note) throw badRequest('驳回必须填写理由', 'REVIEW_NOTE_REQUIRED');
        data = { status: 'REJECTED', reviewNote: body.note };
      } else if (body.decision === 'accept') {
        data = { status: 'ACCEPTED', reviewNote: body.note ?? null };
      } else {
        const matcher = body.matcher as Matcher;
        const recomputed = await recomputeImpact(prisma, row, matcher);
        if (!recomputed.ok)
          throw badRequest(`规则校验未通过：${recomputed.error}`, 'MATCHER_INVALID');
        data = {
          status: 'MODIFIED',
          matcherKind: matcher.kind,
          matcherValue: matcher.value as Prisma.InputJsonValue,
          estimatedImpact: recomputed.impact as unknown as Prisma.InputJsonValue,
          ...(body.action ? { action: body.action } : {}),
          reviewNote: body.note ?? null,
        };
      }
      const updated = await prisma.policySuggestion.update({
        where: { id },
        data: { ...data, reviewedById: user.id, reviewedAt: now },
      });
      await writeAudit({
        ...auditBase(request),
        action: `policy_suggestion.${body.decision}`,
        targetId: id,
        detail: {
          previousStatus: row.status,
          status: updated.status,
          note: body.note ?? null,
          ...(body.decision === 'modify'
            ? { matcherBefore: rowMatcher(row), matcherAfter: rowMatcher(updated) }
            : {}),
        },
      });
      return serialize(updated);
    },
  );

  app.post(
    '/dispatch',
    { preHandler: [requirePermission('remediation:update')] },
    async (request) => {
      const user = request.currentUser!;
      // 平台专属能力先判租户再校验入参：租户侧不该从校验细节里看出这些接口要什么。
      assertGatewayTenant(user);
      const { ids } = idsBody.parse(request.body);
      const resolved = await gatewayConn();
      if (!resolved.ok) {
        throw badRequest(
          `无法下发：${resolved.message}，可导出后手工导入`,
          'GATEWAY_NOT_CONFIGURED',
        );
      }
      const cap = await probePolicyCapability(resolved.conn);
      if (!cap.supported) {
        throw badRequest(
          '当前网关版本未开放策略下发接口，可导出后手工导入',
          'GATEWAY_CAPABILITY_MISSING',
        );
      }
      const results = [];
      for (const id of ids) {
        const row = await loadWritable(user, id);
        const outcome = await dispatchOne(prisma, resolved.conn, row, user.id);
        results.push(outcome);
        await writeAudit({
          ...auditBase(request),
          action: 'policy_suggestion.dispatch',
          targetId: id,
          detail: {
            ok: outcome.ok,
            status: outcome.status,
            error: outcome.error,
            externalId: row.externalId,
            type: row.type,
          },
        });
      }
      return { results };
    },
  );

  app.post(
    '/:id/refresh',
    { preHandler: [requirePermission('remediation:update')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const user = request.currentUser!;
      let row = await loadWritable(user, id);
      let poll: { polled: boolean; reason: string | null } = { polled: false, reason: null };
      if (row.status === 'GATEWAY_PENDING') {
        assertGatewayTenant(user);
        const resolved = await gatewayConn();
        if (!resolved.ok) throw badRequest(resolved.message, 'GATEWAY_NOT_CONFIGURED');
        const before = row.status;
        poll = await pollOne(prisma, resolved.conn, row, launcher, new Date(), user.id);
        row = await prisma.policySuggestion.findUniqueOrThrow({ where: { id } });
        if (row.status !== before) {
          await writeAudit({
            ...auditBase(request),
            action: 'policy_suggestion.gateway_status',
            targetId: id,
            detail: {
              from: before,
              to: row.status,
              ruleSetVersion: row.ruleSetVersion,
              retestTaskId: row.retestTaskId,
              retestStatus: row.retestStatus,
            },
          });
        }
      }
      // 已发布但复测未发起（如复测服务曾不可用）：刷新时重试发起。
      if (row.status === 'PUBLISHED' && !row.retestTaskId) {
        row = await launchRetest(prisma, row, launcher, user.id);
      }
      row = await backfillRetest(prisma, row);
      return { ...serialize(row), poll };
    },
  );
}
