import { checkLabel, checkHint } from './CheckPresentation';
import { useQuery } from '@tanstack/react-query';
import { ragEvalApi, type RagAlignmentMode } from '@/lib/api';
import { Button } from '@/components/ui/button';

export const targetProbeKey = (id: string, mode: RagAlignmentMode) => ['rag-eval', 'connection', id, mode];
export function useTargetProbe(id: string, mode: RagAlignmentMode) {
  return useQuery({ queryKey: targetProbeKey(id, mode), queryFn: () => ragEvalApi.checkTarget(id, mode), enabled: false, retry: false, staleTime: 0 });
}

/** 试连不写入评估记录，空检索响应如实显示为未配置或本次未返回。 */
export function ConnectionProbe({ id, mode }: { id: string; mode: RagAlignmentMode }) {
  const probe = useTargetProbe(id, mode);
  return <div className="space-y-3">
    <Button variant="outline" disabled={probe.isFetching} onClick={() => void probe.refetch()}>
      {probe.isFetching ? '试连中…' : '试连'}
    </Button>
    {probe.error && <p role="alert" className="text-sm text-severity-critical">试连失败，请检查网络后重试。</p>}
    {probe.data && <div aria-label="试连结果" className="rounded-card border border-line text-sm">
      <p className="border-b border-line px-3 py-2">{probe.data.ok ? '试连通过' : '试连失败'} · {probe.data.httpStatus ? `HTTP ${probe.data.httpStatus} · ` : ''}{probe.data.latencyMs} 毫秒</p>
      <ul className="divide-y divide-line">
        {probe.data.checks.map(c => <li key={c.key} className="flex gap-3 px-3 py-2">
          <span className={c.status === 'fail' ? 'text-severity-critical' : c.status === 'pass' ? 'text-severity-pass' : 'text-ink-3'}>{c.status === 'pass' ? '通过' : c.status === 'fail' ? '失败' : '未配置'}</span>
          <span className="flex-1">{checkLabel(c.key.replace(/^config\./, ''), c.label)}{(c.key.startsWith('config.') ? c.status !== 'pass' && checkHint(c.key.slice(7)) : c.reason) && <span className="block text-xs text-ink-3">{c.key.startsWith('config.') ? checkHint(c.key.slice(7)) : c.reason}</span>}</span>
        </li>)}
      </ul>
    </div>}
  </div>;
}
