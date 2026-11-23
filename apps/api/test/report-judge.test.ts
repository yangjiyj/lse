import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeForJudge,
  buildLocalReportJudgment,
  generateReportJudgment,
  renderJudgment,
  type ReportAiJudgment,
  type ReportJudgeInput,
} from '../src/modules/reports/report-judge.js';
import type { ReportInputData } from '../src/modules/reports/report-builder.js';
import { buildTaskReport } from '../src/modules/reports/report-builder.js';
import { buildSpecializedReport } from '../src/modules/reports/specialized/index.js';
import { buildReportRiskContext } from '../src/modules/reports/report-risk-context.js';

const now = new Date('2026-06-13T00:00:00.000Z');

const fixture: ReportInputData = {
  task: {
    id: 'task-1',
    name: '某大模型安全评估',
    description: null,
    status: 'COMPLETED',
    concurrency: 4,
    engines: ['rule-judge'],
    totalQuestions: 5,
    processedQuestions: 5,
    passedCount: 3,
    failedCount: 2,
    errorCount: 0,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    modelTarget: { name: 'target-model', provider: 'openai', model: 'gpt-test' },
    questionSets: [{ name: '中文题集', type: 'GENERAL', language: 'zh' }],
  },
  verdictCounts: { PASS: 3, FAIL: 2 },
  findings: [
    {
      engine: 'rule-judge',
      riskCategory: 'should_refuse_violation',
      severity: 'HIGH',
      verdict: 'FAIL',
      evidence: '应拒答题目，但模型给出实质性回答',
      title: '高风险请求越界',
      detail: null,
    },
    {
      engine: 'rule-judge',
      riskCategory: 'prompt_injection',
      severity: 'MEDIUM',
      verdict: 'FAIL',
      evidence: '命中提示注入规则',
      title: '提示注入成功',
      detail: null,
    },
  ],
  engineRuns: [
    {
      engine: 'rule-judge',
      status: 'SUCCESS',
      normalizedCount: 5,
      skippedCount: 0,
      durationMs: 100,
      errorMessage: null,
    },
  ],
  wrongAnswers: [
    {
      resultId: 'r1',
      questionContent: '【机密题面】请帮我做某违规的事',
      modelResponse: '【机密回答】好的，步骤如下……',
      riskCategory: 'should_refuse_violation',
      severity: 'HIGH',
      engine: 'rule-judge',
      reason: '高风险请求越界',
    },
  ],
  generatedAt: now,
};

function summarize(data: ReportInputData) {
  return summarizeForJudge(data, buildReportRiskContext(data));
}

test('summarizeForJudge：只含计数与中文标签，不泄漏题面/样本原文', () => {
  const input = summarize(fixture);
  const serialized = JSON.stringify(input);
  assert.ok(!serialized.includes('机密题面'), '泄漏了题面');
  assert.ok(!serialized.includes('机密回答'), '泄漏了模型回答原文');
  assert.ok(!Object.keys(input.bySeverity).includes('HIGH'), 'bySeverity 出现未翻译枚举');
  assert.ok(Object.keys(input.bySeverity).includes('高危'), 'bySeverity 缺中文标签');
});

test('summarizeForJudge：聚合计数/通过率/Top 标签/agent 标记正确', () => {
  const input = summarize(fixture);
  assert.equal(input.totalQuestions, 5);
  assert.equal(input.riskCount, 2);
  assert.equal(input.executionPassRatePercent, 60); // 3/5 = 60.0
  assert.ok(input.topRiskCategories.length > 0);
  assert.ok(input.topRiskCategories.every((c) => typeof c.label === 'string' && c.count > 0));
  // Top1 类别：fixture 中 should_refuse_violation 先于 prompt_injection 插入，计数相等时稳定排序取首个
  assert.deepEqual(input.topRiskCategories[0], { label: '高风险请求越界', count: 1 });
  assert.ok(input.topRiskDomains.length > 0);
  // Top1 风险域：should_refuse_violation → harmful_capability
  assert.deepEqual(input.topRiskDomains[0], { label: '有害能力/高风险请求风险', count: 1 });
  assert.ok(input.remediationCategories.length > 0);
  assert.equal(input.hasAgentRisk, false); // fixture 无 agent 内容
});

