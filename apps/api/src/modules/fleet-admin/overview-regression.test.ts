import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adaptProbeReport, judgeProbeReport, summarizeReport } from './posture.js';
const report = JSON.parse(
  readFileSync(
    new URL('../../../test/fixtures/fleet/overview-sanitized.json', import.meta.url),
    'utf8',
  ),
);

test('脱敏真实结构：重复副本合并成 88 个技能、1 个工具且 88 个来源已登记', () => {
  const { input } = adaptProbeReport(report);
  assert.equal((input.skills as unknown[]).length, 88);
  assert.equal((input.mcp_servers as unknown[]).length, 1);
  const sources = judgeProbeReport(report).find((f) => f.ruleId === 'skill_source')!.subjects;
  assert.equal(sources.length, 88);
  assert.equal(sources.filter((s) => s.state === 'clear').length, 88);
  assert.equal(summarizeReport(report).assetsByKind.skill, 88);
});

test('文档、文档代码块、无扩展名命中待确认，可执行脚本命中才是风险', () => {
  for (const [file, context, expected] of [
    ['SKILL.md', 'document', 'review'],
    ['INSTALL.md', 'code_block', 'review'],
    ['README.rst', undefined, 'review'],
    ['unknown', undefined, 'review'],
    ['run.sh', 'code_block', 'risk'],
    ['run.py', undefined, 'risk'],
  ]) {
    const findings = judgeProbeReport({
      assets: [
        {
          kind: 'skill',
          name: '测试技能',
          evidence: {
            source: 'local_directory',
            static_assessment: {
              checks: [
                {
                  rule_id: 'skill.destructive_delete',
                  status: 'finding',
                  severity: 'high',
                  file_label: file,
                  context_type: context,
                  line_number: 51,
                  reason_zh: '命中删除规则',
                },
              ],
            },
          },
        },
      ],
    });
    const f = findings.find((f) => f.ruleId === 'skill_risk')!;
    assert.equal(f.subjects.find((s) => s.state !== 'not_checked')!.state, expected);
    assert.equal(f.state, expected);
    assert.equal(f.verdict, expected === 'risk' ? 'FAIL' : 'UNKNOWN');
    assert.equal(
      (f.subjects.find((s) => s.state === expected) as unknown as Record<string, unknown>)
        .file_label,
      file,
    );
  }
});

test('技能来源依次支持直接来源、安装证据、目录标签和下挂副本', () => {
  for (const evidence of [
    { source: 'local_directory' },
    { installation_evidence: 'verified_install' },
    { install_path_label: '测试目录' },
    { skills: [{ name: '测试技能', source: 'plugin_cache' }] },
  ]) {
    const f = judgeProbeReport({ assets: [{ kind: 'skill', name: '测试技能', evidence }] }).find(
      (f) => f.ruleId === 'skill_source',
    )!;
    assert.equal(f.subjects.length, 1);
    assert.equal(f.subjects[0]!.state, 'clear');
  }
});

test('真实结构三个说明文档命中不进入已发现风险计数', () => {
  const f = judgeProbeReport(report).find((f) => f.ruleId === 'skill_risk')!;
  assert.equal(f.subjects.filter((s) => s.state === 'risk').length, 0);
  assert.equal(f.subjects.filter((s) => s.state === 'review').length, 3);
});

test('同名不同内容技能分别保留，同一内容跨智能体装载合并归属', () => {
  const skill = (hash: string) => ({
    name: '同名技能',
    source: 'local_directory',
    static_assessment: {
      content_hash: hash,
      checks: [{ rule_id: 'skill.script_patterns', status: 'pass' }],
    },
  });
  const report = {
    assets: [
      { kind: 'cli_agent', name: 'claude-code', evidence: { skills: [skill('内容一')] } },
      {
        kind: 'cli_agent',
        name: 'codex',
        evidence: { skills: [skill('内容一'), skill('内容二')] },
      },
    ],
  };
  const input = adaptProbeReport(report).input;
  assert.equal((input.skills as unknown[]).length, 2);
  assert.deepEqual(
    ((input.skills as Array<Record<string, unknown>>)[0]!.installedIn as string[]).sort(),
    ['Claude Code', 'Codex'],
  );
});

test('其余技能行为没有检查时不在说明里拼接危险行为断言', () => {
  const f = judgeProbeReport({
    assets: [
      {
        kind: 'skill',
        name: '仅检查部分行为',
        evidence: {
          static_assessment: { checks: [{ rule_id: 'skill.destructive_delete', status: 'pass' }] },
        },
      },
    ],
  }).find((f) => f.ruleId === 'skill_risk')!;
  for (const s of f.subjects.filter((s) => s.state === 'not_checked'))
    assert.doesNotMatch(s.detail, /会读取凭据|会写入指令文件|会把内容上传/);
});

test('旧探针把技能检查放在智能体资产层时，文档命中仍是待确认', () => {
  const finding = judgeProbeReport({
    assets: [
      {
        kind: 'cli_agent',
        name: 'codex',
        evidence: {
          static_assessment: {
            checks: [
              {
                rule_id: 'skill.destructive_delete',
                status: 'finding',
                file_label: 'INSTALL.md',
                context_type: 'code_block',
              },
            ],
          },
        },
      },
    ],
  }).find((f) => f.ruleId === 'skill_risk')!;
  assert.equal(finding.state, 'review');
  assert.equal(finding.subjects.filter((s) => s.state === 'risk').length, 0);
});
