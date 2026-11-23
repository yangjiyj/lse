import { Prisma } from '@prisma/client';
import { prismaUnscoped as db } from '../db.js';

/**
 * 资产租户归属转移：把一棵已存在的资产子树从一个租户整体搬到另一个租户。
 *
 * 为什么不用带隔离的 prisma：它的查询扩展会剥掉 update 里的 tenantId 并追加当前租户条件
 * （见 db.ts 的 stripTenant / scopeArgs），正好挡住这里要做的事。所以本模块用 prismaUnscoped，
 * 唯一的合法调用方是 modules/tenants 的转移路由（requirePlatformAdmin）。
 *
 * 顺序为什么重要：数据库的 lse_tenant_20_guard 是 BEFORE INSERT OR UPDATE OF "tenantId"，改一行归属
 * 就校验它指向的父对象是否同租户。所以必须父先子后；顺序错了直接 42501、整个事务回滚。
 * 换句话说：下面这张顺序表即使写错，也造不出半搬状态。
 */

export type TransferKind = 'model-target' | 'fleet-endpoint' | 'question-set' | 'agent-sample';

export interface TransferKindMeta {
  kind: TransferKind;
  label: string;
  /** 根对象所在的表。 */
  rootTable: string;
  /** 用来展示的行名称列（终端是 hostname，样本是 suite）。 */
  nameExpr: Prisma.Sql;
}

export const TRANSFER_KINDS: TransferKindMeta[] = [
  {
    kind: 'model-target',
    label: '评估对象',
    rootTable: 'model_targets',
    nameExpr: Prisma.sql`"name"`,
  },
  {
    kind: 'fleet-endpoint',
    label: '终端',
    rootTable: 'fleet_endpoints',
    nameExpr: Prisma.sql`"hostname"`,
  },
  {
    kind: 'question-set',
    label: '题集',
    rootTable: 'question_sets',
    nameExpr: Prisma.sql`"name"`,
  },
  {
    kind: 'agent-sample',
    label: '自建样本',
    rootTable: 'agent_samples',
    nameExpr: Prisma.sql`coalesce(nullif("suite", ''), left("id", 8))`,
  },
];

export const TRANSFER_KIND_MAP = new Map(TRANSFER_KINDS.map((item) => [item.kind, item]));

export interface TransferBlocker {
  code: string;
  message: string;
  objectId?: string;
}

export interface TransferWarning {
  code: string;
  message: string;
  objectId?: string;
}

export interface TransferRoot {
  id: string;
  name: string;
  tenantId: string | null;
}

export interface TransferPlan {
  kind: TransferKind;
  kindLabel: string;
  sourceTenant: { id: string; name: string };
  targetTenant: { id: string; name: string };
  roots: TransferRoot[];
  counts: Record<string, { label: string; count: number }>;
  totalRows: number;
  blockers: TransferBlocker[];
  warnings: TransferWarning[];
  canTransfer: boolean;
}

export interface TransferInput {
  kind: TransferKind;
  ids: string[];
  targetTenantId: string;
}

export interface TransferResult {
  plan: TransferPlan;
  applied: Record<string, number>;
  totalRows: number;
}

interface StepContext {
  source: string;
  target: string;
  rootIds: string[];
  ids: Map<string, string[]>;
}

interface Step {
  key: string;
  label: string;
  table: string;
  condition: (ctx: StepContext) => Prisma.Sql;
  /** 同一批行额外要做的字段处理（例如转移终端时清空跨租户责任人）。 */
  afterApply?: (tx: Prisma.TransactionClient, ctx: StepContext, ids: string[]) => Promise<void>;
}

function rawColumn(column: string): Prisma.Sql {
  return Prisma.raw(`"${column}"`);
}

function inIds(column: string, ids: string[]): Prisma.Sql {
  if (ids.length === 0) return Prisma.sql`false`;
  return Prisma.sql`${rawColumn(column)} = ANY(${ids}::text[])`;
}

function idIn(ids: string[]): Prisma.Sql {
  return inIds('id', ids);
}

