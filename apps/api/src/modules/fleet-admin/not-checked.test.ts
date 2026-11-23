import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEndpointOverview } from './overview.js';
import { judgeProbeReport } from './posture.js';
import { agentSnapshot } from './agent-snapshot.js';
import {
  NOT_CHECKED_CAUSES,
  buildNotCheckedRows,
  notCheckedCause,
} from '../../../../../packages/shared/src/not-checked.js';
import {
  FLEET_KNOWN_AGENT_PRODUCTS,
  fleetAgentDisplayName,
  fleetAgentIdentity,
} from '../../../../../packages/shared/src/fleet-agent-display.js';

const KEY = (c: string) => c.repeat(64);
const HASH = (c: string) => `sha256:${c.repeat(64)}`;
const users = [
  { account_key: KEY('a'), username: 'root', uid: '0' },
  { account_key: KEY('b'), username: 'nobody', uid: '65534' },
  { account_key: KEY('c'), username: 'libvirt-qemu', uid: '64055' },
  { account_key: KEY('d'), username: 'yj', uid: '1000' },
  { account_key: KEY('e'), username: 'alice', uid: '1001' },
];
type Cfg = [string, string, string];
const READ_FAILED: Cfg = ['read_failed', 'read_failed', 'read_failed'];
const DEFAULTS: Cfg = ['default:ask', 'default:disabled', 'default:none'];
const UNKNOWN: Cfg = ['unknown', 'unknown', 'unknown'];
const ITEMS = ['permission', 'auto_approval', 'sandbox'] as const;
/** 与探针一致：按每项取值生成 config.* 检查（读取失败/未知=unknown，默认值=pass，显式=按取值）。 */
function configChecks(cfg: Cfg) {
  return ITEMS.map((item, i) => {
    const value = cfg[i]!;
    if (value === 'read_failed')
      return { rule_id: `config.${item}`, status: 'unknown', evidence_code: `${item}_read_failed` };
    if (value === 'unknown')
      return { rule_id: `config.${item}`, status: 'unknown', evidence_code: `${item}_unknown` };
    if (value.startsWith('default:'))
      return {
        rule_id: `config.${item}`,
        status: 'pass',
        evidence_code: `${item}_default_applied`,
      };
    const risky = value === 'bypassPermissions' || value === 'enabled';
    return {
      rule_id: `config.${item}`,
      status: risky ? 'finding' : 'pass',
      evidence_code: risky ? `${item}_bypass` : `${item}_mode_observed`,
    };
  });
}
function agent(
  name: string,
  owner: string,
  hash: string,
  cfg: Cfg,
  credential: 'unknown' | 'pass' | 'finding' | 'none' = 'unknown',
  version = '1.0.0',
) {
  const code = {
    unknown: 'credential_scan_partial',
    pass: 'credential_not_matched',
    finding: 'credential_literal',
  };
  return {
    kind: 'cli_agent',
    name,
    version,
    evidence: {
      install_path_label: 'package.json',
      install_path_hash: hash,
      owner_account_key: owner,
      config: { permission_mode: cfg[0], auto_approval: cfg[1], sandbox_mode: cfg[2] },
      static_assessment: {
        checks: [
          ...configChecks(cfg),
          ...(credential === 'none'
            ? []
            : [
                {
                  rule_id: 'config.credential',
                  status: credential,
                  evidence_code: code[credential],
                },
              ]),
        ],
      },
    },
  };
}
const skill = (name: string, status: 'pass' | 'unknown' | 'none') => ({
  kind: 'skill',
  name,
  evidence: {
    source: 'local_directory',
    static_assessment: {
      content_hash: `h-${name}`,
      checks:
        status === 'none'
          ? []
          : [
              {
                rule_id: 'skill.script_patterns',
                status,
                evidence_code:
                  status === 'pass' ? 'script_pattern_not_matched' : 'script_scan_partial',
              },
            ],
    },
  },
});
const mcp = (name: string, checks: Array<[string, string, string]>) => ({
  kind: 'mcp_server',
  name,
  evidence: {
    server_name: name,
    scope: 'user',
    transport: 'stdio',
    static_assessment: {
      checks: checks.map(([rule_id, status, evidence_code]) => ({
        rule_id,
        status,
        evidence_code,
      })),
    },
  },
});
const PPT_MCP = mcp('ppt', [
  ['mcp.authorization', 'unknown', 'mcp_local_authorization_unknown'],
  ['mcp.credential', 'pass', 'mcp_credential_not_matched'],
  ['mcp.dependency', 'unknown', 'mcp_dependency_unknown'],
  ['mcp.descriptions', 'unknown', 'mcp_descriptions_uncollected'],
  ['mcp.launch', 'unknown', 'mcp_launch_unverified'],
  ['mcp.source', 'pass', 'mcp_source_fingerprinted'],
  ['mcp.transport', 'pass', 'mcp_stdio_transport'],
]);
/** 与现网 demo-host 同形态：系统账号名下重复发现的同一份全局安装、符号链接配置、本地 MCP、半数技能脚本没查完。 */
function prodLikeReport() {
  const shared = HASH('9');
  return {
    host: { users },
    collectors: [{ name: 'agents', status: 'partial' }],
    assets: [
      agent('claude-code', KEY('c'), shared, READ_FAILED, 'unknown', '2.1.126'),
      agent('claude-code', KEY('b'), shared, READ_FAILED, 'unknown', '2.1.126'),
      agent('claude-code', KEY('a'), shared, DEFAULTS, 'unknown', '2.1.126'),
      agent(
        'claude-code',
        KEY('d'),
        HASH('2'),
        ['bypassPermissions', 'enabled', 'unknown'],
        'finding',
        '2.1.308',
      ),
      agent('codex', KEY('d'), HASH('d'), READ_FAILED, 'unknown', '0.160.1'),
      agent('ollama', KEY('a'), HASH('f'), UNKNOWN, 'unknown', 'version_unknown'),
      PPT_MCP,
      { kind: 'instruction_file', name: 'CLAUDE.md', evidence: {} },
      { kind: 'instruction_file', name: 'AGENTS.md', evidence: {} },
      ...Array.from({ length: 23 }, (_, i) => skill(`干净技能-${i}`, 'pass')),
      ...Array.from({ length: 65 }, (_, i) => skill(`脚本复杂技能-${i}`, 'unknown')),
      {
        kind: 'platform_container',
        name: 'dify',
        display_name: 'Dify',
        version: '1.17.1',
        running: true,
        evidence: {
          detail: { container_id: 'abcdef123456789' },
          static_assessment: {
            checks: [
              {
                rule_id: 'platform.config_read',
                status: 'unknown',
                evidence_code: 'platform_config_partial',
              },
              {
                rule_id: 'platform.version',
                status: 'unknown',
                evidence_code: 'platform_version_unknown',
              },
              {
                rule_id: 'platform.secret_key',
                status: 'pass',
                evidence_code: 'platform_value_ok',
              },
            ],
          },
        },
      },
    ],
  };
}
const overviewOf = (report: unknown) => buildEndpointOverview({ body: report }, { id: '终端' });
const notChecked = (o: ReturnType<typeof overviewOf>) =>
  o.risks.filter((r) => r.level === 'NOT_CHECKED');

