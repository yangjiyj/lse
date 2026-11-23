import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePosture } from '../endpoint-evals/posture-judge.js';
import { judgeProbeReport } from './posture.js';
import { buildEndpointOverview } from './overview.js';
import { CHECK_CATALOG } from './check-catalog.js';
import {
  NOT_CHECKED_CAUSES,
  notCheckedCause,
} from '../../../../../packages/shared/src/not-checked.js';
import { POSTURE_RULE_TO_AGENT_REQUIREMENTS, POSTURE_RULE_TO_CLAUSES } from '@lse/shared';

const RULES = ['sandbox_enabled', 'sandbox_bypass', 'sandbox_credential_read'] as const;
type Rule = (typeof RULES)[number];

const verdict = (sandbox: Record<string, unknown> | undefined, rule: Rule) =>
  judgePosture(sandbox ? { sandbox } : {}).find((f) => f.ruleId === rule)?.verdict;

/** 一处智能体安装；sandbox 缺省表示旧探针（没有上报沙箱字段）。 */
function agent(name: string, sandbox?: unknown, version = '1.0.0') {
  return {
    kind: 'cli_agent',
    name,
    version,
    evidence: {
      static_assessment: { checks: [] },
      config: {},
      ...(sandbox === undefined ? {} : { sandbox }),
    },
  };
}
const report = (...assets: unknown[]) => ({
  collectors: [{ name: 'agents', status: 'complete' }],
  assets,
});
const finding = (body: unknown, rule: Rule) =>
  judgeProbeReport(body).find((f) => f.ruleId === rule)!;
const ON = { support: 'supported', enabled: true, enabled_source: 'explicit' };

test('目录：三项沙箱检查都在体检目录里，中危，归在部署与运行环境', () => {
  for (const rule of RULES) {
    const item = CHECK_CATALOG.posture.find((c) => c.id === rule);
    assert.ok(item, rule);
    assert.equal(item.severity, 'MEDIUM');
    assert.equal(item.category, 'environment');
    assert.deepEqual(item.impact.touches, ['智能体沙箱配置']);
    assert.ok(POSTURE_RULE_TO_CLAUSES[rule]?.length, rule);
    assert.ok(POSTURE_RULE_TO_AGENT_REQUIREMENTS[rule]?.length, rule);
  }
});

test('规则：没开、可绕开、凭据目录可读各自命中；没有取得就是未知', () => {
  assert.equal(verdict({ off: true }, 'sandbox_enabled'), 'FAIL');
  assert.equal(verdict({ off: false }, 'sandbox_enabled'), 'PASS');
  assert.equal(verdict({ bypass_allowed: true }, 'sandbox_bypass'), 'FAIL');
  assert.equal(verdict({ bypass_allowed: false }, 'sandbox_bypass'), 'PASS');
  assert.equal(verdict({ credential_readable: true }, 'sandbox_credential_read'), 'FAIL');
  assert.equal(verdict({ credential_readable: false }, 'sandbox_credential_read'), 'PASS');
  for (const rule of RULES) {
    assert.equal(verdict(undefined, rule), 'UNKNOWN', rule);
    // 只有完整主机访问这一项事实时，不能顺带把三项新检查算成通过
    assert.equal(verdict({ full_access: false }, rule), 'UNKNOWN', rule);
  }
});

test('没开：支持但没开、当前系统不支持、没有自带沙箱三种情形都算风险，说法各不相同', () => {
  const off = finding(
    report(
      agent('claude-code', { support: 'supported', enabled: false, enabled_source: 'default' }),
    ),
    'sandbox_enabled',
  );
  assert.equal(off.verdict, 'FAIL');
  assert.match(off.subjects[0]!.detail, /没有开启/);
  const unsupported = finding(
    report(agent('claude-code', { support: 'platform_unsupported' })),
    'sandbox_enabled',
  );
  assert.equal(unsupported.verdict, 'FAIL');
  assert.match(unsupported.subjects[0]!.detail, /当前系统上不支持/);
  assert.doesNotMatch(unsupported.subjects[0]!.detail, /没有开启/);
  const none = finding(report(agent('opencode', { support: 'no_builtin' })), 'sandbox_enabled');
  assert.equal(none.verdict, 'FAIL');
  assert.match(none.subjects[0]!.detail, /没有自带沙箱/);
  assert.doesNotMatch(none.subjects[0]!.detail, /没有开启|不支持/);
  const on = finding(report(agent('codex', ON)), 'sandbox_enabled');
  assert.equal(on.verdict, 'PASS');
  assert.equal(on.subjects[0]!.state, 'clear');
});

