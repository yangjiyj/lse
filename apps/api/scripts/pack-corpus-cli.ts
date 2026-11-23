// 打包语料扫描命令行版：corpus-scan-cli-<版本>.tar.gz，内含 cli.ts、core/*.ts、keywords.json、README.md。
// 用法（在 apps/api 下）：
//   npx tsx scripts/pack-corpus-cli.ts [--keywords 词表.json] [--out-dir 输出目录] [--version 版本号]
// 不给 --keywords 时从数据库导出平台词表（需要 DATABASE_URL）；版本号默认取仓库根 package.json。
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(API, '../..');
const CORE_DIR = join(API, 'src/modules/corpus-scans/core');
const CORE_FILES = [
  'formats.ts',
  'keyword-matcher.ts',
  'sensitive-rules.ts',
  'custom-rules.ts',
  'scan.ts',
  'mask.ts',
];
const TOOL_DIR = join(REPO, 'tools/corpus-scan');
const CORE_IMPORT = '../../apps/api/src/modules/corpus-scans/core/';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function keywordsJson(path: string | undefined): Promise<string> {
  if (path) {
    const text = await readFile(resolve(path), 'utf8');
    const parsed = JSON.parse(text) as { keywords?: unknown };
    if (!Array.isArray(parsed.keywords)) throw new Error(`关键词文件里没有 keywords 数组：${path}`);
    return text;
  }
  const { buildCorpusKeywordsJson } = await import('./export-corpus-keywords.js');
  const { prisma } = await import('../src/db.js');
  try {
    return JSON.stringify(await buildCorpusKeywordsJson());
  } finally {
    await prisma.$disconnect();
  }
}

export async function packCorpusCli(opts: {
  keywords?: string;
  outDir?: string;
  version?: string;
}): Promise<string> {
  const version =
    opts.version ??
    (JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) throw new Error(`版本号不合法：${version}`);
  const name = `corpus-scan-cli-${version}`;
  const outDir = resolve(opts.outDir ?? join(REPO, 'dist/corpus-scan-cli'));
  const staging = await mkdtemp(join(tmpdir(), 'corpus-cli-pack-'));
  try {
    const pkg = join(staging, name);
    await mkdir(join(pkg, 'core'), { recursive: true });
    for (const f of CORE_FILES) await copyFile(join(CORE_DIR, f), join(pkg, 'core', f));

    let cli = await readFile(join(TOOL_DIR, 'cli.ts'), 'utf8');
    if (!cli.includes(CORE_IMPORT)) throw new Error('cli.ts 里找不到 core 的引用路径');
    cli = cli.split(CORE_IMPORT).join('./core/');
    const versionLine = "const CLI_VERSION = 'dev';";
    if (cli.split(versionLine).length !== 2) throw new Error('cli.ts 里找不到版本号占位');
    cli = cli.replace(versionLine, `const CLI_VERSION = '${version}';`);
    await writeFile(join(pkg, 'cli.ts'), cli);
    await copyFile(join(TOOL_DIR, 'README.md'), join(pkg, 'README.md'));
    await writeFile(join(pkg, 'keywords.json'), await keywordsJson(opts.keywords));

    await mkdir(outDir, { recursive: true });
    const tarball = join(outDir, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', tarball, '-C', staging, name]);
    return tarball;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packCorpusCli({
    keywords: arg('--keywords'),
    outDir: arg('--out-dir'),
    version: arg('--version'),
  })
    .then((tarball) => console.log(tarball))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    });
}
