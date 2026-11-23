import type { ByteSource } from './source.js';
import type { FormatScan, ModelFinding } from './types.js';

const MAX_HEADER = 100 * 1024 * 1024;
/** safetensors 规范允许的 dtype 及每元素位数（F4/F6 等子字节类型按位计）。 */
const DTYPE_BITS: Record<string, number> = {
  BOOL: 8, U8: 8, I8: 8, F8_E5M2: 8, F8_E4M3: 8, F8_E8M0: 8, I16: 16, U16: 16, F16: 16, BF16: 16,
  I32: 32, U32: 32, F32: 32, F64: 64, I64: 64, U64: 64, C64: 64, F4: 4, F6_E2M3: 6, F6_E3M2: 6,
};

/** 只读取 8 字节长度 + JSON 头，按文件总长校验张量区间；不读取张量数据。 */
export async function scanSafetensors(src: ByteSource): Promise<FormatScan> {
  const invalid = (detail: string): FormatScan => ({
    format: 'safetensors',
    findings: [
      { ruleId: 'SAFETENSORS_INVALID', severity: 'HIGH', title: 'safetensors 结构异常', detail },
    ],
    meta: {},
  });
  if (src.size < 8) return invalid('文件短于 8 字节头长度');
  const n = Number((await src.read(0, 8)).readBigUInt64LE(0));
  if (!Number.isSafeInteger(n) || n < 2 || n > Math.min(src.size - 8, MAX_HEADER))
    return invalid('头长度越界');
  const dataSize = src.size - 8 - n;
  try {
    const h = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await src.read(8, n)),
    ) as Record<string, unknown>;
    if (!h || typeof h !== 'object' || Array.isArray(h)) throw Error('头部不是 JSON 对象');
    const spans: Array<[number, number]> = [];
    const dtypes = new Set<string>();
    let loraTensors = 0;
    let packedQuantTensors = 0;
    let params = 0;
    const findings: ModelFinding[] = [];
    const meta: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(h)) {
      if (name === '__metadata__') {
        if (v && typeof v === 'object')
          meta.metadata = Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => typeof x === 'string')
              .slice(0, 50),
          );
        continue;
      }
      if (!v || typeof v !== 'object') throw Error(`张量项无效: ${name}`);
      const x = v as { dtype?: unknown; shape?: unknown; data_offsets?: unknown };
      if (
        typeof x.dtype !== 'string' ||
        !Array.isArray(x.shape) ||
        !x.shape.every((a) => Number.isSafeInteger(a) && a >= 0) ||
        !Array.isArray(x.data_offsets) ||
        x.data_offsets.length !== 2 ||
        !x.data_offsets.every(Number.isSafeInteger)
      ) {
        throw Error(`张量元数据无效: ${name}`);
      }
      const [a, b] = x.data_offsets as [number, number];
      if (a < 0 || b < a || b > dataSize) throw Error(`张量数据越界: ${name}`);
      const bits = DTYPE_BITS[x.dtype];
      if (bits === undefined) throw Error(`张量 dtype 非法: ${name}（${x.dtype.slice(0, 20)}）`);
      const elems = (x.shape as number[]).reduce((p, c) => p * c, 1);
      const expect = Math.ceil((elems * bits) / 8);
      if (!Number.isSafeInteger(expect) || expect !== b - a)
        throw Error(`张量大小与 shape×dtype 不符: ${name}（应为 ${expect} 字节，实际区间 ${b - a} 字节）`);
      spans.push([a, b]);
      params += elems;
      dtypes.add(x.dtype);
      if (/(?:^|\.)lora_(?:A|B|up|down|embedding_A|embedding_B)(?:\.|$)/.test(name)) loraTensors++;
      if (/\.(?:qweight|qzeros)$/.test(name)) packedQuantTensors++;
    }
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++)
      if (spans[i]![0] < spans[i - 1]![1]) throw Error('张量数据区间重叠');
    meta.tensorCount = spans.length;
    meta.parameterCount = params;
    meta.dtypes = [...dtypes].sort().slice(0, 10);
    if (loraTensors) meta.loraTensors = loraTensors;
    if (packedQuantTensors) meta.packedQuantTensors = packedQuantTensors;
    findings.push({
      ruleId: 'SAFETENSORS_VALIDATED',
      severity: 'INFO',
      title: 'safetensors 结构检查通过',
      detail: `已校验 ${spans.length} 个张量`,
    });
    return { format: 'safetensors', findings, meta };
  } catch (e) {
    return invalid(e instanceof Error ? e.message : '头部 JSON 无效');
  }
}
