import { Fragment, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type FrameworkCoverageResponse, type FrameworkCoverageStatus } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { QueryState } from '@/components/QueryState';
import { FrameworkHeatmapPanel } from '@/components/FrameworkHeatmapPanel';

export const COVERAGE_TABS = [
  ['OWASP_AGENTIC', 'OWASP 智能体十大风险'],
  ['OWASP_LLM', 'OWASP 大模型十大风险'],
  ['ATLAS', 'MITRE ATLAS'],
  ['HEATMAP', '按评估对象热力图'],
] as const;
type TabId = (typeof COVERAGE_TABS)[number][0];

const TAB_HINTS: Record<TabId, string> = {
  OWASP_AGENTIC:
    'OWASP Top 10 for Agentic Applications 2026（2025-12 发布）。需用智能体评估或平台应用评估补测。',
  OWASP_LLM: 'OWASP Top 10 for LLM Applications（2025）。',
  ATLAS: '只展示平台风险域能映射到的 ATLAS 技术条目，不展示完整矩阵。',
  HEATMAP:
    '按评估对象（或评估任务）横向对比各框架条目的失败情况；口径与覆盖矩阵一致，默认只显示有数据的条目。',
};

const STATUS_VIEW: Record<
  FrameworkCoverageStatus,
  { label: string; className: string; tone: 'neutral' | 'success' | 'critical' }
> = {
  NOT_TESTED: { label: '未测试', className: '', tone: 'neutral' },
  TESTED_CLEAN: { label: '已测·未发现风险', className: '', tone: 'success' },
  TESTED_FINDINGS: { label: '已测·发现风险', className: '', tone: 'critical' },
  NOT_SUPPORTED: {
    label: '平台暂不覆盖',
    className: 'border border-dashed border-slate-400 bg-white text-ink-3 ring-0',
    tone: 'neutral',
  },
};

export function CoverageStatusBadge({ status }: { status: FrameworkCoverageStatus }) {
  const view = STATUS_VIEW[status];
  return (
    <Badge
      tone={view.tone}
      icon={status !== 'NOT_SUPPORTED'}
      className={view.className}
      data-status={status}
    >
      {view.label}
    </Badge>
  );
}

const DAY_OPTIONS = [
  ['30', '近 30 天'],
  ['90', '近 90 天'],
  ['', '全部时间'],
] as const;

type Row = FrameworkCoverageResponse['rows'][number];

function entryTitle(row: Row): string {
  return row.entryNameEn ? `${row.entryName}（${row.entryNameEn}）` : row.entryName;
}

/** 旧书签：国标附录 A 页签已迁到「国内标准条款」页。 */
export function FrameworkCoveragePage() {
  const [searchParams] = useSearchParams();
  if (searchParams.get('framework') === 'GBT45654_ANNEX_A')
    return <Navigate to="/reports/standard-clauses?line=content" replace />;
  return <FrameworkCoverageView />;
}

