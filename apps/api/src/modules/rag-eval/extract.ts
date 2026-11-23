import { createHash } from 'node:crypto';

/** 知识库文档支持的格式。 */
export const RAG_DOCUMENT_FORMATS = ['txt', 'md', 'pdf', 'docx'] as const;
export type RagDocumentFormat = (typeof RAG_DOCUMENT_FORMATS)[number];

/** 单个文档体量上限：沿用现有 base64 上传接口的 16MB 请求体上限，解码后原文件不超过 10MB。 */
export const RAG_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** 抽取后的文本上限（字符），防止超大文档撑爆切块与生成。 */
export const RAG_DOCUMENT_MAX_CHARS = 2_000_000;

export class RagExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagExtractError';
  }
}

export function detectFormat(filename: string): RagDocumentFormat | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'markdown') return 'md';
  return (RAG_DOCUMENT_FORMATS as readonly string[]).includes(ext)
    ? (ext as RagDocumentFormat)
    : null;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdf(buffer: Buffer): Promise<string> {
  // unpdf 内置 pdf.js 的无 worker 服务端构建（纯 JS，无原生依赖，可随离线包分发）。
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).join('\n\n');
  } finally {
    await pdf.cleanup?.();
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

function decodeUtf8Strict(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new RagExtractError('文本文件需为 UTF-8 编码');
  }
}

/** 从上传文件中抽取纯文本；失败时抛 RagExtractError（路由层转 400）。 */
export async function extractDocumentText(
  buffer: Buffer,
  format: RagDocumentFormat,
): Promise<string> {
  if (buffer.length === 0) throw new RagExtractError('文件内容为空');
  if (buffer.length > RAG_DOCUMENT_MAX_BYTES) {
    throw new RagExtractError(`文件超过 ${RAG_DOCUMENT_MAX_BYTES / 1024 / 1024}MB 上限`);
  }
  let raw: string;
  try {
    if (format === 'pdf') raw = await extractPdf(buffer);
    else if (format === 'docx') raw = await extractDocx(buffer);
    else raw = decodeUtf8Strict(buffer);
  } catch (err) {
    if (err instanceof RagExtractError) throw err;
    throw new RagExtractError(`文档解析失败：${(err as Error).message}`);
  }
  const text = normalizeText(raw);
  if (!text) {
    throw new RagExtractError(
      format === 'pdf'
        ? '未从 PDF 中提取到文本（可能为扫描件，平台不做 OCR）'
        : '文档中没有可用文本',
    );
  }
  if (text.length > RAG_DOCUMENT_MAX_CHARS) {
    throw new RagExtractError(`文档文本超过 ${RAG_DOCUMENT_MAX_CHARS} 字符上限`);
  }
  return text;
}

export interface TextChunk {
  seq: number;
  content: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  /** 目标块长（字符），默认 600。 */
  size?: number;
  /** 相邻块重叠（字符），默认 80。 */
  overlap?: number;
}

const BREAK_CHARS = ['\n\n', '\n', '。', '！', '？', '. ', '；', ';', '，', ', ', ' '];

/**
 * 按段落/句末优先切块：在 [size*0.6, size] 区间内寻找最靠后的自然断点，找不到则硬切。
 * 记录每块在原文中的字符区间，便于追溯来源。
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const size = Math.max(100, opts.size ?? 600);
  const overlap = Math.min(Math.max(0, opts.overlap ?? 80), Math.floor(size / 2));
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const minEnd = start + Math.floor(size * 0.6);
      let best = -1;
      for (const br of BREAK_CHARS) {
        const idx = text.lastIndexOf(br, end - br.length);
        if (idx >= minEnd) {
          best = idx + br.length;
          break;
        }
      }
      if (best > start) end = best;
    }
    const slice = text.slice(start, end);
    const trimmedLead = slice.length - slice.trimStart().length;
    const content = slice.trim();
    if (content) {
      chunks.push({
        seq: chunks.length,
        content,
        charStart: start + trimmedLead,
        charEnd: start + trimmedLead + content.length,
      });
    }
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
