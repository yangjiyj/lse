/**
 * 依赖清单解析（npm）：package.json、package-lock.json（v2/v3 packages 字段）、pnpm-lock.yaml。
 * 锁文件记录的是实际解析版本，视为 exact；package.json 仅精确版本（1.2.3 / =1.2.3 / v1.2.3）
 * 视为 exact，其余（^、~、>=、x、*、tag、git/file 链接）视为 range。
 * 解析失败的文件返回空数组（不抛错），由调用方统计。
 */
import type { ManifestDependency } from './manifests-python.js';

const NPM_NAME_RE = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i;

/** 在原文中定位 `"key"` 首次出现的行号（1 起）；找不到返回 1。 */
function lineOf(content: string, needle: string, from = 0): number {
  const index = content.indexOf(needle, from);
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

function safeJson(content: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parsePackageJson(file: string, content: string): ManifestDependency[] {
  const json = safeJson(content);
  if (!json) return [];
  const out: ManifestDependency[] = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = json[section];
    if (!deps || typeof deps !== 'object') continue;
    const sectionAt = content.indexOf(`"${section}"`);
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== 'string' || !NPM_NAME_RE.test(name)) continue;
      const exact = /^(?:=|v)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec.trim());
      out.push({
        ecosystem: 'npm',
        name,
        version: exact?.[1] ?? spec.trim(),
        versionKind: exact?.[1] ? 'exact' : 'range',
        file,
        line: lineOf(content, `"${name}"`, Math.max(sectionAt, 0)),
      });
    }
  }
  return out;
}

export function parsePackageLock(file: string, content: string): ManifestDependency[] {
  const json = safeJson(content);
  const packages = json?.packages;
  if (!packages || typeof packages !== 'object') return [];
  const out: ManifestDependency[] = [];
  for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
    if (!key || !entry || typeof entry !== 'object') continue; // "" 为根项目
    const e = entry as { version?: unknown; name?: unknown; link?: unknown };
    if (e.link === true || typeof e.version !== 'string') continue;
    const idx = key.lastIndexOf('node_modules/');
    const name = typeof e.name === 'string' ? e.name : idx >= 0 ? key.slice(idx + 13) : '';
    if (!NPM_NAME_RE.test(name)) continue;
    out.push({
      ecosystem: 'npm',
      name,
      version: e.version,
      versionKind: 'exact',
      file,
      line: lineOf(content, `"${key}"`),
    });
  }
  return out;
}

/**
 * pnpm-lock.yaml：只读 `packages:`（及 v9 的 `snapshots:`）下的顶层键，形如
 *   /name@1.2.3:、/@scope/name@1.2.3(peer@x):、name@1.2.3:、'@scope/name@1.2.3':、/name/1.2.3:（v5）
 */
export function parsePnpmLock(file: string, content: string): ManifestDependency[] {
  const out: ManifestDependency[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);
  let inPackages = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line)) {
      inPackages = /^(packages|snapshots):\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const m = /^ {2}(['"]?)(\/?[^\s'"]+)\1:\s*$/.exec(line);
    if (!m?.[2]) continue;
    const key = m[2].replace(/^\//, '').replace(/\(.*$/, '');
    let name = '';
    let version = '';
    const at = key.lastIndexOf('@');
    if (at > 0) {
      name = key.slice(0, at);
      version = key.slice(at + 1);
    } else {
      const slash = key.lastIndexOf('/');
      name = key.slice(0, slash);
      version = key.slice(slash + 1);
    }
    version = version.replace(/_.*$/, '');
    if (!NPM_NAME_RE.test(name) || !/^\d/.test(version)) continue;
    const dedupe = `${name}@${version}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ ecosystem: 'npm', name, version, versionKind: 'exact', file, line: i + 1 });
  }
  return out;
}
