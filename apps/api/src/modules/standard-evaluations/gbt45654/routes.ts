import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clauseVerdictLabel, getClause } from '@lse/shared';
import { prisma } from '../../../db.js';
import { requirePermission } from '../../../plugins/auth.js';
import { requireLicensedFeature } from '../../../lib/license-enforcement.js';
import { badRequest, notFound, AppError } from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { assertNonEndpointTaskTarget } from '../../../lib/endpoint-task-policy.js';
import { clearEvalTaskCancel, enqueueEvalTask } from '../../../lib/queue.js';
import { STANDARD_OUTPUT_ENGINE } from '../core.js';
import { rejudgeGbtRun } from '../executor.js';
import { standardTaskCounters } from '../task-evidence.js';
import { ANNEX_ITEM_NAME, GBT_BANKS, GBT_BANK_LABEL, GBT_MIN_SAMPLES } from './constants.js';
import { MANUAL_FORM_VERDICTS } from './measures.js';
import {
  ManualReviewError,
  listManualReviewItems,
  submitManualReview,
  submitManualReviewBatch,
} from './manual-review-store.js';
import { config } from '../../../config.js';
import { selectLatestActiveJudgeTarget, type JudgeTargetStore } from '../../engines/judge-target.js';
import {
  MeasureError,
  collectExplicitLabelEvidence,
  confirmMeasure,
  listMeasures,
  runAbuseProbe,
} from './measures-store.js';
import {
  attachGbtMethodsRun,
  getGbtState,
  isGbtMethodsPlan,
} from './pipeline.js';
import { METHOD_IDS } from './method-verdict.js';
import type { GbtMethodOutcome, GbtState } from './state.js';

const uuid = z.string().uuid();
const runParams = z.object({ id: uuid });

const createBody = z.object({
  modelTargetId: uuid,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1_000).optional(),
  seed: z.string().trim().min(1).max(200).optional(),
  targets: z
    .object({
      generation: z.coerce.number().int().min(1).max(20_000).optional(),
      refusal: z.coerce.number().int().min(1).max(20_000).optional(),
      non_refusal: z.coerce.number().int().min(1).max(20_000).optional(),
    })
    .optional(),
  /** 建完立即入队执行。 */
  autoStart: z.boolean().default(true),
});

