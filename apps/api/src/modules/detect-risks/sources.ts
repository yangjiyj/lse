import type { DetectCategory, DetectRecordKind } from '@lse/shared';

/**
 * 四类风险（2.2.2）的来源：每个来源是一类检测记录里「算一条有效风险」的行。
 * 口径、时间窗口、与现有页面的关系见 docs/detect-risk-categories.md。
 */
export const RISK_SOURCE_KEYS = [
  'model_file',
  'corpus',
  'eval_content',
  'eval_app',
  'service_assurance',
  'ai_component',
  'asset_discovery',
] as const;

export type RiskSourceKey = (typeof RISK_SOURCE_KEYS)[number];

export interface RiskSourceDef {
  category: DetectCategory;
  label: string;
  /** 看这个来源要的权限，任一即可（与对应模块列表接口一致） */
  permissions: readonly string[];
  /** 明细行的来源记录类型 */
  recordKind: DetectRecordKind;
}

export const RISK_SOURCES: Record<RiskSourceKey, RiskSourceDef> = {
  model_file: {
    category: 'model',
    label: '模型文件扫描发现',
    permissions: ['engine:scan', 'remediation:read'],
    recordKind: 'model_file_scan',
  },
  corpus: {
    category: 'data',
    label: '语料扫描命中',
    permissions: ['corpus_scan:read'],
    recordKind: 'corpus_scan',
  },
  eval_content: {
    category: 'content',
    label: '内容评估风险项',
    permissions: ['eval_task:read'],
    recordKind: 'eval_task',
  },
  eval_app: {
    category: 'app_env',
    label: '智能体与终端测评风险项',
    permissions: ['eval_task:read'],
    recordKind: 'eval_task',
  },
  service_assurance: {
    category: 'app_env',
    label: '服务核验漏洞与基线问题',
    permissions: ['service_assurance:read'],
    recordKind: 'service_assurance',
  },
  ai_component: {
    category: 'app_env',
    label: '组件扫描发现',
    permissions: ['engine:scan', 'eval_task:read'],
    recordKind: 'ai_component_scan',
  },
  asset_discovery: {
    category: 'app_env',
    label: '未登记 AI 服务',
    permissions: ['engine:scan', 'platform_setting:read'],
    recordKind: 'asset_discovery',
  },
};

/** 各类别下的来源，按页面展示顺序。 */
export const RISK_SOURCES_BY_CATEGORY: Record<DetectCategory, readonly RiskSourceKey[]> = {
  model: ['model_file'],
  data: ['corpus'],
  content: ['eval_content'],
  app_env: ['eval_app', 'service_assurance', 'ai_component', 'asset_discovery'],
};

/** 任一来源的权限（首页卡片、检测结果页的入口权限）。 */
export const RISK_SOURCE_PERMISSIONS: readonly string[] = [
  ...new Set(RISK_SOURCE_KEYS.flatMap((key) => RISK_SOURCES[key].permissions)),
];

export function isRiskSourceKey(value: unknown): value is RiskSourceKey {
  return typeof value === 'string' && (RISK_SOURCE_KEYS as readonly string[]).includes(value);
}

export function canReadRiskSource(source: RiskSourceKey, has: (code: string) => boolean): boolean {
  return RISK_SOURCES[source].permissions.some((code) => has(code));
}
