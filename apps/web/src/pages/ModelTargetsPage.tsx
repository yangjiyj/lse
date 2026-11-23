import { endpointProduct as parseEndpointProduct } from '@/lib/endpoint-agents';
import type { FleetLiveProduct } from '../../../../packages/shared/src/fleet-live-eval';
import { EndpointAgentFields } from './model-targets/EndpointAgentFields';
import { EndpointTargetDetails } from './model-targets/EndpointTargetDetails';
import {
  ENDPOINT_EVAL_MODE_LABELS,
  useEndpointEvalLauncher,
} from './model-targets/useEndpointEvalLauncher';
import { FLEET_ENROLL_PATH, targetDisplayName } from '@/lib/fleet';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Plug,
  Pencil,
  Trash2,
  CheckCircle2,
  XCircle,
  Search,
  HelpCircle,
  Stethoscope,
  TerminalSquare,
  ListChecks,
  Building2,
} from 'lucide-react';
import {
  api,
  ApiError,
  type GatewayLogAnalysisBody,
  type ModelTarget,
  type ModelTargetBatchTestResult,
  type ModelTargetDiagnoseReport,
  type ModelTestResult,
  type TargetType,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isPlatformTenantUser } from '@/lib/tenant';
import { TenantCell, TenantFilterSelect, useTenantView } from '@/lib/tenant-view';
import { TenantTransferDialog } from '@/components/TenantTransferDialog';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { RowActionMenu, type RowActionItem } from '@/components/page-kit/RowActionMenu';
import { TagCluster } from '@/components/page-kit/TagCluster';
import { FormSection } from '@/components/page-kit/FormSection';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { GatewayDrillModal } from './GatewayDrillModal';
import {
  EMPTY_RAG_FORM,
  RagTargetFields,
  buildRagPayload,
  ragFormFields,
  type RagFormState,
} from './model-targets/RagTargetFields';
import {
  AgentApiAccessFields,
  DEFAULT_REQUEST_TEMPLATE,
  buildAgentAccessConfig,
} from './model-targets/AgentApiAccessFields';
import { Spinner } from '@/components/ui/spinner';
import { QueryState } from '@/components/QueryState';
import { formatDateTime, formatLatency } from '@/lib/format';
import { PRODUCT_NAME } from '@/lib/product-name';
import {
  MODEL_ACCESS_PRESETS,
  TENDER_TEXT_APP_ACCESS,
  TENDER_TEXT_BATCH_TEST,
  TENDER_TEXT_CURL_IMPORT,
  TENDER_TEXT_DIAGNOSE,
  TENDER_TEXT_MODEL_ACCESS,
  accessTypeLabel,
  presetByProvider,
} from './model-targets/access-presets';
import {
  CurlImportModal,
  stripContentType,
  type CurlApplyPayload,
} from './model-targets/CurlImportModal';
import { DiagnoseReportView } from './model-targets/DiagnoseReportView';
import {
  FINGERPRINT_TARGET_TYPES,
  TargetFingerprintSection,
} from '@/components/model-fingerprint/TargetFingerprintSection';

type AgentEntryMode = 'api' | 'public' | 'mcp';

// 小问号：把「OpenAI 兼容 / 网关证据源 / 重判对标」等技术黑话收进 tooltip，
// 界面正文使用用户可读术语，技术细节通过提示补充。
function HelpHint({ text, label }: { text: string; label?: string }) {
  return (
    <span
      title={text}
      aria-label={label ?? text}
      className="ml-1 inline-flex cursor-help align-middle text-muted-foreground"
    >
      <HelpCircle className="h-3.5 w-3.5" />
    </span>
  );
}

interface FormState extends RagFormState {
  endpointId: string;
  endpointLabel: string;
  agentshieldBaseUrl: string;
  endpointProduct: FleetLiveProduct;
  name: string;
  targetType: TargetType;
  agentEntryMode: AgentEntryMode;
  platform: 'dify' | 'coze';
  appMode: 'agent-chat' | 'chat' | 'advanced-chat' | 'workflow';
  botId: string;
  /** 平台对象的暗号，只写不回显：编辑时初始为空（读到的是脱敏值），留空保存由服务端沿用已存值。 */
  knowledgeCanary: string;
  systemCanary: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  authType: 'bearer' | 'api_key' | 'none';
  authHeaderName: string;
  sessionHeaderName: string;
  customHeaders: string;
  requestTemplate: string;
  responseTextPath: string;
  schemaUrl: string;
  entryUrl: string;
  gatewayBaseUrl: string;
  tenantId: string;
  gatewayClientId: string;
  gatewaySourceIp: string;
  isActive: boolean;
  isGlobal: boolean;
  supportsVision: boolean;
}

const TARGET_OPTIONS: Array<{
  value: TargetType;
  label: string;
  description: string;
}> = [
  {
    value: 'MODEL',
    label: '模型（OpenAI 兼容 API 接入）',
    description:
      '目标模型通过 OpenAI 兼容 API 接入，兼容本地模型服务、云端模型服务及国家管网集团标准模型接口。',
  },
  {
    value: 'AGENT_API',
    label: '模型应用、智能体应用（非标准业务接口）',
    description:
      '支持非标准业务接口或等效 E2E 接入，接入模型应用、智能体应用；可从 curl 导入接口配置并执行接入诊断。',
  },
  {
    value: 'PLATFORM_APP',
    label: '平台智能体（Dify/扣子）',
    description: '接入真实平台应用，观测回答、工具调用和工作流节点。',
  },
  {
    value: 'GATEWAY_LOG',
    label: 'AI 服务 / 网关观测',
    description:
      '对象类型为 AI 服务的网关观测。按调用方标识或源 IP 分析历史流量和阻断证据，不主动调用服务。',
  },
];

const AGENT_ENTRY_OPTIONS: Array<{
  value: AgentEntryMode;
  targetType: TargetType;
  label: string;
  description: string;
}> = [
  {
    value: 'api',
    targetType: 'AGENT_API',
    label: 'API 调用接口',
    description:
      '配置 Dify、FastGPT、Coze 或自研 AI 应用的后端接口。平台将以黑盒方式发送测试样本并记录响应、判定和证据。',
  },
  // 注：公网访问入口（PUBLIC_AGENT，与 API 接入同一调用路径，无独立实现）与
  // OpenAPI/MCP 资产（MCP_OPENAPI，适配器未实现，运行即报错）已下线，仅保留 API 接入。
];

const TARGET_DETAILS: Record<TargetType, { title: string; description: string }> = {
  ENDPOINT_AGENT: {
    title: '终端智能体',
    description: '对真实终端上的智能体配置进行体检，或在终端的隔离工作区里执行真机测评。',
  },
  AGENT: { title: '智能体工具安全评估', description: TENDER_TEXT_MODEL_ACCESS },
  MODEL: {
    title: 'OpenAI 兼容 API 接入',
    description: TENDER_TEXT_MODEL_ACCESS,
  },
  PLATFORM_APP: {
    title: '平台智能体（Dify/扣子）',
    description: '使用应用密钥连接平台应用，评估真实回答与工具轨迹。',
  },
  AGENT_API: {
    title: '非标准业务接口 / E2E 接入',
    description: `${TENDER_TEXT_APP_ACCESS}适用于 Dify、FastGPT、Coze 或自研业务接口。`,
  },
  PUBLIC_AGENT: {
    title: '公网智能体入口',
    description: '登记网页客服、门户机器人、公开聊天页等入口，用于后续浏览器黑盒与暴露面分析。',
  },
  MCP_OPENAPI: {
    title: '组件资产 Schema',
    description:
      '接入 OpenAPI 或 MCP Schema，平台从工具描述、接口参数和暴露面角度分析组件资产风险。',
  },
  GATEWAY_LOG: {
    title: '网关流量观测',
    description:
      '按调用方标识或源 IP 筛选网关历史流量，执行风险分析并生成包含标准条款映射的评估报告。',
  },
  JUDGE: {
    title: '全局判定模型（AI 复核）',
    description:
      '配置独立模型作为全局判定引擎，对评估对象响应执行辅助复核。判定模型必须与评估对象不同。',
  },
};

// 接入说明正文保持简洁，详细接入要求通过技术提示补充。
const TARGET_DETAIL_TECH_HINT: Partial<Record<TargetType, string>> = {
  MODEL:
    '技术细节：按 OpenAI 兼容接口协议调用；填写网关证据源后，报告会附带该对象在网关上的真实流量与阻断实证。',
  AGENT_API:
    '技术细节：平台以黑盒方式将攻击样本作为用户输入发送至智能体后端接口，并根据响应判定是否发生安全边界突破。',
  GATEWAY_LOG:
    '技术细节：不主动调用，按网关侧身份（调用方标识 / 源 IP）读取历史流量并重新判定。标准条款映射仅供覆盖核查。',
};

const EMPTY: FormState = {
  endpointId: '',
  endpointLabel: '',
  agentshieldBaseUrl: '',
  endpointProduct: 'claude-code',
  name: '',
  targetType: 'MODEL',
  agentEntryMode: 'api',
  platform: 'dify',
  appMode: 'agent-chat',
  botId: '',
  knowledgeCanary: '',
  systemCanary: '',
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  apiKey: '',
  authType: 'bearer',
  authHeaderName: '',
  sessionHeaderName: '',
  customHeaders: '',
  requestTemplate: DEFAULT_REQUEST_TEMPLATE,
  responseTextPath: 'data.answer',
  schemaUrl: '',
  entryUrl: '',
  gatewayBaseUrl: '',
  tenantId: '',
  gatewayClientId: '',
  gatewaySourceIp: '',
  isActive: true,
  isGlobal: false,
  ...EMPTY_RAG_FORM,
  supportsVision: false,
};

const AGENT_TARGET_TYPES = new Set<TargetType>([
  'AGENT',
  'AGENT_API',
  'PUBLIC_AGENT',
  'MCP_OPENAPI',
]);

function isAgentTargetType(type: TargetType | string | null | undefined): boolean {
  return AGENT_TARGET_TYPES.has((type ?? 'MODEL') as TargetType);
}

function isEvidenceSourceType(type: TargetType | string | null | undefined): boolean {
  return type === 'GATEWAY_LOG';
}

function agentEntryModeFromType(type: TargetType | string | null | undefined): AgentEntryMode {
  if (type === 'PUBLIC_AGENT') return 'public';
  if (type === 'MCP_OPENAPI') return 'mcp';
  return 'api';
}

function agentTargetTypeFromMode(mode: AgentEntryMode): TargetType {
  if (mode === 'public') return 'PUBLIC_AGENT';
  if (mode === 'mcp') return 'MCP_OPENAPI';
  return 'AGENT_API';
}

function effectiveFormTargetType(form: FormState): TargetType {
  if (form.targetType === 'AGENT_API') return agentTargetTypeFromMode(form.agentEntryMode);
  return form.targetType;
}

