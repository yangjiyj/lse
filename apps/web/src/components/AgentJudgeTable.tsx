import { useState, Fragment } from 'react';

const DIMENSION_LABELS: Array<{ key: string; label: string }> = [
  { key: 'tool_choice', label: '工具选择' },
  { key: 'arg_safety', label: '参数安全' },
  { key: 'confirmation', label: '二次确认' },
  { key: 'injection_isolation', label: '注入隔离' },
  { key: 'task_tool_match', label: '任务匹配' },
];

export interface AgentJudgeSample {
  sampleId: string;
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  score: number;
  dimensionScores?: Record<string, 'ok' | 'warn' | 'fail'>;
  reason: string;
}

interface Props {
  samples: ReadonlyArray<AgentJudgeSample>;
  onRowClick?: (s: AgentJudgeSample) => void;
}

const SCORE_COLOR: Record<string, string> = {
  ok: '#10b981',
  warn: '#f59e0b',
  fail: '#ef4444',
};

// 维度分档中文解读：正常 / 需关注 / 不合格
const SCORE_LABEL: Record<string, string> = {
  ok: '正常',
  warn: '需关注',
  fail: '不合格',
};

// 总体结论中文解读
const VERDICT_LABEL: Record<string, string> = {
  PASS: '通过',
  FAIL: '发现风险',
  UNKNOWN: '待人工复核',
};

function verdictLabel(v: string): string {
  return VERDICT_LABEL[v] ?? '待人工复核';
}

function verdictColorKey(v: string): string {
  return v === 'FAIL' ? 'fail' : v === 'UNKNOWN' ? 'warn' : 'ok';
}

export function AgentJudgeTable({ samples, onRowClick }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-700 text-xs text-slate-500">
          <th className="px-2 py-1 text-left">样本</th>
          {DIMENSION_LABELS.map((d) => (
            <th key={d.key} className="px-2 py-1 text-left">
              {d.label}
            </th>
          ))}
          <th className="px-2 py-1 text-left">总体结论</th>
        </tr>
      </thead>
      <tbody>
        {samples.map((s) => {
          const isOpen = expanded === s.sampleId;
          return (
            <Fragment key={s.sampleId}>
              <tr
                onClick={() => {
                  setExpanded(isOpen ? null : s.sampleId);
                  onRowClick?.(s);
                }}
                className="cursor-pointer border-b border-slate-800 hover:bg-slate-900/60"
              >
                <td className="px-2 py-1 text-slate-200">{s.sampleId}</td>
                {DIMENSION_LABELS.map((d) => {
                  const score = s.dimensionScores?.[d.key] ?? 'warn';
                  return (
                    <td
                      key={d.key}
                      data-score={score}
                      style={{ color: SCORE_COLOR[score] }}
                      className="px-2 py-1 text-xs"
                    >
                      {SCORE_LABEL[score] ?? '需关注'}
                    </td>
                  );
                })}
                <td
                  className="px-2 py-1 text-xs font-medium"
                  style={{ color: SCORE_COLOR[verdictColorKey(s.verdict)] }}
                >
                  {verdictLabel(s.verdict)}
                </td>
              </tr>
              {isOpen && (
                <tr>
                  <td colSpan={7} className="bg-slate-900/80 px-3 py-2 text-xs text-slate-300">
                    {s.reason}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
