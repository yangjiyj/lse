import { Prisma, type DetectScheme, type DetectSchemeItem } from '@prisma/client';
import { z } from 'zod';
import {
  DETECT_CATEGORIES,
  DETECT_JOB_ITEM_META,
  TOOL_TASK_ENTRIES,
  isDetectJobItemKind,
  isDetectTaskTerminal,
  type DetectJobItemKind,
  type LedgerAssetType,
  type ToolTaskEntryKey,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { parseDetectJobItemParams } from '../detect-jobs/item-params.js';
import {
  DETECT_JOB_MAX_ITEMS,
  createDetectJob,
  type DetectJobActionContext,
} from '../detect-jobs/service.js';
import { readLedgerAttrs } from '../ledger/attrs.js';
import {
  LEDGER_LINK_SELECT,
  ledgerDisplayName,
  linkedEndpoint,
  linkedTarget,
} from '../ledger/service.js';
import { REPORT_TIME_ZONE } from '../reports/labels.js';
import { effectiveRoots, loadConfig as loadModelFileConfig } from '../model-files/service.js';
import { readScopeConfig } from '../asset-discovery/service.js';
import { generateSchemeItems, type GenerateAsset, type GenerateContext } from './generate.js';

// 检测方案（2.8.2）：需求配置校验、状态推算、详情。都在当前租户范围内执行（查询扩展过滤）。

export const SCHEME_STATUSES = ['draft', 'planned', 'executing', 'done', 'archived'] as const;
export type SchemeStatus = (typeof SCHEME_STATUSES)[number];

/**
 * 方案状态（读时推算）：归档 → archived；没有清单项 → draft（需求配置中）；没有关联的组合任务 → planned（清单已生成）；
 * 有未结束的组合任务 → executing；否则 → done。
 */
export function schemeStatus(s: {
  archivedAt: Date | null;
  itemCount: number;
  jobCount: number;
  activeJobCount: number;
}): SchemeStatus {
  if (s.archivedAt) return 'archived';
  if (s.itemCount === 0) return 'draft';
  if (s.jobCount === 0) return 'planned';
  if (s.activeJobCount > 0) return 'executing';
  return 'done';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (v: string) => {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const dateField = z
  .string()
  .refine(isRealDate, { message: '日期格式为 YYYY-MM-DD' })
  .nullable()
  .optional()
  .transform((v) => v || undefined);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v || undefined);

/** 需求配置：检测目标、类别（非空）、对象（1～200 个，都在本租户台账里）、计划时间、联系人、备注。 */
export const requirementSchema = z
  .object({
    objective: z.string().trim().min(1, '请填写检测目标').max(1000),
    categories: z
      .array(z.enum(DETECT_CATEGORIES))
      .min(1, '至少选一个检测类别')
      .transform((v) => DETECT_CATEGORIES.filter((c) => v.includes(c))),
    assetIds: z
      .array(z.string().uuid())
      .min(1, '至少选一个检测对象')
      .max(200, '检测对象不超过 200 个')
      .transform((v) => [...new Set(v)]),
    plannedStart: dateField,
    plannedEnd: dateField,
    contactName: optionalText(50),
    contactPhone: optionalText(30),
    notes: optionalText(2000),
  })
  .strict()
  .refine((r) => !r.plannedStart || !r.plannedEnd || r.plannedStart <= r.plannedEnd, {
    message: '计划开始日期不能晚于结束日期',
    path: ['plannedEnd'],
  });

export type SchemeRequirement = z.output<typeof requirementSchema>;

/** 库里的需求配置（JSON）读成对象；字段缺失时给空值，不抛错。 */
export function readRequirement(value: unknown): SchemeRequirement {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const strings = (x: unknown) =>
    Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [];
  const text = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
  return {
    objective: typeof v.objective === 'string' ? v.objective : '',
    categories: DETECT_CATEGORIES.filter((c) => strings(v.categories).includes(c)),
    assetIds: strings(v.assetIds),
    plannedStart: text(v.plannedStart),
    plannedEnd: text(v.plannedEnd),
    contactName: text(v.contactName),
    contactPhone: text(v.contactPhone),
    notes: text(v.notes),
  };
}

const assetInvalid = () => badRequest('检测对象不存在或不属于本租户', 'SCHEME_ASSET_INVALID');

/** 本租户台账里还在的资产 id（查询扩展只读得到本租户的）。 */
async function existingAssetIds(assetIds: string[]): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const rows = await prisma.ledgerAsset.findMany({
    where: { id: { in: assetIds } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** 需求配置里的对象都要在本租户台账里。 */
export async function assertRequirementAssets(assetIds: string[]): Promise<void> {
  const found = await existingAssetIds(assetIds);
  if (found.size !== assetIds.length) throw assetInvalid();
}

/**
 * 改需求配置时的对象：原来配置里有、后来从台账删掉的 id 直接忽略（详情回填时可能带着）；
 * 新加的 id 必须在本租户台账里。忽略之后一个都不剩时 400。
 */
export async function resolveRequirementAssets(
  assetIds: string[],
  storedIds: readonly string[],
): Promise<string[]> {
  const found = await existingAssetIds(assetIds);
  const stored = new Set(storedIds);
  if (assetIds.some((id) => !found.has(id) && !stored.has(id))) throw assetInvalid();
  const kept = assetIds.filter((id) => found.has(id));
  if (kept.length === 0) throw badRequest('至少选一个检测对象', 'SCHEME_ASSET_INVALID');
  return kept;
}

/** 日期（北京时间），组合任务的默认名称用。 */
export function schemeDateText(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export const schemeNameTaken = () => conflict('已有同名方案', 'SCHEME_NAME_TAKEN');
export const schemeArchived = () => conflict('方案已归档，请先取消归档', 'SCHEME_ARCHIVED');

export function rethrowSchemeUnique(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw schemeNameTaken();
  }
  throw err;
}

/** 方案关联的组合任务数（总数、未结束数）。 */
export async function schemeJobCounts(
  ids: string[],
): Promise<Map<string, { total: number; active: number }>> {
  const out = new Map(ids.map((id) => [id, { total: 0, active: 0 }]));
  if (ids.length === 0) return out;
  const rows = await prisma.detectJob.groupBy({
    by: ['schemeId', 'status'],
    where: { schemeId: { in: ids } },
    _count: { _all: true },
  });
  for (const row of rows) {
    const c = row.schemeId ? out.get(row.schemeId) : undefined;
    if (!c) continue;
    c.total += row._count._all;
    if (!isDetectTaskTerminal(row.status)) c.active += row._count._all;
  }
  return out;
}

/** 取本租户的方案，取不到 404。 */
export async function loadScheme(id: string): Promise<DetectScheme> {
  const scheme = await prisma.detectScheme.findUnique({ where: { id } });
  if (!scheme) throw notFound('方案不存在');
  return scheme;
}

/** 写操作前：方案存在且没归档。 */
export async function loadWritableScheme(id: string): Promise<DetectScheme> {
  const scheme = await loadScheme(id);
  if (scheme.archivedAt) throw schemeArchived();
  return scheme;
}

export const itemInclude = {
  asset: { select: { id: true, type: true, name: true, ...LEDGER_LINK_SELECT } },
} satisfies Prisma.DetectSchemeItemInclude;

export type SchemeItemRow = Prisma.DetectSchemeItemGetPayload<{ include: typeof itemInclude }>;

export function serializeItem(item: SchemeItemRow) {
  return {
    id: item.id,
    position: item.position,
    assetId: item.assetId,
    asset: item.asset
      ? {
          id: item.asset.id,
          type: item.asset.type as LedgerAssetType,
          name: ledgerDisplayName(item.asset),
        }
      : null,
    category: item.category,
    entryKey: item.entryKey,
    mode: item.mode,
    jobKind: item.jobKind,
    params: item.params,
    ...itemReadiness(item),
    title: item.title,
    note: item.note,
    enabled: item.enabled,
    origin: item.origin,
    edited: item.edited,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function serializeSchemeBase(
  s: DetectScheme,
  counts: { itemCount: number; jobCount: number; activeJobCount: number },
) {
  return {
    id: s.id,
    tenantId: s.tenantId,
    name: s.name,
    status: schemeStatus({ archivedAt: s.archivedAt, ...counts }),
    itemCount: counts.itemCount,
    jobCount: counts.jobCount,
    generatedAt: s.generatedAt?.toISOString() ?? null,
    archivedAt: s.archivedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** 方案详情：需求配置（对象带名称，已从台账删掉的不再列出）、清单项、状态。 */
export async function schemeDetail(id: string) {
  const scheme = await loadScheme(id);
  const stored = readRequirement(scheme.requirement);
  const [items, assets, jobs] = await Promise.all([
    prisma.detectSchemeItem.findMany({
      where: { schemeId: id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: itemInclude,
    }),
    prisma.ledgerAsset.findMany({
      where: { id: { in: stored.assetIds } },
      select: { id: true, type: true, name: true, ...LEDGER_LINK_SELECT },
    }),
    schemeJobCounts([id]),
  ]);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const requirement = { ...stored, assetIds: stored.assetIds.filter((a) => byId.has(a)) };
  const job = jobs.get(id) ?? { total: 0, active: 0 };
  return {
    ...serializeSchemeBase(scheme, {
      itemCount: items.length,
      jobCount: job.total,
      activeJobCount: job.active,
    }),
    requirement,
    // 需求配置里的对象按配置顺序；已从台账删除的不再列出。
    assets: requirement.assetIds
      .map((assetId) => byId.get(assetId))
      .filter((a): a is NonNullable<typeof a> => Boolean(a))
      .map((a) => ({ id: a.id, type: a.type as LedgerAssetType, name: ledgerDisplayName(a) })),
    items: items.map(serializeItem),
  };
}

// ---------------------------------------------------------------- 方案清单（2.8.2）

/** 生成清单用的平台配置：模型文件扫描的允许目录、资产测绘已配的端口。 */
export async function schemeGenerateContext(): Promise<GenerateContext> {
  const [cfg, scope] = await Promise.all([loadModelFileConfig(), readScopeConfig()]);
  return { modelFileRoots: effectiveRoots(cfg), discoveryPorts: scope.ports };
}

/** 需求配置里的资产（本租户），转成生成规则的输入；已移除或不在本租户的终端、评估对象按没关联算。 */
export async function schemeGenerateAssets(assetIds: string[]): Promise<GenerateAsset[]> {
  const rows = await prisma.ledgerAsset.findMany({
    where: { id: { in: assetIds } },
    select: { id: true, type: true, name: true, attrs: true, ...LEDGER_LINK_SELECT },
  });
  return rows.map((a) => {
    const endpoint = linkedEndpoint(a);
    return {
      id: a.id,
      type: a.type,
      name: ledgerDisplayName(a),
      attrs: readLedgerAttrs(a.attrs),
      fleetEndpointId: endpoint && !endpoint.removedAt ? a.fleetEndpointId : null,
      modelTargetId: linkedTarget(a) ? a.modelTargetId : null,
    };
  });
}

/**
 * 按台账（重新）生成清单：删除规则生成且没被手工改过的项，按规则重出，跳过与保留项「资产 + 入口」相同的；
 * 保留项（手工改过的、手工添加的）序号不动，新项排在后面；写 generatedAt。
 * 并发生成时先锁方案行，第二次等第一次提交后再删再出，不会出重复项。
 */
export async function generateScheme(id: string): Promise<{ created: number; kept: number }> {
  const scheme = await loadWritableScheme(id);
  const requirement = readRequirement(scheme.requirement);
  const [assets, ctx] = await Promise.all([
    schemeGenerateAssets(requirement.assetIds),
    schemeGenerateContext(),
  ]);
  const generated = generateSchemeItems(requirement, assets, ctx);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "detect_schemes" WHERE "id" = ${id} FOR UPDATE`;
    await tx.detectSchemeItem.deleteMany({
      where: { schemeId: id, origin: 'generated', edited: false },
    });
    const kept = await tx.detectSchemeItem.findMany({
      where: { schemeId: id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, position: true, assetId: true, entryKey: true },
    });
    const keptKeys = new Set(kept.map((k) => `${k.assetId ?? ''}|${k.entryKey}`));
    const fresh = generated.filter((g) => !keptKeys.has(`${g.assetId}|${g.entryKey}`));
    const start = kept.reduce((max, k) => Math.max(max, k.position), -1) + 1;
    if (fresh.length) {
      await tx.detectSchemeItem.createMany({
        data: fresh.map((g, i) => ({
          schemeId: id,
          position: start + i,
          assetId: g.assetId,
          category: g.category,
          entryKey: g.entryKey,
          mode: g.mode,
          jobKind: g.jobKind,
          params: g.params as Prisma.InputJsonObject,
          title: g.title.slice(0, 200),
          origin: 'generated',
        })),
      });
    }
    await tx.detectScheme.update({ where: { id }, data: { generatedAt: new Date() } });
    return { created: fresh.length, kept: kept.length };
  });
}

const itemInvalid = (message: string) => badRequest(message, 'SCHEME_ITEM_INVALID');

/** 平台自动执行的项必须给子任务类型，且子任务对应的入口就是这一项的入口；人工执行的项不带子任务类型。 */
export function assertItemMode(entryKey: string, mode: string, jobKind: string | null): void {
  if (mode === 'auto') {
    if (!jobKind || !isDetectJobItemKind(jobKind)) {
      throw itemInvalid('平台自动执行的项要选子任务类型');
    }
    if (DETECT_JOB_ITEM_META[jobKind].entry !== entryKey) {
      throw itemInvalid('子任务类型与检测入口不一致');
    }
  } else if (jobKind) {
    throw itemInvalid('人工执行的项不需要子任务类型');
  }
}

async function assertItemAsset(assetId: string | null | undefined) {
  if (!assetId) return null;
  const asset = await prisma.ledgerAsset.findUnique({
    where: { id: assetId },
    select: { id: true, type: true, name: true, ...LEDGER_LINK_SELECT },
  });
  if (!asset) throw badRequest('检测对象不存在或不属于本租户', 'SCHEME_ASSET_INVALID');
  return asset;
}

type ItemAsset = NonNullable<Awaited<ReturnType<typeof assertItemAsset>>>;

/** 子任务参数里绑定检测对象的字段：必须是该对象在台账里关联的终端、评估对象。目录、扫描目标这类用户可改的不校验。 */
const BOUND_PARAM_FIELDS: Partial<
  Record<DetectJobItemKind, Array<{ field: string; link: 'endpoint' | 'target'; label: string }>>
> = {
  eval_task: [{ field: 'modelTargetId', link: 'target', label: '评估对象' }],
  model_file_scan: [{ field: 'targetId', link: 'target', label: '评估对象' }],
  fleet_posture: [{ field: 'endpointId', link: 'endpoint', label: '终端' }],
};

/** 自动项换了检测对象或参数时：参数里绑定对象的字段要与对象关联的一致，不一致 400。没指定对象的不校验。 */
export function assertParamsMatchAsset(
  jobKind: string | null,
  params: unknown,
  asset: ItemAsset | null,
): void {
  if (!asset || !jobKind || !isDetectJobItemKind(jobKind)) return;
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  for (const bound of BOUND_PARAM_FIELDS[jobKind] ?? []) {
    const value = p[bound.field];
    if (typeof value !== 'string' || !value) continue;
    const linked =
      bound.link === 'endpoint'
        ? linkedEndpoint(asset)
          ? asset.fleetEndpointId
          : null
        : linkedTarget(asset)
          ? asset.modelTargetId
          : null;
    if (value !== linked) {
      throw badRequest(
        `参数里的${bound.label}与检测对象「${ledgerDisplayName(asset)}」关联的${bound.label}不一致`,
        'SCHEME_ITEM_ASSET_MISMATCH',
        { field: bound.field },
      );
    }
  }
}

async function loadItem(schemeId: string, itemId: string) {
  const item = await prisma.detectSchemeItem.findFirst({ where: { id: itemId, schemeId } });
  if (!item) throw notFound('清单项不存在');
  return item;
}

export interface SchemeItemInput {
  assetId?: string | null;
  entryKey: ToolTaskEntryKey;
  mode: 'auto' | 'manual';
  jobKind?: DetectJobItemKind | null;
  params?: Record<string, unknown>;
  title?: string;
  note?: string;
  enabled?: boolean;
}

/** 手工添加清单项：origin = manual，类别取入口的类别，排在最后。 */
export async function addSchemeItem(schemeId: string, input: SchemeItemInput) {
  await loadWritableScheme(schemeId);
  const jobKind = input.jobKind ?? null;
  assertItemMode(input.entryKey, input.mode, jobKind);
  const asset = await assertItemAsset(input.assetId);
  if (input.mode === 'auto') assertParamsMatchAsset(jobKind, input.params ?? {}, asset);
  const entry = TOOL_TASK_ENTRIES[input.entryKey];
  const last = await prisma.detectSchemeItem.aggregate({
    where: { schemeId },
    _max: { position: true },
  });
  return prisma.detectSchemeItem.create({
    data: {
      schemeId,
      position: (last._max.position ?? -1) + 1,
      assetId: asset?.id ?? null,
      category: entry.category,
      entryKey: input.entryKey,
      mode: input.mode,
      jobKind,
      params: (input.params ?? {}) as Prisma.InputJsonObject,
      title: input.title ?? (asset ? `${entry.label} · ${ledgerDisplayName(asset)}` : entry.label),
      note: input.note ?? '',
      enabled: input.enabled ?? true,
      origin: 'manual',
    },
    include: itemInclude,
  });
}

export type SchemeItemPatch = Partial<Omit<SchemeItemInput, 'entryKey'>>;

/** 改清单项（含启停）：标 edited，重新生成时保留。 */
export async function updateSchemeItem(schemeId: string, itemId: string, patch: SchemeItemPatch) {
  await loadWritableScheme(schemeId);
  const item = await loadItem(schemeId, itemId);
  const mode = patch.mode ?? item.mode;
  const jobKind =
    patch.jobKind !== undefined ? patch.jobKind : patch.mode === 'manual' ? null : item.jobKind;
  assertItemMode(item.entryKey, mode, jobKind);
  const assetId = patch.assetId !== undefined ? patch.assetId : item.assetId;
  const asset = await assertItemAsset(assetId);
  // 只在改了对象、参数或方式时核对绑定字段：单纯启停、改名不受历史数据影响。
  const bindingTouched =
    patch.assetId !== undefined ||
    patch.params !== undefined ||
    patch.mode !== undefined ||
    patch.jobKind !== undefined;
  if (mode === 'auto' && bindingTouched) {
    assertParamsMatchAsset(jobKind, patch.params !== undefined ? patch.params : item.params, asset);
  }
  const updated = await prisma.detectSchemeItem.update({
    where: { id: itemId },
    data: {
      mode,
      jobKind,
      ...(patch.assetId !== undefined ? { assetId: patch.assetId } : {}),
      ...(patch.params !== undefined ? { params: patch.params as Prisma.InputJsonObject } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      edited: true,
    },
    include: itemInclude,
  });
  return { before: item, after: updated };
}

export async function deleteSchemeItem(schemeId: string, itemId: string) {
  await loadWritableScheme(schemeId);
  const item = await loadItem(schemeId, itemId);
  await prisma.detectSchemeItem.delete({ where: { id: itemId } });
  return item;
}

/** 排序：ids 必须恰好是该方案的全部清单项。 */
export async function reorderSchemeItems(schemeId: string, ids: string[]): Promise<void> {
  await loadWritableScheme(schemeId);
  const items = await prisma.detectSchemeItem.findMany({
    where: { schemeId },
    select: { id: true },
  });
  const all = new Set(items.map((i) => i.id));
  if (new Set(ids).size !== ids.length || ids.length !== all.size || ids.some((i) => !all.has(i))) {
    throw badRequest('排序要包含方案的全部清单项', 'SCHEME_REORDER_INVALID');
  }
  await prisma.$transaction(
    ids.map((id, position) =>
      prisma.detectSchemeItem.update({ where: { id }, data: { position } }),
    ),
  );
}

// ---------------------------------------------------------------- 方案与组合任务（2.8.4）

/** 子任务参数里的字段 → 页面上的中文名（「缺：样本库、端口」）。 */
const PARAM_FIELD_LABELS: Record<DetectJobItemKind, Record<string, string>> = {
  eval_task: {
    modelTargetId: '评估对象',
    questionSetIds: '样本库',
    engines: '判定引擎',
    dimensions: '评估维度',
    concurrency: '并发数',
    sampleSize: '抽样数量',
    sampleSeed: '抽样种子',
    description: '描述',
  },
  model_file_scan: {
    source: '扫描来源',
    path: '模型目录',
    uploadId: '模型库文件',
    targetId: '评估对象',
  },
  corpus_scan: { sourceScanId: '来源语料', ruleSetId: '规则集', judgeReview: '裁判复核' },
  asset_discovery: { targets: '扫描目标', ports: '端口', confirm: '授权确认' },
  fleet_posture: { endpointId: '终端', items: '体检项' },
};

export interface ItemReadiness {
  /** 平台自动执行的项能不能直接建任务；人工执行的项为 null */
  ready: boolean | null;
  /** 缺的或不合法的参数（中文字段名） */
  missing: string[];
}

/** 按组合任务的参数校验（parseDetectJobItemParams）判断 auto 项是否就绪，缺的字段翻成中文名。 */
export function itemReadiness(item: {
  mode: string;
  jobKind: string | null;
  params: unknown;
}): ItemReadiness {
  if (item.mode !== 'auto') return { ready: null, missing: [] };
  if (!item.jobKind || !isDetectJobItemKind(item.jobKind)) {
    return { ready: false, missing: ['子任务类型'] };
  }
  const kind = item.jobKind;
  try {
    parseDetectJobItemParams(kind, item.params);
    return { ready: true, missing: [] };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const issues = ((
      err.details as { issues?: Array<{ path: Array<string | number> }> } | undefined
    )?.issues ?? []) as Array<{ path: Array<string | number> }>;
    const labels = PARAM_FIELD_LABELS[kind];
    const missing = issues.map((issue) => {
      const key = issue.path[0];
      return typeof key === 'string' ? (labels[key] ?? key) : '参数';
    });
    return { ready: false, missing: [...new Set(missing.length ? missing : ['参数'])] };
  }
}

/**
 * 按方案清单建组合任务（不启动，启动由调用方在写完审计后做）：取启用的 auto 项（给了 itemIds 就只取这些），
 * 超过组合任务子任务上限 400（请勾选分批建），有未就绪的 400 并列出缺的字段；
 * 子任务带上清单项的资产，组合任务记 schemeId、triggeredBy = scheme。
 */
export async function createSchemeJob(
  user: CurrentUser,
  schemeId: string,
  body: { name?: string; itemIds?: string[]; maxParallel?: number; start?: boolean },
  ctx: DetectJobActionContext,
): Promise<{ jobId: string; itemCount: number }> {
  const scheme = await loadWritableScheme(schemeId);
  const autoItems = await prisma.detectSchemeItem.findMany({
    where: { schemeId, enabled: true, mode: 'auto' },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  let selected = autoItems;
  if (body.itemIds) {
    const wanted = new Set(body.itemIds);
    selected = autoItems.filter((i) => wanted.has(i.id));
    if (selected.length !== wanted.size) {
      throw badRequest('所选清单项不存在、已停用或不能自动执行', 'SCHEME_ITEMS_INVALID');
    }
  }
  if (selected.length === 0) {
    throw badRequest('没有可自动执行的清单项', 'SCHEME_NO_AUTO_ITEMS');
  }
  if (selected.length > DETECT_JOB_MAX_ITEMS) {
    throw badRequest(
      `可自动执行的清单项有 ${selected.length} 个，一个组合任务最多 ${DETECT_JOB_MAX_ITEMS} 个，请勾选不超过 ${DETECT_JOB_MAX_ITEMS} 项分批建任务`,
      'SCHEME_TOO_MANY_ITEMS',
      { count: selected.length, max: DETECT_JOB_MAX_ITEMS },
    );
  }
  const notReady = selected
    .map((item) => ({ item, readiness: itemReadiness(item) }))
    .filter((r) => !r.readiness.ready)
    .map((r) => ({ id: r.item.id, title: r.item.title, missing: r.readiness.missing }));
  if (notReady.length > 0) {
    throw badRequest(
      `以下清单项参数不完整：${notReady.map((r) => `「${r.title}」缺${r.missing.join('、')}`).join('；')}`,
      'SCHEME_ITEMS_NOT_READY',
      { items: notReady },
    );
  }
  const name = body.name?.trim() || `${scheme.name} · ${schemeDateText()}`;
  const { id: jobId } = await createDetectJob(user, {
    name,
    maxParallel: body.maxParallel,
    items: selected.map((item) => ({
      kind: item.jobKind as DetectJobItemKind,
      title: item.title,
      params: item.params,
      ledgerAssetId: item.assetId,
    })),
    schemeId,
    triggeredBy: 'scheme',
  });
  await writeAudit({
    actorId: user.id,
    actorName: user.username,
    action: 'detect_job.create',
    targetType: 'detect_job',
    targetId: jobId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    detail: {
      name,
      maxParallel: body.maxParallel ?? null,
      kinds: selected.map((i) => i.jobKind),
      start: body.start ?? false,
      schemeId,
      triggeredBy: 'scheme',
    },
  });
  return { jobId, itemCount: selected.length };
}

/**
 * 按台账快速建任务的候选项：对单个资产、四类全选跑清单生成规则；
 * auto 项带就绪判断，manual 项带工具中心入口的建任务路径。
 */
export async function assetQuickItems(assetId: string) {
  const [asset] = await schemeGenerateAssets([assetId]);
  if (!asset) throw notFound('资产不存在');
  const ctx = await schemeGenerateContext();
  const items = generateSchemeItems(
    { categories: DETECT_CATEGORIES, assetIds: [assetId] },
    [asset],
    ctx,
  );
  return {
    auto: items
      .filter((i) => i.mode === 'auto')
      .map((i) => ({
        jobKind: i.jobKind!,
        entryKey: i.entryKey,
        category: i.category,
        title: i.title,
        params: i.params,
        ...itemReadiness(i),
      })),
    manual: items
      .filter((i) => i.mode === 'manual')
      .map((i) => ({
        entryKey: i.entryKey,
        category: i.category,
        title: i.title,
        params: i.params,
        createPath: TOOL_TASK_ENTRIES[i.entryKey].createPath,
      })),
  };
}
