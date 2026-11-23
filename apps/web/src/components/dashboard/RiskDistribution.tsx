import { Link, useNavigate } from 'react-router-dom';
import { Layers } from 'lucide-react';
import type { SeverityCounts } from '@/lib/api';
import { SeverityBadge } from '@/components/ui/severity-badge';
import { SEVERITY_LABELS } from '@/lib/format';
import { DonutChart } from '@/pages/dashboard/charts';
import { DashCard, ChipTag, type CardLoadState } from './DashCard';
import { SEVERITY_FILL, SEVERITY_ORDER, fmt, pct } from './utils';

export function RiskDistribution({
  counts,
  periodLabel,
  state,
  levelHref,
}: {
  counts?: SeverityCounts;
  periodLabel: string;
  state: CardLoadState;
  /** 等级下钻链接（2.2.4）；不传则扇区和图例不可点。 */
  levelHref?: (level: keyof SeverityCounts) => string;
}) {
  const navigate = useNavigate();
  const total = counts ? SEVERITY_ORDER.reduce((s, k) => s + counts[k], 0) : 0;
  const rows = counts ? SEVERITY_ORDER.filter((k) => counts[k] > 0) : [];
  return (
    <DashCard
      title="风险等级分布"
      badge={<ChipTag>{periodLabel}</ChipTag>}
      state={state}
      skeletonRows={5}
      className="h-full"
    >
      {!counts || total === 0 ? (
        <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand-500">
            <Layers className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="text-[15px] font-semibold text-ink">{periodLabel}暂无风险回复</div>
          <p className="text-[13px] text-ink-3">发起评估后在此查看风险等级构成。</p>
        </div>
      ) : (
        <>
          <div className="flex justify-center">
            <DonutChart
              label="风险等级分布"
              size={140}
              data={rows.map((k) => ({
                key: k,
                name: SEVERITY_LABELS[k],
                value: counts[k],
                color: SEVERITY_FILL[k],
              }))}
              onSelect={
                levelHref ? (d) => navigate(levelHref(d.key as keyof SeverityCounts)) : undefined
              }
            >
              <span className="font-num text-[26px] font-bold leading-8 tabular-nums text-ink">
                {fmt(total)}
              </span>
              <span className="text-[12px] text-ink-3">条风险回复</span>
            </DonutChart>
          </div>
          <ul className="mt-3">
            {rows.map((k) => {
              const row = 'flex items-center justify-between py-2';
              const body = (
                <>
                  <SeverityBadge value={k} />
                  <span className="flex items-baseline gap-4">
                    <b className="font-num text-[18px] font-bold tabular-nums text-ink">
                      {fmt(counts[k])}
                    </b>
                    <span className="w-14 text-right font-num text-[13px] tabular-nums text-ink-3">
                      {pct(counts[k], total)}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={k} className="border-b border-line/70 last:border-0">
                  {levelHref ? (
                    <Link
                      to={levelHref(k)}
                      aria-label={`${SEVERITY_LABELS[k]} ${fmt(counts[k])} ${pct(counts[k], total)}`}
                      className={`${row} hover:bg-canvas/60`}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className={row}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </DashCard>
  );
}