test('词表：每条成因都有处理方、短标题和不含“请开启”的办法，标题不超过 30 字', () => {
  for (const [key, cause] of Object.entries(NOT_CHECKED_CAUSES)) {
    assert.ok(['admin', 'manual', 'probe'].includes(cause.owner), key);
    assert.ok(cause.title.length <= 30, `${key} 标题过长`);
    assert.ok(cause.basis && cause.advice && cause.unit && cause.short, key);
    assert.doesNotMatch(
      cause.basis + cause.advice,
      /请开启|请开放|开放.*采集权限|补充采集依据/,
      key,
    );
    // 依据按“；”拆句展示，词表里的依据不能自己带分号
    assert.ok(!cause.basis.includes('；'), `${key} 依据含分号`);
  }
  assert.equal(notCheckedCause('不存在的键'), undefined);
  assert.equal(notCheckedCause(undefined), undefined);
});

test('合并：同一处理方、同一领域的成因合成一行，逐类说明放在 groups 里', () => {
  const rows = buildNotCheckedRows([
    { cause: 'skill_scan_partial', name: '技能甲' },
    { cause: 'skill_scan_partial', name: '技能乙' },
    { cause: 'mcp_dependency_unknown', name: 'ppt' },
    { cause: 'mcp_descriptions_uncollected', name: 'ppt' },
    { cause: 'mcp_launch_unverified', name: 'ppt' },
    { cause: 'hooks_not_reported', name: 'Codex' },
    { cause: 'config_read_failed', name: 'Codex' },
    { cause: 'credential_scan_blocked', name: 'Codex' },
    { cause: '词表外的键', name: '某对象' },
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'coverage.admin.agent',
    'coverage.admin.coverage',
    'coverage.manual.mcp',
    'coverage.probe.agent',
    'coverage.probe.skill',
  ]);
  // 管理员能动手的排在最前，同一处理方内按智能体、技能、MCP、平台排
  assert.equal(rows[0]!.owner, 'admin');
  assert.deepEqual(
    rows.map((r) => r.owner),
    ['admin', 'admin', 'manual', 'probe', 'probe'],
  );
  const mcpRow = byId['coverage.manual.mcp']!;
  assert.equal(mcpRow.groups!.length, 3);
  assert.equal(mcpRow.involved, '3 类检查');
  assert.ok(mcpRow.title.length <= 30);
  const skillRow = byId['coverage.probe.skill']!;
  assert.equal(skillRow.title, '技能脚本检查没有完成');
  assert.equal(skillRow.involved, '2 个技能');
  assert.equal(skillRow.subjectCount, 2);
  // 被配置读取失败覆盖的凭据检查不单独成行
  assert.ok(!rows.some((r) => r.groups?.some((g) => g.cause === 'credential_scan_blocked')));
  // 一律如此的成因只给数量，不逐个列名
  const hooks = byId['coverage.probe.agent']!.groups!.find(
    (g) => g.cause === 'hooks_not_reported',
  )!;
  assert.equal(hooks.subjectCount, 1);
  assert.deepEqual(hooks.subjects, []);
  // 词表外的键按“终端没有提供这项检查”处理：多半是探针版本太旧，归管理员升级
  assert.equal(byId['coverage.admin.coverage']!.title, NOT_CHECKED_CAUSES.check_missing.title);
});

