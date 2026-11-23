import type { FastifyInstance } from 'fastify';
import {
  EvalTaskStatus,
  FindingRemediationStatus,
  FindingReviewStatus,
  Prisma,
  Verdict,
} from '@prisma/client';
import { z } from 'zod';
import type { Paginated } from '@lse/shared';
import { prisma } from '../../db.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { failedRetestClosureReason } from '../eval-tasks/retest-evidence.js';
import { isPlatformConnector } from '../../lib/platform-connector-access.js';

const idParams = z.object({ findingId: z.string().uuid() });

const statusListParam = z
  .preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : value,
    z.array(z.nativeEnum(FindingRemediationStatus)),
  )
  .optional();

const listQuery = z.object({
  taskId: z.string().uuid().optional(),
  status: statusListParam,
  overdue: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

const nullableText = (max: number) =>
  z.preprocess(
    (value) => (value === '' || value == null ? null : value),
    z.string().trim().max(max).nullable().optional(),
  );

const updateSchema = z
  .object({
    status: z.nativeEnum(FindingRemediationStatus).optional(),
    owner: nullableText(128),
    team: nullableText(128),
    controlLocation: nullableText(512),
    action: nullableText(4_000),
    dueAt: z.preprocess(
      (value) => (value === '' || value == null ? null : value),
      z.string().datetime({ offset: true }).nullable().optional(),
    ),
    record: nullableText(4_000),
    acceptanceCriteria: nullableText(4_000),
    retestTaskId: z.preprocess(
      (value) => (value === '' || value == null ? null : value),
      z.string().uuid().nullable().optional(),
    ),
    closureEvidence: nullableText(4_000),
  })
  .strict();

const reviewSchema = z
  .object({
    status: z.nativeEnum(FindingReviewStatus),
    reason: nullableText(4_000),
  })
  .strict();

const findingInclude = {
  task: {
    select: {
      id: true,
      name: true,
      status: true,
      createdById: true,
      modelTargetId: true,
      engines: true,
      dimensions: true,
      modelTarget: {
        select: { id: true, name: true, model: true, provider: true, targetType: true },
      },
      questionSets: {
        select: {
          questionSetId: true,
          questionSet: { select: { id: true, name: true } },
        },
      },
    },
  },
  result: { select: { id: true, prompt: true, response: true, createdAt: true } },
  question: { select: { id: true, content: true } },
  remediationRetestTask: {
    select: { id: true, name: true, status: true, modelTargetId: true, finishedAt: true },
  },
} satisfies Prisma.FindingInclude;

type FindingPayload = Prisma.FindingGetPayload<{ include: typeof findingInclude }>;

function serialize(row: FindingPayload) {
  return {
    id: row.id,
    taskId: row.taskId,
    resultId: row.resultId,
    questionId: row.questionId,
    engine: row.engine,
    riskCategory: row.riskCategory,
    severity: row.severity,
    verdict: row.verdict,
    confidence: row.confidence,
    evidenceStrength: row.evidenceStrength,
    executionOutcome: row.executionOutcome,
    reviewStatus: row.reviewStatus,
    reviewReason: row.reviewReason,
    title: row.title,
    evidence: row.evidence,
    detail: row.detail,
    createdAt: row.createdAt,
    task: row.task,
    result: row.result,
    question: row.question,
    remediation: {
      status: row.remediationStatus,
      owner: row.remediationOwner,
      team: row.remediationTeam,
      controlLocation: row.remediationLocation,
      action: row.remediationAction,
      dueAt: row.remediationDueAt,
      record: row.remediationRecord,
      acceptanceCriteria: row.remediationAcceptanceCriteria,
      retestTaskId: row.remediationRetestTaskId,
      closureEvidence: row.remediationClosureEvidence,
      closedAt: row.remediationClosedAt,
    },
    retestTask: row.remediationRetestTask,
  };
}

type SerializedFinding = ReturnType<typeof serialize>;

function canReadFinding(user: CurrentUser, finding: FindingPayload): boolean {
  return user.isBuiltin || finding.task.createdById === user.id || finding.task.createdById === null;
}

function canUpdateFinding(user: CurrentUser, finding: FindingPayload): boolean {
  return user.isBuiltin || finding.task.createdById === user.id;
}

function nonBlank(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function targetScopeMatches(
  original: FindingPayload,
  retest: {
    modelTargetId: string;
    engines: string[];
    dimensions: string[];
    questionSets: Array<{ questionSetId: string }>;
    status: EvalTaskStatus;
  },
): boolean {
  const sameValues = (left: string[], right: string[]) =>
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
  const originalQuestionSets = original.task.questionSets.map((item) => item.questionSetId);
  const retestQuestionSets = retest.questionSets.map((item) => item.questionSetId);
  return (
    original.task.modelTargetId === retest.modelTargetId &&
    sameValues(original.task.engines, retest.engines) &&
    sameValues(original.task.dimensions, retest.dimensions) &&
    sameValues(originalQuestionSets, retestQuestionSets)
  );
}

export async function remediationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: [requirePermission('remediation:read')] }, async (request) => {
    const query = listQuery.parse(request.query);
    const where: Prisma.FindingWhereInput = {};
    if (query.taskId) where.taskId = query.taskId;
    if (query.status?.length) where.remediationStatus = { in: query.status };
    if (query.overdue) {
      where.remediationDueAt = { lt: new Date() };
      where.remediationStatus = {
        notIn: [FindingRemediationStatus.VERIFIED_CLOSED, FindingRemediationStatus.NOT_APPLICABLE],
      };
    }
    if (!request.currentUser!.isBuiltin) {
      where.task = { OR: [{ createdById: request.currentUser!.id }, { createdById: null }] };
    }

    const [items, total] = await Promise.all([
      prisma.finding.findMany({
        where,
        include: findingInclude,
        orderBy: [{ remediationDueAt: 'asc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.finding.count({ where }),
    ]);
    const body: Paginated<SerializedFinding> = {
      items: items.map(serialize),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
    return body;
  });

  app.get(
    '/:findingId',
    { preHandler: [requirePermission('remediation:read')] },
    async (request) => {
      const { findingId } = idParams.parse(request.params);
      const finding = await prisma.finding.findUnique({
        where: { id: findingId },
        include: findingInclude,
      });
      if (!finding) throw notFound('风险发现不存在', 'FINDING_NOT_FOUND');
      if (!canReadFinding(request.currentUser!, finding)) {
        throw notFound('风险发现不存在', 'FINDING_NOT_FOUND');
      }
      return serialize(finding);
    },
  );

  app.patch(
    '/:findingId/review',
    { preHandler: [requirePermission('remediation:update')] },
    async (request) => {
      const { findingId } = idParams.parse(request.params);
      const body = reviewSchema.parse(request.body);
      const current = await prisma.finding.findUnique({
        where: { id: findingId },
        include: findingInclude,
      });
      if (!current) throw notFound('风险发现不存在', 'FINDING_NOT_FOUND');
      if (!canUpdateFinding(request.currentUser!, current)) {
        throw forbidden('无权操作该风险发现', 'REMEDIATION_ACCESS_DENIED');
      }
      if (
        current.remediationStatus === FindingRemediationStatus.VERIFIED_CLOSED &&
        body.status !== current.reviewStatus
      ) {
        throw conflict(
          '已验证关闭的整改项只能先重新打开，再修改复核结论。',
          'REMEDIATION_CLOSED_IMMUTABLE',
        );
      }
      if (body.status !== FindingReviewStatus.UNREVIEWED && !nonBlank(body.reason)) {
        throw conflict('人工复核必须填写复核依据。', 'FINDING_REVIEW_REASON_REQUIRED');
      }

      const reviewed = await prisma.finding.update({
        where: { id: findingId, ...(isPlatformConnector(request.currentUser!)
          ? { task: { createdById: request.currentUser!.id } } : {}) },
        data: {
          reviewStatus: body.status,
          reviewReason: body.status === FindingReviewStatus.UNREVIEWED ? null : body.reason,
        },
        include: findingInclude,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'finding.review',
        targetType: 'finding',
        targetId: findingId,
        detail: { reviewStatus: body.status },
      });
      return { finding: serialize(reviewed) };
    },
  );

  app.patch(
    '/:findingId',
    { preHandler: [requirePermission('remediation:update')] },
    async (request) => {
      const { findingId } = idParams.parse(request.params);
      const body = updateSchema.parse(request.body);
      const current = await prisma.finding.findUnique({
        where: { id: findingId },
        include: findingInclude,
      });
      if (!current) throw notFound('风险发现不存在', 'FINDING_NOT_FOUND');
      if (!canUpdateFinding(request.currentUser!, current)) {
        throw forbidden('无权操作该风险发现', 'REMEDIATION_ACCESS_DENIED');
      }

      const nextStatus = body.status ?? current.remediationStatus;
      if (
        current.remediationStatus === FindingRemediationStatus.VERIFIED_CLOSED &&
        nextStatus !== FindingRemediationStatus.REOPENED
      ) {
        throw conflict(
          '已验证关闭的整改项只能通过重新打开后修改。',
          'REMEDIATION_CLOSED_IMMUTABLE',
        );
      }
      if (nextStatus === FindingRemediationStatus.VERIFIED_CLOSED) {
        if (current.reviewStatus !== 'CONFIRMED') {
          throw conflict('只有人工确认的风险才能验证关闭。', 'REMEDIATION_REVIEW_REQUIRED');
        }
        if (!nonBlank(body.acceptanceCriteria ?? current.remediationAcceptanceCriteria)) {
          throw conflict('验证关闭必须填写验收条件。', 'REMEDIATION_ACCEPTANCE_REQUIRED');
        }
        if (!nonBlank(body.closureEvidence ?? current.remediationClosureEvidence)) {
          throw conflict('验证关闭必须填写关闭证据。', 'REMEDIATION_CLOSURE_EVIDENCE_REQUIRED');
        }
        const retestTaskId = body.retestTaskId ?? current.remediationRetestTaskId;
        if (!retestTaskId) {
          throw conflict('验证关闭必须关联复测任务。', 'REMEDIATION_RETEST_REQUIRED');
        }
        const retestTask = await prisma.evalTask.findUnique({
          where: { id: retestTaskId },
          select: {
            id: true,
            status: true,
            modelTargetId: true,
            engines: true,
            dimensions: true,
            questionSets: { select: { questionSetId: true } },
            name: true,
            finishedAt: true,
            parentTaskId: true,
            createdById: true,
          },
        });
        if (!retestTask || retestTask.status !== EvalTaskStatus.COMPLETED) {
          throw conflict(
            '复测任务必须是已完成任务，异常或不完整任务不能作为关闭依据。',
            'REMEDIATION_RETEST_INCOMPLETE',
          );
        }
        if (!targetScopeMatches(current, retestTask)) {
          throw conflict('复测任务必须使用同一评估对象。', 'REMEDIATION_RETEST_SCOPE_MISMATCH');
        }
        if (retestTask.parentTaskId !== current.taskId || !current.task.createdById ||
            retestTask.createdById !== current.task.createdById) {
          throw conflict('复测必须关联原任务并由同一身份发起。', 'REMEDIATION_RETEST_SCOPE_MISMATCH');
        }
        const repeated = await prisma.finding.count({
          where: {
            taskId: retestTask.id,
            riskCategory: current.riskCategory,
            verdict: { in: [Verdict.FAIL, Verdict.UNKNOWN, Verdict.ERROR] },
            reviewStatus: { not: 'FALSE_POSITIVE' },
          },
        });
        if (repeated > 0) {
          const reopened = await prisma.finding.update({
            where: { id: findingId },
            data: {
              remediationStatus: FindingRemediationStatus.REOPENED,
              remediationRetestTaskId: retestTask.id,
              remediationClosedAt: null,
              remediationClosureEvidence: null,
              remediationRecord: `复测任务「${retestTask.name}」再次命中同类风险，已自动重开。`,
            },
            include: findingInclude,
          });
          await writeAudit({
            actorId: request.currentUser!.id,
            actorName: request.currentUser!.username,
            action: 'remediation.reopened_by_retest',
            targetType: 'finding',
            targetId: findingId,
            detail: { retestTaskId: retestTask.id, repeatedFindingCount: repeated },
          });
          request.log.info(
            { findingId, retestTaskId: retestTask.id },
            'remediation reopened by retest',
          );
          return { reopened: true, finding: serialize(reopened) };
        }
        const [parentFailures, retestResults] = await Promise.all([
          prisma.evalResult.findMany({ where: { taskId: current.taskId, finalVerdict: { in: [Verdict.FAIL, Verdict.ERROR] } },
            select: { questionId: true } }),
          prisma.evalResult.findMany({ where: { taskId: retestTask.id },
            select: { questionId: true, finalVerdict: true, status: true } }),
        ]);
        const requiredQuestionIds = [...new Set([...parentFailures.map(row => row.questionId),
          ...(current.questionId ? [current.questionId] : [])])];
        const closureReason = failedRetestClosureReason({ originalTaskId: current.taskId,
          parentTaskId: retestTask.parentTaskId, originalOwnerId: current.task.createdById,
          retestOwnerId: retestTask.createdById, status: retestTask.status, requiredQuestionIds, results: retestResults });
        if (closureReason) throw conflict('复测必须关联原任务，并完整通过原失败用例后才能结案。', closureReason);
      }

      if (nextStatus === FindingRemediationStatus.NOT_APPLICABLE) {
        if (!nonBlank(body.record ?? current.remediationRecord)) {
          throw conflict(
            '标记不适用必须填写处置记录和适用性依据。',
            'REMEDIATION_NOT_APPLICABLE_REASON_REQUIRED',
          );
        }
      }
      if (
        nextStatus === FindingRemediationStatus.VERIFIED_CLOSED &&
        current.reviewStatus === 'ACCEPTED_RISK'
      ) {
        throw conflict('风险接受不能计为修复或验证关闭。', 'REMEDIATION_ACCEPTED_RISK_NOT_CLOSED');
      }

      const data: Prisma.FindingUpdateInput = {
        remediationStatus: nextStatus,
        ...(body.owner !== undefined ? { remediationOwner: body.owner } : {}),
        ...(body.team !== undefined ? { remediationTeam: body.team } : {}),
        ...(body.controlLocation !== undefined
          ? { remediationLocation: body.controlLocation }
          : {}),
        ...(body.action !== undefined ? { remediationAction: body.action } : {}),
        ...(body.dueAt !== undefined
          ? { remediationDueAt: body.dueAt ? new Date(body.dueAt) : null }
          : {}),
        ...(body.record !== undefined ? { remediationRecord: body.record } : {}),
        ...(body.acceptanceCriteria !== undefined
          ? { remediationAcceptanceCriteria: body.acceptanceCriteria }
          : {}),
        ...(body.retestTaskId !== undefined ? { remediationRetestTaskId: body.retestTaskId } : {}),
        ...(body.closureEvidence !== undefined
          ? { remediationClosureEvidence: body.closureEvidence }
          : {}),
        ...(nextStatus === FindingRemediationStatus.VERIFIED_CLOSED
          ? { remediationClosedAt: new Date() }
          : nextStatus === FindingRemediationStatus.REOPENED
            ? { remediationClosedAt: null }
            : {}),
      };
      const updated = await prisma.finding.update({
        where: { id: findingId },
        data,
        include: findingInclude,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'remediation.update',
        targetType: 'finding',
        targetId: findingId,
        detail: { status: nextStatus, retestTaskId: body.retestTaskId ?? null },
      });
      return { reopened: false, finding: serialize(updated) };
    },
  );
}
