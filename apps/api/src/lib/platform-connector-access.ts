import type { CurrentUser } from './rbac.js';
import { forbidden, notFound } from './errors.js';
import { z } from 'zod';
import { parseAgentConfig, assertAgentExtraHeaders } from '../modules/agent-evals/agent-target.js';

export const CONNECTOR_RESTRICTED = 'platform_connector:restricted';
export const connectorOwnerWhere = (u: CurrentUser) => isPlatformConnector(u) ? { createdById: u.id } : {};
export const isPlatformConnector = (u: CurrentUser) => u.permissions.has(CONNECTOR_RESTRICTED) || u.roles?.includes('platform_connector');
type Owned = { createdById: string | null } | null;
type OwnedTarget = { createdById: string | null; targetType?: string; agentConfig?: unknown; apiKey?: string; extraHeaders?: unknown } | null;
export interface ConnectorAccessStore {
  evalTask: { findUnique(args: { where: { id: string }; select: { createdById: true } }): Promise<Owned> };
  modelTarget: { findUnique(args: { where: { id: string }; select: { createdById: true; targetType?: true; agentConfig?: true; apiKey?: true; extraHeaders?: true } }): Promise<OwnedTarget> };
  report: { findUnique(args: { where: { id: string }; select: { task: { select: { createdById: true } } } }): Promise<{ task: Owned } | null> };
  finding: { findUnique(args: { where: { id: string }; select: { task: { select: { createdById: true } } } }): Promise<{ task: Owned } | null> };
}
export interface ConnectorRequest {
  method: string; routeOptions: { url?: string }; params?: unknown; query?: unknown; body?: unknown;
}
const allowed = new Set([
  'GET /api/version',
  'GET /api/eval-tasks/:id/verdict',
  'GET /api/auth/me', 'POST /api/auth/logout',
  'GET /api/model-targets/capabilities',
  'GET /api/model-targets', 'POST /api/model-targets', 'GET /api/model-targets/:id',
  'PATCH /api/model-targets/:id',
  'POST /api/agent-evals/run', 'POST /api/agent-evals/preview',
  'POST /api/eval-tasks',
  'GET /api/eval-tasks', 'GET /api/eval-tasks/:id',
  'GET /api/eval-tasks/:id/results', 'GET /api/eval-tasks/:id/findings',
  'POST /api/eval-tasks/:id/retest-failed',
  'GET /api/reports', 'POST /api/reports', 'GET /api/reports/:id',
  'GET /api/remediation/:findingId', 'PATCH /api/remediation/:findingId',
  'PATCH /api/remediation/:findingId/review',
]);
const mutationPermissions = new Map([
  ['PATCH /api/model-targets/:id', 'model_target:update'],
  ['PATCH /api/remediation/:findingId/review', 'remediation:update'],
]);
const agentPatchSchema = z.object({ apiKey: z.string().trim().min(1).max(1000).optional(),
  agentConfig: z.record(z.unknown()).optional() }).strict();
