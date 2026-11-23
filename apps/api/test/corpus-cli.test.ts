import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { runCorpusScan } from '../src/modules/corpus-scans/executor.js';
import { buildCorpusKeywordsJson } from '../scripts/export-corpus-keywords.js';

// 命令行版（tools/corpus-scan）：用 node --experimental-strip-types 直接跑，统计与服务端一致；
// 打包脚本产出的 tar 包内含 README、关键词 JSON、cli 和 core。

const run = promisify(execFile);
const REPO = resolve(process.cwd(), '../..');
const CLI = join(REPO, 'tools/corpus-scan/cli.ts');
const P = '__p2g_cli_';
const ID = '110101199003071233';

let app: Awaited<ReturnType<typeof buildApp>>;
let work = '';
let adminToken = '';
let keywordsFile = '';
let rulesFile = '';
let sample = '';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prismaUnscoped.corpusScan.deleteMany({ where: { fileName: { startsWith: P } } });
  await prismaUnscoped.corpusRuleSet.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.auditLog.deleteMany({ where: { action: { startsWith: 'corpus_' } } });
}

async function cli(args: string[]) {
  return run(process.execPath, ['--experimental-strip-types', '--no-warnings', ...args], {
    cwd: work,
    maxBuffer: 64 * 1024 * 1024,
  });
}

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'p2g-cli-'));
  process.env.CORPUS_STORAGE_DIR = join(work, 'storage');
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') },
  });
  adminToken = login.json().token;

  const kw = await prisma.standardKeyword.findFirst({
    where: { tenantId: null, reviewStatus: 'approved', itemCode: 'A.2.a' },
    orderBy: { term: 'asc' },
  });
  assert.ok(kw, '测试库里要有国标关键词');
  sample = [
    JSON.stringify({ instruction: `介绍一下${kw.term}`, input: '', output: '不能回答' }),
    JSON.stringify({ instruction: '登记', input: '', output: `身份证 ${ID}，电话 13800138000` }),
    '{坏行',
    JSON.stringify({ instruction: '整理内部资料', input: '', output: '项目 PRJ-001 已归档' }),
  ].join('\n');
  await writeFile(join(work, 'sample.jsonl'), sample);
  rulesFile = join(work, 'rules.csv');
  await writeFile(
    rulesFile,
    '类型,内容,类别,严重度\n关键词,内部资料,涉密,高\n正则,PRJ-\\d{3},项目代号,中\n',
  );
});

after(async () => {
  await cleanup();
  await app.close();
  await rm(work, { recursive: true, force: true });
  delete process.env.CORPUS_STORAGE_DIR;
});

test('导出关键词 JSON：平台词表加所属租户的，带条目名称', async () => {
  const scanTenant =
    (await prisma.tenant.findFirst({ where: { id: '00000000-0000-4000-8000-000000000001' } }))
      ?.id ?? null;
  const json = await buildCorpusKeywordsJson({ tenantId: scanTenant });
  assert.equal(json.format, 'lse-corpus-keywords');
  assert.equal(json.total, json.keywords.length);
  assert.ok(json.total > 3000);
  assert.equal(json.items['A.1.a'], '煽动颠覆国家政权、推翻社会主义制度');
  keywordsFile = join(work, 'keywords.json');
  await writeFile(keywordsFile, JSON.stringify(json));
});

