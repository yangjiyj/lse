/**
 * 依赖清单解析（Python）：requirements*.txt、pyproject.toml（PEP 621 与 Poetry 两种写法）。
 *
 * 版本确定性：只有 `==`/`===` 精确钉版本记为 exact；范围（>=、~=、^、*、多条件等）记为
 * range，交给匹配层降级为“可能受影响”(POSSIBLE)——范围解析出的真实安装版本取决于解析时刻，
 * 静态扫描无法确定，报确定命中会误报，完全不报又会漏掉“允许安装受影响版本”的风险。
 */
export type ManifestEcosystem = 'pypi' | 'npm';

export interface ManifestDependency {
  ecosystem: ManifestEcosystem;
  name: string;
  /** exact 时为精确版本；range 时为原始范围表达式（可能为空串 = 未约束）。 */
  version: string;
  versionKind: 'exact' | 'range';
  file: string;
  line: number;
}

/** PEP 503 名称规范化：大小写不敏感，-_. 等价。 */
export function normalizePypiName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

const PY_REQ_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/;

/** 解析单条 PEP 508 需求（忽略环境标记）；返回 null 表示不是包需求。 */
export function parsePep508(
  spec: string,
): { name: string; version: string; versionKind: 'exact' | 'range' } | null {
  const text = spec.split(';')[0]?.trim() ?? '';
  if (!text || text.includes('://') || text.startsWith('-') || text.startsWith('.')) return null;
  const m = PY_REQ_RE.exec(text);
  if (!m?.[1]) return null;
  const constraint = (m[3] ?? '').replace(/^\(|\)$/g, '').trim();
  if (constraint.startsWith('@')) return null; // 直接 URL 引用
  const exact = /^={2,3}\s*([A-Za-z0-9.+!_-]+)$/.exec(constraint);
  if (exact?.[1] && !exact[1].includes('*')) {
    return { name: normalizePypiName(m[1]), version: exact[1], versionKind: 'exact' };
  }
  return { name: normalizePypiName(m[1]), version: constraint, versionKind: 'range' };
}

export function parseRequirementsTxt(file: string, content: string): ManifestDependency[] {
  const out: ManifestDependency[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? '').replace(/(^|\s)#.*$/, '').replace(/\\$/, '').trim();
    if (!raw || raw.startsWith('-')) continue;
    const spec = raw.replace(/\s--hash=\S+/g, '').trim();
    const req = parsePep508(spec);
    if (req) out.push({ ecosystem: 'pypi', ...req, file, line: i + 1 });
  }
  return out;
}

/** 仅支持本场景需要的 TOML 子集：表头、键 = 字符串 / 内联表 / 字符串数组（可跨行）。 */
export function parsePyprojectToml(file: string, content: string): ManifestDependency[] {
  const out: ManifestDependency[] = [];
  const lines = content.split(/\r?\n/);
  let table = '';
  const pushPep508 = (spec: string, line: number) => {
    const req = parsePep508(spec);
    if (req) out.push({ ecosystem: 'pypi', ...req, file, line });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header?.[1]) {
      table = header[1].replace(/["']/g, '');
      continue;
    }
    const kv = /^("?[A-Za-z0-9._-]+"?)\s*=\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    const key = kv[1].replace(/"/g, '');
    const value = kv[2] ?? '';
    const pep621 =
      (table === 'project' && key === 'dependencies') ||
      table === 'project.optional-dependencies' ||
      table === 'dependency-groups';
    if (pep621 && value.startsWith('[')) {
      // 逐行收集数组元素，保留每个元素所在行号
      let j = i;
      let chunk = value;
      for (;;) {
        for (const m of chunk.matchAll(/"([^"]*)"|'([^']*)'/g)) pushPep508(m[1] ?? m[2] ?? '', j + 1);
        if (/\]\s*(#.*)?$/.test(chunk.replace(/"[^"]*"|'[^']*'/g, '')) || j + 1 >= lines.length) break;
        j += 1;
        chunk = (lines[j] ?? '').trim();
      }
      i = j;
      continue;
    }
    const poetry = /^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(table);
    if (poetry && key.toLowerCase() !== 'python') {
      const str = /^"([^"]*)"|^'([^']*)'/.exec(value);
      const inline = /version\s*=\s*"([^"]*)"/.exec(value);
      const constraint = (str?.[1] ?? str?.[2] ?? inline?.[1] ?? '').trim();
      if (!str && !inline) continue; // git/path 依赖
      const exact = /^(?:==)?\s*(\d[A-Za-z0-9.+!_-]*)$/.exec(constraint);
      out.push({
        ecosystem: 'pypi',
        name: normalizePypiName(key),
        version: exact?.[1] ?? constraint,
        versionKind: exact?.[1] ? 'exact' : 'range',
        file,
        line: i + 1,
      });
    }
  }
  return out;
}
