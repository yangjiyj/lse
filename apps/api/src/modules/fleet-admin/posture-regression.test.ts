import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judgeProbeReport } from './posture.js';
import { completeFinding, judgePosture, complianceSuffixText } from '../endpoint-evals/posture-judge.js';

const body = JSON.parse(
  readFileSync(
    new URL('../../../test/fixtures/fleet/demo-host-probe-report.json', import.meta.url),
    'utf8',
  ),
);
test('真实报告：局部采集失败不抹去 MCP 七项结果', () => {
  const findings = judgeProbeReport(body);
  const group = findings.find((f) => f.ruleId === 'mcp_risk')!;
  assert.ok(group.subjects?.length);
  const ppt = group.subjects.filter((s) => s.name.includes('ppt'));
  assert.equal(ppt.length, 7);
  assert.equal(ppt.filter((s) => s.state === 'clear').length, 4);
  assert.equal(ppt.filter((s) => s.state === 'not_checked').length, 3);
  for (const s of ppt.filter((s) => s.state === 'not_checked'))
    assert.match(s.detail, /未|没有|无法/);
  const transport = findings.find((f) => f.ruleId === 'mcp_transport')!;
  assert.equal(transport.state, 'clear');
  assert.match(transport.evidence, /本次采集有部分没完成/);
  assert.match(transport.evidence, /终端没有提供具体原因/);
  assert.match(transport.evidence, /已采集到的 1 个对象/);
  for (const f of findings) {
    assert.equal(
      f.verdict,
      { risk: 'FAIL', review: 'UNKNOWN', clear: 'PASS', not_checked: 'UNKNOWN' }[f.state],
    );
    assert.ok(Array.isArray(f.subjects));
    const suffix = complianceSuffixText(f.compliance);
    assert.ok(f.evidence.endsWith(suffix));
    assert.equal(f.evidence.split(suffix).length, 2);
    if (f.state === 'not_checked') assert.ok(f.notCheckedReason && f.howToCheck);
  }
});
test('真实报告：无执行位置的技能命中待确认，脚本没检查写明原因和办法', () => {
  const f = judgeProbeReport(body).find((f) => f.ruleId === 'skill_risk')!;
  assert.equal(f.state, 'review');
  assert.equal(f.subjects.filter((s) => s.state === 'review').length, 3);
  assert.equal(f.subjects.filter((s) => s.state === 'risk').length, 0);
  // 脚本没查完：写明是探针解析不了而不是权限问题，并带成因键
  const partial = f.subjects.filter(
    (s) => s.state === 'not_checked' && s.cause === 'skill_scan_partial',
  );
  assert.ok(partial.length > 0);
  assert.ok(partial.every((s) => /探针暂时解析不了/.test(s.detail)));
});
test('真实报告：八个命令行智能体与定时智能体均在检查范围内', () => {
  const findings = judgeProbeReport(body);
  for (const id of ['permissions', 'credentials', 'hooks']) {
    const f = findings.find((f) => f.ruleId === id)!;
    assert.equal(f.subjects.filter((s) => s.kind === 'agent').length, 9);
    for (const name of ['Claude Code', 'Codex', 'OpenCode', 'OpenClaw', 'Hermes'])
      assert.ok(f.subjects.some((s) => s.name.includes(name)));
  }
  assert.equal(
    findings
      .find((f) => f.ruleId === 'permissions')!
      .subjects.filter((s) => s.kind === 'scheduled_agent').length,
    10,
  );
});

test('技能只有单项结果、没有脚本汇总项时，其余行为规则列为没检查', () => {
  const f = judgeProbeReport({
    collectors: [{ name: 'agents', status: 'complete' }],
    assets: [
      {
        kind: 'skill',
        name: '只检查脚本的技能',
        evidence: {
          static_assessment: { checks: [{ rule_id: 'skill.destructive_delete', status: 'pass' }] },
        },
      },
    ],
  }).find((f) => f.ruleId === 'skill_risk')!;
  assert.equal(f.state, 'not_checked');
  assert.ok(f.subjects.some((s) => s.state === 'clear'));
  assert.ok(f.subjects.some((s) => s.state === 'not_checked' && s.cause === 'skill_rules_missing'));
});

