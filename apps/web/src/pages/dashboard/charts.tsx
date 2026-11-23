import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart as RechartsRadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useElementWidth } from '@/components/dashboard/utils';

// 图表文字统一用高对比色，深浅背景下都可读；Tooltip 用深底白字。
export const CHART_TEXT = '#334155';
export const CHART_GRID = '#e2e8f0';
export const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 6,
    color: '#f8fafc',
    fontSize: 12,
  },
  itemStyle: { color: '#f8fafc' },
  labelStyle: { color: '#cbd5e1' },
} as const;
const AXIS_TICK = { fill: '#64748b', fontSize: 12 };
const LEGEND_STYLE = { color: CHART_TEXT, fontSize: 12 };

export const RISK_COLORS = { HIGH: '#dc2626', MEDIUM: '#f59e0b', LOW: '#94a3b8' } as const;
// 政企风格的克制配色：以蓝、青、靛为主，辅以中性灰；风险色单独定义。
export const PALETTE = [
  '#1d4ed8',
  '#0891b2',
  '#4f46e5',
  '#0d9488',
  '#64748b',
  '#60a5fa',
  '#a16207',
  '#94a3b8',
];
/** 单系列柱图统一主色，避免彩虹色。 */
export const BAR_COLOR = '#2f5bd3';

export interface NamedValue {
  name: string;
  value: number;
  color?: string;
  /** 业务键（如等级、风险类别编码），点击下钻时用。 */
  key?: string;
}

function NoData() {
  return <p className="py-10 text-center text-sm text-slate-500">暂无数据</p>;
}

/** 环形图：只画非零项；全为 0 时显示「暂无数据」。children 放在圆心；传 onSelect 时扇区可点。 */
export function DonutChart({
  data,
  label,
  size = 164,
  children,
  onSelect,
}: {
  data: NamedValue[];
  label: string;
  size?: number;
  children?: ReactNode;
  onSelect?: (item: NamedValue) => void;
}) {
  const shown = data.filter((d) => d.value > 0);
  if (shown.length === 0) return <NoData />;
  return (
    <div
      role="group"
      aria-label={label}
      className="relative shrink-0"
      style={{ width: size, height: size }}
    >
      <PieChart width={size} height={size}>
        <Pie
          data={shown}
          dataKey="value"
          nameKey="name"
          innerRadius="66%"
          outerRadius="100%"
          paddingAngle={1}
          stroke="none"
          isAnimationActive={false}
        >
          {shown.map((d, i) => (
            <Cell
              key={d.name}
              fill={d.color ?? PALETTE[i % PALETTE.length]}
              aria-label={`${d.name} ${d.value}`}
              style={onSelect ? { cursor: 'pointer' } : undefined}
              onClick={onSelect ? () => onSelect(d) : undefined}
            />
          ))}
        </Pie>
        <Tooltip {...TOOLTIP_STYLE} />
      </PieChart>
      {children && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {children}
        </div>
      )}
    </div>
  );
}

/** 雷达图坐标轴文字：去掉「风险」后缀、取「/」前一段；完整名称看悬停提示。 */
function radarAxisLabel(name: string): string {
  return name.replace(/风险$/, '').split('/')[0]!;
}

const AXIS_FONT = 12;
const AXIS_LINE = 15;

/** 估算文字宽度：中文和全角字符按一个字号，其余按 0.6 个字号。 */
function textWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0xff ? fontSize : fontSize * 0.6;
  return w;
}

function clipText(text: string, maxWidth: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && textWidth(`${chars.join('')}…`, fontSize) > maxWidth) chars.pop();
  return `${chars.join('')}…`;
}

/** 把坐标轴文字排进 maxWidth：放得下就一行；放不下按宽度对半折成两行；两行还放不下才截断。 */
export function fitAxisLabel(text: string, maxWidth: number, fontSize = AXIS_FONT): string[] {
  if (textWidth(text, fontSize) <= maxWidth) return [text];
  const chars = [...text];
  let cut = 1;
  let widest = Infinity;
  for (let i = 1; i < chars.length; i++) {
    const w = Math.max(
      textWidth(chars.slice(0, i).join(''), fontSize),
      textWidth(chars.slice(i).join(''), fontSize),
    );
    if (w <= widest) [cut, widest] = [i, w];
  }
  if (widest > maxWidth) {
    cut = 1;
    while (
      cut < chars.length - 1 &&
      textWidth(chars.slice(0, cut + 1).join(''), fontSize) <= maxWidth
    )
      cut++;
  }
  return [chars.slice(0, cut).join(''), clipText(chars.slice(cut).join(''), maxWidth, fontSize)];
}

interface AxisTickProps {
  x: number;
  y: number;
  textAnchor?: 'start' | 'middle' | 'end';
  payload: { value: string; coordinate: number };
}

/**
 * 雷达图坐标轴文字：按所在一侧剩余的宽度排字，放不下才折行；
 * 上方顶点的文字压在点上面，下方的挂在点下面，两侧的与点垂直居中，避免文字盖住顶点。
 */
