import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, RefreshCw, Search, Building2 } from 'lucide-react';
import { api, type FleetEndpoint, type FleetJob } from '@/lib/api';
import { osLabel, productLabel } from '@/lib/endpoint-agents';
import { shortProbeVersion } from '@/lib/fleet';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import { TenantTransferDialog } from '@/components/TenantTransferDialog';
import { CapabilityBadge, JobStatusBadge, OnlineBadge } from '@/components/fleet/FleetBadges';
import { EndpointActions } from '@/components/fleet/EndpointActions';
import { PostureChecksModal } from '@/components/fleet/PostureChecksModal';
import { RevokeEndpointDialog } from '@/components/fleet/RevokeEndpointDialog';
import { SafetyStateBadge } from '@/components/fleet/safety/EndpointSafety';
import { ownerText } from '@/components/fleet/OwnerDialog';
import { TenantCell, TenantFilterSelect, useTenantView } from '@/lib/tenant-view';

const PAGE_SIZE = 20;

export function EndpointsTab({
  canManage,
  onGoEnroll,
}: {
  canManage: boolean;
  onGoEnroll: () => void;
}) {
  const [page, setPage] = useState(1);
  const [input, setInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [showRevoked, setShowRevoked] = useState(false);
  const navigate = useNavigate();
  const [requestFor, setRequestFor] = useState<FleetEndpoint | null>(null);
  const [revokeFor, setRevokeFor] = useState<FleetEndpoint | null>(null);
  const [removeFor, setRemoveFor] = useState<FleetEndpoint | null>(null);
  const [transferFor, setTransferFor] = useState<FleetEndpoint | null>(null);
  const toast = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { isAllTenants, listParams, tenantFilter, guardRow, enterTenant, platformTenantId } =
    useTenantView();
  // 全局视角下「接入终端」：终端必须落在具体租户，直接进本属租户的接入页，不再弹选租户。
  // 要给别的租户接终端，先在顶栏切进那个租户。
  const goEnrollInOwnTenant = () => enterTenant(platformTenantId, '/fleet?tab=enroll');
  const remove = useMutation({
    mutationFn: async (endpoint: FleetEndpoint) => {
      if (endpoint.status !== 'REVOKED') await api.fleet.revokeEndpoint(endpoint.id);
      return api.fleet.removeEndpoint(endpoint.id);
    },
    onSuccess: () => { toast.success('终端已删除'); setRemoveFor(null); void qc.invalidateQueries({ queryKey: ['fleet'] }); },
    onError: () => { toast.error('删除终端失败，请刷新后重试'); void qc.invalidateQueries({ queryKey: ['fleet'] }); },
  });

  const q = useQuery({
    queryKey: ['fleet', 'endpoints', page, keyword, showRevoked, tenantFilter],
    queryFn: () => api.fleet.endpoints({ page, pageSize: PAGE_SIZE, q: keyword || undefined, ...(showRevoked ? {} : { status: 'ACTIVE' }), ...listParams }),
    retry: false,
    placeholderData: (prev) => prev,
  });
  // 后端清单不带「当前任务」，这里汇总未结束的任务（含升级前遗留的待批准旧任务），按终端归并。
  const open = useQuery({
    queryKey: ['fleet', 'jobs', 'open', tenantFilter],
    queryFn: async () => {
      const [pending, active] = await Promise.all([
        api.fleet.evalJobs({ view: 'pending', page: 1, pageSize: 100, ...listParams }),
        api.fleet.evalJobs({ view: 'active', page: 1, pageSize: 100, ...listParams }),
      ]);
      return [...pending.items, ...active.items];
    },
    retry: false,
  });
  const activeByEndpoint = new Map<string, FleetJob>();
  for (const j of open.data ?? [])
    if (!activeByEndpoint.has(j.endpointId)) activeByEndpoint.set(j.endpointId, j);

  const items = (q.data?.items ?? []).filter((item) => showRevoked || item.status !== 'REVOKED');
  const searching = keyword !== '';

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setKeyword(input.trim());
        }}
      >
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <Input
            aria-label="搜索终端"
            className="pl-9"
            placeholder="按主机名、用户搜索"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline">
          搜索
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? 'animate-spin' : ''}`} />
          刷新
        </Button>
        <TenantFilterSelect />
        {canManage && <Button type="button"
          onClick={isAllTenants ? goEnrollInOwnTenant : onGoEnroll}>接入终端</Button>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showRevoked}
          onChange={(event) => { setShowRevoked(event.target.checked); setPage(1); }} />显示已吊销终端</label>
      </form>

      <section>
      {q.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5" />
        </div>
      ) : q.isError ? (
        <NoteBox tone="warning" role="alert">
          终端清单加载失败，请稍后重试。
          <Button className="ml-2" size="sm" variant="outline" onClick={() => void q.refetch()}>
            重试
          </Button>
        </NoteBox>
      ) : items.length === 0 ? (
        searching ? (
          <EmptyState title="没有符合条件的终端" description="换个关键词试试，或清空搜索。" />
        ) : (
          <EmptyState
            icon={<Laptop className="h-7 w-7" />}
            title="还没有接入任何终端"
            description="在终端上安装探针并用接入码注册后，终端会出现在这里，可做配置检测和真机测评。"
            action={canManage ? <Button onClick={isAllTenants ? goEnrollInOwnTenant : onGoEnroll}>接入第一台终端</Button> : undefined}
          />
        )
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                {isAllTenants && <TH>租户</TH>}
                <TH>主机名</TH>
                <TH>系统</TH>
                <TH>责任人</TH>
                <TH>智能体</TH>
                <TH>探针版本</TH>
                <TH>状态</TH>
                <TH>真机测评</TH>
                <TH>最近检测</TH>
                <TH>当前任务</TH>
                <TH>操作</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((e) => (
                <TR key={e.id}>
                  {isAllTenants && <TD data-label="租户"><TenantCell tenantId={e.tenantId} /></TD>}
                  <TD data-label="主机名" className="whitespace-nowrap font-medium">
                    {e.hostname}
                  </TD>
                  <TD data-label="系统">
                    <div>{osLabel(e.os)}</div>
                    <div className="text-xs text-ink-3">{e.osVersion}</div>
                  </TD>
                  <TD data-label="责任人" className="whitespace-nowrap">
                    <div>{e.owner ? ownerText(e.owner) : <span className="text-ink-3">未设置</span>}</div>
                    {e.osUser && <div className="text-xs text-ink-3">登录账号 {e.osUser}</div>}
                  </TD>
                  <TD data-label="智能体" className="max-w-[22rem]">{e.agents.length ? `${new Set(e.agents.map((agent) => agent.product)).size} · ${[...new Map(e.agents.map((agent) => [agent.product, agent.displayName || productLabel(agent.product)])).values()].join('、')}` : '未上报'}</TD>
                  <TD data-label="探针版本">
                    <span title={e.agentVersion || undefined}>
                      {shortProbeVersion(e.agentVersion)}
                    </span>
                  </TD>
                  <TD data-label="状态">
                    <OnlineBadge endpoint={e} />
                  </TD>
                  <TD data-label="真机测评">
                    <CapabilityBadge endpoint={e} />
                  </TD>
                  <TD data-label="最近检测">
                    {e.latestReport?.scannedAt ? (
                      <>
                        <div>{formatDateTime(e.latestReport.scannedAt)}</div>
                        <div className="text-xs text-ink-3">{e.latestReport.assetCount} 项资产</div>
                      </>
                    ) : (
                      <div className="space-y-1"><SafetyStateBadge state="not_checked" /><p className="text-xs text-ink-3">未上报</p></div>
                    )}
                  </TD>
                  <TD data-label="当前任务">
                    {activeByEndpoint.get(e.id) ? (
                      <JobStatusBadge status={activeByEndpoint.get(e.id)!.status} />
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </TD>
                  <TD data-label="操作"
                    onClickCapture={isAllTenants ? (ev) => {
                      // 「变更归属」要能在全部租户视角下直接点，不能先被行点击带去别的租户。
                      if ((ev.target as HTMLElement).closest('[data-transfer-action]')) return;
                      ev.preventDefault();
                      ev.stopPropagation();
                      guardRow(e.tenantId, `/fleet/endpoints/${e.id}`);
                    } : undefined}>
                    <div className="flex items-center gap-1">
                    <EndpointActions
                      endpoint={e}
                      activeJob={activeByEndpoint.get(e.id) ?? null}
                      canManage={canManage}
                      onRequestJob={(e, mode = 'all') => {
                        if (mode === 'live') navigate(`/agent-evals/new?endpoint=${encodeURIComponent(e.id)}`);
                        else setRequestFor(e);
                      }}
                      onRevoke={setRevokeFor}
                      onRemove={setRemoveFor}
                      onDetail={e => navigate(`/fleet/endpoints/${e.id}`)}
                    />
                    {user?.isPlatformAdmin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="变更归属租户"
                        data-transfer-action
                        data-testid={`endpoint-transfer-${e.id}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setTransferFor(e);
                        }}
                      >
                        <Building2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={q.data?.total ?? 0}
            onPageChange={setPage}
          />
        </>
      )}

      </section>

      <PostureChecksModal
        endpoint={requestFor}
        onClose={() => setRequestFor(null)}
      />
      <TenantTransferDialog
        open={Boolean(transferFor)}
        kind="fleet-endpoint"
        ids={transferFor ? [transferFor.id] : []}
        onClose={() => setTransferFor(null)}
        onTransferred={(message) => {
          toast.success(message);
          void qc.invalidateQueries({ queryKey: ['fleet'] });
        }}
      />
      <RevokeEndpointDialog endpoint={revokeFor} onClose={() => setRevokeFor(null)} />
      <Modal open={!!removeFor} onClose={() => setRemoveFor(null)} title="删除终端"
        description={`确定从终端清单删除「${removeFor?.hostname ?? ''}」？`}
        footer={<><Button variant="outline" onClick={() => setRemoveFor(null)}>取消</Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => removeFor && remove.mutate(removeFor)}>确认删除</Button></>}>
        <p className="text-sm">{removeFor?.status === 'REVOKED' ? '该终端已吊销。' : '删除会吊销终端令牌并停止接收任务，未结束的任务将被取消或标记失败。'}终端将从清单移除，历史检测和测评记录保留。</p>
      </Modal>
    </div>
  );
}
