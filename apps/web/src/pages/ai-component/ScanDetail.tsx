import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, aiComponentsApi, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { FindingCard } from './FindingCard';
import { CompareView } from './CompareView';
import { ASSET_TYPE_LABEL, JUDGE_STATUS_LABEL, SOURCE_TYPE_LABEL, formatBytes } from './labels';

export function ScanDetail({
  id,
  canScan,
  onChanged,
  onDeleted,
}: {
  id: string;
  canScan: boolean;
  onChanged: (id: string) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [linkOpen, setLinkOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [sev, setSev] = useState('');
  const detail = useQuery({
    queryKey: ['ai-components', 'scan', id],
    queryFn: () => aiComponentsApi.get(id),
  });
  const findings = useQuery({
    queryKey: ['ai-components', 'findings', id],
    queryFn: () => aiComponentsApi.findings(id),
  });
  const fail = (e: unknown, fb: string) => toast.error(e instanceof ApiError ? e.message : fb);
  const rescan = useMutation({
    mutationFn: () => aiComponentsApi.rescan(id),
    onSuccess: (r) => {
      toast.success('已按原输入重新扫描');
      onChanged(r.id);
    },
    onError: (e) => fail(e, '重新扫描失败'),
  });
  const remove = useMutation({
    mutationFn: () => aiComponentsApi.remove(id),
    onSuccess: () => {
      toast.success('扫描记录已删除');
      void qc.invalidateQueries({ queryKey: ['ai-components', 'scans'] });
      onDeleted();
    },
    onError: (e) => fail(e, '删除失败'),
  });

  if (detail.isLoading) return <LoadingBlock />;
  const s = detail.data;
  if (!s) return <p className="p-4 text-sm text-slate-500">扫描记录不存在或已删除。</p>;
  const items = (findings.data ?? []).filter(
    (f) =>
      !sev || (sev === 'HIGH' ? ['HIGH', 'CRITICAL'].includes(f.severity) : f.severity === sev),
  );
  const skipped = (s.files ?? []).filter(
    (f): f is { path: string; skipped: string } => !!f.skipped,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-slate-900">
            {s.assetName}
            {s.assetVersion ? ` ${s.assetVersion}` : ''}
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            {ASSET_TYPE_LABEL[s.assetType]} · {SOURCE_TYPE_LABEL[s.sourceType]} · 扫描 {s.fileCount}{' '}
            个文件（{formatBytes(s.totalBytes)}），跳过 {s.skippedCount} 个 ·{' '}
            {formatDateTime(s.createdAt)}
            {s.contentSha256 ? (
              <>
                <br />
                SHA-256 {s.contentSha256}
              </>
            ) : null}
            {s.judgeStatus && s.judgeStatus !== 'NOT_NEEDED' ? (
              <>
                <br />
                {JUDGE_STATUS_LABEL[s.judgeStatus]}
              </>
            ) : null}
          </p>
        </div>
        {canScan ? (
          <div className="flex flex-wrap gap-2">
            {s.previousScan ? (
              <Button variant="outline" size="sm" onClick={() => setCompareOpen(true)}>
                与上次扫描对比
              </Button>
            ) : null}
            {s.canRescan ? (
              <Button
                variant="outline"
                size="sm"
                disabled={rescan.isPending}
                onClick={() => rescan.mutate()}
              >
                重新扫描
              </Button>
            ) : null}
            {s.status === 'COMPLETED' && !s.linkedTaskId ? (
              <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
                关联评估任务
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="text-severity-critical"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm('确定删除该扫描记录？已关联到评估任务的发现项会保留在任务中。'))
                  remove.mutate();
              }}
            >
              删除
            </Button>
          </div>
        ) : null}
      </div>
      {s.status === 'FAILED' ? (
        <p className="rounded-lg border border-severity-critical/40 px-3 py-2 text-sm text-severity-critical">
          扫描失败：{s.error}
        </p>
      ) : null}
      {skipped.length ? (
        <details
          className="rounded-lg border border-slate-200 text-xs"
          open={s.status === 'FAILED'}
        >
          <summary className="cursor-pointer px-3 py-2 text-slate-700">
            跳过的文件 {skipped.length} 个
            {s.skippedCount > skipped.length
              ? `（共 ${s.skippedCount} 个，仅列出前 ${skipped.length} 个）`
              : ''}
          </summary>
          <div role="group" aria-label="跳过的文件">
            <table className="w-full border-t border-slate-200">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr className="h-10">
                  <th className="px-3 font-normal">文件</th>
                  <th className="px-3 font-normal">跳过原因</th>
                </tr>
              </thead>
              <tbody>
                {skipped.map((f) => (
                  <tr key={f.path} className="h-10 border-t border-slate-100">
                    <td className="break-all px-3 text-slate-800">{f.path}</td>
                    <td className="px-3 text-slate-600">{f.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
      {s.linkedTaskId ? (
        <p className="text-xs text-slate-600">
          已关联评估任务“{s.linkedTaskName ?? s.linkedTaskId}”（{formatDateTime(s.linkedAt)}
          ），发现项会出现在该任务的报告中。
        </p>
      ) : null}
      {s.status === 'COMPLETED' ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-700">发现项 {findings.data?.length ?? 0}</span>
            <Select
              aria-label="按风险等级筛选"
              className="w-32"
              value={sev}
              onChange={(e) => setSev(e.target.value)}
            >
              <option value="">全部等级</option>
              <option value="HIGH">高危及以上</option>
              <option value="MEDIUM">中危</option>
              <option value="LOW">低危</option>
            </Select>
          </div>
          {findings.isLoading ? (
            <LoadingBlock />
          ) : items.length ? (
            items.map((f) => <FindingCard key={f.id} f={f} scanId={id} canScan={canScan} />)
          ) : (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500">
              {findings.data?.length
                ? '当前筛选条件下没有发现项。'
                : '未发现风险。静态分析不执行代码，动态行为请到 评估任务 · 智能体行为与工具 评估。'}
            </p>
          )}
        </div>
      ) : null}
      {linkOpen ? (
        <LinkTaskModal
          scanId={id}
          onClose={() => setLinkOpen(false)}
          onDone={() => {
            setLinkOpen(false);
            void qc.invalidateQueries({ queryKey: ['ai-components'] });
          }}
        />
      ) : null}
      {compareOpen && s.previousScan ? (
        <Modal
          open
          onClose={() => setCompareOpen(false)}
          title="与上次扫描对比"
          description={`上次：${s.previousScan.assetVersion ?? '未标版本'} · ${formatDateTime(s.previousScan.createdAt)}`}
          size="lg"
        >
          <CompareView base={s.previousScan.id} target={s.id} />
        </Modal>
      ) : null}
    </div>
  );
}

function LinkTaskModal({
  scanId,
  onClose,
  onDone,
}: {
  scanId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [taskId, setTaskId] = useState('');
  const [includeFp, setIncludeFp] = useState(false);
  const tasks = useQuery({
    queryKey: ['ai-components', 'tasks'],
    queryFn: () => api.evalTasks.list({ page: 1, pageSize: 100 }),
  });
  const link = useMutation({
    mutationFn: () => aiComponentsApi.linkTask(scanId, { taskId, includeFalsePositive: includeFp }),
    onSuccess: (r) => {
      toast.success(`已关联到“${r.taskName}”，带入 ${r.linkedCount} 条发现`);
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '关联失败'),
  });
  const list = tasks.data?.items ?? [];
  return (
    <Modal
      open
      onClose={onClose}
      title="关联评估任务"
      description="关联后，本次扫描的发现项会写入所选任务，并出现在该任务的评估报告中。关联后不可撤销。"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!taskId || link.isPending} onClick={() => link.mutate()}>
            确认关联
          </Button>
        </>
      }
    >
      {tasks.isLoading ? (
        <LoadingBlock />
      ) : list.length === 0 ? (
        <p className="text-sm text-slate-600">
          还没有评估任务。可到 评估中心 · 评估任务 新建后再关联；不关联也不影响扫描结果查看。
        </p>
      ) : (
        <div className="space-y-3">
          <Select aria-label="评估任务" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">请选择评估任务</option>
            {list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={includeFp}
              onChange={(e) => setIncludeFp(e.target.checked)}
            />
            同时带入已标记为误报的发现项
          </label>
        </div>
      )}
    </Modal>
  );
}
