import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { config } from '../../config.js';
import { getRedisConnection } from '../../lib/queue.js';
import { triggerEvalPlan } from './service.js';
import { runInTenant } from '../../lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';

export const EVAL_PLAN_QUEUE_NAME = 'eval-plans';
export const EVAL_PLAN_JOB_NAME = 'trigger';

export interface EvalPlanJobData {
  planId: string;
}

export interface SchedulablePlan {
  id: string;
  cron: string;
  timezone: string;
  enabled: boolean;
}

/** 计划调度端口：路由在新建/编辑/启停/删除时调用；测试注入假实现。 */
export interface PlanScheduler {
  sync(plan: SchedulablePlan): Promise<void>;
  remove(planId: string): Promise<void>;
}

export function evalPlanSchedulerId(planId: string): string {
  return `eval-plan:${planId}`;
}

/** 基于 BullMQ Job Scheduler 的实现：每个启用计划一个 scheduler，按 cron+时区产生触发 job。 */
export function createBullmqPlanScheduler(queue: Queue<EvalPlanJobData>): PlanScheduler {
  return {
    async sync(plan) {
      if (!plan.enabled) {
        await queue.removeJobScheduler(evalPlanSchedulerId(plan.id));
        return;
      }
      await queue.upsertJobScheduler(
        evalPlanSchedulerId(plan.id),
        { pattern: plan.cron, tz: plan.timezone },
        {
          name: EVAL_PLAN_JOB_NAME,
          data: { planId: plan.id },
          opts: { removeOnComplete: 100, removeOnFail: 200, attempts: 1 },
        },
      );
    },
    async remove(planId) {
      await queue.removeJobScheduler(evalPlanSchedulerId(planId));
    },
  };
}

let planQueue: Queue<EvalPlanJobData> | null = null;

export function getEvalPlanQueue(): Queue<EvalPlanJobData> {
  if (!planQueue) {
    planQueue = new Queue<EvalPlanJobData>(EVAL_PLAN_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return planQueue;
}

export async function closeEvalPlanQueue(): Promise<void> {
  if (planQueue) {
    await planQueue.close();
    planQueue = null;
  }
}

const isTest = process.env.LSE_TEST === '1' || config.NODE_ENV === 'test';

/**
 * 默认调度器：生产环境走 BullMQ；测试环境（LSE_TEST=1）不连 Redis，与 enqueueEvalTask 的测试跳过口径一致。
 * 调度同步失败只记录日志不抛出——计划已落库，worker 启动时会按库重新对齐。
 */
export function defaultPlanScheduler(): PlanScheduler {
  if (isTest) return { sync: async () => undefined, remove: async () => undefined };
  const inner = () => createBullmqPlanScheduler(getEvalPlanQueue());
  return {
    async sync(plan) {
      try {
        await inner().sync(plan);
      } catch (err) {
        console.error(`[eval-plan] 调度同步失败 planId=${plan.id}:`, (err as Error).message);
      }
    },
    async remove(planId) {
      try {
        await inner().remove(planId);
      } catch (err) {
        console.error(`[eval-plan] 调度移除失败 planId=${planId}:`, (err as Error).message);
      }
    },
  };
}

/** 按数据库对齐调度：启用计划 upsert，库里不存在或已停用的 scheduler 移除。worker 启动时调用。 */
export async function reconcilePlanSchedulers(
  db: PrismaClient,
  queue: Queue<EvalPlanJobData>,
): Promise<{ upserted: number; removed: number }> {
  const scheduler = createBullmqPlanScheduler(queue);
  const plans = await db.evalPlan.findMany({
    select: { id: true, cron: true, timezone: true, enabled: true },
  });
  const enabledIds = new Set(plans.filter((p) => p.enabled).map((p) => evalPlanSchedulerId(p.id)));
  let upserted = 0;
  for (const plan of plans.filter((p) => p.enabled)) {
    await scheduler.sync(plan);
    upserted += 1;
  }
  let removed = 0;
  for (const existing of await queue.getJobSchedulers(0, -1)) {
    if (existing.key.startsWith('eval-plan:') && !enabledIds.has(existing.key)) {
      await queue.removeJobScheduler(existing.key);
      removed += 1;
    }
  }
  return { upserted, removed };
}

/** 调度消费者：每个触发 job 调用 triggerEvalPlan（并发/间隔/启停检查都在服务函数内）。 */
export function createEvalPlanWorker(
  db: PrismaClient,
  options: { queueName?: string; connection?: ConnectionOptions } = {},
): Worker<EvalPlanJobData> {
  return new Worker<EvalPlanJobData>(
    options.queueName ?? EVAL_PLAN_QUEUE_NAME,
    async (job) => {
      const plan = await db.evalPlan.findUnique({ where: { id: job.data.planId } });
      if (!plan) return { status: 'skipped', reason: '评估计划不存在' };
      // 调度器没有租户上下文：按计划所属租户执行，否则触发审计与派生数据会落到平台租户。
      return runInTenant(plan.tenantId ?? PLATFORM_TENANT_ID, () =>
        triggerEvalPlan(db, plan.id, { triggeredBy: 'schedule', actorId: null }),
      );
    },
    { connection: options.connection ?? getRedisConnection(), concurrency: 1 },
  );
}