test('合并：同一对象不重复计数，对象超过 50 个只留 50 个并给剩余数', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    cause: 'skill_scan_partial',
    name: `技能${i}`,
  }));
  const [row] = buildNotCheckedRows([...many, ...many]);
  assert.equal(row!.subjectCount, 120);
  assert.equal(row!.subjects.length, 50);
  assert.equal(row!.moreCount, 70);
});

test('技能：脚本检查通过就是已检查无风险，不再说“其余 8 类没有检查”', () => {
  const finding = judgeProbeReport({ assets: [skill('干净技能', 'pass')] }).find(
    (f) => f.ruleId === 'skill_risk',
  )!;
  assert.deepEqual(
    finding.subjects.map((s) => s.state),
    ['clear'],
  );
  assert.doesNotMatch(JSON.stringify(finding.subjects), /其余 \d+ 类/);
  // 全部技能脚本检查通过时整体闭环为通过，而不是永远“没检查”
  assert.equal(finding.verdict, 'PASS');
  assert.equal(finding.state, 'clear');
});

test('技能：脚本没查完归为探针暂时查不了，写明不是权限问题，且不含不存在的操作', () => {
  const finding = judgeProbeReport({ assets: [skill('复杂技能', 'unknown')] }).find(
    (f) => f.ruleId === 'skill_risk',
  )!;
  const subject = finding.subjects[0]!;
  assert.equal(subject.state, 'not_checked');
  assert.equal(subject.cause, 'skill_scan_partial');
  assert.equal(notCheckedCause(subject.cause)!.owner, 'probe');
  assert.equal(subject.detail, NOT_CHECKED_CAUSES.skill_scan_partial.basis);
  assert.match(finding.howToCheck ?? '', /不是权限问题/);
  assert.doesNotMatch(JSON.stringify(finding), /请更新探针|请开放|请确认技能目录/);
});

test('技能：没有脚本汇总结果时才说规则没查全，原因另归一类', () => {
  const rulesOnly = {
    kind: 'skill',
    name: '只有单项结果',
    evidence: {
      static_assessment: { checks: [{ rule_id: 'skill.destructive_delete', status: 'pass' }] },
    },
  };
  const f = judgeProbeReport({ assets: [rulesOnly, skill('完全没结果', 'none')] }).find(
    (x) => x.ruleId === 'skill_risk',
  )!;
  assert.deepEqual(
    f.subjects
      .filter((s) => s.state === 'not_checked')
      .map((s) => s.cause)
      .sort(),
    ['skill_no_result', 'skill_rules_missing'],
  );
});

