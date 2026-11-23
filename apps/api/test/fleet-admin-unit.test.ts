import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEndpointPack } from '../src/modules/endpoint-evals/pack.js';
import {
  buildJobPayload,
  canonicalize,
  validateScenarioPack as validateScenarioPackRaw,
} from '../src/modules/fleet-agent/checksum.js';

// 协议侧的场景包校验返回错误文字（null 表示通过）；本文件的断言沿用「抛异常 / 不抛」的写法，
// 这里做一层薄适配，避免改动原有断言。
function validateScenarioPack(pack: unknown): void {
  const error = validateScenarioPackRaw(pack);
  if (error) throw new Error(`场景包不合法：${error}`);
}
import { adaptProbeReport, judgeProbeReport } from '../src/modules/fleet-admin/posture.js';
import { sampleReport } from './fleet-admin-fixtures.js';

// 规格 protocol-subset.md §6.1 测试向量（三方实测一致）。
const basePack = {
  pack_id: 'probe-proto-harmless',
  digest: 'sha256:' + '0'.repeat(63) + '1',
  scenarios: [
    {
      scenario_id: 's1-reply-ok',
      title: '回复 OK',
      prompt: '请只回复 OK。',
      fixtures: [],
      canaries: [],
      max_turns: 1,
      timeout_sec: 60,
    },
  ],
};
const withPrompt = (prompt: string) => ({
  ...basePack,
  scenarios: [{ ...basePack.scenarios[0]!, prompt }],
});
const SINK = 'https://jiandun.example/sink';

test('checksum 与规格向量 V1–V7 逐字节一致', () => {
  const v1 = buildJobPayload('claude-code', basePack, SINK);
  assert.equal(
    v1.canonical,
    '{"product":"claude-code","scenario_pack":{"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000001","pack_id":"probe-proto-harmless","scenarios":[{"canaries":[],"fixtures":[],"max_turns":1,"prompt":"请只回复 OK。","scenario_id":"s1-reply-ok","timeout_sec":60,"title":"回复 OK"}]},"sink_base_url":"https://jiandun.example/sink"}',
  );
  const cases: Array<[unknown, string]> = [
    [basePack, 'bc253b4f96b6f45546f3a97f671a781c2ee7ac6f42f00dfc04e2c440e39760fc'],
    [
      withPrompt('<script>a&b</script>'),
      '75755a94132c16e28879fe992c825165cd48b5c969e4a295c897daf59ff40bcd',
    ],
    [
      withPrompt('行\u2028分\u2029段'),
      '361ce2d5cd74e32c4dd8f223b12c699b889f90d8a7ac10d73b6e5d9b01f528f3',
    ],
    [
      withPrompt('a\nb\tc\rd\be\ff\u0001g\u007fh'),
      '02df3e8b5ae4f1e2b7b5fb189290e4f08034af6ae9b7e20823777b44aeb759aa',
    ],
    [
      withPrompt('say "hi" \\ 😀 𠀀'),
      'dfe856da35a0ca12e9edadbdcd9232cdcf72246c202f1d402dff7cbb2cffef5c',
    ],
    [
      {
        pack_id: 'p2',
        digest: 'sha256:' + 'ab'.repeat(32),
        scenarios: [
          {
            scenario_id: 'a',
            title: 't',
            prompt: 'p',
            fixtures: [{ path: 'src/x.txt', content: 'x' }],
            canaries: ['LSE_CANARY_1'],
            max_turns: 3,
            timeout_sec: 120,
          },
          {
            scenario_id: 'b',
            title: 't2',
            prompt: 'p2',
            fixtures: [],
            canaries: [],
            max_turns: 1,
            timeout_sec: 30,
          },
        ],
      },
      '8b8e244ff8277c3f288b0691225faa4673e3a259d40839f9e15d8952a463861b',
    ],
  ];
  for (const [pack, expected] of cases)
    assert.equal(buildJobPayload('claude-code', pack, SINK).checksum, expected);
});

test('canonical 拒绝非整数与孤立代理项', () => {
  assert.throws(() => canonicalize({ a: 1.5 }));
  assert.throws(() => canonicalize({ a: '\ud800' }));
  assert.equal(canonicalize({ b: [true, null], a: 'x' }), '{"a":"x","b":[true,null]}');
});

test('场景包校验：内置测评包通过，越界/路径穿越/空值被拒', () => {
  validateScenarioPack(buildEndpointPack('https://lse.example/sink/abc'));
  const bad = (patch: Record<string, unknown>) =>
    assert.throws(
      () =>
        validateScenarioPack({ ...basePack, scenarios: [{ ...basePack.scenarios[0], ...patch }] }),
      /场景包不合法/,
    );
  bad({ max_turns: 51 });
  bad({ timeout_sec: 0 });
  bad({ prompt: '' });
  bad({ fixtures: null });
  bad({ canaries: null });
  bad({ fixtures: [{ path: '../x', content: '' }] });
  bad({ fixtures: [{ path: '/etc/passwd', content: '' }] });
  bad({ fixtures: [{ path: 'a\\b', content: '' }] });
  bad({ fixtures: [{ path: 'c:x', content: '' }] });
  bad({ prompt: 'a\u0000b' });
  assert.throws(() => validateScenarioPack({ ...basePack, scenarios: [] }), /场景包不合法/);
  assert.throws(
    () =>
      validateScenarioPack({
        ...basePack,
        scenarios: [basePack.scenarios[0], basePack.scenarios[0]],
      }),
    /重复/,
  );
});

test('体检适配：aiprobe.report.v1 → judgePosture，命中项 FAIL，未采集项 UNKNOWN', () => {
  const safe = judgeProbeReport(sampleReport());
  const by = (fs: typeof safe, id: string) => fs.find((f) => f.ruleId === id)!.verdict;
  assert.equal(by(safe, 'permissions'), 'PASS');
  assert.equal(by(safe, 'mcp_transport'), 'PASS');
  assert.equal(by(safe, 'credentials'), 'PASS');
  assert.equal(by(safe, 'mcp_injection'), 'UNKNOWN', '未采集工具描述不能当作安全');
  assert.equal(by(safe, 'hooks'), 'UNKNOWN');

  const risky = judgeProbeReport(sampleReport({ bypass: true, shadowing: true, httpMcp: true }));
  assert.equal(by(risky, 'permissions'), 'FAIL');
  assert.equal(by(risky, 'mcp_injection'), 'FAIL');
  assert.match(risky.find((f) => f.ruleId === 'mcp_injection')!.evidence, /劫持/);
  assert.equal(by(risky, 'mcp_transport'), 'FAIL');

  const empty = judgeProbeReport({
    schema_version: 'aiprobe.report.v1',
    assets: [],
    collectors: [],
  });
  assert.ok(empty.every((f) => f.verdict === 'UNKNOWN'));
  assert.equal(adaptProbeReport({}).input.mcp_servers, undefined);
});
