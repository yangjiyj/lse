/** 引擎适配层共用的 HTTP 小工具：基于全局 fetch + AbortController 超时，绝不抛出。 */

export interface HttpResult {
  ok: boolean;
  status: number;
  json: unknown;
  text: string | null;
  error: string | null;
}

const DEFAULT_HTTP_TIMEOUT_MS = 15000;

/**
 * 发起一次 HTTP 请求并尽力解析 JSON。
 * 任何失败（网络 / 超时 / 非 JSON）都收敛到 HttpResult.error，绝不抛出。
 */
export async function httpRequest(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<HttpResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      text,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `请求超时（>${timeoutMs}ms）`
          : err.message
        : String(err);
    return { ok: false, status: 0, json: null, text: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** 便捷：POST JSON。 */
export function postJson(url: string, body: unknown, timeoutMs?: number): Promise<HttpResult> {
  return httpRequest(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

/** 便捷：GET JSON。 */
export function getJson(url: string, timeoutMs?: number): Promise<HttpResult> {
  return httpRequest(url, { method: 'GET' }, timeoutMs);
}