test('MCP：三类没检查各自成因和处理方，不再让人“开启工具描述采集”', () => {
  const finding = judgeProbeReport({
    collectors: [{ name: 'agents', status: 'complete' }],
    assets: [PPT_MCP],
  }).find((f) => f.ruleId === 'mcp_risk')!;
  const causes = finding.subjects
    .filter((s) => s.state === 'not_checked')
    .map((s) => s.cause)
    .sort();
  assert.deepEqual(causes, [
    'mcp_dependency_unknown',
    'mcp_descriptions_uncollected',
    'mcp_launch_unverified',
    'mcp_local_authorization_unknown',
  ]);
  assert.ok(causes.every((c) => notCheckedCause(c)!.owner === 'manual'));
  // 旧探针才会缺的成因，管理员升级探针就能补上
  for (const key of [
    'skill_rules_missing',
    'skill_no_result',
    'skill_source_missing',
    'mcp_check_missing',
    'platform_not_assessed',
    'check_missing',
  ])
    assert.equal(notCheckedCause(key)!.owner, 'admin', key);
  // 新探针也做不到的，才是“暂时查不了”
  for (const key of [
    'skill_scan_partial',
    'hooks_not_reported',
    'broad_allow_not_reported',
    'platform_config_partial',
    'platform_version_unknown',
  ])
    assert.equal(notCheckedCause(key)!.owner, 'probe', key);
  assert.doesNotMatch(JSON.stringify(finding), /开启工具描述采集|补充组件版本及依赖检查/);
});

test('智能体：配置读不到的安装按成因归类，权限判定的没检查对象带成因和所在账号', () => {
  const report = prodLikeReport();
  const finding = judgeProbeReport(report).find((f) => f.ruleId === 'permissions')!;
  const codex = finding.subjects.find((s) => s.name.startsWith('Codex'))!;
  assert.equal(codex.state, 'not_checked');
  assert.equal(codex.cause, 'config_read_failed');
  assert.equal(codex.where, 'yj · …/package.json 所在目录');
  const ollama = finding.subjects.find((s) => s.name.startsWith('Ollama'))!;
  assert.equal(ollama.cause, 'config_unknown');
});

test('智能体：凭据检查没做的原因区分“被配置读取失败挡住”和“没有可检查的配置文件”', () => {
  const finding = judgeProbeReport(prodLikeReport()).find((f) => f.ruleId === 'credentials')!;
  const cause = (prefix: string) => finding.subjects.find((s) => s.name.startsWith(prefix))!.cause;
  assert.equal(cause('Codex'), 'credential_scan_blocked');
  assert.equal(cause('Ollama'), 'credential_no_files');
  assert.equal(cause('Claude Code 2.1.126'), 'credential_no_files');
});

test('智能体：探针不上报的防护接入与命令授权，写成探针暂时查不了，而不是让管理员开放权限', () => {
  const findings = judgeProbeReport(prodLikeReport());
  for (const [rule, cause] of [
    ['hooks', 'hooks_not_reported'],
    ['broad_allow', 'broad_allow_not_reported'],
  ] as const) {
    const subjects = findings
      .find((f) => f.ruleId === rule)!
      .subjects.filter((s) => s.kind === 'agent');
    assert.ok(subjects.length > 0);
    assert.ok(
      subjects.every((s) => s.state === 'not_checked' && s.cause === cause),
      rule,
    );
    assert.doesNotMatch(subjects.map((s) => s.detail).join(''), /请确认其配置可读取|开放/);
  }
});

test('系统账号：同一份全局安装在 nobody、libvirt-qemu 下重复发现且配置全读不到，折成一处安装', () => {
  const overview = overviewOf(prodLikeReport());
  const claude = overview.agents.find((a) => a.key === 'claude-code')!;
  assert.equal(claude.installs, 2);
  assert.deepEqual([...(claude.ignoredAccounts ?? [])].sort(), ['libvirt-qemu', 'nobody']);
  assert.equal(overview.counts.agentInstalls, 4);
  assert.equal(overview.counts.agentKinds, 3);
  // 折叠后的安装不再产生配置读取失败的没检查对象
  const failed = notChecked(overview).find((r) =>
    r.groups?.some((g) => g.cause === 'config_read_failed'),
  )!;
  assert.equal(failed.groups!.find((g) => g.cause === 'config_read_failed')!.subjectCount, 1);
  // 智能体判定的对象也一并折叠
  const permissions = judgeProbeReport(prodLikeReport()).find((f) => f.ruleId === 'permissions')!;
  assert.equal(permissions.subjects.filter((s) => s.kind === 'agent').length, 4);
  assert.equal(agentSnapshot(prodLikeReport()).length, 4);
});

