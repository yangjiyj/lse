import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { buildEndpointOverview } from './overview.js';
const body = JSON.parse(
  readFileSync(
    new URL('../../../test/fixtures/fleet/overview-sanitized.json', import.meta.url),
    'utf8',
  ),
);
const endpoint = {
  id: 'endpoint-test',
  lastHealth: {
    live_eval: {
      products: [
        {
          product: 'claude-code',
          liveEvalRegistered: true,
          liveEvalRunnable: true,
          liveEvalSupported: true,
        },
      ],
    },
  },
  evalRunner: '1',
};
test('概览契约：技能来源分布、合并安装、计数、风险排序与完整字段', () => {
  const start = performance.now();
  const result = buildEndpointOverview(
    { body, reportId: 'pr_test', scannedAt: new Date(body.scanned_at) },
    endpoint,
    [],
    [],
  );
  assert.ok(performance.now() - start < 200);
  assert.equal(result.endpointId, 'endpoint-test');
  assert.equal(result.report?.reportId, 'pr_test');
  assert.equal(result.counts.skills, 88);
  assert.equal(result.counts.mcpServers, 1);
  assert.equal(result.counts.agentKinds, result.agents.length);
  assert.equal(result.counts.agentInstalls, 9);
  assert.equal(result.agents.find((a) => a.key === 'claude-code')?.installs, 4);
  assert.equal(result.agents.find((a) => a.key === 'claude-code')?.liveEval.registered, true);
  assert.equal(result.skills.filter((s) => s.sourceLabel === '本地目录').length, 79);
  assert.equal(result.skills.filter((s) => s.sourceLabel === '官方市场缓存').length, 8);
  assert.equal(result.skills.filter((s) => s.sourceLabel === '插件缓存').length, 1);
  assert.equal(result.skills.filter((s) => s.state === 'review').length, 3);
  assert.equal(result.skills.filter((s) => s.state === 'risk').length, 0);
  assert.ok(
    result.skills
      .filter((s) => s.state === 'review')
      .every((s) => s.hits[0]?.file && s.hits[0]?.line),
  );
  assert.equal(result.mcp[0]?.checks.length, 7);
  assert.equal(
    result.counts.openRisks,
    result.risks.filter((r) => !['REVIEW', 'NOT_CHECKED'].includes(r.level)).length,
  );
  assert.equal(result.counts.reviewItems, result.risks.filter((r) => r.level === 'REVIEW').length);
  assert.equal(
    result.counts.notCheckedKinds,
    result.risks.filter((r) => r.level === 'NOT_CHECKED').length,
  );
  assert.equal(
    result.counts.notCheckedInstalls,
    result.risks.filter((r) => r.level === 'NOT_CHECKED').reduce((n, r) => n + r.subjectCount, 0),
  );
  const order = ['HIGH', 'MEDIUM', 'LOW', 'REVIEW', 'NOT_CHECKED'];
  assert.deepEqual(
    result.risks.map((r) => order.indexOf(r.level)),
    result.risks.map((r) => order.indexOf(r.level)).sort((a, b) => a - b),
  );
  assert.ok(
    result.risks.every(
      (r) => r.subjects.length <= 50 && r.title.length <= 30 && r.basis && r.advice,
    ),
  );
});
test('没有最新上报返回空数组和空计数，即使传入了任务', () => {
  const result = buildEndpointOverview(null, endpoint, [{ id: 'old' }], []);
  assert.equal(result.report, null);
  for (const key of ['risks', 'agents', 'skills', 'mcp', 'history'] as const)
    assert.deepEqual(result[key], []);
  assert.ok(Object.values(result.counts).every((n) => n === 0));
});
test('终端详情以当前心跳清单为准，即使配置报告过期或不存在', () => {
  const current = { ...endpoint, lastHealth: { ...endpoint.lastHealth,
    agents: [{ product: 'codex', version: '2.0' }] } };
  for (const report of [{ body }, null]) {
    const overview = buildEndpointOverview(report, current);
    assert.deepEqual(overview.agents.map((agent) => agent.key), ['codex']);
    assert.equal(overview.agents[0]?.version, '2.0');
    assert.equal(overview.agents[0]?.liveEval.registered, false);
  }
});
test('历史任务只列最近 20 项，并区分真机和配置体检', () => {
  const jobs = Array.from({ length: 25 }, (_, i) => ({
    id: `task-${i}`,
    createdAt: new Date(2026, 0, i + 1),
    status: 'COMPLETED',
    mode: i % 2 ? 'live' : 'posture',
    failedCount: 1,
  }));
  const history = buildEndpointOverview({ body }, endpoint, jobs, []).history;
  assert.equal(history.length, 20);
  assert.equal(history[0]?.taskId, 'task-24');
  assert.ok(history.every((h) => h.summaryLine && h.modeLabel && h.createdAt));
});

test('真机检测记录使用测评摘要，不将题目失败数当作风险结论', () => {
  const history = buildEndpointOverview({ body }, endpoint, [{ id: 'live', createdAt: new Date(),
    status: 'COMPLETED', failedCount: 6, fleetEvalJob: { status: 'COMPLETED' },
    fleetSummaryLine: '模型自己拒绝 1 次，照做 1 次' }], []).history;
  assert.equal(history[0]?.summaryLine, '模型自己拒绝 1 次，照做 1 次');
});

test('同名不同内容的技能分别展示状态，风险不能串到另一份内容', () => {
  const makeSkill = (hash: string, hit: boolean) => ({
    kind: 'skill',
    name: '同名技能',
    evidence: {
      source: 'local_directory',
      static_assessment: {
        content_hash: hash,
        checks: [
          {
            rule_id: 'skill.destructive_delete',
            status: hit ? 'finding' : 'pass',
            file_label: 'run.sh',
          },
        ],
      },
    },
  });
  const result = buildEndpointOverview(
    { body: { assets: [makeSkill('一', true), makeSkill('二', false)] } },
    endpoint,
    [],
    [],
  );
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills.filter((s) => s.state === 'risk').length, 1);
});

test('同一句说明不在每个对象下重复：说明都相同时就是依据，待确认的对象只列名称', () => {
  const result = buildEndpointOverview(
    { body, reportId: 'pr_test', scannedAt: new Date(body.scanned_at) },
    endpoint,
    [],
    [],
  );
  const permissions = result.risks.find((r) => r.id.startsWith('permissions:'))!;
  assert.ok(permissions.subjects.length > 1);
  assert.match(permissions.basis, /绕过权限确认/);
  const review = result.risks.find((r) => r.level === 'REVIEW')!;
  assert.ok(review.subjects.length > 0);
  assert.ok(review.subjects.every((s) => s.name && s.detail === ''));
});
