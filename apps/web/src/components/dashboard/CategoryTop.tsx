import { Link } from 'react-router-dom';
import { Tags } from 'lucide-react';
import type { DashboardRiskCategories } from '@/lib/api';
import { DashCard, ChipTag, type CardLoadState } from './DashCard';
import { fmt } from './utils';

export function CategoryTop({
  data,
  periodLabel,
  state,
  categoryHref,
}: {
  data?: DashboardRiskCategories;
  periodLabel: string;
  state: CardLoadState;
  /** 类别下钻链接（2.2.4）；不传则行不可点。 */
  categoryHref?: (key: string) => string;
}) {
  const items = data?.items ?? [];
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <DashCard
      title="风险类别分布"
      badge={<ChipTag>{periodLabel}</ChipTag>}
      state={state}
      skeletonRows={7}
      // 行数不足 5 行时不拉伸占满整行高度，卡片高度跟随内容，不留大片空白。
      className={items.length >= 5 ? 'h-full' : 'self-start'}
      action={
        <Link
          to="/reports/framework-coverage"
          className="text-[13px] font-medium text-brand-600 hover:text-brand-700"
        >
          框架映射 ›
        </Link>
      }
    >
      {items.length === 0 ? (
        <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand-500">
            <Tags className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="text-[15px] font-semibold text-ink">{periodLabel}暂无风险类别数据</div>
          <p className="text-[13px] text-ink-3">产生风险回复后，按类别汇总排名。</p>
        </div>
      ) : (
        <ol className="space-y-3.5">
          {items.map((it, idx) => {
            const row =
              'grid grid-cols-[minmax(0,10.5rem)_1fr_auto] items-center gap-3 sm:grid-cols-[minmax(0,12rem)_1fr_auto]';
            const body = (
              <>
                <span className="truncate text-[13.5px] text-ink" title={it.label}>
                  {it.label}
                </span>
                <span
                  className="h-2.5 overflow-hidden rounded-full bg-severity-low-bg"
                  aria-hidden="true"
                >
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.max((it.count / max) * 100, 3)}%`,
                      background: idx === 0 ? '#1F57E0' : '#7FA6F5',
                    }}
                  />
                </span>
                <b
                  className="min-w-[2ch] text-right font-num text-[14px] font-bold tabular-nums text-ink"
                  title={it.high > 0 ? `其中高危及以上 ${it.high} 条` : undefined}
                >
                  {fmt(it.count)}
                </b>
              </>
            );
            return (
              <li key={it.key}>
                {categoryHref ? (
                  <Link
                    to={categoryHref(it.key)}
                    aria-label={`${it.label} ${fmt(it.count)}`}
                    className={`${row} rounded-md hover:bg-canvas/60`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div className={row}>{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </DashCard>
  );
}
