/**
 * 版本号解析与比较（PEP 440 为主，兼容常见 semver 写法），纯函数、无 eval。
 *
 * 支持：1.2.3、v1.2、0.0.131、2024.1、20240410、1.0.0rc1、2.0.0a0、1.3.0-rc11、
 * 1.0.0-beta.2、1.0.dev3、1.0.post2、2026.2.21-1（纯数字连字符后缀按 post-release 处理，
 * 与 PEP 440 “1.0-1” 语义一致）、1.2.3+local（本地/构建标识忽略）。
 * 无法识别的写法（main、cec2080、21.1.x、@scope/pkg@1.0）返回 null，由调用方判为“无法判定”。
 */

export interface ParsedVersion {
  release: number[];
  /** 预发布：[阶段, 序号]，阶段 0=alpha 1=beta 2=rc */
  pre: [number, number] | null;
  post: number | null;
  dev: number | null;
}

const PRE_RANK: Record<string, number> = {
  a: 0,
  alpha: 0,
  b: 1,
  beta: 1,
  c: 2,
  rc: 2,
  pre: 2,
  preview: 2,
};

const VERSION_RE =
  /^v?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d+)?)?(?:(?:[-_.]?(post|rev|r)[-_.]?(\d+)?)|-(\d+))?(?:[-_.]?dev[-_.]?(\d+)?)?(?:\+[a-z0-9.\-_]+)?$/;

export function parseVersion(raw: string): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (!text || text.length > 64) return null;
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  const release = (m[1] ?? '').split('.').map((part) => Number(part));
  if (release.some((part) => !Number.isSafeInteger(part))) return null;
  const preTag = m[2];
  const pre: [number, number] | null =
    preTag !== undefined ? [PRE_RANK[preTag] ?? 2, Number(m[3] ?? 0)] : null;
  let post: number | null = null;
  if (m[4] !== undefined) post = Number(m[5] ?? 0);
  else if (m[6] !== undefined) post = Number(m[6]);
  const dev = text.includes('dev') ? Number(m[7] ?? 0) : null;
  return { release, pre, post, dev };
}

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpTuple(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = cmpNum(a[i] ?? 0, b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** PEP 440 排序：X.devN < XaN < XbN < XrcN < X < X.postN；dev 附在哪一段就排在该段之前。 */
function phaseKey(v: ParsedVersion): number[] {
  const preKey =
    v.pre !== null
      ? [0, v.pre[0], v.pre[1]]
      : v.dev !== null && v.post === null
        ? [-1, 0, 0]
        : [1, 0, 0];
  const postKey = v.post !== null ? v.post : -1;
  const devKey = v.dev !== null ? v.dev : Number.MAX_SAFE_INTEGER;
  return [...preKey, postKey, devKey];
}

export function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  const release = cmpTuple(a.release, b.release);
  if (release !== 0) return release;
  return cmpTuple(phaseKey(a), phaseKey(b));
}

/** 比较两个版本字符串；任一方无法解析时返回 null（“无法判定”）。 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  return compareParsed(pa, pb);
}
