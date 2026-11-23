import { useEffect, useState } from 'react';
import type { FleetJob } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

/** 驳回必须填原因。 */
export function RejectJobDialog({
  job,
  pending,
  onClose,
  onSubmit,
}: {
  job: FleetJob | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (job) {
      setReason('');
      setTouched(false);
    }
  }, [job]);
  const trimmed = reason.trim();
  const error = touched && !trimmed ? '请填写驳回原因' : undefined;
  return (
    <Modal
      open={job !== null}
      onClose={onClose}
      size="sm"
      title="驳回真机测评任务"
      description={
        job
          ? `终端：${job.endpoint?.hostname ?? '—'}　发起人：${job.requestedBy?.username ?? '—'}`
          : undefined
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setTouched(true);
              if (trimmed) onSubmit(trimmed);
            }}
          >
            {pending ? '提交中…' : '确认驳回'}
          </Button>
        </>
      }
    >
      <Field
        label="驳回原因"
        htmlFor="fleet-reject-reason"
        required
        error={error}
        hint="发起人会看到这条原因。"
      >
        <Textarea
          id="fleet-reject-reason"
          rows={3}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </Field>
    </Modal>
  );
}
