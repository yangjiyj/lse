import type { LlmCallResult, Verdict } from '@lse/shared';
import { outcomeFromMcpRun } from '@lse/shared';
import { invokeEvaluationTarget, type EvaluationTargetConfig } from '../eval-targets/invoker.js';
import { parseMcpAccessConfig } from '../eval-targets/mcp-client.js';
import { triggerMcpSync, fetchMcpShadowCheck } from '../eval-targets/mcp-management-client.js';
import {
  fetchGatewayAssuranceEvidence,
  extractMcpToolDecisions,
} from '../assurance/gateway-client.js';
import type { GatewayAssuranceEvidence } from '../assurance/types.js';
import {
  attributeMcpRuntime,
  attributeMcpRegistry,
  type McpClosedLoopResult,
  type McpInvokeStatus,
  type McpRegistryOutcome,
} from '../assurance/mcp-attribution.js';
import type { McpScenarioMetadata } from './types.js';

/**
 * MCP 测-堵-验闭环执行器（Lane 3 核心）。
 *
 * runtime 类：经网关 /mcp/{serverID} 发 tools/call（测）→ 轮询审计 settle → 按 trace_id 回查
 *   网关审计（tool_call_logs/security_events/request_logs）判检测/堵/留痕（堵+验）→ 归因。
 * registry 类：走 control-plane 管理端点触发 observe-only 检测（sync/shadow-check），读响应判据。
 *
 * 与 runAgentScenario 一样返回 LlmCallResult 形态（附 verdict + closedLoop），
 * 便于 executor 落 EngineRun.rawOutput 与 evalResult。
 */

export interface McpRunnerGatewayAccess {
  controlPlaneBaseUrl: string;
  tenantId: string;
}

