import { Prisma } from '@prisma/client';
import type {
  EndpointAccelerator,
  EndpointAIComponent,
  EndpointHardware,
} from '../../../../../packages/shared/src/endpoint-hardware.js';
import { prisma } from '../../db.js';
import { tenantCondition } from '../../lib/detect-sql.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { weightedScoresByTask } from '../../lib/weighted-score.js';
import { originOf } from '../asset-discovery/service.js';
import { PERM_READ as FLEET_READ } from '../fleet-admin/config.js';
import { endpointHardware } from '../fleet-admin/hardware.js';
import { FLEET_TARGET_PROVIDER } from '../fleet-admin/service.js';
import { ledgerDisplayName, linkedEndpoint, linkedTarget } from '../ledger/service.js';
import { readLedgerAttrs, type LedgerAttrs } from '../ledger/attrs.js';
import { organizationPaths } from '../organizations/service.js';
import { listRiskResults, type DetectResultRow } from './results.js';
import { RISK_SOURCES, RISK_SOURCE_KEYS, canReadRiskSource } from './sources.js';
import {
  RISK_SEVERITY_KEYS,
  RiskCounter,
  detectRiskStats,
  loadDiscoveryData,
  mergeScopes,
  originLikePatterns,
  scopeApplies,
  type DetectRiskStats,
  type DiscoveryData,
  type RiskScope,
  type RiskWindow,
} from './stats.js';
import { riskSuggestions, type RiskSuggestion } from './suggestions.js';

// 受测应用安全画像（2.5.6）：画像主体是台账里的应用平台，沿关系收集子树，
// 环境、算力、模型从子树取，风险范围由子树关联的评估对象、终端、组件和组合任务子任务决定。
// 都只在平台所属租户里取：全部租户视角下也不串到别的租户（平台共享的评估对象被别的租户用过也一样）。

/** 子树最多这么多个资产（含平台自己），超出截断并标记。 */
export const PROFILE_MAX_ASSETS = 200;
/** 「包含」下级平台最多走几层。 */
const CONTAINS_DEPTH = 3;
const TOP_RISKS = 10;
/** 平台列表一页同时算几个平台的风险数。 */
const LIST_CONCURRENCY = 5;
const ALL_TIME: RiskWindow = { since: null, until: null };

const subtreeSelect = {
  id: true,
  tenantId: true,
  type: true,
  name: true,
  attrs: true,
  modelTargetId: true,
  fleetEndpointId: true,
  // 关联对象带 tenantId：经 linkedEndpoint、linkedTarget 核对租户，不在资产所在租户的当没关联。
  fleetEndpoint: { select: { id: true, hostname: true, lastSeenAt: true, tenantId: true } },
  modelTarget: {
    select: { id: true, name: true, model: true, targetType: true, tenantId: true },
  },
} satisfies Prisma.LedgerAssetSelect;

const rootSelect = {
  ...subtreeSelect,
  code: true,
  description: true,
  ownerName: true,
  ownerDepartment: true,
  organizationId: true,
} satisfies Prisma.LedgerAssetSelect;

type SubtreeAsset = Prisma.LedgerAssetGetPayload<{ select: typeof subtreeSelect }>;
type RootAsset = Prisma.LedgerAssetGetPayload<{ select: typeof rootSelect }>;

export interface ProfileSubtree {
  assets: SubtreeAsset[];
  truncated: boolean;
}

interface Walk {
  order: string[];
  seen: Set<string>;
  truncated: boolean;
}

function addTo(walk: Walk, id: string): boolean {
  if (walk.seen.has(id)) return false;
  if (walk.order.length >= PROFILE_MAX_ASSETS) {
    walk.truncated = true;
    return false;
  }
  walk.seen.add(id);
  walk.order.push(id);
  return true;
}

/**
 * 从平台出发收集子树（一次可以算多个平台，画像列表一页共用这几条查询）：
 * - 「包含」的下级平台（最多 3 层）；
 * - 这些平台「使用」的模型、组件、软件和「部署于」的服务器；
 * - 模型「使用」的组件；
 * - 以上模型、组件、软件「部署于」的服务器、终端。
 * 去重，每个平台最多 PROFILE_MAX_ASSETS 个（含平台自己）。
 */
