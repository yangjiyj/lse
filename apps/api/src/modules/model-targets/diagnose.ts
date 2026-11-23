// 接入诊断：对评估对象实际发起一次请求，逐项判定认证、流式、异步、会话与响应字段，
// 并给出中文建议。出站请求统一走 fetchTarget（目标出站允许清单 + 内网地址校验 + 禁止重定向），
// 与评估执行完全相同，诊断不放宽任何出站策略。报告中的响应预览经过脱敏，不回显凭据。
import { randomBytes } from 'node:crypto';
import { detectResponseTextPaths, readJsonPath } from '@lse/shared';
import {
  aggregateStream,
  detectStreamFormat,
  type StreamFormat,
} from '../../lib/stream-aggregate.js';
import { redactString } from '../../lib/redact.js';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  TargetEgressError,
  fetchTarget,
  readResponseBodyLimited,
  resolveServerTargetEgressContext,
} from '../../lib/target-egress-policy.js';
import { withLseCorrelationSignature } from '../../lib/lse-correlation-signature.js';
import { buildAgentApiRequest } from '../eval-targets/invoker.js';
import { createPlatformAdapter, parsePlatformAppConfig } from '../eval-targets/platform-adapters/index.js';

export type DiagnoseStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DiagnoseCheck {
  key: 'network' | 'auth' | 'stream' | 'async' | 'session' | 'field';
  label: string;
  status: DiagnoseStatus;
  message: string;
  suggestion?: string;
}

export interface DiagnoseReport {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  contentType: string | null;
  streamFormat: StreamFormat | null;
  answerSample: string | null;
  responseCandidates: string[];
  detectedSessionField: string | null;
  detectedAsyncField: string | null;
  responsePreview: string;
  checks: DiagnoseCheck[];
}

export interface DiagnoseTargetShape {
  targetType: string;
  hasApiKey: boolean;
  /** 智能体应用配置的响应字段路径；模型对象为 null（固定 choices[0].message.content）。 */
  responseTextPath: string | null;
  sessionHeaderName: string | null;
  templateUsesSessionId: boolean;
}

export interface ProbeResponse {
  httpStatus: number;
  contentType: string | null;
  text: string;
}

const LABELS: Record<DiagnoseCheck['key'], string> = {
  network: '接口连通',
  auth: '认证',
  stream: 'SSE/NDJSON 流式响应',
  async: '异步轮询',
  session: '固定会话',
  field: '响应字段',
};
const ORDER: DiagnoseCheck['key'][] = ['network', 'auth', 'stream', 'async', 'session', 'field'];
const MODEL_ANSWER_PATH = 'choices[0].message.content';
const AGENT_DEFAULT_PATHS = ['answer', 'content', 'message', 'output', 'data.answer'];
const SESSION_KEYS = [
  'conversation_id',
  'conversationId',
  'session_id',
  'sessionId',
  'thread_id',
  'threadId',
  'chat_id',
  'chatId',
];
const ASYNC_ID_KEYS = ['task_id', 'taskId', 'job_id', 'jobId', 'request_id', 'requestId'];
const PENDING_STATUS_RE =
  /^(pending|queued|queue|running|processing|submitted|in_progress|waiting)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findKey(value: unknown, keys: string[], depth = 0, prefix = ''): string | null {
  if (!isRecord(value) || depth > 2) return null;
  for (const key of keys) {
    const item = value[key];
    if (
      Object.prototype.hasOwnProperty.call(value, key) &&
      (typeof item === 'string' || typeof item === 'number')
    ) {
      return prefix + key;
    }
  }
  for (const [key, item] of Object.entries(value)) {
    const hit = findKey(item, keys, depth + 1, `${prefix}${key}.`);
    if (hit) return hit;
  }
  return null;
}

function pendingStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const container of [value, value.data, value.output]) {
    if (!isRecord(container)) continue;
    for (const key of ['status', 'state', 'task_status', 'taskStatus']) {
      const s = container[key];
      if (typeof s === 'string' && PENDING_STATUS_RE.test(s.trim())) return true;
    }
  }
  return false;
}

function stringAt(json: unknown, path: string): string | null {
  const v = readJsonPath(json, path);
  return typeof v === 'string' && v.trim() ? v : null;
}

function mk(
  key: DiagnoseCheck['key'],
  status: DiagnoseStatus,
  message: string,
  suggestion?: string,
) {
  return { key, label: LABELS[key], status, message, ...(suggestion ? { suggestion } : {}) };
}

