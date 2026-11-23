import type {
  GatewayAssuranceContract,
  GatewayAssuranceCoverage,
  GatewayAssuranceEvidence,
  GatewayAssuranceEvidenceChecks,
  GatewayAssuranceLinkContract,
  GatewayAssurancePolicyContract,
  GatewayAssuranceSampleVariant,
  McpToolDecision,
} from './types.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface BaseGatewayOptions {
  controlPlaneBaseUrl: string;
  internalToken: string;
  tenantId: string;
  fetchFn?: FetchLike;
}

export interface FetchGatewayAssuranceEvidenceOptions extends BaseGatewayOptions {
  traceId?: string;
  evalRunId?: string;
  taskId?: string;
  sampleId?: string;
  requestId?: string;
}

function endpoint(baseUrl: string, path: string): URL {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return new URL(`${trimmed}/eval-integration${path}`);
}

function headers(options: BaseGatewayOptions): Record<string, string> {
  const token = options.internalToken.trim();
  const tenantId = options.tenantId.trim();
  if (!token) throw new Error('gateway internal token is required');
  if (!tenantId) throw new Error('gateway tenant id is required');
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-newapi-tenant-id': tenantId,
  };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('gateway assurance response is not valid JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, snake: string, camel = toCamelKey(snake)): string {
  if (!isRecord(value)) return '';
  const raw = value[snake] ?? value[camel];
  return typeof raw === 'string' ? raw : '';
}

function boolField(value: unknown, snake: string, camel = toCamelKey(snake)): boolean {
  if (!isRecord(value)) return false;
  return value[snake] === true || value[camel] === true;
}

function numberField(value: unknown, snake: string, camel = toCamelKey(snake)): number {
  if (!isRecord(value)) return 0;
  const raw = value[snake] ?? value[camel];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function normalizePolicy(value: unknown): GatewayAssurancePolicyContract | null {
  if (!isRecord(value)) return null;
  const policyId = stringField(value, 'policy_id');
  if (!policyId) return null;
  const rawVariants = value.sample_variants ?? value.sampleVariants;
  return {
    policyId,
    version: stringField(value, 'version'),
    category: stringField(value, 'category'),
    mode: stringField(value, 'mode'),
    expectedDecision: stringField(value, 'expected_decision'),
    severity: stringField(value, 'severity'),
    detector: stringField(value, 'detector'),
    evidenceRequired: boolField(value, 'evidence_required'),
    sampleGenerationHint: stringField(value, 'sample_generation_hint'),
    negativeContext: stringArray(value.negative_context ?? value.negativeContext),
    sampleVariants: Array.isArray(rawVariants)
      ? rawVariants.flatMap((item: unknown) => {
          const variant = normalizeSampleVariant(item);
          return variant === null ? [] : [variant];
        })
      : undefined,
  };
}

function normalizeSampleVariant(value: unknown): GatewayAssuranceSampleVariant | null {
  if (!isRecord(value)) return null;
  const variantId = stringField(value, 'variant_id');
  if (!variantId) return null;
  return {
    variantId,
    label: stringField(value, 'label') || variantId,
    strategy: stringField(value, 'strategy') || variantId,
    weight: numberField(value, 'weight') || 1,
    turnCount: numberField(value, 'turn_count') || undefined,
  };
}

function normalizeCoverage(value: unknown): GatewayAssuranceCoverage | undefined {
  if (!isRecord(value)) return undefined;
  return {
    policySource: stringField(value, 'policy_source'),
    coverageScope: stringField(value, 'coverage_scope'),
    policyCount: numberField(value, 'policy_count'),
    sampleVariantCount: numberField(value, 'sample_variant_count'),
    minimumVariantsEach: numberField(value, 'minimum_variants_each'),
  };
}

function normalizeLink(value: unknown): GatewayAssuranceLinkContract | null {
  if (!isRecord(value)) return null;
  const linkId = stringField(value, 'link_id');
  if (!linkId) return null;
  return { linkId, required: boolField(value, 'required') };
}

function normalizeChecks(value: unknown): GatewayAssuranceEvidenceChecks {
  return {
    requestLog: boolField(value, 'request_log'),
    contentLog: boolField(value, 'content_log'),
    securityEngine: boolField(value, 'security_engine'),
    policyDecision: boolField(value, 'policy_decision'),
    securityEvent: boolField(value, 'security_event'),
    alert: boolField(value, 'alert'),
    uiVisible: boolField(value, 'ui_visible'),
    deepLink: boolField(value, 'deep_link'),
    writeback: boolField(value, 'writeback'),
    outbox: boolField(value, 'outbox'),
    toolCall: boolField(value, 'tool_call'),
    toolDecision: boolField(value, 'tool_decision'),
  };
}

function normalizeMcpToolDecision(value: unknown): McpToolDecision | null {
  if (!isRecord(value)) return null;
  const toolName = stringField(value, 'tool_name');
  if (!toolName) return null;
  const rawRuleIds = value.rule_ids ?? value.ruleIds;
  const createdAt = stringField(value, 'created_at');
  const matchedPolicyId = stringField(value, 'matched_policy_id');
  const traceId = stringField(value, 'trace_id');
  return {
    toolName,
    toolType: stringField(value, 'tool_type') || 'mcp',
    rawDecision: stringField(value, 'raw_decision'),
    effectiveDecision: stringField(value, 'effective_decision'),
    mode: stringField(value, 'mode'),
    hardFloor: boolField(value, 'hard_floor'),
    riskLevel: stringField(value, 'risk_level'),
    status: stringField(value, 'status'),
    matchedPolicyId: matchedPolicyId || null,
    provenance: stringField(value, 'provenance'),
    ruleIds: stringArray(rawRuleIds),
    traceId: traceId || null,
    createdAt: createdAt || null,
  };
}

/**
 * 从证据的 events[] 里抽出所有 MCP 工具决策（Lane 2 每个 event 附 mcp_tool_decisions[]）。
 * 这是 MCP「验」段的权威数据：raw/effective 双决策 + hard_floor + rule_ids。
 */
export function extractMcpToolDecisions(evidence: GatewayAssuranceEvidence): McpToolDecision[] {
  const out: McpToolDecision[] = [];
  for (const event of evidence.events) {
    if (!isRecord(event)) continue;
    const decisions = event.mcp_tool_decisions ?? event.mcpToolDecisions;
    if (!Array.isArray(decisions)) continue;
    for (const item of decisions) {
      const normalized = normalizeMcpToolDecision(item);
      if (normalized !== null) out.push(normalized);
    }
  }
  return out;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[toCamelKey(key)] = item;
  }
  return out;
}

