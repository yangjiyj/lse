import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { judgeProbeReport } from './posture.js';
import { buildEndpointOverview } from './overview.js';
import { aggregateBlast } from './blast.js';
import { sampleReport, postureSignalsReport } from '../../../test/fleet-admin-fixtures.js';
import { NOT_CHECKED_CAUSES } from '../../../../../packages/shared/src/not-checked.js';

const finding = (body: unknown, rule = 'instruction_file') =>
  judgeProbeReport(body).find((f) => f.ruleId === rule)!;
const one = () => {
  const body = postureSignalsReport();
  body.assets = body.assets.slice(0, 1);
  return body;
};

test('防护接入三种通过方式使用对应的受控说明', () => {
  for (const [code, detail] of [
    ['hook_managed', '已由系统级托管设置接入。'],
    ['hook_plugin', '已通过防护插件接入。'],
    ['hook_user', '用户设置中已接入。'],
  ]) {
    const body = one();
    body.assets[0]!.evidence.static_assessment.checks.at(-1)!.evidence_code = code!;
    const result = finding(body, 'hooks');
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.subjects[0]!.detail, detail);
  }
});

test('防护设置读取失败归管理员，缺失新检查保持原有成因，各账号独立判定', () => {
  const body = postureSignalsReport();
  const checks = body.assets[1]!.evidence.static_assessment.checks;
  checks.at(-1)!.status = 'unknown';
  checks.at(-1)!.evidence_code = 'hook_read_failed';
  body.assets[2]!.evidence.static_assessment.checks.pop();
  const result = finding(body, 'hooks');
  assert.equal(result.verdict, 'UNKNOWN');
  assert.deepEqual(
    result.subjects.map((s) => [s.state, s.cause]),
    [
      ['clear', undefined],
      ['not_checked', 'config_read_failed'],
      ['not_checked', 'hooks_not_reported'],
    ],
  );
  assert.equal(NOT_CHECKED_CAUSES.config_read_failed.owner, 'admin');
  const risk = finding(postureSignalsReport(), 'hooks');
  assert.equal(risk.verdict, 'FAIL');
  assert.match(risk.subjects[2]!.detail, /没有接入所需的终端工具防护/);
});

test('指令文件按安装分别保留已检查、未完成和风险，只展示受控句子', () => {
  const body = postureSignalsReport();
  body.assets[2]!.evidence.posture.forEach((p) => {
    p.label = '/现场构造目录/CLAUDE.md';
    p.evidence_code = '现场构造的密钥内容';
  });
  const result = finding(body);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(
    result.subjects.map((s) => [s.kind, s.state, s.cause]),
    [
      ['agent', 'clear', undefined],
      ['agent', 'not_checked', 'instruction_scan_incomplete'],
      ['agent', 'risk', undefined],
    ],
  );
  assert.equal(result.subjects[0]!.detail, '已检查 3 个指令文件，未发现隐藏字符、密钥或可疑指令。');
  assert.equal(
    result.subjects[2]!.detail,
    '指令文件含隐藏的方向控制或标签字符。；指令文件含零宽字符。；指令文件含疑似密钥。；指令文件含要求绕过审批或向用户隐瞒操作的语句。',
  );
  assert.equal(result.subjects[2]!.where, 'CLAUDE.md · 用户级');
  assert.ok(result.subjects[2]!.detail.length <= 120);
  assert.doesNotMatch(JSON.stringify(result), /现场构造|bypass_or_conceal|file-2/);
});

test('指令四项全部通过才算检查完成，数量取最大值，未知不能被通过覆盖', () => {
  const body = one();
  body.assets[0]!.evidence.posture[1]!.count = 7;
  assert.equal(finding(body).verdict, 'PASS');
  assert.match(finding(body).subjects[0]!.detail, /已检查 7 个/);
  body.assets[0]!.evidence.posture.pop();
  assert.equal(finding(body).verdict, 'UNKNOWN');
  body.assets[0]!.evidence.posture[0]!.status = 'unknown';
  assert.equal(finding(body).subjects[0]!.cause, 'instruction_scan_incomplete');
  body.assets[0]!.evidence.posture[1]!.status = 'finding';
  body.assets[0]!.evidence.posture[1]!.scope = 'project';
  body.assets[0]!.evidence.posture[1]!.label = '';
  assert.equal(finding(body).verdict, 'FAIL');
  assert.equal(finding(body).subjects[0]!.where, '项目级');
});