test('系统账号：只有满足全部条件才折叠，普通用户账号读取失败要如实保留', () => {
  const base = prodLikeReport();
  const assets = (list: unknown[]) => ({ ...base, assets: list });
  const root = agent('claude-code', KEY('a'), HASH('9'), DEFAULTS);
  // 普通用户 alice 的配置读取失败，即使与 root 是同一份安装也不能当作重复
  const alice = agent('claude-code', KEY('e'), HASH('9'), READ_FAILED);
  assert.equal(overviewOf(assets([root, alice])).agents[0]!.installs, 2);
  // 路径指纹不同，是两份不同的安装
  const other = agent('claude-code', KEY('b'), HASH('3'), READ_FAILED);
  assert.equal(overviewOf(assets([root, other])).agents[0]!.installs, 2);
  // 系统账号自己读到了配置，不是重复
  const readable = agent('claude-code', KEY('b'), HASH('9'), ['ask', 'disabled', 'restricted']);
  assert.equal(overviewOf(assets([root, readable])).agents[0]!.installs, 2);
  // 同一份安装在所有账号下都读不到：没有可作代表的安装，全部保留
  const a = agent('claude-code', KEY('b'), HASH('9'), READ_FAILED);
  const b = agent('claude-code', KEY('c'), HASH('9'), READ_FAILED);
  assert.equal(overviewOf(assets([a, b])).agents[0]!.installs, 2);
  // 没有账号信息时不折叠
  const { host: _host, ...noHost } = base;
  assert.equal(overviewOf({ ...noHost, assets: [root, a] }).agents[0]!.installs, 2);
  // 折叠后的账号名不带出控制字符
  const weird = {
    ...base,
    host: { users: [...users, { account_key: KEY('f'), username: 'ni\u0000l', uid: '65533' }] },
  };
  const phantom = agent('claude-code', KEY('f'), HASH('9'), READ_FAILED);
  assert.deepEqual(overviewOf({ ...weird, assets: [root, phantom] }).agents[0]!.ignoredAccounts, [
    'nil',
  ]);
});

/** 新版探针不再枚举无家目录的系统账号：它们名下遗留的安装在本轮是 stale，账号表里已经没有这个账号。 */
type AgentAsset = ReturnType<typeof agent>;
const STALE = (a: AgentAsset) => ({
  ...a,
  evidence: { ...a.evidence, collection_status: 'stale' },
});
const usersWithoutSystemAccounts = users.filter((u) => ['0', '1000', '1001'].includes(u.uid));
function newProbeReport() {
  const base = prodLikeReport();
  const [ghostC, ghostB, ...rest] = base.assets;
  return {
    ...base,
    host: { users: usersWithoutSystemAccounts },
    assets: [STALE(ghostC as AgentAsset), STALE(ghostB as AgentAsset), ...rest],
  };
}

test('系统账号（新版探针）：账号已不在账号表、安装是 stale 且配置全读不到，同样折成一处安装', () => {
  const report = newProbeReport();
  const overview = overviewOf(report);
  const claude = overview.agents.find((a) => a.key === 'claude-code')!;
  assert.equal(claude.installs, 2);
  assert.equal(overview.counts.agentInstalls, 4);
  // 账号表里已经没有这个账号，不编造账号名
  assert.equal(claude.ignoredAccounts, undefined);
  const failed = notChecked(overview).find((r) =>
    r.groups?.some((g) => g.cause === 'config_read_failed'),
  )!;
  assert.equal(failed.groups!.find((g) => g.cause === 'config_read_failed')!.subjectCount, 1);
  const permissions = judgeProbeReport(report).find((f) => f.ruleId === 'permissions')!;
  assert.equal(permissions.subjects.filter((s) => s.kind === 'agent').length, 4);
  assert.equal(agentSnapshot(report).length, 4);
});

