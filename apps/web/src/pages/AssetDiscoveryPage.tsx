import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, assetDiscoveryApi, type GatewayModelClue } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isPlatformTenantUser } from '@/lib/tenant';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LoadingBlock } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';
import {
  ScopeCard,
  countHosts,
  isUrlTarget,
  parsePorts,
  splitList,
} from './asset-discovery/ScopeCard';
import { RegisterTargetModal, type RegisterDraft } from './asset-discovery/RegisterTargetModal';
import { Empty, HitsTable, RunsTable } from './asset-discovery/tables';

type Tab = 'scan' | 'gateway';

export function AssetDiscoveryPage() {
  const { hasPermission, user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canRead = hasPermission('engine:scan') || hasPermission('platform_setting:read');
  const canScan = hasPermission('engine:scan');
  const canEditScope = hasPermission('platform_setting:update');
  const canRegister = hasPermission('model_target:create');
  // 网关审计线索来自全平台共用的网关：只在平台租户出现。
  const platformTenant = isPlatformTenantUser(user);
  const canGateway = hasPermission('gateway_log:analyze') && platformTenant;
  const [tab, setTab] = useState<Tab>('scan');
  const [targets, setTargets] = useState('');
  const [ports, setPorts] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [searchParams] = useSearchParams();
  // 从检测任务总览跳来时带 ?run=，直接打开这次测绘。
  const [selectedRun, setSelectedRun] = useState<string | null>(() => searchParams.get('run'));
  const [draft, setDraft] = useState<RegisterDraft | null>(null);

  const scopeQuery = useQuery({
    queryKey: ['asset-discovery', 'scope'],
    queryFn: () => assetDiscoveryApi.scope(),
    enabled: canRead,
  });
  const runsQuery = useQuery({
    queryKey: ['asset-discovery', 'runs'],
    queryFn: () => assetDiscoveryApi.runs(),
    enabled: canRead,
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === 'PENDING' || r.status === 'RUNNING') ? 3000 : false,
  });
  const runs = runsQuery.data ?? [];
  useEffect(() => {
    if (!selectedRun && runs[0]) setSelectedRun(runs[0].id);
  }, [runs, selectedRun]);
  const selected = runs.find((r) => r.id === selectedRun);
  const detailQuery = useQuery({
    queryKey: ['asset-discovery', 'run', selectedRun, selected?.status],
    queryFn: () => assetDiscoveryApi.run(selectedRun!),
    enabled: !!selectedRun,
  });
  const cluesQuery = useQuery({
    queryKey: ['asset-discovery', 'gateway-clues'],
    queryFn: () => assetDiscoveryApi.gatewayClues(),
    enabled: tab === 'gateway' && canGateway,
  });

  const scope = scopeQuery.data;
  const scopeEmpty = !scope || !scope.entries.length || !scope.ports.length;
  const targetList = splitList(targets);
  const urlCount = targetList.filter(isUrlTarget).length;
  const plainTargets = targetList.filter((t) => !isUrlTarget(t));
  const portList = parsePorts(ports);
  const hostCount = countHosts(targetList);
  const runPorts = plainTargets.length ? (portList ?? []) : [];
  const endpointCount = countHosts(plainTargets) * runPorts.length + urlCount;

  useEffect(() => {
    if (scope && !ports) setPorts(scope.ports.join(', '));
  }, [scope, ports]);

  const start = useMutation({
    mutationFn: () =>
      assetDiscoveryApi.startRun({ targets: targetList, ports: runPorts, confirm: true }),
    onSuccess: (run) => {
      toast.success('扫描已发起');
      setConfirmOpen(false);
      setSelectedRun(run.id);
      void qc.invalidateQueries({ queryKey: ['asset-discovery', 'runs'] });
    },
    onError: (e) => {
      setConfirmOpen(false);
      toast.error(e instanceof ApiError ? e.message : '发起扫描失败');
    },
  });

  const openConfirm = () => {
    if (!targetList.length) return toast.error('请填写扫描目标');
    if (plainTargets.length && (!portList || !portList.length)) {
      return toast.error('请填写有效端口');
    }
    setConfirmOpen(true);
  };

  if (!canRead) {
    return (
      <div>
        <PageHeader title="AI 资产测绘" />
        <Card>
          <CardContent className="py-10 text-center text-sm text-ink-3">
            当前账号没有查看 AI 资产测绘的权限。
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI 资产测绘"
        description="在管理员授权范围内只读探测 LLM 推理服务，识别未登记 AI 服务（影子 AI）"
      />
      {canGateway && (
      <div className="flex gap-6 border-b border-line text-sm" role="tablist">
        {(
          [
            ['scan', '主动探测'],
            ['gateway', '网关审计线索'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={
              tab === key
                ? '-mb-px border-b-2 border-brand-600 pb-2 font-medium text-brand-600'
                : 'pb-2 text-ink-3 hover:text-ink'
            }
          >
            {label}
          </button>
        ))}
      </div>
      )}

      {tab === 'scan' ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <ScopeCard scope={scope} canEdit={canEditScope} />
            <SectionCard
              title="发起扫描"
              description="只读探测、不携带凭据、不跟随重定向；并发不超过 8"
              bodyClassName="space-y-4"
            >
              {scopeEmpty ? (
                <p className="text-sm text-ink-3">
                  {canEditScope
                    ? '尚未配置扫描范围，请先在上方填写并保存。'
                    : '尚未配置扫描范围，请联系平台管理员配置。'}
                </p>
              ) : null}
              <Field
                label="扫描目标"
                htmlFor="asset-discovery-targets"
                hint="须落在授权范围内，可填 IP、CIDR、主机名、主机:端口或 URL，逗号分隔"
              >
                <Input
                  id="asset-discovery-targets"
                  value={targets}
                  disabled={!canScan || scopeEmpty}
                  placeholder={scope?.entries[0] ?? ''}
                  onChange={(e) => setTargets(e.target.value)}
                />
              </Field>
              <Field
                label="扫描端口"
                htmlFor="asset-discovery-run-ports"
                hint="须在授权端口内；URL 和主机:端口用其中的端口"
              >
                <Input
                  id="asset-discovery-run-ports"
                  value={ports}
                  disabled={!canScan || scopeEmpty}
                  onChange={(e) => setPorts(e.target.value)}
                />
              </Field>
              <Button
                type="button"
                onClick={openConfirm}
                disabled={!canScan || scopeEmpty || start.isPending}
              >
                发起扫描
              </Button>
              {!canScan ? <p className="text-sm text-ink-3">当前账号没有发起扫描的权限。</p> : null}
            </SectionCard>
          </div>

          <SectionCard title="运行记录" bodyClassName="p-0">
            {runsQuery.isLoading ? (
              <LoadingBlock />
            ) : (
              <RunsTable runs={runs} selectedId={selectedRun} onSelect={setSelectedRun} />
            )}
          </SectionCard>

          <SectionCard
            title="识别结果"
            description={
              selected
                ? `${formatDateTime(selected.createdAt)} 发起 · 已探测 ${selected.probedCount} 个端点`
                : '选择一次运行查看结果'
            }
            bodyClassName="p-0"
          >
            {detailQuery.isLoading ? (
              <LoadingBlock />
            ) : (
              <HitsTable
                hits={detailQuery.data?.hits ?? []}
                canRegister={canRegister}
                onRegister={setDraft}
              />
            )}
          </SectionCard>
        </>
      ) : (
        <GatewayCluesPanel
          canGateway={canGateway}
          loading={cluesQuery.isLoading}
          data={cluesQuery.data}
          error={cluesQuery.error}
        />
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="确认发起主动探测"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? '发起中…' : '确认扫描'}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          {urlCount ? (
            <>
              将主动探测 <span className="tabular-nums font-medium">{endpointCount}</span>{' '}
              个端点。
            </>
          ) : (
            <>
              将主动探测 <span className="tabular-nums font-medium">{hostCount}</span> 台主机 ×{' '}
              <span className="tabular-nums font-medium">{runPorts.length}</span> 个端口（共{' '}
              <span className="tabular-nums font-medium">{endpointCount}</span> 个端点）。
            </>
          )}
          探测请求会出现在目标主机日志中，本次操作将记入操作日志。
        </p>
        <p className="mt-2 break-all text-xs text-ink-3">目标：{targetList.join(', ')}</p>
      </Modal>
      <RegisterTargetModal draft={draft} onClose={() => setDraft(null)} />
    </div>
  );
}

function GatewayCluesPanel({
  canGateway,
  loading,
  data,
  error,
}: {
  canGateway: boolean;
  loading: boolean;
  data: Awaited<ReturnType<typeof assetDiscoveryApi.gatewayClues>> | undefined;
  error: unknown;
}) {
  let body;
  if (!canGateway) body = <Empty>当前账号没有查看网关审计线索的权限。</Empty>;
  else if (loading) body = <LoadingBlock />;
  else if (error) body = <Empty>{error instanceof ApiError ? error.message : '加载失败'}</Empty>;
  else if (!data || data.status !== 'OK')
    body = <Empty>{data?.message ?? '网关未接入，无法获取审计线索'}</Empty>;
  else if (!data.clues.length) body = <Empty>暂无数据</Empty>;
  else body = <CluesTable clues={data.clues} />;
  return (
    <SectionCard
      title="网关审计线索"
      description={
        data?.status === 'OK'
          ? `近 ${data.windowDays} 天 ${data.eventCount} 条审计事件中出现的上游模型${data.truncated ? '（已达拉取上限，仅统计前 2000 条）' : ''}；审计事件不含上游地址，仅按模型名比对`
          : '来自智能体安全网关审计事件中的上游模型'
      }
      bodyClassName="p-0"
    >
      {body}
    </SectionCard>
  );
}

function CluesTable({ clues }: { clues: GatewayModelClue[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>上游模型</TH>
          <TH>上游渠道</TH>
          <TH>接口类型</TH>
          <TH>事件数</TH>
          <TH>最近出现</TH>
          <TH>是否已登记</TH>
        </TR>
      </THead>
      <TBody>
        {clues.map((c) => (
          <TR key={`${c.providerId}-${c.model}`}>
            <TD data-label="上游模型">{c.model}</TD>
            <TD data-label="上游渠道">{c.providerId || '—'}</TD>
            <TD data-label="接口类型">{c.endpointTypes.join('、') || '—'}</TD>
            <TD data-label="事件数" className="tabular-nums">
              {c.eventCount}
            </TD>
            <TD data-label="最近出现" className="whitespace-nowrap tabular-nums">
              {formatDateTime(c.lastSeenAt)}
            </TD>
            <TD data-label="是否已登记">
              {c.registered ? (
                <span>已登记（{c.targetName}）</span>
              ) : (
                <span className="text-severity-high">未登记 AI 服务</span>
              )}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
