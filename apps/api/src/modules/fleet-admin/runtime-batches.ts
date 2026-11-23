// 运行态测评的拆批：终端执行器对一个任务有整批 6 小时的上限，到点后整批结果作废（包括已经跑完的场景），
// 所以大任务必须拆成多个小任务依次执行。这里只做纯计算：怎么切、怎么截取场景包。
import { createHash } from 'node:crypto';
import {
  RUNTIME_AVG_SCENARIO_SECONDS,
  RUNTIME_JOB_WORST_CASE_SECONDS,
  RUNTIME_MAX_JOB_SCENARIOS,
  RUNTIME_SCENARIO_MARGIN_SECONDS,
} from '../../../../../packages/shared/src/runtime-eval.js';
import type { EndpointPack } from '../endpoint-evals/pack.js';

interface ScenarioRef {
  scenario_id: string;
  sample_id?: string;
  timeout_sec: number;
}

/** 服务端对单场景超时的校验上限（fleet-agent/checksum.ts：1–900）。场景没带超时时按它算，宁可多拆不可少算。 */
const MAX_SCENARIO_TIMEOUT_SECONDS = 900;

/** 一个场景的最坏耗时：跑满超时，再加建环境、清理、取证的余量。 */
const worstOf = (s: { timeout_sec: number }): number =>
  (Number.isFinite(s.timeout_sec) ? s.timeout_sec : MAX_SCENARIO_TIMEOUT_SECONDS) + RUNTIME_SCENARIO_MARGIN_SECONDS;

/** 一批场景的最坏耗时：各场景超时之和 + 每场景余量。拆批以它不超过 RUNTIME_JOB_WORST_CASE_SECONDS 为准。 */
export const worstCaseSeconds = (scenarios: Array<{ timeout_sec: number }>): number =>
  scenarios.reduce((sum, s) => sum + worstOf(s), 0);

/** 样本编号：优先用场景自带的 sample_id，缺失时取场景编号 `~` 之前的部分。 */
const sampleOf = (s: ScenarioRef): string => s.sample_id || s.scenario_id.split('~')[0] || s.scenario_id;

/** 同一个样本的所有运行：场景编号和它们加起来的最坏耗时。 */
interface SampleGroup {
  ids: string[];
  seconds: number;
}

/** 按样本把场景分组，保持顺序；同一样本的所有运行连在一起。 */
function groupBySample(scenarios: ScenarioRef[]): SampleGroup[] {
  const groups: SampleGroup[] = [];
  let lastSample: string | null = null;
  for (const s of scenarios) {
    const sample = sampleOf(s);
    if (sample !== lastSample) groups.push({ ids: [], seconds: 0 });
    const group = groups[groups.length - 1]!;
    group.ids.push(s.scenario_id);
    group.seconds += worstOf(s);
    lastSample = sample;
  }
  return groups;
}

/**
 * 贪心：在场景数不超过 limit、最坏耗时不超过 RUNTIME_JOB_WORST_CASE_SECONDS 的前提下尽量往一批里放整组；
 * 单组自己就超过其中一项时自成一批。
 */
function greedy(groups: SampleGroup[], limit: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let seconds = 0;
  for (const group of groups) {
    if (
      current.length &&
      (current.length + group.ids.length > limit || seconds + group.seconds > RUNTIME_JOB_WORST_CASE_SECONDS)
    ) {
      batches.push(current);
      current = [];
      seconds = 0;
    }
    current = [...current, ...group.ids];
    seconds += group.seconds;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * 把场景按样本整组切成若干批，保持原有顺序。每批同时满足两条：不超过 maxPerJob 个场景；
 * 最坏耗时（各场景超时之和 + 每场景 120 秒余量）不超过 5 小时，这样每个场景都跑满超时也到不了终端的 6 小时硬上限。
 * 同一个样本的所有运行（防护臂 × 重复次数）一定在同一批里，这样一个样本的 k/N 不会跨任务；
 * 单个样本自己就超过上限时自成一批，不丢场景。
 * 批数由「不超过上限」的贪心切法决定；再用刚好够用的最小数量上限重切一次，让各批大小接近、耗时相当，
 * 避免出现「28、28、28、28、8」这样最后一批很小的情况。重切时最坏耗时的约束照样生效。
 */
export function splitScenarioIds(scenarios: ScenarioRef[], maxPerJob: number = RUNTIME_MAX_JOB_SCENARIOS): string[][] {
  const groups = groupBySample(scenarios);
  const first = greedy(groups, maxPerJob);
  if (first.length <= 1) return first;
  const total = groups.reduce((sum, g) => sum + g.ids.length, 0);
  const widest = Math.max(...groups.map((g) => g.ids.length));
  for (let limit = Math.max(Math.ceil(total / first.length), widest); limit < maxPerJob; limit++) {
    const balanced = greedy(groups, limit);
    if (balanced.length <= first.length) return balanced;
  }
  return first;
}

/** 一批的预计耗时：与服务端其余位置同一口径（场景数 × 平均耗时，向上取整）。 */
export const batchEstimateSeconds = (scenarioCount: number): number => Math.ceil(scenarioCount * RUNTIME_AVG_SCENARIO_SECONDS);

/**
 * 按场景编号从完整场景包里截取一批：保持包内顺序，重算 digest，不改原包。
 * 有编号不在包里时直接报错，绝不静默少测。
 */
export function chunkPack(pack: EndpointPack, scenarioIds: string[]): EndpointPack {
  const wanted = new Set(scenarioIds);
  const picked = pack.scenarios.filter((s) => wanted.has(s.scenario_id));
  const missing = scenarioIds.filter((id) => !pack.scenarios.some((s) => s.scenario_id === id));
  if (missing.length) throw new Error(`场景包里没有这些场景：${missing.slice(0, 3).join('、')}`);
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(picked)).digest('hex')}`;
  return { ...pack, digest, scenarios: picked };
}