test('系统账号（新版探针）：只有 stale 且账号表里确实没有该账号才折叠，其余照旧保留', () => {
  const base = newProbeReport();
  const root = agent('claude-code', KEY('a'), HASH('9'), DEFAULTS);
  const ghost = () => STALE(agent('claude-code', KEY('c'), HASH('9'), READ_FAILED));
  const run = (list: unknown[], report: object = base) =>
    overviewOf({ ...report, assets: list }).agents[0]!.installs;
  assert.equal(run([root, ghost()]), 1);
  // 旧探针形态：账号不在账号表里但不是 stale，判定与升级前完全一致（不折叠）
  assert.equal(run([root, agent('claude-code', KEY('c'), HASH('9'), READ_FAILED)]), 2);
  // stale 但账号在账号表里且是普通用户：如实保留
  assert.equal(run([root, STALE(agent('claude-code', KEY('e'), HASH('9'), READ_FAILED))]), 2);
  // stale 但路径指纹不同：是另一份安装
  assert.equal(run([root, STALE(agent('claude-code', KEY('c'), HASH('3'), READ_FAILED))]), 2);
  // stale 但读到了配置：不是重复
  const readable = STALE(
    agent('claude-code', KEY('c'), HASH('9'), ['ask', 'disabled', 'restricted']),
  );
  assert.equal(run([root, readable]), 2);
  // stale 但带发现项：风险不能被折掉
  const risky = STALE(agent('claude-code', KEY('c'), HASH('9'), READ_FAILED, 'finding'));
  assert.equal(run([root, risky]), 2);
  // 没有可作代表的安装：全部保留
  const another = STALE(agent('claude-code', KEY('f'), HASH('9'), READ_FAILED));
  assert.equal(run([ghost(), another]), 2);
  // 代表是账号表里的普通用户安装（即使本身读不到配置），遗留安装折进去
  const yj = agent('claude-code', KEY('d'), HASH('9'), READ_FAILED);
  assert.equal(run([ghost(), yj]), 1);
  // 没有账号信息时不折叠
  const { host: _host, ...noHost } = base;
  assert.equal(run([root, ghost()], noHost), 2);
  // 没有账号归属字段的 stale 安装不折叠
  assert.equal(run([root, STALE(agent('claude-code', '', HASH('9'), READ_FAILED))]), 2);
});

test('系统账号（新版探针）：300 个遗留安装折叠在 2 秒内完成', () => {
  const base = newProbeReport();
  const root = agent('claude-code', KEY('a'), HASH('9'), DEFAULTS);
  const ghosts = Array.from({ length: 300 }, (_, i) =>
    STALE(agent('claude-code', `${i}`.padStart(64, '0'), HASH('9'), READ_FAILED)),
  );
  const started = Date.now();
  const overview = overviewOf({ ...base, assets: [root, ...ghosts] });
  assert.ok(Date.now() - started < 2000);
  assert.equal(overview.agents[0]!.installs, 1);
});

test('智能体版本：多处安装版本不一致时，version 取最高版本，其余版本放 otherVersions，不再混进配置说明', () => {
  const claude = overviewOf(prodLikeReport()).agents.find((a) => a.key === 'claude-code')!;
  assert.equal(claude.version, '2.1.308');
  assert.deepEqual(claude.otherVersions, ['2.1.126']);
  assert.ok(!/存在多个版本/.test(claude.configNote ?? ''));
  // 只有一个版本的产品不带这个字段
  const codex = overviewOf(prodLikeReport()).agents.find((a) => a.key === 'codex')!;
  assert.equal(codex.otherVersions, undefined);
  // 三个版本按由高到低排列，去掉最高的
  const base = prodLikeReport();
  const three = {
    ...base,
    assets: [
      agent('claude-code', KEY('d'), HASH('2'), DEFAULTS, 'unknown', '2.1.9'),
      agent('claude-code', KEY('e'), HASH('3'), DEFAULTS, 'unknown', '2.1.126'),
      agent('claude-code', KEY('a'), HASH('4'), DEFAULTS, 'unknown', '2.1.308'),
    ],
  };
  assert.deepEqual(overviewOf(three).agents[0]!.otherVersions, ['2.1.126', '2.1.9']);
});

