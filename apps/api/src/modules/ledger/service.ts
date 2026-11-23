import { Prisma } from '@prisma/client';
import {
  DETECT_RECORD_KINDS,
  LEDGER_ENDPOINT_LINK_TYPES,
  detectRecordHref,
  type DetectRecordKind,
  LEDGER_TARGET_LINK_TYPES,
  ledgerRelationAllowed,
  type LedgerAssetType,
  type LedgerRelationKind,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { endpointHardware } from '../fleet-admin/hardware.js';
import { organizationPaths } from '../organizations/service.js';
import { parseLedgerAttrs, readLedgerAttrs, type LedgerAttrs } from './attrs.js';

// 应用台账（2.8.1）的读写：关联规则、导入终端和评估对象、关系。都在当前租户范围内执行（查询扩展过滤）。

/** 台账名称上限；导入时主机名、评估对象名超长就截断。 */
export const LEDGER_NAME_MAX = 200;

/** 导入评估对象时各 targetType 建成什么类型的台账资产；没列到的（JUDGE、GATEWAY_LOG、ENDPOINT_AGENT）跳过。 */
export const TARGET_IMPORT_TYPES: Readonly<Record<string, LedgerAssetType>> = Object.fromEntries(
  Object.entries(LEDGER_TARGET_LINK_TYPES).flatMap(([type, targetTypes]) =>
    (targetTypes ?? []).map((targetType) => [targetType, type as LedgerAssetType]),
  ),
);

// 关联对象用 include 读出来，不经租户查询扩展。终端、评估对象转移到别的租户后（转移时会解除关联，
// 见 lib/tenant-transfer.ts），这里再按租户核一次：关联对象不属于资产所在租户就当没关联（评估对象可以是平台共享的）。
export const assetInclude = {
  fleetEndpoint: {
    select: {
      id: true,
      tenantId: true,
      hostname: true,
      os: true,
      lastSeenAt: true,
      removedAt: true,
    },
  },
  modelTarget: { select: { id: true, tenantId: true, name: true, model: true, targetType: true } },
  _count: { select: { outgoing: true, incoming: true } },
} satisfies Prisma.LedgerAssetInclude;

/** 其他地方读资产时取显示名和关联用的字段（带租户，供 linkedEndpoint、linkedTarget 核对）。 */
export const LEDGER_LINK_SELECT = {
  tenantId: true,
  fleetEndpointId: true,
  modelTargetId: true,
  fleetEndpoint: { select: { hostname: true, tenantId: true, removedAt: true } },
  modelTarget: { select: { name: true, tenantId: true } },
} satisfies Prisma.LedgerAssetSelect;

export type AssetRow = Prisma.LedgerAssetGetPayload<{ include: typeof assetInclude }>;

type LinkSource = {
  type: string;
  name: string;
  tenantId: string | null;
  fleetEndpoint?: { hostname: string; tenantId: string | null } | null;
  modelTarget?: { name: string; tenantId: string | null } | null;
};

/** 资产关联的终端：终端不在资产所在租户时当没关联。 */
export function linkedEndpoint<E extends { tenantId: string | null }>(asset: {
  tenantId: string | null;
  fleetEndpoint?: E | null;
}): E | null {
  const e = asset.fleetEndpoint;
  return e && e.tenantId === asset.tenantId ? e : null;
}

/** 资产关联的评估对象：本租户的或平台共享的才算。 */
export function linkedTarget<T extends { tenantId: string | null }>(asset: {
  tenantId: string | null;
  modelTarget?: T | null;
}): T | null {
  const t = asset.modelTarget;
  return t && (t.tenantId === null || t.tenantId === asset.tenantId) ? t : null;
}

/**
 * 资产在列表、方案清单、作业指导书里显示的名称：一律用台账里的资产名称。
 * 关联的终端主机名、评估对象名在资产详情和列表的 endpoint、target 字段里单独给。
 */
export function ledgerDisplayName(asset: Pick<LinkSource, 'name'>): string {
  return asset.name;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function serializeAsset(a: AssetRow, paths: Map<string, string>) {
  const endpoint = linkedEndpoint(a);
  const target = linkedTarget(a);
  return {
    id: a.id,
    tenantId: a.tenantId,
    type: a.type,
    name: a.name,
    displayName: ledgerDisplayName(a),
    code: a.code,
    description: a.description,
    ownerName: a.ownerName,
    ownerDepartment: a.ownerDepartment,
    organizationId: a.organizationId,
    organizationPath: a.organizationId ? (paths.get(a.organizationId) ?? null) : null,
    tags: a.tags,
    attrs: readLedgerAttrs(a.attrs),
    fleetEndpointId: endpoint ? a.fleetEndpointId : null,
    modelTargetId: target ? a.modelTargetId : null,
    endpoint: endpoint
      ? {
          id: endpoint.id,
          hostname: endpoint.hostname,
          os: endpoint.os,
          lastSeenAt: iso(endpoint.lastSeenAt),
          removed: Boolean(endpoint.removedAt),
        }
      : null,
    target: target
      ? {
          id: target.id,
          name: target.name,
          model: target.model,
          targetType: target.targetType,
        }
      : null,
    relationCount: a._count.outgoing + a._count.incoming,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function serializeAssets(rows: AssetRow[]) {
  const paths = await organizationPaths(rows.map((row) => row.organizationId));
  return rows.map((row) => serializeAsset(row, paths));
}

const linkInvalid = (message: string) => badRequest(message, 'LEDGER_LINK_INVALID');

/** 关联终端：只有服务器、终端能关联；终端须属本租户（查询扩展过滤）且没被移除。 */
async function assertEndpointLink(type: LedgerAssetType, fleetEndpointId: string | null) {
  if (!fleetEndpointId) return;
  if (!LEDGER_ENDPOINT_LINK_TYPES.includes(type)) throw linkInvalid('只有服务器和终端能关联终端');
  const endpoint = await prisma.fleetEndpoint.findUnique({
    where: { id: fleetEndpointId },
    select: { id: true, removedAt: true },
  });
  if (!endpoint || endpoint.removedAt) throw linkInvalid('终端不存在或已移除');
}

/**
 * 关联评估对象：AI 模型只关联 MODEL；应用平台只关联智能体、平台应用类；其他类型不能关联。
 * 评估对象可以是本租户的或平台共享的（查询扩展读到的就是这两种）。
 */
async function assertTargetLink(type: LedgerAssetType, modelTargetId: string | null) {
  if (!modelTargetId) return;
  const allowed = LEDGER_TARGET_LINK_TYPES[type];
  if (!allowed) throw linkInvalid('只有 AI 模型和应用平台能关联评估对象');
  const target = await prisma.modelTarget.findUnique({
    where: { id: modelTargetId },
    select: { targetType: true },
  });
  if (!target) throw linkInvalid('评估对象不存在');
  if (!allowed.includes(target.targetType)) {
    throw linkInvalid(
      type === 'model'
        ? 'AI 模型只能关联模型类评估对象'
        : '应用平台只能关联智能体或平台应用类评估对象',
    );
  }
}

/** 组织须是本租户的。 */
async function assertOrganization(tenantId: string, organizationId: string | null) {
  if (!organizationId) return;
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, tenantId },
    select: { id: true },
  });
  if (!org) throw badRequest('组织不存在', 'ORG_NOT_FOUND');
}

/** 唯一键撞车翻成具体提示。 */
function rethrowUnique(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = JSON.stringify(err.meta?.target ?? '');
    if (target.includes('code')) throw conflict('资产编号已被使用', 'LEDGER_CODE_TAKEN');
    if (target.includes('fleetEndpointId'))
      throw conflict('该终端已在台账中', 'LEDGER_ENDPOINT_TAKEN');
    if (target.includes('modelTargetId'))
      throw conflict('该评估对象已在台账中', 'LEDGER_TARGET_TAKEN');
    if (target.includes('name')) throw conflict('同类型下已有同名资产', 'LEDGER_NAME_TAKEN');
    throw conflict('资产已存在', 'LEDGER_ASSET_EXISTS');
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
    throw badRequest('关联的对象不存在或已删除', 'LEDGER_LINK_INVALID');
  }
  throw err;
}

