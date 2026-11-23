import { useState, type ReactNode, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  EndpointOverview,
  EndpointAgentRow,
  EndpointMcpRow,
  EndpointRiskRow,
  EndpointSkillRow,
  OverviewAssetState,
} from '../../../../../packages/shared/src/endpoint-overview';
import { NOT_CHECKED_OWNER_LABELS } from '../../../../../packages/shared/src/not-checked';
import {
  PlatformDetails,
  PlatformChecks,
  platformStatus,
  platformPorts,
  platformSubtitle,
} from './EndpointPlatformDetails';
import { SegmentTabs } from '@/components/page-kit/SegmentTabs';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DetailDrawer } from './DetailDrawer';
import { Meta, OwnerChip, StateBadge, causeOf } from './DrawerParts';
import {
  AgentDetails,
  McpDetails,
  RiskDetails,
  SkillDetails,
  mcpBadgeLabel,
  riskSubtitle,
  skillBadgeLabel,
} from './OverviewDrawers';
import {
  categoryLabels,
  configLabels,
  levelLabels,
  scopeLabel,
  transportLabel,
} from './overview-labels';
import { formatDateTime } from '@/lib/format';
import { FLEET_JOB_STATUS_LABELS } from '@/lib/fleet';
import type { FleetAgentRow } from '@/lib/api';

export type OverviewTab = 'risks' | 'agents' | 'skills' | 'mcp' | 'history' | 'platforms';
export type OverviewFilter = 'all' | OverviewAssetState | 'unknown';
/** 同产品多处安装时，在名称下方区分每一行：账号 · 位置；两项都没有则不出这一行。 */
function installLine(agent: EndpointAgentRow): string {
  return [agent.account, agent.location].filter(Boolean).join(' · ');
}
/** 风险表“状态”列：没检查的写谁来处理，其余沿用等级对应的状态。 */
function riskStatus(risk: EndpointRiskRow): string {
  if (risk.level === 'NOT_CHECKED')
    return risk.owner ? NOT_CHECKED_OWNER_LABELS[risk.owner] : '没检查';
  return risk.level === 'REVIEW' ? '待确认' : '需处理';
}
const agentVersion = (agent: EndpointAgentRow) =>
  !agent.version || agent.version === 'version_unknown' ? '版本未知' : agent.version;
const readinessLabel = (row: FleetAgentRow | undefined) => row
  ? ({ ready: '可测', needs_attention: '需处理', unsupported: '不支持', offline: '终端离线', platform_managed: '平台管理' } as const)[row.status]
  : '未上报';
