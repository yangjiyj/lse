/**
 * 红队模型调用错误分类。
 *
 * 把一次模型调用归一化结果（LlmCallResult 形态）折算成统一的错误分类，供
 * 自适应并发控制器与统一调用包装决定「是否原轮重试 / 是否降并发 / 是否暂停」。
 *
 * 分类口径与 spec「错误分类」一致：
 *   retryable（瞬时，降并发+原轮重试可恢复）：
 *     - fetch failed / AbortError / 超时（status=ERROR，httpStatus=null，error 含网络/超时特征）
 *     - HTTP 429 / 502 / 503 / 504
 *     - HTTP 200 但 content 为空/null/纯空白（疑似上游瞬时返回空体）
 *   non-retryable（确定性配置/协议错误，不得靠降并发掩盖）：
 *     - HTTP 400 / 401 / 403 / 404
 *     - 响应缺少 choices 等协议配置错误
 *
 * 纯函数，不抛出，不访问网络/时钟。
 */

export interface ChatErrorInput {
  status?: unknown;
  content?: unknown;
  finishReason?: unknown;
  httpStatus?: unknown;
  error?: unknown;
}

export interface ChatErrorClassification {
  retryable: boolean;
  reasonCode: string;
  httpStatus: number | null;
}

const RETRYABLE_5XX = new Set([502, 503, 504]);
const NON_RETRYABLE_4XX = new Set([400, 401, 403, 404]);

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 判定一次调用结果是否「HTTP 200 但回答正文为空/纯空白」。
 * 注意：finish_reason=length 且有正文不算空（属资源消耗证据）。
 */
function isEmptyContent(input: ChatErrorInput): boolean {
  if (asNumber(input.httpStatus) !== 200 && input.status !== 'SUCCESS') return false;
  // 仅当成功态（status=SUCCESS 或 httpStatus=200）下的空正文才视为瞬时空响应。
  const successLike = input.status === 'SUCCESS' || asNumber(input.httpStatus) === 200;
  if (!successLike) return false;
  return asString(input.content).trim() === '';
}

export function classifyChatError(input: ChatErrorInput): ChatErrorClassification {
  const httpStatus = asNumber(input.httpStatus);
  const status = input.status;
  const errMsg = asString(input.error).toLowerCase();

  // 1) 成功且有非空正文：无错误。length 截断只要有正文也算成功（资源消耗证据）。
  if (status === 'SUCCESS' && !isEmptyContent(input)) {
    return { retryable: false, reasonCode: 'OK', httpStatus };
  }

  // 2) HTTP 5xx（502/503/504）：上游/网关瞬时，retryable。
  if (httpStatus !== null && RETRYABLE_5XX.has(httpStatus)) {
    return { retryable: true, reasonCode: 'HTTP_5XX', httpStatus };
  }

  // 3) HTTP 429：限流，retryable。
  if (httpStatus === 429) {
    return { retryable: true, reasonCode: 'HTTP_429', httpStatus };
  }

  // Context exhaustion is scoped to one accumulated conversation. It must not
  // trip the task-wide circuit used for invalid credentials or endpoints.
  if (
    httpStatus === 400 &&
    (errMsg.includes('exceeds the available context size') ||
      errMsg.includes('maximum context length') ||
      errMsg.includes('context length exceeded') ||
      (errMsg.includes('context window') && errMsg.includes('exceed')))
  ) {
    return { retryable: false, reasonCode: 'CONTEXT_WINDOW_EXCEEDED', httpStatus };
  }
  // 4) HTTP 4xx（400/401/403/404）：配置错误，non-retryable，不得降并发轰击。
  if (httpStatus !== null && NON_RETRYABLE_4XX.has(httpStatus)) {
    return { retryable: false, reasonCode: 'HTTP_4XX', httpStatus };
  }

  // 5) 缺 choices 等协议配置错误（error 文案特征）：non-retryable。
  if (errMsg.includes('缺少 choices') || errMsg.includes('missing choices')) {
    return { retryable: false, reasonCode: 'MISSING_CHOICES', httpStatus };
  }

  // 推理模型可能在正式正文前耗尽输出预算：不是并发拥塞，应提升 max_tokens 后重试。
  if (isEmptyContent(input) && asString(input.finishReason).toLowerCase() === 'length') {
    return { retryable: true, reasonCode: 'TOKEN_BUDGET_EXHAUSTED', httpStatus };
  }

  // 6) HTTP 200 / SUCCESS 但正文为空：疑似上游瞬时返回空体，retryable。
  if (isEmptyContent(input)) {
    return { retryable: true, reasonCode: 'EMPTY_CONTENT', httpStatus };
  }

  // 7) 网络/超时（status=ERROR，httpStatus=null）：error 文案区分超时 vs 网络。
  if (status === 'ERROR' && httpStatus === null) {
    if (errMsg.includes('超时') || errMsg.includes('timeout') || errMsg.includes('abort')) {
      return { retryable: true, reasonCode: 'TIMEOUT', httpStatus };
    }
    // fetch failed / 网络连接错误 / EgressGuard 出站拦截也归网络瞬时类。
    return { retryable: true, reasonCode: 'NETWORK', httpStatus };
  }

  // 8) 兜底：无法识别的 ERROR，保守按 non-retryable 处理，避免无限重试未知错误。
  return { retryable: false, reasonCode: 'UNKNOWN', httpStatus };
}
