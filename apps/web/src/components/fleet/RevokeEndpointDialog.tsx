import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type FleetEndpoint } from '@/lib/api';
import { errorMessage } from '@/lib/fleet';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { NoteBox } from '@/components/page-kit/NoteBox';

export function RevokeEndpointDialog({
  endpoint,
  onClose,
}: {
  endpoint: FleetEndpoint | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.fleet.revokeEndpoint(endpoint!.id),
    onSuccess: () => {
      toast.success('终端已吊销');
      void qc.invalidateQueries({ queryKey: ['fleet'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err, '吊销失败，请稍后重试')),
  });
  return (
    <Modal
      open={endpoint !== null}
      onClose={onClose}
      size="sm"
      title="吊销终端"
      description={endpoint ? `确定吊销终端「${endpoint.hostname}」吗？` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={revoke.isPending}>
            取消
          </Button>
          <Button variant="destructive" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
            {revoke.isPending ? '吊销中…' : '确认吊销'}
          </Button>
        </>
      }
    >
      <NoteBox tone="warning">
        吊销后该终端的令牌立即失效，不再上报数据，也不会再领取测评任务；已有的历史记录会保留。如需重新接入，需先清除终端本地的采集器状态，再使用新的接入码重新登记；用原来的状态直接重新登记会被拒绝。
      </NoteBox>
    </Modal>
  );
}
