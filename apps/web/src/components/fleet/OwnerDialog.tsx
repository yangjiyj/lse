import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type FleetEndpointOwner } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

/** 责任人显示：姓名（部门）。 */
export function ownerText(owner: FleetEndpointOwner | null | undefined): string {
  if (!owner) return '';
  return owner.department ? `${owner.name}（${owner.department}）` : owner.name;
}

/**
 * 设置终端责任人：姓名可以从本租户的平台用户里点选，也可以直接填平台外的人；部门可不填。
 * 姓名清空后保存即清除责任人。
 */
export function OwnerDialog({
  endpointId,
  endpointName,
  owner,
  onClose,
}: {
  endpointId: string;
  endpointName: string;
  owner: FleetEndpointOwner | null;
  onClose: () => void;
}) {
  const { hasPermission } = useAuth();
  const qc = useQueryClient();
  const { success } = useToast();
  const listId = useId();
  const [name, setName] = useState(owner?.name ?? '');
  const [department, setDepartment] = useState(owner?.department ?? '');
  const [error, setError] = useState<string | null>(null);
  const users = useQuery({
    queryKey: ['users', 'owner-candidates'],
    queryFn: () => api.users.list({ page: 1, pageSize: 200 }),
    enabled: hasPermission('user:read'),
    staleTime: 60_000,
  });
  const candidates = (users.data?.items ?? []).filter((u) => u.isActive);
  const save = useMutation({
    mutationFn: (clear: boolean) => {
      const trimmed = clear ? '' : name.trim();
      const matched = candidates.find((u) => u.displayName === trimmed || u.username === trimmed);
      return api.fleet.setOwner(endpointId, {
        name: matched ? matched.displayName : trimmed,
        department: clear ? '' : department.trim(),
        userId: matched ? matched.id : null,
      });
    },
    onSuccess: (res) => {
      success(res.owner ? '责任人已保存' : '已清除责任人');
      void qc.invalidateQueries({ queryKey: ['fleet'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`${endpointName} · 责任人`}
      footer={
        <>
          {owner && (
            <Button variant="ghost" className="mr-auto text-severity-critical" disabled={save.isPending} onClick={() => save.mutate(true)}>
              清除
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate(false)}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="责任人" htmlFor={`${listId}-name`} required>
          <Input
            id={`${listId}-name`}
            value={name}
            maxLength={64}
            list={`${listId}-users`}
            autoComplete="off"
            placeholder="选择平台用户，或直接填写姓名"
            onChange={(e) => setName(e.target.value)}
          />
          <datalist id={`${listId}-users`}>
            {candidates.map((u) => (
              <option key={u.id} value={u.displayName}>
                {u.username}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="部门" htmlFor={`${listId}-department`}>
          <Input
            id={`${listId}-department`}
            value={department}
            maxLength={64}
            onChange={(e) => setDepartment(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}
