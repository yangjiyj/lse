import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { shortDate } from './utils';

export interface SparkPoint {
  date: string;
  value: number;
}

/** 迷你趋势线：纯 SVG，悬停显示当日值及其口径。 */
export function Sparkline({
  points,
  color,
  hint,
  unit,
}: {
  points: SparkPoint[];
  color: string;
  /** 悬停提示里的口径说明 */
  hint: string;
  unit: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;
  const W = 132;
  const H = 40;
  const pad = 4;
  const max = Math.max(1, ...points.map((p) => p.value));
  const x = (i: number) => pad + (i * (W - pad * 2)) / (points.length - 1);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${H - pad} L${x(0).toFixed(1)} ${H - pad} Z`;
  const gid = `spark-${color.replace('#', '')}`;
  const cur = hover ?? points.length - 1;
  return (
    <div className="relative" onMouseLeave={() => setHover(null)} data-testid="sparkline">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`近 ${points.length} 天趋势：${hint}`}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          setHover(
            Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))),
          );
        }}
      >
        <title>{hint}</title>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gid})`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={x(cur)}
          cy={y(points[cur]!.value)}
          r="3"
          fill="#fff"
          stroke={color}
          strokeWidth="1.8"
        />
      </svg>
      {hover != null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs leading-[18px] text-white shadow-lg"
        >
          {shortDate(points[hover]!.date)} {hint}：{points[hover]!.value} {unit}
        </div>
      )}
    </div>
  );
}

export type KpiTone = 'neutral' | 'high' | 'critical';

const TONE_TEXT: Record<KpiTone, string> = {
  neutral: 'text-ink',
  high: 'text-severity-high',
  critical: 'text-severity-critical',
};
const TONE_ICON: Record<KpiTone, string> = {
  neutral: 'bg-severity-unknown-bg text-severity-unknown',
  high: 'bg-severity-high-bg text-severity-high',
  critical: 'bg-severity-critical-bg text-severity-critical',
};

/** 指标卡：零值显示绿色「已清零」，非零用语义色并可点击跳转。 */
export function KpiCard({
  icon,
  title,
  value,
  tone,
  to,
  zeroText,
  detail,
  spark,
  loading,
  error,
  onRetry,
}: {
  icon: ReactNode;
  title: string;
  /** null = 数据暂不可用（不显示数字） */
  value: number | null;
  tone: Exclude<KpiTone, 'neutral'>;
  to: string;
  zeroText: string;
  detail?: ReactNode;
  spark?: ReactNode;
  loading?: boolean;
  /** 接口失败：数字位置显示重试，不展示任何数字 */
  error?: boolean;
  onRetry?: () => void;
}) {
  const zero = value === 0;
  const shownTone: KpiTone = zero || value == null ? 'neutral' : tone;
  const inner = (
    <>
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'grid h-8 w-8 place-items-center rounded-full [&_svg]:h-4 [&_svg]:w-4',
            zero ? 'bg-severity-pass-bg text-severity-pass' : TONE_ICON[tone],
          )}
        >
          {icon}
        </span>
        <span className="text-[14px] font-medium text-ink-2">{title}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          {error ? (
            <div className="font-num text-[38px] font-bold leading-[44px] text-ink-3">—</div>
          ) : loading ? (
            <div className="h-10 w-16 animate-pulse rounded bg-slate-100" aria-label="加载中" />
          ) : value == null ? (
            <div className="font-num text-[38px] font-bold leading-[44px] text-ink-3">—</div>
          ) : (
            <div
              className={cn(
                'font-num text-[38px] font-bold leading-[44px] tabular-nums',
                zero ? 'text-ink' : TONE_TEXT[shownTone],
              )}
            >
              {value.toLocaleString('zh-CN')}
            </div>
          )}
          <div className="mt-2 min-h-[24px] text-xs text-ink-3">
            {error ? (
              <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-severity-high">
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                加载失败 · 点击重试
              </span>
            ) : zero ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-severity-pass-bg px-2.5 py-0.5 text-[12.5px] font-semibold text-severity-pass">
                <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
                {zeroText}
              </span>
            ) : (
              detail
            )}
          </div>
        </div>
        {spark && <div className="shrink-0 pb-1">{spark}</div>}
      </div>
    </>
  );
  const cls =
    'block p-5 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <Card className="min-w-0 p-0">
      <Link
        to={to}
        onClick={(e) => {
          if (error && onRetry) {
            e.preventDefault();
            onRetry();
          }
        }}
        className={cn(cls, 'rounded-card')}
        aria-label={`${title}${value != null ? ` ${value}` : ''}`}
      >
        {inner}
      </Link>
    </Card>
  );
}