function anyOf(parts: Prisma.Sql[]): Prisma.Sql {
  if (parts.length === 0) return Prisma.sql`false`;
  if (parts.length === 1) return parts[0] as Prisma.Sql;
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

function idsOf(ctx: StepContext, key: string): string[] {
  return ctx.ids.get(key) ?? [];
}

/**
 * 应用台账（2.8.1）关联的终端、评估对象：搬走后，别的租户（含原租户）台账里指向它们的关联置空，
 * 否则原租户的台账能读到新租户里的主机名、模型名，新租户也没法再把它们登记进自己的台账。
 */
async function unlinkLedgerAssets(
  tx: Prisma.TransactionClient,
  column: 'fleetEndpointId' | 'modelTargetId',
  ids: string[],
  target: string,
): Promise<void> {
  if (ids.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "ledger_assets" SET ${rawColumn(column)} = NULL
    WHERE ${inIds(column, ids)} AND "tenantId" IS DISTINCT FROM ${target}
  `);
}

const MODEL_TARGET_STEPS: Step[] = [
  {
    key: 'modelTarget',
    label: '评估对象',
    table: 'model_targets',
    condition: (ctx) => idIn(ctx.rootIds),
    afterApply: (tx, ctx, ids) => unlinkLedgerAssets(tx, 'modelTargetId', ids, ctx.target),
  },
  {
    key: 'evalPlan',
    label: '评估计划',
    table: 'eval_plans',
    condition: (ctx) => inIds('targetId', ctx.rootIds),
  },
  {
    // 上传件是扫描记录的父对象：先搬它，扫描记录才不会指向原租户的上传件。
    key: 'modelFileUpload',
    label: '模型文件上传',
    table: 'model_file_uploads',
    condition: (ctx) => Prisma.sql`"id" IN (
      SELECT "uploadId" FROM "model_file_scans"
      WHERE "tenantId" = ${ctx.source} AND ${inIds('targetId', ctx.rootIds)}
    )`,
  },
  {
    key: 'evalTask',
    label: '评估任务',
    table: 'eval_tasks',
    condition: (ctx) =>
      anyOf([inIds('modelTargetId', ctx.rootIds), inIds('planId', idsOf(ctx, 'evalPlan'))]),
  },
  {
    // 自动样本集是标准专项的父对象（standard_runs.bankReleaseId），先搬。
    key: 'standardBankRelease',
    label: '自动样本集发布',
    table: 'standard_bank_releases',
    condition: (ctx) => Prisma.sql`"id" IN (
      SELECT "bankReleaseId" FROM "standard_runs"
      WHERE "tenantId" = ${ctx.source} AND ${inIds('taskId', idsOf(ctx, 'evalTask'))}
    )`,
  },
  {
    key: 'evalResult',
    label: '评估结果',
    table: 'eval_results',
    condition: (ctx) => inIds('taskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'wrongAnswer',
    label: '错题',
    table: 'wrong_answers',
    condition: (ctx) => inIds('taskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'finding',
    label: '风险项',
    table: 'findings',
    condition: (ctx) => inIds('taskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'report',
    label: '报告',
    table: 'reports',
    condition: (ctx) => inIds('taskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'policySuggestion',
    label: '策略建议',
    table: 'policy_suggestions',
    condition: (ctx) => inIds('taskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'ragEvalRun',
    label: 'RAG 评估',
    table: 'rag_eval_runs',
    condition: (ctx) => inIds('taskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'standardRun',
    label: '国标专项',
    table: 'standard_runs',
    condition: (ctx) => inIds('taskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'serviceAssuranceRun',
    label: '服务核验',
    table: 'service_assurance_runs',
    condition: (ctx) => inIds('taskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'vulnerabilityAssessment',
    label: '脆弱性评估',
    table: 'vulnerability_assessments',
    condition: (ctx) => inIds('runId', idsOf(ctx, 'serviceAssuranceRun')),
  },
  {
    key: 'aiComponentScan',
    label: 'AI 组件扫描',
    table: 'ai_component_scans',
    condition: (ctx) => inIds('linkedTaskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'aiComponentFinding',
    label: '组件风险',
    table: 'ai_component_findings',
    condition: (ctx) => inIds('scanId', idsOf(ctx, 'aiComponentScan')),
  },
  {
    key: 'fleetEvalJob',
    label: '终端下发作业',
    table: 'fleet_eval_jobs',
    condition: (ctx) => inIds('evalTaskId', idsOf(ctx, 'evalTask')),
  },
  {
    key: 'gateRule',
    label: '门禁规则',
    table: 'gate_rules',
    condition: (ctx) =>
      anyOf([inIds('planId', idsOf(ctx, 'evalPlan')), inIds('modelTargetId', ctx.rootIds)]),
  },
  {
    key: 'modelFileScan',
    label: '模型文件扫描',
    table: 'model_file_scans',
    condition: (ctx) => inIds('targetId', ctx.rootIds),
  },
  {
    key: 'modelFileFinding',
    label: '模型文件风险',
    table: 'model_file_findings',
    condition: (ctx) => inIds('scanId', idsOf(ctx, 'modelFileScan')),
  },
  {
    key: 'modelFingerprint',
    label: '模型指纹',
    table: 'model_fingerprints',
    condition: (ctx) => inIds('modelTargetId', ctx.rootIds),
  },
];

const FLEET_ENDPOINT_STEPS: Step[] = [
  {
    key: 'fleetEndpoint',
    label: '终端',
    table: 'fleet_endpoints',
    condition: (ctx) => idIn(ctx.rootIds),
    // 责任人必须是本租户用户，跨租户挂人是错的：转移时一并清空，由目标租户重新指派。
    afterApply: async (tx, ctx, ids) => {
      if (ids.length === 0) return;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "fleet_endpoints"
        SET "ownerName" = NULL, "ownerDepartment" = NULL, "ownerUserId" = NULL, "ownerUpdatedAt" = NULL
        WHERE ${idIn(ids)}
      `);
      await unlinkLedgerAssets(tx, 'fleetEndpointId', ids, ctx.target);
    },
  },
  {
    key: 'fleetProbeReport',
    label: '探针报告',
    table: 'fleet_probe_reports',
    condition: (ctx) => inIds('endpointId', ctx.rootIds),
  },
  {
    // 终端转移不搬评估任务；历史作业指向原租户任务会让 guard 拒绝，所以先解除作业与任务的关联。
    key: 'fleetEvalJob',
    label: '下发作业',
    table: 'fleet_eval_jobs',
    condition: (ctx) => inIds('endpointId', ctx.rootIds),
    afterApply: async (tx, ctx, ids) => {
      if (ids.length === 0) return;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "fleet_eval_jobs" SET "evalTaskId" = NULL
        WHERE ${idIn(ids)}
          AND "evalTaskId" IS NOT NULL
          AND "evalTaskId" IN (SELECT "id" FROM "eval_tasks" WHERE "tenantId" = ${ctx.source})
      `);
    },
  },
];

const QUESTION_SET_STEPS: Step[] = [
  {
    key: 'questionSet',
    label: '题集',
    table: 'question_sets',
    condition: (ctx) => idIn(ctx.rootIds),
  },
  {
    key: 'question',
    label: '题目',
    table: 'questions',
    condition: (ctx) => inIds('questionSetId', ctx.rootIds),
  },
];

const AGENT_SAMPLE_STEPS: Step[] = [
  {
    key: 'agentSample',
    label: '自建样本',
    table: 'agent_samples',
    condition: (ctx) => idIn(ctx.rootIds),
  },
  {
    key: 'agentSampleTrial',
    label: '样本试验记录',
    table: 'agent_sample_trials',
    condition: (ctx) => inIds('sampleId', ctx.rootIds),
  },
];

function stepsFor(kind: TransferKind): Step[] {
  switch (kind) {
    case 'model-target':
      return MODEL_TARGET_STEPS;
    case 'fleet-endpoint':
      return FLEET_ENDPOINT_STEPS;
    case 'question-set':
      return QUESTION_SET_STEPS;
    case 'agent-sample':
      return AGENT_SAMPLE_STEPS;
    default:
      return [];
  }
}

interface RootRow {
  id: string;
  name: string;
  tenantId: string | null;
}

async function loadRoots(
  tx: Prisma.TransactionClient,
  meta: TransferKindMeta,
  ids: string[],
): Promise<RootRow[]> {
  if (ids.length === 0) return [];
  const table = Prisma.raw(`"${meta.rootTable}"`);
  return tx.$queryRaw<RootRow[]>(Prisma.sql`
    SELECT "id", ${meta.nameExpr} AS "name", "tenantId" FROM ${table} WHERE ${idIn(ids)}
  `);
}

async function loadTenant(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{ id: string; name: string; isActive: boolean } | null> {
  const rows = await tx.$queryRaw<{ id: string; name: string; isActive: boolean }[]>(Prisma.sql`
    SELECT "id", "name", "isActive" FROM "tenants" WHERE "id" = ${id}
  `);
  return rows[0] ?? null;
}

/** 预演：只 SELECT，拿到每一步会搬走的行 id。 */
async function collectStep(
  tx: Prisma.TransactionClient,
  ctx: StepContext,
  step: Step,
): Promise<string[]> {
  const table = Prisma.raw(`"${step.table}"`);
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM ${table}
    WHERE "tenantId" = ${ctx.source} AND (${step.condition(ctx)})
  `);
  return rows.map((row) => row.id);
}