const reviewQuery = z.object({
  slot: z.coerce.number().int().min(1).max(3).default(1),
  filter: z.enum(['todo', 'done', 'conflict', 'all']).default('todo'),
  kind: z.enum(['safety', 'refusal']).default('safety'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const reviewBody = z.object({
  sampleId: uuid,
  slot: z.coerce.number().int().min(1).max(3).default(1),
  verdict: z.enum(['PASS', 'FAIL', 'REFUSED', 'NOT_REFUSED']),
  itemCode: z.string().trim().max(20).nullable().optional(),
  note: z.string().trim().max(2_000).nullable().optional(),
});

const reviewBatchBody = z.object({
  slot: z.coerce.number().int().min(1).max(3).default(1),
  items: z
    .array(
      z.object({
        sampleId: uuid,
        verdict: z.enum(['PASS', 'FAIL', 'REFUSED', 'NOT_REFUSED']),
        itemCode: z.string().trim().max(20).nullable().optional(),
        note: z.string().trim().max(2_000).nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
});

const judgeStatusQuery = z.object({ modelTargetId: uuid.optional() });

const abuseBody = z
  .object({
    inputs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(10).optional(),
    followUp: z.string().trim().min(1).max(2_000).optional(),
  })
  .optional()
  .default({});

const measureBody = z.object({
  verdict: z.enum(MANUAL_FORM_VERDICTS as unknown as [string, ...string[]]),
  note: z.string().trim().max(2_000).nullable().optional(),
  materials: z.string().trim().max(2_000).nullable().optional(),
});

function methodView(o: GbtMethodOutcome) {
  const clause = getClause(o.spec.clauseId)!;
  return {
    id: o.spec.id,
    clauseId: o.spec.clauseId,
    label: o.spec.label,
    ratioName: o.spec.ratioName,
    verdict: o.verdict,
    verdictLabel: clauseVerdictLabel(clause, o.verdict),
    tested: o.tested,
    hits: o.hits,
    invalid: o.invalid,
    minSamples: o.spec.minSamples,
    shortfall: o.shortfall,
    ratioPercent: o.ratioPercent,
    threshold: { op: o.spec.op, percent: o.spec.percent },
    unavailable: o.unavailable,
    note: o.note,
    /** 细分状态：题数不够、待人工抽检、裁判模型故障等，比「证据不足」说得清缺什么。 */
    status: o.status,
    statusLabel: o.statusLabel,
    planned: o.planned,
    unjudged: o.unjudged,
    ruleTemporary: o.ruleTemporary,
    /** 依据条款：GB/T 45654—2025 第 5.2 条与附录 B.2.2（资料性参考方法）。 */
    basis: o.spec.basis,
    /** 拒答类方法的裁判模型（或规则）预判，只供参考；其他方法为 null。 */
    prejudge: o.prejudge,
  };
}

/** 状态的接口视图：中文标签，不暴露内部枚举。 */
export function gbtStateView(state: GbtState) {
  return {
    methods: METHOD_IDS.map((id) => methodView(state.methods[id])),
    headline: state.headline,
    progress: METHOD_IDS.map((id) => ({ id, ...state.progress[id] })),
    manual: {
      total: state.manual.total,
      decided: state.manual.decided,
      pass: state.manual.pass,
      fail: state.manual.fail,
      pending: state.manual.pending,
      conflict: state.manual.conflict,
      doubleReviewed: state.manual.doubleReviewed,
      doubleAgreed: state.manual.doubleAgreed,
      /** 技术抽检与人工的一致率（只统计两边都有结论的生成内容题）。 */
      technicalAgreement: state.manual.agreement,
    },
    /** 拒答两项的人工抽检进度（人工确认题数、拒答题数、待确认题数）。 */
    refusalManual: state.refusalManual,
    /** 技术抽检的构成：用到哪几种技术，关键词初筛命中、分类模型判出、技术抽检不合格、排进人工优先复核各多少题。 */
    technical: state.technical,
    keyword: state.keyword,
    annexItems: state.annexItems.map((i) => ({
      code: i.code,
      name: i.name,
      tested: i.tested,
      failed: i.failed,
      verdict: i.result.verdict,
      verdictLabel: i.result.label,
      note: i.result.note,
    })),
    clauses: state.clauseResults.map((r) => ({
      clauseId: r.clause.id,
      title: r.clause.title,
      verdict: r.verdict,
      verdictLabel: r.label,
      note: r.note,
    })),
    bankCoverage: state.bankCoverage,
  };
}

/** 正在补跑判定的运行（本进程内）。补跑可能要调用上千次裁判模型，放到后台做，界面轮询状态。 */
const activeRejudges = new Set<string>();

async function loadGbtRun(id: string) {
  const run = await prisma.standardRun.findUnique({
    where: { id },
    include: { task: { include: { modelTarget: true } } },
  });
  if (!run) throw notFound('标准专项运行不存在');
  if (!isGbtMethodsPlan(run.samplePlan)) {
    throw badRequest('这次运行不是按 GB/T 45654 附录 B 方法抽样的运行', 'GBT_RUN_REQUIRED');
  }
  return run;
}

function mapStoreError(error: unknown): never {
  if (error instanceof ManualReviewError || error instanceof MeasureError) {
    throw badRequest(error.message, error.code);
  }
  throw error;
}

export async function gbtMethodRoutes(app: FastifyInstance): Promise<void> {
  /** 按附录 B 方法建任务：从三套固定题库分层抽样并冻结名单。 */
  app.post(
    '/standard-evaluations/gbt45654',
    { preHandler: [requirePermission('standard_eval:run'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      const target = await prisma.modelTarget.findUnique({ where: { id: body.modelTargetId } });
      if (!target) throw badRequest('所选评估对象不存在', 'MODEL_TARGET_NOT_FOUND');
      if (!target.isActive) throw badRequest('所选评估对象已禁用', 'MODEL_TARGET_INACTIVE');
      assertNonEndpointTaskTarget(target);
      if (!['MODEL', 'PLATFORM_APP'].includes(target.targetType)) {
        throw badRequest('生成内容安全评估支持模型或平台智能体对象。', 'GBT_TARGET_UNSUPPORTED');
      }
      const seed = body.seed ?? `GBT45654-${Date.now().toString(36)}`;
      const name = body.name ?? `GB/T 45654 生成内容安全评估 ${seed}`;
      const task = await prisma.evalTask.create({
        data: {
          name,
          description: body.description ?? null,
          status: 'PENDING',
          modelTargetId: target.id,
          engines: [STANDARD_OUTPUT_ENGINE],
          dimensions: ['standard_output_safety'],
          totalQuestions: 0,
          createdById: request.currentUser!.id,
        },
      });
      let attached;
      try {
        attached = await attachGbtMethodsRun(prisma, {
          taskId: task.id,
          modelTarget: {
            id: target.id,
            name: target.name,
            provider: target.provider,
            model: target.model,
            targetType: target.targetType,
          },
          seed,
          targets: body.targets,
          createdById: request.currentUser!.id,
          tenantId: request.currentUser!.tenantId,
        });
      } catch (error) {
        await prisma.evalTask.delete({ where: { id: task.id } }).catch(() => undefined);
        throw badRequest(error instanceof Error ? error.message : '抽样失败', 'GBT_SAMPLING_FAILED');
      }
      await prisma.evalTask.update({
        where: { id: task.id },
        data: { totalQuestions: attached.sampleCount },
      });
      if (body.autoStart) {
        await clearEvalTaskCancel(task.id);
        await enqueueEvalTask(task.id);
      }
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_evaluation.create_gbt45654',
        targetType: 'standard_run',
        targetId: attached.runId,
        detail: {
          taskId: task.id,
          seed,
          selectedCounts: attached.selectedCounts,
          shortages: attached.shortages,
          samplePlanHash: attached.samplePlanHash,
        },
      });
      reply.code(201);
      return {
        taskId: task.id,
        runId: attached.runId,
        name,
        seed,
        sampleCount: attached.sampleCount,
        selectedCounts: attached.selectedCounts,
        shortages: attached.shortages.map((s) => ({
          ...s,
          bankLabel: GBT_BANK_LABEL[s.bank],
          minimum: GBT_MIN_SAMPLES[s.bank],
        })),
        samplePlanHash: attached.samplePlanHash,
        started: body.autoStart,
      };
    },
  );

  app.get(
    '/standard-evaluations/:id/gbt/state',
    { preHandler: [requirePermission('standard_eval:read')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      const run = await loadGbtRun(id);
      const [state, counters] = await Promise.all([
        getGbtState(prisma, id),
        standardTaskCounters(prisma, run.taskId),
      ]);
      if (!state) throw notFound('没有可用的运行状态');
      const plan = run.samplePlan as Record<string, unknown>;
      return {
        runId: id,
        taskId: run.taskId,
        status: run.status,
        seed: plan.seed,
        samplePlanHash: run.samplePlanHash,
        selectedCounts: plan.selectedCounts,
        shortages: ((plan.shortages as Array<{ bank: keyof typeof GBT_BANK_LABEL }> | undefined) ?? []).map(
          (s) => ({ ...s, bankLabel: GBT_BANK_LABEL[s.bank] }),
        ),
        banks: GBT_BANKS.map((bank) => {
          const b = (plan.banks as Record<string, { version: string | null; sha256: string | null; total: number; selected: number } | undefined>)[bank];
          return {
            bank,
            label: GBT_BANK_LABEL[bank],
            version: b?.version ?? null,
            sha256: b?.sha256 ?? null,
            total: b?.total ?? 0,
            selected: b?.selected ?? 0,
          };
        }),
        ...gbtStateView(state),
        /** 被测模型没有给出回答（调用失败、超时）的题数，可用「重试失败题」重新提问。 */
        failedSamples: await prisma.standardSample.count({ where: { standardRunId: id, responseStatus: 'ERROR' } }),
        judging: {
          running: activeRejudges.has(id),
          collecting: run.status === 'RUNNING' || run.status === 'QUEUED',
          unjudged: Math.max(counters.processed - counters.passed - counters.failed - counters.error, 0),
          fault: state.fault ? { reason: state.fault.reason, since: state.fault.since } : null,
        },
      };
    },
  );

  /**
   * 补跑自动判定（关键词、分类模型、拒答）：对已取得回答、尚缺判定的样本补判，并刷新任务计数。
   * 取样时已逐条判定；这里用于取消后的运行、判定失败的样本和复核后重跑。后台执行，立即返回。
   */
  app.post(
    '/standard-evaluations/:id/gbt/judge',
    { preHandler: [requirePermission('standard_eval:run')] },
    async (request, reply) => {
      const { id } = runParams.parse(request.params);
      const run = await loadGbtRun(id);
      // 取样进行中不补跑：回答边取边判，取样结束后执行器会自动补判一次。
      if (run.status === 'RUNNING') {
        throw badRequest('评估正在取样，回答会边取边判，取样结束后会自动补判。', 'GBT_RUN_COLLECTING');
      }
      reply.code(202);
      if (activeRejudges.has(id)) return { runId: id, started: false, running: true };
      activeRejudges.add(id);
      void rejudgeGbtRun(id)
        .catch((error: unknown) => {
          request.log.error({ err: error, runId: id }, 'GB/T 45654 补跑判定失败');
        })
        .finally(() => activeRejudges.delete(id));
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_evaluation.gbt_rejudge',
        targetType: 'standard_run',
        targetId: id,
        detail: { taskId: run.taskId },
      });
      return { runId: id, started: true, running: true };
    },
  );

  /**
   * 重试失败题：被测模型调用失败、超时没有取得回答的题重新提问一次（已取得回答的题沿用原回答，不重复提问），
   * 取到回答后照常逐条判定。运行重新排队，由评估执行器处理。
   */
  app.post(
    '/standard-evaluations/:id/gbt/retry-failed',
    { preHandler: [requirePermission('standard_eval:run')] },
    async (request, reply) => {
      const { id } = runParams.parse(request.params);
      const run = await loadGbtRun(id);
      if (run.status === 'RUNNING' || run.status === 'QUEUED' || run.status === 'PENDING') {
        throw badRequest('评估正在执行，结束后再重试失败题。', 'GBT_RUN_BUSY');
      }
      const failed = await prisma.standardSample.count({ where: { standardRunId: id, responseStatus: 'ERROR' } });
      if (failed === 0) throw badRequest('没有失败的题需要重试。', 'GBT_NO_FAILED_SAMPLES');
      await prisma.$transaction([
        prisma.standardRun.update({ where: { id }, data: { status: 'QUEUED' } }),
        prisma.evalTask.update({ where: { id: run.taskId }, data: { status: 'PENDING', finishedAt: null } }),
      ]);
      await clearEvalTaskCancel(run.taskId);
      await enqueueEvalTask(run.taskId);
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_evaluation.gbt_retry_failed',
        targetType: 'standard_run',
        targetId: id,
        detail: { taskId: run.taskId, failed },
      });
      reply.code(202);
      return { runId: id, taskId: run.taskId, failed, queued: true };
    },
  );

  app.get(
    '/standard-evaluations/:id/gbt/review-items',
    { preHandler: [requirePermission('standard_review:judge')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      await loadGbtRun(id);
      const q = reviewQuery.parse(request.query ?? {});
      const result = await listManualReviewItems(prisma, {
        runId: id,
        slot: q.slot as 1 | 2 | 3,
        reviewerId: request.currentUser!.id,
        filter: q.filter,
        kind: q.kind,
        page: q.page,
        pageSize: q.pageSize,
      });
      return {
        ...result,
        itemOptions: Object.entries(ANNEX_ITEM_NAME).map(([code, name]) => ({ code, name })),
      };
    },
  );

  app.post(
    '/standard-evaluations/:id/gbt/reviews',
    { preHandler: [requirePermission('standard_review:judge')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      await loadGbtRun(id);
      const body = reviewBody.parse(request.body);
      try {
        const saved = await submitManualReview(prisma, {
          runId: id,
          sampleId: body.sampleId,
          slot: body.slot as 1 | 2 | 3,
          verdict: body.verdict,
          itemCode: body.itemCode ?? null,
          note: body.note ?? null,
          reviewer: { id: request.currentUser!.id, name: request.currentUser!.username },
        });
        return { id: saved.id, sampleId: saved.sampleId, slot: saved.slot, verdict: saved.verdict };
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  app.post(
    '/standard-evaluations/:id/gbt/reviews/batch',
    { preHandler: [requirePermission('standard_review:judge')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      await loadGbtRun(id);
      const body = reviewBatchBody.parse(request.body);
      const result = await submitManualReviewBatch(prisma, {
        runId: id,
        slot: body.slot as 1 | 2 | 3,
        items: body.items,
        reviewer: { id: request.currentUser!.id, name: request.currentUser!.username },
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'standard_evaluation.gbt_review_batch',
        targetType: 'standard_run',
        targetId: id,
        detail: { slot: body.slot, count: body.items.length, succeeded: result.succeeded, failed: result.failed },
      });
      return result;
    },
  );

  app.get(
    '/standard-evaluations/:id/gbt/measures',
    { preHandler: [requirePermission('standard_eval:read')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      await loadGbtRun(id);
      return { items: await listMeasures(prisma, id) };
    },
  );

  app.post(
    '/standard-evaluations/:id/gbt/measures/abuse-probe',
    { preHandler: [requirePermission('standard_eval:run')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      const run = await loadGbtRun(id);
      const body = abuseBody.parse(request.body);
      const t = run.task.modelTarget;
      try {
        const saved = await runAbuseProbe(prisma, {
          runId: id,
          target: {
            targetType: t.targetType,
            baseUrl: t.baseUrl,
            apiKey: t.apiKey,
            model: t.model,
            extraHeaders: t.extraHeaders,
            defaultParams: t.defaultParams,
            accessConfig: t.accessConfig,
          },
          inputs: body.inputs,
          followUp: body.followUp,
        });
        return { clauseId: saved.clauseId, evidence: saved.evidence };
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  app.post(
    '/standard-evaluations/:id/gbt/measures/explicit-label',
    { preHandler: [requirePermission('standard_eval:run')] },
    async (request) => {
      const { id } = runParams.parse(request.params);
      await loadGbtRun(id);
      try {
        const saved = await collectExplicitLabelEvidence(prisma, id);
        return { clauseId: saved.clauseId, evidence: saved.evidence };
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  app.put(
    '/standard-evaluations/:id/gbt/measures/:clauseId',
    { preHandler: [requirePermission('standard_review:judge')] },
    async (request) => {
      const params = z.object({ id: uuid, clauseId: z.string().min(1).max(100) }).parse(request.params);
      await loadGbtRun(params.id);
      const body = measureBody.parse(request.body);
      try {
        const saved = await confirmMeasure(prisma, {
          runId: params.id,
          clauseId: params.clauseId,
          verdict: body.verdict as 'conform' | 'nonconform' | 'not_applicable',
          note: body.note ?? null,
          materials: body.materials ?? null,
          reviewer: { id: request.currentUser!.id, name: request.currentUser!.username },
        });
        return { clauseId: saved.clauseId, verdict: saved.verdict, confirmedAt: saved.confirmedAt };
      } catch (error) {
        if (error instanceof AppError) throw error;
        return mapStoreError(error);
      }
    },
  );

  /** 新建弹窗用：本次会用哪个裁判模型。不返回密钥。 */
  app.get(
    '/standard-evaluations/gbt45654/judge-status',
    { preHandler: [requirePermission('standard_eval:run')] },
    async (request) => {
      const q = judgeStatusQuery.parse(request.query ?? {});
      const sut = q.modelTargetId
        ? await prisma.modelTarget.findUnique({
            where: { id: q.modelTargetId },
            select: { id: true, baseUrl: true, model: true },
          })
        : null;
      const same = (c: { id?: string | null; baseUrl: string; model: string }) =>
        !!sut && ((!!c.id && c.id === sut.id) || (c.baseUrl === sut.baseUrl && c.model === sut.model));
      const none = {
        configured: false,
        id: null as string | null,
        name: null as string | null,
        model: null as string | null,
        lastTestStatus: null as string | null,
        lastTestedAt: null as Date | null,
        sameAsTarget: false,
        source: null as 'model_target' | 'env' | null,
      };
      const selected = await selectLatestActiveJudgeTarget(prisma as unknown as JudgeTargetStore);
      if (selected.found) {
        const t = selected.target;
        if (!t) return none;
        const row = await prisma.modelTarget.findUnique({ where: { id: t.id }, select: { lastTestedAt: true } });
        return {
          configured: true,
          id: t.id,
          name: t.name,
          model: t.model,
          lastTestStatus: t.lastTestStatus,
          lastTestedAt: row?.lastTestedAt ?? null,
          sameAsTarget: same(t),
          source: 'model_target' as const,
        };
      }
      if (config.LLM_JUDGE_BASE_URL && config.LLM_JUDGE_API_KEY && config.LLM_JUDGE_MODEL) {
        return {
          ...none,
          configured: true,
          name: '系统默认裁判模型',
          model: config.LLM_JUDGE_MODEL,
          sameAsTarget: same({ baseUrl: config.LLM_JUDGE_BASE_URL, model: config.LLM_JUDGE_MODEL }),
          source: 'env' as const,
        };
      }
      return none;
    },
  );
}
