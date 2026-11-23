import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentInstallLocation,
  agentOwnerAccount,
  agentSnapshot,
  attachAgentSnapshot,
} from './agent-snapshot.js';
import { summarizeConfigItems } from './inventory.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const HASH = `sha256:${'9'.repeat(64)}`;

function agent(
  name: string,
  label: string,
  owner: string,
  config: Record<string, string> = {},
  kind = 'cli_agent',
) {
  return {
    kind,
    name,
    version: '2.1.126',
    evidence: {
      install_path_label: label,
      install_path_hash: HASH,
      owner_account_key: owner,
      owner_hash: HASH,
      config,
    },
  };
}
const cfg = (v: string[]) => ({
  permission_mode: v[0]!,
  auto_approval: v[1]!,
  sandbox_mode: v[2]!,
});
const report = {
  host: {
    users: [
      { account_key: KEY_A, username: 'alice', domain: 'WORKGROUP', uid: '1001', is_current: false },
      { account_key: KEY_B, username: 'yj', domain: 'WORKGROUP', uid: '1000', is_current: true },
    ],
  },
  assets: [
    agent('claude-code', 'package.json', KEY_A, cfg(['ask', 'disabled', 'restricted'])),
    agent('claude-code', 'package.json', KEY_B, cfg(['unknown', 'unknown', 'unknown'])),
    agent('claude-code', '.claude', KEY_B, cfg(['internal_store', 'unknown', 'internal_store'])),
    { kind: 'skill', name: '某技能', evidence: { install_path_label: 'skills' } },
    agent('codex', '.codex', KEY_B, cfg(['default:ask', 'disabled', 'default:none'])),
  ],
};

test('安装位置：点开头的目录写成主目录相对路径，package.json 说明在其所在目录', () => {
  const loc = (label: string) => agentInstallLocation(agent('x', label, KEY_A));
  assert.equal(loc('.claude'), '~/.claude');
  assert.equal(loc('package.json'), '…/package.json 所在目录');
  assert.equal(loc('opencode'), 'opencode');
  assert.equal(loc('claude.exe'), 'claude.exe');
  assert.equal(loc(''), null);
  assert.equal(agentInstallLocation({ kind: 'cli_agent', name: 'x', evidence: {} }), null);
  assert.equal(agentInstallLocation({}), null);
  assert.equal(agentInstallLocation(null), null);
});

test('安装位置：缺少目录标签时退回到可执行文件标签', () => {
  assert.equal(
    agentInstallLocation({ evidence: { installed_binary_path_label: 'claude.exe' } }),
    'claude.exe',
  );
});

test('安装位置：只保留末级名称，不回显绝对路径；凭据样式内容与控制字符被清理，长度有上限', () => {
  const loc = (label: string) => agentInstallLocation(agent('x', label, KEY_A));
  assert.equal(loc('/Users/alice/.claude'), '~/.claude');
  assert.equal(loc('C:\\Users\\alice\\tool.exe'), 'tool.exe');
  assert.equal(loc('/home/alice/work/package.json'), '…/package.json 所在目录');
  assert.doesNotMatch(loc('/Users/alice/work/app') ?? '', /Users|alice|work/);
  assert.doesNotMatch(loc('sk-abcdefghijklmnop1234') ?? '', /sk-abcdefghijklmnop1234/);
  assert.doesNotMatch(loc('a\u0000b\u001fc') ?? '', /[\u0000-\u001f]/);
  assert.ok((loc('x'.repeat(500)) ?? '').length <= 80);
});

test('所属账号：按 owner_account_key 在主机账号表里找用户名，只给用户名', () => {
  const [first, second] = report.assets;
  assert.equal(agentOwnerAccount(first, report), 'alice');
  assert.equal(agentOwnerAccount(second, report), 'yj');
  assert.doesNotMatch(String(agentOwnerAccount(first, report)), /WORKGROUP|1001|aaaa/);
});

