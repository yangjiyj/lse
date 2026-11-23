import type { DetectCategory, DetectRecordKind } from './detect-category.js';
import type { ToolTaskEntryKey } from './tool-task-entries.js';

/** 统一任务视图的状态：各表的原始状态归一到这六种。 */
export const DETECT_TASK_STATUSES = [
  'PENDING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELED',
] as const;
export type DetectTaskStatus = (typeof DETECT_TASK_STATUSES)[number];

export const DETECT_TASK_STATUS_LABELS: Record<DetectTaskStatus, string> = {
  PENDING: '排队中',
  RUNNING: '执行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELED: '已停止',
};

export const DETECT_TASK_TERMINAL_STATUSES: readonly DetectTaskStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELED',
];

export function isDetectTaskTerminal(status: string): boolean {
  return (DETECT_TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * 各表原始状态 → 统一状态。
 * 原始状态来源：EvalTaskStatus（评估任务、批量评估）、ModelFileScanStatus、ServiceAssuranceRunStatus、
 * FleetJobStatus 枚举，以及语料扫描、资产测绘、组件扫描的字符串状态。
 * 服务核验的 PARTIAL 归为已完成；终端测评已下发（DELIVERED）算执行中。没列到的一律算失败。
 */
export const DETECT_RAW_STATUS_MAP: Readonly<Record<string, DetectTaskStatus>> = {
  PENDING: 'PENDING',
  QUEUED: 'PENDING',
  PENDING_APPROVAL: 'PENDING',
  RUNNING: 'RUNNING',
  DELIVERED: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  PARTIAL: 'COMPLETED',
  FAILED: 'FAILED',
  REJECTED: 'FAILED',
  EXPIRED: 'FAILED',
  CANCELED: 'CANCELED',
  CANCELLED: 'CANCELED',
};

export function normalizeDetectTaskStatus(raw: string): DetectTaskStatus {
  // 只认自有属性：toString 这类原型链上的名字也算没列到。
  return Object.prototype.hasOwnProperty.call(DETECT_RAW_STATUS_MAP, raw)
    ? DETECT_RAW_STATUS_MAP[raw]!
    : 'FAILED';
}

export const DETECT_RECORD_KIND_LABELS: Record<DetectRecordKind, string> = {
  eval_task: '评估任务',
  batch_evaluation: '批量评估',
  standard_run: '合规专项检测',
  rag_eval: 'RAG 专项评估',
  model_file_scan: '模型文件扫描',
  corpus_scan: '语料扫描',
  asset_discovery: 'AI 资产测绘',
  service_assurance: 'AI 服务安全核验',
  ai_component_scan: 'AI 组件漏洞扫描',
  fleet_eval_job: '终端测评',
};

/**
 * 看某类记录需要的权限（任一即可），与各模块列表接口的 requirePermission 一致。
 * standard_run、rag_eval、fleet_eval_job 在统一视图里都是 eval_tasks 的行，按评估任务的权限看。
 */
export const DETECT_RECORD_READ_PERMISSIONS: Record<DetectRecordKind, readonly string[]> = {
  eval_task: ['eval_task:read'],
  batch_evaluation: ['eval_task:read'],
  standard_run: ['eval_task:read'],
  rag_eval: ['eval_task:read'],
  model_file_scan: ['engine:scan', 'remediation:read'],
  corpus_scan: ['corpus_scan:read'],
  asset_discovery: ['engine:scan', 'platform_setting:read'],
  service_assurance: ['service_assurance:read'],
  ai_component_scan: ['engine:scan', 'eval_task:read'],
  fleet_eval_job: ['eval_task:read'],
};

export function canReadDetectRecord(
  kind: DetectRecordKind,
  has: (code: string) => boolean,
): boolean {
  return DETECT_RECORD_READ_PERMISSIONS[kind].some((code) => has(code));
}

/** 记录详情页的前端路径（统一视图、检测结果、组合任务都按它跳转）。 */
export function detectRecordHref(kind: DetectRecordKind, id: string): string {
  const v = encodeURIComponent(id);
  switch (kind) {
    case 'eval_task':
    case 'standard_run':
    case 'rag_eval':
    case 'fleet_eval_job':
      return `/eval-tasks/${v}`;
    case 'batch_evaluation':
      return `/batch-evaluations?id=${v}`;
    case 'model_file_scan':
      return `/inspect/model-files?scan=${v}`;
    case 'corpus_scan':
      return `/data/corpus-scans/${v}`;
    case 'asset_discovery':
      return `/inspect/asset-discovery?run=${v}`;
    case 'service_assurance':
      return `/service-assurance?run=${v}`;
    case 'ai_component_scan':
      return `/ai-asset-scan?scan=${v}`;
  }
}

/** 组合任务能自动启动的子任务类型（2.4.9）。 */
export const DETECT_JOB_ITEM_KINDS = [
  'eval_task',
  'model_file_scan',
  'corpus_scan',
  'asset_discovery',
  'fleet_posture',
] as const;
export type DetectJobItemKind = (typeof DETECT_JOB_ITEM_KINDS)[number];

export interface DetectJobItemMeta {
  label: string;
  category: DetectCategory;
  /** 启动后生成的检测记录类型 */
  recordKind: DetectRecordKind;
  /** 对应的工具中心入口（TOOL_TASK_ENTRIES 的 key） */
  entry: ToolTaskEntryKey;
  /** 启动这类子任务要的权限，全部都要有 */
  createPermissions: readonly string[];
}

export const DETECT_JOB_ITEM_META: Record<DetectJobItemKind, DetectJobItemMeta> = {
  eval_task: {
    label: '内容安全评估',
    category: 'content',
    recordKind: 'eval_task',
    entry: 'content-eval',
    createPermissions: ['eval_task:create'],
  },
  model_file_scan: {
    label: '模型文件扫描',
    category: 'model',
    recordKind: 'model_file_scan',
    entry: 'model-file-scan',
    createPermissions: ['engine:scan'],
  },
  corpus_scan: {
    label: '语料扫描',
    category: 'data',
    recordKind: 'corpus_scan',
    entry: 'corpus-scan',
    createPermissions: ['corpus_scan:create'],
  },
  asset_discovery: {
    label: 'AI 资产测绘',
    category: 'app_env',
    recordKind: 'asset_discovery',
    entry: 'asset-discovery',
    createPermissions: ['engine:scan'],
  },
  fleet_posture: {
    label: '终端配置体检',
    category: 'app_env',
    recordKind: 'fleet_eval_job',
    entry: 'fleet-posture',
    createPermissions: ['model_target:create', 'eval_task:create'],
  },
};

export function isDetectJobItemKind(value: unknown): value is DetectJobItemKind {
  return typeof value === 'string' && (DETECT_JOB_ITEM_KINDS as readonly string[]).includes(value);
}
