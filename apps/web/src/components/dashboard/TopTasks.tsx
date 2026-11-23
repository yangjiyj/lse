import { Link } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import type { DashboardOverview } from '@/lib/api';
import { formatEvalScore } from '@/lib/format';
import { DashCard, type CardLoadState } from './DashCard';

const RANK_STYLE = [
  'bg-severity-critical-bg text-severity-critical',
  'bg-severity-high-bg text-severity-high',
  'bg-severity-medium-bg text-severity-medium',
];

/** 得分条颜色：得分越低越危险。 */
function scoreColor(score: number): string {
  if (score < 60) return '#B42318';
  if (score < 80) return '#B04A05';
  return '#1B7A46';
}

export function TopTasks({
  tasks,
  state,
}: {
  tasks?: DashboardOverview['topHighRiskTasks'];
  state: CardLoadState;
}) {
  return (
    <DashCard
      title="高风险任务排行"
      state={state}
      skeletonRows={5}
      className="h-full"
      action={
        <Link
          to="/eval-tasks"
          aria-label="查看全部评估任务"
          className="text-[13px] font-medium text-brand-600 hover:text-brand-700"
        >
          评估任务 ›
        </Link>
      }
    >
      {!tasks || tasks.length === 0 ? (
        <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-severity-pass-bg text-severity-pass">
            <ClipboardList className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="text-[15px] font-semibold text-ink">暂无高风险任务</div>
          <p className="text-[13px] text-ink-3">当前范围内没有出现高风险回复的评估任务。</p>
        </div>
      ) : (
        <ol>
          {tasks.map((t, idx) => (
            <li key={t.id} className="border-b border-line/70 last:border-0">
              <Link
                to={`/eval-tasks/${t.id}`}
                className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 py-3 hover:bg-canvas/60 sm:grid-cols-[28px_minmax(0,1fr)_minmax(140px,200px)_auto]"
              >
                <span
                  className={`grid h-7 w-7 place-items-center rounded-full font-num text-[13px] font-bold ${RANK_STYLE[idx] ?? 'bg-severity-unknown-bg text-ink-2'}`}
                >
                  {idx + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className="block truncate text-[14px] font-semibold text-ink"
                    title={t.name}
                  >
                    {t.name}
                  </span>
                  <span
                    className="block truncate text-xs text-ink-3"
                    title={`${t.modelName ?? '—'} · 中风险 ${t.mediumRiskCount}`}
                  >
                    {t.modelName ?? '—'} · 中风险 {t.mediumRiskCount}
                  </span>
                </span>
                <span className="hidden items-center gap-2 sm:flex">
                  <span className="text-xs text-ink-3">得分</span>
                  {t.evalScore != null ? (
                    <>
                      <span
                        className="h-1.5 flex-1 overflow-hidden rounded-full bg-severity-low-bg"
                        aria-hidden="true"
                      >
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${Math.max(Math.min(t.evalScore, 100), 2)}%`,
                            background: scoreColor(t.evalScore),
                          }}
                        />
                      </span>
                      <b className="w-11 text-right font-num text-[14px] font-bold tabular-nums text-ink">
                        {formatEvalScore(t.evalScore)}
                      </b>
                    </>
                  ) : (
                    // 评估不完整的任务不出分：显示「—（评估不完整）」，不画得分条，不把 100 分当安全。
                    <span
                      className="flex-1 text-right text-xs text-ink-3"
                      title="存在未判定或异常样本，未形成完整结论，因此不给出评估得分"
                    >
                      —（评估不完整）
                    </span>
                  )}
                </span>
                <span className="text-right leading-tight">
                  <b className="block font-num text-[20px] font-bold tabular-nums text-severity-critical">
                    {t.highRiskCount}
                  </b>
                  <span className="text-xs text-ink-3">项高风险</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </DashCard>
  );
}
