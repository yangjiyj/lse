import { Link } from 'react-router-dom';
import {
  DISCOVERY_TRUNCATED_HINT,
  corpusTruncatedHint,
  type DashboardDetectRisks,
  type DetectRiskCategoryStat,
} from '@/lib/detect-risks';
import { ChipTag, DashCard, type CardLoadState } from './DashCard';
import { detectResultsHref } from './drill';
import { fmt } from './utils';

/** 首页「四类风险」（2.2.2）：模型、数据、内容、应用与环境，口径见 docs/detect-risk-categories.md。 */
export function DetectRiskCard({
  data,
  periodLabel,
  state,
  postureFindingTotal,
}: {
  data?: DashboardDetectRisks;
  periodLabel: string;
  state: CardLoadState;
  /** 同一周期安全态势卡的风险回复数；差额是终端体检的通过项，有差额时写明。 */
  postureFindingTotal?: number | null;
}) {
  const evalCounts = data?.categories
    .flatMap((c) => c.sources)
    .filter((s) => s.source === 'eval_content' || s.source === 'eval_app');
  const evalTotal =
    evalCounts && evalCounts.length === 2 && evalCounts.every((s) => s.count)
      ? evalCounts.reduce((sum, s) => sum + s.count!.total, 0)
      : null;
  const gap =
    postureFindingTotal != null && evalTotal != null ? postureFindingTotal - evalTotal : 0;
  return (
    <section aria-label="四类风险">
      <DashCard
        title="四类风险"
        badge={<ChipTag>{periodLabel}</ChipTag>}
        state={state}
        skeletonRows={4}
      >
        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {data.categories.map((c) => (
                <CategoryCell
                  key={c.category}
                  stat={c}
                  since={data.periodStart}
                  hint={
                    c.category === 'data' && data.truncatedCorpusScans > 0
                      ? corpusTruncatedHint(data.truncatedCorpusScans)
                      : c.category === 'app_env' && data.discoveryRunsTruncated
                        ? DISCOVERY_TRUNCATED_HINT
                        : null
                  }
                />
              ))}
            </div>
            {gap > 0 && (
              <p className="mt-3 text-xs text-ink-3">
                {`评估类比安全态势「风险回复」（已扣误报）少 ${fmt(gap)} 条：终端体检通过项不计入`}
              </p>
            )}
          </>
        )}
      </DashCard>
    </section>
  );
}

function CategoryCell({
  stat,
  since,
  hint,
}: {
  stat: DetectRiskCategoryStat;
  since: string | null;
  /** 计数不全的提示（语料命中过多、资产测绘次数过多） */
  hint: string | null;
}) {
  const visible = stat.sources.filter((s) => s.count);
  const cell = 'flex min-w-0 flex-col rounded-xl bg-canvas p-3.5';
  if (visible.length === 0) {
    return (
      <div data-testid="detect-risk-cell" data-category={stat.category} className={cell}>
        <div className="text-[13px] font-medium text-ink-2">{stat.label}</div>
        <div className="mt-1 font-num text-[28px] font-bold leading-8 text-ink-3">—</div>
      </div>
    );
  }
  return (
    <div data-testid="detect-risk-cell" data-category={stat.category} className={cell}>
      <Link to={detectResultsHref({ category: stat.category, since })} className="group block">
        <div className="text-[13px] font-medium text-ink-2 group-hover:text-brand-700">
          {stat.label}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="font-num text-[28px] font-bold leading-8 tabular-nums text-ink">
            {fmt(stat.total)}
          </span>
          <span
            className={`text-[12.5px] ${stat.high > 0 ? 'font-medium text-severity-high' : 'text-ink-3'}`}
          >
            {`高危 ${fmt(stat.high)}`}
          </span>
        </div>
      </Link>
      <ul className="mt-2.5 space-y-1 border-t border-line pt-2.5">
        {visible.map((s) => (
          <li key={s.source}>
            <Link
              to={detectResultsHref({ category: stat.category, since, source: s.source })}
              className="flex items-center justify-between gap-2 text-xs text-ink-3 hover:text-brand-700"
            >
              <span className="truncate">{s.label}</span>
              <span className="font-num tabular-nums">{fmt(s.count!.total)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {hint && <p className="mt-2 text-xs text-severity-high">{hint}</p>}
    </div>
  );
}
