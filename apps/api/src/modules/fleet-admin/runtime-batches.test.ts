import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RUNTIME_AVG_SCENARIO_SECONDS,
  RUNTIME_JOB_WORST_CASE_SECONDS,
  RUNTIME_MAX_ESTIMATE_SECONDS,
  RUNTIME_MAX_JOB_SCENARIOS,
  RUNTIME_SCENARIO_MARGIN_SECONDS,
} from '../../../../../packages/shared/src/runtime-eval.js';
import { buildEndpointPack, buildScriptedPack, type EndpointPack } from '../endpoint-evals/pack.js';
import { validateScenarioPack } from '../fleet-agent/checksum.js';
import { batchEstimateSeconds, chunkPack, splitScenarioIds, worstCaseSeconds } from './runtime-batches.js';

/**
 * 每个样本 arms×repeat 个场景，id 形如 sample-03~observe~r1，与 buildRuntimePack 一致。
 * 超时默认取 60 秒：这样最坏耗时远不到预算，下面只验证数量上限的用例不受时间约束影响。
 */
function scenarios(samples: number, runsPerSample: number, timeoutSec = 60) {
  const out: Array<{ scenario_id: string; sample_id: string; timeout_sec: number }> = [];
  for (let s = 0; s < samples; s++)
    for (let r = 0; r < runsPerSample; r++) {
      const sample = `sample-${String(s).padStart(2, '0')}`;
      out.push({ scenario_id: `${sample}~${r % 2 ? 'enforce' : 'observe'}~r${Math.floor(r / 2)}`, sample_id: sample, timeout_sec: timeoutSec });
    }
  return out;
}
/** 一批场景编号对应的最坏耗时。 */
const worstOf = (ids: string[], all: Array<{ scenario_id: string; timeout_sec: number }>) =>
  worstCaseSeconds(all.filter((s) => ids.includes(s.scenario_id)));

// 平均耗时按现网实测改为 300 秒后，30 个场景的平均估算是 2.5 小时，对 6 小时上限留 2 倍以上余量；
// 真正兜住最坏情况的是下面「每批最坏耗时不超过 5 小时」那组约束。
test('单个任务的场景数上限留足余量：按平均耗时估算远低于终端 6 小时整批上限', () => {
  assert.ok(RUNTIME_MAX_JOB_SCENARIOS >= 10 && RUNTIME_MAX_JOB_SCENARIOS <= 40);
  const worst = RUNTIME_MAX_JOB_SCENARIOS * RUNTIME_AVG_SCENARIO_SECONDS;
  assert.ok(worst * 2 < RUNTIME_MAX_ESTIMATE_SECONDS, `单批预计 ${worst} 秒，余量不足 2 倍`);
});

test('120 个场景整样本切成 5 批，每批不超过上限、大小均衡，顺序不变', () => {
  const all = scenarios(30, 4);
  const batches = splitScenarioIds(all);
  // 每个样本 4 次运行且不拆开：一批最多 7 个样本（28 个场景），所以至少 5 批
  assert.equal(batches.length, 5);
  for (const b of batches) assert.ok(b.length <= RUNTIME_MAX_JOB_SCENARIOS);
  const sizes = batches.map((b) => b.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 4, `批大小不均衡：${sizes.join(',')}`);
  assert.deepEqual(batches.flat(), all.map((s) => s.scenario_id));
});

test('不超过上限时不拆，仍是一批', () => {
  const all = scenarios(5, 4);
  assert.equal(splitScenarioIds(all).length, 1);
});

test('同一个样本的所有运行不会被拆到两批里', () => {
  const all = scenarios(7, 6); // 42 个场景，每个样本 6 次
  const batches = splitScenarioIds(all);
  assert.ok(batches.length >= 2);
  const where = new Map<string, number>();
  batches.forEach((ids, index) => {
    for (const id of ids) {
      const sample = id.split('~')[0]!;
      assert.ok(!where.has(sample) || where.get(sample) === index, `${sample} 被拆到多批`);
      where.set(sample, index);
    }
  });
});

