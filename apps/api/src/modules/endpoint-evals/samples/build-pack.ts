import { createHash, randomBytes } from 'node:crypto';
import type { EndpointPack, EndpointScenario } from '../pack.js';
import { ALL_SAMPLES } from './registry.js';
import {
  RUNTIME_ARMS, RUNTIME_AVG_SCENARIO_SECONDS, RUNTIME_MAX_SCENARIOS, RUNTIME_TEMPLATES, RUNTIME_VECTORS,
  type RuntimeArm, type RuntimeSample, type RuntimeTemplate, type RuntimeTier, type RuntimeVector,
} from './types.js';

export interface BuildRuntimePackOptions {
  tier: RuntimeTier;
  vectors?: RuntimeVector[];
  arms: RuntimeArm[];
  repeat: number;
  templates: RuntimeTemplate[];
  sampleIds?: string[];
  sinkBaseUrl: string;
  samples?: RuntimeSample[];
}
type EstimateOptions = Omit<BuildRuntimePackOptions, 'sinkBaseUrl'>;

const PER_TIER: Record<RuntimeTier, number> = { quick: 1, standard: 5, full: Number.POSITIVE_INFINITY };
const ARM_TITLE: Record<RuntimeArm, string> = { observe: '防护关', enforce: '防护开' };
const SINK = '{{SINK}}';

export function listRuntimeSamples(filter: { vectors?: RuntimeVector[]; templates?: RuntimeTemplate[] } = {}): RuntimeSample[] {
  return ALL_SAMPLES.filter((s) => (!filter.vectors || filter.vectors.includes(s.vector))
    && (!filter.templates || s.template === 'any' || filter.templates.includes(s.template)));
}

/** 一个样本在给定模板范围内展开成若干 (样本, 模板)；'any' 对每个所选模板各展开一份。 */
function expand(sample: RuntimeSample, templates: RuntimeTemplate[]): Array<{ sample: RuntimeSample; template: RuntimeTemplate }> {
  if (sample.template === 'any') return templates.map((template) => ({ sample, template }));
  return templates.includes(sample.template) ? [{ sample, template: sample.template }] : [];
}

function pick(opts: EstimateOptions): Array<{ sample: RuntimeSample; template: RuntimeTemplate }> {
  const samples = opts.samples ?? ALL_SAMPLES;
  const vectors = opts.vectors ?? [...RUNTIME_VECTORS];
  const wanted = opts.sampleIds ? new Set(opts.sampleIds) : null;
  const chosen: Array<{ sample: RuntimeSample; template: RuntimeTemplate }> = [];
  for (const vector of RUNTIME_VECTORS) {
    if (!vectors.includes(vector)) continue;
    const pool = samples.filter((s) => s.vector === vector && (!wanted || wanted.has(s.id)))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // 先按模板过滤再数个数：否则排在前面、但模板不在所选范围内的样本会占掉名额，整类被丢掉。
    let taken = 0;
    for (const sample of pool) {
      if (!wanted && taken >= PER_TIER[opts.tier]) break;
      const expanded = expand(sample, opts.templates);
      if (!expanded.length) continue;
      chosen.push(...expanded);
      taken++;
    }
  }
  if (wanted) {
    const known = new Set(samples.map((s) => s.id));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`样本不存在：${unknown.slice(0, 5).join('、')}`);
  }
  return chosen;
}

export function listRuntimeSelections(opts: EstimateOptions): Array<{ sample: RuntimeSample; template: RuntimeTemplate }> {
  checkOptions(opts);
  return pick(opts);
}

function checkOptions(opts: EstimateOptions): void {
  if (!RUNTIME_TIERS_OK(opts.tier)) throw new Error('档位不合法');
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1 || opts.repeat > 5) throw new Error('重复次数必须是 1 到 5 的整数');
  if (!opts.arms.length || opts.arms.some((a) => !RUNTIME_ARMS.includes(a)) || new Set(opts.arms).size !== opts.arms.length)
    throw new Error('防护臂不合法或为空');
  if (!opts.templates.length || opts.templates.some((t) => !RUNTIME_TEMPLATES.includes(t))) throw new Error('项目模板不合法或为空');
}
const RUNTIME_TIERS_OK = (t: string) => t === 'quick' || t === 'standard' || t === 'full';

export function estimateRuntimePack(opts: EstimateOptions): { scenarios: number; seconds: number } {
  checkOptions(opts);
  const scenarios = pick(opts).length * opts.arms.length * opts.repeat;
  return { scenarios, seconds: Math.ceil(scenarios * RUNTIME_AVG_SCENARIO_SECONDS) };
}

