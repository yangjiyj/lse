import type { Prisma, TargetType } from '@prisma/client';
import { prisma } from '../../db.js';

/**
 * 评估对象接入状态（态势概览各处「接入异常」的唯一口径）：
 * - failed：启用中且最近一次连通测试失败 → 计入接入异常
 * - untested：启用中但从未做过连通测试 → 待测试，不计入异常
 * - inactive：已停用，不计入接入异常
 */
export type TargetConnectionState = 'ok' | 'failed' | 'untested' | 'inactive';

export function targetConnectionState(target: {
  isActive: boolean;
  lastTestStatus: string | null;
}): TargetConnectionState {
  if (!target.isActive) return 'inactive';
  if (target.lastTestStatus === null) return 'untested';
  return target.lastTestStatus === 'SUCCESS' ? 'ok' : 'failed';
}

/**
 * 首页「评估对象」数与评估对象页同口径：不含 JUDGE（系统判定模型，列表默认不展示）。
 * 评估对象页的默认列表就是 targetType != JUDGE。
 */
export const VISIBLE_TARGET_WHERE: Prisma.ModelTargetWhereInput = {
  targetType: { not: 'JUDGE' },
};

/** 与 targetConnectionState === 'failed' 等价的查询条件（按评估对象，天然不重复）。 */
export const CONNECTION_ISSUE_WHERE: Prisma.ModelTargetWhereInput = {
  ...VISIBLE_TARGET_WHERE,
  isActive: true,
  AND: [{ lastTestStatus: { not: null } }, { lastTestStatus: { not: 'SUCCESS' } }],
};

/**
 * 可做连通性测试的评估对象类型（评估对象页「测试」按钮的前提）：MODEL / AGENT_API / PLATFORM_APP。
 * 终端智能体、纯资产登记对象（Hermes 等）没有测试入口，永远「未测试」，不能计入「待测试」。
 * 评估对象页（?untested=1）按同一组类型过滤，保持首页数字与落地列表一致。
 */
export const TESTABLE_TARGET_TYPES: TargetType[] = ['MODEL', 'AGENT_API', 'PLATFORM_APP'];

/** 待测试：启用中、从未做过连通测试，且属于可测试的类型。 */
export function untestedWhere(): Prisma.ModelTargetWhereInput {
  return { isActive: true, lastTestStatus: null, targetType: { in: TESTABLE_TARGET_TYPES } };
}

export async function connectionIssueSummary(): Promise<{ count: number; untestedCount: number }> {
  const [count, untestedCount] = await Promise.all([
    prisma.modelTarget.count({ where: CONNECTION_ISSUE_WHERE }),
    prisma.modelTarget.count({ where: untestedWhere() }),
  ]);
  return { count, untestedCount };
}

export function listConnectionIssueTargets(take: number) {
  return prisma.modelTarget.findMany({
    where: CONNECTION_ISSUE_WHERE,
    orderBy: { updatedAt: 'desc' },
    take,
    select: {
      id: true,
      tenantId: true,
      name: true,
      isActive: true,
      lastTestStatus: true,
      lastTestedAt: true,
    },
  });
}
