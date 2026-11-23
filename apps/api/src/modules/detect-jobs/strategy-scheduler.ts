import type { Queue } from 'bullmq';
import { config } from '../../config.js';
import { prismaUnscoped } from '../../db.js';
import { getDetectStrategiesQueue } from '../../lib/queue.js';

// 检测策略的执行周期（2.4.3）：每个启用且有 cron 的策略一个 BullMQ Job Scheduler。

export const DETECT_STRATEGY_JOB_NAME = 'trigger';

export interface SchedulableStrategy {
  id: string;
  cron: string | null;
  timezone: string;
  enabled: boolean;
}

/** 策略调度端口：新建、编辑、启停、删除时调用；测试注入假实现。 */
export interface DetectStrategyScheduler {
  sync(strategy: SchedulableStrategy): Promise<void>;
  remove(strategyId: string): Promise<void>;
}

export function detectStrategySchedulerId(strategyId: string): string {
  return `detect-strategy:${strategyId}`;
}

export function createBullmqStrategyScheduler(
  queue: Queue<{ strategyId: string }>,
): DetectStrategyScheduler {
  return {
    async sync(s) {
      if (!s.enabled || !s.cron) {
        await queue.removeJobScheduler(detectStrategySchedulerId(s.id));
        return;
      }
      await queue.upsertJobScheduler(
        detectStrategySchedulerId(s.id),
        { pattern: s.cron, tz: s.timezone },
        {
          name: DETECT_STRATEGY_JOB_NAME,
          data: { strategyId: s.id },
          opts: { removeOnComplete: 100, removeOnFail: 200, attempts: 1 },
        },
      );
    },
    async remove(strategyId) {
      await queue.removeJobScheduler(detectStrategySchedulerId(strategyId));
    },
  };
}

const isTest = process.env.LSE_TEST === '1' || config.NODE_ENV === 'test';

/**
 * 默认调度器：生产走 BullMQ；测试环境不连 Redis。同步失败只记日志不抛出——策略已落库，
 * worker 启动时按库重新对齐。写法同评估计划的 defaultPlanScheduler。
 */
export function defaultDetectStrategyScheduler(): DetectStrategyScheduler {
  if (isTest) return { sync: async () => undefined, remove: async () => undefined };
  const inner = () => createBullmqStrategyScheduler(getDetectStrategiesQueue());
  return {
    async sync(s) {
      try {
        await inner().sync(s);
      } catch (err) {
        console.error(`[detect-strategy] 调度同步失败 strategyId=${s.id}:`, (err as Error).message);
      }
    },
    async remove(strategyId) {
      try {
        await inner().remove(strategyId);
      } catch (err) {
        console.error(
          `[detect-strategy] 调度移除失败 strategyId=${strategyId}:`,
          (err as Error).message,
        );
      }
    },
  };
}

/** 按库对齐调度（worker 启动时调用）：启用且有 cron 的 upsert，其余已注册的移除。 */
export async function reconcileDetectStrategySchedulers(
  queue: Queue<{ strategyId: string }> = getDetectStrategiesQueue(),
): Promise<{ upserted: number; removed: number }> {
  const scheduler = createBullmqStrategyScheduler(queue);
  const rows = await prismaUnscoped.detectStrategy.findMany({
    select: { id: true, cron: true, timezone: true, enabled: true },
  });
  const active = rows.filter((s) => s.enabled && s.cron);
  const keep = new Set(active.map((s) => detectStrategySchedulerId(s.id)));
  for (const s of active) await scheduler.sync(s);
  let removed = 0;
  for (const existing of await queue.getJobSchedulers(0, -1)) {
    if (existing.key.startsWith('detect-strategy:') && !keep.has(existing.key)) {
      await queue.removeJobScheduler(existing.key);
      removed += 1;
    }
  }
  return { upserted: active.length, removed };
}
