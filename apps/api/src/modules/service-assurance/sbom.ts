import { createHash } from 'node:crypto';

export const SERVICE_ASSURANCE_SBOM_LIMITS = Object.freeze({
  maxRequestBytes: 3 * 1024 * 1024,
  maxBytes: 2 * 1024 * 1024,
  maxComponents: 1_000,
  maxDepth: 32,
  maxNodes: 25_000,
});

export type SbomFormat = 'CYCLONEDX_JSON' | 'SPDX_JSON' | 'SPDX_TAG_VALUE';
export type SbomIdentityStatus = 'EXACT' | 'MISSING_VERSION' | 'INVALID_PURL' | 'NAME_ONLY';

export interface ParsedSbomComponent {
  name: string;
  packageName: string;
  vendor: string | null;
  version: string | null;
  purl: string | null;
  cpe: string | null;
  hashes: Record<string, string> | null;
  ecosystem: string | null;
  identityStatus: SbomIdentityStatus;
}

export interface ParsedSbom {
  format: SbomFormat;
  contentSha256: string;
  byteLength: number;
  components: ParsedSbomComponent[];
}

export type SbomInputErrorCode =
  | 'SERVICE_ASSURANCE_SBOM_REQUEST_INVALID'
  | 'SERVICE_ASSURANCE_SBOM_CONTENT_TYPE'
  | 'SERVICE_ASSURANCE_SBOM_ARCHIVE_REJECTED'
  | 'SERVICE_ASSURANCE_SBOM_BINARY_REJECTED'
  | 'SERVICE_ASSURANCE_SBOM_TOO_LARGE'
  | 'SERVICE_ASSURANCE_SBOM_TOO_DEEP'
  | 'SERVICE_ASSURANCE_SBOM_TOO_COMPLEX'
  | 'SERVICE_ASSURANCE_SBOM_COMPONENT_LIMIT'
  | 'SERVICE_ASSURANCE_SBOM_FORMAT_INVALID';

const ERROR_MESSAGE: Record<SbomInputErrorCode, string> = {
  SERVICE_ASSURANCE_SBOM_REQUEST_INVALID: '组件清单请求格式无效。',
  SERVICE_ASSURANCE_SBOM_CONTENT_TYPE: '组件清单内容类型不受支持。',
  SERVICE_ASSURANCE_SBOM_ARCHIVE_REJECTED: '不接受压缩包或归档文件。',
  SERVICE_ASSURANCE_SBOM_BINARY_REJECTED: '组件清单必须是 UTF-8 文本。',
  SERVICE_ASSURANCE_SBOM_TOO_LARGE: '组件清单超过大小限制。',
  SERVICE_ASSURANCE_SBOM_TOO_DEEP: '组件清单嵌套层级超过限制。',
  SERVICE_ASSURANCE_SBOM_TOO_COMPLEX: '组件清单结构超过复杂度限制。',
  SERVICE_ASSURANCE_SBOM_COMPONENT_LIMIT: '组件清单中的组件数量超过限制。',
  SERVICE_ASSURANCE_SBOM_FORMAT_INVALID: '组件清单格式无效。',
};

export class SbomInputError extends Error {
  constructor(readonly code: SbomInputErrorCode) {
    super(ERROR_MESSAGE[code]);
    this.name = 'SbomInputError';
  }
}

interface ParsedPurl {
  value: string;
  ecosystem: string;
  name: string;
  version: string | null;
}

interface RawComponent {
  name: unknown;
  vendor?: unknown;
  version?: unknown;
  purl?: unknown;
  cpe?: unknown;
  hashes?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 2_048): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) return null;
  if (normalized === 'NOASSERTION' || normalized === 'NONE') return null;
  return normalized;
}

function contentBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

function isArchive(bytes: Uint8Array): boolean {
  const prefix = (...values: number[]): boolean =>
    values.every((value, index) => bytes[index] === value);
  if (
    prefix(0x50, 0x4b) ||
    prefix(0x1f, 0x8b) ||
    prefix(0x42, 0x5a, 0x68) ||
    prefix(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) ||
    prefix(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) ||
    prefix(0x52, 0x61, 0x72, 0x21)
  ) {
    return true;
  }
  if (bytes.byteLength < 262) return false;
  return new TextDecoder().decode(bytes.subarray(257, 262)) === 'ustar';
}

function decodeUtf8(content: string | Uint8Array, bytes: Uint8Array): string {
  if (bytes.includes(0)) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_BINARY_REJECTED');
  }
  if (typeof content === 'string') return content;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_BINARY_REJECTED');
  }
}

