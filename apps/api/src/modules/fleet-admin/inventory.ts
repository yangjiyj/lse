import {
  isScriptFile,
  type EndpointAgentRow,
} from '../../../../../packages/shared/src/endpoint-overview.js';
import { createHash } from 'node:crypto';
import { fleetAgentIdentity } from '../../../../../packages/shared/src/fleet-agent-display.js';
import { redactString } from '../../lib/redact.js';
import { CONFIG_DEFAULT_NOTE } from '../../../../../packages/shared/src/not-checked.js';
export type Rec = Record<string, unknown>;
export const rec = (v: unknown): Rec =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
export const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const AGENT_KINDS = new Set(['cli_agent', 'ide_plugin', 'desktop_app']);
/** 去控制字符、遮蔽凭据样式内容、限制长度；清理后为空返回 null。 */
export function safeText(value: unknown, max: number): string | null {
  const text = redactString(
    str(value)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim(),
  ).slice(0, max);
  return text || null;
}
export function skillSource(holder: Rec): string | null {
  const nested = arr(holder.skills).find((s) => s.name === holder.name) ?? arr(holder.skills)[0];
  const installation = rec(holder.installation_evidence);
  return (
    str(holder.source) ||
    str(installation.source) ||
    str(nested?.source) ||
    (str(holder.installation_evidence) || str(holder.install_path_label) ? 'local_directory' : null)
  );
}
export function sourceLabel(holder: Rec): string {
  const source = skillSource(holder);
  return source === 'official_marketplace_cache'
    ? '官方市场缓存'
    : source === 'plugin_cache'
      ? '插件缓存'
      : source && !/^(unknown|未知)$/.test(source)
        ? '本地目录'
        : '来源未知';
}
export function holderChecks(holder: Rec): Rec[] {
  return arr(rec(holder.static_assessment).checks);
}
/** 文件扩展名优先；说明文档及无法定位的命中需要人工确认。 */
export function skillHitState(check: Rec): 'risk' | 'review' {
  return isScriptFile(check.file_label) ? 'risk' : 'review';
}
function uniqueChecks(checks: Rec[]): Rec[] {
  return [...new Map(checks.map((c) => [JSON.stringify(c), c])).values()];
}
/** 系统账号：不是登录用户。root 不算，它名下的全局安装是真实安装。 */
function isSystemUid(uid: number): boolean {
  return uid < 0 || (uid > 0 && uid < 1000) || uid >= 60000;
}
function hostAccounts(report: unknown): Map<string, { username: string; uid: number | null }> {
  const accounts = new Map<string, { username: string; uid: number | null }>();
  for (const user of arr(rec(rec(report).host).users)) {
    const key = str(user.account_key);
    const username = safeText(user.username, 64);
    if (!key || !username) continue;
    accounts.set(key, { username, uid: /^-?\d+$/.test(str(user.uid)) ? Number(user.uid) : null });
  }
  return accounts;
}
/**
 * 全局安装的程序会在每个被枚举到的系统账号（nobody、libvirt-qemu 等）名下各登记一次，
 * 它们没有可读的配置，不是用户的安装。折成同一份程序在可读账号下的那一条，并记下账号名。
 * 只在全部满足时折叠：账号是系统账号（或新版探针不再枚举该账号、这条安装本轮是 stale）、
 * 同名同版本同路径指纹、三项设置都没读到、没有任何发现项，且存在一条不满足这些条件的安装可以作代表。
 * 新版探针不再枚举无家目录的系统账号，它们名下遗留的安装本轮标为 stale 且账号表里已查不到账号；
 * 旧探针没有 stale 状态，账号查不到时照旧不折叠。
 */