test('概览：现网形态的没检查按处理方和领域合成 6 行，每行都有处理方、办法，标题不超过 30 字', () => {
  const overview = overviewOf(prodLikeReport());
  const rows = notChecked(overview);
  assert.deepEqual(
    rows.map((r) => r.id),
    [
      'coverage.admin.agent',
      'coverage.manual.agent',
      'coverage.manual.mcp',
      'coverage.probe.agent',
      'coverage.probe.skill',
      'coverage.probe.platform',
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.owner),
    ['admin', 'manual', 'manual', 'probe', 'probe', 'probe'],
  );
  for (const row of rows) {
    assert.ok(row.title.length <= 30, row.title);
    assert.ok(row.basis && row.advice && row.groups?.length, row.id);
    assert.ok(row.subjectCount > 0, row.id);
  }
  // 旧探针没有上报沙箱字段：管理员这一行在“配置读取失败”之外多一类“沙箱设置没有上报”，只给数量
  const admin = rows[0]!;
  assert.deepEqual(
    admin.groups!.map((g) => g.cause),
    ['config_read_failed', 'sandbox_not_reported'],
  );
  assert.equal(admin.involved, '2 类检查');
  const unread = admin.groups![0]!;
  assert.equal(unread.title, '配置读取失败');
  assert.equal(unread.subjectCount, 1);
  assert.match(unread.advice, /符号链接换成真实文件/);
  assert.deepEqual(
    admin.subjects.map((s) => s.name),
    ['Codex 0.160.1'],
  );
  assert.equal(admin.subjects[0]!.detail, 'yj · …/package.json 所在目录');
  assert.deepEqual(admin.groups![1]!.subjects, []);
  // 没有核对过官方沙箱配置项的智能体（这里是 Ollama）归为需人工核对
  assert.equal(rows[1]!.title, '沙箱设置没法核对');
  assert.deepEqual(
    rows[1]!.subjects.map((s) => s.name),
    ['Ollama'],
  );
  const skills = rows[4]!;
  assert.equal(skills.involved, '65 个技能');
  assert.equal(overview.counts.notCheckedKinds, 6);
  assert.equal(overview.counts.notCheckedAdmin, 1);
  assert.doesNotMatch(JSON.stringify(rows), /请更新探针并|请开启|补充采集依据|开放对应配置/);
});

test('概览：待确认的技能脚本没查完时也带成因，列表按整体状态显示', () => {
  const risky = {
    kind: 'skill',
    name: '文档里有命中的技能',
    evidence: {
      source: 'local_directory',
      static_assessment: {
        content_hash: 'h-doc',
        checks: [
          {
            rule_id: 'skill.pipe_shell',
            status: 'finding',
            file_label: 'README.md',
            context_type: 'document',
          },
          {
            rule_id: 'skill.script_patterns',
            status: 'unknown',
            evidence_code: 'script_scan_partial',
          },
        ],
      },
    },
  };
  const row = overviewOf({ assets: [risky] }).skills[0]!;
  assert.equal(row.state, 'review');
  assert.equal(row.cause, 'skill_scan_partial');
  // 风险表里这个技能也算进“脚本没完成”那一行，行数与列表里的原因能对上
  const risk = notChecked(overviewOf({ assets: [risky] })).find((r) => r.category === 'skill')!;
  assert.equal(risk.subjectCount, 1);
});

test('概览：没检查的技能和 MCP 检查带成因；通过脚本检查的技能是已检查无风险', () => {
  const overview = overviewOf(prodLikeReport());
  const states = overview.skills.map((s) => s.state);
  assert.equal(states.filter((s) => s === 'clear').length, 23);
  const partial = overview.skills.filter((s) => s.state === 'not_checked');
  assert.equal(partial.length, 65);
  assert.ok(partial.every((s) => s.cause === 'skill_scan_partial'));
  const ppt = overview.mcp[0]!;
  const unknown = ppt.checks.filter((c) => c.state === 'unknown');
  assert.deepEqual(unknown.map((c) => c.cause).sort(), [
    'mcp_dependency_unknown',
    'mcp_descriptions_uncollected',
    'mcp_launch_unverified',
    'mcp_local_authorization_unknown',
  ]);
  assert.ok(ppt.checks.filter((c) => c.state === 'pass').every((c) => c.cause === undefined));
});

