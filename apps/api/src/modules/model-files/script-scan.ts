import { detectCodeRisks } from '../engines/ai-asset/engine/code-rules.js';
import { langOf, lineIndex } from '../engines/ai-asset/engine/lexer.js';
import { aiAssetRule } from '../engines/ai-asset/taxonomy.js';
import {
  AUTO_EXEC_PAYLOAD,
  AUTO_EXEC_PAYLOAD_PARTS,
  SCRIPT_PATTERN_RULES,
  type ScriptLang,
} from './script-rules.js';
import { bufferSource, type ByteSource } from './source.js';
import type { FormatScan, ModelFinding, ModelSeverity } from './types.js';
import { entrySource, listZip, type ZipEntry } from './zip.js';

/** 单个脚本读取上限（与组件扫描的文本文件上限一致）。 */
export const SCRIPT_MAX_BYTES = 2 * 1024 * 1024;
/** 每个文件每条规则最多记录的命中数，到了就不再往下找。 */
export const MAX_HITS_PER_RULE = 50;
/** 一个宏工程里所有模块解压输出的总预算，到了就停。 */
export const OVBA_MAX_OUT = 2 * 1024 * 1024;
/** 老式 .xls/.doc（OLE 复合文档）读取上限：宏工程在文件里，按整个文件找。 */
export const LEGACY_OFFICE_MAX_BYTES = 16 * 1024 * 1024;

const SCRIPT_EXT: Array<[RegExp, ScriptLang]> = [
  [/\.pyw?$/i, 'python'],
  [/\.(?:js|mjs|cjs)$/i, 'javascript'],
  [/\.(?:ts|mts|cts)$/i, 'typescript'],
  [/\.(?:sh|bash)$/i, 'shell'],
  [/\.ps1$/i, 'powershell'],
  [/\.(?:bat|cmd)$/i, 'batch'],
  [/\.vbs$/i, 'vbscript'],
  [/\.(?:bas|vba)$/i, 'vba'],
];
/**
 * 带宏的 Office 文档：.xlsm/.docm/.pptm/.xlam/.dotm 是 ZIP，宏在 vbaProject.bin 里；
 * 老式 .xls/.doc 是 OLE 复合文档，宏工程直接在文件里。
 */
export const OFFICE_MACRO_FILE = /\.(?:xlsm|docm|pptm|xlam|dotm|xls|doc)$/i;
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export function scriptLangOf(fileName: string): ScriptLang | null {
  return SCRIPT_EXT.find(([re]) => re.test(fileName))?.[1] ?? null;
}
export function isScriptFile(fileName: string): boolean {
  return scriptLangOf(fileName) !== null;
}

const SEV_RANK: Record<ModelSeverity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

interface Hit {
  ruleId: string;
  severity: ModelSeverity;
  title: string;
  line: number;
  excerpt: string;
}

/** 文本解码：按 BOM 认 UTF-16LE（PowerShell 常见）、UTF-16BE，其余按 UTF-8。 */
export function decodeText(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const le = Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1)));
    return le.swap16().toString('utf16le');
  }
  return b.toString('utf8').replace(/^﻿/, '');
}

