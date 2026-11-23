import { runObservedScenario } from '../src/modules/agent-evals/observed-runner.js';
import { agentToolGuard } from '../src/modules/engines/agent-tool-guard.js';
import type { AgentScenario } from '../src/modules/agent-evals/types.js';
import type { ObservedToolCall, PlatformAdapter, PlatformTurnResult } from '../src/modules/eval-targets/platform-adapters/types.js';
import type { ReportInputData } from '../src/modules/reports/report-builder.js';

/** 夹具里一个场景的“平台回放”：每轮返回的回答和工具调用；不真实调用任何平台。 */
export interface ReplayTurn { text: string; toolCalls?: ObservedToolCall[] }
export interface ReportFixtureCase {
  scenario: AgentScenario;
  /** 按轮次回放；轮次不够时重复最后一轮。 */
  turns: ReplayTurn[];
  /** 受控接收端命中（抓取诱饵页、外发等）。 */
  sinkHits?: { kind?: 'fetch' | 'exfil'; channel?: string; canaryPresent: boolean }[];
}

export function replayAdapter(turns: ReplayTurn[]): PlatformAdapter {
  let index = 0;
  return {
    diagnose: async () => ({ ok: true, detail: '' }),
    sendTurn: async (): Promise<PlatformTurnResult> => {
      const turn = turns[Math.min(index, turns.length - 1)]!;
      index += 1;
      return { text: turn.text, toolCalls: turn.toolCalls ?? [], conversationId: 'conv-fixture', latencyMs: 5 };
    },
  };
}

/**
 * 用真实的 runObservedScenario 与 agentToolGuard 生成平台智能体任务的报告输入，
 * 结构与 gatherReportData 对平台任务的输出一致（results / engineRuns / findings / wrongAnswers）。
 */
export async function buildPlatformReportData(cases: ReportFixtureCase[], overrides: { name?: string; dimensions?: string[]; targetType?: string; provider?: string } = {}): Promise<ReportInputData> {
  const now = new Date('2026-10-30T08:00:00.000Z');
  const results: NonNullable<ReportInputData['results']> = [];
  const engineRuns: ReportInputData['engineRuns'] = [];
  const findings: ReportInputData['findings'] = [];
  const wrongAnswers: ReportInputData['wrongAnswers'] = [];
  const verdictCounts: Record<string, number> = {};
  for (const [index, item] of cases.entries()) {
    const id = `fixture-result-${index}`;
    const run = await runObservedScenario(replayAdapter(item.turns), { prompt: item.scenario.prompt, metadata: item.scenario.metadata },
      { retryDelayMs: 0, sinkHits: () => item.sinkHits ?? [] });
    let verdict = run.verdict;
    let judged: ReturnType<typeof agentToolGuard> | null = null;
    // 与执行器一致：平台错误 -> UNKNOWN；空回答且无轨迹 -> UNKNOWN；否则交给 agent-tool-guard 聚合。
    if (!(run.content.trim().length === 0 && run.trace.length === 0)) {
      judged = agentToolGuard({ taskId: 'fixture-task', questionId: id, questionType: 'PROMPT_INJECTION', prompt: item.scenario.prompt, response: run.content,
        shouldRefuse: true, severity: 'HIGH', rules: { agentMetadata: run.raw as Record<string, unknown>, agentTrace: run.trace } } as never);
      verdict = judged.verdict;
    } else verdict = 'UNKNOWN';
    verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
    results.push({ id, prompt: item.scenario.prompt, response: run.content, finalVerdict: verdict, status: 'SUCCESS',
      question: { content: item.scenario.prompt, type: item.scenario.type, shouldRefuse: true, language: item.scenario.language, severity: item.scenario.severity,
        category: item.scenario.category, displayTitle: null }, engineRuns: [{ status: 'SUCCESS', skippedCount: 0 }] });
    engineRuns.push({ resultId: id, engine: 'agent-tool-guard', status: 'SUCCESS', rawOutput: JSON.stringify(run.raw), normalizedCount: run.trace.length, skippedCount: 0, durationMs: 5, errorMessage: null });
    if (verdict === 'FAIL' && judged) {
      findings.push({ resultId: id, engine: 'agent-tool-guard', riskCategory: judged.riskCategory, severity: judged.severity, verdict: 'FAIL', score: 0, confidence: 0.9,
        evidenceStrength: judged.evidenceStrength ?? null, executionOutcome: judged.executionOutcome ?? null, reviewStatus: 'ACTIVE',
        title: `[agent-tool-guard] ${judged.riskCategory}`, evidence: judged.evidence, detail: judged.rawOutput });
      wrongAnswers.push({ resultId: id, questionContent: item.scenario.prompt, modelResponse: run.content, riskCategory: judged.riskCategory, severity: judged.severity,
        engine: 'agent-tool-guard', reason: judged.evidence });
    }
  }
  const passed = verdictCounts.PASS ?? 0;
  const failed = verdictCounts.FAIL ?? 0;
  return {
    generatedAt: now,
    task: { id: 'fixture-task', name: overrides.name ?? 'Dify 客服应用 智能体工具安全评估 ab12cd34', description: '智能体工具安全评估（快速档）', status: 'COMPLETED', concurrency: 1,
      engines: ['agent-tool-guard'], dimensions: overrides.dimensions ?? ['agent_tool_call'], totalQuestions: cases.length, processedQuestions: cases.length, passedCount: passed,
      failedCount: failed, errorCount: 0, createdAt: now, startedAt: now, finishedAt: now,
      modelTarget: { name: 'Dify 客服应用', provider: overrides.provider ?? 'dify', model: 'platform-app', targetType: overrides.targetType ?? 'PLATFORM_APP' },
      questionSets: [{ id: 'fixture-set', name: 'Dify 客服应用 智能体工具安全评估 运行记录 ab12cd34', type: 'PROMPT_INJECTION', language: 'zh', source: 'agent-runtime:fixture-task',
        tags: ['agent:runtime', 'agent-level:smoke'], questionCount: cases.length }] },
    verdictCounts, findings, engineRuns, wrongAnswers, results,
  } as ReportInputData;
}
