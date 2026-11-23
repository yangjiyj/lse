// 策略建议服务：生成（落库）/ 审核 / 下发 / 状态轮询 / 自动复测 / 攻击成功率回填。
import type { PolicySuggestion, Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { riskDomainForCategory } from '../reports/labels.js';
import {
  estimateImpact,
  generateSuggestions,
  passTextsForType,
  samplesForType,
  type PassSample,
  type SourceFinding,
  type SuggestionType,
} from './generator.js';
import { checkMatcher, type Matcher } from './regex-safety.js';
import {
  GatewayCallError,
  fetchPolicySuggestionState,
  probePolicyCapability,
  submitPolicySuggestion,
  type GatewayConn,
} from './gateway-client.js';
import { isGatewaySupportedType, toGatewayBody } from './export.js';
import { retestFailureState, type RetestLauncher } from './retest-launcher.js';

export type Db = PrismaClient;

/** 轮询最小间隔与超时（契约：间隔 ≥30s，超时 7 天）。 */
export const POLL_MIN_INTERVAL_MS = 30_000;
export const POLL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCOPE_TASKS = 20;
const MAX_PASS_SAMPLES = 500;

export const REVIEWABLE = ['DRAFT', 'ACCEPTED', 'MODIFIED'] as const;
export const DISPATCHABLE = ['ACCEPTED', 'MODIFIED'] as const;

export type GenerateScope = { taskId: string } | { modelTargetId: string };

interface ScopeTask {
  id: string;
  modelTargetId: string;
  createdAt: Date;
}

async function scopeTasks(db: Db, scope: GenerateScope, taskFilter: Prisma.EvalTaskWhereInput) {
  if ('taskId' in scope) {
    return db.evalTask.findMany({
      where: { id: scope.taskId, ...taskFilter },
      select: { id: true, modelTargetId: true, createdAt: true },
    });
  }
  return db.evalTask.findMany({
    where: { modelTargetId: scope.modelTargetId, ...taskFilter },
    select: { id: true, modelTargetId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_SCOPE_TASKS,
  });
}

async function loadFindings(db: Db, taskIds: string[]) {
  const rows = await db.finding.findMany({
    where: { taskId: { in: taskIds }, verdict: 'FAIL' },
    select: {
      id: true,
      taskId: true,
      riskCategory: true,
      title: true,
      evidence: true,
      verdict: true,
      reviewStatus: true,
      detail: true,
      result: { select: { prompt: true, response: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    taskId: r.taskId,
    source: {
      id: r.id,
      riskCategory: r.riskCategory,
      title: r.title,
      evidence: r.evidence,
      verdict: r.verdict,
      reviewStatus: r.reviewStatus,
      detail: r.detail,
      prompt: r.result?.prompt ?? null,
      response: r.result?.response ?? null,
    } satisfies SourceFinding,
  }));
}

async function loadPassSamples(db: Db, taskIds: string[]): Promise<PassSample[]> {
  return db.evalResult.findMany({
    where: { taskId: { in: taskIds }, finalVerdict: 'PASS' },
    select: { prompt: true, response: true },
    take: MAX_PASS_SAMPLES,
  });
}

function scopeKeyOf(scope: GenerateScope): string {
  return 'taskId' in scope ? `task:${scope.taskId}` : `target:${scope.modelTargetId}`;
}

export interface GenerateResult {
  created: number;
  updated: number;
  skipped: number;
  items: PolicySuggestion[];
}

/**
 * 生成并落库。重复生成：同范围同分组仅刷新仍为草稿的建议；已审核/已下发的保持不动（计入 skipped）。
 * taskFilter 由路由层按用户可见范围传入。
 */
export async function generateAndStore(
  db: Db,
  scope: GenerateScope,
  actorId: string | null,
  taskFilter: Prisma.EvalTaskWhereInput = {},
): Promise<GenerateResult> {
  const tasks: ScopeTask[] = await scopeTasks(db, scope, taskFilter);
  if (tasks.length === 0) return { created: 0, updated: 0, skipped: 0, items: [] };
  const taskIds = tasks.map((t) => t.id);
  const findings = await loadFindings(db, taskIds);
  const passSamples = await loadPassSamples(db, taskIds);
  const generated = generateSuggestions(
    findings.map((f) => f.source),
    passSamples,
  );
  const taskOfFinding = new Map(findings.map((f) => [f.source.id, f.taskId]));
  const order = new Map(tasks.map((t) => [t.id, t.createdAt.getTime()]));
  const scopeKey = scopeKeyOf(scope);
  const result: GenerateResult = { created: 0, updated: 0, skipped: 0, items: [] };

  for (const g of generated) {
    // 来源任务：该组 Finding 所在任务中最新的一个（复测父任务、下发前攻击成功率口径）。
    const sourceTaskId = [...new Set(g.sourceFindingIds.map((id) => taskOfFinding.get(id)!))].sort(
      (a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0),
    )[0]!;
    const task = tasks.find((t) => t.id === sourceTaskId)!;
    const data = {
      taskId: sourceTaskId,
      modelTargetId: task.modelTargetId,
      riskCategory: g.riskCategory,
      type: g.type,
      action: g.action,
      matcherKind: g.matcher.kind,
      matcherValue: g.matcher.value as Prisma.InputJsonValue,
      generatedMatcher: g.matcher as unknown as Prisma.InputJsonValue,
      examples: g.examples as Prisma.InputJsonValue,
      sourceFindingIds: g.sourceFindingIds,
      estimatedImpact: g.estimatedImpact as unknown as Prisma.InputJsonValue,
      generationNote: g.generationNote,
    };
    // 幂等键是 (tenantId, scopeKey, groupKey)：在同一租户范围内找已有的建议。
    const existing = await db.policySuggestion.findFirst({
      where: { scopeKey, groupKey: g.groupKey },
    });
    if (existing && existing.status !== 'DRAFT') {
      result.skipped += 1;
      result.items.push(existing);
      continue;
    }
    if (existing) {
      result.updated += 1;
      result.items.push(await db.policySuggestion.update({ where: { id: existing.id }, data }));
      continue;
    }
    result.created += 1;
    result.items.push(
      await db.policySuggestion.create({
        data: {
          ...data,
          scopeKey,
          groupKey: g.groupKey,
          externalId: `lse-ps-${randomUUID()}`,
          createdById: actorId,
        },
      }),
    );
  }
  return result;
}

/** 人工修改 matcher 后：重新校验 + 在原证据样本上重算预估影响。 */
export async function recomputeImpact(db: Db, row: PolicySuggestion, matcher: Matcher) {
  const check = checkMatcher(matcher);
  if (!check.ok) return { ok: false as const, error: check.error ?? '规则不合规' };
  const findings = await loadFindings(db, [...new Set([row.taskId])]);
  const ids = new Set(row.sourceFindingIds);
  const sources = findings.filter((f) => ids.has(f.source.id)).map((f) => f.source);
  const type = row.type as SuggestionType;
  const pass = await loadPassSamples(db, [row.taskId]);
  const impact = estimateImpact(
    matcher,
    samplesForType(type, sources),
    passTextsForType(type, pass),
  );
  return { ok: true as const, impact };
}

export interface AttackRate {
  failCount: number;
  totalCount: number;
  rate: number | null;
}

/**
 * 攻击成功率 = 该任务中相关风险类别判定 FAIL 的测试数 / 该任务测试数。
 * 测试数取任务的评估结果条数；按 resultId 去重，无 resultId 的 Finding 单独计数。
 */
export async function attackRateFor(
  db: Db,
  taskId: string,
  riskDomain: string,
): Promise<AttackRate> {
  const [findings, totalCount] = await Promise.all([
    db.finding.findMany({
      where: { taskId, verdict: 'FAIL', reviewStatus: { not: 'FALSE_POSITIVE' } },
      select: { id: true, resultId: true, riskCategory: true, title: true },
    }),
    db.evalResult.count({ where: { taskId } }),
  ]);
  const keys = new Set<string>();
  for (const f of findings) {
    if (riskDomainForCategory(f.riskCategory, f.title) !== riskDomain) continue;
    keys.add(f.resultId ?? `finding:${f.id}`);
  }
  const failCount = keys.size;
  return { failCount, totalCount, rate: totalCount > 0 ? failCount / totalCount : null };
}

// ——————————————————— 下发 / 轮询 / 复测 ———————————————————

export interface DispatchOutcome {
  id: string;
  ok: boolean;
  status: string;
  error: string | null;
}

export async function dispatchOne(
  db: Db,
  conn: GatewayConn,
  row: PolicySuggestion,
  actorId: string | null,
  now = new Date(),
): Promise<DispatchOutcome> {
  if (!(DISPATCHABLE as readonly string[]).includes(row.status)) {
    return { id: row.id, ok: false, status: row.status, error: '仅已采纳或已修改的建议可下发' };
  }
  if (!isGatewaySupportedType(row.type)) {
    return { id: row.id, ok: false, status: row.status, error: '网关暂不支持此类型，仅可导出' };
  }
  try {
    const state = await submitPolicySuggestion(conn, toGatewayBody(row));
    await db.policySuggestion.update({
      where: { id: row.id },
      data: {
        status: 'GATEWAY_PENDING',
        gatewaySuggestionId: state.id,
        gatewayStatus: state.status,
        dispatchedAt: now,
        dispatchedById: actorId,
        dispatchError: null,
        lastPolledAt: now,
        pollDeadlineAt: new Date(now.getTime() + POLL_TIMEOUT_MS),
        pollExpired: false,
      },
    });
    // 幂等命中时网关可能已是终态：立即按状态推进。
    if (state.status !== 'pending_approval') {
      const fresh = await db.policySuggestion.findUniqueOrThrow({ where: { id: row.id } });
      await applyGatewayState(db, fresh, state, now);
    }
    const after = await db.policySuggestion.findUniqueOrThrow({ where: { id: row.id } });
    return { id: row.id, ok: true, status: after.status, error: null };
  } catch (err) {
    const message =
      err instanceof GatewayCallError && err.code === 'unsupported_suggestion_type'
        ? '网关暂不支持此类型，仅可导出'
        : err instanceof Error
          ? err.message
          : '下发失败';
    await db.policySuggestion.update({
      where: { id: row.id },
      data: { dispatchError: message.slice(0, 500) },
    });
    return { id: row.id, ok: false, status: row.status, error: message };
  }
}

async function applyGatewayState(
  db: Db,
  row: PolicySuggestion,
  state: {
    status: string;
    ruleSetId: string | null;
    ruleSetVersion: string | null;
    reviewNote: string | null;
  },
  now: Date,
): Promise<PolicySuggestion> {
  const base = { gatewayStatus: state.status, lastPolledAt: now };
  if (state.status === 'published') {
    return db.policySuggestion.update({
      where: { id: row.id },
      data: {
        ...base,
        status: 'PUBLISHED',
        ruleSetId: state.ruleSetId,
        ruleSetVersion: state.ruleSetVersion,
      },
    });
  }
  if (state.status === 'rejected') {
    return db.policySuggestion.update({
      where: { id: row.id },
      data: {
        ...base,
        status: 'GATEWAY_REJECTED',
        ...(state.reviewNote
          ? { dispatchError: `网关驳回：${state.reviewNote}`.slice(0, 500) }
          : {}),
      },
    });
  }
  return db.policySuggestion.update({ where: { id: row.id }, data: base });
}

export interface PollOutcome {
  id: string;
  polled: boolean;
  status: string;
  reason: string | null;
}

/**
 * 按需刷新一条已下发建议的网关状态。间隔 <30s 不打网关；超过 7 天标记超时停止轮询。
 * 发布后自动发起复测（launcher 注入）。
 */
export async function pollOne(
  db: Db,
  conn: GatewayConn,
  row: PolicySuggestion,
  launcher: RetestLauncher,
  now = new Date(),
  fallbackActorId: string | null = null,
): Promise<PollOutcome> {
  if (row.status !== 'GATEWAY_PENDING' || !row.gatewaySuggestionId) {
    return { id: row.id, polled: false, status: row.status, reason: '不在网关待审批状态' };
  }
  if (row.pollDeadlineAt && now.getTime() > row.pollDeadlineAt.getTime()) {
    if (!row.pollExpired) {
      await db.policySuggestion.update({ where: { id: row.id }, data: { pollExpired: true } });
    }
    return { id: row.id, polled: false, status: row.status, reason: '轮询已超过 7 天，已停止' };
  }
  if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < POLL_MIN_INTERVAL_MS) {
    return { id: row.id, polled: false, status: row.status, reason: '距上次查询不足 30 秒' };
  }
  const state = await fetchPolicySuggestionState(conn, row.gatewaySuggestionId);
  const updated = await applyGatewayState(db, row, state, now);
  if (updated.status === 'PUBLISHED') await launchRetest(db, updated, launcher, fallbackActorId);
  const after = await db.policySuggestion.findUniqueOrThrow({ where: { id: row.id } });
  return { id: row.id, polled: true, status: after.status, reason: null };
}

/** 发布后发起复测并回填下发前攻击成功率；复测不能发起时按 W3c 错误码标记原因。 */
export async function launchRetest(
  db: Db,
  row: PolicySuggestion,
  launcher: RetestLauncher,
  fallbackActorId: string | null = null,
): Promise<PolicySuggestion> {
  if (row.retestTaskId) return row;
  const pre = await attackRateFor(db, row.taskId, row.riskCategory);
  const preData = {
    preFailCount: pre.failCount,
    preTotalCount: pre.totalCount,
    preAttackRate: pre.rate,
  };
  try {
    const { taskId } = await launcher.launch(db, row.taskId, {
      actorId: row.dispatchedById ?? row.reviewedById ?? fallbackActorId,
    });
    return db.policySuggestion.update({
      where: { id: row.id },
      data: { ...preData, retestTaskId: taskId, retestStatus: 'RUNNING', retestError: null },
    });
  } catch (err) {
    const failure = retestFailureState(err);
    return db.policySuggestion.update({
      where: { id: row.id },
      data: { ...preData, retestStatus: failure.status, retestError: failure.error },
    });
  }
}

/** 复测任务结束后回填下发后攻击成功率（按需刷新时调用）。 */
export async function backfillRetest(db: Db, row: PolicySuggestion): Promise<PolicySuggestion> {
  if (!row.retestTaskId || row.retestStatus === 'COMPLETED') return row;
  const task = await db.evalTask.findUnique({
    where: { id: row.retestTaskId },
    select: { status: true },
  });
  if (!task) return row;
  if (task.status === 'FAILED' || task.status === 'CANCELED') {
    return db.policySuggestion.update({
      where: { id: row.id },
      data: { retestStatus: task.status, retestError: '复测任务未正常完成，无法对比' },
    });
  }
  if (task.status !== 'COMPLETED') return row;
  const post = await attackRateFor(db, row.retestTaskId, row.riskCategory);
  return db.policySuggestion.update({
    where: { id: row.id },
    data: {
      retestStatus: 'COMPLETED',
      postFailCount: post.failCount,
      postTotalCount: post.totalCount,
      postAttackRate: post.rate,
    },
  });
}

export { probePolicyCapability };
