import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEndpointOverview } from './overview.js';
import { adaptProbeReport, judgeProbeReport } from './posture.js';
const fields = ['permission_mode', 'auto_approval', 'sandbox_mode'];
const items = ['permission', 'auto_approval', 'sandbox'];
function asset(values: Array<string | undefined>, checks: unknown[] = []) {
  return {
    kind: 'cli_agent',
    name: 'claude-code',
    evidence: {
      config: Object.fromEntries(fields.map((field, i) => [field, values[i]])),
      static_assessment: { checks },
    },
  };
}
function overview(assets: unknown[]) {
  return buildEndpointOverview({ assets }, { id: '测试终端' });
}
for (const [values, expected] of [
  [['ask', 'disabled', 'restricted'], 'checked'],
  [['cli:bypass', 'cli:enabled', 'restricted'], 'checked'],
  [['default:ask', 'disabled', 'default:none'], 'default'],
  [['ask', 'unknown', 'unknown'], 'partial'],
  [['default:ask', 'unknown', 'unknown'], 'partial'],
  [['internal_store', 'unknown', 'internal_store'], 'internal_store'],
  [['read_failed', 'unknown', 'read_failed'], 'read_failed'],
  [['unknown', 'unknown', 'unknown'], 'not_checked'],
  [['ask', 'internal_store', 'read_failed'], 'partial'],
] as const)
  test(`配置汇总：${values.join('/')} → ${expected}`, () => {
    assert.equal(overview([asset([...values])]).agents[0]!.configState, expected);
  });
test('跨安装汇总分布，新旧探针混合不丢失未知项', () => {
  const row = overview([
    asset(['ask', 'disabled', 'restricted']),
    asset(['default:ask', 'internal_store', 'read_failed']),
    asset(['unknown', 'unknown', 'unknown']),
  ]).agents[0]!;
  assert.equal(row.configState, 'partial');
  assert.deepEqual(row.configItems, [
    { item: 'permission', state: 'explicit', installs: 1 },
    { item: 'permission', state: 'default', installs: 1 },
    { item: 'permission', state: 'unknown', installs: 1 },
    { item: 'auto_approval', state: 'explicit', installs: 1 },
    { item: 'auto_approval', state: 'internal_store', installs: 1 },
    { item: 'auto_approval', state: 'unknown', installs: 1 },
    { item: 'sandbox', state: 'explicit', installs: 1 },
    { item: 'sandbox', state: 'read_failed', installs: 1 },
    { item: 'sandbox', state: 'unknown', installs: 1 },
  ]);
});
for (const [suffix, state] of [
  ['default_applied', 'default'],
  ['default_risky', 'default'],
  ['internal_store', 'internal_store'],
  ['read_failed', 'read_failed'],
] as const)
  test(`字段缺失由三项证据码推断：${suffix}`, () => {
    const checks = items.map((item) => ({
      rule_id: `config.${item}`,
      evidence_code: `${item}_${suffix}`,
      status:
        suffix === 'default_applied' ? 'pass' : suffix === 'default_risky' ? 'finding' : 'unknown',
    }));
    const row = overview([asset([], checks)]).agents[0]!;
    assert.equal(row.configState, state);
    assert.deepEqual(
      row.configItems,
      items.map((item) => ({ item, state, installs: 1 })),
    );
  });