test('所有指令扫描未完成证据码均保留没检查，旧版单项未知也不算通过', () => {
  for (const code of [
    'instruction_too_large',
    'instruction_not_utf8',
    'instruction_unreadable',
    'project_limit_reached',
    'project_scan_timeout',
    'rule_dir_unreadable',
    'rule_file_limit',
  ]) {
    const body = one();
    body.assets[0]!.evidence.posture = [
      {
        key: 'instr.hidden_unicode',
        status: 'unknown',
        count: 1,
        scope: 'user',
        label: '',
        evidence_code: code,
      },
    ];
    assert.equal(finding(body).verdict, 'UNKNOWN');
    assert.equal(finding(body).subjects[0]!.cause, 'instruction_scan_incomplete');
  }
});

test('只有用户级同指纹且有指令检查行才覆盖独立指令文件，空指纹不匹配', () => {
  const agent = one().assets[0]!;
  const file = (hash: string) => ({
    kind: 'instruction_file',
    name: 'AGENTS.md',
    evidence: { config: { instruction_files: [{ path_hash: hash }] } },
  });
  for (const status of ['pass', 'unknown', 'finding']) {
    agent.evidence.posture.forEach((p) => {
      p.status = status;
    });
    const subjects = finding({ assets: [agent, file('file-0')] }).subjects;
    assert.equal(subjects.length, 1);
    assert.equal(subjects[0]!.kind, 'agent');
  }
  for (const body of [
    { assets: [agent, file('different')] },
    { assets: [agent, file('')] },
    { assets: [{ ...agent, evidence: { ...agent.evidence, posture: [] } }, file('file-0')] },
    {
      assets: [
        {
          ...agent,
          evidence: {
            ...agent.evidence,
            config: { instruction_files: [{ path_hash: 'file-0', scope: 'project' }] },
          },
        },
        file('file-0'),
      ],
    },
  ]) {
    assert.ok(finding(body).subjects.some((s) => s.cause === 'instruction_file_unassessed'));
  }
});

test('旧夹具没有新信号时防护和指令文件判定不变，空清单不算已检查', () => {
  const body = sampleReport();
  const hooks = finding(body, 'hooks');
  assert.equal(hooks.verdict, 'UNKNOWN');
  assert.equal(hooks.subjects[0]!.cause, 'hooks_not_reported');
  assert.equal(finding(body).verdict, 'UNKNOWN');
  assert.deepEqual(finding(body).subjects, []);
  assert.equal(
    finding({
      ...body,
      assets: [
        ...body.assets,
        {
          kind: 'instruction_file',
          name: 'AGENTS.md',
        },
      ],
    }).subjects[0]!.cause,
    'instruction_file_unassessed',
  );
});

test('影响范围只展示命中，新增指令通过行不增加或覆盖风险', () => {
  const body = one();
  assert.deepEqual(aggregateBlast(body), []);
  const risk = {
    key: 'cred.plaintext_key',
    status: 'finding',
    scope: 'user',
    count: 1,
    label: '',
    evidence_code: '',
  };
  assert.deepEqual(
    aggregateBlast({ assets: [{ ...body.assets[0], evidence: { posture: [risk] } }] }),
    aggregateBlast({
      assets: [
        { ...body.assets[0], evidence: { posture: [...body.assets[0]!.evidence.posture, risk] } },
      ],
    }),
  );
});

