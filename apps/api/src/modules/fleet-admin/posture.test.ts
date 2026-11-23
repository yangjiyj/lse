import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePosture } from '../endpoint-evals/posture-judge.js';
import { judgeProbeReport } from './posture.js';

const groups = [
  {
    id: 'skill_risk',
    kind: 'skills',
    severity: 'HIGH',
    compliance: ['pg20266a.use-skill-safety'],
    rules: [
      ['skill.instruction_write', '会写入指令文件'],
      ['skill.persistence', '会设置长期自动运行'],
      ['skill.destructive_delete', '会删除文件或目录'],
      ['skill.credential_access', '会读取凭据'],
      ['skill.pipe_shell', '会下载内容并直接运行'],
      ['skill.instruction_override', '会要求忽略原有安全指令'],
      ['skill.script_patterns', '包含高风险脚本行为'],
      ['skill.network_upload', '会把内容上传到外部地址'],
      ['skill.encoded_execution', '会解码并运行隐藏内容'],
    ],
  },
  {
    id: 'mcp_risk',
    kind: 'mcp_servers',
    severity: 'MEDIUM',
    compliance: ['pg20266a.deploy-plugin-source'],
    rules: [
      ['mcp.authorization', '缺少访问授权'],
      ['mcp.credential', '凭据保护'],
      ['mcp.descriptions', '工具描述'],
      ['mcp.transport', '传输连接'],
      ['mcp.dependency', '依赖组件存在风险'],
      ['mcp.launch', '启动命令存在风险'],
      ['mcp.source', '工具来源不明'],
      ['mcp.project_auto_approve', '项目配置会自动批准工具操作'],
    ],
  },
] as const;

function report(
  kind: string,
  checks: Array<{ rule_id: string; status: string; reason_zh?: string }>,
) {
  return {
    collectors: [{ name: 'agents', status: 'complete' }],
    assets: [
      {
        kind: 'cli_agent',
        evidence: {
          [kind]: [
            {
              name: '测试项目',
              static_assessment: {
                checks: checks.map((c) => ({ ...c, file_label: 'run.sh', context_type: 'script' })),
              },
            },
          ],
        },
      },
    ],
  };
}

for (const group of groups) {
  for (const [rule, meaning] of group.rules) {
    test(`${group.id} 汇总 ${rule}，证据仅使用中文行为说明`, () => {
      const result = judgeProbeReport(
        report(group.kind, [
          {
            rule_id: rule,
            status: 'finding',
            reason_zh: '不应回显的原始脚本与秘密内容',
          },
        ]),
      ).find((f) => f.ruleId === group.id);
      assert.ok(result);
      assert.equal(result.verdict, 'FAIL');
      assert.equal(result.severity, group.severity);
      assert.deepEqual(result.compliance, group.compliance);
      assert.ok(result.evidence.includes(meaning));
      assert.ok(!result.evidence.includes('不应回显'));
    });
  }
  test(`${group.id} 未采集、部分采集或未知检查保持 UNKNOWN`, () => {
    const all = group.rules.map(([rule_id]) => ({ rule_id, status: 'pass' }));
    for (const body of [
      {},
      report(group.kind, []),
      report(group.kind, all.slice(1)),
      report(
        group.kind,
        all.map((c, i) => (i === 0 ? { ...c, status: 'unknown' } : c)),
      ),
    ]) {
      assert.equal(judgeProbeReport(body).find((f) => f.ruleId === group.id)?.verdict, 'UNKNOWN');
    }
  });
  test(`${group.id} 全部静态检查明确通过才 PASS`, () => {
    const body = report(
      group.kind,
      group.rules.map(([rule_id]) => ({ rule_id, status: 'pass' })),
    );
    assert.equal(judgeProbeReport(body).find((f) => f.ruleId === group.id)?.verdict, 'PASS');
    const input = { collected_fields: [group.kind], [group.kind]: [] };
    assert.equal(judgePosture(input).find((f) => f.ruleId === group.id)?.verdict, 'PASS');
  });
  test(`${group.id} 不能用一个项目的通过覆盖另一个项目的缺失`, () => {
    const body = report(
      group.kind,
      group.rules.map(([rule_id]) => ({ rule_id, status: 'pass' })),
    );
    body.assets[0]!.evidence[group.kind]!.push({
      name: '另一个项目',
      static_assessment: { checks: [] },
    });
    assert.equal(judgeProbeReport(body).find((f) => f.ruleId === group.id)?.verdict, 'UNKNOWN');
  });
}

for (const group of groups) {
  test(`${group.id} 资产层检查未采全不能被空清单覆盖`, () => {
    const body = {
      collectors: [{ name: 'agents', status: 'complete' }],
      assets: [
        {
          kind: 'cli_agent',
          evidence: {
            [group.kind]: [],
            static_assessment: { checks: [{ rule_id: group.rules[0][0], status: 'unknown' }] },
          },
        },
      ],
    };
    assert.equal(judgeProbeReport(body).find((f) => f.ruleId === group.id)?.verdict, 'UNKNOWN');
  });
  test(`${group.id} 采集局部失败不覆盖已完整检查的对象`, () => {
    const body = report(
      group.kind,
      group.rules.map(([rule_id]) => ({ rule_id, status: 'pass' })),
    );
    const complete = judgeProbeReport(body).find((f) => f.ruleId === group.id)!;
    assert.equal(complete.verdict, 'PASS');
    assert.doesNotMatch(complete.evidence, /本次采集有部分没完成|以上结论只覆盖/);
    const partial = {
      ...body,
      collectors: [
        {
          name: 'agents',
          status: 'partial',
          stats: { errors: [{ code: 'plugin_fingerprint_failed' }] },
        },
      ],
    };
    const result = judgeProbeReport(partial).find((f) => f.ruleId === group.id)!;
    assert.equal(result.verdict, 'PASS');
    assert.match(result.evidence, /本次采集有部分没完成（原因：插件目录指纹检查失败）/);
    assert.match(result.evidence, /以上结论只覆盖已采集到的 1 个对象/);
  });
  test(`${group.id} 多类行为同时命中时中文证据逐项列出`, () => {
    const body = report(
      group.kind,
      group.rules.map(([rule_id]) => ({ rule_id, status: 'finding' })),
    );
    const result = judgeProbeReport(body).find((f) => f.ruleId === group.id)!;
    assert.equal(result.verdict, 'FAIL');
    for (const [, meaning] of group.rules) assert.ok(result.evidence.includes(meaning));
  });
}

