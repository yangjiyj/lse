import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskReport, type ReportInputData } from '../src/modules/reports/report-builder.js';
import { buildReportPdfDoc } from '../src/modules/reports/pdf.js';

test('综合报告同时输出模块级统计，并进入 PDF 交付内容', () => {
  const now = new Date('2026-08-21T00:00:00.000Z');
  const input: ReportInputData = {
    task: {
      id: 'comprehensive-report-task',
      name: '综合安全评估',
      description: '同一任务随机混排',
      status: 'COMPLETED',
      concurrency: 2,
      engines: ['rule-judge'],
      expectedEngines: ['rule-judge'],
      dimensions: ['comprehensive', 'content_safety', 'agent_tool_call'],
      totalQuestions: 2,
      processedQuestions: 2,
      passedCount: 2,
      failedCount: 0,
      errorCount: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test-model' },
      questionSets: [
        {
          id: 'set-content',
          name: '[综合评估·内容安全] 测试',
          type: 'GENERAL',
          language: 'zh',
          source: 'comprehensive:task:content_safety',
          tags: ['comprehensive', 'module:content_safety'],
          questionCount: 1,
        },
        {
          id: 'set-agent',
          name: '[综合评估·工具安全] 测试',
          type: 'PROMPT_INJECTION',
          language: 'zh',
          source: 'comprehensive:task:agent_tool_safety',
          tags: ['comprehensive', 'module:agent_tool_safety'],
          questionCount: 1,
        },
      ],
    },
    verdictCounts: { PASS: 2 },
    findings: [],
    wrongAnswers: [],
    engineRuns: [
      {
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 2,
        skippedCount: 0,
        durationMs: 2,
        errorMessage: null,
      },
    ],
    results: [
      {
        id: 'result-content',
        finalVerdict: 'PASS',
        status: 'SUCCESS',
        question: {
          questionSetId: 'set-content',
          content: '内容安全样本',
          type: 'GENERAL',
          shouldRefuse: false,
          language: 'zh',
          severity: 'LOW',
          category: '内容安全',
        },
      },
      {
        id: 'result-agent',
        finalVerdict: 'PASS',
        status: 'SUCCESS',
        question: {
          questionSetId: 'set-agent',
          content: '工具安全样本',
          type: 'PROMPT_INJECTION',
          shouldRefuse: true,
          language: 'zh',
          severity: 'HIGH',
          category: '工具越权',
        },
      },
    ],
    generatedAt: now,
  };

  const report = buildTaskReport(input);
  assert.deepEqual(
    report.summary.comprehensiveModules?.map((module) => ({
      id: module.id,
      sampleCount: module.sampleCount,
      processedCount: module.processedCount,
      passedCount: module.passedCount,
    })),
    [
      { id: 'content_safety', sampleCount: 1, processedCount: 1, passedCount: 1 },
      { id: 'agent_tool_safety', sampleCount: 1, processedCount: 1, passedCount: 1 },
    ],
  );
  assert.match(report.content, /综合评估模块覆盖/);
  assert.match(report.content, /内容安全评估/);
  assert.match(report.content, /智能体工具安全评估/);

  const pdf = buildReportPdfDoc(report);
  const pdfText = JSON.stringify(pdf);
  assert.match(pdfText, /综合评估模块覆盖/);
  assert.match(pdfText, /综合评估模块结果/);
  assert.match(pdfText, /内容安全评估/);
  assert.match(pdfText, /智能体工具安全评估/);
});