function fill(text: string, sink: string): string {
  return text.split(SINK).join(sink);
}
/** 服务端对 timeout_sec 的校验上限（fleet-agent/checksum.ts：1–900）。 */
const CREDENTIAL_READ_TIMEOUT_SEC = 900;

/**
 * 单场景超时（秒）。现网真机 25 次运行实测：单轮平均 159 秒、P90 285 秒，读凭据类约 320 秒且有一次到 421 秒被截断，
 * 原来的 200 秒会把正常在做事的场景判成超时。基础 600 秒，多轮每多一轮加 120 秒，带 MCP 加 60 秒，上限 900。
 */
function timeoutFor(sample: RuntimeSample): number {
  const turns = sample.turns?.length ?? 1;
  // 读凭据类任务要先检查目标目录、备份、权限再对比，现网 12 次实测 384–601 秒，其中 2 次被 600 秒截断，
  // 整个任务因此判失败。这类直接用服务端允许的最大值。
  if (sample.harm === 'credential_read') return CREDENTIAL_READ_TIMEOUT_SEC;
  return Math.min(900, 600 + (turns - 1) * 120 + (sample.mcp ? 60 : 0));
}
/**
 * 智能体最多可用的对话轮次（claude 的 --max-turns）。真机复现：修缺陷类任务（读代码、写测试、跑测试、lint、检查改动）
 * 实测 20 多次工具调用，上限 12 时会在中途以非零码退出，被误判为失败；上限 30 时正常完成。基础 30，多轮每多一轮加 10，上限 50。
 */
function turnsFor(sample: RuntimeSample): number {
  const turns = sample.turns?.length ?? 1;
  return Math.min(50, 30 + (turns - 1) * 10);
}

function validateSink(sinkBaseUrl: string): string {
  const sink = new URL(sinkBaseUrl);
  if (!['http:', 'https:'].includes(sink.protocol) || sink.username || sink.password || sink.search || sink.hash)
    throw new Error('测试接收地址无效或含凭据');
  return sink.href.replace(/\/$/, '');
}

export function buildRuntimePack(opts: BuildRuntimePackOptions): EndpointPack {
  const sink = validateSink(opts.sinkBaseUrl);
  checkOptions(opts);
  const picked = pick(opts);
  const total = picked.length * opts.arms.length * opts.repeat;
  if (total < 1) throw new Error('所选范围内没有可用样本，请调整类别、模板或样本');
  if (total > RUNTIME_MAX_SCENARIOS)
    throw new Error(`场景数 ${total} 超过上限 ${RUNTIME_MAX_SCENARIOS}，请减少类别、样本、重复次数或防护臂`);
  const scenarios: EndpointScenario[] = [];
  for (const { sample, template } of picked) {
    const sampleId = picked.filter((p) => p.sample === sample).length > 1 ? `${sample.id}.${template.split('-')[0]}` : sample.id;
    for (const arm of opts.arms) {
      for (let k = 0; k < opts.repeat; k++) {
        const markers: Record<string, string> = {};
        for (const name of [...sample.decoys.workspace, ...sample.decoys.home]) markers[name] = `LSE-CANARY-${randomBytes(16).toString('hex')}`;
        const slots = Object.fromEntries(Object.entries(sample.slots).map(([key, value]) => [key, fill(value, sink)]));
        const title = `${sample.title}（${ARM_TITLE[arm]}${opts.repeat > 1 ? `，第 ${k + 1} 次` : ''}）`;
        scenarios.push({
          scenario_id: `${sampleId}~${arm}~r${k}`, title, prompt: fill(sample.prompt, sink),
          fixtures: [], canaries: Object.values(markers), max_turns: turnsFor(sample), timeout_sec: timeoutFor(sample),
          vector: sample.vector, ...(sample.channel ? { channel: sample.channel } : {}), harm: sample.harm,
          sample_id: sampleId, repeat_index: k, protection: arm, template, slots,
          ...(sample.turns ? { turns: sample.turns.map((t) => fill(t, sink)) } : {}),
          decoys: sample.decoys, decoy_markers: markers,
          ...(sample.mcp ? { mcp: JSON.parse(fill(JSON.stringify(sample.mcp), sink)) } : {}),
          ...(sample.expect ? { expect: sample.expect } : {}),
          danger: sample.danger.map((d) => (d.kind === 'egress_to' ? { ...d, host: fill(d.host, sink) } : d)),
          explain: sample.explain, refs: sample.refs,
        } as EndpointScenario);
      }
    }
  }
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(scenarios)).digest('hex')}`;
  return { pack_id: 'endpoint-agent-v2', digest, scenarios } as unknown as EndpointPack;
}
