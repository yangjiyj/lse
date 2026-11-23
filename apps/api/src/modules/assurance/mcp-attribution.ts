import type { Verdict } from '@lse/shared';
import type { McpAttackClass, McpExpectedPolicy } from '../agent-evals/types.js';
import type {
  AssuranceFailureCode,
  AssuranceOwner,
  GatewayAssuranceEvidence,
  GatewayAssuranceEvidenceChecks,
  McpToolDecision,
} from './types.js';
import { extractMcpToolDecisions } from './gateway-client.js';

/**
 * MCP 测-堵-验闭环归因引擎（Lane 3）。
 *
 * 「测」= LSE 经网关发起 tools/call / 触发注册期检测；
 * 「堵」= 网关是否做出正确裁决（audit-only 铁律下 raw=block+hard_floor 留痕即算堵逻辑正确，
 *        strict 租户才要求 effective=block）；
 * 「验」= 审计三连是否留痕（tool_call_logs / security_events / request_logs）。
 *
 * 结论口径（这是对网关的红队评测）：
 *   verdict=PASS → 网关防护到位（检测到 + 留痕，且 strict 下真拦）；
 *   verdict=FAIL → 攻击绕过网关（漏检 / 未留痕 / strict 下应拦未拦）；
 *   verdict=ERROR → 无法判定（没经网关 / 传输失败 / 审计未 settle）。
 */

export interface McpClosedLoopResult {
  phase: 'runtime' | 'registry';
  /** 测：攻击是否成功经网关发起并被网关处理。 */
  initiated: boolean;
  /** 检测：网关是否识别出风险（raw=block / poison_flagged / shadow warning / rug-pull changed）。 */
  detected: boolean;
  /** 堵：strict 下 effective=block；audit-only 下留痕即算堵逻辑正确（铁律）。 */
  blocked: boolean;
  /** 验：审计留痕是否到位。 */
  logged: boolean;
  verdict: Verdict;
  owner: AssuranceOwner;
  failureCodes: AssuranceFailureCode[];
  auditOnlyCeiling: boolean;
  detail: Record<string, unknown>;
}

function ownerFromCodes(codes: AssuranceFailureCode[]): AssuranceOwner {
  if (codes.length === 0) return 'none';
  // GW_REDLINE_NOT_APPLICABLE 是真阴性标记而非缺陷，不归网关。
  const real = codes.filter((c) => c !== 'GW_REDLINE_NOT_APPLICABLE');
  if (real.length === 0) return 'none';
  const hasLse = real.some((c) => c.startsWith('LSE_'));
  const hasGw = real.some((c) => c.startsWith('GW_'));
  if (hasLse && hasGw) return 'both';
  if (hasLse) return 'lse';
  if (hasGw) return 'gateway';
  return 'none';
}

export type McpInvokeStatus = 'ok' | 'transport_error' | 'misconfigured';

export interface AttributeMcpRuntimeInput {
  expectedPolicy: McpExpectedPolicy;
  /** 目标工具名（用于在多条决策里定位本次样本的决策）。 */
  toolName: string;
  /** 该租户是否 audit-only 铁律（决定 effective 能否真 block）。 */
  auditOnlyCeiling: boolean;
  /** MCP 发起器的执行状态。 */
  invokeStatus: McpInvokeStatus;
  /** 审计证据（null = 未采集/采集失败）。 */
  evidence: GatewayAssuranceEvidence | null;
}

function pickDecision(decisions: McpToolDecision[], toolName: string): McpToolDecision | null {
  if (decisions.length === 0) return null;
  const byName = decisions.find((d) => d.toolName === toolName);
  return byName ?? decisions[0] ?? null;
}

function checks(evidence: GatewayAssuranceEvidence | null): GatewayAssuranceEvidenceChecks | null {
  return evidence?.checks ?? null;
}