function agentEntryLabel(type: TargetType | string | null | undefined): string {
  const mode = agentEntryModeFromType(type);
  return AGENT_ENTRY_OPTIONS.find((item) => item.value === mode)?.label ?? 'API 调用接口';
}

function targetLabel(type: TargetType | string | null | undefined): string {
  if (type === 'ENDPOINT_AGENT') return '终端智能体';
  if (isAgentTargetType(type)) return '智能体';
  if (type === 'GATEWAY_LOG') return '智能体流量观测（经网关）';
  return TARGET_OPTIONS.find((item) => item.value === type)?.label ?? '大模型';
}

/** 列表副标题里的供应商标识 → 中文名；未知值回退「其他」，不把内部代号露给客户。 */
const PROVIDER_LABELS: Record<string, string> = {
  'jiandun-fleet': `${PRODUCT_NAME}自管终端`,
  agentshield: '智能体安全平台',
  'openai-compatible': 'OpenAI 兼容接口',
  // 新建对象时按接入类型写入的默认值（见 defaultProvider）
  'platform-app': '平台智能体',
  'custom-agent': '自定义智能体接口',
  'public-agent': '公网智能体入口',
  'mcp-openapi': '组件资产 Schema',
  'newapi-agent-security-gateway': '智能体安全网关',
};

export function providerLabel(provider: string | null | undefined): string {
  const key = (provider ?? '').trim();
  return PROVIDER_LABELS[key] ?? presetByProvider(key)?.label ?? '其他';
}

/** 「首页 → 测试」带 ?untested=1 跳来：只看未测试且可做连通性测试的对象。 */
const CONNECTIVITY_TEST_TYPES = new Set<string>(['MODEL', 'AGENT_API', 'PLATFORM_APP']);

export function isUntestedTestable(target: Pick<ModelTarget, 'targetType' | 'lastTestStatus'>) {
  return CONNECTIVITY_TEST_TYPES.has(target.targetType ?? 'MODEL') && target.lastTestStatus == null;
}

function defaultProvider(type: TargetType): string {
  if (type === 'PLATFORM_APP') return 'platform-app';
  if (type === 'ENDPOINT_AGENT') return 'agentshield';
  if (type === 'AGENT_API') return 'custom-agent';
  if (type === 'PUBLIC_AGENT') return 'public-agent';
  if (type === 'MCP_OPENAPI') return 'mcp-openapi';
  if (type === 'GATEWAY_LOG') return 'newapi-agent-security-gateway';
  return 'openai-compatible';
}

function defaultModel(type: TargetType): string {
  if (type === 'PLATFORM_APP') return 'platform-app';
  if (type === 'ENDPOINT_AGENT') return 'endpoint-agent';
  if (type === 'AGENT_API') return 'agent-api';
  if (type === 'PUBLIC_AGENT') return 'public-agent';
  if (type === 'MCP_OPENAPI') return 'mcp-openapi';
  if (type === 'GATEWAY_LOG') return 'gateway-log-source';
  return '';
}

function executableType(
  type: TargetType | string | null | undefined,
  platformAppEnabled = false,
): boolean {
  if (type === 'PLATFORM_APP' && !platformAppEnabled) return false;
  return type === 'MODEL' || type === 'AGENT_API' || type === 'PLATFORM_APP';
}

function usesCallableUrl(type: TargetType): boolean {
  return type === 'MODEL' || type === 'AGENT_API' || type === 'PLATFORM_APP' || type === 'JUDGE';
}

function showsApiKey(type: TargetType): boolean {
  return type === 'MODEL' || type === 'AGENT_API' || type === 'PLATFORM_APP' || type === 'JUDGE';
}

function usesModelName(type: TargetType): boolean {
  return type === 'MODEL' || type === 'JUDGE';
}

function accessLabel(type: TargetType): string {
  if (type === 'PLATFORM_APP') return '平台基地址';
  if (type === 'MODEL') return 'AI 接口地址';
  if (type === 'AGENT_API') return '智能体调用接口 URL';
  if (type === 'PUBLIC_AGENT') return '公网访问入口 URL';
  if (type === 'MCP_OPENAPI') return 'OpenAPI / MCP Schema URL';
  if (type === 'JUDGE') return '判定模型 API Base URL';
  return '接入地址 URL';
}

function accessHint(type: TargetType): string | undefined {
  if (type === 'PLATFORM_APP')
    return 'Dify 填写以 /v1 结尾的应用接口地址；扣子填写平台接口基地址。';
  if (type === 'MODEL')
    return '填写 OpenAI 兼容接口地址（Base URL），通常以 /v1 结尾，平台自动拼接 /chat/completions。';
  return undefined;
}

function gatewayBaseUrlFromControlPlane(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/admin\/v1$/i, '');
}

function targetAccessValue(target: ModelTarget): string {
  const type = target.targetType ?? 'MODEL';
  const config = target.accessConfig ?? null;
  if (type === 'MCP_OPENAPI') return accessString(config, 'schemaUrl') || target.baseUrl;
  if (type === 'PUBLIC_AGENT') return accessString(config, 'entryUrl') || target.baseUrl;
  if (type === 'GATEWAY_LOG') {
    return (
      accessString(config, 'gatewayBaseUrl') ||
      gatewayBaseUrlFromControlPlane(accessString(config, 'controlPlaneBaseUrl') || target.baseUrl)
    );
  }
  return target.baseUrl;
}

const CANARY_PATTERN = /^LSE-CANARY-[a-zA-Z0-9_-]+$/;
const CANARY_MAX_LENGTH = 128;
const CANARY_FORMAT_ERROR =
  '暗号格式应为 LSE-CANARY- 开头，后接字母、数字、下划线或连字符，最长 128 个字符。';

/** 平台对象暗号的前端校验（规则与服务端一致）；留空不算错误，表示不提交该字段。 */
function canaryFormatError(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return CANARY_PATTERN.test(text) && text.length <= CANARY_MAX_LENGTH
    ? undefined
    : CANARY_FORMAT_ERROR;
}

function canSubmitForm(form: FormState, editing: ModelTarget | null): boolean {
  if (!form.name.trim()) return false;
  const effectiveType = effectiveFormTargetType(form);
  if (effectiveType === 'MODEL' || effectiveType === 'JUDGE') {
    return Boolean(form.baseUrl.trim() && form.model.trim() && (editing || form.apiKey.trim()));
  }
  if (effectiveType === 'PLATFORM_APP') {
    return Boolean(
      form.baseUrl.trim() &&
      (editing || form.apiKey.trim()) &&
      (form.platform === 'dify' || form.botId.trim()) &&
      !canaryFormatError(form.knowledgeCanary) &&
      !canaryFormatError(form.systemCanary),
    );
  }
  if (effectiveType === 'ENDPOINT_AGENT')
    return Boolean(form.endpointId && form.agentshieldBaseUrl);
  if (effectiveType === 'AGENT_API') return Boolean(form.baseUrl.trim());
  if (effectiveType === 'MCP_OPENAPI') return Boolean(form.schemaUrl.trim());
  if (effectiveType === 'PUBLIC_AGENT') return Boolean(form.entryUrl.trim());
  if (effectiveType === 'GATEWAY_LOG') return Boolean(form.gatewayBaseUrl.trim());
  return Boolean(form.baseUrl.trim() && form.model.trim() && (editing || form.apiKey.trim()));
}

