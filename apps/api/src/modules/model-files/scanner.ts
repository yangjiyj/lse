import { createHash } from 'node:crypto';
import { analyzePickle } from './pickle.js';
import { scanSafetensors } from './safetensors.js';
import { CONFIG_MAX_BYTES, configInScope, isConfigFile, scanConfigFile } from './config-file.js';
import {
  OFFICE_MACRO_FILE,
  SCRIPT_MAX_BYTES,
  VBA_PROJECT_ENTRY,
  isScriptFile,
  scanArchivedOffice,
  scanArchivedScript,
  scanOfficeMacro,
  scanScriptFile,
  scanVbaEntry,
} from './script-scan.js';
import { scanGguf } from './gguf.js';
import { scanOnnx } from './onnx.js';
import { scanKerasH5, scanKerasZip } from './keras.js';
import { scanNumpy } from './numpy.js';
import { inflatingSource } from './inflate.js';
import { entrySource, listZip, looksLikeZip, type ZipEntry } from './zip.js';
import { bufferSource, type ByteSource } from './source.js';
import {
  ARCHIVE_TEXT_MAX_BYTES,
  ARCHIVE_TEXT_MAX_ENTRIES,
  DEFAULT_LIMITS,
  type FormatScan,
  type ModelFinding,
  type ScanLimits,
  MODEL_FILE_EXT,
} from './types.js';

export type { ModelFinding, ModelFormat, FormatScan, ScanLimits } from './types.js';
export { DEFAULT_LIMITS } from './types.js';

/** 这些扩展名由 torch.load / pickle.load / joblib.load 加载，无论首字节如何一律按 pickle 解析。 */
const PICKLE_EXT = /\.(?:pkl|pickle|pt|pth|bin|ckpt|joblib|dat|data)$/i;
const ZIP_PICKLE_ENTRY = /(?:^|\/)[^/]+\.(?:pkl|pickle)$/i;

async function pickleFindings(
  src: ByteSource,
  label: string,
  limits: ScanLimits,
): Promise<{ findings: ModelFinding[]; globals: string[] }> {
  const r = await analyzePickle(src, 0, src.size, { maxReadBytes: limits.pickleMaxBytes });
  const findings: ModelFinding[] = r.issues.map((i) => ({
    ...i,
    detail: label ? `${label}: ${i.detail}` : i.detail,
  }));
  if (r.complete && !findings.some((f) => f.severity !== 'INFO'))
    findings.push({
      ruleId: 'PICKLE_PARSED',
      severity: 'INFO',
      title: 'Pickle opcode 解析完成',
      detail: `${label ? `${label}: ` : ''}${r.opcodeCount} 个 opcode，未发现危险调用`,
    });
  return { findings, globals: r.globals };
}

const NESTED_ZIP = /\.zip$/i;
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** 压缩包内文本条目的读取预算：条目数和读取总量，所有层共享；超出的条目记下名字。 */
interface TextBudget {
  bytes: number;
  entries: number;
  maxBytes: number;
  skipped: string[];
}

/** 一个条目最多读多少：脚本 2 MiB、配置 8 MiB、宏工程 8 MiB；宏文档和内层 zip 整个读入。 */
function entryCost(e: ZipEntry): number {
  if (isScriptFile(e.name)) return Math.min(e.size, SCRIPT_MAX_BYTES);
  if (VBA_PROJECT_ENTRY.test(e.name)) return Math.min(e.size, 4 * SCRIPT_MAX_BYTES);
  if (OFFICE_MACRO_FILE.test(e.name) || NESTED_ZIP.test(e.name)) return e.size;
  return Math.min(e.size, CONFIG_MAX_BYTES);
}

async function readAll(src: ByteSource, e: ZipEntry): Promise<Buffer> {
  const s = await entrySource(src, e, e.size);
  return s.read(0, e.size);
}

/**
 * 压缩包里的脚本、配置文件、宏工程和宏文档（torch.package 会带 .py 源码）；内层 zip 展开一层。
 * 条目数（500）和读取总量（默认 64 MiB）共享预算，超出的条目不读，由调用方补一条提示。
 */
