import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, type EndpointTaskSummary } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { Pagination } from '@/components/ui/pagination';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';

const STATUS = { ready: '可测', needs_attention: '需处理', unsupported: '不支持', offline: '终端离线', platform_managed: '平台管理' } as const;
const OUTCOMES = { allowed: '照做', control_blocked: '被拦截', model_refused: '识破', invalid: '无效' } as const;
type Outcome = keyof typeof OUTCOMES;
const priority: Record<Outcome, number> = { allowed: 4, control_blocked: 3, model_refused: 2, invalid: 1 };

export function AgentProfilePage() {
  const { endpointId = '', agentKey = '' } = useParams();
  const { hasPermission } = useAuth();
  const [page, setPage] = useState(1);
  const canReadTasks = hasPermission('eval_task:read');
  const agentQuery = useQuery({ queryKey: ['fleet', 'agents', 'profile', endpointId],
    queryFn: () => api.fleet.agents({ endpointId, page: 1, pageSize: 100 }), enabled: !!endpointId, retry: false });
  const jobsQuery = useQuery({ queryKey: ['fleet', 'agent-history', endpointId, agentKey, page],
    queryFn: () => api.fleet.evalJobs({ endpointId, product: agentKey, page, pageSize: 10 }),
    enabled: !!endpointId && !!agentKey && canReadTasks, retry: false });
  const sampleQuery = useQuery({ queryKey: ['agent-samples'], queryFn: api.agentSamples.list, retry: false });
  const jobs = jobsQuery.data?.items ?? [];
  const summaries = useQueries({ queries: jobs.map((job) => ({ queryKey: ['endpoint-task-summary', job.evalTaskId],
    queryFn: () => api.evalTasks.endpointSummary(job.evalTaskId!),
    enabled: !!job.evalTaskId && ['COMPLETED', 'FAILED'].includes(job.status), retry: false })) });
  const agent = agentQuery.data?.items.find((row) => row.agentKey === agentKey);
  const knownSamples = new Map((sampleQuery.data?.items ?? []).map((sample) => [sample.id, sample.title]));
  const matrix = new Map<string, { title: string; outcomes: Map<string, Outcome> }>();
  const collect = (summary: EndpointTaskSummary, taskId: string) => {
    for (const scenario of summary.liveScenarios) {
      const raw = scenario.runtime?.sample_id || scenario.scenarioId;
      const base = raw.replace(/\.(?:py|node)$/, '');
      const id = knownSamples.has(raw) ? raw : knownSamples.has(base) ? base : raw;
      const outcome = scenario.outcome;
      if (!id || !outcome) continue;
      const item = matrix.get(id) ?? { title: knownSamples.get(id) || scenario.sampleTitle || id, outcomes: new Map<string, Outcome>() };
      const existing = item.outcomes.get(taskId);
      if (!existing || priority[outcome] > priority[existing]) item.outcomes.set(taskId, outcome);
      matrix.set(id, item);
    }
  };
  jobs.forEach((job, index) => { const data = summaries[index]?.data; if (job.evalTaskId && data) collect(data, job.evalTaskId); });
  return <main className="space-y-6">
    <nav className="text-sm"><Link className="text-brand-700 hover:underline" to="/fleet">终端与智能体</Link> / 智能体档案</nav>
    {agentQuery.isLoading ? <p role="status">正在读取智能体…</p> : agentQuery.isError ? <p role="alert">智能体读取失败。</p> : !agent ? <p>智能体未上报或终端已吊销。</p> : <>
      <PageHeader title={agent.agentName} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <Link className="text-brand-700 hover:underline" to={`/fleet/endpoints/${encodeURIComponent(endpointId)}`}>{agent.endpointName}</Link>
        <span>{agent.version || '版本未知'}</span><span>{STATUS[agent.status]}{agent.status === 'ready' ? ` · ${agent.scope === 'all' ? '全部样本' : '基础场景（使用真实配置）'}` : ''}</span>
        <span>{agent.latest?.conclusion || (agent.latest ? '结论未上报' : '暂无测评')}</span>
        {agent.status === 'ready' && hasPermission('model_target:create') && hasPermission('eval_task:create') &&
          <Link className="font-medium text-brand-700 underline" to={`/agent-evals/new?endpoint=${encodeURIComponent(endpointId)}&agent=${encodeURIComponent(agentKey)}`}>发起测评</Link>}
      </div>
      <section className="space-y-3"><h2 className="text-base font-semibold">测评历史</h2>
        {!canReadTasks ? <p>没有查看测评任务的权限。</p> : jobsQuery.isLoading ? <p role="status">正在读取测评历史…</p> : jobsQuery.isError ? <p role="alert">测评历史读取失败。</p> : <>
          <Table><THead><TR><TH>发起时间</TH><TH>状态</TH><TH>场景数</TH><TH>结论</TH><TH>任务</TH></TR></THead><TBody>
            {jobs.map((job, index) => <TR key={job.id}><TD data-label="发起时间">{formatDateTime(job.createdAt)}</TD><TD data-label="状态">{job.statusLabel}</TD><TD data-label="场景数">{job.scenarioCount}</TD>
              <TD data-label="结论">{summaries[index]?.data?.verdictLine || (summaries[index]?.isError ? '结论读取失败' : '未上报')}</TD>
              <TD data-label="任务">{job.evalTaskId ? <Link className="text-brand-700 underline" to={`/eval-tasks/${encodeURIComponent(job.evalTaskId)}`}>查看任务</Link> : '未关联'}</TD></TR>)}
          </TBody></Table>
          {!jobs.length && <p className="py-3 text-sm text-ink-3">暂无测评历史</p>}
          <Pagination page={page} pageSize={10} total={jobsQuery.data?.total ?? 0} onPageChange={setPage} />
        </>}
      </section>
      {jobs.length > 0 && <section className="space-y-3"><h2 className="text-base font-semibold">样本结论矩阵</h2>
        {summaries.some((query) => query.isLoading && query.fetchStatus !== 'idle') ? <p role="status">正在读取样本结论…</p> : <>
          {matrix.size ? <Table><THead><TR><TH>样本</TH>{jobs.map((job) => <TH key={job.id}>{formatDateTime(job.createdAt)}</TH>)}</TR></THead><TBody>
            {[...matrix].map(([id, row]) => <TR key={id}><TD data-label="样本">{row.title}</TD>{jobs.map((job, index) => <TD key={job.id} data-label={formatDateTime(job.createdAt)}>
              {job.evalTaskId && row.outcomes.has(job.evalTaskId) ? OUTCOMES[row.outcomes.get(job.evalTaskId)!] : summaries[index]?.isError ? '读取失败' : '未记录'}
            </TD>)}</TR>)}
          </TBody></Table> : <p className="text-sm text-ink-3">当前任务未记录样本结论。</p>}
        </>}
      </section>}
    </>}
  </main>;
}