/** 执行：UPDATE 并把实际改动的 id 带回来，供下游步骤使用。 */
async function applyStep(
  tx: Prisma.TransactionClient,
  ctx: StepContext,
  step: Step,
): Promise<string[]> {
  const table = Prisma.raw(`"${step.table}"`);
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH updated AS (
      UPDATE ${table}
      SET "tenantId" = ${ctx.target}
      WHERE "tenantId" = ${ctx.source} AND (${step.condition(ctx)})
      RETURNING "id"
    )
    SELECT "id" FROM updated
  `);
  const ids = rows.map((row) => row.id);
  if (step.afterApply && ids.length > 0) await step.afterApply(tx, ctx, ids);
  return ids;
}

async function walk(
  tx: Prisma.TransactionClient,
  mode: 'plan' | 'apply',
  ctx: StepContext,
  steps: Step[],
): Promise<Record<string, { label: string; count: number }>> {
  const counts: Record<string, { label: string; count: number }> = {};
  for (const step of steps) {
    const ids = mode === 'apply' ? await applyStep(tx, ctx, step) : await collectStep(tx, ctx, step);
    ctx.ids.set(step.key, ids);
    if (ids.length > 0) counts[step.key] = { label: step.label, count: ids.length };
  }
  return counts;
}

/** 目标租户里已有同名对象：唯一键是 (tenantId, name)，直接搬会撞。 */
async function checkNameConflicts(
  tx: Prisma.TransactionClient,
  meta: TransferKindMeta,
  roots: RootRow[],
  target: string,
): Promise<TransferBlocker[]> {
  const names = roots.map((root) => root.name).filter((name) => name.length > 0);
  if (names.length === 0) return [];
  const table = Prisma.raw(`"${meta.rootTable}"`);
  const rows = await tx.$queryRaw<{ name: string }[]>(Prisma.sql`
    SELECT ${meta.nameExpr} AS "name" FROM ${table}
    WHERE "tenantId" = ${target} AND ${meta.nameExpr} = ANY(${names}::text[])
  `);
  return rows.map((row) => ({
    code: 'NAME_CONFLICT',
    message: `目标租户已有同名${meta.label}「${row.name}」，请先在目标租户改名或删除`,
    objectId: roots.find((root) => root.name === row.name)?.id,
  }));
}

/** 任务引用了源租户自建的题集：任务搬走、题集留下，会变成跨租户引用。 */
async function checkQuestionSetLinks(
  tx: Prisma.TransactionClient,
  ctx: StepContext,
  taskIds: string[],
): Promise<TransferBlocker[]> {
  if (taskIds.length === 0) return [];
  const rows = await tx.$queryRaw<{ taskId: string; name: string }[]>(Prisma.sql`
    SELECT DISTINCT l."taskId", q."name"
    FROM "eval_task_question_sets" l
    JOIN "question_sets" q ON q."id" = l."questionSetId"
    WHERE l."taskId" = ANY(${taskIds}::text[])
      AND q."tenantId" = ${ctx.source}
  `);
  return rows.map((row) => ({
    code: 'FOREIGN_QUESTION_SET',
    message: `任务引用了本租户自建题集「${row.name}」，请先把该题集一并转移，或单独处理这个任务`,
    objectId: row.taskId,
  }));
}

/** 责任人属于源租户的终端：转移后会被清空，提前告知。 */
async function collectOwnerWarnings(
  tx: Prisma.TransactionClient,
  endpointIds: string[],
  source: string,
): Promise<TransferWarning[]> {
  if (endpointIds.length === 0) return [];
  const rows = await tx.$queryRaw<{ hostname: string; ownerName: string | null }[]>(Prisma.sql`
    SELECT "hostname", "ownerName" FROM "fleet_endpoints"
    WHERE "id" = ANY(${endpointIds}::text[]) AND "ownerUserId" IS NOT NULL
      AND "ownerUserId" IN (SELECT "id" FROM "users" WHERE "tenantId" = ${source})
  `);
  return rows.map((row) => ({
    code: 'OWNER_CLEARED',
    message: `终端 ${row.hostname} 的责任人「${row.ownerName ?? '未填姓名'}」属于原租户，转移后将被清空，请在新租户重新指派`,
  }));
}

/** 终端作业关联了原租户的任务：转移时会解除关联，提前告知条数。 */
async function collectJobWarnings(
  tx: Prisma.TransactionClient,
  endpointIds: string[],
  source: string,
): Promise<TransferWarning[]> {
  if (endpointIds.length === 0) return [];
  const rows = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n FROM "fleet_eval_jobs"
    WHERE "endpointId" = ANY(${endpointIds}::text[])
      AND "evalTaskId" IN (SELECT "id" FROM "eval_tasks" WHERE "tenantId" = ${source})
  `);
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) return [];
  return [
    {
      code: 'JOB_TASK_UNLINKED',
      message: `有 ${n} 个历史下发作业关联着原租户的评估任务，转移时会解除关联（作业记录本身保留）`,
    },
  ];
}

