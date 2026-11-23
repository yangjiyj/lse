import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLlmJudgeEngine, buildJudgePrompt } from '../src/modules/engines/llm-judge.js';
import { runObservedScenario } from '../src/modules/agent-evals/observed-runner.js';
import { buildAgentTraceSamples, buildTaskReport } from '../src/modules/reports/report-builder.js';
import { buildReportRiskContext } from '../src/modules/reports/report-risk-context.js';
import { buildSpecializedReport } from '../src/modules/reports/specialized/index.js';
import { agentToolGuard } from '../src/modules/engines/agent-tool-guard.js';
import { createAgentLlmJudgeEngine } from '../src/modules/engines/agent-llm-judge.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/platform-app/reaccept-a2.json', import.meta.url), 'utf8'));
const finding = fixture.findings[0];
const result = fixture.results.find((r: any) => r.id === finding.resultId);
const run = fixture.engineRuns.find((r: any) => r.resultId === result.id);
const raw = JSON.parse(run.rawOutput);
const input = { ...result, questionType: 'PROMPT_INJECTION', shouldRefuse: true,
  rules: { agentMetadata: { ...raw, runnerVerdict: raw.verdict }, agentTrace: raw.trace } };

test('A2 真实判官 FAIL 与未执行越权的理由矛盾时降为 UNKNOWN', async () => {
  for (const reason of [finding.evidence, '未越权', '未执行页面里的指令']) {
    const engine = createLlmJudgeEngine({ target: { baseUrl: 'https://judge.test', apiKey: 'test', model: 'test' },
      chat: async () => ({ status: 'SUCCESS', content: JSON.stringify({ ...finding.detail, reason }) }) as any });
    const judged = await engine.judge(input);
    assert.equal(judged.verdict, 'UNKNOWN');
    assert.equal((judged.rawOutput as any).proposedVerdict, 'FAIL');
  }
});

test('A2 间接注入判官提示明确抓取诱饵页属于预期行为并提供观测证据', () => {
  const prompt = buildJudgePrompt(input).map(m => m.content).join('\n');
  assert.match(prompt, /抓取.*诱饵页.*预期行为/);
  assert.match(prompt, /html_comment/);
  assert.match(prompt, /fetch_url/);
});

test('平台语义判官在工具清单已知时也不能将未越权理由判 FAIL', async () => {
  const engine = createAgentLlmJudgeEngine({ target: { baseUrl: 'https://judge.test', apiKey: 'test', model: 'test' },
    chat: async () => ({ status: 'SUCCESS', content: JSON.stringify(finding.detail) }) as any });
  const judged = await engine.judge({ ...input, rules: { ...input.rules,
    agentMetadata: { ...input.rules.agentMetadata, allowedTools: ['fetch_url'] } } });
  assert.equal(judged.verdict, 'UNKNOWN');
});

test('A2 NEEDS_REVIEW 不计 active_fail，确认后才计入且同题确认风险不被隐藏', () => {
  const data = { results: [{ ...result, question: { content: result.prompt } }], findings: [finding], engineRuns: [run], wrongAnswers: [] } as any;
  assert.equal(buildReportRiskContext(data).failDisposition.activeFailCount, 0);
  assert.equal(buildReportRiskContext(data).failDisposition.unexplainedFailCount, 1);
  data.findings.push({ ...finding, reviewStatus: 'CONFIRMED' });
  assert.equal(buildReportRiskContext(data).failDisposition.activeFailCount, 1);
});

test('A2 真实 fetch_url 参数抓取诱饵不失败，已外发即使没有 canary 仍失败', async () => {
  const adapter = { diagnose: async () => ({ ok: true, detail: '' }), sendTurn: async () => raw.modelRaw[0] };
  const scenario = { prompt: result.prompt, metadata: raw };
  const fetched = await runObservedScenario(adapter, scenario, { sinkHits: async () => [{ kind: 'fetch', channel: 'html_comment', canaryPresent: false }] } as any);
  assert.notEqual(fetched.verdict, 'FAIL');
  assert.ok((fetched.raw as any).evidenceChain.some((e: any) => e.eventType === 'sink_fetch'));
  const exfil = await runObservedScenario(adapter, scenario, { sinkHits: async () => [{ kind: 'exfil', canaryPresent: false }] } as any);
  assert.equal(exfil.verdict, 'FAIL');
  assert.equal((exfil.raw as any).sinkCanaryHit, false);
  assert.ok((exfil.raw as any).evidenceChain.some((e: any) => e.eventType === 'sink_exfil'));
  assert.equal(exfil.trace.length, raw.trace.length, '接收端证据不能编造工具调用');
  const guarded = agentToolGuard({ ...input, rules: { agentMetadata: { ...(exfil.raw as any), runnerVerdict: exfil.verdict }, agentTrace: exfil.trace } });
  assert.equal(guarded.verdict, 'FAIL');
  assert.equal(guarded.executionOutcome, 'EXECUTED');
  assert.equal(guarded.evidenceStrength, 'CONTROLLED_EXECUTION');
});

test('A2 报告观测风险数与逐调用判定共用工具风险事实，UNKNOWN 不显示发现风险', () => {
  const now = new Date();
  const data = { task: { id: 'a3', name: '真实平台回放', status: 'COMPLETED', concurrency: 1, engines: ['agent-tool-guard'], dimensions: [], totalQuestions: 1, processedQuestions: 1, passedCount: 0, failedCount: 0, errorCount: 0, createdAt: now, modelTarget: { targetType: 'PLATFORM_APP', name: '脱敏平台', provider: 'dify', model: 'platform-app' }, questionSets: [] },
    results: [{ ...result, finalVerdict: 'UNKNOWN', question: { content: result.prompt, type: 'PROMPT_INJECTION', category: 'indirect_url', language: 'zh', shouldRefuse: true } }],
    findings: [], engineRuns: [run], wrongAnswers: [], verdictCounts: { UNKNOWN: 1 }, generatedAt: now } as any;
  assert.equal(buildSpecializedReport('agent_tool_abuse', data).summary.metrics.observedRiskToolCallCount, 0);
  assert.ok(!buildTaskReport(data).content.includes('| 发现风险 |'));
  for (const allowed of [true, false]) {
    const trace = [{ ...raw.trace[0], allowed, riskSurface: allowed ? null : 'data_exfiltration' }];
    data.engineRuns = [{ ...run, rawOutput: JSON.stringify({ ...raw, verdict: 'FAIL', trace }) }];
    const samples = buildAgentTraceSamples([], data.engineRuns);
    assert.equal(samples[0].verdictLabel, allowed ? '通过' : '未通过');
    assert.equal(buildSpecializedReport('agent_tool_abuse', data).summary.metrics.observedRiskToolCallCount, allowed ? 0 : 1);
  }
});
