import type { FleetLiveProduct } from '../../../../../packages/shared/src/fleet-live-eval.js';
import { conflict } from '../../lib/errors.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  fetchTarget,
  readResponseBodyLimited,
  resolveServerTargetEgressContext,
  type TargetEgressOptions,
} from '../../lib/target-egress-policy.js';
import type { EndpointEvalResult } from './config.js';
import type { EndpointPack } from './pack.js';

export function signRequest(
  secret: string,
  ts: string,
  method: string,
  path: string,
  body: string,
): string {
  return createHmac('sha256', secret)
    .update(`${ts}\n${method}\n${path}\n${createHash('sha256').update(body).digest('hex')}`)
    .digest('hex');
}
export function verifySignature(
  secret: string,
  ts: string,
  signature: string,
  method: string,
  path: string,
  body: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (
    !secret ||
    !/^\d+$/.test(ts) ||
    !/^[a-fA-F0-9]{64}$/.test(signature) ||
    Math.abs(now - Number(ts)) > 300
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(signRequest(secret, ts, method, path, body), 'hex'),
  );
}
export interface EndpointInfo {
  endpoint_id: string;
  /** 机器标识：同一台机器的多条登记相同。平台补上后台账即按它合并；没有时按主机名和操作系统。 */
  machine_id?: string | null;
  hostname: string;
  os: string;
  owner_display: string | null;
  department: string | null;
  last_seen_at: string | null;
  eval_runner_version: string | null;
  agents: Array<{
    product: FleetLiveProduct;
    version: string | null;
    headless_capable: boolean;
  }>;
}
export interface CreateEndpointJob {
  lse_task_id: string;
  endpoint_id: string;
  product: FleetLiveProduct;
  scenario_pack: EndpointPack;
  sink_base_url: string;
  callback_url: string;
  requested_by: string;
  reason: string;
}
export interface EndpointJob {
  job_id: string;
  status: string;
  result?: EndpointEvalResult | null;
  error?: unknown;
}
/** 连接器返回了非 2xx：带上状态码和平台的错误码，调用方据此区分「不存在」和「调用失败」。 */
export class ConnectorHttpError extends Error {
  constructor(
    readonly status: number,
    /** 平台错误体 {"error":{"code":…}} 里的 code；不是这种格式时为 null。 */
    readonly code: string | null,
  ) {
    super(`终端测评连接器返回 ${status}`);
    this.name = 'ConnectorHttpError';
  }
}

function connectorErrorCode(text: string): string | null {
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export class AgentShieldClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  constructor(
    private readonly options: {
      baseUrl?: string;
      secret?: string;
      egress?: TargetEgressOptions;
    } = {},
  ) {
    this.baseUrl = options.baseUrl ?? process.env.LSE_AGENTSHIELD_BASE_URL ?? '';
    this.secret = options.secret ?? process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET ?? '';
  }
  private async request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    if (!this.baseUrl || !this.secret) throw new Error('未配置终端测评连接器地址或共享密钥');
    const base = new URL(this.baseUrl);
    if (base.pathname !== '/' || base.search || base.hash || base.username || base.password)
      throw new Error('连接器地址必须为不含路径和凭据的服务基地址');
    const body = payload === undefined ? '' : JSON.stringify(payload);
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('连接器请求超过 1MB');
    const ts = String(Math.floor(Date.now() / 1000));
    const response = await fetchTarget(
      new URL(path, base).href,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'X-LSE-Timestamp': ts,
          'X-LSE-Signature': signRequest(this.secret, ts, method, path.split('?')[0]!, body),
        },
        ...(body ? { body } : {}),
      },
      { context: resolveServerTargetEgressContext(), ...this.options.egress },
    );
    const text = await readResponseBodyLimited(response, 2 * 1024 * 1024);
    if (response.status === 409 && path.endsWith('/cancel')) throw conflict('任务已结束，无法取消');
    if (!response.ok) throw new ConnectorHttpError(response.status, connectorErrorCode(text));
    return (text ? JSON.parse(text) : {}) as T;
  }
  endpoints(product?: string): Promise<EndpointInfo[]> {
    return this.request(
      'GET',
      `/connectors/lse/endpoints${product ? `?product=${encodeURIComponent(product)}` : ''}`,
    );
  }
  posture(id: string, product: string): Promise<Record<string, unknown>> {
    return this.request(
      'GET',
      `/connectors/lse/endpoints/${encodeURIComponent(id)}/posture?product=${encodeURIComponent(product)}`,
    );
  }
  /**
   * 登记在平台里是否还在（未删除，也没有被吊销、停用或退役）。
   * 平台的 posture 接口对不在的登记返回 404 + not_found，登记还在就返回 200，即使它没有可测智能体。
   * 只有平台明确回答不存在才返回 false；其他失败（含功能开关关闭时的纯文本 404）照常抛出。
   */
  async endpointExists(id: string, product: string): Promise<boolean> {
    try {
      await this.posture(id, product);
      return true;
    } catch (error) {
      if (error instanceof ConnectorHttpError && error.status === 404 && error.code === 'not_found') return false;
      throw error;
    }
  }
  async createJob(payload: CreateEndpointJob): Promise<EndpointJob> {
    const scenarios = payload.scenario_pack.scenarios;
    if (!scenarios.length || scenarios.length > 12) throw new Error('场景数量必须在 1 到 12 之间');
    for (const scenario of scenarios) {
      if (Buffer.byteLength(scenario.prompt) > 8 * 1024) throw new Error('场景提示超过大小上限');
      for (const fixture of scenario.fixtures) {
        if (
          !fixture.path ||
          fixture.path.startsWith('/') ||
          fixture.path.includes('..') ||
          fixture.path.includes('\\') ||
          /^[A-Za-z]:/.test(fixture.path)
        )
          throw new Error('场景测试件路径必须是安全的相对路径');
        if (Buffer.byteLength(fixture.content) > 64 * 1024)
          throw new Error('场景测试件超过大小上限');
      }
    }
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(scenarios)).digest('hex')}`;
    if (payload.scenario_pack.digest !== digest) throw new Error('场景包摘要不匹配');
    return this.request('POST', '/connectors/lse/eval-jobs', payload);
  }
  job(id: string): Promise<EndpointJob> {
    return this.request('GET', `/connectors/lse/eval-jobs/${encodeURIComponent(id)}`);
  }
  cancel(id: string): Promise<EndpointJob> {
    return this.request('POST', `/connectors/lse/eval-jobs/${encodeURIComponent(id)}/cancel`);
  }
}
