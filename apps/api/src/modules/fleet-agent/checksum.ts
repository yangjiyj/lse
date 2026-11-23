// 终端测评任务 payload 规范化与 checksum（protocol-subset.md §6），以及场景包校验（§5.1）。
// 规范化结果必须与采集器 eval_job_checksum（Python json.dumps sort_keys/ensure_ascii=False）
// 和 AgentShield lseeval.Canonical 逐字节一致；改动前请先跑 test/fleet-agent-checksum.test.ts 的 7 组向量。
import { createHash } from 'node:crypto';

import { FLEET_LIVE_PRODUCTS, LIVE_RISK_TYPE_IDS } from '../../../../../packages/shared/src/fleet-live-eval.js';
import {
  RUNTIME_ARMS,
  RUNTIME_CHANNELS,
  RUNTIME_HARMS,
  RUNTIME_HOME_DECOYS,
  RUNTIME_MAX_SCENARIOS,
  RUNTIME_TEMPLATES,
  RUNTIME_VECTORS,
  RUNTIME_WORKSPACE_DECOYS,
} from '../../../../../packages/shared/src/runtime-eval.js';
import { MAX_PAYLOAD_CANONICAL_BYTES } from './config.js';
export const FLEET_PRODUCTS = FLEET_LIVE_PRODUCTS;
export type FleetProduct = (typeof FLEET_PRODUCTS)[number];

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 字符串是否为合法 UTF-16（无孤立代理项）；Python 端 encode('utf-8') 遇到孤立代理项会失败。 */
export function isWellFormedString(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

export function canonicalize(v: unknown): string {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('eval payload 只允许安全整数');
    return String(v);
  }
  if (typeof v === 'string') return quote(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return (
      '{' +
      Object.keys(o)
        .sort()
        .map((k) => quote(k) + ':' + canonicalize(o[k]))
        .join(',') +
      '}'
    );
  }
  throw new Error('不支持的类型');
}

function quote(s: string): string {
  if (!isWellFormedString(s)) throw new Error('孤立代理项');
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

export interface FleetJobPayload {
  product: string;
  scenario_pack: unknown;
  sink_base_url: string;
}

/** 只对 product / scenario_pack / sink_base_url 三个字段求和；job_id、deadline、checksum 不参与。 */
export function canonicalJobPayload(job: FleetJobPayload): string {
  return canonicalize({
    product: job.product,
    scenario_pack: job.scenario_pack,
    sink_base_url: job.sink_base_url,
  });
}

export const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

export const evalJobChecksum = (job: FleetJobPayload): string =>
  sha256Hex(Buffer.from(canonicalJobPayload(job), 'utf8'));

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** 任意字符串（含键名）含 NUL 或孤立代理项即返回 true。迭代实现，避免深层嵌套栈溢出。 */
export function containsBadString(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.includes('\u0000') || !isWellFormedString(v)) return true;
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (isObject(v)) {
      for (const [k, item] of Object.entries(v)) {
        if (k.includes('\u0000') || !isWellFormedString(k)) return true;
        stack.push(item);
      }
    }
  }
  return false;
}

/** fixture 路径：非空、相对路径、不含 `..` 段、`\`、`:`、NUL。 */
function fixturePathError(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return 'fixture 路径不能为空';
  if (path.startsWith('/')) return 'fixture 路径不能是绝对路径';
  if (path.includes('\\') || path.includes(':') || path.includes('\u0000'))
    return 'fixture 路径含非法字符';
  if (path.split('/').some((seg) => seg === '..')) return 'fixture 路径不能含 ..';
  return null;
}

/** 运行态测评 v2 的场景包 id；其余 pack_id（含 v1）走原有校验，行为不变。 */
export const RUNTIME_PACK_ID = 'endpoint-agent-v2';
/** v2 单个场景序列化（canonical）后的字节上限。 */
export const RUNTIME_SCENARIO_MAX_BYTES = 16 * 1024;

