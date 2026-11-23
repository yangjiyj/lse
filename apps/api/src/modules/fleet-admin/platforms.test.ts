import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEndpointOverview } from './overview.js';

const check = (rule: string, status = 'pass', severity = 'info', extra = {}) => ({
  rule_id: `platform.${rule}`,
  status,
  severity,
  reason_zh:
    status === 'finding'
      ? '管理端鉴权未开启。'
      : status === 'unknown'
        ? '配置没有读到。'
        : '本项配置正常。',
  recommendation_zh: '请开启管理端鉴权。',
  ...extra,
});
const asset = (id: string, checks?: ReturnType<typeof check>[], extra = {}) => ({
  kind: 'platform_container',
  name: 'dify',
  display_name: 'Dify',
  version: '1.2.0',
  running: true,
  evidence: {
    detail: { container_id: id, image: '不应回传的镜像内容' },
    ...(checks ? { static_assessment: { ruleset_version: 'platform-static-v1', checks } } : {}),
  },
  ...extra,
});
const overview = (assets: unknown[]) => buildEndpointOverview({ body: { assets } }, { id: '终端' });

test('旧探针仅识别平台，未体检不等于通过，也不进入智能体表', () => {
  const result = overview([asset('abcdef123456789')]);
  assert.equal(result.platforms?.length, 1);
  assert.deepEqual(result.platforms[0], {
    key: 'dify',
    name: 'Dify',
    version: '1.2.0',
    containers: 1,
    running: 1,
    exposedPorts: 0,
    checks: [],
    readState: 'not_checked',
    issues: 0,
  });
  assert.deepEqual(result.agents, []);
  assert.equal(result.counts.agentKinds, 0);
});

test('多容器合并三态，风险取最高严重度、稳定键及原文，未知不生成风险', () => {
  const a = asset('abcdef123456789', [
    check('config_read'),
    check('admin_auth', 'finding', 'medium'),
    check('exposure', 'finding', 'high'),
  ]);
  const b = asset(
    'fedcba654321987',
    [
      check('config_read', 'unknown'),
      check('admin_auth', 'finding', 'high', { file_label: 'AUTO_LOGIN' }),
      check('secret_key', 'unknown'),
    ],
    { version: '1.13.0', running: false },
  );
  const c = asset('000000123456789', [check('config_read'), check('admin_auth')]);
  const result = overview([a, b, c]);
  const platform = result.platforms?.[0];
  assert.ok(platform);
  assert.equal(platform.containers, 3);
  assert.equal(platform.running, 2);
  assert.equal(platform.version, '1.13.0');
  assert.equal(platform.readState, 'partial');
  assert.equal(platform.exposedPorts, 1);
  assert.equal(platform.issues, 2);
  assert.equal(
    platform.checks.find((c) => c.rule === 'admin_auth' && c.state === 'risk')?.containers,
    2,
  );
  assert.equal(
    platform.checks.find((c) => c.rule === 'admin_auth' && c.state === 'clear')?.containers,
    1,
  );
  assert.ok(platform.checks.some((c) => c.rule === 'secret_key' && c.state === 'unread'));
  // 没读到的项不生成风险行，但要有一行可闭环的“没检查”
  const risks = result.risks.filter((r) => r.category === 'platform' && r.level !== 'NOT_CHECKED');
  assert.equal(risks.length, 2);
  const unread = result.risks.filter((r) => r.category === 'platform' && r.level === 'NOT_CHECKED');
  assert.equal(unread.length, 1);
  assert.deepEqual(
    unread[0]!.subjects.map((s) => s.name),
    ['Dify'],
  );
  const risk = risks.find((r) => r.id === 'platform:dify:admin_auth')!;
  assert.equal(risk.level, 'HIGH');
  assert.equal(risk.involved, '2 个容器');
  assert.equal(risk.basis, '管理端鉴权未开启。');
  assert.equal(risk.advice, '请开启管理端鉴权。');
  assert.deepEqual(risk.subjects, [
    { name: 'abcdef123456', detail: '' },
    { name: 'fedcba654321', detail: 'AUTO_LOGIN' },
  ]);
  assert.equal(result.counts.openRisks, overview([]).counts.openRisks + 2);
  assert.equal(result.counts.highRisks, 2);
  assert.equal(result.counts.platformKinds, 1);
  assert.equal(result.counts.platformContainers, 3);
  assert.deepEqual(
    overview([c, b, a])
      .risks.filter((r) => r.category === 'platform' && r.level !== 'NOT_CHECKED')
      .map((r) => r.id),
    risks.map((r) => r.id),
  );
  assert.ok(!JSON.stringify(result).includes('不应回传的镜像内容'));
});

test('读全、读不全及混合旧探针不会误报通过，忽略词表外分类', () => {
  assert.equal(
    overview([asset('1', [check('config_read'), check('secret_key')])]).platforms?.[0]?.readState,
    'complete',
  );
  for (const checks of [
    [check('config_read'), check('secret_key', 'unknown')],
    [check('config_read', 'pass', 'info', { evidence_code: 'platform_config_partial' })],
    [],
  ]) {
    const result = overview([asset('1', checks)]);
    assert.equal(result.platforms?.[0]?.readState, 'partial');
    // 读不全不是风险；但必须留一行“没检查”，不能让“读不全”无处闭环
    assert.equal(
      result.risks.filter((r) => r.category === 'platform' && r.level !== 'NOT_CHECKED').length,
      0,
    );
    assert.equal(
      result.risks.filter((r) => r.category === 'platform' && r.level === 'NOT_CHECKED').length,
      1,
    );
  }
  const result = overview([
    asset('1', [check('config_read'), check('secret_key'), check('other', 'finding')]),
    asset('2'),
  ]);
  assert.equal(result.platforms?.[0]?.readState, 'partial');
  assert.ok(result.platforms[0]!.checks.every((c) => c.rule !== ('other' as string)));
  assert.equal(result.platforms[0]!.issues, 0);
});

test('版本无法比较返回未知，无上报平台为空', () => {
  assert.deepEqual(buildEndpointOverview(null, {}).platforms, []);
  assert.equal(
    overview([
      asset('1', undefined, { version: 'latest' }),
      asset('2', undefined, { version: 'dev' }),
    ]).platforms?.[0]?.version,
    null,
  );
});