/** 原租户台账里关联着这些终端、评估对象的资产：转移时会解除关联，提前告知条数。 */
async function collectLedgerWarnings(
  tx: Prisma.TransactionClient,
  column: 'fleetEndpointId' | 'modelTargetId',
  rootIds: string[],
  target: string,
): Promise<TransferWarning[]> {
  if (rootIds.length === 0) return [];
  const rows = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n FROM "ledger_assets"
    WHERE ${inIds(column, rootIds)} AND "tenantId" IS DISTINCT FROM ${target}
  `);
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) return [];
  const what = column === 'fleetEndpointId' ? '终端' : '评估对象';
  return [
    {
      code: 'LEDGER_UNLINKED',
      message: `有 ${n} 个应用台账资产关联着这些${what}，转移时会解除关联（台账资产本身保留）`,
    },
  ];
}

/** 组合报告不跟任务走：引用了要迁走的任务的组合报告留在原租户，报告里那些任务标「任务已移出本租户」。 */
async function collectCombinedReportWarnings(
  tx: Prisma.TransactionClient,
  taskIds: string[],
  source: string,
): Promise<TransferWarning[]> {
  if (taskIds.length === 0) return [];
  const rows = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(DISTINCT rt."reportId") AS n
    FROM "report_tasks" rt
    JOIN "reports" r ON r."id" = rt."reportId"
    WHERE rt."taskId" = ANY(${taskIds}::text[]) AND r."tenantId" = ${source}
  `);
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) return [];
  return [
    {
      code: 'COMBINED_REPORT_STAYS',
      message: `有 ${n} 份组合报告引用这些任务，报告留在原租户`,
    },
  ];
}

