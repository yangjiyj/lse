import { createHash } from 'node:crypto';
import {
  REVIEW_ROW,
  skillHitFromCheck,
  type EndpointOverview,
  type EndpointRiskRow,
  type EndpointSkillRow,
  type OverviewAssetState,
} from '../../../../../packages/shared/src/endpoint-overview.js';
import { fleetAgentIdentity } from '../../../../../packages/shared/src/fleet-agent-display.js';
import {
  SKILL_CAUSE_ORDER,
  buildNotCheckedRows,
  causeFromEvidenceCode,
  notCheckedSubjectLabel,
  type NotCheckedEntry,
} from '../../../../../packages/shared/src/not-checked.js';
import { endpointAgents } from './agents.js';
import { ALL_SAMPLES } from '../endpoint-evals/samples/registry.js';
import { aggregatePlatforms } from './platforms.js';
import { aggregateBlast } from './blast.js';
import { judgeProbeReport } from './posture.js';
import {
  arr,
  rec,
  str,
  reportInventory,
  sourceLabel,
  holderChecks,
  agentConfigItems,
  summarizeAgentConfig,
  type Rec,
} from './inventory.js';
const date = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : str(v) || null);
const levels = ['HIGH', 'MEDIUM', 'LOW', 'REVIEW', 'NOT_CHECKED'];
const stateOrder = ['risk', 'review', 'not_checked', 'clear'];
const builtinSampleIds = new Set(ALL_SAMPLES.map((sample) => sample.id));
const SUPPLEMENTAL_POSTURE_RULES = new Set([
  'sandbox_scope',
  'sandbox_enabled',
  'sandbox_bypass',
  'sandbox_credential_read',
  'model_destination',
  'agent_version',
  'platform_exposure',
  'platform_telemetry',
  'platform_version',
  'run_as_admin',
  'dir_scope',
  'logging',
  'listen_exposure',
  'install_source',
  'install_integrity',
]);
export function jobSampleCount(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  try {
    const scenarios = rec(rec(JSON.parse(value)).scenario_pack).scenarios;
    if (!Array.isArray(scenarios) || !scenarios.length) return null;
    const ids = scenarios.map((scenario) => str(rec(scenario).sample_id || rec(scenario).scenario_id));
    return ids.every(Boolean) ? new Set(ids.map((id) => {
      if (builtinSampleIds.has(id)) return id;
      const base = id.replace(/\.(?:py|node)$/, '');
      return builtinSampleIds.has(base) ? base : id;
    })).size : null;
  } catch {
    return null;
  }
}
const mcpChecks: Record<string, string> = {
  'mcp.authorization': '访问授权',
  'mcp.credential': '凭据保护',
  'mcp.source': '工具来源',
  'mcp.transport': '传输连接',
  'mcp.dependency': '依赖组件',
  'mcp.descriptions': '工具描述',
  'mcp.launch': '启动命令',
};
const fingerprint = (values: string[]) =>
  createHash('sha256')
    .update([...new Set(values)].sort().join('|'))
    .digest('hex')
    .slice(0, 16);