const RUNTIME_MCP_KINDS = ['poisoned_description', 'poisoned_result', 'rug_pull', 'shadow_tool', 'benign'];
const RUNTIME_DANGER_KINDS = ['read_decoy', 'egress_to', 'sink_received', 'cmd_matches', 'path_changed', 'wrote_text'];
const RUNTIME_CHANGE_OPS = ['delete', 'modify', 'create'];
const RUNTIME_SLOT_KEY = /^[a-z_]{1,40}$/;
const RUNTIME_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const inList = (list: readonly string[], v: unknown): boolean => typeof v === 'string' && list.includes(v);
const stringList = (v: unknown, max: number, itemMaxBytes: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && byteLength(x) <= itemMaxBytes);

/** checks / expect.files 的路径：相对工作区，或 ~/ 开头指蜜罐 HOME；不含 ..、反斜杠、冒号、NUL。 */
function runtimePathError(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return '路径不能为空';
  if (path.startsWith('/')) return '路径不能是绝对路径';
  if (path.includes('\\') || path.includes(':') || path.includes('\u0000')) return '路径含非法字符';
  if (path.split('/').some((seg) => seg === '..')) return '路径不能含 ..';
  if (path === '~' || path === '~/') return '路径不能为空';
  return null;
}

function runtimeMcpError(mcp: unknown, at: string): string | null {
  if (!isObject(mcp)) return `${at}的 mcp 必须是对象`;
  if (!Array.isArray(mcp.servers) || mcp.servers.length > 4) return `${at}的 mcp.servers 必须是不超过 4 项的数组`;
  for (const server of mcp.servers) {
    if (!isObject(server)) return `${at}的 mcp 服务必须是对象`;
    if (typeof server.name !== 'string' || !server.name || byteLength(server.name) > 64) return `${at}的 mcp 服务名必须为 1–64 字节`;
    if (!inList(RUNTIME_MCP_KINDS, server.kind)) return `${at}的 mcp 服务 kind 不合法`;
    if (!Array.isArray(server.tools) || server.tools.length > 8) return `${at}的 mcp 服务工具数必须不超过 8 个`;
    if (server.poison !== undefined && (typeof server.poison !== 'string' || byteLength(server.poison) > 8192)) return `${at}的 mcp poison 必须是不超过 8 KiB 的字符串`;
    if (server.mutate_after_calls !== undefined && !isInt(server.mutate_after_calls, 1, 1000)) return `${at}的 mcp mutate_after_calls 必须为 1–1000 的整数`;
    for (const tool of server.tools) {
      if (!isObject(tool)) return `${at}的 mcp 工具必须是对象`;
      if (typeof tool.name !== 'string' || !tool.name || byteLength(tool.name) > 128) return `${at}的 mcp 工具名必须为 1–128 字节`;
      if (typeof tool.description !== 'string' || byteLength(tool.description) > 8192) return `${at}的 mcp 工具描述必须是不超过 8 KiB 的字符串`;
      if (!isObject(tool.input_schema)) return `${at}的 mcp 工具 input_schema 必须是对象`;
      if (typeof tool.result !== 'string' && !isObject(tool.result)) return `${at}的 mcp 工具 result 必须是字符串或对象`;
    }
  }
  return null;
}

function runtimeDangerError(danger: unknown, at: string): string | null {
  if (!Array.isArray(danger) || danger.length > 20) return `${at}的 danger 必须是不超过 20 项的数组`;
  for (const d of danger) {
    if (!isObject(d) || !inList(RUNTIME_DANGER_KINDS, d.kind)) return `${at}的 danger 项不合法`;
    const text = (key: string, max: number) => typeof d[key] === 'string' && !!d[key] && byteLength(d[key] as string) <= max;
    if (d.kind === 'read_decoy' && !text('decoy', 64)) return `${at}的 danger.read_decoy 缺少 decoy`;
    if (d.kind === 'egress_to' && !text('host', 253)) return `${at}的 danger.egress_to 缺少 host`;
    if (d.kind === 'cmd_matches' && !text('pattern', 500)) return `${at}的 danger.cmd_matches 的 pattern 必须为 1–500 字节`;
    if (d.kind === 'path_changed' && (!text('path', 1024) || !inList(RUNTIME_CHANGE_OPS, d.op))) return `${at}的 danger.path_changed 不合法`;
    if (d.kind === 'wrote_text' && (!text('path', 1024) || typeof d.contains !== 'string' || byteLength(d.contains) > 2048)) return `${at}的 danger.wrote_text 不合法`;
  }
  return null;
}

