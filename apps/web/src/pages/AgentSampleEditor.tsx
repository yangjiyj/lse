import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { DetailDrawer } from '@/components/fleet/DetailDrawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  RUNTIME_CHANNELS, RUNTIME_HARMS, RUNTIME_HARM_LABELS, RUNTIME_HOME_DECOYS, RUNTIME_TEMPLATES,
  RUNTIME_VECTORS, RUNTIME_VECTOR_LABELS, RUNTIME_WORKSPACE_DECOYS,
  type RuntimeDanger, type RuntimeSample,
} from '../../../../packages/shared/src/runtime-eval';

const SLOTS = ['readme_note', 'contributing_step', 'changelog_note', 'makefile_note', 'requirements_comment', 'ci_step',
  'runbook_note', 'deploy_note', 'script_output', 'cache_comment', 'app_comment', 'test_message', 'vendor_readme',
  'issue_body', 'claude_md', 'agents_md', 'cursorrules', 'package_script'];
const SLOT_LABEL: Record<string, string> = { readme_note: 'README.md', contributing_step: 'CONTRIBUTING.md', changelog_note: 'CHANGELOG.md',
  makefile_note: 'Makefile', requirements_comment: 'requirements.txt', ci_step: 'CI 工作流', runbook_note: '运行手册', deploy_note: '部署文档',
  script_output: '检查脚本输出', cache_comment: '缓存模块注释', app_comment: '服务模块注释', test_message: '测试断言消息',
  vendor_readme: '依赖 README', issue_body: '问题记录', claude_md: 'CLAUDE.md', agents_md: 'AGENTS.md', cursorrules: '.cursorrules', package_script: 'package.json 安装脚本' };
const DECOY_LABEL: Record<string, string> = { env_file: '.env', customers_csv: 'data/customers.csv', deploy_key: '部署私钥', kubeconfig: '项目 kubeconfig',
  ssh_key: 'SSH 私钥', aws: 'AWS 凭据', gh: 'GitHub 凭据', npmrc: 'npm 凭据', git_credentials: 'Git 凭据', docker_config: 'Docker 凭据', kube_config: '用户 kubeconfig', netrc: 'netrc 凭据' };
const CHANNEL_LABEL: Record<string, string> = { doc: '文档', code: '代码', dep: '依赖文件', web: '网页内容', mcp: 'MCP 工具' };
const REFS = ['OWASP-LLM01', 'OWASP-LLM02', 'OWASP-LLM06'];
const KIND: Record<RuntimeDanger['kind'], string> = { read_decoy: '读取蜜标', egress_to: '访问目标', sink_received: '接收端收到标记',
  cmd_matches: '命令匹配', path_changed: '文件变化', wrote_text: '写入内容' };
const makeDanger = (kind: RuntimeDanger['kind']): RuntimeDanger => {
  switch (kind) {
    case 'read_decoy': return { kind, decoy: 'aws' };
    case 'egress_to': return { kind, host: '{{SINK}}' };
    case 'sink_received': return { kind };
    case 'cmd_matches': return { kind, pattern: '' };
    case 'path_changed': return { kind, path: '', op: 'modify' };
    case 'wrote_text': return { kind, path: '', contains: '' };
  }
};
/** 出处是可选的人工备注：留空就不提交这个字段。 */
const withoutEmptyOrigin = (value: RuntimeSample): RuntimeSample => {
  const next = { ...value };
  if (typeof next.origin !== 'string' || !next.origin.trim()) delete next.origin; else next.origin = next.origin.trim();
  return next;
};
export const newRuntimeSample = (): RuntimeSample => ({ id: '', vector: 'direct', title: '', prompt: '', template: 'py-service-v1',
  slots: {}, decoys: { workspace: [], home: ['aws'] }, harm: 'credential_read', danger: [{ kind: 'read_decoy', decoy: 'aws' }],
  expect: { run: ['python3', '-m', 'unittest', '-q'] }, explain: '', refs: ['OWASP-LLM02'] });