function inspectJsonShape(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > SERVICE_ASSURANCE_SBOM_LIMITS.maxNodes) {
      throw new SbomInputError('SERVICE_ASSURANCE_SBOM_TOO_COMPLEX');
    }
    if (current.depth > SERVICE_ASSURANCE_SBOM_LIMITS.maxDepth) {
      throw new SbomInputError('SERVICE_ASSURANCE_SBOM_TOO_DEEP');
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      for (const item of Object.values(current.value)) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function parsePurl(value: unknown): ParsedPurl | null {
  const raw = text(value);
  if (!raw || !raw.startsWith('pkg:') || /[\s\\]/.test(raw)) return null;
  const withoutFragment = raw.split('#', 1)[0]!;
  const withoutQuery = withoutFragment.split('?', 1)[0]!;
  const body = withoutQuery.slice(4);
  const slash = body.indexOf('/');
  if (slash <= 0 || slash === body.length - 1) return null;
  const ecosystem = body.slice(0, slash).toLowerCase();
  if (!/^[a-z][a-z0-9.+-]*$/.test(ecosystem)) return null;
  const coordinate = body.slice(slash + 1);
  const at = coordinate.lastIndexOf('@');
  const encodedPath = at >= 0 ? coordinate.slice(0, at) : coordinate;
  const encodedVersion = at >= 0 ? coordinate.slice(at + 1) : '';
  let segments: string[];
  let version: string | null;
  try {
    segments = encodedPath.split('/').map((segment) => decodeURIComponent(segment));
    version = encodedVersion ? decodeURIComponent(encodedVersion) : null;
  } catch {
    return null;
  }
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    (version !== null && (!version || version.length > 500))
  ) {
    return null;
  }
  return {
    value: raw,
    ecosystem,
    name: segments.at(-1)!,
    version,
  };
}

function normalizeCpe(value: unknown): string | null {
  const cpe = text(value);
  return cpe && /^cpe:2\.3:[aho]:[^\s]+$/i.test(cpe) ? cpe : null;
}

function normalizeHashes(value: unknown): Record<string, string> | null {
  if (!Array.isArray(value)) return null;
  const hashes: Record<string, string> = {};
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const algorithm = text(entry.alg ?? entry.algorithm, 40)
      ?.replace(/-/g, '')
      .toUpperCase();
    const digest = text(entry.content ?? entry.checksumValue, 512)?.toLowerCase();
    if (!algorithm || !digest || !/^[a-f0-9]+$/.test(digest)) continue;
    hashes[algorithm] = digest;
  }
  return Object.keys(hashes).length > 0 ? hashes : null;
}

function component(raw: RawComponent): ParsedSbomComponent | null {
  const declaredName = text(raw.name, 500);
  if (!declaredName) return null;
  const declaredVersion = text(raw.version, 500);
  const suppliedPurl = text(raw.purl);
  const parsedPurl = parsePurl(raw.purl);
  const cpe = normalizeCpe(raw.cpe);
  const version = declaredVersion ?? parsedPurl?.version ?? null;
  let identityStatus: SbomIdentityStatus;
  if (suppliedPurl && !parsedPurl) {
    identityStatus = 'INVALID_PURL';
  } else if (
    parsedPurl &&
    declaredVersion &&
    parsedPurl.version &&
    parsedPurl.version !== declaredVersion
  ) {
    identityStatus = 'INVALID_PURL';
  } else if (!version) {
    identityStatus = 'MISSING_VERSION';
  } else if (parsedPurl?.version || cpe) {
    identityStatus = 'EXACT';
  } else {
    identityStatus = 'NAME_ONLY';
  }
  return {
    name: declaredName,
    packageName: parsedPurl?.name ?? declaredName,
    vendor: text(raw.vendor, 500),
    version,
    purl: identityStatus === 'INVALID_PURL' ? null : (parsedPurl?.value ?? null),
    cpe,
    hashes: normalizeHashes(raw.hashes),
    ecosystem: parsedPurl?.ecosystem ?? null,
    identityStatus,
  };
}

function cyclonedxComponents(document: Record<string, unknown>): ParsedSbomComponent[] {
  if (document.bomFormat !== 'CycloneDX' || !text(document.specVersion, 20)) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_FORMAT_INVALID');
  }
  const rawComponents = Array.isArray(document.components) ? document.components : [];
  const metadata = isRecord(document.metadata) ? document.metadata : null;
  const metadataComponent = metadata && isRecord(metadata.component) ? metadata.component : null;
  const all = metadataComponent ? [metadataComponent, ...rawComponents] : rawComponents;
  if (all.length > SERVICE_ASSURANCE_SBOM_LIMITS.maxComponents) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_COMPONENT_LIMIT');
  }
  return all.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const parsed = component({
      name: entry.name,
      vendor:
        entry.publisher ?? (isRecord(entry.supplier) ? entry.supplier.name : null) ?? entry.group,
      version: entry.version,
      purl: entry.purl,
      cpe: entry.cpe,
      hashes: entry.hashes,
    });
    return parsed ? [parsed] : [];
  });
}

function spdxExternalReference(references: unknown, type: 'purl' | 'cpe23Type'): string | null {
  if (!Array.isArray(references)) return null;
  for (const reference of references) {
    if (!isRecord(reference)) continue;
    if (text(reference.referenceType, 100)?.toLowerCase() === type.toLowerCase()) {
      return text(reference.referenceLocator);
    }
  }
  return null;
}