interface PlanOutcome {
  plan: TransferPlan;
  ctx: StepContext;
  steps: Step[];
}

async function buildPlan(
  tx: Prisma.TransactionClient,
  input: TransferInput,
): Promise<PlanOutcome> {
  const meta = TRANSFER_KIND_MAP.get(input.kind);
  const blockers: TransferBlocker[] = [];
  const warnings: TransferWarning[] = [];
  const emptyCtx: StepContext = {
    source: '',
    target: input.targetTenantId,
    rootIds: [],
    ids: new Map(),
  };

  const finish = (): PlanOutcome => {
    const totalRows = Object.values(countsFinal).reduce((sum, item) => sum + item.count, 0);
    return {
      plan: {
        kind: input.kind,
        kindLabel: meta?.label ?? input.kind,
        sourceTenant: { id: emptyCtx.source, name: sourceName },
        targetTenant: { id: input.targetTenantId, name: targetName },
        roots,
        counts: countsFinal,
        totalRows,
        blockers,
        warnings,
        canTransfer: blockers.length === 0 && totalRows > 0,
      },
      ctx: emptyCtx,
      steps: meta ? stepsFor(input.kind) : [],
    };
  };

  let countsFinal: Record<string, { label: string; count: number }> = {};
  let roots: TransferRoot[] = [];
  let sourceName = '';
  let targetName = '';

  if (!meta) {
    blockers.push({ code: 'UNKNOWN_KIND', message: `不支持的资产类型：${input.kind}` });
    return finish();
  }

  const target = await loadTenant(tx, input.targetTenantId);
  if (!target) {
    blockers.push({ code: 'TARGET_NOT_FOUND', message: '目标租户不存在' });
    return finish();
  }
  targetName = target.name;
  if (!target.isActive) {
    blockers.push({ code: 'TARGET_INACTIVE', message: '目标租户已停用，请先启用' });
    return finish();
  }

  const rootRows = await loadRoots(tx, meta, input.ids);
  const missing = input.ids.filter((id) => !rootRows.some((row) => row.id === id));
  if (missing.length > 0) {
    blockers.push({
      code: 'ROOT_NOT_FOUND',
      message: `有 ${missing.length} 个${meta.label}不存在或已删除`,
    });
  }

  const shared = rootRows.filter((row) => row.tenantId === null);
  if (shared.length > 0) {
    blockers.push({
      code: 'SHARED_OBJECT',
      message: `平台共享的${meta.label}（${shared.map((row) => `「${row.name}」`).join('、')}）不可转移，各租户只读共用`,
    });
  }

  const already = rootRows.filter((row) => row.tenantId === input.targetTenantId);
  const movable = rootRows.filter(
    (row) => row.tenantId !== null && row.tenantId !== input.targetTenantId,
  );

  const sources = [...new Set(movable.map((row) => row.tenantId as string))];
  if (sources.length > 1) {
    blockers.push({
      code: 'MULTI_SOURCE',
      message: '所选资产分属不同租户，请一次只转移同一个租户的资产',
    });
    return finish();
  }

  const source = sources[0] ?? '';
  emptyCtx.source = source;
  emptyCtx.rootIds = movable.map((row) => row.id);
  roots = movable.map((row) => ({ id: row.id, name: row.name, tenantId: row.tenantId }));
  if (source) sourceName = (await loadTenant(tx, source))?.name ?? '';

  if (movable.length === 0) {
    if (already.length > 0 && blockers.length === 0) {
      blockers.push({
        code: 'ALREADY_IN_TARGET',
        message: `所选${meta.label}已经在目标租户，无需转移`,
      });
    }
    return finish();
  }

  countsFinal = await walk(tx, 'plan', emptyCtx, stepsFor(input.kind));

  if (input.kind === 'model-target') {
    blockers.push(...(await checkQuestionSetLinks(tx, emptyCtx, idsOf(emptyCtx, 'evalTask'))));
  }
  warnings.push(
    ...(await collectCombinedReportWarnings(tx, idsOf(emptyCtx, 'evalTask'), source)),
  );
  if (input.kind === 'fleet-endpoint') {
    warnings.push(...(await collectOwnerWarnings(tx, emptyCtx.rootIds, source)));
    warnings.push(...(await collectJobWarnings(tx, emptyCtx.rootIds, source)));
    warnings.push(
      ...(await collectLedgerWarnings(tx, 'fleetEndpointId', emptyCtx.rootIds, input.targetTenantId)),
    );
  }
  if (input.kind === 'model-target') {
    warnings.push(
      ...(await collectLedgerWarnings(tx, 'modelTargetId', emptyCtx.rootIds, input.targetTenantId)),
    );
  }
  if (input.kind === 'question-set') {
    const refs = await tx.$queryRaw<{ taskId: string }[]>(Prisma.sql`
      SELECT DISTINCT "taskId" FROM "eval_task_question_sets"
      WHERE "questionSetId" = ANY(${emptyCtx.rootIds}::text[])
        AND "taskId" IN (SELECT "id" FROM "eval_tasks" WHERE "tenantId" = ${source})
    `);
    if (refs.length > 0) {
      blockers.push({
        code: 'IN_USE_BY_TASK',
        message: `有 ${refs.length} 个本租户任务正在使用该题集，请先转移或删除这些任务`,
      });
    }
  }
  blockers.push(...(await checkNameConflicts(tx, meta, movable, input.targetTenantId)));

  warnings.push({
    code: 'INVISIBLE_AFTER',
    message: '转移后原租户的用户将不再看到这些资产；这是一次不可逆的归属变更，请先确认已备份。',
  });

  return finish();
}

