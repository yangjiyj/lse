import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { EVAL_WEIGHT_DIMENSION_LABELS } from '@lse/shared';
import { api } from '@/lib/api';

/** 任务详情「综合评估得分」：按配置管理中的评估维度权重占比与评估分数权重占比计算；评估不完整时不出分。 */
export function WeightedScoreCard({
  taskId,
  scoreReady = true,
}: {
  taskId: string;
  /** 任务已完成且已处理样本 > 0；否则（如复测排队中）得分显示「—」，不展示旧分数与维度明细。 */
  scoreReady?: boolean;
}) {
  const query = useQuery({
    queryKey: ['evaluation-config', 'task-score', taskId],
    queryFn: () => api.evaluationConfig.taskScore(taskId),
  });
  if (!query.data) return null;
  const incomplete = scoreReady && query.data.incomplete === true;
  const score = scoreReady && !incomplete ? query.data.score : null;
  const dimensions = scoreReady && !incomplete ? query.data.dimensions : [];
  return (
    <div
      className="rounded-card border border-[#EDF1F8] bg-white p-6 shadow-card"
      data-testid="weighted-score"
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-primary" />
          <span className="text-[15px] font-bold text-ink">综合评估得分</span>
        </div>
        <span className="text-[32px] font-bold leading-none tabular-nums text-ink">
          {score === null ? '—' : score.toFixed(1)}
        </span>
        <span className="text-xs text-muted-foreground">
          {incomplete
            ? '评估不完整（存在未判定、异常或被跳过的样本），不给出得分'
            : !scoreReady
              ? '任务未完成，不给出得分'
              : score === null
              ? '暂无已判定样本'
              : '按「平台设置 → 配置管理」的评估维度权重占比与评估分数权重占比计算'}
        </span>
      </div>
      {dimensions.length > 0 ? (
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {dimensions.map((d) => (
            <div key={d.dimension} className="rounded-xl bg-[#F7F9FD] px-4 py-3">
              <div className="text-xs text-muted-foreground">
                {EVAL_WEIGHT_DIMENSION_LABELS[d.dimension]} · 权重 {d.effectiveWeight}%
              </div>
              <div className="mt-1 font-semibold tabular-nums">{d.score.toFixed(1)}</div>
              <div className="text-xs text-muted-foreground tabular-nums">
                通过率 {d.passRateScore.toFixed(1)} · 严重度 {d.severityScore.toFixed(1)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