test('命令行版扫样例文件：输出 JSON 的统计和服务端一致，命中原文不打码', async () => {
  assert.ok(keywordsFile, '先导出关键词');
  // 服务端：同样的文件、同样的规则
  const set = await app.inject({
    method: 'POST',
    url: '/api/corpus-rules/sets',
    headers: bearer(adminToken),
    payload: { name: `${P}规则` },
  });
  const imp = await app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${set.json().id}/import?format=csv`,
    headers: { ...bearer(adminToken), 'content-type': 'application/octet-stream' },
    payload: await readFile(rulesFile),
  });
  assert.equal(imp.json().added, 2, imp.body);
  const res = await app.inject({
    method: 'POST',
    url: `/api/corpus-scans?fileName=${encodeURIComponent(`${P}sample.jsonl`)}&ruleSetId=${set.json().id}`,
    headers: { ...bearer(adminToken), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(sample),
  });
  assert.equal(res.statusCode, 201, res.body);
  await runCorpusScan(res.json().id);
  const server = await prisma.corpusScan.findUniqueOrThrow({ where: { id: res.json().id } });
  assert.equal(server.status, 'COMPLETED', server.error ?? '');

  const out = join(work, 'report.json');
  const { stderr } = await cli([
    CLI,
    'sample.jsonl',
    '--keywords',
    keywordsFile,
    '--rules',
    rulesFile,
    '--out',
    out,
  ]);
  assert.match(stderr, /记录 4 条/);
  const report = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(report.stats, server.stats);
  assert.equal(report.file.sha256, server.sha256);
  assert.equal(report.file.bytes, Number(server.bytes));
  assert.ok(report.findings.some((f: { matchText: string }) => f.matchText === ID));
  assert.equal(report.findings.length, report.stats.findingCount);
});

test('命令行版：不给 --out 时报告写到标准输出；参数不对时退出码非 0', async () => {
  const { stdout } = await cli([
    CLI,
    'sample.jsonl',
    '--keywords',
    keywordsFile,
    '--format',
    'alpaca',
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.format, 'alpaca');
  assert.equal(report.stats.invalidRecords, 1);
  await assert.rejects(
    cli([CLI]),
    (e: { code?: number; stderr?: string }) => e.code !== 0 && /用法/.test(e.stderr ?? ''),
  );
  await assert.rejects(
    cli([CLI, 'sample.jsonl', '--format', 'yaml']),
    (e: { code?: number }) => e.code !== 0,
  );
});

test('打包脚本：tar 包内含 README、关键词 JSON、cli 和 core，解开就能跑', async () => {
  const outDir = join(work, 'dist');
  await run(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/pack-corpus-cli.ts',
      '--keywords',
      keywordsFile,
      '--out-dir',
      outDir,
      '--version',
      '9.9.9-test',
    ],
    { cwd: resolve(REPO, 'apps/api'), env: process.env },
  );
  const tarball = join(outDir, 'corpus-scan-cli-9.9.9-test.tar.gz');
  const { stdout: list } = await run('tar', ['-tzf', tarball]);
  const entries = list.split('\n').filter(Boolean);
  for (const name of [
    'README.md',
    'keywords.json',
    'cli.ts',
    'core/scan.ts',
    'core/formats.ts',
    'core/sensitive-rules.ts',
  ]) {
    assert.ok(
      entries.includes(`corpus-scan-cli-9.9.9-test/${name}`),
      `缺少 ${name}：${entries.join(', ')}`,
    );
  }
  const unpack = join(work, 'unpack');
  await mkdir(unpack);
  await run('tar', ['-xzf', tarball, '-C', unpack]);
  const pkg = join(unpack, 'corpus-scan-cli-9.9.9-test');
  // 包是给客户的：不带内部路径和参考产品名
  for (const name of entries.filter((e) => !e.endsWith('/'))) {
    const text = await readFile(join(unpack, name), 'utf8');
    assert.ok(!text.includes('/home/'), `${name} 里有内部路径 /home/`);
    assert.ok(!/jjdguard/i.test(text), `${name} 里有参考产品名`);
  }
  // 包里自带关键词：不给 --keywords 也会加载
  const { stdout } = await cli([join(pkg, 'cli.ts'), 'sample.jsonl', '--rules', rulesFile]);
  const report = JSON.parse(stdout);
  assert.equal(report.version, '9.9.9-test');
  const local = JSON.parse(await readFile(join(work, 'report.json'), 'utf8'));
  assert.deepEqual(report.stats, local.stats);
});
