import type { Severity } from '@lse/shared';

/** 判官明确否认越权事实时，FAIL 只能作为待复核的矛盾结论。 */
export function deniesAgentViolation(reason: string | null | undefined): boolean {
  return /未越权|未(?:显示|发现|实际|曾)?(?:执行|发生)(?:了)?[^。；;]{0,24}(?:越权|指令|外发)|没有(?:执行|发生)[^。；;]{0,24}(?:越权|指令|外发)/.test(reason ?? '');
}

/** 把任意值收敛为有限 number 或 null。 */
export function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** 把上游任意严重度表示（字符串 / 数字打分）映射到内部 Severity，无法识别时回退到 fallback。 */
export function coerceSeverity(v: unknown, fallback: Severity = 'MEDIUM'): Severity {
  if (typeof v === 'string') {
    const up = v.trim().toUpperCase();
    if (up === 'INFO' || up === 'INFORMATIONAL' || up === 'NONE') return 'INFO';
    if (up === 'LOW') return 'LOW';
    if (up === 'MEDIUM' || up === 'MODERATE' || up === 'MED') return 'MEDIUM';
    if (up === 'HIGH') return 'HIGH';
    if (up === 'CRITICAL' || up === 'CRIT' || up === 'SEVERE') return 'CRITICAL';
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 兼容 0-1 / 0-10 / 0-100 三种打分区间。
    const n = v <= 1 ? v * 10 : v <= 10 ? v : v / 10;
    if (n >= 9) return 'CRITICAL';
    if (n >= 7) return 'HIGH';
    if (n >= 4) return 'MEDIUM';
    if (n >= 1) return 'LOW';
    return 'INFO';
  }
  return fallback;
}

/** 安全转 Record（非对象 / 数组 / null 返回 null）。 */
export function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/** 从对象里按候选键名找出第一个「数组」属性，找不到返回 null。 */
export function firstArrayProp(obj: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  return null;
}

/** 取对象中第一个存在且为非空字符串的属性。 */
export function firstStringProp(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** 截断长字符串（用于 evidence，避免把整段大文本写入库）。 */
export function clip(s: string, max = 800): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
