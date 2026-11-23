import { test } from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../src/modules/batch-evaluations/core.js').catch(() => null);
const question = (id: string, content = id) => ({
  id,
  content,
  language: 'zh',
  type: 'GENERAL',
  category: '内容安全',
  shouldRefuse: false,
  metadata: null,
});

test('统一样本去重、固定种子可复现并保留内容快照', () => {
  assert.ok(core, '缺少批量评估核心');
  const input = [question('a'), question('b'), question('duplicate', 'a'), question('c')];
  const first = core.selectSamples(input, 3, 'stable');
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map((q: any) => q.content)).size, 3);
  assert.deepEqual(first, core.selectSamples(input, 3, 'stable'));
  input[0]!.content = '题库已编辑';
  assert.ok(first.some((q: any) => q.content === 'a'));
});

test('去重后样本不足必须拒绝创建，不能重复补足万题', () => {
  assert.ok(core, '缺少批量评估核心');
  assert.throws(
    () => core.selectSamples([question('a'), question('b', 'a')], 2, 'stable'),
    /有效样本不足/,
  );
});

test('同题冲突判定规则必须显式拒绝', () => {
  assert.ok(core, '缺少批量评估核心');
  assert.throws(
    () =>
      core.selectSamples(
        [question('a'), { ...question('b', 'a'), shouldRefuse: true }],
        1,
        'stable',
      ),
    /判定规则冲突/,
  );
});

test('总报告保留风险与证据缺口，不将异常算成通过', () => {
  assert.ok(core, '缺少批量评估核心');
  const summary = core.buildSummary(
    { expected: 100, processed: 100, pass: 97, fail: 1, error: 1, unknown: 1, critical: 1 },
    true,
    [],
  );
  assert.equal(summary.state, 'RISK_DETECTED');
  assert.equal(summary.coverageComplete, false);
  assert.equal(summary.counts.valid, 98);
  assert.ok(summary.recommendations.length >= 2);
  assert.equal(
    core.buildSummary(
      { expected: 1, processed: 1, pass: 0, fail: 0, error: 1, unknown: 0, critical: 0 },
      true,
      [],
    ).state,
    'INCOMPLETE',
  );
});

test('轮询在不同对象间轮转，顺序执行保持当前对象', () => {
  assert.ok(core, '缺少批量评估核心');
  const runs = [
    { id: 'a', remaining: 2 },
    { id: 'b', remaining: 3 },
    { id: 'c', remaining: 1 },
  ];
  assert.deepEqual(core.pickRuns(runs, 'ROUND_ROBIN', 1), ['b']);
  assert.deepEqual(core.pickRuns(runs, 'SEQUENTIAL', 1), ['a']);
  assert.deepEqual(core.pickRuns(runs, 'PARALLEL', 1), ['b', 'c', 'a']);
});

test('十个对象各一万样本组合调度无遗漏与重复', () => {
  assert.ok(core, '缺少批量评估核心');
  const samples = core.selectSamples(
    Array.from({ length: 10000 }, (_, i) => question(String(i))),
    10000,
    'scale',
  );
  const runs = Array.from({ length: 10 }, (_, i) => ({ id: String(i), remaining: samples.length }));
  const seen = new Set<string>();
  let cursor = 0;
  while (runs.some((r) => r.remaining > 0)) {
    const id = core.pickRuns(runs, 'ROUND_ROBIN', cursor)[0]!;
    const run = runs.find((r) => r.id === id)!;
    const count = Math.min(100, run.remaining);
    for (let i = 0; i < count; i++) seen.add(`${id}:${samples.length - run.remaining + i}`);
    run.remaining -= count;
    cursor = (Number(id) + 1) % runs.length;
  }
  assert.equal(seen.size, 100000);
});

test('敏感信息未命中不能将主评审待判定覆盖为通过', () => {
  assert.ok(core);
  assert.equal(typeof core.batchVerdict, 'function', '缺少严格批量判定聚合');
  assert.equal(
    core.batchVerdict([
      { verdict: 'UNKNOWN', status: 'success' },
      { verdict: 'PASS', status: 'success' },
    ]),
    'UNKNOWN',
  );
  assert.equal(
    core.batchVerdict([
      { verdict: 'UNKNOWN', status: 'success' },
      { verdict: 'FAIL', status: 'success' },
    ]),
    'FAIL',
  );
  assert.equal(
    core.batchVerdict([
      { verdict: 'PASS', status: 'success' },
      { verdict: 'PASS', status: 'success' },
    ]),
    'PASS',
  );
});

test('模型评审仅接受严格 JSON 枚举，不将 unsafe 或不通过解析为通过', () => {
  assert.ok(core);
  assert.equal(typeof core.strictJudgeContent, 'function');
  for (const content of [
    'unsafe',
    '不通过',
    '不合规',
    '{"verdict":"unsafe"}',
    '{"verdict":"not PASS"}',
  ])
    assert.equal(core.strictJudgeContent(content), null);
  assert.equal(
    JSON.parse(core.strictJudgeContent('```json\n{"verdict":"UNKNOWN","reason":"需复核"}\n```')!)
      .verdict,
    'UNKNOWN',
  );
});
