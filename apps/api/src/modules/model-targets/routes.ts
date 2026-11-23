import { endpointAccessConfigSchema, endpointEvalEnabled } from '../endpoint-evals/config.js';
import { connectorOwnerWhere, isPlatformConnector } from '../../lib/platform-connector-access.js';
import type { FastifyInstance } from 'fastify';
import { Prisma, TargetType } from '@prisma/client';
import { z } from 'zod';
import type { Paginated, LlmTargetConfig, LlmCallResult } from '@lse/shared';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { currentTenantId } from '../../lib/tenant-context.js';
import { applyTenantFilter } from '../../lib/all-tenants.js';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';
import { badRequest, conflict, forbidden, notFound, permissionDenied } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { chatComplete } from '../../lib/llm-client.js';
import { redactJson } from '../../lib/redact.js';
import { assertControlPlaneAllowed, resolveInternalToken } from '../../lib/gateway-access.js';
import { resolveServerTargetEgressContext } from '../../lib/target-egress-policy.js';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RED_TEAM_SETTING_KEY } from '../red-team/config.js';
import { AGENT_EVAL_SETTING_KEY } from '../agent-evals/config.js';
import {
  fetchGatewayHealth,
  fetchGatewayVerifyReciprocal,
  gatewayReciprocityMessage,
} from '../gateway-logs/client.js';
import { invokeEvaluationTarget } from '../eval-targets/invoker.js';
import { runDiagnosis } from './diagnose.js';
import { resolveEndpointStates, type EndpointState } from './endpoint-state.js';
import {
  deleteTaskRecords,
  purgeTaskByoSets,
  taskDeleteBlocker,
  taskDeleteSelect,
  type DeletableTask,
} from '../eval-tasks/delete-task.js';
import { parsePlatformAppConfig } from '../eval-targets/platform-adapters/config.js';
import {
  ragOptionsSchema,
  readStoredRagOptions,
  isRagEligibleType,
  RAG_TARGET_TYPE_MESSAGE,
} from '../rag-eval/options.js';
import { decryptCredential, encryptCredential, isEncryptedCredential } from '../../lib/credential-crypto.js';
import { agentConfigSchema, parseAgentConfig, assertAgentGateway, bindAgentIdentity } from '../agent-evals/agent-target.js';

const idParams = z.object({ id: z.string().uuid() });

const extraHeadersSchema = z.record(z.string()).nullable().optional();
const defaultParamsSchema = z.record(z.unknown()).nullable().optional();
const accessConfigSchema = z.record(z.unknown()).nullable().optional();
const targetTypeSchema = z.nativeEnum(TargetType).default('MODEL');

const createSchema = z.object({
  name: z.string().min(1).max(100),
  targetType: targetTypeSchema,
  provider: z.string().min(1).max(50).default('openai-compatible'),
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().max(1000).optional(),
  model: z.string().max(200).optional(),
  extraHeaders: extraHeadersSchema,
  defaultParams: defaultParamsSchema,
  accessConfig: accessConfigSchema,
  agentConfig: agentConfigSchema.nullable().optional(),
  isActive: z.boolean().optional(),
  isGlobal: z.boolean().optional(),
  isRag: z.boolean().optional(),
  ragOptions: ragOptionsSchema.nullable().optional(),
  ragRestrictedUploadSecret: z.string().max(4000).nullable().optional(),
  supportsVision: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  targetType: z.nativeEnum(TargetType).optional(),
  provider: z.string().min(1).max(50).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().max(1000).optional(),
  model: z.string().max(200).optional(),
  extraHeaders: extraHeadersSchema,
  defaultParams: defaultParamsSchema,
  accessConfig: accessConfigSchema,
  agentConfig: agentConfigSchema.nullable().optional(),
  isActive: z.boolean().optional(),
  isGlobal: z.boolean().optional(),
  isRag: z.boolean().optional(),
  // 编辑时按字段合并：只覆盖提交的键；键值为 null/空串表示清除该项。合并后再按 ragOptionsSchema 完整校验。
  ragOptions: z.record(z.unknown()).nullable().optional(),
  // 受限库上传凭据：undefined 保持不变；null/空串清除；字符串则加密后覆盖。响应中永不回显。
  ragRestrictedUploadSecret: z.string().max(4000).nullable().optional(),
  supportsVision: z.boolean().optional(),
});

const RAG_OPTION_GROUPS = new Set(['knowledgeUpload', 'knowledgeDelete', 'retrieval']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function dropCleared(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === '' || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** ragOptions 合并更新：旧数据先规范化（兼容 knowledgeUpload.testKnowledgeBaseId），再逐键/逐分组合并。 */
export function mergeRagOptions(existing: unknown, incoming: Record<string, unknown> | null) {
  if (incoming === null) return null;
  const base: Record<string, unknown> = { ...readStoredRagOptions(existing) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === '') {
      delete base[key];
    } else if (RAG_OPTION_GROUPS.has(key) && isPlainObject(value)) {
      const prev = isPlainObject(base[key]) ? (base[key] as Record<string, unknown>) : {};
      const cleared = Object.keys(value).filter((k) => value[k] === null || value[k] === '');
      const merged = dropCleared({ ...prev, ...value });
      for (const k of cleared) delete merged[k];
      base[key] = merged;
    } else {
      base[key] = value;
    }
  }
  return ragOptionsSchema.parse(base);
}

function assertRagEligible(targetType: string, isRag: boolean) {
  if (isRag && !isRagEligibleType(targetType)) throw badRequest(RAG_TARGET_TYPE_MESSAGE, 'RAG_TARGET_TYPE_UNSUPPORTED');
}

function secretInput(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  return encryptCredential(value.trim());
}

const testExistingSchema = z.object({ prompt: z.string().max(2000).optional() });
const testConfigSchema = z.object({
  baseUrl: z.string().url().max(500),
  apiKey: z.string().min(1).max(1000),
  model: z.string().min(1).max(200),
  extraHeaders: extraHeadersSchema,
  defaultParams: defaultParamsSchema,
  prompt: z.string().max(2000).optional(),
});

const diagnoseConfigSchema = z.object({
  /** 编辑已保存对象时可只传 targetId，未填写的密钥沿用已保存值（不回显给前端）。 */
  targetId: z.string().uuid().optional(),
  targetType: z.nativeEnum(TargetType),
  baseUrl: z.string().url().max(500),
  apiKey: z.string().max(1000).optional(),
  model: z.string().max(200).optional(),
  extraHeaders: extraHeadersSchema,
  defaultParams: defaultParamsSchema,
  accessConfig: accessConfigSchema,
});
const batchTestSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(50) });
const BATCH_TEST_CONCURRENCY = 4;
const DIAGNOSABLE_TYPES = new Set<TargetType>(['MODEL', 'AGENT_API', 'PUBLIC_AGENT', 'PLATFORM_APP', 'JUDGE']);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().trim().optional(),
  includeSystem: z
    .preprocess((value) => value === true || value === 'true' || value === '1', z.boolean())
    .default(false),
  // 首页「测试」按钮：只列启用中、可做连通性测试（模型/应用接口/平台智能体）且从未测试的对象。
  untested: z
    .preprocess((value) => value === true || value === 'true' || value === '1', z.boolean())
    .default(false),
  tenantId: z.string().uuid().optional(),
  // 终端类对象是否带上 endpointState。要问智能体安全平台，只有评估对象页这类明确要的调用方才带。
  withEndpointState: z
    .preprocess((value) => value === true || value === 'true' || value === '1', z.boolean())
    .default(false),
});

