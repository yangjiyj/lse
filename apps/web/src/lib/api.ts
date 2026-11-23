import type {
  FleetLiveProduct,
  LiveRiskType,
  LiveRiskTypeCatalogItem,
} from '../../../../packages/shared/src/fleet-live-eval';
import type { ReportKind } from '@/lib/format';
import type { DashboardDetectRisks } from '@/lib/detect-risks';
import type {
  BuiltinTaxonomyId,
  ServiceAssuranceMode,
  ServiceAssuranceReadinessResponse,
  ServiceAssuranceRunDetailResponse,
  ServiceAssuranceRunListItem,
  ServiceAssuranceTargetKind,
} from '@lse/shared';

// 与后端 Fastify API 对齐的前端数据客户端：令牌管理 + 统一请求 + 全量端点 + 视图类型。
// 视图类型在前端本地声明（与后端 serialize* 输出严格对应），以解耦 workspace 类型依赖。

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';
const TOKEN_KEY = 'lse_token';
// 平台管理员切换进入的租户（只对平台管理员生效，后端对其他人忽略）；'all' = 全部租户只读视角。
const TENANT_KEY = 'lse_tenant';
export const ALL_TENANTS = 'all';
export const TENANT_REQUIRED_EVENT = 'lse:tenant-required';
/** 服务端要求先改密（首次登录）：登录态据此刷新当前用户，路由守卫随即跳到改密页。 */
export const PASSWORD_CHANGE_REQUIRED_EVENT = 'lse:password-change-required';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TENANT_KEY);
}
export function getTenantSelection(): string | null {
  return localStorage.getItem(TENANT_KEY);
}
/** 平台管理员切换租户；'all' 进入全部租户视角，null 回到本属租户。 */
export function setTenantSelection(tenantId: string | null): void {
  if (tenantId) localStorage.setItem(TENANT_KEY, tenantId);
  else localStorage.removeItem(TENANT_KEY);
}

