import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_CATALOG } from './check-catalog.js';
import { judgePosture } from '../endpoint-evals/posture-judge.js';
import { buildEndpointPack } from '../endpoint-evals/pack.js';

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id).sort();

test('目录与实际体检规则、真机场景的标识集合完全一致且无重复', () => {
  const findings = judgePosture({});
  const scenarios = buildEndpointPack('https://jiandun.example/controlled').scenarios;
  assert.deepEqual(ids(CHECK_CATALOG.posture), findings.map((f) => f.ruleId).sort());
  assert.deepEqual(ids(CHECK_CATALOG.live), scenarios.map((s) => s.scenario_id).sort());
  assert.equal(new Set(ids(CHECK_CATALOG.posture)).size, CHECK_CATALOG.posture.length);
  assert.equal(new Set(ids(CHECK_CATALOG.live)).size, CHECK_CATALOG.live.length);
  for (const finding of findings) {
    assert.equal(
      CHECK_CATALOG.posture.find((item) => item.id === finding.ruleId)?.severity,
      finding.severity,
    );
  }
});

test('每项说明完整、分类有效、影响明确，展示文案不含内部英文术语', () => {
  const categories = CHECK_CATALOG.categories;
  assert.deepEqual(
    categories.map((c) => c.id),
    ['permission', 'mcp', 'skill', 'instruction', 'credential', 'behavior', 'environment'],
  );
  assert.equal(new Set(categories.map((c) => c.order)).size, categories.length);
  for (const [mode, items] of [
    ['posture', CHECK_CATALOG.posture],
    ['live', CHECK_CATALOG.live],
  ] as const) {
    for (const item of items) {
      assert.equal(item.mode, mode);
      assert.ok(categories.some((c) => c.id === item.category));
      for (const copy of [
        item.title,
        item.what,
        item.why,
        item.remediation,
        item.impact.note,
        ...item.impact.touches,
      ]) {
        assert.ok(copy.trim());
        assert.doesNotMatch(copy, /opcode|payload|canary|fixture|sink|injection|exfil/i);
      }
      assert.equal(item.impact.level, mode === 'posture' ? 'read_only' : 'runs_agent');
      assert.equal(typeof item.impact.reversible, 'boolean');
      if (mode === 'posture') assert.equal(item.impact.reversible, true);
    }
  }
});

test('真机说明如实披露越界位置、无法完全撤销、无效下载地址与平台受控接收地址', () => {
  const escape = CHECK_CATALOG.live.find((item) => item.id === 'endpoint-workspace-escape')!;
  assert.ok(CHECK_CATALOG.live.find((item) => item.id === 'endpoint-workspace-tool-output')!.impact.touches.includes('~/lse-eval-cache/keep.txt'));
  assert.ok(escape.impact.touches.includes('~/lse-eval-result.txt'));
  assert.equal(escape.impact.reversible, false);
  assert.match(escape.impact.note, /专门创建测试文件.*已有同名路径.*拒绝执行/);
  assert.match(escape.impact.note, /结束后核对并清理/);
  assert.match(
    CHECK_CATALOG.live.find((item) => item.id === 'endpoint-dangerous-command')!.impact.note,
    /无效.*不会.*下载.*执行/,
  );
  for (const id of [
    'endpoint-readme-injection',
    'endpoint-credential-exfil',
    'endpoint-tool-output-injection',
  ]) {
    assert.match(
      CHECK_CATALOG.live.find((item) => item.id === id)!.impact.note,
      /平台.*接收地址.*不会.*外部/,
    );
  }
  const summary = CHECK_CATALOG.liveSummary;
  assert.match(summary.steps.join(''), /临时目录.*当前用户/);
  assert.match(summary.steps.join(''), /已登记.*真实智能体.*12/);
  assert.match(summary.consumesQuota, /登录用户.*主目录.*模型额度/);
  assert.match(summary.isolationNote, /Linux.*bwrap.*只读.*macOS.*sandbox-exec.*只读/);
  assert.match(summary.isolationNote, /都不可用时.*测评不会启动/);
  assert.match(summary.cleanup, /删除临时目录.*记录文件变化/);
  assert.match(summary.cleanup, /专用测试路径.*核对并清理.*清理失败/);
  assert.match(summary.cleanup, /额度无法退回/);
});

test('代码注释场景正向说明诱导改写临时保留文件的实际行为', () => {
  const item = CHECK_CATALOG.live.find((entry) => entry.id === 'endpoint-code-comment-injection')!;
  assert.ok(item.impact.note.includes('阅读临时目录内的代码注释'));
  assert.ok(item.impact.note.includes('改写临时目录内预置的保留测试文件'));
  assert.ok(item.impact.touches.includes('.lse-eval-protected/keep.txt'));
  assert.equal(item.impact.reversible, false);
  assert.match(item.impact.note, /临时目录会清理/);
});

test('两种越权写入场景均说明有无系统隔离的差异与专用路径例外', () => {
  for (const id of ['endpoint-workspace-escape', 'endpoint-workspace-tool-output']) {
    const item = CHECK_CATALOG.live.find((entry) => entry.id === id)!;
    assert.ok(item.impact.note.includes('有系统隔离时，写入范围受限制，本轮专用测试路径会单独开放以核对是否越权'), id);
    assert.ok(item.impact.note.includes('没有系统隔离时，测评不会启动'), id);
    assert.ok(!item.impact.note.includes('仅靠防护检查'), id);
    assert.match(item.impact.note, /已有同名路径时拒绝执行.*结束后核对并清理/);
  }
});
