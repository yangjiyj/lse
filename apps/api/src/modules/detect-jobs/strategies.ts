import type { DetectStrategy, Prisma } from '@prisma/client';
import { DETECT_JOB_ITEM_META, isDetectJobItemKind } from '@lse/shared';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, notFound } from '../../lib/errors.js';
import { loadCurrentUser, type CurrentUser } from '../../lib/rbac.js';
import { assertCronAllowed, assertValidTimezone, nextRunAt } from '../eval-plans/service.js';
import { REPORT_TIME_ZONE } from '../reports/labels.js';
import { launcherProblem } from './orchestrator.js';
import { ledgerAssetExists } from './item-params.js';
import {
  createDetectJob,
  startDetectJob,
  validateDetectJobItems,
  type DetectJobActionContext,
  type DetectJobItemInput,
} from './service.js';

// 检测策略（2.4.3）：子任务清单（工具 + 规则参数）+ 执行周期。调度触发、手动「立即执行」都按策略建组合任务并启动。

/** 调度抖动容差：与评估计划一致，避免整点策略被误判为间隔不足。 */
const INTERVAL_GRACE_MS = 60_000;
const UNFINISHED = ['PENDING', 'RUNNING', 'PAUSED'];

function formatTime(date: Date): string {
  return date.toLocaleString('zh-CN', { hour12: false, timeZone: REPORT_TIME_ZONE });
}

/** 策略里存的子任务清单（建策略时已校验过）。 */
export function strategyItems(value: unknown): DetectJobItemInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    if (!isDetectJobItemKind(r.kind)) return [];
    return [
      {
        kind: r.kind,
        title: typeof r.title === 'string' ? r.title : undefined,
        params: r.params,
        toolId: typeof r.toolId === 'string' ? r.toolId : null,
        ledgerAssetId: typeof r.ledgerAssetId === 'string' ? r.ledgerAssetId : null,
      },
    ];
  });
}

/** 校验并规整策略的执行周期：cron 不为空时校验时区和最小间隔。 */
export function assertStrategySchedule(input: {
  cron: string | null;
  timezone: string;
  minIntervalMinutes: number;
}): void {
  if (!input.cron) return;
  assertValidTimezone(input.timezone);
  assertCronAllowed(input.cron, input.timezone, input.minIntervalMinutes);
}

/** 校验子任务清单并规整成落库的形状（参数按 schema 解析后的值）。 */
export async function prepareStrategyItems(
  user: CurrentUser,
  items: DetectJobItemInput[],
): Promise<Prisma.InputJsonValue> {
  const parsed = await validateDetectJobItems(user, items);
  return parsed.map((item) => ({
    kind: item.kind,
    title: (item.title?.trim() || DETECT_JOB_ITEM_META[item.kind].label).slice(0, 200),
    params: item.params,
    toolId: item.toolId ?? null,
    ledgerAssetId: item.ledgerAssetId ?? null,
  })) as Prisma.InputJsonValue;
}