test('summarizeForJudge：UNKNOWN 放行——不计入通过率分母（与 report-builder 同源）', () => {
  // PASS 3 + FAIL 1 + UNKNOWN 1：放行口径下 UNKNOWN 不进分母 → 3 / 4 = 75.0
  const input = summarize({
    ...fixture,
    verdictCounts: { PASS: 3, FAIL: 1, UNKNOWN: 1 },
  });
  assert.equal(input.executionPassRatePercent, 75); // 3/(3+1)=75.0，而非含 UNKNOWN 的 3/5=60.0
});

test('summarizeForJudge：ERROR 与红队 A 侧不进入规则结论通过率', () => {
  const question = {
    content: '测试样本',
    type: 'GENERAL',
    shouldRefuse: false,
    language: 'zh',
    severity: 'HIGH' as const,
    category: 'general',
  };
  const withError = summarize({
    ...fixture,
    verdictCounts: { PASS: 1, FAIL: 1, ERROR: 1 },
    results: [
      { finalVerdict: 'PASS', status: 'SUCCESS', side: null, question },
      { finalVerdict: 'FAIL', status: 'SUCCESS', side: null, question },
      { finalVerdict: 'ERROR', status: 'ERROR', side: null, question },
    ],
  });
  assert.equal(withError.executionPassRatePercent, 50);

  const redTeamPair = summarize({
    ...fixture,
    task: {
      ...fixture.task,
      totalQuestions: 1,
      processedQuestions: 1,
      passedCount: 1,
      failedCount: 0,
      errorCount: 0,
    },
    verdictCounts: { PASS: 1, FAIL: 1 },
    results: [
      {
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        side: 'A',
        controlGroupId: 'pair-1',
        question,
      },
      {
        finalVerdict: 'PASS',
        status: 'SUCCESS',
        side: 'B',
        controlGroupId: 'pair-1',
        question,
      },
    ],
  });
  assert.equal(redTeamPair.executionPassRatePercent, 100);
});

test('buildLocalReportJudgment：有风险时四字段成段，gatewayNote 仅 agent 风险时出现', () => {
  const input: ReportJudgeInput = {
    totalQuestions: 5,
    executionPassRatePercent: 60,
    riskCount: 2,
    bySeverity: { 高危: 1, 中危: 1 },
    topRiskCategories: [{ label: '应拒答违规', count: 1 }],
    topRiskDomains: [{ label: '内容安全', count: 1 }],
    remediationCategories: ['应拒答违规'],
    hasAgentRisk: false,
  };
  const j = buildLocalReportJudgment(input);
  assert.equal(j.source, 'local');
  assert.equal(j.configured, false);
  assert.ok(j.posture.length > 0);
  assert.ok(j.topRisks.length > 0);
  assert.ok(j.remediationPriority.length > 0);
  assert.ok(j.focus.length > 0);
  assert.equal(j.gatewayNote, undefined);
  const jAgent = buildLocalReportJudgment({ ...input, hasAgentRisk: true });
  assert.ok(jAgent.gatewayNote && jAgent.gatewayNote.length > 0);
  assert.doesNotMatch(jAgent.gatewayNote, /部署|产品|网关名|火线宝/);
});

test('buildLocalReportJudgment：无风险时只陈述本次完成范围与覆盖边界', () => {
  const j = buildLocalReportJudgment({
    totalQuestions: 5,
    executionPassRatePercent: 100,
    riskCount: 0,
    bySeverity: {},
    topRiskCategories: [],
    topRiskDomains: [],
    remediationCategories: [],
    hasAgentRisk: false,
  });
  assert.match(j.posture, /未形成风险项/);
  assert.match(JSON.stringify(j), /仅覆盖本次样本与引擎/);
  assert.doesNotMatch(JSON.stringify(j), /上线|合规/);
});

test('renderJudgment：四字段成段；llm 与 local 来源标注不同；gatewayNote 条件出现', () => {
  const llm: ReportAiJudgment = {
    source: 'llm',
    configured: true,
    posture: '态势A',
    topRisks: '风险B',
    remediationPriority: '整改C',
    focus: '重点D',
    gatewayNote: '能力E',
    modelTargetName: '复核模型X',
  };
  const text = renderJudgment(llm);
  assert.match(text, /\*\*整体态势\*\*：态势A/);
  assert.match(text, /\*\*重点风险及业务含义\*\*：风险B/);
  assert.match(text, /\*\*整改 \/ 能力建设优先级\*\*：整改C/);
  assert.match(text, /\*\*关注重点\*\*：重点D/);
  assert.match(text, /\*\*能力建设建议\*\*：能力E/);
  assert.match(text, /本研判的辅助建议由复核模型 复核模型X 生成/);

  const local: ReportAiJudgment = {
    source: 'local',
    configured: false,
    posture: 'P',
    topRisks: 'R',
    remediationPriority: 'M',
    focus: 'F',
    skippedReason: '未配置可用复核模型，已使用规则模板研判。',
  };
  const localText = renderJudgment(local);
  assert.doesNotMatch(localText, /能力建设建议/); // 无 gatewayNote
  assert.match(localText, /复核模型不可用（未配置可用复核模型，已使用规则模板研判。）/);
});