export interface LedgerAssetInput {
  type: LedgerAssetType;
  name: string;
  code?: string | null;
  description?: string;
  ownerName?: string | null;
  ownerDepartment?: string | null;
  organizationId?: string | null;
  tags?: string[];
  attrs?: unknown;
  fleetEndpointId?: string | null;
  modelTargetId?: string | null;
}

export async function createLedgerAsset(
  user: { id: string; tenantId: string },
  input: LedgerAssetInput,
): Promise<AssetRow> {
  const attrs = parseLedgerAttrs(input.type, input.attrs);
  const fleetEndpointId = input.fleetEndpointId ?? null;
  const modelTargetId = input.modelTargetId ?? null;
  await assertEndpointLink(input.type, fleetEndpointId);
  await assertTargetLink(input.type, modelTargetId);
  await assertOrganization(user.tenantId, input.organizationId ?? null);
  try {
    return await prisma.ledgerAsset.create({
      data: {
        type: input.type,
        name: input.name,
        code: input.code ?? null,
        description: input.description ?? '',
        ownerName: input.ownerName ?? null,
        ownerDepartment: input.ownerDepartment ?? null,
        organizationId: input.organizationId ?? null,
        tags: input.tags ?? [],
        attrs: attrs as Prisma.InputJsonObject,
        fleetEndpointId,
        modelTargetId,
        createdById: user.id,
      },
      include: assetInclude,
    });
  } catch (err) {
    rethrowUnique(err);
  }
}