test('所属账号：账号表缺失、没有对应账号或没有账号键时为空', () => {
  const asset = agent('claude-code', '.claude', KEY_C);
  assert.equal(agentOwnerAccount(asset, report), null);
  assert.equal(agentOwnerAccount(asset, {}), null);
  assert.equal(agentOwnerAccount(agent('claude-code', '.claude', ''), report), null);
  assert.equal(agentOwnerAccount(asset, { host: { users: 'bad' } }), null);
  assert.equal(agentOwnerAccount(null, report), null);
});

test('所属账号：控制字符被清理，凭据样式内容被遮蔽，长度有上限', () => {
  const r = {
    host: {
      users: [
        { account_key: KEY_A, username: 'ali\u0000ce' },
        { account_key: KEY_B, username: 'sk-abcdefghijklmnop1234' },
        { account_key: KEY_C, username: 'u'.repeat(300) },
      ],
    },
  };
  assert.equal(agentOwnerAccount(agent('x', '.x', KEY_A), r), 'alice');
  assert.doesNotMatch(String(agentOwnerAccount(agent('x', '.x', KEY_B), r)), /sk-abcdefghijklmnop1234/);
  assert.ok((agentOwnerAccount(agent('x', '.x', KEY_C), r) ?? '').length <= 64);
});

test('快照：只含智能体类资产，每个安装一条，保留上报顺序和各自配置六态', () => {
  const snapshot = agentSnapshot(report);
  assert.equal(snapshot.length, 4);
  assert.deepEqual(
    snapshot.map((s) => [s.name, s.configState, s.location, s.account]),
    [
      ['claude-code', 'checked', '…/package.json 所在目录', 'alice'],
      ['claude-code', 'not_checked', '…/package.json 所在目录', 'yj'],
      ['claude-code', 'internal_store', '~/.claude', 'yj'],
      ['codex', 'default', '~/.codex', 'yj'],
    ],
  );
  assert.deepEqual(snapshot[2]!.configItems, [
    { item: 'permission', state: 'internal_store' },
    { item: 'auto_approval', state: 'unknown' },
    { item: 'sandbox', state: 'internal_store' },
  ]);
});

test('快照只存判断结果：不含配置取值、哈希、账号键和其他账号信息', () => {
  const marked = {
    ...report,
    assets: [
      agent('claude-code', '.claude', KEY_A, cfg(['ask-SECRETMARK', 'disabled', 'restricted'])),
    ],
  };
  const text = JSON.stringify(agentSnapshot(marked));
  assert.doesNotMatch(text, /SECRETMARK|sha256|aaaaaaaa|9999|WORKGROUP|1001|yj/);
  assert.match(text, /"alice"/);
});

test('快照：报告为空、资产缺失时返回空数组，数量有上限', () => {
  assert.deepEqual(agentSnapshot(null), []);
  assert.deepEqual(agentSnapshot({}), []);
  const many = { assets: Array.from({ length: 400 }, () => agent('codex', '.codex', KEY_A)) };
  assert.equal(agentSnapshot(many).length, 200);
});

test('读取：同名安装按上报顺序依次对回已存快照，配置说明由各项状态推出', () => {
  const stored = JSON.parse(JSON.stringify(agentSnapshot(report)));
  const agents = report.assets.filter((a) => a.kind === 'cli_agent');
  const merged = attachAgentSnapshot(agents, stored, report);
  assert.equal(merged.length, 4);
  assert.deepEqual(
    merged.map((m) => m.snapshot.config?.state),
    ['checked', 'not_checked', 'internal_store', 'default'],
  );
  assert.equal(merged[0]!.snapshot.config?.note, null);
  assert.match(merged[2]!.snapshot.config?.note ?? '', /内部/);
  assert.deepEqual(merged[2]!.snapshot.config?.items, [
    { item: 'permission', state: 'internal_store', installs: 1 },
    { item: 'auto_approval', state: 'unknown', installs: 1 },
    { item: 'sandbox', state: 'internal_store', installs: 1 },
  ]);
  assert.equal(merged[3]!.snapshot.location, '~/.codex');
  assert.equal(merged[0]!.name, 'claude-code');
});

