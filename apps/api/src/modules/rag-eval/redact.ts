import { buildSecurityFixtures } from './security.js';

/**
 * 只读视图脱敏：无 rag_eval:manage 的调用者不得拿到投毒金丝雀、注入标记、越权哨兵原文。
 * 这些字符串是安全判定的依据，泄露后可被用来“预知”判定条件或污染被测知识库。
 */
export const RAG_MARKER_MASK = '[测试标记已隐藏]';

/** metadata 中的敏感键：canaries（security.ts / routes.ts securityMetadata 写入）及同类命名。 */
const SENSITIVE_META_KEY = /canar|marker|sentinel|poison|probe|token|secret/i;

export function stripSensitiveMetadata(meta: unknown): unknown {
  if (Array.isArray(meta)) return meta.map(stripSensitiveMetadata);
  if (!meta || typeof meta !== 'object') return meta;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (SENSITIVE_META_KEY.test(k)) continue;
    out[k] = stripSensitiveMetadata(v);
  }
  return out;
}

function collectStrings(v: unknown, out: Set<string>) {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectStrings(x, out));
}

/** 某测试集的全部测试标记：按种子重建的金丝雀/外链/哨兵 + 库内存量字段 + 题目 metadata 中的敏感值。 */
export function testSetMarkers(
  set: { seed: string; poisonCanary: string; sentinelToken: string },
  itemMetadata: unknown[] = [],
): string[] {
  const fx = buildSecurityFixtures(set.seed);
  const out = new Set<string>([fx.poisonCanary, fx.injectionCanary, fx.canaryUrl, fx.sentinelToken, set.poisonCanary, set.sentinelToken]);
  for (const meta of itemMetadata) {
    if (!meta || typeof meta !== 'object') continue;
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) if (SENSITIVE_META_KEY.test(k)) collectStrings(v, out);
  }
  return [...out].filter((s) => s.length >= 6);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 深度替换所有字符串中的测试标记（忽略大小写）；非字符串原样保留，Date 等对象不展开。 */
export function redactMarkers<T>(value: T, markers: readonly string[]): T {
  if (markers.length === 0) return value;
  const re = new RegExp([...markers].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'gi');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(re, RAG_MARKER_MASK);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
