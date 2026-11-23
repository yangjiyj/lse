import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Select } from '@/components/ui/select';
import { QueryState } from '@/components/QueryState';

export const HEATMAP_FRAMEWORKS = [
  ['OWASP_AGENTIC', 'OWASP 智能体十大风险'],
  ['OWASP_LLM', 'OWASP 大模型十大风险'],
  ['ATLAS_MATRIX', 'MITRE ATLAS（技术）'],
] as const;

/** 旧链接里的 framework 取值兼容：ATLAS 一律按 ATLAS_MATRIX 处理。 */
function normalizeFramework(value: string | null): string {
  if (value === 'ATLAS') return 'ATLAS_MATRIX';
  return HEATMAP_FRAMEWORKS.some(([id]) => id === value) ? (value as string) : 'OWASP_AGENTIC';
}

/** 单元格底色：0 失败为绿；失败率 <25% / <50% / >=50% 三档逐级加深（文字对比度均 >= 4.5:1）。 */
export const HEAT_TONES = {
  clean: 'bg-severity-pass-bg text-severity-pass',
  low: 'bg-severity-critical-bg text-severity-critical',
  mid: 'bg-[#F8C9C3] text-[#8E1B10]',
  high: 'bg-severity-critical text-white',
} as const;

function cellTone(failCount: number, rate: number | null): string {
  if (failCount === 0) return HEAT_TONES.clean;
  const r = rate ?? 0;
  return r >= 0.5 ? HEAT_TONES.high : r >= 0.25 ? HEAT_TONES.mid : HEAT_TONES.low;
}

