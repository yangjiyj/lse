import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEndpointSummary } from '../../eval-tasks/endpoint-summary.js';
import { buildEndpointReport } from '../specialized/endpoint.js';
import { buildReportHtmlModel } from './model.js';
import { renderReportHtmlString } from './render.js';

function reportData(finishedAt: Date | null) {
  const summary = buildEndpointSummary({
    task: { name: '电脑' },
    agents: [{ product: 'codex', displayName: 'Codex', version: '0.160.1' }],
    results: [{ prompt: '目录授权', finalVerdict: 'PASS' }],
  });
  return {
    task: {
      id: 'task', name: '电脑', description: null, status: 'COMPLETED', concurrency: 1,
      engines: ['endpoint-agent-eval'], totalQuestions: 1, processedQuestions: 1, passedCount: 1, failedCount: 0, errorCount: 0,
      createdAt: new Date('2026-11-02T01:00:00Z'), startedAt: new Date('2026-11-02T01:00:00Z'), finishedAt,
      modelTarget: { name: '电脑', provider: 'jiandun-fleet', model: 'endpoint-agent', targetType: 'ENDPOINT_AGENT' },
      questionSets: [],
    },
    verdictCounts: { PASS: 1 },
    findings: [], engineRuns: [], wrongAnswers: [], results: [],
    generatedAt: new Date('2026-11-02T04:00:00Z'),
    endpointSummary: summary,
  };
}

test('终端报告的 HTML 导出使用客户版版式：封面、章节、页眉页脚', () => {
  const built = buildEndpointReport('comprehensive', reportData(new Date('2026-11-02T02:30:00Z')) as never);
  const html = renderReportHtmlString(buildReportHtmlModel(built, { reportId: 'RPT-X-1', classification: '客户保密' }));
  assert.match(html, /class="cover"/);
  assert.match(html, /<h2>管理摘要<\/h2>/);
  assert.match(html, /@page/);
  assert.match(html, /RPT-X-1/);
  assert.match(html, /客户保密/);
  // 不再是「每行一个段落」的纯文本导出
  assert.doesNotMatch(html, /^<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>[^<]*<\/title><style>@page\{size:A4;margin:20mm\}/);
});

test('终端报告的 HTML 导出带上测评完成时间，缺失时回退到报告生成时间', () => {
  const withFinish = renderReportHtmlString(
    buildReportHtmlModel(buildEndpointReport('comprehensive', reportData(new Date('2026-11-02T02:30:00Z')) as never)),
  );
  assert.match(withFinish, /2026-11-02 10:30/);
  const noFinish = renderReportHtmlString(buildReportHtmlModel(buildEndpointReport('comprehensive', reportData(null) as never)));
  assert.match(noFinish, /2026-11-02 12:00/);
});

test('配置体检任务导出为配置体检报告标题，真机任务导出为运行态报告标题', () => {
  const html = renderReportHtmlString(buildReportHtmlModel(buildEndpointReport('comprehensive', reportData(null) as never)));
  assert.match(html, /<title>智能体配置体检报告<\/title>/);
});
