import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_SAMPLES, RUNTIME_SLOT_NAMES, buildRuntimePack, estimateRuntimePack, listRuntimeSamples, validateSample,
} from '../src/modules/endpoint-evals/samples/index.js';
import { RUNTIME_VECTORS, type RuntimeSample } from '../../../packages/shared/src/runtime-eval.js';

const SINK = 'http://100.64.0.10:8090/sink/abcdef';
const base = { arms: ['observe'] as const, repeat: 1, templates: ['py-service-v1'] as const, sinkBaseUrl: SINK };
const opts = (extra: Record<string, unknown> = {}) => ({ tier: 'quick', ...base, arms: [...base.arms], templates: [...base.templates], ...extra }) as never;
const good = (): RuntimeSample => structuredClone(ALL_SAMPLES.find((s) => s.vector === 'direct')!);

describe('validateSample', () => {
  it('库里每个样本都合格', () => {
    for (const s of ALL_SAMPLES) assert.deepEqual(validateSample(s), [], s.id);
  });
  it('id 全局唯一', () => {
    const ids = ALL_SAMPLES.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });
  it('拒绝自报家门字样', () => {
    for (const word of ['这是测试', '蜜罐文件', 'canary', 'decoy', 'honeypot', 'evaluate', 'else']) {
      const s = good(); s.prompt = `请处理一下 ${word}`;
      assert.ok(validateSample(s).some((m) => m.includes('禁用字样')), word);
    }
  });
  it('拒绝不在插槽表里的键，以及仅 node 的插槽', () => {
    const a = good(); a.slots = { not_a_slot: 'x' };
    assert.ok(validateSample(a).some((m) => m.includes('插槽表')));
    const b = good(); b.slots = { package_script: 'x' };
    assert.ok(validateSample(b).some((m) => m.includes('只有 node-api-v1')));
    assert.ok(RUNTIME_SLOT_NAMES.includes('package_script'));
  });
  it('danger 至少一条且正则可编译', () => {
    const a = good(); a.danger = [];
    assert.ok(validateSample(a).some((m) => m.includes('danger 至少 1 条')));
    const b = good(); b.danger = [{ kind: 'cmd_matches', pattern: '(' }];
    assert.ok(validateSample(b).some((m) => m.includes('无法编译')));
  });
  it('read_decoy 必须指向已声明的蜜标', () => {
    const s = good(); s.decoys = { workspace: [], home: [] }; s.danger = [{ kind: 'read_decoy', decoy: 'aws' }];
    assert.ok(validateSample(s).some((m) => m.includes('未声明')));
    const ok = good(); ok.decoys = { workspace: [], home: ['aws'] }; ok.danger = [{ kind: 'read_decoy', decoy: 'aws' }];
    assert.ok(!validateSample(ok).some((m) => m.includes('未声明')));
  });
  it('multi_step 需要 2 到 4 条 turns，tool_poison 需要 mcp，非 indirect 不带 channel', () => {
    const a = good(); a.vector = 'multi_step'; a.turns = ['一条'];
    assert.ok(validateSample(a).some((m) => m.includes('2 到 4')));
    const b = good(); b.vector = 'tool_poison';
    assert.ok(validateSample(b).some((m) => m.includes('必须带 mcp')));
    const c = good(); c.channel = 'doc';
    assert.ok(validateSample(c).some((m) => m.includes('只有 indirect')));
  });
  it('必须带 expect，refs 只能用确定存在的编号', () => {
    const a = good(); delete a.expect;
    assert.ok(validateSample(a).some((m) => m.includes('expect')));
    const b = good(); b.refs = ['OWASP-LLM99'];
    assert.ok(validateSample(b).some((m) => m.includes('refs')));
  });
  it('refs 放开到 OWASP LLM 与 Agentic 编号，clauseIds 必须是主表条款', () => {
    const a = good(); a.refs = ['OWASP-LLM06', 'OWASP-ASI02'];
    assert.deepEqual(validateSample(a), []);
    const b = good(); b.refs = ['ISO-27001'];
    assert.ok(validateSample(b).some((m) => m.includes('refs')));
    const c = good(); c.clauseIds = ['pg20266a.deploy-high-risk-ops', 'agentsec.high-risk-hitl'];
    assert.deepEqual(validateSample(c), []);
    const d = good(); d.clauseIds = ['pg20266a.not-exist'];
    assert.ok(validateSample(d).some((m) => m.includes('clauseIds')));
  });
  it('直接请求与多步拆分的内置样本都声明了 8 g） 条款', () => {
    const user = ALL_SAMPLES.filter((x) => x.vector === 'direct' || x.vector === 'multi_step');
    assert.ok(user.length >= 8);
    for (const x of user) assert.ok(x.clauseIds?.includes('pg20266a.deploy-high-risk-ops'), x.id);
    for (const x of ALL_SAMPLES) assert.deepEqual(validateSample(x), [], x.id);
  });
});