test('终端概览消费新版信号：防护风险一行，指令风险与补查分流，干净对象不混入', () => {
  const overview = buildEndpointOverview({ body: postureSignalsReport() }, { id: 'test' });
  const hooks = overview.risks.filter((r) => r.id.startsWith('hooks:'));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0]!.subjectCount, 1);
  const instruction = overview.risks.find((r) => r.id.startsWith('instruction_file:'))!;
  assert.equal(instruction.subjectCount, 1);
  const incomplete = overview.risks.find((r) =>
    r.groups?.some((g) => g.cause === 'instruction_scan_incomplete'),
  )!;
  assert.equal(incomplete.owner, 'probe');
  assert.equal(
    incomplete.groups!.find((g) => g.cause === 'instruction_scan_incomplete')!.subjectCount,
    1,
  );
  assert.doesNotMatch(JSON.stringify(overview.risks), /已检查 3 个/);
});

test('300 个安装在两秒内判定，概览同成因折叠且只展示前 50 个对象', () => {
  const sample = postureSignalsReport().assets[1]!;
  const body = {
    assets: Array.from({ length: 300 }, (_, i) => ({
      ...structuredClone(sample),
      version: '1.0.0',
      evidence: { ...structuredClone(sample.evidence), owner_account_key: `account-${i}` },
    })),
  };
  const start = performance.now();
  const result = finding(body);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2000, `判定耗时 ${elapsed}ms`);
  assert.equal(result.subjects.length, 300);
  const overview = buildEndpointOverview({ body }, { id: 'test' });
  const rows = overview.risks.filter((r) =>
    r.groups?.some((g) => g.cause === 'instruction_scan_incomplete'),
  );
  assert.equal(rows.length, 1);
  const group = rows[0]!.groups!.find((g) => g.cause === 'instruction_scan_incomplete')!;
  assert.equal(group.subjectCount, 300);
  assert.equal(group.subjects.length, 50);
  assert.equal(group.moreCount, 250);
  assert.ok(rows[0]!.subjects.length <= 50);
});

test('新版成因文案兼容旧版与未覆盖文件，平台不再举已支持的例子', () => {
  assert.equal(
    NOT_CHECKED_CAUSES.hooks_not_reported.basis,
    '防护接入结果未上报，新版探针目前只检查 Claude Code。',
  );
  assert.equal(
    NOT_CHECKED_CAUSES.instruction_file_unassessed.basis,
    '指令文件没有对应的内容检查结果。',
  );
  assert.doesNotMatch(NOT_CHECKED_CAUSES.platform_config_partial.basis, /YAML/);
  assert.match(NOT_CHECKED_CAUSES.platform_config_partial.advice, /升级探针到最新版本/);
  const cause =
    NOT_CHECKED_CAUSES['instruction_scan_incomplete' as keyof typeof NOT_CHECKED_CAUSES];
  assert.ok(cause);
  assert.equal(cause.owner, 'probe');
  assert.equal(cause.unit, '处安装');
});

test('防护读取失败不能被旧字段的通过覆盖，未识别通过码沿用通用说明', () => {
  const body = one();
  const asset = body.assets[0]!;
  const hook = asset.evidence.static_assessment.checks.at(-1)!;
  Object.assign(asset.evidence, { managed_by_agentshield: true });
  hook.status = 'unknown';
  hook.evidence_code = 'hook_read_failed';
  assert.equal(finding(body, 'hooks').subjects[0]!.state, 'not_checked');
  hook.status = 'pass';
  hook.evidence_code = 'future_pass_code';
  assert.equal(finding(body, 'hooks').subjects[0]!.detail, '已检查该智能体配置，未发现此项风险。');
  asset.evidence.static_assessment.checks.pop();
  delete (asset.evidence as Record<string, unknown>).managed_by_agentshield;
  asset.name = 'codex';
  assert.equal(finding(body, 'hooks').subjects[0]!.cause, 'hooks_not_reported');
});

test('四类指令命中逐项使用受控句子，命中优先于其他键未知', () => {
  const details = [
    '指令文件含隐藏的方向控制或标签字符。',
    '指令文件含零宽字符。',
    '指令文件含疑似密钥。',
    '指令文件含要求绕过审批或向用户隐瞒操作的语句。',
  ];
  details.forEach((detail, index) => {
    const body = one();
    body.assets[0]!.evidence.posture.forEach((p, i) => {
      p.status = i === index ? 'finding' : 'unknown';
    });
    const result = finding(body);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.subjects[0]!.detail, detail);
  });
});
