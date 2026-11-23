/** 依赖清单统一入口：按文件名分派到具体解析器。 */
import {
  parsePackageJson,
  parsePackageLock,
  parsePnpmLock,
} from './manifests-npm.js';
import {
  parsePyprojectToml,
  parseRequirementsTxt,
  type ManifestDependency,
} from './manifests-python.js';

export type { ManifestDependency, ManifestEcosystem } from './manifests-python.js';
export { normalizePypiName, parsePep508 } from './manifests-python.js';

export type ManifestKind =
  | 'requirements.txt'
  | 'pyproject.toml'
  | 'package.json'
  | 'package-lock.json'
  | 'pnpm-lock.yaml';

/** 单文件解析上限，防止超大输入拖慢扫描。 */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export function detectManifestKind(filePath: string): ManifestKind | null {
  const base = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (/^requirements[\w.-]*\.txt$/.test(base) || /^requirements\/.+\.txt$/.test(base)) {
    return 'requirements.txt';
  }
  if (base === 'pyproject.toml') return 'pyproject.toml';
  if (base === 'package.json') return 'package.json';
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return 'package-lock.json';
  if (base === 'pnpm-lock.yaml') return 'pnpm-lock.yaml';
  return null;
}

export function parseManifest(filePath: string, content: string): ManifestDependency[] {
  const kind = detectManifestKind(filePath);
  if (!kind || typeof content !== 'string' || content.length > MAX_MANIFEST_BYTES) return [];
  switch (kind) {
    case 'requirements.txt':
      return parseRequirementsTxt(filePath, content);
    case 'pyproject.toml':
      return parsePyprojectToml(filePath, content);
    case 'package.json':
      return parsePackageJson(filePath, content);
    case 'package-lock.json':
      return parsePackageLock(filePath, content);
    case 'pnpm-lock.yaml':
      return parsePnpmLock(filePath, content);
  }
}