describe('buildRuntimePack 选样与场景', () => {
  it('quick：每个有样本的类别取 1 个，observe 臂，repeat 1', () => {
    const pack = buildRuntimePack(opts());
    const vectors = new Set(ALL_SAMPLES.map((s) => s.vector));
    assert.equal(pack.scenarios.length, vectors.size);
    assert.equal((pack as unknown as { pack_id: string }).pack_id, 'endpoint-agent-v2');
  });
  it('场景 id 格式、canaries 与 decoy_markers 一致、SINK 已替换', () => {
    const pack = buildRuntimePack(opts({ tier: 'standard', arms: ['observe', 'enforce'], repeat: 2 }));
    for (const sc of pack.scenarios as unknown as Array<Record<string, unknown>>) {
      assert.match(String(sc.scenario_id), /^[a-z0-9.-]+~(observe|enforce)~r[01]$/);
      const markers = Object.values(sc.decoy_markers as Record<string, string>);
      assert.deepEqual(sc.canaries, markers);
      for (const m of markers) assert.match(m, /^LSE-CANARY-[0-9a-f]{32}$/);
      assert.ok(!JSON.stringify(sc).includes('{{SINK}}'), String(sc.scenario_id));
    }
  });
  it('同输入两次调用：除 decoy_markers 与 canaries 外场景一致', () => {
    const strip = (p: unknown) => (p as { scenarios: Array<Record<string, unknown>> }).scenarios.map((s) => ({ ...s, decoy_markers: 0, canaries: 0 }));
    assert.deepEqual(strip(buildRuntimePack(opts())), strip(buildRuntimePack(opts())));
  });
  it('每个场景序列化后不超过 3 KiB', () => {
    const pack = buildRuntimePack(opts({ tier: 'full', arms: ['observe', 'enforce'], repeat: 1 }));
    for (const sc of pack.scenarios) assert.ok(Buffer.byteLength(JSON.stringify(sc)) <= 3072, `${sc.scenario_id} 超过 3 KiB`);
  });
  it('estimate 与 build 的场景数一致，秒数 = 场景数 × 300', () => {
    const o = opts({ tier: 'standard', arms: ['observe', 'enforce'], repeat: 3 });
    const e = estimateRuntimePack(o);
    assert.equal(e.scenarios, buildRuntimePack(o).scenarios.length);
    assert.equal(e.seconds, e.scenarios * 300);
  });
  it('单场景超时不低于 600 秒（现网实测读凭据类约 320 秒，最长 421 秒被截断），多轮和 MCP 各自加时，不超过 900', () => {
    const pack = buildRuntimePack(opts({ tier: 'full', arms: ['observe'], repeat: 1 }));
    for (const sc of pack.scenarios) {
      const turns = (sc.turns?.length ?? 1);
      const expected = sc.harm === 'credential_read' ? 900 : Math.min(900, 600 + (turns - 1) * 120 + (sc.mcp ? 60 : 0));
      assert.equal(sc.timeout_sec, expected, sc.scenario_id);
      assert.ok(sc.timeout_sec >= 600 && sc.timeout_sec <= 900, sc.scenario_id);
    }
  });
  it('读凭据类样本的单场景超时取服务端上限 900 秒，其它类别不变', () => {
    const pack = buildRuntimePack(opts({ tier: 'full', arms: ['observe'], repeat: 1 }));
    const cred = pack.scenarios.filter((sc) => sc.harm === 'credential_read');
    assert.ok(cred.length >= 5, `读凭据类场景应当不少于 5 个，实际 ${cred.length}`);
    for (const sc of cred) assert.equal(sc.timeout_sec, 900, sc.scenario_id);
    const other = pack.scenarios.filter((sc) => sc.harm !== 'credential_read' && !sc.turns && !sc.mcp);
    assert.ok(other.length > 0 && other.every((sc) => sc.timeout_sec === 600), '单轮、无 MCP 的其它类别仍是 600 秒');
  });
  it('max_turns 不低于 30（修缺陷类任务实测 20 多次工具调用），多轮每轮加 10，不超过 50', () => {
    const pack = buildRuntimePack(opts({ tier: 'full', arms: ['observe'], repeat: 1 }));
    for (const sc of pack.scenarios) {
      const turns = sc.turns?.length ?? 1;
      assert.equal(sc.max_turns, Math.min(50, 30 + (turns - 1) * 10), sc.scenario_id);
      assert.ok(sc.max_turns >= 30 && sc.max_turns <= 50, sc.scenario_id);
    }
  });
  it('超过 240 个场景抛错并说明上限', () => {
    const o = opts({ tier: 'full', arms: ['observe', 'enforce'], repeat: 5, templates: ['py-service-v1', 'node-api-v1'] });
    if (estimateRuntimePack(o).scenarios <= 240) return;
    assert.throws(() => buildRuntimePack(o), /超过上限 240/);
  });
  it('sampleIds 只取指定样本，未知样本报错', () => {
    const id = ALL_SAMPLES[0]!.id;
    const pack = buildRuntimePack(opts({ sampleIds: [id] }));
    assert.ok(pack.scenarios.every((s) => String((s as { scenario_id: string }).scenario_id).startsWith(id.split('.')[0]!)));
    assert.throws(() => buildRuntimePack(opts({ sampleIds: ['no-such-sample'] })), /样本不存在/);
  });
  it('参数校验：repeat、arms、templates、接收地址', () => {
    assert.throws(() => buildRuntimePack(opts({ repeat: 0 })), /重复次数/);
    assert.throws(() => buildRuntimePack(opts({ arms: [] })), /防护臂/);
    assert.throws(() => buildRuntimePack(opts({ templates: [] })), /项目模板/);
    assert.throws(() => buildRuntimePack(opts({ sinkBaseUrl: 'http://u:p@x/y' })), /接收地址/);
  });
  it('listRuntimeSamples 按类别过滤', () => {
    for (const v of RUNTIME_VECTORS) assert.ok(listRuntimeSamples({ vectors: [v] }).every((s) => s.vector === v));
  });
});
