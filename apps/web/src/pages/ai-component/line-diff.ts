export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

/** 超过该单元数时不做 LCS（避免超大输入卡住页面），退化为整段删除 + 整段新增 */
const MAX_LCS_CELLS = 4_000_000;

/** 基于最长公共子序列的行级 diff：同一位置先列删除行再列新增行。 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_LCS_CELLS) {
    return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))];
  }
  // dp[i*w+j] = a[i..] 与 b[j..] 的 LCS 长度（扁平数组；越界读按 0 处理）
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  const at = (i: number, j: number) => dp[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const x = a[i] ?? '';
    const y = b[j] ?? '';
    if (x === y) {
      out.push({ type: 'same', text: x });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ type: 'del', text: x });
      i++;
    } else {
      out.push({ type: 'add', text: y });
      j++;
    }
  }
  for (; i < n; i++) out.push({ type: 'del', text: a[i] ?? '' });
  for (; j < m; j++) out.push({ type: 'add', text: b[j] ?? '' });
  return out;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(src).sort().map((k) => [k, sortKeys(src[k])]));
  }
  return v === undefined ? null : v;
}

/** 键序规范化后的 pretty JSON：仅键序不同的两个对象输出相同。 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2);
}
