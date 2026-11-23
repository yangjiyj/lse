import { analyzePickle } from './pickle.js';
import type { ByteSource } from './source.js';
import type { FormatScan, ModelFinding, ScanLimits } from './types.js';
import { entrySource, listZip } from './zip.js';

const MAGIC = '\x93NUMPY';
/** descr 中的 object dtype（'|O'、'O'、结构化字段里的 'O'）。 */
const OBJECT_DESCR = /['"][|<>=]?O\d*['"]/;

/** 解析 .npy 头；dtype 含 object 时其后数据为 pickle，按 pickle 静态分析。 */
export async function scanNpySource(
  src: ByteSource,
  label: string,
  limits: ScanLimits,
): Promise<{ findings: ModelFinding[]; meta: Record<string, unknown> }> {
  const head = await src.read(0, 12);
  if (head.length < 10 || head.subarray(0, 6).toString('latin1') !== MAGIC)
    return {
      findings: [
        { ruleId: 'NUMPY_INVALID', severity: 'MEDIUM', title: 'npy 结构异常', detail: `${label}缺少 NUMPY 魔数` },
      ],
      meta: {},
    };
  const major = head[6]!;
  const hlen = major === 1 ? head.readUInt16LE(8) : head.readUInt32LE(8);
  const hstart = major === 1 ? 10 : 12;
  if (hlen > 1024 * 1024 || hstart + hlen > src.size)
    return {
      findings: [
        { ruleId: 'NUMPY_INVALID', severity: 'MEDIUM', title: 'npy 结构异常', detail: `${label}头长度越界` },
      ],
      meta: {},
    };
  const header = (await src.read(hstart, hlen)).toString('latin1');
  const descr = /['"]descr['"]\s*:\s*(\[.*\]|'[^']*'|"[^"]*")/s.exec(header)?.[1] ?? '';
  const shape = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header)?.[1] ?? '';
  const meta = { dtype: descr.slice(0, 200), shape: `(${shape.trim()})` };
  if (!OBJECT_DESCR.test(descr))
    return {
      findings: [
        { ruleId: 'NUMPY_PARSED', severity: 'INFO', title: 'npy 数值数组', detail: `${label}dtype ${meta.dtype}，不含 pickle` },
      ],
      meta,
    };
  const r = await analyzePickle(src, hstart + hlen, src.size, { maxReadBytes: limits.pickleMaxBytes });
  const findings: ModelFinding[] = [
    {
      ruleId: 'NUMPY_OBJECT_ARRAY',
      severity: 'LOW',
      title: 'npy 为 object 数组（加载需 allow_pickle）',
      detail: `${label}dtype ${meta.dtype}，数据以 pickle 存储，已按 pickle 静态分析`,
    },
    ...r.issues.map((i) => ({ ...i, detail: `${label}${i.detail}` })),
  ];
  return { findings, meta: { ...meta, globals: r.globals.slice(0, 200) } };
}

export async function scanNumpy(
  fileName: string,
  src: ByteSource,
  limits: ScanLimits,
): Promise<FormatScan> {
  if (!/\.npz$/i.test(fileName)) {
    const r = await scanNpySource(src, '', limits);
    return { format: 'numpy', ...r };
  }
  const entries = (await listZip(src)).filter((e) => /\.npy$/i.test(e.name));
  const findings: ModelFinding[] = [];
  for (const e of entries.slice(0, 1000)) {
    try {
      const es = await entrySource(src, e, limits.pickleMaxBytes + 65536);
      const r = await scanNpySource(es, `${e.name}: `, limits);
      findings.push(...r.findings.filter((f) => f.ruleId !== 'NUMPY_PARSED'));
    } catch (err) {
      findings.push({
        ruleId: 'NUMPY_INVALID',
        severity: 'MEDIUM',
        title: 'npz 条目解析中止',
        detail: `${e.name}: ${err instanceof Error ? err.message : '未知错误'}`,
      });
    }
  }
  findings.push({
    ruleId: 'NUMPY_PARSED',
    severity: 'INFO',
    title: 'npz 解析完成',
    detail: `共 ${entries.length} 个数组`,
  });
  return { format: 'numpy', findings, meta: { arrays: entries.length } };
}
