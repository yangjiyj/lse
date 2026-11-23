// 采集器回传的测评结果校验：移植自 docs/endpoint-fleet/stub_server.reference.py 的 validate_result
// （其本身移植自 AgentShield lseeval.ValidateResult）。
// 与参考实现的差异：参考实现在若干字段上依赖 Python 运行时类型错误（会变成 500），这里显式做类型检查；
// cleanup_error / output_excerpt 按 UTF-8 字节计长（与 AgentShield Go 的 len(string) 一致，参考实现按字符计）。
import { containsBadString } from './checksum.js';

export class InvalidResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidResultError';
  }
}

const TOP_REQUIRED = [
  'runner_version',
  'product',
  'product_version',
  'os',
  'isolation',
  'model_route',
  'scenarios',
];
const TOP_OPTIONAL = ['registry_untrusted', 'sandbox'];
const SCEN_REQUIRED = [
  'scenario_id',
  'status',
  'exit_code',
  'duration_ms',
  'final_text',
  'tool_events',
  'transcript_excerpt',
  'canary_hits',
  'workspace_changes',
];
const SCEN_OPTIONAL = [
  'truncated',
  'cleanup_error',
  'error_code',
  'error_reason',
  'external_changes',
  'evidence_status',
  // 运行态测评 v2（旧探针不报，缺失时行为与旧版一致）
  'egress_events',
  'honeypot_touches',
  'home_changes',
  'file_checks',
  'task_result',
  'turn_count',
  'mcp_calls',
  'attempts',
];
const EVENT_REQUIRED = ['seq', 'tool', 'input', 'decision'];
const EVENT_OPTIONAL = [
  'deny_reason', 'output_excerpt', 'rule_id', 'raw_decision', 'source', 'would_block', 'effective', 'reason_kind',
];

const OS = new Set(['linux', 'darwin', 'windows']);
const ISOLATION = new Set(['bwrap', 'bwrap-v2', 'sandbox-exec', 'hook-only', 'hook_inactive']);
const MODEL_ROUTE = new Set(['jjdguard', 'vendor', 'unknown']);
const SCEN_STATUS_FAILED = new Set(['timeout', 'error', 'skipped']);
const DECISION = new Set(['allow', 'deny']);
const CANARY_WHERE = new Set(['tool_input', 'final_text', 'file_write', 'network', 'egress', 'honeypot']);
const CHANGE_OP = new Set(['create', 'modify', 'delete']);
const SANDBOX_PROTECTION = new Set(['observe', 'enforce', 'harness']);
const EGRESS_ROUTE = new Set(['model', 'sink', 'blocked']);
const TOUCH_KIND = new Set(['open', 'access', 'modify', 'delete', 'create']);
const EVENT_SOURCE = new Set(['policy', 'harness']);
/** hookd 模式 2 的实际生效结果：allow 或 block（confirm 在测评里按拒绝处理，记为 block）。 */
const EVENT_EFFECTIVE = new Set(['allow', 'block']);
/** 运行态测评 v2 的场景数与每个场景证据条数上限（契约 §4、§12.4）。 */
const MAX_SCENARIOS = 240;
const MAX_EGRESS_EVENTS = 200;
const MAX_HONEYPOT_TOUCHES = 200;
const MAX_HOME_CHANGES = 200;
const MAX_MCP_CALLS = 100;

type Obj = Record<string, unknown>;

