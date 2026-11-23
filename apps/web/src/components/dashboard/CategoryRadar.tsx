import { useNavigate } from 'react-router-dom';
import type { DashboardRiskCategories } from '@/lib/api';
import { RADAR_MIN_POINTS, RadarChart } from '@/pages/dashboard/charts';
import { ChipTag, DashCard, type CardLoadState } from './DashCard';

/** 雷达图取风险类别接口的前 6 类。 */
const RADAR_MAX_POINTS = 6;

/**
 * 雷达卡要不要出：数据取到且类别不足 3 个时不出（排行卡占满整行）；加载中、失败时照常占位。
 */
export function showCategoryRadar(data?: DashboardRiskCategories): boolean {
  return !data || data.items.length >= RADAR_MIN_POINTS;
}

/** 风险类别雷达图（2.2.3）：取风险类别接口的前 6 类；类别不足 3 个时不渲染。 */
export function CategoryRadar({
  data,
  periodLabel,
  state,
  categoryHref,
}: {
  data?: DashboardRiskCategories;
  periodLabel: string;
  state: CardLoadState;
  /** 类别下钻链接（2.2.4）；不传则顶点不可点。 */
  categoryHref?: (key: string) => string;
}) {
  const navigate = useNavigate();
  if (!showCategoryRadar(data)) return null;
  const items = (data?.items ?? []).slice(0, RADAR_MAX_POINTS);
  return (
    <section aria-label="风险类别雷达" className="min-w-0">
      <DashCard
        title="风险类别雷达"
        badge={<ChipTag>{periodLabel}</ChipTag>}
        state={state}
        skeletonRows={6}
        className="h-full"
      >
        <RadarChart
          label="风险类别雷达图"
          data={items.map((it) => ({ key: it.key, name: it.label, value: it.count }))}
          onSelect={categoryHref ? (d) => navigate(categoryHref(d.key!)) : undefined}
        />
      </DashCard>
    </section>
  );
}
