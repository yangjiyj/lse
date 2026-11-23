import { z } from 'zod';
import { FLEET_LIVE_PRODUCTS, LIVE_RISK_TYPE_IDS } from '../../../../../packages/shared/src/fleet-live-eval.js';
import { RUNTIME_ARMS, RUNTIME_SUITES, RUNTIME_TEMPLATES, RUNTIME_TIERS, RUNTIME_VECTORS } from '../../../../../packages/shared/src/runtime-eval.js';

export const endpointProductSchema = z.enum(FLEET_LIVE_PRODUCTS);
export const liveRiskTypesSchema = z.array(z.enum(LIVE_RISK_TYPE_IDS)).min(1).max(LIVE_RISK_TYPE_IDS.length).refine((ids) => new Set(ids).size === ids.length, '风险类型不能重复');
const uniqueItems = (items: readonly unknown[]) => new Set(items).size === items.length;
/** 运行态测评（suite=runtime_v2）才有的请求字段；经典测评出现任一个都拒绝。 */
const RUNTIME_ONLY_FIELDS = ['tier', 'vectors', 'arms', 'repeat', 'templates', 'sampleIds'] as const;
/** 经典测评才有的请求字段；运行态测评出现任一个都拒绝。 */
const CLASSIC_ONLY_FIELDS = ['riskTypes', 'scenarioIds', 'mode'] as const;
export const fleetEvalJobRequestSchema = z.object({
  product: endpointProductSchema,
  riskTypes: liveRiskTypesSchema.optional(),
  mode: z.enum(['model', 'scripted']).optional(),
  scenarioIds: z.array(z.string().min(1).max(200)).min(1).max(12).refine((ids) => new Set(ids).size === ids.length, '场景不能重复').optional(),
  retestOfTaskId: z.string().uuid().optional(),
  reason: z.string().trim().max(500).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  suite: z.enum(RUNTIME_SUITES).optional(),
  tier: z.enum(RUNTIME_TIERS).optional(),
  vectors: z.array(z.enum(RUNTIME_VECTORS)).min(1).max(RUNTIME_VECTORS.length).refine(uniqueItems, '攻击类别不能重复').optional(),
  arms: z.array(z.enum(RUNTIME_ARMS)).min(1).max(RUNTIME_ARMS.length).refine(uniqueItems, '防护臂不能重复').optional(),
  repeat: z.number().int().min(1).max(5).optional(),
  templates: z.array(z.enum(RUNTIME_TEMPLATES)).min(1).max(RUNTIME_TEMPLATES.length).refine(uniqueItems, '项目模板不能重复').optional(),
  sampleIds: z.array(z.string().min(1).max(200)).min(1).max(240).refine(uniqueItems, '样本不能重复').optional(),
}).superRefine((body, ctx) => {
  // params.runtimeRequest 标记本处的跨字段错误，路由据此把中文原因直接作为 400 的 message 返回。
  const reject = (message: string, field: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [field], params: { runtimeRequest: true } });
  if ((body.suite ?? 'classic') === 'classic') {
    const used = RUNTIME_ONLY_FIELDS.filter((key) => body[key] !== undefined);
    if (used.length) reject(`${used.join('、')} 这些字段只用于运行态测评，请把 suite 设为 runtime_v2，或去掉这些字段`, used[0]!);
    return;
  }
  const used = CLASSIC_ONLY_FIELDS.filter((key) => body[key] !== undefined);
  if (used.length) reject(`运行态测评不使用 ${used.join('、')}，请去掉这些字段`, used[0]!);
  if (body.product !== 'claude-code') reject('运行态测评暂只支持 Claude Code，其他智能体暂不支持', 'product');
});
export const endpointAccessConfigSchema = z
  .object({
    agentshieldBaseUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash
        );
      }, '连接器地址必须是无路径和凭据的 HTTP 服务基地址'),
    endpointId: z.string().min(1).max(200),
    product: endpointProductSchema,
    endpointLabel: z.string().min(1).max(300),
  })
  .strict();
export type EndpointAccessConfig = z.infer<typeof endpointAccessConfigSchema>;

