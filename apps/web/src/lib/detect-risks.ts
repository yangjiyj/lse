import type { DetectCategory, DetectRecordKind } from '@lse/shared';
import type {
  EndpointAccelerator,
  EndpointAIComponent,
  EndpointHardware,
} from '../../../../packages/shared/src/endpoint-hardware';
import { request } from '@/lib/api';

// 四类风险（2.2.2、2.5.3）的前端类型与常量；口径在 API 的 detect-risks 模块，见 docs/detect-risk-categories.md。

export type RiskSourceKey =
  | 'model_file'
  | 'corpus'
  | 'eval_content'
  | 'eval_app'
  | 'service_assurance'
  | 'ai_component'
  | 'asset_discovery';

export type RiskSeverityKey = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' | 'UNRATED';

export interface RiskCount {
  total: number;
  /** 严重 + 高危 */
  high: number;
  bySeverity: Record<RiskSeverityKey, number>;
}

export interface DetectRiskCategoryStat {
  category: DetectCategory;
  label: string;
  total: number;
  high: number;
  /** 没权限的来源 count 为 null */
  sources: Array<{ source: RiskSourceKey; label: string; count: RiskCount | null }>;
}

export interface DashboardDetectRisks {
  period: 'month' | '7d' | 'all';
  periodStart: string | null;
  categories: DetectRiskCategoryStat[];
  /** 命中超过 50,000 条、只保存了一部分的语料扫描数 */
  truncatedCorpusScans: number;
  /** 已完成的资产测绘超过 500 次，只看了最近 500 次 */
  discoveryRunsTruncated: boolean;
}

/** 看任一来源要的权限（与 API detect-risks/sources.ts 的 RISK_SOURCE_PERMISSIONS 一致）。 */
export const DETECT_RISK_PERMISSIONS = [
  'engine:scan',
  'remediation:read',
  'corpus_scan:read',
  'eval_task:read',
  'service_assurance:read',
  'platform_setting:read',
] as const;

export function canReadDetectRisks(has: (code: string) => boolean): boolean {
  return DETECT_RISK_PERMISSIONS.some((code) => has(code));
}

/** 计数不全时的提示（首页卡片和检测结果页共用）。 */
export const corpusTruncatedHint = (scans: number) =>
  `${scans.toLocaleString('zh-CN')} 次扫描命中过多，只计已保存的部分`;
export const DISCOVERY_TRUNCATED_HINT = '资产测绘超过 500 次，只计最近 500 次';

export const RISK_SEVERITY_LABELS: Record<RiskSeverityKey, string> = {
  CRITICAL: '严重',
  HIGH: '高危',
  MEDIUM: '中危',
  LOW: '低危',
  INFO: '提示',
  UNRATED: '未定级',
};

/** 严重度筛选项：value 原样作为接口的 severity 参数（逗号分隔）。 */
export const RISK_SEVERITY_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部严重度' },
  { value: 'CRITICAL,HIGH', label: '高危及以上' },
  ...(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNRATED'] as const).map((value) => ({
    value,
    label: RISK_SEVERITY_LABELS[value],
  })),
];

export interface DetectResultRow {
  source: RiskSourceKey;
  id: string;
  tenantId: string | null;
  title: string;
  severity: RiskSeverityKey;
  subject: string | null;
  recordKind: DetectRecordKind;
  recordId: string;
  recordName: string | null;
  href: string;
  createdAt: string;
}

/** 检测结果按画像范围看时的平台（?profile=） */
export interface DetectResultsProfile {
  id: string;
  name: string;
}

export interface DetectResultsPage {
  category: DetectCategory;
  profile: DetectResultsProfile | null;
  /** 实际查的来源（地址没带时为该类第一个有权限的来源） */
  source: RiskSourceKey;
  sources: Array<{ source: RiskSourceKey; label: string; total: number }>;
  items: DetectResultRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DetectRiskStatsBody {
  categories: DetectRiskCategoryStat[];
  truncatedCorpusScans: number;
  discoveryRunsTruncated: boolean;
}

export interface DetectRiskStatsView extends DetectRiskStatsBody {
  since: string | null;
  until: string | null;
  profile: DetectResultsProfile | null;
}

export interface DetectResultsQuery {
  category: DetectCategory;
  source?: string;
  severity?: string;
  since?: string;
  until?: string;
  /** 只看某个应用平台画像范围里的风险（台账资产 id） */
  profile?: string;
  page?: number;
  pageSize?: number;
  tenantId?: string;
}

export const detectResultsApi = {
  list(query: DetectResultsQuery) {
    return request<DetectResultsPage>('GET', '/detect-results', { query: { ...query } });
  },
  stats(query: { since?: string; until?: string; profile?: string; tenantId?: string }) {
    return request<DetectRiskStatsView>('GET', '/detect-results/stats', { query: { ...query } });
  },
};

const BJT_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** ISO 时间 → 北京时间日期（日期框的值）。 */
export function bjtDate(iso: string): string {
  return new Date(Date.parse(iso) + BJT_MS).toISOString().slice(0, 10);
}

/** 日期框的起止日期 → 接口的 since（当天 0 点）与 until（次日 0 点，开区间）。 */
export function bjtDayStart(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}
export function bjtDayEnd(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00+08:00`) + DAY_MS).toISOString();
}
/** until（开区间上界）在日期框里显示为它前一刻那天。 */
export function bjtUntilDate(iso: string): string {
  return bjtDate(new Date(Date.parse(iso) - 1).toISOString());
}

// ───────────── 受测应用安全画像（2.5.6） ─────────────

export interface RiskSuggestion {
  category: DetectCategory;
  source: RiskSourceKey;
  title: string;
  action: string;
  count: number;
  severity: RiskSeverityKey;
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
      /** 规格：终端探针上报的优先，探针没有的项用台账里填的 */
      os: string | null;
      cpu: string | null;
      memoryMB: number | null;
      gpu: string | null;
      endpoint: { id: string; hostname: string; lastSeenAt: string | null } | null;
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
    frameworks: EndpointAIComponent[];
  };
  compute: {
    accelerators: Array<EndpointAccelerator & { serverName: string }>;
    cardCount: number;
    totalMemoryMB: number | null;
  };
  models: Array<{
    assetId: string;
    name: string;
    modelTarget: { id: string; name: string; model: string } | null;
    identity: {
      verdictLabel: string;
      name: string | null;
      quantization: string | null;
      baseModel: string | null;
      knownModel: string | null;
    } | null;
    lastEval: { taskId: string; finishedAt: string | null; score: number | null } | null;
    /** 模型文件扫描识别出的优先，没有时用台账里填的 */
    baseModel: string | null;
  }>;
  risks: { stats: DetectRiskStatsBody; top: DetectResultRow[] };
  suggestions: RiskSuggestion[];
  /** 关联资产超过 200 个，只统计了前 200 个 */
  truncated: boolean;
}

export interface AppProfileListItem {
  id: string;
  tenantId: string | null;
  name: string;
  code: string | null;
  ownerName: string | null;
  organizationPath: string | null;
  assetCount: number;
  truncated: boolean;
  /** 看不到任何风险来源时为 null */
  riskTotal: number | null;
  riskHigh: number | null;
}

export const appProfilesApi = {
  list(query: { q?: string; page?: number; pageSize?: number; tenantId?: string }) {
    return request<{ items: AppProfileListItem[]; total: number; page: number; pageSize: number }>(
      'GET',
      '/app-profiles',
      { query: { ...query } },
    );
  },
  get(id: string) {
    return request<AppProfile>('GET', `/app-profiles/${encodeURIComponent(id)}`);
  },
};
