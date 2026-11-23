import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { endpointAgents, runtimeV2Supported } from './agents.js';
import { resultErrorCode } from '../fleet-agent/result-error.js';
const report = JSON.parse(
  readFileSync(
    new URL('../../../test/fixtures/fleet/demo-host-probe-report.json', import.meta.url),
    'utf8',
  ),
);
test('智能体清单保留八个安装项，版本字段不能替代登记能力', () => {
  const agents = endpointAgents(report, { capabilities: { eval_runner: '1' } }, '1');
  assert.equal(agents.length, 8);
  assert.ok(agents.every((a) => !a.liveEvalRegistered && a.liveEvalBlockedReason));
  assert.ok(agents.some((a) => a.product === 'hermes' && a.version === null));
});
test('登记与可运行能力仅来自终端明确上报', () => {
  const health = {
    capabilities: {
      eval_products: [
        { product: 'claude-code', registered: true, runnable: true },
        {
          product: 'codex',
          registered: false,
          runnable: false,
          blocked_reason: 'registry_missing',
        },
      ],
    },
  };
  const agents = endpointAgents(report, health, '1');
  assert.ok(
    agents
      .filter((a) => a.product === 'claude-code')
      .every((a) => a.liveEvalRegistered && !a.liveEvalBlockedReason),
  );
  assert.ok(
    agents
      .filter((a) => a.product === 'codex')
      .every((a) => !a.liveEvalRegistered && a.liveEvalBlockedReason?.includes('登记')),
  );
  assert.equal(
    resultErrorCode({ scenarios: [{ status: 'skipped' }] }, 'codex', health),
    'product_not_registered',
  );
  assert.equal(
    resultErrorCode({ scenarios: [{ status: 'skipped' }] }, 'codex', {}),
    'all_scenarios_skipped',
  );
  assert.equal(
    resultErrorCode({ scenarios: [{ status: 'completed' }, { status: 'error' }] }, 'codex', health),
    'partial_scenario_failed',
  );
  assert.equal(
    resultErrorCode({ scenarios: [{ status: 'timeout' }] }, 'codex', health),
    'scenario_timeout',
  );
  // 有场景跑完时，整批按「部分没跑完」说，不按超时说成没有完成检查
  assert.equal(
    resultErrorCode({ scenarios: [{ status: 'completed' }, { status: 'timeout' }] }, 'codex', health),
    'partial_scenario_failed',
  );
});
test('明确完整的登记清单不包含该产品时，与登记信息缺失分开处理', () => {
  const health = {
    capabilities: {
      eval_products: [{ product: 'claude-code', registered: true, runnable: true }],
      eval_registry_complete: true,
    },
  };
  assert.equal(
    resultErrorCode({ scenarios: [{ status: 'skipped' }] }, 'codex', health),
    'product_not_registered',
  );
});

test('未知产品保留原始标识，但显示人话名称和完整的不可运行说明', () => {
  assert.deepEqual(endpointAgents(null, { agents: [{ product: 'other' }] }, '1'), [
    {
      product: 'other',
      displayName: '未识别的智能体',
      version: null,
      headlessCapable: false,
      liveEvalSupported: false,
      liveEvalRegistered: false,
      scripted: false,
      runtimeV2: false,
      liveEvalBlockedReason: '平台暂不支持运行该智能体的真机测评。',
    },
  ]);
});

test('心跳 live_eval 优先于兼容字段，分别如实显示登记、未登记和隔离不可用', () => {
  const health = {
    agents: ['claude-code', 'codex', 'hermes'].map((product) => ({ product })),
    capabilities: { eval_products: [{ product: 'codex', registered: true, runnable: true }] },
    live_eval: {
      products: [
        {
          product: 'claude-code',
          liveEvalSupported: true,
          liveEvalRegistered: true,
          liveEvalRunnable: true,
        },
        {
          product: 'codex',
          liveEvalSupported: true,
          liveEvalRegistered: false,
          liveEvalRunnable: false,
          liveEvalBlockedReason: '这台电脑未登记 Codex，请联系管理员登记。',
          reasonCode: 'product_not_registered',
        },
        {
          product: 'hermes',
          liveEvalSupported: true,
          liveEvalRegistered: true,
          liveEvalRunnable: false,
          liveEvalBlockedReason: '系统隔离不可用，请启用隔离后重试。',
          reasonCode: 'isolation_unavailable',
        },
      ],
    },
  };
  assert.deepEqual(endpointAgents(null, health, '1'), [
    {
      product: 'claude-code',
      displayName: 'Claude Code',
      version: null,
      headlessCapable: false,
      liveEvalSupported: true,
      liveEvalRegistered: true,
      scripted: false,
      runtimeV2: false,
    },
    {
      product: 'codex',
      displayName: 'Codex',
      version: null,
      headlessCapable: false,
      liveEvalSupported: true,
      liveEvalRegistered: false,
      scripted: false,
      runtimeV2: false,
      liveEvalBlockedReason: '这台电脑未登记 Codex，请联系管理员登记。',
    },
    {
      product: 'hermes',
      displayName: 'Hermes',
      version: null,
      headlessCapable: false,
      liveEvalSupported: true,
      liveEvalRegistered: true,
      scripted: false,
      runtimeV2: false,
      liveEvalBlockedReason: '系统隔离不可用，请启用隔离后重试。',
    },
  ]);
  assert.equal(
    resultErrorCode({ scenarios: [{ status: 'skipped' }] }, 'codex', health),
    'product_not_registered',
  );
});

