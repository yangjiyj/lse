import { platformAppEnabled } from '../eval-targets/platform-adapters/index.js';
import { assertNonEndpointTaskTarget } from '../../lib/endpoint-task-policy.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  STANDARD_BANK_TYPES,
  STANDARD_GROUP_DEFAULT_COUNTS,
  STANDARD_GROUP_BANK,
  STANDARD_PROFILE_ID,
  STANDARD_PROFILE_VERSION,
  STANDARD_SAMPLING_ALGORITHM_VERSION,
  STANDARD_JUDGMENT_RULE_VERSION,
  STANDARD_METRIC_FORMULA_VERSION,
  type StandardBankType,
  type StandardSampleGroup,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { currentTenantId } from '../../lib/tenant-context.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { auditDownload, resolveDownloadWatermark } from '../../lib/data-security.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { clearEvalTaskCancel, enqueueEvalTask, requestEvalTaskCancel } from '../../lib/queue.js';
import { config } from '../../config.js';
import {
  STANDARD_PROFILE,
  buildRevisionHash,
  classifyTechnicalResponse,
  computeStandardMetrics,
  latestJudgment,
  metricInputsFromSamples,
  profileSnapshot,
  sampleReleaseItems,
  sha256,
  STANDARD_OUTPUT_ENGINE,
  validateReleaseItems,
} from './core.js';
import { renderStandardReportPdf } from './report-pdf.js';
import { countStandardVerdicts, standardTaskCounters } from './task-evidence.js';
import { cancelStandardRun } from './cancel.js';
import { gbtMethodRoutes } from './gbt45654/routes.js';
import { getGbtState } from './gbt45654/pipeline.js';
import { METHOD_IDS } from './gbt45654/method-verdict.js';

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const runParams = z.object({ id: uuid });
const revisionBody = z
  .object({
    questionId: uuid.optional(),
    content: z.string().trim().min(1).max(20_000).optional(),
    expectedBehavior: z.string().trim().max(20_000).nullable().optional(),
    category: z.string().trim().max(200).nullable().optional(),
    primaryCategory: z.string().trim().max(100).nullable().optional(),
    secondaryCategories: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    nonRefusalTopic: z.string().trim().max(100).nullable().optional(),
    language: z.string().trim().min(2).max(20).default('zh'),
    modality: z.string().trim().min(1).max(30).default('text'),
    purpose: z.string().trim().max(500).nullable().optional(),
    source: z.string().trim().max(500).nullable().optional(),
  })
  .refine((body) => Boolean(body.questionId) || Boolean(body.content), {
    message: '必须提供 questionId 或 content',
  });

const reviewBody = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  reason: z.string().trim().max(2_000).optional(),
  correctionRef: z.string().trim().max(200).optional(),
});

const releaseBody = z.object({
  name: z.string().trim().min(1).max(200),
  profileId: z.string().trim().default(STANDARD_PROFILE_ID),
  profileVersion: z.string().trim().default(STANDARD_PROFILE_VERSION),
  language: z.string().trim().default('zh'),
  modalities: z.array(z.string().trim().min(1).max(30)).min(1).max(10).default(['text']),
  items: z
    .array(
      z.object({
        revisionId: uuid,
        bankType: z.enum(STANDARD_BANK_TYPES as [StandardBankType, ...StandardBankType[]]),
        primaryCategory: z.string().trim().max(100).nullable().optional(),
        nonRefusalTopic: z.string().trim().max(100).nullable().optional(),
      }),
    )
    .min(1)
    .max(100_000),
});

const runBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1_000).optional(),
  bankReleaseId: uuid,
  modelTargetId: uuid,
  seed: z.string().trim().min(1).max(200),
  mode: z.enum(['FORMAL', 'DIAGNOSTIC']).default('FORMAL'),
  counts: z
    .object({
      MANUAL_SAFETY: z.coerce.number().int().min(1).max(100_000).optional(),
      TECHNICAL_SAFETY: z.coerce.number().int().min(1).max(100_000).optional(),
      SHOULD_REFUSE: z.coerce.number().int().min(1).max(100_000).optional(),
      NON_REFUSAL: z.coerce.number().int().min(1).max(100_000).optional(),
    })
    .optional(),
  boundary: z.string().trim().min(1).max(500).default('指定 API 服务及可确认配置'),
});

const simulateBody = z.object({
  responses: z
    .array(
      z.object({
        sampleId: uuid,
        status: z.enum(['SUCCESS', 'ERROR']).default('SUCCESS'),
        response: z.string().max(100_000).nullable().optional(),
        rawResponse: z.unknown().nullable().optional(),
        latencyMs: z.number().int().min(0).max(86_400_000).optional(),
        httpStatus: z.number().int().min(100).max(599).nullable().optional(),
        errorMessage: z.string().max(2_000).nullable().optional(),
      }),
    )
    .min(1)
    .max(100_000),
});

const executeBody = z.object({}).strict().optional().default({});

