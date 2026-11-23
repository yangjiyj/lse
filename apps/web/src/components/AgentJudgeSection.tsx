import { useMemo } from 'react';
import { useDemoMode } from '@/lib/use-demo-mode';
import { AgentJudgeTable, type AgentJudgeSample } from './AgentJudgeTable';
import { AgentJudgeRadar } from './AgentJudgeRadar';
import type { EvalResult } from '@/lib/api';

interface Props {
  results: ReadonlyArray<EvalResult>;
}

function extractSamples(results: ReadonlyArray<EvalResult>): AgentJudgeSample[] {
  const samples: AgentJudgeSample[] = [];
  for (const r of results) {
    const finding = (r.findings ?? []).find((f) => f.engine === 'agent-llm-judge');
    if (!finding) continue;
    const detail = (finding.detail ?? {}) as Record<string, unknown>;
    samples.push({
      sampleId: r.questionId.slice(0, 8),
      verdict: (finding.verdict ?? 'UNKNOWN') as 'PASS' | 'FAIL' | 'UNKNOWN',
      score: typeof detail.score === 'number' ? detail.score : 0,
      dimensionScores: detail.dimensionScores as Record<string, 'ok' | 'warn' | 'fail'> | undefined,
      reason: typeof detail.reason === 'string' ? detail.reason : '',
    });
  }
  return samples;
}

export function AgentJudgeSection({ results }: Props) {
  const { mode } = useDemoMode();
  const samples = useMemo(() => extractSamples(results), [results]);
  const summary = useMemo(() => {
    let safe = 0;
    let risk = 0;
    let review = 0;
    for (const s of samples) {
      if (s.verdict === 'FAIL') risk += 1;
      else if (s.verdict === 'UNKNOWN') review += 1;
      else safe += 1;
    }
    return { safe, risk, review };
  }, [samples]);
  if (samples.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="智能体决策安全画像"
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">智能体决策安全画像</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            从工具选择、参数安全、二次确认、注入隔离和任务匹配五个维度评估智能体决策。
          </p>
        </div>
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          共检查 {samples.length} 个场景
        </span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        这 {samples.length} 个里，
        <span className="font-medium text-foreground" style={{ color: '#10b981' }}>
          {summary.safe} 个未观察到有效风险
        </span>
        、
        <span className="font-medium text-foreground" style={{ color: '#ef4444' }}>
          {summary.risk} 个发现风险
        </span>
        、
        <span className="font-medium text-foreground" style={{ color: '#f59e0b' }}>
          {summary.review} 个待人工复核
        </span>
        。{mode === 'expert' ? '（判定引擎：agent-llm-judge）' : null}
      </p>
      {mode === 'expert' ? (
        <AgentJudgeTable samples={samples} />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {samples.map((s) => (
            <div
              key={s.sampleId}
              data-testid="agent-radar"
              className="flex flex-col items-center rounded-md border border-border p-2"
            >
              <AgentJudgeRadar sample={s} />
              <div className="mt-1 text-xs text-muted-foreground">
                样本 {s.sampleId} ·{' '}
                <span
                  style={{
                    color:
                      s.verdict === 'FAIL'
                        ? '#ef4444'
                        : s.verdict === 'UNKNOWN'
                          ? '#f59e0b'
                          : '#10b981',
                  }}
                >
                  {s.verdict === 'FAIL'
                    ? '发现风险'
                    : s.verdict === 'UNKNOWN'
                      ? '待复核'
                      : '未观察到风险'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
