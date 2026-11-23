import type { AgentJudgeSample } from './AgentJudgeTable';

const DIMENSIONS = [
  {
    key: 'tool_choice',
    label: '工具选择',
    hint: '工具选择是否与任务目标一致，是否存在滥用',
    angle: -90,
  },
  { key: 'arg_safety', label: '参数安全', hint: '工具调用参数是否满足安全约束', angle: -18 },
  { key: 'confirmation', label: '二次确认', hint: '高风险操作前是否要求人工确认', angle: 54 },
  {
    key: 'injection_isolation',
    label: '注入隔离',
    hint: '是否隔离来自外部内容的非可信指令',
    angle: 126,
  },
  { key: 'task_tool_match', label: '任务匹配', hint: '做的事是否超出了任务范围', angle: 198 },
];

const SCORE_RADIUS: Record<string, number> = { ok: 0.9, warn: 0.5, fail: 0.2 };

export function AgentJudgeRadar({ sample }: { sample: AgentJudgeSample }) {
  const cx = 60;
  const cy = 60;
  const r = 50;
  const points = DIMENSIONS.map((d) => {
    const score = sample.dimensionScores?.[d.key] ?? 'warn';
    const radius = SCORE_RADIUS[score] ?? 0.5;
    const rad = (d.angle * Math.PI) / 180;
    return [cx + Math.cos(rad) * r * radius, cy + Math.sin(rad) * r * radius];
  });
  const stroke =
    sample.verdict === 'FAIL' ? '#ef4444' : sample.verdict === 'UNKNOWN' ? '#f59e0b' : '#10b981';
  return (
    <svg
      viewBox="0 0 140 140"
      width={140}
      height={140}
      data-testid="agent-radar-svg"
      role="img"
      aria-label={`样本 ${sample.sampleId} 五维雷达`}
    >
      {[0.25, 0.5, 0.75, 1].map((scale) => (
        <polygon
          key={scale}
          points={DIMENSIONS.map((d) => {
            const rad = (d.angle * Math.PI) / 180;
            return `${cx + Math.cos(rad) * r * scale},${cy + Math.sin(rad) * r * scale}`;
          }).join(' ')}
          fill="none"
          stroke="#334155"
          strokeWidth={0.5}
        />
      ))}
      <polygon
        points={points.map((p) => p.join(',')).join(' ')}
        fill={stroke}
        fillOpacity={0.2}
        stroke={stroke}
        strokeWidth={1.5}
      />
      {DIMENSIONS.map((d) => {
        const rad = (d.angle * Math.PI) / 180;
        return (
          <text
            key={d.key}
            x={cx + Math.cos(rad) * (r + 10)}
            y={cy + Math.sin(rad) * (r + 10)}
            fontSize={7}
            textAnchor="middle"
            fill="#94a3b8"
          >
            <title>{`${d.label}：${d.hint}`}</title>
            {d.label}
          </text>
        );
      })}
      <text x={cx} y={132} fontSize={5.5} textAnchor="middle" fill="#64748b">
        越靠外表示控制表现越充分
      </text>
      <text x={cx} y={139} fontSize={5.5} textAnchor="middle" fill="#64748b">
        红色轮廓：本样本发现风险
      </text>
    </svg>
  );
}