test('同名工具去重不丢失后续工具的配置风险命中', () => {
  const body = report('mcp_servers', [{ rule_id: 'mcp.launch', status: 'pass' }]);
  body.assets[0]!.evidence.mcp_servers!.push({
    name: '测试项目',
    static_assessment: {
      checks: [
        { rule_id: 'mcp.launch', status: 'finding', file_label: 'run.sh', context_type: 'script' },
      ],
    },
  });
  assert.equal(judgeProbeReport(body).find((f) => f.ruleId === 'mcp_risk')?.verdict, 'FAIL');
});

for (const group of groups) {
  test(`${group.id} 独立资产缺少静态检查时保持 UNKNOWN`, () => {
    const body = {
      collectors: [{ name: 'agents', status: 'complete' }],
      assets: [{ kind: group.id === 'skill_risk' ? 'skill' : 'mcp_server', evidence: {} }],
    };
    assert.equal(judgeProbeReport(body).find((f) => f.ruleId === group.id)?.verdict, 'UNKNOWN');
  });
}

test('partial 未提供原因时如实说明缺失，不以检查条数冒充对象数', () => {
  const checks = [
    'mcp.authorization',
    'mcp.credential',
    'mcp.dependency',
    'mcp.descriptions',
    'mcp.launch',
    'mcp.source',
    'mcp.transport',
  ].map((rule_id) => ({ rule_id, status: 'pass' }));
  const body = report('mcp_servers', checks);
  body.collectors[0]!.status = 'partial';
  const result = judgeProbeReport(body).find((f) => f.ruleId === 'mcp_risk')!;
  assert.equal(result.verdict, 'PASS');
  assert.match(result.evidence, /终端没有提供具体原因/);
  assert.match(result.evidence, /已采集到的 1 个对象/);
  assert.doesNotMatch(result.evidence, /已采集到的 7 个对象/);
});

test('partial 原因使用报告里的具体错误类别，不回显路径或原始配置内容', () => {
  const body = report(
    'skills',
    groups[0].rules.map(([rule_id]) => ({ rule_id, status: 'pass' })),
  );
  const result = judgeProbeReport({
    ...body,
    collectors: [{ name: 'agents', status: 'partial' }],
    stats: {
      errors: [
        { code: 'plugin_fingerprint_failed', message: '/home/private/secret-example' },
        { error_code: 'plugin_install_reference_unavailable' },
        '智能体配置不是常规文件',
        { message: 'skill_directory_unavailable' },
      ],
    },
  }).find((f) => f.ruleId === 'skill_risk')!;
  for (const reason of [
    '插件目录指纹检查失败',
    '插件安装引用不可用',
    '智能体配置不是常规文件',
    '技能目录不可用或无法读取',
  ])
    assert.ok(result.evidence.includes(reason));
  assert.match(result.evidence, /已采集到的 1 个对象/);
  assert.doesNotMatch(result.evidence, /private|secret-example/);
});

test('未检查的对象说明只写原因，不拼风险描述', () => {
  const result = judgeProbeReport(
    report('skills', [{ rule_id: 'skill.script_patterns', status: 'unknown' }]),
  ).find((f) => f.ruleId === 'skill_risk')!;
  assert.equal(result.verdict, 'UNKNOWN');
  assert.ok(result.subjects!.length > 0);
  for (const subject of result.subjects!) {
    assert.equal(subject.state, 'not_checked');
    assert.doesNotMatch(subject.detail, /包含高风险脚本行为/);
    assert.match(subject.detail, /终端没有完成脚本检查/);
  }
});

test('命中风险的对象说明只写一次风险描述', () => {
  const result = judgeProbeReport(
    report('skills', [{ rule_id: 'skill.credential_access', status: 'finding' }]),
  ).find((f) => f.ruleId === 'skill_risk')!;
  const risk = result.subjects!.find((subject) => subject.state === 'risk')!;
  assert.equal(risk.detail, '会读取凭据');
  assert.ok(result.evidence.includes('会读取凭据'));
});

test('技能来源登记为未知时写风险描述，已登记只写简短结论', () => {
  const source = (value: string | undefined) =>
    judgeProbeReport({
      collectors: [{ name: 'agents', status: 'complete' }],
      assets: [
        {
          kind: 'skill',
          name: '技能A',
          evidence: value === undefined ? {} : { source: value },
        },
      ],
    }).find((f) => f.ruleId === 'skill_source')!;
  const unknown = source('unknown').subjects![0]!;
  assert.equal(unknown.state, 'risk');
  assert.match(unknown.detail, /无法追溯提供方/);
  assert.doesNotMatch(unknown.detail, /已核对技能来源登记/);
  const known = source('npm:@scope/pkg').subjects![0]!;
  assert.equal(known.state, 'clear');
  assert.equal(known.detail, '来源已登记。');
  const missing = source(undefined).subjects![0]!;
  assert.equal(missing.state, 'not_checked');
  assert.doesNotMatch(missing.detail, /无法追溯提供方/);
});
