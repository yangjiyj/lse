/**
 * 智能体安全平台连接器的终端清单 → 资产台账里的智能体行。
 *
 * 平台是「每个智能体一条登记」：同一台机器会有多条 endpoint_id 不同的登记。
 * 台账按机器合并：机器内同一产品只留一行，行仍带它自己那条登记的 endpointId。
 */
export interface PlatformAgentEntry {
  /** 分组键（机器）：`agentshield\0` + 机器标识。 */
  groupKey: string;
  endpointId: string;
  endpointName: string;
  user: string | null;
  os: string;
  product: string;
  version: string | null;
  /** 这一行所属登记的最近心跳；没发过心跳为 null。 */
  lastSeenAt: Date | null;
  /** 这一行所属登记上报的测评执行器版本；没上报为 null。 */
  evalRunnerVersion: string | null;
}

export interface PlatformInventory {
  entries: PlatformAgentEntry[];
  /** 每台机器（groupKey）所有登记里最新的一次心跳，含没报智能体的登记；都没发过心跳为 null。 */
  machineLastSeenAt: Map<string, Date | null>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * 机器标识：连接器带 machine_id 用它；否则退回「主机名 + 操作系统 + 使用人」；主机名也没有时只能各算各的。
 * 退回键带上使用人（owner_display，为空按空串），是为了少把主机名和系统恰好相同的两台机器并成一台。
 */
function machineKey(endpoint: Record<string, unknown>, endpointId: string): string {
  const machineId = text(endpoint.machine_id);
  if (machineId) return `machine:${machineId.slice(0, 200)}`;
  const hostname = text(endpoint.hostname).toLowerCase();
  if (hostname) {
    const os = text(endpoint.os).toLowerCase().slice(0, 100);
    return `host:${hostname.slice(0, 200)}|${os}|${text(endpoint.owner_display).slice(0, 200)}`;
  }
  return `endpoint:${endpointId}`;
}

const hasVersion = (version: string | null) => Boolean(version && version.trim() && version !== 'version_unknown');

/** 同一产品的两条登记取哪条：优先有版本号的，其次心跳更新的；都一样时保留先出现的。 */
function better(candidate: PlatformAgentEntry, current: PlatformAgentEntry): boolean {
  if (hasVersion(candidate.version) !== hasVersion(current.version)) return hasVersion(candidate.version);
  return (candidate.lastSeenAt?.getTime() ?? -Infinity) > (current.lastSeenAt?.getTime() ?? -Infinity);
}

export function mergePlatformEndpoints(remote: readonly unknown[]): PlatformInventory {
  const machines = new Map<string, Map<string, PlatformAgentEntry>>();
  const machineLastSeenAt = new Map<string, Date | null>();
  for (const raw of remote) {
    if (!raw || typeof raw !== 'object') continue;
    const endpoint = raw as Record<string, unknown>;
    if (typeof endpoint.endpoint_id !== 'string' || !Array.isArray(endpoint.agents)) continue;
    const endpointId = endpoint.endpoint_id.slice(0, 200);
    const key = machineKey(endpoint, endpointId);
    const seen = typeof endpoint.last_seen_at === 'string' ? new Date(endpoint.last_seen_at) : null;
    const lastSeenAt = seen && Number.isFinite(seen.getTime()) ? seen : null;
    const products = machines.get(key) ?? new Map<string, PlatformAgentEntry>();
    machines.set(key, products);
    const groupKey = `agentshield\0${key}`;
    const latest = machineLastSeenAt.get(groupKey) ?? null;
    machineLastSeenAt.set(groupKey, lastSeenAt && (!latest || lastSeenAt > latest) ? lastSeenAt : latest);
    for (const agent of endpoint.agents as unknown[]) {
      const product = agent && typeof agent === 'object' ? (agent as Record<string, unknown>).product : null;
      if (typeof product !== 'string') continue;
      const version = (agent as Record<string, unknown>).version;
      const entry: PlatformAgentEntry = {
        groupKey,
        endpointId,
        endpointName: typeof endpoint.hostname === 'string' && endpoint.hostname ? endpoint.hostname.slice(0, 200) : '终端名称未上报',
        user: typeof endpoint.owner_display === 'string' ? endpoint.owner_display.slice(0, 200) : null,
        os: typeof endpoint.os === 'string' ? endpoint.os.slice(0, 100) : '',
        product: product.slice(0, 200),
        version: typeof version === 'string' ? version.slice(0, 200) : null,
        lastSeenAt,
        evalRunnerVersion: text(endpoint.eval_runner_version).slice(0, 100) || null,
      };
      const current = products.get(entry.product);
      if (!current || better(entry, current)) products.set(entry.product, entry);
    }
  }
  return { entries: [...machines.values()].flatMap((products) => [...products.values()]), machineLastSeenAt };
}