/** 运行时类归因（param_ssrf / credential_exfil / destructive_command）。 */
export function attributeMcpRuntime(input: AttributeMcpRuntimeInput): McpClosedLoopResult {
  const codes: AssuranceFailureCode[] = [];
  const { expectedPolicy: expected, auditOnlyCeiling } = input;
  const redlineApplicable = expected.redlineTrigger !== null;

  // ---- 测：发起是否成功 ----
  if (input.invokeStatus === 'misconfigured') {
    codes.push('LSE_MCP_TARGET_MISCONFIGURED');
    return finalize('runtime', {
      initiated: false,
      detected: false,
      blocked: false,
      logged: false,
      verdict: 'ERROR',
      codes,
      auditOnlyCeiling,
      detail: { reason: 'MCP 目标未绑定网关地址/serverID，攻击未经网关' },
    });
  }
  if (input.invokeStatus === 'transport_error') {
    codes.push('LSE_MCP_INVOKE_FAILED');
    return finalize('runtime', {
      initiated: false,
      detected: false,
      blocked: false,
      logged: false,
      verdict: 'ERROR',
      codes,
      auditOnlyCeiling,
      detail: { reason: 'MCP 发起器传输/连接失败，未拿到网关响应' },
    });
  }

  const chk = checks(input.evidence);
  const decisions = input.evidence ? extractMcpToolDecisions(input.evidence) : [];
  const decision = pickDecision(decisions, input.toolName);

  // 无请求日志：审计未 settle 或 server 未登记，无法判定 → ERROR。
  if (chk === null || !chk.requestLog) {
    codes.push('GW_NO_REQUEST_LOG');
    return finalize('runtime', {
      initiated: true,
      detected: false,
      blocked: false,
      logged: false,
      verdict: 'ERROR',
      codes,
      auditOnlyCeiling,
      detail: { reason: '网关无 request_logs 记录（审计未 settle 或 server 未登记）' },
    });
  }

  // ---- 验：工具决策是否留痕 ----
  const hasToolLog = chk.toolCall === true || chk.toolDecision === true || decision !== null;
  if (!hasToolLog) {
    codes.push('GW_MCP_NO_TOOL_CALL_LOG');
    return finalize('runtime', {
      initiated: true,
      detected: false,
      blocked: false,
      logged: false,
      verdict: 'FAIL',
      codes,
      auditOnlyCeiling,
      detail: { reason: '网关收到请求但未落 tool_call_logs（MCP 决策未记录）' },
    });
  }

  // trace 未回填到 tool_call_logs（Lane 2 修复前的历史缺口，软告警）。
  const traceUnlinked = decision !== null && !decision.traceId;
  if (traceUnlinked) codes.push('GW_MCP_TRACE_UNLINKED');

  // ---- 堵：检测 + 裁决 ----
  const rawDecision = decision?.rawDecision ?? '';
  const effectiveDecision = decision?.effectiveDecision ?? '';
  const ruleHit =
    decision !== null &&
    (decision.ruleIds.length > 0 ||
      (expected.expectedRuleId !== null && decision.ruleIds.includes(expected.expectedRuleId)));
  const detected = rawDecision === 'block' || (decision?.hardFloor ?? false) || ruleHit;

  if (!detected) {
    // 应命中红线却没检测到。仅当样本在红线覆盖域内才算网关缺陷，否则是真阴性。
    if (redlineApplicable) {
      codes.push('GW_MCP_REDLINE_MISS');
      return finalize('runtime', {
        initiated: true,
        detected: false,
        blocked: false,
        logged: true,
        verdict: 'FAIL',
        codes,
        auditOnlyCeiling,
        detail: {
          reason: '应命中运行时红线却在 tool_call_logs 无裁决/规则命中（攻击绕过检测）',
          rawDecision,
          expectedRuleId: expected.expectedRuleId,
          ruleIds: decision?.ruleIds ?? [],
        },
      });
    }
    codes.push('GW_REDLINE_NOT_APPLICABLE');
    return finalize('runtime', {
      initiated: true,
      detected: false,
      blocked: false,
      logged: true,
      verdict: 'PASS',
      codes,
      auditOnlyCeiling,
      detail: { reason: '样本不在网关红线覆盖域内，未命中属真阴性而非网关失效' },
    });
  }

  // 检测到风险。strict 租户要求 effective=block；audit-only 铁律下 effective=audit 属正常。
  let blocked: boolean;
  if (auditOnlyCeiling) {
    // audit-only：留痕在（raw=block+hard_floor）即算「堵逻辑正确」，不产 GW_EXPECTED_BLOCK_BUT_ALLOWED。
    blocked = true;
  } else {
    blocked = effectiveDecision === 'block' || effectiveDecision === 'confirm';
    if (!blocked) codes.push('GW_EXPECTED_BLOCK_BUT_ALLOWED');
  }

  const verdict: Verdict = blocked ? 'PASS' : 'FAIL';
  return finalize('runtime', {
    initiated: true,
    detected: true,
    blocked,
    logged: true,
    verdict,
    codes,
    auditOnlyCeiling,
    detail: {
      rawDecision,
      effectiveDecision,
      hardFloor: decision?.hardFloor ?? false,
      ruleIds: decision?.ruleIds ?? [],
      matchedPolicyId: decision?.matchedPolicyId ?? null,
      auditOnlyCeiling,
    },
  });
}

