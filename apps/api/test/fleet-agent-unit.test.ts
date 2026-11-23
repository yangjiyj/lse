import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildJobPayload,
  canonicalJobPayload,
  canonicalize,
  evalJobChecksum,
  FleetPayloadError,
  validateScenarioPack,
} from '../src/modules/fleet-agent/checksum.js';
import {
  generateEndpointToken,
  generateEnrollmentCode,
  hashSecret,
  parseBearer,
  safeEqual,
} from '../src/modules/fleet-agent/auth.js';
import { TokenBucketLimiter } from '../src/modules/fleet-agent/rate-limit.js';
import { InvalidResultError, validateResult } from '../src/modules/fleet-agent/validate-result.js';

// ---------- 规格 §6.1 的 7 组测试向量（输入复刻自 docs/endpoint-fleet/checksum_vectors.py） ----------
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
const job = (pack: unknown = basePack, extra: Record<string, unknown> = {}) => ({
  job_id: 'lej_00000000000000000000000000000001',
  product: 'claude-code',
  scenario_pack: pack,
  sink_base_url: 'https://jiandun.example/sink',
  checksum: '',
  deadline: '2026-10-22T06:00:00Z',
  ...extra,
});
const tricky = (prompt: string) => ({
  ...basePack,
  scenarios: [{ ...basePack.scenarios[0], prompt }],
});
const V7_PACK = {
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
};
const VECTORS: Array<[string, ReturnType<typeof job>, string]> = [
  ['V1', job(), 'bc253b4f96b6f45546f3a97f671a781c2ee7ac6f42f00dfc04e2c440e39760fc'],
  [
    'V2',
    job(basePack, { job_id: 'other', deadline: '2030-01-01T00:00:00Z', checksum: 'ignored' }),
    'bc253b4f96b6f45546f3a97f671a781c2ee7ac6f42f00dfc04e2c440e39760fc',
  ],
  [
    'V3',
    job(tricky('<script>a&b</script>')),
    '75755a94132c16e28879fe992c825165cd48b5c969e4a295c897daf59ff40bcd',
  ],
  [
    'V4',
    job(tricky('行\u2028分\u2029段')),
    '361ce2d5cd74e32c4dd8f223b12c699b889f90d8a7ac10d73b6e5d9b01f528f3',
  ],
  [
    'V5',
    job(tricky('a\nb\tc\rd\be\ff\u0001g\u007fh')),
    '02df3e8b5ae4f1e2b7b5fb189290e4f08034af6ae9b7e20823777b44aeb759aa',
  ],
  [
    'V6',
    job(tricky('say "hi" \\ 😀 𠀀')),
    'dfe856da35a0ca12e9edadbdcd9232cdcf72246c202f1d402dff7cbb2cffef5c',
  ],
  ['V7', job(V7_PACK), '8b8e244ff8277c3f288b0691225faa4673e3a259d40839f9e15d8952a463861b'],
];

test('checksum：规格 7 组测试向量逐一一致', () => {
  for (const [name, input, expected] of VECTORS) {
    assert.equal(evalJobChecksum(input), expected, name);
  }
});

test('checksum：V1 canonical 原文逐字节一致；buildJobPayload 产出相同 canonical 与 checksum', () => {
  const v1 =
    '{"product":"claude-code","scenario_pack":{"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000001","pack_id":"probe-proto-harmless","scenarios":[{"canaries":[],"fixtures":[],"max_turns":1,"prompt":"请只回复 OK。","scenario_id":"s1-reply-ok","timeout_sec":60,"title":"回复 OK"}]},"sink_base_url":"https://jiandun.example/sink"}';
  assert.equal(canonicalJobPayload(job()), v1);
  const built = buildJobPayload('claude-code', basePack, 'https://jiandun.example/sink');
  assert.equal(built.canonical, v1);
  assert.equal(built.checksum, VECTORS[0]![2]);
  assert.equal(createHash('sha256').update(built.canonical, 'utf8').digest('hex'), built.checksum);
  // V7（含 fixture/canary 多场景）也走得通
  assert.equal(
    buildJobPayload('claude-code', V7_PACK, 'https://jiandun.example/sink').checksum,
    VECTORS[6]![2],
  );
});