export interface RunMcpScenarioArgs {
  target: EvaluationTargetConfig;
  metadata: McpScenarioMetadata;
  prompt: string;
  correlationHeaders?: Record<string, string>;
  traceId: string;
  evalRunId: string;
  taskId: string;
  sampleId: string;
  targetId: string;
  /** 归因回查通道（control-plane），null = 未绑定网关（无法验证）。 */
  gateway: McpRunnerGatewayAccess | null;
  /** 拉审计/触发管理端点的内部密钥。 */
  internalToken: string;
  /** 该租户是否 audit-only 铁律；缺省则从观测到的裁决推断。 */
  auditOnlyCeiling?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunMcpScenarioDeps {
  invoke?: typeof invokeEvaluationTarget;
  fetchEvidence?: typeof fetchGatewayAssuranceEvidence;
  triggerSync?: typeof triggerMcpSync;
  fetchShadowCheck?: typeof fetchMcpShadowCheck;
  sleep?: (ms: number) => Promise<void>;
  /** 审计 settle 轮询次数与间隔（安全网关走事务，需等 request_logs 先落）。 */
  auditSettleAttempts?: number;
  auditSettleDelayMs?: number;
}

export interface McpRunResult extends LlmCallResult {
  executionStatus?: 'NOT_EXECUTED';
  verdict: Verdict;
  closedLoop: McpClosedLoopResult;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询审计直到 request_logs 落库（避免刚打完就查得 GW_NO_REQUEST_LOG 假阴）。 */
async function fetchEvidenceAfterSettle(args: {
  fetchEvidence: typeof fetchGatewayAssuranceEvidence;
  gateway: McpRunnerGatewayAccess;
  internalToken: string;
  traceId: string;
  evalRunId: string;
  taskId: string;
  sampleId: string;
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<GatewayAssuranceEvidence | null> {
  let last: GatewayAssuranceEvidence | null = null;
  for (let attempt = 0; attempt < args.attempts; attempt += 1) {
    try {
      const evidence = await args.fetchEvidence({
        controlPlaneBaseUrl: args.gateway.controlPlaneBaseUrl,
        internalToken: args.internalToken,
        tenantId: args.gateway.tenantId,
        traceId: args.traceId,
        evalRunId: args.evalRunId,
        taskId: args.taskId,
        sampleId: args.sampleId,
      });
      last = evidence;
      // request_logs 已落 + 工具决策已落（或已判定拦截）即可停止轮询。
      if (
        evidence.checks.requestLog &&
        (evidence.checks.toolCall || evidence.checks.toolDecision)
      ) {
        return evidence;
      }
    } catch {
      // 网络抖动/审计未 settle：重试。
    }
    if (attempt < args.attempts - 1) await args.sleep(args.delayMs * (attempt + 1));
  }
  return last;
}

function inferAuditOnlyCeiling(
  explicit: boolean | undefined,
  evidence: GatewayAssuranceEvidence | null,
): boolean {
  if (explicit !== undefined) return explicit;
  if (evidence === null) return true; // 生产默认 SECURITY_AUDIT_ONLY=true，保守不误判漏堵
  const decisions = extractMcpToolDecisions(evidence);
  // 观测到 effective=block/confirm ⇒ 该租户是 strict（天花板未生效）。
  const sawRealBlock = decisions.some(
    (d) => d.effectiveDecision === 'block' || d.effectiveDecision === 'confirm',
  );
  return !sawRealBlock;
}

function buildEnvelope(args: {
  metadata: McpScenarioMetadata;
  closedLoop: McpClosedLoopResult;
  traceId: string;
  invokeRaw: unknown;
  evidence: GatewayAssuranceEvidence | null;
  registryOutcome: McpRegistryOutcome | null;
}): Record<string, unknown> {
  const { metadata, closedLoop } = args;
  const outcome = outcomeFromMcpRun({ verdict: closedLoop.verdict });
  return {
    kind: 'mcp_closed_loop',
    // 统一结局口径：网关检出并留痕 = 被拦截（产品拦截），绕过网关 = 照做。
    outcome: outcome.outcome,
    outcomeLabel: outcome.label,
    ...(outcome.blockSource ? { blockSource: outcome.blockSource } : {}),
    productProtected: outcome.productProtected,
    ...(metadata.templateId.endsWith('-r4')
      ? { scope: 'LOCAL_SANDBOX_SELF_TEST', scopeLabel: SANDBOX_LABEL }
      : {}),
    verdict: closedLoop.verdict,
    mcpClass: metadata.mcpClass,
    mcpPhase: metadata.mcpPhase,
    technique: metadata.technique,
    riskSurface: metadata.riskSurface,
    toolName: metadata.toolName,
    intent: metadata.intent,
    templateId: metadata.templateId,
    attackPackId: metadata.attackPackId,
    attackPackVersion: metadata.attackPackVersion,
    safeCanary: metadata.safeCanary,
    expectedPolicy: metadata.expectedPolicy,
    expectedGatewayAction: metadata.expectedGatewayAction,
    successSignals: metadata.successSignals,
    evidenceRequirements: metadata.evidenceRequirements,
    // 测-堵-验三连（报告与看板核心）。
    triad: {
      test: closedLoop.initiated,
      block: closedLoop.blocked,
      verify: closedLoop.logged,
      detected: closedLoop.detected,
    },
    attribution: {
      owner: closedLoop.owner,
      failureCodes: closedLoop.failureCodes,
      auditOnlyCeiling: closedLoop.auditOnlyCeiling,
      detail: closedLoop.detail,
    },
    traceId: args.traceId,
    mcpToolDecisions: args.evidence ? extractMcpToolDecisions(args.evidence) : [],
    evidenceChecks: args.evidence?.checks ?? null,
    ...(metadata.remediation ? { remediation: metadata.remediation } : {}),
    ...(args.registryOutcome ? { registryOutcome: args.registryOutcome } : {}),
    invokeRaw: args.invokeRaw,
  };
}

function toResult(
  base: {
    status: 'SUCCESS' | 'ERROR';
    content: string;
    latencyMs: number;
    httpStatus: number | null;
    error: string | null;
  },
  closedLoop: McpClosedLoopResult,
  envelope: Record<string, unknown>,
): McpRunResult {
  return {
    status: base.status,
    content: base.content,
    finishReason: null,
    model: 'mcp-openapi',
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    latencyMs: base.latencyMs,
    httpStatus: base.httpStatus,
    error: base.error,
    raw: envelope,
    verdict: closedLoop.verdict,
    closedLoop,
  };
}

async function runRuntimeScenario(
  args: RunMcpScenarioArgs,
  deps: Required<Pick<RunMcpScenarioDeps, 'invoke' | 'fetchEvidence' | 'sleep'>> & {
    auditSettleAttempts: number;
    auditSettleDelayMs: number;
  },
): Promise<McpRunResult> {
  const { metadata } = args;
  const parsed = parseMcpAccessConfig(args.target.accessConfig);
  const jsonRpc = metadata.jsonRpc;

  // 前置：目标必须绑定网关且样本自带 tools/call payload，否则攻击没经网关（LSE 侧配置的锅）。
  if (parsed.config === null || jsonRpc === undefined || args.gateway === null) {
    const closedLoop = attributeMcpRuntime({
      expectedPolicy: metadata.expectedPolicy,
      toolName: metadata.toolName,
      auditOnlyCeiling: args.auditOnlyCeiling ?? true,
      invokeStatus: 'misconfigured',
      evidence: null,
    });
    const envelope = buildEnvelope({
      metadata,
      closedLoop,
      traceId: args.traceId,
      invokeRaw: { error: parsed.error ?? '缺少 jsonRpc payload 或未绑定网关' },
      evidence: null,
      registryOutcome: null,
    });
    return toResult(
      {
        status: 'ERROR',
        content: '',
        latencyMs: 0,
        httpStatus: null,
        error: parsed.error ?? 'MCP 目标配置无效',
      },
      closedLoop,
      envelope,
    );
  }

  // ---- 测：经网关发起 tools/call ----
  const invokeResult = await deps.invoke(args.target, [{ role: 'user', content: args.prompt }], {
    mcpCall: jsonRpc,
    ...(args.correlationHeaders ? { correlationHeaders: args.correlationHeaders } : {}),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    ...(args.signal ? { signal: args.signal } : {}),
  });

  let invokeStatus: McpInvokeStatus = 'ok';
  if (invokeResult.status === 'ERROR') {
    invokeStatus = 'transport_error';
  }

  // ---- 验：轮询审计 settle 后按 trace_id 回查 ----
  let evidence: GatewayAssuranceEvidence | null = null;
  if (invokeStatus === 'ok') {
    evidence = await fetchEvidenceAfterSettle({
      fetchEvidence: deps.fetchEvidence,
      gateway: args.gateway,
      internalToken: args.internalToken,
      traceId: args.traceId,
      evalRunId: args.evalRunId,
      taskId: args.taskId,
      sampleId: args.sampleId,
      attempts: deps.auditSettleAttempts,
      delayMs: deps.auditSettleDelayMs,
      sleep: deps.sleep,
    });
  }

  const auditOnlyCeiling = inferAuditOnlyCeiling(args.auditOnlyCeiling, evidence);
  const closedLoop = attributeMcpRuntime({
    expectedPolicy: metadata.expectedPolicy,
    toolName: metadata.toolName,
    auditOnlyCeiling,
    invokeStatus,
    evidence,
  });

  const envelope = buildEnvelope({
    metadata,
    closedLoop,
    traceId: args.traceId,
    invokeRaw: invokeResult.raw,
    evidence,
    registryOutcome: null,
  });
  const content = summarizeTriad(closedLoop);
  return toResult(
    {
      status: closedLoop.verdict === 'ERROR' ? 'ERROR' : 'SUCCESS',
      content,
      latencyMs: invokeResult.latencyMs,
      httpStatus: invokeResult.httpStatus,
      error: closedLoop.verdict === 'ERROR' ? (invokeResult.error ?? '闭环无法判定') : null,
    },
    closedLoop,
    envelope,
  );
}

async function runRegistryScenario(
  args: RunMcpScenarioArgs,
  deps: Required<Pick<RunMcpScenarioDeps, 'triggerSync' | 'fetchShadowCheck'>>,
): Promise<McpRunResult> {
  const { metadata } = args;
  const parsed = parseMcpAccessConfig(args.target.accessConfig);
  if (parsed.config === null || args.gateway === null) {
    const closedLoop = attributeMcpRegistry({
      mcpClass: metadata.mcpClass,
      outcome: { ok: false, error: parsed.error ?? '未绑定网关控制面' },
      auditOnlyCeiling: args.auditOnlyCeiling ?? true,
    });
    // 未绑定网关是 LSE 侧配置问题：改判为 misconfigured 归因。
    closedLoop.failureCodes = ['LSE_MCP_TARGET_MISCONFIGURED'];
    closedLoop.owner = 'lse';
    closedLoop.verdict = 'ERROR';
    const envelope = buildEnvelope({
      metadata,
      closedLoop,
      traceId: args.traceId,
      invokeRaw: null,
      evidence: null,
      registryOutcome: null,
    });
    return toResult(
      {
        status: 'ERROR',
        content: '',
        latencyMs: 0,
        httpStatus: null,
        error: parsed.error ?? 'MCP 目标配置无效',
      },
      closedLoop,
      envelope,
    );
  }

  let outcome: McpRegistryOutcome;
  if (metadata.mcpClass === 'shadow_tool') {
    outcome = await deps.fetchShadowCheck({
      controlPlaneBaseUrl: args.gateway.controlPlaneBaseUrl,
      tenantId: args.gateway.tenantId,
      internalToken: args.internalToken,
      serverID: parsed.config.serverID,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
  } else {
    // tool_poisoning / rug_pull：触发 sync 读检测响应。
    outcome = await deps.triggerSync({
      controlPlaneBaseUrl: args.gateway.controlPlaneBaseUrl,
      tenantId: args.gateway.tenantId,
      internalToken: args.internalToken,
      serverID: parsed.config.serverID,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
  }

  const closedLoop = attributeMcpRegistry({
    mcpClass: metadata.mcpClass,
    outcome,
    auditOnlyCeiling: args.auditOnlyCeiling ?? true,
  });
  const envelope = buildEnvelope({
    metadata,
    closedLoop,
    traceId: args.traceId,
    invokeRaw: null,
    evidence: null,
    registryOutcome: outcome,
  });
  return toResult(
    {
      status: closedLoop.verdict === 'ERROR' ? 'ERROR' : 'SUCCESS',
      content: metadata.templateId.endsWith('-r4')
        ? `${SANDBOX_LABEL}：${summarizeTriad(closedLoop)}；不代表客户MCP配置覆盖。`
        : summarizeTriad(closedLoop),
      latencyMs: 0,
      httpStatus: null,
      error: closedLoop.verdict === 'ERROR' ? (outcome.error ?? '注册期检测无法判定') : null,
    },
    closedLoop,
    envelope,
  );
}

function summarizeTriad(closedLoop: McpClosedLoopResult): string {
  const mark = (ok: boolean): string => (ok ? '✓' : '✗');
  return (
    `MCP ${closedLoop.phase} 闭环：测${mark(closedLoop.initiated)} ` +
    `检测${mark(closedLoop.detected)} 堵${mark(closedLoop.blocked)} 验${mark(closedLoop.logged)}` +
    (closedLoop.failureCodes.length > 0 ? `（归因：${closedLoop.failureCodes.join(',')}）` : '')
  );
}

const SANDBOX_LABEL = '本地沙箱探针（检测器自检）';
function skipSandbox(args: RunMcpScenarioArgs): McpRunResult {
  const reason = `${SANDBOX_LABEL}：前提不满足，未执行；需要本地沙箱MCP服务，不代表客户MCP配置覆盖。`;
  const closedLoop: McpClosedLoopResult = {
    phase: args.metadata.mcpPhase,
    initiated: false,
    detected: false,
    blocked: false,
    logged: false,
    verdict: 'UNKNOWN',
    owner: 'lse',
    failureCodes: [],
    auditOnlyCeiling: true,
    detail: { reason, executionStatus: 'NOT_EXECUTED', scope: 'LOCAL_SANDBOX_SELF_TEST' },
  };
  return {
    ...toResult(
      { status: 'SUCCESS', content: reason, latencyMs: 0, httpStatus: null, error: null },
      closedLoop,
      {
        kind: 'mcp_configuration_probe',
        executionStatus: 'NOT_EXECUTED',
        scope: 'LOCAL_SANDBOX_SELF_TEST',
        reason,
      },
    ),
    executionStatus: 'NOT_EXECUTED',
  };
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
async function runSandboxProbe(
  args: RunMcpScenarioArgs,
  invoke: typeof invokeEvaluationTarget,
): Promise<McpRunResult> {
  const probe = args.metadata.sandboxProbe!;
  if (!args.metadata.jsonRpc) return skipSandbox(args);
  const result = await invoke(args.target, [{ role: 'user', content: args.prompt }], {
    mcpCall: args.metadata.jsonRpc,
    signal: args.signal,
    timeoutMs: args.timeoutMs,
  });
  if (result.status === 'ERROR' && result.httpStatus === null) return skipSandbox(args);
  const raw = record(result.raw);
  const body = record(raw?.jsonRpcResult);
  let verdict: Verdict = 'ERROR';
  let reason = '实际工具清单或完整Agent轨迹缺失，无法判定';
  if (
    result.status === 'SUCCESS' &&
    body &&
    !raw?.jsonRpcError &&
    result.httpStatus !== null &&
    result.httpStatus < 400
  ) {
    const trace = record(body.agentTrace);
    const calls = probe.kind === 'enumeration' ? body.tools : trace?.toolCalls;
    const complete = probe.kind === 'enumeration' ? !body.nextCursor : trace?.complete === true;
    if (
      complete &&
      Array.isArray(calls) &&
      calls.every((tool) => typeof record(tool)?.name === 'string')
    ) {
      const unexpected = calls.filter(
        (tool) => !probe.allowedTools.includes(String(record(tool)?.name)),
      );
      verdict = unexpected.length ? 'FAIL' : 'PASS';
      reason = unexpected.length ? '实际观察到白名单外工具' : '完整返回与轨迹未见白名单外工具';
    }
  }
  reason = `${SANDBOX_LABEL}：${reason}；不代表客户MCP配置覆盖。`;
  const closedLoop: McpClosedLoopResult = {
    phase: 'runtime',
    initiated: true,
    detected: verdict === 'FAIL',
    blocked: false,
    logged: raw !== null,
    verdict,
    owner: 'lse',
    failureCodes: [],
    auditOnlyCeiling: true,
    detail: { reason, scope: 'LOCAL_SANDBOX_SELF_TEST' },
  };
  return toResult(
    {
      status: verdict === 'ERROR' ? 'ERROR' : 'SUCCESS',
      content: reason,
      latencyMs: result.latencyMs,
      httpStatus: result.httpStatus,
      error: verdict === 'ERROR' ? reason : null,
    },
    closedLoop,
    {
      kind: 'mcp_configuration_probe',
      verdict,
      scope: 'LOCAL_SANDBOX_SELF_TEST',
      templateId: args.metadata.templateId,
      invokeRaw: raw,
      reason,
    },
  );
}

export async function runMcpScenario(
  args: RunMcpScenarioArgs,
  deps: RunMcpScenarioDeps = {},
): Promise<McpRunResult> {
  // All new configuration fixtures, including registry probes, stay in the local sandbox.
  if (args.metadata.templateId.endsWith('-r4')) {
    const access = args.target.accessConfig as Record<string, unknown> | null;
    const keys =
      args.metadata.mcpPhase === 'registry'
        ? ['gatewayBaseUrl', 'controlPlaneBaseUrl']
        : ['gatewayBaseUrl'];
    const urls = keys.map((key) => access?.[key]);
    if (args.metadata.mcpPhase === 'registry') urls.push(args.gateway?.controlPlaneBaseUrl);
    const local = urls.every((value) => {
      try {
        const u = new URL(String(value ?? ''));
        return u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password;
      } catch {
        return false;
      }
    });
    if (!local || args.target.targetType !== 'MCP_OPENAPI') return skipSandbox(args);
  }
  if (args.metadata.sandboxProbe)
    return runSandboxProbe(args, deps.invoke ?? invokeEvaluationTarget);
  const resolved = {
    invoke: deps.invoke ?? invokeEvaluationTarget,
    fetchEvidence: deps.fetchEvidence ?? fetchGatewayAssuranceEvidence,
    triggerSync: deps.triggerSync ?? triggerMcpSync,
    fetchShadowCheck: deps.fetchShadowCheck ?? fetchMcpShadowCheck,
    sleep: deps.sleep ?? defaultSleep,
    auditSettleAttempts: deps.auditSettleAttempts ?? 5,
    auditSettleDelayMs: deps.auditSettleDelayMs ?? 300,
  };
  if (args.metadata.mcpPhase === 'registry') {
    return runRegistryScenario(args, resolved);
  }
  return runRuntimeScenario(args, resolved);
}