test('不同智能体的权限和凭据结论独立，风险原因具体且不回显配置内容', () => {
  const findings = judgeProbeReport({
    collectors: [{ name: 'agents', status: 'partial' }],
    assets: [
      {
        kind: 'cli_agent',
        name: 'claude-code',
        evidence: {
          config: { permission_mode: 'bypassPermissions', auto_approval: 'enabled' },
          static_assessment: {
            checks: [
              { rule_id: 'config.credential', status: 'finding', reason_zh: '不可回显的配置内容' },
            ],
          },
        },
      },
      {
        kind: 'cli_agent',
        name: 'codex',
        evidence: {
          config: { permission_mode: 'default', auto_approval: 'disabled' },
          static_assessment: { checks: [{ rule_id: 'config.credential', status: 'pass' }] },
        },
      },
      { kind: 'cli_agent', name: 'hermes', evidence: { config: {} } },
    ],
  });
  const permission = findings.find((f) => f.ruleId === 'permissions')!;
  assert.equal(permission.subjects[0]!.state, 'risk');
  assert.match(permission.subjects[0]!.detail, /跳过|绕过|自动批准/);
  assert.equal(permission.subjects[1]!.state, 'clear');
  assert.equal(permission.subjects[2]!.state, 'not_checked');
  const credential = findings.find((f) => f.ruleId === 'credentials')!;
  assert.match(credential.subjects[0]!.detail, /凭据/);
  assert.equal(credential.subjects[1]!.state, 'clear');
  assert.equal(credential.subjects[2]!.state, 'not_checked');
  assert.doesNotMatch(JSON.stringify(findings), /不可回显的配置内容/);
});

test('智能体资产层的工具描述风险不能因缺少嵌套工具清单而丢失', () => {
  const result = judgeProbeReport({
    assets: [
      {
        kind: 'cli_agent',
        name: 'codex',
        evidence: {
          static_assessment: {
            checks: [{ rule_id: 'mcp.description_shadowing', status: 'finding' }],
          },
        },
      },
    ],
  }).find((f) => f.ruleId === 'mcp_injection')!;
  assert.equal(result.state, 'risk');
  assert.ok(result.subjects.some((s) => s.name.includes('Codex') && s.state === 'risk'));
});

test('所有配置判定规则的证据保留指引条款对照，重复补齐不重复追加，不再出现 ①②④', () => {
  for (const finding of judgePosture({})) {
    const suffix = complianceSuffixText(finding.compliance);
    assert.ok(finding.compliance.length > 0);
    assert.ok(finding.compliance.every((id) => id.startsWith('pg20266a.')), finding.ruleId);
    assert.ok(!/[①②③④]|智能体检测项/.test(finding.evidence), finding.ruleId);
    assert.ok(finding.evidence.endsWith(suffix), finding.ruleId);
    assert.deepEqual(completeFinding(finding), finding);
    const scoped = completeFinding({
      ...finding,
      evidence: finding.evidence + '本次仅覆盖已采集的对象。',
    });
    assert.ok(scoped.evidence.endsWith(suffix));
    assert.equal(scoped.evidence.split(suffix).length, 2);
    assert.ok(scoped.evidence.includes('本次仅覆盖已采集的对象。'));
  }
});

test('三态补齐只恢复报告证据对照，不改变管理员说明及对象明细；无映射不追加', () => {
  for (const verdict of ['PASS', 'FAIL', 'UNKNOWN'] as const) {
    const finding = {
      ruleId: 'permissions',
      title: '权限检查',
      severity: 'HIGH' as const,
      riskCategory: 'agent_tool_abuse',
      verdict,
      evidence: '原始检查说明。',
      compliance: ['pg20266a.deploy-least-privilege'],
      subjects: [
        {
          kind: 'agent' as const,
          name: 'Codex',
          state: 'not_checked' as const,
          detail: '缺少配置。',
        },
      ],
      plainTitle: '权限检查说明',
      plainWhy: '检查授权范围。',
      plainFix: '请核对授权。',
      notCheckedReason: '终端未提供配置。',
      howToCheck: '请更新探针后重试。',
    };
    const completed = completeFinding(finding);
    assert.deepEqual(completed, {
      ...finding,
      evidence: '原始检查说明。' + complianceSuffixText(['pg20266a.deploy-least-privilege']),
      state: verdict === 'PASS' ? 'clear' : verdict === 'FAIL' ? 'risk' : 'not_checked',
      notCheckedReason: verdict === 'UNKNOWN' ? finding.notCheckedReason : undefined,
      howToCheck: verdict === 'UNKNOWN' ? finding.howToCheck : undefined,
    });
    assert.equal(completeFinding({ ...finding, compliance: [] }).evidence, finding.evidence);
  }
});

test('历史证据里的「GB/T 45654 智能体检测项 ①②④」在补齐时被清除，换成指引条款对照', () => {
  const completed = completeFinding({
    ruleId: 'credentials',
    title: '凭据暴露',
    severity: 'MEDIUM',
    riskCategory: 'privacy_leakage',
    verdict: 'FAIL',
    evidence: '配置里有明文令牌。 GB/T 45654 智能体检测项：④（候选对照）。本次仅覆盖已采集的对象。',
    compliance: ['④', 'pg20266a.use-data-protection'],
  });
  assert.deepEqual(completed.compliance, ['pg20266a.use-data-protection']);
  assert.ok(!completed.evidence.includes('智能体检测项'));
  assert.ok(completed.evidence.includes('本次仅覆盖已采集的对象。'));
  assert.ok(completed.evidence.endsWith(complianceSuffixText(['pg20266a.use-data-protection'])));
  assert.match(completed.evidence, /TC260-PG-20266A 附录 A 使用阶段 · 正文 9 c\)「加强对自身个人信息以及敏感数据的安全防护」/);
});
