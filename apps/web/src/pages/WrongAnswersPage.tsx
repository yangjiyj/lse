import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RISK_DOMAIN, RISK_DOMAIN_LABELS, type RiskDomain } from '@lse/shared';
import { api, type RiskGroupQuery } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { SegmentTabs } from '@/components/page-kit/SegmentTabs';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { RiskGroupTable } from '@/components/risk/RiskGroupTable';
import { RiskGroupDrawer } from '@/components/risk/RiskGroupDrawer';
import { TenantFilterSelect, useTenantView } from '@/lib/tenant-view';
import { riskDate } from '@/components/risk/risk-date';

type Status = NonNullable<RiskGroupQuery['status']>;
const levels = [['CRITICAL', '严重'], ['HIGH', '高危'], ['MEDIUM', '中危'], ['LOW', '低危'], ['INFO', '提示']];
const isDomain = (value: string | null): value is RiskDomain => (RISK_DOMAIN as readonly string[]).includes(value ?? '');
/** URL 里的时间（首页下钻带来的 ISO 时间）；认不出的忽略。 */
const validTime = (value: string | null): string | undefined => value && !Number.isNaN(Date.parse(value)) ? value : undefined;
/** 日期标签（北京时间）：只有起点「11-01 起」；until 是开区间上界，显示到它前一刻那天：同一天「11-05」，跨天「11-01～11-05」。 */
function dateLabel(since?: string, until?: string): string | null {
  const last = until ? riskDate(new Date(Date.parse(until) - 1).toISOString(), true) : null;
  const first = since ? riskDate(since, true) : null;
  if (first && last) return first === last ? first : `${first}～${last}`;
  if (first) return `${first} 起`;
  return last ? `截至 ${last}` : null;
}

