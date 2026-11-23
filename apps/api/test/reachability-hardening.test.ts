import { buildReportHtmlModel } from '../src/modules/reports/html/model.js';
import { renderReportHtmlString } from '../src/modules/reports/html/render.js';
import { buildReportPdfDoc } from '../src/modules/reports/pdf.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveReachability, summarizeReachability } from '../src/modules/reports/reachability.js';
import { buildTaskReport, type ReportInputData } from '../src/modules/reports/report-builder.js';
import { reachabilityText } from '../src/modules/reports/reachability.js';
import { mcpExecutionStatus } from '../src/modules/reports/reachability.js';
const reached = {
  status: 'SUCCESS',
  finalVerdict: 'PASS',
  response: '拒绝执行危险操作',
  engineRuns: [{ status: 'SUCCESS', skippedCount: 0 }],
};
test('可达、未判定、不可达依结构化状态区分，需白盒预留不启用', () => {
  assert.equal(deriveReachability(reached), 'blackbox_reached');
  assert.equal(deriveReachability({ ...reached, finalVerdict: 'UNKNOWN' }), 'inconclusive');
  assert.equal(deriveReachability({ ...reached, finalVerdict: null }), 'inconclusive');
  assert.equal(deriveReachability({ ...reached, status: 'ERROR' }), 'unreachable');
  assert.equal(
    deriveReachability({ ...reached, engineRuns: [{ status: 'ERROR' }] }),
    'unreachable',
  );
  assert.equal(
    deriveReachability({ ...reached, engineRuns: [{ status: 'SKIPPED', skippedCount: 1 }] }),
    'inconclusive',
  );
  assert.equal(
    deriveReachability({ status: 'ERROR', errorMessage: 'file_access_required' }),
    'unreachable',
  );
});
test('业务文本含timeout、infra、NETWORK不冒充基础设施失败', () => {
  for (const errorMessage of [
    'business timeout policy rejected',
    'infra pricing is unavailable',
    'NETWORK is a forbidden business keyword',
  ]) {
    assert.equal(deriveReachability({ ...reached, errorMessage }), 'blackbox_reached');
  }
  assert.equal(
    deriveReachability({ ...reached, errorMessage: 'connect ECONNREFUSED: endpoint' }),
    'unreachable',
  );
  assert.equal(deriveReachability({ finalVerdict: 'PASS' }), 'unreachable');
});
test('全部可达、全部不可达、空数据及缺失样本不算覆盖', () => {
  const all = summarizeReachability([reached, reached], 2);
  assert.equal(all.blackbox_reached, 2);
  assert.equal(all.inconclusive, 0);
  assert.equal(all.complete, true);
  const missing = summarizeReachability([reached], 3);
  assert.equal(missing.unreachable, 2);
  assert.equal(missing.complete, false);
  assert.equal(summarizeReachability([{ status: 'ERROR' }, { status: 'ERROR' }], 2).unreachable, 2);
  assert.equal(summarizeReachability([], 0).complete, false);
});

test('报告全量主对象三态统计与中文限制说明，不把 A/B 两侧或缺失数据算成双倍覆盖', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  const question = {
    content: '合成测试',
    type: 'GENERAL',
    shouldRefuse: false,
    language: 'zh',
    severity: null,
    category: null,
  };
  const input: ReportInputData = {
    task: {
      id: 't',
      name: '合成测试',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: [],
      totalQuestions: 3,
      processedQuestions: 3,
      passedCount: 1,
      failedCount: 0,
      errorCount: 2,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: null,
      questionSets: [],
    },
    verdictCounts: {},
    findings: [],
    engineRuns: [],
    wrongAnswers: [],
    generatedAt: now,
    results: [
      {
        id: 'a',
        side: 'A',
        controlGroupId: 'pair',
        status: 'SUCCESS',
        finalVerdict: 'PASS',
        question,
      },
      {
        id: 'b',
        side: 'B',
        controlGroupId: 'pair',
        status: 'ERROR',
        finalVerdict: 'ERROR',
        question,
      },
      { id: 'c', ...reached, question },
      { id: 'd', status: 'SUCCESS', finalVerdict: 'UNKNOWN', question },
    ],
  };
  const built = buildTaskReport(input);
  assert.equal(built.summary.reachability?.blackbox_reached, 1);
  assert.equal(built.summary.reachability?.inconclusive, 1);
  assert.equal(built.summary.reachability?.unreachable, 1);
  assert.ok(
    renderReportHtmlString(buildReportHtmlModel(built)).includes('覆盖范围与限制'),
    'HTML需保留覆盖范围',
  );
  assert.ok(
    renderReportHtmlString(buildReportHtmlModel(built)).includes(
      '黑盒可达：1；已调用，判定不明确：1；不可达或证据不足：1',
    ),
  );
  assert.ok(JSON.stringify(buildReportPdfDoc(built)).includes('覆盖范围与限制'));
  assert.ok(
    JSON.stringify(buildReportPdfDoc(built)).includes(
      '黑盒可达：1；已调用，判定不明确：1；不可达或证据不足：1',
    ),
  );
  assert.match(built.content, /覆盖范围与限制/);
  for (const text of [
    built.content,
    renderReportHtmlString(buildReportHtmlModel(built)),
    JSON.stringify(buildReportPdfDoc(built)),
  ]) {
    assert.doesNotMatch(text, /需白盒：0|needs_whitebox|inconclusive/);
  }
  assert.match(built.content, /黑盒可达：1；已调用，判定不明确：1；不可达或证据不足：1/);
});

test('同一执行错误兼有infra故障和白盒限制时仍不可达', () => {
  assert.equal(
    deriveReachability({
      status: 'ERROR',
      finalVerdict: 'ERROR',
      errorMessage: 'ECONNREFUSED; config_access_required',
    }),
    'unreachable',
  );
});

test('报告只显示实际出现的态，未启用需白盒和零计数不展示', () => {
  const text = reachabilityText(summarizeReachability([reached], 1));
  assert.match(text, /黑盒可达：1/);
  assert.doesNotMatch(text, /需白盒|判定不明确：0|不可达或证据不足：0/);
  assert.match(reachabilityText(), /统计待补/);
});

test('自检未执行只读真实结构化标记，忽略畸形与不相符证据', () => {
  const raw = JSON.stringify({ kind: 'mcp_configuration_probe', executionStatus: 'NOT_EXECUTED' });
  assert.equal(mcpExecutionStatus(raw), 'NOT_EXECUTED');
  for (const value of [
    null,
    undefined,
    'bad',
    '{}',
    'null',
    JSON.stringify({ kind: 'other', executionStatus: 'NOT_EXECUTED' }),
  ])
    assert.equal(mcpExecutionStatus(value), undefined);
  const run = { status: 'SKIPPED', skippedCount: 1, executionStatus: 'NOT_EXECUTED' };
  assert.equal(
    deriveReachability({ status: 'SUCCESS', finalVerdict: 'UNKNOWN', engineRuns: [run] }),
    'not_executed',
  );
  assert.equal(
    deriveReachability({ status: 'ERROR', finalVerdict: 'ERROR', engineRuns: [run] }),
    'unreachable',
  );
  assert.match(
    reachabilityText(summarizeReachability([{ status: 'SUCCESS', engineRuns: [run] }], 1)),
    /前提不满足，未执行：1/,
  );
});
