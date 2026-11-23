import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const check = z.object({
  rule_id: z.string().min(1).max(128),
  status: z.enum(['finding', 'pass', 'unknown']),
  severity: z.enum(['high', 'medium', 'info']),
  reason_zh: z.string().max(500),
  evidence_code: z.string().max(128),
  evidence_hash: hash.optional(),
  recommendation_zh: z.string().max(500),
}).strict();

export const assessmentBody = z.object({
  source_request_id: z.string().uuid(),
  source_tenant_id: z.string().min(1).max(64),
  source_asset_id: z.string().min(1).max(128),
  source_instance_id: z.string().min(1).max(128),
  source_endpoint_id: z.string().min(1).max(128).optional(),
  source_endpoint_asset_id: z.string().min(1).max(128).optional(),
  source_endpoint_name: z.string().min(1).max(128).optional(),
  asset_type: z.enum(['skill', 'mcp', 'agent', 'mcp_server', 'mcp_tool']),
  content_hash: hash,
  ruleset_version: z.string().min(1).max(128),
  status: z.enum(['findings', 'pass_candidate', 'partial']),
  checks: z.array(check).max(256),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const [index, item] of value.checks.entries()) {
    if (ids.has(item.rule_id)) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: ['checks', index, 'rule_id'], message: 'duplicate rule id' });
    ids.add(item.rule_id);
    if (item.status === 'finding' && (!item.reason_zh || !item.evidence_code || !item.recommendation_zh)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checks', index], message: 'finding evidence incomplete' });
    }
  }
  const findings = value.checks.filter((item) => item.status === 'finding').length;
  if (value.status === 'findings' && findings === 0) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ['status'], message: 'finding status requires findings' });
  if (value.status === 'pass_candidate' && (value.checks.length === 0 || value.checks.some((item) => item.status !== 'pass'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'pass candidate requires complete pass checks' });
  }
});

export type AssessmentBody = z.infer<typeof assessmentBody>;

export function assessEvidence(input: AssessmentBody) {
  const findings = input.checks.filter((item) => item.status === 'finding').map((item) => ({
    rule_id: item.rule_id,
    severity: item.severity,
    reason_zh: item.reason_zh,
    evidence_code: item.evidence_code,
    evidence_hash: item.evidence_hash ?? null,
    recommendation_zh: item.recommendation_zh,
  }));
  const hasUnknown = input.checks.some((item) => item.status === 'unknown');
  const coverage = input.status === 'partial' || hasUnknown || input.checks.length === 0
    ? 'partial' : 'supplied_evidence_only';
  const verdict = findings.length > 0 ? 'risk_found'
    : coverage === 'partial' ? 'inconclusive' : 'no_risk_in_supplied_evidence';
  const unknowns = input.checks.filter((item) => item.status === 'unknown').map((item) => ({
    rule_id: item.rule_id, reason_zh: item.reason_zh || '检查结果未确定',
  }));
  const report = {
    schema: 'lse.external_asset_assessment.v1',
    method: 'supplied_static_evidence_review',
    scope: { asset_type: input.asset_type, content_hash: input.content_hash,
      ruleset_version: input.ruleset_version, checked_rules: input.checks.length },
    verdict, coverage,
    summary: { findings: findings.length, high: findings.filter((x) => x.severity === 'high').length,
      medium: findings.filter((x) => x.severity === 'medium').length, unknown: unknowns.length },
    findings, unknowns,
    limitation: '本报告仅核验已提交的端侧静态证据；未执行技能、MCP 工具或生产流量测试。',
  };
  return { coverage, verdict, findings, report, method: 'supplied_static_evidence_review' as const };
}