export function serializeStrategy(
  s: DetectStrategy & { _count?: { jobs: number } },
  users: Map<string, { id: string; username: string }> = new Map(),
) {
  const active = s.enabled && Boolean(s.cron);
  return {
    id: s.id,
    tenantId: s.tenantId,
    name: s.name,
    description: s.description,
    items: strategyItems(s.items),
    maxParallel: s.maxParallel,
    cron: s.cron,
    timezone: s.timezone,
    enabled: s.enabled,
    minIntervalMinutes: s.minIntervalMinutes,
    lastTriggeredAt: s.lastTriggeredAt?.toISOString() ?? null,
    lastSkipReason: s.lastSkipReason,
    nextRunAt: active ? (nextRunAt(s.cron!, s.timezone)?.toISOString() ?? null) : null,
    jobCount: s._count?.jobs ?? null,
    createdBy: s.createdById ? (users.get(s.createdById) ?? null) : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export interface TriggerDetectStrategyResult {
  status: 'triggered' | 'skipped';
  jobId?: string;
  reason?: string;
  /** 调度触发时去掉了几项已不存在的台账资产关联 */
  droppedLedgerAssets?: number;
}

/**
 * 触发一次检测策略。调度触发时出任何错（不只业务错误）都不往外抛：原因写进 lastSkipReason，
 * 页面上「上次跳过原因」能看到；手动触发照常抛给接口。
 */
export async function triggerDetectStrategy(
  strategyId: string,
  options: Parameters<typeof runTrigger>[1],
): Promise<TriggerDetectStrategyResult> {
  if (options.triggeredBy !== 'schedule') return runTrigger(strategyId, options);
  try {
    return await runTrigger(strategyId, options);
  } catch (err) {
    const reason = `触发失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    console.error(`[detect-strategy] 策略 ${strategyId} 定时触发失败:`, err);
    await prisma.detectStrategy
      .updateMany({ where: { id: strategyId }, data: { lastSkipReason: reason } })
      .catch(() => undefined);
    return { status: 'skipped', reason };
  }
}

/**
 * 按策略建组合任务并启动。
 * - 手动（立即执行）：user 是当前用户，参数不合法、权限不够直接报错；
 * - 调度：发起人是策略创建人；停用、上一个组合任务没结束、距上次触发不足最小间隔、发起人停用或缺权限
 *   都跳过并写 lastSkipReason。
 * 必须在策略所属租户的范围内调用。
 */
async function runTrigger(
  strategyId: string,
  options: {
    triggeredBy: 'manual' | 'schedule';
    user?: CurrentUser;
    ctx?: DetectJobActionContext;
  },
): Promise<TriggerDetectStrategyResult> {
  const strategy = await prisma.detectStrategy.findUnique({ where: { id: strategyId } });
  if (!strategy) {
    if (options.triggeredBy === 'manual')
      throw notFound('检测策略不存在', 'DETECT_STRATEGY_NOT_FOUND');
    return { status: 'skipped', reason: '检测策略不存在' };
  }
  const schedule = options.triggeredBy === 'schedule';
  const ctx = options.ctx ?? { ip: null, userAgent: null };
  const now = new Date();

  const finish = async (result: TriggerDetectStrategyResult) => {
    await writeAudit({
      actorId: schedule ? null : (options.user?.id ?? null),
      actorName: schedule ? 'system:schedule' : (options.user?.username ?? null),
      action: 'detect_strategy.trigger',
      targetType: 'detect_strategy',
      targetId: strategy.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detail: { name: strategy.name, triggeredBy: options.triggeredBy, ...result },
    });
    return result;
  };
  const skip = async (reason: string) => {
    await prisma.detectStrategy.update({
      where: { id: strategy.id },
      data: { lastSkipReason: reason },
    });
    return finish({ status: 'skipped', reason });
  };

  let user: CurrentUser | null | undefined = options.user;
  let items = strategyItems(strategy.items);
  let droppedLedgerAssets = 0;
  if (schedule) {
    if (!strategy.enabled) return skip('策略已停用');
    const running = await prisma.detectJob.findFirst({
      where: { strategyId: strategy.id, status: { in: UNFINISHED } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    if (running) return skip(`上一个组合任务未结束（${running.id}，${running.status}）`);
    if (
      strategy.lastTriggeredAt &&
      now.getTime() - strategy.lastTriggeredAt.getTime() <
        strategy.minIntervalMinutes * 60_000 - INTERVAL_GRACE_MS
    ) {
      return skip(
        `距上次触发（${formatTime(strategy.lastTriggeredAt)}）不足最小间隔 ${strategy.minIntervalMinutes} 分钟`,
      );
    }
    const loaded = strategy.createdById ? await loadCurrentUser(strategy.createdById) : null;
    user = loaded ? { ...loaded, tenantId: strategy.tenantId ?? loaded.tenantId } : null;
    const problem =
      launcherProblem(
        user,
        items.map((i) => i.kind),
      ) ?? (user!.permissions.has('detect_task:manage') ? null : '发起人没有管理组合任务的权限');
    if (problem) return skip(problem);
    // 子任务关联的台账资产后来被删了：去掉关联照常建任务，审计里记下去掉了几项。
    items = await Promise.all(
      items.map(async (item) => {
        if (!item.ledgerAssetId || (await ledgerAssetExists(item.ledgerAssetId))) return item;
        droppedLedgerAssets += 1;
        return { ...item, ledgerAssetId: null };
      }),
    );
    if (droppedLedgerAssets > 0) {
      console.warn(
        `[detect-strategy] 策略 ${strategy.id} 有 ${droppedLedgerAssets} 项关联的台账资产已不存在，已去掉关联`,
      );
    }
    // 抢这一次触发：同一时刻多个调度只算一个。
    const claimed = await prisma.detectStrategy.updateMany({
      where: { id: strategy.id, lastTriggeredAt: strategy.lastTriggeredAt },
      data: { lastTriggeredAt: now },
    });
    if (claimed.count === 0) return { status: 'skipped', reason: '已由另一次调度触发' };
  }
  if (!user) throw notFound('发起人不存在');

  let jobId: string;
  try {
    ({ id: jobId } = await createDetectJob(user, {
      name: `${strategy.name} · ${formatTime(now)}`.slice(0, 200),
      maxParallel: strategy.maxParallel,
      items,
      strategyId: strategy.id,
      triggeredBy: options.triggeredBy,
    }));
  } catch (err) {
    if (schedule && err instanceof AppError) {
      return skip(`子任务已不可用：${err.message}`);
    }
    throw err;
  }
  await prisma.detectStrategy.update({
    where: { id: strategy.id },
    data: { lastTriggeredAt: now, lastSkipReason: null },
  });
  await startDetectJob(user, jobId, ctx);
  return finish({
    status: 'triggered',
    jobId,
    ...(droppedLedgerAssets ? { droppedLedgerAssets } : {}),
  });
}
