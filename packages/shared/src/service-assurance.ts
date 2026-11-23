import type { Severity } from './enums.js';

export const SERVICE_ASSURANCE_MODES = ['SAFE', 'DEEP', 'SBOM'] as const;
export type ServiceAssuranceMode = (typeof SERVICE_ASSURANCE_MODES)[number];

export const SERVICE_ASSURANCE_TARGET_KINDS = ['ENDPOINT', 'OPENAPI', 'MCP', 'SBOM'] as const;
export type ServiceAssuranceTargetKind = (typeof SERVICE_ASSURANCE_TARGET_KINDS)[number];

export const SERVICE_ASSURANCE_RUN_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELED',
] as const;
export type ServiceAssuranceRunStatus = (typeof SERVICE_ASSURANCE_RUN_STATUSES)[number];

export const SERVICE_ASSURANCE_COVERAGE_STATUSES = ['COMPLETE', 'INCOMPLETE', 'NOT_READY'] as const;
export type ServiceAssuranceCoverageStatus = (typeof SERVICE_ASSURANCE_COVERAGE_STATUSES)[number];

export const ASSURANCE_IMPACT_STATUSES = [
  'UNDER_INVESTIGATION',
  'AFFECTED',
  'NOT_AFFECTED',
  'FIXED',
] as const;
export type AssuranceImpactStatus = (typeof ASSURANCE_IMPACT_STATUSES)[number];

export const ASSURANCE_EVIDENCE_LEVELS = [
  'LEAD',
  'VERSION_MATCH',
  'CONFIG_MATCH',
  'ACTIVE_VERIFIED',
] as const;
export type AssuranceEvidenceLevel = (typeof ASSURANCE_EVIDENCE_LEVELS)[number];

export const ASSURANCE_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'UNKNOWN'] as const;
export type AssurancePriority = (typeof ASSURANCE_PRIORITIES)[number];

export interface ServiceAssuranceNotice {
  code: string;
  message: string;
}

export interface ServiceAssuranceCustomerSummary {
  confirmed: number;
  underInvestigation: number;
  notAffected: number;
  fixed: number;
  incomplete: boolean;
  statusMessage: string;
}

export interface ServiceAssuranceReadinessMode {
  mode: ServiceAssuranceMode;
  ready: boolean;
  message: string;
  baselineUpdatedAt: string | null;
}

export interface ServiceAssuranceReadinessResponse {
  modes: ServiceAssuranceReadinessMode[];
  targets?: Array<ServiceAssuranceReadinessMode & { targetKind: ServiceAssuranceTargetKind }>;
}

export interface ServiceAssuranceRunListItem {
  runId: string;
  /** 未关联评估任务时为 null。 */
  taskId: string | null;
  taskName?: string | null;
  linkedAt?: string | null;
  mode: ServiceAssuranceMode;
  targetKind: ServiceAssuranceTargetKind;
  targetName: string;
  targetAddress?: string | null;
  status: ServiceAssuranceRunStatus;
  coverageStatus: ServiceAssuranceCoverageStatus;
  statusMessage: string;
  summary: ServiceAssuranceCustomerSummary;
  createdAt: string;
  completedAt: string | null;
}

export interface ServiceAssuranceAssetItem {
  assetId: string;
  name: string;
  address: string;
  protocol: string | null;
  host: string | null;
  port: number | null;
  title: string | null;
}

export interface ServiceAssuranceComponentItem {
  componentId: string;
  name: string;
  vendor: string | null;
  version: string | null;
  confidence: number | null;
  evidenceLabel: string;
}

export interface ServiceAssuranceAssessmentItem {
  assessmentId: string;
  title: string;
  advisoryId: string | null;
  severity: Severity | null;
  impactStatus: AssuranceImpactStatus;
  confidence: number | null;
  priority: AssurancePriority;
  reason: string;
  remediation: string | null;
  evidenceLabel: string;
}

export interface ServiceAssuranceRunDetailResponse {
  run: ServiceAssuranceRunListItem;
  assets: ServiceAssuranceAssetItem[];
  components: ServiceAssuranceComponentItem[];
  results: ServiceAssuranceAssessmentItem[];
  execution?: ServiceAssuranceExecutionRecord & {
    telemetryAvailable: boolean;
    limitations: string[];
  };
}