export async function profileSubtrees(rootIds: string[]): Promise<Map<string, ProfileSubtree>> {
  const walks = new Map<string, Walk>(
    rootIds.map((id) => [id, { order: [id], seen: new Set([id]), truncated: false }]),
  );
  const relations = (fromIds: Iterable<string>, kinds: string[]) => {
    const ids = [...new Set(fromIds)];
    return ids.length
      ? prisma.ledgerRelation.findMany({
          where: { fromId: { in: ids }, kind: { in: kinds } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { fromId: true, toId: true, kind: true },
        })
      : Promise.resolve([]);
  };
  /** 一跳：每个平台各自从自己的起点出发，把指到的资产加进自己的子树，返回新加的（按关系种类筛）。 */
  const hop = async (
    from: Map<string, string[]>,
    kinds: string[],
  ): Promise<Map<string, Array<{ toId: string; kind: string; added: boolean }>>> => {
    const rels = await relations([...from.values()].flat(), kinds);
    const out = new Map<string, Array<{ toId: string; kind: string; added: boolean }>>();
    for (const [root, starts] of from) {
      const walk = walks.get(root)!;
      const set = new Set(starts);
      out.set(
        root,
        rels
          .filter((r) => set.has(r.fromId))
          .map((r) => ({ toId: r.toId, kind: r.kind, added: addTo(walk, r.toId) })),
      );
    }
    return out;
  };
  const kept = (root: string, ids: string[]) =>
    [...new Set(ids)].filter((id) => walks.get(root)!.seen.has(id));

  const platforms = new Map(rootIds.map((id) => [id, [id]]));
  let frontier = new Map(rootIds.map((id) => [id, [id]]));
  for (
    let depth = 0;
    depth < CONTAINS_DEPTH && [...frontier.values()].some((f) => f.length);
    depth += 1
  ) {
    const found = await hop(frontier, ['contains']);
    frontier = new Map(
      [...found].map(([root, rels]) => [root, rels.filter((r) => r.added).map((r) => r.toId)]),
    );
    for (const [root, added] of frontier) platforms.get(root)!.push(...added);
  }
  const direct = await hop(platforms, ['uses', 'deployed_on']);
  // 平台使用的模型、组件、软件：再走一跳「部署于」，模型另走「使用」的组件。
  const used = new Map(
    [...direct].map(([root, rels]) => [
      root,
      kept(
        root,
        rels.filter((r) => r.kind === 'uses').map((r) => r.toId),
      ),
    ]),
  );
  const second = await hop(used, ['deployed_on', 'uses']);
  const usedByModels = new Map(
    [...second].map(([root, rels]) => {
      const before = new Set(used.get(root));
      const ids = kept(
        root,
        rels.filter((r) => r.kind === 'uses').map((r) => r.toId),
      );
      return [root, ids.filter((id) => !before.has(id))];
    }),
  );
  await hop(usedByModels, ['deployed_on']);

  const allIds = [...new Set([...walks.values()].flatMap((w) => w.order))];
  const rows = await prisma.ledgerAsset.findMany({
    where: { id: { in: allIds } },
    select: subtreeSelect,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Map(
    rootIds.map((root) => {
      const walk = walks.get(root)!;
      return [
        root,
        {
          assets: walk.order.map((id) => byId.get(id)).filter((r): r is SubtreeAsset => !!r),
          truncated: walk.truncated,
        },
      ];
    }),
  );
}

export async function profileSubtree(rootId: string): Promise<ProfileSubtree> {
  return (await profileSubtrees([rootId])).get(rootId)!;
}

const attrText = (attrs: LedgerAttrs, key: string): string | null => {
  const v = attrs[key];
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
};
const isMachine = (a: SubtreeAsset) => a.type === 'server' || a.type === 'endpoint';
/** 资产关联的终端、评估对象 id（租户不一致的当没关联）。 */
const endpointIdOf = (a: SubtreeAsset) => linkedEndpoint(a)?.id ?? null;
const targetIdOf = (a: SubtreeAsset) => linkedTarget(a)?.id ?? null;
const attrNumber = (attrs: LedgerAttrs, key: string): number | null => {
  const v = attrs[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 单项最多算几张卡（与探针上报的上限一致）。 */
const MAX_LEDGER_CARDS = 64;
/** 从型号文字推厂商（ACCELERATOR_VENDOR_LABELS 的键），认不出的记 other。 */
const GPU_VENDOR_PATTERNS: Array<[RegExp, string]> = [
  [/nvidia|geforce|quadro|tesla|rtx|gtx|\b(?:a|h|l|v|t|b)\d{1,4}\b/i, 'nvidia'],
  [/昇腾|ascend|huawei|华为/i, 'huawei'],
  [/\bamd\b|instinct|radeon|\bmi\d{2,3}/i, 'amd'],
  [/海光|hygon|\bdcu\b/i, 'hygon'],
  [/寒武纪|cambricon|\bmlu/i, 'cambricon'],
  [/燧原|enflame/i, 'enflame'],
  [/昆仑|kunlun/i, 'kunlunxin'],
  [/沐曦|metax/i, 'metax'],
  [/天数|iluvatar/i, 'iluvatar'],
  [/摩尔线程|moore ?threads|\bmtt\b/i, 'moorethreads'],
  [/gaudi|habana/i, 'habana'],
  [/\bintel\b|arc\b/i, 'intel'],
];

/**
 * 台账里服务器「GPU」一栏的文字解析成算力卡（没有探针数据时兜底）：
 * 多种卡用「；，、+」分开；数量写「× 8」「8x」「8 张/块/卡/片」，没写算 1 张；单卡显存取「80GB」「80G」。
 */
export function parseLedgerGpu(text: string): EndpointAccelerator[] {
  const cards: EndpointAccelerator[] = [];
  for (const raw of text.split(/[;；,，、+]/)) {
    let item = raw.trim();
    if (!item) continue;
    let count = 1;
    const patterns = [
      // 「× 8」「x8」：x 前面不能是字母（RTX 4090 不是 4090 张）
      /(?:×|\*|(?<![A-Za-z])[xX])\s*(\d{1,4})\s*$/,
      /^(\d{1,4})\s*[×xX*]\s*/,
      /(\d{1,4})\s*(?:张|块|卡|片)\s*$/,
    ];
    for (const re of patterns) {
      const m = re.exec(item);
      if (!m) continue;
      count = Number(m[1]);
      item = item.replace(re, ' ').trim();
      break;
    }
    if (!item || count < 1) continue;
    const mem = /(\d{1,4}(?:\.\d+)?)\s*G(?:B|iB)?\b/i.exec(item);
    const vendor = GPU_VENDOR_PATTERNS.find(([re]) => re.test(item))?.[1] ?? 'other';
    const card: EndpointAccelerator = {
      vendor,
      model: item,
      source: 'ledger',
      ...(mem ? { memoryMB: Math.round(Number(mem[1]) * 1024) } : {}),
    };
    for (let i = 0; i < Math.min(count, MAX_LEDGER_CARDS); i += 1) cards.push({ ...card });
  }
  return cards;
}

/** 算力卡按型号汇总成一段文字，如「NVIDIA A100 80GB × 2」。 */
function gpuSummary(cards: EndpointAccelerator[]): string | null {
  const byModel = new Map<string, number>();
  for (const c of cards) byModel.set(c.model, (byModel.get(c.model) ?? 0) + 1);
  return byModel.size
    ? [...byModel].map(([model, n]) => (n > 1 ? `${model} × ${n}` : model)).join('、')
    : null;
}

/** 各类检测记录在风险范围里归到哪个字段（组合任务子任务按 recordKind 并入）。 */
const RECORD_SCOPE_FIELD: Record<string, keyof RiskScope> = {
  eval_task: 'evalTaskIds',
  standard_run: 'evalTaskIds',
  rag_eval: 'evalTaskIds',
  fleet_eval_job: 'evalTaskIds',
  model_file_scan: 'modelFileScanIds',
  corpus_scan: 'corpusScanIds',
  asset_discovery: 'assetDiscoveryRunIds',
  service_assurance: 'serviceAssuranceRunIds',
};

/**
 * 子树的风险范围（一次可以算多个平台，画像列表一页共用这几条查询）：
 * 平台和模型关联的评估对象、服务器和终端关联终端对应的终端评估对象、组件资产键、
 * 服务器和终端的 IP、平台访问地址的 origin（及按它匹配的服务核验），以及关联到子树资产的组合任务子任务。
 * tenantId 为平台所属租户：全部租户视角下也只在这个租户里找。
 */
export async function profileRiskScopes(
  items: Array<{ assets: SubtreeAsset[]; tenantId: string | null }>,
): Promise<RiskScope[]> {
  const tenantIds = [...new Set(items.map((i) => i.tenantId))];
  const tenant: { tenantId?: { in: string[] } } = tenantIds.every((t): t is string => Boolean(t))
    ? { tenantId: { in: tenantIds } }
    : {};
  const parts = items.map(({ assets, tenantId }) => ({
    tenantId,
    assets,
    assetIds: new Set(assets.map((a) => a.id)),
    endpointIds: new Set(
      assets
        .filter(isMachine)
        .map(endpointIdOf)
        .filter((id): id is string => Boolean(id)),
    ),
    origins: [
      ...new Set(
        assets
          .filter((a) => a.type === 'platform')
          .map((a) => attrText(readLedgerAttrs(a.attrs), 'url'))
          .map((url) => (url ? originOf(url) : null))
          .filter((o): o is string => Boolean(o)),
      ),
    ],
  }));
  const endpointIds = [...new Set(parts.flatMap((p) => [...p.endpointIds]))];
  const origins = [...new Set(parts.flatMap((p) => p.origins))];
  const assetIds = [...new Set(parts.flatMap((p) => [...p.assetIds]))];
  const [fleetTargets, runs, jobItems] = await Promise.all([
    endpointIds.length
      ? prisma.modelTarget.findMany({
          where: {
            ...tenant,
            provider: FLEET_TARGET_PROVIDER,
            OR: endpointIds.map((id) => ({
              accessConfig: { path: ['fleetEndpointId'], equals: id },
            })),
          },
          select: { id: true, tenantId: true, accessConfig: true },
        })
      : Promise.resolve([]),
    // 服务核验在库里按 origin 前缀预筛（原始 SQL，带租户条件），再按 origin 精确比对。
    origins.length
      ? prisma.$queryRaw<
          Array<{
            id: string;
            tenantId: string | null;
            normalizedTarget: string | null;
            targetName: string;
          }>
        >(Prisma.sql`SELECT r."id", r."tenantId", r."normalizedTarget", r."targetName"
          FROM "service_assurance_runs" r
          WHERE lower(coalesce(r."normalizedTarget", r."targetName"))
              LIKE ANY(${originLikePatterns(origins)}::text[])
            ${tenantCondition('r."tenantId"')}
            ${tenant.tenantId ? Prisma.sql`AND r."tenantId" = ANY(${tenant.tenantId.in}::text[])` : Prisma.empty}`)
      : Promise.resolve([]),
    assetIds.length
      ? prisma.detectJobItem.findMany({
          where: { ...tenant, ledgerAssetId: { in: assetIds }, recordId: { not: null } },
          select: { tenantId: true, ledgerAssetId: true, recordKind: true, recordId: true },
        })
      : Promise.resolve([]),
  ]);
  return parts.map((part) => {
    const sameTenant = (t: string | null) => !part.tenantId || t === part.tenantId;
    const modelTargetIds = new Set(
      part.assets
        .filter((a) => a.type === 'platform' || a.type === 'model')
        .map(targetIdOf)
        .filter((id): id is string => Boolean(id)),
    );
    for (const t of fleetTargets) {
      const endpointId = (t.accessConfig as Record<string, unknown> | null)?.fleetEndpointId;
      if (
        sameTenant(t.tenantId) &&
        typeof endpointId === 'string' &&
        part.endpointIds.has(endpointId)
      ) {
        modelTargetIds.add(t.id);
      }
    }
    const originSet = new Set(part.origins);
    const scope: RiskScope = {
      modelTargetIds: [...modelTargetIds],
      aiComponentAssetKeys: [
        ...new Set(
          part.assets
            .filter((a) => a.type === 'component')
            .map((a) => attrText(readLedgerAttrs(a.attrs), 'assetKey'))
            .filter((k): k is string => Boolean(k)),
        ),
      ],
      hosts: [
        ...new Set(
          part.assets
            .filter(isMachine)
            .map((a) => attrText(readLedgerAttrs(a.attrs), 'ip'))
            .filter((ip): ip is string => Boolean(ip)),
        ),
      ],
      origins: part.origins,
      serviceAssuranceRunIds: runs
        .filter((r) => {
          const origin = originOf(r.normalizedTarget ?? r.targetName);
          return sameTenant(r.tenantId) && origin !== null && originSet.has(origin);
        })
        .map((r) => r.id),
    };
    for (const item of jobItems) {
      if (!item.ledgerAssetId || !part.assetIds.has(item.ledgerAssetId)) continue;
      if (!sameTenant(item.tenantId)) continue;
      const field = item.recordKind ? RECORD_SCOPE_FIELD[item.recordKind] : undefined;
      if (!field || !item.recordId) continue;
      const list = (scope[field] ??= []);
      if (!list.includes(item.recordId)) list.push(item.recordId);
    }
    return scope;
  });
}

export async function profileRiskScope(
  assets: SubtreeAsset[],
  tenantId: string | null,
): Promise<RiskScope> {
  return (await profileRiskScopes([{ assets, tenantId }]))[0]!;
}

/** 找画像主体：不存在（含其他租户的）404，不是应用平台 400。 */
async function findPlatform(assetId: string): Promise<RootAsset> {
  const root = await prisma.ledgerAsset.findUnique({ where: { id: assetId }, select: rootSelect });
  if (!root) throw notFound('应用平台不存在');
  if (root.type !== 'platform') throw badRequest('只有应用平台有画像', 'PROFILE_PLATFORM_ONLY');
  return root;
}

export interface ProfileRange {
  platform: { id: string; name: string; tenantId: string | null };
  assets: SubtreeAsset[];
  truncated: boolean;
  scope: RiskScope;
}

async function rangeOf(root: RootAsset): Promise<ProfileRange> {
  const { assets, truncated } = await profileSubtree(root.id);
  return {
    platform: { id: root.id, name: root.name, tenantId: root.tenantId },
    assets,
    truncated,
    scope: await profileRiskScope(assets, root.tenantId),
  };
}

/**
 * 按画像范围看风险（画像详情、检测结果 ?profile= 共用）：子树、风险范围和平台所属租户。
 * 调用方负责 ledger:read；不存在 404，不是应用平台 400。
 */
export async function profileRange(assetId: string): Promise<ProfileRange> {
  return rangeOf(await findPlatform(assetId));
}

export interface AppProfile {
  asset: {
    id: string;
    tenantId: string | null;
    name: string;
    code: string | null;
    description: string;
    ownerName: string | null;
    ownerDepartment: string | null;
    organizationPath: string | null;
    attrs: Record<string, unknown>;
    modelTarget: { id: string; name: string; model: string; targetType: string } | null;
  };
  environment: {
    servers: Array<{
      assetId: string;
      name: string;
      type: 'server' | 'endpoint';
      ip: string | null;
      /** 规格：终端探针上报的优先，探针没有的项用台账里填的兜底 */
      os: string | null;
      cpu: string | null;
      memoryMB: number | null;
      gpu: string | null;
      endpoint: { id: string; hostname: string; lastSeenAt: string | null } | null;
      /** 没有终端管理的读权限时为 null */
      hardware: EndpointHardware | null;
    }>;
    software: Array<{
      assetId: string;
      name: string;
      vendor: string | null;
      version: string | null;
    }>;
    components: Array<{
      assetId: string;
      name: string;
      componentType: string | null;
      version: string | null;
    }>;
    /** 探针在部署服务器上识别出的训练推理框架（hardware.aiComponents 合并去重） */
    frameworks: EndpointAIComponent[];
  };
  compute: {
    /** 每台服务器：探针上报了算力卡就用探针的，没有探针数据时按台账「GPU」一栏解析 */
    accelerators: Array<EndpointAccelerator & { serverName: string }>;
    cardCount: number;
    /** 任一卡缺显存、或没有卡时为 null */
    totalMemoryMB: number | null;
  };
  models: Array<{
    assetId: string;
    name: string;
    modelTarget: { id: string; name: string; model: string } | null;
    /** 没有模型文件扫描的读权限时为 null */
    identity: {
      verdictLabel: string;
      name: string | null;
      quantization: string | null;
      baseModel: string | null;
      knownModel: string | null;
    } | null;
    /** 没有 eval_task:read 时为 null */
    lastEval: { taskId: string; finishedAt: string | null; score: number | null } | null;
    /** 基座模型：模型文件扫描识别出的优先，没有时用台账里填的 */
    baseModel: string | null;
  }>;
  risks: { stats: DetectRiskStats; top: DetectResultRow[] };
  suggestions: RiskSuggestion[];
  truncated: boolean;
}

type Identity = AppProfile['models'][number]['identity'];
type LastEval = AppProfile['models'][number]['lastEval'];

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function identityOf(files: unknown): Identity {
  for (const file of Array.isArray(files) ? files : []) {
    const meta = rec(rec(file).meta);
    const id = rec(meta.identification);
    const verdictLabel = str(id.verdictLabel);
    if (!verdictLabel) continue;
    return {
      verdictLabel,
      name: str(id.name),
      quantization: str(id.quantization),
      baseModel: str(id.baseModel),
      knownModel: str(meta.knownModelLabel) ?? str(rec(meta.knownModel).repo),
    };
  }
  return null;
}

/**
 * 模型的识别结论和最近评估，按评估对象批量取，只取平台所属租户的记录：
 * 识别结论取最近一次完成的模型文件扫描里第一个带识别结论的文件（要模型文件扫描的读权限），
 * 最近评估取最近一次完成的评估任务，得分与任务列表同口径（要 eval_task:read）。
 */
async function modelDetails(
  targetIds: string[],
  tenantId: string | null,
  can: (code: string) => boolean,
): Promise<{ identities: Map<string, Identity>; evals: Map<string, LastEval> }> {
  const identities = new Map<string, Identity>();
  const evals = new Map<string, LastEval>();
  if (targetIds.length === 0) return { identities, evals };
  const tenant = tenantId ? { tenantId } : {};
  const canIdentity = RISK_SOURCES.model_file.permissions.some((code) => can(code));
  const canEval = can('eval_task:read');
  await Promise.all([
    (async () => {
      if (!canIdentity) return;
      // 先取每个对象最近一次扫描的 id（不带文件清单），再只读这几次扫描的文件清单。
      const latest = await prisma.modelFileScan.findMany({
        where: { ...tenant, targetId: { in: targetIds }, status: 'COMPLETED' },
        orderBy: [{ targetId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        distinct: ['targetId'],
        select: { id: true },
      });
      if (latest.length === 0) return;
      const scans = await prisma.modelFileScan.findMany({
        where: { id: { in: latest.map((s) => s.id) } },
        select: { targetId: true, files: true },
      });
      for (const s of scans) if (s.targetId) identities.set(s.targetId, identityOf(s.files));
    })(),
    (async () => {
      if (!canEval) return;
      const tasks = await prisma.evalTask.findMany({
        where: { ...tenant, modelTargetId: { in: targetIds }, status: 'COMPLETED' },
        orderBy: [
          { modelTargetId: 'asc' },
          { finishedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        distinct: ['modelTargetId'],
        select: { id: true, modelTargetId: true, finishedAt: true },
      });
      const scores = await weightedScoresByTask(tasks.map((t) => t.id));
      for (const t of tasks) {
        evals.set(t.modelTargetId, {
          taskId: t.id,
          finishedAt: t.finishedAt?.toISOString() ?? null,
          score: scores.get(t.id) ?? null,
        });
      }
    })(),
  ]);
  return { identities, evals };
}

/** 各可见来源合起来按严重度取前 10 条。 */
async function topRisks(
  can: (code: string) => boolean,
  counter: RiskCounter,
): Promise<DetectResultRow[]> {
  const sources = RISK_SOURCE_KEYS.filter(
    (s) => canReadRiskSource(s, can) && scopeApplies(s, counter.scope),
  );
  const pages = await Promise.all(
    sources.map((s) => listRiskResults(s, { page: 1, pageSize: TOP_RISKS }, counter)),
  );
  const rank = (s: string) => RISK_SEVERITY_KEYS.indexOf(s as (typeof RISK_SEVERITY_KEYS)[number]);
  return pages
    .flatMap((p) => p.items)
    .sort(
      (a, b) =>
        rank(a.severity) - rank(b.severity) || b.createdAt.getTime() - a.createdAt.getTime(),
    )
    .slice(0, TOP_RISKS);
}

/**
 * 画像（2.5.6）。不存在（含其他租户的）404，不是应用平台 400。
 * 风险按来源权限过滤；识别结论、最近评估、终端硬件按各自模块的读权限过滤，没权限为 null。
 */
export async function appProfile(
  assetId: string,
  can: (code: string) => boolean,
): Promise<AppProfile> {
  const root = await findPlatform(assetId);
  const { assets, truncated, scope } = await rangeOf(root);
  const tenantId = root.tenantId ?? undefined;
  const counter = new RiskCounter(ALL_TIME, scope, tenantId);
  const rootTarget = linkedTarget(root);

  const machines = assets.filter(isMachine);
  const endpointIds = machines.map(endpointIdOf).filter((id): id is string => !!id);
  const reports =
    endpointIds.length && can(FLEET_READ)
      ? await prisma.fleetProbeReport.findMany({
          where: { endpointId: { in: endpointIds } },
          orderBy: [{ endpointId: 'asc' }, { scannedAt: 'desc' }],
          distinct: ['endpointId'],
          select: { endpointId: true, body: true },
        })
      : [];
  const hardwareByEndpoint = new Map(reports.map((r) => [r.endpointId, endpointHardware(r.body)]));

  const serverCards: EndpointAccelerator[][] = [];
  const servers = machines.map((m) => {
    const attrs = readLedgerAttrs(m.attrs);
    const linked = linkedEndpoint(m);
    const h = (linked && hardwareByEndpoint.get(linked.id)) || null;
    // 探针报了算力卡（哪怕是空列表）就以探针为准；没有探针数据时按台账「GPU」一栏解析。
    serverCards.push(h?.accelerators ?? parseLedgerGpu(attrText(attrs, 'gpu') ?? ''));
    const probeOs = h ? [h.platform ?? h.os, h.platformVersion].filter(Boolean).join(' ') : '';
    const ledgerMemory = attrNumber(attrs, 'memoryGB');
    return {
      assetId: m.id,
      name: ledgerDisplayName(m),
      type: m.type as 'server' | 'endpoint',
      ip: attrText(attrs, 'ip'),
      os: probeOs || attrText(attrs, 'os'),
      cpu: h?.cpuModel
        ? `${h.cpuModel}${h.cpuCores ? ` · ${h.cpuCores} 核` : ''}`
        : attrText(attrs, 'cpu'),
      memoryMB: h?.memoryTotalMB ?? (ledgerMemory ? Math.round(ledgerMemory * 1024) : null),
      gpu: h?.accelerators ? gpuSummary(h.accelerators) : attrText(attrs, 'gpu'),
      endpoint: linked
        ? {
            id: linked.id,
            hostname: linked.hostname,
            lastSeenAt: linked.lastSeenAt?.toISOString() ?? null,
          }
        : null,
      hardware: h,
    };
  });
  const frameworks = new Map<string, EndpointAIComponent>();
  for (const s of servers) {
    for (const c of s.hardware?.aiComponents ?? []) {
      const key = `${c.id}|${c.version ?? ''}`;
      if (!frameworks.has(key)) frameworks.set(key, c);
    }
  }
  const accelerators = servers.flatMap((s, i) =>
    serverCards[i]!.map((card) => ({ ...card, serverName: s.name })),
  );
  const totalMemoryMB =
    accelerators.length > 0 && accelerators.every((c) => typeof c.memoryMB === 'number')
      ? accelerators.reduce((sum, c) => sum + c.memoryMB!, 0)
      : null;

  const modelAssets = assets.filter((a) => a.type === 'model');
  const targetIds = [...new Set(modelAssets.map(targetIdOf).filter((id): id is string => !!id))];
  const [details, stats, top, suggestions, paths] = await Promise.all([
    modelDetails(targetIds, root.tenantId, can),
    detectRiskStats(can, counter),
    topRisks(can, counter),
    riskSuggestions(can, counter),
    organizationPaths([root.organizationId]),
  ]);

  return {
    asset: {
      id: root.id,
      tenantId: root.tenantId,
      name: root.name,
      code: root.code,
      description: root.description,
      ownerName: root.ownerName,
      ownerDepartment: root.ownerDepartment,
      organizationPath: root.organizationId ? (paths.get(root.organizationId) ?? null) : null,
      attrs: readLedgerAttrs(root.attrs),
      modelTarget: rootTarget
        ? {
            id: rootTarget.id,
            name: rootTarget.name,
            model: rootTarget.model,
            targetType: rootTarget.targetType,
          }
        : null,
    },
    environment: {
      servers,
      software: assets
        .filter((a) => a.type === 'software')
        .map((a) => {
          const attrs = readLedgerAttrs(a.attrs);
          return {
            assetId: a.id,
            name: a.name,
            vendor: attrText(attrs, 'vendor'),
            version: attrText(attrs, 'version'),
          };
        }),
      components: assets
        .filter((a) => a.type === 'component')
        .map((a) => {
          const attrs = readLedgerAttrs(a.attrs);
          return {
            assetId: a.id,
            name: a.name,
            componentType: attrText(attrs, 'componentType'),
            version: attrText(attrs, 'version'),
          };
        }),
      frameworks: [...frameworks.values()],
    },
    compute: { accelerators, cardCount: accelerators.length, totalMemoryMB },
    models: modelAssets.map((m) => {
      const target = linkedTarget(m);
      const identity = (target && details.identities.get(target.id)) || null;
      return {
        assetId: m.id,
        name: ledgerDisplayName(m),
        modelTarget: target ? { id: target.id, name: target.name, model: target.model } : null,
        identity,
        baseModel: identity?.baseModel || attrText(readLedgerAttrs(m.attrs), 'baseModel'),
        lastEval: (target && details.evals.get(target.id)) || null,
      };
    }),
    risks: { stats, top },
    suggestions,
    truncated,
  };
}

export interface AppProfileListItem {
  id: string;
  tenantId: string | null;
  name: string;
  code: string | null;
  ownerName: string | null;
  organizationPath: string | null;
  /** 关联资产数（不含平台自己） */
  assetCount: number;
  truncated: boolean;
  /** 看不到任何风险来源时为 null */
  riskTotal: number | null;
  riskHigh: number | null;
}

/** 按 limit 个一批并发处理，结果顺序与输入一致。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * 平台列表一页的风险数：与画像的风险统计同一范围，全部时间。
 * 资产测绘和已登记的评估对象按租户只读一次（按这一页各平台范围的并集在库里预筛），各行在内存里按自己的范围比对；
 * 其余来源范围里没有能用的字段时不查库。
 */
export async function profileListItems(
  rows: Array<{
    id: string;
    tenantId: string | null;
    name: string;
    code: string | null;
    ownerName: string | null;
    organizationId: string | null;
  }>,
  can: (code: string) => boolean,
): Promise<AppProfileListItem[]> {
  const canSee = RISK_SOURCE_KEYS.some((s) => canReadRiskSource(s, can));
  // 子树和风险范围整页一起算（几条查询），每行只剩自己的计数。
  const [paths, subtrees] = await Promise.all([
    organizationPaths(rows.map((r) => r.organizationId)),
    profileSubtrees(rows.map((r) => r.id)),
  ]);
  const trees = rows.map((r) => subtrees.get(r.id)!);
  const scopes = canSee
    ? await profileRiskScopes(
        rows.map((r, i) => ({ assets: trees[i]!.assets, tenantId: r.tenantId })),
      )
    : null;
  const ranges = trees.map((t, i) => ({ ...t, scope: scopes ? scopes[i]! : null }));
  const discovery = new Map<string, Promise<DiscoveryData>>();
  if (canSee && canReadRiskSource('asset_discovery', can)) {
    const byTenant = new Map<string, RiskScope[]>();
    rows.forEach((row, i) => {
      const key = row.tenantId ?? '';
      byTenant.set(key, [...(byTenant.get(key) ?? []), ranges[i]!.scope!]);
    });
    for (const [key, scopes] of byTenant) {
      discovery.set(key, loadDiscoveryData(ALL_TIME, mergeScopes(scopes), key || undefined));
    }
  }
  const stats = await mapLimit(rows, LIST_CONCURRENCY, async (row) => {
    const scope = ranges[rows.indexOf(row)]!.scope;
    if (!scope) return null;
    const counter = new RiskCounter(ALL_TIME, scope, row.tenantId ?? undefined, {
      discovery: discovery.get(row.tenantId ?? ''),
    });
    return detectRiskStats(can, counter);
  });
  return rows.map((row, i) => ({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    code: row.code,
    ownerName: row.ownerName,
    organizationPath: row.organizationId ? (paths.get(row.organizationId) ?? null) : null,
    assetCount: ranges[i]!.assets.length - 1,
    truncated: ranges[i]!.truncated,
    riskTotal: stats[i] ? stats[i].categories.reduce((sum, c) => sum + c.total, 0) : null,
    riskHigh: stats[i] ? stats[i].categories.reduce((sum, c) => sum + c.high, 0) : null,
  }));
}