test('平台：版本对照缺失和配置读不全成为探针暂时查不了的没检查，镜像没写版本号归管理员', () => {
  const unread = notChecked(overviewOf(prodLikeReport())).find((r) => r.category === 'platform')!;
  assert.equal(unread.owner, 'probe');
  assert.deepEqual(unread.groups!.map((g) => g.cause).sort(), [
    'platform_config_partial',
    'platform_version_unknown',
  ]);
  const unversioned = prodLikeReport();
  const dify = unversioned.assets.find((a) => a.kind === 'platform_container') as Record<
    string,
    unknown
  >;
  dify.version = 'version_unknown';
  const row = notChecked(overviewOf(unversioned)).find((r) => r.id === 'coverage.admin.platform')!;
  assert.deepEqual(
    row.groups!.map((g) => g.cause),
    ['platform_image_no_version'],
  );
  assert.match(row.advice, /带具体版本号/);
  const checks = overviewOf(unversioned).platforms[0]!.checks.filter((c) => c.state === 'unread');
  assert.deepEqual(checks.map((c) => [c.rule, c.cause]).sort(), [
    ['config_read', 'platform_config_partial'],
    ['version', 'platform_image_no_version'],
  ]);
});

test('显示名：探针识别的产品都有中文可读的名称，词表外的产品仍保留原始标识', () => {
  assert.equal(fleetAgentDisplayName('claude-desktop'), 'Claude Desktop');
  assert.equal(fleetAgentDisplayName('ollama'), 'Ollama');
  assert.equal(fleetAgentIdentity('claude-desktop'), 'Claude Desktop');
  assert.equal(fleetAgentIdentity('lingma'), '通义灵码');
  assert.equal(fleetAgentIdentity('完全不认识'), '未识别的智能体（原始标识：完全不认识）');
  assert.ok(FLEET_KNOWN_AGENT_PRODUCTS.length >= 89);
  assert.ok(FLEET_KNOWN_AGENT_PRODUCTS.every((p) => !fleetAgentIdentity(p).includes('未识别')));
});

test('没有可列对象的没检查发现项：合成一行“终端没有提供这项检查”，名称取检查项标题，不报错', () => {
  const overview = overviewOf({ assets: [] });
  const rows = notChecked(overview);
  assert.ok(rows.length >= 1);
  const row = rows.find((r) => r.id === 'coverage.admin.coverage')!;
  assert.equal(row.title, NOT_CHECKED_CAUSES.check_missing.title);
  assert.ok(row.subjects.every((s) => s.name.length > 0));
  assert.equal(buildEndpointOverview(null, { id: '终端' }).risks.length, 0);
});

test('合并：整行的 moreCount 按各组被截掉的数量累计', () => {
  const entries = [
    ...Array.from({ length: 60 }, (_, i) => ({ cause: 'skill_no_result', name: `技能${i}` })),
    // skill_no_result 归管理员，另起一行；同一处理方内的另一成因才会并进同一行
    ...Array.from({ length: 55 }, (_, i) => ({ cause: 'skill_rules_missing', name: `另一批${i}` })),
  ];
  const [row] = buildNotCheckedRows(entries);
  assert.equal(row!.subjectCount, 115);
  assert.equal(row!.subjects.length, 50);
  assert.equal(row!.moreCount, 65);
  // 组按词表顺序排：skill_rules_missing（55 个）在 skill_no_result（60 个）之前
  assert.deepEqual(
    row!.groups!.map((g) => [g.cause, g.subjects.length, g.moreCount]),
    [
      ['skill_rules_missing', 50, 5],
      ['skill_no_result', 50, 10],
    ],
  );
});

test('平台：只识别出平台、没做体检归探针，读不全却没有未读项也留一行可闭环', () => {
  const plain = {
    kind: 'platform_container',
    name: 'dify',
    display_name: 'Dify',
    version: '1.2.0',
    running: true,
    evidence: { detail: { container_id: 'abc' } },
  };
  const row = notChecked(overviewOf({ assets: [plain] })).find((r) => r.category === 'platform')!;
  assert.deepEqual(
    row.groups!.map((g) => g.cause),
    ['platform_not_assessed'],
  );
  const partial = {
    ...plain,
    evidence: {
      detail: { container_id: 'abc' },
      static_assessment: { checks: [{ rule_id: 'platform.config_read', status: 'pass' }] },
    },
  };
  const rows = notChecked(
    overviewOf({ assets: [partial, { ...partial, evidence: { detail: {} } }] }),
  );
  assert.ok(rows.some((r) => r.category === 'platform'));
});
