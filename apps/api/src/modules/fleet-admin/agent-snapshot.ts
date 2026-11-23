import type { EndpointAgentRow } from '../../../../../packages/shared/src/endpoint-overview.js';
import {
  agentConfigItems,
  arr,
  installAgents,
  rec,
  safeText,
  str,
  summarizeConfigItems,
  type ConfigReadState,
  type Rec,
} from './inventory.js';

/** 一份报告里智能体安装数的保存上限，防止异常报告撑大任务日志。 */
const MAX_AGENTS = 200;
const CONFIG_STATES: readonly ConfigReadState[] = [
  'checked',
  'default',
  'partial',
  'internal_store',
  'read_failed',
  'not_checked',
];
const ITEMS = ['permission', 'auto_approval', 'sandbox'] as const;
const ITEM_STATES = ['explicit', 'default', 'internal_store', 'read_failed', 'unknown'] as const;
type Item = (typeof ITEMS)[number];
type ItemState = (typeof ITEM_STATES)[number];

/** 任务创建时保存的判断结果：不含配置取值、路径哈希、账号键。 */
export interface AgentSnapshotEntry {
  name: string;
  configState: ConfigReadState;
  configItems: Array<{ item: Item; state: ItemState }>;
  location: string | null;
  account: string | null;
}
/** 回读后挂在智能体上的展示数据；config 缺失表示这个任务当时没有记录。 */
export interface AgentSnapshotView {
  config?: { state: ConfigReadState; items: EndpointAgentRow['configItems']; note: string | null };
  location: string | null;
  account: string | null;
}

const nameKey = (value: unknown) => str(value).slice(0, 80);

/**
 * 安装位置：探针只上报目录末级名称（不含斜杠），这里转成用户能认的写法。
 * 点开头的目录视为主目录下的目录；package.json 说明装在含它的目录里，真实路径探针不上报。
 */
export function agentInstallLocation(asset: unknown): string | null {
  const evidence = rec(rec(asset).evidence);
  const raw = str(evidence.install_path_label) || str(evidence.installed_binary_path_label);
  const last = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();
  if (!last) return null;
  const shown =
    last.toLowerCase() === 'package.json'
      ? '…/package.json 所在目录'
      : last.startsWith('.')
        ? `~/${last}`
        : last;
  return safeText(shown, 80);
}

/** 安装所属账号：按 owner_account_key 在主机账号表里找用户名，只取用户名。 */
export function agentOwnerAccount(asset: unknown, report: unknown): string | null {
  const key = str(rec(rec(asset).evidence).owner_account_key);
  if (!key) return null;
  const user = arr(rec(rec(report).host).users).find((u) => str(u.account_key) === key);
  return user ? safeText(user.username, 64) : null;
}

/** 任务创建时调用：每个智能体安装保存一条判断结果，顺序与报告一致。 */
export function agentSnapshot(report: unknown): AgentSnapshotEntry[] {
  const body = rec(report);
  return installAgents(body)
    .kept.slice(0, MAX_AGENTS)
    .map((asset) => {
      const items = agentConfigItems(asset);
      return {
        name: nameKey(asset.name),
        configState: summarizeConfigItems(items).configState,
        configItems: items.map(({ item, state }) => ({ item, state })),
        location: agentInstallLocation(asset),
        account: agentOwnerAccount(asset, body),
      };
    });
}

function storedConfig(entry: Rec): AgentSnapshotView['config'] {
  const state = str(entry.configState) as ConfigReadState;
  if (!CONFIG_STATES.includes(state)) return undefined;
  const items = arr(entry.configItems).flatMap((i) =>
    ITEMS.includes(i.item as Item) && ITEM_STATES.includes(i.state as ItemState)
      ? [{ item: i.item as Item, state: i.state as ItemState, installs: 1 }]
      : [],
  );
  const summary = summarizeConfigItems(items);
  return { state, items: summary.configItems, note: summary.configNote };
}

/**
 * 读任务时把已存快照对回各个安装，每条快照只用一次：先按“名称 + 账号 + 位置”对，
 * 再按名称依次对（同名安装按上报顺序）。旧任务的快照里可能还留着已折叠的系统账号安装，
 * 只按名称顺序会把它们的状态错配给保留下来的安装。
 * 旧任务没有快照：不给配置状态；位置与账号由当时绑定的报告现算，它们只描述安装身份。
 */
export function attachAgentSnapshot<T extends Rec>(
  agents: T[],
  stored: unknown,
  report?: unknown,
): Array<T & { snapshot: AgentSnapshotView }> {
  const pool = (Array.isArray(stored) ? stored : []).map(rec);
  const used = new Set<number>();
  return agents.map((agent) => {
    const account = agentOwnerAccount(agent, report);
    const location = agentInstallLocation(agent);
    const free = (e: Rec, i: number) => !used.has(i) && nameKey(e.name) === nameKey(agent.name);
    let index = pool.findIndex(
      (e, i) =>
        free(e, i) &&
        (str(e.account) || null) === account &&
        (str(e.location) || null) === location,
    );
    if (index < 0) index = pool.findIndex(free);
    const entry = index >= 0 ? pool[index] : undefined;
    if (index >= 0) used.add(index);
    const config = entry ? storedConfig(entry) : undefined;
    return {
      ...agent,
      snapshot: {
        ...(config ? { config } : {}),
        location: (entry && safeText(entry.location, 80)) || location,
        account: (entry && safeText(entry.account, 64)) || account,
      },
    };
  });
}