function finish(
  partial: Omit<DiagnoseReport, 'ok' | 'checks'>,
  checks: DiagnoseCheck[],
): DiagnoseReport {
  const sorted = ORDER.map((key) => checks.find((c) => c.key === key)).filter(
    (c): c is DiagnoseCheck => Boolean(c),
  );
  return { ...partial, ok: !sorted.some((c) => c.status === 'fail'), checks: sorted };
}

/** 请求未拿到任何 HTTP 响应（出站策略拦截、DNS、超时、连接失败）时的诊断报告。 */
export function networkFailureReport(message: string, egressBlocked: boolean): DiagnoseReport {
  const checks: DiagnoseCheck[] = [
    mk(
      'network',
      'fail',
      `接口不可达：${redactString(message)}`,
      egressBlocked
        ? '该地址被平台目标出站策略拦截，请联系管理员将接口地址加入目标出站允许清单。'
        : '请检查接口地址、端口与网络连通性，确认平台所在网络可以访问该接口。',
    ),
  ];
  for (const key of ORDER.slice(1)) checks.push(mk(key, 'skip', '未获得响应，未执行该项检查。'));
  return finish(
    {
      httpStatus: null,
      latencyMs: null,
      contentType: null,
      streamFormat: null,
      answerSample: null,
      responseCandidates: [],
      detectedSessionField: null,
      detectedAsyncField: null,
      responsePreview: '',
    },
    checks,
  );
}

