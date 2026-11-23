import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { cn } from '@/lib/utils';

/** 与终端接口契约一致；可选字段用于旧终端渐进升级。 */
export type SafetyState = 'risk' | 'clear' | 'not_checked';
export interface EndpointSubject {
  kind: 'agent' | 'mcp' | 'skill' | 'instruction_file' | 'scheduled_agent';
  name: string;
  state?: SafetyState | null;
  detail?: string | null;
}
export interface EndpointFinding {
  state?: SafetyState | null;
  subjects?: EndpointSubject[] | null;
  plainTitle?: string | null;
  plainWhy?: string | null;
  plainFix?: string | null;
  notCheckedReason?: string | null;
  howToCheck?: string | null;
  evidence?: string | null;
  severity?: 'HIGH' | 'MEDIUM' | 'LOW' | null;
}
export interface EndpointAgent {
  product: string;
  displayName?: string;
  version: string | null;
  /** 安装位置的脱敏指纹（前 8 位），仅用于区分同产品同版本的重复安装。 */
  installHint?: string | null;
  liveEvalSupported?: boolean;
  liveEvalRegistered?: boolean;
  liveEvalBlockedReason?: string | null;
}
export interface EndpointLiveScenario {
  scenarioId: string;
  riskType: string;
  whatWeAsked?: string | null;
  whatItDid?: string | null;
  judgement?: string | null;
  evidenceExcerpt?: string | null;
}
export interface EndpointMetric {
  label: string;
  value?: number | null;
  unit?: string;
  description?: string;
}
const states = {
  risk: { label: '发现风险', shape: '▲', tone: 'warning' },
  clear: { label: '已检查无风险', shape: '✓', tone: 'success' },
  not_checked: { label: '终端没检查', shape: '—', tone: 'neutral' },
} as const;

/** 状态必须由接口明确给出，未知值保持没检查，不从说明文字猜测。 */
function checkedState(state?: SafetyState | null): SafetyState {
  return state === 'risk' || state === 'clear' ? state : 'not_checked';
}
function textOr(value: string | null | undefined, fallback: string) {
  return value?.trim() || fallback;
}

export function SafetyStateBadge({ state }: { state?: SafetyState | null }) {
  const item = states[checkedState(state)];
  return <Badge tone={item.tone}><span aria-hidden="true">{item.shape}</span>{item.label}</Badge>;
}

/** 只有明确的高危等级使用红色，普通风险状态使用克制的黄色。 */
export function RiskLevelBadge({ severity }: { severity?: EndpointFinding['severity'] }) {
  if (!severity) return null;
  const levels = {
    HIGH: { label: '高危', shape: '▲', className: 'bg-severity-critical-bg text-severity-critical ring-severity-critical/20' },
    MEDIUM: { label: '中危', shape: '●', className: 'bg-severity-medium-bg text-severity-medium ring-severity-medium/20' },
    LOW: { label: '低危', shape: '○', className: 'bg-severity-low-bg text-severity-low ring-severity-low/20' },
  } as const;
  const item = levels[severity];
  if (!item) return null;
  return <Badge className={item.className}><span aria-hidden="true">{item.shape}</span>{item.label}</Badge>;
}