function bad(message: string): never {
  throw new InvalidResultError(message);
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

function fields(
  value: unknown,
  required: string[],
  optional: string[],
  at: string,
  nullable: string[] = [],
): Obj {
  if (!isObj(value)) bad(`${at}必须是对象`);
  const keys = Object.keys(value);
  for (const k of required) if (!Object.hasOwn(value, k)) bad(`${at}缺少字段 ${k}`);
  for (const k of keys)
    if (!required.includes(k) && !optional.includes(k)) bad(`${at}含未知字段 ${k}`);
  for (const k of keys) if (value[k] === null && !nullable.includes(k)) bad(`${at}字段 ${k} 不能为 null`);
  return value;
}

const shortString = (v: unknown, max: number): v is string => typeof v === 'string' && bytes(v) <= max;

/** 顶层 sandbox 摘要（运行态测评 v2，可选）。 */
function validateSandbox(value: unknown): void {
  const sb = fields(value, ['profile', 'net', 'home', 'protection', 'credential_exposed'], [], 'sandbox');
  if (sb.profile !== 'v2') bad('sandbox.profile 不合法');
  if (sb.net !== 'bridged') bad('sandbox.net 不合法');
  if (sb.home !== 'honeypot') bad('sandbox.home 不合法');
  if (typeof sb.protection !== 'string' || !SANDBOX_PROTECTION.has(sb.protection))
    bad('sandbox.protection 不合法');
  if (typeof sb.credential_exposed !== 'boolean') bad('sandbox.credential_exposed 必须是布尔值');
}

/** 场景级运行态证据（运行态测评 v2，全部可选；缺失时不做任何校验）。 */
function validateRuntimeEvidence(s: Obj, at: string): void {
  if ('egress_events' in s) {
    if (!Array.isArray(s.egress_events) || s.egress_events.length > MAX_EGRESS_EVENTS)
      bad(`${at}的 egress_events 必须是不超过 ${MAX_EGRESS_EVENTS} 条的数组`);
    for (const raw of s.egress_events) {
      const e = fields(
        raw,
        ['host', 'port', 'method', 'allowed', 'route', 'bytes', 'canary_hits'],
        [],
        `${at}的外发事件`,
      );
      if (!nonEmptyString(e.host) || !shortString(e.host, 255)) bad(`${at}的外发事件 host 不合法`);
      if (!isInt(e.port) || e.port < 0 || e.port > 65535) bad(`${at}的外发事件 port 不合法`);
      if (!nonEmptyString(e.method) || !shortString(e.method, 16)) bad(`${at}的外发事件 method 不合法`);
      if (typeof e.allowed !== 'boolean') bad(`${at}的外发事件 allowed 必须是布尔值`);
      if (typeof e.route !== 'string' || !EGRESS_ROUTE.has(e.route)) bad(`${at}的外发事件 route 不合法`);
      if (!isInt(e.bytes) || e.bytes < 0) bad(`${at}的外发事件 bytes 不合法`);
      if (
        !Array.isArray(e.canary_hits) ||
        e.canary_hits.length > 50 ||
        e.canary_hits.some((c) => !nonEmptyString(c) || !shortString(c, 200))
      )
        bad(`${at}的外发事件 canary_hits 必须是字符串数组`);
    }
  }
  if ('honeypot_touches' in s) {
    if (!Array.isArray(s.honeypot_touches) || s.honeypot_touches.length > MAX_HONEYPOT_TOUCHES)
      bad(`${at}的 honeypot_touches 必须是不超过 ${MAX_HONEYPOT_TOUCHES} 条的数组`);
    for (const raw of s.honeypot_touches) {
      const t = fields(raw, ['path', 'kind', 'decoy'], [], `${at}的蜜标触碰`);
      if (!nonEmptyString(t.path) || !shortString(t.path, 4096)) bad(`${at}的蜜标触碰 path 不合法`);
      if (typeof t.kind !== 'string' || !TOUCH_KIND.has(t.kind)) bad(`${at}的蜜标触碰 kind 不合法`);
      if (!shortString(t.decoy, 64)) bad(`${at}的蜜标触碰 decoy 不合法`);
    }
  }
  if ('home_changes' in s) {
    if (!Array.isArray(s.home_changes) || s.home_changes.length > MAX_HOME_CHANGES)
      bad(`${at}的 home_changes 必须是不超过 ${MAX_HOME_CHANGES} 条的数组`);
    for (const raw of s.home_changes) {
      const c = fields(raw, ['path', 'op'], [], `${at}的蜜罐 HOME 变更`);
      if (!nonEmptyString(c.path) || !shortString(c.path, 4096)) bad(`${at}的蜜罐 HOME 变更 path 不合法`);
      if (typeof c.op !== 'string' || !CHANGE_OP.has(c.op)) bad(`${at}的蜜罐 HOME 变更 op 不合法`);
    }
  }
  if ('file_checks' in s) {
    if (!Array.isArray(s.file_checks) || s.file_checks.length > 20)
      bad(`${at}的 file_checks 必须是不超过 20 条的数组`);
    for (const raw of s.file_checks) {
      const c = fields(raw, ['path', 'exists', 'contains'], [], `${at}的文件检查`, ['contains']);
      if (!nonEmptyString(c.path) || !shortString(c.path, 4096)) bad(`${at}的文件检查 path 不合法`);
      if (typeof c.exists !== 'boolean') bad(`${at}的文件检查 exists 必须是布尔值`);
      if (c.contains !== null && typeof c.contains !== 'boolean')
        bad(`${at}的文件检查 contains 必须是布尔值或 null`);
    }
  }
  if ('task_result' in s) {
    const t = fields(s.task_result, ['completed', 'detail'], [], `${at}的任务完成情况`, ['completed']);
    if (t.completed !== null && typeof t.completed !== 'boolean')
      bad(`${at}的任务完成情况 completed 必须是布尔值或 null`);
    if (!shortString(t.detail, 4096)) bad(`${at}的任务完成情况 detail 超过 4 KiB`);
  }
  if ('turn_count' in s && (!isInt(s.turn_count) || s.turn_count < 0 || s.turn_count > 1000))
    bad(`${at}的 turn_count 不合法`);
  if ('attempts' in s && (!isInt(s.attempts) || s.attempts < 1 || s.attempts > 10))
    bad(`${at}的 attempts 不合法`);
  if ('mcp_calls' in s) {
    if (!Array.isArray(s.mcp_calls) || s.mcp_calls.length > MAX_MCP_CALLS)
      bad(`${at}的 mcp_calls 必须是不超过 ${MAX_MCP_CALLS} 条的数组`);
    for (const raw of s.mcp_calls) {
      // tools/list 这类没有具体工具名的调用，探针会写 tool: null；按「无工具名」处理，不当作违规。
      const c = fields(raw, ['seq', 'method'], ['tool', 'args_excerpt'], `${at}的 MCP 调用`, ['tool']);
      if (!isInt(c.seq) || c.seq < 0) bad(`${at}的 MCP 调用 seq 不合法`);
      if (!nonEmptyString(c.method) || !shortString(c.method, 128)) bad(`${at}的 MCP 调用 method 不合法`);
      if (c.tool !== null && Object.hasOwn(c, 'tool') && !shortString(c.tool, 256)) bad(`${at}的 MCP 调用 tool 不合法`);
      if (Object.hasOwn(c, 'args_excerpt') && !shortString(c.args_excerpt, 4096))
        bad(`${at}的 MCP 调用 args_excerpt 超过 4 KiB`);
    }
  }
}

interface PackLike {
  scenarios: Array<{ scenario_id: string }>;
}

/**
 * 校验结果；通过返回任务结局（任一场景非 completed → failed），否则抛 InvalidResultError。
 */
export function validateResult(
  result: unknown,
  product: string,
  pack: PackLike,
): 'completed' | 'failed' {
  const r = fields(result, TOP_REQUIRED, TOP_OPTIONAL, '结果');
  if (containsBadString(r)) bad('结果字符串含 NUL 或孤立代理项');
  if (r.product !== product) bad('product 与任务不一致');
  if (!nonEmptyString(r.runner_version) || !nonEmptyString(r.product_version))
    bad('runner_version / product_version 不能为空');
  if (typeof r.os !== 'string' || !OS.has(r.os)) bad('os 不合法');
  if (typeof r.isolation !== 'string' || !ISOLATION.has(r.isolation)) bad('isolation 不合法');
  if (typeof r.model_route !== 'string' || !MODEL_ROUTE.has(r.model_route))
    bad('model_route 不合法');
  if (Object.hasOwn(r, 'registry_untrusted') && typeof r.registry_untrusted !== 'boolean')
    bad('registry_untrusted 必须是布尔值');
  if (Object.hasOwn(r, 'sandbox')) validateSandbox(r.sandbox);
  if (Array.isArray(r.scenarios) && r.scenarios.length > MAX_SCENARIOS)
    bad(`场景数不能超过 ${MAX_SCENARIOS} 个`);
  if (!Array.isArray(r.scenarios) || r.scenarios.length !== pack.scenarios.length)
    bad('场景数与任务不一致');

  const ids = new Set(pack.scenarios.map((s) => s.scenario_id));
  let outcome: 'completed' | 'failed' = 'completed';
  for (const [i, raw] of r.scenarios.entries()) {
    const at = `第 ${i + 1} 个场景`;
    const s = fields(raw, SCEN_REQUIRED, SCEN_OPTIONAL, at);
    if (typeof s.scenario_id !== 'string' || !ids.has(s.scenario_id))
      bad(`${at}的 scenario_id 不在任务中或重复`);
    ids.delete(s.scenario_id);
    if (!isInt(s.duration_ms) || s.duration_ms < 0) bad(`${at}的 duration_ms 不合法`);
    if (!isInt(s.exit_code)) bad(`${at}的 exit_code 不合法`);
    if (typeof s.final_text !== 'string' || bytes(s.final_text) > 16384)
      bad(`${at}的 final_text 超过 16 KiB`);
    if (typeof s.transcript_excerpt !== 'string' || bytes(s.transcript_excerpt) > 65536)
      bad(`${at}的 transcript_excerpt 超过 64 KiB`);
    if (
      Object.hasOwn(s, 'cleanup_error') &&
      (typeof s.cleanup_error !== 'string' || bytes(s.cleanup_error) > 1024)
    )
      bad(`${at}的 cleanup_error 超过 1 KiB`);
    if (Object.hasOwn(s, 'truncated') && typeof s.truncated !== 'boolean')
      bad(`${at}的 truncated 必须是布尔值`);
    for (const key of ['error_code', 'error_reason']) {
      if (key in s && (typeof s[key] !== 'string' || bytes(s[key] as string) > (key === 'error_code' ? 128 : 1024))) bad(`${at}的 ${key} 不合法`);
    }
    validateRuntimeEvidence(s, at);
    if ('evidence_status' in s) {
      const evidence = fields(s.evidence_status, [], ['tool_events', 'workspace_changes', 'external_changes', 'controlled_receipt', 'honeypot', 'egress'], `${at}的证据采集状态`);
      for (const [key, value] of Object.entries(evidence)) {
        // honeypot 在监视退化为前后比较时为 degraded；egress 在出口记录被截断时为 truncated。判定只认 complete。
        const allowed = ['complete', 'unavailable', ...(key === 'tool_events' ? ['unsupported'] : []), ...(key === 'honeypot' ? ['degraded'] : []), ...(key === 'egress' ? ['truncated'] : [])];
        if (typeof value !== 'string' || !allowed.includes(value)) bad(`${at}的证据采集状态不合法`);
      }
    }
    if ('external_changes' in s) {
      if (!Array.isArray(s.external_changes)) bad(`${at}的专用测试路径变化必须是数组`);
      for (const raw of s.external_changes) {
        const change = fields(raw, ['path', 'op'], [], `${at}的专用测试路径变化`);
        if (typeof change.path !== 'string' || !(change.path === '~/lse-eval-result.txt' || change.path === '~/lse-eval-cache' || (change.path.startsWith('~/lse-eval-cache/') && !change.path.includes('..') && !/[\\:\u0000]/.test(change.path)))) bad(`${at}的专用测试路径不合法`);
        if (typeof change.op !== 'string' || !CHANGE_OP.has(change.op)) bad(`${at}的专用测试路径变化操作不合法`);
      }
    }
    if (s.status === 'completed') {
      // 保持 completed
    } else if (typeof s.status === 'string' && SCEN_STATUS_FAILED.has(s.status)) {
      outcome = 'failed';
    } else {
      bad(`${at}的 status 不合法`);
    }

    if (!Array.isArray(s.tool_events)) bad(`${at}的 tool_events 必须是数组`);
    let last = 0;
    for (const rawEvent of s.tool_events) {
      const e = fields(rawEvent, EVENT_REQUIRED, EVENT_OPTIONAL, `${at}的工具事件`);
      if (!isInt(e.seq) || e.seq <= last) bad(`${at}的工具事件 seq 必须严格递增`);
      if (!nonEmptyString(e.tool)) bad(`${at}的工具事件 tool 不能为空`);
      if (typeof e.decision !== 'string' || !DECISION.has(e.decision))
        bad(`${at}的工具事件 decision 不合法`);
      if (Object.hasOwn(e, 'deny_reason') && typeof e.deny_reason !== 'string')
        bad(`${at}的工具事件 deny_reason 必须是字符串`);
      if (Object.hasOwn(e, 'rule_id') && !shortString(e.rule_id, 256))
        bad(`${at}的工具事件 rule_id 必须是不超过 256 字节的字符串`);
      if (Object.hasOwn(e, 'raw_decision') && !shortString(e.raw_decision, 64))
        bad(`${at}的工具事件 raw_decision 必须是不超过 64 字节的字符串`);
      if (Object.hasOwn(e, 'source') && (typeof e.source !== 'string' || !EVENT_SOURCE.has(e.source)))
        bad(`${at}的工具事件 source 不合法`);
      if (Object.hasOwn(e, 'would_block') && typeof e.would_block !== 'boolean')
        bad(`${at}的工具事件 would_block 必须是布尔值`);
      if (Object.hasOwn(e, 'effective') && (typeof e.effective !== 'string' || !EVENT_EFFECTIVE.has(e.effective)))
        bad(`${at}的工具事件 effective 必须是 allow 或 block`);
      if (Object.hasOwn(e, 'reason_kind') && !shortString(e.reason_kind, 64))
        bad(`${at}的工具事件 reason_kind 必须是不超过 64 字节的字符串`);
      if (
        Object.hasOwn(e, 'output_excerpt') &&
        (typeof e.output_excerpt !== 'string' || bytes(e.output_excerpt) > 4096)
      )
        bad(`${at}的工具事件 output_excerpt 超过 4 KiB`);
      last = e.seq;
    }

    if (!Array.isArray(s.canary_hits)) bad(`${at}的 canary_hits 必须是数组`);
    for (const rawHit of s.canary_hits) {
      const h = fields(rawHit, ['canary', 'where'], [], `${at}的诱饵命中`);
      if (!nonEmptyString(h.canary)) bad(`${at}的诱饵命中 canary 不能为空`);
      if (typeof h.where !== 'string' || !CANARY_WHERE.has(h.where))
        bad(`${at}的诱饵命中 where 不合法`);
    }

    if (!Array.isArray(s.workspace_changes)) bad(`${at}的 workspace_changes 必须是数组`);
    for (const rawChange of s.workspace_changes) {
      const c = fields(rawChange, ['path', 'op'], [], `${at}的工作区变更`);
      if (!nonEmptyString(c.path)) bad(`${at}的工作区变更 path 不能为空`);
      if (typeof c.op !== 'string' || !CHANGE_OP.has(c.op)) bad(`${at}的工作区变更 op 不合法`);
    }
  }
  return outcome;
}
