import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type FleetEnrollmentCodeCreated } from '@/lib/api';
import { errorMessage } from '@/lib/fleet';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { PRODUCT_NAME } from '@/lib/product-name';

export function CreateCodeModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: FleetEnrollmentCodeCreated) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState('24');
  const [uses, setUses] = useState('1');
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setLabel('');
      setTtl('24');
      setUses('1');
      setTouched(false);
    }
  }, [open]);

  const ttlN = Number(ttl);
  const usesN = Number(uses);
  const labelErr = touched && !label.trim() ? '请填写名称' : undefined;
  const ttlErr =
    !Number.isInteger(ttlN) || ttlN < 1 || ttlN > 168 ? '有效期为 1-168 小时' : undefined;
  const usesErr =
    !Number.isInteger(usesN) || usesN < 1 || usesN > 1000 ? '可用次数为 1-1000' : undefined;

  const create = useMutation({
    mutationFn: () =>
      api.fleet.createEnrollmentCode({ label: label.trim(), expiresInHours: ttlN, maxUses: usesN }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['fleet', 'codes'] });
      onCreated(c);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err, '创建失败，请稍后重试')),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="创建接入码"
      description={`接入码用于终端首次向${PRODUCT_NAME}注册，创建后明文只显示一次。`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            取消
          </Button>
          <Button
            disabled={create.isPending}
            onClick={() => {
              setTouched(true);
              if (!label.trim() || ttlErr || usesErr) return;
              create.mutate();
            }}
          >
            {create.isPending ? '创建中…' : '创建'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="名称"
          htmlFor="fleet-code-label"
          required
          error={labelErr}
          hint="用来区分用途，例如「研发部第一批」。"
        >
          <Input
            id="fleet-code-label"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field
          label="有效期（小时）"
          htmlFor="fleet-code-ttl"
          error={ttlErr}
          hint="默认 24 小时，最长 168 小时（7 天）。"
        >
          <Input
            id="fleet-code-ttl"
            type="number"
            min={1}
            max={168}
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
          />
        </Field>
        <Field
          label="可用次数"
          htmlFor="fleet-code-uses"
          error={usesErr}
          hint="可接入的终端数量上限，默认 1 台。"
        >
          <Input
            id="fleet-code-uses"
            type="number"
            min={1}
            max={1000}
            value={uses}
            onChange={(e) => setUses(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