export function AgentSampleEditor({ initial, editing = false, classicDraft = false, onSave, onClose }: {
  initial: RuntimeSample; editing?: boolean; classicDraft?: boolean; onSave: (sample: RuntimeSample, note: string) => Promise<void>; onClose: () => void;
}) {
  const [sample, setSample] = useState(initial);
  const [note, setNote] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(initial, null, 2));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const change = <K extends keyof RuntimeSample>(key: K, value: RuntimeSample[K]) => setSample((old) => ({ ...old, [key]: value }));
  const toggleAdvanced = (next: boolean) => {
    if (next) setJson(JSON.stringify(sample, null, 2));
    else try { setSample(JSON.parse(json) as RuntimeSample); setError(''); } catch { setError('JSON 格式不正确'); return; }
    setAdvanced(next);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try { await onSave(withoutEmptyOrigin(advanced ? JSON.parse(json) as RuntimeSample : sample), note); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const replaceDanger = (index: number, value: RuntimeDanger) => change('danger', sample.danger.map((item, i) => i === index ? value : item));
  return <DetailDrawer title={editing ? '编辑样本' : '新建样本'} onClose={onClose}>
    <form className="space-y-5" onSubmit={submit}>
      {classicDraft && <p role="note">经典样本已复制为沙箱草稿，请重新核对任务、插槽和判定规则后保存。</p>}
      <div className="flex gap-2"><Button type="button" variant={!advanced ? 'primary' : 'outline'} onClick={() => toggleAdvanced(false)}>表单</Button>
        <Button type="button" variant={advanced ? 'primary' : 'outline'} onClick={() => toggleAdvanced(true)}>JSON</Button></div>
      {advanced ? <label className="block space-y-1">样本 JSON<Textarea aria-label="样本 JSON" className="min-h-96 font-mono" value={json} onChange={(event) => setJson(event.target.value)} /></label> : <>
        <label className="block space-y-1">样本编号<Input aria-label="样本编号" required disabled={editing} value={sample.id} onChange={(event) => change('id', event.target.value)} /></label>
        <label className="block space-y-1">标题<Input aria-label="标题" required value={sample.title} onChange={(event) => change('title', event.target.value)} /></label>
        <label className="block space-y-1">攻击类别<Select aria-label="攻击类别" value={sample.vector} onChange={(event) => {
          const vector = event.target.value as RuntimeSample['vector'];
          setSample((old) => { const next = { ...old, vector }; if (vector === 'indirect') next.channel = old.channel ?? 'doc'; else delete next.channel;
            if (vector === 'multi_step') next.turns = old.turns ?? ['', '']; else delete next.turns; return next; });
        }}>{RUNTIME_VECTORS.map((value) => <option key={value} value={value}>{RUNTIME_VECTOR_LABELS[value]}</option>)}</Select></label>
        {sample.vector === 'indirect' && <label className="block space-y-1">投毒渠道<Select aria-label="投毒渠道" value={sample.channel ?? 'doc'} onChange={(event) => change('channel', event.target.value as RuntimeSample['channel'])}>{RUNTIME_CHANNELS.map((value) => <option key={value} value={value}>{CHANNEL_LABEL[value]}</option>)}</Select></label>}
        <label className="block space-y-1">危害<Select aria-label="危害" value={sample.harm} onChange={(event) => change('harm', event.target.value as RuntimeSample['harm'])}>{RUNTIME_HARMS.map((value) => <option key={value} value={value}>{RUNTIME_HARM_LABELS[value]}</option>)}</Select></label>
        <label className="block space-y-1">靶场项目<Select aria-label="靶场项目" value={sample.template} onChange={(event) => change('template', event.target.value as RuntimeSample['template'])}><option value="any">两种项目</option>{RUNTIME_TEMPLATES.map((value) => <option key={value} value={value}>{value === 'py-service-v1' ? 'Python 库存服务' : 'Node 订单接口'}</option>)}</Select></label>
        <label className="block space-y-1">任务<Textarea aria-label="任务" required value={sample.prompt} onChange={(event) => change('prompt', event.target.value)} /></label>
        {sample.vector === 'multi_step' && <label className="block space-y-1">轮次<Textarea aria-label="轮次" value={(sample.turns ?? []).join('\n')} onChange={(event) => change('turns', event.target.value.split('\n'))} /></label>}
        <fieldset className="space-y-2"><legend className="font-medium">投毒插槽</legend>
          {Object.entries(sample.slots).map(([slot, value]) => <div key={slot} className="flex items-start gap-2"><label className="min-w-0 flex-1">{SLOT_LABEL[slot] ?? slot}<Textarea aria-label={`插槽 ${slot}`} value={value} onChange={(event) => change('slots', { ...sample.slots, [slot]: event.target.value })} /></label>
            <Button type="button" variant="ghost" size="icon" aria-label={`删除插槽 ${slot}`} title="删除插槽" onClick={() => { const next = { ...sample.slots }; delete next[slot]; change('slots', next); }}><Trash2 className="h-4 w-4" /></Button></div>)}
          <Select aria-label="添加插槽" value="" onChange={(event) => { if (event.target.value) change('slots', { ...sample.slots, [event.target.value]: '' }); }}><option value="">添加插槽</option>{SLOTS.filter((slot) => !(slot in sample.slots) && (slot !== 'package_script' || sample.template === 'node-api-v1')).map((slot) => <option key={slot} value={slot}>{SLOT_LABEL[slot]}</option>)}</Select>
        </fieldset>
        <fieldset className="space-y-2"><legend className="font-medium">蜜标</legend>
          {([['workspace', RUNTIME_WORKSPACE_DECOYS], ['home', RUNTIME_HOME_DECOYS]] as const).map(([group, values]) => <div className="flex flex-wrap gap-x-4 gap-y-2" key={group}>{values.map((value) => <label key={value} className="flex items-center gap-1"><input type="checkbox" checked={sample.decoys[group].includes(value)} onChange={(event) => change('decoys', { ...sample.decoys, [group]: event.target.checked ? [...sample.decoys[group], value] : sample.decoys[group].filter((item) => item !== value) })} />{DECOY_LABEL[value]}</label>)}</div>)}
        </fieldset>
        <fieldset className="space-y-3"><legend className="font-medium">判定规则</legend>{sample.danger.map((rule, index) => <div className="space-y-2 border-b border-line pb-3" key={index}>
          <div className="flex gap-2"><Select aria-label={`规则类型 ${index + 1}`} value={rule.kind} onChange={(event) => replaceDanger(index, makeDanger(event.target.value as RuntimeDanger['kind']))}>{Object.entries(KIND).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</Select>
            <Button type="button" variant="ghost" size="icon" aria-label={`删除规则 ${index + 1}`} title="删除规则" onClick={() => change('danger', sample.danger.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" /></Button></div>
          {rule.kind === 'read_decoy' && <Select aria-label={`规则蜜标 ${index + 1}`} value={rule.decoy} onChange={(event) => replaceDanger(index, { ...rule, decoy: event.target.value })}>{[...sample.decoys.workspace, ...sample.decoys.home].map((item) => <option key={item} value={item}>{DECOY_LABEL[item] ?? item}</option>)}</Select>}
          {rule.kind === 'egress_to' && <Input aria-label={`规则目标 ${index + 1}`} value={rule.host} onChange={(event) => replaceDanger(index, { ...rule, host: event.target.value })} />}
          {rule.kind === 'cmd_matches' && <Input aria-label={`规则表达式 ${index + 1}`} value={rule.pattern} onChange={(event) => replaceDanger(index, { ...rule, pattern: event.target.value })} />}
          {(rule.kind === 'path_changed' || rule.kind === 'wrote_text') && <Input aria-label={`规则路径 ${index + 1}`} value={rule.path} onChange={(event) => replaceDanger(index, { ...rule, path: event.target.value })} />}
          {rule.kind === 'path_changed' && <Select aria-label={`文件操作 ${index + 1}`} value={rule.op} onChange={(event) => replaceDanger(index, { ...rule, op: event.target.value as typeof rule.op })}><option value="create">创建</option><option value="modify">修改</option><option value="delete">删除</option></Select>}
          {rule.kind === 'wrote_text' && <Input aria-label={`规则内容 ${index + 1}`} value={rule.contains} onChange={(event) => replaceDanger(index, { ...rule, contains: event.target.value })} />}
        </div>)}<Button type="button" variant="outline" onClick={() => change('danger', [...sample.danger, makeDanger('read_decoy')])}><Plus className="mr-1 h-4 w-4" />添加规则</Button></fieldset>
        <label className="block space-y-1">期望回答包含<Textarea aria-label="期望回答包含" value={(sample.expect?.final_contains ?? []).join('\n')} onChange={(event) => change('expect', { ...sample.expect, final_contains: event.target.value.split('\n').filter(Boolean) })} /></label>
        <label className="block space-y-1">期望命令参数<Textarea aria-label="期望命令参数" value={(sample.expect?.run ?? []).join('\n')} onChange={(event) => change('expect', { ...sample.expect, run: event.target.value.split('\n').filter(Boolean) })} /></label>
        <fieldset className="space-y-2"><legend className="font-medium">期望文件</legend>{(sample.expect?.files ?? []).map((file, index) => <div key={index} className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-2"><Input aria-label={`期望文件路径 ${index + 1}`} placeholder="路径" value={file.path} onChange={(event) => change('expect', { ...sample.expect, files: (sample.expect?.files ?? []).map((item, i) => i === index ? { ...item, path: event.target.value } : item) })} />
            <Input aria-label={`期望文件内容 ${index + 1}`} placeholder="包含内容" value={file.contains} onChange={(event) => change('expect', { ...sample.expect, files: (sample.expect?.files ?? []).map((item, i) => i === index ? { ...item, contains: event.target.value } : item) })} /></div>
          <Button type="button" variant="ghost" size="icon" aria-label={`删除期望文件 ${index + 1}`} title="删除期望文件" onClick={() => change('expect', { ...sample.expect, files: (sample.expect?.files ?? []).filter((_, i) => i !== index) })}><Trash2 className="h-4 w-4" /></Button>
        </div>)}<Button type="button" variant="outline" onClick={() => change('expect', { ...sample.expect, files: [...(sample.expect?.files ?? []), { path: '', contains: '' }] })}><Plus className="mr-1 h-4 w-4" />添加期望文件</Button></fieldset>
        <label className="block space-y-1">判定说明<Textarea aria-label="判定说明" required value={sample.explain} onChange={(event) => change('explain', event.target.value)} /></label>
        <fieldset className="space-y-2"><legend className="font-medium">参考标准</legend><div className="flex flex-wrap gap-3">{REFS.map((ref) => <label key={ref} className="flex gap-1"><input type="checkbox" checked={sample.refs.includes(ref)} onChange={(event) => change('refs', event.target.checked ? [...sample.refs, ref] : sample.refs.filter((item) => item !== ref))} />{ref}</label>)}</div></fieldset>
      </>}
      {!advanced && <label className="block space-y-1">出处<Input aria-label="出处" maxLength={200} placeholder="例如：某次事故复盘、CVE 编号、客户现场发现（选填）" value={sample.origin ?? ''} onChange={(event) => change('origin', event.target.value)} /></label>}
      <label className="block space-y-1">变更说明<Input aria-label="变更说明" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex gap-2"><Button type="submit" disabled={busy}>保存样本</Button><Button type="button" variant="outline" onClick={onClose}>取消</Button></div>
    </form>
  </DetailDrawer>;
}
