import { Eye, Stethoscope } from 'lucide-react';
import type { FleetEndpoint, FleetJobStatus } from '@/lib/api';
import { LIVE_EVAL_UNAVAILABLE_HINT } from '@/lib/fleet';
import { Button } from '@/components/ui/button';
import { RowActionMenu } from '@/components/page-kit/RowActionMenu';
import type { CheckMode } from './RunChecksModal';

interface Props {
  endpoint: FleetEndpoint;
  activeJob?: { id: string; status: FleetJobStatus } | null;
  canManage: boolean;
  onRequestJob: (e: FleetEndpoint, mode?: CheckMode) => void;
  onRevoke: (e: FleetEndpoint) => void;
  onRemove?: (e: FleetEndpoint) => void;
  onDetail?: (e: FleetEndpoint) => void;
  showMore?: boolean;
}

export function EndpointActions({
  endpoint,
  activeJob,
  canManage,
  onRequestJob,
  onRevoke,
  onRemove,
  onDetail,
  showMore = true,
}: Props) {
  const revoked = endpoint.status === 'REVOKED';
  const unavailable = revoked
    ? '该终端已吊销，不再接收任务；如需检测，请重新接入终端。'
    : !endpoint.online
      ? '终端已离线，请确认终端和探针正常运行，恢复在线后再试。'
      : !endpoint.latestReport
        ? '该终端还没有上报配置检测数据，暂时无法检测。请确认采集器已按部署说明运行，上报成功后再试。'
        : '';
  const liveReason = [
    revoked ? '该终端已吊销，请重新接入终端。' : !endpoint.online ? '终端已离线。' : '',
    !endpoint.evalRunner ? LIVE_EVAL_UNAVAILABLE_HINT : '',
    activeJob ? '该终端已有进行中的任务，请等待任务结束后再试。' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canManage && (
        <span title={unavailable || '先查看检测项目与影响，再开始检测'}>
          <Button
            size="sm"
            variant="outline"
            disabled={!!unavailable}
            title={unavailable || '先查看检测项目与影响，再开始检测'}
            aria-label={`一键检测：${endpoint.hostname}`}
            onClick={() => onRequestJob(endpoint, 'all')}
          >
            <Stethoscope className="h-3.5 w-3.5" />
            一键检测
          </Button>
        </span>
      )}
      {onDetail && (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`查看详情：${endpoint.hostname}`}
          onClick={() => onDetail(endpoint)}
        >
          <Eye className="h-3.5 w-3.5" />
          详情
        </Button>
      )}
      {canManage && !revoked && <Button size="sm" variant="outline" disabled={!!liveReason}
        title={liveReason || '选择智能体和样本'} onClick={() => onRequestJob(endpoint, 'live')}>发起测评</Button>}
      {canManage && onRemove && <Button size="sm" variant="ghost" onClick={() => onRemove(endpoint)}>删除终端</Button>}
      {showMore && canManage && !revoked && (
        <RowActionMenu
          label={`更多操作：${endpoint.hostname}`}
          items={[
            {
              key: 'posture',
              ariaLabel: '只做配置检测',
              label: (
                <span>
                  只做配置检测
                  <small className="block text-ink-3">
                    {unavailable || '只读取配置，不运行智能体'}
                  </small>
                </span>
              ),
              disabled: !!unavailable,
              onSelect: () => onRequestJob(endpoint, 'posture'),
            },
            {
              key: 'live',
              ariaLabel: '只做真机测评',
              label: (
                <span>
                  只做真机测评
                  <small className="block text-ink-3">
                    {liveReason || '在终端上实际运行智能体做测试'}
                  </small>
                </span>
              ),
              disabled: !!liveReason,
              onSelect: () => onRequestJob(endpoint, 'live'),
            },
            { key: 'revoke', label: '吊销终端', danger: true, onSelect: () => onRevoke(endpoint) },
          ]}
        />
      )}
    </div>
  );
}
