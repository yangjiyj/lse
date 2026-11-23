export const MAX_SERVICE_ASSURANCE_SBOM_BYTES = 2 * 1024 * 1024;

const ALLOWED_SBOM_TYPES = new Set([
  'application/json',
  'application/vnd.cyclonedx+json',
  'application/spdx+json',
  'text/spdx',
]);

export function serviceAssuranceSbomContentType(file: File): string | null {
  const declaredType = file.type.split(';', 1)[0]!.trim().toLowerCase();
  if (ALLOWED_SBOM_TYPES.has(declaredType)) return declaredType;
  const name = file.name.toLowerCase();
  if (name.endsWith('.spdx')) return 'text/spdx';
  if (name.endsWith('.json')) return 'application/json';
  return null;
}

export function serviceAssuranceSbomFileError(file: File): string | null {
  if (!serviceAssuranceSbomContentType(file)) {
    return '仅支持 CycloneDX JSON、SPDX JSON 或 SPDX 文本清单。';
  }
  if (file.size > MAX_SERVICE_ASSURANCE_SBOM_BYTES) {
    return '组件清单不能超过 2 MB。';
  }
  return null;
}

export function readServiceAssuranceSbomFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('组件清单读取失败'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}
