// AI 资产测绘：单个端点（协议 + host:port + 路径前缀）的只读指纹探测。
// 约束：只发 GET（唯一例外是 Ollama 的只读查询 POST /api/show）、不带任何凭据、不跟随重定向、
// 响应体读取上限、单请求超时；
// 主机名先解析并钉住 IP，拒绝解析到保留/链路本地/组播地址。
// https 不校验证书：内网推理服务多为自签证书，探测不携带凭据，只读取指纹。
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isBlockedIpv4, isIpv4, type ScanEndpoint } from './ranges.js';

export type DiscoveredServiceType =
  | 'OLLAMA'
  | 'VLLM'
  | 'XINFERENCE'
  | 'LM_STUDIO'
  | 'OPENAI_COMPATIBLE'
  | 'TGI'
  | 'TRITON';

/** 模型配置：接口没返回的字段不出现，不做推断。 */
export interface ModelDetail {
  name: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  /** 计算精度（如 TGI 的 model_dtype：torch.float16），不是量化方式。 */
  dtype?: string;
  contextLength?: number;
}

export interface ProbeHit {
  host: string;
  port: number;
  baseUrl: string;
  serviceType: DiscoveredServiceType;
  models: string[];
  modelDetails: ModelDetail[];
  evidence: string;
}

export type ProbeTarget = Pick<ScanEndpoint, 'host' | 'port'> &
  Partial<Pick<ScanEndpoint, 'scheme' | 'basePath'>>;

export interface ProbeOptions {
  timeoutMs?: number;
  /** 模型详情请求（如 Ollama /api/show）的单请求超时。 */
  detailTimeoutMs?: number;
  /** 单个端点所有模型详情请求的总时长上限，超出即停，已拿到的保留。 */
  detailBudgetMs?: number;
  maxBodyBytes?: number;
  lookup?: (host: string) => Promise<string>;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 2500;
export const DEFAULT_DETAIL_TIMEOUT_MS = 5000;
export const DEFAULT_DETAIL_BUDGET_MS = 15000;
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const MAX_MODELS = 50;
/** 逐个查询详情的模型数上限（每个模型一次请求、串行）。 */
const MAX_DETAIL_MODELS = 20;
/** 剩余时长不足这么多就不再发详情请求（基本等不到响应）。 */
const MIN_DETAIL_SLICE_MS = 50;

interface GetResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

async function resolveHost(host: string, opts: ProbeOptions): Promise<string | null> {
  if (isIpv4(host)) return isBlockedIpv4(host) ? null : host;
  try {
    const ip = opts.lookup
      ? await opts.lookup(host)
      : (await dnsLookup(host, { family: 4 })).address;
    return isIpv4(ip) && !isBlockedIpv4(ip) ? ip : null;
  } catch {
    return null;
  }
}

interface Conn {
  ip: string;
  host: string;
  port: number;
  tls: boolean;
}

interface RequestSpec {
  method?: 'GET' | 'POST';
  /** POST 时的 JSON 请求体。 */
  json?: unknown;
  timeoutMs?: number;
}

function getJson(
  conn: Conn,
  path: string,
  opts: ProbeOptions,
  spec: RequestSpec = {},
): Promise<GetResult | null> {
  const timeoutMs = spec.timeoutMs ?? opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const { ip, host: hostHeader, port } = conn;
  const payload = spec.json === undefined ? null : Buffer.from(JSON.stringify(spec.json));
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: GetResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const request = conn.tls ? https.request : http.request;
    const req = request(
      {
        host: ip,
        port,
        path,
        method: spec.method ?? 'GET',
        headers: {
          host: `${hostHeader}:${port}`,
          accept: 'application/json',
          'user-agent': 'LSE-Asset-Discovery',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
        },
        agent: false,
        ...(conn.tls
          ? { servername: isIpv4(hostHeader) ? undefined : hostHeader, rejectUnauthorized: false }
          : {}),
      },
      (res: http.IncomingMessage) => {
        const status = res.statusCode ?? 0;
        // 不跟随任何重定向（含同主机），3xx 与非 2xx 均视为未识别。
        if (status < 200 || status >= 300) {
          res.resume();
          req.destroy();
          return done(null);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            return done(null);
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            done({
              status,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch {
            done(null);
          }
        });
        res.on('error', () => done(null));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(null);
    }, timeoutMs);
    req.on('error', () => done(null));
    req.end(payload ?? undefined);
  });
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 200) : '';
}

function posInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

/** 去掉空字段，保持字段顺序稳定。 */
function detail(fields: ModelDetail): ModelDetail {
  const out: ModelDetail = { name: fields.name };
  if (fields.family) out.family = fields.family;
  if (fields.parameterSize) out.parameterSize = fields.parameterSize;
  if (fields.quantization) out.quantization = fields.quantization;
  if (fields.dtype) out.dtype = fields.dtype;
  if (fields.contextLength !== undefined) out.contextLength = fields.contextLength;
  return out;
}

/** Ollama /api/show 的 model_info：优先 <架构>.context_length，否则取第一个 *.context_length。 */
export function ollamaContextLength(showBody: unknown): number | undefined {
  const info = rec(rec(showBody)?.model_info);
  if (!info) return undefined;
  const arch = str(info['general.architecture']);
  const own = arch ? posInt(info[`${arch}.context_length`]) : undefined;
  if (own !== undefined) return own;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && posInt(value) !== undefined) return posInt(value);
  }
  return undefined;
}

/**
 * /v1/models 单条：名称一律用 id（与模型列、登记用的模型标识一致）；vLLM 的 max_model_len；
 * Xinference 的 model_name（内置模型名，记为系列；没有时用 model_family）、context_length 等。
 */
export function openAiModelDetail(item: Record<string, unknown>): ModelDetail | null {
  const name = str(item.id);
  if (!name) return null;
  const billions = item.model_size_in_billions;
  return detail({
    name,
    family: str(item.model_name) || str(item.model_family),
    parameterSize:
      typeof billions === 'number' && billions > 0
        ? `${billions}B`
        : typeof billions === 'string' && /^\d+(?:[._]\d+)?$/.test(billions)
          ? `${billions.replace('_', '.')}B`
          : undefined,
    quantization: str(item.quantization),
    contextLength: posInt(item.max_model_len) ?? posInt(item.context_length),
  });
}

/**
 * TGI /info：model_id、max_input_tokens（旧版 max_input_length）、model_dtype。
 * model_dtype 是计算精度，记为 dtype；/info 不给量化方式，量化留空。
 */
export function tgiModelDetail(info: Record<string, unknown>): ModelDetail {
  return detail({
    name: str(info.model_id),
    dtype: str(info.model_dtype),
    contextLength: posInt(info.max_input_tokens) ?? posInt(info.max_input_length),
  });
}

/** 按 /v1/models 条目的 owned_by 等特征区分实现；不确定一律归为 OpenAI 兼容。 */
export function classifyOpenAiModels(
  items: Array<Record<string, unknown>>,
  headers: http.IncomingHttpHeaders,
): DiscoveredServiceType {
  const owners = new Set(items.map((i) => str(i.owned_by).toLowerCase()));
  if (owners.has('vllm')) return 'VLLM';
  if (owners.has('xinference')) return 'XINFERENCE';
  if (owners.has('organization_owner')) return 'LM_STUDIO';
  const server = String(headers.server ?? '').toLowerCase();
  if (server.includes('xinference')) return 'XINFERENCE';
  return 'OPENAI_COMPATIBLE';
}

/** 端点根地址；省略默认端口。 */
export function endpointOrigin(target: ProbeTarget): string {
  const scheme = target.scheme ?? 'http';
  const defaultPort = scheme === 'https' ? 443 : 80;
  return `${scheme}://${target.host}${target.port === defaultPort ? '' : `:${target.port}`}`;
}

/** OpenAI 兼容模型列表的候选路径：前缀已以 /vN 结尾时直接拼 /models。 */
function modelListPaths(prefix: string): Array<{ path: string; base: string }> {
  if (!prefix) return [{ path: '/v1/models', base: '/v1' }];
  if (/\/v\d+$/.test(prefix)) return [{ path: `${prefix}/models`, base: prefix }];
  return [
    { path: `${prefix}/v1/models`, base: `${prefix}/v1` },
    { path: `${prefix}/models`, base: prefix },
  ];
}

export async function probeEndpoint(
  host: string,
  port: number,
  opts: ProbeOptions = {},
): Promise<ProbeHit | null> {
  return probeTarget({ host, port }, opts);
}

