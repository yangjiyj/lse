import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { LEDGER_ASSET_TYPES, LEDGER_ASSET_TYPE_LABELS, type LedgerAssetType } from '@lse/shared';
import { useAuth } from '@/lib/auth';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { flattenOrgTree, organizationApi } from '@/lib/organizations';
import { LEDGER_QUERY_KEY, ledgerApi, ledgerKeyAttrs, type ImportResult } from '@/lib/ledger';
import { PageHeader } from '@/components/PageHeader';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { LedgerAssetModal } from './LedgerAssetModal';

const PAGE_SIZE = 20;
const DASH = '—';

/** 应用台账：左边按类型筛选（带数），右边资产表格。 */
export function LedgerPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('ledger:manage');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [type, setType] = useState<LedgerAssetType | ''>('');
  const [keyword, setKeyword] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebouncedValue(keyword.trim());
  const [creating, setCreating] = useState(false);

  const query = {
    type: type || undefined,
    q: term || undefined,
    organizationId: organizationId || undefined,
    includeDescendants: organizationId ? true : undefined,
    page,
    pageSize: PAGE_SIZE,
  };
  const list = useQuery({
    queryKey: [LEDGER_QUERY_KEY, 'list', query],
    queryFn: () => ledgerApi.list(query),
  });
  const orgs = useQuery({
    queryKey: [LEDGER_QUERY_KEY, 'org-options'],
    queryFn: () => organizationApi.tree(),
    enabled: hasPermission('org:read'),
  });
  const orgOptions = flattenOrgTree(orgs.data?.items ?? []);
  const counts = list.data?.counts;
  const total = counts ? LEDGER_ASSET_TYPES.reduce((sum, t) => sum + counts[t], 0) : undefined;
  const items = list.data?.items ?? [];
  // 当前页所有行都没填组织时不显示组织列
  const showOrg = items.some((a) => a.organizationPath);
  // 1366 宽下一行一条：多出组织列时其余可截断的列收窄一点
  const w = showOrg
    ? { name: 'max-w-[9rem]', attrs: 'max-w-[8rem]', org: 'max-w-[6rem]', owner: 'max-w-[6rem]' }
    : { name: 'max-w-[11rem]', attrs: 'max-w-[10rem]', org: '', owner: 'max-w-[7rem]' };
  const headers = [
    '名称',
    '类型',
    '编号',
    '关键属性',
    ...(showOrg ? ['组织'] : []),
    '责任人',
    '关系',
    '更新时间',
  ];

  const refresh = () => queryClient.invalidateQueries({ queryKey: [LEDGER_QUERY_KEY] });
  const imported = (r: ImportResult) => {
    success(r.created ? `已导入 ${r.created} 项` : '没有新的可导入项');
    void refresh();
  };
  const importEndpoints = useMutation({
    mutationFn: () => ledgerApi.importEndpoints(),
    onSuccess: imported,
    onError: (e: Error) => toastError(e.message),
  });
  const importTargets = useMutation({
    mutationFn: () => ledgerApi.importTargets(),
    onSuccess: imported,
    onError: (e: Error) => toastError(e.message),
  });

  const pick = (next: LedgerAssetType | '') => {
    setType(next);
    setPage(1);
  };
  const typeItems: Array<{ value: LedgerAssetType | ''; label: string; count?: number }> = [
    { value: '', label: '全部', count: total },
    ...LEDGER_ASSET_TYPES.map((t) => ({
      value: t,
      label: LEDGER_ASSET_TYPE_LABELS[t],
      count: counts?.[t],
    })),
  ];

  return (
    <div>
      <PageHeader
        title="应用台账"
        actions={
          canManage ? (
            <>
              <Button
                variant="outline"
                disabled={importEndpoints.isPending}
                onClick={() => {
                  if (window.confirm('为本租户还没登记的终端建台账资产？'))
                    importEndpoints.mutate();
                }}
              >
                导入终端
              </Button>
              <Button
                variant="outline"
                disabled={importTargets.isPending}
                onClick={() => {
                  if (window.confirm('为本租户还没登记的评估对象建台账资产？'))
                    importTargets.mutate();
                }}
              >
                导入评估对象
              </Button>
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                新建资产
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4 lg:flex-row">
        <nav aria-label="资产类型" className="flex shrink-0 flex-wrap gap-1 lg:w-36 lg:flex-col">
          {typeItems.map((item) => {
            const active = item.value === type;
            return (
              <button
                key={item.value || 'all'}
                type="button"
                aria-pressed={active}
                onClick={() => pick(item.value)}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-left text-[13.5px] transition-colors',
                  active
                    ? 'bg-brand-50 font-semibold text-brand-700'
                    : 'text-ink-2 hover:bg-slate-100 hover:text-ink',
                )}
              >
                <span>{item.label}</span>
                <span className="font-num text-xs text-ink-3">{item.count ?? ''}</span>
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1">
          <FilterBar>
            <Input
              aria-label="搜索资产"
              placeholder="名称、编号或 IP"
              className="w-60"
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                setPage(1);
              }}
            />
            {orgOptions.length > 0 && (
              <Select
                aria-label="组织"
                className="w-56"
                value={organizationId}
                onChange={(e) => {
                  setOrganizationId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">全部组织</option>
                {orgOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.path}
                  </option>
                ))}
              </Select>
            )}
          </FilterBar>
          {list.isLoading ? (
            <LoadingBlock />
          ) : list.isError ? (
            <p className="p-4 text-sm text-severity-critical">{(list.error as Error).message}</p>
          ) : items.length === 0 ? (
            <EmptyState title="暂无资产" />
          ) : (
            <>
              <Table aria-label="资产">
                <THead>
                  <TR>
                    {headers.map((h) => (
                      <TH key={h}>{h}</TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {items.map((a) => {
                    const attrs = ledgerKeyAttrs(a);
                    const owner = [a.ownerName, a.ownerDepartment].filter(Boolean).join(' · ');
                    return (
                      <TR key={a.id}>
                        <TD data-label="名称">
                          <Link
                            to={`/ledger/${a.id}`}
                            title={a.name}
                            className={cn(
                              'block truncate whitespace-nowrap font-medium text-brand-700 hover:underline',
                              w.name,
                            )}
                          >
                            {a.name}
                          </Link>
                        </TD>
                        <TD data-label="类型" className="whitespace-nowrap">
                          {LEDGER_ASSET_TYPE_LABELS[a.type]}
                        </TD>
                        <TD data-label="编号" className="whitespace-nowrap">
                          {a.code || DASH}
                        </TD>
                        <TD data-label="关键属性">
                          <span
                            className={cn('block truncate whitespace-nowrap', w.attrs)}
                            title={attrs}
                          >
                            {attrs || DASH}
                          </span>
                        </TD>
                        {showOrg && (
                          <TD data-label="组织">
                            <span
                              className={cn('block truncate whitespace-nowrap', w.org)}
                              title={a.organizationPath ?? undefined}
                            >
                              {a.organizationPath || DASH}
                            </span>
                          </TD>
                        )}
                        <TD data-label="责任人">
                          <span
                            className={cn('block truncate whitespace-nowrap', w.owner)}
                            title={owner}
                          >
                            {owner || DASH}
                          </span>
                        </TD>
                        <TD data-label="关系" className="whitespace-nowrap font-num">
                          {a.relationCount}
                        </TD>
                        <TD data-label="更新时间" className="whitespace-nowrap">
                          {formatDateTime(a.updatedAt)}
                        </TD>
                      </TR>
                    );
                  })}
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
        </div>
      </div>
      {creating && (
        <LedgerAssetModal
          defaultType={type || 'platform'}
          onClose={() => setCreating(false)}
          onSaved={(asset) => {
            setCreating(false);
            void refresh();
            navigate(`/ledger/${asset.id}`);
          }}
        />
      )}
    </div>
  );
}