export function FrameworkHeatmapPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [dimension, setDimension] = useState<'target' | 'task'>('target');
  const [showUntested, setShowUntested] = useState(false);
  const [unmappedOpen, setUnmappedOpen] = useState(false);
  const framework = normalizeFramework(searchParams.get('hmFramework'));
  const query = useQuery({
    queryKey: ['framework-heatmap', framework, dimension],
    queryFn: () => api.frameworks.heatmap({ framework, dimension }),
  });
  const data = query.data;
  const cellMap = useMemo(
    () => new Map((data?.cells ?? []).map((cell) => [`${cell.entryId}:${cell.columnId}`, cell])),
    [data],
  );
  const testedEntryIds = useMemo(
    () => new Set((data?.cells ?? []).filter((cell) => cell.tested).map((cell) => cell.entryId)),
    [data],
  );
  const allItems = data?.items ?? [];
  const items = showUntested ? allItems : allItems.filter((item) => testedEntryIds.has(item.id));
  const hiddenCount = allItems.length - items.length;
  const isAtlas = framework === 'ATLAS_MATRIX';

  return (
    <div className="space-y-4" data-testid="heatmap-panel">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-ink-2">
          框架
          <Select
            aria-label="热力图框架"
            className="w-56"
            value={framework}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              next.set('hmFramework', event.target.value);
              setSearchParams(next, { replace: true });
            }}
          >
            {HEATMAP_FRAMEWORKS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-ink-2">
          列维度
          <Select
            aria-label="列维度"
            className="w-36"
            value={dimension}
            onChange={(event) => setDimension(event.target.value as 'target' | 'task')}
          >
            <option value="target">评估对象</option>
            <option value="task">评估任务</option>
          </Select>
        </label>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-ink-2">
          <input
            type="checkbox"
            checked={showUntested}
            onChange={(event) => setShowUntested(event.target.checked)}
          />
          显示未测试条目
        </label>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line bg-canvas px-4 py-2.5 text-[13px] text-ink-2"
        aria-label="图例"
      >
        <span className="flex items-center gap-2">
          <span className="inline-flex h-5 w-8 items-center justify-center rounded border border-dashed border-line-2 bg-white text-ink-3">
            —
          </span>
          无数据（未测试，不等于安全）
        </span>
        <span className="flex items-center gap-2">
          <span className={`inline-block h-5 w-8 rounded ${HEAT_TONES.clean}`} />
          已测·无风险
        </span>
        <span className="flex items-center gap-2">
          有风险（失败率由低到高）
          <span className="inline-flex overflow-hidden rounded">
            <span className={`inline-block h-5 w-8 ${HEAT_TONES.low}`} />
            <span className={`inline-block h-5 w-8 ${HEAT_TONES.mid}`} />
            <span className={`inline-block h-5 w-8 ${HEAT_TONES.high}`} />
          </span>
        </span>
      </div>

      {query.isLoading || query.isError ? (
        <QueryState
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          onRetry={() => query.refetch()}
          empty={false}
          emptyTitle="暂无框架数据"
          emptyDescription="当前没有可展示的框架映射。"
        />
      ) : (
        <>
          {(data?.unmappedCount ?? 0) > 0 && (
            <div className="rounded-lg border border-severity-high/30 bg-severity-high-bg p-3 text-sm text-severity-high">
              <button
                type="button"
                className="font-medium underline"
                aria-expanded={unmappedOpen}
                onClick={() => setUnmappedOpen((open) => !open)}
              >
                有 {data?.unmappedCount} 条结果未映射到该框架的任何条目（
                {unmappedOpen ? '收起' : '查看明细'}）
              </button>
              {unmappedOpen && (
                <div className="mt-2 space-y-1" data-testid="unmapped-detail">
                  <p>这些结果的风险类别暂未映射到该框架，不代表没有风险。按风险类别分布：</p>
                  <ul className="list-disc pl-5">
                    {(data?.unmapped ?? []).map((entry) => (
                      <li key={entry.label}>
                        {entry.label}：{entry.count} 条
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-2 p-4 text-sm text-ink-3">
              所选框架下暂时没有已测条目。可打开「显示未测试条目」查看全部 {allItems.length} 条。
            </p>
          ) : (
            <div className="max-h-[70vh] overflow-auto rounded-[14px] border border-line">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 top-0 z-10 border-b border-r border-line bg-[#F7F9FD] px-3 py-2.5 text-left text-[13px] font-semibold text-ink-3">
                      框架条目
                    </th>
                    {data?.columns.map((column) => (
                      <th
                        key={column.id}
                        className="sticky top-0 border-b border-line bg-[#F7F9FD] px-3 py-2.5 text-[13px] font-semibold text-ink-3"
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="h-10" data-testid={`heat-row-${item.id}`}>
                      <th className="sticky left-0 border-b border-r border-line bg-white px-3 py-2 text-left font-normal">
                        <span className="font-medium">{item.nameZh || item.nameEn}</span>
                        <span className="ml-1 font-mono text-[13px] text-ink-3">{item.id}</span>
                        {item.nameZh && item.nameEn && (
                          <span className="block text-[13px] text-ink-3">{item.nameEn}</span>
                        )}
                        {item.groupZh && (
                          <span className="block text-[13px] text-ink-3">战术：{item.groupZh}</span>
                        )}
                      </th>
                      {data?.columns.map((column) => {
                        const cell = cellMap.get(`${item.id}:${column.id}`);
                        return (
                          <td key={column.id} className="border-b border-line p-1 text-center">
                            {cell?.tested ? (
                              <Link
                                className={`block rounded px-2 py-1.5 font-medium tabular-nums hover:opacity-90 ${cellTone(cell.failCount, cell.rate)}`}
                                title={`失败率 ${Math.round((cell.rate ?? 0) * 100)}%，占该列已判定结果的 ${Math.round(cell.coverage * 100)}%`}
                                to={
                                  dimension === 'task'
                                    ? `/wrong-answers?taskId=${column.id}`
                                    : `/wrong-answers?findingIds=${encodeURIComponent(cell.findingIds.join(','))}`
                                }
                              >
                                {cell.failCount}/{cell.testCount} 失败
                              </Link>
                            ) : (
                              <span
                                className="block text-line-2"
                                aria-label="无数据"
                                title="无数据（未测试）"
                              >
                                —
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!showUntested && hiddenCount > 0 && (
            <p className="text-[13px] text-ink-3">
              已隐藏 {hiddenCount} 条所有对象都没有数据的条目（平台无法测试或尚未测试）。
            </p>
          )}
          {isAtlas && (
            <p className="text-[13px] text-ink-3">
              中文名为平台译名，以 MITRE 官方英文名为准；未译条目保留英文原名。
            </p>
          )}
          <p className="text-[13px] text-ink-3">
            单元格为「失败题数/已测题数」，点击可查看对应风险。{data?.disclaimer}
          </p>
        </>
      )}
    </div>
  );
}
