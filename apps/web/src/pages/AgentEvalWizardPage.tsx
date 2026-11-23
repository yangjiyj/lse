import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, ChevronDown, ChevronRight, Monitor, ShieldCheck } from 'lucide-react';
import { api, type AgentEvalSelection, type AgentSample, type FleetEndpointAgent } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { Pagination } from '@/components/ui/pagination';
import { SampleDetails } from '@/components/agent-samples/SampleDetails';
import { FLEET_LIVE_PRODUCTS, FLEET_LIVE_PRODUCT_LABELS, type FleetLiveProduct } from '../../../../packages/shared/src/fleet-live-eval';
import type { RuntimeArm, RuntimeTemplate } from '../../../../packages/shared/src/runtime-eval';

const STEPS = ['对象', '样本', '设置', '确认'];
const PLAN_LABEL: Record<string, string> = { quick: '快速', standard: '标准', full: '完整' };
const PROJECT_LABEL: Record<RuntimeTemplate, string> = { 'py-service-v1': 'Python 库存服务', 'node-api-v1': 'Node 订单接口' };
const productLabel = (value: string) => FLEET_LIVE_PRODUCT_LABELS[value as FleetLiveProduct] ?? value;
const message = (error: unknown) => error instanceof Error ? error.message : '请求失败，请重试。';
const duration = (seconds: number) => seconds < 60 ? `${seconds} 秒` : seconds < 3600
  ? `约 ${Math.ceil(seconds / 60)} 分钟` : `约 ${Math.floor(seconds / 3600)} 小时 ${Math.ceil((seconds % 3600) / 60)} 分钟`;