export async function probeTarget(
  target: ProbeTarget,
  opts: ProbeOptions = {},
): Promise<ProbeHit | null> {
  const { host, port } = target;
  const prefix = target.basePath ?? '';
  const ip = await resolveHost(host, opts);
  if (!ip) return null;
  const origin = endpointOrigin(target);
  const conn: Conn = { ip, host, port, tls: target.scheme === 'https' };
  const get = (path: string) => getJson(conn, path, opts);

  const tags = await get(`${prefix}/api/tags`);
  const tagModels = rec(tags?.body)?.models;
  if (Array.isArray(tagModels)) {
    const entries = tagModels
      .map((m) => ({
        name: str(rec(m)?.name) || str(rec(m)?.model),
        details: rec(rec(m)?.details),
      }))
      .filter((m) => m.name)
      .slice(0, MAX_MODELS);
    const modelDetails: ModelDetail[] = [];
    const perRequest = opts.detailTimeoutMs ?? DEFAULT_DETAIL_TIMEOUT_MS;
    const deadline = Date.now() + (opts.detailBudgetMs ?? DEFAULT_DETAIL_BUDGET_MS);
    for (const [i, m] of entries.entries()) {
      // 每个模型单独请求、单独超时，整个端点另有总时长上限；查不到就只留 /api/tags 给出的字段。
      const remaining = deadline - Date.now();
      const show =
        i < MAX_DETAIL_MODELS && remaining >= MIN_DETAIL_SLICE_MS
          ? await getJson(conn, `${prefix}/api/show`, opts, {
              method: 'POST',
              // 新版 Ollama 认 model，旧版认 name
              json: { model: m.name, name: m.name },
              timeoutMs: Math.min(perRequest, remaining),
            })
          : null;
      modelDetails.push(
        detail({
          name: m.name,
          family: str(m.details?.family),
          parameterSize: str(m.details?.parameter_size),
          quantization: str(m.details?.quantization_level),
          contextLength: ollamaContextLength(show?.body),
        }),
      );
    }
    return {
      host,
      port,
      baseUrl: `${origin}${prefix}/v1`,
      serviceType: 'OLLAMA',
      models: entries.map((m) => m.name),
      modelDetails,
      evidence: `GET ${prefix}/api/tags`,
    };
  }

  for (const candidate of modelListPaths(prefix)) {
    const list = await get(candidate.path);
    const data = rec(list?.body)?.data;
    if (list && Array.isArray(data)) {
      const items = data
        .map(rec)
        .filter((i): i is Record<string, unknown> => !!i && !!str(i.id))
        .slice(0, MAX_MODELS);
      return {
        host,
        port,
        baseUrl: `${origin}${candidate.base}`,
        serviceType: classifyOpenAiModels(items, list.headers),
        models: items.map((i) => str(i.id)),
        modelDetails: items.map(openAiModelDetail).filter((d): d is ModelDetail => !!d),
        evidence: `GET ${candidate.path}`,
      };
    }
  }

  const info = rec((await get(`${prefix}/info`))?.body);
  if (
    info &&
    str(info.model_id) &&
    ('max_total_tokens' in info || 'max_input_tokens' in info || 'router' in info)
  ) {
    return {
      host,
      port,
      baseUrl: `${origin}${prefix}/v1`,
      serviceType: 'TGI',
      models: [str(info.model_id)],
      modelDetails: [tgiModelDetail(info)],
      evidence: `GET ${prefix}/info`,
    };
  }

  const v2 = rec((await get(`${prefix}/v2`))?.body);
  if (v2 && str(v2.name).toLowerCase() === 'triton' && Array.isArray(v2.extensions)) {
    // 模型仓库索引是 POST /v2/repository/index，按只读原则不调用；改用 GET /v2/models/stats 取已加载模型名。
    const stats = rec((await get(`${prefix}/v2/models/stats`))?.body)?.model_stats;
    const models = Array.isArray(stats)
      ? [...new Set(stats.map((s) => str(rec(s)?.name)).filter(Boolean))].slice(0, MAX_MODELS)
      : [];
    return {
      host,
      port,
      baseUrl: `${origin}${prefix}`,
      serviceType: 'TRITON',
      models,
      modelDetails: models.map((name) => ({ name })),
      evidence: `GET ${prefix}/v2`,
    };
  }
  return null;
}
