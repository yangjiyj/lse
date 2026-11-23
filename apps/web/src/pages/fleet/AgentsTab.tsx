import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Copy } from 'lucide-react';
import { api, type FleetAgentGroup, type FleetAgentRow } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { FLEET_JOB_STATUS_LABELS } from '@/lib/fleet';
import { endpointProduct, osLabel, suggestedEndpointTargetName } from '@/lib/endpoint-agents';
import { DetailDrawer } from '@/components/fleet/DetailDrawer';
import { DrawerSection } from '@/components/fleet/DrawerParts';
import { OwnerDialog, ownerText } from '@/components/fleet/OwnerDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { useTenantView } from '@/lib/tenant-view';

const LABEL: Record<FleetAgentRow['status'], string> = { ready: '可测', needs_attention: '需处理', unsupported: '不支持', offline: '终端离线', platform_managed: '平台管理' };
const REGISTRY_CHECK = "sudo stat -c '%U %a %F' /etc/agent-platform-managed/eval-registry.json";
/** 每页终端数：按终端分页，一台终端的智能体不会被拆到两页。 */
const GROUPS_PER_PAGE = 10;

function ReadinessDetails({ row, close }: { row: FleetAgentRow; close: () => void }) {
  const [copyState, setCopyState] = useState('');
  if (row.status === 'ready') return <DetailDrawer title={`${row.agentName} · 可测范围`} onClose={close}>
    <DrawerSection title="可用样本">
      <p>该智能体当前可运行基础场景，测评时使用终端登录用户的真实配置和模型路由。</p>
      <p className="mt-2">隔离沙箱样本目前仅支持 Claude Code，且终端需上报沙箱能力。其他智能体尚未接入此能力。</p>
    </DrawerSection>
  </DetailDrawer>;
  return <DetailDrawer title={`${row.agentName} · 需处理`} onClose={close}>
    <DrawerSection title="原因"><p>{row.reason || '终端尚未上报可测状态。'}</p></DrawerSection>
    {row.os.toLowerCase() === 'linux' && row.source === 'jiandun' && <DrawerSection title="处理步骤">
      <ol className="list-decimal space-y-2 pl-5">
        <li>确认终端已安装该智能体，且采集器启用了真机测评。</li>
        <li>检查测评登记文件由 root 持有、权限为 0644，且包含该智能体的可执行路径。</li>
        <li>检查采集器配置中的测评用户，等待终端重新上报后刷新。</li>
      </ol>
      <div className="mt-3 flex items-start gap-2 border-t border-line pt-3">
        <code className="min-w-0 flex-1 break-all text-xs">{REGISTRY_CHECK}</code>
        <Button variant="ghost" size="icon" aria-label="复制检查命令" title="复制检查命令" onClick={async () => {
          try { await navigator.clipboard.writeText(REGISTRY_CHECK); setCopyState('已复制'); } catch { setCopyState('复制失败'); }
        }}><Copy className="h-4 w-4" /></Button>
      </div>{copyState && <p role="status">{copyState}</p>}
    </DrawerSection>}
  </DetailDrawer>;
}

/** 分组键由接口给出（平台来源按机器合并，一组里有多个 endpointId）；旧接口没有时按终端拼。 */
const groupKey = (row: FleetAgentRow) => row.groupKey ?? `${row.source}\0${row.endpointId}`;

/** 旧接口没有 groups 时，按行里的终端信息拼出分组（没有资产与风险汇总）。 */
function fallbackGroups(rows: FleetAgentRow[]): FleetAgentGroup[] {
  const groups = new Map<string, FleetAgentGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    if (!groups.has(key)) groups.set(key, {
      key, endpointId: row.endpointId, source: row.source, name: row.endpointName, os: row.os,
      osUser: row.source === 'jiandun' ? row.user : null, online: null,
      owner: row.source === 'agentshield' && row.user ? { name: row.user, department: null, userId: null, updatedAt: null } : null,
      ownerSource: row.source === 'agentshield' && row.user ? 'reported' : null, assets: null, risks: null,
    });
  }
  return [...groups.values()];
}

/**
 * 平台来源的在线登记能否登记为评估对象：登记上报了测评执行器，且产品是评估对象表单认识的。
 * 入口是评估对象页的新建表单（按路由 state 预填终端，仍需用户确认保存）。
 */
const canRegister = (row: FleetAgentRow) =>
  row.status === 'platform_managed' && Boolean(row.evalRunnerVersion) && Boolean(endpointProduct(row.agentKey));