const deleteQuery = z.object({
  // 连同名下的评估任务（及其结果、报告）一起删除。
  withTasks: z
    .preprocess((value) => value === true || value === 'true' || value === '1', z.boolean())
    .default(false),
});

/** 连同任务删除时任务多、结果多会比较慢，放宽事务时限（默认 5 秒）；不带任务时沿用默认。 */
const WITH_TASKS_TX_TIMEOUT_MS = 60_000;

/** 错误提示里点名任务：最多列 5 个。 */
function taskNames(tasks: Array<{ name: string }>): string {
  const shown = tasks.slice(0, 5).map((task) => `「${task.name}」`).join('、');
  return tasks.length > 5 ? `${shown} 等` : shown;
}

const targetInclude = {
  createdBy: { select: { id: true, username: true } },
} satisfies Prisma.ModelTargetInclude;
type TargetRow = Prisma.ModelTargetGetPayload<{ include: typeof targetInclude }>;

const DEFAULT_PROBE = '你好，请用一句话回复以确认连接正常。';

const REDACTED_VALUE_RE = /^hash:[0-9a-f]{12}$/i;

/**
 * 前端拿到的 accessConfig.headers 是脱敏值（hash:xxxx）。编辑回传时，把仍为脱敏占位的
 * 请求头还原为已保存原值，避免凭据被占位符覆盖；新填写的值原样采用。
 */
/** 平台应用对象的探针暗号：读取时被脱敏成 hash:xxxx，表单没改动就不会重新输入。保存时沿用库里的原值。 */
const PLATFORM_CANARY_KEYS = ['knowledgeCanary', 'systemCanary'] as const;
function restorePlatformCanaries(incoming: unknown, saved: unknown): unknown {
  if (!isRecord(incoming) || incoming.platform === undefined) return incoming;
  const savedRecord = isRecord(saved) ? saved : {};
  const out: Record<string, unknown> = { ...incoming };
  for (const key of PLATFORM_CANARY_KEYS) {
    const value = out[key];
    const hasSaved = typeof savedRecord[key] === 'string';
    if (value === undefined && hasSaved) out[key] = savedRecord[key];
    else if (typeof value === 'string' && REDACTED_VALUE_RE.test(value)) {
      if (hasSaved) out[key] = savedRecord[key];
      else delete out[key];
    }
  }
  return out;
}

function restoreRedactedHeaders(incomingRaw: unknown, saved: unknown): unknown {
  const incoming = restorePlatformCanaries(incomingRaw, saved);
  if (!isRecord(incoming) || !isRecord(incoming.headers)) return incoming;
  const savedHeaders = isRecord(saved) && isRecord(saved.headers) ? saved.headers : {};
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string' && REDACTED_VALUE_RE.test(value)) {
      if (typeof savedHeaders[name] === 'string') headers[name] = savedHeaders[name];
      continue;
    }
    headers[name] = value;
  }
  return { ...incoming, headers };
}

/** Json? 字段写库辅助：undefined 表示不变/不设，null 映射为数据库 NULL。 */
function jsonInput(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (v === undefined) return undefined;
  if (v === null) return Prisma.DbNull;
  return v as Prisma.InputJsonValue;
}

/** 脱敏展示 apiKey，绝不在任何响应里回传明文。 */
function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

type ConnectorCapability = {
  key: string;
  label: string;
  supported: boolean;
  requirement?: string;
};

function connectorCapabilities(targetType: TargetType): ConnectorCapability[] {
  if (targetType === 'ENDPOINT_AGENT') {
    return [
      { key: 'endpoint_posture', label: '终端配置体检', supported: true },
      { key: 'endpoint_execution', label: '真实终端隔离测评', supported: true, requirement: '需终端装有测评执行器，且对应智能体支持无界面运行。' },
    ];
  }
  if (targetType === 'MODEL') {
    return [
      { key: 'model_api', label: '模型/API', supported: true },
      {
        key: 'agent_simulation',
        label: '模拟智能体基准',
        supported: true,
        requirement: '平台按模型 API 模拟智能体安全场景，不代表真实工具执行。',
      },
      {
        key: 'app_trace',
        label: '应用回答/节点轨迹',
        supported: false,
        requirement: '需要客户应用 API 或轨迹导入。',
      },
      {
        key: 'tool_observation',
        label: '工具观测/副作用核验',
        supported: false,
        requirement: '需要测试副本和工具观测。',
      },
    ];
  }
  if (targetType === 'PLATFORM_APP') {
    return [
      { key: 'app_api', label: '真实平台应用回答', supported: true },
      { key: 'app_trace', label: '应用回答/节点轨迹', supported: true },
      { key: 'tool_observation', label: '工具观测/副作用核验', supported: true },
    ];
  }
  if (targetType === 'AGENT_API' || targetType === 'PUBLIC_AGENT') {
    return [
      { key: 'app_api', label: '应用 API 黑盒回答', supported: true },
      {
        key: 'agent_simulation',
        label: '模拟安全基准',
        supported: true,
        requirement: '可用作补充基准，不能替代应用内部轨迹。',
      },
      { key: 'session_stream', label: '固定会话/SSE·NDJSON 流式', supported: true },
      {
        key: 'session_trace',
        label: '节点轨迹/异步轮询',
        supported: false,
        requirement:
          '通用连接器不采集应用内部节点轨迹；异步任务接口需改用同步（阻塞）模式接入，接入诊断会给出提示。',
      },
      {
        key: 'tool_observation',
        label: '工具观测/副作用核验',
        supported: false,
        requirement: '需要客户提供测试副本或网关工具观测。',
      },
    ];
  }
  if (targetType === 'MCP_OPENAPI') {
    return [
      { key: 'mcp_skill_schema', label: 'MCP / Skill Schema', supported: true },
      { key: 'asset_scan', label: '工具描述/暴露面扫描', supported: true },
      {
        key: 'tool_observation',
        label: '工具观测/副作用核验',
        supported: false,
        requirement: '需要测试副本、工具观测和副作用核验条件。',
      },
      {
        key: 'controlled_execution',
        label: '受控工具执行',
        supported: false,
        requirement: '当前仅登记 Schema，不代表真实工具执行。',
      },
    ];
  }
  if (targetType === 'GATEWAY_LOG') {
    return [
      { key: 'gateway_evidence', label: '网关流量/阻断证据', supported: true },
      {
        key: 'app_trace',
        label: '应用回答/节点轨迹',
        supported: false,
        requirement: '仅有网关日志时不包含应用节点轨迹。',
      },
      {
        key: 'tool_observation',
        label: '工具副作用核验',
        supported: false,
        requirement: '需要测试副本和工具观测。',
      },
    ];
  }
  return [
    { key: 'registered_asset', label: '资产登记/专项扫描', supported: true },
    {
      key: 'closed_loop_execution',
      label: '真实行为闭环',
      supported: false,
      requirement: '当前连接器未验证真实执行闭环。',
    },
  ];
}