test('读取：顺序与快照不同也按资产名依次取用，同名安装不会重复使用同一条', () => {
  const stored = JSON.parse(JSON.stringify(agentSnapshot(report)));
  const agents = [
    { name: 'codex' },
    { name: 'claude-code' },
    { name: 'claude-code' },
    { name: 'claude-code' },
    { name: 'hermes' },
  ];
  const merged = attachAgentSnapshot(agents, stored);
  assert.equal(merged[0]!.snapshot.location, '~/.codex');
  assert.deepEqual(
    merged.slice(1, 4).map((m) => m.snapshot.config?.state),
    ['checked', 'not_checked', 'internal_store'],
  );
  assert.equal(merged[4]!.snapshot.config, undefined);
});

test('读取：已存快照里的位置与账号优先于报告现算的结果', () => {
  const merged = attachAgentSnapshot(
    [agent('claude-code', '.claude', KEY_A)],
    [{ name: 'claude-code', configState: 'checked', configItems: [], location: '~/.stored', account: 'bob' }],
    report,
  );
  assert.equal(merged[0]!.snapshot.location, '~/.stored');
  assert.equal(merged[0]!.snapshot.account, 'bob');
});

test('读取：旧任务没有快照时不给配置状态，位置与账号仍可由当时的报告现算', () => {
  const agents = report.assets.filter((a) => a.kind === 'cli_agent');
  for (const stored of [undefined, null, 'bad', [], {}]) {
    const merged = attachAgentSnapshot(agents, stored, report);
    assert.ok(merged.every((m) => m.snapshot.config === undefined));
    assert.deepEqual(
      merged.map((m) => [m.snapshot.location, m.snapshot.account]),
      [
        ['…/package.json 所在目录', 'alice'],
        ['…/package.json 所在目录', 'yj'],
        ['~/.claude', 'yj'],
        ['~/.codex', 'yj'],
      ],
    );
  }
  const bare = attachAgentSnapshot([{ name: 'claude-code' }], undefined);
  assert.deepEqual(bare[0]!.snapshot, { location: null, account: null });
});

test('读取：配置状态取值不在白名单时按未记录处理，非法的单项被丢弃', () => {
  const [bad] = attachAgentSnapshot(
    [{ name: 'claude-code' }],
    [{ name: 'claude-code', configState: '没读到', location: '~/.x', account: null }],
  );
  assert.equal(bad!.snapshot.config, undefined);
  assert.equal(bad!.snapshot.location, '~/.x');
  const [odd] = attachAgentSnapshot(
    [{ name: 'claude-code' }],
    [
      {
        name: 'claude-code',
        configState: 'checked',
        configItems: [
          { item: 'permission', state: 'explicit' },
          { item: 'hacker', state: 'explicit' },
          { item: 'sandbox', state: '任意文本' },
        ],
      },
    ],
  );
  assert.equal(odd!.snapshot.config?.state, 'checked');
  assert.deepEqual(odd!.snapshot.config?.items, [
    { item: 'permission', state: 'explicit', installs: 1 },
  ]);
});

test('配置汇总函数：已读到不产生说明，同一原因只写一次', () => {
  const one = summarizeConfigItems([
    { item: 'permission', state: 'explicit', installs: 1 },
    { item: 'auto_approval', state: 'explicit', installs: 1 },
    { item: 'sandbox', state: 'explicit', installs: 1 },
  ]);
  assert.equal(one.configState, 'checked');
  assert.equal(one.configNote, null);
  const two = summarizeConfigItems([
    { item: 'permission', state: 'internal_store', installs: 1 },
    { item: 'auto_approval', state: 'internal_store', installs: 1 },
    { item: 'sandbox', state: 'explicit', installs: 1 },
  ]);
  assert.equal(two.configState, 'partial');
  assert.equal((two.configNote ?? '').match(/内部/g)?.length, 1);
});
