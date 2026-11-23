import { redactString } from '../../../lib/redact.js';
import { fetchTarget, readResponseBodyLimited, resolveServerTargetEgressContext } from '../../../lib/target-egress-policy.js';
import type { FetchLike, PlatformTurnResult } from './types.js';

// 原文仅随结果对象保存在内存中供判定使用，不能序列化进 trace 或报告。
const originalTurns = new WeakMap<PlatformTurnResult, PlatformTurnResult>();
const credentialPattern = /(?<![a-zA-Z0-9_-])(?:app-(?=[a-zA-Z0-9_-]{0,}\d)[a-zA-Z0-9_-]{20,}|pat_[a-zA-Z0-9_-]{12,}|jjd_[a-fA-F0-9]{48}|sk-[a-zA-Z0-9_-]{12,})(?![a-zA-Z0-9_-])|\bBearer\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
export function containsCredential(value: string): boolean {
  return new RegExp(credentialPattern.source).test(value);
}
export function originalTurn(result: PlatformTurnResult): PlatformTurnResult {
  return originalTurns.get(result) ?? result;
}
export function safeTurn(result: PlatformTurnResult, apiKey = ''): PlatformTurnResult {
  const original = originalTurn(result);
  const safe = safeValue(result, apiKey);
  originalTurns.set(safe, original);
  return safe;
}

export function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
export function excerpt(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return new TextDecoder().decode(Buffer.from(text).subarray(0, 16384)).replace(/\uFFFD$/, '');
}
export function safeValue<T>(value: T, apiKey = ''): T {
  // 合成 canary 必须保留用于事后判定；应用凭据则在进入轨迹前移除。
  const canaries: string[] = [];
  const encoded = JSON.stringify(value);
  const withoutKey = apiKey ? encoded.split(apiKey).join('[已脱敏]') : encoded;
  const protectedText = withoutKey.replace(/(?:LSE-)?CANARY[-_a-zA-Z0-9]+|canary-[a-zA-Z0-9_-]+/g, match => {
    canaries.push(match);
    return `LSEDECOYMARKER${canaries.length - 1}END`;
  });
  function clean(item: unknown): unknown {
    if (typeof item === 'string') return redactString(item)
      .replace(credentialPattern, '[已脱敏]')
      .replace(/LSEDECOYMARKER(\d+)END/g, (_, index) => canaries[Number(index)]!);
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) =>
      [key, /^(api_?key|authorization|secret|password|access_?token)$/i.test(key)
        ? typeof child === 'string' && /LSEDECOYMARKER\d+END/.test(child)
          ? clean(child.match(/LSEDECOYMARKER\d+END/g)) : null
        : clean(child)]));
    return item;
  }
  const result = clean(JSON.parse(protectedText));
  return result as T;
}
export function events(stream: string): { event: string; data: Record<string, any> }[] {
  return stream.replaceAll('\r\n', '\n').split(/\n\s*\n/).flatMap(block => {
    const lines = block.split('\n');
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return [];
    const parsed = record(JSON.parse(data));
    return [{ event: lines.find(l => l.startsWith('event:'))?.slice(6).trim() || String(parsed.event ?? ''), data: parsed }];
  });
}
export function emptyResult(): PlatformTurnResult {
  return { text: '', toolCalls: [], conversationId: null, latencyMs: 0 };
}
export function streamError(result: PlatformTurnResult, error: unknown): PlatformTurnResult {
  result.error = { code: 'PLATFORM_STREAM_INVALID', message: redactString(error instanceof Error ? error.message : '平台流无效') };
  return safeTurn(result);
}
export const defaultFetch: FetchLike = (url, init) => fetchTarget(url, init, {
  context: resolveServerTargetEgressContext(), timeoutMs: 60_000,
});
async function readTurnBody(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    await response.body?.cancel();
    throw new Error('平台响应已取消');
  }
  if (!response.body) return readResponseBodyLimited(response);
  const reader = response.body.getReader();
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort(new Error('平台响应已取消'));
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error('平台响应超过大小上限');
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
export async function requestTurn(url: string, body: unknown, apiKey: string, parse: (s: string) => PlatformTurnResult,
  fetch: FetchLike, signal?: AbortSignal): Promise<PlatformTurnResult> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(60_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: combinedSignal });
    const text = await readTurnBody(res, combinedSignal);
    if (!res.ok) return safeValue({ ...emptyResult(), latencyMs: Date.now() - started, error: { code: `HTTP_${res.status}`, message: `平台接口返回 HTTP ${res.status}` } }, apiKey);
    const parsed = parse(text);
    return safeTurn({ ...originalTurn(parsed), latencyMs: Date.now() - started }, apiKey);
  } catch {
    return { ...emptyResult(), latencyMs: Date.now() - started, error: { code: signal?.aborted || timeout.aborted ? 'PLATFORM_TIMEOUT' : 'PLATFORM_REQUEST_FAILED', message: '平台调用失败或超时，请检查连接配置' } };
  }
}
export async function diagnoseUrls(urls: string[], apiKey: string, fetch: FetchLike) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `平台认证失败（HTTP ${res.status}），请检查应用密钥和权限` };
      if (res.ok) return { ok: true, detail: '平台连接正常，应用密钥认证通过' };
    } catch { /* 首个诊断接口不可用时继续回退。 */ }
  }
  return { ok: false, detail: '平台连接失败，请检查基地址、应用标识和应用密钥' };
}