/** 根据一次真实响应逐项诊断常见接入问题。纯函数，便于单测覆盖。 */
export function analyzeProbeResponse(
  target: DiagnoseTargetShape,
  resp: ProbeResponse,
): DiagnoseReport {
  const isModel = target.targetType === 'MODEL' || target.targetType === 'JUDGE';
  const checks: DiagnoseCheck[] = [];
  let json: unknown = null;
  try {
    json = resp.text ? JSON.parse(resp.text) : null;
  } catch {
    json = null;
  }
  const streamFormat = json === null ? detectStreamFormat(resp.contentType, resp.text) : null;
  const aggregated = streamFormat
    ? aggregateStream(resp.text, streamFormat, isModel ? null : target.responseTextPath)
    : null;
  const bodyJson = aggregated ? aggregated.lastJsonEvent : json;
  const okStatus = resp.httpStatus >= 200 && resp.httpStatus < 300;
  const authFailed = resp.httpStatus === 401 || resp.httpStatus === 403;

  // 1. 连通
  if (okStatus || authFailed) {
    checks.push(mk('network', 'pass', `接口可达，返回 HTTP ${resp.httpStatus}。`));
  } else {
    const upstream = isRecord(json)
      ? (readJsonPath(json, 'error.message') ?? json.message ?? json.msg)
      : null;
    checks.push(
      mk(
        'network',
        'fail',
        `接口返回 HTTP ${resp.httpStatus}${typeof upstream === 'string' ? `：${redactString(upstream.slice(0, 200))}` : ''}。`,
        resp.httpStatus === 404 || resp.httpStatus === 405
          ? isModel
            ? '请确认接口地址为 OpenAI 兼容 Base URL（通常以 /v1 结尾，平台会自动拼接 /chat/completions）。'
            : '请确认接口地址与请求方法正确，平台以 POST 方式发送请求模板。'
          : '请检查接口服务状态与请求模板参数是否符合接口要求。',
      ),
    );
  }

  // 2. 认证
  if (authFailed) {
    checks.push(
      mk(
        'auth',
        'fail',
        `认证失败：接口返回 HTTP ${resp.httpStatus}。`,
        target.hasApiKey
          ? '请核对访问密钥是否正确、未过期，以及认证方式（Bearer Token / API-Key 请求头及其名称）是否与接口要求一致。'
          : '当前未配置访问密钥，请填写接口签发的密钥并选择对应的认证方式。',
      ),
    );
  } else {
    checks.push(mk('auth', 'pass', target.hasApiKey ? '认证通过。' : '接口未要求认证。'));
  }

  // 3. 流式
  if (streamFormat) {
    const label = streamFormat === 'sse' ? 'SSE（text/event-stream）' : 'NDJSON';
    const count = aggregated?.events.length ?? 0;
    checks.push(
      isModel
        ? mk(
            'stream',
            'fail',
            `接口返回 ${label} 流式响应（${count} 个事件）。`,
            'OpenAI 兼容模型按非流式方式调用，请在默认参数中移除 stream=true 或关闭服务端强制流式输出。',
          )
        : mk(
            'stream',
            aggregated?.text ? 'pass' : 'warn',
            aggregated?.text
              ? `识别为 ${label} 流式响应，已聚合 ${count} 个事件为完整回答。`
              : `识别为 ${label} 流式响应（${count} 个事件），但未能从事件中提取回答文本。`,
            aggregated?.text
              ? undefined
              : '请在「响应字段路径」中填写每个事件中承载回答增量的字段，例如 answer 或 choices[0].delta.content。',
          ),
    );
  } else {
    checks.push(mk('stream', 'pass', '非流式响应，按完整 JSON 读取。'));
  }

  // 4. 异步轮询
  const detectedAsyncField = findKey(bodyJson, ASYNC_ID_KEYS);
  const pending = pendingStatus(bodyJson);
  if (okStatus && (resp.httpStatus === 202 || (detectedAsyncField && pending))) {
    checks.push(
      mk(
        'async',
        'warn',
        `接口可能为异步任务模式：${resp.httpStatus === 202 ? '返回 HTTP 202' : ''}${detectedAsyncField ? `${resp.httpStatus === 202 ? '，' : ''}响应包含 ${detectedAsyncField}` : ''}${pending ? ' 且状态为处理中' : ''}，回答需要轮询获取。`,
        '平台按同步方式读取回答，请改用接口的同步/阻塞模式（如 response_mode=blocking），或提供同步返回结果的封装接口。',
      ),
    );
  } else if (!okStatus) {
    checks.push(mk('async', 'skip', '接口未成功响应，未执行该项检查。'));
  } else {
    checks.push(mk('async', 'pass', '接口同步返回结果。'));
  }

  // 5. 固定会话
  const detectedSessionField = findKey(bodyJson, SESSION_KEYS);
  const sessionConfigured = Boolean(target.sessionHeaderName) || target.templateUsesSessionId;
  const sessionHow = target.sessionHeaderName
    ? `会话请求头 ${target.sessionHeaderName}`
    : '请求模板中的 {{session_id}}';
  if (detectedSessionField && !sessionConfigured) {
    checks.push(
      mk(
        'session',
        'warn',
        `响应包含会话字段 ${detectedSessionField}，接口支持多轮会话。`,
        '如需多轮对抗保持同一会话，请在「会话请求头」中填写接口接收会话标识的请求头名称，或在请求模板中使用 {{session_id}}；平台对每个评估样本使用固定会话标识。',
      ),
    );
  } else if (sessionConfigured) {
    checks.push(mk('session', 'pass', `已配置固定会话：通过${sessionHow}携带会话标识。`));
  } else {
    checks.push(mk('session', 'pass', '未检测到会话字段，按单轮请求处理。'));
  }

  // 6. 响应字段
  let answerSample: string | null = null;
  let responseCandidates: string[] = [];
  if (!okStatus) {
    checks.push(mk('field', 'skip', '接口未成功响应，未执行该项检查。'));
  } else if (aggregated) {
    answerSample = aggregated.text;
    if (!aggregated.text) responseCandidates = detectResponseTextPaths(bodyJson);
    checks.push(
      aggregated.text
        ? mk('field', 'pass', `从流式事件字段 ${aggregated.textPath ?? '(文本)'} 读取到回答。`)
        : mk(
            'field',
            'fail',
            '字段缺失：流式事件中未找到回答字段。',
            responseCandidates.length ? `候选路径：${responseCandidates.join('、')}` : undefined,
          ),
    );
  } else {
    const configured = isModel ? MODEL_ANSWER_PATH : target.responseTextPath?.trim() || '';
    answerSample = configured ? stringAt(bodyJson, configured) : null;
    responseCandidates = detectResponseTextPaths(bodyJson);
    if (answerSample !== null) {
      checks.push(mk('field', 'pass', `响应字段 ${configured} 存在，已读取到回答。`));
    } else {
      const fallback = isModel ? undefined : AGENT_DEFAULT_PATHS.find((p) => stringAt(bodyJson, p));
      if (fallback) {
        answerSample = stringAt(bodyJson, fallback);
        checks.push(
          mk(
            'field',
            'warn',
            `配置的响应字段 ${configured || '(未配置)'} 不存在，当前按默认字段 ${fallback} 读取到回答。`,
            `建议把响应字段路径改为 ${fallback}。`,
          ),
        );
      } else {
        checks.push(
          mk(
            'field',
            'fail',
            `字段缺失：响应中不存在 ${configured || '回答'} 字段。`,
            responseCandidates.length
              ? `候选路径：${responseCandidates.join('、')}，请据此修改响应字段路径。`
              : '响应中没有可作为回答的文本字段，请检查请求模板与接口返回格式。',
          ),
        );
      }
    }
  }

  return finish(
    {
      httpStatus: resp.httpStatus,
      latencyMs: null,
      contentType: resp.contentType,
      streamFormat,
      answerSample: answerSample === null ? null : redactString(answerSample.slice(0, 500)),
      responseCandidates,
      detectedSessionField,
      detectedAsyncField,
      responsePreview: redactString(resp.text.slice(0, 1500)),
    },
    checks,
  );
}