function appendParam(url: URL, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) url.searchParams.set(key, trimmed);
}

export async function fetchGatewayAssuranceContract(
  options: BaseGatewayOptions,
): Promise<GatewayAssuranceContract> {
  const fetchFn = options.fetchFn ?? fetch;
  const res = await fetchFn(endpoint(options.controlPlaneBaseUrl, '/assurance-contract'), {
    method: 'GET',
    headers: headers(options),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`gateway assurance contract query failed: HTTP ${res.status}`);
  if (!isRecord(body)) throw new Error('gateway assurance contract response is not an object');
  return {
    schemaVersion: stringField(body, 'schema_version'),
    tenantId: stringField(body, 'tenant_id'),
    generatedAt: stringField(body, 'generated_at') || undefined,
    coverage: normalizeCoverage(body.coverage),
    policies: Array.isArray(body.policies)
      ? body.policies.flatMap((item) => {
          const policy = normalizePolicy(item);
          return policy === null ? [] : [policy];
        })
      : [],
    linkContracts: Array.isArray(body.link_contracts)
      ? body.link_contracts.flatMap((item) => {
          const link = normalizeLink(item);
          return link === null ? [] : [link];
        })
      : [],
  };
}

export async function fetchGatewayAssuranceEvidence(
  options: FetchGatewayAssuranceEvidenceOptions,
): Promise<GatewayAssuranceEvidence> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = endpoint(options.controlPlaneBaseUrl, '/assurance-evidence');
  appendParam(url, 'trace_id', options.traceId);
  appendParam(url, 'eval_run_id', options.evalRunId);
  appendParam(url, 'task_id', options.taskId);
  appendParam(url, 'sample_id', options.sampleId);
  appendParam(url, 'request_id', options.requestId);
  const res = await fetchFn(url, { method: 'GET', headers: headers(options) });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`gateway assurance evidence query failed: HTTP ${res.status}`);
  if (!isRecord(body)) throw new Error('gateway assurance evidence response is not an object');
  return {
    schemaVersion: stringField(body, 'schema_version'),
    tenantId: stringField(body, 'tenant_id'),
    query: normalizeStringRecord(body.query),
    checks: normalizeChecks(body.checks),
    sources: normalizeStringRecord(body.sources),
    events: Array.isArray(body.events) ? body.events : [],
  };
}