test('可绕开：允许命令不经沙箱运行算风险并说明途径，关闭后通过', () => {
  const open = finding(
    report(
      agent('claude-code', {
        ...ON,
        unsandboxed_allowed: true,
        unsandboxed_via: ['allow_unsandboxed_commands', 'excluded_commands', '探针自带的说明'],
      }),
    ),
    'sandbox_bypass',
  );
  assert.equal(open.verdict, 'FAIL');
  assert.match(open.subjects[0]!.detail, /不经沙箱/);
  assert.match(open.subjects[0]!.detail, /排除在沙箱之外/);
  // 途径只按已知代码转成固定说法，不回显探针给的其他文字
  assert.doesNotMatch(JSON.stringify(open), /探针自带的说明/);
  const closed = finding(
    report(agent('claude-code', { ...ON, unsandboxed_allowed: false })),
    'sandbox_bypass',
  );
  assert.equal(closed.verdict, 'PASS');
});

test('凭据目录：沙箱内读得到的目录按固定名称列出，全部排除后通过', () => {
  const exposed = finding(
    report(
      agent('claude-code', {
        ...ON,
        credential_dirs: {
          checked: ['.ssh', '.aws', '.kube'],
          readable: ['.ssh', '.aws', '/home/user/私有目录'],
        },
      }),
    ),
    'sandbox_credential_read',
  );
  assert.equal(exposed.verdict, 'FAIL');
  assert.match(exposed.subjects[0]!.detail, /~\/\.ssh、~\/\.aws/);
  assert.doesNotMatch(JSON.stringify(exposed), /私有目录/);
  const excluded = finding(
    report(
      agent('claude-code', {
        ...ON,
        credential_dirs: { checked: ['.ssh', '.aws'], readable: [] },
      }),
    ),
    'sandbox_credential_read',
  );
  assert.equal(excluded.verdict, 'PASS');
});

test('沙箱没开时，绕开与凭据目录两项记为未检查并指向先开沙箱，不算通过也不算风险', () => {
  for (const sandbox of [
    { support: 'supported', enabled: false, enabled_source: 'explicit' },
    { support: 'platform_unsupported' },
    { support: 'no_builtin' },
  ]) {
    const body = report(agent('claude-code', sandbox));
    for (const rule of ['sandbox_bypass', 'sandbox_credential_read'] as const) {
      const f = finding(body, rule);
      assert.equal(f.verdict, 'UNKNOWN', rule);
      assert.equal(f.subjects[0]!.state, 'not_checked');
      assert.equal(f.subjects[0]!.cause, 'sandbox_not_enabled');
      assert.match(f.howToCheck ?? '', /沙箱未开启/);
    }
  }
  // 这一类已经由“沙箱未开启”的风险行说明，概览里不再单独成行
  const overview = buildEndpointOverview(
    { body: report(agent('claude-code', { support: 'supported', enabled: false })) },
    { id: '终端' },
  );
  assert.ok(
    overview.risks.some((r) => r.id.startsWith('sandbox_enabled:') && r.level === 'MEDIUM'),
  );
  assert.ok(!overview.risks.some((r) => r.groups?.some((g) => g.cause === 'sandbox_not_enabled')));
});

test('旧探针没有上报沙箱字段：三项都是未检查并写明原因，由管理员升级探针', () => {
  const body = report(agent('claude-code'), agent('codex'));
  for (const rule of RULES) {
    const f = finding(body, rule);
    assert.equal(f.verdict, 'UNKNOWN', rule);
    assert.equal(f.state, 'not_checked');
    assert.equal(f.subjects.length, 2);
    assert.ok(
      f.subjects.every((s) => s.state === 'not_checked' && s.cause === 'sandbox_not_reported'),
    );
    assert.equal(f.notCheckedReason, NOT_CHECKED_CAUSES.sandbox_not_reported.basis);
    assert.match(f.howToCheck ?? '', /升级/);
  }
  assert.equal(notCheckedCause('sandbox_not_reported')!.owner, 'admin');
  const overview = buildEndpointOverview({ body }, { id: '终端' });
  const row = overview.risks.find(
    (r) => r.level === 'NOT_CHECKED' && r.groups?.some((g) => g.cause === 'sandbox_not_reported'),
  );
  assert.ok(row);
  assert.equal(row.owner, 'admin');
  // 同一处安装在三项检查里只计一次
  assert.equal(row.groups!.find((g) => g.cause === 'sandbox_not_reported')!.subjectCount, 2);
  assert.ok(!overview.risks.some((r) => /^sandbox_(enabled|bypass|credential_read):/.test(r.id)));
});

