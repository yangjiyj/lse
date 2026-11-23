import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type StandardCapability,
  type StandardCoverageClause,
  type StandardLine,
} from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { QueryState } from '@/components/QueryState';

export const STANDARD_LINE_TABS: ReadonlyArray<readonly [StandardLine, string]> = [
  ['content', '内容安全'],
  ['agent', '智能体'],
  ['endpoint', '终端'],
];

const DAY_OPTIONS = [
  ['30', '近 30 天'],
  ['90', '近 90 天'],
  ['', '全部时间'],
] as const;

const DASHED = 'border border-dashed border-slate-400 bg-white text-ink-3 ring-0';

const CAPABILITY_VIEW: Record<
  StandardCapability,
  { tone: 'success' | 'warning' | 'neutral'; dashed: boolean }
> = {
  covered: { tone: 'success', dashed: false },
  partial: { tone: 'warning', dashed: false },
  not_covered: { tone: 'neutral', dashed: true },
  not_applicable: { tone: 'neutral', dashed: true },
};

export function CapabilityBadge({ clause }: { clause: StandardCoverageClause }) {
  const view = CAPABILITY_VIEW[clause.capability];
  return (
    <Badge
      tone={view.tone}
      icon={!view.dashed}
      className={view.dashed ? DASHED : undefined}
      data-capability={clause.capability}
    >
      {clause.capabilityLabel}
    </Badge>
  );
}

/** 本范围结论：未测、暂不覆盖、不适用用虚线空心标签，和「未发现风险」「符合」的实心绿色明显区分。 */
export function ClauseVerdictBadge({ clause }: { clause: StandardCoverageClause }) {
  if (clause.verdict === 'not_tested') {
    const uncovered = clause.capability === 'not_covered';
    return (
      <Badge tone="neutral" className={DASHED} data-state={uncovered ? 'not_covered' : 'not_tested'}>
        {uncovered ? '暂不覆盖' : '未测'}
      </Badge>
    );
  }
  if (clause.verdict === 'not_applicable') {
    return (
      <Badge tone="neutral" className={DASHED} data-state="not_applicable">
        {clause.verdictLabel}
      </Badge>
    );
  }
  const tone =
    clause.verdict === 'nonconform' ? 'critical' : clause.verdict === 'insufficient' ? 'warning' : 'success';
  return (
    <Badge tone={tone} icon data-state={clause.verdict}>
      {clause.verdictLabel}
    </Badge>
  );
}

function isUntested(clause: StandardCoverageClause): boolean {
  return clause.verdict === 'not_tested' || clause.verdict === 'not_applicable';
}