export function isAllTenantsSelection(): boolean {
  return getTenantSelection() === ALL_TENANTS;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  issues?: unknown;
  constructor(message: string, status: number, code?: string, issues?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== null && v !== undefined && v !== '') sp.append(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${url}?${qs}` : url;
}

/** 只读方法：其余方法一律视为写操作。 */
const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * 租户请求头。
 * 「全部租户」是只读汇总视角：只有读请求带 `x-lse-tenant: all`；写请求一律不带，
 * 即落回账号的本属租户。这样平台管理员在全局视角里新建东西时不需要先选租户
 * （不再弹「建到哪个租户」），新建的资产默认归自己，需要给别的租户时再用「移到租户」。
 */
function authHeaders(method: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extra };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const tenant = getTenantSelection();
  if (token && tenant && (tenant !== ALL_TENANTS || READ_METHODS.has(method.toUpperCase()))) {
    headers['x-lse-tenant'] = tenant;
  }
  return headers;
}

function handleUnauthorized(): void {
  clearToken();
  if (!window.location.pathname.startsWith('/login')) {
    window.location.assign('/login');
  }
}

/** 几类要由全局处理的错误：派发事件或回退租户。 */
function handleGlobalError(err: ApiError): void {
  // 全部租户视角下服务端拒绝写操作：统一弹「进入租户」选择框。
  if (err.code === 'TENANT_REQUIRED' && isAllTenantsSelection()) {
    window.dispatchEvent(new CustomEvent(TENANT_REQUIRED_EVENT));
  }
  if (err.status === 403 && err.code === 'PASSWORD_CHANGE_REQUIRED') {
    window.dispatchEvent(new CustomEvent(PASSWORD_CHANGE_REQUIRED_EVENT));
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `请求失败（${res.status}）`;
  let code: string | undefined;
  let issues: unknown;
  try {
    const data = (await res.json()) as {
      error?: string | { message?: string; code?: string; issues?: unknown; details?: unknown };
      message?: string;
    };
    if (data?.error && typeof data.error === 'object') {
      // 嵌套错误体 { error: { message, code, issues } }
      if (data.error.message) message = data.error.message;
      code = data.error.code;
      issues = data.error.issues ?? data.error.details;
    } else {
      // 扁平错误体 { error: '<code>', message: '<中文说明>' }
      if (typeof data?.message === 'string' && data.message) message = data.message;
      if (typeof data?.error === 'string') code = data.error;
    }
  } catch {
    // 忽略非 JSON 错误体
  }
  return new ApiError(message, res.status, code, issues);
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  skipAuthRedirect?: boolean;
}

/** 失败响应转成 ApiError，并做统一处理：401 回登录页、租户相关的全局事件、代管租户已删除时回退。 */
async function responseError(res: Response, skipAuthRedirect = false): Promise<ApiError> {
  if (res.status === 401 && !skipAuthRedirect) {
    handleUnauthorized();
    return parseError(res);
  }
  const err = await parseError(res);
  handleGlobalError(err);
  // 代管的租户已不存在：退回本属租户重新加载。
  if (err.code === 'TENANT_NOT_FOUND' && getTenantSelection()) {
    setTenantSelection(null);
    window.location.assign('/');
  }
  return err;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers: authHeaders(method, hasBody ? { 'Content-Type': 'application/json' } : undefined),
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) throw await responseError(res, opts.skipAuthRedirect);
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * 带鉴权的文件下载：拉取 blob 后用临时 <a> 触发浏览器下载。
 * 默认 GET；传 body 时改为 POST + JSON（例如接入码不能放进 URL，只能放请求体）。
 */
export async function downloadFile(
  path: string,
  query?: Query,
  fallbackName = 'download',
  body?: unknown,
): Promise<void> {
  const hasBody = body !== undefined;
  const res = await fetch(buildUrl(path, query), {
    method: hasBody ? 'POST' : 'GET',
    headers: authHeaders(hasBody ? 'POST' : 'GET', hasBody ? { 'Content-Type': 'application/json' } : undefined),
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    handleUnauthorized();
    throw await parseError(res);
  }
  if (!res.ok) {
    const err = await parseError(res);
    handleGlobalError(err);
    throw err;
  }

  const disposition = res.headers.get('Content-Disposition') ?? '';
  let filename = fallbackName;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  if (star?.[1]) filename = decodeURIComponent(star[1]);
  else if (plain?.[1]) filename = plain[1];

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

/** 带鉴权下载站内文件（小文件：拉成 blob 再保存）。path 不带 API 前缀，如 `/tools/x/manuals/y/download`。 */
export function downloadRaw(path: string, fallbackName: string): Promise<void> {
  return downloadFile(path, undefined, fallbackName);
}

/**
 * 让浏览器原生下载（不经 blob，适合大文件）：用于接口签发的一次性下载链接。
 * url 是接口给的站内地址（带 /api 前缀），只接受站内路径。
 * 带 download 属性：链接失效时也不会把当前页面跳走，文件名取响应头里的。
 */
export function startBrowserDownload(url: string): void {
  if (!url.startsWith('/api/')) throw new ApiError('下载地址不正确', 0, 'BAD_DOWNLOAD_URL');
  const a = document.createElement('a');
  a.href = buildUrl(url.slice('/api'.length));
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface UploadRawOptions {
  query?: Query;
  onProgress?: (loaded: number, total: number) => void;
  /** 取消上传：中止 XHR，返回 code 为 UPLOAD_ABORTED 的 ApiError。 */
  signal?: AbortSignal;
}

/**
 * 原始字节上传（application/octet-stream，元数据走 query）：用 XHR 以便显示进度、能取消；
 * 鉴权头、租户头和失败处理与 request 一致（含 401 回登录页、TENANT_REQUIRED 等全局处理）。
 */
export function uploadRaw<T>(
  method: 'POST' | 'PUT',
  path: string,
  file: Blob,
  opts: UploadRawOptions = {},
): Promise<T> {
  const aborted = () => new ApiError('已取消上传', 0, 'UPLOAD_ABORTED');
  return new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(aborted());
    const xhr = new XMLHttpRequest();
    xhr.open(method, buildUrl(path, opts.query));
    for (const [k, v] of Object.entries(
      authHeaders(method, { 'Content-Type': 'application/octet-stream' }),
    ))
      xhr.setRequestHeader(k, v);
    const onAbort = () => xhr.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const settle = () => opts.signal?.removeEventListener('abort', onAbort);
    xhr.upload.onprogress = (e) => opts.onProgress?.(e.loaded, e.total || file.size);
    xhr.onabort = () => {
      settle();
      reject(aborted());
    };
    xhr.onerror = () => {
      settle();
      reject(new ApiError('上传中断，请检查网络后重试', 0));
    };
    xhr.onload = () => {
      settle();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve((xhr.responseText ? JSON.parse(xhr.responseText) : undefined) as T);
        } catch {
          reject(new ApiError('服务器返回的内容无法解析', xhr.status));
        }
        return;
      }
      void responseError(new Response(xhr.responseText, { status: xhr.status })).then(reject);
    };
    xhr.send(file);
  });
}

// ---------------------------------------------------------------------------
// 视图类型
// ---------------------------------------------------------------------------

export type FrameworkCoverageStatus =
  | 'NOT_TESTED'
  | 'TESTED_CLEAN'
  | 'TESTED_FINDINGS'
  | 'NOT_SUPPORTED';
export interface FrameworkCoverageResponse {
  scope: { taskId: string | null; targetId: string | null; days: number | null };
  rows: Array<{
    framework: 'OWASP_AGENTIC' | 'OWASP_LLM' | 'GBT45654_ANNEX_A' | 'ATLAS';
    entryId: string;
    entryName: string;
    entryNameEn: string;
    tested: number;
    passed: number;
    failed: number;
    undetermined: number;
    status: FrameworkCoverageStatus;
    sampleAdequate: boolean;
    note?: string;
    riskDomains: Array<{ domain: string; label: string; tested: number }>;
    recentTasks: Array<{ id: string; name: string }>;
  }>;
  summary: {
    entries: number;
    byStatus: Record<FrameworkCoverageStatus, number>;
    totalTested: number;
    unmappedTested: number;
  };
  disclaimer: string;
}

export type StandardLine = 'content' | 'agent' | 'endpoint';
export type StandardCapability = 'covered' | 'partial' | 'not_covered' | 'not_applicable';
export type StandardVerdict = 'conform' | 'nonconform' | 'insufficient' | 'not_tested' | 'not_applicable';
export interface StandardClauseInfo {
  id: string;
  basisId: string;
  basisName: string;
  ref: string;
  title: string;
  requirement: string;
  kind: 'risk' | 'method' | 'control';
  kindLabel: string;
  automation: 'auto' | 'semi' | 'manual';
  automationLabel: string;
  capability: StandardCapability;
  capabilityLabel: string;
  capabilityNote: string | null;
  applicability: string | null;
  sourceRef: string;
  hasThreshold: boolean;
}
export interface StandardCatalogResponse {
  lines: Array<{
    line: StandardLine;
    label: string;
    basisStatement: string;
    bases: Array<{ id: string; code: string | null; title: string; statusLabel: string; statusNote: string | null; issuer: string }>;
    references: string[];
    clauses: StandardClauseInfo[];
  }>;
}
export interface StandardCoverageClause extends StandardClauseInfo {
  verdict: StandardVerdict;
  verdictLabel: string;
  tested: number;
  failed: number;
  invalid: number;
  note: string;
}
export interface StandardCoverageResponse {
  scope: { line: StandardLine | null; taskId: string | null; targetId: string | null; days: number | null };
  lines: Array<{
    line: StandardLine;
    label: string;
    validCount: number;
    taskCount: number;
    summary: { clauses: number; byVerdict: Record<string, number> };
    clauses: StandardCoverageClause[];
    annexMajors?: Array<{ code: string; name: string; tested: number; failed: number; invalid: number }>;
  }>;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type BatchStatus = 'PENDING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELED';
export type BatchStrategy = 'ROUND_ROBIN' | 'SEQUENTIAL' | 'PARALLEL';
export type BatchJudgeMode = 'MODEL' | 'RULES';
export interface BatchPlan {
  id: string;
  name: string;
  status: BatchStatus;
  strategy: BatchStrategy;
  judgeMode: BatchJudgeMode;
  sampleCount: number;
  targetCount: number;
  totalSamples: number;
  processedSamples: number;
  validSamples: number;
  failedSamples: number;
  errorSamples: number;
  unknownSamples: number;
  criticalSamples: number;
  requestsUsed: number;
  maxRequests: number;
  stopReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: number;
}
export interface BatchRun {
  id: string;
  targetId: string;
  targetName: string;
  status: BatchStatus;
  expectedSamples: number;
  processedSamples: number;
  validSamples: number;
  passedSamples: number;
  failedSamples: number;
  errorSamples: number;
  unknownSamples: number;
  criticalSamples: number;
  riskRate: number | null;
  falseRefusalRate: number | null;
  validRate: number;
  averageLatencyMs: number | null;
  totalTokens: number;
}
export interface BatchSummary {
  state: 'RISK_DETECTED' | 'NO_RISK_OBSERVED' | 'INCOMPLETE';
  coverageComplete: boolean;
  counts: {
    expected: number;
    processed: number;
    valid: number;
    pass: number;
    fail: number;
    error: number;
    unknown: number;
    critical: number;
  };
  commonRisks: Array<{ category: string; affectedTargets: number }>;
  recommendations: string[];
}
export interface BatchDetail extends BatchPlan {
  seed: string;
  samplePlanHash: string;
  concurrency: number;
  targetConcurrency: number;
  batchSize: number;
  rpm: number;
  maxAttempts: number;
  maxDurationMinutes: number;
  runs: BatchRun[];
  summary: BatchSummary;
}
export interface CreateBatchRequest {
  name: string;
  targetIds: string[];
  questionSetIds: string[];
  sampleCount: number;
  seed: string;
  judgeMode: BatchJudgeMode;
  strategy: BatchStrategy;
  concurrency: number;
  targetConcurrency: number;
  batchSize: number;
  rpm: number;
  maxAttempts: number;
  maxRequests?: number;
  maxDurationMinutes: number;
}
export interface BatchResult {
  id: string;
  runId: string;
  targetName: string;
  sequence: number;
  prompt: string;
  response: string | null;
  verdict: 'PASS' | 'FAIL' | 'ERROR' | 'UNKNOWN' | null;
  severity: string | null;
  category: string;
  errorMessage: string | null;
  attempts: number;
  latencyMs: number | null;
  totalTokens: number;
  evidence: string[];
}
export interface BatchReport {
  title: string;
  content: string;
  summary: BatchSummary;
  generatedAt: string;
}

export type ViewMode = 'expert' | 'demo';

export interface UserPreferences {
  viewMode?: ViewMode;
}

export interface AuthUser {
  allTenants?: boolean;
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  isBuiltin: boolean;
  roles: string[];
  permissions: string[];
  preferences: UserPreferences;
  /** 安全设置：密码已超过强制更新时间，须先改密。 */
  passwordExpired?: boolean;
  /** 首次登录强制改密：须先改密才能使用其他功能。 */
  passwordChangeRequired?: boolean;
  passwordExpiresAt?: string | null;
  /** 超时登出时间（分钟），0 为不限制。 */
  idleTimeoutMinutes?: number;
  /** 操作日志查看范围：system_admin_only 时只有平台管理员能看。 */
  auditLogAccess?: 'admins_and_auditors' | 'system_admin_only';
  /** 本次操作的租户（平台管理员切换后为目标租户）。 */
  tenant?: { id: string; name: string; isPlatform: boolean };
  homeTenantId?: string;
  /** 平台管理员：可管理租户、切换进入任意租户。 */
  isPlatformAdmin?: boolean;
}

export interface TenantItem {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isPlatform: boolean;
  createdAt: string;
  userCount: number;
  targetCount: number;
  endpointCount: number;
  taskCount: number;
  /** 有效风险项 / 高危数；旧后端不返回这两个字段。 */
  riskCount?: number;
  highRiskCount?: number;
  lastTaskAt: string | null;
}

export interface TenantCreateInput {
  name: string;
  description?: string;
  admin: { username: string; displayName?: string; password: string };
}

/** 可转移归属的资产类型。 */
export type TenantTransferKind = 'model-target' | 'fleet-endpoint' | 'question-set' | 'agent-sample';

export interface TenantTransferBlocker {
  code: string;
  message: string;
  objectId?: string;
}

export interface TenantTransferWarning {
  code: string;
  message: string;
  objectId?: string;
}

export interface TenantTransferPlan {
  kind: TenantTransferKind;
  kindLabel: string;
  sourceTenant: { id: string; name: string };
  targetTenant: { id: string; name: string };
  roots: { id: string; name: string; tenantId: string | null }[];
  counts: Record<string, { label: string; count: number }>;
  totalRows: number;
  blockers: TenantTransferBlocker[];
  warnings: TenantTransferWarning[];
  canTransfer: boolean;
}

export interface TenantTransferInput {
  kind: TenantTransferKind;
  ids: string[];
  targetTenantId: string;
}

export interface TenantTransferResult {
  plan: TenantTransferPlan;
  applied: Record<string, number>;
  totalRows: number;
}
export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface PermissionItem {
  code: string;
  name: string;
}
export interface PermissionGroup {
  group: string;
  items: PermissionItem[];
}
export interface PermissionCatalog {
  groups: PermissionGroup[];
  all: Array<{ code: string; name: string; group: string }>;
}

export interface ServiceAssuranceCreateRequest {
  /** 可选：不传表示不关联评估任务，之后可在核验记录上关联。 */
  taskId?: string;
  mode: ServiceAssuranceMode;
  targetKind: ServiceAssuranceTargetKind;
  targetName: string;
  targetUrl?: string;
  scopePolicyRef: string;
  credentialRef?: string;
  authorizationConfirmed: boolean;
  sbom?: ServiceAssuranceSbomRequest;
}

export type ServiceAssuranceRunListQuery = {
  taskId?: string;
  keyword?: string;
  status?: ServiceAssuranceRunListItem['status'];
  page?: number;
  pageSize?: number;
};

export interface ServiceAssuranceRunListResponse {
  items: ServiceAssuranceRunListItem[];
  total?: number;
  page?: number;
  pageSize?: number;
}

export interface ServiceAssuranceScopePolicy {
  ref: string;
  name: string;
  origins: string[];
  cidrs: string[];
  allowPrivate: boolean;
  allowPublic: boolean;
  isDefault: boolean;
}

export interface ServiceAssuranceScopeSettings {
  policies: ServiceAssuranceScopePolicy[];
  defaultPolicyRef: string | null;
  managedByPlatform: boolean;
  updatedAt: string | null;
}

export interface ServiceAssuranceScopePreview {
  origin: string;
  hostname: string;
  addresses: string[];
  suggestedCidrs: string[];
  allowPrivate: boolean;
  allowPublic: boolean;
}

export interface ServiceAssuranceSbomRequest {
  contentType: string;
  content: string;
}

export interface ServiceAssuranceEvidenceItem {
  evidenceId: string;
  assessmentId: string | null;
  evidenceType: string;
  ruleId: string | null;
  ruleSummary: string | null;
  matchedLocation: string | null;
  customerSummary: string;
  requestSummary: string | null;
  responseSummary: string | null;
  contentSha256: string;
  visibility: 'TECHNICAL';
}

export type ServiceAssuranceNotAffectedJustification =
  | 'component_not_present'
  | 'vulnerable_code_not_present'
  | 'vulnerable_code_not_in_execute_path'
  | 'vulnerable_code_cannot_be_controlled_by_adversary'
  | 'inline_mitigations_already_exist';

export type ServiceAssuranceReviewRequest =
  | { impactStatus: 'UNDER_INVESTIGATION' | 'AFFECTED'; statement: string }
  | {
      impactStatus: 'NOT_AFFECTED';
      justification: ServiceAssuranceNotAffectedJustification;
      statement: string;
    }
  | { impactStatus: 'FIXED'; retestRunId: string; statement: string };

export interface ServiceAssuranceRetestRequest {
  sbom?: ServiceAssuranceSbomRequest;
}

export interface ServiceAssuranceReviewResult {
  impactStatus: 'UNDER_INVESTIGATION' | 'AFFECTED' | 'NOT_AFFECTED' | 'FIXED';
  reason: string;
  reviewedAt: string | null;
}

export type TargetType =
  | 'MODEL'
  | 'AGENT'
  | 'AGENT_API'
  | 'PLATFORM_APP'
  | 'ENDPOINT_AGENT'
  | 'PUBLIC_AGENT'
  | 'MCP_OPENAPI'
  | 'GATEWAY_LOG'
  | 'JUDGE';

export interface ModelTarget {
  id: string;
  tenantId?: string | null;
  name: string;
  targetType: TargetType;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  extraHeaders: Record<string, string> | null;
  defaultParams: Record<string, unknown> | null;
  accessConfig: Record<string, unknown> | null;
  /** 仅列表接口带 withEndpointState 时、仅终端类对象：绑定的终端还在不在（gone 已失效；unknown 判断不了）。 */
  endpointState?: 'active' | 'gone' | 'unknown';
  agentConfig?: Record<string, unknown> | null;
  connectorCapabilities?: Array<{
    key: string;
    label: string;
    supported: boolean;
    requirement?: string;
  }>;
  isGlobal: boolean;
  isActive: boolean;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  /** RAG 专项评估：是否声明为 RAG 应用及其引用/知识库上传配置。 */
  isRag?: boolean;
  ragOptions?: Record<string, unknown> | null;
  /** 是否已设置受限库上传凭据（值不回显）。 */
  hasRagRestrictedUploadSecret?: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; username: string } | null;
  /** W6b：是否声明支持图片输入（多模态越狱仅对 true 开放）。 */
  supportsVision?: boolean;
}

export interface ModelTestResult {
  status: string;
  latencyMs: number | null;
  httpStatus: number | null;
  model: string | null;
  sample: string | null;
  usage: Record<string, unknown> | null;
  error: string | null;
}

export interface ModelTargetDiagnoseCheck {
  key: 'network' | 'auth' | 'stream' | 'async' | 'session' | 'field';
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  message: string;
  suggestion?: string;
}

export interface ModelTargetDiagnoseReport {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  contentType: string | null;
  streamFormat: 'sse' | 'ndjson' | null;
  answerSample: string | null;
  responseCandidates: string[];
  detectedSessionField: string | null;
  detectedAsyncField: string | null;
  responsePreview: string;
  checks: ModelTargetDiagnoseCheck[];
}

export interface ModelTargetBatchTestResult {
  summary: { total: number; success: number; failed: number; skipped: number };
  concurrency: number;
  results: Array<{
    id: string;
    name: string | null;
    status: 'SUCCESS' | 'ERROR' | 'SKIPPED' | string;
    latencyMs: number | null;
    httpStatus: number | null;
    error: string | null;
    testedAt?: string;
  }>;
}

export interface QuestionSet {
  id: string;
  name: string;
  description: string | null;
  type: string;
  tags: string[];
  source: string | null;
  isBuiltin: boolean;
  /** 自建库可禁用；禁用后不能再用来建任务。缺省按启用处理。 */
  enabled?: boolean;
  /** 派生分类：seed 种子库 / own 自有样本库 / run 运行记录。 */
  kind?: 'seed' | 'own' | 'run';
  questionCount: number;
  /** 在用题数（列表接口返回）：国标三个题库不含已下线和尚未生效的题，其他题源等于 questionCount。 */
  activeQuestionCount?: number;
  importCount: number;
  taskLinkCount: number;
  riskCoverage?: string[];
  createdBy: { id: string; username: string; displayName: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** 攻击种子泛化。 */
export interface TestDomain {
  id: string;
  name: string;
  description: string | null;
}
export interface MutationStrategy {
  id: string;
  label: string;
  family: string;
  familyLabel: string;
  description: string;
  requiresLlm: boolean;
}
export interface MutationStrategiesResult {
  items: MutationStrategy[];
  llmConfigured: boolean;
  limits: { maxSampleSize: number; maxStrategies: number; maxOutput: number };
}
export interface MutationSpec {
  sourceSetId: string;
  sampleSize: number;
  seed?: string;
  strategies: string[];
  perSeed: number;
  name: string;
}
export interface MutationResult {
  id: string;
  name: string;
  seed: string;
  sourceTotal: number;
  sampled: number;
  total: number;
  skipped: number;
  perStrategy: { id: string; label: string; count: number }[];
}

export interface AttackSeedSpec {
  domain: string;
  scope: string;
  focus: string;
  keywords: string[];
  scenarioCount: number;
  questionsPerScenario: number;
  binding: { taxonomy: BuiltinTaxonomyId; categories: string[] } | null;
}
export interface AttackSeedScenario {
  name: string;
  description: string;
  category: string | null;
  questions: string[];
}
export interface AttackSeedResult {
  source: 'attacker_model' | 'template';
  fallbackReason?: string;
  attackerModel: string | null;
  total: number;
  scenarios: AttackSeedScenario[];
}

/** 内置合规题库统计（GET /question-sets/builtin/stats）。 */
export interface BuiltinBankStats {
  builtinQuestionTotal: number;
  builtinSetCount: number;
  ownSetCount: number;
  categories: { taxonomy: string; major: string; minor: string; count: number }[];
}

/** 国标（GB/T 45654 附录 B）题库覆盖统计：GET /question-sets/builtin/bank-coverage。 */
export interface BankCoverageRow {
  key: string;
  label: string;
  count: number;
  min: number;
  gap: number;
  ok: boolean;
  importOnly: boolean;
}
export interface BankCoverageBank {
  bank: 'generation' | 'refusal' | 'non_refusal';
  label: string;
  total: number;
  totalMin: number;
  totalOk: boolean;
  rows: BankCoverageRow[];
  gaps: BankCoverageRow[];
  ok: boolean;
  pendingImportItems: string[];
}
/** 题库与关键词库更新记录：GET /question-sets/builtin/updates。 */
export interface BankUpdateRecord {
  id: string;
  kind: 'questions' | 'keywords';
  version: string;
  trigger: 'release' | 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  /** 执行中但心跳已过期（服务重启等）：显示「已中断」。 */
  interrupted?: boolean;
  actorName: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 按题库、按小项的新增数（关键词为按小项）。 */
  added: Record<string, Record<string, number> | number> | null;
  retired: Record<string, Record<string, number>> | null;
  totals: Record<string, unknown> | null;
  generatorModel: string | null;
  judgeModel: string | null;
  note: string | null;
  error: string | null;
}
export interface BankUpdateOverview {
  items: BankUpdateRecord[];
  /** 当前用户能否立即更新（仅平台租户的平台管理员）。 */
  canRun?: boolean;
  questions: {
    version: string | null;
    updatedAt: string | null;
    cadence: string;
    nextRunAt: string | null;
    running: boolean;
  };
  keywords: {
    version: string | null;
    updatedAt: string | null;
    lastAdded: number | null;
    /** 最近一次执行（成功、失败、未执行、中断都算）。 */
    lastRun?: {
      status: 'running' | 'succeeded' | 'failed' | 'skipped';
      interrupted: boolean;
      at: string | null;
      added: number;
      reason: string | null;
    } | null;
    cadence: string;
    nextRunAt: string | null;
    running: boolean;
  };
}
export interface KeywordCoverageResult {
  total: number;
  totalMin: number;
  totalOk: boolean;
  rows: BankCoverageRow[];
  gaps: BankCoverageRow[];
  ok: boolean;
  pendingImportItems: string[];
  byStatus: Record<string, number>;
  /** 每个小项的在用、待确认、停用词数；rows[].count 只算在用的词。 */
  byItemStatus: Record<string, { approved: number; pending: number; disabled: number }>;
}
/** 关键词状态：approved 在用、pending 待确认、disabled 停用、rejected 已剔除（版本淘汰）。 */
export type KeywordStatus = 'approved' | 'pending' | 'disabled' | 'rejected';
export interface KeywordListItem {
  id: string;
  itemCode: string;
  itemName: string;
  term: string;
  source: string;
  /** 内置 / 导入 / 每周更新 / 手工 */
  sourceLabel: string;
  reviewStatus: KeywordStatus;
  reviewStatusLabel: string;
  statusChangedAt: string | null;
  statusChangedBy: string | null;
  /** 当前账号能否改这个词的状态（租户看平台词为否）。 */
  editable: boolean;
  scope: string;
  createdAt: string;
}
export interface KeywordListResult {
  total: number;
  /** 当前筛选下自己能改状态的词数。 */
  editableTotal: number;
  /** 当前账号改的是平台共享词表（影响所有租户的判定）。 */
  writesPlatform?: boolean;
  page: number;
  pageSize: number;
  items: KeywordListItem[];
}
export interface BankImportResult {
  totalRows: number;
  imported: number;
  duplicates: number;
  failed: number;
  issues: { row: number; message: string }[];
  byBank: Record<string, number>;
}
export interface KeywordImportResult {
  totalRows: number;
  added: number;
  duplicates: number;
  failed: number;
  issues: { row: number; message: string }[];
  byItem: Record<string, number>;
  /** 文件带状态列时，停用、已剔除而没有导入的行数。 */
  skippedInactive?: number;
}

export interface QuestionResultRecord {
  taskId: string;
  taskName: string;
  targetName: string;
  verdict: string | null;
  severity: string | null;
  createdAt: string;
}

export interface Question {
  id: string;
  questionSetId: string;
  externalId: string | null;
  content: string;
  expectedBehavior: string | null;
  referenceAnswer: string | null;
  category: string | null;
  language: string;
  type: string;
  severity: string | null;
  shouldRefuse: boolean;
  tags: string[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportRecord {
  id: string;
  questionSetId: string;
  filename: string;
  format: string;
  templateType: string;
  totalRows: number;
  importedRows: number;
  failedRows: number;
  status: string;
  errorReport: unknown;
  uploadedBy: unknown;
  createdAt: string;
}

export interface TemplateColumn {
  field: string;
  header: string;
  required: boolean;
  aliases: string[];
  example: string;
}
export interface QuestionTemplate {
  type: string;
  questionType: string;
  label: string;
  description: string;
  shouldRefuse: boolean;
  columns: TemplateColumn[];
}

/** 评估可信度：失败率区间、样本量与警告（后端派生，不改动既有计数）。 */
export interface EvalTaskStatistics {
  sampleSize: number;
  failedCount: number;
  unknownCount: number;
  errorCount: number;
  failRate: number | null;
  failRateLower: number | null;
  failRateUpper: number | null;
  unknownRate: number | null;
  confidenceLevel: number;
  warningCodes: Array<'NO_SAMPLE' | 'TOO_FEW' | 'FEW'>;
  warnings: string[];
  note: string;
}

/** 两个任务失败率差异是否可信。 */
export interface EvalDifferenceHint {
  verdict: 'insufficient' | 'within_noise' | 'beyond_noise';
  delta: number | null;
  message: string;
}

export interface EvalJudgeCalibration {
  status: 'OK' | 'INSUFFICIENT';
  reviewedCount: number;
  excludedReviewedCount: number;
  pendingCount: number;
  minRequired: number;
  agreementRate: number | null;
  agreementLower: number | null;
  agreementUpper: number | null;
  kappa: number | null;
  kappaLevel: string;
  precision: number | null;
  recall: number | null;
  missedRiskCount: number;
  falseAlarmCount: number;
  confusion: { tp: number; fp: number; fn: number; tn: number };
  message: string;
}

export interface EvalSpotCheckSample {
  seed: string;
  size: number;
  poolSize: number;
  items: Array<{
    findingId: string;
    resultId: string | null;
    questionId: string | null;
    riskCategory: string;
    severity: string | null;
    verdict: string;
    reviewStatus: string;
    title: string | null;
  }>;
}

export interface EvalTask {
  endpointMode?: 'posture' | 'live';
  id: string;
  tenantId?: string | null;
  name: string;
  description: string | null;
  status: string;
  modelTarget: {
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    model: string;
    targetType?: string;
    gatewayBound?: boolean;
  } | null;
  engines: string[];
  dimensions: string[];
  concurrency: number;
  totalQuestions: number;
  processedQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  unknownCount?: number;
  statistics?: EvalTaskStatistics;
  skippedEngineCount?: number;
  stealthBreakCount?: number;
  recognizedCount?: number;
  progress: number;
  questionSetCount: number;
  resultCount: number;
  logCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 综合评估得分 0–100（1 位小数，按配置管理权重）；无已判定样本或评估不完整（存在未判定/异常/跳过）时为 null。 */
  evalScore?: number | null;
  riskLevels?: { HIGH: number; MEDIUM: number; LOW: number };
  /** 能否暂停（只有走普通执行器的任务能暂停，2.4.2）。 */
  pausable?: boolean;
  /** 暂停中：已请求暂停，进行中的题做完再停。 */
  pauseRequested?: boolean;
  pausedAt?: string | null;
}

export interface EvalTaskDetail extends EvalTask {
  findingCount?: number;
  pendingReviewCount?: number;
  questionSets: Array<{ id: string; name: string; type: string; questionCount: number }>;
  gatewayLinkageEnabled?: boolean;
  /** 非空表示这条任务带国标符合性评估。 */
  standardRun?: {
    id: string;
    status: string;
    conclusion: string;
    evidenceCompleteness: string;
  } | null;
  parentTaskId?: string | null;
  retestMode?: string | null;
  retest?: EvalTaskRetestInfo;
}

/** 失败用例复测信息：retestOf 仅复测任务有，按题目对齐父任务统计。 */
export interface EvalTaskRetestInfo {
  retestOf: {
    parentTaskId: string;
    parentTaskName: string | null;
    retestMode: string | null;
    total: number;
    fixed: number;
    stillFailing: number;
    notRetested: number;
  } | null;
  failedQuestionCount: number;
  retestBlockedReason: string | null;
  retestTasks: Array<{ id: string; name: string; status: string; createdAt: string }>;
}

export interface FailedRetestCreated {
  task: {
    id: string;
    name: string;
    status: string;
    modelTargetId: string;
    parentTaskId: string;
    retestMode: string;
    totalQuestions: number;
  };
  questionIds: string[];
  findingId: string | null;
}

export interface RedTeamEvalCreateBody {
  bareTargetId: string;
  gatewayTargetId?: string;
  attackerTargetId: string;
  secondaryAttackerTargetId?: string;
  judgeTargetId?: string;
  questionSetId: string;
  breakOn?: 'verdict' | 'attitude';
  maxRounds?: number;
  noProgressK?: number;
  sampleCount?: number;
  selectionSeed?: string;
  directions?: string[];
}

export type ComprehensiveEvalModuleId =
  | 'content_safety'
  | 'autonomous_red_team'
  | 'agent_tool_safety'
  | 'indirect_prompt_injection'
  | 'runtime_trace'
  | 'sample_regression';

export interface ComprehensiveEvalCreateBody {
  name?: string;
  modelTargetId: string;
  mode: 'full' | 'random';
  seed?: string;
  modules: ComprehensiveEvalModuleId[];
  sampleCounts?: Partial<
    Record<
      'content_safety' | 'autonomous_red_team' | 'agent_tool_safety' | 'indirect_prompt_injection',
      number
    >
  >;
  regressionQuestionSetIds?: string[];
  adrPayload?: unknown;
  concurrency?: number;
}

export interface RedTeamDirection {
  id: string;
  /** 风险类型分组：prompt_injection / sensitive_info_leakage / violating_content（旧后端可能缺省）。 */
  riskType?: string;
  riskTypeLabel?: string;
  label: string;
  description: string;
  chainSummary: string;
  objectiveCount: number;
}

export interface RedTeamTraceTurn {
  index: number | null;
  move: string;
  attackerMessage: string;
  modelResponse: string;
  attitude: string;
  phaseId?: string;
  phaseLabel?: string;
  rationale?: string;
  successSignal?: string;
  /** 调整依据：目标上一轮响应 → 本轮攻击策略（历史录制缺省）。 */
  adjustmentBasis?: string;
  /** 逐轮判定（历史录制缺省为 null）。 */
  roundJudgment?: { source: string; verdict: string; engine: string | null } | null;
}

export interface RedTeamReplayMessage {
  role: string;
  content: string;
}

export interface RedTeamTrace {
  side: string | null;
  brokenLayers?: string[];
  recognizedRisk?: boolean;
  redLayerReward?: number | null;
  breakStatus?: 'stealth_break' | 'gateway_recognized' | 'clean';
  /** 客观 oracle：SUT 真的吐出了种入的 canary 机密（实时数据外发实锤，非裁判推断） */
  liveExfilProven?: boolean;
  canaryToken?: string;
  headName?: string;
  playbookVariant?: string;
  playbookLabel?: string;
  rounds: number | null;
  stopReason?: string;
  movesUsed: string[];
  transcript: RedTeamTraceTurn[];
  replayMessages: RedTeamReplayMessage[];
}

export interface EvalResultFinding {
  engine: string;
  riskCategory: string;
  severity: string;
  verdict?: string | null;
  confidence?: number | null;
  evidenceStrength?: string | null;
  executionOutcome?: string | null;
  reviewStatus?: string | null;
  reviewReason?: string | null;
  suppressionKey?: string | null;
  title?: string | null;
  evidence?: string | null;
  detail: unknown;
  /** 风险等级（高/中/低）+ 合规风险类别 + 关联法律法规（旧后端缺省）。 */
  compliance?: FindingCompliance | null;
}

export interface FindingCompliance {
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  riskLevelLabel: string;
  complianceCategory: string | null;
  complianceCategoryLabel: string | null;
  legalReferences: Array<{ law: string; topic: string }>;
}

export interface CustomRiskRule {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  patterns: string[];
  examples: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  enabled: boolean;
}

export interface TaskFinding extends EvalResultFinding {
  id: string;
  score: number | null;
  createdAt: string;
  remediation?: FindingRemediation;
}

export type FindingRemediationStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'READY_FOR_RETEST'
  | 'VERIFIED_CLOSED'
  | 'REOPENED'
  | 'NOT_APPLICABLE';

export type FindingReviewStatus =
  | 'UNREVIEWED'
  | 'NEEDS_REVIEW'
  | 'CONFIRMED'
  | 'FALSE_POSITIVE'
  | 'ACCEPTED_RISK';

export interface FindingRemediation {
  status: FindingRemediationStatus | null;
  owner: string | null;
  team: string | null;
  controlLocation: string | null;
  action: string | null;
  dueAt: string | null;
  record: string | null;
  acceptanceCriteria: string | null;
  retestTaskId: string | null;
  closureEvidence: string | null;
  closedAt: string | null;
}

export interface RemediationFinding extends TaskFinding {
  task: {
    id: string;
    name: string;
    status: string;
    modelTargetId: string;
    engines: string[];
    dimensions: string[];
    questionSets: Array<{ questionSetId: string; questionSet: { id: string; name: string } }>;
    modelTarget: {
      id: string;
      name: string;
      model: string;
      provider: string;
      targetType: string;
    };
  };
  result: { id: string; prompt: string; response: string | null; createdAt: string } | null;
  question: { id: string; content: string } | null;
  remediation: FindingRemediation;
  retestTask: {
    id: string;
    name: string;
    status: string;
    modelTargetId: string;
    finishedAt: string | null;
  } | null;
}

export interface EvalResult {
  reachability?:
    | 'blackbox_reached'
    | 'needs_whitebox'
    | 'inconclusive'
    | 'unreachable'
    | 'not_executed';
  id: string;
  questionId: string;
  controlGroupId: string | null;
  side: 'A' | 'B' | string | null;
  prompt: string;
  response: string | null;
  status: string;
  errorMessage: string | null;
  usage: Record<string, unknown> | null;
  latencyMs: number | null;
  finalVerdict: string | null;
  finalScore: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  question: {
    id: string;
    content: string;
    type: string;
    severity: string | null;
    /** 客户可读的一句话样本标题（智能体样本才有）；列表层优先展示它而非 content。 */
    displayTitle?: string | null;
  };
  redTeamTrace?: RedTeamTrace | null;
  findings?: EvalResultFinding[];
  /** 判定依据一句话（国标专项样本带：分类模型理由、拒答判定理由等）。 */
  verdictReason?: string | null;
  multimodal?: MultimodalEvidence | null;
}

export type MultimodalAttackType = 'typographic' | 'split' | 'injection';

export interface MultimodalEvidence {
  attackType: MultimodalAttackType | string;
  attackLabel: string;
  seed: string;
  text: string;
  imageText: string;
  injectedText: string | null;
  image: { mimeType: string; width: number; height: number; sha256: string };
  judge: {
    engine: string;
    status: string;
    verdict: string;
    severity: string | null;
    score: number | null;
    evidence: string | null;
  } | null;
  /** 客户自带图片集题目的补充信息；程序生成题为空。 */
  byo?: { category: string; expected: string; note: string; imageName: string } | null;
  error: string | null;
}

/** 自带图片集上传校验：逐行问题（line=0 表示整体问题）。 */
export interface ByoIssue {
  line: number;
  message: string;
}
export interface ByoUploadStats {
  zipBytes: number;
  entries: number;
  rows: number;
  images: number;
  unpackedBytes: number;
}
export interface ByoUploadResult {
  id: string;
  name: string;
  questionCount: number;
  imageCount: number;
  warnings: ByoIssue[];
  stats: ByoUploadStats;
}
export interface ByoValidationDetails {
  issues: ByoIssue[];
  warnings: ByoIssue[];
  stats: ByoUploadStats;
}

export type MultimodalCarrier = 'notice' | 'webpage' | 'email' | 'product' | 'document';

/** 自动生成题源：按风险类别、语言、数量、种子现产题目。 */
export interface MultimodalGeneratorSpec {
  categories?: string[];
  count?: number;
  language: 'zh' | 'en';
  seed?: string;
}

/** questionSetId 与 generatorSpec 二选一。 */
export interface MultimodalEvalCreateBody {
  name?: string;
  modelTargetId: string;
  questionSetId?: string;
  generatorSpec?: MultimodalGeneratorSpec;
  categories?: string[];
  attackTypes: MultimodalAttackType[];
  carriers?: MultimodalCarrier[];
  sampleCount?: number;
  seed?: string;
}

/** 带鉴权拉取多模态存证图片，返回 object URL（调用方负责 revoke）。 */
export async function fetchMultimodalImageUrl(taskId: string, resultId: string): Promise<string> {
  const res = await fetch(buildUrl(`/eval-tasks/${taskId}/results/${resultId}/multimodal-image`), {
    method: 'GET',
    headers: authHeaders('GET'),
  });
  if (res.status === 401) {
    handleUnauthorized();
    throw await parseError(res);
  }
  if (!res.ok) throw await parseError(res);
  return URL.createObjectURL(await res.blob());
}

export type EvalResultExplanationMode = 'local' | 'self' | 'review_model';

export interface EvalResultExplanation {
  source: 'local' | 'llm';
  mode: EvalResultExplanationMode;
  configured: boolean;
  riskType: string;
  ruleAction: string;
  samplePurpose: string;
  expectedBehavior: string;
  answerProblem: string;
  verdictReason: string;
  remediation: string;
  evidence: string[];
  modelTargetName?: string;
  skippedReason?: string;
}

export interface TaskLog {
  id: string;
  level: string;
  message: string;
  context: Record<string, unknown> | null;
  createdAt: string;
}

export interface RiskDistribution {
  bySeverity: Record<string, number>;
  byRiskCategory: Record<string, number>;
  byRiskDomain?: Record<string, number>;
}

export interface ReportChartDatum {
  key: string;
  label: string;
  value: number;
}

export interface ReportCharts {
  severity?: ReportChartDatum[];
  verdict?: ReportChartDatum[];
  riskCategory?: ReportChartDatum[];
  riskDomain?: ReportChartDatum[];
  engineStatus?: ReportChartDatum[];
  passRatePercent?: number | null;
}

export interface ReportExplanationRun {
  mode: 'local' | 'self' | 'review_model';
  label: string;
  modelTargetName?: string;
  attemptedCount: number;
  llmCount: number;
  fallbackCount: number;
  skippedReasons: string[];
}

export interface ReportWrongAnswerSample {
  questionContent: string;
  riskCategoryLabel: string;
  riskTypeLabel: string;
  ruleActionLabel: string;
  severityLabel: string;
  engineLabel: string;
  reason: string;
  riskExplanation: string;
}

export interface ReportRemediationItem {
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'UNKNOWN';
  title: string;
  riskCategoryLabel: string;
  evidence: string;
  action: string;
  verification: string;
  responsibility?: string;
  verificationScope?: string;
  status?: string | null;
  owner?: string | null;
  team?: string | null;
  controlLocation?: string | null;
  dueAt?: string | null;
  record?: string | null;
  retestTaskId?: string | null;
  acceptanceCriteria?: string | null;
  closureEvidence?: string | null;
  closedAt?: string | null;
}

export interface ReportRiskEvidenceSnapshot {
  engineLabel: string;
  riskCategory: string;
  riskCategoryLabel: string;
  severity: string | null;
  severityLabel: string;
  verdict: string;
  verdictLabel: string;
  title: string | null;
  evidence: string | null;
  confidence: number | null;
  evidenceStrength: string | null;
  executionOutcome: string | null;
  reviewStatus: string;
  reviewReason: string | null;
}

export interface ReportRiskEvidenceGroup {
  reviewStatus: string;
  acceptedResidualRisk: boolean;
  representative: ReportRiskEvidenceSnapshot;
  evidence: ReportRiskEvidenceSnapshot[];
}

export interface ReportRiskEvidencePortfolio {
  schemaVersion: number;
  activeRisks: ReportRiskEvidenceGroup[];
  excludedRisks: ReportRiskEvidenceGroup[];
}

export interface ReportSecurityScore {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  activeFindingCount: number;
  confirmedFindingCount: number;
  unreviewedFindingCount: number;
  needsReviewFindingCount: number;
  falsePositiveFindingCount: number;
  acceptedRiskFindingCount: number;
  skippedEngineCount: number;
  riskDeduction: number;
  reviewDeduction: number;
  coverageDeduction: number;
  totalDeduction: number;
}

export type ReportConclusionState = 'RISK_DETECTED' | 'NO_RISK_OBSERVED' | 'INCOMPLETE';

export interface ReportConclusionCounts {
  expected: number;
  observed: number;
  valid: number;
  pass: number;
  fail: number;
  activeFailCount: number;
  excludedFailCount: number;
  unexplainedFailCount: number;
  error: number;
  unknown: number;
  missingVerdict: number;
  modelCallError: number;
  engineRunTotal: number;
  engineRunFailed: number;
  engineRunSkipped: number;
  engineRunNonterminal: number;
  engineRunPartialSkip: number;
  skippedEvaluation: number;
  unobservedResult: number;
}

export interface ReportConclusionSnapshot {
  schemaVersion: number;
  policyVersion: string;
  scopeKind: 'TASK' | 'RESULT_SET' | 'ENGINE_RUN_SET';
  taskCompleted: boolean | null;
  resultDetailsAvailable: boolean;
  taskCountersMatch: boolean | null;
  missingEngineRunCount: number;
  source: 'DETERMINISTIC_RULE' | 'LEGACY_FALLBACK';
  basis: 'ACTIVE_RISK_AND_EXECUTION_COVERAGE' | null;
  state: ReportConclusionState;
  coverageComplete: boolean;
  reasonCodes: string[];
  activeRiskCount: number | null;
  counts: ReportConclusionCounts | null;
  passRate: number | null;
  validDecisionRate: number | null;
}

export interface RiskItem {
  seq: number;
  severity: string | null;
  severityLabel: string;
  riskDomain: string;
  riskDomainLabel: string;
  riskCategoryLabel: string;
  questionContent: string;
  evidence: string;
  engineLabel: string;
  riskExplanation: string;
  remediation: { action: string; verification: string };
  compliance: { gbt45654: string[]; owasp: string[] };
}
export interface RiskItemSeverityGroup {
  severity: string;
  severityLabel: string;
  items: RiskItem[];
  truncated: number;
}

export interface ReportSummary {
  endpointSummary?: EndpointTaskSummary;
  kind?: ReportKind;
  headline?: string;
  metrics?: Record<string, number | string | null>;
  totalQuestions: number;
  processedQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  wrongAnswerCount: number;
  findingCount: number;
  securityScore?: ReportSecurityScore;
  riskEvidencePortfolio?: ReportRiskEvidencePortfolio;
  conclusionSnapshot?: ReportConclusionSnapshot;
  charts?: ReportCharts;
  remediationItems?: ReportRemediationItem[];
  explanationRun?: ReportExplanationRun;
  wrongAnswerSamples?: ReportWrongAnswerSample[];
  riskItemsBySeverity?: RiskItemSeverityGroup[];
  comprehensiveModules?: Array<{
    id: ComprehensiveEvalModuleId;
    label: string;
    sampleCount: number;
    processedCount: number;
    passedCount: number;
    failedCount: number;
    errorCount: number;
  }>;
  verdictDistribution: Record<string, number>;
  severityDistribution: Record<string, number>;
}
/** 组合报告里的一个任务：生成时的快照；任务被删后 deleted 为 true，迁到别的租户后 movedOut 为 true。 */
export interface CombinedReportTask {
  id: string;
  name: string;
  deleted: boolean;
  movedOut: boolean;
  targetName: string;
  model: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  passRate: number | null;
  score: number | null;
  findingCount: number;
  riskDistribution: RiskDistribution;
}
export interface Report {
  id: string;
  tenantId?: string | null;
  /** 组合报告不挂单个任务，为空。 */
  taskId: string | null;
  title: string;
  format: string;
  kind: ReportKind;
  content: string;
  summary: ReportSummary;
  passRate: number | null;
  totalQuestions: number;
  riskDistribution: RiskDistribution;
  generatedById: string | null;
  createdAt: string;
  /** 组合报告：列表里的任务数。 */
  taskCount?: number;
  /** 组合报告：详情里的任务清单。 */
  tasks?: CombinedReportTask[];
  /** 从组合任务生成的综合检测报告：检测项数和列表标签「综合检测 · N 项」。 */
  detectItemCount?: number;
  label?: string;
}
export type ReportListItem = Omit<Report, 'content'>;

/** 报告模板（2.4.7）：证据详略 full 完整、summary 只附攻破的、none 不附。 */
export type ReportEvidenceDetail = 'none' | 'summary' | 'full';
export interface ReportTemplate {
  id: string;
  name: string;
  /** 空数组表示不限定章节（按报告原有范围）。 */
  sections: string[];
  evidenceDetail: ReportEvidenceDetail;
  coverTitle: string;
  coverKicker: string;
  organization: string;
  client: string;
  classification: string;
  headerText: string;
  footerText: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
export type ReportTemplateInput = Omit<ReportTemplate, 'id' | 'createdAt' | 'updatedAt'>;

export interface RiskGroup {
  id: string;
  tenantId?: string | null;
  title: string;
  severity: string | null;
  sampleCount: number;
  targets: { names: string[]; count: number };
  latestAt: string;
  status: '待确认' | '整改中' | '已关闭';
  suspectedFalsePositive: number;
}
export interface RiskGroupQuery {
  taskId?: string;
  tenantId?: string;
  findingIds?: string;
  agentRisk?: boolean;
  reviewStatus?: 'pending' | string[];
  status?: '待确认' | '整改中' | '已关闭' | '全部';
  severity?: string[];
  /** 风险类别（风险域编码），与首页「风险类别分布」同一套归类。 */
  domain?: string;
  /** 按任务创建时间 [since, until)（ISO 时间），与首页统计周期同口径。 */
  since?: string;
  until?: string;
  page?: number;
  pageSize?: number;
}
export interface RiskGroupDetail extends RiskGroup {
  representative: {
    id: string;
    questionContent: string;
    modelResponse: string | null;
    modelStance: 'refused' | 'complied' | 'unclear';
    modelReaction: string;
    suspectedFalsePositive: boolean;
    reason: string | null;
    sandboxBlocked: boolean;
  };
  observations: Array<{ targetName: string; createdAt: string }>;
  remediation: string[];
  findingRefs: Array<{ taskId: string; findingId: string }>;
  actionable: boolean;
  retestPlan: Array<{ taskId: string; findingId: string; questionId: string }>;
  members: Paginated<string>;
}

export interface WrongAnswer {
  id: string;
  tenantId?: string | null;
  findingId?: string | null;
  taskId: string;
  assessmentContext?: {
    target: {
      id: string;
      name: string;
      version: string;
      provider: string;
      targetType: string;
    };
    scope: {
      dimensions: string[];
      modules: string[];
      sampleSets: Array<{ id: string; name: string }>;
    };
  };
  resultId: string;
  questionId: string;
  questionContent: string;
  modelResponse: string | null;
  riskCategory: string | null;
  severity: string | null;
  verdict: string | null;
  reason: string | null;
  engine: string | null;
  reviewStatus?: string | null;
  reviewReason?: string | null;
  evidenceStrength?: string | null;
  executionOutcome?: string | null;
  remediation?: {
    title: string;
    action: string;
    verification: string;
    responsibility?: string;
    verificationScope?: string;
    status?: FindingRemediationStatus | null;
    owner?: string | null;
    team?: string | null;
    controlLocation?: string | null;
    dueAt?: string | null;
    record?: string | null;
    acceptanceCriteria?: string | null;
    retestTaskId?: string | null;
    closureEvidence?: string | null;
    closedAt?: string | null;
  };
  createdAt: string;
}

export interface LicenseRecord {
  id: string;
  subject: string | null;
  status: string;
  valid: boolean;
  reason: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  machineFingerprint: string | null;
  createdAt: string;
}
export interface LicenseInfo {
  configured: boolean;
  enforce: boolean;
  publicKeyConfigured: boolean;
  /** 公钥环（多把公钥）是否已配置；旧接口可能不返回，此时只看 publicKeyConfigured。 */
  publicKeyRingConfigured?: boolean;
  fingerprint: string;
  license: LicenseRecord | null;
}
export interface LicenseUploadResult {
  valid: boolean;
  status: string;
  reason: string | null;
  license: LicenseRecord | null;
}

export interface AccessSettings {
  encryptedLoginUrl: string;
  compatibleLoginUrl: string;
  loginPolicy: string;
  sessionPolicy: string;
}
export interface AuditSettings {
  operationAudit: boolean;
  evidenceRetention: string;
  logRedaction: string;
  retentionDays: number;
  externalArchive: boolean;
  archiveTarget: string;
}
export interface GatewaySettings {
  gatewayBaseUrl: string;
  gatewayLinkageEnabled: boolean;
  secretConfigured?: boolean;
  addressAuthorization?: 'NOT_CONFIGURED' | 'AUTHORIZED' | 'NOT_AUTHORIZED' | 'INVALID';
}
export interface RedTeamSettings {
  gatewayTargetId: string;
  attackerTargetId: string;
  secondaryAttackerTargetId: string;
  judgeTargetId: string;
  breakOn: 'verdict' | 'attitude';
  maxRounds: number;
  noProgressK: number;
  moves?: string[];
}
export interface AgentEvalSettings {
  attackerTargetId: string;
  judgeTargetId: string;
  adaptiveRounds: number;
  noProgressK: number;
  enabled: boolean;
  fanoutEnabled: boolean;
}
/** 安全设置：密码长度与强度要求、密码强制更新时间、最大非法登录次数、禁用账户时间、超时登出时间。 */
export interface SecuritySettings {
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireDigit: boolean;
  passwordRequireSpecial: boolean;
  passwordExpireDays: number;
  maxFailedLoginAttempts: number;
  lockoutMinutes: number;
  idleTimeoutMinutes: number;
  /** 操作日志查看范围：管理员和审计员 / 仅平台管理员。 */
  auditLogAccess: 'admins_and_auditors' | 'system_admin_only';
  /** 管理员新建、重置密码的用户和新建租户的首个管理员，首次登录须先改密。 */
  forcePasswordChangeOnFirstLogin: boolean;
  /** 是否开放登录页自助注册。 */
  registrationEnabled: boolean;
  /** 自助注册用户归属的租户；为空时归平台租户。 */
  registrationTenantId: string | null;
}
/** 注册页要显示的密码规则（不含密码过期等其他配置）。 */
export type PasswordRulePolicy = Pick<
  SecuritySettings,
  | 'passwordMinLength'
  | 'passwordRequireUppercase'
  | 'passwordRequireLowercase'
  | 'passwordRequireDigit'
  | 'passwordRequireSpecial'
>;
/** 登录页免登录读取的平台信息：访问量、下载量（今日与累计）、注册开关；开放注册时带密码规则。 */
export interface LoginStats {
  visits: { today: number; total: number };
  downloads: { today: number; total: number };
  registrationEnabled: boolean;
  passwordPolicy?: PasswordRulePolicy | null;
}
export interface RegisterBody {
  username: string;
  displayName: string;
  phone: string;
  organization: string;
  password: string;
}
export type PasswordPolicy = Pick<
  SecuritySettings,
  | 'passwordMinLength'
  | 'passwordRequireUppercase'
  | 'passwordRequireLowercase'
  | 'passwordRequireDigit'
  | 'passwordRequireSpecial'
  | 'passwordExpireDays'
>;
/** 租户信息设置：平台logo、页签logo（PNG/JPG/ICO/WEBP data URL，空串为默认）与平台标题。 */
export interface TenantSettings {
  platformTitle: string;
  platformLogo: string;
  tabLogo: string;
  /** 技术支持单位与联系人，空串为不展示。 */
  supportOrg: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
}
/** 配置管理：评估维度权重占比、单次评估题数、评估分数权重占比（百分比，各组合计 100）。 */
export interface EvaluationSettings {
  dimensionWeights: Record<'COMPLIANCE' | 'PROMPT_INJECTION' | 'SHOULD_REFUSE' | 'GENERAL', number>;
  questionCount: number;
  scoreWeights: Record<'passRate' | 'severity', number>;
}
export interface TaskWeightedScore {
  /** 评估不完整时为 null，不输出数字。 */
  score: number | null;
  judgedCount: number;
  /** 评估不完整（存在未判定/异常/跳过引擎，或任务未跑完）；缺省按完整处理（兼容旧后端）。 */
  incomplete?: boolean;
  dimensions: Array<{
    dimension: 'COMPLIANCE' | 'PROMPT_INJECTION' | 'SHOULD_REFUSE' | 'GENERAL';
    total: number;
    passRateScore: number;
    severityScore: number;
    score: number;
    effectiveWeight: number;
  }>;
}
export interface SystemSettings {
  access: AccessSettings;
  audit: AuditSettings;
  gateway: GatewaySettings;
  redteam: RedTeamSettings;
  agent_eval: AgentEvalSettings;
  security?: SecuritySettings;
  tenant?: TenantSettings;
  evaluation?: EvaluationSettings;
  data_security?: DataSecuritySettings;
  updatedAt: Record<'access' | 'audit' | 'gateway' | 'redteam' | 'agent_eval', string | null> &
    Partial<Record<'security' | 'tenant' | 'evaluation' | 'data_security', string | null>>;
}
/** 数据安全：敏感信息默认脱敏、下载文件水印、前端页面水印（默认全部开启）。 */
export interface DataSecuritySettings {
  maskSensitive: boolean;
  downloadWatermark: boolean;
  pageWatermark: boolean;
}
export interface DataSecurityStatus extends DataSecuritySettings {
  /** 当前用户是否拥有「查看敏感信息明文」权限。 */
  canViewPlain: boolean;
}

export type SystemSettingsUpdate = Partial<{
  access: Partial<AccessSettings>;
  audit: Partial<AuditSettings>;
  gateway: Partial<GatewaySettings>;
  redteam: Partial<RedTeamSettings>;
  agent_eval: Partial<AgentEvalSettings>;
  security: Partial<SecuritySettings>;
  tenant: Partial<TenantSettings>;
  evaluation: Partial<EvaluationSettings>;
  data_security: Partial<DataSecuritySettings>;
}>;

export interface User {
  id: string;
  tenantId?: string | null;
  username: string;
  displayName: string;
  email: string | null;
  /** 自助注册填写的手机号与单位。 */
  phone?: string | null;
  organization?: string | null;
  /** 所属组织（组织架构）与路径「总部 / 研发中心」；和上面自助注册填的「单位」无关。 */
  organizationId?: string | null;
  organizationPath?: string | null;
  registrationStatus?: RegistrationStatus;
  isActive: boolean;
  isBuiltin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  roles: Array<{ id: string; name: string }>;
}

export type RegistrationStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
  userCount: number;
  permissions: string[];
}

export interface SystemStatus {
  cpu: { cores: number; load1: number; load5: number; usagePercent: number };
  memory: { total: number; used: number };
  disks: Array<{ mount: string; total: number; used: number }>;
  uptimeSeconds: number;
  checkedAt: string;
  dependencies: { database: 'ok' | 'error'; redis: 'ok' | 'error' };
}

export interface RoleUser {
  id: string;
  username: string;
  displayName: string;
  tenantName: string;
  isActive: boolean;
}

export interface AuditLog {
  id: string;
  tenantId?: string | null;
  actorId: string | null;
  actorName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface StandardProfile {
  id: string;
  number: string;
  version: string;
  title: string;
  scope: string;
  clauses: Array<{ id: string; level: string; source: string; summary: string }>;
  sampling: Record<string, number>;
  limits: Record<string, string>;
}

export interface StandardBankRelease {
  id: string;
  profileId: string;
  profileVersion: string;
  name: string;
  language: string;
  modalities: string[];
  status: string;
  counts: Record<string, number> | null;
  validation: {
    ok?: boolean;
    errors?: string[];
    warnings?: string[];
    fixtureOnly?: boolean;
  } | null;
  overallHash: string | null;
  publishedAt: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StandardMetricResult {
  group: string;
  numerator: number;
  denominator: number;
  planned: number;
  ratioPercent: number | null;
  threshold: { operator: '>=' | '<='; percent: number };
  conclusion: 'ATTAINED' | 'NOT_ATTAINED' | 'INSUFFICIENT_EVIDENCE';
}

export interface StandardSummary {
  runId: string;
  status: string;
  evidenceCompleteness: string;
  conclusion: string;
  metrics: {
    complete: boolean;
    overallConclusion: string;
    groups: Record<string, StandardMetricResult>;
  };
  progress?: { processed: number; total: number; ratio: number };
  coverage?: StandardComplianceCoverage | null;
  formulaVersion: string;
  trainingData: string;
  scope: string;
}

export interface StandardRunListItem {
  runId: string;
  taskId: string;
  name: string;
  status: string;
  conclusion: string;
  evidenceCompleteness: string;
  bankReleaseName: string;
  modelTargetName: string | null;
  modelName: string | null;
  sampleCount: number;
  reportCount: number;
  processedCount: number;
  createdBy: string | null;
  createdAt: string;
}

export interface StandardComplianceCoverage {
  produced: Record<string, number>;
  requested: Record<string, number>;
  coveredCategories: string[];
  missingCategories: string[];
  missingCoreCategories: string[];
  coveredTopics: string[];
  missingTopics: string[];
}

export interface StandardComplianceCreated {
  taskId: string;
  runId: string;
  name: string;
  seed: string;
  sampleCount: number;
  selectedCounts: Record<string, number>;
  samplePlanHash: string;
  coverage: StandardComplianceCoverage;
}

export interface StandardJudgmentRecord {
  id: string;
  source: string;
  safetyOutcome: string | null;
  refusalOutcome: string | null;
  qualityOutcome: string | null;
  reason: string | null;
  evidence: string | null;
  createdAt: string;
}

export interface StandardReviewItem {
  id: string;
  group: string;
  sequence: number;
  inputSnapshot: string;
  expectedBehavior: string | null;
  primaryCategory: string | null;
  nonRefusalTopic: string | null;
  responseStatus: string;
  selectedResponse: string | null;
  judgments: StandardJudgmentRecord[];
}

export interface StandardPreflightResult {
  ok: boolean;
  blocking: boolean;
  mode: string;
  target: { id: string; name: string; provider: string; model: string };
  scope: { language: string; modalities: string[]; boundary?: string };
  counts: Record<string, number>;
  available: Record<string, number>;
  shortages: Array<{ group: string; count: number; bankType: string }>;
  validation: { ok?: boolean; errors?: string[]; warnings?: string[]; fixtureOnly?: boolean };
  noExternalCalls: boolean;
}

// GB/T 45654—2025 第 5.2 条与附录 B.2.2 方法（人工抽检、技术抽检、应拒答题拒答率、非拒答题误拒率）与第 6 章措施核验。
export interface GbtMethodView {
  id: 'manual' | 'technical' | 'refusal' | 'false_refusal';
  clauseId: string;
  label: string;
  ratioName: string;
  verdict: string;
  verdictLabel: string;
  tested: number;
  hits: number;
  invalid: number;
  minSamples: number;
  shortfall: number;
  ratioPercent: number | null;
  threshold: { op: '>=' | '<='; percent: number };
  unavailable: string | null;
  note: string;
  /** 细分状态：conform、nonconform、short_samples、pending_manual（待人工抽检）、judge_fault、judging、incomplete、unavailable。 */
  status?: string;
  statusLabel?: string;
  /** 本次抽样名单里该方法能用的题数。 */
  planned?: number;
  /** 已取得回答但还没有有效判定的题数。 */
  unjudged?: number;
  /** 其中由规则临时判定的题数。 */
  ruleTemporary?: number;
  /** 依据条款（整句中文，小字展示）。 */
  basis?: string;
  /** 拒答类方法的裁判模型（或规则）预判，只供参考；其他方法为 null。 */
  prejudge?: { tested: number; hits: number; ratePercent: number | null } | null;
}

export interface GbtStateView {
  runId: string;
  taskId: string;
  status: string;
  seed: string;
  samplePlanHash: string;
  shortages: Array<{ bank: string; bankLabel: string; requested: number; selected: number; missing: number }>;
  banks: Array<{ bank: string; label: string; version: string | null; sha256: string | null; total: number; selected: number }>;
  methods: GbtMethodView[];
  /** 整体一句话：自动化方法、人工抽检各到哪一步。 */
  headline?: { text: string; tone: 'ok' | 'bad' | 'warn' };
  progress: Array<{
    id: GbtMethodView['id'];
    planned: number;
    done: number;
    label: string;
    status: 'not_started' | 'running' | 'incomplete' | 'done' | 'unavailable';
  }>;
  manual: {
    total: number;
    decided: number;
    pass: number;
    fail: number;
    pending: number;
    conflict: number;
    doubleReviewed: number;
    doubleAgreed: number;
    /** 技术抽检与人工的一致率。 */
    technicalAgreement: { compared: number; agreed: number; ratePercent: number | null };
  };
  /** 拒答两项的人工抽检进度。 */
  refusalManual?: {
    refusal: { total: number; decided: number; refused: number; notRefused: number; pending: number; conflict: number };
    false_refusal: { total: number; decided: number; refused: number; notRefused: number; pending: number; conflict: number };
  };
  /** 技术抽检构成：用到哪几种技术，关键词初筛命中、分类模型判出、技术抽检不合格（merged）、只有关键词命中而排进人工优先复核（keywordOnly）的题数。 */
  technical?: {
    mode: 'both' | 'keyword_only' | 'classifier_only' | 'none';
    keywordUnsafe: number;
    classifierUnsafe: number;
    merged: number;
    keywordOnly?: number;
    text: string;
  };
  keyword: { approved: number; pending: number; pendingHitSamples: number; unavailable: string | null };
  annexItems: Array<{ code: string; name: string; tested: number; failed: number; verdict: string; verdictLabel: string; note: string }>;
  clauses: Array<{ clauseId: string; title: string; verdict: string; verdictLabel: string; note: string }>;
  /** 被测模型没有给出回答（调用失败、超时）的题数。 */
  failedSamples?: number;
  /** 判定状态：后台补跑中、仍在取样（边取边判）、已取得回答但还没有判定的条数。 */
  judging?: {
    running: boolean;
    collecting: boolean;
    unjudged: number;
    /** 裁判模型故障：没有故障为 null。 */
    fault?: { reason: string; since: string } | null;
  };
}

/** 人工抽检结论：生成内容题 PASS/FAIL，应拒答与非拒答题 REFUSED/NOT_REFUSED。 */
export type GbtReviewVerdict = 'PASS' | 'FAIL' | 'REFUSED' | 'NOT_REFUSED';

export interface GbtReviewItem {
  sampleId: string;
  sequence: number;
  group: 'MANUAL_SAFETY' | 'SHOULD_REFUSE' | 'NON_REFUSAL';
  groupLabel: string;
  question: string;
  response: string;
  classifier: { label: string | null; reason: string | null; safe: boolean | null } | null;
  annexItem: string | null;
  /** 拒答类题目的模型预判；生成内容题为 null。 */
  modelJudgment: { refused: boolean | null; by: 'judge' | 'rule' | null; reason: string | null } | null;
  /** 重点复核：关键词命中、分类模型判合格（技术抽检不计不合格，交人工下结论）；terms 为命中的生效词。 */
  priority?: { terms: string[] } | null;
  mine: { verdict: string; itemCode: string | null; note: string | null; at: string } | null;
  others: Array<{ slot: number; reviewerName: string; verdict: string; itemCode: string | null }>;
  status: string;
  statusLabel: string;
}

export interface GbtReviewBatchResult {
  results: Array<{ sampleId: string; ok: boolean; code?: string; error?: string }>;
  succeeded: number;
  failed: number;
}

export interface GbtJudgeStatus {
  configured: boolean;
  id: string | null;
  name: string | null;
  model: string | null;
  lastTestStatus: string | null;
  lastTestedAt: string | null;
  sameAsTarget: boolean;
  source: 'model_target' | 'env' | null;
}

export interface GbtMeasureItem {
  clauseId: string;
  title: string;
  ref: string;
  requirement: string;
  kind: 'PROBE' | 'FORM';
  hasEvidence: boolean;
  evidence: unknown;
  /** 平台取证类的自动结论：conform 符合、observe 提示项、none 没取得结果；填报类为 null。 */
  finding: { status: 'conform' | 'observe' | 'none'; text: string; advice: string | null } | null;
  verdict: string | null;
  note: string | null;
  materials: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
}

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

export type EnhanceMode = 'rewrite' | 'induce' | 'variant';
export type EnhanceIntensity = 1 | 2 | 3;

export interface EnhanceSpec {
  mode: EnhanceMode;
  intensity: EnhanceIntensity;
  language?: string;
  sampleLimit?: number;
}

export interface GeneratorEnhancementResponse {
  configured: boolean;
  requested: number;
  applied: number;
  failed: number;
  skippedReason: 'not_requested' | 'not_configured' | null;
}

export interface EnhancedGeneratorSample {
  before: string;
  after: string;
}

export interface GeneratorRequestBase {
  types: string[];
  categories?: string[];
  language?: string;
  count: number;
  variantStrength?: 0 | 1 | 2 | 'auto';
  seed?: string;
  dedupe?: boolean;
  enhance?: EnhanceSpec;
}

export interface GeneratorPreviewBody extends GeneratorRequestBase {}

export interface GeneratorGenerateBody extends GeneratorRequestBase {
  name: string;
  description?: string;
}

export interface GeneratorDiversityDatum {
  key: string;
  label: string;
  count: number;
}

export interface GeneratorDiversitySummary {
  languages: GeneratorDiversityDatum[];
  variants: GeneratorDiversityDatum[];
  riskDomains: GeneratorDiversityDatum[];
}

export interface GeneratorSample {
  content: string;
  type: string;
  category: string;
  language: string;
  severity: string;
  shouldRefuse: boolean;
  tags: string[];
  variantId?: string;
  riskDomain?: string;
}

export interface GeneratorPreviewResult {
  requested: number;
  produced: number;
  capacityCeiling: number;
  samples: GeneratorSample[];
  enhancement?: GeneratorEnhancementResponse;
  enhancedSamples?: EnhancedGeneratorSample[];
  diversity?: GeneratorDiversitySummary;
}

export interface GeneratorGenerateResult {
  questionSetId: string;
  requested: number;
  produced: number;
  capacityCeiling: number;
  seed: string;
  enhancement?: GeneratorEnhancementResponse;
  diversity?: GeneratorDiversitySummary;
}

export type CustomerDataFieldKind =
  | 'api_key'
  | 'jwt'
  | 'password'
  | 'phone'
  | 'email'
  | 'person_name'
  | 'id_card'
  | 'bank_card'
  | 'address'
  | 'salary'
  | 'contract_amount'
  | 'medical_record'
  | 'customer_id'
  | 'internal_doc'
  | 'custom';

export interface CustomerDataFieldSpec {
  key: string;
  label: string;
  kind: CustomerDataFieldKind;
  description?: string;
  examples?: string[];
  sensitivity?: string;
}

export interface CustomerDataGeneratorBody {
  datasetName: string;
  fields: CustomerDataFieldSpec[];
  count: number;
  seed?: string;
  language?: 'zh' | 'en';
  scenarios?: string[];
}

export interface CustomerDataGenerateBody extends CustomerDataGeneratorBody {
  name: string;
  description?: string;
}

export interface CustomerDataGeneratorSample extends GeneratorSample {
  expectedBehavior?: string | null;
  referenceAnswer?: string | null;
  externalId?: string;
  variantId?: string;
  riskDomain?: string;
  metadata?: Record<string, unknown>;
}

export interface CustomerDataGeneratorResult {
  questionSetId?: string;
  requested: number;
  produced: number;
  capacityCeiling: number;
  seed?: string;
  samples?: CustomerDataGeneratorSample[];
  diversity?: GeneratorDiversitySummary & {
    scenarios?: GeneratorDiversityDatum[];
    fieldKinds?: GeneratorDiversityDatum[];
  };
}

export interface BenchmarkFormat {
  id: string;
  label: string;
  description: string;
  inputKind: 'json' | 'jsonl' | 'csv';
  origin?: string;
  typicalFiles?: string;
  expectedHeaders?: string;
  licenseNote?: string;
  usageNote?: string;
}

export interface BenchmarkSample {
  id: string;
  label: string;
  description: string;
  formatId: string;
  license: string;
  itemCount: number;
}

export interface EngineCatalogItem {
  engine: string;
  kind: 'per-question' | 'task-level';
  builtin: boolean;
  available: boolean;
  label: string;
  description: string;
}

export interface EngineScanResult {
  runId: string;
  status: string;
  normalizedCount: number;
  message: string | null;
}

export interface EngineFinding {
  id: string;
  taskId: string;
  engine: string;
  riskCategory: string;
  severity: string;
  verdict: string;
  title: string | null;
  evidence: string | null;
  detail: unknown;
  createdAt: string;
}

export interface EngineRunSummary {
  id: string;
  taskId: string;
  engine: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  normalizedCount: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AiAssetStaticFile {
  path: string;
  content: string;
}

export interface AiAssetStaticScanBody {
  taskId: string;
  assetType: 'SKILL' | 'MCP_SERVER';
  source?: string;
  files: AiAssetStaticFile[];
}

export interface RelayAuditBody {
  taskId: string;
  algorithm?: 'quick' | 'full';
}

export type AgentEvalLevel = 'smoke' | 'standard' | 'deep' | 'adversarial';

export type AgentRiskSurface =
  | 'ssrf'
  | 'secret_read'
  | 'file_read'
  | 'dangerous_command'
  | 'data_exfiltration'
  | 'indirect_prompt_injection'
  | 'tool_argument_bypass';

export type AgentAttackTechnique =
  | 'boundary_reframe'
  | 'task_splitting'
  | 'payload_smuggling'
  | 'argument_obfuscation'
  | 'tool_substitution'
  | 'authority_override';

export interface AgentEvalStrengthConfig {
  level: AgentEvalLevel;
  label: string;
  defaultSampleCount: number;
  minSampleCount: number;
  maxSampleCount: number;
  maxTurns: number;
  variantDepth: number;
  riskSurfaces: AgentRiskSurface[];
  techniques: AgentAttackTechnique[];
  adaptiveRounds: number;
}

export interface AgentEvalRunBody {
  modelTargetId: string;
  level?: AgentEvalLevel;
  sampleCount?: number;
  seed?: string;
  riskSurfaces?: AgentRiskSurface[];
  packIds?: string[];
  techniques?: string[];
  maxConcurrency?: number;
  timeoutMs?: number;
  saveQuestionSet?: boolean;
  adaptiveOverride?: { enabled: boolean; rounds?: number; attackerTargetId?: string };
  /** 追加四类沙箱场景（目标劫持 / 伪造记忆 / 失败连锁调用 / 越权调用）。 */
  agenticScenarios?: boolean;
  /** 追加高风险操作人工介入场景（13 个，agentsec.high-risk-hitl）。 */
  hitlScenarios?: boolean;
}

export interface AgentEvalPreviewBody {
  level?: AgentEvalLevel;
  sampleCount?: number;
  seed?: string;
  riskSurfaces?: AgentRiskSurface[];
  packIds?: string[];
  maxConcurrency?: number;
  timeoutMs?: number;
}

export interface AgentEvalSample {
  id: string;
  prompt: string;
  type: string;
  category: string;
  severity: string;
  shouldRefuse: boolean;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface AgentEvalPreviewResult {
  samples: AgentEvalSample[];
  strength: AgentEvalStrengthConfig;
  sampleCount: number;
  seed: string;
  riskSurfaces: AgentRiskSurface[];
  packIds: string[];
  maxConcurrency: number;
  timeoutMs: number | null;
}

export interface AgentEvalRunResult {
  taskId: string;
  questionSetId: string;
  level: AgentEvalLevel;
  sampleCount: number;
  seed: string;
  riskSurfaces: AgentRiskSurface[];
  saveQuestionSet: boolean;
  attackPackVersion: string;
  packIds: string[];
  maxConcurrency: number;
  timeoutMs: number | null;
}

export interface AgentEvalTechniqueMeta {
  id: string;
  level: string;
  label: string;
  description: string;
}

export interface AgentEvalConfig {
  techniques: AgentEvalTechniqueMeta[];
  adaptive: {
    enabled: boolean;
    defaultRounds: number;
    defaultAttackerTargetId: string;
    judgeTargetId: string;
    noProgressK: number;
  };
}

export interface AgentAttackPackSummary {
  id: string;
  version: string;
  templateCount: number;
  riskSurfaces: AgentRiskSurface[];
  sourceRefs: string[];
  updatedAt?: string | null;
  templates: Array<{ id: string; riskSurface: AgentRiskSurface; severity: string; source: string }>;
}

export interface AgentFanoutFinding {
  channel:
    | 'html_body'
    | 'html_comment'
    | 'markdown_link'
    | 'csv_header'
    | 'json_field'
    | 'http_header'
    | 'rss_item'
    | 'multilingual';
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR';
  trifectaTags: {
    privilegedAccess: boolean;
    untrustedInput: boolean;
    exfilCapable: boolean;
  };
  lethal: boolean;
  score: number;
  exfilHits: number;
  evidence: string;
  turns?: number;
}

export interface AgentFanoutRunBody {
  modelTargetId: string;
  secretHint?: string;
  benignTaskZh?: string;
}

export interface AgentFanoutRunResult {
  runToken: string;
  /** 落库后的评估任务 id（可跳转详情页 / 生成报告）；落库失败时缺省。 */
  taskId?: string;
  findings: AgentFanoutFinding[];
  failedChannels: string[];
}

export interface AdrTraceImportSummary {
  entryCount: number;
  messageCount: number;
  toolCallCount: number;
  findingCount: number;
  riskSessionCount: number;
  passedSessionCount: number;
  failedFindingCount: number;
  reviewFindingCount: number;
  truncatedSessionCount: number;
}

export interface AdrTraceImportBody {
  modelTargetId: string;
  name?: string;
  payload: unknown;
}

export interface AdrTraceImportResult {
  taskId: string;
  summary: AdrTraceImportSummary;
}

export interface GatewayDrillArtifact {
  channel: string;
  title: string;
  content: string;
}
export interface GatewayDrillScenario {
  canaryToken: string;
  collectorUrl: string;
  artifacts: GatewayDrillArtifact[];
  successSignal: string;
  gatewayRule: { ruleType: string; pattern: string; action: string; name: string };
}
export interface GatewayDrillPrepareResult {
  drill: GatewayDrillScenario;
  hint: string;
}

export interface GatewayLogAnalysisBody {
  modelTargetId: string;
  name?: string;
  startTime: string;
  endTime: string;
  evalRunId?: string;
  taskId?: string;
  sampleId?: string;
  traceId?: string;
  clientId?: string;
  sourceIp?: string;
  canaryTokens?: string[];
}

export interface GatewayLogAnalysisSummary {
  totalEvents: number;
  passedEvents: number;
  riskEvents: number;
  blockedEvents: number;
}

export interface GatewayLogAnalysisResult {
  task: {
    id: string;
    name: string;
    status: string;
    modelTargetId: string;
    totalQuestions: number;
    processedQuestions: number;
    passedCount: number;
    failedCount: number;
    errorCount: number;
    progress: number;
    startedAt: string | null;
    finishedAt: string | null;
  };
  summary: GatewayLogAnalysisSummary;
  findingCount: number;
}

// ---- 态势概览（GET /api/dashboard/overview）----
export type RiskLevelKey = 'HIGH' | 'MEDIUM' | 'LOW';
export type ReadinessState = 'done' | 'active' | 'pending' | 'failed' | 'warn';
export interface DashboardOverview {
  period: 'month' | '7d' | 'all';
  periodStart: string | null;
  counts: {
    taskTotal: number;
    periodTaskCount: number;
    modelTargetCount: number;
    /** 自有样本库套数（与样本库页「自有样本库」同口径，不含运行记录）。 */
    ownQuestionSetCount: number;
    /** 运行记录条数（评估任务运行时自动落库的快照）。 */
    runQuestionSetCount?: number;
    /** 当前用户可见的工具数；没有 tool:read 时为 null。 */
    tools?: number | null;
  };
  categories: Array<{ category: string; label: string; count: number }>;
  riskDistribution: Record<RiskLevelKey, number>;
  taskStatus: Array<{ status: string; count: number }>;
  taskTrend: Array<{ date: string; created: number; completed: number; failed: number }>;
  recentTasks: Array<{
    id: string;
    tenantId?: string | null;
    name: string;
    category: string;
    categoryLabel: string;
    status: string;
    modelName: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  readiness: Array<{
    taskId: string;
    taskName: string;
    modelName: string;
    modelTargetId: string | null;
    /** 评估对象接入状态：failed 计入接入异常；untested 为待测试。 */
    connectionState: 'ok' | 'failed' | 'untested' | 'inactive' | null;
    startStatus: string;
    runStatus: string;
    stages: Array<{ key: string; label: string; state: ReadinessState; detail: string }>;
  }>;
  /** 接入异常（按不重复评估对象，与待办同口径）；无 model_target:read 时为 null。 */
  connectionIssues: { count: number; untestedCount: number } | null;
  topHighRiskTasks: Array<{
    id: string;
    name: string;
    status: string;
    modelName: string | null;
    createdAt: string;
    highRiskCount: number;
    mediumRiskCount: number;
    lowRiskCount: number;
    /** 综合评估得分；评估不完整的任务为 null。 */
    evalScore: number | null;
  }>;
}

// ---- 态势概览新接口（posture / trend / risk-categories / changes）----
export type DashboardRange = 'month' | '7d' | 'all';
export type PostureRiskLevel = 'HIGH' | 'MEDIUM_HIGH' | 'MEDIUM' | 'LOW' | 'UNRATED';
export type SeverityCounts = Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO', number>;
/** 首页「规则库」统计：按租户范围计数（含平台内置），不随统计周期变化。 */
export interface RuleLibraryStats {
  questionSets: number;
  questions: number;
  keywords: number;
  agentSamples: number;
}
export interface DashboardPosture {
  /** 所选周期的起点（ISO）；「全部」为 null。下钻到风险处置台时作为 since。 */
  periodStart?: string | null;
  riskLevel: PostureRiskLevel;
  riskLevelLabel: string;
  /** 综合评分；无法评分时为 null（此时不画评分环）。 */
  score: number | null;
  levelBasis: string | null;
  fewValid: boolean;
  severityCounts: SeverityCounts;
  facts: {
    tasksInitiated: number;
    tasksCompleted: number;
    findingTotal: number;
    activeFindingTotal: number;
    falsePositiveExcluded: number;
    /** 含严重 */
    highCount: number;
    criticalCount: number;
    pendingReview: number;
    pendingReviewTotal: number;
    testItems: number;
    validJudgements: number;
  };
}
export interface DashboardTrend {
  days: number;
  timezone: string;
  points: Array<{ date: string; findings: number; high: number; pendingReview: number }>;
}
export interface DashboardRiskCategories {
  /** 所选周期的起点（ISO）；「全部」为 null。 */
  periodStart?: string | null;
  total: number;
  categoryCount: number;
  items: Array<{
    key: string;
    label: string;
    count: number;
    high: number;
    severity: Partial<SeverityCounts>;
  }>;
}
export interface DashboardChanges {
  newFindings: { current: number | null; previous: number | null; delta: number | null } | null;
  /** 0–1 小数 */
  highShare: { current: number | null; previous: number | null; delta: number | null } | null;
  avgReviewHours: {
    current: number | null;
    previous: number | null;
    sampleSize?: { current: number; previous: number } | null;
    unavailableReason?: string | null;
  } | null;
  previousUnavailableReason?: string | null;
}

/** 内置题库统计（GET /api/question-sets/builtin/stats，由题库工作流提供）。 */
/** 态势概览使用的内置题库统计，与 BuiltinBankStats 同一契约。 */
export type BuiltinQuestionStats = BuiltinBankStats;

/** 多模型对比分析中的单个任务。 */
export interface EvalCompareDifference extends EvalDifferenceHint {
  taskId: string;
  baselineTaskId: string;
}

export interface EvalCompareItem {
  id: string;
  name: string;
  status: string;
  batchId: string | null;
  modelName: string;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  processedQuestions: number;
  totalQuestions: number;
  passRate: number | null;
  evalScore: number | null;
  riskLevels: { HIGH: number; MEDIUM: number; LOW: number };
  statistics?: EvalTaskStatistics;
  categories: Array<{ category: string; passed: number; failed: number; passRate: number | null }>;
}

/** AI 应用组件安全统计（服务核验真实数据）。 */
export interface ComponentSecurityStats {
  componentCount: number;
  vulnerabilityCount: number;
  baselineIssueCount: number;
  runCount: number;
}
export interface DashboardTodos {
  review: {
    /** 待复核合计（与首页「待复核」、风险处置台同一口径）。 */
    count: number;
    /** 最近 10 条风险项（兼容旧版，新页面请用 tasks）。 */
    items: Array<{
      id: string;
      tenantId?: string | null;
      taskId: string;
      taskName: string;
      title: string | null;
      severity: string | null;
      createdAt: string;
    }>;
    /** 按任务分组，count 是该任务真实待复核数；后端不返回时前端回退到 items 合并。 */
    tasks?: Array<{
      taskId: string;
      tenantId?: string | null;
      taskName: string;
      count: number;
      topSeverity: string | null;
      latestAt: string | null;
      titles: string[];
    }>;
    /** 有待复核的任务总数（分页用）。 */
    taskTotal?: number;
    taskPage?: number;
    taskPageSize?: number;
  };
  remediation: {
    count: number;
    items: Array<{
      id: string;
      tenantId?: string | null;
      taskId: string;
      taskName: string;
      title: string | null;
      severity: string | null;
      dueAt: string;
      overdue: boolean;
    }>;
  };
  connection: {
    count: number;
    items: Array<{
      targetId: string;
      tenantId?: string | null;
      targetName: string;
      active: boolean;
      lastTestStatus: string | null;
      lastTestedAt: string | null;
    }>;
  };
  /** 门禁未过：仅 gate:read / gate:manage 可见（planning=true）；无权限时为空。 */
  gate: { count: number; items: FailingGateItem[] };
  gates: { remediation: boolean; connection: boolean; planning: boolean };
  /** 模型文件扫描发现（中危及以上）的待复核 / 临期整改 */
  modelFile?: {
    reviewCount: number;
    remediationCount: number;
    items: Array<{
      id: string;
      scanId: string;
      filePath: string;
      title: string;
      severity: string;
      remediationDueAt: string | null;
      reviewStatus: string;
      overdue: boolean;
    }>;
  };
}

export interface EndpointInfo {
  endpoint_id: string;
  hostname: string;
  os: string;
  owner_display?: string | null;
  department?: string | null;
  last_seen_at?: string | null;
  eval_runner_version: string | null;
  agents: Array<{
    product: FleetLiveProduct;
    version?: string | null;
    headless_capable: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// 自管终端（fleet）：本平台自己签发接入码、接收探针、发起真机测评
// ---------------------------------------------------------------------------

export type FleetJobStatus =
  | 'PENDING_APPROVAL'
  | 'QUEUED'
  | 'DELIVERED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface FleetUserRef {
  id: string;
  username: string;
  displayName?: string | null;
}

/** 前端用的开关状态：后端没有单独的 config 接口，由探测 /fleet/endpoints 得出（404 即未启用）。 */
export interface FleetConfig {
  enabled: boolean;
}

export interface FleetEnrollmentCodeCreateBody {
  label: string;
  /** 有效期（小时），1-168，默认 24。 */
  expiresInHours?: number;
  /** 可接入终端数，1-1000，默认 1。 */
  maxUses?: number;
}

export type FleetCodeStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'EXHAUSTED';

export interface FleetEnrollmentCode {
  id: string;
  label: string;
  codePrefix: string;
  maxUses: number;
  usedCount: number;
  remainingUses: number;
  endpointCount: number;
  status: FleetCodeStatus;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  createdBy: FleetUserRef | null;
}

export interface FleetEnrollmentCodeCreated {
  /** 接入码明文，仅创建响应里出现一次。 */
  code: string;
  notice: string;
  item: FleetEnrollmentCode;
}

export interface FleetJob {
  id: string;
  tenantId?: string | null;
  publicId: string;
  endpointId: string;
  endpoint: { id: string; publicId: string; hostname: string } | null;
  evalTaskId: string | null;
  product: FleetLiveProduct;
  checksum: string;
  scenarioCount: number;
  sampleCount?: number | null;
  suite?: 'classic' | 'runtime_v2' | null;
  status: FleetJobStatus;
  statusLabel: string;
  reason: string;
  rejectReason: string | null;
  errorCode: string | null;
  errorReason?: string | null;
  requestedBy: FleetUserRef | null;
  approvedBy: FleetUserRef | null;
  approvedAt: string | null;
  deadline: string | null;
  deliveredAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface FleetEndpointAgent {
  product: string;
  displayName?: string;
  version: string | null;
  headlessCapable?: boolean;
  liveEvalSupported?: boolean;
  liveEvalRegistered?: boolean;
  liveEvalBlockedReason?: string;
  /** 仅 claude-code：终端心跳上报了 eval_sandbox_v2，可以发起运行态测评；旧后端不返回该字段。 */
  runtimeV2?: boolean;
  /** 配置体检任务创建时保存的配置读取状态；旧任务没有该字段，页面显示“任务未记录”。 */
  config?: {
    state: Exclude<
      import('../../../../packages/shared/src/endpoint-overview').EndpointAgentRow['configState'],
      'unrecorded'
    >;
    items: import('../../../../packages/shared/src/endpoint-overview').EndpointAgentRow['configItems'];
    note: string | null;
  };
  /** 安装位置（主目录相对路径）与所属账号，用于区分同一产品的多处安装。 */
  location?: string;
  account?: string;
}

export interface FleetLatestReport {
  reportId: string;
  scannedAt: string | null;
  status: string;
  assetCount: number;
}

export interface FleetEndpoint {
  id: string;
  tenantId?: string | null;
  publicId: string;
  platform: 'jiandun';
  hostname: string;
  os: string;
  osVersion: string;
  arch: string;
  osUser: string;
  agentVersion: string;
  capabilities: string[];
  status: 'ACTIVE' | 'REVOKED';
  online: boolean;
  lastSeenAt: string | null;
  evalRunner: string | null;
  /** 终端上已装的智能体；当前采集器未上报时为空数组。 */
  agents: FleetEndpointAgent[];
  registeredAt: string | null;
  revokedAt: string | null;
  /** 责任人；未设置为 null（旧接口可能没有这个字段）。 */
  owner?: FleetEndpointOwner | null;
  enrollmentCode: { id: string; label: string; codePrefix: string } | null;
  latestReport: FleetLatestReport | null;
}

export interface FleetEndpointDetail extends FleetEndpoint {
  machineId: string;
  installationId: string;
  /** 最近一次上报的主机快照；没有上报时为 null，旧接口没有该字段。 */
  hardware?: import('../../../../packages/shared/src/endpoint-hardware').EndpointHardware | null;
  health: {
    queue_events?: number;
    queue_bytes?: number;
    dropped_events?: number;
    last_upload_error?: string;
    capabilities?: Record<string, string>;
    collector?: {
      last_error?: string;
      last_eval_job_error?: string;
      last_scan_at?: string;
      assets_observed?: number;
      source_revision?: string;
    };
  } | null;
  latestReportSummary:
    | (FleetLatestReport & {
        assetsByKind: Record<string, number>;
        agents: Array<{ name: string; kind: string; version: string | null }>;
        collectors: Array<{ name: string; status: string; errorCode: string | null }>;
        staticFindings: { high: number; medium: number; info: number };
      })
    | null;
  recentJobs: FleetJob[];
}

export interface FleetPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Windows 安装包的可用状态：不可用时 reason 是后端给出的中文原因。 */
export interface FleetInstallerState {
  available: boolean;
  reason?: string;
}

export type FleetInstallerTarget = 'windows-amd64' | 'windows-arm64';

export interface FleetDeploymentInfo {
  ready: boolean;
  /** 未就绪的原因（中文）。 */
  issues: string[];
  warnings: string[];
  server: string | null;
  certificate: {
    pem: string;
    sha256: string;
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    selfSigned: boolean;
    hostMatches: boolean | null;
  } | null;
  tlsDeployment: {
    server: string;
    tls_server_cert_pem: string;
    tls_server_cert_sha256: string;
  } | null;
  collectorConfigPatch: Record<string, unknown>;
  installCommands: Array<{ title: string; command: string }>;
  /** 一键安装（Linux）就绪状态与脚本散列。 */
  oneclick?: {
    available: boolean;
    /** 不可用的原因（中文）。 */
    reasons: string[];
    scriptUrl: string | null;
    scriptSha256: string | null;
    scriptFile: string;
    targets: Array<{
      target: string;
      os: string;
      arch: string;
      version: string;
      filename: string;
      bytes: number | null;
      status: 'ok' | 'missing' | 'size_mismatch' | 'sha_mismatch' | 'unreadable' | 'not_supported';
      oneclick: boolean;
      /** Windows 安装包能否下载；仅 Windows 目标带这个字段。 */
      installer?: FleetInstallerState;
    }>;
  };
}

export interface CheckImpact {
  level: 'read_only' | 'runs_agent';
  touches: string[];
  reversible: boolean;
  note: string;
}
export interface CheckItem {
  id: string;
  mode: 'posture' | 'live';
  category: 'permission' | 'mcp' | 'skill' | 'instruction' | 'credential' | 'behavior' | 'environment';
  title: string;
  what: string;
  why: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  impact: CheckImpact;
  remediation: string;
}
export interface CheckCatalog {
  liveRiskTypes?: LiveRiskTypeCatalogItem[];
  categories: Array<{ id: CheckItem['category']; label: string; order: number }>;
  posture: CheckItem[];
  live: CheckItem[];
  liveSummary: {
    title: string;
    steps: string[];
    consumesQuota: string;
    isolationNote: string;
    cleanup: string;
  };
}
/** 技能命中的位置与受控中文说明，不含脚本内容。 */
export interface FleetPostureHit {
  rule_id?: string;
  reason_zh?: string;
  file_label?: string;
  line_number?: number | null;
  context_type?: string;
}
export interface FleetPostureFinding {
  /** review=命中只出现在说明文档里，需人工确认。 */
  state?: 'risk' | 'review' | 'clear' | 'not_checked';
  notCheckedReason?: string;
  howToCheck?: string;
  subjects?: Array<
    FleetPostureHit & {
      kind: 'agent' | 'mcp' | 'skill' | 'instruction_file' | 'scheduled_agent';
      name: string;
      state: 'risk' | 'review' | 'clear' | 'not_checked';
      detail: string;
      /** 仅没检查的对象：成因键（见 shared/not-checked 词表）与所在账号、位置。 */
      cause?: string;
      where?: string;
      hits?: FleetPostureHit[];
    }
  >;
  plainTitle?: string;
  plainWhy?: string;
  plainFix?: string;
  ruleId: string;
  title: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  riskCategory: string;
  evidence: string;
  compliance: readonly string[];
}

export interface EndpointTaskSummary {
  mode?: 'posture' | 'live';
  endpoint: { id?: string; name: string; lastSeenAt: string | null };
  endpointId?: string | null;
  product?: FleetLiveProduct;
  driver?: import('../../../../packages/shared/src/endpoint-live-outcome').LiveDriver;
  totals?: import('../../../../packages/shared/src/endpoint-live-outcome').LiveTotals;
  runtimeSummary?: import('../../../../packages/shared/src/endpoint-live-outcome').RuntimeSummary;
  retestOf?: { taskId: string };
  /** 任务还在排队或执行、终端尚未回传场景时才有：此时没有结论，只显示进度。 */
  progress?: { state: 'queued' | 'running'; total: number; startedAt: string | null; estimateSeconds: number | null };
  overview?: import('../../../../packages/shared/src/endpoint-overview').EndpointOverview;
  agents: FleetEndpointAgent[];
  verdictLine: string;
  groups: Array<{ id: string; label: string; items: FleetPostureFinding[] }>;
  liveScenarios: Array<import('../../../../packages/shared/src/endpoint-live-outcome').LiveScenarioOutcomeFields & {
    scenarioId: string;
    riskType: string;
    whatWeAsked: string;
    whatItDid: string;
    judgement: string;
    evidenceExcerpt: string;
    executionNotes?: string[];
    agentName?: string;
    isolation?: string | null;
    modelRoute?: string | null;
  }>;
}

export interface AgentSample {
  id: string; suite: 'runtime_v2' | 'classic'; source: 'builtin' | 'custom'; title: string;
  enabled?: boolean; version?: number; digest?: string;
  vector: string | null; vectorLabel: string; harm: string; harmLabel: string; channel: string | null;
  locations: string[]; template: string | null; agents: string[]; environment: 'sandbox' | 'real_config';
  /** 一句话说明这条样本测什么。 */
  summary: string;
  /** 参考标准编号，如 OWASP-LLM02。 */
  refs: string[];
}
export interface AgentSampleDetail extends AgentSample {
  prompt: string; turns: string[]; slots: Record<string, string>;
  decoys: { workspace: string[]; home: string[] }; dangerDescriptions: string[];
  expect: { run?: string[]; final_contains?: string[]; files?: { path: string; contains: string }[] } | null;
  explain: string; mcp?: import('../../../../packages/shared/src/runtime-eval').RuntimeMcpSpec | null;
  statistics: null;
  /** 毒藏在哪：按位置给出文件、路径和原文。 */
  poison: Array<{ kind: 'file' | 'mcp'; location: string; path: string | null; text: string }>;
  decoyInfo: Array<{ id: string; label: string; path: string; purpose: string }>;
  refsInfo: Array<{ code: string; label: string }>;
  provenance: { kind: 'builtin' | 'custom'; origin: string | null; createdBy: string | null; createdAt: string; changeNote: string; version: number; digest: string };
}
export interface AgentRangeInfo {
  decoys: Array<{ id: string; label: string; path: string; purpose: string; usedBy: number }>;
  projects: Array<{ template: string; name: string; files: Array<{ path: string; slot: string; label: string; usedBy: number }> }>;
  mcp: Array<{ kind: string; label: string; description: string; usedBy: number }>;
  receiverBase: string | null; receiverReachable: boolean | null;
  recentReceipts: Array<{ id: string; taskId: string; createdAt: string }>;
}
export interface AgentSampleStatsBucket {
  allowed: number; model_refused: number; control_blocked: number; invalid: number; complyRate: number | null;
}
export interface AgentSampleStatistics {
  items: Array<{ product: string; observe: AgentSampleStatsBucket; enforce: AgentSampleStatsBucket; unlabeled: AgentSampleStatsBucket }>;
  versions?: Array<{ product: string; version: number | null; observe: AgentSampleStatsBucket; enforce: AgentSampleStatsBucket; unlabeled: AgentSampleStatsBucket }>;
  incompleteJobs: number;
}
export interface AgentSamplePlan {
  id: 'quick' | 'standard' | 'full'; sampleIds: string[];
  sampleVersions?: Array<{ id: string; version: number }>;
  arms: import('../../../../packages/shared/src/runtime-eval').RuntimeArm[];
  repeat: number; templates: import('../../../../packages/shared/src/runtime-eval').RuntimeTemplate[];
}
export interface AgentEvalSelection {
  products: FleetLiveProduct[]; sampleIds: string[];
  trial?: boolean;
  sampleVersions?: Array<{ id: string; version: number }>;
  arms: import('../../../../packages/shared/src/runtime-eval').RuntimeArm[];
  repeat: number; templates: import('../../../../packages/shared/src/runtime-eval').RuntimeTemplate[];
}
export interface AgentEvalEstimate {
  jobs: Array<{ product: FleetLiveProduct; suite: 'classic' | 'runtime_v2'; scenarioCount: number; estimateSeconds: number;
    /** 场景较多时服务端按整样本拆成多个任务依次执行；只有一个任务时没有。 */
    batch?: { index: number; total: number };
    scenarios: Array<{ scenarioId: string; sampleId: string; title: string; template: string | null; arm: string | null }> }>;
  scenarioCount: number; estimateSeconds: number; modelUsage: null;
}
export interface FleetAgentRow {
  tenantId?: string | null;
  /** 所属分组（FleetAgentGroup.key）。智能体安全平台来源按机器合并，同组的行 endpointId 可以不同。 */
  groupKey?: string;
  endpointId: string; endpointName: string; user: string | null; os: string; source: 'jiandun' | 'agentshield';
  agentKey: string; agentName: string; version: string | null;
  /** platform_managed：智能体安全平台来源且在线，测评登记由平台管理。 */
  status: 'ready' | 'needs_attention' | 'unsupported' | 'offline' | 'platform_managed'; reason: string | null;
  /** 仅智能体安全平台来源：该登记上报的测评执行器版本。 */
  evalRunnerVersion?: string | null;
  scope: 'all' | 'classic_only'; runtimeV2: boolean;
  latest: { jobId: string; taskId: string | null; status: FleetJobStatus; createdAt: string; conclusion: string | null } | null;
  /** 该智能体自己的资产数（按终端分组时返回；智能体安全平台来源为 null）。 */
  assets?: { skills: number; mcp: number } | null;
}

/** 终端责任人（资产台账）。 */
export interface FleetEndpointOwner {
  name: string;
  department: string | null;
  userId: string | null;
  updatedAt: string | null;
}

/** 资产台账里的一台终端：责任人、资产与风险汇总（与终端详情同一口径）。 */
export interface FleetAgentGroup {
  tenantId?: string | null;
  key: string;
  endpointId: string;
  source: 'jiandun' | 'agentshield';
  name: string;
  os: string;
  osUser: string | null;
  online: boolean | null;
  owner: FleetEndpointOwner | null;
  /** manual：本平台设置；reported：智能体安全平台上报的使用人。 */
  ownerSource: 'manual' | 'reported' | null;
  assets: { agents: number; skills: number; mcp: number; platforms: number } | null;
  risks: { open: number; high: number } | null;
}

export const api = {
  agentSamples: {
    list: () => request<{ items: AgentSample[] }>('GET', '/agent-samples'),
    get: (id: string, version?: number) => request<AgentSampleDetail>('GET', `/agent-samples/${encodeURIComponent(id)}`, { query: version ? { version } : {} }),
    create: (sample: import('../../../../packages/shared/src/runtime-eval').RuntimeSample, changeNote = '') =>
      request<{ id: string; version: number }>('POST', '/agent-samples', { body: { sample, changeNote } }),
    update: (id: string, sample: import('../../../../packages/shared/src/runtime-eval').RuntimeSample, expectedVersion: number, changeNote = '') =>
      request<{ id: string; version: number }>('PUT', `/agent-samples/${encodeURIComponent(id)}`, { body: { sample, expectedVersion, changeNote } }),
    setEnabled: (id: string, enabled: boolean) => request<{ id: string; enabled: boolean }>('PATCH', `/agent-samples/${encodeURIComponent(id)}/status`, { body: { enabled } }),
    exportSample: (id: string) => request<{ samples: Array<{ id: string; suite: string; source: string; currentVersion: number;
      versions: Array<{ version: number; digest: string; content: unknown; createdAt: string; changeNote: string }> }> }>('GET', `/agent-samples/${encodeURIComponent(id)}/export`),
    exportAll: () => request<{ samples: unknown[] }>('GET', '/agent-samples/export'),
    importSamples: (samples: unknown[]) => request<{ items: Array<{ index: number; id?: string; ok: boolean; error?: string }> }>('POST', '/agent-samples/import', { body: { samples } }),
    trials: (id: string, version?: number) => request<{ items: Array<{ version: number; taskId: string; createdAt: string; status: FleetJobStatus | 'UNKNOWN'; conclusion: string | null }> }>('GET', `/agent-samples/${encodeURIComponent(id)}/trials`, { query: version ? { version } : {} }),
    statistics: (id: string) => request<AgentSampleStatistics>('GET', `/agent-samples/${encodeURIComponent(id)}/stats`),
    allStatistics: () => request<{ items: Array<{ id: string; complyRate: number | null }>; incompleteJobs: number }>('GET', '/agent-samples/statistics'),
    plans: () => request<{ items: AgentSamplePlan[] }>('GET', '/agent-samples/plans'),
    range: () => request<AgentRangeInfo>('GET', '/agent-samples/range'),
  },
  fleet: {
    agents: (query: { page?: number; pageSize?: number; q?: string; endpointId?: string; tenantId?: string; groupBy?: 'endpoint' } = {}) =>
      request<FleetPage<FleetAgentRow> & { groups?: FleetAgentGroup[]; connectorStatus?: 'available' | 'unavailable' | 'not_configured' | 'permission_required' }>('GET', '/fleet/agents', { query }),
    setOwner: (id: string, body: { name: string; department?: string; userId?: string | null }) =>
      request<{ id: string; owner: FleetEndpointOwner | null }>('PATCH', `/fleet/endpoints/${encodeURIComponent(id)}/owner`, { body }),
    estimateEvalJobs: (body: AgentEvalSelection) => request<AgentEvalEstimate>('POST', '/fleet/eval-jobs/estimate', { body }),
    createEvalBatch: (id: string, body: AgentEvalSelection & { acknowledged: true }) =>
      request<{ jobs: Array<FleetJob & { taskId: string | null }>; scenarioCount: number; estimateSeconds: number }>(
        'POST', `/fleet/endpoints/${encodeURIComponent(id)}/eval-jobs/batch`, { body }),
    checkCatalog: () => request<CheckCatalog>('GET', '/fleet/check-catalog'),
    posture: (id: string) =>
      request<{ findings: FleetPostureFinding[] }>(
        'GET',
        `/fleet/endpoints/${encodeURIComponent(id)}/posture`,
      ),
    /** 后端没有 /fleet/config：功能未启用时所有 /fleet/* 都返回 404，据此判断。 */
    config: async (): Promise<FleetConfig> => {
      try {
        await request('GET', '/fleet/endpoints', { query: { page: 1, pageSize: 1 } });
        return { enabled: true };
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 404) return { enabled: false };
          // 已启用但当前账号没有查看权限：功能存在，具体页面会提示无权限。
          if (err.status === 403) return { enabled: true };
        }
        throw err;
      }
    },
    createEnrollmentCode: (body: FleetEnrollmentCodeCreateBody) =>
      request<FleetEnrollmentCodeCreated>('POST', '/fleet/enrollment-codes', { body }),
    enrollmentCodes: () =>
      request<FleetPage<FleetEnrollmentCode>>('GET', '/fleet/enrollment-codes', {
        query: { page: 1, pageSize: 100 },
      }),
    revokeEnrollmentCode: (id: string) =>
      request<FleetEnrollmentCode>(
        'POST',
        `/fleet/enrollment-codes/${encodeURIComponent(id)}/revoke`,
      ),
    endpoints: (query: { page?: number; pageSize?: number; q?: string; status?: 'ACTIVE' | 'REVOKED'; tenantId?: string } = {}) =>
      request<FleetPage<FleetEndpoint>>('GET', '/fleet/endpoints', { query }),
    endpoint: (id: string) =>
      request<FleetEndpointDetail>('GET', `/fleet/endpoints/${encodeURIComponent(id)}`),
    revokeEndpoint: (id: string) =>
      request<{ id: string; status: 'REVOKED'; cancelledJobs: number; failedJobs: number }>(
        'POST',
        `/fleet/endpoints/${encodeURIComponent(id)}/revoke`,
      ),
    removeEndpoint: (id: string) =>
      request<{ id: string; removed: boolean }>('DELETE', `/fleet/endpoints/${encodeURIComponent(id)}`),
    overview: (id: string) =>
      request<import('../../../../packages/shared/src/endpoint-overview').EndpointOverview>('GET', `/fleet/endpoints/${encodeURIComponent(id)}/overview`),
    postureEval: (id: string, body?: { items: string[] }) =>
      request<{ taskId: string; status: string }>(
        'POST',
        `/fleet/endpoints/${encodeURIComponent(id)}/posture-eval`,
        { body: body ?? {} },
      ),
    requestEvalJob: (
      endpointId: string,
      body: import('../../../../packages/shared/src/endpoint-live-outcome').EvalJobRequestExtras &
        Partial<import('../../../../packages/shared/src/runtime-eval').RuntimeJobOptions> & {
          product: FleetLiveProduct;
          riskTypes?: LiveRiskType[];
          reason?: string;
          name?: string;
        },
    ) =>
      request<
        FleetJob & {
          taskId: string | null;
          /** 以下三项只在 suite=runtime_v2 的响应里出现（scenarioCount 沿用 FleetJob）。 */
          suite?: import('../../../../packages/shared/src/runtime-eval').RuntimeSuite;
          tier?: import('../../../../packages/shared/src/runtime-eval').RuntimeTier;
          estimate_seconds?: number;
          /** 超过单任务上限被拆成多个任务时才有：任务个数。 */
          batchCount?: number;
        }
      >('POST', `/fleet/endpoints/${encodeURIComponent(endpointId)}/eval-jobs`, { body }),
    evalJobs: (
      query: {
        status?: string;
        view?: 'pending' | 'active' | 'history';
        page?: number;
        pageSize?: number;
        endpointId?: string;
        tenantId?: string;
        product?: string;
      } = {},
    ) => request<FleetPage<FleetJob>>('GET', '/fleet/eval-jobs', { query }),
    approveEvalJob: (id: string) =>
      request<FleetJob>('POST', `/fleet/eval-jobs/${encodeURIComponent(id)}/approve`, {
        body: {},
      }),
    rejectEvalJob: (id: string, reason: string) =>
      request<FleetJob>('POST', `/fleet/eval-jobs/${encodeURIComponent(id)}/reject`, {
        body: { reason },
      }),
    /** force：终端管理员把已下发/执行中的任务在平台上强制结束（终端上的进程不受影响）。 */
    cancelEvalJob: (id: string, options: { force?: boolean } = {}) =>
      request<FleetJob>('POST', `/fleet/eval-jobs/${encodeURIComponent(id)}/cancel`, {
        body: options.force ? { force: true } : {},
      }),
    deploymentInfo: () => request<FleetDeploymentInfo>('GET', '/fleet/deployment-info'),
    /** 下载内置了接入码的 Windows 安装包；失败时抛出带后端中文原因的 ApiError。 */
    downloadWindowsInstaller: (code: string, target: FleetInstallerTarget) =>
      downloadFile(
        '/fleet/install/windows-installer',
        undefined,
        `jiandun-probe-setup-${target}.exe`,
        { code, target },
      ),
  },
  endpointEvals: {
    config: () =>
      request<{ enabled: boolean; agentshieldBaseUrl: string }>('GET', '/endpoint-evals/config'),
    endpoints: (product?: string) =>
      request<EndpointInfo[]>('GET', '/endpoint-evals/endpoints', { query: { product } }),
    posture: (modelTargetId: string) =>
      request<{ taskId: string }>('POST', '/endpoint-evals/posture', { body: { modelTargetId } }),
    run: (modelTargetId: string) =>
      request<{ taskId: string }>('POST', '/endpoint-evals/run', { body: { modelTargetId } }),
  },

  standards: {
    catalog() {
      return request<StandardCatalogResponse>('GET', '/standards/catalog');
    },
    coverage(query: { line?: StandardLine; taskId?: string; targetId?: string; days?: number }) {
      return request<StandardCoverageResponse>('GET', '/standards/coverage', { query });
    },
  },

  frameworks: {
    coverage(query: { framework?: string; taskId?: string; targetId?: string; days?: number }) {
      return request<FrameworkCoverageResponse>('GET', '/frameworks/coverage', { query });
    },
    heatmap(query: { framework: string; dimension: 'target' | 'task' }) {
      return request<{
        framework: string;
        columns: Array<{ id: string; label: string }>;
        items: Array<{ id: string; nameEn: string; nameZh: string; groupZh?: string }>;
        cells: Array<{
          entryId: string;
          columnId: string;
          tested: boolean;
          testCount: number;
          failCount: number;
          rate: number | null;
          coverage: number;
          findingIds: string[];
        }>;
        unmappedCount: number;
        unmapped: Array<{ label: string; count: number }>;
        disclaimer: string;
        limitation?: string;
      }>('GET', '/frameworks/heatmap', { query });
    },
  },

  // 认证
  login(body: { username: string; password: string }) {
    return request<LoginResponse>('POST', '/auth/login', { body, skipAuthRedirect: true });
  },
  me() {
    return request<{ user: AuthUser }>('GET', '/auth/me', { skipAuthRedirect: true });
  },
  // 自助注册（免登录）
  register(body: RegisterBody) {
    return request<{ ok: boolean }>('POST', '/auth/register', { body, skipAuthRedirect: true });
  },
  // 登录页信息（免登录）：访问量、下载量、注册开关
  loginStats() {
    return request<LoginStats>('GET', '/public/login-stats', { skipAuthRedirect: true });
  },
  // 登录页打开时计一次访问（免登录，同一 IP 30 分钟内只计一次）
  recordVisit() {
    return request<void>('POST', '/public/visits', { skipAuthRedirect: true });
  },
  logout() {
    return request<{ ok: boolean }>('POST', '/auth/logout');
  },
  // 当前登录用户自助修改自己的密码（需校验当前密码）
  changeMyPassword(body: { currentPassword: string; newPassword: string }) {
    return request<{ ok: boolean }>('POST', '/auth/me/password', { body });
  },
  // 当前生效的密码策略（改密弹窗动态规则）
  passwordPolicy() {
    return request<PasswordPolicy>('GET', '/auth/password-policy');
  },
  patchMyPreferences(body: UserPreferences) {
    return request<{ user: AuthUser }>('PATCH', '/auth/me/preferences', { body });
  },

  // 权限目录
  permissions() {
    return request<PermissionCatalog>('GET', '/permissions');
  },

  // 评估对象
  modelTargets: {
    capabilities() {
      return request<{ platformAppEnabled: boolean }>('GET', '/model-targets/capabilities');
    },
    list(query?: {
      page?: number;
      pageSize?: number;
      keyword?: string;
      includeSystem?: boolean;
      /** 只列「启用中、可做连通性测试、且从未测试」的对象（首页「测试」按钮的口径）。 */
      untested?: boolean;
      /** 终端类对象带上 endpointState（要问智能体安全平台，只有评估对象页带）。 */
      withEndpointState?: boolean;
      tenantId?: string;
    }) {
      return request<Paginated<ModelTarget>>('GET', '/model-targets', { query });
    },
    get(id: string) {
      return request<ModelTarget>('GET', `/model-targets/${id}`);
    },
    create(body: Record<string, unknown>) {
      return request<ModelTarget>('POST', '/model-targets', { body });
    },
    update(id: string, body: Record<string, unknown>) {
      return request<ModelTarget>('PATCH', `/model-targets/${id}`, { body });
    },
    /** withTasks：连同名下的评估任务及其结果、报告一起删除（还需要评估任务删除权限）。 */
    remove(id: string, options?: { withTasks: true }) {
      return request<void>('DELETE', `/model-targets/${id}`, options ? { query: { withTasks: true } } : {});
    },
    test(id: string, prompt?: string) {
      return request<ModelTestResult>('POST', `/model-targets/${id}/test`, { body: { prompt } });
    },
    testGateway(id: string) {
      return request<{
        ok: boolean;
        message: string;
        latencyMs?: number | null;
        httpStatus?: number | null;
      }>('POST', `/model-targets/${id}/test-gateway`);
    },
    testConfig(body: Record<string, unknown>) {
      return request<ModelTestResult>('POST', '/model-targets/test', { body });
    },
    diagnose(body: Record<string, unknown>) {
      return request<ModelTargetDiagnoseReport>('POST', '/model-targets/diagnose', { body });
    },
    diagnoseSaved(id: string) {
      return request<ModelTargetDiagnoseReport>('POST', `/model-targets/${id}/diagnose`);
    },
    batchTest(ids: string[]) {
      return request<ModelTargetBatchTestResult>('POST', '/model-targets/batch-test', {
        body: { ids },
      });
    },
  },

  batchEvaluations: {
    list(query?: { page?: number; pageSize?: number }) {
      return request<Paginated<BatchPlan>>('GET', '/batch-evaluations', { query });
    },
    create(body: CreateBatchRequest) {
      return request<BatchDetail>('POST', '/batch-evaluations', { body });
    },
    get(id: string) {
      return request<BatchDetail>('GET', `/batch-evaluations/${id}`);
    },
    start(id: string) {
      return request<BatchDetail>('POST', `/batch-evaluations/${id}/start`);
    },
    pause(id: string) {
      return request<BatchDetail>('POST', `/batch-evaluations/${id}/pause`);
    },
    resume(id: string, body?: { maxRequests?: number; maxDurationMinutes?: number }) {
      return request<BatchDetail>('POST', `/batch-evaluations/${id}/resume`, { body });
    },
    cancel(id: string) {
      return request<BatchDetail>('POST', `/batch-evaluations/${id}/cancel`);
    },
    retryErrors(id: string, body?: { maxRequests?: number; maxDurationMinutes?: number }) {
      return request<BatchDetail>('POST', `/batch-evaluations/${id}/retry-errors`, { body });
    },
    results(
      id: string,
      query?: { page?: number; pageSize?: number; runId?: string; verdict?: string },
    ) {
      return request<Paginated<BatchResult>>('GET', `/batch-evaluations/${id}/results`, { query });
    },
    report(id: string, runId?: string) {
      return request<BatchReport>('GET', `/batch-evaluations/${id}/report`, { query: { runId } });
    },
    downloadReport(id: string, runId?: string) {
      return downloadFile(`/batch-evaluations/${id}/report/download`, { runId }, '批量评估报告.md');
    },
  },

  // 样本库 / 测评样本
  questionSets: {
    list(query?: {
      page?: number;
      pageSize?: number;
      keyword?: string;
      type?: string;
      domain?: string;
      origin?: 'builtin' | 'own';
      kind?: 'seed' | 'own' | 'run';
      /** true = 只列启用的（建任务时用）。 */
      enabled?: boolean;
    }) {
      return request<Paginated<QuestionSet>>('GET', '/question-sets', { query });
    },
    builtinStats() {
      return request<BuiltinBankStats>('GET', '/question-sets/builtin/stats');
    },
    /** 按小类浏览内置题目，与 builtinStats 的小类题数同口径（跨在用内置库、只列在用题）。 */
    builtinBrowse(params: { minor: string; page: number; pageSize: number }) {
      const qs = new URLSearchParams({
        minor: params.minor,
        page: String(params.page),
        pageSize: String(params.pageSize),
      });
      return request<{
        total: number;
        page: number;
        pageSize: number;
        items: { id: string; content: string; setName: string; setSource: string | null }[];
      }>('GET', `/question-sets/builtin/browse?${qs.toString()}`);
    },
    bankCoverage() {
      return request<{ banks: BankCoverageBank[] }>('GET', '/question-sets/builtin/bank-coverage');
    },
    bankUpdates() {
      return request<BankUpdateOverview>('GET', '/question-sets/builtin/updates');
    },
    runBankUpdate(kind: 'questions' | 'keywords') {
      return request<{ started: boolean; message: string }>('POST', '/question-sets/builtin/updates/run', { body: { kind } });
    },
    bankImport(body: { format: 'csv' | 'jsonl'; filename: string; content: string; bank?: string }) {
      return request<BankImportResult>('POST', '/question-sets/builtin/bank-import', { body });
    },
    bankImportTemplate() {
      return downloadFile('/question-sets/builtin/bank-import/template', undefined, '国标题库导入模板.csv');
    },
    keywordCoverage() {
      return request<KeywordCoverageResult>('GET', '/question-sets/builtin/keywords/coverage');
    },
    keywordImport(body: { format: 'csv' | 'txt'; filename: string; content: string; itemCode?: string }) {
      return request<KeywordImportResult>('POST', '/question-sets/builtin/keywords/import', { body });
    },
    keywordList(query: {
      itemCode?: string;
      keyword?: string;
      reviewStatus?: KeywordStatus;
      page?: number;
      pageSize?: number;
    }) {
      return request<KeywordListResult>('GET', '/question-sets/builtin/keywords', { query });
    },
    /** 批量改状态：按 id，或按小项 + 原状态。 */
    keywordSetStatus(
      body:
        | { ids: string[]; to: 'approved' | 'disabled' }
        | { itemCode: string; fromStatus: 'pending' | 'approved' | 'disabled'; to: 'approved' | 'disabled' },
    ) {
      return request<{ to: string; itemCode: string | null; changed: number }>(
        'POST',
        '/question-sets/builtin/keywords/status',
        { body },
      );
    },
    keywordExport(itemCode?: string) {
      return downloadFile('/question-sets/builtin/keywords/export', { itemCode }, '国标关键词库.csv');
    },
    attackSeedDomains() {
      return request<{ items: TestDomain[] }>('GET', '/question-sets/attack-seeds/domains');
    },
    createAttackSeedDomain(body: { name: string; description?: string }) {
      return request<TestDomain>('POST', '/question-sets/attack-seeds/domains', { body });
    },
    generateAttackSeeds(body: AttackSeedSpec) {
      return request<AttackSeedResult>('POST', '/question-sets/attack-seeds/generate', { body });
    },
    mutationStrategies() {
      return request<MutationStrategiesResult>('GET', '/question-sets/mutation/strategies');
    },
    createMutation(body: MutationSpec) {
      return request<MutationResult>('POST', '/question-sets/mutation', { body });
    },
    saveAttackSeeds(body: {
      name: string;
      spec: AttackSeedSpec;
      source: AttackSeedResult['source'];
      scenarios: AttackSeedScenario[];
    }) {
      return request<{ id: string; name: string; questionCount: number }>(
        'POST',
        '/question-sets/attack-seeds/save',
        { body },
      );
    },
    copy(id: string, body: { name?: string; categories?: string[] } = {}) {
      return request<{ id: string; name: string; questionCount: number }>(
        'POST',
        `/question-sets/${id}/copy`,
        { body },
      );
    },
    riskCategories() {
      return request<{ items: { domain: string; label: string; count: number }[] }>(
        'GET',
        '/question-sets/risk-categories',
      );
    },
    get(id: string) {
      return request<QuestionSet>('GET', `/question-sets/${id}`);
    },
    create(body: Record<string, unknown>) {
      return request<QuestionSet>('POST', '/question-sets', { body });
    },
    update(id: string, body: Record<string, unknown>) {
      return request<QuestionSet>('PATCH', `/question-sets/${id}`, { body });
    },
    remove(id: string) {
      return request<void>('DELETE', `/question-sets/${id}`);
    },
    questions(setId: string, query?: { page?: number; pageSize?: number; category?: string }) {
      return request<Paginated<Question>>('GET', `/question-sets/${setId}/questions`, { query });
    },
    /** 这道题在各任务里的检测结果（按时间倒序）。 */
    questionResults(setId: string, questionId: string) {
      return request<{ items: QuestionResultRecord[]; total: number }>(
        'GET',
        `/question-sets/${setId}/questions/${questionId}/results`,
      );
    },
    createQuestion(setId: string, body: Record<string, unknown>) {
      return request<Question>('POST', `/question-sets/${setId}/questions`, { body });
    },
    updateQuestion(questionId: string, body: Record<string, unknown>) {
      return request<Question>('PATCH', `/question-sets/questions/${questionId}`, { body });
    },
    removeQuestion(questionId: string) {
      return request<void>('DELETE', `/question-sets/questions/${questionId}`);
    },
    templates() {
      return request<{ items: QuestionTemplate[] }>('GET', '/question-sets/templates');
    },
    downloadTemplate(templateType: string) {
      return downloadFile(
        `/question-sets/templates/${templateType}/download`,
        undefined,
        `${templateType}-template.xlsx`,
      );
    },
    /** 导出样本库（可按分类等筛选），导出的文件能按导入模板导回去。 */
    exportSet(
      id: string,
      format: 'xlsx' | 'csv',
      filters: { category?: string; severity?: string; keyword?: string } = {},
    ) {
      return downloadFile(
        `/question-sets/${encodeURIComponent(id)}/export`,
        { format, ...filters },
        `question-set-${id}.${format}`,
      );
    },
    /** 样本库的分类与样本数（按样本数倒序）。 */
    categories(id: string) {
      return request<{ items: Array<{ category: string; count: number }> }>(
        'GET',
        `/question-sets/${encodeURIComponent(id)}/categories`,
      );
    },
    imports(query?: { page?: number; pageSize?: number }) {
      return request<Paginated<ImportRecord>>('GET', '/question-sets/imports', { query });
    },
    import(body: Record<string, unknown>) {
      return request<{ questionSetId: string; import: ImportRecord }>(
        'POST',
        '/question-sets/import',
        {
          body,
        },
      );
    },
  },

  // GB/T 45654-2025 模型 API 输出安全专项。
  standardEvaluations: {
    profiles() {
      return request<{ items: StandardProfile[] }>('GET', '/standards/profiles');
    },
    releases() {
      return request<{ items: StandardBankRelease[] }>('GET', '/standard-bank-releases');
    },
    list(params: { page?: number; pageSize?: number } = {}) {
      return request<{
        items: StandardRunListItem[];
        total: number;
        page: number;
        pageSize: number;
      }>('GET', '/standard-evaluations', { query: params });
    },
    preflight(body: Record<string, unknown>) {
      return request<StandardPreflightResult>('POST', '/standard-evaluations/preflight', { body });
    },
    cancel(runId: string) {
      return request<{ runId: string; taskId: string; status: string }>(
        'POST',
        `/standard-evaluations/${runId}/cancel`,
        { body: {} },
      );
    },
    create(body: Record<string, unknown>) {
      return request<{
        runId: string;
        taskId: string;
        sampleCount: number;
        noExternalCalls: boolean;
      }>('POST', '/standard-evaluations', { body });
    },
    execute(runId: string) {
      return request<{
        runId: string;
        taskId: string;
        status: string;
        queued: boolean;
        automaticJudgment: boolean;
      }>('POST', `/standard-evaluations/${runId}/execute`, { body: {} });
    },
    get(runId: string) {
      return request<Record<string, unknown>>('GET', `/standard-evaluations/${runId}`);
    },
    summary(runId: string) {
      return request<StandardSummary>('GET', `/standard-evaluations/${runId}/summary`);
    },
    reviewItems(runId: string) {
      return request<{ items: StandardReviewItem[]; manualRequired: number }>(
        'GET',
        `/standard-evaluations/${runId}/review-items`,
      );
    },
    generateReport(runId: string) {
      return request<Record<string, unknown>>('POST', `/standard-evaluations/${runId}/report`, {
        body: {},
      });
    },
    downloadReportPdf(runId: string) {
      return downloadFile(
        `/standard-evaluations/${runId}/report.pdf`,
        undefined,
        `standard-evaluation-${runId}.pdf`,
      );
    },
    downloadEvidence(runId: string) {
      return downloadFile(
        `/standard-evaluations/${runId}/report.evidence.json`,
        undefined,
        `standard-evaluation-${runId}-evidence.json`,
      );
    },
    report(runId: string) {
      return request<Record<string, unknown>>('GET', `/standard-evaluations/${runId}/report`);
    },
    // 按附录 B 方法抽样的运行：方法进度与结论、人工抽检、措施核验。
    gbtState(runId: string) {
      return request<GbtStateView>('GET', `/standard-evaluations/${runId}/gbt/state`);
    },
    gbtRetryFailed(runId: string) {
      return request<{ runId: string; taskId: string; failed: number; queued: boolean }>('POST', `/standard-evaluations/${runId}/gbt/retry-failed`);
    },
    gbtJudge(runId: string) {
      return request<{ runId: string; started: boolean; running: boolean }>('POST', `/standard-evaluations/${runId}/gbt/judge`, {
        body: {},
      });
    },
    gbtReviewItems(
      runId: string,
      query: { slot: number; filter: string; page: number; pageSize: number; kind?: 'safety' | 'refusal' },
    ) {
      return request<{
        items: GbtReviewItem[];
        total: number;
        page: number;
        pageSize: number;
        mineDone?: number;
        /** 当前名单范围里的重点复核题数。 */
        priorityCount?: number;
        groups?: { shouldRefuse: { total: number; decided: number }; nonRefusal: { total: number; decided: number } };
        itemOptions: Array<{ code: string; name: string }>;
      }>('GET', `/standard-evaluations/${runId}/gbt/review-items`, { query });
    },
    gbtSubmitReview(
      runId: string,
      body: { sampleId: string; slot: number; verdict: GbtReviewVerdict; itemCode?: string | null; note?: string | null },
    ) {
      return request<{ id: string }>('POST', `/standard-evaluations/${runId}/gbt/reviews`, { body });
    },
    gbtSubmitReviewsBatch(
      runId: string,
      body: {
        slot: number;
        items: Array<{ sampleId: string; verdict: GbtReviewVerdict; itemCode?: string | null; note?: string | null }>;
      },
    ) {
      return request<GbtReviewBatchResult>('POST', `/standard-evaluations/${runId}/gbt/reviews/batch`, { body });
    },
    gbtJudgeStatus(modelTargetId?: string) {
      return request<GbtJudgeStatus>('GET', '/standard-evaluations/gbt45654/judge-status', {
        query: modelTargetId ? { modelTargetId } : {},
      });
    },
    gbtMeasures(runId: string) {
      return request<{ items: GbtMeasureItem[] }>('GET', `/standard-evaluations/${runId}/gbt/measures`);
    },
    gbtAbuseProbe(runId: string) {
      return request<Record<string, unknown>>(
        'POST',
        `/standard-evaluations/${runId}/gbt/measures/abuse-probe`,
        { body: {} },
      );
    },
    gbtExplicitLabel(runId: string) {
      return request<Record<string, unknown>>(
        'POST',
        `/standard-evaluations/${runId}/gbt/measures/explicit-label`,
        { body: {} },
      );
    },
    gbtConfirmMeasure(
      runId: string,
      clauseId: string,
      body: { verdict: string; note?: string | null; materials?: string | null },
    ) {
      return request<Record<string, unknown>>(
        'PUT',
        `/standard-evaluations/${runId}/gbt/measures/${encodeURIComponent(clauseId)}`,
        { body },
      );
    },
    /** 按 GB/T 45654 附录 B 方法建任务：从三套固定题库分层抽样并冻结名单，可直接开始执行。 */
    createGbt(body: {
      modelTargetId: string;
      name?: string;
      seed?: string;
      targets?: { generation?: number; refusal?: number; non_refusal?: number };
      autoStart?: boolean;
    }) {
      return request<{
        taskId: string;
        runId: string;
        name: string;
        seed: string;
        sampleCount: number;
        selectedCounts: Record<string, number>;
        shortages: Array<{ bank: string; bankLabel: string; minimum: number; [key: string]: unknown }>;
        started: boolean;
      }>('POST', '/standard-evaluations/gbt45654', { body });
    },
    downloadGbtReport(runId: string) {
      return downloadFile(`/reports/gbt45654/${runId}`, { format: 'pdf' }, `gbt45654-report-${runId}.pdf`);
    },
  },

  // 样本生成器
  generator: {
    preview(body: GeneratorPreviewBody) {
      return request<GeneratorPreviewResult>('POST', '/generator/preview', { body });
    },
    generate(body: GeneratorGenerateBody) {
      return request<GeneratorGenerateResult>('POST', '/generator/generate', { body });
    },
    customerDataPreview(body: CustomerDataGeneratorBody) {
      return request<CustomerDataGeneratorResult>('POST', '/generator/customer-data/preview', {
        body,
      });
    },
    customerDataGenerate(body: CustomerDataGenerateBody) {
      return request<CustomerDataGeneratorResult>('POST', '/generator/customer-data/generate', {
        body,
      });
    },
  },

  // 测评基准（三期）
  benchmarks: {
    formats() {
      return request<BenchmarkFormat[]>('GET', '/benchmarks/formats');
    },
    samples() {
      return request<BenchmarkSample[]>('GET', '/benchmarks/samples');
    },
    import(body: Record<string, unknown>) {
      return request<{ questionSetId: string; import: ImportRecord }>(
        'POST',
        '/benchmarks/import',
        {
          body,
        },
      );
    },
  },

  serviceAssurance: {
    readiness() {
      return request<ServiceAssuranceReadinessResponse>('GET', '/service-assurance/readiness');
    },
    scopePolicies() {
      return request<ServiceAssuranceScopeSettings>('GET', '/service-assurance/scope-policies');
    },
    previewScopePolicy(targetUrl: string) {
      return request<ServiceAssuranceScopePreview>(
        'POST',
        '/service-assurance/scope-policies/preview',
        { body: { targetUrl } },
      );
    },
    saveScopePolicies(policies: ServiceAssuranceScopePolicy[]) {
      return request<ServiceAssuranceScopeSettings>('PUT', '/service-assurance/scope-policies', {
        body: { policies },
      });
    },
    listRuns(query: ServiceAssuranceRunListQuery = {}) {
      return request<ServiceAssuranceRunListResponse>('GET', '/service-assurance/runs', { query });
    },
    linkTask(runId: string, taskId: string) {
      return request<{ run: ServiceAssuranceRunListItem; findingCount: number }>(
        'POST',
        `/service-assurance/runs/${runId}/link-task`,
        { body: { taskId } },
      );
    },
    unlinkTask(runId: string) {
      return request<{ run: ServiceAssuranceRunListItem }>(
        'POST',
        `/service-assurance/runs/${runId}/unlink-task`,
      );
    },
    getRun(runId: string) {
      return request<ServiceAssuranceRunDetailResponse>('GET', `/service-assurance/runs/${runId}`);
    },
    createRun(body: ServiceAssuranceCreateRequest) {
      return request<{ run: ServiceAssuranceRunListItem }>('POST', '/service-assurance/runs', {
        body,
      });
    },
    cancelRun(runId: string) {
      return request<{ run: ServiceAssuranceRunListItem }>(
        'POST',
        `/service-assurance/runs/${runId}/cancel`,
      );
    },
    reviewAssessment(assessmentId: string, body: ServiceAssuranceReviewRequest) {
      return request<{ result: ServiceAssuranceReviewResult }>(
        'POST',
        `/service-assurance/assessments/${assessmentId}/review`,
        { body },
      );
    },
    retestAssessment(assessmentId: string, body: ServiceAssuranceRetestRequest) {
      return request<{ run: ServiceAssuranceRunListItem }>(
        'POST',
        `/service-assurance/assessments/${assessmentId}/retest`,
        { body },
      );
    },
    evidence(runId: string) {
      return request<{ items: ServiceAssuranceEvidenceItem[] }>(
        'GET',
        `/service-assurance/runs/${runId}/evidence`,
      );
    },
  },

  // 安全引擎
  engines: {
    list() {
      return request<EngineCatalogItem[]>('GET', '/engines');
    },
    scanAiAssetStatic(body: AiAssetStaticScanBody) {
      return request<EngineScanResult>('POST', '/engines/ai-asset/static-scan', { body });
    },
    aiAssetFindings(query: { taskId: string }) {
      return request<EngineFinding[]>('GET', '/engines/ai-asset/findings', { query });
    },
    aiAssetRuns(query: { taskId: string }) {
      return request<EngineRunSummary[]>('GET', '/engines/ai-asset/runs', { query });
    },
    relayAudit(body: RelayAuditBody) {
      return request<EngineScanResult>('POST', '/engines/relay-audit/scan', { body });
    },
    relayFindings(query: { taskId: string }) {
      return request<EngineFinding[]>('GET', '/engines/relay-audit/findings', { query });
    },
    relayRuns(query: { taskId: string }) {
      return request<EngineRunSummary[]>('GET', '/engines/relay-audit/runs', { query });
    },
    customRisks() {
      return request<{ items: CustomRiskRule[]; presets: CustomRiskRule[] }>(
        'GET',
        '/engines/custom-risks',
      );
    },
    saveCustomRisks(body: { items: CustomRiskRule[] }) {
      return request<{ items: CustomRiskRule[] }>('PUT', '/engines/custom-risks', { body });
    },
    fuzzCustomRisks(body: { ruleIds?: string[]; questionSetName?: string }) {
      return request<{
        items: Array<{ ruleId: string; transform: string | null; label: string; content: string }>;
        questionSetId: string | null;
      }>('POST', '/engines/custom-risks/fuzz', { body });
    },
  },

  // Agent 一键测评
  agentEvals: {
    preview(body: AgentEvalPreviewBody) {
      return request<AgentEvalPreviewResult>('POST', '/agent-evals/preview', { body });
    },
    run(body: AgentEvalRunBody) {
      return request<AgentEvalRunResult>('POST', '/agent-evals/run', { body });
    },
    packs() {
      return request<{ items: AgentAttackPackSummary[] }>('GET', '/agent-evals/packs');
    },
    getConfig() {
      return request<AgentEvalConfig>('GET', '/agent-evals/config');
    },
    fanout(body: AgentFanoutRunBody): Promise<AgentFanoutRunResult> {
      return request<AgentFanoutRunResult>('POST', '/agent-evals/fanout', { body });
    },
    importAdrTrace(body: AdrTraceImportBody): Promise<AdrTraceImportResult> {
      return request<AdrTraceImportResult>('POST', '/agent-evals/adr/import', { body });
    },
  },

  // 网关日志分析
  gatewayLogs: {
    analyze(body: GatewayLogAnalysisBody) {
      return request<GatewayLogAnalysisResult>('POST', '/gateway-logs/analyze', { body });
    },
    drillPrepare(body: { canaryToken?: string; channels?: string[]; collectorUrl?: string }) {
      return request<GatewayDrillPrepareResult>('POST', '/gateway-logs/drill/prepare', { body });
    },
  },

  // 评估任务
  evalTasks: {
    endpointSummary: (id: string) =>
      request<EndpointTaskSummary>('GET', `/eval-tasks/${encodeURIComponent(id)}/endpoint-summary`),
    /** CI 结果导出（JUnit / SARIF / JSON），不含模型完整回答。 */
    exportCi(id: string, format: CiExportFormat) {
      const ext = { junit: 'xml', sarif: 'sarif', json: 'json' }[format];
      return downloadFile(
        `/eval-tasks/${encodeURIComponent(id)}/export`,
        { format },
        `lse-${id}.${ext}`,
      );
    },
    /** 国标符合性评估：不选样本库，攻击样本由平台生成器现产。 */
    createStandardCompliance(body: {
      modelTargetId: string;
      seed?: string;
      name?: string;
      counts?: Record<string, number>;
    }) {
      return request<StandardComplianceCreated>('POST', '/eval-tasks/standard-compliance', {
        body,
      });
    },
    riskSummary() {
      return request<{ agentRiskCount: number }>('GET', '/eval-tasks/risk-summary');
    },
    list(query?: {
      page?: number;
      pageSize?: number;
      keyword?: string;
      status?: string;
      modelTargetId?: string;
      result?: 'risk' | 'pass' | 'error';
      startFrom?: string;
      startTo?: string;
      tenantId?: string;
    }) {
      return request<Paginated<EvalTask>>('GET', '/eval-tasks', { query });
    },
    /** 按列表筛选导出全部匹配任务。 */
    exportList(
      query: {
        keyword?: string;
        status?: string;
        modelTargetId?: string;
        result?: 'risk' | 'pass' | 'error';
        startFrom?: string;
        startTo?: string;
        tenantId?: string;
      },
      format: 'csv' | 'json',
    ) {
      return downloadFile('/eval-tasks/export', { ...query, format }, `eval-tasks.${format}`);
    },
    get(id: string) {
      return request<EvalTaskDetail>('GET', `/eval-tasks/${id}`);
    },
    createBatch(body: {
      name: string;
      description?: string;
      modelTargetIds: string[];
      questionSetIds: string[];
      engines?: string[];
      dimensions?: string[];
      concurrency?: number;
      sampleSize?: number;
    }) {
      return request<{
        batchId: string;
        tasks: Array<{ id: string; name: string; modelTargetId: string }>;
      }>('POST', '/eval-tasks/batch', { body });
    },
    compare(query: { ids?: string; batchId?: string }) {
      return request<{ items: EvalCompareItem[]; differences?: EvalCompareDifference[] }>(
        'GET',
        '/eval-tasks/compare',
        { query },
      );
    },
    judgeCalibration(id: string) {
      return request<EvalJudgeCalibration>('GET', `/eval-tasks/${id}/judge-calibration`);
    },
    judgeCalibrationSample(id: string, query: { size?: number; seed?: string }) {
      return request<EvalSpotCheckSample>('GET', `/eval-tasks/${id}/judge-calibration/sample`, {
        query,
      });
    },
    create(body: Record<string, unknown>) {
      return request<EvalTaskDetail>('POST', '/eval-tasks', { body });
    },
    createRedTeam(body: RedTeamEvalCreateBody) {
      return request<EvalTaskDetail>('POST', '/eval-tasks/red-team', { body });
    },
    createMultimodal(body: MultimodalEvalCreateBody) {
      return request<{ id: string; name: string; totalQuestions: number; seed: string }>(
        'POST',
        '/eval-tasks/multimodal',
        { body },
      );
    },
    /** 客户自带图片集：上传 zip（含图片与 manifest.csv），校验通过后入库。 */
    async uploadByoImageSet(file: File, name?: string): Promise<ByoUploadResult> {
      const res = await fetch(
        buildUrl('/eval-tasks/multimodal/byo/image-sets', name ? { name } : undefined),
        {
          method: 'POST',
          headers: authHeaders('POST', { 'Content-Type': 'application/octet-stream' }),
          body: file,
        },
      );
      if (res.status === 401) {
        handleUnauthorized();
        throw await parseError(res);
      }
      if (!res.ok) throw await parseError(res);
      return (await res.json()) as ByoUploadResult;
    },
    createMultimodalByo(body: { modelTargetId: string; byoImageSetId: string; name?: string }) {
      return request<{ id: string; name: string; totalQuestions: number }>(
        'POST',
        '/eval-tasks/multimodal/byo',
        { body },
      );
    },
    deleteByoImageSetImages(setId: string) {
      return request<{ ok: boolean; deleted: number }>(
        'DELETE',
        `/eval-tasks/multimodal/byo/image-sets/${setId}/images`,
      );
    },
    deleteTaskByoImages(taskId: string) {
      return request<{ ok: boolean; deleted: number }>(
        'DELETE',
        `/eval-tasks/${taskId}/multimodal-byo-images`,
      );
    },
    downloadByoManifestTemplate() {
      return downloadFile(
        '/eval-tasks/multimodal/byo/manifest-template',
        undefined,
        'manifest-template.csv',
      );
    },
    multimodalGeneratorCategories(language: 'zh' | 'en') {
      return request<{ items: Array<{ id: string; label: string }> }>(
        'GET',
        '/eval-tasks/multimodal/generator-categories',
        { query: { language } },
      );
    },
    createComprehensive(body: ComprehensiveEvalCreateBody) {
      return request<EvalTaskDetail>('POST', '/eval-tasks/comprehensive', { body });
    },
    redTeamDirections() {
      return request<{ items: RedTeamDirection[] }>('GET', '/eval-tasks/red-team/directions');
    },
    /** 导入题库：把红队实战对抗生成的攻击题目新建或追加到自有题库。 */
    importToQuestionBank(
      id: string,
      body: {
        mode: 'create' | 'append';
        name?: string;
        questionSetId?: string;
        scope?: 'last_round' | 'all_rounds';
      },
    ) {
      return request<{ questionSetId: string; imported: number; skipped: number }>(
        'POST',
        `/eval-tasks/${id}/import-to-question-bank`,
        { body },
      );
    },
    results(
      id: string,
      query?: {
        page?: number;
        pageSize?: number;
        status?: string;
        verdict?: string;
        severity?: string;
      },
    ) {
      return request<Paginated<EvalResult>>('GET', `/eval-tasks/${id}/results`, { query });
    },
    explainResult(
      id: string,
      resultId: string,
      query?: { mode?: EvalResultExplanationMode; modelTargetId?: string },
    ) {
      return request<EvalResultExplanation>(
        'GET',
        `/eval-tasks/${id}/results/${resultId}/explanation`,
        { query },
      );
    },
    findings(
      id: string,
      query?: {
        page?: number;
        pageSize?: number;
        engine?: string;
        clientId?: string;
        sourceIp?: string;
      },
    ) {
      return request<Paginated<TaskFinding>>('GET', `/eval-tasks/${id}/findings`, { query });
    },
    logs(
      id: string,
      query?: { page?: number; pageSize?: number; level?: string; order?: 'asc' | 'desc' },
    ) {
      return request<Paginated<TaskLog>>('GET', `/eval-tasks/${id}/logs`, { query });
    },
    /** 导出该任务的全部日志。 */
    exportLogs(id: string, format: 'csv' | 'json') {
      return downloadFile(
        `/eval-tasks/${encodeURIComponent(id)}/logs/export`,
        { format },
        `eval-task-logs-${id}.${format}`,
      );
    },
    reEval(id: string) {
      return request<EvalTaskDetail>('POST', `/eval-tasks/${id}/re-eval`);
    },
    retestFailed(id: string, body: { findingId?: string; name?: string } = {}) {
      return request<FailedRetestCreated>('POST', `/eval-tasks/${id}/retest-failed`, { body });
    },
    cancel(id: string) {
      return request<EvalTaskDetail>('POST', `/eval-tasks/${id}/cancel`);
    },
    /** 暂停：执行中的任务返回 pauseRequested，进行中的题做完再停。 */
    pause(id: string) {
      return request<EvalTaskDetail>('POST', `/eval-tasks/${encodeURIComponent(id)}/pause`);
    },
    /** 恢复已暂停的任务；暂停中的任务撤销暂停。 */
    resume(id: string) {
      return request<EvalTaskDetail>('POST', `/eval-tasks/${encodeURIComponent(id)}/resume`);
    },
    remove(id: string) {
      return request<void>('DELETE', `/eval-tasks/${id}`);
    },
  },

  // 报告
  reports: {
    list(query?: { taskId?: string; tenantId?: string; kind?: ReportKind; page?: number; pageSize?: number }) {
      return request<Paginated<ReportListItem>>('GET', '/reports', { query });
    },
    get(id: string) {
      return request<Report>('GET', `/reports/${id}`);
    },
    create(body: {
      taskId: string;
      kind?: ReportKind;
      title?: string;
      explanationMode?: EvalResultExplanationMode;
      explanationModelTargetId?: string;
      applicationContext?: {
        businessScenario?: string;
        deploymentMode?:
          | 'third_party_api'
          | 'self_hosted_open_weights'
          | 'self_trained'
          | 'unknown';
        controlScope?: string;
      };
      sections?: string[];
      templateId?: string;
    }) {
      return request<Report>('POST', '/reports', { body });
    },
    /** 多任务组合报告：2～20 个已完成的评估任务。 */
    createCombined(body: { title: string; taskIds: string[]; templateId?: string }) {
      return request<Report>('POST', '/reports/combined', { body });
    },
    download(
      id: string,
      opts?: {
        profile?: string;
        severity?: string[];
        riskDomain?: string[];
        sections?: string[];
        /** 不传按生成时的模板，没有则用本租户默认模板。 */
        templateId?: string;
      },
      format: 'pdf' | 'html' | 'docx' = 'pdf',
    ) {
      return downloadFile(
        `/reports/${id}/download`,
        {
          format,
          profile: opts?.profile,
          severity: opts?.severity?.length ? opts.severity.join(',') : undefined,
          riskDomain: opts?.riskDomain?.length ? opts.riskDomain.join(',') : undefined,
          sections: opts?.sections?.length ? opts.sections.join(',') : undefined,
          templateId: opts?.templateId || undefined,
        },
        `report-${id}.${format}`,
      );
    },
    remove(id: string) {
      return request<void>('DELETE', `/reports/${id}`);
    },
  },

  // 报告模板（2.4.7）：读要 report:read，写要 report_template:manage
  reportTemplates: {
    /** 全部租户视角下带 tenantId 只列该租户的。 */
    list(query?: { tenantId?: string }) {
      return request<{ items: ReportTemplate[] }>('GET', '/report-templates', { query });
    },
    create(body: ReportTemplateInput) {
      return request<ReportTemplate>('POST', '/report-templates', { body });
    },
    update(id: string, body: Partial<ReportTemplateInput>) {
      return request<ReportTemplate>('PATCH', `/report-templates/${encodeURIComponent(id)}`, {
        body,
      });
    },
    remove(id: string) {
      return request<{ id: string; deleted: true }>(
        'DELETE',
        `/report-templates/${encodeURIComponent(id)}`,
      );
    },
    setDefault(id: string) {
      return request<ReportTemplate>(
        'POST',
        `/report-templates/${encodeURIComponent(id)}/default`,
      );
    },
  },

  // 风险样本
  wrongAnswers: {
    groups(query: RiskGroupQuery = {}) {
      return request<Paginated<RiskGroup> & { counts: Record<RiskGroup['status'], number> }>('GET', '/wrong-answers/groups', {
        query: { ...query, severity: query.severity?.join(','), agentRisk: query.agentRisk ? 'true' : undefined,
          reviewStatus: Array.isArray(query.reviewStatus) ? query.reviewStatus.join(',') : query.reviewStatus },
      });
    },
    group(id: string, query: RiskGroupQuery = {}) {
      return request<RiskGroupDetail>('GET', `/wrong-answers/groups/${id}`, {
        query: { ...query, severity: query.severity?.join(','), agentRisk: query.agentRisk ? 'true' : undefined,
          reviewStatus: Array.isArray(query.reviewStatus) ? query.reviewStatus.join(',') : query.reviewStatus },
      });
    },
    list(query?: {
      taskId?: string;
      findingIds?: string;
      page?: number;
      pageSize?: number;
      severity?: string[];
      agentRisk?: boolean;
      /**
       * 复核状态筛选：'pending' = 待复核（未复核 + 待人工复核，排除失败/已取消任务，
       * 与首页「待复核」、我的待办同一口径）；也可传具体状态数组。不传 = 不限。
       */
      reviewStatus?: 'pending' | string[];
      tenantId?: string;
    }) {
      const { severity, agentRisk, reviewStatus, ...rest } = query ?? {};
      return request<Paginated<WrongAnswer>>('GET', '/wrong-answers', {
        query: {
          ...rest,
          severity: severity?.length ? severity.join(',') : undefined,
          agentRisk: agentRisk ? 'true' : undefined,
          reviewStatus: Array.isArray(reviewStatus)
            ? reviewStatus.length
              ? reviewStatus.join(',')
              : undefined
            : reviewStatus,
        },
      });
    },
    export(
      taskId: string,
      severity?: string[],
      agentRisk?: boolean,
      findingIds?: string,
      scope: { domain?: string; since?: string; until?: string } = {},
    ) {
      return downloadFile(
        '/wrong-answers/export',
        {
          taskId,
          findingIds,
          severity: severity?.length ? severity.join(',') : undefined,
          agentRisk: agentRisk ? 'true' : undefined,
          domain: scope.domain,
          since: scope.since,
          until: scope.until,
        },
        `wrong-answers-${taskId}.xlsx`,
      );
    },
  },

  // 风险整改闭环
  remediation: {
    list(query?: {
      taskId?: string;
      status?: FindingRemediationStatus[];
      overdue?: boolean;
      page?: number;
      pageSize?: number;
    }) {
      const { status, ...rest } = query ?? {};
      return request<Paginated<RemediationFinding>>('GET', '/remediation', {
        query: { ...rest, status: status?.length ? status.join(',') : undefined },
      });
    },
    get(findingId: string) {
      return request<RemediationFinding>('GET', `/remediation/${findingId}`);
    },
    update(
      findingId: string,
      body: Partial<{
        status: FindingRemediationStatus;
        owner: string | null;
        team: string | null;
        controlLocation: string | null;
        action: string | null;
        dueAt: string | null;
        record: string | null;
        acceptanceCriteria: string | null;
        retestTaskId: string | null;
        closureEvidence: string | null;
      }>,
    ) {
      return request<{ reopened: boolean; finding: RemediationFinding }>(
        'PATCH',
        `/remediation/${findingId}`,
        { body },
      );
    },
    review(findingId: string, body: { status: FindingReviewStatus; reason: string | null }) {
      return request<{ finding: RemediationFinding }>('PATCH', `/remediation/${findingId}/review`, {
        body,
      });
    },
  },

  // 系统管理 / 平台运行配置
  systemSettings: {
    get() {
      return request<SystemSettings>('GET', '/system-settings');
    },
    testGateway(gatewayBaseUrl: string) {
      return request<{ ok: boolean; message: string; latencyMs?: number | null }>(
        'POST',
        '/system-settings/gateway/test',
        { body: { gatewayBaseUrl } },
      );
    },
    update(body: SystemSettingsUpdate) {
      return request<SystemSettings>('PATCH', '/system-settings', { body });
    },
  },

  // 配置管理（只读消费端）：单次评估题数、综合评估得分
  evaluationConfig: {
    get() {
      return request<EvaluationSettings>('GET', '/evaluation-config');
    },
    taskScore(taskId: string) {
      return request<TaskWeightedScore>('GET', `/evaluation-config/tasks/${taskId}/score`);
    },
  },

  dataSecurity: {
    get() {
      return request<DataSecurityStatus>('GET', '/data-security');
    },
    reveal(body: {
      kind: 'phone' | 'id_card' | 'email' | 'bank_card' | 'name';
      field: string;
      targetType?: string;
      targetId?: string;
    }) {
      return request<{ ok: boolean }>('POST', '/data-security/reveal', { body });
    },
  },

  // 系统管理 / License
  license: {
    get() {
      return request<LicenseInfo>('GET', '/license');
    },
    fingerprint() {
      return request<{ fingerprint: string }>('GET', '/license/fingerprint');
    },
    hostInfo() {
      return request<Record<string, unknown>>('GET', '/license/host-info');
    },
    upload(body: Record<string, unknown>) {
      return request<LicenseUploadResult>('POST', '/license', { body });
    },
  },

  // 用户
  users: {
    list(query?: {
      page?: number;
      pageSize?: number;
      keyword?: string;
      includeSystem?: boolean;
      tenantId?: string;
      registrationStatus?: RegistrationStatus;
      organizationId?: string;
      includeDescendants?: boolean;
    }) {
      return request<Paginated<User>>('GET', '/users', { query });
    },
    // 审核自助注册：通过时可同时分配角色
    reviewRegistration(
      id: string,
      body: { action: 'approve'; roleIds: string[] } | { action: 'reject' },
    ) {
      return request<User>('POST', `/users/${id}/registration`, { body });
    },
    get(id: string) {
      return request<User>('GET', `/users/${id}`);
    },
    create(body: Record<string, unknown>) {
      return request<User>('POST', '/users', { body });
    },
    update(id: string, body: Record<string, unknown>) {
      return request<User>('PATCH', `/users/${id}`, { body });
    },
    remove(id: string) {
      return request<void>('DELETE', `/users/${id}`);
    },
    resetPassword(id: string, password: string) {
      return request<{ ok: boolean }>('POST', `/users/${id}/reset-password`, {
        body: { password },
      });
    },
  },

  // 角色
  roles: {
    list() {
      return request<{ items: Role[] }>('GET', '/roles');
    },
    get(id: string) {
      return request<Role>('GET', `/roles/${id}`);
    },
    create(body: Record<string, unknown>) {
      return request<Role>('POST', '/roles', { body });
    },
    update(id: string, body: Record<string, unknown>) {
      return request<Role>('PATCH', `/roles/${id}`, { body });
    },
    remove(id: string) {
      return request<void>('DELETE', `/roles/${id}`);
    },
    users(id: string) {
      return request<{ items: RoleUser[]; truncated?: boolean }>('GET', `/roles/${id}/users`);
    },
  },

  // 平台运行状态（仅平台管理员）
  system: {
    status() {
      return request<SystemStatus>('GET', '/system/status');
    },
  },

  // 态势概览
  dashboard: {
    overview(query?: { period?: 'month' | '7d' | 'all' }) {
      return request<DashboardOverview>('GET', '/dashboard/overview', { query });
    },
    componentSecurity() {
      return request<ComponentSecurityStats>('GET', '/dashboard/component-security');
    },
    todos(query?: { reviewTaskPage?: number; reviewTaskPageSize?: number }) {
      return request<DashboardTodos>('GET', '/dashboard/todos', { query });
    },
    posture(query?: { range?: DashboardRange }) {
      return request<DashboardPosture>('GET', '/dashboard/posture', { query });
    },
    trend(query?: { days?: number }) {
      return request<DashboardTrend>('GET', '/dashboard/trend', { query });
    },
    riskCategories(query?: { limit?: number; range?: DashboardRange }) {
      return request<DashboardRiskCategories>('GET', '/dashboard/risk-categories', { query });
    },
    changes(query?: { range?: DashboardRange }) {
      return request<DashboardChanges>('GET', '/dashboard/changes', { query });
    },
    ruleLibrary() {
      return request<RuleLibraryStats>('GET', '/dashboard/rule-library');
    },
    /** 四类风险（2.2.2）：模型、数据、内容、应用与环境 */
    detectRisks(query?: { period?: DashboardRange }) {
      return request<DashboardDetectRisks>('GET', '/dashboard/detect-risks', { query });
    },
  },

  // 操作日志
  auditLogs: {
    list(query?: {
      page?: number;
      pageSize?: number;
      action?: string;
      category?: 'download';
      actorName?: string;
      targetType?: string;
      start?: string;
      end?: string;
      tenantId?: string;
    }) {
      return request<Paginated<AuditLog>>('GET', '/audit-logs', { query });
    },
    get(id: string) {
      return request<AuditLog>('GET', `/audit-logs/${id}`);
    },
    export(query: {
      format: 'csv' | 'json';
      action?: string;
      category?: 'download';
      actorName?: string;
      targetType?: string;
      start?: string;
      end?: string;
      tenantId?: string;
    }) {
      return downloadFile('/audit-logs/export', query, `操作日志.${query.format}`);
    },
  },

  // API 令牌（系统管理，仅管理员）
  // 租户管理（平台管理员）
  tenants: {
    list() {
      return request<{ items: TenantItem[] }>('GET', '/tenants');
    },
    create(body: TenantCreateInput) {
      return request<TenantItem>('POST', '/tenants', { body });
    },
    update(id: string, body: { name?: string; description?: string | null; isActive?: boolean }) {
      return request<TenantItem>('PATCH', `/tenants/${id}`, { body });
    },
    /** 资产归属转移：先预检拿到会搬走的条数与冲突，再执行。 */
    transferPreflight(body: TenantTransferInput) {
      return request<TenantTransferPlan>('POST', '/tenants/transfer/preflight', { body });
    },
    transfer(body: TenantTransferInput) {
      return request<TenantTransferResult>('POST', '/tenants/transfer', { body });
    },
  },

  apiTokens: {
    list() {
      return request<{ items: ApiTokenItem[]; scopes: ApiTokenScope[] }>('GET', '/api-tokens');
    },
    create(body: { name: string; scopes: ApiTokenScope[]; expiresInDays: number }) {
      return request<{ token: string; item: ApiTokenItem }>('POST', '/api-tokens', { body });
    },
    revoke(id: string) {
      return request<ApiTokenItem>('POST', `/api-tokens/${id}/revoke`);
    },
  },

  // 上线门禁
  gates: {
    list() {
      return request<{ items: GateRuleItem[] }>('GET', '/gates');
    },
    create(body: GateRuleInput) {
      return request<GateRuleItem>('POST', '/gates', { body });
    },
    update(id: string, body: Partial<GateRuleInput>) {
      return request<GateRuleItem>('PATCH', `/gates/${id}`, { body });
    },
    remove(id: string) {
      return request<void>('DELETE', `/gates/${id}`);
    },
    evaluations(id: string) {
      return request<{ items: GateEvaluationItem[] }>('GET', `/gates/${id}/evaluations`);
    },
    failing() {
      return request<{ total: number; items: FailingGateItem[] }>('GET', '/gates/failing');
    },
  },
  // 评估计划（W3）：模板 + cron 调度 + 启停；每次触发生成真实评估任务并记录运行。
  evalPlans: {
    list(query?: { page?: number; pageSize?: number; keyword?: string }) {
      return request<Paginated<EvalPlanItem>>('GET', '/eval-plans', { query });
    },
    get(id: string) {
      return request<EvalPlanItem>('GET', `/eval-plans/${id}`);
    },
    create(body: EvalPlanInput) {
      return request<EvalPlanItem>('POST', '/eval-plans', { body });
    },
    update(id: string, body: Partial<Omit<EvalPlanInput, 'enabled'>>) {
      return request<EvalPlanItem>('PATCH', `/eval-plans/${id}`, { body });
    },
    toggle(id: string, enabled: boolean) {
      return request<EvalPlanItem>('POST', `/eval-plans/${id}/toggle`, { body: { enabled } });
    },
    remove(id: string) {
      return request<{ ok: boolean }>('DELETE', `/eval-plans/${id}`);
    },
    /** 立即执行；本次被跳过时后端返回 409（ApiError，message 含跳过原因）。 */
    trigger(id: string) {
      return request<EvalPlanTriggerResult>('POST', `/eval-plans/${id}/trigger`);
    },
    runs(id: string, query?: { page?: number; pageSize?: number }) {
      return request<Paginated<EvalPlanRunItem>>('GET', `/eval-plans/${id}/runs`, { query });
    },
    tasks(id: string) {
      return request<{ items: EvalPlanTaskItem[] }>('GET', `/eval-plans/${id}/tasks`);
    },
    /** 回归对比：planId（+headTaskId）取计划相邻两次运行；或 baseTaskId + headTaskId 任选两任务。 */
    regression(query: { planId?: string; baseTaskId?: string; headTaskId?: string }) {
      return request<EvalRegressionResult>('GET', '/eval-plans/regression', { query });
    },
  },
};

export type CiExportFormat = 'junit' | 'sarif' | 'json';
export type ApiTokenScope = 'gates:read' | 'eval-plans:trigger' | 'eval-tasks:read';

export interface ApiTokenItem {
  id: string;
  name: string;
  prefix: string;
  maskedToken: string;
  scopes: ApiTokenScope[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

export interface GateRules {
  minScore?: number;
  maxHighRisk?: number;
  /** 类别 → 失败率上限（0–1）。 */
  categoryMaxFailRate?: Record<string, number>;
  noRegression?: boolean;
}

export interface GateRuleInput {
  name: string;
  modelTargetId?: string | null;
  planId?: string | null;
  rules: GateRules;
  enabled?: boolean;
}

export interface GateEvaluationItem {
  id: string;
  gateId: string;
  taskId: string;
  taskName?: string | null;
  /** 有效样本量与小样本警告（仅展示，不参与门禁判定）。 */
  sampleSize?: number | null;
  sampleWarning?: string | null;
  passed: boolean;
  reasons: string[];
  metrics: {
    score: number | null;
    highRiskCount: number;
    categoryFailureRates: Record<string, number>;
    previousScore: number | null;
  } | null;
  previousTaskId: string | null;
  createdAt: string;
}

export interface GateRuleItem {
  id: string;
  name: string;
  planId: string | null;
  modelTargetId: string | null;
  modelTargetName?: string | null;
  rules: GateRules;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  latest?: GateEvaluationItem | null;
}

export interface FailingGateItem {
  gateId: string;
  gateName: string;
  modelTargetId: string | null;
  planId: string | null;
  taskId: string;
  taskName: string | null;
  reasons: string[];
  evaluatedAt: string;
}

/** 评估计划模板：发起评估任务参数快照（与 POST /eval-tasks 同一校验，评估对象与任务名由计划决定）。 */
export interface EvalPlanTemplate {
  questionSetIds: string[];
  engines?: string[];
  dimensions?: string[];
  concurrency?: number;
  sampleSize?: number;
  sampleSeed?: string;
  description?: string;
}

export interface EvalPlanInput {
  name: string;
  description?: string | null;
  targetId: string;
  cron: string;
  timezone?: string;
  minIntervalMinutes?: number;
  enabled?: boolean;
  templateParams: EvalPlanTemplate;
}

export interface EvalPlanItem {
  id: string;
  name: string;
  description: string | null;
  targetId: string;
  targetName: string;
  targetActive: boolean;
  templateParams: EvalPlanTemplate;
  cron: string;
  timezone: string;
  enabled: boolean;
  minIntervalMinutes: number;
  lastTriggeredAt: string | null;
  lastSkipReason: string | null;
  nextRunAt: string | null;
  taskCount: number;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export type EvalPlanTriggerSource = 'manual' | 'schedule' | 'ci';

export interface EvalPlanTriggerResult {
  status: 'triggered' | 'skipped';
  runId: string;
  taskId?: string | null;
  reason?: string;
}

export interface EvalPlanRunItem {
  id: string;
  triggeredBy: EvalPlanTriggerSource;
  status: 'triggered' | 'skipped';
  reason: string | null;
  createdAt: string;
  task: {
    id: string;
    name: string;
    status: string;
    passedCount: number;
    failedCount: number;
    errorCount: number;
    totalQuestions: number;
    finishedAt: string | null;
  } | null;
}

export interface EvalPlanTaskItem {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  totalQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  passRate: number | null;
}

export interface EvalRegressionTask {
  id: string;
  name: string;
  status: string;
  planId: string | null;
  modelName: string;
  createdAt: string;
  finishedAt: string | null;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  passRate: number | null;
  evalScore: number | null;
  statistics?: EvalTaskStatistics;
}

/** 按题目对齐后的一条变化；失败口径 = FAIL 或 ERROR。 */
export interface EvalRegressionQuestion {
  questionId: string;
  category: string;
  baseVerdict: string | null;
  headVerdict: string | null;
  externalId: string | null;
  content: string;
  severity: string | null;
}

export interface EvalRegressionCategory {
  category: string;
  aligned: number;
  basePassRate: number | null;
  headPassRate: number | null;
  passRateDelta: number | null;
  newlyFailed: number;
  fixed: number;
  stillFailing: number;
}

export interface EvalRegressionResult {
  base: EvalRegressionTask;
  head: EvalRegressionTask;
  newlyFailed: EvalRegressionQuestion[];
  fixed: EvalRegressionQuestion[];
  stillFailing: EvalRegressionQuestion[];
  categories: EvalRegressionCategory[];
  summary: {
    aligned: number;
    onlyInBase: number;
    onlyInHead: number;
    newlyFailed: number;
    fixed: number;
    stillFailing: number;
    /** 每类明细最多返回条数；计数以 summary 为准。 */
    itemLimit: number;
    scoreDelta: number | null;
    passRateDelta: number | null;
    failRateDifference?: EvalDifferenceHint;
  };
}

// ---------------------------------------------------------------------------
// 策略建议（评估结果 → 网关策略 → 下发 → 复测）
// ---------------------------------------------------------------------------

export type PolicySuggestionStatus =
  | 'DRAFT'
  | 'ACCEPTED'
  | 'MODIFIED'
  | 'REJECTED'
  | 'DISPATCHED'
  | 'GATEWAY_PENDING'
  | 'PUBLISHED'
  | 'GATEWAY_REJECTED';

export type PolicyMatcher =
  | { kind: 'regex'; value: string }
  | { kind: 'keywords'; value: string[] }
  | { kind: 'field_names'; value: string[] };

export interface PolicySuggestion {
  id: string;
  externalId: string;
  taskId: string;
  modelTargetId: string;
  riskCategory: string;
  type: 'prompt_injection' | 'sensitive_data' | 'content_category' | 'tool_restriction';
  action: 'block' | 'alert' | 'mask';
  matcher: PolicyMatcher;
  examples: string[];
  sourceFindingIds: string[];
  estimatedImpact: {
    sampleCount: number;
    hitCount: number;
    coverage: number;
    passSampleCount: number;
    passSampleHits: number;
    description: string;
  };
  generationNote: string | null;
  status: PolicySuggestionStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
  gatewaySuggestionId: string | null;
  gatewayStatus: string | null;
  ruleSetVersion: string | null;
  dispatchedAt: string | null;
  dispatchError: string | null;
  lastPolledAt: string | null;
  pollExpired: boolean;
  preFailCount: number | null;
  preTotalCount: number | null;
  preAttackRate: number | null;
  postFailCount: number | null;
  postTotalCount: number | null;
  postAttackRate: number | null;
  retestStatus: string | null;
  retestError: string | null;
  retestTaskId: string | null;
  gatewaySupported: boolean;
  dispatchable: boolean;
  createdAt: string;
}

export interface PolicySuggestionDetail extends PolicySuggestion {
  sourceFindings: Array<{
    id: string;
    title: string | null;
    riskCategory: string;
    severity: string | null;
    evidence: string | null;
    result: { prompt: string; response: string | null } | null;
  }>;
  payloadPreview: Record<string, unknown>;
}

export interface PolicyGatewayCapability {
  configured: boolean;
  reachable: boolean;
  supported: boolean;
  message: string;
}

export const policySuggestionsApi = {
  list(query?: {
    taskId?: string;
    modelTargetId?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }) {
    return request<Paginated<PolicySuggestion>>('GET', '/policy-suggestions', { query });
  },
  get(id: string) {
    return request<PolicySuggestionDetail>('GET', `/policy-suggestions/${id}`);
  },
  capability() {
    return request<PolicyGatewayCapability>('GET', '/policy-suggestions/gateway-capability');
  },
  generate(body: { taskId?: string; modelTargetId?: string }) {
    return request<{
      created: number;
      updated: number;
      skipped: number;
      items: PolicySuggestion[];
    }>('POST', '/policy-suggestions/generate', { body });
  },
  review(
    id: string,
    body:
      | { decision: 'accept'; note?: string }
      | { decision: 'reject'; note: string }
      | { decision: 'modify'; matcher: PolicyMatcher; action?: string; note?: string },
  ) {
    return request<PolicySuggestion>('POST', `/policy-suggestions/${id}/review`, { body });
  },
  dispatch(ids: string[]) {
    return request<{
      results: Array<{ id: string; ok: boolean; status: string; error: string | null }>;
    }>('POST', '/policy-suggestions/dispatch', { body: { ids } });
  },
  refresh(id: string) {
    return request<PolicySuggestion & { poll: { polled: boolean; reason: string | null } }>(
      'POST',
      `/policy-suggestions/${id}/refresh`,
    );
  },
  exportJson(ids: string[]) {
    return request<Array<Record<string, unknown>>>('POST', '/policy-suggestions/export', {
      body: { ids },
    });
  },
};

// ============================= 模型文件扫描 / AIBOM（W5） =============================
/** 一个白名单目录：来源、对应的服务器路径与当前是否可用。 */
export interface ModelFileRootDetail {
  /** 容器内路径，也就是平台实际访问的路径 */
  path: string;
  /** 对应的服务器路径；只有部署时挂载的目录及其子目录能推出来 */
  hostPath: string | null;
  /** deploy=部署时配置（只读）；admin=管理员添加（可增删） */
  source: 'deploy' | 'admin';
  exists: boolean;
  readable: boolean;
  /** 不可用时的中文原因 */
  problem: string | null;
}
export interface ModelFileLimitBounds {
  pickleMaxBytes: { min: number; max: number };
  totalMaxBytes: { min: number; max: number };
  maxFiles: { min: number; max: number };
}
export interface ModelFileScanConfig {
  /** 管理员添加的目录 */
  roots: string[];
  pickleMaxBytes: number;
  totalMaxBytes: number;
  maxFiles: number;
  uploadMaxBytes: number;
  /** 部署时配置的目录，与 roots 取并集生效 */
  envRoots: string[];
  /** 服务器上对应容器内 /models 的目录；部署时未提供则为 null */
  hostDir: string | null;
  rootDetails: ModelFileRootDetail[];
  limitBounds: ModelFileLimitBounds;
  /** 库里遗留的、已不再生效的目录（写法不对或属于系统目录） */
  ignoredRoots: string[];
}
export interface ModelFileConfigUpdate {
  roots: string[];
  pickleMaxBytes: number;
  totalMaxBytes: number;
  maxFiles: number;
}
export interface ModelFileBrowseResult {
  path: string;
  hostPath: string | null;
  directories: string[];
  directoryTotal: number;
  modelFiles: Array<{ name: string; bytes: number; modifiedAt: string }>;
  modelFileTotal: number;
  fileCount: number;
  otherFileCount: number;
  truncated: boolean;
  scanLimited: boolean;
  limit: number;
}
export interface ModelFileScanRecord {
  id: string;
  source: 'UPLOAD' | 'DIRECTORY';
  path: string;
  targetId: string | null;
  target: { id: string; name: string } | null;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error: string | null;
  progressFiles: number;
  progressBytes: number;
  plannedFiles: number;
  plannedBytes: number;
  truncatedCount: number;
  truncatedReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  fileCount: number;
  totalBytes: number;
  skippedCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  hasAibom: boolean;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  files?: Array<{
    path: string;
    format: string;
    bytes: number;
    sha256: string;
    meta: Record<string, unknown>;
  }> | null;
}
/** 模型识别（扫描文件 meta.identification）。 */
export interface ModelFileIdentification {
  verdict: 'original' | 'quantized' | 'finetuned' | 'adapter' | 'merged' | 'unidentified';
  verdictLabel: string;
  name?: string;
  architecture?: string;
  modelType?: string;
  quantization?: string;
  dtype?: string;
  baseModel?: string;
  lora?: { peftType?: string; r?: number; alpha?: number; targetModules?: string[] };
  basis: string[];
}
/** 已知模型库命中（扫描文件 meta.knownModel）。 */
export interface ModelFileKnownModel {
  repo: string;
  name: string;
  family: string;
  kind: string;
  kindLabel: string;
  /** 官方发布的文件（官方仓库，或与官方一致的转存） */
  official?: boolean;
  /** 哈希经哪里核对（官方仓库的哈希取自社区转存或 ModelScope） */
  verifiedVia?: string;
  copyOf?: { repo: string; publisher: string; resaved: boolean };
  previous?: { revision: string; date?: string };
  quantization?: string;
  baseModel?: string;
  license?: string;
  file: string;
  source: string;
}
export interface ModelFileRule {
  id: string;
  category: string;
  /** detect：检测规则；note：解析、扫描过程和识别结果的提示 */
  kind: 'detect' | 'note';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  title: string;
  description: string;
}
export interface ModelFileScriptRiskGroup {
  format: string;
  total: number;
  items: Array<
    Pick<
      ModelFileFindingRecord,
      'id' | 'scanId' | 'filePath' | 'format' | 'severity' | 'ruleId' | 'title' | 'evidence'
    >
  >;
}
export interface ModelFileFindingRecord {
  id: string;
  scanId: string;
  filePath: string;
  format: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  ruleId: string;
  title: string;
  evidence: string;
  riskCategory: string;
  createdAt: string;
  reviewStatus: 'UNREVIEWED' | 'NEEDS_REVIEW' | 'CONFIRMED' | 'FALSE_POSITIVE' | 'ACCEPTED_RISK';
  reviewReason: string | null;
  remediationStatus:
    | 'OPEN'
    | 'IN_PROGRESS'
    | 'READY_FOR_RETEST'
    | 'VERIFIED_CLOSED'
    | 'REOPENED'
    | 'NOT_APPLICABLE';
  remediationOwner: string | null;
  remediationAction: string | null;
  remediationDueAt: string | null;
  remediationRecord: string | null;
  remediationClosureEvidence: string | null;
  remediationRetestScanId: string | null;
  remediationClosedAt: string | null;
}
export interface ModelFileAibomFields {
  targetId?: string | null;
  name?: string;
  source?: string;
  license?: string;
  parameterInfo?: string;
  datasetRefs?: string[];
  dependencySbom?: { contentType: string; content: string };
}
export interface ModelFileScanAccepted {
  id: string;
  status: ModelFileScanRecord['status'];
}
export interface TargetAibom {
  scanId: string;
  createdAt: string;
  source: 'UPLOAD' | 'DIRECTORY';
  aibom: {
    specVersion: string;
    components: Array<{
      type: string;
      name: string;
      version?: string;
      purl?: string;
      hashes?: Array<{ alg: string; content: string }>;
      licenses?: Array<{ license: { name?: string; id?: string } }>;
      properties?: Array<{ name: string; value: string }>;
    }>;
  };
}

export interface ModelFileLibraryItem {
  id: string;
  fileName: string;
  bytes: number;
  expectedBytes: number | null;
  status: 'UPLOADING' | 'READY';
  sha256: string | null;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  latestScan: { id: string; status: ModelFileScanRecord['status']; verdict: string | null } | null;
}
export interface ModelFileLibrary extends Paginated<ModelFileLibraryItem> {
  diskFreeBytes: number;
  libraryBytes: number;
}

export const modelFilesApi = {
  library(query?: { page?: number; pageSize?: number }) {
    return request<ModelFileLibrary>('GET', '/model-files/library', { query });
  },
  createLibraryUpload(body: { fileName: string; totalBytes?: number }) {
    return request<{ uploadId: string; chunkSize: number }>(
      'POST',
      '/model-files/library/uploads',
      { body },
    );
  },
  libraryUpload(id: string) {
    return request<{
      status: 'UPLOADING' | 'READY' | 'DELETED';
      bytes: number;
      expectedBytes: number | null;
    }>('GET', `/model-files/library/uploads/${encodeURIComponent(id)}`);
  },
  uploadLibraryChunk(
    id: string,
    offset: number,
    data: Blob,
    signal?: AbortSignal,
    onProgress?: (bytes: number) => void,
  ) {
    return new Promise<{ bytes: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        'PUT',
        buildUrl(`/model-files/library/uploads/${encodeURIComponent(id)}/chunk`, { offset }),
      );
      for (const [key, value] of Object.entries(
        authHeaders('PUT', { 'Content-Type': 'application/octet-stream' }),
      ))
        xhr.setRequestHeader(key, value);
      const stop = () => xhr.abort();
      const cleanup = () => signal?.removeEventListener('abort', stop);
      xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
      xhr.onerror = () => {
        cleanup();
        reject(new ApiError('上传中断，请检查网络后重试', 0));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException('上传已暂停', 'AbortError'));
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status === 401) handleUnauthorized();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new ApiError('服务器返回的上传进度有误，请重试', 0));
          }
        } else void parseError(new Response(xhr.responseText, { status: xhr.status })).then(reject);
      };
      if (signal?.aborted) {
        reject(new DOMException('上传已暂停', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', stop, { once: true });
      xhr.send(data);
    });
  },
  async completeLibraryUpload(id: string, signal?: AbortSignal) {
    const response = await fetch(
      buildUrl(`/model-files/library/uploads/${encodeURIComponent(id)}/complete`),
      {
        method: 'POST',
        headers: authHeaders('POST'),
        signal,
      },
    );
    if (response.status === 401) handleUnauthorized();
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as { uploadId: string; status: 'READY'; bytes: number };
  },
  deleteLibrary(id: string) {
    return request<{ deleted: true }>('DELETE', `/model-files/library/${encodeURIComponent(id)}`);
  },
  scanLibrary(id: string, body: ModelFileAibomFields = {}) {
    return request<ModelFileScanAccepted>(
      'POST',
      `/model-files/library/${encodeURIComponent(id)}/scan`,
      { body },
    );
  },
  config() {
    return request<ModelFileScanConfig>('GET', '/model-files/config');
  },
  updateConfig(body: ModelFileConfigUpdate) {
    return request<ModelFileScanConfig>('PUT', '/model-files/config', { body });
  },
  browse(path: string) {
    return request<ModelFileBrowseResult>('GET', '/model-files/browse', { query: { path } });
  },
  /** 原始字节上传（application/octet-stream，文件名走 query），用 XHR 以便显示上传进度。 */
  stageUpload(file: File, onProgress?: (loaded: number, total: number) => void) {
    return new Promise<{ uploadId: string; fileName: string; bytes: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', buildUrl('/model-files/uploads', { fileName: file.name }));
      for (const [k, v] of Object.entries(
        authHeaders('POST', { 'Content-Type': 'application/octet-stream' }),
      ))
        xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total || file.size);
      xhr.onerror = () => reject(new ApiError('上传中断，请检查网络后重试', 0));
      xhr.onload = () => {
        if (xhr.status === 401) handleUnauthorized();
        if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
        void parseError(new Response(xhr.responseText, { status: xhr.status })).then(reject);
      };
      xhr.send(file);
    });
  },
  scanUpload(body: { uploadId: string } & ModelFileAibomFields) {
    return request<ModelFileScanAccepted>('POST', '/model-files/scan/upload', { body });
  },
  cancel(id: string) {
    return request<ModelFileScanAccepted>('POST', `/model-files/scans/${id}/cancel`);
  },
  scanDirectory(body: { path: string } & ModelFileAibomFields) {
    return request<ModelFileScanAccepted>('POST', '/model-files/scan/directory', { body });
  },
  list(query?: { targetId?: string; page?: number; pageSize?: number }) {
    return request<Paginated<ModelFileScanRecord>>('GET', '/model-files/scans', { query });
  },
  get(id: string) {
    return request<ModelFileScanRecord>('GET', `/model-files/scans/${id}`);
  },
  findings(id: string, query?: { severity?: string; page?: number; pageSize?: number }) {
    return request<Paginated<ModelFileFindingRecord>>('GET', `/model-files/scans/${id}/findings`, {
      query,
    });
  },
  scriptRisks(id: string) {
    return request<{ groups: ModelFileScriptRiskGroup[] }>(
      'GET',
      `/model-files/scans/${id}/script-risks`,
    );
  },
  rules() {
    return request<{ total: number; detectTotal: number; noteTotal: number; items: ModelFileRule[] }>(
      'GET',
      '/model-files/rules',
    );
  },
  exportAibom(id: string) {
    return downloadFile(`/model-files/scans/${id}/aibom`, undefined, `aibom-${id}.cdx.json`);
  },
  targetAibom(targetId: string) {
    return request<TargetAibom | null>('GET', `/model-files/targets/${targetId}/aibom`);
  },
  targetLatest(targetId: string) {
    return request<Pick<
      ModelFileScanRecord,
      | 'id'
      | 'status'
      | 'source'
      | 'path'
      | 'createdAt'
      | 'finishedAt'
      | 'fileCount'
      | 'highCount'
      | 'mediumCount'
      | 'lowCount'
      | 'truncatedCount'
      | 'error'
    > | null>('GET', `/model-files/targets/${targetId}/latest`);
  },
  remediationFindings(query?: {
    page?: number;
    pageSize?: number;
    reviewStatus?: string;
    remediationStatus?: string;
  }) {
    return request<
      Paginated<
        ModelFileFindingRecord & {
          scan: {
            id: string;
            source: 'UPLOAD' | 'DIRECTORY';
            path: string;
            createdAt: string;
            createdById: string | null;
            target: { id: string; name: string } | null;
          };
        }
      >
    >('GET', '/model-files/findings', { query });
  },
  reviewFinding(
    id: string,
    body: { status: ModelFileFindingRecord['reviewStatus']; reason?: string | null },
  ) {
    return request<{ finding: ModelFileFindingRecord }>(
      'PATCH',
      `/model-files/findings/${id}/review`,
      { body },
    );
  },
  updateFinding(
    id: string,
    body: {
      status?: ModelFileFindingRecord['remediationStatus'];
      owner?: string | null;
      action?: string | null;
      dueAt?: string | null;
      record?: string | null;
      closureEvidence?: string | null;
      retestScanId?: string | null;
    },
  ) {
    return request<{ reopened: boolean; finding: ModelFileFindingRecord }>(
      'PATCH',
      `/model-files/findings/${id}`,
      { body },
    );
  },
};

// ============================= AI 资产测绘（影子 AI） =============================
export type DiscoveredServiceType =
  | 'OLLAMA'
  | 'VLLM'
  | 'XINFERENCE'
  | 'LM_STUDIO'
  | 'OPENAI_COMPATIBLE'
  | 'TGI'
  | 'TRITON';

export interface AssetDiscoveryScope {
  entries: string[];
  ports: number[];
  maxHostsPerRun: number;
}

export interface AssetDiscoveryRun {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  targets: string[];
  ports: number[];
  hostCount: number;
  portCount: number;
  /** 实际探测的端点数（URL、主机:端口与网段混填时不等于主机数 × 端口数）。 */
  endpointCount: number;
  probedCount: number;
  hitCount: number;
  error: string | null;
  createdByName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface AssetDiscoveryHitMatch {
  model: string | null;
  registered: boolean;
  targetId: string | null;
  targetName: string | null;
}

export interface AssetDiscoveryModelDetail {
  name: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  /** 计算精度（如 TGI 的 torch.float16），不是量化方式。 */
  dtype?: string;
  contextLength?: number;
}

export interface AssetDiscoveryHit {
  id: string;
  host: string;
  port: number;
  baseUrl: string;
  serviceType: DiscoveredServiceType;
  models: string[];
  /** 旧记录为 null。 */
  modelDetails: AssetDiscoveryModelDetail[] | null;
  evidence: string;
  matches: AssetDiscoveryHitMatch[];
}

export interface AssetDiscoveryRunDetail extends AssetDiscoveryRun {
  hits: AssetDiscoveryHit[];
}

export interface GatewayModelClue {
  model: string;
  providerId: string;
  endpointTypes: string[];
  eventCount: number;
  lastSeenAt: string | null;
  registered: boolean;
  targetId: string | null;
  targetName: string | null;
}

export type GatewayClueResult =
  | { status: 'NOT_CONNECTED' | 'UNREACHABLE'; message: string; clues: [] }
  | {
      status: 'OK';
      windowDays: number;
      eventCount: number;
      truncated: boolean;
      clues: GatewayModelClue[];
    };

export const assetDiscoveryApi = {
  scope() {
    return request<AssetDiscoveryScope>('GET', '/asset-discovery/scope');
  },
  saveScope(body: AssetDiscoveryScope) {
    return request<AssetDiscoveryScope>('PUT', '/asset-discovery/scope', { body });
  },
  runs() {
    return request<AssetDiscoveryRun[]>('GET', '/asset-discovery/runs');
  },
  run(id: string) {
    return request<AssetDiscoveryRunDetail>('GET', `/asset-discovery/runs/${id}`);
  },
  startRun(body: { targets: string[]; ports: number[]; confirm: true }) {
    return request<AssetDiscoveryRun>('POST', '/asset-discovery/runs', { body });
  },
  gatewayClues() {
    return request<GatewayClueResult>('GET', '/asset-discovery/gateway-clues');
  },
};

// ---------------------------------------------------------------------------
// RAG 专项评估（/api/rag-eval）
// ---------------------------------------------------------------------------

export type RagItemType =
  | 'FACT'
  | 'MULTI_HOP'
  | 'NO_ANSWER'
  | 'DISTRACTOR'
  | 'POISON'
  | 'INDIRECT_INJECTION'
  | 'CROSS_ACCESS';

export interface RagEvalStatus {
  judgeConfigured: boolean;
  judgeModelName: string | null;
  message: string | null;
  maxDocumentBytes: number;
  formats: string[];
  judgeSettingsPath?: string;
  alignmentModes?: Array<{ key: RagAlignmentMode; label: string }>;
  importFields?: string[];
}

/** 知识对齐模式：已有知识库 / 测试知识库包 / 检索接口直评。 */
export type RagAlignmentMode = 'KB_EXISTING' | 'TEST_PACKAGE' | 'RETRIEVAL_API';

export interface RagConfigCheck {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  hint: string;
}

export interface RagChunkSummary {
  id: string;
  seq: number;
  filename: string;
  preview: string;
}

export interface RagGenerationProgress {
  planned: number;
  done: number;
  generated: number;
  failed: number;
}

/** 分组指标中的单项：未评估样本不参与通过率，并列出原因。 */
export interface RagMetricSummary {
  key: string;
  label: string;
  applicable: number;
  samples: number;
  passed: number;
  passRate: number | null;
  average: number | null;
  notEvaluated: number;
  notEvaluatedReasons: Array<{ reason: string; count: number }>;
  extra?: Record<string, number>;
}

export interface RagGroupMetrics {
  generation: RagMetricSummary[];
  retrieval: RagMetricSummary[];
  retrievalStats: { hitAtK: number | null; mrr: number | null; samples: number };
  security: RagMetricSummary[];
}

export interface RagCleanupRecord {
  attempted: boolean;
  ok: boolean;
  reason: string | null;
  residual: Array<{
    filename: string;
    knowledgeBaseId: string;
    documentId: string | null;
    error: string | null;
  }>;
  deleted: number;
}

export interface RagIndexProbe {
  ready: boolean;
  hitRate: number;
  threshold: number;
  attempts: number;
  elapsedMs: number;
  timeoutSec: number;
  docs: Array<{ manifestId: string; filename: string; hit: boolean; via: string | null }>;
  error: string | null;
}

export interface RagCorpus {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  documentCount: number;
  chunkCount: number;
  testSetCount: number;
}

export interface RagDocument {
  id: string;
  corpusId: string;
  filename: string;
  format: string;
  sizeBytes: number;
  textLength: number;
  chunkCount: number;
  createdAt: string;
}

export interface RagTarget {
  id: string;
  name: string;
  targetType: string;
  isActive: boolean;
  citationConfigured: boolean;
  knowledgeUploadConfigured: boolean;
  restrictedKnowledgeBaseConfigured: boolean;
  eligible?: boolean;
  defaultAlignmentMode?: RagAlignmentMode | null;
  contextConfigured?: boolean;
  knowledgeDeleteConfigured?: boolean;
  retrievalConfigured?: boolean;
  restrictedCredentialConfigured?: boolean;
  checklist?: RagConfigCheck[];
  ready?: boolean;
}

export interface RagGenerationStats {
  requested?: Partial<Record<RagItemType, number>>;
  generated?: Partial<Record<RagItemType, number>>;
  failures?: Array<{ type: string; error: string }>;
  includeSecurity?: boolean;
}

export interface RagTestSetSummary {
  id: string;
  corpusId: string;
  corpusName: string;
  name: string;
  seed: string;
  promptVersion: string;
  judgeModelName: string | null;
  generationStats: RagGenerationStats | null;
  itemCount: number;
  runCount: number;
  createdAt: string;
  alignmentMode?: RagAlignmentMode;
  alignmentModeLabel?: string;
  generationStatus?: 'GENERATING' | 'READY' | 'FAILED' | 'CANCELED';
  generationProgress?: RagGenerationProgress | null;
  generationError?: string | null;
}

export interface RagTestItem {
  id: string;
  type: RagItemType;
  question: string;
  referenceAnswer: string | null;
  sourceChunkIds: string[];
  origin: string;
}

export interface RagTestSetDetail {
  id: string;
  name: string;
  seed: string;
  promptVersion: string;
  judgeModelName: string | null;
  corpus: { id: string; name: string };
  alignmentMode?: RagAlignmentMode;
  alignmentModeLabel?: string;
  generationStatus?: string;
  items: RagTestItem[];
  sources: Array<{ id: string; seq: number; filename: string; content: string }>;
}

export interface RagTypeMetrics {
  itemType: RagItemType;
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  error: number;
  restricted: number;
  correctRate: number | null;
  avgFaithfulness: number | null;
  refusalRate: number | null;
  avgCitationAccuracy: number | null;
}

export interface RagEvalRun {
  id: string;
  taskId: string;
  testSetId: string;
  testSetName: string;
  modelTargetId: string;
  modelTargetName: string;
  status: string;
  taskStatus: string;
  progress: number;
  processed: number;
  total: number;
  summary: Record<string, unknown> | null;
  error: string | null;
  poisonDocumentImported: boolean;
  sentinelDocumentImported: boolean;
  createdAt: string;
  alignmentMode?: RagAlignmentMode;
  alignmentModeLabel?: string;
  alignmentConfirmedByName?: string | null;
  alignmentConfirmedAt?: string | null;
  packageImported?: boolean;
  indexProbe?: RagIndexProbe | null;
  uploads?: Array<{
    filename: string;
    role: string;
    knowledgeBase: string;
    ok: boolean;
    error: string | null;
  }> | null;
  cleanup?: RagCleanupRecord | null;
}

export interface RagEvalRunDetail extends RagEvalRun {
  metrics: RagTypeMetrics[];
  groups?: RagGroupMetrics;
  capabilities: {
    citationConfigured: boolean;
    knowledgeUploadConfigured: boolean;
    restrictedKnowledgeBaseConfigured: boolean;
    contextConfigured?: boolean;
    knowledgeDeleteConfigured?: boolean;
    retrievalConfigured?: boolean;
  };
}

export interface RagEvalResult {
  id: string;
  itemType: RagItemType;
  question: string;
  referenceAnswer: string | null;
  response: string | null;
  status: 'SUCCESS' | 'ERROR' | 'RESTRICTED';
  errorMessage: string | null;
  correctness: number | null;
  faithfulness: number | null;
  refusalOk: boolean | null;
  citationAccuracy: number | null;
  injectionFollowed: boolean | null;
  sentinelLeaked: boolean | null;
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR';
  reason: string | null;
  latencyMs: number | null;
  citations?: unknown;
  retrievedContext?: unknown;
  retrievalRank?: number | null;
  retrievalEvaluated?: boolean;
  notEvaluated?: Record<string, string> | null;
  needsReview?: boolean;
}

export interface RagConnectionCheck {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  checks: Array<{ key: string; label: string; status: 'pass' | 'fail' | 'unconfigured'; reason: string }>;
}

export const ragEvalApi = {
  checkTarget(id: string, mode?: RagAlignmentMode) {
    return request<RagConnectionCheck>('POST', `/rag-eval/targets/${id}/check`, { body: { mode } });
  },
  checkJudge(modelTargetId?: string) {
    return request<{ available: boolean; message: string | null }>('POST', '/rag-eval/judge/check', { body: { modelTargetId } });
  },
  status() {
    return request<RagEvalStatus>('GET', '/rag-eval/status');
  },
  targets(mode?: RagAlignmentMode) {
    return request<RagTarget[]>('GET', '/rag-eval/targets', { query: { mode } });
  },
  corpusChunks(corpusId: string) {
    return request<RagChunkSummary[]>('GET', `/rag-eval/corpora/${corpusId}/chunks`);
  },
  corpora() {
    return request<RagCorpus[]>('GET', '/rag-eval/corpora');
  },
  createCorpus(body: { name: string; description?: string }) {
    return request<{ id: string }>('POST', '/rag-eval/corpora', { body });
  },
  deleteCorpus(id: string) {
    return request<{ ok: true }>('DELETE', `/rag-eval/corpora/${id}`);
  },
  documents(corpusId: string) {
    return request<RagDocument[]>('GET', `/rag-eval/corpora/${corpusId}/documents`);
  },
  uploadDocument(corpusId: string, body: { filename: string; contentBase64: string }) {
    return request<RagDocument>('POST', `/rag-eval/corpora/${corpusId}/documents`, { body });
  },
  deleteDocument(id: string) {
    return request<{ ok: true }>('DELETE', `/rag-eval/documents/${id}`);
  },
  testSets(corpusId?: string) {
    return request<RagTestSetSummary[]>('GET', '/rag-eval/test-sets', { query: { corpusId } });
  },
  generateTestSet(
    corpusId: string,
    body: {
      name: string;
      seed?: string;
      alignmentMode?: RagAlignmentMode;
      counts: Partial<Record<'FACT' | 'MULTI_HOP' | 'NO_ANSWER' | 'DISTRACTOR', number>>;
      includeSecurity: boolean;
    },
  ) {
    return request<{ id: string; name: string; seed: string; generationStatus: string }>(
      'POST',
      `/rag-eval/corpora/${corpusId}/test-sets/generate`,
      { body },
    );
  },
  createEmptyTestSet(
    corpusId: string,
    body: { name: string; alignmentMode?: RagAlignmentMode; includeSecurity?: boolean },
  ) {
    return request<{ id: string; name: string }>(
      'POST',
      `/rag-eval/corpora/${corpusId}/test-sets`,
      {
        body,
      },
    );
  },
  cancelGeneration(testSetId: string) {
    return request<{ ok: true }>('POST', `/rag-eval/test-sets/${testSetId}/generation/cancel`);
  },
  updateTestSet(id: string, body: { name?: string; alignmentMode?: RagAlignmentMode }) {
    return request<{ id: string }>('PATCH', `/rag-eval/test-sets/${id}`, { body });
  },
  createItem(
    testSetId: string,
    body: {
      type: RagItemType;
      question: string;
      referenceAnswer?: string | null;
      sourceChunkIds?: string[];
    },
  ) {
    return request<RagTestItem>('POST', `/rag-eval/test-sets/${testSetId}/items`, { body });
  },
  updateItem(
    testSetId: string,
    itemId: string,
    body: Partial<{
      type: RagItemType;
      question: string;
      referenceAnswer: string | null;
      sourceChunkIds: string[];
    }>,
  ) {
    return request<RagTestItem>('PATCH', `/rag-eval/test-sets/${testSetId}/items/${itemId}`, {
      body,
    });
  },
  deleteItem(testSetId: string, itemId: string) {
    return request<{ ok: true }>('DELETE', `/rag-eval/test-sets/${testSetId}/items/${itemId}`);
  },
  importItems(testSetId: string, body: { format: 'csv' | 'jsonl'; content: string }) {
    return request<{ imported: number; duplicates: number }>(
      'POST',
      `/rag-eval/test-sets/${testSetId}/items/import`,
      { body },
    );
  },
  exportItems(testSetId: string, format: 'csv' | 'jsonl') {
    return downloadFile(
      `/rag-eval/test-sets/${testSetId}/items/export`,
      { format },
      `rag-test-set.${format}`,
    );
  },
  downloadTestPackage(testSetId: string) {
    return downloadFile(
      `/rag-eval/test-sets/${testSetId}/package`,
      undefined,
      'lse-rag-test-package.zip',
    );
  },
  testSet(id: string) {
    return request<RagTestSetDetail>('GET', `/rag-eval/test-sets/${id}`);
  },
  deleteTestSet(id: string) {
    return request<{ ok: true }>('DELETE', `/rag-eval/test-sets/${id}`);
  },
  downloadSecurityDocument(testSetId: string, kind: 'poison' | 'sentinel') {
    return downloadFile(
      `/rag-eval/test-sets/${testSetId}/security-documents/${kind}`,
      undefined,
      `lse-rag-${kind}-test.md`,
    );
  },
  runs(testSetId?: string) {
    return request<RagEvalRun[]>('GET', '/rag-eval/runs', { query: { testSetId } });
  },
  createRun(body: {
    testSetId: string;
    modelTargetId: string;
    name?: string;
    alignmentConfirmed?: boolean;
    packageImported?: boolean;
    poisonDocumentImported: boolean;
    sentinelDocumentImported: boolean;
  }) {
    return request<{ id: string; taskId: string; status: string }>('POST', '/rag-eval/runs', {
      body,
    });
  },
  run(id: string) {
    return request<RagEvalRunDetail>('GET', `/rag-eval/runs/${id}`);
  },
  cancelRun(id: string) {
    return request<{ ok: true }>('POST', `/rag-eval/runs/${id}/cancel`);
  },
  results(
    id: string,
    query?: {
      page?: number;
      pageSize?: number;
      itemType?: string;
      verdict?: string;
      needsReview?: 'true' | 'false';
    },
  ) {
    return request<Paginated<RagEvalResult>>('GET', `/rag-eval/runs/${id}/results`, { query });
  },
};

// ---------------- 模型指纹（W6c） ----------------

export type FingerprintSource = 'MANUAL' | 'PRE_TASK';

export interface ModelFingerprint {
  id: string;
  modelTargetId: string;
  probeVersion: string;
  outputs: Array<{ probeId: string; output: string }>;
  features: Array<{
    probeId: string;
    length: number;
    refused: boolean;
    jsonParsable: boolean;
    text: string;
  }>;
  source: FingerprintSource;
  isBaseline: boolean;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ModelFingerprintList {
  items: ModelFingerprint[];
  baselineId: string | null;
  probeVersion: string;
  probes: Array<{ id: string; kind: string; prompt: string }>;
  defaultThreshold: number;
}

export interface ModelFingerprintMeta {
  id: string;
  probeVersion: string;
  createdAt: string;
  isBaseline: boolean;
  source: FingerprintSource;
}

export type FingerprintComponentKey = 'ngram' | 'length' | 'refusal' | 'format' | 'identity';

export interface ModelFingerprintComparison {
  a: ModelFingerprintMeta;
  b: ModelFingerprintMeta;
  similarity: number;
  threshold: number;
  drift: boolean;
  components: Record<FingerprintComponentKey, number>;
  weights: Record<FingerprintComponentKey, number>;
  comparedProbes: number;
}

/** 任务执行前指纹比对结果（EvalTask.fingerprintCheck） */
export interface EvalTaskFingerprintCheck {
  status: 'OK' | 'DRIFT' | 'FAILED' | 'NO_BASELINE';
  similarity: number | null;
  threshold: number | null;
  baselineId: string | null;
  fingerprintId: string | null;
  reason: string | null;
  checkedAt: string | null;
}

export const modelFingerprintApi = {
  list(targetId: string, limit = 20) {
    return request<ModelFingerprintList>('GET', `/model-targets/${targetId}/fingerprints`, {
      query: { limit },
    });
  },
  collect(targetId: string) {
    return request<ModelFingerprint>('POST', `/model-targets/${targetId}/fingerprints`);
  },
  setBaseline(targetId: string, fpId: string) {
    return request<ModelFingerprint>(
      'POST',
      `/model-targets/${targetId}/fingerprints/${fpId}/baseline`,
    );
  },
  compare(targetId: string, query: { a: string; b: string; threshold?: number }) {
    return request<ModelFingerprintComparison>(
      'GET',
      `/model-targets/${targetId}/fingerprints/compare`,
      { query },
    );
  },
};

/** 任务详情追加字段（接口合并）：任务执行前模型指纹比对结果，未比对时为 null。 */
export interface EvalTaskDetail {
  fingerprintCheck?: EvalTaskFingerprintCheck | null;
}

// ---------------------------------------------------------------------------
// AI 组件漏洞扫描（独立扫描记录，不依赖评估任务；关联任务为可选的显式动作）
// ---------------------------------------------------------------------------

export type AiComponentAssetType = 'SKILL' | 'MCP' | 'PLUGIN';
export type AiComponentReviewStatus = 'PENDING' | 'CONFIRMED' | 'FALSE_POSITIVE';

export interface AiComponentConfig {
  uploadMaxBytes: number;
  archiveFormats: string[];
  mcpFetch: {
    available: boolean;
    transports?: string[];
    reason?: string;
    /** 出站策略布尔摘要；不含允许清单内容。 */
    egress?: { allowlistConfigured: boolean; allowPrivateNetworks: boolean };
  };
  stdioSupported: boolean;
  stdioNote: string;
}

export interface AiComponentScanSummary {
  id: string;
  assetName: string;
  assetType: AiComponentAssetType;
  assetVersion: string | null;
  assetKey: string;
  sourceType: 'UPLOAD' | 'ARCHIVE' | 'MCP_ENDPOINT';
  sourceLabel: string | null;
  endpointUrl: string | null;
  contentSha256: string | null;
  status: 'COMPLETED' | 'FAILED';
  error: string | null;
  fileCount: number;
  totalBytes: number;
  skippedCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  judgeStatus: 'NOT_NEEDED' | 'NOT_CONFIGURED' | 'REVIEWED' | 'FAILED' | null;
  linkedTaskId: string | null;
  linkedTaskName?: string | null;
  linkedAt: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface AiComponentScanList {
  items: AiComponentScanSummary[];
  total: number;
  page: number;
  pageSize: number;
  capabilities: { vulnDb: boolean; mcpFetch: boolean };
}

export interface AiComponentScanDetail extends AiComponentScanSummary {
  files: Array<{ path: string; bytes?: number; sha256?: string; skipped?: string }> | null;
  canRescan: boolean;
  previousScan: { id: string; assetVersion: string | null; createdAt: string } | null;
}

export interface AiComponentFindingLocation {
  path: string;
  line: number;
  excerpt: string;
  toolName?: string;
}

export interface AiComponentFindingItem {
  id: string;
  scanId: string;
  ruleId: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  riskCategory: string;
  title: string;
  description: string;
  remediation: string;
  filePath: string | null;
  line: number | null;
  locations: AiComponentFindingLocation[];
  evidence: string | null;
  confidence: number;
  fingerprint: string;
  reviewStatus: AiComponentReviewStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
  linkedFindingId: string | null;
  detail: {
    totalLocations?: number;
    truncatedLocations?: number;
    judge?: { status: string; model?: string; note?: string; reason?: string; poisoned?: boolean };
    baseline?: {
      previousDescription?: string;
      previousInputSchema?: unknown;
      previousAnnotations?: unknown;
      inputSchemaRecorded?: boolean;
    };
    currentTool?: { description: string; inputSchema?: unknown; annotations?: unknown };
    [k: string]: unknown;
  } | null;
  taxonomy: Array<{ framework: string; id: string; title?: string }> | null;
  createdAt: string;
}

export interface AiComponentCompareItem {
  id: string;
  ruleId: string;
  severity: string;
  title: string;
  filePath: string | null;
  line: number | null;
  evidence: string | null;
  /** 仅 rug pull（mcp.rug_pull）发现项：逐字段的基线值与当前值 */
  toolChange?: {
    toolName: string | null;
    baseline: {
      description: string | null;
      inputSchema: unknown;
      annotations: unknown;
      inputSchemaRecorded: boolean;
    };
    current: { description: string | null; inputSchema: unknown; annotations: unknown };
  };
}

export interface AiComponentCompare {
  added: AiComponentCompareItem[];
  removed: AiComponentCompareItem[];
  unchanged: number;
  descriptionChanged: AiComponentCompareItem[];
}

export interface AiComponentUploadMeta {
  assetName: string;
  assetType: AiComponentAssetType;
  assetVersion?: string;
  sourceLabel?: string;
  fileName: string;
  mode: 'UPLOAD' | 'ARCHIVE';
}

export async function uploadOctetStream<T>(
  path: string,
  query: Query,
  body: Blob | Uint8Array,
): Promise<T> {
  const res = await fetch(buildUrl(path, query), {
    method: 'POST',
    headers: authHeaders('POST', { 'Content-Type': 'application/octet-stream' }),
    body: body instanceof Blob ? body : new Blob([body as BlobPart]),
  });
  if (res.status === 401) {
    handleUnauthorized();
    throw await parseError(res);
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export const aiComponentsApi = {
  config() {
    return request<AiComponentConfig>('GET', '/engines/ai-components/config');
  },
  upload(meta: AiComponentUploadMeta, body: Blob | Uint8Array) {
    return uploadOctetStream<{ id: string }>(
      '/engines/ai-components/scans/upload',
      { ...meta },
      body,
    );
  },
  scanEndpoint(body: {
    assetName: string;
    assetType: AiComponentAssetType;
    assetVersion?: string;
    url: string;
    headers?: Record<string, string>;
  }) {
    return request<{ id: string }>('POST', '/engines/ai-components/scans/endpoint', { body });
  },
  list(query: { keyword?: string; assetKey?: string; page?: number; pageSize?: number }) {
    return request<AiComponentScanList>('GET', '/engines/ai-components/scans', { query });
  },
  get(id: string) {
    return request<AiComponentScanDetail>('GET', `/engines/ai-components/scans/${id}`);
  },
  findings(id: string, query: { severity?: string; reviewStatus?: string } = {}) {
    return request<AiComponentFindingItem[]>('GET', `/engines/ai-components/scans/${id}/findings`, {
      query,
    });
  },
  review(findingId: string, body: { status: AiComponentReviewStatus; note?: string }) {
    return request<AiComponentFindingItem>(
      'PATCH',
      `/engines/ai-components/findings/${findingId}/review`,
      { body },
    );
  },
  acceptBaseline(findingId: string) {
    return request<{ ok: true }>(
      'POST',
      `/engines/ai-components/findings/${findingId}/accept-baseline`,
    );
  },
  rescan(id: string) {
    return request<{ id: string }>('POST', `/engines/ai-components/scans/${id}/rescan`);
  },
  remove(id: string) {
    return request<{ ok: true }>('DELETE', `/engines/ai-components/scans/${id}`);
  },
  linkTask(id: string, body: { taskId: string; includeFalsePositive?: boolean }) {
    return request<{ linkedCount: number; taskId: string; taskName: string }>(
      'POST',
      `/engines/ai-components/scans/${id}/link-task`,
      { body },
    );
  },
  compare(base: string, target: string) {
    return request<AiComponentCompare>('GET', '/engines/ai-components/compare', {
      query: { base, target },
    });
  },
};