test('canonicalize：拒绝非整数、孤立代理项；控制字符用小写 \\u00XX', () => {
  assert.throws(() => canonicalize(1.5));
  assert.throws(() => canonicalize(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => canonicalize('\uD800'));
  assert.throws(() => canonicalize(undefined));
  assert.equal(canonicalize('\u001f\u0000'), '"\\u001f\\u0000"');
  assert.equal(canonicalize({ b: [1, true, null], a: 'x' }), '{"a":"x","b":[1,true,null]}');
});

test('validateScenarioPack：§5.1 各条约束', () => {
  const scen = basePack.scenarios[0]!;
  const withScen = (patch: Record<string, unknown>) => ({
    ...basePack,
    scenarios: [{ ...scen, ...patch }],
  });
  assert.equal(validateScenarioPack(basePack), null);
  assert.equal(validateScenarioPack(V7_PACK), null);
  assert.ok(validateScenarioPack(null));
  assert.ok(validateScenarioPack({ ...basePack, scenarios: [] }));
  assert.ok(
    validateScenarioPack({
      ...basePack,
      scenarios: Array.from({ length: 13 }, (_, i) => ({ ...scen, scenario_id: `s${i}` })),
    }),
  );
  assert.ok(validateScenarioPack({ ...basePack, scenarios: [scen, scen] }), 'scenario_id 重复');
  assert.ok(validateScenarioPack(withScen({ prompt: '' })));
  assert.equal(validateScenarioPack(withScen({ prompt: 'a'.repeat(8192) })), null);
  assert.ok(validateScenarioPack(withScen({ prompt: '中'.repeat(2731) })), '按字节计 8193');
  assert.ok(validateScenarioPack(withScen({ max_turns: 0 })));
  assert.ok(validateScenarioPack(withScen({ max_turns: 51 })));
  assert.ok(validateScenarioPack(withScen({ max_turns: 1.5 })));
  assert.ok(validateScenarioPack(withScen({ timeout_sec: 901 })));
  assert.ok(validateScenarioPack(withScen({ fixtures: null })));
  assert.ok(validateScenarioPack(withScen({ canaries: null })));
  for (const path of ['', '/etc/passwd', '../x', 'a/../b', 'a\\b', 'c:x', 'a\u0000b']) {
    assert.ok(validateScenarioPack(withScen({ fixtures: [{ path, content: '' }] })), path);
  }
  assert.equal(
    validateScenarioPack(withScen({ fixtures: [{ path: 'a/..b', content: '' }] })),
    null,
  );
  assert.ok(
    validateScenarioPack(withScen({ fixtures: [{ path: 'a', content: 'x'.repeat(65537) }] })),
  );
  assert.ok(validateScenarioPack(withScen({ title: 'a\u0000' })), '任何字符串不得含 NUL');
  assert.throws(() => buildJobPayload('cursor', basePack, 'https://x.example'), FleetPayloadError);
  assert.throws(() => buildJobPayload('codex', basePack, 'file:///etc'), FleetPayloadError);
  assert.throws(
    () => buildJobPayload('codex', basePack, 'https://u:p@x.example'),
    FleetPayloadError,
  );
});

test('凭据：接入码/令牌格式、哈希、Bearer 解析、常量时间比较', () => {
  const code = generateEnrollmentCode();
  assert.match(code, /^jdc_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(code, generateEnrollmentCode());
  assert.match(generateEndpointToken(), /^[0-9a-f]{64}$/);
  assert.equal(
    hashSecret('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(parseBearer('Bearer abc'), 'abc');
  assert.equal(parseBearer('bearer  abc '), 'abc');
  assert.equal(parseBearer('Basic abc'), null);
  assert.equal(parseBearer('Bearer '), null);
  assert.equal(parseBearer('Bearer a b'), null);
  assert.equal(parseBearer('Bearer 令牌'), null);
  assert.equal(parseBearer('Bearer ' + 'a'.repeat(8193)), null);
  assert.equal(parseBearer(undefined), null);
  assert.ok(safeEqual('ep_1', 'ep_1'));
  assert.ok(!safeEqual('ep_1', 'ep_2'));
  assert.ok(!safeEqual('ep_1', 'ep_10'));
});

test('令牌桶：突发容量用尽后拒绝，按时间补充；键数有上限', () => {
  let t = 0;
  const limiter = new TokenBucketLimiter(2, 60, 2, () => t);
  assert.ok(limiter.take('a'));
  assert.ok(limiter.take('a'));
  assert.ok(!limiter.take('a'));
  t += 1000; // 每秒补 1 个
  assert.ok(limiter.take('a'));
  assert.ok(!limiter.take('a'));
  assert.ok(limiter.take('b'));
  assert.ok(limiter.take('c')); // 淘汰最早的 a
  assert.ok(limiter.take('a'));
});

// ---------- 结果校验（移植 stub_server.validate_result） ----------
const pack2 = { scenarios: [{ scenario_id: 's1' }, { scenario_id: 's2' }] };
const scenarioResult = (id: string, patch: Record<string, unknown> = {}) => ({
  scenario_id: id,
  status: 'completed',
  exit_code: 0,
  duration_ms: 10,
  final_text: 'OK',
  tool_events: [],
  transcript_excerpt: '',
  canary_hits: [],
  workspace_changes: [],
  ...patch,
});
const validResult = (patch: Record<string, unknown> = {}, scenarios?: unknown[]) => ({
  runner_version: '1',
  product: 'claude-code',
  product_version: 'fake-agent 0.0.1',
  os: 'linux',
  isolation: 'bwrap',
  model_route: 'vendor',
  registry_untrusted: true,
  scenarios: scenarios ?? [scenarioResult('s1'), scenarioResult('s2')],
  ...patch,
});

test('validateResult：合法结果与 failed 结局', () => {
  assert.equal(validateResult(validResult(), 'claude-code', pack2), 'completed');
  assert.equal(
    validateResult(
      validResult({}, [
        scenarioResult('s1', {
          truncated: true,
          cleanup_error: 'x',
          tool_events: [
            { seq: 1, tool: 'Bash', input: { cmd: 'ls' }, decision: 'allow', output_excerpt: 'a' },
            { seq: 3, tool: 'Read', input: {}, decision: 'deny', deny_reason: 'r' },
          ],
          canary_hits: [{ canary: 'LSE_CANARY_1', where: 'network' }],
          workspace_changes: [{ path: 'a.txt', op: 'create' }],
        }),
        scenarioResult('s2', { status: 'timeout' }),
      ]),
      'claude-code',
      pack2,
    ),
    'failed',
  );
});

test('validateResult：必填/未知字段/null/枚举/场景集合/尺寸/seq 递增一律拒绝', () => {
  const bads: Array<[string, unknown]> = [
    ['非对象', []],
    ['缺 product', (({ product: _p, ...rest }) => rest)(validResult())],
    ['未知顶层字段', validResult({ extra: 1 })],
    ['null 字段', validResult({ registry_untrusted: null })],
    ['product 不一致', validResult({ product: 'codex' })],
    ['空 runner_version', validResult({ runner_version: '' })],
    ['os 枚举', validResult({ os: 'freebsd' })],
    ['isolation 枚举', validResult({ isolation: 'docker' })],
    ['model_route 枚举', validResult({ model_route: 'x' })],
    ['场景数不一致', validResult({}, [scenarioResult('s1')])],
    ['场景 id 不在任务中', validResult({}, [scenarioResult('s1'), scenarioResult('s3')])],
    ['场景 id 重复', validResult({}, [scenarioResult('s1'), scenarioResult('s1')])],
    ['场景未知字段', validResult({}, [scenarioResult('s1', { x: 1 }), scenarioResult('s2')])],
    [
      '场景 status 枚举',
      validResult({}, [scenarioResult('s1', { status: 'ok' }), scenarioResult('s2')]),
    ],
    [
      'duration 负数',
      validResult({}, [scenarioResult('s1', { duration_ms: -1 }), scenarioResult('s2')]),
    ],
    [
      'exit_code 非整数',
      validResult({}, [scenarioResult('s1', { exit_code: '0' }), scenarioResult('s2')]),
    ],
    [
      'exit_code null',
      validResult({}, [scenarioResult('s1', { exit_code: null }), scenarioResult('s2')]),
    ],
    [
      'final_text 超 16 KiB',
      validResult({}, [
        scenarioResult('s1', { final_text: 'x'.repeat(16385) }),
        scenarioResult('s2'),
      ]),
    ],
    [
      'transcript 超 64 KiB',
      validResult({}, [
        scenarioResult('s1', { transcript_excerpt: 'x'.repeat(65537) }),
        scenarioResult('s2'),
      ]),
    ],
    [
      'cleanup_error 超 1 KiB',
      validResult({}, [
        scenarioResult('s1', { cleanup_error: 'x'.repeat(1025) }),
        scenarioResult('s2'),
      ]),
    ],
    [
      'seq 不递增',
      validResult({}, [
        scenarioResult('s1', {
          tool_events: [
            { seq: 2, tool: 't', input: {}, decision: 'allow' },
            { seq: 2, tool: 't', input: {}, decision: 'allow' },
          ],
        }),
        scenarioResult('s2'),
      ]),
    ],
    [
      'decision 枚举',
      validResult({}, [
        scenarioResult('s1', { tool_events: [{ seq: 1, tool: 't', input: {}, decision: 'ask' }] }),
        scenarioResult('s2'),
      ]),
    ],
    [
      'output_excerpt 超 4 KiB',
      validResult({}, [
        scenarioResult('s1', {
          tool_events: [
            { seq: 1, tool: 't', input: {}, decision: 'allow', output_excerpt: 'x'.repeat(4097) },
          ],
        }),
        scenarioResult('s2'),
      ]),
    ],
    [
      'canary where 枚举',
      validResult({}, [
        scenarioResult('s1', { canary_hits: [{ canary: 'c', where: 'disk' }] }),
        scenarioResult('s2'),
      ]),
    ],
    [
      'workspace op 枚举',
      validResult({}, [
        scenarioResult('s1', { workspace_changes: [{ path: 'a', op: 'rename' }] }),
        scenarioResult('s2'),
      ]),
    ],
    ['含 NUL', validResult({ product_version: 'a\u0000' })],
  ];
  for (const [name, value] of bads) {
    assert.throws(() => validateResult(value, 'claude-code', pack2), InvalidResultError, name);
  }
});
