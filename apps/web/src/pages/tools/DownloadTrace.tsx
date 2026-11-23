import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toolsApi, type ToolDownloadRecent } from '@/lib/tools';
import { formatDateTime } from '@/lib/format';
import { niceAxis } from '@/components/dashboard/TrendChart';
import { shortDate, useElementWidth } from '@/components/dashboard/utils';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TOOLS_QUERY_KEY } from './labels';

const BLUE = '#1F57E0';

/** 近 30 天每日下载量折线（写法同首页风险趋势图）。 */
function DownloadTrendChart({ points }: { points: Array<{ date: string; count: number }> }) {
  const [wrapRef, width] = useElementWidth(640);
  const [hover, setHover] = useState<number | null>(null);
  const H = 180;
  const L = 34;
  const R = 14;
  const T = 16;
  const B = 26;
  const innerW = Math.max(width - L - R, 100);
  const innerH = H - T - B;
  const max = Math.max(0, ...points.map((p) => p.count));
  const { top, ticks } = niceAxis(max);
  const x = (i: number) =>
    L + (points.length <= 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
  const y = (v: number) => T + innerH - (v / top) * innerH;
  const line = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.count).toFixed(1)}`)
    .join(' ');
  const labelEvery = Math.max(1, Math.round(points.length / 6));
  const total = points.reduce((s, p) => s + p.count, 0);
  const hv = hover != null ? points[hover] : undefined;
  return (
    <div ref={wrapRef} className="relative w-full" data-testid="download-trend">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`近 ${points.length} 天共下载 ${total} 次，单日最多 ${max} 次`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - rect.left - L) / innerW) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
      >
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
              y={H - 6}
              textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
              fontSize="12"
              fill="#5B6778"
              className="font-num"
            >
              {shortDate(p.date)}
            </text>
          ) : null,
        )}
        <path d={line} fill="none" stroke={BLUE} strokeWidth="2.2" strokeLinejoin="round" />
        {hv && hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + innerH} stroke="#C9D3E1" />
            <circle
              cx={x(hover)}
              cy={y(hv.count)}
              r="4"
              fill="#fff"
              stroke={BLUE}
              strokeWidth="2"
            />
          </g>
        )}
      </svg>
      {hv && (
        <div className="pointer-events-none absolute right-2 top-0 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink-2 shadow-sm">
          {hv.date} · {hv.count} 次
        </div>
      )}
    </div>
  );
}

function RecentDownloads({ rows }: { rows: ToolDownloadRecent[] }) {
  return (
    <SectionCard title="下载明细">
      <Table>
        <THead>
          <TR>
            <TH>时间</TH>
            <TH>用户</TH>
            <TH>文件</TH>
            <TH>IP</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={`${r.createdAt}:${i}`}>
              <TD data-label="时间">{formatDateTime(r.createdAt)}</TD>
              <TD data-label="用户">{r.username ?? '匿名'}</TD>
              <TD data-label="文件" className="break-all">
                {r.filename ?? '—'}
              </TD>
              <TD data-label="IP" className="font-num">
                {r.ip}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </SectionCard>
  );
}

/** 下载记录（tool:manage）：30 天趋势 + 按用户汇总 + 最近 50 条下载明细。 */
export function DownloadTrace({ toolId }: { toolId: string }) {
  const q = useQuery({
    queryKey: [TOOLS_QUERY_KEY, 'downloads', toolId],
    queryFn: () => toolsApi.downloads(toolId),
  });
  const recent = q.data?.recent ?? [];
  return (
    <>
      <SectionCard
        title="下载记录"
        extra={
          q.data ? (
            <span className="text-[13px] text-ink-3 font-num">共 {q.data.total} 次</span>
          ) : undefined
        }
      >
        {q.isLoading ? (
          <LoadingBlock />
        ) : q.isError ? (
          <p className="text-sm text-severity-critical">{(q.error as Error).message}</p>
        ) : q.data ? (
          <div className="space-y-5">
            <DownloadTrendChart points={q.data.trend} />
            {q.data.byUser.length === 0 ? (
              <p className="py-4 text-center text-[13.5px] text-ink-3">还没有下载记录</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>用户</TH>
                    <TH>租户</TH>
                    <TH>安装包</TH>
                    <TH>手册</TH>
                    <TH>最近下载</TH>
                  </TR>
                </THead>
                <TBody>
                  {q.data.byUser.map((u) => (
                    <TR key={`${u.userId ?? ''}:${u.username ?? ''}`}>
                      <TD data-label="用户">{u.username ?? '匿名'}</TD>
                      <TD data-label="租户">{u.tenantName ?? '—'}</TD>
                      <TD data-label="安装包" className="font-num">
                        {u.packages}
                      </TD>
                      <TD data-label="手册" className="font-num">
                        {u.manuals}
                      </TD>
                      <TD data-label="最近下载">{formatDateTime(u.lastDownloadedAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </div>
        ) : null}
      </SectionCard>
      {recent.length > 0 && <RecentDownloads rows={recent} />}
    </>
  );
}
