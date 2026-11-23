import { useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChartNoAxesColumn } from 'lucide-react';
import type { DashboardTrend } from '@/lib/api';
import { DashCard, type CardLoadState } from './DashCard';
import { shortDate, useElementWidth } from './utils';

/** 取「好看」的纵轴上限与刻度（0 起，4 档以内的整数刻度）。 */
export function niceAxis(max: number): { top: number; ticks: number[] } {
  const m = Math.max(max, 1);
  const step = m <= 4 ? 1 : m <= 8 ? 2 : Math.ceil(m / 4 / 5) * 5 || 5;
  const top = Math.ceil(m / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

const BLUE = '#1F57E0';
const ORANGE = '#B04A05';

export function TrendChart({
  trend,
  state,
  dayHref,
}: {
  trend?: DashboardTrend;
  state: CardLoadState;
  /** 点某一天下钻到的页面（2.2.4）；不传（如无风险处置台权限）则不可点、不可聚焦。 */
  dayHref?: (date: string) => string;
}) {
  const navigate = useNavigate();
  const [wrapRef, width] = useElementWidth(640);
  const [hover, setHover] = useState<number | null>(null);
  const points = trend?.points ?? [];
  const total = points.reduce((s, p) => s + p.findings, 0);
  const H = 250;
  const L = 34;
  const R = 14;
  const T = 38;
  const B = 28;
  const innerW = Math.max(width - L - R, 100);
  const innerH = H - T - B;
  const maxVal = Math.max(0, ...points.map((p) => p.findings), ...points.map((p) => p.high));
  const { top, ticks } = niceAxis(maxVal);
  const x = (i: number) =>
    L + (points.length <= 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
  const y = (v: number) => T + innerH - (v / top) * innerH;
  const path = (key: 'findings' | 'high') =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const peakIdx =
    maxVal > 0
      ? points.reduce((best, p, i) => (p.findings > points[best]!.findings ? i : best), 0)
      : -1;
  const labelEvery = Math.max(1, Math.round(points.length / 6));
  const empty = points.length === 0 || total === 0;
  const hv = hover != null ? points[hover] : undefined;
  const indexAt = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - L) / innerW) * (points.length - 1));
    return Math.max(0, Math.min(points.length - 1, i));
  };
  const peak = peakIdx >= 0 ? points[peakIdx] : undefined;

  return (
    <DashCard
      title={`近 ${trend?.days ?? 30} 天风险趋势`}
      state={state}
      skeletonRows={6}
      bodyClassName="min-h-[250px]"
      action={
        <div className="flex items-center gap-4 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="18"
                y2="3"
                stroke={BLUE}
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
            风险回复
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="18"
                y2="3"
                stroke={ORANGE}
                strokeWidth="2.2"
                strokeDasharray="4 3"
              />
            </svg>
            其中高危
          </span>
        </div>
      }
    >
      {empty ? (
        <div className="flex h-[250px] flex-col items-center justify-center gap-2 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand-500">
            <ChartNoAxesColumn className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="text-[15px] font-semibold text-ink">
            近 {trend?.days ?? 30} 天暂无风险回复
          </div>
          <p className="text-[13px] text-ink-3">评估产生风险回复后，将在此展示每日走势。</p>
        </div>
      ) : (
        <div ref={wrapRef} className="relative w-full" data-testid="trend-chart">
          <svg
            width={width}
            height={H}
            role="img"
            aria-label={`近 ${points.length} 天风险回复共 ${total} 条，每日最多 ${maxVal} 条`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => setHover(indexAt(e))}
            onClick={dayHref ? (e) => navigate(dayHref(points[indexAt(e)]!.date)) : undefined}
            style={dayHref ? { cursor: 'pointer' } : undefined}
          >
            <defs>
              <linearGradient id="trend-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={BLUE} stopOpacity="0.22" />
                <stop offset="100%" stopColor={BLUE} stopOpacity="0" />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={L}
                  x2={width - R}
                  y1={y(t)}
                  y2={y(t)}
                  stroke="#E4EAF3"
                  strokeDasharray={t === 0 ? undefined : '3 4'}
                />
                <text
                  x={L - 8}
                  y={y(t) + 4}
                  textAnchor="end"
                  fontSize="12"
                  fill="#5B6778"
                  className="font-num"
                >
                  {t}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % labelEvery === 0 || i === points.length - 1 ? (
                <text
                  key={p.date}
                  x={x(i)}
                  y={H - 8}
                  textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                  fontSize="12"
                  fill="#5B6778"
                  className="font-num"
                >
                  {shortDate(p.date)}
                </text>
              ) : null,
            )}
            <path
              d={`${path('findings')} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`}
              fill="url(#trend-area)"
            />
            <path
              d={path('findings')}
              fill="none"
              stroke={BLUE}
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
            <path
              d={path('high')}
              fill="none"
              stroke={ORANGE}
              strokeWidth="2"
              strokeDasharray="5 4"
              strokeLinejoin="round"
            />
            {peak && hover == null && (
              <g>
                <circle
                  cx={x(peakIdx)}
                  cy={y(peak.findings)}
                  r="4.5"
                  fill="#fff"
                  stroke={BLUE}
                  strokeWidth="2.2"
                />
                {(() => {
                  const text = `${shortDate(peak.date)} 峰值 ${peak.findings}`;
                  const w = text.length * 7.2 + 18;
                  const cx = Math.min(Math.max(x(peakIdx), L + w / 2), width - R - w / 2);
                  const cy = Math.max(y(peak.findings) - 34, 2);
                  return (
                    <g>
                      <rect x={cx - w / 2} y={cy} width={w} height={24} rx="7" fill="#0F172A" />
                      <text
                        x={cx}
                        y={cy + 16}
                        textAnchor="middle"
                        fontSize="12"
                        fill="#fff"
                        className="font-num"
                      >
                        {text}
                      </text>
                    </g>
                  );
                })()}
              </g>
            )}
            {hv && hover != null && (
              <g>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={T}
                  y2={T + innerH}
                  stroke="#7FA6F5"
                  strokeDasharray="3 3"
                />
                <circle
                  cx={x(hover)}
                  cy={y(hv.findings)}
                  r="4.5"
                  fill="#fff"
                  stroke={BLUE}
                  strokeWidth="2.2"
                />
                <circle
                  cx={x(hover)}
                  cy={y(hv.high)}
                  r="4"
                  fill="#fff"
                  stroke={ORANGE}
                  strokeWidth="2"
                />
              </g>
            )}
          </svg>
          {dayHref &&
            points.map((p, i) => (
              // 每天一个可聚焦的点（键盘 Tab 到某天，回车或空格下钻）；鼠标点图上任意处取最近的一天。
              <button
                key={p.date}
                type="button"
                role="link"
                aria-label={`${shortDate(p.date)} 风险回复 ${p.findings} 条`}
                className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                style={{ left: x(i), top: y(p.findings) }}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => navigate(dayHref(p.date))}
              />
            ))}
          {hv && hover != null && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 rounded-lg bg-ink px-3 py-2 text-xs leading-5 text-white shadow-lg"
              style={{
                top: 4,
                left: Math.min(Math.max(x(hover) + 12, 0), width - 150),
              }}
            >
              <div className="font-num font-semibold">{hv.date}</div>
              <div>风险回复：{hv.findings} 条</div>
              <div>其中高危（含严重）：{hv.high} 条</div>
            </div>
          )}
        </div>
      )}
    </DashCard>
  );
}