test('没有核对过官方配置项的智能体，以及探针说明查不了的项，归为需人工核对', () => {
  const other = finding(report(agent('cursor', ON)), 'sandbox_enabled');
  assert.equal(other.verdict, 'UNKNOWN');
  assert.equal(other.subjects[0]!.cause, 'sandbox_unverifiable');
  assert.equal(notCheckedCause('sandbox_unverifiable')!.owner, 'manual');
  const gemini = agent('gemini', {
    support: 'supported',
    enabled: true,
    enabled_source: 'explicit',
    unread: { unsandboxed: 'not_documented', credential_dirs: 'read_scope_undocumented' },
  });
  assert.equal(finding(report(gemini), 'sandbox_enabled').verdict, 'PASS');
  for (const rule of ['sandbox_bypass', 'sandbox_credential_read'] as const) {
    const f = finding(report(gemini), rule);
    assert.equal(f.verdict, 'UNKNOWN', rule);
    assert.equal(f.subjects[0]!.cause, 'sandbox_unverifiable');
  }
  const envOnly = agent('gemini', { support: 'supported', unread: { enabled: 'env_may_enable' } });
  for (const rule of RULES)
    assert.equal(finding(report(envOnly), rule).subjects[0]!.cause, 'sandbox_unverifiable', rule);
});

test('配置读不到：三项都归到“配置读取失败”，沿用现有成因', () => {
  const unread = agent('codex', {
    support: 'supported',
    unread: {
      enabled: 'config_read_failed',
      unsandboxed: 'config_read_failed',
      credential_dirs: 'config_read_failed',
    },
  });
  for (const rule of RULES) {
    const f = finding(report(unread), rule);
    assert.equal(f.verdict, 'UNKNOWN', rule);
    assert.equal(f.subjects[0]!.cause, 'config_read_failed');
  }
});

test('字段形状不对时按未检查处理，不报错也不当成通过', () => {
  for (const sandbox of [
    null,
    'on',
    [],
    { support: 'supported', enabled: 'true' },
    { support: '别的取值', enabled: true },
    { ...ON, unsandboxed_allowed: 'no', credential_dirs: { checked: ['.ssh'], readable: '.ssh' } },
    { ...ON, credential_dirs: { readable: [] } },
    { ...ON, credential_dirs: ['.ssh'] },
  ]) {
    const body = report(agent('claude-code', sandbox));
    for (const rule of RULES) {
      const f = finding(body, rule);
      if (
        rule === 'sandbox_enabled' &&
        sandbox &&
        typeof sandbox === 'object' &&
        !Array.isArray(sandbox) &&
        sandbox.support === 'supported' &&
        sandbox.enabled === true
      )
        assert.equal(f.verdict, 'PASS');
      else assert.equal(f.verdict, 'UNKNOWN', `${rule} ${JSON.stringify(sandbox)}`);
    }
  }
});

test('多处安装：一处有风险整体就是风险；其余没检查不被通过盖住', () => {
  const body = report(
    agent('claude-code', { ...ON, unsandboxed_allowed: false }),
    agent('codex', { ...ON, unsandboxed_allowed: true, unsandboxed_via: ['approval_on_request'] }),
    agent('gemini', { ...ON, unread: { unsandboxed: 'not_documented' } }),
  );
  const f = finding(body, 'sandbox_bypass');
  assert.equal(f.verdict, 'FAIL');
  assert.deepEqual(
    f.subjects.map((s) => s.state),
    ['clear', 'risk', 'not_checked'],
  );
  const clearAndUnknown = finding(
    report(
      agent('claude-code', { ...ON, unsandboxed_allowed: false }),
      agent('gemini', { ...ON, unread: { unsandboxed: 'not_documented' } }),
    ),
    'sandbox_bypass',
  );
  assert.equal(clearAndUnknown.verdict, 'UNKNOWN');
});
