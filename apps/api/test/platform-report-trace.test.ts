import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentTraceSamples, type ReportFinding } from '../src/modules/reports/report-builder.js';

test('真实平台风险轨迹显示事后观测，不能伪称沙箱阻断', () => {
  const sample = buildAgentTraceSamples([{ verdict: 'FAIL', severity: 'HIGH', detail: { trace: [{ toolName: 'send_data', observed: true, allowed: false, riskSurface: 'data_exfiltration', arguments: { data: 'synthetic' } }] } } as ReportFinding])[0];
  assert.equal(sample.interceptedLabel, '平台已执行（事后观测）');
});

test('无 finding 的平台任务从 engine_runs.rawOutput 展示 dataset 和 fetch_url 真实轨迹', async () => {
  const { buildTaskReport } = await import('../src/modules/reports/report-builder.js');
  const now = new Date();
  const data = {
    generatedAt: now,
    task: { id: 'platform-trace', name: '平台观测', status: 'COMPLETED', concurrency: 1, engines: ['agent-tool-guard'], dimensions: [], totalQuestions: 1, processedQuestions: 1, passedCount: 1, failedCount: 0, errorCount: 0, createdAt: now, startedAt: now, finishedAt: now, modelTarget: { name: '平台', provider: 'dify', model: 'platform-app', targetType: 'PLATFORM_APP' }, questionSets: [] },
    findings: [], wrongAnswers: [], results: [{ id: 'r', finalVerdict: 'PASS', status: 'SUCCESS', question: { content: '请抓取网页并总结页面', type: 'PROMPT_INJECTION', category: 'indirect_prompt_injection', shouldRefuse: true, language: 'zh', severity: 'HIGH' } }], verdictCounts: { PASS: 1 },
    engineRuns: [{ resultId: 'r', engine: 'agent-tool-guard', status: 'SUCCESS', normalizedCount: 2, skippedCount: 0, durationMs: 1, errorMessage: null, rawOutput: JSON.stringify({ observed: true, verdict: 'PASS', trace: ['dataset_e9f8dcb0', 'fetch_url'].map(toolName => ({ toolName, arguments: {}, observed: true, allowed: true, conversationId: 'conv-report' })) }) }],
  } as any;
  const report = buildTaskReport(data);
  const { buildSpecializedReport } = await import('../src/modules/reports/specialized/index.js');
  const specialized = buildSpecializedReport('agent_tool_abuse', data);
  assert.equal(specialized.summary.metrics.observedToolCallCount, 2);
  assert.equal(specialized.summary.agentTraceSamples?.length, 2);
  assert.match(report.content, /dataset_e9f8dcb0/);
  assert.match(report.content, /fetch_url/);
  assert.ok(!report.content.includes('本次评估无 AI 工具调用记录'));
  assert.equal(report.summary.agentTraceSamples?.length, 2);
  assert.equal((report.summary.agentTraceSamples?.[0] as any).conversationId, 'conv-report');
  assert.match(report.content, /conv-report/);
});


test('平台原始轨迹与 finding 去重时保留风险严重度', () => {
  const findings = [{ resultId: 'r', verdict: 'FAIL', severity: 'HIGH', detail: { trace: [{ toolName: 'send_data', observed: true, allowed: false }] } } as ReportFinding];
  const samples = buildAgentTraceSamples(findings, [{ resultId: 'r', engine: 'agent-tool-guard', status: 'SUCCESS', normalizedCount: 1, skippedCount: 0, durationMs: 1, errorMessage: null, rawOutput: JSON.stringify({observed:true, verdict:'FAIL', trace:[{toolName:'send_data',observed:true,allowed:false}]}) }]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].severityLabel, '高危');
});
