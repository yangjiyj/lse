// 导出语料扫描命令行版用的国标关键词 JSON：平台共享词表（可选加某个租户自己的），只导生效的词；带附录 A 条目名称。
// 用法（在 apps/api 下，需要 DATABASE_URL）：
//   npx tsx scripts/export-corpus-keywords.ts --out corpus-keywords.json [--tenant <租户 ID>]
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANNEX_A_ITEMS } from '@lse/shared';
import { prisma } from '../src/db.js';
import { loadScanKeywords } from '../src/modules/corpus-scans/executor.js';

export interface CorpusKeywordsJson {
  format: 'lse-corpus-keywords';
  version: 1;
  exportedAt: string;
  total: number;
  /** 条目编码 → 名称 */
  items: Record<string, string>;
  keywords: { term: string; code: string }[];
}

export async function buildCorpusKeywordsJson(
  opts: { tenantId?: string | null } = {},
): Promise<CorpusKeywordsJson> {
  const keywords = await loadScanKeywords(opts.tenantId ?? null);
  return {
    format: 'lse-corpus-keywords',
    version: 1,
    exportedAt: new Date().toISOString(),
    total: keywords.length,
    items: Object.fromEntries(ANNEX_A_ITEMS.map((i) => [i.code, i.name])),
    keywords,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const out = resolve(arg('--out') ?? 'corpus-keywords.json');
  const json = await buildCorpusKeywordsJson({ tenantId: arg('--tenant') ?? null });
  await writeFile(out, JSON.stringify(json));
  console.log(`已导出 ${json.total} 个关键词 → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