/** VBA 注释（' 或 Rem 开头的行）替换为空行，保留行号。 */
function stripVbaComments(text: string): string {
  return text
    .split('\n')
    .map((l) => (/^\s*(?:'|rem\b)/i.test(l) ? '' : l))
    .join('\n');
}

function patternHits(text: string, lang: ScriptLang): Hit[] {
  const out: Hit[] = [];
  const body = lang === 'vba' || lang === 'vbscript' ? stripVbaComments(text) : text;
  const lines = lineIndex(body);
  for (const r of SCRIPT_PATTERN_RULES) {
    if (!r.langs.includes(lang)) continue;
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`);
    let found = 0;
    for (const m of body.matchAll(re)) {
      const severity = r.severityOf ? r.severityOf(m) : r.severity;
      if (!severity) continue;
      const line = lines.lineAt(m.index ?? 0);
      out.push({
        ruleId: r.id,
        severity,
        title: r.title,
        line,
        excerpt: lines.lineText(line).trim().slice(0, 300),
      });
      if (++found >= MAX_HITS_PER_RULE) break;
    }
  }
  if (
    out.some((h) => h.ruleId === 'vba.auto_exec') &&
    out.some((h) => AUTO_EXEC_PAYLOAD_PARTS.includes(h.ruleId))
  ) {
    const entry = out.find((h) => h.ruleId === 'vba.auto_exec')!;
    const payload = out.find((h) => AUTO_EXEC_PAYLOAD_PARTS.includes(h.ruleId))!;
    out.push({
      ruleId: AUTO_EXEC_PAYLOAD.id,
      severity: AUTO_EXEC_PAYLOAD.severity,
      title: AUTO_EXEC_PAYLOAD.title,
      line: entry.line,
      excerpt: `入口：${entry.excerpt}；调用：${payload.excerpt}`,
    });
  }
  return out;
}

/** 复用组件扫描的代码规则（命令执行、下载即执行、混淆、外传等），按 ai-asset 的语言划分。 */
function codeRuleHits(path: string, text: string): Hit[] {
  const lang = langOf(path);
  return detectCodeRisks([{ path, content: text, lang }], {
    maxHitsPerRule: MAX_HITS_PER_RULE,
  }).flatMap((h) => {
    const def = aiAssetRule(h.ruleId);
    if (!def) return [];
    return [
      {
        ruleId: def.ruleId,
        severity: h.severity ?? def.severity,
        title: def.title,
        line: h.line,
        excerpt: h.excerpt,
      },
    ];
  });
}

/** 同一文件同一规则合并为一条问题，证据列出前几处命中行。 */
function toFindings(hits: Hit[], label: string, format?: ScriptLang): ModelFinding[] {
  const groups = new Map<string, { list: Hit[]; lines: Set<number> }>();
  for (const h of hits) {
    const g = groups.get(h.ruleId) ?? { list: [], lines: new Set<number>() };
    if (!g.lines.has(h.line)) {
      g.lines.add(h.line);
      g.list.push(h);
    }
    groups.set(h.ruleId, g);
  }
  return [...groups.values()].map(({ list }) => {
    list.sort((a, b) => a.line - b.line);
    const worst = list.reduce((a, b) => (SEV_RANK[b.severity] > SEV_RANK[a.severity] ? b : a));
    const shown = list
      .slice(0, 5)
      .map((h) => `第 ${h.line} 行：${h.excerpt}`)
      .join('；');
    const more =
      list.length >= MAX_HITS_PER_RULE
        ? `（至少 ${list.length} 处）`
        : list.length > 5
          ? `（共 ${list.length} 处）`
          : '';
    return {
      ruleId: list[0]!.ruleId,
      severity: worst.severity,
      title: list[0]!.title,
      detail: `${label ? `${label}: ` : ''}${shown}${more}`.slice(0, 3900),
      ...(format ? { format } : {}),
    };
  });
}

/** 检查一段脚本文本。label 为压缩包内条目名（顶层文件传空串）；format 用于压缩包内命中标出语言。 */
export function scanScriptText(
  path: string,
  text: string,
  lang: ScriptLang,
  label = '',
  format?: ScriptLang,
): ModelFinding[] {
  const usesCodeRules =
    lang === 'python' ||
    lang === 'javascript' ||
    lang === 'typescript' ||
    lang === 'shell' ||
    lang === 'powershell' ||
    lang === 'batch';
  const hits = [...(usesCodeRules ? codeRuleHits(path, text) : []), ...patternHits(text, lang)];
  return toFindings(hits, label, format);
}

export async function scanScriptFile(fileName: string, src: ByteSource): Promise<FormatScan> {
  const lang = scriptLangOf(fileName)!;
  const findings: ModelFinding[] = [];
  const text = decodeText(await src.read(0, Math.min(src.size, SCRIPT_MAX_BYTES)));
  if (src.size > SCRIPT_MAX_BYTES)
    findings.push({
      ruleId: 'SCRIPT_TRUNCATED',
      severity: 'LOW',
      title: '脚本过大，仅检查了开头部分',
      detail: `${baseName(fileName)} 超过 ${SCRIPT_MAX_BYTES / 1024 / 1024} MiB`,
    });
  findings.push(...scanScriptText(fileName, text, lang));
  return { format: lang, findings, meta: { scriptLang: lang, lines: text.split('\n').length } };
}

export interface OvbaResult {
  data: Buffer;
  /** 消耗到的位置：下一个压缩容器从这里之后找 */
  end: number;
  /** 因输出预算停下 */
  truncated: boolean;
}

/**
 * MS-OVBA 解压（[MS-OVBA] 2.4.1）：从 offset 处的压缩容器（0x01 签名）开始，逐块解压，
 * 每块输出不超过 4096 字节，总输出不超过 maxOut；遇到无效块头或数据不足时停止，返回已解出的部分。
 */
export function decompressOvba(buf: Buffer, offset: number, maxOut = SCRIPT_MAX_BYTES): OvbaResult {
  if (buf[offset] !== 0x01 || maxOut <= 0)
    return { data: Buffer.alloc(0), end: offset + 1, truncated: maxOut <= 0 };
  // 每块至少 3 字节输入、至多 4096 字节输出，按此预分配
  const cap = Math.min(maxOut, Math.ceil((buf.length - offset) / 3) * 4096);
  const out = Buffer.allocUnsafe(cap);
  let n = 0;
  let p = offset + 1;
  let truncated = false;
  outer: while (p + 2 <= buf.length) {
    if (n >= cap) {
      truncated = true;
      break;
    }
    const header = buf.readUInt16LE(p);
    if (((header >> 12) & 0x7) !== 0b011) break;
    const chunkEnd = Math.min(buf.length, p + (header & 0x0fff) + 3);
    const compressed = (header & 0x8000) !== 0;
    p += 2;
    const chunkStart = n;
    const chunkCap = Math.min(cap, chunkStart + 4096);
    if (!compressed) {
      const take = Math.min(4096, buf.length - p, chunkCap - n);
      buf.copy(out, n, p, p + take);
      n += take;
      p = Math.min(buf.length, p + 4096);
      continue;
    }
    while (p < chunkEnd) {
      const flags = buf[p++]!;
      for (let bit = 0; bit < 8 && p < chunkEnd; bit++) {
        if (n >= chunkCap) {
          if (n >= cap) {
            truncated = true;
            break outer;
          }
          break; // 本块已满 4096 字节，余下的记号丢弃
        }
        if ((flags & (1 << bit)) === 0) {
          out[n++] = buf[p++]!;
          continue;
        }
        if (p + 2 > chunkEnd) break outer;
        const token = buf.readUInt16LE(p);
        p += 2;
        const diff = n - chunkStart;
        let bitCount = 4;
        while (1 << bitCount < diff && bitCount < 12) bitCount++;
        const lengthMask = 0xffff >> bitCount;
        const length = (token & lengthMask) + 3;
        const distance = (token >> (16 - bitCount)) + 1;
        const from = n - distance;
        if (from < chunkStart) break outer;
        const len = Math.min(length, chunkCap - n);
        for (let i = 0; i < len; i++) out[n++] = out[from + i]!;
      }
      if (n >= chunkCap) break;
    }
    p = chunkEnd;
  }
  return { data: Buffer.from(out.subarray(0, n)), end: p, truncated };
}

export interface VbaText {
  text: string;
  /** 解压输出到了预算，后面的模块没有解出来 */
  truncated: boolean;
}

/**
 * 从宏工程（vbaProject.bin，或整个老式 .xls/.doc）取宏文本，不做完整 OLE 解析：
 * 1. 找模块源码的压缩容器（源码都以 “Attribute VB_Name” 开头，压缩后为 0x01 + 块头 + 0x00 + “Attribut”），
 *    逐个解压；解完一个从它消耗到的位置往后找下一个，所有模块共享 2 MiB 输出预算；
 * 2. withStrings 时再补上原始字节里的可打印字符串（标识符表、未压缩的片段）。
 *    老式文档整文件都是正文，不补，免得正文里的字样被当成宏。
 */
export function extractVbaTextInfo(bin: Buffer, withStrings = true): VbaText {
  const parts: string[] = [];
  const marker = Buffer.from('\x00Attribut', 'latin1');
  let budget = OVBA_MAX_OUT;
  let truncated = false;
  let next = 0;
  for (let i = bin.indexOf(marker); i >= 0 && parts.length < 200; i = bin.indexOf(marker, next)) {
    next = i + 1;
    if (i < 3 || bin[i - 3] !== 0x01) continue;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const r = decompressOvba(bin, i - 3, budget);
    parts.push(r.data.toString('latin1'));
    budget -= r.data.length;
    if (r.truncated) truncated = true;
    next = Math.max(next, r.end);
  }
  if (withStrings)
    parts.push((bin.toString('latin1').match(/[\x20-\x7e\t]{6,}/g) ?? []).join('\n'));
  return {
    text: parts
      .join('\n')
      .replace(/\r\n?/g, '\n')
      .slice(0, 4 * SCRIPT_MAX_BYTES),
    truncated,
  };
}

export function extractVbaText(bin: Buffer): string {
  return extractVbaTextInfo(bin).text;
}

export const VBA_PROJECT_ENTRY = /(?:^|\/)vbaProject\.bin$/i;

async function readEntry(src: ByteSource, e: ZipEntry, max: number): Promise<Buffer> {
  const s = await entrySource(src, e, max);
  return s.read(0, Math.min(s.size, max));
}

function vbaFindings(name: string, vba: VbaText): ModelFinding[] {
  const findings = scanScriptText(name, vba.text, 'vba', name, 'vba');
  if (vba.truncated)
    findings.push({
      ruleId: 'SCRIPT_TRUNCATED',
      severity: 'LOW',
      title: '脚本过大，仅检查了开头部分',
      detail: `${name}: 宏代码解压超过 ${OVBA_MAX_OUT / 1024 / 1024} MiB，其余模块未检查`,
    });
  return findings;
}

/** 压缩包里的宏工程：提取文本后按 VBA 规则检查，命中标为 VBA。 */
export async function scanVbaEntry(src: ByteSource, e: ZipEntry): Promise<ModelFinding[]> {
  return vbaFindings(e.name, extractVbaTextInfo(await readEntry(src, e, 4 * SCRIPT_MAX_BYTES)));
}

/** 带宏的 Office 文档：ZIP 格式读其中的 vbaProject.bin；老式 OLE 格式（.xls/.doc）对整个文件找宏模块。 */
export async function scanOfficeMacro(src: ByteSource, fileName = ''): Promise<FormatScan> {
  const findings: ModelFinding[] = [];
  let entries: ZipEntry[] = [];
  const head = await src.read(0, 8);
  if (head.length === 8 && head.equals(OLE_MAGIC)) {
    const name = fileName.split(/[\\/]/).pop() || 'OLE 文档';
    const vba = extractVbaTextInfo(
      await src.read(0, Math.min(src.size, LEGACY_OFFICE_MAX_BYTES)),
      false,
    );
    findings.push(...vbaFindings(name, vba));
    if (src.size > LEGACY_OFFICE_MAX_BYTES)
      findings.push({
        ruleId: 'SCRIPT_TRUNCATED',
        severity: 'LOW',
        title: '脚本过大，仅检查了开头部分',
        detail: `${name} 超过 ${LEGACY_OFFICE_MAX_BYTES / 1024 / 1024} MiB，只在开头部分找了宏`,
      });
    return {
      format: 'office-macro',
      findings,
      meta: { legacyOffice: true, macroModules: vba.text ? true : false },
    };
  }
  try {
    entries = await listZip(src);
    for (const e of entries.filter((x) => VBA_PROJECT_ENTRY.test(x.name)))
      findings.push(...(await scanVbaEntry(src, e)));
  } catch (err) {
    findings.push({
      ruleId: 'OFFICE_PARSE_ABORTED',
      severity: 'MEDIUM',
      title: 'Office 文档解析中止',
      detail: `解析中止：${err instanceof Error ? err.message : '未知错误'}`,
    });
  }
  return {
    format: 'office-macro',
    findings,
    meta: {
      macroProjects: entries.filter((x) => VBA_PROJECT_ENTRY.test(x.name)).map((x) => x.name),
    },
  };
}

/** 压缩包里的 Office 宏文档：整个读入（调用方已按预算限制大小）后按文档扫描，问题前面带上条目名。 */
export async function scanArchivedOffice(src: ByteSource, e: ZipEntry): Promise<ModelFinding[]> {
  const doc = await readEntry(src, e, e.size);
  const r = await scanOfficeMacro(bufferSource(doc), e.name);
  return r.findings.map((f) => ({ ...f, detail: `${e.name}: ${f.detail}` }));
}

/** 压缩包（PyTorch 归档、torch.package、.zip）内的脚本：按扩展名识别语言后检查，命中带上条目名和语言。 */
export async function scanArchivedScript(src: ByteSource, e: ZipEntry): Promise<ModelFinding[]> {
  const lang = scriptLangOf(e.name)!;
  const text = decodeText(await readEntry(src, e, SCRIPT_MAX_BYTES));
  return scanScriptText(e.name, text, lang, e.name, lang);
}

interface AutoMapRef {
  key: string;
  value: string;
  module: string;
  remote: boolean;
}

/**
 * auto_map 指向的本地 .py 与配置关联：在被指向的脚本 meta 里记 autoMapFrom，
 * 在配置的 config.auto_map 问题里写明哪些已纳入扫描、哪些没找到。
 */
export function linkAutoMap<T extends FormatScan & { path: string }>(files: T[]): T[] {
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  const byPath = new Map(files.map((f) => [f.path, f]));
  const referencedBy = new Map<string, string[]>();
  const notes = new Map<string, { found: string[]; missing: string[] }>();
  for (const f of files) {
    const refs = (f.meta.autoMap as AutoMapRef[] | undefined)?.filter((r) => !r.remote) ?? [];
    if (!refs.length) continue;
    const found = new Set<string>();
    const missing = new Set<string>();
    for (const r of refs) {
      const rel = `${r.module.replace(/\./g, '/')}.py`;
      const target = `${dirOf(f.path)}${rel}`;
      if (byPath.has(target)) {
        found.add(rel);
        referencedBy.set(target, [...new Set([...(referencedBy.get(target) ?? []), f.path])]);
      } else missing.add(rel);
    }
    notes.set(f.path, { found: [...found], missing: [...missing] });
  }
  if (!notes.size) return files;
  return files.map((f) => {
    const note = notes.get(f.path);
    const from = referencedBy.get(f.path);
    if (!note && !from) return f;
    const findings = note
      ? f.findings.map((x) =>
          x.ruleId === 'config.auto_map'
            ? {
                ...x,
                detail: [
                  x.detail,
                  note.found.length ? `已纳入扫描：${note.found.join('、')}` : '',
                  note.missing.length ? `未在扫描范围内找到：${note.missing.join('、')}` : '',
                ]
                  .filter(Boolean)
                  .join('；'),
              }
            : x,
        )
      : f.findings;
    return { ...f, findings, meta: from ? { ...f.meta, autoMapFrom: from } : f.meta };
  });
}
