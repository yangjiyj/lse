import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type FleetEndpoint } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

export function PostureChecksModal({ endpoint, onClose, onStarted }: {
  endpoint: FleetEndpoint | null;
  onClose: () => void;
  onStarted?: (taskId: string) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<string[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const catalog = useQuery({
    queryKey: ['fleet', 'check-catalog'],
    queryFn: () => api.fleet.checkCatalog(),
    enabled: !!endpoint,
    retry: false,
  });
  useEffect(() => { setTaskId(null); setItems([]); }, [endpoint?.id]);
  useEffect(() => {
    if (endpoint && catalog.data) setItems(catalog.data.posture.map((item) => item.id));
  }, [endpoint?.id, catalog.data]);
  const submit = useMutation({
    mutationFn: () => api.fleet.postureEval(endpoint!.id, { items }),
    onSuccess: (result) => {
      setTaskId(result.taskId);
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      toast.success('已开始配置检测');
      onStarted?.(result.taskId);
    },
    onError: () => toast.error('配置检测发起失败，请稍后重试'),
  });
  return (
    <Modal open={!!endpoint} onClose={submit.isPending ? () => {} : onClose} size="lg"
      title={`配置体检 ${endpoint?.hostname ?? ''}`}
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={submit.isPending}>{taskId ? '关闭' : '取消'}</Button>
        {!taskId && <Button onClick={() => submit.mutate()} disabled={!catalog.data || !items.length || submit.isPending || endpoint?.status === 'REVOKED'}>
          {submit.isPending ? '提交中…' : '开始检测'}
        </Button>}
      </>}>
      {catalog.isLoading && <p role="status">正在加载检测项目…</p>}
      {catalog.isError && <div role="alert">检测项目加载失败。<Button variant="outline" onClick={() => void catalog.refetch()}>重试</Button></div>}
      {taskId ? <Link className="text-brand-700 underline" to={`/eval-tasks/${taskId}`}>查看检测结果</Link> :
        <div className="space-y-2">{catalog.data?.posture.map((item) => <label key={item.id} className="flex items-start gap-2">
          <input type="checkbox" checked={items.includes(item.id)} disabled={submit.isPending}
            onChange={(event) => setItems((previous) => event.target.checked ? [...previous, item.id] : previous.filter((id) => id !== item.id))} />
          <span>{item.title}</span>
        </label>)}</div>}
    </Modal>
  );
}