/** 预检：不写任何数据。 */
export async function planTransfer(input: TransferInput): Promise<TransferPlan> {
  const outcome = await db.$transaction((tx) => buildPlan(tx, input), { timeout: 30_000 });
  return outcome.plan;
}

export class TransferRejected extends Error {
  constructor(
    message: string,
    readonly plan: TransferPlan,
  ) {
    super(message);
    this.name = 'TransferRejected';
  }
}

/** 执行：一个事务里重跑预检再逐层搬，任何一步被数据库拒绝都整体回滚。 */
export async function executeTransfer(input: TransferInput): Promise<TransferResult> {
  return db.$transaction(
    async (tx) => {
      const outcome = await buildPlan(tx, input);
      if (!outcome.plan.canTransfer) {
        const detail = outcome.plan.blockers.map((item) => item.message).join('；');
        throw new TransferRejected(detail || '没有可转移的资产', outcome.plan);
      }

      const appliedCounts = await walk(tx, 'apply', outcome.ctx, outcome.steps);

      // 收尾校验：本次涉及的每一层都不应该再有源租户的行残留。
      for (const step of outcome.steps) {
        const moved = outcome.ctx.ids.get(step.key) ?? [];
        if (moved.length === 0) continue;
        const rows = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
          SELECT count(*) AS n FROM ${Prisma.raw(`"${step.table}"`)}
          WHERE "id" = ANY(${moved}::text[]) AND "tenantId" <> ${outcome.ctx.target}
        `);
        if (Number(rows[0]?.n ?? 0) > 0) {
          throw new TransferRejected(`转移后仍有${step.label}留在原租户，已回滚`, outcome.plan);
        }
      }

      const applied: Record<string, number> = {};
      let totalRows = 0;
      for (const [key, value] of Object.entries(appliedCounts)) {
        applied[key] = value.count;
        totalRows += value.count;
      }
      return { plan: outcome.plan, applied, totalRows };
    },
    { timeout: 120_000, maxWait: 15_000 },
  );
}