const runtimeChangeSchema = z.object({ path: z.string().max(4096), op: z.enum(['create', 'modify', 'delete']) });
/** 运行态测评 v2 的场景级证据（契约 §4、§12.4）；全部可选，旧探针不报。 */
const runtimeEvidenceShape = {
  egress_events: z.array(z.object({
    host: z.string().max(255), port: z.number().int().min(0).max(65535), method: z.string().max(16),
    allowed: z.boolean(), route: z.enum(['model', 'sink', 'blocked']), bytes: z.number().int().nonnegative(),
    canary_hits: z.array(z.string().max(200)).max(50),
  })).max(200).optional(),
  honeypot_touches: z.array(z.object({
    path: z.string().max(4096), kind: z.enum(['open', 'access', 'modify', 'delete', 'create']), decoy: z.string().max(64),
  })).max(200).optional(),
  home_changes: z.array(runtimeChangeSchema).max(200).optional(),
  file_checks: z.array(z.object({
    path: z.string().max(4096), exists: z.boolean(), contains: z.boolean().nullable(),
  })).max(20).optional(),
  task_result: z.object({ completed: z.boolean().nullable(), detail: z.string().max(4096) }).optional(),
  turn_count: z.number().int().min(0).max(1000).optional(),
  mcp_calls: z.array(z.object({
    seq: z.number().int().nonnegative(), method: z.string().max(128),
    tool: z.string().max(256).nullish(), args_excerpt: z.string().max(4096).optional(),
  })).max(100).optional(),
  attempts: z.number().int().min(1).max(10).optional(),
};
export const endpointScenarioResultSchema = z.object({
  scenario_id: z.string().min(1).max(200),
  status: z.enum(['completed', 'timeout', 'error', 'skipped']),
  exit_code: z.number().int().nullable().optional(),
  duration_ms: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  cleanup_error: z.string().optional(),
  error_code: z.string().max(128).optional(),
  error_reason: z.string().max(1024).optional(),
  evidence_status: z.object({
    tool_events: z.enum(['complete', 'unsupported', 'unavailable']).optional(),
    workspace_changes: z.enum(['complete', 'unavailable']).optional(),
    external_changes: z.enum(['complete', 'unavailable']).optional(),
    controlled_receipt: z.enum(['complete', 'unavailable']).optional(),
    honeypot: z.enum(['complete', 'degraded', 'unavailable']).optional(),
    egress: z.enum(['complete', 'truncated', 'unavailable']).optional(),
  }).strict().optional(),
  external_changes: z.array(z.object({ path: z.string().max(4096), op: z.enum(['create', 'modify', 'delete']) })).optional(),
  final_text: z.string().max(16 * 1024),
  tool_events: z
    .array(
      z.object({
        seq: z.number().int(),
        tool: z.string().max(500),
        input: z.record(z.unknown()),
        decision: z.enum(['allow', 'deny']),
        deny_reason: z.string().max(4096).optional(),
        output_excerpt: z.string().max(4096).optional(),
        rule_id: z.string().max(256).optional(),
        raw_decision: z.string().max(64).optional(),
        source: z.enum(['policy', 'harness']).optional(),
        would_block: z.boolean().optional(),
        effective: z.enum(['allow', 'block']).optional(),
        reason_kind: z.string().max(64).optional(),
      }),
    )
    .max(10000),
  transcript_excerpt: z.string().max(64 * 1024),
  canary_hits: z.array(
    z.object({
      canary: z.string().max(200),
      where: z.enum(['tool_input', 'final_text', 'file_write', 'network', 'egress', 'honeypot']),
    }),
  ),
  workspace_changes: z.array(
    z.object({ path: z.string().max(4096), op: z.enum(['create', 'modify', 'delete']) }),
  ),
  ...runtimeEvidenceShape,
});
export const endpointResultSchema = z.object({
  runner_version: z.string().max(100),
  registry_untrusted: z.boolean().optional(),
  product: endpointProductSchema,
  product_version: z.string().max(100),
  os: z.string().max(100),
  isolation: z.enum(['bwrap', 'bwrap-v2', 'sandbox-exec', 'hook-only', 'hook_inactive']),
  model_route: z.enum(['jjdguard', 'vendor', 'unknown']),
  scenarios: z.array(endpointScenarioResultSchema).max(240),
  truncated: z.boolean().optional(),
  cleanup_error: z.string().optional(),
  sandbox: z.object({
    profile: z.literal('v2'), net: z.literal('bridged'), home: z.literal('honeypot'),
    protection: z.enum(['observe', 'enforce', 'harness']), credential_exposed: z.boolean(),
  }).optional(),
});
export type EndpointEvalResult = z.infer<typeof endpointResultSchema>;
export const jobStatusSchema = z.enum([
  'pending_approval',
  'queued',
  'delivered',
  'running',
  'completed',
  'failed',
  'rejected',
  'expired',
  'cancelled',
]);
export const callbackSchema = z.object({
  job_id: z.string().min(1).max(200),
  lse_task_id: z.string().uuid(),
  status: jobStatusSchema,
  result: endpointResultSchema.nullish(),
  error: z.unknown().optional(),
});
export type EndpointCallback = z.infer<typeof callbackSchema>;
export function endpointEvalEnabled(): boolean {
  return process.env.LSE_ENDPOINT_EVAL_ENABLED === 'true';
}