/** 校验 v2 场景附加字段（均可选）；未知字段仍放行，与 v1 风格一致。 */
function runtimeScenarioError(s: Record<string, unknown>, at: string): string | null {
  if (s.vector !== undefined && !inList(RUNTIME_VECTORS, s.vector)) return `${at}的 vector 不合法`;
  if (s.channel !== undefined && !inList(RUNTIME_CHANNELS, s.channel)) return `${at}的 channel 不合法`;
  if (s.harm !== undefined && !inList(RUNTIME_HARMS, s.harm)) return `${at}的 harm 不合法`;
  if (s.sample_id !== undefined && (typeof s.sample_id !== 'string' || !s.sample_id || byteLength(s.sample_id) > 200)) return `${at}的 sample_id 必须为 1–200 字节的字符串`;
  if (s.repeat_index !== undefined && !isInt(s.repeat_index, 0, 99)) return `${at}的 repeat_index 必须为 0–99 的整数`;
  if (s.protection !== undefined && !inList(RUNTIME_ARMS, s.protection)) return `${at}的 protection 必须是 observe 或 enforce`;
  if (s.template !== undefined && !inList(RUNTIME_TEMPLATES, s.template)) return `${at}的 template 不合法`;
  if (s.slots !== undefined) {
    if (!isObject(s.slots)) return `${at}的 slots 必须是对象`;
    const entries = Object.entries(s.slots);
    if (entries.length > 40) return `${at}的 slots 不能超过 40 条`;
    for (const [key, value] of entries) {
      if (!RUNTIME_SLOT_KEY.test(key)) return `${at}的 slots 键名只允许小写字母和下划线（1–40 个字符）`;
      if (typeof value !== 'string' || byteLength(value) > 8192) return `${at}的 slots 值必须是不超过 8 KiB 的字符串`;
    }
  }
  if (s.turns !== undefined) {
    if (!Array.isArray(s.turns) || s.turns.length < 1 || s.turns.length > 4) return `${at}的 turns 必须为 1–4 条`;
    if (s.turns.some((t) => typeof t !== 'string' || byteLength(t) < 1 || byteLength(t) > 8192)) return `${at}的每条 turns 必须为 1–8192 字节`;
  }
  if (s.decoys !== undefined) {
    if (!isObject(s.decoys)) return `${at}的 decoys 必须是对象`;
    const extra = Object.keys(s.decoys).find((k) => k !== 'workspace' && k !== 'home');
    if (extra) return `${at}的 decoys 含未知字段 ${extra}`;
    for (const [key, allowed] of [['workspace', RUNTIME_WORKSPACE_DECOYS], ['home', RUNTIME_HOME_DECOYS]] as const) {
      const names = s.decoys[key];
      if (names === undefined) continue;
      if (!Array.isArray(names) || names.length > 16 || names.some((n) => !inList(allowed, n))) return `${at}的 decoys.${key} 含不认识的蜜标名`;
    }
  }
  if (s.decoy_markers !== undefined) {
    if (!isObject(s.decoy_markers)) return `${at}的 decoy_markers 必须是对象`;
    const entries = Object.entries(s.decoy_markers);
    if (entries.length > 40) return `${at}的 decoy_markers 不能超过 40 条`;
    for (const [name, value] of entries) {
      if (!name || byteLength(name) > 64) return `${at}的 decoy_markers 键名必须为 1–64 字节`;
      if (typeof value !== 'string' || !value.startsWith('LSE-CANARY-') || byteLength(value) > 200) return `${at}的 decoy_markers 值必须以 LSE-CANARY- 开头`;
    }
  }
  if (s.mcp !== undefined) {
    const error = runtimeMcpError(s.mcp, at);
    if (error) return error;
  }
  if (s.expect !== undefined) {
    if (!isObject(s.expect)) return `${at}的 expect 必须是对象`;
    const { final_contains: finalContains, files, run } = s.expect;
    if (finalContains !== undefined && !stringList(finalContains, 20, 1024)) return `${at}的 expect.final_contains 必须是不超过 20 项的字符串数组`;
    if (files !== undefined) {
      if (!Array.isArray(files) || files.length > 20) return `${at}的 expect.files 必须是不超过 20 项的数组`;
      for (const f of files) {
        if (!isObject(f)) return `${at}的 expect.files 项必须是对象`;
        const pathError = runtimePathError(f.path);
        if (pathError) return `${at}的 expect.files ${pathError}`;
        if (typeof f.contains !== 'string' || byteLength(f.contains) > 8192) return `${at}的 expect.files 的 contains 必须是不超过 8 KiB 的字符串`;
      }
    }
    if (run !== undefined && (!Array.isArray(run) || run.length < 1 || run.length > 8 || run.some((x) => typeof x !== 'string' || !x || x.length > 200))) return `${at}的 expect.run 必须是 1–8 项、每项不超过 200 字符的字符串数组`;
  }
  if (s.checks !== undefined) {
    if (!Array.isArray(s.checks) || s.checks.length > 20) return `${at}的 checks 必须是不超过 20 项的数组`;
    for (const c of s.checks) {
      if (!isObject(c)) return `${at}的 checks 项必须是对象`;
      const pathError = runtimePathError(c.path);
      if (pathError) return `${at}的 checks ${pathError}`;
      if (c.contains !== undefined && (typeof c.contains !== 'string' || byteLength(c.contains) > 8192)) return `${at}的 checks 的 contains 必须是不超过 8 KiB 的字符串`;
    }
  }
  if (s.allow_hosts !== undefined && (!Array.isArray(s.allow_hosts) || s.allow_hosts.length > 10 || s.allow_hosts.some((h) => typeof h !== 'string' || !RUNTIME_HOST.test(h)))) return `${at}的 allow_hosts 必须是不超过 10 项的主机名数组`;
  if (s.danger !== undefined) {
    const error = runtimeDangerError(s.danger, at);
    if (error) return error;
  }
  if (s.explain !== undefined && (typeof s.explain !== 'string' || byteLength(s.explain) > 4096)) return `${at}的 explain 必须是不超过 4 KiB 的字符串`;
  if (s.refs !== undefined && !stringList(s.refs, 10, 100)) return `${at}的 refs 必须是不超过 10 项的字符串数组`;
  return null;
}

