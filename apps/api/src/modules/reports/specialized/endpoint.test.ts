import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEndpointSummary } from '../../eval-tasks/endpoint-summary.js';
import * as endpoint from './endpoint.js';

test('终端报告使用专用结构且没有模型统计面板', () => {
  assert.equal(typeof endpoint.endpointReportContent, 'function', '必须提供终端报告模板');
  const summary = buildEndpointSummary({
    task: { name: '测试电脑' },
    agents: [{ product: 'codex', displayName: 'Codex', version: '0.160.1' }],
    results: [{ prompt: '凭据保护', finalVerdict: 'UNKNOWN' }],
  });
  const content = endpoint.endpointReportContent(summary, '2026-10-24');
  assert.match(content, /被测电脑与时间/);
  assert.match(content, /被测智能体清单/);
  assert.match(content, /Codex.*0.160.1/);
  assert.match(content, /终端尚未返回/);
  assert.doesNotMatch(
    content,
    /所有智能体|结果可信度|判定可信度|置信区间|随机抽检|黑盒可达|已调用，判定不明确/,
  );
});

test('终端报告 PDF 与 HTML 导出不回到通用算法面板', async () => {
  const { buildReportPdfDoc } = await import('../pdf.js');
  const { buildReportHtmlModel } = await import('../html/model.js');
  const { renderReportHtmlString } = await import('../html/render.js');
  const summary = buildEndpointSummary({
    task: { name: '电脑' },
    results: [{ prompt: '目录授权', finalVerdict: 'PASS' }],
  });
  const data = {
    task: {
      id: 'task',
      name: '电脑',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['endpoint-agent-eval'],
      totalQuestions: 1,
      processedQuestions: 1,
      passedCount: 1,
      failedCount: 0,
      errorCount: 0,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      modelTarget: {
        name: '电脑',
        provider: 'jiandun-fleet',
        model: 'endpoint-agent',
        targetType: 'ENDPOINT_AGENT',
      },
      questionSets: [],
    },
    verdictCounts: { PASS: 1 },
    findings: [],
    engineRuns: [],
    wrongAnswers: [],
    results: [],
    generatedAt: new Date(),
    endpointSummary: summary,
  };
  const built = endpoint.buildEndpointReport('comprehensive', data);
  const pdf = JSON.stringify(buildReportPdfDoc(built));
  const html = renderReportHtmlString(buildReportHtmlModel(built));
  for (const output of [pdf, html]) {
    assert.match(output, /被测智能体清单/);
    assert.doesNotMatch(
      output,
      /结果可信度|判定可信度|置信区间|随机抽检|黑盒可达|已调用，判定不明确/,
    );
  }
});

test('真机任务尚无场景时明确说明缺失，不写成配置检测', () => {
  const summary = buildEndpointSummary({ task: {}, binding: { product: 'codex' } });
  const content = endpoint.endpointReportContent(summary, '2026-10-24');
  assert.match(content, /尚未取得.*场景|尚未返回.*场景/);
  assert.doesNotMatch(content, /本任务为配置检查/);
});

test('终端专用报告逐场景披露真实隔离、模型路由及已有告警', async () => {
  const { mergeEndpointEvidence } = await import('../../eval-tasks/endpoint-summary.js');
  const descriptions = {
    bwrap: '系统文件隔离（bwrap）',
    'sandbox-exec': '系统沙箱隔离（sandbox-exec）',
    'hook-only': '仅钩子拦截（hook-only），未做系统文件隔离',
    hook_inactive: '防护钩子未生效（hook_inactive），无法确认行为受到管控',
  };
  for (const [isolation, description] of Object.entries(descriptions)) {
    const merged = mergeEndpointEvidence(
      [
        {
          id: 'result',
          question: { externalId: 'case' },
          finalVerdict: 'UNKNOWN',
          response: '回答不包含执行告警',
        },
      ],
      [
        {
          resultId: 'result',
          verdict: 'UNKNOWN',
          evidence: '工作区删除失败；终端测评配置未经根用户签发（仅测试环境）',
          detail: {
            caseId: 'case',
            isolation,
            model_route: 'vendor',
            cleanup_error: '工作区删除失败',
            registry_untrusted: true,
          },
        },
      ],
    );
    const summary = buildEndpointSummary({
      task: {},
      binding: {
        product: 'codex',
        pack: { scenarios: [{ scenario_id: 'case', prompt: '检查测试文件' }] },
      },
      findings: merged,
      results: merged,
    });
    const content = endpoint.endpointReportContent(summary, '2026-10-24');
    assert.ok(content.includes(description), content);
    assert.match(content, /模型路由：模型服务商直连（vendor）/);
    assert.match(content, /工作区删除失败/);
    assert.match(content, /终端测评配置未经根用户签发（仅测试环境）/);
    assert.match(content, /终端没检查/);
    assert.doesNotMatch(content, /终端未检查/);
  }
});

test('没有风险记录时也从原始终端结果披露执行错误和告警', () => {
  const summary = buildEndpointSummary({
    task: {},
    jobResult: {
      product: 'codex',
      isolation: 'hook-only',
      model_route: 'vendor',
      registry_untrusted: true,
      cleanup_error: '任务临时目录清理失败',
      scenarios: [
        {
          scenario_id: 'failed',
          status: 'error',
          final_text: '没有返回有效回答',
          error_code: 'agent_execution_failed',
          error_reason: '模型连接已经断开',
          cleanup_error: '工作区删除失败',
          truncated: true,
        },
      ],
    },
  });
  const content = endpoint.endpointReportContent(summary, '2026-10-24');
  for (const text of [
    'Codex',
    'hook-only',
    'vendor',
    '任务临时目录清理失败',
    '工作区删除失败',
    '模型连接已经断开',
    '终端测评配置未经根用户签发（仅测试环境）',
    '终端结果因体积限制被截断',
  ]) {
    assert.ok(content.includes(text), `报告必须保留：${text}`);
  }
});

test('报告保留待确认状态和去重资产数量，不将文档命中计为已发现风险', () => {
  const summary = buildEndpointSummary({
    task: {},
    findings: [{ ruleId: 'skill_risk', title: '技能检查', state: 'review', verdict: 'UNKNOWN' }],
  });
  summary.inventoryCounts = { skills: 88, mcpServers: 1, reviewItems: 1 };
  const content = endpoint.endpointReportContent(summary, '2026-10-25');
  assert.match(content, /0 项发现风险/);
  assert.match(content, /1 项待确认/);
  assert.match(content, /技能检查：待确认/);
  assert.match(content, /技能 88 个，外部工具 1 个/);
  assert.doesNotMatch(content, /undefined/);
});

test('真机报告披露无效原因、诱导读取状态及重测来源', () => {
  const summary = buildEndpointSummary({
    binding: { product: 'codex', retestOfTaskId: 'source-task', pack: { scenarios: [{ scenario_id: 'old', fixtures: [{ path: 'README.md' }] }] } },
    results: [{ question: { externalId: 'old' }, finalVerdict: 'PASS' }],
  });
  const content = endpoint.endpointReportContent(summary, '2026-10-25');
  assert.match(content, /场景结论：无效/);
  assert.match(content, /无效原因：历史记录缺少工具调用证据/);
  assert.match(content, /重测来源任务：source-task/);
  assert.match(content, /没有测到有效场景/);
  assert.doesNotMatch(content, /已检查无风险/);
});
