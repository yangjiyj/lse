import { useEffect, useState } from 'react';
import type { DashboardRange, SeverityCounts } from '@/lib/api';

export const RANGE_OPTIONS: Array<{ value: DashboardRange; label: string }> = [
  { value: 'month', label: '本月' },
  { value: '7d', label: '近 7 天' },
  { value: 'all', label: '全部' },
];

export function rangeLabel(range: DashboardRange): string {
  return RANGE_OPTIONS.find((item) => item.value === range)?.label ?? '';
}

/** 数字千分位（中文环境）。 */
export function fmt(n: number): string {
  return n.toLocaleString('zh-CN');
}

/** 占比，保留 1 位小数；分母为 0 时返回 0。 */
export function pct(part: number, total: number): string {
  if (!total) return '0.0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

export const SEVERITY_ORDER: Array<keyof SeverityCounts> = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'INFO',
];

/** 堆叠条 / 折线所用实心色（与严重度徽章语义一致，色值取自设计令牌）。 */
export const SEVERITY_FILL: Record<keyof SeverityCounts, string> = {
  CRITICAL: '#B42318',
  HIGH: '#B04A05',
  MEDIUM: '#D9A406',
  LOW: '#6F8BA8',
  INFO: '#A8B3C2',
};

/** 日期 2026-10-19 → 10/19。 */
export function shortDate(date: string): string {
  const [, m, d] = date.split('-');
  return m && d ? `${m}/${d}` : date;
}

/**
 * 量元素宽度（ResizeObserver 跟随变化）；量不到（如测试环境）时用 fallback。
 * 用回调 ref：图表只在数据加载后才挂载，普通 useEffect 取不到节点。
 */
export function useElementWidth(fallback: number) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const next = el.clientWidth;
      if (next > 0) setW(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w] as const;
}