test('live_eval 存在就是完整清单，空清单和缺席产品不得使用旧登记信息', () => {
  for (const live_eval of [
    { products: [] },
    { products: [{ product: 'hermes', liveEvalRegistered: true }] },
    {},
  ]) {
    const health = {
      agents: [{ product: 'codex' }],
      live_eval,
      capabilities: { eval_products: [{ product: 'codex', registered: true, runnable: true }] },
    };
    assert.deepEqual(endpointAgents(null, health, '1'), [
      {
        product: 'codex',
        displayName: 'Codex',
        version: null,
        headlessCapable: false,
        liveEvalSupported: true,
        liveEvalRegistered: false,
        scripted: false,
        runtimeV2: false,
        liveEvalBlockedReason:
          '这台电脑没有登记 Codex 的测评，无法运行。请在终端上登记后再测，或改选已登记的智能体。',
      },
    ]);
    assert.equal(
      resultErrorCode({ scenarios: [{ status: 'skipped' }] }, 'codex', health),
      'product_not_registered',
    );
  }
});

test('终端中文原因脱敏路径、地址和凭据并限制长度；缺失时用原因码中文说明', () => {
  const agent = (reason?: string) => {
    const result = endpointAgents(
      null,
      {
        agents: [{ product: 'hermes' }],
        live_eval: {
          products: [
            {
              product: 'hermes',
              liveEvalSupported: true,
              liveEvalRegistered: true,
              liveEvalRunnable: false,
              reasonCode: 'isolation_unavailable',
              liveEvalBlockedReason: reason,
            },
          ],
        },
      },
      '1',
    )[0];
    assert.ok(result);
    return result;
  };
  const reason = agent(
    '隔离不可用：/home/测试用户/私有目录；/home/test-user/private/config；C:\\Users\\test-user\\private；\\\\test-host\\private；~/private；192.0.2.10；aa:bb:cc:dd:ee:ff；Bearer fake-test-token；' +
      '请修复。'.repeat(200),
  ).liveEvalBlockedReason!;
  assert.ok(reason.startsWith('隔离不可用：'));
  assert.ok(reason.length <= 500);
  for (const sensitive of [
    '测试用户',
    '私有目录',
    'test-user',
    'test-host',
    'private',
    '192.0.2.10',
    'aa:bb:cc:dd:ee:ff',
    'fake-test-token',
  ])
    assert.equal(reason.includes(sensitive), false);
  assert.equal(
    agent().liveEvalBlockedReason,
    '终端缺少可用的系统隔离，此智能体暂不能安全运行测评；请启用隔离或先做配置检测。',
  );
});

test('终端明确不支持某产品时保留中文原因且不能显示可运行', () => {
  assert.deepEqual(
    endpointAgents(
      null,
      {
        agents: [{ product: 'opencode' }],
        live_eval: {
          products: [
            {
              product: 'opencode',
              liveEvalSupported: false,
              liveEvalRegistered: true,
              liveEvalRunnable: false,
              liveEvalBlockedReason: '此版本尚不支持，请升级执行器。',
            },
          ],
        },
      },
      '1',
    ),
    [
      {
        product: 'opencode',
        displayName: 'OpenCode',
        version: null,
        headlessCapable: false,
        liveEvalSupported: false,
        liveEvalRegistered: true,
        scripted: false,
        runtimeV2: false,
        liveEvalBlockedReason: '此版本尚不支持，请升级执行器。',
      },
    ],
  );
});

test('脚本支持位仅接受明确的字符串能力，不改变模型测评登记语义', () => {
  for (const value of ['1', true, 1, '0', undefined]) {
    const agents = endpointAgents(null, { agents: [{ product: 'codex' }], capabilities: { eval_scripted: value } }, '1');
    assert.equal(agents[0]!.scripted, value === '1');
    assert.equal(agents[0]!.liveEvalRegistered, false);
  }
});

test('运行态测评位只认心跳里明确的字符串 1，且仅 claude-code 为真', () => {
  for (const value of ['1', true, 1, '0', undefined]) {
    const health = {
      agents: [{ product: 'claude-code' }, { product: 'codex' }],
      capabilities: { eval_sandbox_v2: value },
    };
    assert.equal(runtimeV2Supported(health), value === '1');
    const agents = endpointAgents(null, health, '1');
    assert.equal(agents.find((a) => a.product === 'claude-code')!.runtimeV2, value === '1');
    assert.equal(agents.find((a) => a.product === 'codex')!.runtimeV2, false, '其他产品暂不支持运行态测评');
  }
  assert.equal(runtimeV2Supported(null), false);
  assert.equal(runtimeV2Supported({}), false);
});
