import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { BUILTIN_PROBE_TOOL_CODE, TOOL_TASK_ENTRY_KEYS } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prismaUnscoped as db } from '../src/db.js';
import { DATA_SECURITY_SETTING_KEY } from '../src/lib/data-security.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { DOCX_CONTENT_TYPE } from '../src/modules/reports/docx/docx-kit.js';
import { ENTRY_GUIDE_STEPS } from '../src/modules/detect-schemes/guide-steps.js';
import { GUIDE_NOTICES, buildSchemeGuideDocx } from '../src/modules/detect-schemes/guide-docx.js';
import { latestPerPlatform } from '../src/modules/detect-schemes/routes.js';
import {
  bearer,
  cleanupSchemeTenants,
  createUser,
  ledgerAsset,
  loginAs,
  setupSchemeTenants,
  type SchemeFixture,
} from './helpers/scheme-fixtures.js';

// 2.8.3 作业指导书（Word）与配套工具清单：内容、停用项、水印、转义、审计和下载分类、工具可见性、内置探针版本、租户隔离。

const TENANT_PREFIX = 'C6指导书测试';
const USER_PREFIX = '__c6_guide_';
const TOOL_PREFIX = 'c6-guide-';
const PLATFORM_NAME = 'C6平台方案';
const REV = 'c6rev01';
const NO_TOOL_ROLE = `${USER_PREFIX}no_tool_role`;

let app: Awaited<ReturnType<typeof buildApp>>;
let f: SchemeFixture;
let platformAdmin = '';
let platformOperator = '';
let kitDir = '';
let previousKitDir: string | undefined;
let previousDataSecurity: unknown;
let schemeId = '';
let platformSchemeId = '';
let probeName = '';

interface Item {
  id: string;
  entryKey: string;
  title: string;
}

function call(method: string, token: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url: `/api/detect-schemes${url}`,
    headers: { ...bearer(token), 'user-agent': 'c6-guide-agent' },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

function docxFiles(body: Buffer): Record<string, string> {
  const files = unzipSync(new Uint8Array(body));
  return Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => name.endsWith('.xml'))
      .map(([name, data]) => [name, new TextDecoder().decode(data)]),
  );
}