function FrameworkCoverageView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(null);
  const tabParam = searchParams.get('framework');
  const tab: TabId = COVERAGE_TABS.some(([id]) => id === tabParam)
    ? (tabParam as TabId)
    : 'OWASP_AGENTIC';
  const taskId = searchParams.get('taskId') ?? '';
  const targetId = searchParams.get('targetId') ?? '';
  const days = searchParams.get('days') ?? '';

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  };

  const targets = useQuery({
    queryKey: ['coverage-targets'],
    queryFn: () => api.modelTargets.list({ pageSize: 100 }),
  });
  const query = useQuery({
    queryKey: ['framework-coverage', taskId, targetId, days],
    queryFn: () =>
      api.frameworks.coverage({
        taskId: taskId || undefined,
        targetId: targetId || undefined,
        days: days ? Number(days) : undefined,
      }),
  });
  const isHeatmap = tab === 'HEATMAP';
  const rows = (query.data?.rows ?? []).filter((row) => row.framework === tab);
  const tabCounts = rows.reduce<Record<FrameworkCoverageStatus, number>>(
    (acc, row) => ({ ...acc, [row.status]: acc[row.status] + 1 }),
    { NOT_TESTED: 0, TESTED_CLEAN: 0, TESTED_FINDINGS: 0, NOT_SUPPORTED: 0 },
  );
  const taskName = taskId
    ? query.data?.rows.flatMap((row) => row.recentTasks).find((task) => task.id === taskId)?.name
    : undefined;

  return (
    <div className="space-y-5">
      <PageHeader title="框架覆盖：国际框架（参考）" />
      <p className="text-[13.5px] text-ink-2">
        国际框架只作对照参考。国内标准条款（GB/T 45654 附录 A、智能体、终端）请看
        <Link className="mx-1 font-medium text-brand-600 hover:underline" to="/reports/standard-clauses">
          国内标准条款
        </Link>
        页。
      </p>
      <p className="rounded-card border border-severity-medium/30 bg-severity-medium-bg px-5 py-3 text-[13.5px] leading-6 text-severity-medium">
        覆盖矩阵回答：每条风险标准你测了没有、测出了什么。未测试不等于安全；已测·未发现风险也只代表本次所测题目未发现问题，样本偏少时不宜下结论。
      </p>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {COVERAGE_TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition-colors ${
              tab === id
                ? 'border-brand-600 font-semibold text-brand-600'
                : 'border-transparent text-ink-2 hover:text-ink'
            }`}
            onClick={() => {
              setExpanded(null);
              update({ framework: id });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <Card>
        <CardContent className="space-y-4 p-6">
          <p className="text-[13.5px] text-ink-3">{TAB_HINTS[tab]}</p>
          <div className={isHeatmap ? 'hidden' : 'flex flex-wrap items-center gap-3'}>
            {taskId ? (
              <div className="flex items-center gap-3 text-sm">
                <span>仅统计单个任务{taskName ? `：${taskName}` : ''}</span>
                <button
                  type="button"
                  className="font-medium text-brand-600 hover:underline"
                  onClick={() => update({ taskId: '' })}
                >
                  查看全部任务
                </button>
                <Link
                  className="font-medium text-brand-600 hover:underline"
                  to={`/eval-tasks/${taskId}`}
                >
                  返回任务详情
                </Link>
              </div>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  评估对象
                  <Select
                    aria-label="评估对象"
                    className="w-56"
                    value={targetId}
                    onChange={(event) => update({ targetId: event.target.value })}
                  >
                    <option value="">全部评估对象</option>
                    {(targets.data?.items ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  时间窗
                  <Select
                    aria-label="时间窗"
                    className="w-36"
                    value={days}
                    onChange={(event) => update({ days: event.target.value })}
                  >
                    {DAY_OPTIONS.map(([value, label]) => (
                      <option key={value || 'all'} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </label>
              </>
            )}
          </div>

          {isHeatmap ? (
            <FrameworkHeatmapPanel />
          ) : query.isLoading || query.isError ? (
            <QueryState
              isLoading={query.isLoading}
              isError={query.isError}
              error={query.error}
              onRetry={() => query.refetch()}
              empty={false}
              emptyTitle="暂无覆盖数据"
              emptyDescription="当前没有可展示的框架覆盖数据。"
            />
          ) : (
            <>
              <p className="text-sm leading-6 text-ink-2" data-testid="coverage-summary">
                本页共 {rows.length} 条：已测·发现风险 {tabCounts.TESTED_FINDINGS}，已测·未发现风险{' '}
                {tabCounts.TESTED_CLEAN}，未测试 {tabCounts.NOT_TESTED}，平台暂不覆盖{' '}
                {tabCounts.NOT_SUPPORTED}。 所选范围内共 {query.data?.summary.totalTested ?? 0}{' '}
                道已判定题目，其中 {query.data?.summary.unmappedTested ?? 0}{' '}
                道未映射到任何框架条目。
              </p>
              <Table>
                <THead>
                  <TR>
                    <TH>编号</TH>
                    <TH>条目</TH>
                    <TH className="text-right">已测题数</TH>
                    <TH className="text-right">通过</TH>
                    <TH className="text-right">风险</TH>
                    <TH className="text-right">无法判定</TH>
                    <TH>状态</TH>
                    <TH>样本</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => {
                    const key = `${row.framework}:${row.entryId}`;
                    const open = expanded === key;
                    return (
                      <Fragment key={key}>
                        <TR
                          className="cursor-pointer"
                          data-testid={`row-${row.entryId}`}
                          onClick={() => setExpanded(open ? null : key)}
                          aria-expanded={open}
                        >
                          <TD className="font-mono text-[13px]">{row.entryId}</TD>
                          <TD>{entryTitle(row)}</TD>
                          <TD className="text-right">{row.tested}</TD>
                          <TD className="text-right">{row.passed}</TD>
                          <TD className="text-right">{row.failed}</TD>
                          <TD className="text-right">{row.undetermined}</TD>
                          <TD>
                            <CoverageStatusBadge status={row.status} />
                          </TD>
                          <TD className="whitespace-nowrap text-ink-3">
                            {row.status === 'NOT_SUPPORTED' || row.tested === 0
                              ? '—'
                              : row.sampleAdequate
                                ? '样本充足'
                                : '样本偏少（不足 10 题）'}
                          </TD>
                        </TR>
                        {open && (
                          <tr data-testid={`detail-${row.entryId}`}>
                            <td colSpan={8} className="bg-canvas px-5 py-4 text-sm">
                              {row.note && <p className="mb-2 text-ink-2">{row.note}</p>}
                              <p className="mb-1 font-semibold text-ink">关联的风险类别</p>
                              {row.riskDomains.length ? (
                                <ul className="mb-3 list-disc pl-5">
                                  {row.riskDomains.map((d) => (
                                    <li key={d.domain}>
                                      {d.label}：{d.tested} 题
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="mb-3 text-ink-3">
                                  本范围内没有已判定题目落入该条目。
                                </p>
                              )}
                              <p className="mb-1 font-semibold text-ink">最近的相关任务</p>
                              {row.recentTasks.length ? (
                                <ul className="list-disc pl-5">
                                  {row.recentTasks.map((t) => (
                                    <li key={t.id}>
                                      <Link
                                        className="text-brand-600 hover:underline"
                                        to={`/eval-tasks/${t.id}`}
                                      >
                                        {t.name}
                                      </Link>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-ink-3">暂无。</p>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </TBody>
              </Table>
            </>
          )}
          <p className="text-[13px] text-ink-3">
            按平台风险域参考映射统计，非认证结论；一道题可映射多个条目，在各条目下分别计数。
            {query.data?.disclaimer}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** 旧路由 /risk/framework-map 的兼容重定向：并入「框架覆盖」的热力图页签，保留旧书签里的 framework 参数。 */
export function FrameworkMapRedirect() {
  const [searchParams] = useSearchParams();
  const next = new URLSearchParams({ framework: 'HEATMAP' });
  const legacy = searchParams.get('framework');
  if (legacy) next.set('hmFramework', legacy);
  return <Navigate to={`/reports/framework-coverage?${next.toString()}`} replace />;
}
