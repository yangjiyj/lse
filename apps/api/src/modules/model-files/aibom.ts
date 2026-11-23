import { randomUUID } from 'node:crypto';
import { PRODUCT_NAME } from '../../lib/product-name.js';
import type { ParsedSbom } from '../service-assurance/sbom.js';

export interface AibomModelInput {
  name: string;
  path: string;
  format: string;
  bytes: number;
  sha256: string;
  meta: Record<string, unknown>;
}
export interface AibomOptions {
  source?: string | null;
  license?: string | null;
  parameterInfo?: string | null;
  datasetRefs?: string[];
  target?: { id: string; name: string; model: string } | null;
  dependencySbom?: ParsedSbom | null;
}

const HASH_ALG: Record<string, string> = {
  'sha-256': 'SHA-256',
  sha256: 'SHA-256',
  'sha-1': 'SHA-1',
  sha1: 'SHA-1',
  'sha-512': 'SHA-512',
  sha512: 'SHA-512',
  md5: 'MD5',
};

function prop(name: string, value: unknown) {
  return value === undefined || value === null || value === ''
    ? null
    : { name, value: String(value) };
}

/** 构造 CycloneDX 1.6 ML-BOM：模型文件为 machine-learning-model 组件，依赖 SBOM 合并为 library 组件。 */
export function buildCycloneDxMlBom(
  models: AibomModelInput[],
  opts: AibomOptions,
  now = new Date(),
) {
  const datasets = (opts.datasetRefs ?? []).map((name, i) => ({
    'bom-ref': `dataset-${i + 1}`,
    type: 'data',
    name,
    data: [{ type: 'dataset', name }],
  }));
  const deps = (opts.dependencySbom?.components ?? []).map((c, i) => {
    const hashes = Object.entries(c.hashes ?? {})
      .map(([alg, content]) => ({ alg: HASH_ALG[alg.toLowerCase()], content }))
      .filter((h): h is { alg: string; content: string } => Boolean(h.alg));
    return {
      'bom-ref': `dep-${i + 1}`,
      type: 'library',
      name: c.packageName || c.name,
      ...(c.vendor ? { group: c.vendor } : {}),
      ...(c.version ? { version: c.version } : {}),
      ...(c.purl ? { purl: c.purl } : {}),
      ...(c.cpe ? { cpe: c.cpe } : {}),
      ...(hashes.length ? { hashes } : {}),
    };
  });
  const modelComponents = models.map((m, i) => {
    const arch = m.meta['general.architecture'];
    const properties = [
      prop('lse:format', m.format),
      prop('lse:path', m.path),
      prop('lse:bytes', m.bytes),
      prop('lse:source', opts.source),
      prop('lse:parameterCount', m.meta.parameterCount),
      prop('lse:tensorCount', m.meta.tensorCount),
      prop('lse:parameterInfo', opts.parameterInfo),
    ].filter((p): p is { name: string; value: string } => p !== null);
    return {
      'bom-ref': `model-${i + 1}`,
      type: 'machine-learning-model',
      name: models.length === 1 ? opts.target?.name || m.name : m.name,
      hashes: [{ alg: 'SHA-256', content: m.sha256 }],
      ...(opts.license ? { licenses: [{ license: { name: opts.license } }] } : {}),
      ...(opts.source ? { externalReferences: [{ type: 'distribution', url: opts.source }] } : {}),
      properties,
      modelCard: {
        modelParameters: {
          ...(typeof arch === 'string' ? { architectureFamily: arch } : {}),
          ...(datasets.length ? { datasets: datasets.map((d) => ({ ref: d['bom-ref'] })) } : {}),
        },
      },
    };
  });
  const depRefs = deps.map((d) => d['bom-ref']);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: now.toISOString(),
      tools: { components: [{ type: 'application', name: `${PRODUCT_NAME}模型文件扫描` }] },
      ...(opts.target
        ? {
            // CycloneDX version 表示组件版本；评估对象的 model 是接口模型标识（如 qwen2.5-7b-instruct），不是版本号
            component: {
              'bom-ref': 'target',
              type: 'application',
              name: opts.target.name,
              ...(opts.target.model
                ? { properties: [{ name: 'lse:modelId', value: opts.target.model }] }
                : {}),
            },
          }
        : {}),
    },
    components: [...modelComponents, ...datasets, ...deps],
    dependencies: [
      ...(opts.target
        ? [{ ref: 'target', dependsOn: modelComponents.map((c) => c['bom-ref']) }]
        : []),
      ...modelComponents.map((c) => ({
        ref: c['bom-ref'],
        dependsOn: [...datasets.map((d) => d['bom-ref']), ...depRefs],
      })),
      ...depRefs.map((ref) => ({ ref, dependsOn: [] as string[] })),
    ],
  };
}