export type LedgerAssetPatch = Partial<Omit<LedgerAssetInput, 'type'>>;

/** 改资产：类型不能改；attrs 给了就整体替换；关联按改后的值重新校验。 */
export async function updateLedgerAsset(
  user: { tenantId: string },
  id: string,
  patch: LedgerAssetPatch,
): Promise<{ before: AssetRow; after: AssetRow }> {
  const before = await prisma.ledgerAsset.findUnique({ where: { id }, include: assetInclude });
  if (!before) throw notFound('资产不存在');
  const type = before.type as LedgerAssetType;
  const data: Prisma.LedgerAssetUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.code !== undefined) data.code = patch.code;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.ownerName !== undefined) data.ownerName = patch.ownerName;
  if (patch.ownerDepartment !== undefined) data.ownerDepartment = patch.ownerDepartment;
  if (patch.tags !== undefined) data.tags = patch.tags;
  if (patch.attrs !== undefined) {
    data.attrs = parseLedgerAttrs(type, patch.attrs) as Prisma.InputJsonObject;
  }
  if (patch.organizationId !== undefined) {
    await assertOrganization(user.tenantId, patch.organizationId);
    data.organizationId = patch.organizationId;
  }
  if (patch.fleetEndpointId !== undefined && patch.fleetEndpointId !== before.fleetEndpointId) {
    await assertEndpointLink(type, patch.fleetEndpointId);
    data.fleetEndpointId = patch.fleetEndpointId;
  }
  if (patch.modelTargetId !== undefined && patch.modelTargetId !== before.modelTargetId) {
    await assertTargetLink(type, patch.modelTargetId);
    data.modelTargetId = patch.modelTargetId;
  }
  try {
    const after = await prisma.ledgerAsset.update({ where: { id }, data, include: assetInclude });
    return { before, after };
  } catch (err) {
    rethrowUnique(err);
  }
}

/** 名称去重：已有就加「 (2)」「 (3)」……；taken 会被更新。 */
export function uniqueLedgerName(base: string, taken: Set<string>): string {
  const root = base.trim().slice(0, LEDGER_NAME_MAX - 8) || '未命名';
  let name = root;
  for (let i = 2; taken.has(name); i += 1) name = `${root} (${i})`;
  taken.add(name);
  return name;
}

