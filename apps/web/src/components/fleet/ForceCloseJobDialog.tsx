import type { FleetJob } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { NoteBox } from '@/components/page-kit/NoteBox';

/** 强制结束执行中的任务前确认：只写不知道就会误操作的那一句后果。 */
export function ForceCloseJobDialog({
  job,
  pending,
  onClose,
  onConfirm,
}: {
  job: FleetJob | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={job !== null}
      onClose={onClose}
      size="sm"
      title="强制结束"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? '提交中…' : '强制结束'}
          </Button>
        </>
      }
    >
      <NoteBox tone="warning">终端上的进程不会被停止，之后回传的结果会被丢弃。</NoteBox>
    </Modal>
  );
}