/**
 * 场景包校验（对齐 AgentShield lseeval.Validate，规格 §5.1）。
 * 通过返回 null，否则返回中文原因。未知字段放行（仍参与 checksum）。
 * pack_id 为 endpoint-agent-v2 时场景数上限放宽到 240，并校验 v2 附加字段；其余包行为不变。
 */
export function validateScenarioPack(pack: unknown): string | null {
  if (!isObject(pack)) return '场景包必须是对象';
  if (containsBadString(pack)) return '场景包字符串不能含 NUL 或孤立代理项';
  if (typeof pack.pack_id !== 'string' || !pack.pack_id) return 'pack_id 不能为空';
  if (typeof pack.digest !== 'string') return 'digest 必须是字符串';
  const runtime = pack.pack_id === RUNTIME_PACK_ID;
  const maxScenarios = runtime ? RUNTIME_MAX_SCENARIOS : 12;
  const scenarios = pack.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > maxScenarios)
    return `场景数必须为 1–${maxScenarios} 个`;
  if (pack.riskTypes !== undefined && (!Array.isArray(pack.riskTypes) || !pack.riskTypes.length || pack.riskTypes.some((r) => !(LIVE_RISK_TYPE_IDS as readonly unknown[]).includes(r)))) return '风险类型不合法';
  const ids = new Set<string>();
  for (const [i, s] of scenarios.entries()) {
    const at = `第 ${i + 1} 个场景`;
    if (!isObject(s)) return `${at}必须是对象`;
    if (typeof s.scenario_id !== 'string' || !s.scenario_id) return `${at}的 scenario_id 不能为空`;
    if (ids.has(s.scenario_id)) return `${at}的 scenario_id 重复`;
    ids.add(s.scenario_id);
    if (s.risk_type !== undefined && !(LIVE_RISK_TYPE_IDS as readonly unknown[]).includes(s.risk_type)) return `${at}的风险类型不合法`;
    if (Array.isArray(pack.riskTypes) && !pack.riskTypes.includes(s.risk_type)) return `${at}不在所选风险类型中`;
    if (s.external_fixtures !== undefined && (!Array.isArray(s.external_fixtures) || s.external_fixtures.some((f) => !isObject(f) || typeof f.path !== 'string' || !/^~\/lse-eval-(?:cache\/keep\.txt|result\.txt)$/.test(f.path) || typeof f.content !== 'string' || byteLength(f.content) > 65536))) return `${at}的专用测试路径不合法`;
    if (typeof s.title !== 'string') return `${at}的 title 必须是字符串`;
    if (typeof s.prompt !== 'string' || byteLength(s.prompt) < 1 || byteLength(s.prompt) > 8192)
      return `${at}的 prompt 必须为 1–8192 字节`;
    if (!isInt(s.max_turns, 1, 50)) return `${at}的 max_turns 必须为 1–50 的整数`;
    if (!isInt(s.timeout_sec, 1, 900)) return `${at}的 timeout_sec 必须为 1–900 的整数`;
    if (!Array.isArray(s.fixtures)) return `${at}的 fixtures 必须是数组（不能为 null）`;
    if (!Array.isArray(s.canaries)) return `${at}的 canaries 必须是数组（不能为 null）`;
    for (const f of s.fixtures) {
      if (!isObject(f)) return `${at}的 fixture 必须是对象`;
      const pathError = fixturePathError(f.path);
      if (pathError) return `${at}的${pathError}`;
      if (typeof f.content !== 'string' || byteLength(f.content) > 64 * 1024)
        return `${at}的 fixture 内容必须是不超过 64 KiB 的字符串`;
    }
    for (const c of s.canaries) {
      if (typeof c !== 'string' || !c) return `${at}的 canary 必须是非空字符串`;
    }
    if (runtime) {
      const runtimeError = runtimeScenarioError(s, at);
      if (runtimeError) return runtimeError;
      let size: number;
      try {
        size = byteLength(canonicalize(s));
      } catch {
        return `${at}含不支持的数值或类型，无法序列化`;
      }
      if (size > RUNTIME_SCENARIO_MAX_BYTES)
        return `${at}序列化后 ${size} 字节，超过单场景 16 KiB 上限，请把大文件交给项目模板`;
    }
  }
  return null;
}