test('字段优先，旧探针 pass/finding 兼容，旧 unknown 不推断默认值', () => {
  const checks = items.map((item) => ({
    rule_id: `config.${item}`,
    status: 'pass',
    evidence_code: `${item}_mode_observed`,
  }));
  assert.equal(
    overview([asset(['unknown', 'unknown', 'unknown'], checks)]).agents[0]!.configState,
    'checked',
  );
  assert.equal(
    overview([asset(['internal_store', 'internal_store', 'internal_store'], checks)]).agents[0]!
      .configState,
    'internal_store',
  );
  assert.equal(
    overview([asset(['unknown', 'unknown', 'unknown'])]).agents[0]!.configState,
    'not_checked',
  );
});
test('覆盖项按真实原因分类，默认值与部分未知安装不制造全未知覆盖项', () => {
  const result = overview([
    asset(['unknown', 'unknown', 'unknown']),
    asset(['ask', 'unknown', 'unknown']),
    asset(['default:ask', 'default:disabled', 'default:none']),
    asset(['internal_store', 'internal_store', 'internal_store']),
    asset(['read_failed', 'read_failed', 'read_failed']),
  ]);
  // 三类成因分属三个处理方，各自成行：读取失败归管理员，设置在软件内部归人工，没读到归探针。
  const rows = result.risks.filter((r) => r.level === 'NOT_CHECKED' && r.category === 'agent');
  const byCause = (cause: string) =>
    rows.flatMap((r) => r.groups ?? []).find((g) => g.cause === cause)!;
  // 权限模式或自动批准有一项没读到就判不了权限边界：全没读到的和只读到一项的都算
  assert.equal(byCause('config_unknown').subjectCount, 2);
  const internal = byCause('config_internal_store');
  assert.equal(internal.subjectCount, 1);
  assert.match(internal.basis, /该软件把这些设置存在内部，探针读不到/);
  const failed = byCause('config_read_failed');
  assert.equal(failed.subjectCount, 1);
  assert.match(failed.advice, /符号链接换成真实文件/);
  assert.deepEqual(
    rows.map((r) => r.owner),
    ['admin', 'manual', 'probe'],
  );
});
for (const value of [
  'default:bypass',
  'default:ask',
  'cli:bypass',
  'cli:ask',
  'internal_store',
  'read_failed',
])
  test(`新值不自行判断安全或风险：${value}`, () => {
    const report = { assets: [asset([value, value, value])] };
    const permissions = adaptProbeReport(report).input.permissions as Record<string, unknown>;
    assert.equal(permissions.mode, undefined);
    assert.equal(permissions.skip_confirm, undefined);
    assert.equal(
      judgeProbeReport(report).find((f) => f.ruleId === 'permissions')!.verdict,
      'UNKNOWN',
    );
    for (const [status, verdict] of [
      ['finding', 'FAIL'],
      ['pass', 'PASS'],
    ] as const) {
      const checks = ['permission', 'auto_approval'].map((item) => ({
        rule_id: `config.${item}`,
        status,
        evidence_code: `${item}_default_risky`,
      }));
      assert.equal(
        judgeProbeReport({ assets: [asset([value, value, value], checks)] }).find(
          (f) => f.ruleId === 'permissions',
        )!.verdict,
        verdict,
      );
    }
  });

test('逐项原因去重，默认值不产生配置成因，读取失败优先于软件内部存储', () => {
  const configCauses = (r: ReturnType<typeof overview>) =>
    r.risks
      .filter((x) => x.level === 'NOT_CHECKED')
      .flatMap((x) => x.groups ?? [])
      .map((g) => g.cause)
      .filter((cause) => cause.startsWith('config_'));
  const defaults = overview([asset(['default:ask', 'default:disabled', 'default:restricted'])]);
  assert.deepEqual(configCauses(defaults), []);
  assert.equal(defaults.agents[0]!.configNote, '配置未显式设置，按已核实的官方默认值读取。');
  const result = overview([asset(['internal_store', 'read_failed', 'internal_store'])]);
  assert.equal(result.agents[0]!.configState, 'internal_store');
  assert.equal(result.agents[0]!.configNote!.split('需要在软件里确认').length - 1, 1);
  assert.equal(result.agents[0]!.configNote!.split('配置文件读取或解析失败').length - 1, 1);
  // 一处安装只落一个成因：读取失败管理员能动手，排在软件内部存储前面；处理后下一次采集才会暴露后者
  assert.deepEqual(configCauses(result), ['config_read_failed']);
  const failed = result.risks
    .flatMap((r) => r.groups ?? [])
    .find((g) => g.cause === 'config_read_failed')!;
  assert.equal(failed.title, '配置读取失败');
  assert.equal(failed.subjectCount, 1);
  // 没有账号信息的报告里，对象旁没有位置说明，也不编造
  assert.equal(failed.subjects[0]!.detail, '');
  assert.deepEqual(
    configCauses(overview([asset(['internal_store', 'unknown', 'internal_store'])])),
    ['config_internal_store'],
  );
});

test('脱敏现网形态保留文件已读但三项缺失、四处安装部分读取的差异', () => {
  const agents = [
    ...Array.from({ length: 3 }, () => asset(['unknown', 'unknown', 'unknown'])),
    asset(['ask', 'disabled', 'unknown']),
    ...['hermes', 'openclaw', 'opencode'].map((name) => ({
      ...asset(['unknown', 'unknown', 'unknown']),
      name,
    })),
    { ...asset(['on-request', 'unknown', 'workspace-write']), name: 'codex' },
  ];
  const result = overview(agents);
  assert.equal(result.agents[0]!.installs, 4);
  assert.equal(result.agents[0]!.configState, 'partial');
  assert.deepEqual(
    result.agents[0]!.configItems.find((i) => i.item === 'permission' && i.state === 'unknown'),
    { item: 'permission', state: 'unknown', installs: 3 },
  );
  for (const key of ['hermes', 'openclaw', 'opencode'])
    assert.equal(result.agents.find((a) => a.key === key)!.configState, 'not_checked');
  assert.equal(result.agents.find((a) => a.key === 'codex')!.configState, 'partial');
});