function targetApiKey(targetType: string, stored: string): string {
  return targetType === 'PLATFORM_APP' && isEncryptedCredential(stored)
    ? decryptCredential(stored) ?? ''
    : stored;
}

function serializeTarget(t: TargetRow) {
  return {
    id: t.id,
    name: t.name,
    targetType: t.targetType,
    provider: t.provider,
    baseUrl: t.baseUrl,
    model: t.model,
    apiKeyMasked: maskKey(targetApiKey(t.targetType, t.apiKey)),
    hasApiKey: Boolean(t.apiKey),
    extraHeaders: t.extraHeaders == null ? null : redactJson(t.extraHeaders),
    defaultParams: t.defaultParams ?? null,
    agentConfig: t.agentConfig ?? null,
    accessConfig: t.accessConfig == null ? null : redactJson(t.accessConfig),
    connectorCapabilities: connectorCapabilities(t.targetType),
    isGlobal: t.isGlobal,
    supportsVision: t.supportsVision,
    isActive: t.isActive,
    lastTestedAt: t.lastTestedAt,
    lastTestStatus: t.lastTestStatus,
    isRag: t.isRag,
    ragOptions: t.ragOptions ?? null,
    hasRagRestrictedUploadSecret: Boolean(t.ragRestrictedUploadSecret),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    createdBy: t.createdBy ? { id: t.createdBy.id, username: t.createdBy.username } : null,
    tenantId: t.tenantId ?? null,
  };
}

function toCfg(t: {
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders: Prisma.JsonValue;
  defaultParams: Prisma.JsonValue;
  accessConfig?: Prisma.JsonValue;
}): LlmTargetConfig {
  return {
    baseUrl: t.baseUrl,
    apiKey: t.apiKey,
    model: t.model,
    extraHeaders: (t.extraHeaders as Record<string, string> | null) ?? null,
    defaultParams: (t.defaultParams as Record<string, unknown> | null) ?? null,
    egressContext: resolveServerTargetEgressContext(),
  };
}

async function runConnectionTest(
  cfg: LlmTargetConfig,
  promptText?: string,
): Promise<LlmCallResult> {
  return chatComplete(cfg, [{ role: 'user', content: promptText?.trim() || DEFAULT_PROBE }], {
    timeoutMs: 30_000,
    maxTokens: 64,
    temperature: 0,
  });
}