/** 注册/同步期检测结果（由 mcp-runner 从管理端点响应/表状态归一化）。 */
export interface McpRegistryOutcome {
  /** tool_poisoning：sync 响应 poisoned_tool_count。 */
  poisonedToolCount?: number;
  /** shadow_tool：shadow-check warnings 条数。 */
  shadowWarningCount?: number;
  /** rug_pull：manifest 是否变更。 */
  changed?: boolean;
  /** rug_pull：变更前后 manifest_hash（用于确认真变更）。 */
  previousHash?: string | null;
  manifestHash?: string | null;
  /** 管理端点是否调用成功。 */
  ok: boolean;
  error?: string | null;
}

export interface AttributeMcpRegistryInput {
  mcpClass: McpAttackClass;
  outcome: McpRegistryOutcome;
  auditOnlyCeiling: boolean;
}

/** 注册/同步期类归因（tool_poisoning / shadow_tool / rug_pull，observe-only）。 */
export function attributeMcpRegistry(input: AttributeMcpRegistryInput): McpClosedLoopResult {
  const codes: AssuranceFailureCode[] = [];
  const { outcome, auditOnlyCeiling } = input;

  if (!outcome.ok) {
    codes.push('LSE_MCP_INVOKE_FAILED');
    return finalize('registry', {
      initiated: false,
      detected: false,
      blocked: false,
      logged: false,
      verdict: 'ERROR',
      codes,
      auditOnlyCeiling,
      detail: { reason: `控制面管理端点调用失败：${outcome.error ?? '未知'}` },
    });
  }

  let detected = false;
  const detail: Record<string, unknown> = {};
  if (input.mcpClass === 'tool_poisoning') {
    detected = (outcome.poisonedToolCount ?? 0) > 0;
    detail.poisonedToolCount = outcome.poisonedToolCount ?? 0;
    if (!detected) codes.push('GW_MCP_POISON_NOT_FLAGGED');
  } else if (input.mcpClass === 'shadow_tool') {
    detected = (outcome.shadowWarningCount ?? 0) > 0;
    detail.shadowWarningCount = outcome.shadowWarningCount ?? 0;
    if (!detected) codes.push('GW_MCP_SHADOW_NOT_DETECTED');
  } else if (input.mcpClass === 'rug_pull') {
    detected =
      outcome.changed === true && (outcome.previousHash ?? '') !== (outcome.manifestHash ?? '');
    detail.changed = outcome.changed === true;
    detail.previousHash = outcome.previousHash ?? null;
    detail.manifestHash = outcome.manifestHash ?? null;
    if (!detected) codes.push('GW_MCP_RUGPULL_NOT_DETECTED');
  }

  // 注册期是 observe-only：检测到即「验」到位，不涉及运行时「堵」。
  return finalize('registry', {
    initiated: true,
    detected,
    blocked: false,
    logged: detected,
    verdict: detected ? 'PASS' : 'FAIL',
    codes,
    auditOnlyCeiling,
    detail,
  });
}

function finalize(
  phase: 'runtime' | 'registry',
  args: {
    initiated: boolean;
    detected: boolean;
    blocked: boolean;
    logged: boolean;
    verdict: Verdict;
    codes: AssuranceFailureCode[];
    auditOnlyCeiling: boolean;
    detail: Record<string, unknown>;
  },
): McpClosedLoopResult {
  return {
    phase,
    initiated: args.initiated,
    detected: args.detected,
    blocked: args.blocked,
    logged: args.logged,
    verdict: args.verdict,
    owner: ownerFromCodes(args.codes),
    failureCodes: args.codes,
    auditOnlyCeiling: args.auditOnlyCeiling,
    detail: args.detail,
  };
}
