import { useEffect, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { X } from 'lucide-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  DETECT_CATEGORIES,
  DETECT_CATEGORY_LABELS,
  DETECT_RECORD_KIND_LABELS,
  isDetectCategory,
  type DetectCategory,
} from '@lse/shared';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { SegmentTabs } from '@/components/page-kit/SegmentTabs';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { SeverityBadge } from '@/components/ui/severity-badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime, formatNumber } from '@/lib/format';
import { TenantFilterSelect, useTenantView } from '@/lib/tenant-view';
import {
  DISCOVERY_TRUNCATED_HINT,
  RISK_SEVERITY_FILTERS,
  RISK_SEVERITY_LABELS,
  bjtDate,
  bjtDayEnd,
  bjtDayStart,
  bjtUntilDate,
  corpusTruncatedHint,
  detectResultsApi,
  type DetectResultRow,
  type DetectRiskStatsView,
} from '@/lib/detect-risks';
import { useKeyedPage } from '@/lib/use-keyed-page';

const PAGE_SIZE = 20;

/** 地址里的时间（首页下钻带来的 ISO 时间）；认不出的忽略。 */
const validTime = (value: string | null): string | undefined =>
  value && !Number.isNaN(Date.parse(value)) ? value : undefined;

/** 该类有没有能看的来源（没有时页签不带数）。 */
function visibleTotal(stats: DetectRiskStatsView | undefined, category: DetectCategory) {
  const stat = stats?.categories.find((c) => c.category === category);
  return stat && stat.sources.some((s) => s.count) ? stat.total : null;
}