const findingConfirmSchema = z.object({ status: z.literal('CONFIRMED'), reason: z.string().trim().min(1).max(4000) }).strict();
/** Additional server boundary: ordinary role checks still apply. Unknown APIs fail closed. */
export async function enforcePlatformConnectorAccess(
  user: CurrentUser, request: ConnectorRequest, store: ConnectorAccessStore,
): Promise<void> {
  if (!isPlatformConnector(user)) return;
  const route = request.routeOptions.url?.replace(/\/$/, '') ?? '';
  if (!allowed.has(request.method + ' ' + route)) {
    throw forbidden('Connector operation denied', 'CONNECTOR_OPERATION_DENIED');
  }
  const permission = mutationPermissions.get(request.method + ' ' + route);
  if (permission && !user.permissions.has(permission)) {
    throw forbidden('Connector mutation permission required', 'CONNECTOR_PERMISSION_REQUIRED');
  }
  if (operationIsTargetCreate(request.method, route)) {
    const type = (request.body as { targetType?: string } | undefined)?.targetType;
    if (!['AGENT', 'AGENT_API', 'PUBLIC_AGENT', 'MCP_OPENAPI', 'PLATFORM_APP'].includes(type ?? '')) {
      throw forbidden('Connector target type denied', 'CONNECTOR_TARGET_TYPE_DENIED');
    }
    if (type === 'AGENT') assertAgentExtraHeaders((request.body as { extraHeaders?: unknown }).extraHeaders);
  }
  const own = (record: Owned) => {
    if (!record || record.createdById !== user.id) {
      throw notFound('连接器资源不存在', 'CONNECTOR_RESOURCE_NOT_FOUND');
    }
  };
  const task = async (id: string) => own(await store.evalTask.findUnique({ where: { id }, select: { createdById: true } }));
  const target = async (id: string) => own(await store.modelTarget.findUnique({ where: { id }, select: { createdById: true } }));
  const finding = async (id: string) => {
    const row = await store.finding.findUnique({ where: { id }, select: { task: { select: { createdById: true } } } });
    own(row?.task ?? null);
  };
  const params = request.params as Record<string, unknown> | undefined;
  if (typeof params?.id === 'string') {
    if (route.startsWith('/api/eval-tasks/')) await task(params.id);
    if (route.startsWith('/api/model-targets/')) await target(params.id);
    if (route.startsWith('/api/reports/')) {
      const row = await store.report.findUnique({ where: { id: params.id }, select: { task: { select: { createdById: true } } } });
      own(row?.task ?? null);
    }
  }
  if (typeof params?.findingId === 'string') {
    await finding(params.findingId);
  }
  if (request.method === 'PATCH' && route === '/api/model-targets/:id') {
    const row = typeof params?.id === 'string' ? await store.modelTarget.findUnique({
      where: { id: params.id }, select: { createdById: true, targetType: true, agentConfig: true, apiKey: true, extraHeaders: true },
    }) : null;
    own(row);
    if (row?.targetType !== 'AGENT') throw forbidden('Connector target type denied', 'CONNECTOR_TARGET_TYPE_DENIED');
    assertAgentExtraHeaders(row.extraHeaders);
    const parsed = agentPatchSchema.safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0)
      throw forbidden('Connector mutation fields denied', 'CONNECTOR_MUTATION_FIELDS_DENIED');
    const body = parsed.data;
    const stored = parseAgentConfig(row.agentConfig);
    const snapshot = body.agentConfig;
    if (snapshot && !['agentInstanceId', 'gatewayCredentialId', 'systemPrompt', 'tools', 'mcp', 'skills']
      .every(key => Object.prototype.hasOwnProperty.call(snapshot, key)))
      throw forbidden('Connector mutation fields denied', 'CONNECTOR_MUTATION_FIELDS_DENIED');
    const next = snapshot ? parseAgentConfig(snapshot) : stored;
    if (next.agentInstanceId !== stored.agentInstanceId)
      throw forbidden('Connector agent identity immutable', 'CONNECTOR_AGENT_IDENTITY_IMMUTABLE');
    const keyChanged = body.apiKey !== undefined && body.apiKey !== row.apiKey;
    const bindingChanged = next.gatewayCredentialId !== stored.gatewayCredentialId;
    if (keyChanged !== bindingChanged || (keyChanged && !snapshot))
      throw forbidden('Connector credential binding update must be atomic', 'CONNECTOR_CREDENTIAL_BINDING_REQUIRED');
  }
  if (request.method === 'PATCH' && route === '/api/remediation/:findingId/review' &&
      !findingConfirmSchema.safeParse(request.body).success)
    throw forbidden('Connector mutation fields denied', 'CONNECTOR_MUTATION_FIELDS_DENIED');
  // Validate nested source/retest/review references before any side effect.
  const refs = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== 'object') return;
    for (const [key, ref] of Object.entries(value)) {
      if (typeof ref === 'string') {
        if (key === 'findingId') await finding(ref);
        if (['taskId', 'retestTaskId', 'baseTaskId'].includes(key)) await task(ref);
        if (['modelTargetId', 'explanationModelTargetId', 'gatewayTargetId', 'attackerTargetId'].includes(key)) await target(ref);
      } else if (ref && typeof ref === 'object') await refs(ref);
    }
  };
  await refs(request.query);
  await refs(request.body);
}

function operationIsTargetCreate(method: string, route: string) {
  return method === 'POST' && route === '/api/model-targets';
}