export function installAgents(report: unknown): { kept: Rec[]; ignored: Map<Rec, string[]> } {
  const agents = arr(rec(report).assets).filter((a) => AGENT_KINDS.has(str(a.kind)));
  const accounts = hostAccounts(report);
  const identity = (a: Rec) =>
    [str(a.name), str(a.version), str(rec(a.evidence).install_path_hash)].join('\u0000');
  const phantom = (a: Rec): boolean => {
    const evidence = rec(a.evidence);
    const owner = str(evidence.owner_account_key);
    const account = accounts.get(owner);
    const systemAccount = account?.uid != null && isSystemUid(account.uid);
    const droppedAccount =
      Boolean(owner) &&
      accounts.size > 0 &&
      !account &&
      str(evidence.collection_status) === 'stale';
    return (
      Boolean(str(evidence.install_path_hash)) &&
      (systemAccount || droppedAccount) &&
      agentConfigItems(a).every((i) => i.state === 'read_failed' || i.state === 'unknown') &&
      !holderChecks(evidence).some((c) => c.status === 'finding') &&
      !arr(evidence.posture).some((p) => p.status === 'finding')
    );
  };
  const delegate = new Map<string, Rec>();
  for (const a of agents)
    if (!phantom(a) && !delegate.has(identity(a))) delegate.set(identity(a), a);
  const kept: Rec[] = [];
  const names = new Map<Rec, Set<string>>();
  for (const a of agents) {
    const target = phantom(a) ? delegate.get(identity(a)) : undefined;
    if (!target) {
      kept.push(a);
      continue;
    }
    const set = names.get(target) ?? new Set<string>();
    const name = accounts.get(str(rec(a.evidence).owner_account_key))?.username;
    if (name) set.add(name);
    names.set(target, set);
  }
  return {
    kept,
    ignored: new Map([...names].map(([asset, set]) => [asset, [...set].sort()])),
  };
}

/** 各入口共用规范化资产，合并副本而保留安装归属和所有检查。 */
export function reportInventory(report: unknown): {
  agents: Rec[];
  /** 折叠掉的系统账号名：键是保留下来的那条安装。 */
  ignored: Map<Rec, string[]>;
  skills: Rec[];
  mcp: Rec[];
} {
  const assets = arr(rec(report).assets),
    { kept: agents, ignored } = installAgents(report);
  function collect(kind: 'skill' | 'mcp_server', field: string): Rec[] {
    const raw: Rec[] = [];
    for (const asset of assets) {
      const e = rec(asset.evidence);
      const installedIn = AGENT_KINDS.has(str(asset.kind))
        ? [fleetAgentIdentity(str(asset.name))]
        : str(e.parent_agent)
          ? [fleetAgentIdentity(str(e.parent_agent))]
          : [];
      for (const s of arr(e[field])) raw.push({ ...s, installedIn });
      if (asset.kind === kind)
        raw.push({
          ...e,
          identityHash: str(
            rec(arr(e[field]).find((s) => s.name === asset.name)?.static_assessment).content_hash,
          ),
          name: kind === 'mcp_server' ? e.server_name || asset.name : asset.name,
          installedIn,
        });
    }
    const groups = new Map<string, Rec>();
    for (const item of raw) {
      const hash =
        str(item.identityHash) || str(rec(item.static_assessment).content_hash) || str(item.sha256);
      const label = str(item.source_label) || str(item.install_path_label);
      const key =
        kind === 'skill'
          ? `${str(item.name)}|${hash || label}`
          : `${str(item.name)}|${str(item.scope)}|${str(item.origin)}|${str(item.transport)}`;
      const previous = groups.get(key);
      if (!previous) {
        groups.set(key, {
          ...item,
          assetKey: createHash('sha256').update(key).digest('hex').slice(0, 16),
          ...(kind === 'skill' ? { source: skillSource(item) } : {}),
          static_assessment: {
            ...rec(item.static_assessment),
            checks: uniqueChecks(holderChecks(item)),
          },
        });
      } else {
        previous.installedIn = [
          ...new Set([...(previous.installedIn as string[]), ...(item.installedIn as string[])]),
        ];
        previous.static_assessment = {
          ...rec(previous.static_assessment),
          checks: uniqueChecks([...holderChecks(previous), ...holderChecks(item)]),
        };
        if (kind === 'skill') {
          const source = skillSource(item);
          if (
            source &&
            (!previous.source ||
              source === 'official_marketplace_cache' ||
              source === 'plugin_cache')
          )
            previous.source = source;
        }
        for (const [k, v] of Object.entries(item))
          if (previous[k] === undefined || previous[k] === null) previous[k] = v;
      }
    }
    return [...groups.values()];
  }
  return {
    agents,
    ignored,
    skills: collect('skill', 'skills'),
    mcp: collect('mcp_server', 'mcp_servers'),
  };
}

