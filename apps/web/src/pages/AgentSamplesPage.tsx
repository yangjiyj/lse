import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronRight, Copy, Download, Pencil, Plus, Power, Upload } from 'lucide-react';
import { api, type AgentSample } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock } from '@/components/ui/spinner';
import type { RuntimeSample } from '../../../../packages/shared/src/runtime-eval';
import { useAuth } from '@/lib/auth';
import { randomId } from '@/lib/random-id';
import { Button } from '@/components/ui/button';
import { AgentSampleEditor, newRuntimeSample } from './AgentSampleEditor';
import { SampleDetails, TEMPLATE, product, restrictedAgents } from '@/components/agent-samples/SampleDetails';
import { SampleTags } from '@/components/agent-samples/SampleTags';
import { Badge } from '@/components/ui/badge';
import { TenantTransferDialog } from '@/components/TenantTransferDialog';

export function AgentSamplesPage() {
  const query = useQuery({ queryKey: ['agent-samples'], queryFn: api.agentSamples.list });
  const client = useQueryClient();
  const { hasPermission, user } = useAuth();
  const canManage = hasPermission('model_target:create');
  const [editor, setEditor] = useState<{ sample: RuntimeSample; editing: boolean; version: number; classicDraft?: boolean } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [harm, setHarm] = useState('');
  const [environment, setEnvironment] = useState('');
  const [template, setTemplate] = useState('');
  const [agent, setAgent] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('default');
  const rates = useQuery({ queryKey: ['agent-sample-all-statistics'], queryFn: api.agentSamples.allStatistics, enabled: sort === 'comply', retry: false });
  const [selected, setSelected] = useState<AgentSample | null>(null);
  const [transferFor, setTransferFor] = useState<AgentSample | null>(null);
  const items = query.data?.items ?? [];
  const filtered = items.filter((item) => (!search || `${item.title} ${item.summary ?? ''} ${item.locations.join(' ')}`.toLowerCase().includes(search.toLowerCase())) &&
    (!category || item.vectorLabel === category) && (!harm || item.harmLabel === harm) &&
    (!environment || item.environment === environment) && (!template || item.template === template || item.template === 'any') &&
    (!agent || item.agents.includes(agent)));
  const ratesById = new Map((rates.data?.items ?? []).map((item) => [item.id, item.complyRate]));
  if (sort === 'comply') filtered.sort((a, b) => (ratesById.get(b.id) ?? -1) - (ratesById.get(a.id) ?? -1) || a.title.localeCompare(b.title, 'zh'));
  const options = (values: string[]) => [...new Set(values)].sort();
  const change = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLSelectElement>) => { setter(event.target.value); setPage(1); };
  const refresh = async () => {
    await Promise.all(['agent-samples', 'agent-sample', 'agent-sample-history', 'agent-sample-trials', 'agent-sample-all-statistics']
      .map((key) => client.invalidateQueries({ queryKey: [key] })));
  };
  const loadEditor = async (item: AgentSample, copy: boolean) => {
    setError('');
    try {
      const data = await api.agentSamples.exportSample(item.id);
      const stored = data.samples[0];
      const version = stored?.versions.find((entry) => entry.version === stored.currentVersion);
      if (!stored || !version) throw new Error('样本版本不可用');
      if (stored.suite === 'classic' && copy) {
        const classic = version.content as { title?: unknown; prompt?: unknown; content?: unknown };
        if (typeof classic.title !== 'string' || typeof classic.prompt !== 'string' || typeof classic.content !== 'string') throw new Error('经典样本内容不完整');
        setEditor({ sample: { ...newRuntimeSample(), id: `custom-${randomId()}`, title: classic.title, prompt: classic.prompt,
          vector: 'indirect', channel: 'doc', slots: { readme_note: classic.content.replaceAll('SINK', '{{SINK}}') },
          decoys: { workspace: ['env_file'], home: [] }, danger: [], explain: '' }, editing: false, version: 0, classicDraft: true });
        return;
      }
      if (stored.suite !== 'runtime_v2') throw new Error('该样本不能作为运行态样本编辑');
      const sample = version.content as RuntimeSample;
      setEditor({ sample: copy ? { ...sample, id: `custom-${randomId()}` } : sample, editing: !copy, version: version.version });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '读取样本失败'); }
  };
  const save = async (sample: RuntimeSample, note: string) => {
    if (editor?.editing) await api.agentSamples.update(sample.id, sample, editor.version, note);
    else await api.agentSamples.create(sample, note);
    setEditor(null); setNotice('样本已保存'); setError(''); await refresh();
  };
  const setEnabled = async (item: AgentSample) => {
    try { await api.agentSamples.setEnabled(item.id, item.enabled === false); setNotice(item.enabled === false ? '样本已启用' : '样本已停用'); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '更新状态失败'); }
  };
  const download = async (item: AgentSample) => {
    try {
      const data = await api.agentSamples.exportSample(item.id);
      const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = href; link.download = `${item.id}.json`; link.click(); URL.revokeObjectURL(href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败'); }
  };
  const downloadAll = async () => {
    try {
      const data = await api.agentSamples.exportAll();
      const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = href; link.download = 'agent-samples.json'; link.click(); URL.revokeObjectURL(href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败'); }
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const data: unknown = JSON.parse(await file.text());
      const samples = Array.isArray(data) ? data : data && typeof data === 'object' && 'samples' in data ? (data as { samples: unknown }).samples : null;
      if (!Array.isArray(samples)) throw new Error('JSON 中缺少样本列表');
      const result = await api.agentSamples.importSamples(samples);
      const failed = result.items.filter((item) => !item.ok);
      setNotice(`已导入 ${result.items.length - failed.length} 条${failed.length ? `，失败 ${failed.length} 条：${failed.map((item) => `第 ${item.index + 1} 条 ${item.error}`).join('；')}` : ''}`);
      setError(''); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败'); }
  };
  return <main className="min-w-0">
    <PageHeader title="智能体样本库" actions={<>
      <Button variant="outline" onClick={() => void downloadAll()}><Download className="mr-1 h-4 w-4" />导出 JSON</Button>
      {canManage && <>
      <label className="inline-flex min-h-9 cursor-pointer items-center gap-1 rounded border border-line px-3 text-sm"><Upload className="h-4 w-4" />导入 JSON<input className="sr-only" type="file" accept="application/json,.json" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></label>
      <Button onClick={() => setEditor({ sample: newRuntimeSample(), editing: false, version: 0 })}><Plus className="mr-1 h-4 w-4" />新建样本</Button>
      </>}
    </>} />
    {notice && <p role="status" className="mb-3 text-sm">{notice}</p>}{error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
    <div className="mb-3 flex items-center gap-2"><label htmlFor="sample-sort" className="text-sm">排序</label><Select id="sample-sort" className="max-w-44" value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="default">默认</option><option value="comply">照做率从高到低</option></Select>
      {rates.isFetching && <span role="status">正在统计…</span>}{rates.isError && <span role="alert">统计不可用或无查看权限。</span>}{!!rates.data?.incompleteJobs && <span>部分任务读取失败，统计不完整。</span>}
    </div>
    <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <Input aria-label="搜索样本" placeholder="搜索标题或位置" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
      <Select aria-label="攻击类别" value={category} onChange={change(setCategory)}><option value="">全部攻击类别</option>{options(items.map((i) => i.vectorLabel)).map((v) => <option key={v}>{v}</option>)}</Select>
      <Select aria-label="危害" value={harm} onChange={change(setHarm)}><option value="">全部危害</option>{options(items.map((i) => i.harmLabel)).map((v) => <option key={v}>{v}</option>)}</Select>
      <Select aria-label="运行环境" value={environment} onChange={change(setEnvironment)}><option value="">全部运行环境</option><option value="sandbox">蜜罐沙箱</option><option value="real_config">真实配置</option></Select>
      <Select aria-label="靶场项目" value={template} onChange={change(setTemplate)}><option value="">全部靶场项目</option><option value="py-service-v1">Python 库存服务</option><option value="node-api-v1">Node 订单接口</option></Select>
      <Select aria-label="适用智能体" value={agent} onChange={change(setAgent)}><option value="">全部智能体</option>{options(items.flatMap((i) => i.agents)).map((v) => <option key={v} value={v}>{product(v)}</option>)}</Select>
    </div>
    {query.isLoading ? <LoadingBlock label="正在读取样本" /> : query.isError ? <p role="alert">样本读取失败，请重试。</p> : <>
      <Table><THead><TR>{['样本', '标签', '投毒位置', '靶场项目'].map((label) => <TH key={label}>{label}</TH>)}<TH aria-label="详情" /></TR></THead>
        <TBody>{filtered.slice((page - 1) * 20, page * 20).map((item) => <TR key={item.id}>
          <TD data-label="样本" className="max-w-md">
            <button type="button" className="text-left font-medium text-ink hover:text-brand-700" onClick={() => setSelected(item)}>{item.title}</button>
            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-ink-3">{item.summary}</p>
            {restrictedAgents(item.agents) && <Badge tone="neutral" className="mt-1 whitespace-nowrap">仅 {restrictedAgents(item.agents)}</Badge>}
            {sort === 'comply' && <span className="block text-xs text-ink-3">{ratesById.get(item.id) == null ? '照做率未记录' : `照做率 ${Math.round(ratesById.get(item.id)! * 1000) / 10}%`}</span>}
          </TD>
          <TD data-label="标签"><SampleTags item={item} /></TD>
          <TD data-label="投毒位置" className="text-sm">{item.locations.slice(0, 2).join('、')}{item.locations.length > 2 ? ` 等 ${item.locations.length} 处` : ''}</TD>
          <TD data-label="靶场项目" className="whitespace-nowrap text-sm">{item.template ? TEMPLATE[item.template] ?? item.template : '—'}</TD>
          <TD><div className="flex items-center">
            {canManage && item.suite === 'runtime_v2' && item.source === 'custom' && <button type="button" className="rounded p-2 hover:bg-slate-100" aria-label={`编辑${item.title}`} title="编辑样本" onClick={() => void loadEditor(item, false)}><Pencil className="h-4 w-4" /></button>}
            {canManage && <button type="button" className="rounded p-2 hover:bg-slate-100" aria-label={`复制${item.title}`} title={item.suite === 'classic' ? '复制为沙箱草稿' : '复制为自定义'} onClick={() => void loadEditor(item, true)}><Copy className="h-4 w-4" /></button>}
            {canManage && <button type="button" className="rounded p-2 hover:bg-slate-100" aria-label={`${item.enabled === false ? '启用' : '停用'}${item.title}`} title={item.enabled === false ? '启用' : '停用'} onClick={() => void setEnabled(item)}><Power className="h-4 w-4" /></button>}
            {user?.isPlatformAdmin && item.source === 'custom' && <button type="button" className="rounded p-2 hover:bg-slate-100" aria-label={`变更${item.title}的归属租户`} title="变更归属租户" data-testid={`sample-transfer-${item.id}`} onClick={() => setTransferFor(item)}><Building2 className="h-4 w-4" /></button>}
            <button type="button" className="rounded p-2 hover:bg-slate-100" aria-label={`导出${item.title}`} title="导出 JSON" onClick={() => void download(item)}><Download className="h-4 w-4" /></button>
            <button type="button" className="rounded p-2 hover:bg-slate-100" aria-label={`查看${item.title}`} title="查看详情" onClick={() => setSelected(item)}><ChevronRight className="h-4 w-4" /></button>
          </div></TD>
        </TR>)}</TBody>
      </Table>
      {!filtered.length && <p className="py-8 text-center text-sm text-ink-3">没有符合条件的样本</p>}
      <Pagination page={page} pageSize={20} total={filtered.length} onPageChange={setPage} />
    </>}
    <TenantTransferDialog open={Boolean(transferFor)} kind="agent-sample" ids={transferFor ? [transferFor.id] : []} onClose={() => setTransferFor(null)} onTransferred={(message) => { setNotice(message); void refresh(); }} />
    {selected && <SampleDetails sample={selected} close={() => setSelected(null)} />}
    {editor && <AgentSampleEditor initial={editor.sample} editing={editor.editing} classicDraft={editor.classicDraft} onSave={save} onClose={() => setEditor(null)} />}
  </main>;
}