test('单个样本的运行数本身超过上限时自成一批，不丢场景', () => {
  const big = scenarios(1, RUNTIME_MAX_JOB_SCENARIOS + 5);
  const batches = splitScenarioIds([...scenarios(2, 4), ...big.map((s) => ({ ...s, sample_id: 'huge' }))]);
  assert.deepEqual(batches.flat().length, 8 + RUNTIME_MAX_JOB_SCENARIOS + 5);
});

test('每一批的预计耗时都低于单任务上限', () => {
  for (const b of splitScenarioIds(scenarios(60, 4))) assert.ok(batchEstimateSeconds(b.length) <= RUNTIME_MAX_ESTIMATE_SECONDS);
});

test('没有场景时返回空，不抛错', () => {
  assert.deepEqual(splitScenarioIds([]), []);
});

test('最坏耗时预算：每批 5 小时，每个场景另留 120 秒，比终端 6 小时硬上限少 1 小时', () => {
  assert.equal(RUNTIME_JOB_WORST_CASE_SECONDS, 5 * 3600);
  assert.equal(RUNTIME_SCENARIO_MARGIN_SECONDS, 120);
  assert.ok(RUNTIME_JOB_WORST_CASE_SECONDS < RUNTIME_MAX_ESTIMATE_SECONDS);
});

test('最坏耗时 = 各场景超时之和 + 每场景 120 秒余量', () => {
  assert.equal(worstCaseSeconds([]), 0);
  assert.equal(worstCaseSeconds([{ timeout_sec: 600 }, { timeout_sec: 900 }]), 600 + 900 + 2 * 120);
});

test('场景没带超时时按服务端允许的最大值 900 秒算，不当成 0', () => {
  assert.equal(worstCaseSeconds([{} as { timeout_sec: number }]), 900 + 120);
});

test('超时 900 秒的场景：30 个不超数量上限也必须拆，每批最坏耗时不超过 5 小时', () => {
  // 每个场景 900 + 120 = 1020 秒，5 小时最多放 17 个；30 个按数量本来是一批，最坏要跑 8.5 小时
  const all = scenarios(30, 1, 900);
  const batches = splitScenarioIds(all);
  assert.equal(batches.length, 2);
  for (const b of batches) {
    assert.ok(b.length <= 17, `一批 ${b.length} 个场景`);
    assert.ok(worstOf(b, all) <= RUNTIME_JOB_WORST_CASE_SECONDS);
  }
  assert.deepEqual(batches.flat(), all.map((s) => s.scenario_id));
});

test('边界：最坏耗时刚好 5 小时放得下，多一个场景就拆', () => {
  // 超时 600 秒：每个场景 720 秒，25 个刚好 18000 秒
  const fits = scenarios(25, 1, 600);
  assert.equal(worstCaseSeconds(fits), RUNTIME_JOB_WORST_CASE_SECONDS);
  assert.equal(splitScenarioIds(fits).length, 1);
  const over = scenarios(26, 1, 600);
  const batches = splitScenarioIds(over);
  assert.equal(batches.length, 2);
  for (const b of batches) assert.ok(worstOf(b, over) <= RUNTIME_JOB_WORST_CASE_SECONDS);
});

test('超时很短时仍受 30 个场景的数量上限约束', () => {
  const all = scenarios(31, 1, 60);
  assert.ok(worstCaseSeconds(all) < RUNTIME_JOB_WORST_CASE_SECONDS);
  const batches = splitScenarioIds(all);
  assert.equal(batches.length, 2);
  for (const b of batches) assert.ok(b.length <= RUNTIME_MAX_JOB_SCENARIOS);
});

test('超时长短混合时按实际之和计算', () => {
  // 10 个 900 秒 + 20 个 600 秒 = 10200 + 14400 = 24600 秒，数量刚好 30 个
  const all = [
    ...scenarios(10, 1, 900),
    ...scenarios(20, 1, 600).map((s) => ({ ...s, scenario_id: `mix-${s.scenario_id}`, sample_id: `mix-${s.sample_id}` })),
  ];
  const batches = splitScenarioIds(all);
  assert.ok(batches.length >= 2);
  for (const b of batches) {
    assert.ok(b.length <= RUNTIME_MAX_JOB_SCENARIOS);
    assert.ok(worstOf(b, all) <= RUNTIME_JOB_WORST_CASE_SECONDS, `一批最坏 ${worstOf(b, all)} 秒`);
  }
  assert.deepEqual(batches.flat(), all.map((s) => s.scenario_id));
});

