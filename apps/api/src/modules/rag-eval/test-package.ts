import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { makeRng } from '../generator/core/prng.js';
import { POISON_DOCUMENT_FILENAME, SENTINEL_DOCUMENT_FILENAME } from './security.js';

/** 测试知识库包格式版本。 */
export const RAG_TEST_PACKAGE_FORMAT = 'lse-rag-test-package/v1';

export type PackageDocRole = 'corpus' | 'poison' | 'sentinel';

export interface PackageDocument {
  /** 清单文档 ID（被测系统引用时可回填此 ID，平台据此映射来源）。 */
  manifestId: string;
  role: PackageDocRole;
  /** 包内文件名。 */
  filename: string;
  /** 平台原始文件名（corpus 文档）。 */
  originalFilename: string | null;
  /** 平台文档 ID（corpus 文档）。 */
  sourceDocumentId: string | null;
  /** 平台原始文件 SHA-256（corpus 文档）。 */
  sourceSha256: string | null;
  /** 包内文件内容的 SHA-256。 */
  sha256: string;
  /** 唯一探针短语：用于“索引就绪探测”。 */
  probe: string;
  /** 应导入的知识库：test=测试知识库，restricted=测试身份无权访问的受限库。 */
  knowledgeBase: 'test' | 'restricted';
  content: string;
}

export interface PackageSourceDoc {
  id: string;
  filename: string;
  sha256: string;
  chunks: Array<{ seq: number; content: string; charStart: number; charEnd: number }>;
}

export interface TestPackage {
  documents: PackageDocument[];
  manifest: Record<string, unknown>;
}

function token(seed: string, label: string, len = 10): string {
  const rng = makeRng(`${seed}|${label}`);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[rng.int(alphabet.length)];
  return out;
}

export function probeToken(seed: string, key: string): string {
  return `LSE-PROBE-${token(seed, `probe|${key}`, 10)}`;
}

export function probeLine(probe: string): string {
  return `LSE 索引探针编号：${probe}（平台自动添加，用于确认本文档已完成索引，请勿删除）`;
}

/** 按切块偏移还原文档文本（切块有重叠，按 charStart/charEnd 拼接；间隙补换行）。 */
export function reconstructText(chunks: PackageSourceDoc['chunks']): string {
  const sorted = [...chunks].sort((a, b) => a.seq - b.seq);
  let out = '';
  let pos = 0;
  for (const c of sorted) {
    if (c.charEnd <= pos) continue;
    if (c.charStart > pos) {
      if (out) out += '\n\n';
      out += c.content;
    } else {
      out += c.content.slice(pos - c.charStart);
    }
    pos = c.charEnd;
  }
  return out;
}

function safeName(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
  return base || 'document';
}

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 已有投毒/哨兵文档的探针：新模板内含 LSE-PROBE-，旧模板回退产品型号（文档内唯一）。 */
export function securityDocProbe(doc: string): string | null {
  return doc.match(/LSE-PROBE-[A-Z0-9]+/)?.[0] ?? doc.match(/QX-[A-Z0-9]{4}/)?.[0] ?? null;
}

/**
 * 生成测试知识库包：平台语料（按切块还原的文本 + 探针行）+ 投毒文档 + 越权哨兵文档，
 * 清单含文档 ID、文件名、哈希、探针与应导入的知识库。同一测试集种子得到同一包，便于复现。
 */
export function buildTestPackage(
  set: { id: string; name: string; seed: string; poisonDocument: string; sentinelDocument: string },
  docs: PackageSourceDoc[],
  opts: { includeSecurity: boolean },
): TestPackage {
  const documents: PackageDocument[] = [];
  for (const d of [...docs].sort((a, b) => a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id))) {
    const manifestId = `lse-doc-${d.id.replace(/-/g, '').slice(0, 12)}`;
    const probe = probeToken(set.seed, d.id);
    const content = `${probeLine(probe)}\n\n${reconstructText(d.chunks)}\n`;
    documents.push({
      manifestId,
      role: 'corpus',
      filename: `${manifestId}__${safeName(d.filename)}.md`,
      originalFilename: d.filename,
      sourceDocumentId: d.id,
      sourceSha256: d.sha256,
      sha256: sha(content),
      probe,
      knowledgeBase: 'test',
      content,
    });
  }
  if (opts.includeSecurity) {
    const pp = securityDocProbe(set.poisonDocument);
    documents.push({
      manifestId: 'lse-poison',
      role: 'poison',
      filename: POISON_DOCUMENT_FILENAME,
      originalFilename: null,
      sourceDocumentId: null,
      sourceSha256: null,
      sha256: sha(set.poisonDocument),
      probe: pp ?? '',
      knowledgeBase: 'test',
      content: set.poisonDocument,
    });
    documents.push({
      manifestId: 'lse-sentinel',
      role: 'sentinel',
      filename: SENTINEL_DOCUMENT_FILENAME,
      originalFilename: null,
      sourceDocumentId: null,
      sourceSha256: null,
      sha256: sha(set.sentinelDocument),
      probe: '',
      knowledgeBase: 'restricted',
      content: set.sentinelDocument,
    });
  }
  const manifest = {
    format: RAG_TEST_PACKAGE_FORMAT,
    testSetId: set.id,
    testSetName: set.name,
    seed: set.seed,
    instructions: [
      '1. 把 role=corpus 与 role=poison 的文档导入被测系统的测试知识库（knowledgeBase=test）。',
      '2. 把 role=sentinel 的文档导入当前测试身份无权访问的受限知识库/其他租户（knowledgeBase=restricted）。',
      '3. 被测系统返回引用时，建议把 manifestId 或包内文件名作为文档标识，平台据此判定引用是否准确。',
      '4. 平台运行前会用 probe 探针短语提问确认索引就绪；测试结束后请删除这些文档。',
    ],
    documents: documents.map(({ content: _c, ...rest }) => rest),
  };
  return { documents, manifest };
}

export function zipTestPackage(pkg: TestPackage): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(pkg.manifest, null, 2)),
  };
  for (const d of pkg.documents) {
    const dir = d.knowledgeBase === 'restricted' ? 'restricted' : 'documents';
    files[`${dir}/${d.filename}`] = strToU8(d.content);
  }
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}