async function scanZipTexts(
  src: ByteSource,
  entries: ZipEntry[],
  budget: TextBudget,
  depth = 0,
): Promise<{ findings: ModelFinding[]; names: string[] }> {
  const findings: ModelFinding[] = [];
  const weightDirs = new Set(entries.filter((e) => MODEL_FILE_EXT.test(e.name)).map((e) => dirOf(e.name)));
  const picked = entries.filter(
    (e) =>
      isScriptFile(e.name) ||
      (isConfigFile(e.name) && configInScope(e.name, weightDirs)) ||
      VBA_PROJECT_ENTRY.test(e.name) ||
      OFFICE_MACRO_FILE.test(e.name) ||
      NESTED_ZIP.test(e.name),
  );
  const names: string[] = [];
  for (const e of picked) {
    if (NESTED_ZIP.test(e.name) && depth >= 1) {
      budget.skipped.push(`${e.name}（嵌套超过一层）`);
      continue;
    }
    const cost = entryCost(e);
    if (budget.entries >= ARCHIVE_TEXT_MAX_ENTRIES || budget.bytes + cost > budget.maxBytes) {
      budget.skipped.push(e.name);
      continue;
    }
    budget.entries++;
    budget.bytes += cost;
    names.push(e.name);
    // 条目之间让出事件循环，大压缩包不长时间占住进程
    await new Promise((r) => setImmediate(r));
    try {
      if (isScriptFile(e.name)) findings.push(...(await scanArchivedScript(src, e)));
      else if (VBA_PROJECT_ENTRY.test(e.name)) findings.push(...(await scanVbaEntry(src, e)));
      else if (OFFICE_MACRO_FILE.test(e.name)) findings.push(...(await scanArchivedOffice(src, e)));
      else if (NESTED_ZIP.test(e.name)) {
        const inner = bufferSource(await readAll(src, e));
        const sub: TextBudget = { ...budget, skipped: [] };
        const r = await scanZipTexts(inner, await listZip(inner), sub, depth + 1);
        budget.bytes = sub.bytes;
        budget.entries = sub.entries;
        budget.skipped.push(...sub.skipped.map((n) => `${e.name}/${n}`));
        findings.push(...r.findings.map((f) => ({ ...f, detail: `${e.name}/${f.detail}` })));
        names.push(...r.names.map((n) => `${e.name}/${n}`));
      } else {
        const r = await scanConfigFile(e.name, await entrySource(src, e, CONFIG_MAX_BYTES + 1));
        findings.push(...r.findings.map((f) => ({ ...f, detail: `${e.name}: ${f.detail}`, format: 'config' as const })));
      }
    } catch (err) {
      findings.push({
        ruleId: 'MODEL_PARSE_ABORTED',
        severity: 'MEDIUM',
        title: '模型文件解析中止',
        detail: `${e.name}: 解析中止：${err instanceof Error ? err.message : '未知错误'}`,
      });
    }
  }
  return { findings, names };
}

function skippedNote(skipped: string[], maxBytes: number): ModelFinding[] {
  if (!skipped.length) return [];
  return [
    {
      ruleId: 'ARCHIVE_ENTRIES_SKIPPED',
      severity: 'LOW',
      title: '压缩包内部分条目未检查',
      detail:
        `${skipped.length} 个条目超出检查上限未检查（条目数 ${ARCHIVE_TEXT_MAX_ENTRIES}、` +
        `读取总量 ${maxBytes / 1024 / 1024 >= 1 ? `${maxBytes / 1024 / 1024} MiB` : `${maxBytes} 字节`}、` +
        `内层压缩包只展开一层）：${skipped.slice(0, 10).join('、')}${skipped.length > 10 ? ' 等' : ''}`,
    },
  ];
}

async function scanZipPickles(
  src: ByteSource,
  entries: ZipEntry[],
  limits: ScanLimits,
  format: 'pytorch-zip' | 'zip' = 'pytorch-zip',
): Promise<FormatScan> {
  const pkls = entries.filter((e) => ZIP_PICKLE_ENTRY.test(e.name));
  const findings: ModelFinding[] = [];
  const globals = new Set<string>();
  if (!pkls.length && format === 'pytorch-zip')
    findings.push({
      ruleId: 'PYTORCH_ZIP_NO_PICKLE',
      severity: 'LOW',
      title: 'ZIP 归档内未找到 pickle',
      detail: `共 ${entries.length} 个条目`,
    });
  for (const e of pkls) {
    try {
      const r = await pickleFindings(await entrySource(src, e, limits.pickleMaxBytes + 65536), e.name, limits);
      findings.push(...r.findings);
      r.globals.forEach((g) => globals.add(g));
    } catch (err) {
      findings.push({
        ruleId: 'PICKLE_PARSE_ABORTED',
        severity: 'MEDIUM',
        title: 'Pickle 解析中止',
        detail: `${e.name}: 解析中止：${err instanceof Error ? err.message : '未知错误'}`,
      });
    }
  }
  const budget: TextBudget = {
    bytes: 0,
    entries: 0,
    maxBytes: limits.archiveTextMaxBytes ?? ARCHIVE_TEXT_MAX_BYTES,
    skipped: [],
  };
  const texts = await scanZipTexts(src, entries, budget);
  findings.push(...texts.findings, ...skippedNote(budget.skipped, budget.maxBytes));
  return {
    format,
    findings,
    meta: {
      zipEntries: entries.length,
      pickleEntries: pkls.map((e) => e.name).slice(0, 100),
      ...(texts.names.length ? { scriptEntries: texts.names.slice(0, 100) } : {}),
      globals: [...globals].slice(0, 200),
    },
  };
}

