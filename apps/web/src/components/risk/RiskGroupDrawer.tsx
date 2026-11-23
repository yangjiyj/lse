import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { RiskGroupDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { RiskSeverityBadge } from './RiskSeverityBadge';
import { riskDate } from './risk-date';

export function RiskGroupDrawer({ detail, loading, failed, canReview, busy, onClose, onReview }: {
  detail?: RiskGroupDetail;
  loading: boolean;
  failed: boolean;
  canReview: boolean;
  busy: boolean;
  onClose: () => void;
  onReview: (status: 'CONFIRMED' | 'FALSE_POSITIVE') => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeAction = useRef(onClose);
  closeAction.current = onClose;
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeAction.current(); };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); trigger?.focus(); };
  }, []);
  const representative = detail?.representative;
  const observations = new Map<string, string>();
  for (const item of detail?.observations ?? []) {
    if (!observations.has(item.targetName) || observations.get(item.targetName)! < item.createdAt) observations.set(item.targetName, item.createdAt);
  }
  return <aside role="dialog" aria-modal="false" aria-label={detail?.title ?? '问题详情'}
    className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[470px] flex-col border-l border-line bg-white shadow-[-12px_0_36px_rgba(15,23,42,0.08)] lg:sticky lg:top-0 lg:z-10 lg:h-[calc(100vh-150px)] lg:min-h-[560px] lg:max-w-none">
    <header className="border-b border-line px-6 py-5">
      <button ref={closeRef} type="button" aria-label="关闭问题详情" onClick={onClose} className="float-right rounded p-1 text-ink-3 hover:bg-slate-100"><X className="h-4 w-4" /></button>
      {detail && <><div className="flex items-center gap-2"><RiskSeverityBadge value={detail.severity} /><span className="rounded bg-[#EEF2F7] px-2 py-0.5 text-xs text-ink-2">{detail.sampleCount} 个样本</span><span className="rounded border border-line px-2 py-0.5 text-xs text-ink-3">{detail.status}</span></div>
        <h2 className="mt-3 pr-5 text-base font-semibold leading-6 text-ink">{detail.title}</h2></>}
    </header>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto break-words px-6 py-5 text-[13px] leading-[22px]">
      {loading && <p role="status">正在加载问题详情…</p>}
      {failed && <p role="alert">问题详情加载失败，请关闭后重试</p>}
      {detail && representative && <>
        <section><h3 className="mb-1.5 text-xs font-medium text-ink-3">典型样本</h3>
          <blockquote className="max-h-[220px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-[#F8FAFD] px-3 py-2.5 text-ink-2">{representative.questionContent || '没有样本快照'}</blockquote>
          {representative.modelResponse && <details className="mt-2"><summary className="cursor-pointer text-ink-3">查看模型回答</summary><p className="mt-2 whitespace-pre-wrap text-ink-2">{representative.modelResponse}</p></details>}
        </section>
        <section><h3 className="mb-1.5 text-xs font-medium text-ink-3">模型的反应</h3><p>{representative.modelReaction}
          {representative.sandboxBlocked && <span className="ml-2 rounded bg-[#FFF6D6] px-1.5 py-0.5 text-xs text-[#8A5F00]">被评估沙箱拦下</span>}</p>
          {representative.suspectedFalsePositive && <p className="mt-1 text-[#8A5F00]">{representative.reason}</p>}
        </section>
        <section><h3 className="mb-1.5 text-xs font-medium text-ink-3">评估对象与时间</h3>
          <dl className="space-y-1">{[...observations].map(([name, date]) => <div key={name} className="flex justify-between gap-4"><dt className="min-w-0 break-all">{name}</dt><dd className="shrink-0 tabular-nums text-ink-3">{riskDate(date)}</dd></div>)}</dl>
        </section>
        <section><h3 className="mb-1.5 text-xs font-medium text-ink-3">整改建议</h3>
          <ul className="list-disc space-y-1 pl-4">{detail.remediation.map(action => <li key={action}>{action}</li>)}</ul>
        </section>
      </>}
    </div>
    {canReview && detail?.actionable && detail.status !== '已关闭' && <footer className="flex justify-end gap-2 border-t border-line px-6 py-4">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onReview('FALSE_POSITIVE')}>判为误报</Button>
      <Button size="sm" disabled={busy} onClick={() => onReview('CONFIRMED')}>确认风险</Button>
    </footer>}
  </aside>;
}
