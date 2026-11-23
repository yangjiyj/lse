import { platformAppEnabled } from '../eval-targets/platform-adapters/index.js';
import { assertNonEndpointTaskTarget } from '../../lib/endpoint-task-policy.js';
import { randomUUID } from 'node:crypto';
import CronParser from 'cron-parser';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { enqueueEvalTask } from '../../lib/queue.js';
import { assertLicensedFeature } from '../../lib/license-enforcement.js';
import { validateCronMinimumInterval } from '../eval-tasks/continuous-evaluation.js';
import { evalTaskCreateBody } from '../eval-tasks/routes.js';
// worker 经本模块间接编译 eval-tasks 路由，需要 app.ts 中对 FastifyRequest.currentUser 的类型扩展
import type {} from '../../app.js';
import { sampledTotal } from '../eval-tasks/sampling.js';
import { REPORT_TIME_ZONE } from '../reports/labels.js';
import { checkQuestionSets } from '../question-sets/enabled.js';

export type EvalPlanTrigger = 'manual' | 'schedule' | 'ci';
export interface TriggerEvalPlanOptions {
  triggeredBy: EvalPlanTrigger;
  actorId: string | null;
  actorName?: string | null;
}
export interface TriggerEvalPlanResult {
  status: 'triggered' | 'skipped';
  /** 本次触发的运行记录 ID（跳过也有）。 */
  runId: string;
  taskId?: string;
  reason?: string;
}

/** 计划模板 = 发起评估任务的参数快照；评估对象与任务名由计划本身决定。 */
export const evalPlanTemplateSchema = evalTaskCreateBody.omit({ modelTargetId: true, name: true });
export type EvalPlanTemplate = z.infer<typeof evalPlanTemplateSchema>;

export const MIN_PLAN_INTERVAL_MINUTES = 5;
export const MAX_PLAN_INTERVAL_MINUTES = 60 * 24 * 31;
const UNFINISHED_STATUSES = ['PENDING', 'RUNNING', 'PAUSED'] as const;
/** 检查 cron 间隔时向后展开的触发次数：覆盖 "0,50 * * * *" 这类不等间隔表达式。 */
const INTERVAL_SCAN_COUNT = 200;

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw badRequest(`时区无效：${timezone}`, 'EVAL_PLAN_TIMEZONE_INVALID');
  }
}

/** 保存时校验 cron：可解析、且任意相邻两次触发间隔不小于计划的最小间隔。 */
export function assertCronAllowed(cron: string, timezone: string, minIntervalMinutes: number): void {
  const minimumMs = minIntervalMinutes * 60_000;
  try {
    validateCronMinimumInterval(cron, minimumMs);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('最小间隔')) {
      throw badRequest(
        `cron 两次触发间隔小于最小间隔 ${minIntervalMinutes} 分钟`,
        'EVAL_PLAN_INTERVAL_TOO_SHORT',
      );
    }
    throw badRequest(`cron 表达式无效：${message}`, 'EVAL_PLAN_CRON_INVALID');
  }
  const interval = CronParser.parseExpression(cron, { tz: timezone });
  let previous = interval.next().getTime();
  for (let i = 0; i < INTERVAL_SCAN_COUNT; i += 1) {
    const current = interval.next().getTime();
    if (current - previous < minimumMs) {
      throw badRequest(
        `cron 两次触发间隔小于最小间隔 ${minIntervalMinutes} 分钟`,
        'EVAL_PLAN_INTERVAL_TOO_SHORT',
      );
    }
    previous = current;
  }
}

export function nextRunAt(cron: string, timezone: string, now = new Date()): Date | null {
  try {
    return CronParser.parseExpression(cron, { tz: timezone, currentDate: now }).next().toDate();
  } catch {
    return null;
  }
}

/** 解析并规范化模板：抽样计划固定种子，保证同计划各次运行题目一致、可按题目对齐回归。 */
export function normalizeTemplate(input: unknown): EvalPlanTemplate {
  const parsed = evalPlanTemplateSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw badRequest('评估计划模板参数不合法', 'EVAL_PLAN_TEMPLATE_INVALID', parsed.error.issues);
  }
  const template = { ...parsed.data, questionSetIds: [...new Set(parsed.data.questionSetIds)] };
  if (template.sampleSize && !template.sampleSeed) template.sampleSeed = randomUUID();
  return template;
}

type Tx = Prisma.TransactionClient;

async function recordSkip(
  tx: Tx,
  planId: string,
  options: TriggerEvalPlanOptions,
  reason: string,
): Promise<TriggerEvalPlanResult> {
  const run = await tx.evalPlanRun.create({
    data: {
      planId,
      triggeredBy: options.triggeredBy,
      status: 'skipped',
      reason,
      actorId: options.actorId,
    },
  });
  await tx.evalPlan.update({ where: { id: planId }, data: { lastSkipReason: reason } });
  return { status: 'skipped', runId: run.id, reason };
}

async function licenseSkipReason(): Promise<string | null> {
  try {
    await assertLicensedFeature('web_ai');
    return null;
  } catch (err) {
    return `授权不可用：${(err as Error).message}`;
  }
}