/** Keras 3 归档：config.json 在根且没有任何 pickle 条目。含 pickle 的一律按 pickle 扫描。 */
function isKerasZip(fileName: string, entries: ZipEntry[]): boolean {
  if (entries.some((e) => ZIP_PICKLE_ENTRY.test(e.name))) return false;
  if (fileName.endsWith('.keras')) return true;
  const names = new Set(entries.map((e) => e.name));
  return names.has('config.json') && names.has('metadata.json');
}

/** joblib/zlib 压缩：zlib 头 0x78 0x01/5E/9C/DA；流式解压后按 pickle 扫描。 */
function looksLikeZlib(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0x78 && (head[0]! * 256 + head[1]!) % 31 === 0;
}

async function scanCompressedPickle(
  src: ByteSource,
  kind: 'zlib' | 'gzip',
  limits: ScanLimits,
): Promise<FormatScan> {
  // 逻辑大小取扫描窗口 +1：窗口内读完即结束，读不完由 analyzePickle 标注“仅分析头部”
  const inflated = inflatingSource(src, 0, src.size, limits.pickleMaxBytes + 1, kind);
  const r = await pickleFindings(inflated, `${kind} 解压后`, limits);
  return { format: 'pickle', findings: r.findings, meta: { compression: kind, globals: r.globals.slice(0, 200) } };
}

/** 按魔数与扩展名分派到各格式解析器；全程只读字节，不加载模型。 */
export async function scanModelSource(
  fileName: string,
  src: ByteSource,
  limits: ScanLimits = DEFAULT_LIMITS,
): Promise<FormatScan> {
  const f = fileName.toLowerCase();
  const head = await src.read(0, 8);
  try {
    if (isConfigFile(f)) return await scanConfigFile(fileName, src);
    if (isScriptFile(f)) return await scanScriptFile(fileName, src);
    if (OFFICE_MACRO_FILE.test(f)) return await scanOfficeMacro(src, fileName);
    if (f.endsWith('.safetensors')) return await scanSafetensors(src);
    if (head.subarray(0, 4).toString('latin1') === 'GGUF' || f.endsWith('.gguf'))
      return await scanGguf(src);
    if (f.endsWith('.onnx')) return await scanOnnx(src);
    if (f.endsWith('.npy') || f.endsWith('.npz')) return await scanNumpy(f, src, limits);
    if (f.endsWith('.h5') || f.endsWith('.hdf5') || head.subarray(0, 4).toString('latin1') === '\x89HDF')
      return await scanKerasH5(src);
    if (looksLikeZip(head)) {
      const entries = await listZip(src);
      if (isKerasZip(f, entries)) return await scanKerasZip(src);
      return await scanZipPickles(src, entries, limits, f.endsWith('.zip') ? 'zip' : 'pytorch-zip');
    }
    if (PICKLE_EXT.test(f) || (head[0] === 0x80 && head[1]! <= 5)) {
      if (head[0] === 0x1f && head[1] === 0x8b) return await scanCompressedPickle(src, 'gzip', limits);
      if (looksLikeZlib(head)) return await scanCompressedPickle(src, 'zlib', limits);
      const r = await pickleFindings(src, '', limits);
      if (head[0] !== 0x80)
        r.findings.push({
          ruleId: 'PICKLE_NO_PROTO_HEADER',
          severity: 'INFO',
          title: '文件不以 pickle PROTO 开头',
          detail: `${fileName.split(/[\\/]/).pop()} 为协议 0/1 或非 pickle 数据；torch.load/pickle.load 仍会按 pickle 加载，已按 pickle 解析`,
        });
      return { format: 'pickle', findings: r.findings, meta: { globals: r.globals.slice(0, 200) } };
    }
  } catch (e) {
    return {
      format: 'unknown',
      findings: [
        {
          ruleId: 'MODEL_PARSE_ABORTED',
          severity: 'MEDIUM',
          title: '模型文件解析中止',
          detail: `解析中止：${e instanceof Error ? e.message : '未知错误'}`,
        },
      ],
      meta: {},
    };
  }
  return {
    format: 'unknown',
    findings: [
      {
        ruleId: 'MODEL_FORMAT_UNKNOWN',
        severity: 'LOW',
        title: '未识别的模型文件格式',
        detail: '未匹配已支持格式，静态扫描不构成安全保证',
      },
    ],
    meta: {},
  };
}

export async function scanModelBytes(
  fileName: string,
  bytes: Uint8Array,
  limits: ScanLimits = DEFAULT_LIMITS,
): Promise<FormatScan> {
  return scanModelSource(fileName, bufferSource(bytes), limits);
}

export async function sourceSha256(
  src: ByteSource,
  onChunk?: (bytes: number) => Promise<void> | void,
): Promise<string> {
  const h = createHash('sha256');
  const chunk = 4 * 1024 * 1024;
  for (let o = 0; o < src.size; o += chunk) {
    const b = await src.read(o, chunk);
    h.update(b);
    await onChunk?.(b.length);
  }
  return h.digest('hex');
}
