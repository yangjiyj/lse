import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Building2, Info } from 'lucide-react';
import { api, type TenantTransferKind } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface TenantTransferDialogProps {
  open: boolean;
  kind: TenantTransferKind;
  /** 要转移的根对象（一次只允许同一个租户的对象）。 */
  ids: string[];
  onClose: () => void;
  onTransferred?: (message: string) => void;
}

/**
 * 资产归属转移：先选目标租户 → 服务端预检（会搬走什么、有哪些冲突）→ 确认执行。
 * 预检是只读的；执行时服务端会重新预检一次，不信任前端结果。
 */
export function TenantTransferDialog({
  open,
  kind,
  ids,
  onClose,
  onTransferred,
}: TenantTransferDialogProps) {
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.tenants.list(),
    enabled: open,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open) {
      setTargetId('');
      setError('');
    }
  }, [open]);

  const plan = useQuery({
    queryKey: ['tenant-transfer-plan', kind, targetId, ids.slice().sort().join(',')],
    queryFn: () => api.tenants.transferPreflight({ kind, ids, targetTenantId: targetId }),
    enabled: open && Boolean(targetId) && ids.length > 0,
    retry: false,
  });

  const run = useMutation({
    mutationFn: () => api.tenants.transfer({ kind, ids, targetTenantId: targetId }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries();
      onTransferred?.(
        `已把 ${result.plan.roots.length} 个${result.plan.kindLabel}（共 ${result.totalRows} 条记录）转到「${result.plan.targetTenant.name}」`,
      );
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const data = plan.data;
  const selecting = !targetId;
  const loading = plan.isFetching;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="转移资产归属"
      description={
        selecting
          ? '选择要把这些资产转到哪个租户。转移完成后原租户将不再看到它们。'
          : '确认下面的清单。转移是一个事务，任何一条搬不了都会整体回滚。'
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={run.isPending}>
            取消
          </Button>
          <Button
            onClick={() => {
              setError('');
              run.mutate();
            }}
            disabled={!data?.canTransfer || run.isPending || loading}
          >
            {run.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
            确认转移
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-ink">目标租户</span>
          <select
            aria-label="目标租户"
            data-testid="transfer-target"
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
              setError('');
            }}
            className="h-9 w-full rounded-lg border border-line bg-white px-3 text-[13.5px] text-ink-2"
          >
            <option value="">请选择…</option>
            {(tenants.data?.items ?? []).map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
                {tenant.isPlatform ? '（平台租户）' : ''}
              </option>
            ))}
          </select>
        </label>

        {loading && (
          <div className="flex items-center gap-2 rounded-lg bg-[#F7F9FD] px-3 py-2 text-[13px] text-ink-2">
            <Spinner className="h-3.5 w-3.5" />
            正在检查依赖与冲突…
          </div>
        )}

        {plan.isError && !loading && (
          <p role="alert" className="rounded-lg bg-[#FDF2F2] px-3 py-2 text-[13px] text-[#A32D2D]">
            预检失败：{(plan.error as Error).message}
          </p>
        )}

        {data && !loading && (
          <>
            <div className="flex items-center gap-2 rounded-lg bg-[#F7F9FD] px-3 py-2 text-[13px]">
              <Building2 className="h-4 w-4 shrink-0 text-slate-500" />
              <span className="truncate text-ink-2">{data.sourceTenant.name || '原租户'}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="truncate font-medium text-ink">{data.targetTenant.name}</span>
            </div>

            {data.totalRows > 0 && (
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-ink">
                  将转移 {data.roots.length} 个{data.kindLabel}，共 {data.totalRows} 条记录
                </div>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-line px-3 py-2 text-[13px] text-ink-2">
                  {Object.entries(data.counts).map(([key, item]) => (
                    <li key={key} className="flex items-center justify-between gap-2">
                      <span className="truncate">{item.label}</span>
                      <span className="tabular-nums text-ink">{item.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.blockers.length > 0 && (
              <div role="alert" className="rounded-lg bg-[#FDF2F2] px-3 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-[#A32D2D]">
                  <AlertTriangle className="h-4 w-4" />
                  需要先处理 {data.blockers.length} 项
                </div>
                <ul className="space-y-1 text-[12.5px] text-[#791F1F]">
                  {data.blockers.map((blocker, index) => (
                    <li key={`${blocker.code}-${index}`}>· {blocker.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {data.warnings.length > 0 && (
              <div className="rounded-lg bg-[#FDF8EC] px-3 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-[#854F0B]">
                  <Info className="h-4 w-4" />
                  请注意
                </div>
                <ul className="space-y-1 text-[12.5px] text-[#633806]">
                  {data.warnings.map((warning, index) => (
                    <li key={`${warning.code}-${index}`}>· {warning.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {data.canTransfer && (
              <p className="text-[12.5px] text-ink-3">
                确认后立即生效，原租户的用户将无法再访问这些资产。
              </p>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="rounded-lg bg-[#FDF2F2] px-3 py-2 text-[13px] text-[#A32D2D]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