export interface DiagnoseInput {
  targetType: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: unknown;
  defaultParams?: unknown;
  accessConfig?: unknown;
}

const DIAGNOSE_PROMPT = '你好，请用一句话回复以确认连接正常。';
const DIAGNOSE_TIMEOUT_MS = 30_000;

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
}

function templateUsesSessionId(template: unknown): boolean {
  try {
    return JSON.stringify(template ?? null).includes('{{session_id}}');
  } catch {
    return false;
  }
}

function buildProbeRequest(input: DiagnoseInput, sessionId: string) {
  if (input.targetType === 'AGENT_API' || input.targetType === 'PUBLIC_AGENT') {
    const built = buildAgentApiRequest(input, DIAGNOSE_PROMPT, undefined, sessionId);
    return { url: input.baseUrl, headers: built.headers, body: built.body };
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${input.apiKey}`,
    ...withLseCorrelationSignature(stringRecord(input.extraHeaders)),
  };
  const body = {
    ...(isRecord(input.defaultParams) ? input.defaultParams : {}),
    model: input.model,
    messages: [{ role: 'user', content: DIAGNOSE_PROMPT }],
    max_tokens: 64,
    temperature: 0,
  };
  return { url: `${input.baseUrl.replace(/\/+$/, '')}/chat/completions`, headers, body };
}

/**
 * 实际发起一次诊断请求。出站走 fetchTarget（允许清单 + DNS 内网校验 + 禁止重定向），
 * 响应体按 1MB 上限读取，异常一律归一为诊断报告而不抛出。
 */
export async function runDiagnosis(input: DiagnoseInput): Promise<DiagnoseReport> {
  if (input.targetType === 'PLATFORM_APP') {
    const startedAt = Date.now();
    try {
      const adapter = createPlatformAdapter(parsePlatformAppConfig(input.accessConfig), input.apiKey);
      const result = await adapter.diagnose();
      return finish({
        httpStatus: null, latencyMs: Date.now() - startedAt, contentType: null,
        streamFormat: null, answerSample: null, responseCandidates: [],
        detectedSessionField: null, detectedAsyncField: null, responsePreview: '',
      }, [
        mk('network', result.ok ? 'pass' : 'fail', redactString(result.detail)),
        mk('auth', result.ok ? 'pass' : 'fail', redactString(result.detail)),
        ...ORDER.slice(2).map((key) => mk(key, 'skip', '连接诊断只校验平台接入；回答与工具轨迹将在评估时采集。')),
      ]);
    } catch (error) {
      return { ...networkFailureReport(error instanceof Error ? error.message : String(error), error instanceof TargetEgressError), latencyMs: Date.now() - startedAt };
    }
  }
  const accessConfig = isRecord(input.accessConfig) ? input.accessConfig : {};
  const sessionId = `lse-diagnose-${randomBytes(6).toString('hex')}`;
  const { url, headers, body } = buildProbeRequest(input, sessionId);
  const startedAt = Date.now();
  try {
    const res = await fetchTarget(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      { context: resolveServerTargetEgressContext(), timeoutMs: DIAGNOSE_TIMEOUT_MS },
    );
    const text = await readResponseBodyLimited(res, DEFAULT_MAX_RESPONSE_BYTES);
    const report = analyzeProbeResponse(
      {
        targetType: input.targetType,
        hasApiKey: Boolean(input.apiKey),
        responseTextPath:
          typeof accessConfig.responseTextPath === 'string' ? accessConfig.responseTextPath : null,
        sessionHeaderName:
          typeof accessConfig.sessionHeaderName === 'string' &&
          accessConfig.sessionHeaderName.trim()
            ? accessConfig.sessionHeaderName.trim()
            : null,
        templateUsesSessionId: templateUsesSessionId(accessConfig.requestTemplate),
      },
      { httpStatus: res.status, contentType: res.headers.get('content-type'), text },
    );
    return { ...report, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof TargetEgressError) {
      const blocked = [
        'TARGET_EGRESS_POLICY_REQUIRED',
        'TARGET_EGRESS_TARGET_NOT_ALLOWED',
        'TARGET_EGRESS_PRIVATE_ADDRESS',
      ].includes(error.code);
      return { ...networkFailureReport(error.message, blocked), latencyMs };
    }
    const err = error as Error;
    const reason =
      err?.name === 'AbortError' || err?.name === 'TimeoutError'
        ? `请求超时（>${DIAGNOSE_TIMEOUT_MS}ms）`
        : `网络/连接错误：${err?.message ?? String(error)}`;
    return { ...networkFailureReport(reason, false), latencyMs };
  }
}
