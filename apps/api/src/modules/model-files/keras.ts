import { Cursor, type ByteSource } from './source.js';
import { entrySource, listZip } from './zip.js';
import type { FormatScan, ModelFinding } from './types.js';

const MAX_CONFIG = 32 * 1024 * 1024;
const BUILTIN_MODULE = /^(?:keras|tensorflow|tf_keras)(?:\.|$)/;

type Layer = {
  class_name?: unknown;
  module?: unknown;
  registered_name?: unknown;
  config?: unknown;
};

function walkLayers(
  node: unknown,
  out: { lambdas: string[]; custom: string[]; count: number },
  depth = 0,
): void {
  if (depth > 64 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) walkLayers(x, out, depth + 1);
    return;
  }
  const l = node as Layer;
  if (typeof l.class_name === 'string') {
    out.count++;
    const name = (l.config as { name?: unknown } | undefined)?.name;
    const label = `${l.class_name}${typeof name === 'string' ? `(${name})` : ''}`;
    if (l.class_name === 'Lambda') out.lambdas.push(label);
    else if (typeof l.module === 'string' && !BUILTIN_MODULE.test(l.module))
      out.custom.push(`${l.module}.${l.class_name}`);
    else if (typeof l.registered_name === 'string' && l.registered_name.includes('>'))
      out.custom.push(l.registered_name);
  }
  for (const v of Object.values(node)) walkLayers(v, out, depth + 1);
}

function findingsFor(
  out: { lambdas: string[]; custom: string[]; count: number },
  prefix: string,
): ModelFinding[] {
  const f: ModelFinding[] = [];
  if (out.lambdas.length)
    f.push({
      ruleId: `${prefix}_LAMBDA_LAYER`,
      severity: 'HIGH',
      title: 'Keras 模型含 Lambda 层（加载时可执行任意代码）',
      detail: out.lambdas.slice(0, 20).join('、'),
    });
  if (out.custom.length)
    f.push({
      ruleId: `${prefix}_CUSTOM_OBJECT`,
      severity: 'MEDIUM',
      title: 'Keras 模型依赖自定义层或对象',
      detail: [...new Set(out.custom)].slice(0, 20).join('、'),
    });
  return f;
}

/** .keras（Keras 3 ZIP）：解析 config.json 全部层定义。 */
export async function scanKerasZip(src: ByteSource): Promise<FormatScan> {
  const meta: Record<string, unknown> = {};
  try {
    const entries = await listZip(src);
    const cfg = entries.find((e) => e.name === 'config.json');
    if (!cfg)
      return {
        format: 'keras',
        findings: [
          {
            ruleId: 'KERAS_CONFIG_MISSING',
            severity: 'MEDIUM',
            title: 'Keras 归档缺少 config.json',
            detail: '无法确认层结构',
          },
        ],
        meta,
      };
    const data = await entrySource(src, cfg, MAX_CONFIG);
    const json = JSON.parse((await data.read(0, data.size)).toString('utf8')) as unknown;
    const out = { lambdas: [] as string[], custom: [] as string[], count: 0 };
    walkLayers(json, out);
    meta.layerCount = out.count;
    const findings = findingsFor(out, 'KERAS');
    findings.push({
      ruleId: 'KERAS_PARSED',
      severity: 'INFO',
      title: 'Keras config.json 解析完成',
      detail: `${out.count} 个层/对象定义`,
    });
    return { format: 'keras', findings, meta };
  } catch (e) {
    return {
      format: 'keras',
      findings: [
        {
          ruleId: 'KERAS_PARSE_ABORTED',
          severity: 'MEDIUM',
          title: 'Keras 解析中止',
          detail: `解析中止：${e instanceof Error ? e.message : '未知错误'}`,
        },
      ],
      meta,
    };
  }
}

/**
 * Keras H5：未实现 HDF5 结构解析。按块流式搜索 model_config 属性中的 JSON 片段，
 * 启发式识别 Lambda 层与自定义模块；结论标注为启发式。
 */
export async function scanKerasH5(src: ByteSource): Promise<FormatScan> {
  const cur = new Cursor(src);
  const findings: ModelFinding[] = [];
  const out = { lambdas: [] as string[], custom: [] as string[], count: 0 };
  const lambda = /"class_name"\s*:\s*"Lambda"/g;
  const moduleRe = /"module"\s*:\s*"([^"]{1,200})"/g;
  let carry = '';
  let sawConfig = false;
  const chunk = 4 * 1024 * 1024;
  while (cur.remaining > 0) {
    const text = carry + (await cur.take(Math.min(chunk, cur.remaining))).toString('latin1');
    if (text.includes('"class_name"')) sawConfig = true;
    // 跳过完全落在上一块重叠区内的匹配，避免重复计数
    const fresh = (m: RegExpMatchArray) => m.index! + m[0].length > carry.length;
    for (const m of text.matchAll(lambda)) if (fresh(m)) out.lambdas.push('Lambda');
    for (const m of text.matchAll(moduleRe))
      if (fresh(m) && !BUILTIN_MODULE.test(m[1]!)) out.custom.push(m[1]!);
    carry = text.slice(-256);
  }
  out.lambdas = out.lambdas.length ? [`共 ${out.lambdas.length} 处 Lambda 定义（字节启发式）`] : [];
  findings.push(...findingsFor(out, 'KERAS_H5'));
  findings.push({
    ruleId: 'KERAS_H5_HEURISTIC',
    severity: sawConfig ? 'INFO' : 'MEDIUM',
    title: sawConfig ? 'Keras H5 启发式检查完成' : 'Keras H5 未找到模型配置',
    detail: '未完整解析 HDF5 结构，仅对 model_config JSON 片段做字节启发式匹配',
  });
  return { format: 'keras-h5', findings, meta: {} };
}