/** 检测结果（2.5.3）：模型、数据、内容、应用与环境四个视角查看各来源的有效风险。 */
export function DetectResultsPage() {
  const [params, setParams] = useSearchParams();
  const { isAllTenants, listParams, tenantName, guardRow } = useTenantView();
  const since = validTime(params.get('since'));
  const until = validTime(params.get('until'));
  const severity = params.get('severity') ?? '';
  const source = params.get('source') ?? undefined;
  // 带 profile 时按该应用平台的画像范围看，租户就是平台所属租户，不再用租户筛选。
  const profile = params.get('profile') ?? undefined;
  const tenantParams = profile ? {} : listParams;
  // 换租户（全部租户视角的租户筛选）直接按第 1 页算。
  const [page, setPage] = useKeyedPage(tenantParams.tenantId ?? '');

  // 切来源、筛选时保留上一份数据，加载完再换，版面不跳。
  const stats = useQuery({
    queryKey: ['detect-results', 'stats', since, until, profile, tenantParams],
    queryFn: () => detectResultsApi.stats({ since, until, profile, ...tenantParams }),
    placeholderData: keepPreviousData,
  });
  const categoryParam = params.get('category');
  // 地址没带类别时，等统计回来取第一个能看的类别。
  const category: DetectCategory | undefined = isDetectCategory(categoryParam)
    ? categoryParam
    : stats.data
      ? (DETECT_CATEGORIES.find((c) => visibleTotal(stats.data, c) !== null) ?? 'content')
      : stats.isError
        ? 'content'
        : undefined;

  const list = useQuery({
    queryKey: [
      'detect-results',
      'list',
      category,
      source,
      severity,
      since,
      until,
      profile,
      page,
      tenantParams,
    ],
    queryFn: () =>
      detectResultsApi.list({
        category: category!,
        source,
        severity: severity || undefined,
        since,
        until,
        profile,
        page,
        pageSize: PAGE_SIZE,
        ...tenantParams,
      }),
    enabled: Boolean(category),
    // 只在同一类别里保留上一份数据；切类别时不留上一类的行和来源分段，免得带着新类别点到旧来源。
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === category ? previous : undefined,
  });
  // 当前页已经没有数据（数据变少或删掉了）时回第 1 页，不留一个没有分页条的空页。
  const emptyPage =
    page > 1 && !list.isPlaceholderData && list.data !== undefined && list.data.items.length === 0;
  useEffect(() => {
    if (emptyPage) setPage(1);
  }, [emptyPage]);

  function update(change: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(params);
    if (category) next.set('category', category);
    change(next);
    setParams(next, { replace: true });
    setPage(1);
  }
  const setParam = (key: string, value: string | undefined) =>
    update((next) => (value ? next.set(key, value) : next.delete(key)));

  const items = list.data?.items ?? [];
  const hint =
    category === 'data' && (stats.data?.truncatedCorpusScans ?? 0) > 0
      ? corpusTruncatedHint(stats.data!.truncatedCorpusScans)
      : category === 'app_env' && stats.data?.discoveryRunsTruncated
        ? DISCOVERY_TRUNCATED_HINT
        : null;

  return (
    <div>
      <PageHeader title="检测结果" />
      <SegmentTabs<DetectCategory>
        ariaLabel="检测类别"
        className="mb-4"
        value={category ?? 'content'}
        onChange={(value) =>
          update((next) => {
            next.set('category', value);
            next.delete('source');
          })
        }
        items={DETECT_CATEGORIES.map((c) => {
          const total = visibleTotal(stats.data, c);
          return {
            value: c,
            label:
              total === null
                ? DETECT_CATEGORY_LABELS[c]
                : `${DETECT_CATEGORY_LABELS[c]} ${formatNumber(total)}`,
          };
        })}
      />
      <FilterBar>
        {!profile && <TenantFilterSelect />}
        {profile && (
          <span className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white pl-3 pr-1 text-[13px] text-ink-2">
            {`应用画像：${list.data?.profile?.name ?? stats.data?.profile?.name ?? '…'}`}
            <button
              type="button"
              aria-label="清除应用画像"
              onClick={() => setParam('profile', undefined)}
              className="grid h-6 w-6 place-items-center rounded-md text-ink-3 hover:bg-canvas hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        )}
        {list.data && (
          <SegmentTabs
            size="field"
            ariaLabel="来源"
            value={list.data.source}
            onChange={(value) => setParam('source', value)}
            items={list.data.sources.map((s) => ({
              value: s.source,
              label: `${s.label} ${formatNumber(s.total)}`,
            }))}
          />
        )}
        {/* 严重度和日期是一组：一行放不下时整组换到下一行，日期框不单独掉下去 */}
        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            aria-label="严重度"
            value={severity}
            onChange={(e) => setParam('severity', e.target.value)}
            className="w-32"
          >
            {RISK_SEVERITY_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-3">
            <Input
              type="date"
              aria-label="开始日期"
              value={since ? bjtDate(since) : ''}
              onChange={(e) =>
                setParam('since', e.target.value ? bjtDayStart(e.target.value) : undefined)
              }
              className="w-36"
            />
            ～
            <Input
              type="date"
              aria-label="结束日期"
              value={until ? bjtUntilDate(until) : ''}
              onChange={(e) =>
                setParam('until', e.target.value ? bjtDayEnd(e.target.value) : undefined)
              }
              className="w-36"
            />
            {(since || until) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  update((next) => {
                    next.delete('since');
                    next.delete('until');
                  })
                }
              >
                清除日期
              </Button>
            )}
          </span>
        </div>
      </FilterBar>
      {hint && <p className="mb-3 text-[13px] text-severity-high">{hint}</p>}
      <Card className="p-4">
        {list.isLoading || list.isError || items.length === 0 || !category ? (
          <QueryState
            isLoading={list.isLoading || !category}
            isError={list.isError}
            error={list.error}
            onRetry={() => void list.refetch()}
            empty={items.length === 0}
            filtered={Boolean(severity || since || until)}
            emptyTitle="暂无风险"
            emptyDescription=""
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>风险</TH>
                  <TH>严重度</TH>
                  <TH>对象</TH>
                  <TH>来源记录</TH>
                  {isAllTenants && <TH>租户</TH>}
                  <TH>时间</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((r) => (
                  <ResultRow
                    key={`${r.source}:${r.id}`}
                    row={r}
                    tenant={isAllTenants ? tenantName(r.tenantId) : null}
                    onOpen={(ev) => {
                      if (guardRow(r.tenantId, r.href)) ev.preventDefault();
                    }}
                  />
                ))}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={list.data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </Card>
    </div>
  );
}

/** 一行有效风险（检测结果页、画像页的主要风险表共用）。 */
export function ResultRow({
  row,
  tenant,
  onOpen,
}: {
  row: DetectResultRow;
  tenant: string | null;
  onOpen: (ev: MouseEvent) => void;
}) {
  return (
    <TR className="h-12">
      <TD data-label="风险" className="max-w-[28rem]">
        <span className="line-clamp-2 text-ink">{row.title}</span>
      </TD>
      <TD data-label="严重度">
        {row.severity === 'UNRATED' ? (
          <Badge tone="neutral">{RISK_SEVERITY_LABELS.UNRATED}</Badge>
        ) : (
          <SeverityBadge value={row.severity} />
        )}
      </TD>
      <TD data-label="对象" className="max-w-[20rem] truncate" title={row.subject ?? undefined}>
        {row.subject ?? '—'}
      </TD>
      <TD data-label="来源记录" className="max-w-[18rem] truncate">
        <Link to={row.href} onClick={onOpen} className="text-brand-600 hover:underline">
          {row.recordName ?? DETECT_RECORD_KIND_LABELS[row.recordKind]}
        </Link>
      </TD>
      {tenant !== null && <TD data-label="租户">{tenant}</TD>}
      <TD data-label="时间" className="whitespace-nowrap">
        {formatDateTime(row.createdAt)}
      </TD>
    </TR>
  );
}