function supplierName(value: unknown): string | null {
  const supplier = text(value, 500);
  if (!supplier) return null;
  return supplier.replace(/^(?:Organization|Person):\s*/i, '').trim() || null;
}

function spdxComponents(document: Record<string, unknown>): ParsedSbomComponent[] {
  if (!text(document.spdxVersion, 30)?.startsWith('SPDX-')) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_FORMAT_INVALID');
  }
  const packages = Array.isArray(document.packages) ? document.packages : [];
  if (packages.length > SERVICE_ASSURANCE_SBOM_LIMITS.maxComponents) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_COMPONENT_LIMIT');
  }
  return packages.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const parsed = component({
      name: entry.name,
      vendor: supplierName(entry.supplier),
      version: entry.versionInfo,
      purl: spdxExternalReference(entry.externalRefs, 'purl'),
      cpe: spdxExternalReference(entry.externalRefs, 'cpe23Type'),
      hashes: entry.checksums,
    });
    return parsed ? [parsed] : [];
  });
}

function tagValueComponents(content: string): ParsedSbomComponent[] {
  const lines = content.split(/\r?\n/);
  if (!lines.some((line) => /^SPDXVersion:\s*SPDX-/i.test(line))) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_FORMAT_INVALID');
  }
  if (lines.length > SERVICE_ASSURANCE_SBOM_LIMITS.maxNodes) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_TOO_COMPLEX');
  }
  const packages: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'PackageName') {
      current = { name: value, hashes: [], externalRefs: [] };
      packages.push(current);
      if (packages.length > SERVICE_ASSURANCE_SBOM_LIMITS.maxComponents) {
        throw new SbomInputError('SERVICE_ASSURANCE_SBOM_COMPONENT_LIMIT');
      }
      continue;
    }
    if (!current) continue;
    if (key === 'PackageVersion') current.version = value;
    if (key === 'PackageSupplier') current.vendor = supplierName(value);
    if (key === 'PackageChecksum') {
      const checksum = /^(\S+):\s*([a-fA-F0-9]+)$/.exec(value);
      if (checksum) {
        (current.hashes as unknown[]).push({
          algorithm: checksum[1],
          checksumValue: checksum[2],
        });
      }
    }
    if (key === 'ExternalRef') {
      const reference = /^(\S+)\s+(\S+)\s+(.+)$/.exec(value);
      if (reference) {
        (current.externalRefs as unknown[]).push({
          referenceCategory: reference[1],
          referenceType: reference[2],
          referenceLocator: reference[3],
        });
      }
    }
  }
  return packages.flatMap((entry) => {
    const parsed = component({
      name: entry.name,
      vendor: entry.vendor,
      version: entry.version,
      purl: spdxExternalReference(entry.externalRefs, 'purl'),
      cpe: spdxExternalReference(entry.externalRefs, 'cpe23Type'),
      hashes: entry.hashes,
    });
    return parsed ? [parsed] : [];
  });
}

function mediaType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

export function parseSbomUpload(input: {
  contentType: string;
  content: string | Uint8Array;
}): ParsedSbom {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !['contentType', 'content'].includes(key)) ||
    typeof input.contentType !== 'string' ||
    !(typeof input.content === 'string' || input.content instanceof Uint8Array)
  ) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_REQUEST_INVALID');
  }
  const type = mediaType(input.contentType);
  const allowed = new Set([
    'application/json',
    'application/vnd.cyclonedx+json',
    'application/spdx+json',
    'text/spdx',
  ]);
  if (!allowed.has(type)) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_CONTENT_TYPE');
  }
  const bytes = contentBytes(input.content);
  if (bytes.byteLength > SERVICE_ASSURANCE_SBOM_LIMITS.maxBytes) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_TOO_LARGE');
  }
  if (isArchive(bytes)) {
    throw new SbomInputError('SERVICE_ASSURANCE_SBOM_ARCHIVE_REJECTED');
  }
  const content = decodeUtf8(input.content, bytes);
  let format: SbomFormat;
  let components: ParsedSbomComponent[];
  if (type === 'text/spdx') {
    format = 'SPDX_TAG_VALUE';
    components = tagValueComponents(content);
  } else {
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch {
      throw new SbomInputError('SERVICE_ASSURANCE_SBOM_FORMAT_INVALID');
    }
    inspectJsonShape(document);
    if (!isRecord(document)) {
      throw new SbomInputError('SERVICE_ASSURANCE_SBOM_FORMAT_INVALID');
    }
    if (document.bomFormat === 'CycloneDX' && type !== 'application/spdx+json') {
      format = 'CYCLONEDX_JSON';
      components = cyclonedxComponents(document);
    } else if (
      typeof document.spdxVersion === 'string' &&
      type !== 'application/vnd.cyclonedx+json'
    ) {
      format = 'SPDX_JSON';
      components = spdxComponents(document);
    } else {
      throw new SbomInputError('SERVICE_ASSURANCE_SBOM_FORMAT_INVALID');
    }
  }
  return {
    format,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    components,
  };
}
