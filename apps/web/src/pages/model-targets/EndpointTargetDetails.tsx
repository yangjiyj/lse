import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ModelTarget } from '@/lib/api';
import { isEndpointOnline, osLabel, productLabel } from '@/lib/endpoint-agents';
import { fleetEndpointIdOf, shortProbeVersion } from '@/lib/fleet';

function accessText(config: Record<string, unknown> | null | undefined, key: string): string {
  const value = config?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * 终端类评估对象的「接入详情」：显示主机名 / 系统 / 探针状态，
 * 不再露出「对象标识 endpoint-agent」和「接入位置 fleet://ep_…」这些内部代号。
 * 终端状态在展开时才去读，列表本身不额外发请求。
 */
export function EndpointTargetDetails({ target }: { target: ModelTarget }) {
  const [open, setOpen] = useState(false);
  const config = target.accessConfig;
  const fleetId = fleetEndpointIdOf(target);
  const registeredId = accessText(config, 'endpointId');
  const fleet = useQuery({
    queryKey: ['fleet', 'endpoint', fleetId],
    queryFn: () => api.fleet.endpoint(fleetId!),
    enabled: open && fleetId !== null,
    retry: false,
  });
  const shield = useQuery({
    queryKey: ['endpoint-evals-endpoints', 'all'],
    queryFn: () => api.endpointEvals.endpoints(),
    enabled: open && fleetId === null && registeredId !== '',
    retry: false,
  });
  const shieldEndpoint = shield.data?.find((e) => e.endpoint_id === registeredId);
  const pending = fleetId !== null ? fleet.isLoading : shield.isLoading;
  const failed = fleetId !== null ? fleet.isError : shield.isError;

  const hostname =
    fleet.data?.hostname ??
    shieldEndpoint?.hostname ??
    (accessText(config, 'endpointLabel') || '—');
  let system = '—';
  let probe = '—';
  if (fleet.data) {
    const d = fleet.data;
    system = [osLabel(d.os), d.osVersion].filter(Boolean).join(' ');
    const state = d.status === 'REVOKED' ? '已吊销' : d.online ? '在线' : '离线';
    probe = d.agentVersion ? `${state} · 版本 ${shortProbeVersion(d.agentVersion)}` : state;
  } else if (shieldEndpoint) {
    system = osLabel(shieldEndpoint.os);
    probe = isEndpointOnline(shieldEndpoint) ? '在线' : '离线';
  }
  const product = accessText(config, 'product');

  return (
    <details
      className="mt-1 text-xs text-ink-3"
      onClick={(e) => e.stopPropagation()}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-brand-700 hover:underline">接入详情</summary>
      <dl
        className="mt-1 space-y-1 break-all rounded-lg bg-[#F7F9FD] p-2"
        data-testid="endpoint-target-details"
      >
        <dt className="text-ink-3">主机名</dt>
        <dd className="text-ink">{hostname}</dd>
        {product && (
          <>
            <dt className="text-ink-3">智能体</dt>
            <dd className="text-ink">{productLabel(product)}</dd>
          </>
        )}
        <dt className="text-ink-3">系统</dt>
        <dd className="text-ink">{pending ? '读取中…' : system}</dd>
        <dt className="text-ink-3">探针状态</dt>
        <dd className="text-ink">{pending ? '读取中…' : probe}</dd>
        {failed && <dd className="text-ink-3">暂时无法读取终端状态，请稍后重试。</dd>}
      </dl>
    </details>
  );
}