export function WrongAnswersPage() {
  const [params, setParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const { listParams } = useTenantView();
  const { success, error } = useToast();
  const client = useQueryClient();
  const initialReview = params.get('reviewStatus');
  const [status, setStatus] = useState<Status>(initialReview && initialReview !== 'pending' ? '全部' : '待确认');
  const [severity, setSeverity] = useState(params.get('severity')?.split(',')[0] ?? '');
  // 风险类别、时间范围以 URL 为准（首页下钻带 ?domain=、?since=&until=），改了写回 URL；认不出的忽略。
  const domainParam = params.get('domain');
  const domain: RiskDomain | '' = isDomain(domainParam) ? domainParam : '';
  const since = validTime(params.get('since'));
  const until = validTime(params.get('until'));
  const dates = dateLabel(since, until);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const taskId = params.get('taskId') ?? undefined;
  const findingIds = params.get('findingIds') ?? undefined;
  const agentRisk = params.get('agentRisk') === 'true';
  const review = params.get('reviewStatus');
  const scope: RiskGroupQuery = { ...listParams, taskId, findingIds, agentRisk, domain: domain || undefined, since, until,
    reviewStatus: review && !['all', 'pending'].includes(review) ? review.split(',') : undefined };
  const query: RiskGroupQuery = { ...scope, status, severity: severity ? [severity] : undefined, page, pageSize: 15 };
  const groups = useQuery({ queryKey: ['risk-groups', query], queryFn: () => api.wrongAnswers.groups(query) });
  const detail = useQuery({ queryKey: ['risk-group', selected, scope],
    queryFn: () => api.wrongAnswers.group(selected!, scope), enabled: Boolean(selected) });
  const canReview = hasPermission('remediation:update');
  const canExport = hasPermission('wrong_answer:export');
  const counts = groups.data?.counts;
  // 导出接口还不按类别和日期过滤（与 W4 的导出改造合并后再补），选了它们时先不让导出，免得导出范围和列表对不上。

  function updateParams(change: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(params);
    change(next);
    setParams(next, { replace: true });
    setPage(1);
    setSelected(null);
  }
  function changeDomain(value: RiskDomain | '') {
    updateParams(next => { if (value) next.set('domain', value); else next.delete('domain'); });
  }
  function clearDates() {
    updateParams(next => { next.delete('since'); next.delete('until'); });
  }

  function changeStatus(value: Status) {
    setStatus(value);
    setPage(1);
    setSelected(null);
    if (params.has('reviewStatus')) {
      const next = new URLSearchParams(params);
      next.delete('reviewStatus');
      setParams(next, { replace: true });
    }
  }
  async function exportSamples() {
    if (!taskId || exporting) return;
    setExporting(true);
    try {
      await api.wrongAnswers.export(taskId, severity ? [severity] : undefined, agentRisk, findingIds,
        { domain: domain || undefined, since: since || undefined, until: until || undefined });
    }
    catch { error('导出失败，请重试'); }
    finally { setExporting(false); }
  }
  async function reviewGroup(value: 'CONFIRMED' | 'FALSE_POSITIVE') {
    if (!detail.data?.actionable || !canReview || busy) return;
    setBusy(true);
    let completed = 0;
    try {
      for (const ref of detail.data.findingRefs) {
        await api.remediation.review(ref.findingId, { status: value, reason: value === 'FALSE_POSITIVE' ? '人工确认误报' : '人工确认风险' });
        completed++;
      }
      success(`已将 ${completed} 条发现${value === 'FALSE_POSITIVE' ? '判为误报' : '确认为风险'}`);
      setSelected(null);
    } catch { error(`已处理 ${completed} 条，其余发现处理失败，请刷新后重试`); }
    finally {
      setBusy(false);
      await Promise.all([client.invalidateQueries({ queryKey: ['risk-groups'] }), client.invalidateQueries({ queryKey: ['risk-group'] })]);
    }
  }
  return <div className="space-y-5">
    <header className="flex items-center justify-between gap-4">
      <h1 className="text-xl font-semibold text-ink">风险处置台</h1>
      <Button variant="outline" size="sm" disabled={!taskId || !canExport || exporting}
        title={!taskId ? '先在评估任务中选择任务' : undefined} onClick={() => void exportSamples()}>导出</Button>
    </header>
    <div className={selected ? 'grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_470px]' : ''}>
      <div className="min-w-0">
        <FilterBar>
          <TenantFilterSelect />
          <SegmentTabs<Status> size="sm" ariaLabel="处置状态" value={status} onChange={changeStatus}
            items={[{ value: '待确认', label: `待确认 ${counts?.待确认 ?? 0}` }, { value: '整改中', label: `整改中 ${counts?.整改中 ?? 0}` },
              { value: '已关闭', label: `已关闭 ${counts?.已关闭 ?? 0}` }, { value: '全部', label: '全部' }]} />
          <select aria-label="风险等级" value={severity} onChange={e => { setSeverity(e.target.value); setPage(1); setSelected(null); }}
            className="h-8 rounded-lg border border-line bg-white px-3 text-[13px] text-ink-2">
            <option value="">全部等级</option>{levels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="风险类别" value={domain} onChange={e => changeDomain(e.target.value as RiskDomain | '')}
            className="h-8 rounded-lg border border-line bg-white px-3 text-[13px] text-ink-2">
            <option value="">全部类别</option>{RISK_DOMAIN.map(value => <option key={value} value={value}>{RISK_DOMAIN_LABELS[value]}</option>)}
          </select>
          {dates && <span className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white pl-3 pr-1 text-[13px] text-ink-2">
            {dates}
            <button type="button" aria-label="清除日期" onClick={clearDates}
              className="grid h-6 w-6 place-items-center rounded-md text-ink-3 hover:bg-canvas hover:text-ink"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
          </span>}
          {(taskId || findingIds || agentRisk || domain || dates) && <Button size="sm" variant="ghost" onClick={() => { setParams({}); setPage(1); setSelected(null); }}>查看全部问题</Button>}
        </FilterBar>
        {groups.isLoading ? <p role="status" className="p-8 text-center text-sm text-ink-3">正在加载风险问题…</p> : groups.isError ?
          <div role="alert" className="p-8 text-center text-sm text-red-700">风险问题加载失败<Button variant="ghost" onClick={() => void groups.refetch()}>重试</Button></div> :
          !groups.data?.items.length ? <p className="rounded-xl border border-line bg-white p-12 text-center text-sm text-ink-3">没有待处理的风险</p> :
            <><RiskGroupTable items={groups.data.items} selectedId={selected} onSelect={setSelected} />
              <Pagination page={page} pageSize={15} total={groups.data.total} onPageChange={value => { setPage(value); setSelected(null); }} /></>}
      </div>
      {selected && <RiskGroupDrawer key={selected} detail={detail.data} loading={detail.isLoading} failed={detail.isError}
        busy={busy} canReview={canReview} onClose={() => setSelected(null)} onReview={value => void reviewGroup(value)} />}
    </div>
  </div>;
}