function jsonString(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function accessString(config: Record<string, unknown> | null | undefined, key: string): string {
  const value = config?.[key];
  return typeof value === 'string' ? value : '';
}

/** 平台对象的暗号字段是否已在库里配置。读到的值是脱敏值，只用来判断有没有，绝不显示或回传。 */
function canaryConfigured(
  target: ModelTarget | null,
  key: 'knowledgeCanary' | 'systemCanary',
): boolean {
  if (target?.targetType !== 'PLATFORM_APP') return false;
  return accessString(target.accessConfig, key).trim().length > 0;
}

/** 暗号输入框：编辑时恒为空，旁边的“已配置/未配置”表示库里是否已有；只有重新输入才会提交。 */
function PlatformCanaryField({
  id,
  label,
  hint,
  value,
  onChange,
  configured,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  /** undefined：新建，不显示状态；boolean：编辑已有对象，显示是否已配置。 */
  configured?: boolean;
}) {
  const error = canaryFormatError(value);
  const statusId = `${id}-status`;
  return (
    <Field
      label={label}
      htmlFor={id}
      className="sm:col-span-2"
      hint={`${hint}格式以 LSE-CANARY- 开头。${configured ? '留空则保持不变，重新输入会替换原暗号。' : ''}`}
      error={error}
    >
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="LSE-CANARY-..."
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={configured === undefined ? undefined : statusId}
          className="font-mono text-xs"
        />
        {configured !== undefined && (
          <Badge id={statusId} tone={configured ? 'success' : 'neutral'}>
            {configured ? '已配置' : '未配置'}
          </Badge>
        )}
      </div>
    </Field>
  );
}

function targetGatewayBound(t: ModelTarget): boolean {
  return accessString(t.accessConfig, 'controlPlaneBaseUrl').trim().length > 0;
}

function authTypeFrom(config: Record<string, unknown> | null | undefined): FormState['authType'] {
  const value = accessString(config, 'authType');
  if (value === 'api_key' || value === 'none') return value;
  return 'bearer';
}

// 将最近测试状态码映射为中文标签与状态色，避免直接展示内部枚举。
function lastTestLabel(status: string): { text: string; tone: 'ok' | 'bad' | 'muted' } {
  const s = status.toUpperCase();
  if (s === 'SUCCESS') return { text: '连接正常', tone: 'ok' };
  if (s === 'FAILED' || s === 'ERROR') return { text: '连接失败', tone: 'bad' };
  return { text: '未测试', tone: 'muted' };
}

// 评估任务状态码 → 中文，界面不裸露 RUNNING/COMPLETED 等原始枚举。
function evalTaskStatusLabel(status: string): string {
  const s = status.toUpperCase();
  if (s === 'RUNNING') return '运行中';
  if (s === 'COMPLETED') return '已完成';
  if (s === 'FAILED') return '失败';
  if (s === 'PENDING' || s === 'QUEUED') return '排队中';
  return status;
}

interface GatewayAnalyzeForm {
  name: string;
  startTime: string;
  endTime: string;
  clientId: string;
  sourceIp: string;
  canaryTokens: string;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

function localDateTimeValue(date: Date): string {
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hours = padDatePart(date.getHours());
  const minutes = padDatePart(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function defaultAnalyzeForm(target: ModelTarget): GatewayAnalyzeForm {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return {
    name: `${target.name} 日志风险分析`,
    startTime: localDateTimeValue(start),
    endTime: localDateTimeValue(end),
    clientId: accessString(target.accessConfig, 'clientId'),
    sourceIp: accessString(target.accessConfig, 'sourceIp'),
    canaryTokens: '',
  };
}

function toIsoFromLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('INVALID_DATETIME');
  return date.toISOString();
}

export function ModelTargetsPage() {
  const { hasPermission, user } = useAuth();
  // 网关观测、网关关联、智能体安全平台终端来源依赖全平台共用的集成，只在平台租户出现。
  const platformTenant = isPlatformTenantUser(user);
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isAllTenants, listParams, tenantFilter, guardCreate, guardRow } = useTenantView();
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  // 首页「测试」按钮带 ?untested=1 跳来：只看未测试且可做连通性测试的对象。
  const [searchParams, setSearchParams] = useSearchParams();
  const untestedOnly = searchParams.get('untested') === '1';
  const [modalOpen, setModalOpen] = useState(false);
  const [fingerprintTarget, setFingerprintTarget] = useState<ModelTarget | null>(null);
  const [editing, setEditing] = useState<ModelTarget | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [testResult, setTestResult] = useState<Record<string, ModelTestResult>>({});
  const [gatewayAnalyzeTarget, setGatewayAnalyzeTarget] = useState<ModelTarget | null>(null);
  const [drillTarget, setDrillTarget] = useState<ModelTarget | null>(null);
  const [gatewayAnalyzeForm, setGatewayAnalyzeForm] = useState<GatewayAnalyzeForm>(() => ({
    name: '',
    startTime: '',
    endTime: '',
    clientId: '',
    sourceIp: '',
    canaryTokens: '',
  }));
  const [deleteRefTarget, setDeleteRefTarget] = useState<ModelTarget | null>(null);
  const [curlOpen, setCurlOpen] = useState(false);
  const [formDiagnose, setFormDiagnose] = useState<ModelTargetDiagnoseReport | null>(null);
  const [diagnoseTarget, setDiagnoseTarget] = useState<ModelTarget | null>(null);
  const [savedDiagnose, setSavedDiagnose] = useState<ModelTargetDiagnoseReport | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchResult, setBatchResult] = useState<ModelTargetBatchTestResult | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  const canRead = hasPermission('model_target:read');
  const canCreate = hasPermission('model_target:create');
  const canUpdate = hasPermission('model_target:update');
  const canDelete = hasPermission('model_target:delete');
  const canTest = hasPermission('model_target:test');
  const canAnalyzeGateway = hasPermission('eval_task:create');
  const gatewayDefault = useQuery({
    queryKey: ['model-targets-gateway-default'],
    queryFn: () => api.systemSettings.get(),
    enabled: platformTenant && (hasPermission('system_setting:read') || hasPermission('license:read')),
    retry: false,
  });

  const capabilities = useQuery({
    queryKey: ['model-target-capabilities'],
    queryFn: () => api.modelTargets.capabilities(),
    enabled: canRead,
    retry: false,
  });
  const endpointFeature = useQuery({
    queryKey: ['endpoint-evals-config'],
    queryFn: () => api.endpointEvals.config(),
    retry: false,
  });
  const endpointEnabled = endpointFeature.data?.enabled === true;
  const baseTargetOptions = TARGET_OPTIONS.filter(
    (option) =>
      (option.value !== 'PLATFORM_APP' || capabilities.data?.platformAppEnabled) &&
      (option.value !== 'GATEWAY_LOG' || platformTenant),
  );
  const targetOptions = endpointEnabled && platformTenant
    ? [
        ...baseTargetOptions,
        {
          value: 'ENDPOINT_AGENT' as const,
          label: '终端智能体',
          description: TARGET_DETAILS.ENDPOINT_AGENT.description,
        },
      ]
    : baseTargetOptions;
  const endpointMutation = useEndpointEvalLauncher();

  const pageSize = 10;
  const list = useQuery({
    queryKey: ['model-targets', page, search, untestedOnly, tenantFilter],
    queryFn: () =>
      api.modelTargets.list({
        page,
        pageSize,
        keyword: search || undefined,
        ...(untestedOnly ? { untested: true } : {}),
        withEndpointState: true,
        ...listParams,
      }),
    enabled: canRead,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['model-targets'] });
  const targetDescription = targetOptions.find(
    (item) => item.value === form.targetType,
  )?.description;

  const buildPayload = (): Record<string, unknown> | null => {
    const effectiveType = effectiveFormTargetType(form);
    let agentAccess: Record<string, unknown> = {};
    if (effectiveType === 'AGENT_API') {
      const built = buildAgentAccessConfig(form);
      if (!built.ok) {
        toast.error(built.error);
        return null;
      }
      agentAccess = built.accessConfig;
    }
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      targetType: effectiveType,
      provider: form.provider.trim() || defaultProvider(effectiveType),
      model: form.model.trim() || defaultModel(effectiveType),
      isActive: form.isActive,
      isGlobal: form.isGlobal,
    };
    // RAG 声明只对智能体应用 API 开放；编辑时按合并补丁提交，避免覆盖未展示/未修改的配置。
    const ragPayload = buildRagPayload(form, {
      eligible: effectiveType === 'AGENT_API',
      patch: Boolean(editing),
    });
    if (!ragPayload.ok) {
      toast.error(ragPayload.error);
      return null;
    }
    payload.isRag = ragPayload.isRag;
    if (ragPayload.ragOptions !== undefined) payload.ragOptions = ragPayload.ragOptions;
    if (ragPayload.ragRestrictedUploadSecret !== undefined) {
      payload.ragRestrictedUploadSecret = ragPayload.ragRestrictedUploadSecret;
    }
    if (effectiveType === 'MODEL') payload.supportsVision = form.supportsVision;
    if (usesCallableUrl(effectiveType)) payload.baseUrl = form.baseUrl.trim();
    if (showsApiKey(effectiveType) && form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
    if (effectiveType === 'ENDPOINT_AGENT') {
      payload.accessConfig = {
        agentshieldBaseUrl: form.agentshieldBaseUrl,
        endpointId: form.endpointId,
        endpointLabel: form.endpointLabel,
        product: form.endpointProduct,
      };
    } else if (effectiveType === 'MODEL' && platformTenant && form.gatewayBaseUrl.trim()) {
      payload.accessConfig = {
        gatewayBaseUrl: form.gatewayBaseUrl.trim(),
        ...(form.tenantId.trim() ? { tenantId: form.tenantId.trim() } : {}),
      };
    } else if (effectiveType === 'AGENT_API') {
      payload.accessConfig = {
        ...agentAccess,
        ...(platformTenant && form.gatewayBaseUrl.trim() ? { gatewayBaseUrl: form.gatewayBaseUrl.trim() } : {}),
        ...(platformTenant && form.gatewayBaseUrl.trim() && form.tenantId.trim()
          ? { tenantId: form.tenantId.trim() }
          : {}),
      };
    } else if (effectiveType === 'PLATFORM_APP') {
      // 暗号只在用户填写时提交：编辑时输入框默认留空（读到的是脱敏值，不能回传），
      // 留空即不带该字段，服务端会沿用库里已保存的值。格式由 canSubmitForm 把关。
      const knowledgeCanary = form.knowledgeCanary.trim();
      const systemCanary = form.systemCanary.trim();
      payload.accessConfig = {
        ...(editing?.targetType === 'PLATFORM_APP' && editing.accessConfig?.user
          ? { user: editing.accessConfig.user }
          : {}),
        ...(form.platform === 'dify' &&
        editing?.targetType === 'PLATFORM_APP' &&
        editing.accessConfig?.inputs
          ? { inputs: editing.accessConfig.inputs }
          : {}),
        platform: form.platform,
        baseUrl: form.baseUrl.trim(),
        ...(form.platform === 'dify' ? { appMode: form.appMode } : { botId: form.botId.trim() }),
        ...(knowledgeCanary ? { knowledgeCanary } : {}),
        ...(systemCanary ? { systemCanary } : {}),
      };
    } else if (effectiveType === 'MCP_OPENAPI') {
      payload.accessConfig = { schemaUrl: form.schemaUrl.trim() };
    } else if (effectiveType === 'PUBLIC_AGENT') {
      payload.accessConfig = { entryUrl: form.entryUrl.trim() };
    } else if (effectiveType === 'GATEWAY_LOG') {
      payload.accessConfig = {
        gatewayBaseUrl: form.gatewayBaseUrl.trim(),
        ...(form.tenantId.trim() ? { tenantId: form.tenantId.trim() } : {}),
        ...(form.gatewayClientId.trim() ? { clientId: form.gatewayClientId.trim() } : {}),
        ...(form.gatewaySourceIp.trim() ? { sourceIp: form.gatewaySourceIp.trim() } : {}),
      };
    }
    return payload;
  };

  const buildGatewayAnalyzePayload = (): GatewayLogAnalysisBody | null => {
    if (!gatewayAnalyzeTarget) return null;
    let startTime: string;
    let endTime: string;
    try {
      startTime = toIsoFromLocal(gatewayAnalyzeForm.startTime);
      endTime = toIsoFromLocal(gatewayAnalyzeForm.endTime);
    } catch {
      toast.error('时间范围格式不正确');
      return null;
    }
    if (new Date(startTime).getTime() > new Date(endTime).getTime()) {
      toast.error('开始时间不能晚于结束时间');
      return null;
    }
    const canaryTokens = gatewayAnalyzeForm.canaryTokens
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    return {
      modelTargetId: gatewayAnalyzeTarget.id,
      name: gatewayAnalyzeForm.name.trim() || undefined,
      startTime,
      endTime,
      clientId: gatewayAnalyzeForm.clientId.trim() || undefined,
      sourceIp: gatewayAnalyzeForm.sourceIp.trim() || undefined,
      canaryTokens: canaryTokens.length > 0 ? canaryTokens : undefined,
    };
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = buildPayload();
      if (!payload) throw new Error('FORM_INVALID');
      if (editing) return api.modelTargets.update(editing.id, payload);
      return api.modelTargets.create(payload);
    },
    onSuccess: () => {
      toast.success(editing ? '评估对象已更新' : '评估对象已创建');
      setModalOpen(false);
      invalidate();
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'FORM_INVALID') return;
      toast.error(err instanceof ApiError ? err.message : '保存失败');
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => api.modelTargets.test(id),
    onSuccess: (res, id) => {
      setTestResult((prev) => ({ ...prev, [id]: res }));
      if (res.status === 'SUCCESS') toast.success(`连接成功 · ${formatLatency(res.latencyMs)}`);
      else toast.error(`连接失败：${res.error ?? '未知错误'}`);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '测试失败'),
  });

  const formDiagnoseMutation = useMutation({
    mutationFn: async () => {
      const payload = buildPayload();
      if (!payload) throw new Error('FORM_INVALID');
      return api.modelTargets.diagnose({
        ...payload,
        ...(editing ? { targetId: editing.id } : {}),
      });
    },
    onSuccess: (report) => setFormDiagnose(report),
    onError: (err) => {
      if (err instanceof Error && err.message === 'FORM_INVALID') return;
      toast.error(err instanceof ApiError ? err.message : '接口诊断失败');
    },
  });

  const savedDiagnoseMutation = useMutation({
    mutationFn: (id: string) => api.modelTargets.diagnoseSaved(id),
    onSuccess: (report) => setSavedDiagnose(report),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '接口诊断失败'),
  });

  const batchTestMutation = useMutation({
    mutationFn: (ids: string[]) => api.modelTargets.batchTest(ids),
    onSuccess: (res) => {
      setBatchResult(res);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '批量连通性测试失败'),
  });

  const openSavedDiagnose = (t: ModelTarget) => {
    setDiagnoseTarget(t);
    setSavedDiagnose(null);
    savedDiagnoseMutation.mutate(t.id);
  };

  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const applyPreset = (key: string) => {
    const preset = MODEL_ACCESS_PRESETS.find((p) => p.key === key);
    setForm((prev) => ({ ...prev, provider: preset?.provider ?? 'openai-compatible' }));
  };

  // curl 导入：用户确认识别结果后填入表单（凭据只进入密码框，不在界面明文展示）。
  const applyCurl = ({ mode, parsed, responseTextPath }: CurlApplyPayload) => {
    setFormDiagnose(null);
    if (mode === 'model' && parsed.openAiCompatible) {
      const oa = parsed.openAiCompatible;
      setForm((prev) => ({
        ...prev,
        targetType: 'MODEL',
        agentEntryMode: 'api',
        provider: prev.targetType === 'MODEL' ? prev.provider : 'openai-compatible',
        baseUrl: oa.baseUrl,
        model: oa.model ?? prev.model,
        apiKey: parsed.auth.type === 'bearer' ? parsed.auth.value : prev.apiKey,
      }));
      toast.success('已按 OpenAI 兼容 API 填入接口地址、模型与密钥，请核对后保存');
      return;
    }
    setForm((prev) => ({
      ...prev,
      targetType: 'AGENT_API',
      agentEntryMode: 'api',
      provider: prev.targetType === 'AGENT_API' ? prev.provider : defaultProvider('AGENT_API'),
      model: prev.targetType === 'AGENT_API' ? prev.model : defaultModel('AGENT_API'),
      baseUrl: parsed.url,
      apiKey: parsed.auth.value,
      authType: parsed.auth.type,
      authHeaderName: parsed.auth.headerName ?? '',
      customHeaders: Object.keys(stripContentType(parsed.headers)).length
        ? JSON.stringify(stripContentType(parsed.headers), null, 2)
        : '',
      requestTemplate: JSON.stringify(parsed.requestTemplate ?? { input: '{{prompt}}' }, null, 2),
      responseTextPath: responseTextPath ?? prev.responseTextPath,
    }));
    toast.success('已按识别结果填入接口配置，请核对后保存');
  };

  const testGatewayMutation = useMutation({
    mutationFn: (id: string) => api.modelTargets.testGateway(id),
    onSuccess: (res) => {
      if (res.ok)
        toast.success(
          `安全网关连接成功${res.latencyMs != null ? `，响应时间 ${res.latencyMs} 毫秒` : ''}。后续报告可关联该评估对象的网关流量证据。`,
        );
      else toast.error(`网关连接失败：${res.message ?? '未知错误'}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '测网关失败'),
  });

  const gatewayAnalyzeMutation = useMutation({
    mutationFn: async () => {
      const payload = buildGatewayAnalyzePayload();
      if (!payload) throw new Error('FORM_INVALID');
      return api.gatewayLogs.analyze(payload);
    },
    onSuccess: (res) => {
      toast.success(
        res.summary.riskEvents > 0
          ? `已识别 ${res.summary.riskEvents} 条待复核风险记录，正在生成评估报告。`
          : '在所选时间范围和已观测流量内，未发现已确认风险。该结果不代表绝对安全或合规认证。',
      );
      setGatewayAnalyzeTarget(null);
      navigate(`/eval-tasks/${res.task.id}`);
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'FORM_INVALID') return;
      toast.error(err instanceof ApiError ? err.message : '日志分析失败');
    },
  });

  const openCreate = () => {
    setEditing(null);
    setFormDiagnose(null);
    setForm({
      ...EMPTY,
      gatewayBaseUrl: platformTenant ? (gatewayDefault.data?.gateway.gatewayBaseUrl ?? '') : '',
    });
    setModalOpen(true);
  };

  // 新建模式下，系统设置的全局网关地址到达后自动回填「网关地址」字段，
  // 修「openCreate 一次性预填」在查询尚未就绪时落空的竞态（不覆盖用户已手填的值）。
  useEffect(() => {
    const def = gatewayDefault.data?.gateway.gatewayBaseUrl?.trim();
    if (!platformTenant || !modalOpen || editing || !def) return;
    setForm((f) => (f.gatewayBaseUrl.trim() ? f : { ...f, gatewayBaseUrl: def }));
  }, [platformTenant, modalOpen, editing, gatewayDefault.data]);

  const openEdit = (t: ModelTarget) => {
    const rawType = t.targetType ?? 'MODEL';
    const type = isAgentTargetType(rawType) ? 'AGENT_API' : rawType;
    const agentEntryMode = agentEntryModeFromType(rawType);
    const config = t.accessConfig ?? null;
    setEditing(t);
    setFormDiagnose(null);
    setForm({
      endpointId: accessString(config, 'endpointId'),
      endpointLabel: accessString(config, 'endpointLabel'),
      agentshieldBaseUrl: accessString(config, 'agentshieldBaseUrl'),
      endpointProduct: parseEndpointProduct(config?.product) ?? 'claude-code',
      name: t.name,
      targetType: type as TargetType,
      agentEntryMode,
      platform: config?.platform === 'coze' ? 'coze' : 'dify',
      appMode: (accessString(config, 'appMode') || 'agent-chat') as FormState['appMode'],
      botId: accessString(config, 'botId'),
      // 读到的暗号是脱敏值，不回填；输入框留空，是否已配置另按 editing.accessConfig 判断。
      knowledgeCanary: '',
      systemCanary: '',
      provider: t.provider || defaultProvider(rawType),
      baseUrl: usesCallableUrl(rawType) ? t.baseUrl : '',
      model: usesModelName(rawType) ? t.model : defaultModel(rawType),
      apiKey: '',
      authType: authTypeFrom(config),
      authHeaderName: accessString(config, 'authHeaderName'),
      sessionHeaderName: accessString(config, 'sessionHeaderName'),
      customHeaders:
        config?.headers && typeof config.headers === 'object'
          ? JSON.stringify(config.headers, null, 2)
          : '',
      requestTemplate: jsonString(config?.requestTemplate, DEFAULT_REQUEST_TEMPLATE),
      responseTextPath: accessString(config, 'responseTextPath') || 'data.answer',
      schemaUrl: accessString(config, 'schemaUrl') || (rawType === 'MCP_OPENAPI' ? t.baseUrl : ''),
      entryUrl: accessString(config, 'entryUrl') || (rawType === 'PUBLIC_AGENT' ? t.baseUrl : ''),
      gatewayBaseUrl:
        accessString(config, 'gatewayBaseUrl') ||
        gatewayBaseUrlFromControlPlane(
          accessString(config, 'controlPlaneBaseUrl') ||
            (rawType === 'GATEWAY_LOG' ? t.baseUrl : ''),
        ),
      tenantId: accessString(config, 'tenantId'),
      gatewayClientId: accessString(config, 'clientId'),
      gatewaySourceIp: accessString(config, 'sourceIp'),
      isActive: t.isActive,
      isGlobal: t.isGlobal,
      ...ragFormFields(t),
      supportsVision: t.supportsVision ?? false,
    });
    setModalOpen(true);
  };

  // 从「接入终端」页点「登记为评估对象」跳回时，打开新建弹窗并预填终端信息（仍需用户确认保存）。
  const location = useLocation();
  useEffect(() => {
    const reg = (
      location.state as {
        registerEndpoint?: { endpointId: string; hostname: string; product: string; name: string };
      } | null
    )?.registerEndpoint;
    if (!reg || !canCreate || !endpointFeature.data) return;
    if (!endpointEnabled || !platformTenant) return;
    setEditing(null);
    setFormDiagnose(null);
    setForm({
      ...EMPTY,
      targetType: 'ENDPOINT_AGENT',
      name: reg.name,
      endpointId: reg.endpointId,
      endpointLabel: reg.hostname,
      endpointProduct: parseEndpointProduct(reg.product) ?? 'claude-code',
      agentshieldBaseUrl: endpointFeature.data.agentshieldBaseUrl ?? '',
    });
    setModalOpen(true);
    navigate(location.pathname, { replace: true, state: null });
  }, [location, canCreate, endpointFeature.data, endpointEnabled, platformTenant, navigate]);

  const changeTargetType = (targetType: TargetType) => {
    const effectiveType = targetType === 'AGENT_API' ? 'AGENT_API' : targetType;
    setForm((prev) => ({
      ...prev,
      targetType,
      agentEntryMode: 'api',
      provider: defaultProvider(effectiveType),
      baseUrl: '',
      model: defaultModel(effectiveType),
      apiKey: '',
      authType: 'bearer',
      authHeaderName: '',
      sessionHeaderName: '',
      customHeaders: '',
      requestTemplate: DEFAULT_REQUEST_TEMPLATE,
      responseTextPath: 'data.answer',
      schemaUrl: '',
      entryUrl: '',
      gatewayBaseUrl: gatewayDefault.data?.gateway.gatewayBaseUrl ?? '',
      tenantId: '',
    }));
  };

  const changeAgentEntryMode = (agentEntryMode: AgentEntryMode) => {
    const targetType = agentTargetTypeFromMode(agentEntryMode);
    setForm((prev) => ({
      ...prev,
      targetType: 'AGENT_API',
      agentEntryMode,
      provider: defaultProvider(targetType),
      baseUrl: '',
      model: defaultModel(targetType),
      apiKey: '',
      authType: 'bearer',
      authHeaderName: '',
      sessionHeaderName: '',
      customHeaders: '',
      requestTemplate: DEFAULT_REQUEST_TEMPLATE,
      responseTextPath: 'data.answer',
      schemaUrl: '',
      entryUrl: '',
      gatewayBaseUrl: '',
      tenantId: '',
    }));
  };

  const openGatewayAnalyze = (target: ModelTarget) => {
    setGatewayAnalyzeTarget(target);
    setGatewayAnalyzeForm(defaultAnalyzeForm(target));
  };

  const closeGatewayAnalyze = () => {
    if (!gatewayAnalyzeMutation.isPending) setGatewayAnalyzeTarget(null);
  };

  const canSubmit = canSubmitForm(form, editing);
  const effectiveFormType = effectiveFormTargetType(form);
  const currentAgentEntry = AGENT_ENTRY_OPTIONS.find((item) => item.value === form.agentEntryMode);
  const currentDetails = TARGET_DETAILS[effectiveFormType] ?? TARGET_DETAILS.MODEL;
  const visibleTargets = (list.data?.items ?? []).filter(
    (target) =>
      (target.targetType ?? 'MODEL') !== 'JUDGE' && (!untestedOnly || isUntestedTestable(target)),
  );
  const subjectTargets = visibleTargets.filter(
    (target) => !isEvidenceSourceType(target.targetType ?? 'MODEL'),
  );
  const evidenceTargets = visibleTargets.filter((target) =>
    isEvidenceSourceType(target.targetType ?? 'MODEL'),
  );
  const canSubmitGatewayAnalyze = Boolean(
    gatewayAnalyzeTarget && gatewayAnalyzeForm.startTime && gatewayAnalyzeForm.endTime,
  );

  const renderTargetTable = (targets: ModelTarget[], kind: 'subject' | 'evidence') => (
    <Table fit className="md:min-w-[900px]" aria-label="评估对象列表">
      <THead>
        <TR>
          {kind === 'subject' && canTest && (
            <TH className="w-8">
              {(() => {
                const ids = targets
                  .filter((x) =>
                    executableType(x.targetType ?? 'MODEL', capabilities.data?.platformAppEnabled),
                  )
                  .map((x) => x.id);
                const all = ids.length > 0 && ids.every((id) => selectedIds.has(id));
                return (
                  <input
                    type="checkbox"
                    aria-label="全选可测试对象"
                    checked={all}
                    disabled={ids.length === 0}
                    onChange={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
                        return next;
                      })
                    }
                  />
                );
              })()}
            </TH>
          )}
          {/* 名称列不设宽度，吃掉剩余空间；其余列合计不超过 1280 宽下的可用宽度，操作列不会被裁掉。 */}
          {isAllTenants && <TH>租户</TH>}
          <TH>名称</TH>
          <TH className="w-[13%]">{kind === 'evidence' ? '源类型' : '对象类型'}</TH>
          <TH className="w-[16%]">已验证能力</TH>
          <TH className="w-[72px]">状态</TH>
          <TH className="w-[120px]">最近测试</TH>
          <TH className="w-[232px] text-right">操作</TH>
        </TR>
      </THead>
      <TBody>
        {targets.map((t) => {
          const tr = testResult[t.id];
          const type = t.targetType ?? 'MODEL';
          const br = batchResult?.results.find((r) => r.id === t.id);
          return (
            <TR key={t.id}>
              {kind === 'subject' && canTest && (
                <TD data-label="选择" className="py-3 align-top">
                  {executableType(type, capabilities.data?.platformAppEnabled) && (
                    <input
                      type="checkbox"
                      aria-label={`选择 ${targetDisplayName(t)}`}
                      checked={selectedIds.has(t.id)}
                      onChange={() => toggleSelected(t.id)}
                    />
                  )}
                </TD>
              )}
              {isAllTenants && <TD data-label="租户"><TenantCell tenantId={t.tenantId} /></TD>}
              <TD data-label="名称" className="py-3 align-top"
                onClick={isAllTenants ? () => guardRow(t.tenantId, '/model-targets') : undefined}>
                <div className="flex min-w-0 items-center gap-1.5">
                  <div
                    className="min-w-0 truncate text-[14px] font-semibold text-ink"
                    title={targetDisplayName(t)}
                  >
                    {targetDisplayName(t)}
                  </div>
                  {t.endpointState === 'gone' && (
                    <Badge tone="warning" className="shrink-0 py-0">
                      终端已失效
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                  <span className="break-words">{providerLabel(t.provider)}</span>
                  {t.isGlobal && (
                    <Badge tone="info" className="py-0">
                      全局
                    </Badge>
                  )}
                </div>
                {type === 'ENDPOINT_AGENT' ? (
                  <EndpointTargetDetails target={t} />
                ) : (
                  <details className="mt-1 text-xs text-ink-3" onClick={(e) => e.stopPropagation()}>
                    <summary className="cursor-pointer text-brand-700 hover:underline">
                      接入详情
                    </summary>
                    <dl className="mt-1 space-y-1 break-all rounded-lg bg-[#F7F9FD] p-2">
                      <dt className="text-ink-3">{kind === 'evidence' ? '源标识' : '对象标识'}</dt>
                      <dd className="text-ink">{t.model || defaultModel(type)}</dd>
                      <dt className="text-ink-3">接入位置</dt>
                      <dd className="text-ink">{targetAccessValue(t)}</dd>
                    </dl>
                  </details>
                )}
              </TD>
              <TD
                data-label={kind === 'evidence' ? '源类型' : '对象类型'}
                className="py-3 align-top"
              >
                <div className="break-words text-[13.5px] font-medium text-ink">
                  {targetLabel(type)}
                </div>
                <div className="mt-0.5 break-words text-xs text-ink-3">
                  {accessTypeLabel(type, t.provider)}
                </div>
                {isAgentTargetType(type) && (
                  <div className="mt-0.5 text-xs text-ink-3">{agentEntryLabel(type)}</div>
                )}
                {isEvidenceSourceType(type) && (
                  <div className="mt-0.5 text-xs text-ink-3">分析智能体风险</div>
                )}
              </TD>
              <TD data-label="已验证能力" className="py-3 align-top">
                <div className="flex max-w-[260px] flex-col items-start gap-1">
                  <TagCluster
                    max={3}
                    tags={(t.connectorCapabilities ?? [])
                      .filter((cap) => cap.supported)
                      .map((cap) => cap.label)}
                  />
                  {(t.connectorCapabilities ?? []).some((cap) => !cap.supported) ? (
                    <span
                      className="text-xs text-ink-3"
                      title={(t.connectorCapabilities ?? [])
                        .filter((cap) => !cap.supported)
                        .map((cap) => cap.requirement)
                        .filter(Boolean)
                        .join('；')}
                    >
                      部分能力待补条件
                    </span>
                  ) : null}
                </div>
              </TD>
              <TD data-label="状态" className="py-3 align-top">
                {t.isActive ? (
                  <Badge tone="success" icon>
                    启用
                  </Badge>
                ) : (
                  <Badge tone="neutral" icon>
                    停用
                  </Badge>
                )}
              </TD>
              <TD data-label="最近测试" className="py-3 align-top">
                {tr ? (
                  tr.status === 'SUCCESS' ? (
                    <span className="inline-flex items-center gap-1 text-xs text-severity-pass">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {formatLatency(tr.latencyMs)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-destructive">
                      <XCircle className="h-3.5 w-3.5" />
                      失败
                    </span>
                  )
                ) : t.lastTestStatus ? (
                  (() => {
                    const meta = lastTestLabel(t.lastTestStatus);
                    const toneClass =
                      meta.tone === 'ok'
                        ? 'text-severity-pass'
                        : meta.tone === 'bad'
                          ? 'text-destructive'
                          : 'text-muted-foreground';
                    return (
                      <span className={`block whitespace-nowrap text-xs ${toneClass}`}>
                        {meta.text}
                        <span className="mt-0.5 block text-slate-500">
                          {formatDateTime(t.lastTestedAt)}
                        </span>
                      </span>
                    );
                  })()
                ) : (
                  <span className="text-xs text-muted-foreground">未测试</span>
                )}
                {br && (
                  <div
                    className={`mt-1 text-xs ${
                      br.status === 'SUCCESS'
                        ? 'text-severity-pass'
                        : br.status === 'SKIPPED'
                          ? 'text-muted-foreground'
                          : 'text-destructive'
                    }`}
                  >
                    批量测试：
                    {br.status === 'SUCCESS'
                      ? `成功 · ${formatLatency(br.latencyMs)}`
                      : br.status === 'SKIPPED'
                        ? '已跳过'
                        : `失败${br.httpStatus ? ` · HTTP ${br.httpStatus}` : ''}`}
                    {br.error && br.status !== 'SUCCESS' ? (
                      <div className="max-w-[220px] break-all text-muted-foreground">
                        {br.error}
                      </div>
                    ) : null}
                  </div>
                )}
              </TD>
              <TD data-label="操作" className="py-3 align-top"
                onClickCapture={isAllTenants ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  guardRow(t.tenantId, '/model-targets');
                } : undefined}>
                {(() => {
                  const testing = testMutation.isPending && testMutation.variables === t.id;
                  const gwTesting =
                    testGatewayMutation.isPending && testGatewayMutation.variables === t.id;
                  const executable =
                    canTest && executableType(type, capabilities.data?.platformAppEnabled);
                  // 操作按使用频率排序：前两项以文字链直接展示，其余收进「更多」，每项仍可达。
                  const actions: Array<RowActionItem & { menuOnly?: boolean }> = [];
                  if (endpointEnabled && canAnalyzeGateway && type === 'ENDPOINT_AGENT') {
                    actions.push({
                      key: 'posture',
                      label: ENDPOINT_EVAL_MODE_LABELS.posture,
                      disabled: endpointMutation.isPending,
                      onSelect: () =>
                        endpointMutation.mutate({ id: t.id, mode: 'posture', target: t }),
                    });
                    actions.push({
                      key: 'run',
                      label: ENDPOINT_EVAL_MODE_LABELS.run,
                      disabled: endpointMutation.isPending,
                      menuOnly: true,
                      onSelect: () => endpointMutation.mutate({ id: t.id, mode: 'run', target: t }),
                    });
                  }
                  if (canAnalyzeGateway && type === 'GATEWAY_LOG') {
                    actions.push({
                      key: 'analyze',
                      label: (
                        <>
                          <Search className="h-3.5 w-3.5" />
                          分析日志
                        </>
                      ),
                      ariaLabel: '分析日志',
                      onSelect: () => openGatewayAnalyze(t),
                    });
                    actions.push({
                      key: 'drill',
                      label: (
                        <>
                          <Plus className="h-3.5 w-3.5" />
                          生成演练
                        </>
                      ),
                      ariaLabel: '生成演练',
                      onSelect: () => setDrillTarget(t),
                    });
                  }
                  if (executable) {
                    actions.push({
                      key: 'test',
                      label: <>{testing ? <Spinner className="h-3.5 w-3.5" /> : null}测试</>,
                      ariaLabel: '测试',
                      disabled: testing,
                      onSelect: () => testMutation.mutate(t.id),
                    });
                  }
                  if (FINGERPRINT_TARGET_TYPES.includes(type)) {
                    actions.push({
                      key: 'fingerprint',
                      label: '模型指纹',
                      onSelect: () => setFingerprintTarget(t),
                    });
                  }
                  if (executable) {
                    actions.push({
                      key: 'diagnose',
                      label: (
                        <>
                          诊断<span className="sr-only">接口诊断</span>
                        </>
                      ),
                      ariaLabel: '接口诊断',
                      onSelect: () => openSavedDiagnose(t),
                    });
                  }
                  if (canTest && targetGatewayBound(t)) {
                    actions.push({
                      key: 'gateway-test',
                      label: (
                        <>
                          {gwTesting ? (
                            <Spinner className="h-3.5 w-3.5" />
                          ) : (
                            <Plug className="h-3.5 w-3.5" />
                          )}
                          测试网关连接
                        </>
                      ),
                      ariaLabel: '测试网关连接',
                      disabled: gwTesting,
                      onSelect: () => testGatewayMutation.mutate(t.id),
                    });
                  }
                  const primary = actions.filter((x) => !x.menuOnly).slice(0, 2);
                  const more = actions.filter((x) => !primary.includes(x));
                  return (
                    <div className="flex items-center justify-start gap-x-1 md:justify-end">
                      {primary.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          aria-label={item.ariaLabel}
                          disabled={item.disabled}
                          onClick={item.onSelect}
                          className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-[9px] px-2 text-[13px] font-medium text-brand-700 transition-colors hover:bg-brand-50 disabled:pointer-events-none disabled:opacity-50"
                        >
                          {item.label}
                        </button>
                      ))}
                      {more.length > 0 ? (
                        <RowActionMenu items={more} />
                      ) : (
                        <span className="h-8 w-8" aria-hidden="true" />
                      )}
                      {canUpdate && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEdit(t)}
                          aria-label="编辑"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="删除"
                          onClick={async () => {
                            await qc.fetchQuery({
                              queryKey: ['model-target-references', t.id],
                              queryFn: () =>
                                api.evalTasks.list({
                                  modelTargetId: t.id,
                                  pageSize: 100,
                                }),
                              staleTime: 0,
                            });
                            setDeleteRefTarget(t);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-severity-critical" />
                        </Button>
                      )}
                    </div>
                  );
                })()}
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );

  return (
    <div>
      {endpointMutation.dialog}
      <PageHeader
        title="评估对象"
        description="被评估的模型、应用接口与网关"
        actions={
          <>
            {endpointEnabled && (
              <Button
                variant="outline"
                title="查看已接入的终端，或接入新终端"
                onClick={() => navigate(FLEET_ENROLL_PATH)}
              >
                <TerminalSquare className="h-4 w-4" />
                接入终端
              </Button>
            )}
            {canCreate && (
              <Button onClick={() => guardCreate(openCreate)}>
                <Plus className="h-4 w-4" />
                新建评估对象
              </Button>
            )}
          </>
        }
      />

      <details
        className="group mb-4 overflow-hidden rounded-card border border-[#EDF1F8] bg-white shadow-card"
        aria-label="评估对象接入说明"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 text-[14px] font-semibold text-ink group-open:border-b group-open:border-line">
          <span className="inline-flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-brand-600" />
            接入能力
            <span className="text-xs font-normal text-ink-3">支持的接入方式与测试手段</span>
          </span>
          <span className="text-[13px] font-medium text-brand-700 group-open:hidden">展开</span>
          <span className="hidden text-[13px] font-medium text-brand-700 group-open:inline">
            收起
          </span>
        </summary>
        <dl
          className="grid gap-3 p-5 text-[13px] leading-5 md:grid-cols-2 xl:grid-cols-3"
          aria-label="接入能力说明"
        >
          {[
            ['模型', TENDER_TEXT_MODEL_ACCESS],
            ['模型应用 / 智能体', TENDER_TEXT_APP_ACCESS],
            ['curl 导入', TENDER_TEXT_CURL_IMPORT],
            ['接口诊断', TENDER_TEXT_DIAGNOSE],
            ['连通性测试', TENDER_TEXT_BATCH_TEST],
            ['流量观测', '按调用方标识或源 IP 关联安全网关历史流量开展分析。'],
          ].map(([label, text]) => (
            <div key={label} className="rounded-xl bg-[#F7F9FD] px-4 py-3">
              <dt className="text-[13px] font-semibold text-ink">{label}</dt>
              <dd className="mt-1 min-w-0 text-ink-2">{text}</dd>
            </div>
          ))}
        </dl>
      </details>

      <Card>
        <CardContent className="p-4">
          <form
            className="mb-4 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setSearch(keyword.trim());
            }}
          >
            <Input
              placeholder="按名称 / 类型 / 接入地址搜索…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="max-w-sm"
            />
            <Button type="submit" variant="outline">
              搜索
            </Button>
            <TenantFilterSelect />
          </form>

          {untestedOnly && (
            <div
              role="status"
              data-testid="untested-filter"
              className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#F7F9FD] px-4 py-2.5 text-[13px] text-ink-2"
            >
              <span>
                当前只显示「未测试」的对象（模型、应用接口和平台智能体，且尚未做过连通性测试）。
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPage(1);
                  setSearchParams(
                    (prev) => {
                      const next = new URLSearchParams(prev);
                      next.delete('untested');
                      return next;
                    },
                    { replace: true },
                  );
                }}
              >
                显示全部对象
              </Button>
            </div>
          )}

          <QueryState
            isLoading={list.isLoading}
            isError={list.isError}
            error={list.error}
            onRetry={() => void list.refetch()}
            empty={visibleTargets.length === 0}
            filtered={Boolean(search) || untestedOnly}
            permissionDenied={!canRead}
            emptyTitle="暂无评估对象"
            emptyDescription={
              untestedOnly
                ? '没有未测试的对象，可以点「显示全部对象」查看全部。'
                : '点击右上角“新建评估对象”完成首次接入配置。'
            }
          />
          {!list.isLoading && !list.isError && canRead && visibleTargets.length > 0 ? (
            <>
              <div className="space-y-6">
                <section aria-label="评估对象列表" className="space-y-3">
                  {canTest && subjectTargets.length > 0 && (
                    <FilterBar className="mb-0 text-[13px]">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={selectedIds.size === 0 || batchTestMutation.isPending}
                        onClick={() => batchTestMutation.mutate([...selectedIds])}
                      >
                        {batchTestMutation.isPending ? (
                          <Spinner className="h-3.5 w-3.5" />
                        ) : (
                          <ListChecks className="h-3.5 w-3.5" />
                        )}
                        批量连通性测试
                      </Button>
                      <span className="text-muted-foreground">已选 {selectedIds.size} 个</span>
                      {user?.isPlatformAdmin && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={selectedIds.size === 0 || transferOpen}
                          onClick={() => setTransferOpen(true)}
                          data-testid="target-transfer-open"
                        >
                          <Building2 className="h-3.5 w-3.5" />
                          移到租户
                        </Button>
                      )}
                      {batchResult && (
                        <span role="status" className="font-medium text-slate-700">
                          批量测试完成：共 {batchResult.summary.total} 个，成功{' '}
                          {batchResult.summary.success}，失败 {batchResult.summary.failed}
                          {batchResult.summary.skipped
                            ? `，跳过 ${batchResult.summary.skipped}`
                            : ''}
                        </span>
                      )}
                    </FilterBar>
                  )}
                  <TenantTransferDialog
                    open={transferOpen}
                    kind="model-target"
                    ids={[...selectedIds]}
                    onClose={() => setTransferOpen(false)}
                    onTransferred={(message) => {
                      toast.success(message);
                      setSelectedIds(new Set());
                      setBatchResult(null);
                    }}
                  />
                  {subjectTargets.length > 0 ? (
                    renderTargetTable(subjectTargets, 'subject')
                  ) : (
                    <div className="rounded-md border border-dashed border-slate-200 p-4 text-sm text-muted-foreground">
                      暂无评估对象。
                    </div>
                  )}
                </section>

                {evidenceTargets.length > 0 && (
                  <section aria-label="流量观测对象列表" className="space-y-3">
                    <h2 className="text-[13px] font-semibold text-slate-900">旁路流量观测对象</h2>
                    {renderTargetTable(evidenceTargets, 'evidence')}
                  </section>
                )}
              </div>
              <Pagination
                page={page}
                pageSize={pageSize}
                total={list.data?.total ?? 0}
                onPageChange={setPage}
              />
            </>
          ) : null}
        </CardContent>
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑评估对象' : '新建评估对象'}
        description="选择接入方式，并填写接口连接信息或流量筛选条件。"
        size="lg"
        footer={
          <>
            {canTest &&
              executableType(effectiveFormType, capabilities.data?.platformAppEnabled) && (
                <Button
                  variant="outline"
                  onClick={() => formDiagnoseMutation.mutate()}
                  disabled={formDiagnoseMutation.isPending || !canSubmit}
                >
                  {formDiagnoseMutation.isPending ? (
                    <Spinner className="h-4 w-4" />
                  ) : (
                    <Stethoscope className="h-4 w-4" />
                  )}
                  {effectiveFormType === 'PLATFORM_APP' ? '连接诊断' : '接口诊断'}
                </Button>
              )}
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !canSubmit}
            >
              {saveMutation.isPending && <Spinner className="h-4 w-4" />}
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-brand-400/60 bg-brand-50/60 px-4 py-3">
            <span className="min-w-0 flex-1 text-[13px] leading-5 text-ink-2">
              已有可用的 curl 命令？粘贴后自动识别
              URL、请求头、认证字段、请求体、提示词字段和响应字段。
            </span>
            <Button size="sm" variant="outline" onClick={() => setCurlOpen(true)}>
              <TerminalSquare className="h-3.5 w-3.5" />从 curl 导入
            </Button>
          </div>

          <FormSection
            title="基本信息"
            description="选择对象类型并命名；类型决定下方需要填写的接入信息。"
          >
            {targetOptions.length > 1 && (
              <Field
                label="对象类型"
                htmlFor="target-type"
                required
                className="sm:col-span-2"
                hint={targetDescription}
              >
                <Select
                  id="target-type"
                  aria-label="对象类型"
                  value={form.targetType}
                  onChange={(e) => changeTargetType(e.target.value as TargetType)}
                >
                  {targetOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {form.targetType === 'ENDPOINT_AGENT' && endpointEnabled && (
              <EndpointAgentFields
                product={form.endpointProduct}
                endpointId={form.endpointId}
                onProductChange={(product) =>
                  setForm({ ...form, endpointProduct: product, endpointId: '', endpointLabel: '' })
                }
                onEndpointChange={(endpoint) =>
                  setForm({
                    ...form,
                    endpointId: endpoint?.endpoint_id ?? '',
                    endpointLabel: endpoint?.hostname ?? '',
                    agentshieldBaseUrl: endpointFeature.data?.agentshieldBaseUrl ?? '',
                  })
                }
              />
            )}
            {form.targetType === 'AGENT_API' && AGENT_ENTRY_OPTIONS.length > 1 && (
              <Field
                label="智能体接入方式"
                htmlFor="agent-entry-mode"
                className="sm:col-span-2"
                hint={currentAgentEntry?.description}
              >
                <Select
                  id="agent-entry-mode"
                  aria-label="智能体接入方式"
                  value={form.agentEntryMode}
                  onChange={(e) => changeAgentEntryMode(e.target.value as AgentEntryMode)}
                >
                  {AGENT_ENTRY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <div className="rounded-xl border border-line border-l-4 border-l-brand-500 bg-white px-4 py-3 sm:col-span-2">
              <div className="flex items-center text-sm font-semibold text-foreground">
                {currentDetails.title}
                {TARGET_DETAIL_TECH_HINT[effectiveFormType] && (
                  <HelpHint
                    label="查看技术细节"
                    text={TARGET_DETAIL_TECH_HINT[effectiveFormType]!}
                  />
                )}
              </div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {currentDetails.description}
              </p>
            </div>
            <Field label="名称" htmlFor="target-name" required className="sm:col-span-2">
              <Input
                id="target-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：客户生产智能体应用"
              />
            </Field>
          </FormSection>

          {effectiveFormType !== 'ENDPOINT_AGENT' && (
            <FormSection
              title="接入配置"
              description="评估平台调用该对象所需的地址、模型与访问凭据。"
            >
              {effectiveFormType === 'MODEL' && (
                <Field
                  label="接入预设（OpenAI 兼容 API 接入）"
                  htmlFor="model-access-preset"
                  className="sm:col-span-2"
                  hint={
                    presetByProvider(form.provider)?.description ??
                    '按 OpenAI 兼容 API 协议调用 /chat/completions。'
                  }
                >
                  <Select
                    id="model-access-preset"
                    aria-label="接入预设"
                    value={presetByProvider(form.provider)?.key ?? ''}
                    onChange={(e) => applyPreset(e.target.value)}
                  >
                    <option value="">通用 OpenAI 兼容 API</option>
                    {MODEL_ACCESS_PRESETS.map((preset) => (
                      <option key={preset.key} value={preset.key}>
                        {preset.label}
                      </option>
                    ))}
                  </Select>
                  {(presetByProvider(form.provider)?.examples.length ?? 0) > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1 text-xs">
                      {presetByProvider(form.provider)!.examples.map((ex) => (
                        <button
                          key={ex.label}
                          type="button"
                          className="rounded border border-slate-200 bg-white px-2 py-0.5 font-mono hover:bg-slate-50"
                          onClick={() =>
                            setForm((prev) => ({ ...prev, baseUrl: ex.baseUrl, model: ex.model }))
                          }
                        >
                          {ex.label}：{ex.baseUrl}
                        </button>
                      ))}
                    </div>
                  )}
                </Field>
              )}

              {usesCallableUrl(effectiveFormType) && (
                <Field
                  label={accessLabel(effectiveFormType)}
                  htmlFor="target-base-url"
                  required
                  className="sm:col-span-2"
                  hint={accessHint(effectiveFormType)}
                >
                  <Input
                    id="target-base-url"
                    value={form.baseUrl}
                    onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                    placeholder={
                      usesModelName(effectiveFormType)
                        ? (presetByProvider(form.provider)?.baseUrlPlaceholder ??
                          'https://api.example.com/v1')
                        : 'https://agent.example.com/api/chat'
                    }
                    className="font-mono text-xs"
                  />
                </Field>
              )}

              {usesModelName(effectiveFormType) && (
                <Field
                  label="模型名称"
                  htmlFor="target-model"
                  required
                  hint="填写 AI 提供方给出的模型标识，例如 gpt-4o-mini、qwen-max。"
                >
                  <Input
                    id="target-model"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="gpt-4o-mini"
                    className="font-mono text-xs"
                  />
                </Field>
              )}
              {showsApiKey(effectiveFormType) && (
                <Field
                  label={effectiveFormType === 'PLATFORM_APP' ? '应用密钥' : '访问密钥（API Key）'}
                  htmlFor="target-api-key"
                  hint={
                    editing
                      ? '留空则保持原密钥不变'
                      : usesModelName(effectiveFormType)
                        ? '填写模型提供方签发的访问密钥，通常以 sk- 开头。'
                        : '选填。填写接口提供方签发的访问密钥。'
                  }
                >
                  <Input
                    id="target-api-key"
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    placeholder={editing ? '••••••（不修改可留空）' : 'sk-...'}
                  />
                </Field>
              )}

              {effectiveFormType === 'PLATFORM_APP' && (
                <>
                  <Field label="平台" htmlFor="platform-app-platform">
                    <Select
                      id="platform-app-platform"
                      value={form.platform}
                      onChange={(e) =>
                        setForm({ ...form, platform: e.target.value as FormState['platform'] })
                      }
                    >
                      <option value="dify">Dify</option>
                      <option value="coze">扣子</option>
                    </Select>
                  </Field>
                  {form.platform === 'dify' ? (
                    <Field label="应用模式" htmlFor="platform-app-mode">
                      <Select
                        id="platform-app-mode"
                        value={form.appMode}
                        onChange={(e) =>
                          setForm({ ...form, appMode: e.target.value as FormState['appMode'] })
                        }
                      >
                        <option value="agent-chat">智能体对话</option>
                        <option value="chat">基础对话</option>
                        <option value="advanced-chat">对话工作流</option>
                        <option value="workflow">工作流（单轮）</option>
                      </Select>
                    </Field>
                  ) : (
                    <Field label="机器人标识" htmlFor="platform-app-bot" required>
                      <Input
                        id="platform-app-bot"
                        value={form.botId}
                        onChange={(e) => setForm({ ...form, botId: e.target.value })}
                      />
                    </Field>
                  )}
                  <PlatformCanaryField
                    id="platform-app-knowledge-canary"
                    label="知识库暗号"
                    hint="在测试应用的知识库蜜罐文档里放入同一个暗号；用于判断知识库越权。"
                    value={form.knowledgeCanary}
                    onChange={(knowledgeCanary) => setForm({ ...form, knowledgeCanary })}
                    configured={
                      editing?.targetType === 'PLATFORM_APP'
                        ? canaryConfigured(editing, 'knowledgeCanary')
                        : undefined
                    }
                  />
                  <PlatformCanaryField
                    id="platform-app-system-canary"
                    label="系统提示词暗号"
                    hint="在测试应用的系统提示词里放入同一个暗号；用于判断系统提示词泄露。"
                    value={form.systemCanary}
                    onChange={(systemCanary) => setForm({ ...form, systemCanary })}
                    configured={
                      editing?.targetType === 'PLATFORM_APP'
                        ? canaryConfigured(editing, 'systemCanary')
                        : undefined
                    }
                  />
                </>
              )}

              {effectiveFormType === 'AGENT_API' && (
                <AgentApiAccessFields form={form} setForm={setForm} />
              )}
              {effectiveFormType === 'MCP_OPENAPI' && (
                <Field
                  label="OpenAPI / MCP Schema URL"
                  htmlFor="mcp-schema-url"
                  required
                  className="sm:col-span-2"
                >
                  <Input
                    id="mcp-schema-url"
                    value={form.schemaUrl}
                    onChange={(e) => setForm({ ...form, schemaUrl: e.target.value })}
                    placeholder="https://agent.example.com/openapi.json"
                    className="font-mono text-xs"
                  />
                </Field>
              )}
              {effectiveFormType === 'PUBLIC_AGENT' && (
                <Field
                  label="公网访问入口 URL"
                  htmlFor="public-entry-url"
                  className="sm:col-span-2"
                  hint="登记公网访问入口，供后续浏览器黑盒评估使用。"
                >
                  <Input
                    id="public-entry-url"
                    value={form.entryUrl}
                    onChange={(e) => setForm({ ...form, entryUrl: e.target.value })}
                    placeholder="https://chat.example.com"
                    className="font-mono text-xs"
                  />
                </Field>
              )}
              {effectiveFormType === 'GATEWAY_LOG' && (
                <>
                  <Field
                    label="安全网关地址"
                    htmlFor="gateway-base-url"
                    required
                    className="sm:col-span-2"
                    hint="默认使用系统网关地址；评估对象接入其他网关时填写对应地址。"
                  >
                    <Input
                      id="gateway-base-url"
                      value={form.gatewayBaseUrl}
                      onChange={(e) => setForm({ ...form, gatewayBaseUrl: e.target.value })}
                      placeholder="192.168.1.20:8081 或 https://agent-gw.example.com"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="网关分区标识（选填）"
                    htmlFor="gateway-tenant-id"
                    hint="留空时使用系统默认分区。"
                  >
                    <Input
                      id="gateway-tenant-id"
                      value={form.tenantId}
                      onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
                      placeholder="tenant_default"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="调用方标识（选填）"
                    htmlFor="gateway-ident-client"
                    hint="用于筛选该评估对象产生的网关记录。未知时可留空或联系网关管理员。"
                  >
                    <Input
                      id="gateway-ident-client"
                      value={form.gatewayClientId}
                      onChange={(e) => setForm({ ...form, gatewayClientId: e.target.value })}
                      placeholder="na_xxx"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="来源地址 IP（选填）"
                    htmlFor="gateway-ident-ip"
                    hint="可按来源 IP 筛选网关记录；与调用方标识至少配置一项即可。"
                  >
                    <Input
                      id="gateway-ident-ip"
                      value={form.gatewaySourceIp}
                      onChange={(e) => setForm({ ...form, gatewaySourceIp: e.target.value })}
                      placeholder="10.0.0.9"
                      className="font-mono text-xs"
                    />
                  </Field>
                </>
              )}
            </FormSection>
          )}

          {platformTenant && (effectiveFormType === 'MODEL' || effectiveFormType === 'AGENT_API') && (
            <FormSection
              title="安全网关关联（选填）"
              description="流量经过安全网关时填写，报告中可关联相应审计记录。"
            >
              {effectiveFormType === 'MODEL' && (
                <>
                  <Field
                    label="安全网关地址（选填）"
                    htmlFor="model-gateway-base-url"
                    hint="选填。若该对象的流量经过安全网关，请填写网关 IP；系统将自动补全端口和路径，并在报告中关联相应审计记录。"
                    className="sm:col-span-2"
                  >
                    <Input
                      id="model-gateway-base-url"
                      value={form.gatewayBaseUrl}
                      onChange={(e) => setForm({ ...form, gatewayBaseUrl: e.target.value })}
                      placeholder="100.64.0.10"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="网关分区标识（选填）"
                    htmlFor="model-gateway-tenant"
                    hint="留空时使用系统默认分区；已分配独立网关分区时填写对应标识。"
                  >
                    <Input
                      id="model-gateway-tenant"
                      value={form.tenantId}
                      onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
                      placeholder="tenant_default"
                      className="font-mono text-xs"
                    />
                  </Field>
                </>
              )}
              {effectiveFormType === 'AGENT_API' && (
                <>
                  <Field
                    label="安全网关地址（选填）"
                    htmlFor="agent-gateway-base-url"
                    hint="选填。若该对象的流量经过安全网关，请填写网关地址，以便在报告中关联相应审计记录。"
                    className="sm:col-span-2"
                  >
                    <Input
                      id="agent-gateway-base-url"
                      value={form.gatewayBaseUrl}
                      onChange={(e) => setForm({ ...form, gatewayBaseUrl: e.target.value })}
                      placeholder="100.64.0.10"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="网关分区标识（选填）"
                    htmlFor="agent-gateway-tenant"
                    hint="留空时使用系统默认分区；已分配独立网关分区时填写对应标识。"
                  >
                    <Input
                      id="agent-gateway-tenant"
                      value={form.tenantId}
                      onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
                      placeholder="tenant_default"
                      className="font-mono text-xs"
                    />
                  </Field>
                </>
              )}
            </FormSection>
          )}

          <FormSection title="状态与选项">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                启用
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isGlobal}
                  onChange={(e) => setForm({ ...form, isGlobal: e.target.checked })}
                />
                设为全局对象（所有用户可见）
              </label>
              {effectiveFormType === 'MODEL' && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label="支持图片输入"
                    checked={form.supportsVision}
                    onChange={(e) => setForm({ ...form, supportsVision: e.target.checked })}
                  />
                  支持图片输入（开启后可发起多模态越狱评估）
                </label>
              )}
            </div>
            <RagTargetFields
              form={form}
              setForm={setForm}
              targetType={effectiveFormTargetType(form)}
            />
          </FormSection>
          {formDiagnose && (
            <div className="sm:col-span-2">
              <DiagnoseReportView report={formDiagnose} />
            </div>
          )}
        </div>
      </Modal>

      <CurlImportModal open={curlOpen} onClose={() => setCurlOpen(false)} onApply={applyCurl} />

      <Modal
        open={Boolean(diagnoseTarget)}
        onClose={() => setDiagnoseTarget(null)}
        title="接口诊断"
        description={diagnoseTarget?.name}
        size="lg"
        footer={
          <>
            <Button
              variant="outline"
              disabled={!diagnoseTarget || savedDiagnoseMutation.isPending}
              onClick={() => diagnoseTarget && openSavedDiagnose(diagnoseTarget)}
            >
              重新诊断
            </Button>
            <Button onClick={() => setDiagnoseTarget(null)}>关闭</Button>
          </>
        }
      >
        {savedDiagnoseMutation.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            正在诊断：发送一次测试请求并分析认证、流式、异步、会话与字段…
          </div>
        ) : savedDiagnose ? (
          <DiagnoseReportView report={savedDiagnose} />
        ) : (
          <p className="text-sm text-muted-foreground">诊断未完成，请重试。</p>
        )}
      </Modal>

      <GatewayDrillModal target={drillTarget} onClose={() => setDrillTarget(null)} />

      <Modal
        open={Boolean(fingerprintTarget)}
        onClose={() => setFingerprintTarget(null)}
        title="模型指纹"
        description={fingerprintTarget?.name}
        size="lg"
      >
        {fingerprintTarget && (
          <TargetFingerprintSection targetId={fingerprintTarget.id} canUpdate={canUpdate} />
        )}
      </Modal>

      <Modal
        open={Boolean(gatewayAnalyzeTarget)}
        onClose={closeGatewayAnalyze}
        title="分析网关日志"
        description={gatewayAnalyzeTarget?.name}
        size="md"
        footer={
          <>
            <Button
              variant="outline"
              onClick={closeGatewayAnalyze}
              disabled={gatewayAnalyzeMutation.isPending}
            >
              取消
            </Button>
            <Button
              onClick={() => gatewayAnalyzeMutation.mutate()}
              disabled={gatewayAnalyzeMutation.isPending || !canSubmitGatewayAnalyze}
            >
              {gatewayAnalyzeMutation.isPending && <Spinner className="h-4 w-4" />}
              开始分析
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="任务名称" htmlFor="gateway-analysis-name" className="sm:col-span-2">
            <Input
              id="gateway-analysis-name"
              value={gatewayAnalyzeForm.name}
              onChange={(e) =>
                setGatewayAnalyzeForm({
                  ...gatewayAnalyzeForm,
                  name: e.target.value,
                })
              }
              placeholder="网关日志风险分析"
            />
          </Field>
          <Field label="开始时间" htmlFor="gateway-analysis-start" required>
            <Input
              id="gateway-analysis-start"
              type="datetime-local"
              value={gatewayAnalyzeForm.startTime}
              onChange={(e) =>
                setGatewayAnalyzeForm({
                  ...gatewayAnalyzeForm,
                  startTime: e.target.value,
                })
              }
            />
          </Field>
          <Field label="结束时间" htmlFor="gateway-analysis-end" required>
            <Input
              id="gateway-analysis-end"
              type="datetime-local"
              value={gatewayAnalyzeForm.endTime}
              onChange={(e) =>
                setGatewayAnalyzeForm({
                  ...gatewayAnalyzeForm,
                  endTime: e.target.value,
                })
              }
            />
          </Field>
          <Field
            label="调用方标识（选填）"
            htmlFor="gateway-analysis-client-id"
            hint="仅分析指定调用方的记录；留空表示不限制调用方。"
          >
            <Input
              id="gateway-analysis-client-id"
              value={gatewayAnalyzeForm.clientId}
              onChange={(e) =>
                setGatewayAnalyzeForm({
                  ...gatewayAnalyzeForm,
                  clientId: e.target.value,
                })
              }
              placeholder="留空表示不限调用方"
            />
          </Field>
          <Field
            label="源 IP 过滤"
            htmlFor="gateway-analysis-source-ip"
            hint="可选。只分析来自该源 IP 的网关日志；留空则不限来源。"
          >
            <Input
              id="gateway-analysis-source-ip"
              value={gatewayAnalyzeForm.sourceIp}
              onChange={(e) =>
                setGatewayAnalyzeForm({
                  ...gatewayAnalyzeForm,
                  sourceIp: e.target.value,
                })
              }
              placeholder="留空表示不限源 IP"
            />
          </Field>
          <Field
            label="诱饵标记（选填，用于验证是否泄露）"
            htmlFor="gateway-analysis-canary"
            hint="选填。填写诱饵演练生成的追踪标记后，系统会在网关日志中核验该标记是否发生外发；留空则不执行诱饵匹配。"
          >
            <Input
              id="gateway-analysis-canary"
              value={gatewayAnalyzeForm.canaryTokens}
              onChange={(e) =>
                setGatewayAnalyzeForm({
                  ...gatewayAnalyzeForm,
                  canaryTokens: e.target.value,
                })
              }
              placeholder="LSE-DRILL-xxxx"
            />
          </Field>
        </div>
      </Modal>

      {deleteRefTarget && (
        <ReferenceDeleteDialog
          target={deleteRefTarget}
          onClose={() => setDeleteRefTarget(null)}
          onObjectDeleted={() => {
            toast.success('已删除');
            setDeleteRefTarget(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function ReferenceDeleteDialog({
  target,
  onClose,
  onObjectDeleted,
}: {
  target: ModelTarget;
  onClose: () => void;
  onObjectDeleted: () => void;
}) {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const refsQuery = useQuery({
    queryKey: ['model-target-references', target.id],
    queryFn: () => api.evalTasks.list({ modelTargetId: target.id, pageSize: 100 }),
    // 列表由打开弹窗前的 qc.fetchQuery 预取并写入同 key 缓存；挂载时直接复用缓存、
    // 不重新请求，避免与"删除任务后显式 refetch"重复触发。删除任务后由 refetch() 强制刷新。
    staleTime: Infinity,
    refetchOnMount: false,
  });
  const tasks = refsQuery.data?.items ?? [];
  const removeTask = useMutation({
    mutationFn: (taskId: string) => api.evalTasks.remove(taskId),
    onSuccess: () => refsQuery.refetch(),
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : '删除任务失败');
      refsQuery.refetch();
    },
  });
  const removeObject = useMutation({
    mutationFn: () => api.modelTargets.remove(target.id),
    onSuccess: onObjectDeleted,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除对象失败'),
  });
  // 连同任务一起删：服务端一次事务里删完，任一任务不能删就整体拒绝。
  const removeWithTasks = useMutation({
    mutationFn: () => api.modelTargets.remove(target.id, { withTasks: true }),
    onSuccess: onObjectDeleted,
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : '删除失败');
      refsQuery.refetch();
    },
  });
  const taskTotal = refsQuery.data?.total ?? tasks.length;
  // 自动收尾：引用列表确实加载完成且归零时，自动删除对象（只触发一次）。
  const settled = !refsQuery.isLoading && !refsQuery.isFetching;
  useEffect(() => {
    if (settled && tasks.length === 0 && removeObject.isIdle) {
      removeObject.mutate();
    }
  }, [settled, tasks.length, removeObject]);
  return (
    <Modal
      open
      onClose={onClose}
      title={`无法直接删除「${targetDisplayName(target)}」——被以下评估任务引用`}
      description="清空全部引用后，将自动删除该对象。"
      size="lg"
      footer={
        <>
          {tasks.length > 0 && hasPermission('eval_task:delete') && (
            <Button
              variant="destructive"
              disabled={removeWithTasks.isPending || removeTask.isPending}
              onClick={() => {
                if (
                  confirm(
                    `删除「${targetDisplayName(target)}」？同时删除 ${taskTotal} 个评估任务及其结果和报告，不可恢复。`,
                  )
                )
                  removeWithTasks.mutate();
              }}
            >
              连同任务一起删除
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
        </>
      }
    >
      {refsQuery.isLoading ? (
        <Spinner />
      ) : removeObject.isError ? (
        <div className="space-y-3">
          <div className="text-sm text-destructive">
            自动删除对象失败，请重试。
            {removeObject.error instanceof Error && removeObject.error.message
              ? `（${removeObject.error.message}）`
              : ''}
          </div>
          <Button variant="outline" size="sm" onClick={() => removeObject.mutate()}>
            重试删除
          </Button>
        </div>
      ) : tasks.length === 0 ? (
        <div className="text-sm text-muted-foreground">引用已清空，正在删除对象…</div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>评估任务</TH>
              <TH>状态</TH>
              <TH>创建时间</TH>
              <TH>操作</TH>
            </TR>
          </THead>
          <TBody>
            {tasks.map((task) => {
              const isRunning = task.status === 'RUNNING';
              return (
                <TR key={task.id}>
                  <TD>{task.name}</TD>
                  <TD>{evalTaskStatusLabel(task.status)}</TD>
                  <TD>{formatDateTime(task.createdAt)}</TD>
                  <TD>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="删除"
                      disabled={isRunning || removeTask.isPending}
                      title={isRunning ? '任务运行中，暂时不能删' : undefined}
                      onClick={() => {
                        const n = task.resultCount;
                        const msg = n
                          ? `删除评估任务「${task.name}」？将同时清除其 ${n} 条评估结果与相关报告，且不可恢复。`
                          : `删除评估任务「${task.name}」？将同时清除其评估结果与报告，且不可恢复。`;
                        if (confirm(msg)) removeTask.mutate(task.id);
                      }}
                    >
                      删除
                    </Button>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </Modal>
  );
}
