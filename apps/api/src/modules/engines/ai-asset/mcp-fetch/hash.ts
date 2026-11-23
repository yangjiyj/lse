/** 哈希、稳定序列化与端点脱敏（纯函数）。 */
import { createHash } from 'node:crypto';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 键排序后的 JSON（数组保持顺序），用于 schema 哈希与比较。 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** 与 AiComponentToolBaseline.descriptionHash 同口径（见 aic-handoff）。 */
export function toolBaselineHash(description: string, inputSchema: unknown): string {
  return sha256Hex(`${description}\n${stableStringify(inputSchema ?? {})}`);
}

const CREDENTIAL_PARAM_RE =
  /(token|key|secret|password|passwd|pwd|auth|credential|session|signature|sig|code|jwt|bearer)/i;

/** 去掉 query 中疑似凭据的参数与 URL 片段/用户信息，用于快照与错误信息。 */
export function sanitizeEndpoint(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return '[非法 URL]';
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (CREDENTIAL_PARAM_RE.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

/** 文本差异摘要：公共前后缀之外的变化片段（截断），供 rug pull 告警展示。 */
export function textDiffSummary(before: string, after: string, maxChars = 160): {
  removed: string;
  added: string;
  prefixLength: number;
} {
  let start = 0;
  const minLen = Math.min(before.length, after.length);
  while (start < minLen && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const clip = (text: string) => (text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);
  return {
    removed: clip(before.slice(start, endBefore)),
    added: clip(after.slice(start, endAfter)),
    prefixLength: start,
  };
}