/** 长说明预览默认最多两行；聚合列表里用 lines=1 保持紧凑，展开后仍可看全文。 */
export function ExpandableSafetyText({ text, label, collapsed = false, lines = 2, renderText }: {
  text: string;
  label: string;
  collapsed?: boolean;
  lines?: 1 | 2;
  renderText?: (text: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const previewRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    if (collapsed || expanded) return;
    const element = previewRef.current;
    if (!element) return;
    const measure = () => setOverflows(element.clientHeight > 0 && element.scrollHeight > element.clientHeight);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [collapsed, expanded, text]);
  const canExpand = collapsed || overflows || text.length > (lines === 1 ? 40 : 70) || text.split('\n').length > lines;
  const button = canExpand ? <button type="button" aria-expanded={expanded} aria-controls={id}
    onClick={() => setExpanded(!expanded)}
    className={cn('shrink-0 rounded text-[13px] font-medium text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', lines === 2 && 'mt-1')}>
    {expanded ? '收起' : '展开'}{label}
  </button> : null;
  // 单行预览时按钮跟在文字同一行，避免聚合列表里每条说明都多占一行。
  if (lines === 1)
    return <div className="flex min-w-0 items-baseline gap-2">
      <div ref={previewRef} id={id} className="min-w-0 flex-1" hidden={collapsed && !expanded}>
        {(!collapsed || expanded) && <p className={cn('whitespace-pre-wrap break-words text-[13px] leading-5 [overflow-wrap:anywhere]', !expanded && 'line-clamp-1')}>{renderText ? renderText(text) : text}</p>}
      </div>
      {button}
    </div>;
  return (
    <div className="min-w-0">
      <div ref={previewRef} id={id} hidden={collapsed && !expanded}>
        {(!collapsed || expanded) && <p className={cn('whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]', !expanded && 'line-clamp-2')}>{renderText ? renderText(text) : text}</p>}
      </div>
      {button}
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid min-w-0 gap-1 sm:grid-cols-[76px_minmax(0,1fr)] sm:gap-4"><dt className="text-[13px] leading-6 text-ink-3">{label}</dt><dd className="min-w-0 text-ink-2">{children}</dd></div>;
}

/** 超过这个对象数才聚合展示；少量对象保持逐条平铺，便于直接对照。 */
const SUBJECT_FOLD_THRESHOLD = 5;
const RISK_SUBJECT_PREVIEW = 10;
const PENDING_SUBJECT_PREVIEW = 8;
const SUBJECT_UNITS: Record<string, string> = {
  agent: '个智能体',
  mcp: '个工具',
  skill: '个技能',
  instruction_file: '个指令文件',
  scheduled_agent: '个定时任务',
};

function subjectName(subject: EndpointSubject) {
  return textOr(subject.name, '未命名对象');
}

function foldButtonClass() {
  return 'rounded text-[13px] font-medium text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
}

function SubjectRow({ subject, showState = true, showDetail = true }: { subject: EndpointSubject; showState?: boolean; showDetail?: boolean }) {
  return <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
    <span className="break-words text-sm">{subjectName(subject)}</span>
    {showState && <SafetyStateBadge state={subject.state} />}
    {showDetail && subject.detail?.trim() && <div className="min-w-0 flex-1 text-ink-3"><ExpandableSafetyText text={subject.detail} label="对象说明" /></div>}
  </li>;
}

interface SubjectGroup {
  reason: string;
  subjects: EndpointSubject[];
}

/** 同一段说明只保留一份，名称并列；说明不同才分成多行。 */
function groupByDetail(subjects: EndpointSubject[], fallback: string): SubjectGroup[] {
  const groups: SubjectGroup[] = [];
  for (const subject of subjects) {
    const reason = subject.detail?.trim() || fallback;
    const found = groups.find((group) => group.reason === reason);
    if (found) found.subjects.push(subject);
    else groups.push({ reason, subjects: [subject] });
  }
  return groups;
}

/** 风险对象默认展开并置顶，任何情况下都不整体折叠隐藏。 */
function RiskSubjectBlock({ groups }: { groups: SubjectGroup[] }) {
  const [showAll, setShowAll] = useState(false);
  const id = useId();
  const shown = showAll ? groups : groups.slice(0, RISK_SUBJECT_PREVIEW);
  const total = groups.reduce((count, group) => count + group.subjects.length, 0);
  const rest = total - shown.reduce((count, group) => count + group.subjects.length, 0);
  // 摘要行已经写明“发现风险 N”，这里用左侧竖线分组，不再重复一行标题。
  return <div className="min-w-0 border-l-2 border-severity-critical/40 pl-3">
    <ul id={id} className="space-y-1">{shown.map((group) => <li key={group.reason} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="break-words text-sm">{group.subjects.map(subjectName).join('、')}</span>
      {group.reason && <div className="min-w-0 flex-1 text-ink-3"><ExpandableSafetyText text={group.reason} label="对象说明" lines={1} /></div>}
    </li>)}</ul>
    {groups.length > RISK_SUBJECT_PREVIEW && <button type="button" aria-expanded={showAll} aria-controls={id} onClick={() => setShowAll(!showAll)} className={cn('mt-1', foldButtonClass())}>
      {showAll ? '收起风险对象' : `展开其余 ${rest} 个风险对象`}
    </button>}
  </div>;
}

/** 同一原因只写一次，下面用紧凑名称列表；默认只列前 8 个。 */
function PendingReasonBlock({ reason, subjects, separated = false }: { reason: string; subjects: EndpointSubject[]; separated?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const shown = expanded ? subjects : subjects.slice(0, PENDING_SUBJECT_PREVIEW);
  const rest = subjects.length - shown.length;
  return <div className={cn('min-w-0', separated && 'border-t border-line pt-2')}>
    <div className="text-ink-3"><ExpandableSafetyText text={reason} label="未检查的原因" lines={1} /></div>
    <div id={id} className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] leading-5 text-ink-2">
      {shown.map((subject, index) => <span key={`${subject.name}-${index}`} className="break-words">{subjectName(subject)}</span>)}
      {!expanded && rest > 0 && <span className="text-ink-3">等共 {subjects.length} 个</span>}
      {subjects.length > PENDING_SUBJECT_PREVIEW && <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)} className={foldButtonClass()}>
        {expanded ? '收起名称' : `展开全部 ${subjects.length} 个`}
      </button>}
    </div>
  </div>;
}