/** Observations made during execution, never inferred from a configured template count. */
export interface ServiceAssuranceCheckExecution {
  id: string;
  label: string;
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'UNKNOWN';
  requestCount: number | null;
  detail: string;
}

export interface ServiceAssuranceExecutionRecord {
  checks: ServiceAssuranceCheckExecution[];
  requestCount: number | null;
}

export interface ServiceAssurancePlannedCheck {
  id: string;
  label: string;
  description: string;
}

export function selectServiceAssuranceReadiness(
  response: ServiceAssuranceReadinessResponse,
  mode: ServiceAssuranceMode,
  targetKind: ServiceAssuranceTargetKind,
): ServiceAssuranceReadinessMode | undefined {
  return response.targets
    ? response.targets.find((item) => item.mode === mode && item.targetKind === targetKind)
    : response.modes.find((item) => item.mode === mode);
}

/** Customer-facing scope of the currently reviewed checks; not proof of execution. */
export function getServiceAssurancePlannedChecks(
  mode: ServiceAssuranceMode,
  targetKind: ServiceAssuranceTargetKind,
): ServiceAssurancePlannedCheck[] {
  if (mode === 'SBOM' && targetKind === 'SBOM') {
    return [
      {
        id: 'sbom-components',
        label: '组件身份与版本核对',
        description: '解析清单中的组件名称、版本及标准包标识。',
      },
      {
        id: 'sbom-advisories',
        label: '已知漏洞匹配',
        description: '使用固定漏洞库核对组件版本；缺少身份、版本或公告覆盖时明确标记。',
      },
    ];
  }
  if (mode === 'SBOM' || targetKind === 'SBOM' || targetKind === 'MCP') return [];
  const checks: ServiceAssurancePlannedCheck[] = [
    {
      id: 'lse-http-security-headers',
      label: '响应类型防护头检查',
      description: '检查成功响应是否存在 X-Content-Type-Options 头；当前规则不验证头值是否正确。',
    },
    {
      id: 'lse-triton-product-fingerprint',
      label: 'Triton 服务识别',
      description: '访问 /v2/health/ready 收集产品线索；识别到名称不代表存在漏洞。',
    },
  ];
  if (mode === 'DEEP') {
    checks.push({
      id: 'lse-unauthenticated-admin-status',
      label: '管理状态接口未授权检查',
      description: '检查 /admin/status 是否返回规则定义的未授权管理状态。',
    });
  }
  if (targetKind === 'OPENAPI') {
    checks.push({
      id: 'zap-api-passive',
      label: '接口描述与被动响应检查',
      description: '导入 OpenAPI 描述，对其中可访问接口的响应执行当前允许的被动检查。',
    });
    if (mode === 'DEEP') {
      checks.push({
        id: 'zap-api-active',
        label: '附加 API 主动检查',
        description: '在授权范围内执行允许的路径穿越、跨站脚本及 SQL 注入检查，受请求预算限制。',
      });
    }
  }
  return checks;
}

export function getServiceAssuranceLimitations(
  mode: ServiceAssuranceMode,
  targetKind: ServiceAssuranceTargetKind,
): string[] {
  if (mode === 'SBOM') {
    return [
      '仅核对上传清单及固定漏洞库；不证明运行环境包含这些组件。',
      '未匹配公告不等于已证明不受影响；缺少版本或数据库覆盖时仍需补充证据。',
    ];
  }
  if (targetKind === 'MCP')
    return ['当前未提供 MCP 协议及工具行为专项检查；历史 HTTP 检查记录仅供查阅。'];
  return [
    '本次不携带访问凭据，鉴权后接口未覆盖。',
    '不覆盖模型越狱、业务权限关系或 MCP 工具行为。',
    targetKind === 'OPENAPI'
      ? '仅覆盖上方固定 HTTP 检查及描述中可访问且获授权的接口，不遍历全部业务接口。'
      : '仅执行列出的固定 HTTP 检查，不是全站漏洞扫描或内部组件清单审计。',
  ];
}
