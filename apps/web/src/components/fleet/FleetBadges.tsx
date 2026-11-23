import { Badge } from '@/components/ui/badge';
import type { FleetEndpoint, FleetJobStatus } from '@/lib/api';
import {
  FLEET_JOB_STATUS_LABELS,
  FLEET_JOB_STATUS_TONE,
  LIVE_EVAL_UNAVAILABLE_HINT,
} from '@/lib/fleet';

export function JobStatusBadge({ status }: { status: FleetJobStatus }) {
  return (
    <Badge tone={FLEET_JOB_STATUS_TONE[status] ?? 'neutral'} icon>
      {FLEET_JOB_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function OnlineBadge({ endpoint }: { endpoint: Pick<FleetEndpoint, 'status' | 'online'> }) {
  if (endpoint.status === 'REVOKED') return <Badge tone="critical">已吊销</Badge>;
  return (
    <Badge tone={endpoint.online ? 'success' : 'neutral'} icon>
      {endpoint.online ? '在线' : '离线'}
    </Badge>
  );
}

/** 真机测评能力以终端上报的测评执行器为准，与操作系统无关。 */
export function CapabilityBadge({ endpoint }: { endpoint: Pick<FleetEndpoint, 'evalRunner'> }) {
  return endpoint.evalRunner ? (
    <Badge tone="info" title={`测评执行器 ${endpoint.evalRunner}`}>
      支持真机测评
    </Badge>
  ) : (
    <Badge tone="neutral" title={LIVE_EVAL_UNAVAILABLE_HINT}>
      仅配置检测
    </Badge>
  );
}