/** 已检查无风险的对象只给数量，展开后只列名称，不再逐条重复结论。 */
function ClearSubjectBlock({ subjects }: { subjects: EndpointSubject[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="min-w-0">
    {/* 状态文字在摘要行已经写过一次，这里只补数量，避免同一句话重复。 */}
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className={cn('flex flex-wrap items-center gap-1.5 text-[13px] text-ink-2', foldButtonClass())}>
      <span aria-hidden="true" className="text-success">✓</span>{subjects.length} 个对象{open ? '，收起名称' : '，展开名称'}
    </button>
    <div id={id} hidden={!open} className={cn('mt-1 flex-wrap gap-x-3 gap-y-1 text-sm text-ink-3', open ? 'flex' : 'hidden')}>
      {subjects.map((subject, index) => <span key={`${subject.name}-${index}`} className="break-words">{subjectName(subject)}</span>)}
    </div>
  </div>;
}

function SubjectAggregate({ subjects }: { subjects: EndpointSubject[] }) {
  const buckets = { risk: [] as EndpointSubject[], clear: [] as EndpointSubject[], not_checked: [] as EndpointSubject[] };
  for (const subject of subjects) buckets[checkedState(subject.state)].push(subject);
  const kinds = new Set(subjects.map((subject) => subject.kind));
  const unit = kinds.size === 1 ? SUBJECT_UNITS[[...kinds][0]!] ?? '个对象' : '个对象';
  const pendingGroups: SubjectGroup[] = [];
  for (const subject of buckets.not_checked) {
    const reason = textOr(subject.detail, '终端没有提供未检查的原因。');
    const group = pendingGroups.find((item) => item.reason === reason);
    if (group) group.subjects.push(subject);
    else pendingGroups.push({ reason, subjects: [subject] });
  }
  return <div className="space-y-2">
    <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-3"><span>共 {subjects.length} {unit}：</span>
      <span className="inline-flex items-center gap-1.5"><SafetyStateBadge state="risk" /><span className="tabular-nums">{buckets.risk.length}</span></span>
      <span className="inline-flex items-center gap-1.5"><SafetyStateBadge state="clear" /><span className="tabular-nums">{buckets.clear.length}</span></span>
      <span className="inline-flex items-center gap-1.5"><SafetyStateBadge state="not_checked" /><span className="tabular-nums">{buckets.not_checked.length}</span></span>
    </p>
    {buckets.risk.length > 0 && <RiskSubjectBlock groups={groupByDetail(buckets.risk, '')} />}
    {pendingGroups.length > 0 && <div className="min-w-0 space-y-2 rounded-lg border border-line bg-canvas px-3 py-2">
      {pendingGroups.map((group, index) => <PendingReasonBlock key={group.reason} reason={group.reason} subjects={group.subjects} separated={index > 0} />)}
    </div>}
    {buckets.clear.length > 0 && <ClearSubjectBlock subjects={buckets.clear} />}
  </div>;
}

export function CheckFindingCard({ finding, showAllGuidance = false, showRiskLevel = true }: { finding: EndpointFinding; showAllGuidance?: boolean; showRiskLevel?: boolean }) {
  const state = checkedState(finding.state);
  const pending = state === 'not_checked';
  const titleId = useId();
  const why = pending
    ? textOr(finding.notCheckedReason, '终端尚未提供这项检查的原因。')
    : textOr(finding.plainWhy, '尚未提供检查原因，请补充检查记录。');
  const fix = pending
    ? textOr(finding.howToCheck, '请补充终端检查记录，再重新检测。')
    : textOr(finding.plainFix, '尚未提供整改建议，请联系管理员确认下一步。');
  return (
    <article aria-labelledby={titleId} className="min-w-0 rounded-xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 id={titleId} className="min-w-0 break-words text-sm font-semibold leading-6 text-ink">{textOr(finding.plainTitle, '终端检查项')}</h3>
        <div className="flex flex-wrap gap-2"><SafetyStateBadge state={state} />{showRiskLevel && state === 'risk' && <RiskLevelBadge severity={finding.severity} />}</div>
      </div>
      <dl className="mt-4 space-y-3">
        <DetailField label="涉及对象">
          {finding.subjects?.length
            ? (finding.subjects.length > SUBJECT_FOLD_THRESHOLD
              ? <SubjectAggregate subjects={finding.subjects} />
              : <ul className="space-y-3">{finding.subjects.map((subject, index, all) => (
                <SubjectRow key={`${subject.kind}-${subject.name}-${index}`} subject={subject}
                  showDetail={all.findIndex((item) => item.detail?.trim() === subject.detail?.trim()) === index} />
              ))}</ul>)
            : <p className="text-sm text-ink-3">尚未提供涉及对象。</p>}
        </DetailField>
        <DetailField label={pending ? '未检查的原因' : '检查原因'}><ExpandableSafetyText text={why} label="检查原因" /></DetailField>
        <DetailField label={pending ? '检查办法' : '整改建议'}><ExpandableSafetyText text={fix} label="下一步建议" /></DetailField>
        {showAllGuidance && pending && finding.plainWhy?.trim() && finding.plainWhy !== why && <DetailField label="检查原因"><ExpandableSafetyText text={finding.plainWhy} label="补充原因" /></DetailField>}
        {showAllGuidance && !pending && finding.howToCheck && finding.subjects?.some(subject => subject.state === 'not_checked') && <DetailField label="检查办法"><ExpandableSafetyText text={finding.howToCheck} label="检查办法" /></DetailField>}
        {showAllGuidance && pending && finding.plainFix?.trim() && finding.plainFix !== fix && <DetailField label="整改建议"><ExpandableSafetyText text={finding.plainFix} label="整改建议" /></DetailField>}
        {finding.evidence?.trim() && <DetailField label="检查证据"><ExpandableSafetyText text={finding.evidence} label="检查证据" collapsed /></DetailField>}
      </dl>
    </article>
  );
}

export function RiskCategoryCard({ title, description, findings, extra, showAllGuidance = false, showItemRiskLevel = true }: {
  title: string;
  description?: string;
  findings: EndpointFinding[];
  extra?: ReactNode;
  showAllGuidance?: boolean;
  showItemRiskLevel?: boolean;
}) {
  const counts = { risk: 0, clear: 0, not_checked: 0 };
  for (const finding of findings) counts[checkedState(finding.state)]++;
  return <SectionCard title={title} description={description} extra={extra}>
    {findings.length ? <><p className="mb-4 text-[13px] text-ink-3">发现风险 {counts.risk} 项 · 已检查无风险 {counts.clear} 项 · 终端没检查 {counts.not_checked} 项</p>
      <div className="space-y-4">{findings.map((finding, index) => <CheckFindingCard key={index} finding={finding} showAllGuidance={showAllGuidance} showRiskLevel={showItemRiskLevel} />)}</div></>
      : <EmptyState title="尚无检查结果" description="请先发起终端检查；没有结果不代表已检查无风险。" />}
  </SectionCard>;
}

export function EndpointConclusion({ verdictLine, state, description, showState = true }: {
  verdictLine?: string | null;
  state?: SafetyState | null;
  description?: string;
  showState?: boolean;
}) {
  return <div className="rounded-card border border-line bg-white px-6 py-5">
    <div className="flex flex-wrap items-start gap-3">{showState && <SafetyStateBadge state={state} />}<div className="min-w-0 flex-1 text-sm font-semibold text-ink"><ExpandableSafetyText text={textOr(verdictLine, '尚无检查结论，请先完成终端检查。')} label="检查结论" /></div></div>
    {description && <div className="mt-2 text-ink-3"><ExpandableSafetyText text={description} label="结论说明" /></div>}
  </div>;
}

export function KeyMetricCards({ metrics }: { metrics: EndpointMetric[] }) {
  if (!metrics.length) return <EmptyState title="尚无统计数据" description="请先完成终端检查。" />;
  return <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{metrics.map((metric, index) => (
    <Card key={index} className="min-w-0 px-6 py-5">
      <dt className="text-[13px] text-ink-3">{metric.label}</dt>
      <dd className="mt-2 text-[28px] font-semibold leading-tight tabular-nums text-ink">
        {metric.value == null || !Number.isFinite(metric.value) ? <span className="text-sm font-normal text-ink-3">暂无数据</span> : <><span>{metric.value}</span>{metric.unit && <span className="ml-2 text-[13px] font-normal text-ink-3">{metric.unit}</span>}</>}
      </dd>
      {metric.description && <div className="mt-2 text-ink-3"><ExpandableSafetyText text={metric.description} label="数字说明" /></div>}
    </Card>
  ))}</dl>;
}

/** 契约场景没有三态字段，调用方必须传入实际执行状态；不推断结论。 */
export function LiveScenarioCard({ title, scenario, state, renderText }: {
  title?: string;
  scenario: EndpointLiveScenario;
  state?: SafetyState | null;
  renderText?: (text: string) => ReactNode;
}) {
  return <SectionCard title={title || '真机场景检查'} extra={<SafetyStateBadge state={state} />}>
    <dl className="grid gap-6 md:grid-cols-2">
      {[
        ['让它做了什么', textOr(scenario.whatWeAsked, '尚未提供测试要求。')],
        ['它实际做了什么', textOr(scenario.whatItDid, '尚未提供操作记录。')],
        ['判定依据', textOr(scenario.judgement, '尚未形成检查结论，请补充运行记录。')],
      ].map(([label, text]) => <div key={label} className="min-w-0"><dt className="mb-1 text-[13px] text-ink-3">{label}</dt><dd className="text-ink-2"><ExpandableSafetyText text={text!} label={label!} renderText={renderText} /></dd></div>)}
      <div className="min-w-0"><dt className="mb-1 text-[13px] text-ink-3">证据摘录</dt><dd className="rounded-lg border border-line bg-canvas p-3 text-ink-2">
        {scenario.evidenceExcerpt?.trim() ? <ExpandableSafetyText text={scenario.evidenceExcerpt} label="场景证据" collapsed renderText={renderText} /> : <p className="text-sm">尚未提供证据，请补充终端运行记录。</p>}
      </dd></div>
    </dl>
  </SectionCard>;
}

function agentReadiness(agent: EndpointAgent) {
  if (agent.liveEvalBlockedReason?.trim()) return { ready: false, reason: agent.liveEvalBlockedReason };
  if (agent.liveEvalSupported === false) return { ready: false, reason: '当前尚不支持该智能体的启动方式。' };
  if (agent.liveEvalRegistered === false) return { ready: false, reason: '终端尚未登记此智能体，请由管理员完成登记。' };
  if (agent.liveEvalSupported !== true || agent.liveEvalRegistered !== true) return { ready: false, reason: '尚未收到真机测评能力信息，请补充检查。' };
  return { ready: true, reason: '已支持且已登记；这不代表已经完成检查。' };
}

export function AgentInventoryCard({ agents, description, title = '智能体清单', versionSeparator, mode = 'live', enableHint }: {
  agents?: EndpointAgent[] | null;
  description?: string;
  title?: string;
  versionSeparator?: string;
  /** posture：配置体检，只列产品与版本并合并重复安装；live：真机测评，逐处保留。 */
  mode?: 'posture' | 'live';
  /** 真机测评的开启入口，由页面提供，组件不杜撰操作路径。 */
  enableHint?: ReactNode;
}) {
  if (mode === 'posture')
    return <PostureAgentInventory agents={agents} description={description} title={title} versionSeparator={versionSeparator} />;
  const readiness = (agents ?? []).map((agent) => agentReadiness(agent));
  const reasons = [...new Set(readiness.map((item) => item.reason))];
  // 所有卡片的阻塞原因相同时只在上方说一次，卡片里不再重复十几遍。
  const sharedReason = agents?.length && reasons.length === 1 ? reasons[0]! : null;
  return <SectionCard title={title} description={description || '逐处展示安装与真机测评条件；可发起不代表已检查。'}>
    {agents?.length ? <>
      {sharedReason && <div className="mb-4 rounded-lg border border-line bg-canvas px-4 py-3 text-[13px] text-ink-3"><p>{sharedReason}</p>{enableHint}</div>}
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{agents.map((agent, index) => {
        const item = agentReadiness(agent);
        return <li key={`${agent.product}-${index}`} className="min-w-0 rounded-xl border border-line bg-canvas p-4">
          <h3 className="break-words text-sm font-semibold text-ink">{agentTitle(agent, versionSeparator)}</h3>
          {versionSeparator == null && <p className="mt-1 text-[13px] text-ink-3">{textOr(agent.version, '版本未知')}</p>}
          <div className="mt-3"><Badge tone={item.ready ? 'info' : 'neutral'}>{item.ready ? '可发起真机测评' : '暂不能发起真机测评'}</Badge></div>
          {!sharedReason && <div className="mt-2 text-ink-3"><ExpandableSafetyText text={item.reason} label="测评条件" /></div>}
        </li>;
      })}</ul>
    </> : <EmptyState title="尚未收到智能体清单" description="请补充终端采集记录，不能据此判断终端未安装智能体。" />}
  </SectionCard>;
}

function agentTitle(agent: EndpointAgent, versionSeparator?: string) {
  const name = textOr(agent.displayName, '未命名智能体');
  return versionSeparator == null ? name : `${name}${versionSeparator}${textOr(agent.version, '版本未知')}`;
}

/** 配置体检只说明装了哪些智能体、各是什么版本，不讲与本任务无关的测评条件。 */
function PostureAgentItem({ agent, count, hints, versionSeparator }: {
  agent: EndpointAgent;
  count: number;
  hints: string[];
  versionSeparator?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <li className="min-w-0 rounded-xl border border-line bg-canvas p-4">
    <h3 className="break-words text-sm font-semibold text-ink">{agentTitle(agent, versionSeparator)}
      {count > 1 && <span className="ml-1 font-normal text-ink-3">×{count} 处</span>}</h3>
    {versionSeparator == null && <p className="mt-1 text-[13px] text-ink-3">{textOr(agent.version, '版本未知')}</p>}
    {count > 1 && <>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className={cn('mt-2', foldButtonClass())}>
        {open ? '收起安装位置' : `查看 ${count} 处安装位置`}
      </button>
      <div id={id} hidden={!open} className="mt-2 space-y-1 text-[13px] text-ink-3">
        {hints.map((hint, index) => <p key={`${hint}-${index}`}>第 {index + 1} 处 · 安装位置指纹 {hint}</p>)}
        {hints.length < count && <p>{hints.length ? `另有 ${count - hints.length} 处` : `${count} 处`}安装没有上报可区分的位置信息。</p>}
      </div>
    </>}
  </li>;
}

function PostureAgentInventory({ agents, description, title, versionSeparator }: {
  agents?: EndpointAgent[] | null;
  description?: string;
  title: string;
  versionSeparator?: string;
}) {
  const groups: Array<{ key: string; agent: EndpointAgent; count: number; hints: string[] }> = [];
  for (const agent of agents ?? []) {
    const key = `${agent.product}|${agent.version ?? ''}`;
    const found = groups.find((group) => group.key === key);
    if (found) {
      found.count += 1;
      if (agent.installHint) found.hints.push(agent.installHint);
    } else groups.push({ key, agent, count: 1, hints: agent.installHint ? [agent.installHint] : [] });
  }
  return <SectionCard title={title} description={description || '这台电脑已安装的智能体与版本；同一产品、同一版本的重复安装合并显示。'}>
    {groups.length ? <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{groups.map((group) => (
      <PostureAgentItem key={group.key} agent={group.agent} count={group.count} hints={group.hints} versionSeparator={versionSeparator} />
    ))}</ul> : <EmptyState title="尚未收到智能体清单" description="请补充终端采集记录，不能据此判断终端未安装智能体。" />}
  </SectionCard>;
}