export function AgentEvalWizardPage() {
  const [params] = useSearchParams();
  const trial = params.get('trial') === '1';
  const [step, setStep] = useState(0);
  const [samplePage, setSamplePage] = useState(1);
  const [endpointId, setEndpointId] = useState(params.get('endpoint') ?? '');
  const [endpointSearch, setEndpointSearch] = useState('');
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [products, setProducts] = useState<string[]>(params.get('agent') ? [params.get('agent')!] : []);
  const [sampleIds, setSampleIds] = useState<string[]>([...new Set(params.getAll('sample'))]);
  const [sampleVersions, setSampleVersions] = useState<Array<{ id: string; version: number }>>(() => {
    const id = params.get('sample'); const version = Number(params.get('version'));
    return id && Number.isInteger(version) && version > 0 ? [{ id, version }] : [];
  });
  const [tier, setTier] = useState('custom');
  const [arms, setArms] = useState<RuntimeArm[]>(['observe']);
  const [repeat, setRepeat] = useState(1);
  const [templates, setTemplates] = useState<RuntimeTemplate[]>(['py-service-v1']);
  const [category, setCategory] = useState('');
  const [harm, setHarm] = useState('');
  const [location, setLocation] = useState('');
  const [project, setProject] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<AgentSample | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const endpoints = useQuery({ queryKey: ['fleet', 'wizard-endpoints', endpointSearch],
    queryFn: () => api.fleet.endpoints({ page: 1, pageSize: 100, ...(endpointSearch ? { q: endpointSearch } : {}) }) });
  const endpoint = useQuery({ queryKey: ['fleet', 'wizard-endpoint', endpointId],
    queryFn: () => api.fleet.endpoint(endpointId), enabled: !!endpointId });
  const overview = useQuery({ queryKey: ['fleet', 'wizard-overview', endpointId],
    queryFn: () => api.fleet.overview(endpointId), enabled: !!endpointId });
  const samples = useQuery({ queryKey: ['agent-samples'], queryFn: api.agentSamples.list });
  const plans = useQuery({ queryKey: ['agent-sample-plans'], queryFn: api.agentSamples.plans });
  const pin = sampleVersions.length === 1 ? sampleVersions[0] : undefined;
  const pinnedSample = useQuery({ queryKey: ['agent-sample', pin?.id, pin?.version],
    queryFn: () => api.agentSamples.get(pin!.id, pin!.version), enabled: !!pin, retry: false });
  const endpointOptions = [...(endpoints.data?.items ?? [])];
  if (endpoint.data && !endpointOptions.some((item) => item.id === endpoint.data!.id)) endpointOptions.unshift(endpoint.data);
  const allSamples = (samples.data?.items ?? []).map((item) => pinnedSample.data?.id === item.id ? pinnedSample.data : item);
  const chosenSamples = allSamples.filter((item) => sampleIds.includes(item.id));
  const requiredTemplate = chosenSamples[0]?.template;
  useEffect(() => {
    if (trial && (requiredTemplate === 'py-service-v1' || requiredTemplate === 'node-api-v1')) setTemplates([requiredTemplate]);
  }, [trial, requiredTemplate]);
  const runtimeSelected = chosenSamples.some((item) => item.suite === 'runtime_v2');
  const fromOverview: FleetEndpointAgent[] = (overview.data?.agents ?? []).map((agent) => ({
    product: agent.key, displayName: agent.name, version: agent.version,
    liveEvalSupported: agent.liveEval.supported, liveEvalRegistered: agent.liveEval.registered,
    ...(agent.liveEval.reason ? { liveEvalBlockedReason: agent.liveEval.reason } : {}), runtimeV2: agent.runtimeV2,
  }));
  const rawAgents = endpoint.data?.agents ?? fromOverview;
  const agents = [...new Map(rawAgents.map((agent) => [agent.product, agent])).values()];
  const blocked = (agent: FleetEndpointAgent) => {
    if (!endpoint.data?.online) return '终端离线';
    if (!endpoint.data.evalRunner) return '终端未上报执行器';
    if (!agent.liveEvalSupported) return '不支持';
    if (!agent.liveEvalRegistered || agent.liveEvalBlockedReason) return agent.liveEvalBlockedReason || '尚未登记';
    if (trial && agent.product !== 'claude-code') return '试运行仅支持 Claude Code';
    if (runtimeSelected && agent.product !== 'claude-code') return '所选样本仅支持 Claude Code';
    if (runtimeSelected && !agent.runtimeV2) return '终端未上报运行态沙箱能力';
    return '';
  };
  const selectedProducts = products.filter((value): value is FleetLiveProduct =>
    (FLEET_LIVE_PRODUCTS as readonly string[]).includes(value) && agents.some((agent) => agent.product === value && !blocked(agent)));
  const selection: AgentEvalSelection = { products: selectedProducts, sampleIds, arms, repeat, templates,
    ...(sampleVersions.length ? { sampleVersions } : {}), ...(trial ? { trial: true } : {}) };
  const canEstimate = !!endpointId && selectedProducts.length > 0 && sampleIds.length > 0 &&
    chosenSamples.length === sampleIds.length && templates.length > 0 && !overview.isLoading && !endpoint.isLoading && !overview.isError && !endpoint.isError &&
    (!pin || (!pinnedSample.isLoading && !pinnedSample.isError));
  const estimate = useQuery({ queryKey: ['fleet', 'agent-eval-estimate', selection],
    queryFn: () => api.fleet.estimateEvalJobs(selection), enabled: canEstimate, retry: false });
  const batch = useMutation({ mutationFn: () => api.fleet.createEvalBatch(endpointId, { ...selection, acknowledged: true }) });
  const toggle = (items: string[], value: string) => items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
  const setChosenSamples = (ids: string[]) => { setSampleIds(ids); setSampleVersions([]); setTier('custom'); setAcknowledged(false); };
  const sampleBlocked = (sample: AgentSample) => {
    if (sample.enabled === false) return '样本已停用';
    if (sample.suite !== 'runtime_v2') return '';
    if (selectedProducts.length !== 1 || selectedProducts[0] !== 'claude-code') return '仅支持 Claude Code';
    if (!agents.find((agent) => agent.product === 'claude-code')?.runtimeV2) return '终端未上报运行态沙箱能力';
    return '';
  };
  const filtered = allSamples.filter((item) => (!search || `${item.title} ${item.locations.join(' ')}`.toLowerCase().includes(search.toLowerCase())) &&
    (!category || item.vectorLabel === category) && (!harm || item.harmLabel === harm) &&
    (!location || item.locations.includes(location)) && (!project || item.template === project || item.template === 'any') &&
    (!agentFilter || item.agents.includes(agentFilter)));
  const choices = (values: string[]) => [...new Set(values)].sort();
  const next = () => { setAcknowledged(false); setStep((value) => Math.min(3, value + 1)); };
  const previous = () => { setAcknowledged(false); setStep((value) => Math.max(0, value - 1)); };
  const hasRealConfig = chosenSamples.some((sample) => sample.environment === 'real_config');

  if (batch.isSuccess) return <main><PageHeader title="测评已发起" /><div className="space-y-3">
    <p>已创建 {batch.data.jobs.length} 个任务，共 {batch.data.scenarioCount} 个场景。</p>
    {batch.data.jobs.map((job, index) => job.taskId && <p key={job.taskId}><Link className="font-medium text-brand-700 underline" to={`/eval-tasks/${job.taskId}`}>查看任务 {index + 1}</Link></p>)}
    <Link className="text-brand-700 underline" to="/eval-tasks">查看全部评估任务</Link>
  </div></main>;

  return <main className="min-w-0">
    <PageHeader title={trial ? '试运行样本' : '发起智能体测评'} />
    <ol aria-label="测评步骤" className="mb-7 flex min-w-0 items-center border-b border-line pb-4 text-sm">
      {STEPS.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1.5 ${step === index ? 'font-semibold text-brand-700' : 'text-ink-3'}`}>
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${index <= step ? 'border-brand-600 bg-brand-700 text-white' : 'border-line-2 bg-white'}`}>{index < step ? <Check className="h-4 w-4" /> : index + 1}</span>
        <span>{label}</span>{index < STEPS.length - 1 && <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-ink-3" />}
      </li>)}
    </ol>
    {step === 0 && <section className="max-w-3xl space-y-5">
      <div><label htmlFor="wizard-endpoint" className="mb-1 block text-sm font-medium">测评终端</label>
        <Select id="wizard-endpoint" value={endpointId} onChange={(event) => { setEndpointId(event.target.value); setProducts([]); setAcknowledged(false); }}>
          <option value="">选择终端</option>{endpointOptions.filter((item) => item.status === 'ACTIVE').map((item) => <option key={item.id} value={item.id}>{item.hostname}</option>)}
        </Select>
        {(endpoints.data?.total ?? 0) > 20 && <Input className="mt-2" aria-label="筛选终端" placeholder="输入主机名筛选终端" value={endpointSearch} onChange={(event) => setEndpointSearch(event.target.value)} />}
      </div>
      {!endpointOptions.length && !endpoints.isLoading && <p className="text-sm text-ink-3">暂无终端。<Link className="ml-2 text-brand-700 underline" to="/fleet?tab=enroll">接入终端</Link></p>}
      {endpoints.isError && <p role="alert">终端清单读取失败：{message(endpoints.error)}</p>}
      {endpointId && (endpoint.isLoading || overview.isLoading) && <LoadingBlock label="正在读取终端能力" />}
      {endpointId && (endpoint.isError || overview.isError) && <p role="alert">终端能力读取失败，请重试。</p>}
      {endpoint.data && !endpoint.isLoading && !overview.isLoading && <>
        <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-line pb-4 text-sm text-ink-3">
          <span className="flex items-center gap-1.5"><Monitor className="h-4 w-4" />{endpoint.data.online ? '在线' : '离线'}</span>
          <span>测评执行器：{endpoint.data.evalRunner ? '已就绪' : '未上报'}</span>
          <span className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" />沙箱：{endpoint.data.health?.capabilities?.eval_sandbox_v2 === '1' ? '已就绪' : '未上报'}</span>
        </div>
        <fieldset><legend className="mb-2 font-medium">智能体</legend>
          {!agents.length && <p className="text-sm text-ink-3">终端尚未上报智能体。</p>}
          {agents.length > 0 && <button type="button" aria-label="选择智能体" aria-expanded={agentsOpen}
            onClick={() => setAgentsOpen(!agentsOpen)} className="flex min-h-10 w-full items-center justify-between gap-3 rounded-md border border-line-2 bg-white px-3 text-left text-sm">
            <span>{selectedProducts.length ? selectedProducts.map(productLabel).join('、') : '选择一个或多个智能体'}</span><ChevronDown className="h-4 w-4 shrink-0" />
          </button>}
          {agentsOpen && <div className="mt-1 max-h-64 overflow-y-auto rounded-md border border-line bg-white px-3">{agents.map((agent) => {
            const reason = blocked(agent);
            return <label key={agent.product} className="flex min-h-14 items-start gap-3 py-3 text-sm">
              <input type="checkbox" className="mt-1" checked={!reason && products.includes(agent.product)} disabled={!!reason}
                onChange={() => { setProducts(toggle(products, agent.product)); setAcknowledged(false); }} />
              <span className="min-w-0 flex-1"><span className="font-medium">{agent.displayName || productLabel(agent.product)}</span>
                <span className="ml-2 text-ink-3">{agent.version || '版本未知'}</span>
                <span className="block text-ink-3">{reason || '已登记，可测'}</span></span>
            </label>;
          })}</div>}
        </fieldset>
        {runtimeSelected && !trial && <Button variant="outline" onClick={() => setChosenSamples([])}>清除样本选择</Button>}
      </>}
    </section>}
    {step === 1 && <section className="space-y-4">
      {!trial && <div className="flex flex-wrap gap-2" aria-label="测评方案">{(plans.data?.items ?? []).map((plan) => <Button key={plan.id}
        type="button" variant={tier === plan.id ? 'primary' : 'outline'}
        disabled={selectedProducts.length !== 1 || selectedProducts[0] !== 'claude-code' || !agents.find((agent) => agent.product === 'claude-code')?.runtimeV2}
        onClick={() => { setTier(plan.id); setSampleIds(plan.sampleIds); setSampleVersions(plan.sampleVersions ?? []); setArms(plan.arms); setRepeat(plan.repeat); setTemplates(plan.templates); setAcknowledged(false); }}>
        {PLAN_LABEL[plan.id]}</Button>)}<Button type="button" variant={tier === 'custom' ? 'primary' : 'outline'} onClick={() => setTier('custom')}>自定义</Button></div>}
      {plans.isError && <p role="alert">测评方案读取失败，可手动选择样本。</p>}
      {pin && pinnedSample.isError && <p role="alert">所选样本版本读取失败。</p>}
      {sampleIds.length !== chosenSamples.length && !samples.isLoading && <p role="alert">部分所选样本已不在当前样本库。<Button variant="outline" size="sm" onClick={() => setChosenSamples(chosenSamples.map((item) => item.id))}>移除不可用样本</Button></p>}
      <div className="grid gap-2 md:grid-cols-3">
        <Input aria-label="搜索样本" placeholder="搜索标题或位置" value={search} onChange={(event) => { setSearch(event.target.value); setSamplePage(1); }} />
        <Select aria-label="攻击类别" value={category} onChange={(event) => { setCategory(event.target.value); setSamplePage(1); }}><option value="">全部攻击类别</option>{choices(allSamples.map((item) => item.vectorLabel)).map((value) => <option key={value}>{value}</option>)}</Select>
        <Select aria-label="危害" value={harm} onChange={(event) => { setHarm(event.target.value); setSamplePage(1); }}><option value="">全部危害</option>{choices(allSamples.map((item) => item.harmLabel)).map((value) => <option key={value}>{value}</option>)}</Select>
        <Select aria-label="投毒位置" value={location} onChange={(event) => { setLocation(event.target.value); setSamplePage(1); }}><option value="">全部位置</option>{choices(allSamples.flatMap((item) => item.locations)).map((value) => <option key={value}>{value}</option>)}</Select>
        <Select aria-label="靶场项目筛选" value={project} onChange={(event) => { setProject(event.target.value); setSamplePage(1); }}><option value="">全部靶场项目</option>{Object.entries(PROJECT_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Select aria-label="适用智能体" value={agentFilter} onChange={(event) => { setAgentFilter(event.target.value); setSamplePage(1); }}><option value="">全部智能体</option>{choices(allSamples.flatMap((item) => item.agents)).map((value) => <option key={value} value={value}>{productLabel(value)}</option>)}</Select>
      </div>
      {samples.isLoading ? <LoadingBlock label="正在读取样本" /> : samples.isError ? <p role="alert">样本读取失败。</p> : <div className="divide-y divide-line border-y border-line">
        {filtered.slice((samplePage - 1) * 10, samplePage * 10).map((sample) => { const reason = sampleBlocked(sample); return <div key={sample.id} className="flex min-h-16 items-start gap-3 py-3 text-sm">
          <label className="flex min-w-0 flex-1 items-start gap-3"><input type="checkbox" className="mt-1" checked={sampleIds.includes(sample.id)} disabled={!!reason || trial}
            onChange={() => setChosenSamples(toggle(sampleIds, sample.id))} /><span className="min-w-0"><span className="font-medium">{sample.title}</span>
            <span className="block text-ink-3">{sample.vectorLabel} · {sample.harmLabel} · {sample.locations.join('、')} · {sample.environment === 'sandbox' ? '蜜罐沙箱' : '真实配置'}</span>
            {reason && <span className="block text-ink-3">{reason}</span>}</span></label>
          <button type="button" title="查看详情" aria-label={`查看${sample.title}`} className="rounded p-2 hover:bg-slate-100" onClick={() => setSelectedDetail(sample)}><ChevronRight className="h-4 w-4" /></button>
        </div>; })}
      </div>}
      <Pagination page={samplePage} pageSize={10} total={filtered.length} onPageChange={setSamplePage} />
      {!filtered.length && !samples.isLoading && <p className="text-sm text-ink-3">没有符合条件的样本</p>}
    </section>}
    {step === 2 && <section className="max-w-3xl space-y-6">
      {runtimeSelected && <>
        <label className="flex items-start gap-3"><input type="checkbox" checked={arms.includes('enforce')} disabled={trial}
          onChange={(event) => { setArms(event.target.checked ? ['observe', 'enforce'] : ['observe']); setAcknowledged(false); }} />
          <span>同时验证终端防护</span></label>
        <div><label htmlFor="wizard-repeat" className="mb-1 block text-sm font-medium">重复次数</label>
          <Input id="wizard-repeat" className="max-w-32" type="number" min={1} max={5} value={repeat} disabled={trial}
            onChange={(event) => { setRepeat(Math.max(1, Math.min(5, Number(event.target.value) || 1))); setAcknowledged(false); }} /></div>
        <fieldset><legend className="mb-2 font-medium">靶场项目</legend><div className="flex flex-wrap gap-5">
          {(['py-service-v1', 'node-api-v1'] as RuntimeTemplate[]).map((template) => <label key={template} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={templates.includes(template)} onChange={() => { setTemplates(trial ? [template] : toggle(templates, template) as RuntimeTemplate[]); setAcknowledged(false); }} />{PROJECT_LABEL[template]}
          </label>)}
        </div></fieldset>
      </>}
      {!runtimeSelected && <p className="text-sm">所选经典样本使用真实配置。</p>}
    </section>}
    {step === 3 && <section className="max-w-4xl space-y-5">
      {estimate.isLoading && <LoadingBlock label="正在估算" />}
      {estimate.isError && <p role="alert">无法估算：{message(estimate.error)}</p>}
      {estimate.data && !estimate.isFetching && <>
        <dl className="grid gap-4 border-y border-line py-4 sm:grid-cols-3">
          <div><dt className="text-sm text-ink-3">场景数</dt><dd className="font-semibold">{estimate.data.scenarioCount}</dd></div>
          <div><dt className="text-sm text-ink-3">预计时长</dt><dd className="font-semibold" title={`${estimate.data.estimateSeconds} 秒`}>{duration(estimate.data.estimateSeconds)}</dd></div>
          <div><dt className="text-sm text-ink-3">模型额度消耗</dt><dd>未上报</dd></div>
        </dl>
        {estimate.data.jobs.map((job, index) => <section key={`${job.product}-${job.suite}-${index}`}>
          <h2 className="font-medium">{productLabel(job.product)} · {job.suite === 'runtime_v2' ? '蜜罐沙箱' : '真实配置'}{job.batch ? ` · 第 ${job.batch.index}/${job.batch.total} 批` : ''} · {job.scenarioCount} 个场景</h2>
          <details className="mt-2 text-sm"><summary className="cursor-pointer text-brand-700">查看场景明细</summary>
            <ul className="mt-2 max-h-64 list-disc space-y-1 overflow-y-auto pl-5">{job.scenarios.map((scenario) => <li key={scenario.scenarioId}>{scenario.title}</li>)}</ul>
          </details>
        </section>)}
        {estimate.data.jobs.some((job) => job.batch) && <p role="note" className="border-l-2 border-brand-500 pl-3 text-sm">场景较多，按样本拆成 {estimate.data.jobs.filter((job) => job.batch).length} 个任务依次执行，每个任务单独出结果，一个失败不影响其它任务。</p>}
        {runtimeSelected && <p className="text-sm">沙箱样本使用隔离环境和模拟用户目录。</p>}
        {hasRealConfig && <p role="note" className="border-l-2 border-amber-500 pl-3 text-sm">经典样本使用登录用户的真实主目录配置和模型路由。</p>}
        <label className="flex items-start gap-3"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>确认测评对象、样本与运行环境</span></label>
      </>}
      {batch.isError && <p role="alert">发起失败：{message(batch.error)}</p>}
    </section>}
    <div className="sticky bottom-0 z-10 mt-6 flex flex-wrap items-center gap-3 border-t border-line bg-canvas py-4">
      {step > 0 && canEstimate && estimate.isFetching && <p className="mr-auto text-sm text-ink-3">正在更新场景数和时长</p>}
      {step > 0 && canEstimate && estimate.data && !estimate.isFetching && step < 3 && <p className="mr-auto text-sm text-ink-3">{estimate.data.scenarioCount} 个场景 · {duration(estimate.data.estimateSeconds)}</p>}
      {step > 0 && canEstimate && estimate.isError && step < 3 && <p role="alert" className="mr-auto text-sm">无法估算：{message(estimate.error)}</p>}
      {step > 0 && <Button variant="outline" onClick={previous}>上一步</Button>}
      {step < 3 ? <Button onClick={next} disabled={step === 0 ? !endpoint.data?.online || !selectedProducts.length || overview.isLoading || overview.isError || endpoint.isError : step === 1 ? !sampleIds.length || sampleIds.length !== chosenSamples.length : !templates.length}>下一步</Button>
        : <Button disabled={!acknowledged || !estimate.data || estimate.isFetching || estimate.isError || batch.isPending} onClick={() => batch.mutate()}>发起测评</Button>}
    </div>
    {selectedDetail && <SampleDetails sample={selectedDetail} close={() => setSelectedDetail(null)} showStart={false} />}
  </main>;
}