/** Word XML 里的文字（w:t），反转义成纯文本。 */
function wordText(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((m) => m[1] ?? '')
    .join('')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function setDownloadWatermark(on: boolean): Promise<void> {
  const value = { maskSensitive: true, downloadWatermark: on, pageWatermark: true };
  await db.systemSetting.upsert({
    where: { key: DATA_SECURITY_SETTING_KEY },
    create: { key: DATA_SECURITY_SETTING_KEY, value },
    update: { value },
  });
}

async function tool(code: string, data: Record<string, unknown>, version?: string) {
  return db.tool.create({
    data: {
      code: `${TOOL_PREFIX}${code}`,
      category: 'data',
      ...data,
      ...(version
        ? {
            versions: {
              create: {
                version,
                os: 'linux',
                arch: 'amd64',
                filename: `${code}-${version}.tar.gz`,
                size: BigInt(2048),
                sha256: 'a'.repeat(64),
                storageKey: randomUUID(),
              },
            },
          }
        : {}),
    } as never,
  });
}

async function cleanupPlatform(): Promise<void> {
  await db.detectScheme.deleteMany({
    where: { tenantId: PLATFORM_TENANT_ID, name: { startsWith: PLATFORM_NAME } },
  });
  await db.ledgerAsset.deleteMany({
    where: { tenantId: PLATFORM_TENANT_ID, name: { startsWith: 'C6平台' } },
  });
  await db.tool.deleteMany({ where: { code: { startsWith: TOOL_PREFIX } } });
}

before(async () => {
  previousKitDir = process.env.FLEET_KIT_DIR;
  kitDir = mkdtempSync(join(tmpdir(), 'c6-kits-'));
  writeFileSync(
    join(kitDir, 'catalog.json'),
    JSON.stringify({
      source_revision: REV,
      items: [
        {
          target: 'linux-amd64',
          os: 'linux',
          arch: 'amd64',
          version: REV,
          filename: 'linux-amd64.tar.gz',
          sha256: createHash('sha256').update('kit').digest('hex'),
          bytes: 3,
          manifest_sha256: 'c'.repeat(64),
        },
      ],
    }),
  );
  process.env.FLEET_KIT_DIR = kitDir;
  previousDataSecurity = (
    await db.systemSetting.findUnique({ where: { key: DATA_SECURITY_SETTING_KEY } })
  )?.value;
  await setDownloadWatermark(false);

  app = await buildApp();
  await app.ready();
  await cleanupPlatform();
  f = await setupSchemeTenants(app, TENANT_PREFIX, USER_PREFIX, 'c6-guide');
  await db.user.deleteMany({ where: { username: `${USER_PREFIX}platform_op` } });
  await createUser(PLATFORM_TENANT_ID, `${USER_PREFIX}platform_op`, 'operator');
  platformOperator = await loginAs(app, `${USER_PREFIX}platform_op`);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') },
  });
  platformAdmin = login.json().token;

  const probe = await db.tool.findUniqueOrThrow({ where: { code: BUILTIN_PROBE_TOOL_CODE } });
  assert.equal(probe.taskEntry, 'fleet-onboard');
  assert.ok(probe.enabled && !probe.hidden, '内置探针应启用且不隐藏');
  probeName = probe.name;
  await tool(
    'scanner',
    {
      name: 'C6语料扫描器',
      taskEntry: 'corpus-scan',
      instructions: '第一步：解压工具包\r\n\r\n第二步：执行 corpus-cli scan <文件>',
    },
    '1.2.0',
  );
  await tool('hidden', { name: 'C6隐藏工具', taskEntry: 'corpus-scan', hidden: true }, '0.9.0');
  await tool('off', { name: 'C6停用工具', taskEntry: 'corpus-scan', enabled: false }, '0.1.0');

  const model = await ledgerAsset(f.tenantA, {
    type: 'model',
    name: 'C6模型<script>alert(1)</script>',
    code: 'M-001',
    ownerName: '王五',
    attrs: { modelName: 'qwen2.5-72b', version: 'v2' },
  });
  const server = await ledgerAsset(f.tenantA, {
    type: 'server',
    name: 'C6服务器',
    attrs: { ip: '10.30.0.8', os: 'Ubuntu 22.04' },
  });
  const created = await call('POST', f.adminA, '', {
    name: 'C6方案<script>x</script>',
    requirement: {
      objective: '指导书测试',
      categories: ['model', 'data', 'app_env'],
      assetIds: [model.id, server.id],
      plannedStart: '2026-12-01',
      plannedEnd: '2026-12-05',
      contactName: '赵六',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  schemeId = created.json().id;
  assert.equal((await call('POST', f.adminA, `/${schemeId}/generate`)).statusCode, 200);

  const platformServer = await ledgerAsset(PLATFORM_TENANT_ID, {
    type: 'server',
    name: 'C6平台服务器',
    attrs: { ip: '10.31.0.8' },
  });
  const platformModel = await ledgerAsset(PLATFORM_TENANT_ID, {
    type: 'model',
    name: 'C6平台模型',
  });
  const p = await call('POST', platformAdmin, '', {
    name: PLATFORM_NAME,
    requirement: {
      objective: '工具可见性',
      categories: ['data', 'app_env'],
      assetIds: [platformServer.id, platformModel.id],
    },
  });
  assert.equal(p.statusCode, 201, p.body);
  platformSchemeId = p.json().id;
  assert.equal(
    (await call('POST', platformAdmin, `/${platformSchemeId}/generate`)).statusCode,
    200,
  );
});

after(async () => {
  if (previousDataSecurity === undefined) {
    await db.systemSetting.deleteMany({ where: { key: DATA_SECURITY_SETTING_KEY } });
  } else {
    await db.systemSetting.update({
      where: { key: DATA_SECURITY_SETTING_KEY },
      data: { value: previousDataSecurity as object },
    });
  }
  if (previousKitDir === undefined) delete process.env.FLEET_KIT_DIR;
  else process.env.FLEET_KIT_DIR = previousKitDir;
  rmSync(kitDir, { recursive: true, force: true });
  await db.auditLog.deleteMany({ where: { targetId: platformSchemeId } });
  await cleanupPlatform();
  await db.user.deleteMany({ where: { username: `${USER_PREFIX}platform_op` } });
  await cleanupSchemeTenants(TENANT_PREFIX, USER_PREFIX);
  await db.role.deleteMany({ where: { name: NO_TOOL_ROLE } });
  await app.close();
});

test('ENTRY_GUIDE_STEPS 覆盖全部入口，每项至少 1 条准备、2 条步骤、1 句结果查看', () => {
  assert.deepEqual(Object.keys(ENTRY_GUIDE_STEPS).sort(), [...TOOL_TASK_ENTRY_KEYS].sort());
  for (const key of TOOL_TASK_ENTRY_KEYS) {
    const g = ENTRY_GUIDE_STEPS[key];
    assert.ok(g.prepare.length >= 1, key);
    assert.ok(g.steps.length >= 2, key);
    assert.ok(g.result.trim().length > 0, key);
  }
});

test('下载 Word：含方案名、对象、启用的清单项、工具名和版本、操作说明、注意事项；停用项不出现；名称转义；写审计', async () => {
  const items = (await call('GET', f.adminA, `/${schemeId}`)).json().items as Item[];
  const disabled = items.find((i) => i.entryKey === 'asset-discovery')!;
  assert.ok(disabled, '服务器有 IP 时应生成资产测绘项');
  const off = await call('PATCH', f.adminA, `/${schemeId}/items/${disabled.id}`, {
    enabled: false,
  });
  assert.equal(off.statusCode, 200, off.body);

  const res = await call('GET', f.operatorA, `/${schemeId}/guide`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], DOCX_CONTENT_TYPE);
  const disposition = String(res.headers['content-disposition']);
  assert.ok(disposition.includes('detect-scheme-guide.docx'), disposition);
  assert.ok(
    disposition.includes(encodeURIComponent('作业指导书')),
    `文件名应为「<方案名>-作业指导书.docx」：${disposition}`,
  );
  const files = docxFiles(res.rawPayload);
  const xml = files['word/document.xml']!;
  const text = wordText(xml);
  for (const expected of [
    'C6方案<script>x</script>',
    '指导书测试',
    '2026-12-01 至 2026-12-05',
    '赵六',
    'C6模型<script>alert(1)</script>',
    'M-001',
    '模型名称：qwen2.5-72b',
    'C6服务器',
    'IP：10.30.0.8',
    'C6语料扫描器',
    '1.2.0',
    '第一步：解压工具包',
    '第二步：执行 corpus-cli scan <文件>',
    probeName,
    REV,
    'linux/amd64',
    `平台「工具中心 → C6语料扫描器」`,
    GUIDE_NOTICES[0],
    ENTRY_GUIDE_STEPS['corpus-scan'].steps[0]!,
    ENTRY_GUIDE_STEPS['fleet-onboard'].result,
  ]) {
    assert.ok(text.includes(expected), `Word 里缺「${expected}」`);
  }
  for (const item of items.filter((i) => i.id !== disabled.id)) {
    assert.ok(text.includes(item.title), `Word 里缺清单项「${item.title}」`);
  }
  assert.ok(!text.includes(disabled.title), '停用的清单项不应出现');
  assert.ok(
    !text.includes(ENTRY_GUIDE_STEPS['asset-discovery'].prepare[0]!),
    '停用项的作业步骤不应出现',
  );
  assert.ok(!text.includes('C6隐藏工具'), '隐藏工具对没有 tool:manage 的用户不出现');
  assert.ok(!text.includes('C6停用工具'));
  // 名称里的尖括号在 XML 里被转义
  assert.ok(!xml.includes('<script>'), 'XML 里不应出现未转义的 <script>');
  assert.ok(xml.includes('&lt;script&gt;'));

  const audit = await db.auditLog.findFirst({
    where: { action: 'detect_scheme.guide_download', targetId: schemeId },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit, '缺 detect_scheme.guide_download 审计');
  assert.ok(audit.ip);
  assert.equal(audit.userAgent, 'c6-guide-agent');
  assert.equal(audit.tenantId, f.tenantA);
  const logs = await app.inject({
    method: 'GET',
    url: '/api/audit-logs?category=download&action=detect_scheme.guide_download&pageSize=20',
    headers: bearer(f.adminA),
  });
  assert.equal(logs.statusCode, 200, logs.body);
  assert.ok(
    (logs.json().items as Array<{ targetId: string }>).some((i) => i.targetId === schemeId),
    '「下载」分类应能查到指导书下载',
  );
});

test('开下载水印时页眉为水印文字', async () => {
  await setDownloadWatermark(true);
  try {
    const res = await call('GET', f.adminA, `/${schemeId}/guide`);
    assert.equal(res.statusCode, 200, res.body);
    const files = docxFiles(res.rawPayload);
    const headers = Object.entries(files).filter(([name]) => /^word\/header\d*\.xml$/.test(name));
    assert.ok(headers.length > 0);
    const headerText = headers.map(([, x]) => wordText(x)).join('');
    assert.ok(headerText.includes(`${USER_PREFIX}admin_a`), headerText);
    assert.ok(!headerText.includes('检测作业指导书'), '开水印时页眉不再是默认文字');
  } finally {
    await setDownloadWatermark(false);
  }
  const plain = docxFiles((await call('GET', f.adminA, `/${schemeId}/guide`)).rawPayload);
  const headerText = Object.entries(plain)
    .filter(([name]) => /^word\/header\d*\.xml$/.test(name))
    .map(([, x]) => wordText(x))
    .join('');
  assert.ok(headerText.includes('检测作业指导书'));
});

test('配套工具：隐藏工具对 operator 不出现、对平台管理员出现；停用工具都不出现；内置探针返回安装包清单里的版本', async () => {
  const list = async (token: string) => {
    const res = await call('GET', token, `/${platformSchemeId}/tools`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().items as Array<{
      name: string;
      builtin: boolean;
      entryKeys: string[];
      detailPath: string;
      versions: Array<{ version: string; os: string; arch: string; sha256: string }>;
    }>;
  };
  const asAdmin = await list(platformAdmin);
  const asOperator = await list(platformOperator);
  assert.ok(asAdmin.some((t) => t.name === 'C6隐藏工具'));
  assert.ok(!asOperator.some((t) => t.name === 'C6隐藏工具'));
  assert.ok(!asAdmin.some((t) => t.name === 'C6停用工具'));
  const scanner = asOperator.find((t) => t.name === 'C6语料扫描器')!;
  assert.deepEqual(scanner.entryKeys, ['corpus-scan']);
  assert.match(scanner.detailPath, /^\/tools\/[0-9a-f-]{36}$/);
  assert.deepEqual(
    scanner.versions.map((v) => [v.version, v.os, v.arch]),
    [['1.2.0', 'linux', 'amd64']],
  );
  const probe = asOperator.find((t) => t.builtin)!;
  assert.ok(probe, '有终端接入项时应列出内置探针');
  assert.deepEqual(
    probe.versions.map((v) => [v.version, v.os, v.arch]),
    [[REV, 'linux', 'amd64']],
  );
});

test('另一个租户看不到指导书和工具；auditor 可以下载', async () => {
  assert.equal((await call('GET', f.adminB, `/${schemeId}/guide`)).statusCode, 404);
  assert.equal((await call('GET', f.adminB, `/${schemeId}/tools`)).statusCode, 404);
  const res = await call('GET', f.auditorA, `/${schemeId}/guide`);
  assert.equal(res.statusCode, 200);
  assert.equal((await call('GET', f.auditorA, `/${schemeId}/tools`)).statusCode, 200);
});

test('同一入口多个对象：作业步骤一节列出适用对象，工具操作说明只在第五章写一次；生成时间按北京时间', async () => {
  const m1 = await ledgerAsset(f.tenantA, { type: 'model', name: 'C6合并模型一' });
  const m2 = await ledgerAsset(f.tenantA, { type: 'model', name: 'C6合并模型二' });
  const created = await call('POST', f.adminA, '', {
    name: 'C6合并方案',
    requirement: { objective: '合并', categories: ['data'], assetIds: [m1.id, m2.id] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  const gen = await call('POST', f.adminA, `/${id}/generate`);
  assert.equal(gen.json().items.length, 2);
  const res = await call('GET', f.adminA, `/${id}/guide`);
  assert.equal(res.statusCode, 200, res.body);
  const text = wordText(docxFiles(res.rawPayload)['word/document.xml']!);
  assert.equal(text.split('第一步：解压工具包').length - 1, 1, '操作说明只出现一次');
  assert.ok(text.includes('见第五章 「C6语料扫描器」'), '作业步骤里写「见第五章」');
  assert.ok(text.includes('C6合并模型一、C6合并模型二'), '一节内列出适用对象');
  assert.equal(
    text.split(ENTRY_GUIDE_STEPS['corpus-scan'].steps[0]!).length - 1,
    1,
    '同一入口的步骤只写一次',
  );
  assert.ok(text.includes('北京时间'));
});

test('没有 tool:read 时指导书不写配套工具相关内容', async () => {
  const perms = await db.permission.findMany({ where: { code: { in: ['scheme:read'] } } });
  await db.role.deleteMany({ where: { name: NO_TOOL_ROLE } });
  await db.role.create({
    data: {
      name: NO_TOOL_ROLE,
      description: 'C6 测试',
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  await createUser(f.tenantA, `${USER_PREFIX}no_tool`, NO_TOOL_ROLE);
  const token = await loginAs(app, `${USER_PREFIX}no_tool`);
  const res = await call('GET', token, `/${schemeId}/guide`);
  assert.equal(res.statusCode, 200, res.body);
  const text = wordText(docxFiles(res.rawPayload)['word/document.xml']!);
  assert.ok(!text.includes('C6语料扫描器'));
  assert.ok(!text.includes('配套工具'));
  assert.ok(!text.includes('第一步：解压工具包'));
  assert.ok(text.includes('五、注意事项'));
  assert.ok(text.includes(GUIDE_NOTICES[0]));
  assert.equal((await call('GET', token, `/${schemeId}/tools`)).statusCode, 403);
});

test('最新版本列表：没有上传时间时按版本号（数字按大小）稳定取最新', () => {
  const v = (id: string, version: string, createdAt: string | null = null) => ({
    id,
    version,
    os: 'linux',
    arch: 'amd64',
    filename: `${id}.tgz`,
    size: 1,
    sha256: 'a'.repeat(64),
    releaseNotes: '',
    createdAt,
    createdBy: null,
    downloadUrl: null,
  });
  assert.deepEqual(
    latestPerPlatform([v('a', '1.2.0'), v('b', '1.10.0'), v('c', '1.9.9')]).map((x) => x.id),
    ['b'],
  );
  assert.deepEqual(
    latestPerPlatform([v('a', '1.0.0'), v('b', '1.0.0')]).map((x) => x.id),
    ['b'],
  );
  assert.deepEqual(
    latestPerPlatform([
      v('old', '2.0.0', '2026-11-01T00:00:00.000Z'),
      v('new', '1.0.0', '2026-11-20T00:00:00.000Z'),
    ]).map((x) => x.id),
    ['new'],
  );
});

test('大方案：1000 个清单项、工具操作说明 400 行，生成指导书在 30 秒内', async (t) => {
  const entries = [
    'asset-discovery',
    'fleet-posture',
    'content-eval',
    'model-file-scan',
    'corpus-scan',
  ];
  const instructions = Array.from(
    { length: 400 },
    (_, i) => `第 ${i} 步：这是一行操作说明，用于测试长文本重复输出的情况。`,
  ).join('\n');
  const assets = Array.from({ length: 200 }, (_, i) => ({
    type: 'server',
    name: `服务器-${i}`,
    code: `S-${i}`,
    ownerName: '张三',
    ownerDepartment: '信息中心',
    attrs: { ip: `10.0.0.${i % 250}`, os: 'Ubuntu 22.04' },
  }));
  const items = Array.from({ length: 1000 }, (_, i) => ({
    title: `检测项 ${i}`,
    category: 'app_env',
    entryKey: entries[i % entries.length]!,
    mode: i % 2 ? 'auto' : 'manual',
    note: '',
    assetName: `服务器-${i % 200}`,
  }));
  const tools = entries.map((e) => ({
    name: `工具-${e}`,
    instructions,
    entryKeys: [e],
    versions: [
      {
        id: `v-${e}`,
        version: '1.0.0',
        os: 'linux',
        arch: 'amd64',
        filename: 'x.tgz',
        size: 1024,
        sha256: 'a'.repeat(64),
        releaseNotes: '',
        createdAt: new Date().toISOString(),
        createdBy: null,
        downloadUrl: null,
      },
    ],
  }));
  const heapBefore = process.memoryUsage().heapUsed;
  const started = Date.now();
  const buf = await buildSchemeGuideDocx({
    schemeName: '大方案',
    requirement: { objective: 'x', categories: ['app_env'], assetIds: [] },
    assets,
    items,
    tools,
    watermark: null,
    now: new Date(),
  });
  const ms = Date.now() - started;
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  t.diagnostic(
    `1000 项 × 400 行操作说明：${ms} ms，docx ${(buf.length / 1024).toFixed(0)} KB，堆增长约 ${heapMb.toFixed(0)} MB`,
  );
  assert.ok(ms < 30_000, `生成耗时 ${ms} ms`);
  const text = wordText(docxFiles(buf)['word/document.xml']!);
  assert.equal(text.split('第 399 步').length - 1, 5, '每个工具的操作说明各写一次');
});