/** 智能体抽屉标题下：版本（有多个时列出其余）、安装数、同产品多处安装时的账号与位置。 */
function agentSubtitle(agent: EndpointAgentRow, multiRow: boolean) {
  return (
    <Meta
      items={[
        agentVersion(agent),
        !!agent.otherVersions?.length && `另有 ${agent.otherVersions.join('、')}`,
        agent.installs > 1 && `${agent.installs} 处安装`,
        multiRow && installLine(agent),
      ]}
    />
  );
}
function skillSubtitle(skill: EndpointSkillRow, state: OverviewAssetState) {
  return (
    <>
      <StateBadge state={state} label={skillBadgeLabel(skill, state)} />
      {state === 'not_checked' && <OwnerChip owner={causeOf(skill.cause).owner} />}
      <Meta items={[skill.sourceLabel, skill.installedIn.join('、')]} />
    </>
  );
}
function mcpSubtitle(mcp: EndpointMcpRow) {
  return (
    <>
      <StateBadge state={mcp.state} label={mcpBadgeLabel(mcp)} />
      <Meta items={[transportLabel(mcp.transport), mcp.installedIn.join('、')]} />
    </>
  );
}
function skillState(skill: EndpointSkillRow): OverviewAssetState {
  return skill.state === 'risk' &&
    skill.hits.length > 0 &&
    skill.hits.every((h) => h.contextType === 'document')
    ? 'review'
    : skill.state;
}
/** 导出当前页签内符合搜索与筛选条件的全部行，防止公式注入。 */
export function exportOverviewCsv(headers: string[], rows: string[][], name: string) {
  const quote = (value: string) =>
    `"${(/^[=+@\-\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
  const blob = new Blob(
    ['\uFEFF' + [headers, ...rows].map((row) => row.map(quote).join(',')).join('\r\n')],
    { type: 'text/csv;charset=utf-8;' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function EndpointOverviewLists({
  overview,
  showCounts = false,
  exportRef,
  agentRows,
  canStartEval = false,
}: {
  overview: EndpointOverview;
  showCounts?: boolean;
  exportRef?: { current: (() => void) | null };
  agentRows?: FleetAgentRow[];
  canStartEval?: boolean;
}) {
  const [tab, setTab] = useState<OverviewTab>('risks');
  const [filter, setFilter] = useState<OverviewFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [drawer, setDrawer] = useState<{
    title: string;
    subtitle?: ReactNode;
    body: ReactNode;
  } | null>(null);
  const change = (next: OverviewTab, nextFilter: OverviewFilter = 'all') => {
    setTab(next);
    setFilter(nextFilter);
    setSearch('');
    setPage(1);
  };
  const openRow = (event: MouseEvent<HTMLTableRowElement>) => {
    if (event.target instanceof Element && !event.target.closest('button, a'))
      event.currentTarget.querySelector<HTMLElement>('button, a')?.click();
  };
  const open = (title: string, body: ReactNode, subtitle?: ReactNode) =>
    setDrawer({ title, subtitle, body });
  const openRisk = (r: EndpointRiskRow) => open(r.title, <RiskDetails risk={r} />, riskSubtitle(r));
  const matches = (name: string, state: OverviewAssetState, unknown = false) =>
    name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
    (filter === 'all' || (filter === 'unknown' ? unknown : state === filter));
  const risks = overview.risks.filter((r) =>
    matches(
      r.title,
      r.level === 'NOT_CHECKED' ? 'not_checked' : r.level === 'REVIEW' ? 'review' : 'risk',
    ),
  );
  const skills = overview.skills.filter((s) =>
    matches(s.name, skillState(s), s.sourceState === 'unknown'),
  );
  const mcp = overview.mcp.filter((m) => matches(m.name, m.state));
  const agents = overview.agents.filter((a) =>
    matches(
      a.name,
      ['not_checked', 'read_failed', 'internal_store', 'unrecorded'].includes(a.configState)
        ? 'not_checked'
        : a.issues
          ? 'risk'
          : 'clear',
    ),
  );
  // 同一产品出现多行时才区分安装；单行不加任何信息。
  const agentRowCount = new Map<string, number>();
  for (const a of overview.agents) agentRowCount.set(a.key, (agentRowCount.get(a.key) ?? 0) + 1);
  const platforms = (overview.platforms ?? []).filter((p) =>
    matches(p.name, p.issues ? 'risk' : p.readState !== 'complete' ? 'not_checked' : 'clear'),
  );
  const headers: Record<OverviewTab, string[]> = {
    risks: ['等级', '类别', '问题', '涉及', '依据', '状态'],
    platforms: ['名称', '版本', '容器', '敏感端口', '检查结果'],
    agents: ['名称', '版本', '安装数', '配置是否读到', '问题数', '真机测评条件', ...(showCounts ? ['最近结论', '操作'] : [])],
    skills: ['名称', '来源', '装在哪', '状态'],
    mcp: ['名称', '传输方式', '范围', '装在哪', '状态'],
    history: ['检测时间', '检测方式', '智能体', '样本数', '状态', '结论'],
  };
  const rows: Record<OverviewTab, string[][]> = {
    risks: risks.map((r) => [
      levelLabels[r.level],
      categoryLabels[r.category],
      r.title,
      r.involved,
      r.basis,
      riskStatus(r),
    ]),
    platforms: platforms.map((p) => [
      p.name,
      p.version || '版本未知',
      `${p.running}/${p.containers}`,
      platformPorts(p),
      platformStatus(p),
    ]),
    agents: agents.map((a) => [
      installLine(a) && agentRowCount.get(a.key)! > 1 ? `${a.name}（${installLine(a)}）` : a.name,
      agentVersion(a),
      String(a.installs),
      configLabels[a.configState],
      String(a.issues),
      showCounts ? readinessLabel(agentRows?.find((row) => row.agentKey === a.key)) : a.liveEval.registered && a.liveEval.supported ? '已登记' : a.liveEval.reason || '暂不可用',
      ...(showCounts ? [agentRows?.find((row) => row.agentKey === a.key)?.latest?.conclusion || '未上报', ''] : []),
    ]),
    skills: skills.map((s) => [
      s.name,
      s.sourceLabel,
      s.installedIn.join('、'),
      skillBadgeLabel(s, skillState(s)),
    ]),
    mcp: mcp.map((m) => [
      m.name,
      transportLabel(m.transport),
      scopeLabel(m.scope),
      m.installedIn.join('、'),
      mcpBadgeLabel(m),
    ]),
    history: overview.history.map((h) => [
      formatDateTime(h.createdAt),
      h.modeLabel,
      h.agentName || '未上报',
      h.sampleCount == null ? '未上报' : String(h.sampleCount),
      (h.mode === 'live' ? (FLEET_JOB_STATUS_LABELS as Record<string, string>)[h.status] : undefined) || (
        {
          COMPLETED: '已完成',
          RUNNING: '进行中',
          PENDING: '等待中',
          FAILED: '失败',
          CANCELLED: '已取消',
          CANCELED: '已取消',
        } as Record<string, string>
      )[h.status] || '状态未知',
      h.summaryLine,
    ]),
  };
  const range = <T,>(list: T[]) => list.slice((page - 1) * 20, page * 20);
  if (exportRef)
    exportRef.current = () =>
      exportOverviewCsv(headers[tab], rows[tab], `终端-${overview.endpointId}-${tab}`);
  const c = overview.counts;
  return (
    <div className="space-y-4">
      {showCounts && (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[
            {
              title: '待处理风险',
              value: c.openRisks,
              note: `${c.highRisks} 项高危`,
              go: () => change('risks', 'risk'),
            },
            {
              title: '智能体',
              value: `${c.agentKinds} 种`,
              note: `${c.agentInstalls} 处安装`,
              go: () => change('agents'),
            },
            {
              title: 'Skill / MCP',
              value: `${c.skills} / ${c.mcpServers}`,
              note: '',
              go: () => change('skills'),
            },
            {
              title: '没检查',
              value: `${c.notCheckedKinds} 类`,
              // 管理员能动手的先说；旧响应没有这个计数，退回原来的安装数。
              note:
                c.notCheckedAdmin === undefined
                  ? `${c.notCheckedInstalls} 处安装`
                  : c.notCheckedAdmin > 0
                    ? `${c.notCheckedAdmin} 类需管理员处理`
                    : '无需管理员处理',
              go: () => change('risks', 'not_checked'),
            },
          ].map((card) => (
            <button
              key={card.title}
              onClick={card.go}
              className="rounded-xl border border-line bg-white px-5 py-3 text-left hover:border-brand-300"
            >
              <span className="text-sm text-ink-3">{card.title}</span>
              <div className="mt-1 text-2xl font-semibold">
                {card.value}
                <span className="ml-3 text-xs font-normal text-ink-3">{card.note}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      <section className="rounded-xl border border-line bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <SegmentTabs
            value={tab}
            onChange={change}
            ariaLabel="终端清单"
            items={[
              { value: 'risks', label: `风险 ${overview.risks.length}` },
              ...((overview.platforms ?? []).length
                ? [{ value: 'platforms' as const, label: `平台 ${overview.platforms.length}` }]
                : []),
              { value: 'agents', label: `智能体 ${overview.agents.length}` },
              { value: 'skills', label: `Skill ${overview.skills.length}` },
              { value: 'mcp', label: `MCP ${overview.mcp.length}` },
              { value: 'history', label: `检测记录 ${overview.history.length}` },
            ]}
          />
          {!exportRef && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                exportOverviewCsv(headers[tab], rows[tab], `终端-${overview.endpointId}-${tab}`)
              }
            >
              导出清单
            </Button>
          )}
        </div>
        {tab !== 'history' && (
          <div className="my-4 flex flex-wrap items-center gap-3">
            <Input
              type="search"
              aria-label="搜索清单"
              placeholder="搜索名称"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="max-w-xs"
            />
            <select
              aria-label="筛选状态"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value as OverviewFilter);
                setPage(1);
              }}
              className="h-9 rounded-lg border border-line bg-white px-3 text-sm"
            >
              <option value="all">全部</option>
              <option value="risk">需处理</option>
              <option value="review">待确认</option>
              {tab === 'skills' && <option value="unknown">来源未知</option>}
              <option value="not_checked">没检查</option>
              <option value="clear">已检查无风险</option>
            </select>
          </div>
        )}
        <Table fit={tab === 'risks'} className={tab === 'risks' ? 'mt-3 md:min-w-[960px]' : 'mt-3'}>
          {tab === 'risks' && (
            <colgroup>
              <col style={{ width: 76 }} />
              <col style={{ width: 92 }} />
              <col style={{ width: '24%' }} />
              <col style={{ width: '20%' }} />
              <col />
              <col style={{ width: 120 }} />
              <col style={{ width: 36 }} />
            </colgroup>
          )}
          <THead>
            <TR>
              {headers[tab].map((h) => (
                <TH key={h}>{h}</TH>
              ))}
              <TH aria-label="详情" />
            </TR>
          </THead>
          <TBody>
            {tab === 'risks' &&
              range(risks).map((r) => (
                <TR
                  key={r.id}
                  className={
                    r.level === 'REVIEW' || r.level === 'NOT_CHECKED'
                      ? r.owner === 'admin'
                        ? 'cursor-pointer bg-[#FAFBFD]'
                        : 'cursor-pointer bg-[#FAFBFD] text-ink-3'
                      : 'cursor-pointer'
                  }
                  onClick={() => openRisk(r)}
                >
                  <TD>
                    <Badge
                      className={r.level === 'HIGH' ? 'bg-[#FDECEA] text-[#B42318]' : undefined}
                      tone={
                        r.level === 'HIGH' ? 'danger' : r.level === 'MEDIUM' ? 'warning' : 'neutral'
                      }
                    >
                      {levelLabels[r.level]}
                    </Badge>
                  </TD>
                  <TD className="whitespace-nowrap">{categoryLabels[r.category]}</TD>
                  <TD className="py-2">
                    <button
                      title={r.title}
                      className="line-clamp-2 text-left font-medium"
                      onClick={(e) => {
                        e.stopPropagation();
                        openRisk(r);
                      }}
                    >
                      {r.title}
                    </button>
                  </TD>
                  <TD className="py-2">
                    <span title={r.involved} className="line-clamp-2 break-words">
                      {r.involved}
                    </span>
                  </TD>
                  <TD className="py-2 text-ink-2">
                    <span title={r.basis} className="line-clamp-2 break-words">
                      {r.basis}
                    </span>
                  </TD>
                  <TD className="whitespace-nowrap">
                    {r.level === 'NOT_CHECKED' && r.owner ? (
                      <OwnerChip owner={r.owner} />
                    ) : (
                      riskStatus(r)
                    )}
                  </TD>
                  <TD className="text-ink-3">›</TD>
                </TR>
              ))}
            {tab === 'platforms' &&
              range(platforms).map((p) => (
                <TR key={p.key} className="cursor-pointer" onClick={openRow}>
                  <TD>
                    <button
                      className="font-medium"
                      onClick={() =>
                        open(p.name, <PlatformDetails platform={p} />, platformSubtitle(p))
                      }
                    >
                      {p.name}
                    </button>
                  </TD>
                  <TD>{p.version || '版本未知'}</TD>
                  <TD>
                    {p.running}/{p.containers}
                  </TD>
                  <TD>
                    <span className={p.exposedPorts > 0 ? 'text-[#B42318]' : undefined}>
                      {platformPorts(p)}
                    </span>
                  </TD>
                  <TD>
                    <PlatformChecks platform={p} />
                  </TD>
                  <TD>›</TD>
                </TR>
              ))}
            {tab === 'agents' &&
              range(agents).map((a, i) => (
                <TR key={`${a.key}-${i}`} className="cursor-pointer" onClick={openRow}>
                  <TD>
                    <button
                      className="font-medium"
                      onClick={() =>
                        open(
                          a.name,
                          <AgentDetails agent={a} />,
                          agentSubtitle(a, agentRowCount.get(a.key)! > 1),
                        )
                      }
                    >
                      {a.name}
                    </button>
                    {agentRowCount.get(a.key)! > 1 && installLine(a) && (
                      <div
                        title={installLine(a)}
                        className="mt-0.5 max-w-[260px] truncate text-xs font-normal text-ink-3"
                      >
                        {installLine(a)}
                      </div>
                    )}
                  </TD>
                  <TD>{agentVersion(a)}</TD>
                  <TD>{a.installs}</TD>
                  <TD>
                    <Badge
                      tone={
                        a.configState === 'checked'
                          ? 'success'
                          : a.configState === 'read_failed'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {configLabels[a.configState]}
                    </Badge>
                  </TD>
                  <TD>{a.issues}</TD>
                  <TD>{showCounts ? readinessLabel(agentRows?.find((row) => row.agentKey === a.key)) : a.liveEval.registered && a.liveEval.supported ? '已登记' : '暂不可用'}</TD>
                  {showCounts && <>
                    <TD>{(() => {
                      const row = agentRows?.find((item) => item.agentKey === a.key);
                      return row ? row.latest ? row.latest.conclusion || FLEET_JOB_STATUS_LABELS[row.latest.status] || '结论未上报' : '暂无测评' : '未上报';
                    })()}</TD>
                    <TD>{agentRows?.find((item) => item.agentKey === a.key)?.status === 'ready' && canStartEval ?
                      <Link className="text-brand-700 hover:underline" to={`/agent-evals/new?endpoint=${encodeURIComponent(overview.endpointId)}&agent=${encodeURIComponent(a.key)}`}>发起测评</Link> : '—'}</TD>
                  </>}
                  <TD>›</TD>
                </TR>
              ))}
            {tab === 'skills' &&
              range(skills).map((s, i) => {
                const state = skillState(s);
                return (
                  <TR key={`${s.name}-${i}`} className="cursor-pointer" onClick={openRow}>
                    <TD>
                      <button
                        className="font-medium"
                        onClick={() =>
                          open(
                            s.name,
                            <SkillDetails skill={s} state={state} />,
                            skillSubtitle(s, state),
                          )
                        }
                      >
                        {s.name}
                      </button>
                    </TD>
                    <TD>{s.sourceLabel}</TD>
                    <TD>{s.installedIn.join('、') || '未上报'}</TD>
                    <TD>
                      <StateBadge state={state} label={skillBadgeLabel(s, state)} />
                    </TD>
                    <TD>›</TD>
                  </TR>
                );
              })}
            {tab === 'mcp' &&
              range(mcp).map((m, i) => (
                <TR key={`${m.name}-${i}`} className="cursor-pointer" onClick={openRow}>
                  <TD>
                    <button
                      className="font-medium"
                      onClick={() => open(m.name, <McpDetails mcp={m} />, mcpSubtitle(m))}
                    >
                      {m.name}
                    </button>
                  </TD>
                  <TD>{transportLabel(m.transport)}</TD>
                  <TD>{scopeLabel(m.scope)}</TD>
                  <TD>{m.installedIn.join('、')}</TD>
                  <TD>
                    <StateBadge state={m.state} label={mcpBadgeLabel(m)} />
                  </TD>
                  <TD>›</TD>
                </TR>
              ))}
            {tab === 'history' &&
              range(overview.history).map((h, i) => (
                <TR key={h.taskId} className="cursor-pointer" onClick={openRow}>
                  {(rows.history[i + (page - 1) * 20] ?? []).map((cell, j) => (
                    <TD key={j}>
                      {j === 0 ? (
                        <Link className="font-medium text-brand-700" to={`/eval-tasks/${h.taskId}`}>
                          {cell}
                        </Link>
                      ) : (
                        cell
                      )}
                    </TD>
                  ))}
                  <TD>›</TD>
                </TR>
              ))}
            {!rows[tab].length && (
              <TR>
                <TD colSpan={headers[tab].length + 1} className="py-10 text-center text-ink-3">
                  没有符合条件的记录
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
        <Pagination page={page} pageSize={20} total={rows[tab].length} onPageChange={setPage} />
      </section>
      {drawer && (
        <DetailDrawer
          title={drawer.title}
          subtitle={drawer.subtitle}
          onClose={() => setDrawer(null)}
        >
          {drawer.body}
        </DetailDrawer>
      )}
    </div>
  );
}