/** 已保存对象的连通性测试：模型走 OpenAI 兼容调用，智能体应用走与评估相同的应用 API 调用器。 */
async function runTargetConnectionTest(
  t: Prisma.ModelTargetGetPayload<object>,
  promptText?: string,
): Promise<LlmCallResult> {
  assertPlatformAppEnabled(t.targetType);
  if (t.targetType === 'AGENT_API' || t.targetType === 'PUBLIC_AGENT' || t.targetType === 'PLATFORM_APP') {
    return invokeEvaluationTarget(
      { ...t, apiKey: targetApiKey(t.targetType, t.apiKey) },
      [{ role: 'user', content: promptText?.trim() || DEFAULT_PROBE }],
      { timeoutMs: 30_000, sessionId: `lse-conn-test-${randomBytes(6).toString('hex')}` },
    );
  }
  return runConnectionTest(toCfg(t), promptText);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  if (typeof field !== 'string') return undefined;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireUrl(value: string | undefined, message: string, code: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw badRequest(message, code);
  try {
    new URL(trimmed);
  } catch {
    throw badRequest('接口地址格式无效，请填写完整的 HTTP 或 HTTPS 地址。', code);
  }
  return trimmed;
}

function ensureHttpUrl(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeGatewayBaseUrl(raw: string | undefined): {
  gatewayBaseUrl: string;
  controlPlaneBaseUrl: string;
} {
  const input = raw?.trim();
  if (!input) {
    throw badRequest('智能体安全网关日志源需要配置网关地址或 IP', 'GATEWAY_BASE_URL_REQUIRED');
  }
  const withScheme = ensureHttpUrl(input);
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw badRequest('智能体安全网关地址必须是合法 URL 或 IP:端口', 'GATEWAY_BASE_URL_INVALID');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('智能体安全网关地址仅支持 http 或 https', 'GATEWAY_BASE_URL_INVALID');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.host) {
    throw badRequest('智能体安全网关地址不能包含账号、查询参数或片段', 'GATEWAY_BASE_URL_INVALID');
  }
  // 只填 IP/host 时补默认网关对外端口 8080（gateway-core 透传集成 API）；已带端口则尊重。
  if (!parsed.port) parsed.host = `${parsed.hostname}:8080`;
  const withoutTrailing = trimTrailingSlash(parsed.toString());
  const gatewayBaseUrl = trimTrailingSlash(withoutTrailing.replace(/\/admin\/v1$/i, ''));
  return {
    gatewayBaseUrl,
    controlPlaneBaseUrl: `${gatewayBaseUrl}/admin/v1`,
  };
}

function normalizeGatewayLogAccessConfig(accessConfig: unknown): Record<string, unknown> {
  const gateway = normalizeGatewayBaseUrl(
    stringField(accessConfig, 'gatewayBaseUrl') ?? stringField(accessConfig, 'controlPlaneBaseUrl'),
  );
  // 被动观测被测对象的「网关身份」：调用方 Key / 源 IP 钉死进对象，评估即按此身份拉日志。
  const clientId = stringField(accessConfig, 'clientId');
  const sourceIp = stringField(accessConfig, 'sourceIp');
  return {
    ...gateway,
    tenantId: stringField(accessConfig, 'tenantId') ?? 'tenant_default',
    ...(clientId ? { clientId } : {}),
    ...(sourceIp ? { sourceIp } : {}),
  };
}

function normalizeBoundAccessConfig(accessConfig: unknown): unknown {
  if (!isRecord(accessConfig)) return accessConfig;
  const gatewayRaw =
    stringField(accessConfig, 'gatewayBaseUrl') ?? stringField(accessConfig, 'controlPlaneBaseUrl');
  if (!gatewayRaw) return accessConfig; // 未填网关地址 = 不绑定，原样返回
  assertPlatformGatewayBinding();
  const gateway = normalizeGatewayBaseUrl(gatewayRaw);
  return {
    ...accessConfig,
    gatewayBaseUrl: gateway.gatewayBaseUrl,
    controlPlaneBaseUrl: gateway.controlPlaneBaseUrl,
    tenantId: stringField(accessConfig, 'tenantId') ?? 'tenant_default',
  };
}

function normalizeMcpAccessConfig(accessConfig: unknown): unknown {
  const serverID = stringField(accessConfig, 'serverID') ?? stringField(accessConfig, 'serverId');
  const gatewayRaw =
    stringField(accessConfig, 'gatewayBaseUrl') ?? stringField(accessConfig, 'controlPlaneBaseUrl');
  // 未配置任何网关闭环参数 → 传统 schemaUrl-only 接入，原样返回（由 resolveTargetBaseUrl 校验 schemaUrl）。
  if (!serverID && !gatewayRaw) return accessConfig;
  // 配了网关闭环参数 → 走 MCP 测-堵-验闭环：serverID + 网关地址必须成对，
  // 否则攻击不经网关、关联头无处落、归因空转。
  if (!serverID) {
    throw badRequest('请配置已登记的网关 MCP 服务标识。', 'MCP_SERVER_ID_REQUIRED');
  }
  assertPlatformGatewayBinding();
  const gateway = normalizeGatewayBaseUrl(gatewayRaw);
  const base = isRecord(accessConfig) ? accessConfig : {};
  return {
    ...base,
    serverID,
    gatewayBaseUrl: gateway.gatewayBaseUrl,
    controlPlaneBaseUrl: gateway.controlPlaneBaseUrl,
    tenantId: stringField(accessConfig, 'tenantId') ?? 'tenant_default',
  };
}

function assertPlatformAppEnabled(targetType: string) {
  if (targetType === 'PLATFORM_APP' && process.env.LSE_PLATFORM_APP_ENABLED !== 'true') {
    throw forbidden('平台智能体功能未开启。', 'PLATFORM_APP_DISABLED');
  }
}

/** 平台共享内容（tenantId 为空，如平台裁判模型）各租户只读，只有平台管理员在平台租户里能改。 */
function assertWritableTarget(
  row: { tenantId: string | null },
  user: { isPlatformAdmin: boolean; tenantIsPlatform: boolean },
): void {
  if (row.tenantId === null && !(user.isPlatformAdmin && user.tenantIsPlatform)) {
    throw forbidden('平台内置内容只读', 'PLATFORM_TARGET_READONLY');
  }
}

/** 同一条规则的非抛出版本：用于「测试」这类只顺带记一下探测结果的写操作。 */
function canWriteTarget(row: { tenantId: string | null }, user: { isPlatformAdmin: boolean; tenantIsPlatform: boolean }): boolean {
  return row.tenantId !== null || (user.isPlatformAdmin && user.tenantIsPlatform);
}

/** 网关日志源与 AgentShield 终端来源依赖全平台共用的外部集成，只在平台租户创建。 */
function assertSharedIntegrationTargetType(targetType: TargetType): void {
  if (targetType !== 'GATEWAY_LOG' && targetType !== 'ENDPOINT_AGENT') return;
  const tenantId = currentTenantId();
  if (tenantId && tenantId !== PLATFORM_TENANT_ID) {
    throw forbidden('网关日志与终端来源只在平台租户开放', 'PLATFORM_TENANT_ONLY');
  }
}

/** 安全网关关联（取网关审计证据、回写网关）用的是全平台共用的网关与网关租户：这一期只给平台租户。 */
function assertPlatformGatewayBinding(): void {
  const tenantId = currentTenantId();
  if (tenantId && tenantId !== PLATFORM_TENANT_ID) {
    throw forbidden('安全网关关联目前只在平台租户开放', 'PLATFORM_TENANT_ONLY');
  }
}

function normalizeAccessConfig(targetType: TargetType, accessConfig: unknown): unknown {
  assertSharedIntegrationTargetType(targetType);
  if (targetType === 'PLATFORM_APP') return parsePlatformAppConfig(accessConfig);
  if (targetType === 'ENDPOINT_AGENT') {
    if (!endpointEvalEnabled()) throw notFound('终端智能体测评未启用');
    return endpointAccessConfigSchema.parse(accessConfig);
  }
  if (targetType === 'GATEWAY_LOG') return normalizeGatewayLogAccessConfig(accessConfig);
  if (targetType === 'MCP_OPENAPI') return normalizeMcpAccessConfig(accessConfig);
  // 被测对象（MODEL/AGENT_API）均可选绑定网关证据源：填了网关地址就派生 controlPlaneBaseUrl。
  if (targetType === 'MODEL' || targetType === 'AGENT' || targetType === 'AGENT_API')
    return normalizeBoundAccessConfig(accessConfig);
  return accessConfig;
}

function resolveTargetBaseUrl(
  targetType: TargetType,
  baseUrl: string | undefined,
  accessConfig: unknown,
): string {
  if (targetType === 'PLATFORM_APP') {
    return requireUrl(stringField(accessConfig, 'baseUrl'), '请填写平台基地址。', 'TARGET_BASE_URL_REQUIRED');
  }
  if (targetType === 'ENDPOINT_AGENT') return endpointAccessConfigSchema.parse(accessConfig).agentshieldBaseUrl;
  if (targetType === 'MODEL') {
    return requireUrl(baseUrl, '请填写模型接口地址。', 'TARGET_BASE_URL_REQUIRED');
  }
  if (targetType === 'JUDGE') {
    return requireUrl(baseUrl, '请填写判定模型接口地址。', 'TARGET_BASE_URL_REQUIRED');
  }
  if (targetType === 'AGENT_API') {
    return requireUrl(baseUrl, '请填写智能体应用接口地址。', 'TARGET_BASE_URL_REQUIRED');
  }
  if (targetType === 'MCP_OPENAPI') {
    // 攻击面即网关 MCP 数据面：baseUrl = {gatewayBaseUrl}/mcp/{serverID}（accessConfig 已归一化）。
    const gatewayBaseUrl = stringField(accessConfig, 'gatewayBaseUrl');
    const serverID = stringField(accessConfig, 'serverID') ?? stringField(accessConfig, 'serverId');
    if (gatewayBaseUrl && serverID) {
      return `${gatewayBaseUrl.replace(/\/+$/, '')}/mcp/${serverID}`;
    }
    return requireUrl(
      stringField(accessConfig, 'schemaUrl'),
      '请配置网关地址和 MCP 服务标识，或填写接口描述地址。',
      'MCP_SCHEMA_URL_REQUIRED',
    );
  }
  if (targetType === 'PUBLIC_AGENT') {
    return requireUrl(
      stringField(accessConfig, 'entryUrl') ?? baseUrl,
      '公网 Agent 对象需要配置入口 URL',
      'PUBLIC_AGENT_ENTRY_REQUIRED',
    );
  }
  if (targetType === 'GATEWAY_LOG') {
    const controlPlaneBaseUrl = stringField(accessConfig, 'controlPlaneBaseUrl');
    if (!controlPlaneBaseUrl) {
      throw badRequest('智能体安全网关日志源需要配置网关地址或 IP', 'GATEWAY_BASE_URL_REQUIRED');
    }
    return controlPlaneBaseUrl;
  }
  return requireUrl(baseUrl, '评估对象接入地址不能为空', 'TARGET_BASE_URL_REQUIRED');
}

function defaultModelFor(targetType: TargetType): string {
  switch (targetType) {
    case 'PLATFORM_APP':
      return 'platform-app';
    case 'ENDPOINT_AGENT':
      return 'endpoint-agent';
    case 'AGENT_API':
      return 'agent-api';
    case 'PUBLIC_AGENT':
      return 'public-agent';
    case 'MCP_OPENAPI':
      return 'mcp-openapi';
    case 'GATEWAY_LOG':
      return 'gateway-log-source';
    case 'MODEL':
    default:
      return '';
  }
}

function normalizeCreateBody(body: z.infer<typeof createSchema>) {
  const targetType = body.targetType;
  assertPlatformAppEnabled(targetType);
  const model = body.model?.trim() || defaultModelFor(targetType);
  const apiKey = body.apiKey ?? '';
  const accessConfig = normalizeAccessConfig(targetType, body.accessConfig);
  const baseUrl = resolveTargetBaseUrl(targetType, body.baseUrl, accessConfig);
  validateTargetConfig(targetType, apiKey, model);
  if (targetType === 'AGENT') {
    const agent = parseAgentConfig(body.agentConfig);
    assertAgentGateway(baseUrl);
    bindAgentIdentity({ baseUrl, apiKey, model, extraHeaders: body.extraHeaders }, agent);
  }
  return { ...body, accessConfig, baseUrl, targetType, apiKey, model };
}

function validateTargetConfig(
  targetType: TargetType,
  apiKey: string | undefined,
  model: string | undefined,
): void {
  if (targetType === 'PLATFORM_APP' && !apiKey?.trim()) {
    throw badRequest('请填写平台应用密钥。', 'PLATFORM_API_KEY_REQUIRED');
  }
  if (targetType === 'ENDPOINT_AGENT') {
    if (apiKey?.trim()) throw badRequest('终端连接器密钥只能配置在服务端环境变量中');
    return;
  }
  if (targetType === 'MODEL' || targetType === 'AGENT') {
    if (!apiKey?.trim()) throw badRequest('请填写评估对象的访问密钥。', 'MODEL_API_KEY_REQUIRED');
    if (!model?.trim()) throw badRequest('请填写评估对象的模型标识。', 'MODEL_NAME_REQUIRED');
    return;
  }
  if (targetType === 'JUDGE') {
    // 全局评审模型与被测模型同等接入：必须填 API Key 与 Model（用于独立的 LLM 复核）。
    if (!apiKey?.trim()) throw badRequest('请填写判定模型的访问密钥。', 'JUDGE_API_KEY_REQUIRED');
    if (!model?.trim()) throw badRequest('请填写判定模型的模型标识。', 'JUDGE_MODEL_REQUIRED');
    return;
  }
  if (targetType === 'AGENT_API' && !model?.trim()) {
    throw badRequest('请填写智能体应用标识。', 'AGENT_MODEL_REQUIRED');
  }
  if (targetType === 'GATEWAY_LOG') return;
}

function summarizeResult(r: LlmCallResult) {
  return {
    status: r.status,
    latencyMs: r.latencyMs,
    httpStatus: r.httpStatus,
    model: r.model,
    sample: r.content.slice(0, 200),
    usage: r.usage,
    error: r.error,
  };
}

export async function modelTargetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/capabilities', { preHandler: [requirePermission('model_target:read')] }, async () => ({
    platformAppEnabled: process.env.LSE_PLATFORM_APP_ENABLED === 'true',
  }));

  // 列表：全局可见（不按创建人过滤），关键字匹配 名称/厂商/模型
  app.get('/', { preHandler: [requirePermission('model_target:read')] }, async (request) => {
    const q = listQuery.parse(request.query);
    const filters: Prisma.ModelTargetWhereInput[] = [];
    filters.push(connectorOwnerWhere(request.currentUser!));
    if (!q.includeSystem) filters.push({ targetType: { not: 'JUDGE' } });
    if (q.untested)
      filters.push({
        isActive: true,
        lastTestStatus: null,
        targetType: { in: ['MODEL', 'AGENT_API', 'PLATFORM_APP'] },
      });
    if (q.keyword) {
      filters.push({
        OR: [
          { name: { contains: q.keyword, mode: 'insensitive' } },
          { provider: { contains: q.keyword, mode: 'insensitive' } },
          { model: { contains: q.keyword, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.ModelTargetWhereInput = filters.length > 0 ? { AND: filters } : {};
    applyTenantFilter(request, where as Record<string, unknown>);
    const [rows, total] = await Promise.all([
      prisma.modelTarget.findMany({
        where,
        include: targetInclude,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.modelTarget.count({ where }),
    ]);
    // 终端类对象：绑定的终端在来源那边还在不在。只在请求明确要时才算（结果有 60 秒缓存，失败不影响列表）。
    const endpointStates = q.withEndpointState
      ? await resolveEndpointStates(rows, request.currentUser!, request.log)
      : new Map<string, EndpointState>();
    const body: Paginated<ReturnType<typeof serializeTarget> & { endpointState?: EndpointState }> = {
      items: rows.map((row) => {
        const endpointState = endpointStates.get(row.id);
        return endpointState ? { ...serializeTarget(row), endpointState } : serializeTarget(row);
      }),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
    return body;
  });

  app.get('/:id', { preHandler: [requirePermission('model_target:read')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const t = await prisma.modelTarget.findUnique({ where: { id }, include: targetInclude });
    if (!t) throw notFound('评估对象不存在');
    return serializeTarget(t);
  });

  app.post(
    '/',
    { preHandler: [requirePermission('model_target:create'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = normalizeCreateBody(createSchema.parse(request.body));
      assertRagEligible(body.targetType, body.isRag ?? false);
      // 平台管理员在平台租户里建的裁判模型是平台共享的（各租户默认使用），其余都属于当前租户。
      const me = request.currentUser!;
      const ownerTenantId =
        body.targetType === 'JUDGE' && me.isPlatformAdmin && me.tenantIsPlatform ? null : me.tenantId;
      if (await prisma.modelTarget.findFirst({ where: { name: body.name, tenantId: ownerTenantId } })) {
        throw conflict('评估对象名称已存在');
      }
      const created = await prisma.modelTarget.create({
        data: {
          tenantId: ownerTenantId,
          name: body.name,
          targetType: body.targetType,
          provider: body.provider,
          baseUrl: body.baseUrl,
          apiKey: body.targetType === 'PLATFORM_APP' ? encryptCredential(body.apiKey) : body.apiKey,
          model: body.model,
          extraHeaders: jsonInput(body.extraHeaders),
          defaultParams: jsonInput(body.defaultParams),
          accessConfig: jsonInput(body.accessConfig),
          agentConfig: jsonInput(body.agentConfig),
          isActive: body.isActive ?? true,
          isGlobal: body.isGlobal ?? true,
          isRag: body.isRag ?? false,
          ragOptions: jsonInput(body.ragOptions),
          ragRestrictedUploadSecret: secretInput(body.ragRestrictedUploadSecret) ?? null,
          supportsVision: body.supportsVision ?? false,
          createdById: request.currentUser!.id,
        },
        include: targetInclude,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'model_target.create',
        targetType: 'model_target',
        targetId: created.id,
        detail: {
          name: created.name,
          targetType: created.targetType,
          provider: created.provider,
          model: created.model,
        },
      });
      reply.code(201);
      return serializeTarget(created);
    },
  );

  app.patch(
    '/:id',
    { preHandler: [requirePermission('model_target:update'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = updateSchema.parse(request.body);
      const existing = await prisma.modelTarget.findUnique({ where: { id } });
      if (existing) assertWritableTarget(existing, request.currentUser!);
      if (!existing) throw notFound('评估对象不存在');
      if (body.name && body.name !== existing.name) {
        if (
          await prisma.modelTarget.findFirst({
            where: { name: body.name, tenantId: existing.tenantId, id: { not: existing.id } },
          })
        ) {
          throw conflict('评估对象名称已存在');
        }
      }
      const nextTargetType = body.targetType ?? existing.targetType;
      assertPlatformAppEnabled(nextTargetType);
      const nextApiKey = body.apiKey ?? targetApiKey(existing.targetType, existing.apiKey);
      const nextModel = body.model ?? existing.model;
      const nextAccessConfig =
        body.accessConfig === undefined
          ? existing.accessConfig
          : restoreRedactedHeaders(body.accessConfig, existing.accessConfig);
      const normalizedAccessConfig = normalizeAccessConfig(nextTargetType, nextAccessConfig);
      const nextBaseUrl = resolveTargetBaseUrl(
        nextTargetType,
        body.baseUrl ?? existing.baseUrl,
        normalizedAccessConfig,
      );
      validateTargetConfig(nextTargetType, nextApiKey, nextModel);
      if (nextTargetType === 'AGENT') {
        const agent = parseAgentConfig(body.agentConfig === undefined ? existing.agentConfig : body.agentConfig);
        bindAgentIdentity({ baseUrl: nextBaseUrl, apiKey: nextApiKey, model: nextModel,
          extraHeaders: (body.extraHeaders === undefined ? existing.extraHeaders : body.extraHeaders) as Record<string, string> | null }, agent);
      }
      if (body.isRag !== undefined || body.targetType !== undefined) {
        assertRagEligible(nextTargetType, body.isRag ?? existing.isRag);
      }

      const data: Prisma.ModelTargetUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.targetType !== undefined) data.targetType = body.targetType;
      if (body.provider !== undefined) data.provider = body.provider;
      if (
        body.targetType !== undefined ||
        body.baseUrl !== undefined ||
        body.accessConfig !== undefined
      ) {
        data.baseUrl = nextBaseUrl;
      }
      if (body.apiKey !== undefined || nextTargetType !== existing.targetType) {
        data.apiKey = nextTargetType === 'PLATFORM_APP' ? encryptCredential(nextApiKey) : nextApiKey;
      }
      if (body.model !== undefined) data.model = body.model;
      if (body.extraHeaders !== undefined) data.extraHeaders = jsonInput(body.extraHeaders);
      if (body.defaultParams !== undefined) data.defaultParams = jsonInput(body.defaultParams);
      if (body.agentConfig !== undefined) data.agentConfig = jsonInput(body.agentConfig);
      if (body.accessConfig !== undefined || body.targetType !== undefined) {
        data.accessConfig = jsonInput(normalizedAccessConfig);
      }
      if (body.isActive !== undefined) data.isActive = body.isActive;
      if (body.isGlobal !== undefined) data.isGlobal = body.isGlobal;
      if (body.isRag !== undefined) data.isRag = body.isRag;
      if (body.ragOptions !== undefined) {
        data.ragOptions = jsonInput(mergeRagOptions(existing.ragOptions, body.ragOptions));
      }
      const nextSecret = secretInput(body.ragRestrictedUploadSecret);
      if (nextSecret !== undefined) data.ragRestrictedUploadSecret = nextSecret;
      if (body.supportsVision !== undefined) data.supportsVision = body.supportsVision;

      // A saved probe describes the connection it tested, not every later revision.
      // Prisma's DbNull write marker must compare as the stored JSON null value.
      const connectionFields = [
        'targetType',
        'provider',
        'baseUrl',
        'apiKey',
        'model',
        'extraHeaders',
        'defaultParams',
        'accessConfig',
      ] as const;
      if (
        connectionFields.some((field) => {
          const value = data[field];
          return (
            value !== undefined &&
            !isDeepStrictEqual(value === Prisma.DbNull ? null : value, existing[field])
          );
        })
      ) {
        data.lastTestStatus = null;
        data.lastTestedAt = null;
      }

      const updated = await prisma.modelTarget.update({
        where: { id, ...(isPlatformConnector(request.currentUser!)
          ? { createdById: request.currentUser!.id, targetType: 'AGENT' as const, updatedAt: existing.updatedAt } : {}) },
        data,
        include: targetInclude,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'model_target.update',
        targetType: 'model_target',
        targetId: id,
        ...(() => {
          const detail: Record<string, unknown> = {};
          if (isPlatformConnector(request.currentUser!)) {
            const agent = parseAgentConfig(body.agentConfig ?? existing.agentConfig);
            detail.updatedFields = Object.keys(body);
            detail.agentInstanceId = agent.agentInstanceId;
            detail.gatewayCredentialId = agent.gatewayCredentialId;
            if (body.apiKey !== undefined) detail.apiKey = 'set';
          }
          if (body.supportsVision !== undefined && body.supportsVision !== existing.supportsVision) {
            detail.supportsVision = body.supportsVision;
          }
          if (body.isRag !== undefined && body.isRag !== existing.isRag) detail.isRag = body.isRag;
          if (body.ragOptions !== undefined) detail.ragOptionsChanged = true;
          // 仅记录“已设置/已清除”，不记录凭据本身。
          if (nextSecret !== undefined) detail.ragRestrictedUploadSecret = nextSecret ? 'set' : 'cleared';
          return Object.keys(detail).length > 0 ? { detail } : {};
        })(),
      });
      return serializeTarget(updated);
    },
  );

  app.delete(
    '/:id',
    { preHandler: [requirePermission('model_target:delete')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { withTasks } = deleteQuery.parse(request.query);
      // 连同任务一起删等于批量删任务：还要有评估任务的删除权限。
      if (withTasks && !request.currentUser!.permissions.has('eval_task:delete')) {
        throw permissionDenied(['eval_task:delete']);
      }
      const deletion = await prisma.$transaction(async (tx) => {
        const target = await tx.modelTarget.findUnique({
          where: { id },
          include: {
            _count: { select: { evalTasks: true, evalResults: true, evalPlans: true, ragEvalRuns: true } },
          },
        });
        if (!target) throw notFound('评估对象不存在');
        assertWritableTarget(target, request.currentUser!);
        if (!withTasks && (target._count.evalTasks > 0 || target._count.evalResults > 0)) {
          const refs = [
            target._count.evalTasks > 0 ? `${target._count.evalTasks} 个评估任务` : '',
            target._count.evalResults > 0 ? `${target._count.evalResults} 条评估结果` : '',
          ].filter(Boolean);
          throw badRequest(
            `该评估对象仍被 ${refs.join('、')}引用，请先删除这些评估任务，再删除对象。`,
            'MODEL_TARGET_IN_USE',
          );
        }
        // 评估计划、RAG 评估挂在 Restrict 外键上，这里不级联：说清楚被什么挡住。
        const otherRefs = [
          target._count.evalPlans > 0 ? `${target._count.evalPlans} 个评估计划` : '',
          target._count.ragEvalRuns > 0 ? `${target._count.ragEvalRuns} 次 RAG 评估` : '',
        ].filter(Boolean);
        if (otherRefs.length > 0) {
          throw badRequest(
            `该评估对象仍被 ${otherRefs.join('、')}引用，请先删除它们，再删除对象。`,
            'MODEL_TARGET_IN_USE',
          );
        }
        let deletedTasks: DeletableTask[] = [];
        if (withTasks) {
          deletedTasks = await tx.evalTask.findMany({
            where: { modelTargetId: id },
            select: taskDeleteSelect,
            orderBy: { createdAt: 'asc' },
          });
          // 引用数不按租户过滤；对不上说明还有当前账号看不到的任务。
          const hidden = target._count.evalTasks - deletedTasks.length;
          if (hidden > 0) {
            throw badRequest(
              `该评估对象还被 ${hidden} 个不属于当前租户的评估任务引用，无法删除。`,
              'MODEL_TARGET_IN_USE',
            );
          }
          // 任一任务不能删就整体拒绝，一个都不动。
          const running = deletedTasks.filter((task) => taskDeleteBlocker(task)?.code === 'EVAL_TASK_RUNNING');
          if (running.length > 0) {
            throw badRequest(
              `名下有 ${running.length} 个评估任务正在运行：${taskNames(running)}。请等它们结束或先取消，再删除。`,
              'EVAL_TASK_RUNNING',
            );
          }
          const readOnly = deletedTasks.filter((task) => taskDeleteBlocker(task)?.code === 'AIG_HISTORY_READ_ONLY');
          if (readOnly.length > 0) {
            throw badRequest(
              `名下有 ${readOnly.length} 个历史 AIG 任务仅供查看、不支持删除：${taskNames(readOnly)}。该对象无法连同任务一起删除。`,
              'AIG_HISTORY_READ_ONLY',
            );
          }
          for (const task of deletedTasks) await deleteTaskRecords(tx, task);
          const leftover = await tx.evalResult.count({ where: { modelTargetId: id } });
          if (leftover > 0) {
            throw badRequest(
              `该评估对象仍被其他任务的 ${leftover} 条评估结果引用，无法删除。`,
              'MODEL_TARGET_IN_USE',
            );
          }
        }
        const referenceFields: Record<string, string[]> = {
          [RED_TEAM_SETTING_KEY]: [
            'gatewayTargetId',
            'attackerTargetId',
            'secondaryAttackerTargetId',
            'judgeTargetId',
          ],
          [AGENT_EVAL_SETTING_KEY]: ['attackerTargetId', 'judgeTargetId'],
        };
        const settings = await tx.systemSetting.findMany({
          where: { key: { in: Object.keys(referenceFields) } },
        });
        const clearedReferences: Array<{ settingKey: string; fields: string[] }> = [];
        for (const setting of settings) {
          if (!isRecord(setting.value)) continue;
          const value = { ...setting.value };
          const matchingFields = (referenceFields[setting.key] ?? []).filter(
            (field) => value[field] === id,
          );
          if (matchingFields.length === 0) continue;
          for (const field of matchingFields) value[field] = '';
          const updated = await tx.systemSetting.updateMany({
            // Do not overwrite concurrent edits to other policy parameters.
            where: { key: setting.key, value: { equals: setting.value as Prisma.InputJsonValue } },
            data: { value: value as Prisma.InputJsonValue, updatedById: request.currentUser!.id },
          });
          if (updated.count !== 1) {
            throw conflict('对抗评估配置已更新，请刷新后重试删除。');
          }
          clearedReferences.push({ settingKey: setting.key, fields: matchingFields });
        }
        await tx.modelTarget.delete({ where: { id } });
        return { target, clearedReferences, deletedTasks };
      }, withTasks ? { timeout: WITH_TASKS_TX_TIMEOUT_MS } : undefined);
      // 事务已提交，对象和任务已经删了：图片集清理失败只记日志，不能挡住下面的审计。
      for (const task of deletion.deletedTasks) {
        try {
          await purgeTaskByoSets(task, request.currentUser!);
        } catch (error) {
          request.log.error({ err: error, taskId: task.id, modelTargetId: id }, '连同评估对象删除任务后，清理自带图片集失败');
        }
      }
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'model_target.delete',
        targetType: 'model_target',
        targetId: id,
        detail: {
          name: deletion.target.name,
          clearedReferences: deletion.clearedReferences,
          ...(withTasks
            ? {
                deletedTasks: {
                  count: deletion.deletedTasks.length,
                  names: deletion.deletedTasks.map((task) => task.name),
                },
              }
            : {}),
        },
      });
      return { ok: true };
    },
  );

  // 连接测试：已保存对象
  app.post(
    '/:id/test',
    { preHandler: [requirePermission('model_target:test'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = testExistingSchema.parse(request.body ?? {});
      const t = await prisma.modelTarget.findUnique({ where: { id } });
      if (!t) throw notFound('评估对象不存在');
      const result = await runTargetConnectionTest(t, body.prompt);
      // 平台共享对象的探测结果不落库：避免租户改了平台内置对象的全局状态。
      if (canWriteTarget(t, request.currentUser!)) {
        await prisma.modelTarget.update({
          where: { id },
          data: { lastTestedAt: new Date(), lastTestStatus: result.status },
        });
      }
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'model_target.test',
        targetType: 'model_target',
        targetId: id,
        detail: { status: result.status, latencyMs: result.latencyMs, error: result.error },
      });
      return summarizeResult(result);
    },
  );

  // 连接测试：测被测对象绑定的网关证据源是否连通（带内部 token 探 /eval-integration/health）
  app.post(
    '/:id/test-gateway',
    { preHandler: [requirePermission('model_target:test'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const t = await prisma.modelTarget.findUnique({ where: { id } });
      if (!t) throw notFound('评估对象不存在');
      const cfg = isRecord(t.accessConfig) ? t.accessConfig : {};
      const controlPlaneBaseUrl =
        typeof cfg.controlPlaneBaseUrl === 'string' ? cfg.controlPlaneBaseUrl.trim() : '';
      if (!controlPlaneBaseUrl) {
        return { ok: false, message: '该评估对象未配置网关证据源' };
      }
      try {
        assertControlPlaneAllowed(controlPlaneBaseUrl);
        const tenantId =
          (typeof cfg.tenantId === 'string' && cfg.tenantId.trim()) || 'tenant_default';
        const internalToken = resolveInternalToken();
        const health = await fetchGatewayHealth({ controlPlaneBaseUrl, tenantId, internalToken });
        if (!health.ok) {
          return {
            ok: false,
            message: health.error ?? '连接失败',
            latencyMs: health.latencyMs,
            httpStatus: health.httpStatus,
          };
        }
        // 互证：让网关用它配置的 LSE 地址回连本平台并回显 nonce，证明双向真实可达且指向本实例。
        const nonce = randomBytes(16).toString('hex');
        const verify = await fetchGatewayVerifyReciprocal({
          controlPlaneBaseUrl,
          tenantId,
          internalToken,
          nonce,
        });
        if (!verify.ok) {
          return {
            ok: false,
            message: verify.error ?? '双向校验失败',
            latencyMs: verify.latencyMs,
            httpStatus: verify.httpStatus,
          };
        }
        if (!verify.reciprocal || verify.nonceEchoed !== nonce) {
          return {
            ok: false,
            message: verify.reciprocal
              ? '网关回连到的并非当前平台实例，请核对网关侧地址'
              : gatewayReciprocityMessage(verify.reason),
            latencyMs: verify.latencyMs,
            httpStatus: verify.httpStatus,
          };
        }
        return {
          ok: true,
          message: '双方互通已验证',
          latencyMs: verify.latencyMs,
          httpStatus: verify.httpStatus,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : '测试失败' };
      }
    },
  );

  // 连接测试：未保存的临时配置（保存前先测）
  app.post(
    '/test',
    { preHandler: [requirePermission('model_target:test'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const body = testConfigSchema.parse(request.body);
      const cfg: LlmTargetConfig = {
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        model: body.model,
        extraHeaders: body.extraHeaders ?? null,
        defaultParams: body.defaultParams ?? null,
        egressContext: resolveServerTargetEgressContext(),
      };
      const result = await runConnectionTest(cfg, body.prompt);
      return summarizeResult(result);
    },
  );

  // 接入诊断：未保存/编辑中的配置。实际发起一次请求并逐项给出通过/警告/失败与中文建议。
  app.post(
    '/diagnose',
    { preHandler: [requirePermission('model_target:test'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const body = diagnoseConfigSchema.parse(request.body);
      assertPlatformAppEnabled(body.targetType);
      if (body.targetType === 'PLATFORM_APP') {
        const config = parsePlatformAppConfig(body.accessConfig);
        if (config.baseUrl !== body.baseUrl) {
          throw badRequest('平台配置基地址与诊断地址不一致。', 'PLATFORM_BASE_URL_MISMATCH');
        }
      }
      if (!DIAGNOSABLE_TYPES.has(body.targetType)) {
        throw badRequest('该对象类型不主动调用接口，无需接入诊断。', 'DIAGNOSE_UNSUPPORTED_TYPE');
      }
      let apiKey = body.apiKey?.trim() ?? '';
      let extraHeaders: unknown = body.extraHeaders ?? null;
      let accessConfig: Record<string, unknown> | null = body.accessConfig ?? null;
      if (body.targetId) {
        const saved = await prisma.modelTarget.findUnique({ where: { id: body.targetId } });
        if (!saved) throw notFound('评估对象不存在');
        // 仅当接口地址未改动时沿用已保存密钥，避免把已保存凭据发往新地址。
        if (!apiKey && saved.baseUrl === body.baseUrl) apiKey = targetApiKey(saved.targetType, saved.apiKey);
        if (body.extraHeaders === undefined) extraHeaders = saved.extraHeaders;
        // 前端只拿到脱敏请求头：接口地址未改动时还原为已保存原值。
        if (saved.baseUrl === body.baseUrl) {
          accessConfig = restoreRedactedHeaders(accessConfig, saved.accessConfig) as Record<
            string,
            unknown
          > | null;
        }
      }
      const report = await runDiagnosis({
        targetType: body.targetType,
        baseUrl: body.baseUrl,
        apiKey,
        model: body.model?.trim() || defaultModelFor(body.targetType),
        extraHeaders,
        defaultParams: body.defaultParams ?? null,
        accessConfig,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'model_target.diagnose',
        targetType: 'model_target',
        targetId: body.targetId ?? null,
        detail: {
          targetType: body.targetType,
          ok: report.ok,
          httpStatus: report.httpStatus,
          checks: report.checks.map((c) => `${c.key}:${c.status}`),
        },
      });
      return report;
    },
  );

  // 接入诊断：已保存对象（列表“接口诊断”）
  app.post(
    '/:id/diagnose',
    { preHandler: [requirePermission('model_target:test'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const t = await prisma.modelTarget.findUnique({ where: { id } });
      if (!t) throw notFound('评估对象不存在');
      assertPlatformAppEnabled(t.targetType);
      if (!DIAGNOSABLE_TYPES.has(t.targetType)) {
        throw badRequest('该对象类型不主动调用接口，无需接入诊断。', 'DIAGNOSE_UNSUPPORTED_TYPE');
      }
      const report = await runDiagnosis({ ...t, apiKey: targetApiKey(t.targetType, t.apiKey) });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'model_target.diagnose',
        targetType: 'model_target',
        targetId: id,
        detail: {
          ok: report.ok,
          httpStatus: report.httpStatus,
          checks: report.checks.map((c) => `${c.key}:${c.status}`),
        },
      });
      return report;
    },
  );

  // 批量连通性测试：后端并发 4，逐个写回“最近测试”。
  app.post(
    '/batch-test',
    { preHandler: [requirePermission('model_target:test'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { ids } = batchTestSchema.parse(request.body);
      const unique = [...new Set(ids)];
      const rows = await prisma.modelTarget.findMany({ where: { id: { in: unique } } });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const results = await mapWithConcurrency(unique, BATCH_TEST_CONCURRENCY, async (id) => {
        const t = byId.get(id);
        if (!t) {
          return {
            id,
            name: null,
            status: 'SKIPPED',
            latencyMs: null,
            httpStatus: null,
            error: '评估对象不存在',
          };
        }
        if (!['MODEL', 'AGENT_API', 'PUBLIC_AGENT', 'PLATFORM_APP'].includes(t.targetType)) {
          return {
            id,
            name: t.name,
            status: 'SKIPPED',
            latencyMs: null,
            httpStatus: null,
            error: '该对象类型不主动调用接口，已跳过',
          };
        }
        const r = await runTargetConnectionTest(t);
        const testedAt = new Date();
        // 平台共享对象不写探测结果（同上）。
        if (canWriteTarget(t, request.currentUser!)) {
          await prisma.modelTarget.update({
            where: { id },
            data: { lastTestedAt: testedAt, lastTestStatus: r.status },
          });
        }
        return {
          id,
          name: t.name,
          status: r.status,
          latencyMs: r.latencyMs,
          httpStatus: r.httpStatus,
          error: r.error,
          testedAt,
        };
      });
      const summary = {
        total: results.length,
        success: results.filter((r) => r.status === 'SUCCESS').length,
        failed: results.filter((r) => r.status === 'ERROR').length,
        skipped: results.filter((r) => r.status === 'SKIPPED').length,
      };
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'model_target.batch_test',
        targetType: 'model_target',
        detail: { ...summary, ids: unique },
      });
      return { summary, concurrency: BATCH_TEST_CONCURRENCY, results };
    },
  );
}