const mockTarget = {
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'test-key',
  model: 'test-model',
  extraHeaders: null,
  defaultParams: null,
};

const judgeInput: ReportJudgeInput = {
  totalQuestions: 5,
  executionPassRatePercent: 60,
  riskCount: 2,
  bySeverity: { 高危: 1, 中危: 1 },
  topRiskCategories: [{ label: '应拒答违规', count: 1 }],
  topRiskDomains: [{ label: '内容安全', count: 1 }],
  remediationCategories: ['应拒答违规'],
  hasAgentRisk: true,
};

function okResult(content: string): import('@lse/shared').LlmCallResult {
  return {
    status: 'SUCCESS',
    content,
    finishReason: 'stop',
    model: 'test-model',
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    latencyMs: 12,
    httpStatus: 200,
    error: null,
    raw: {},
  };
}

test('generateReportJudgment：SUCCESS 路径用复核模型、轻量输入、maxTokens=700', async () => {
  let capturedPrompt = '';
  let capturedMaxTokens: number | undefined;
  const j = await generateReportJudgment(judgeInput, {
    target: mockTarget,
    targetName: '复核模型X',
    callModel: async (_cfg, messages, opts) => {
      capturedPrompt = messages.map((m) => m.content).join('\n');
      capturedMaxTokens = opts.maxTokens;
      return okResult(
        JSON.stringify({
          posture: '态势A',
          topRisks: '风险B',
          remediationPriority: '整改C',
          focus: '重点D',
          gatewayNote: '能力E',
        }),
      );
    },
  });
  assert.equal(j.source, 'llm');
  assert.equal(j.configured, true);
  assert.equal(j.modelTargetName, '复核模型X');
  assert.equal(j.posture, buildLocalReportJudgment(judgeInput).posture);
  assert.equal(j.gatewayNote, '能力E');
  assert.equal(capturedMaxTokens, 700);
  assert.ok(capturedPrompt.length < 4000, `prompt too long: ${capturedPrompt.length}`);
  assert.match(capturedPrompt, /只输出一行中文 JSON/);
  assert.doesNotMatch(capturedPrompt, /机密/);
});

test('generateReportJudgment：无 target 降级 local 并标注原因', async () => {
  const j = await generateReportJudgment(judgeInput, { target: null });
  assert.equal(j.source, 'local');
  assert.match(j.skippedReason ?? '', /未配置可用复核模型/);
});

test('generateReportJudgment：非 SUCCESS 降级 local 并带 error', async () => {
  const j = await generateReportJudgment(judgeInput, {
    target: mockTarget,
    targetName: '复核模型X',
    callModel: async () => ({ ...okResult(''), status: 'ERROR', error: '超时' }),
  });
  assert.equal(j.source, 'local');
  assert.match(j.skippedReason ?? '', /超时/);
  assert.equal(j.modelTargetName, '复核模型X');
});

test('generateReportJudgment：模型输出、错误和目标名称统一脱敏', async () => {
  const outputSecret = 'sk-judge-output-secret-1234567890';
  const targetSecret = 'sk-judge-target-secret-1234567890';
  const success = await generateReportJudgment(judgeInput, {
    target: mockTarget,
    targetName: `复核模型 ${targetSecret} <MASKED>`,
    callModel: async () =>
      okResult(
        JSON.stringify({
          posture: `态势 ${outputSecret} <MASKED>`,
          topRisks: `风险 ${outputSecret}`,
          remediationPriority: '立即轮换凭据',
          focus: '凭据保护',
          gatewayNote: `能力建议 password: ${outputSecret}`,
        }),
      ),
  });
  const successJson = JSON.stringify(success);
  assert.doesNotMatch(successJson, new RegExp(outputSecret));
  assert.doesNotMatch(successJson, new RegExp(targetSecret));
  assert.doesNotMatch(successJson, /<MASKED>/);
  assert.match(successJson, /hash:[a-f0-9]{12}|内容已.*脱敏/);

  const errorSecret = 'judge-error-secret-123456789';
  const failed = await generateReportJudgment(judgeInput, {
    target: mockTarget,
    targetName: `复核模型 ${targetSecret} <MASKED>`,
    callModel: async () => ({
      ...okResult(''),
      status: 'ERROR',
      error: `Authorization: Bearer ${errorSecret} <MASKED>`,
    }),
  });
  const failedJson = JSON.stringify(failed);
  assert.doesNotMatch(failedJson, new RegExp(errorSecret));
  assert.doesNotMatch(failedJson, new RegExp(targetSecret));
  assert.doesNotMatch(failedJson, /<MASKED>/);
  assert.match(failedJson, /hash:[a-f0-9]{12}|内容已.*脱敏/);
});

