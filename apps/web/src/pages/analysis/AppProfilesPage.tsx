import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatNumber } from '@/lib/format';
import { TenantFilterSelect, useTenantView } from '@/lib/tenant-view';
import { appProfilesApi } from '@/lib/detect-risks';
import { useKeyedPage } from '@/lib/use-keyed-page';

const PAGE_SIZE = 20;
const DASH = '—';
const SEARCH_DEBOUNCE_MS = 300;

/** 输入停下来一会儿才生效（搜索框每敲一个字不发一次请求）。 */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** 应用画像（2.5.6）：台账里的应用平台，带风险数，点进去看画像。 */
export function AppProfilesPage() {
  const { isAllTenants, listParams, tenantName } = useTenantView();
  const [input, setInput] = useState('');
  const q = useDebounced(input.trim(), SEARCH_DEBOUNCE_MS);
  // 页码跟着租户筛选和搜索词走：换了直接按第 1 页算。
  const [page, setPage] = useKeyedPage(`${listParams.tenantId ?? ''}|${q}`);
  const list = useQuery({
    queryKey: ['app-profiles', q, page, listParams],
    queryFn: () =>
      appProfilesApi.list({ q: q || undefined, page, pageSize: PAGE_SIZE, ...listParams }),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];

  return (
    <div>
      <PageHeader title="应用画像" />
      <FilterBar>
        <TenantFilterSelect />
        <Input
          aria-label="搜索应用平台"
          placeholder="名称或编号"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="h-8 w-56"
        />
      </FilterBar>
      <Card className="p-4">
        {list.isLoading || list.isError || items.length === 0 ? (
          <QueryState
            isLoading={list.isLoading}
            isError={list.isError}
            error={list.error}
            onRetry={() => void list.refetch()}
            empty={items.length === 0}
            filtered={Boolean(q)}
            emptyTitle="暂无应用平台"
            emptyDescription=""
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>应用平台</TH>
                  <TH>编号</TH>
                  <TH>组织</TH>
                  <TH>责任人</TH>
                  {isAllTenants && <TH>租户</TH>}
                  <TH>关联资产</TH>
                  <TH>风险</TH>
                  <TH>高危</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((p) => (
                  <TR key={p.id} className="h-12">
                    <TD data-label="应用平台">
                      <Link
                        to={`/analysis/profiles/${encodeURIComponent(p.id)}`}
                        className="text-brand-600 hover:underline"
                      >
                        {p.name}
                      </Link>
                    </TD>
                    <TD data-label="编号">{p.code ?? DASH}</TD>
                    <TD data-label="组织">{p.organizationPath ?? DASH}</TD>
                    <TD data-label="责任人">{p.ownerName ?? DASH}</TD>
                    {isAllTenants && <TD data-label="租户">{tenantName(p.tenantId)}</TD>}
                    <TD data-label="关联资产">
                      {p.truncated ? `${formatNumber(p.assetCount)}+` : formatNumber(p.assetCount)}
                    </TD>
                    <TD data-label="风险">
                      {p.riskTotal === null ? DASH : formatNumber(p.riskTotal)}
                    </TD>
                    <TD data-label="高危" className={p.riskHigh ? 'text-severity-high' : undefined}>
                      {p.riskHigh === null ? DASH : formatNumber(p.riskHigh)}
                    </TD>
                  </TR>
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
