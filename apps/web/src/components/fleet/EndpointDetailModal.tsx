import { Link } from 'react-router-dom';
import type { FleetEndpoint, FleetJob } from '@/lib/api';
import { shortProbeVersion } from '@/lib/fleet';
import { osLabel } from '@/lib/endpoint-agents';
import { formatDateTime } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { OnlineBadge } from './FleetBadges';
import { EndpointActions } from './EndpointActions';
import type { CheckMode } from './RunChecksModal';

/** 保留兼容快速预览，完整清单统一在全页详情中展示。 */
export function EndpointDetailModal({
  endpoint,
  activeJob,
  canManage,
  onClose,
  onRequestJob,
  onRevoke,
}: {
  endpoint: FleetEndpoint | null;
  activeJob: FleetJob | null;
  canManage: boolean;
  onClose: () => void;
  onRequestJob: (endpoint: FleetEndpoint, mode?: CheckMode) => void;
  onRevoke: (endpoint: FleetEndpoint) => void;
}) {
  return (
    <Modal
      open={!!endpoint}
      onClose={onClose}
      title={endpoint?.hostname || '终端预览'}
      footer={
        endpoint && (
          <EndpointActions
            endpoint={endpoint}
            activeJob={activeJob}
            canManage={canManage}
            onRequestJob={onRequestJob}
            onRevoke={onRevoke}
          />
        )
      }
    >
      {endpoint && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 text-sm text-ink-3">
            <OnlineBadge endpoint={endpoint} />
            <span>
              {osLabel(endpoint.os)} {endpoint.osVersion}
            </span>
            <span title={endpoint.agentVersion || undefined}>
              探针 {shortProbeVersion(endpoint.agentVersion)}
            </span>
          </div>
          <p className="text-sm">最近上报 {formatDateTime(endpoint.lastSeenAt)}</p>
          {endpoint.status === 'REVOKED' && (
            <NoteBox tone="warning" data-testid="revoked-note">
              该终端已吊销，无法发起检测或真机测评。
            </NoteBox>
          )}
          <Link
            className="text-sm font-medium text-brand-700 hover:underline"
            to={`/fleet/endpoints/${endpoint.id}`}
            onClick={onClose}
          >
            打开完整详情
          </Link>
        </div>
      )}
    </Modal>
  );
}