/** 调度抖动容差：BullMQ 实际触发时刻可能比理论时刻有偏差，避免把整点计划误判为间隔不足。 */
const INTERVAL_GRACE_MS = 60_000;

function formatPlanTime(date: Date): string {
  return date.toLocaleString('zh-CN', { hour12: false, timeZone: REPORT_TIME_ZONE });
}

/**
 * 触发评估计划：启停/授权/对象可用性/并发/最小间隔检查通过后生成一个真实 EvalTask（关联 planId）并入队；
 * 否则记一条 skipped 运行记录并写明原因。无论结果都写运行记录和审计日志。
 * 供 JWT 路由、BullMQ 调度消费者、CI（API Token）入口共用。
 */
export async function triggerEvalPlan(
  db: PrismaClient,
  planId: string,
  options: TriggerEvalPlanOptions,
): Promise<TriggerEvalPlanResult> {
  const licenseReason = await licenseSkipReason();
  const result = await db.$transaction(
    async (tx): Promise<TriggerEvalPlanResult> => {
      // 行锁串行化同一计划的并发触发（调度与手动/CI 同时到达时只生成一个任务）。
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "eval_plans" WHERE "id" = ${planId} FOR UPDATE`;
      if (locked.length === 0) throw notFound('评估计划不存在');
      const plan = await tx.evalPlan.findUniqueOrThrow({
        where: { id: planId },
        include: { target: true },
      });
      assertNonEndpointTaskTarget(plan.target);
      if (plan.target.targetType === 'PLATFORM_APP' && !platformAppEnabled())
        throw forbidden('平台智能体测评功能未启用', 'PLATFORM_APP_DISABLED');
      if (options.triggeredBy === 'schedule' && !plan.enabled) {
        return recordSkip(tx, plan.id, options, '计划已停用');
      }
      if (licenseReason) return recordSkip(tx, plan.id, options, licenseReason);
      if (!plan.target.isActive) return recordSkip(tx, plan.id, options, '评估对象已禁用');
      if (plan.target.targetType === 'GATEWAY_LOG') {
        return recordSkip(tx, plan.id, options, '网关流量观测对象不能用于主动评估');
      }
      const running = await tx.evalTask.findFirst({
        where: { planId: plan.id, status: { in: [...UNFINISHED_STATUSES] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true },
      });
      if (running) {
        return recordSkip(
          tx,
          plan.id,
          options,
          `上一次运行任务未结束（${running.id}，${running.status}）`,
        );
      }
      const now = new Date();
      if (
        plan.lastTriggeredAt &&
        now.getTime() - plan.lastTriggeredAt.getTime() <
          plan.minIntervalMinutes * 60_000 - INTERVAL_GRACE_MS
      ) {
        return recordSkip(
          tx,
          plan.id,
          options,
          `距上次触发（${formatPlanTime(plan.lastTriggeredAt)}）不足最小间隔 ${plan.minIntervalMinutes} 分钟`,
        );
      }
      let template: EvalPlanTemplate;
      try {
        template = normalizeTemplate(plan.templateParams);
      } catch {
        return recordSkip(tx, plan.id, options, '计划模板参数已不符合当前任务创建规则，请编辑计划');
      }
      const { sets, missing, disabled } = await checkQuestionSets(tx, template.questionSetIds);
      if (missing.length > 0) {
        return recordSkip(tx, plan.id, options, '部分样本库已被删除，请编辑计划');
      }
      if (disabled.length > 0) {
        return recordSkip(tx, plan.id, options, '样本库已禁用，请编辑计划');
      }
      const poolQuestions = sets.reduce((sum, s) => sum + s.questionCount, 0);
      const task = await tx.evalTask.create({
        data: {
          name: `${plan.name} · ${formatPlanTime(now)}`.slice(0, 200),
          description: template.description ?? plan.description ?? null,
          status: 'PENDING',
          modelTargetId: plan.targetId,
          engines: template.engines,
          dimensions: template.dimensions,
          concurrency: template.concurrency,
          totalQuestions: sampledTotal(poolQuestions, template.sampleSize),
          sampleSize: template.sampleSize ?? null,
          sampleSeed: template.sampleSize ? (template.sampleSeed ?? null) : null,
          createdById: options.actorId ?? plan.createdById,
          planId: plan.id,
          questionSets: {
            create: template.questionSetIds.map((questionSetId) => ({ questionSetId })),
          },
        },
        select: { id: true },
      });
      const run = await tx.evalPlanRun.create({
        data: {
          planId: plan.id,
          taskId: task.id,
          triggeredBy: options.triggeredBy,
          status: 'triggered',
          actorId: options.actorId,
        },
      });
      await tx.evalPlan.update({
        where: { id: plan.id },
        data: { lastTriggeredAt: now, lastSkipReason: null },
      });
      return { status: 'triggered', runId: run.id, taskId: task.id };
    },
    { timeout: 20_000 },
  );
  if (result.taskId) await enqueueEvalTask(result.taskId);
  await writeAudit({
    actorId: options.actorId,
    actorName: options.actorName ?? (options.actorId ? null : `system:${options.triggeredBy}`),
    action: 'eval_plan.trigger',
    targetType: 'eval_plan',
    targetId: planId,
    detail: { triggeredBy: options.triggeredBy, ...result },
  });
  return result;
}