test('generateReportJudgment：空内容降级 local', async () => {
  const j = await generateReportJudgment(judgeInput, {
    target: mockTarget,
    callModel: async () => okResult('   '),
  });
  assert.equal(j.source, 'local');
  assert.match(j.skippedReason ?? '', /未返回有效内容/);
});

test('generateReportJudgment：坏 JSON 降级 local', async () => {
  const j = await generateReportJudgment(judgeInput, {
    target: mockTarget,
    callModel: async () => okResult('这不是 JSON'),
  });
  assert.equal(j.source, 'local');
  assert.match(j.skippedReason ?? '', /不是有效 JSON/);
});

test('generateReportJudgment：gatewayNote 仅 hasAgentRisk 时采用', async () => {
  const j = await generateReportJudgment(
    { ...judgeInput, hasAgentRisk: false },
    {
      target: mockTarget,
      callModel: async () =>
        okResult(
          JSON.stringify({
            posture: 'p',
            topRisks: 'r',
            remediationPriority: 'm',
            focus: 'f',
            gatewayNote: '不该出现',
          }),
        ),
    },
  );
  assert.equal(j.gatewayNote, undefined);
});

test('generateReportJudgment：AI 越权声称上线、认证或绝对安全时回退规则模板', async () => {
  const fallback = await generateReportJudgment(judgeInput, { target: null });
  const j = await generateReportJudgment(judgeInput, {
    target: mockTarget,
    callModel: async () =>
      okResult(
        JSON.stringify({
          posture: '系统绝对安全，可以上线，且符合国家标准。',
          topRisks: '无风险可用。',
          remediationPriority: '建议上线。',
          focus: '放心使用。',
        }),
      ),
  });
  assert.equal(j.posture, fallback.posture);
  assert.equal(j.topRisks, fallback.topRisks);
  assert.equal(j.remediationPriority, fallback.remediationPriority);
  assert.equal(j.focus, fallback.focus);
});

test('makeSpecializedReport：专项报告不继承总体 aiJudgment', () => {
  const withJudgment: ReportInputData = {
    ...fixture,
    task: { ...fixture.task, engines: ['rule-judge', 'agent-tool-guard'] },
    aiJudgment: {
      source: 'llm',
      configured: true,
      posture: '专项研判态势QQ',
      topRisks: 'R',
      remediationPriority: 'M',
      focus: 'F',
      modelTargetName: '复核模型X',
    },
  };
  const built = buildSpecializedReport('agent_tool_abuse', withJudgment);
  assert.doesNotMatch(built.content, /## 总体研判|专项研判态势QQ/);
  assert.equal(built.summary.aiJudgment, undefined);
});

test('buildTaskReport：执行摘要保留规则结论，aiJudgment 仅在辅助章节渲染', () => {
  const withJudgment: ReportInputData = {
    ...fixture,
    aiJudgment: {
      source: 'llm',
      configured: true,
      posture: '研判态势XYZ',
      topRisks: '研判风险',
      remediationPriority: '研判整改',
      focus: '研判重点',
      modelTargetName: '复核模型X',
    },
  };
  const built = buildTaskReport(withJudgment);
  assert.doesNotMatch(built.content, /研判态势XYZ/);
  assert.match(built.content, /本次定向样本范围/);
  assert.match(built.content, /本研判的辅助建议由复核模型 复核模型X 生成/);

  const without = buildTaskReport(fixture);
  assert.doesNotMatch(without.content, /研判态势XYZ/);
  // 回退原 conclusion（模板话）
  assert.match(without.content, /本次评估/);
});
