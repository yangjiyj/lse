import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { shortProbeVersion } from '@/lib/fleet';
import { fleetJobError } from '@/lib/fleet-job-error';
import { osLabel } from '@/lib/endpoint-agents';
import { Button } from '@/components/ui/button';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { OnlineBadge } from '@/components/fleet/FleetBadges';
import { EndpointOverviewLists } from '@/components/fleet/EndpointOverviewLists';
import { EndpointHardwareCards } from '@/components/fleet/EndpointHardwareCards';
import { DetailDrawer } from '@/components/fleet/DetailDrawer';
import { PostureChecksModal } from '@/components/fleet/PostureChecksModal';
import { OwnerDialog, ownerText } from '@/components/fleet/OwnerDialog';

export function EndpointDetailPage() {
  const { id = '' } = useParams();
  const exportList = useRef<(() => void) | null>(null);
  const { hasPermission } = useAuth();
  const [info, setInfo] = useState(false);
  const [owning, setOwning] = useState(false);
  const [checks, setChecks] = useState(false);
  const endpoint = useQuery({
    queryKey: ['fleet', 'endpoint', id],
    queryFn: () => api.fleet.endpoint(id),
    retry: false,
  });
  const overview = useQuery({
    queryKey: ['fleet', 'overview', id],
    queryFn: () => api.fleet.overview(id),
    retry: false,
  });
  const agents = useQuery({
    queryKey: ['fleet', 'agents', 'endpoint', id],
    queryFn: () => api.fleet.agents({ endpointId: id, page: 1, pageSize: 100 }),
    enabled: !!id,
    retry: false,
  });
  const d = endpoint.data;
  if (!d)
    return (
      <div role={endpoint.isError ? 'alert' : 'status'}>
        {endpoint.isError ? (
          <>
            <p>终端信息加载失败</p>
            <Button onClick={() => void endpoint.refetch()}>重试</Button>
          </>
        ) : (
          '正在读取终端信息…'
        )}
      </div>
    );
  return (
    <div className="space-y-4">
      <nav aria-label="面包屑" className="text-xs text-ink-3">
        评估中心 / <Link to="/fleet">终端</Link> / {d.hostname}
      </nav>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{d.hostname}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-3">
            <OnlineBadge endpoint={d} />
            <span>
              {osLabel(d.os)} {d.osVersion}
            </span>
            <span title={overview.data?.report?.probeVersion || d.agentVersion || undefined}>
              探针 {shortProbeVersion(overview.data?.report?.probeVersion || d.agentVersion)}
            </span>
            <span>最近上报 {formatDateTime(d.lastSeenAt)}</span>
            <span>
              责任人 {d.owner ? <span className="text-ink-2">{ownerText(d.owner)}</span> : '未设置'}
              {hasPermission('model_target:create') && (
                <button className="ml-1.5 text-brand-700" onClick={() => setOwning(true)}>
                  {d.owner ? '修改' : '设置'}
                </button>
              )}
            </span>
            <button className="text-brand-700" onClick={() => setInfo(true)}>
              终端信息
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={!overview.data}
            onClick={() => exportList.current?.()}
          >
            导出清单
          </Button>
          <Button
            disabled={d.status === 'REVOKED' || !hasPermission('model_target:create')}
            onClick={() => setChecks(true)}
          >
            一键检测
          </Button>
        </div>
      </header>
      {d.status === 'REVOKED' && (
        <NoteBox tone="warning" data-testid="revoked-note">
          该终端已吊销，不会再接收任务，也无法发起检测或真机测评；以下为吊销前的记录。
        </NoteBox>
      )}
      {overview.isError ? (
        <NoteBox tone="warning" role="alert">
          终端概览加载失败。
          <Button variant="outline" onClick={() => void overview.refetch()}>
            重试
          </Button>
        </NoteBox>
      ) : overview.data ? (
        <EndpointOverviewLists overview={overview.data} showCounts exportRef={exportList}
          agentRows={agents.data?.items} canStartEval={hasPermission('model_target:create') && hasPermission('eval_task:create')} />
      ) : (
        <p role="status">正在读取概览…</p>
      )}
      <EndpointHardwareCards hardware={d.hardware} />
      {owning && (
        <OwnerDialog endpointId={d.id} endpointName={d.hostname} owner={d.owner ?? null} onClose={() => setOwning(false)} />
      )}
      {info && (
        <DetailDrawer title="终端信息" onClose={() => setInfo(false)}>
          <dl className="space-y-3">
            {[
              ['主机名', d.hostname],
              ['系统', `${osLabel(d.os)} ${d.osVersion} · ${d.arch}`],
              ['所属用户', d.osUser],
              ['接入时间', formatDateTime(d.registeredAt)],
              ['接入码', d.enrollmentCode?.label],
              ['终端编号', d.publicId],
              ['待上报事件数', d.health?.queue_events],
              ['最近采集', formatDateTime(d.health?.collector?.last_scan_at)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-ink-3">{label}</dt>
                <dd>{value ?? '—'}</dd>
              </div>
            ))}
          </dl>
          <section>
            <h3 className="mb-2 text-xs text-ink-3">健康摘要</h3>
            {d.health?.collector?.last_error ||
            d.health?.last_upload_error ||
            d.health?.collector?.last_eval_job_error ? (
              <NoteBox tone="warning">
                {d.health.collector?.last_error && <p>最近错误：{d.health.collector.last_error}</p>}
                {d.health.last_upload_error && <p>最近上传错误：{d.health.last_upload_error}</p>}
                {d.health.collector?.last_eval_job_error && (
                  <p>最近测评错误：{fleetJobError(d.health.collector.last_eval_job_error)}</p>
                )}
              </NoteBox>
            ) : (
              <p>最近没有错误记录。</p>
            )}
          </section>
        </DetailDrawer>
      )}
      <PostureChecksModal endpoint={checks ? d : null} onClose={() => setChecks(false)} />
    </div>
  );
}