async function takenNames(type: LedgerAssetType): Promise<Set<string>> {
  const rows = await prisma.ledgerAsset.findMany({ where: { type }, select: { name: true } });
  return new Set(rows.map((row) => row.name));
}

/** 为本租户还没进台账、没被移除的终端建「终端」资产，名称取主机名。可重复执行。 */
export async function importLedgerEndpoints(
  user: { id: string },
  endpointIds?: string[],
): Promise<{ created: number; skipped: number }> {
  const endpoints = await prisma.fleetEndpoint.findMany({
    where: { removedAt: null, ...(endpointIds ? { id: { in: endpointIds } } : {}) },
    orderBy: { registeredAt: 'asc' },
    select: { id: true, hostname: true, ownerName: true, ownerDepartment: true },
  });
  const linked = new Set(
    (
      await prisma.ledgerAsset.findMany({
        where: { fleetEndpointId: { in: endpoints.map((e) => e.id) } },
        select: { fleetEndpointId: true },
      })
    ).map((row) => row.fleetEndpointId),
  );
  const taken = await takenNames('endpoint');
  const rows = endpoints
    .filter((e) => !linked.has(e.id))
    .map((e) => ({
      type: 'endpoint',
      name: uniqueLedgerName(e.hostname, taken),
      ownerName: e.ownerName,
      ownerDepartment: e.ownerDepartment,
      fleetEndpointId: e.id,
      createdById: user.id,
    }));
  // 并发导入时同一终端只会进一次（fleetEndpointId 唯一），撞车的算跳过。
  const { count } = rows.length
    ? await prisma.ledgerAsset.createMany({ data: rows, skipDuplicates: true })
    : { count: 0 };
  const considered = endpointIds ? new Set(endpointIds).size : endpoints.length;
  return { created: count, skipped: Math.max(0, considered - count) };
}

/** 按评估对象类型建「AI 模型」或「应用平台」资产；裁判、网关日志、终端智能体类跳过。可重复执行。 */
export async function importLedgerTargets(
  user: { id: string },
  targetIds?: string[],
): Promise<{ created: number; skipped: number }> {
  const targets = await prisma.modelTarget.findMany({
    where: targetIds ? { id: { in: targetIds } } : {},
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, model: true, targetType: true },
  });
  const importable = targets.filter((t) => TARGET_IMPORT_TYPES[t.targetType]);
  const existing = await prisma.ledgerAsset.findMany({
    where: { modelTargetId: { in: importable.map((t) => t.id) } },
    select: { type: true, modelTargetId: true },
  });
  const linked = new Set(existing.map((row) => `${row.type}:${row.modelTargetId}`));
  const taken = new Map<LedgerAssetType, Set<string>>();
  const rows: Prisma.LedgerAssetCreateManyInput[] = [];
  for (const t of importable) {
    const type = TARGET_IMPORT_TYPES[t.targetType]!;
    if (linked.has(`${type}:${t.id}`)) continue;
    if (!taken.has(type)) taken.set(type, await takenNames(type));
    const attrs: LedgerAttrs =
      type === 'model' && t.model ? { modelName: t.model.slice(0, 200) } : {};
    rows.push({
      type,
      name: uniqueLedgerName(t.name, taken.get(type)!),
      attrs,
      modelTargetId: t.id,
      createdById: user.id,
    });
  }
  const { count } = rows.length
    ? await prisma.ledgerAsset.createMany({ data: rows, skipDuplicates: true })
    : { count: 0 };
  const considered = targetIds ? new Set(targetIds).size : targets.length;
  return { created: count, skipped: Math.max(0, considered - count) };
}

/**
 * 资产详情：关系（带对方名称和类型）、终端硬件、评估对象摘要。
 * withJobs：调用者有 detect_task:read 时才带「相关任务」，没有就不返回这个字段。
 */