const releaseInclude = {
  items: {
    include: {
      revision: {
        include: {
          reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
    orderBy: [{ bankType: 'asc' }, { position: 'asc' }],
  },
} satisfies Prisma.StandardBankReleaseInclude;
type ReleasePayload = Prisma.StandardBankReleaseGetPayload<{ include: typeof releaseInclude }>;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function serializeRevision(
  revision: Prisma.StandardQuestionRevisionGetPayload<{ include: { reviews: true } }>,
) {
  const latest = revision.reviews
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return {
    id: revision.id,
    questionId: revision.questionId,
    version: revision.version,
    content: revision.content,
    expectedBehavior: revision.expectedBehavior,
    category: revision.category,
    primaryCategory: revision.primaryCategory,
    secondaryCategories: revision.secondaryCategories,
    nonRefusalTopic: revision.nonRefusalTopic,
    language: revision.language,
    modality: revision.modality,
    purpose: revision.purpose,
    source: revision.source,
    standardProfileId: revision.standardProfileId,
    standardProfileVersion: revision.standardProfileVersion,
    contentHash: revision.contentHash,
    review: latest
      ? {
          decision: latest.decision,
          reviewerId: latest.reviewerId,
          reason: latest.reason,
          createdAt: latest.createdAt,
        }
      : null,
    createdById: revision.createdById,
    createdAt: revision.createdAt,
  };
}

function serializeRelease(release: ReleasePayload) {
  return {
    id: release.id,
    profileId: release.profileId,
    profileVersion: release.profileVersion,
    name: release.name,
    language: release.language,
    modalities: release.modalities,
    status: release.status,
    counts: release.counts,
    validation: release.validation,
    overallHash: release.overallHash,
    publishedAt: release.publishedAt,
    itemCount: release.items.length,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
  };
}

function releaseValidation(release: ReleasePayload) {
  const validation = validateReleaseItems(
    release.items.map((item) => ({
      revisionId: item.revisionId,
      bankType: item.bankType as StandardBankType,
      primaryCategory: item.primaryCategory,
      nonRefusalTopic: item.nonRefusalTopic,
      language: item.revision.language,
      modality: item.revision.modality,
    })),
  );
  const reviewErrors: string[] = [];
  for (const item of release.items) {
    const latest = item.revision.reviews[0];
    if (!latest || latest.decision !== 'APPROVED')
      reviewErrors.push(`样本版本 ${item.revisionId} 尚未通过审核`);
    else if (latest.reviewerId === item.revision.createdById)
      reviewErrors.push(`样本版本 ${item.revisionId} 的作者不能批准自己的版本`);
  }
  return {
    ...validation,
    errors: [...new Set([...validation.errors, ...reviewErrors])],
    ok: validation.errors.length === 0 && reviewErrors.length === 0,
  };
}

async function getReleaseForValidation(id: string): Promise<ReleasePayload> {
  const release = await prisma.standardBankRelease.findUnique({
    where: { id },
    include: releaseInclude,
  });
  // 租户口径：平台发布的（tenantId 为空）各租户可用，任务自动样本集只给所属租户。
  const tenantId = currentTenantId();
  if (!release || (release.tenantId !== null && tenantId !== null && release.tenantId !== tenantId)) {
    throw notFound('标准样本集发布版不存在');
  }
  return release;
}

function plannedCounts(run: { samplePlan: Prisma.JsonValue }): Record<StandardSampleGroup, number> {
  const value = run.samplePlan as Record<string, unknown>;
  return {
    MANUAL_SAFETY: Number(value.MANUAL_SAFETY ?? STANDARD_GROUP_DEFAULT_COUNTS.MANUAL_SAFETY),
    TECHNICAL_SAFETY: Number(
      value.TECHNICAL_SAFETY ?? STANDARD_GROUP_DEFAULT_COUNTS.TECHNICAL_SAFETY,
    ),
    SHOULD_REFUSE: Number(value.SHOULD_REFUSE ?? STANDARD_GROUP_DEFAULT_COUNTS.SHOULD_REFUSE),
    NON_REFUSAL: Number(value.NON_REFUSAL ?? STANDARD_GROUP_DEFAULT_COUNTS.NON_REFUSAL),
  };
}

/**
 * 只读地算出一次运行当前应有的状态：指标、证据完整度、运行/任务状态与计数，不写库。
 * GET 接口（详情页每 5 秒轮询的 summary）只能用它；要落库的写路径调用下面的 refreshRunState。
 */
async function computeRunState(runId: string) {
  const run = await prisma.standardRun.findUnique({
    where: { id: runId },
    include: { samples: { include: { judgments: true } }, task: true },
  });
  if (!run) throw notFound('标准专项运行不存在');
  const inputs = metricInputsFromSamples(run.samples);
  const legacyMetrics = computeStandardMetrics(inputs, plannedCounts(run));
  const allResponses =
    run.samples.length > 0 &&
    run.samples.every(
      (sample) => sample.responseStatus === 'SUCCESS' || sample.responseStatus === 'ERROR',
    );
  let metrics = legacyMetrics;
  let evidenceCompleteness =
    metrics.complete && allResponses ? 'COMPLETE' : inputs.length > 0 ? 'PARTIAL' : 'MISSING';
  // 按附录 B 方法抽样的运行：总体结论由四项方法条款折算（旧版四组指标不再适用，
  // 技术样本组计划条数为 0，按旧口径会永远显示未达到）。
  const gbt = await getGbtState(prisma, runId);
  if (gbt) {
    const verdicts = METHOD_IDS.map((id) => gbt.methods[id].verdict);
    const overallConclusion = verdicts.includes('nonconform')
      ? 'NOT_ATTAINED'
      : verdicts.every((v) => v === 'conform')
        ? 'ATTAINED'
        : 'INSUFFICIENT_EVIDENCE';
    metrics = { ...legacyMetrics, overallConclusion, complete: overallConclusion !== 'INSUFFICIENT_EVIDENCE' };
    evidenceCompleteness =
      overallConclusion !== 'INSUFFICIENT_EVIDENCE' && allResponses
        ? 'COMPLETE'
        : METHOD_IDS.some((id) => gbt.methods[id].tested > 0)
          ? 'PARTIAL'
          : 'MISSING';
  }
  // 首期范围不包含人工评审。只要自动执行已经为每个冻结样本留下终态响应，
  // 就结束自动测评并允许生成报告；人工证据不足由 metrics/evidenceCompleteness
  // 明确表达，不能把自动链路伪装成“等待人工审核”而阻塞交付。
  // 取消过的运行不能在这里被复活：详情页每 5 秒轮询一次摘要，只要这里无条件按
  // 样本状态重算，用户点的取消就会被刷回 RUNNING，任务永远挂着而没有 worker 在跑。
  const canceled = run.status === 'CANCELED' || run.task.status === 'CANCELED';
  const status = canceled ? 'CANCELED' : allResponses ? 'COMPLETED' : 'WAITING_REVIEW';
  const terminal = status === 'COMPLETED' || status === 'CANCELED';
  // 判定计数和进度一起回写：老的标准运行只写过 processedQuestions，
  // 通过/未通过/异常留在 0，会让任务列表和报告快照读成一次空跑。
  const counters = countStandardVerdicts(run.samples);
  return { run, metrics, evidenceCompleteness, status, canceled, terminal, counters };
}

/** 重算并落库（仅限写路径：技术判定、生成报告）。GET 不得调用。 */
async function refreshRunState(runId: string) {
  const state = await computeRunState(runId);
  const { run, metrics, evidenceCompleteness, status, canceled, terminal, counters } = state;
  // 已取消的运行：取消路由已把「取消当时」的计数写回，之后的写路径不得再改写这些数字，
  // 否则同一个已取消任务会在「打开前/后」显示两套计数。
  if (canceled) return { run, metrics, evidenceCompleteness, status };
  await prisma.$transaction([
    prisma.standardRun.update({
      where: { id: runId },
      data: { conclusion: metrics.overallConclusion, evidenceCompleteness, status },
    }),
    prisma.evalTask.update({
      where: { id: run.taskId },
      data: {
        status: status === 'COMPLETED' ? 'COMPLETED' : 'RUNNING',
        processedQuestions: counters.processed,
        passedCount: counters.passed,
        failedCount: counters.failed,
        errorCount: counters.error,
        progress: counters.total ? counters.processed / counters.total : 0,
        // 完成时间只认第一次；否则每轮询一次就把"完成时间"往后推一次。
        finishedAt: terminal ? (run.task.finishedAt ?? new Date()) : null,
      },
    }),
  ]);
  return { run, metrics, evidenceCompleteness, status };
}

function samplePlanHash(seed: string, counts: Record<StandardSampleGroup, number>) {
  return sha256({ seed, counts, algorithm: STANDARD_SAMPLING_ALGORITHM_VERSION });
}

export async function standardEvaluationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  // 按 GB/T 45654 附录 B 方法抽样的运行：抽样、人工抽检、措施核验与方法条款结论。
  await gbtMethodRoutes(app);

  app.get(
    '/standards/profiles',
    { preHandler: [requirePermission('standard_eval:read')] },
    async () => ({
      items: [profileSnapshot()],
    }),
  );

  app.get(
    '/standard-question-revisions',
    { preHandler: [requirePermission('standard_eval:read')] },
    async (request) => {
      const query = z
        .object({
          questionId: uuid.optional(),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      const items = await prisma.standardQuestionRevision.findMany({
        where: query.questionId ? { questionId: query.questionId } : undefined,
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        include: { reviews: true },
      });
      return { items: items.map(serializeRevision) };
    },
  );

  app.post(
    '/standard-question-revisions',
    { preHandler: [requirePermission('standard_bank:edit'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = revisionBody.parse(request.body);
      const source = body.questionId
        ? await prisma.question.findUnique({ where: { id: body.questionId } })
        : null;
      if (body.questionId && !source) throw notFound('源样本不存在');
      const content = body.content ?? source!.content;
      const expectedBehavior =
        body.expectedBehavior !== undefined
          ? body.expectedBehavior
          : (source?.expectedBehavior ?? null);
      const category = body.category !== undefined ? body.category : (source?.category ?? null);
      const primaryCategory = body.primaryCategory !== undefined ? body.primaryCategory : category;
      const secondaryCategories = body.secondaryCategories ?? [];
      const language = body.language || source?.language || 'zh';
      const modality = body.modality || 'text';
      const previous = body.questionId
        ? await prisma.standardQuestionRevision.findFirst({
            where: { questionId: body.questionId },
            orderBy: { version: 'desc' },
            select: { version: true },
          })
        : null;
      const revision = await prisma.standardQuestionRevision.create({
        data: {
          questionId: body.questionId,
          version: (previous?.version ?? 0) + 1,
          content,
          expectedBehavior,
          category,
          primaryCategory,
          secondaryCategories,
          nonRefusalTopic: body.nonRefusalTopic ?? null,
          language,
          modality,
          purpose: body.purpose ?? null,
          source: body.source ?? 'MANUAL',
          standardProfileId: STANDARD_PROFILE_ID,
          standardProfileVersion: STANDARD_PROFILE_VERSION,
          contentHash: buildRevisionHash({
            content,
            expectedBehavior,
            primaryCategory,
            secondaryCategories,
            language,
            modality,
            purpose: body.purpose,
          }),
          createdById: request.currentUser!.id,
        },
        include: { reviews: true },
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_revision.create',
        targetType: 'standard_question_revision',
        targetId: revision.id,
        detail: { questionId: body.questionId, version: revision.version },
      });
      reply.code(201);
      return serializeRevision(revision);
    },
  );

  app.post(
    '/standard-question-revisions/:id/submit',
    { preHandler: [requirePermission('standard_bank:edit'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const revision = await prisma.standardQuestionRevision.findUnique({ where: { id } });
      if (!revision) throw notFound('样本版本不存在');
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_revision.submit',
        targetType: 'standard_question_revision',
        targetId: id,
      });
      return { id, submitted: true, message: '已提交审核；作者不能批准自己的版本。' };
    },
  );

  app.post(
    '/standard-question-revisions/:id/reviews',
    { preHandler: [requirePermission('standard_bank:review'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = reviewBody.parse(request.body);
      const revision = await prisma.standardQuestionRevision.findUnique({ where: { id } });
      if (!revision) throw notFound('样本版本不存在');
      if (body.decision === 'APPROVED' && revision.createdById === request.currentUser!.id)
        throw conflict('作者不能批准自己的样本版本', 'STANDARD_AUTHOR_CANNOT_APPROVE');
      const review = await prisma.standardQuestionReview.create({
        data: {
          revisionId: id,
          reviewerId: request.currentUser!.id,
          decision: body.decision,
          reason: body.reason,
          correctionRef: body.correctionRef,
        },
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_revision.review',
        targetType: 'standard_question_revision',
        targetId: id,
        detail: { decision: body.decision },
      });
      return review;
    },
  );

  app.get(
    '/standard-bank-releases',
    { preHandler: [requirePermission('standard_eval:read')] },
    async () => {
      const tenantId = currentTenantId();
      const items = await prisma.standardBankRelease.findMany({
        // 平台发布的标准题集（tenantId 为空）+ 本租户的自动样本集；别家的自动样本集不出现。
        where: tenantId ? { OR: [{ tenantId: null }, { tenantId }] } : {},
        orderBy: { createdAt: 'desc' },
        include: { items: true },
      });
      return { items: items.map((item) => ({ ...item, itemCount: item.items.length })) };
    },
  );

  app.post(
    '/standard-bank-releases',
    { preHandler: [requirePermission('standard_bank:edit'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = releaseBody.parse(request.body);
      if (
        body.profileId !== STANDARD_PROFILE_ID ||
        body.profileVersion !== STANDARD_PROFILE_VERSION
      )
        throw badRequest('只能创建当前已版本化的标准专项配置', 'STANDARD_PROFILE_VERSION_MISMATCH');
      const revisions = await prisma.standardQuestionRevision.findMany({
        where: { id: { in: body.items.map((item) => item.revisionId) } },
        select: { id: true },
      });
      const found = new Set(revisions.map((item) => item.id));
      const missing = body.items.map((item) => item.revisionId).filter((id) => !found.has(id));
      if (missing.length > 0) throw badRequest(`样本版本不存在：${missing.join(', ')}`);
      const release = await prisma.standardBankRelease.create({
        data: {
          profileId: body.profileId,
          profileVersion: body.profileVersion,
          name: body.name,
          language: body.language,
          modalities: body.modalities,
          items: {
            createMany: { data: body.items.map((item, index) => ({ ...item, position: index })) },
          },
        },
        include: releaseInclude,
      });
      const validation = releaseValidation(release);
      const updated = await prisma.standardBankRelease.update({
        where: { id: release.id },
        data: { counts: json(validation.counts), validation: json(validation) },
        include: releaseInclude,
      });
      reply.code(201);
      return serializeRelease(updated);
    },
  );

  app.post(
    '/standard-bank-releases/:id/validate',
    { preHandler: [requirePermission('standard_bank:review')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const release = await getReleaseForValidation(id);
      const validation = releaseValidation(release);
      const updated = await prisma.standardBankRelease.update({
        where: { id },
        data: { counts: json(validation.counts), validation: json(validation) },
        include: releaseInclude,
      });
      return { release: serializeRelease(updated), validation };
    },
  );

  app.post(
    '/standard-bank-releases/:id/publish',
    { preHandler: [requirePermission('standard_bank:publish'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const release = await getReleaseForValidation(id);
      if (release.status === 'PUBLISHED') return serializeRelease(release);
      const validation = releaseValidation(release);
      if (!validation.ok)
        throw badRequest('样本集发布校验未通过', 'STANDARD_BANK_RELEASE_INVALID', validation);
      const overallHash = sha256({
        profileId: release.profileId,
        profileVersion: release.profileVersion,
        items: release.items.map((item) => ({
          revisionId: item.revisionId,
          bankType: item.bankType,
          primaryCategory: item.primaryCategory,
          nonRefusalTopic: item.nonRefusalTopic,
          contentHash: item.revision.contentHash,
        })),
      });
      const published = await prisma.standardBankRelease.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          counts: json(validation.counts),
          validation: json(validation),
          overallHash,
          publishedAt: new Date(),
          publishedById: request.currentUser!.id,
        },
        include: releaseInclude,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_bank.publish',
        targetType: 'standard_bank_release',
        targetId: id,
        detail: { overallHash, counts: validation.counts },
      });
      return serializeRelease(published);
    },
  );

  app.post(
    '/standard-evaluations/preflight',
    { preHandler: [requirePermission('standard_eval:run')] },
    async (request) => {
      const body = runBody.parse(request.body);
      const release = await getReleaseForValidation(body.bankReleaseId);
      const target = await prisma.modelTarget.findUnique({
        where: { id: body.modelTargetId },
        select: {
          id: true,
          name: true,
          provider: true,
          model: true,
          targetType: true,
          isActive: true,
        },
      });
      if (!target) throw notFound('模型 API 对象不存在');
      assertNonEndpointTaskTarget(target);
      if (!target.isActive) throw badRequest('模型 API 对象未启用');
      if (release.status !== 'PUBLISHED')
        throw badRequest('正式专项只能使用已发布样本集版本', 'STANDARD_BANK_RELEASE_NOT_PUBLISHED');
      const validation = releaseValidation(release);
      if (body.mode === 'FORMAL' && !validation.ok)
        throw badRequest('正式专项样本集校验未通过', 'STANDARD_BANK_RELEASE_INVALID', validation);
      const counts = { ...STANDARD_GROUP_DEFAULT_COUNTS, ...(body.counts ?? {}) };
      const groups = Object.entries(counts).map(([group, count]) => ({
        group,
        count,
        bankType: STANDARD_GROUP_BANK[group as StandardSampleGroup],
      }));
      const available = Object.fromEntries(
        STANDARD_BANK_TYPES.map((bankType) => [
          bankType,
          release.items.filter((item) => item.bankType === bankType).length,
        ]),
      );
      const shortages = groups.filter((item) => (available[item.bankType] ?? 0) < item.count);
      return {
        // 诊断/模拟运行允许在样本不足时按现有样本继续，缺口进入抽样计划和报告；
        // 只有正式专项才把样本集完整性作为创建阻断条件。
        ok: body.mode === 'DIAGNOSTIC' || (shortages.length === 0 && validation.ok),
        blocking: body.mode === 'FORMAL' && (shortages.length > 0 || !validation.ok),
        mode: body.mode,
        target,
        scope: {
          language: release.language,
          modalities: release.modalities,
          boundary: body.boundary,
        },
        counts,
        available,
        shortages,
        validation,
        noExternalCalls: true,
      };
    },
  );

  app.get(
    '/standard-evaluations',
    { preHandler: [requirePermission('standard_eval:read')] },
    async (request) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        })
        .parse(request.query ?? {});
      const [total, runs] = await prisma.$transaction([
        prisma.standardRun.count(),
        prisma.standardRun.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: {
            task: {
              select: {
                id: true,
                name: true,
                status: true,
                processedQuestions: true,
                totalQuestions: true,
                modelTarget: { select: { id: true, name: true, model: true } },
              },
            },
            bankRelease: { select: { id: true, name: true, status: true } },
            createdBy: { select: { id: true, username: true } },
            _count: { select: { samples: true, reports: true } },
          },
        }),
      ]);
      return {
        items: runs.map((run) => ({
          runId: run.id,
          taskId: run.taskId,
          name: run.task.name,
          status: run.status,
          conclusion: run.conclusion,
          evidenceCompleteness: run.evidenceCompleteness,
          bankReleaseName: run.bankRelease.name,
          modelTargetName: run.task.modelTarget?.name ?? null,
          modelName: run.task.modelTarget?.model ?? null,
          sampleCount: run._count.samples,
          reportCount: run._count.reports,
          processedCount: run.task.processedQuestions,
          createdBy: run.createdBy?.username ?? null,
          createdAt: run.createdAt,
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },
  );

  app.post(
    '/standard-evaluations',
    { preHandler: [requirePermission('standard_eval:run'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = runBody.parse(request.body);
      const target = await prisma.modelTarget.findUnique({
        where: { id: body.modelTargetId },
        select: {
          id: true,
          name: true,
          provider: true,
          model: true,
          targetType: true,
          isActive: true,
        },
      });
      if (!target) throw notFound('模型 API 对象不存在');
      assertNonEndpointTaskTarget(target);
      if (target.targetType === 'PLATFORM_APP' && !platformAppEnabled()) throw forbidden('平台智能体测评功能未启用', 'PLATFORM_APP_DISABLED');
      if (!target.isActive) throw badRequest('模型 API 对象未启用');
      const release = await getReleaseForValidation(body.bankReleaseId);
      if (release.status !== 'PUBLISHED') throw badRequest('标准专项只能引用已发布样本集版本');
      const validation = releaseValidation(release);
      if (body.mode === 'FORMAL' && !validation.ok)
        throw badRequest('正式专项样本集校验未通过', 'STANDARD_BANK_RELEASE_INVALID', validation);
      const counts = { ...STANDARD_GROUP_DEFAULT_COUNTS, ...(body.counts ?? {}) };
      const groups = Object.entries(counts).map(([group, count]) => ({
        group,
        count,
        bankType: STANDARD_GROUP_BANK[group as StandardSampleGroup],
      }));
      const available = Object.fromEntries(
        STANDARD_BANK_TYPES.map((bankType) => [
          bankType,
          release.items.filter((item) => item.bankType === bankType).length,
        ]),
      );
      const shortages = groups.filter((item) => (available[item.bankType] ?? 0) < item.count);
      if (body.mode === 'FORMAL' && shortages.length > 0) {
        const shortage = shortages[0]!;
        throw badRequest(
          `${shortage.group} 可用样本不足：需要 ${shortage.count}，当前 ${available[shortage.bankType] ?? 0}`,
          'STANDARD_SAMPLE_POOL_INSUFFICIENT',
          { shortages },
        );
      }
      const selected: Array<{ group: StandardSampleGroup; item: (typeof release.items)[number] }> =
        [];
      const selectedCounts = Object.fromEntries(
        groups.map((item) => [item.group, Math.min(item.count, available[item.bankType] ?? 0)]),
      );
      for (const group of Object.keys(counts) as StandardSampleGroup[]) {
        const bankType = STANDARD_GROUP_BANK[group];
        const candidates = release.items.filter((item) => item.bankType === bankType);
        const sampleCount = Math.min(counts[group], candidates.length);
        if (sampleCount === 0) continue;
        selected.push(
          ...sampleReleaseItems(candidates, group, sampleCount, body.seed).map((item) => ({
            group,
            item,
          })),
        );
      }
      if (selected.length === 0)
        throw badRequest(
          '诊断专项样本集没有可用样本，无法执行自动测评',
          'STANDARD_NO_AVAILABLE_SAMPLES',
        );
      const plan = {
        ...counts,
        seed: body.seed,
        mode: body.mode,
        algorithm: STANDARD_SAMPLING_ALGORITHM_VERSION,
        selectedCounts,
        shortages,
        selectionMode: shortages.length > 0 ? 'AVAILABLE_ONLY' : 'EXACT',
        generatedAt: new Date().toISOString(),
      };
      const taskAndRun = await prisma.$transaction(async (tx) => {
        const task = await tx.evalTask.create({
          data: {
            name: body.name,
            description: body.description,
            status: 'PENDING',
            modelTargetId: body.modelTargetId,
            engines: [STANDARD_OUTPUT_ENGINE],
            dimensions: ['standard_output_safety'],
            totalQuestions: selected.length,
            createdById: request.currentUser!.id,
          },
        });
        const run = await tx.standardRun.create({
          data: {
            taskId: task.id,
            bankReleaseId: body.bankReleaseId,
            profileSnapshot: json(profileSnapshot()),
            modelSnapshot: json({
              id: target.id,
              name: target.name,
              provider: target.provider,
              model: target.model,
              targetType: target.targetType,
            }),
            boundary: body.boundary,
            language: release.language,
            modality: release.modalities[0] ?? 'text',
            samplePlan: json(plan),
            samplePlanHash: samplePlanHash(body.seed, counts),
            createdById: request.currentUser!.id,
          },
        });
        const sequenceByGroup = new Map<StandardSampleGroup, number>();
        await tx.standardSample.createMany({
          data: selected.map((selection) => {
            const sequence = (sequenceByGroup.get(selection.group) ?? 0) + 1;
            sequenceByGroup.set(selection.group, sequence);
            return {
              standardRunId: run.id,
              group: selection.group,
              sequence,
              revisionId: selection.item.revisionId,
              releaseItemId: selection.item.id,
              inputSnapshot: selection.item.revision.content,
              expectedBehavior: selection.item.revision.expectedBehavior,
              primaryCategory: selection.item.primaryCategory,
              nonRefusalTopic: selection.item.nonRefusalTopic,
            };
          }),
        });
        return { task, run };
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_evaluation.create',
        targetType: 'standard_run',
        targetId: taskAndRun.run.id,
        detail: {
          taskId: taskAndRun.task.id,
          bankReleaseId: body.bankReleaseId,
          counts,
          shortages,
          selectedCounts,
          seed: body.seed,
          noExternalCalls: true,
        },
      });
      reply.code(201);
      return {
        taskId: taskAndRun.task.id,
        runId: taskAndRun.run.id,
        status: taskAndRun.run.status,
        sampleCount: selected.length,
        counts,
        shortages,
        selectedCounts,
        samplingPlanHash: taskAndRun.run.samplePlanHash,
        noExternalCalls: true,
        message:
          body.mode === 'DIAGNOSTIC'
            ? shortages.length > 0
              ? '诊断专项已按现有样本冻结抽样；样本缺口已记录，仅供开发验证。创建阶段未调用外部模型 API。'
              : '诊断专项已冻结抽样名单，仅供开发验证；创建阶段未调用外部模型 API。'
            : '已冻结正式测评抽样名单；创建阶段未调用模型 API，执行提交后将调用已配置的模型 API。',
      };
    },
  );

  app.post(
    '/standard-evaluations/:id/execute',
    { preHandler: [requirePermission('standard_eval:run'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      executeBody.parse(request.body);
      const run = await prisma.standardRun.findUnique({
        where: { id },
        include: { task: true },
      });
      if (!run) throw notFound('标准专项运行不存在');
      if (run.status === 'RUNNING') throw conflict('标准专项已在执行中', 'STANDARD_RUN_RUNNING');
      if (run.status === 'COMPLETED')
        throw conflict('已完成运行不可重复执行，请新建复测任务', 'STANDARD_RUN_COMPLETED');

      await clearEvalTaskCancel(run.taskId);
      await prisma.$transaction([
        prisma.standardRun.update({
          where: { id },
          data: { status: 'PENDING', evidenceCompleteness: 'MISSING' },
        }),
        prisma.evalTask.update({
          where: { id: run.taskId },
          data: { status: 'PENDING', finishedAt: null },
        }),
      ]);
      await enqueueEvalTask(run.taskId);
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_evaluation.execute',
        targetType: 'standard_run',
        targetId: id,
        detail: { taskId: run.taskId, queue: 'eval-tasks', automaticJudgment: true },
      });
      return {
        runId: id,
        taskId: run.taskId,
        status: 'QUEUED',
        queued: true,
        automaticJudgment: true,
        message: '已进入评估队列；将调用已配置模型 API。',
      };
    },
  );

  app.post(
    '/standard-evaluations/:id/cancel',
    { preHandler: [requirePermission('standard_eval:run')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      // 停止逻辑在 cancel.ts，和检测任务的「停止」共用。
      const { taskId } = await cancelStandardRun(request.currentUser!, id);
      return { runId: id, taskId, status: 'CANCELED' };
    },
  );

  app.get(
    '/standard-evaluations/:id',
    { preHandler: [requirePermission('standard_eval:read')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      const run = await prisma.standardRun.findUnique({
        where: { id },
        include: {
          task: {
            include: {
              modelTarget: { select: { id: true, name: true, provider: true, model: true } },
            },
          },
          bankRelease: { select: { id: true, name: true, overallHash: true, status: true } },
          _count: { select: { samples: true, reports: true } },
        },
      });
      if (!run) throw notFound('标准专项运行不存在');
      return run;
    },
  );

  app.get(
    '/standard-evaluations/:id/review-items',
    { preHandler: [requirePermission('standard_review:judge')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      const samples = await prisma.standardSample.findMany({
        where: { standardRunId: id },
        orderBy: [{ group: 'asc' }, { sequence: 'asc' }],
        include: { judgments: { orderBy: { createdAt: 'desc' }, take: 10 } },
      });
      return {
        items: samples,
        manualRequired: samples.filter(
          (sample) =>
            sample.group !== 'TECHNICAL_SAFETY' && !latestJudgment(sample.judgments, 'MANUAL'),
        ).length,
      };
    },
  );

  /** 仅用于 CI/模拟试点的本地响应注入；不访问外部 API，且每次注入追加尝试记录。 */
  app.post(
    '/standard-evaluations/:id/simulate',
    { preHandler: [requirePermission('standard_eval:run')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      const body = simulateBody.parse(request.body);
      const run = await prisma.standardRun.findUnique({ where: { id }, select: { id: true } });
      if (!run) throw notFound('标准专项运行不存在');
      const samples = await prisma.standardSample.findMany({
        where: { standardRunId: id },
        select: { id: true },
      });
      const allowed = new Set(samples.map((sample) => sample.id));
      for (const response of body.responses)
        if (!allowed.has(response.sampleId))
          throw badRequest(`样本不属于该标准专项：${response.sampleId}`);
      const results = [];
      for (const response of body.responses) {
        const last = await prisma.standardSampleAttempt.findFirst({
          where: { sampleId: response.sampleId },
          orderBy: { attemptNo: 'desc' },
          select: { attemptNo: true },
        });
        const attempt = await prisma.standardSampleAttempt.create({
          data: {
            sampleId: response.sampleId,
            attemptNo: (last?.attemptNo ?? 0) + 1,
            status: response.status,
            response: response.response ?? null,
            rawResponse:
              response.rawResponse === undefined
                ? undefined
                : response.rawResponse === null
                  ? Prisma.JsonNull
                  : json(response.rawResponse),
            latencyMs: response.latencyMs,
            httpStatus: response.httpStatus,
            errorMessage: response.errorMessage,
          },
        });
        const selected = response.status === 'SUCCESS' && response.response?.trim();
        await prisma.standardSample.update({
          where: { id: response.sampleId },
          data: {
            responseStatus: response.status,
            ...(selected
              ? {
                  selectedAttemptNo: attempt.attemptNo,
                  selectedResponse: response.response,
                  selectedRawResponse:
                    response.rawResponse === undefined
                      ? undefined
                      : response.rawResponse === null
                        ? Prisma.JsonNull
                        : json(response.rawResponse),
                  selectedAt: new Date(),
                }
              : {}),
          },
        });
        results.push({
          sampleId: response.sampleId,
          attemptNo: attempt.attemptNo,
          status: response.status,
        });
      }
      await prisma.standardRun.update({ where: { id }, data: { status: 'WAITING_REVIEW' } });
      return {
        simulationOnly: true,
        results,
        message: '模拟响应已追加保存；未发起真实模型 API 请求。',
      };
    },
  );

  app.post(
    '/standard-evaluations/:id/technical-judge',
    { preHandler: [requirePermission('standard_eval:run')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      // 先加载标准专项任务：StandardRun 按租户隔离，别人的任务在这里就 404，
      // 不会写脏别人的国标结论。
      const run = await prisma.standardRun.findUnique({ where: { id }, select: { id: true } });
      if (!run) throw notFound('标准专项任务不存在');
      const samples = await prisma.standardSample.findMany({
        where: { standardRunId: id, selectedResponse: { not: null } },
        include: { judgments: true },
      });
      if (samples.length === 0) throw badRequest('没有可供技术判定的有效响应');
      const judgmentIds = [];
      for (const sample of samples) {
        const outcome = classifyTechnicalResponse(sample.selectedResponse);
        const previous = latestJudgment(sample.judgments, 'TECHNICAL');
        const judgment = await prisma.standardJudgment.create({
          data: {
            sampleId: sample.id,
            source: 'TECHNICAL',
            ruleVersion: STANDARD_JUDGMENT_RULE_VERSION,
            safetyOutcome:
              sample.group === 'MANUAL_SAFETY' || sample.group === 'TECHNICAL_SAFETY'
                ? outcome.safetyOutcome
                : null,
            refusalOutcome:
              sample.group === 'SHOULD_REFUSE' || sample.group === 'NON_REFUSAL'
                ? outcome.refusalOutcome
                : null,
            reason: outcome.reason,
            evidence: '技术规则版本化判定；未命中不等于全面覆盖。',
            previousId: previous?.id,
          },
        });
        judgmentIds.push(judgment.id);
      }
      await refreshRunState(id);
      return {
        ruleVersion: STANDARD_JUDGMENT_RULE_VERSION,
        count: judgmentIds.length,
        judgmentIds,
      };
    },
  );

  app.get(
    '/standard-evaluations/:id/summary',
    { preHandler: [requirePermission('standard_eval:read')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      // 纯读：只计算，不写库（详情页每 5 秒轮询；重算落库放在执行器/技术判定/取消/生成报告）。
      const state = await computeRunState(id);
      const totalSamples = state.run.samples.length;
      const processedSamples = state.run.samples.filter(
        (sample) => sample.responseStatus !== 'PENDING',
      ).length;
      return {
        runId: id,
        status: state.status,
        evidenceCompleteness: state.evidenceCompleteness,
        conclusion: state.metrics.overallConclusion,
        metrics: state.metrics,
        progress: {
          processed: processedSamples,
          total: totalSamples,
          ratio: totalSamples > 0 ? processedSamples / totalSamples : 0,
        },
        // 抽样计划里记着本次覆盖了哪些风险类别、缺哪些，报告和界面都要如实引用。
        coverage: (state.run.samplePlan as { coverage?: unknown } | null)?.coverage ?? null,
        formulaVersion: STANDARD_METRIC_FORMULA_VERSION,
        trainingData: 'NOT_EVALUATED_API_ONLY',
        scope: STANDARD_PROFILE.scope,
      };
    },
  );

  app.post(
    '/standard-evaluations/:id/report',
    {
      preHandler: [requirePermission('standard_report:generate'), requireLicensedFeature('web_ai')],
    },
    async (request) => {
      const { id } = runParams.parse(request.params);
      const state = await refreshRunState(id);
      const samples = await prisma.standardSample.findMany({
        where: { standardRunId: id },
        orderBy: [{ group: 'asc' }, { sequence: 'asc' }],
        include: { judgments: { orderBy: { createdAt: 'desc' } } },
      });
      const run = await prisma.standardRun.findUnique({
        where: { id },
        include: {
          bankRelease: true,
          task: {
            include: {
              modelTarget: { select: { id: true, name: true, provider: true, model: true } },
            },
          },
        },
      });
      if (!run) throw notFound('标准专项运行不存在');
      const previous = await prisma.standardReport.findFirst({
        where: { standardRunId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const content = {
        schemaVersion: 1,
        title: '模型 API 输出安全测评 / GB/T 45654 指标对标',
        scope: {
          standard: STANDARD_PROFILE.number,
          profileId: STANDARD_PROFILE_ID,
          profileVersion: STANDARD_PROFILE_VERSION,
          boundary: run.boundary,
          language: run.language,
          modality: run.modality,
          modelTarget: run.task.modelTarget,
        },
        conclusion: state.metrics.overallConclusion,
        metrics: state.metrics,
        evidence: {
          releaseId: run.bankReleaseId,
          releaseHash: run.bankRelease.overallHash,
          samplePlanHash: run.samplePlanHash,
          formulaVersion: STANDARD_METRIC_FORMULA_VERSION,
          samplingAlgorithm: STANDARD_SAMPLING_ALGORITHM_VERSION,
          judgmentRule: STANDARD_JUDGMENT_RULE_VERSION,
          judgmentSource: 'TECHNICAL_REFERENCE_ONLY',
          manualReviewStatus: '本次未评估',
          samples: samples.map((sample) => ({
            sampleId: sample.id,
            group: sample.group,
            sequence: sample.sequence,
            responseStatus: sample.responseStatus,
            judgmentSources: [...new Set(sample.judgments.map((judgment) => judgment.source))],
          })),
        },
        limitations: [
          '训练数据总体、来源和抽样本次未评估：客户仅提供模型 API。',
          '人工评审、人工抽检、人员分配和人工结果回填本次未评估；自动结果标注为技术判定/参考指标。',
          '正式专业样本集与人工确认的样本适切性本次未验收；当前模拟数据不得冒充正式样本集。',
          '报告只适用于本次对象、范围、样本和时间，不代表整项国标认证或全面合规。',
          '技术规则未命中不等于全面安全；敏感原文按受控证据编号追溯。',
        ],
      };
      const report = await prisma.standardReport.create({
        data: {
          standardRunId: id,
          version: (previous?.version ?? 0) + 1,
          title: '模型 API 输出安全测评 / GB/T 45654 指标对标',
          conclusion: state.metrics.overallConclusion,
          content: json(content),
          generatedById: request.currentUser!.id,
        },
      });
      return report;
    },
  );

  app.get(
    '/standard-evaluations/:id/report',
    { preHandler: [requirePermission('standard_eval:read')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      // StandardReport 是子表（不带 tenantId）：先按父任务校验租户归属。
      const run = await prisma.standardRun.findUnique({ where: { id }, select: { id: true } });
      if (!run) throw notFound('标准专项任务不存在');
      const report = await prisma.standardReport.findFirst({
        where: { standardRunId: id },
        orderBy: { version: 'desc' },
      });
      if (!report) throw notFound('标准对标报告不存在');
      return report;
    },
  );

  app.get(
    '/standard-evaluations/:id/report.pdf',
    { preHandler: [requirePermission('standard_eval:read')] },
    async (request, reply) => {
      const { id } = runParams.parse(request.params);
      // StandardReport 是子表（不带 tenantId）：先按父任务校验租户归属。
      const run = await prisma.standardRun.findUnique({ where: { id }, select: { id: true } });
      if (!run) throw notFound('标准专项任务不存在');
      const report = await prisma.standardReport.findFirst({
        where: { standardRunId: id },
        orderBy: { version: 'desc' },
      });
      if (!report) throw notFound('标准对标报告不存在');
      const watermark = await resolveDownloadWatermark(request.currentUser!);
      const buffer = await renderStandardReportPdf(report.content as never, {
        cjkFontPath: config.PDF_CJK_FONT_PATH || undefined,
        cjkFontFamily: config.PDF_CJK_FONT_FAMILY || undefined,
        watermark: watermark?.text,
      });
      await auditDownload(
        request.currentUser!,
        {
          kind: 'standard_report_pdf',
          targetType: 'standard_run',
          targetId: report.standardRunId,
          detail: { format: 'pdf', version: report.version, watermark: watermark?.text ?? null },
        },
        request,
      );
      reply.header(
        'Content-Disposition',
        `attachment; filename="standard-evaluation-${report.standardRunId}-v${report.version}.pdf"`,
      );
      reply.type('application/pdf');
      return reply.send(buffer);
    },
  );

  app.get(
    '/standard-evaluations/:id/report.evidence.json',
    { preHandler: [requirePermission('standard_eval:read')] },
    async (request, reply) => {
      const { id } = runParams.parse(request.params);
      const run = await prisma.standardRun.findUnique({
        where: { id },
        include: {
          bankRelease: { select: { id: true, name: true, overallHash: true, status: true } },
          samples: {
            orderBy: [{ group: 'asc' }, { sequence: 'asc' }],
            include: {
              attempts: { orderBy: { attemptNo: 'asc' } },
              judgments: { orderBy: { createdAt: 'asc' } },
            },
          },
        },
      });
      if (!run) throw notFound('标准专项运行不存在');
      const watermark = await resolveDownloadWatermark(request.currentUser!);
      const attachment = {
        ...(watermark ? { watermark: watermark.text } : {}),
        schemaVersion: 1,
        attachmentType: 'standard-evaluation-evidence',
        runId: run.id,
        standard: STANDARD_PROFILE.number,
        profile: run.profileSnapshot,
        model: run.modelSnapshot,
        boundary: run.boundary,
        bankRelease: run.bankRelease,
        samplePlan: run.samplePlan,
        samplePlanHash: run.samplePlanHash,
        manualReviewStatus: '本次未评估',
        samples: run.samples.map((sample) => ({
          id: sample.id,
          group: sample.group,
          sequence: sample.sequence,
          inputSnapshot: sample.inputSnapshot,
          expectedBehavior: sample.expectedBehavior,
          responseStatus: sample.responseStatus,
          selectedAttemptNo: sample.selectedAttemptNo,
          selectedResponse: sample.selectedResponse,
          selectedRawResponse: sample.selectedRawResponse,
          attempts: sample.attempts,
          judgments: sample.judgments,
        })),
      };
      await auditDownload(
        request.currentUser!,
        {
          kind: 'standard_evidence_json',
          targetType: 'standard_run',
          targetId: run.id,
          detail: { format: 'json', watermark: watermark?.text ?? null },
        },
        request,
      );
      reply.header(
        'Content-Disposition',
        `attachment; filename="standard-evaluation-${run.id}-evidence.json"`,
      );
      reply.type('application/json');
      return reply.send(attachment);
    },
  );
}