function assetText(assets: FleetAgentRow['assets']): string {
  if (!assets) return '—';
  const parts = [assets.skills ? `Skill ${assets.skills}` : '', assets.mcp ? `MCP ${assets.mcp}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

function latestText(row: FleetAgentRow): string {
  if (!row.latest) return '';
  const status = row.latest.status !== 'COMPLETED' ? FLEET_JOB_STATUS_LABELS[row.latest.status] : '';
  const conclusion = row.latest.conclusion || (row.latest.status === 'COMPLETED' ? '结论未上报' : '');
  return [status, conclusion].filter(Boolean).join(' · ');
}

/** 终端分组头：终端、责任人、资产与风险汇总。 */
function GroupHeader({ group, canManage, onOwner }: { group: FleetAgentGroup; canManage: boolean; onOwner: () => void }) {
  const { isAllTenants, tenantName, guardRow } = useTenantView();
  const detail = `/fleet/endpoints/${encodeURIComponent(group.endpointId)}`;
  return <TR className="bg-[#F7F9FD] hover:bg-[#F7F9FD]" data-testid="endpoint-group">
    <TD colSpan={5} className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {group.source === 'jiandun'
              ? <Link className="text-[15px] font-semibold text-ink hover:text-brand-700" to={detail}
                  onClick={(e) => { if (guardRow(group.tenantId, detail)) e.preventDefault(); }}>{group.name}</Link>
              : <span className="text-[15px] font-semibold text-ink">{group.name}</span>}
            {isAllTenants && <span data-testid="tenant-cell" className="text-xs text-ink-3">{group.source === 'agentshield' ? '智能体安全平台' : tenantName(group.tenantId)}</span>}
            <span className="text-xs text-ink-3">
              {[group.os ? osLabel(group.os) : '', group.source === 'jiandun' ? '自管终端' : '智能体安全平台',
                group.osUser ? `登录账号 ${group.osUser}` : ''].filter(Boolean).join(' · ')}
            </span>
            {group.online === false && <Badge tone="neutral">离线</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
            {group.assets
              ? <span>资产：智能体 {group.assets.agents} · Skill {group.assets.skills} · MCP {group.assets.mcp}
                {group.assets.platforms ? ` · 平台 ${group.assets.platforms}` : ''}</span>
              : <span className="text-ink-3">资产：{group.source === 'agentshield' ? '由智能体安全平台管理' : '探针未上报'}</span>}
            {group.risks && (group.risks.open > 0
              ? <Link className="font-medium text-severity-critical hover:underline" to={detail}>
                风险 {group.risks.open}{group.risks.high ? `（高危 ${group.risks.high}）` : ''}</Link>
              : <span className="text-ink-3">暂无风险</span>)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[13px]">
          <span className="text-ink-3">责任人</span>
          {group.owner
            ? <span className="font-medium text-ink">{ownerText(group.owner)}</span>
            : <span className="text-ink-3">未设置</span>}
          {group.ownerSource === 'reported' && <span className="text-xs text-ink-3">（平台上报）</span>}
          {group.source === 'jiandun' && canManage && <button type="button" className="text-brand-700 hover:underline"
            aria-label={`${group.owner ? '修改' : '设置'} ${group.name} 的责任人`}
            onClick={() => { if (!guardRow(group.tenantId, '/fleet')) onOwner(); }}>{group.owner ? '修改' : '设置'}</button>}
        </div>
      </div>
    </TD>
  </TR>;
}

export function AgentsTab() {
  const { hasPermission } = useAuth();
  const { isAllTenants, listParams, tenantFilter, guardRow } = useTenantView();
  const canCreate = hasPermission('model_target:create') && hasPermission('eval_task:create');
  const canManage = hasPermission('model_target:create');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<FleetAgentRow | null>(null);
  const [owning, setOwning] = useState<FleetAgentGroup | null>(null);
  const query = useQuery({
    queryKey: ['fleet', 'agents', 'by-endpoint', page, q, tenantFilter],
    queryFn: () => api.fleet.agents({ page, pageSize: GROUPS_PER_PAGE, groupBy: 'endpoint', ...(q ? { q } : {}), ...listParams }),
  });
  const rows = query.data?.items ?? [];
  const groups = query.data?.groups ?? fallbackGroups(rows);
  return <section className="space-y-4">
    <Input className="max-w-sm" aria-label="搜索智能体或终端" placeholder="搜索智能体、终端或责任人" value={q}
      onChange={(event) => { setQ(event.target.value); setPage(1); }} />
    {query.isLoading ? <LoadingBlock label="正在读取智能体" /> : query.isError ? <p role="alert">智能体清单读取失败，请重试。</p> : <>
      {query.data?.connectorStatus === 'unavailable' && <p role="alert" className="text-sm text-amber-700">智能体安全平台清单读取失败。</p>}
      {query.data?.connectorStatus === 'permission_required' && <p className="text-sm text-ink-3">当前账号无权读取智能体安全平台清单。</p>}
      {groups.length > 0 && <Table fit>
        <THead><TR>
          <TH className="w-[26%]">智能体</TH>
          <TH className="w-[16%]">资产</TH>
          <TH className="w-[15%]">可测状态</TH>
          <TH>最近测评</TH>
          <TH className="w-[124px]">操作</TH>
        </TR></THead>
        <TBody>{groups.map((group) => [
          <GroupHeader key={`${group.key}-head`} group={group} canManage={canManage} onOwner={() => setOwning(group)} />,
          ...rows.filter((row) => groupKey(row) === group.key).map((row) => <TR key={`${group.key}-${row.agentKey}`}
            onClickCapture={isAllTenants ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              guardRow(row.tenantId, `/fleet/agents/${encodeURIComponent(row.endpointId)}/${encodeURIComponent(row.agentKey)}`);
            } : undefined}>
            <TD data-label="智能体" className="pl-6">
              <div className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
                {row.source === 'jiandun'
                  ? <Link className="truncate font-medium text-brand-700 hover:underline" to={`/fleet/agents/${encodeURIComponent(row.endpointId)}/${encodeURIComponent(row.agentKey)}`}>{row.agentName}</Link>
                  : <span className="truncate font-medium">{row.agentName}</span>}
                <span className="shrink-0 text-xs text-ink-3">{!row.version || row.version === 'version_unknown' ? '版本未知' : row.version}</span>
              </div>
            </TD>
            <TD data-label="资产" className="whitespace-nowrap text-ink-2">{assetText(row.assets)}</TD>
            <TD data-label="可测状态">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap">
                <Badge tone={row.status === 'ready' ? 'success' : row.status === 'needs_attention' ? 'warning' : 'neutral'}>{LABEL[row.status]}</Badge>
                {row.status === 'ready' && (row.scope === 'all'
                  ? <span className="text-xs text-ink-3">全部样本</span>
                  : <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setSelected(row)}>基础场景</button>)}
              </div>
            </TD>
            <TD data-label="最近测评">
              {row.latest
                ? <div className="min-w-0">
                  <div className="truncate" title={latestText(row)}>{latestText(row)}</div>
                  <div className="text-xs text-ink-3">{formatDateTime(row.latest.createdAt)}</div>
                </div>
                : <span className="text-ink-3">暂无测评</span>}
            </TD>
            <TD data-label="操作" className="whitespace-nowrap">
              {row.status === 'ready' && canCreate ? <Link className="font-medium text-brand-700 hover:underline"
                to={`/agent-evals/new?endpoint=${encodeURIComponent(row.endpointId)}&agent=${encodeURIComponent(row.agentKey)}`}>发起测评</Link>
                : row.status === 'needs_attention' ? <Button variant="outline" size="sm" aria-label={`处理 ${row.agentName}`} onClick={() => setSelected(row)}>处理</Button>
                : canRegister(row) && canManage ? <Link className="font-medium text-brand-700 hover:underline" to="/model-targets"
                    state={{ registerEndpoint: { endpointId: row.endpointId, hostname: row.endpointName, product: row.agentKey,
                      name: suggestedEndpointTargetName(row.endpointName, row.agentKey) } }}>登记为评估对象</Link>
                : <span className="text-ink-3">—</span>}
            </TD>
          </TR>),
        ])}</TBody>
      </Table>}
      {!groups.length && <p className="py-8 text-center text-sm text-ink-3">暂无智能体</p>}
      <Pagination page={page} pageSize={GROUPS_PER_PAGE} total={query.data?.total ?? 0} onPageChange={setPage} />
    </>}
    {selected && <ReadinessDetails row={selected} close={() => setSelected(null)} />}
    {owning && <OwnerDialog endpointId={owning.endpointId} endpointName={owning.name} owner={owning.owner}
      onClose={() => setOwning(null)} />}
  </section>;
}