export async function ledgerAssetDetail(id: string, opts: { withJobs: boolean }) {
  const asset = await prisma.ledgerAsset.findUnique({ where: { id }, include: assetInclude });
  if (!asset) return null;
  const peer = {
    select: { id: true, type: true, name: true, ...LEDGER_LINK_SELECT },
  } as const;
  const [outgoing, incoming] = await Promise.all([
    prisma.ledgerRelation.findMany({
      where: { fromId: id },
      orderBy: { createdAt: 'asc' },
      include: { to: peer },
    }),
    prisma.ledgerRelation.findMany({
      where: { toId: id },
      orderBy: { createdAt: 'asc' },
      include: { from: peer },
    }),
  ]);
  let hardware = null;
  const endpoint = linkedEndpoint(asset);
  if (endpoint) {
    const report = await prisma.fleetProbeReport.findFirst({
      where: { endpointId: endpoint.id },
      orderBy: { scannedAt: 'desc' },
      select: { body: true },
    });
    hardware = endpointHardware(report?.body);
  }
  // 相关任务：子任务关联到这个资产的组合任务（最近 50 条）。
  const jobItems = opts.withJobs
    ? await prisma.detectJobItem.findMany({
        where: { ledgerAssetId: id },
        orderBy: [{ createdAt: 'desc' }, { position: 'asc' }],
        take: 50,
        include: { job: { select: { id: true, name: true, status: true, triggeredBy: true } } },
      })
    : null;
  const [serialized] = await serializeAssets([asset]);
  const peerView = (p: (typeof outgoing)[number]['to']) => ({
    id: p.id,
    type: p.type,
    name: ledgerDisplayName(p),
  });
  return {
    ...serialized!,
    outgoing: outgoing.map((r) => ({
      id: r.id,
      kind: r.kind,
      asset: peerView(r.to),
      createdAt: r.createdAt.toISOString(),
    })),
    incoming: incoming.map((r) => ({
      id: r.id,
      kind: r.kind,
      asset: peerView(r.from),
      createdAt: r.createdAt.toISOString(),
    })),
    hardware,
    ...(jobItems
      ? {
          jobItems: jobItems.map((i) => ({
            id: i.id,
            jobId: i.jobId,
            jobName: i.job.name,
            jobStatus: i.job.status,
            triggeredBy: i.job.triggeredBy,
            kind: i.kind,
            title: i.title,
            status: i.status,
            recordKind: i.recordKind,
            recordId: i.recordId,
            href:
              i.recordKind && i.recordId && i.recordKind in DETECT_RECORD_KINDS
                ? detectRecordHref(i.recordKind as DetectRecordKind, i.recordId)
                : null,
            createdAt: i.createdAt.toISOString(),
          })),
        }
      : {}),
  };
}

/** 建关系：两端须是本租户的资产，组合须在 LEDGER_RELATION_RULES 里，不能指向自己、不能重复。 */
export async function createLedgerRelation(input: {
  fromId: string;
  toId: string;
  kind: LedgerRelationKind;
}) {
  if (input.fromId === input.toId) {
    throw badRequest('资产不能与自己建关系', 'LEDGER_RELATION_SELF');
  }
  const [from, to] = await Promise.all([
    prisma.ledgerAsset.findUnique({
      where: { id: input.fromId },
      select: { id: true, type: true, name: true },
    }),
    prisma.ledgerAsset.findUnique({
      where: { id: input.toId },
      select: { id: true, type: true, name: true },
    }),
  ]);
  if (!from || !to) throw notFound('资产不存在');
  if (
    !ledgerRelationAllowed(from.type as LedgerAssetType, input.kind, to.type as LedgerAssetType)
  ) {
    throw badRequest('不支持这种关系', 'LEDGER_RELATION_INVALID');
  }
  try {
    const relation = await prisma.ledgerRelation.create({
      data: { fromId: from.id, toId: to.id, kind: input.kind },
    });
    return { relation, from, to };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('关系已存在', 'LEDGER_RELATION_EXISTS');
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      throw notFound('资产不存在');
    }
    throw err;
  }
}
