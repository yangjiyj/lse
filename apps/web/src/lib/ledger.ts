import {
  LEDGER_ATTR_FIELDS,
  LEDGER_RELATION_RULES,
  type DetectCategory,
  type DetectJobItemKind,
  type LedgerAssetType,
  type LedgerRelationKind,
  type ToolTaskEntryKey,
} from '@lse/shared';
import type { EndpointHardware } from '../../../../packages/shared/src/endpoint-hardware';
import { request, type Paginated } from '@/lib/api';
import type { DetectJobDetail } from '@/lib/detect-tasks';

// 应用台账（评估中心 → 评估 → 应用台账）的前端类型与请求，与 apps/api/src/modules/ledger/routes.ts 对应。

export const LEDGER_QUERY_KEY = 'ledger';

export type LedgerAttrs = Record<string, string | number>;

export interface LedgerAsset {
  id: string;
  tenantId: string | null;
  type: LedgerAssetType;
  /** 资产名称：列表、标题、方案清单、作业指导书都用它 */
  name: string;
  /** 与 name 相同（保留兼容）；关联的主机名、评估对象名看 endpoint、target */
  displayName: string;
  code: string | null;
  description: string;
  ownerName: string | null;
  ownerDepartment: string | null;
  organizationId: string | null;
  organizationPath: string | null;
  tags: string[];
  attrs: LedgerAttrs;
  fleetEndpointId: string | null;
  modelTargetId: string | null;
  endpoint: {
    id: string;
    hostname: string;
    os: string;
    lastSeenAt: string | null;
    removed: boolean;
  } | null;
  target: { id: string; name: string; model: string; targetType: string } | null;
  relationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerPeer {
  id: string;
  type: LedgerAssetType;
  name: string;
}

export interface LedgerRelationView {
  id: string;
  kind: LedgerRelationKind;
  asset: LedgerPeer;
  createdAt: string;
}

/** 资产详情里的相关任务（子任务关联到该资产的组合任务）；没有 detect_task:read 时接口不返回。 */
export interface LedgerJobItem {
  id: string;
  jobId: string;
  jobName: string;
  jobStatus: string;
  triggeredBy: string;
  kind: string;
  title: string;
  status: string;
  recordKind: string | null;
  recordId: string | null;
  href: string | null;
  createdAt: string;
}

export interface LedgerAssetDetail extends LedgerAsset {
  outgoing: LedgerRelationView[];
  incoming: LedgerRelationView[];
  hardware: EndpointHardware | null;
  jobItems?: LedgerJobItem[];
}

export interface LedgerList extends Paginated<LedgerAsset> {
  counts: Record<LedgerAssetType, number>;
}

export type LedgerListQuery = {
  type?: LedgerAssetType;
  q?: string;
  organizationId?: string;
  includeDescendants?: boolean;
  page?: number;
  pageSize?: number;
};

export interface LedgerAssetInput {
  type: LedgerAssetType;
  name: string;
  code?: string | null;
  description?: string;
  ownerName?: string | null;
  ownerDepartment?: string | null;
  organizationId?: string | null;
  tags?: string[];
  attrs?: LedgerAttrs;
  fleetEndpointId?: string | null;
  modelTargetId?: string | null;
}

export interface QuickAutoItem {
  jobKind: DetectJobItemKind;
  entryKey: ToolTaskEntryKey;
  category: DetectCategory;
  title: string;
  params: Record<string, unknown>;
  ready: boolean | null;
  missing: string[];
}

export interface QuickManualItem {
  entryKey: ToolTaskEntryKey;
  category: DetectCategory;
  title: string;
  params: Record<string, unknown>;
  /** 工具中心入口的建任务路径（白名单） */
  createPath: string;
}

export interface QuickItems {
  auto: QuickAutoItem[];
  manual: QuickManualItem[];
}

export interface ImportResult {
  created: number;
  skipped: number;
}

export interface EndpointOption {
  id: string;
  hostname: string;
}

export interface TargetOption {
  id: string;
  name: string;
  model: string;
  targetType: string;
}

const assetPath = (id: string) => `/ledger/assets/${encodeURIComponent(id)}`;

export const ledgerApi = {
  list: (query: LedgerListQuery) => request<LedgerList>('GET', '/ledger/assets', { query }),
  get: (id: string) => request<LedgerAssetDetail>('GET', assetPath(id)),
  create: (body: LedgerAssetInput) => request<LedgerAsset>('POST', '/ledger/assets', { body }),
  update: (id: string, body: Partial<Omit<LedgerAssetInput, 'type'>>) =>
    request<LedgerAsset>('PATCH', assetPath(id), { body }),
  remove: (id: string) => request<{ ok: true }>('DELETE', assetPath(id)),
  importEndpoints: (body: { endpointIds?: string[] } = {}) =>
    request<ImportResult>('POST', '/ledger/assets/import-endpoints', { body }),
  importTargets: (body: { targetIds?: string[] } = {}) =>
    request<ImportResult>('POST', '/ledger/assets/import-targets', { body }),
  createRelation: (body: { fromId: string; toId: string; kind: LedgerRelationKind }) =>
    request<{ id: string }>('POST', '/ledger/relations', { body }),
  removeRelation: (id: string) =>
    request<{ ok: true }>('DELETE', `/ledger/relations/${encodeURIComponent(id)}`),
  /** 按台账快速建任务的候选项。 */
  quickItems: (id: string) => request<QuickItems>('GET', `${assetPath(id)}/quick-items`),
  quickJob: (
    id: string,
    body: {
      items: Array<{ jobKind: DetectJobItemKind; title: string; params: unknown }>;
      start?: boolean;
    },
  ) => request<DetectJobDetail>('POST', `${assetPath(id)}/quick-job`, { body }),
  /** 关联终端的候选：按主机名等关键字查本租户、没被移除的终端。 */
  endpointOptions: (q?: string) =>
    request<Paginated<EndpointOption>>('GET', '/fleet/endpoints', {
      query: { pageSize: 50, q: q || undefined },
    }),
  /** 关联评估对象的候选：按名称关键字查。 */
  targetOptions: (keyword?: string) =>
    request<Paginated<TargetOption>>('GET', '/model-targets', {
      query: { pageSize: 50, keyword: keyword || undefined },
    }),
};

/** 从某类资产出发、按某种关系能指向的类型（LEDGER_RELATION_RULES）。 */
export function relationTargetTypes(
  from: LedgerAssetType,
  kind: LedgerRelationKind,
): readonly LedgerAssetType[] {
  return LEDGER_RELATION_RULES.find((r) => r.from === from && r.kind === kind)?.to ?? [];
}

/** 某类资产作为起点能建的关系种类。 */
export function relationKindsFrom(from: LedgerAssetType): LedgerRelationKind[] {
  return [...new Set(LEDGER_RELATION_RULES.filter((r) => r.from === from).map((r) => r.kind))];
}

/** 专有字段的显示值：下拉显示中文选项名。 */
export function ledgerAttrText(type: LedgerAssetType, key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const field = LEDGER_ATTR_FIELDS[type].find((f) => f.key === key);
  if (field?.input === 'select') {
    return field.options?.find((o) => o.value === value)?.label ?? String(value);
  }
  return String(value);
}

/** 列表里每类资产显示的关键属性。 */
const KEY_ATTRS: Record<LedgerAssetType, string[]> = {
  platform: ['url', 'deploymentMode'],
  server: ['ip', 'os'],
  endpoint: ['ip', 'user'],
  software: ['vendor', 'version'],
  model: ['modelName', 'version'],
  component: ['componentType', 'version'],
};

export function ledgerKeyAttrs(asset: Pick<LedgerAsset, 'type' | 'attrs'>): string {
  return KEY_ATTRS[asset.type]
    .map((key) => ledgerAttrText(asset.type, key, asset.attrs[key]))
    .filter(Boolean)
    .join(' · ');
}