function assetState(states: string[]): OverviewAssetState {
  return states.includes('risk')
    ? 'risk'
    : states.includes('review')
      ? 'review'
      : !states.length || states.includes('not_checked')
        ? 'not_checked'
        : 'clear';
}
/** 纯读模型：上报、终端和批量读取的任务由调用方提供，无数据库和网络访问。 */
export function buildEndpointOverview(
  report: unknown,
  endpoint: unknown,
  jobs: unknown = [],
  allowedHosts: string[] = [],
): EndpointOverview {
  const e = rec(endpoint),
    r = rec(report),
    body = rec(r.body ?? report);
  const result: EndpointOverview = {
    endpointId: str(e.id),
    report: null,
    counts: {
      platformKinds: 0,
      platformContainers: 0,
      openRisks: 0,
      highRisks: 0,
      reviewItems: 0,
      agentKinds: 0,
      agentInstalls: 0,
      skills: 0,
      mcpServers: 0,
      notCheckedKinds: 0,
      notCheckedInstalls: 0,
    },
    risks: [],
    agents: [],
    platforms: [],
    skills: [],
    mcp: [],
    history: [],
  };
  const health = rec(e.lastHealth);
  const hasCurrentInventory = Array.isArray(health.agents) || Array.isArray(rec(health.collector).agents);
  if (!report && !hasCurrentInventory) return result;
  if (report) result.report = {
    reportId: str(r.reportId || body.report_id),
    scannedAt: date(r.scannedAt ?? body.scanned_at),
    probeVersion: str(r.probeVersion || body.probe_version) || null,
  };
  const inventory = reportInventory(body),
    findings = judgeProbeReport(body, allowedHosts);
  const capabilities = endpointAgents(hasCurrentInventory ? null : body, e.lastHealth, str(e.evalRunner) || null);
  const agentInventory: Rec[] = hasCurrentInventory
    ? capabilities.flatMap((agent) => {
        const installs = inventory.agents.filter((item) => str(item.name) === agent.product);
        return installs.length ? installs.map((item) => ({ ...item, version: agent.version }))
          : [{ kind: 'cli_agent', name: agent.product, version: agent.version }];
      })
    : inventory.agents;
  const agentGroups = new Map<string, Rec[]>();
  for (const agent of agentInventory) {
    const key = str(agent.name);
    agentGroups.set(key, [...(agentGroups.get(key) ?? []), agent]);
  }
  result.agents = [...agentGroups].map(([key, installs]) => {
    const versions = [
      ...new Set(installs.map((a) => str(a.version)).filter((v) => v && v !== 'version_unknown')),
    ].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const configSummary = summarizeAgentConfig(installs);
    const cap =
      capabilities.find((a) => a.product === key) ??
      endpointAgents(
        { assets: installs.map((a) => ({ ...a, kind: 'cli_agent' })) },
        e.lastHealth,
        str(e.evalRunner) || null,
      )[0];
    const name = fleetAgentIdentity(key);
    const ignoredAccounts = [
      ...new Set(installs.flatMap((install) => inventory.ignored.get(install) ?? [])),
    ].sort();
    return {
      key,
      name,
      version: versions[0] ?? null,
      installs: installs.length,
      ...configSummary,
      issues: findings
        .flatMap((f) => f.subjects)
        .filter((s) => s.kind === 'agent' && s.name.startsWith(name) && s.state === 'risk').length,
      liveEval: {
        supported: cap?.liveEvalSupported ?? false,
        registered: cap?.liveEvalRegistered ?? false,
        reason: cap?.liveEvalBlockedReason ?? null,
      },
      ...(typeof cap?.runtimeV2 === 'boolean' ? { runtimeV2: cap.runtimeV2 } : {}),
      ...(ignoredAccounts.length ? { ignoredAccounts } : {}),
      ...(versions.length > 1 ? { otherVersions: versions.slice(1) } : {}),
    };
  });
  result.skills = inventory.skills
    .map((s): EndpointSkillRow => {
      const own = holderChecks(s).filter((c) => str(c.rule_id).startsWith('skill.'));
      const hits = own.filter((c) => c.status === 'finding');
      const source = sourceLabel(s);
      const subjects = findings
        .filter((f) => f.ruleId === 'skill_risk' || f.ruleId === 'skill_source')
        .flatMap((f) => f.subjects)
        .filter((subject) => subject.subjectKey === s.assetKey);
      const state = assetState(subjects.map((subject) => subject.state));
      // 待确认或需处理的技能也可能脚本没查完：成因照给，列表按整体状态显示，抽屉里两件事都说清楚。
      const cause =
        SKILL_CAUSE_ORDER.find((key) =>
          subjects.some((subject) => subject.state === 'not_checked' && subject.cause === key),
        ) ?? (state === 'not_checked' ? 'skill_no_result' : undefined);
      return {
        name: str(s.name),
        sourceLabel: source,
        sourceState: source === '来源未知' ? 'unknown' : 'known',
        installedIn: s.installedIn as string[],
        installs: (s.installedIn as string[]).length,
        state,
        ...(cause ? { cause } : {}),
        hits: hits.map(skillHitFromCheck),
      };
    })
    .sort(
      (a, b) =>
        stateOrder.indexOf(a.state) - stateOrder.indexOf(b.state) || a.name.localeCompare(b.name),
    );
  result.mcp = inventory.mcp.map((m) => {
    const own = holderChecks(m);
    const checks = Object.entries(mcpChecks).map(([rule, label]) => {
      const matching = own.filter((c) => c.rule_id === rule);
      const state = matching.some((c) => c.status === 'finding')
        ? ('finding' as const)
        : matching.length && matching.every((c) => c.status === 'pass')
          ? ('pass' as const)
          : ('unknown' as const);
      return {
        label,
        state,
        ...(state === 'unknown'
          ? {
              cause: causeFromEvidenceCode(
                'mcp',
                str((matching.find((c) => c.status === 'unknown') ?? matching[0])?.evidence_code),
              ),
            }
          : {}),
      };
    });
    return {
      name: str(m.name),
      transport: str(m.transport) || null,
      scope: str(m.scope) || null,
      installedIn: m.installedIn as string[],
      state: assetState(
        checks.map((c) =>
          c.state === 'finding' ? 'risk' : c.state === 'pass' ? 'clear' : 'not_checked',
        ),
      ),
      checks,
    };
  });
  const platformSummary = aggregatePlatforms(body);
  result.platforms = platformSummary.platforms;
  const risks: EndpointRiskRow[] = [...aggregateBlast(body), ...platformSummary.risks];
  function addRisk(
    id: string,
    level: EndpointRiskRow['level'],
    category: EndpointRiskRow['category'],
    title: string,
    basis: string,
    advice: string,
    subjects: Array<{ name: string; detail: string }>,
    count = subjects.length,
  ) {
    risks.push({
      id: `${id}:${fingerprint(subjects.map((s) => s.name))}`,
      level,
      category,
      title: title.slice(0, 30),
      basis,
      advice,
      involved: `涉及 ${count} 处${category === 'skill' ? '技能' : category === 'mcp' ? '工具' : '安装'}`,
      subjectCount: count,
      subjects: subjects.slice(0, 50),
      moreCount: Math.max(0, subjects.length - 50),
    });
  }
  // 同一判定规则合并为问题行，已检查无风险不生成行。
  for (const f of findings) {
    const category = f.ruleId.startsWith('skill')
      ? 'skill'
      : f.ruleId.startsWith('mcp')
        ? 'mcp'
        : f.ruleId === 'credentials'
          ? 'credential'
          : 'permission';
    for (const state of ['risk', 'review'] as const) {
      const subjects = f.subjects.filter((s) => s.state === state);
      if (!subjects.length) continue;
      const listed = [
        ...new Map(subjects.map((s) => [s.name, { name: s.name, detail: s.detail }])).values(),
      ];
      // 每个对象都是同一句说明时，这句就是依据，不在每个对象下重复；待确认的说明对谁都一样，只列名称。
      const sentences = new Set(listed.map((s) => s.detail));
      const shared = sentences.size === 1 ? [...sentences][0]! : '';
      addRisk(
        f.ruleId,
        state === 'review' ? 'REVIEW' : f.severity,
        category,
        state === 'review' ? REVIEW_ROW.title : f.plainTitle,
        state === 'review'
          ? REVIEW_ROW.basis
          : shared || '探针的配置或可执行内容检查命中了此项规则。',
        state === 'review' ? REVIEW_ROW.advice : f.plainFix,
        state === 'review' ? listed.map(({ name }) => ({ name, detail: '' })) : listed,
      );
    }
  }
  // 没检查按“谁来处理 × 所属领域”合并：每条成因的原因与办法见 shared/not-checked 词表。
  const entries: NotCheckedEntry[] = [];
  for (const f of findings) {
    if (!f.subjects.length && f.state === 'not_checked') {
      // 对照指引新增的补充规则：探针没上报时只在体检结果和报告的检查清单里写未检，不在概览里再加一行。
      if (SUPPLEMENTAL_POSTURE_RULES.has(f.ruleId)) continue;
      entries.push({ cause: 'check_missing', name: f.plainTitle || f.title });
      continue;
    }
    for (const s of f.subjects) {
      if (s.state !== 'not_checked') continue;
      const cause = s.cause ?? 'check_missing';
      entries.push({
        cause,
        name: notCheckedSubjectLabel(s.name),
        // 词表外的兜底成因不说明是哪项检查，对象旁补上检查项标题。
        detail:
          cause === 'check_missing'
            ? [f.plainTitle || f.title, s.where].filter(Boolean).join(' · ')
            : (s.where ?? ''),
        key: `${cause}:${s.subjectKey || s.name}`,
      });
    }
  }
  for (const platform of result.platforms) {
    if (platform.readState === 'not_checked') {
      entries.push({ cause: 'platform_not_assessed', name: platform.name });
      continue;
    }
    const unread = platform.checks.filter((check) => check.state === 'unread');
    for (const check of unread)
      entries.push({ cause: check.cause ?? 'platform_unread', name: platform.name });
    // 状态是“读不全”却没有任何一项标为没读到（旧探针只报了一部分）：也要有一行可闭环。
    if (platform.readState === 'partial' && !unread.length)
      entries.push({ cause: 'platform_unread', name: platform.name });
  }
  risks.push(...buildNotCheckedRows(entries));
  // 没检查的行保持按处理方、领域的顺序，其余按等级和编号。
  result.risks = risks.sort(
    (a, b) =>
      levels.indexOf(a.level) - levels.indexOf(b.level) ||
      (a.level === 'NOT_CHECKED' ? 0 : a.id.localeCompare(b.id)),
  );
  result.history = arr(jobs)
    .sort((a, b) => (date(b.createdAt) || '').localeCompare(date(a.createdAt) || ''))
    .slice(0, 20)
    .map((j) => {
      const mode =
        j.mode === 'live' || j.fleetEvalJob || j.job || arr(j.logs).length
          ? ('live' as const)
          : ('posture' as const);
      const failed = typeof j.failedCount === 'number' ? j.failedCount : 0;
      const fleetJob = rec(j.fleetEvalJob);
      const status = str(fleetJob.status || j.status);
      return {
        taskId: str(j.taskId || j.id),
        mode,
        modeLabel: mode === 'live' ? '真机测评' : '配置体检',
        createdAt: date(j.createdAt) || '',
        status,
        agentName: str(fleetJob.product) ? fleetAgentIdentity(str(fleetJob.product)) : null,
        sampleCount: jobSampleCount(fleetJob.payloadCanonical),
        summaryLine:
          status === 'COMPLETED'
            ? mode === 'live' ? str(j.fleetSummaryLine) || '结论未上报。' : `检查完成，${failed} 项发现风险。`
            : status === 'FAILED' ? '任务执行失败，请查看执行状态。' : '请查看执行状态。',
      };
    });
  result.counts = {
    platformKinds: result.platforms.length,
    platformContainers: result.platforms.reduce((n, p) => n + p.containers, 0),
    openRisks: risks.filter((r) => !['REVIEW', 'NOT_CHECKED'].includes(r.level)).length,
    highRisks: risks.filter((r) => r.level === 'HIGH').length,
    reviewItems: risks.filter((r) => r.level === 'REVIEW').length,
    agentKinds: result.agents.length,
    agentInstalls: agentInventory.length,
    skills: result.skills.length,
    mcpServers: result.mcp.length,
    notCheckedKinds: risks.filter((r) => r.level === 'NOT_CHECKED').length,
    notCheckedInstalls: risks
      .filter((r) => r.level === 'NOT_CHECKED')
      .reduce((n, r) => n + r.subjectCount, 0),
    notCheckedAdmin: risks.filter((r) => r.level === 'NOT_CHECKED' && r.owner === 'admin').length,
  };
  return result;
}