export class FleetPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetPayloadError';
  }
}

function validateSinkBaseUrl(value: string): string | null {
  if (value.length > 2048) return 'sink_base_url 过长';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'sink_base_url 不是合法 URL';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'sink_base_url 只允许 http/https';
  if (url.username || url.password) return 'sink_base_url 不能含凭据';
  return null;
}

/**
 * 管理接口创建任务时使用：校验后生成 canonical 原文（存 FleetEvalJob.payloadCanonical）与 checksum。
 * 校验失败抛 FleetPayloadError（中文原因）。
 */
export function buildJobPayload(
  product: string,
  scenarioPack: unknown,
  sinkBaseUrl: string,
): { canonical: string; checksum: string } {
  if (!(FLEET_PRODUCTS as readonly string[]).includes(product))
    throw new FleetPayloadError('所选智能体产品不支持真机测评');
  const packError = validateScenarioPack(scenarioPack);
  if (packError) throw new FleetPayloadError(packError);
  if (typeof sinkBaseUrl !== 'string') throw new FleetPayloadError('sink_base_url 必须是字符串');
  const sinkError = validateSinkBaseUrl(sinkBaseUrl);
  if (sinkError) throw new FleetPayloadError(sinkError);
  const canonical = canonicalJobPayload({
    product,
    scenario_pack: scenarioPack,
    sink_base_url: sinkBaseUrl,
  });
  const canonicalBytes = byteLength(canonical);
  if (canonicalBytes > MAX_PAYLOAD_CANONICAL_BYTES)
    throw new FleetPayloadError(
      `任务载荷规范化后 ${canonicalBytes} 字节，超过 ${MAX_PAYLOAD_CANONICAL_BYTES} 字节（1 MiB）上限，请缩小范围（减少场景、样本或重复次数）`,
    );
  return { canonical, checksum: sha256Hex(Buffer.from(canonical, 'utf8')) };
}
