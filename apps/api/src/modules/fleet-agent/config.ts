// 终端接入协议的环境变量。每次请求时读取 process.env，便于测试与运维热切换开关。
const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/** 总开关 FLEET_AGENT_ENABLED，默认 false；关闭时 /agent/v1/* 一律 404。 */
export function fleetAgentEnabled(): boolean {
  return process.env.FLEET_AGENT_ENABLED === 'true';
}

export function fleetAgentRateLimits() {
  return {
    /** 每个来源 IP 每分钟请求数（所有 /agent/v1/* 合计，鉴权之前计数）。 */
    ipPerMinute: intEnv('FLEET_AGENT_IP_RATE_PER_MIN', 600),
    /** 每个来源 IP 每分钟登记次数（防接入码爆破）。 */
    registerPerMinute: intEnv('FLEET_AGENT_REGISTER_RATE_PER_MIN', 20),
    /** 每个已鉴权终端每分钟请求数。采集器正常约 4 次/分钟。 */
    endpointPerMinute: intEnv('FLEET_AGENT_ENDPOINT_RATE_PER_MIN', 120),
  };
}

export const BODY_LIMITS = {
  register: 64 * 1024,
  heartbeat: 64 * 1024,
  probeReport: 8 * 1024 * 1024,
  /** 运行态测评 v2 场景多，结果上限 16 MiB（契约 §3）；runner 按场景数缩小单场景证据。 */
  result: 16 * 1024 * 1024,
  transition: 8 * 1024,
  /** GET 端点不应带体；仍给一个很小的上限。 */
  get: 8 * 1024,
} as const;

/** 下发 payload（canonical）上限：采集器 /eval-jobs 响应上限为 1 MiB + 4 KiB，留出投递元数据余量。 */
export const MAX_PAYLOAD_CANONICAL_BYTES = 1024 * 1024;