/** 只给旧版配置判定器传旧值；新协议的风险与通过完全由检查项决定。 */
export function legacyConfigValue(value: unknown): string {
  const token = str(value);
  return /^(?:default:|cli:)/.test(token) || ['internal_store', 'read_failed'].includes(token)
    ? ''
    : token;
}
export const CONFIG_FIELDS = [
  ['permission', 'permission_mode'],
  ['auto_approval', 'auto_approval'],
  ['sandbox', 'sandbox_mode'],
] as const;
type ConfigItemState = EndpointAgentRow['configItems'][number]['state'];
export const CONFIG_REASONS: Record<Exclude<ConfigItemState, 'explicit'>, string> = {
  default: CONFIG_DEFAULT_NOTE,
  internal_store: '该软件把这项设置保存在内部，探针读不到，需要在软件里确认。',
  read_failed:
    '配置文件读取或解析失败：文件是符号链接（探针出于安全不跟随）、格式有误，或这个账号没有家目录。',
  unknown: '权限、沙箱或自动批准设置没有读到。',
};
/** 字段优先；仅缺失字段使用新证据码，旧版通过与发现结果保留兼容行为。 */
export function agentConfigItems(asset: Rec): EndpointAgentRow['configItems'] {
  const evidence = rec(asset.evidence),
    config = rec(evidence.config),
    checks = holderChecks(evidence);
  return CONFIG_FIELDS.map(([item, field]) => {
    const value = str(config[field]);
    const own = checks.filter((c) => c.rule_id === `config.${item}`);
    let state: ConfigItemState = 'unknown';
    if (value === 'internal_store' || value === 'read_failed') state = value;
    else if (value.startsWith('default:')) state = 'default';
    else if (value && value !== 'unknown') state = 'explicit';
    else {
      if (!value) {
        const codes = own.map((c) => str(c.evidence_code));
        if (codes.includes(`${item}_read_failed`)) state = 'read_failed';
        else if (codes.includes(`${item}_internal_store`)) state = 'internal_store';
        else if (
          codes.some((c) => c === `${item}_default_applied` || c === `${item}_default_risky`)
        )
          state = 'default';
      }
      if (state === 'unknown' && own.some((c) => ['pass', 'finding'].includes(str(c.status))))
        state = 'explicit';
    }
    return { item, state, installs: 1 };
  });
}
/** 读取状态六态；unrecorded 只由前端在历史任务缺少记录时使用，后端不会产生。 */
export type ConfigReadState = Exclude<EndpointAgentRow['configState'], 'unrecorded'>;
export function summarizeAgentConfig(
  installs: Rec[],
): Pick<EndpointAgentRow, 'configItems' | 'configNote'> & { configState: ConfigReadState } {
  return summarizeConfigItems(installs.flatMap(agentConfigItems));
}
/** 直接按分项状态汇总，任务快照回读时没有原始资产，只有分项状态。 */
export function summarizeConfigItems(
  all: EndpointAgentRow['configItems'],
): Pick<EndpointAgentRow, 'configItems' | 'configNote'> & { configState: ConfigReadState } {
  const states = all.map((i) => i.state);
  const hasValue = states.some((s) => s === 'explicit' || s === 'default');
  const complete = states.length > 0 && states.every((s) => s === 'explicit' || s === 'default');
  const configState: ConfigReadState = complete
    ? states.includes('default')
      ? 'default'
      : 'checked'
    : hasValue
      ? 'partial'
      : states.includes('internal_store')
        ? 'internal_store'
        : states.includes('read_failed')
          ? 'read_failed'
          : 'not_checked';
  const configItems: EndpointAgentRow['configItems'] = [];
  for (const entry of all) {
    const previous = configItems.find((i) => i.item === entry.item && i.state === entry.state);
    if (previous) previous.installs++;
    else configItems.push({ ...entry });
  }
  configItems.sort(
    (a, b) =>
      CONFIG_FIELDS.findIndex(([i]) => i === a.item) -
      CONFIG_FIELDS.findIndex(([i]) => i === b.item),
  );
  const reasons = [...new Set(states)]
    .filter((s) => s !== 'explicit')
    .map((s) => CONFIG_REASONS[s as Exclude<ConfigItemState, 'explicit'>]);
  return { configState, configItems, configNote: reasons.join('') || null };
}