export function StandardClausesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(null);
  const lineParam = searchParams.get('line');
  const line: StandardLine = STANDARD_LINE_TABS.some(([id]) => id === lineParam)
    ? (lineParam as StandardLine)
    : 'content';
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
    queryKey: ['standards-targets'],
    queryFn: () => api.modelTargets.list({ pageSize: 100 }),
  });
  const catalog = useQuery({ queryKey: ['standards-catalog'], queryFn: () => api.standards.catalog() });
  const coverage = useQuery({
    queryKey: ['standards-coverage', line, taskId, targetId, days],
    queryFn: () =>
      api.standards.coverage({
        line,
        taskId: taskId || undefined,
        targetId: targetId || undefined,
        days: days ? Number(days) : undefined,
      }),
  });

  const catalogLine = catalog.data?.lines.find((l) => l.line === line);
  const result = coverage.data?.lines.find((l) => l.line === line);
  const byVerdict = result?.summary.byVerdict ?? {};

  return (
    <div className="space-y-5">
      <PageHeader title="国内标准条款" />
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {STANDARD_LINE_TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={line === id}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition-colors ${
              line === id
                ? 'border-brand-600 font-semibold text-brand-600'
                : 'border-transparent text-ink-2 hover:text-ink'
            }`}
            onClick={() => {
              setExpanded(null);
              update({ line: id });
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-4 p-6">
          {catalogLine && (
            <div className="space-y-2" data-testid="basis-block">
              <p className="rounded-card border border-brand-100 bg-brand-50/70 px-5 py-3 text-[13.5px] leading-6 text-ink-2">
                {catalogLine.basisStatement}
              </p>
              <div className="flex gap-3 text-[13px] text-ink-3">
                <span className="shrink-0 font-medium text-ink-2">依据</span>
                <ul className="space-y-0.5">
                  {catalogLine.bases.map((b) => (
                    <li key={b.id}>
                      {b.code ? `${b.code} ` : ''}《{b.title}》{b.statusNote ? `（${b.statusNote}）` : ''}
                    </li>
                  ))}
                  {catalogLine.references.length > 0 && (
                    <li>国际框架（参考）：{catalogLine.references.join('、')}</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {taskId ? (
              <div className="flex items-center gap-3 text-sm">
                <span>仅统计单个任务</span>
                <button
                  type="button"
                  className="font-medium text-brand-600 hover:underline"
                  onClick={() => update({ taskId: '' })}
                >
                  查看全部任务
                </button>
                <Link className="font-medium text-brand-600 hover:underline" to={`/eval-tasks/${taskId}`}>
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

          {coverage.isLoading || coverage.isError || catalog.isError ? (
            <QueryState
              isLoading={coverage.isLoading}
              isError={coverage.isError || catalog.isError}
              error={coverage.error ?? catalog.error}
              onRetry={() => {
                void coverage.refetch();
                void catalog.refetch();
              }}
              empty={false}
              emptyTitle="暂无条款数据"
              emptyDescription="当前没有可展示的条款。"
            />
          ) : (
            result && (
              <>
                <p className="text-sm leading-6 text-ink-2" data-testid="standard-summary">
                  共 {result.summary.clauses} 条：发现风险或不符合 {byVerdict.nonconform ?? 0}，
                  未发现风险或符合 {byVerdict.conform ?? 0}，样本不足 {byVerdict.insufficient ?? 0}，
                  未测或暂不覆盖 {(byVerdict.not_tested ?? 0) + (byVerdict.not_applicable ?? 0)}。
                  所选范围内有效判定 {result.validCount} 项。
                </p>
                <Table>
                  <THead>
                    <TR>
                      <TH>条款</TH>
                      <TH>内容</TH>
                      <TH>平台能力</TH>
                      <TH>本范围结论</TH>
                      <TH className="text-right">有效判定数</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {result.clauses.map((clause) => {
                      const open = expanded === clause.id;
                      const muted = isUntested(clause);
                      return (
                        <Fragment key={clause.id}>
                          <TR
                            className="cursor-pointer"
                            data-testid={`clause-${clause.id}`}
                            aria-expanded={open}
                            onClick={() => setExpanded(open ? null : clause.id)}
                          >
                            <TD className={muted ? 'text-ink-3' : undefined}>
                              <span className="block font-medium">{clause.title}</span>
                              <span className="block text-xs text-ink-3">
                                {clause.basisName} {clause.ref}
                              </span>
                            </TD>
                            <TD className={`max-w-md text-[13px] ${muted ? 'text-ink-3' : 'text-ink-2'}`}>
                              {clause.requirement}
                            </TD>
                            <TD>
                              <CapabilityBadge clause={clause} />
                            </TD>
                            <TD>
                              <ClauseVerdictBadge clause={clause} />
                            </TD>
                            <TD className="text-right tabular-nums">
                              {clause.hasThreshold ? '—' : clause.tested}
                              {clause.failed > 0 && (
                                <span className="ml-1 text-xs text-severity-critical">
                                  （{clause.failed} 项不合格）
                                </span>
                              )}
                            </TD>
                          </TR>
                          {open && (
                            <tr data-testid={`detail-${clause.id}`}>
                              <td colSpan={5} className="space-y-1 bg-canvas px-5 py-4 text-sm text-ink-2">
                                <p>{clause.note}</p>
                                {clause.capabilityNote && <p>平台能力说明：{clause.capabilityNote}</p>}
                                {clause.applicability && <p>适用前提：{clause.applicability}</p>}
                                <p>测法：{clause.automationLabel}</p>
                                <p className="text-ink-3">出处：{clause.sourceRef}</p>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </TBody>
                </Table>
              </>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