test('按时间拆批时同一个样本的所有运行仍在同一批', () => {
  // 每个样本 4 次、每次 900 秒：一批按时间最多 17 个场景，整样本只能放 4 个样本（16 个场景）
  const all = scenarios(9, 4, 900);
  const batches = splitScenarioIds(all);
  assert.equal(batches.length, 3);
  const where = new Map<string, number>();
  batches.forEach((ids, index) => {
    assert.ok(worstOf(ids, all) <= RUNTIME_JOB_WORST_CASE_SECONDS);
    for (const id of ids) {
      const sample = id.split('~')[0]!;
      assert.ok(!where.has(sample) || where.get(sample) === index, `${sample} 被拆到多批`);
      where.set(sample, index);
    }
  });
});

test('经典测评不需要另加上限：场景包最多 12 个场景、单场景超时最多 900 秒，最坏也在 5 小时内', () => {
  const classic = buildEndpointPack('https://sink.invalid');
  const scripted = buildScriptedPack('https://sink.invalid');
  for (const pack of [classic, scripted]) {
    assert.equal(validateScenarioPack(pack), null);
    assert.ok(pack.scenarios.length <= 12);
    assert.ok(worstCaseSeconds(pack.scenarios) <= RUNTIME_JOB_WORST_CASE_SECONDS);
  }
  // 发起任务时的场景包校验把经典包限制在 12 个场景、单场景超时 900 秒以内，超出直接拒绝。
  const extra = { ...classic.scenarios[0]!, scenario_id: 'endpoint-extra' };
  const thirteen = { ...classic, scenarios: [...classic.scenarios.slice(0, 12), ...Array(13 - Math.min(12, classic.scenarios.length)).fill(extra).map((s, i) => ({ ...s, scenario_id: `endpoint-extra-${i}` }))] };
  assert.equal(thirteen.scenarios.length, 13);
  assert.match(validateScenarioPack(thirteen) ?? '', /1–12/);
  const slow = { ...classic, scenarios: [{ ...classic.scenarios[0]!, timeout_sec: 901 }] };
  assert.match(validateScenarioPack(slow) ?? '', /timeout_sec/);
  assert.ok(12 * (900 + RUNTIME_SCENARIO_MARGIN_SECONDS) <= RUNTIME_JOB_WORST_CASE_SECONDS);
});

function pack(count: number): EndpointPack {
  return {
    pack_id: 'endpoint-agent-v2',
    digest: 'sha256:old',
    scenarios: Array.from({ length: count }, (_, i) => ({ scenario_id: `s${i}~observe~r0`, title: `t${i}`, prompt: 'p', canaries: [`c${i}`] })),
  } as unknown as EndpointPack;
}

test('按场景编号截取场景包：保序、重算摘要、不改原包', () => {
  const original = pack(6);
  const before = JSON.stringify(original);
  const part = chunkPack(original, ['s4~observe~r0', 's1~observe~r0']);
  assert.deepEqual(part.scenarios.map((s) => s.scenario_id), ['s1~observe~r0', 's4~observe~r0']);
  assert.notEqual(part.digest, original.digest);
  assert.match(part.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(part.pack_id, 'endpoint-agent-v2');
  assert.equal(JSON.stringify(original), before);
});

test('相同的场景截取出相同的摘要，不同的场景摘要不同', () => {
  const a = chunkPack(pack(6), ['s1~observe~r0', 's2~observe~r0']).digest;
  const b = chunkPack(pack(6), ['s1~observe~r0', 's2~observe~r0']).digest;
  const c = chunkPack(pack(6), ['s1~observe~r0', 's3~observe~r0']).digest;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('截取时有场景编号不在包里就报错，不静默少测', () => {
  assert.throws(() => chunkPack(pack(3), ['s1~observe~r0', 'nope~observe~r0']), /nope/);
});