function RadarAxisTick({
  x,
  y,
  textAnchor = 'middle',
  payload,
  width,
}: AxisTickProps & { width: number }) {
  // 两侧的文字再往外让一点，别贴着顶点的圆点
  const tx = x + (textAnchor === 'start' ? 4 : textAnchor === 'end' ? -4 : 0);
  const room =
    textAnchor === 'start' ? width - tx : textAnchor === 'end' ? tx : 2 * Math.min(tx, width - tx);
  const lines = fitAxisLabel(
    radarAxisLabel(String(payload.value)),
    Math.max(room - 4, AXIS_FONT * 2),
  );
  const up = Math.sin((payload.coordinate * Math.PI) / 180);
  const firstDy =
    up > 0.9
      ? -(lines.length - 1) * AXIS_LINE
      : up < -0.9
        ? AXIS_FONT
        : Math.round(AXIS_FONT * 0.35 - ((lines.length - 1) * AXIS_LINE) / 2);
  return (
    <text x={tx} y={y} textAnchor={textAnchor} fill={CHART_TEXT} fontSize={AXIS_FONT}>
      {lines.map((line, i) => (
        <tspan key={i} x={tx} dy={i === 0 ? firstDy : AXIS_LINE}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

const RADAR_DOT = { r: 3.5, fill: '#fff', stroke: BAR_COLOR, strokeWidth: 2 };

/** 雷达图至少要 3 个有值的顶点才连得成面；更少时不画。 */
export const RADAR_MIN_POINTS = 3;

/** 雷达图：每项一个顶点；有值的不足 3 项时显示「暂无数据」。传 onSelect 时顶点可点（也可用键盘）。 */
export function RadarChart({
  data,
  label,
  height = 260,
  onSelect,
}: {
  data: NamedValue[];
  label: string;
  height?: number;
  onSelect?: (item: NamedValue) => void;
}) {
  const [wrapRef, width] = useElementWidth(360);
  if (data.filter((d) => d.value > 0).length < RADAR_MIN_POINTS) return <NoData />;
  const dot = onSelect
    ? (props: { key?: string; cx?: number; cy?: number; index?: number }) => {
        const item = data[props.index ?? 0]!;
        return (
          <circle
            key={props.key}
            cx={props.cx}
            cy={props.cy}
            {...RADAR_DOT}
            r={4.5}
            role="link"
            tabIndex={0}
            aria-label={`${item.name} ${item.value}`}
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(item)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              onSelect(item);
            }}
          />
        );
      }
    : RADAR_DOT;
  return (
    <div ref={wrapRef} role="group" aria-label={label} className="w-full" style={{ height }}>
      <RechartsRadarChart
        width={width}
        height={height}
        data={data}
        // 左右两侧给坐标轴文字留够宽度，窄屏时缩小雷达而不是截掉文字。
        outerRadius={Math.max(40, Math.min(height / 2 - 34, width / 2 - 96))}
      >
        <PolarGrid stroke={CHART_GRID} />
        <PolarAngleAxis
          dataKey="name"
          tick={(props: AxisTickProps) => <RadarAxisTick {...props} width={width} />}
        />
        <PolarRadiusAxis tick={false} axisLine={false} />
        <Radar
          dataKey="value"
          name="风险回复"
          stroke={BAR_COLOR}
          fill={BAR_COLOR}
          fillOpacity={0.18}
          strokeWidth={2}
          dot={dot}
          isAnimationActive={false}
        />
        <Tooltip {...TOOLTIP_STYLE} />
      </RechartsRadarChart>
    </div>
  );
}

export function SimpleBarChart({
  data,
  label,
  seriesName,
  horizontal = false,
}: {
  data: NamedValue[];
  label: string;
  seriesName: string;
  horizontal?: boolean;
}) {
  return (
    <div role="img" aria-label={label} className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={{ left: 8, right: 16 }}
        >
          <CartesianGrid stroke={CHART_GRID} vertical={false} />
          {horizontal ? (
            <>
              <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} />
              <YAxis type="category" dataKey="name" width={96} tick={AXIS_TICK} />
            </>
          ) : (
            <>
              <XAxis dataKey="name" tick={AXIS_TICK} interval={0} />
              <YAxis allowDecimals={false} tick={AXIS_TICK} />
            </>
          )}
          <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: 'rgba(148,163,184,0.15)' }} />
          <Bar dataKey="value" name={seriesName} radius={2} maxBarSize={28}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.color ?? BAR_COLOR} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendChart({
  data,
}: {
  data: Array<{ date: string; created: number; completed: number; failed: number }>;
}) {
  const rows = data.map((d) => ({ ...d, day: d.date.slice(5) }));
  return (
    <div role="img" aria-label="任务评估情况统计图（按日）" className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ left: 0, right: 16 }}>
          <CartesianGrid stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="day" tick={AXIS_TICK} />
          <YAxis allowDecimals={false} tick={AXIS_TICK} />
          <Tooltip {...TOOLTIP_STYLE} />
          <Legend wrapperStyle={LEGEND_STYLE} />
          <Line
            type="monotone"
            dataKey="created"
            name="新建"
            stroke="#1d4ed8"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="completed"
            name="完成"
            stroke="#0d9488"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="failed"
            name="失败"
            stroke="#dc2626"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
