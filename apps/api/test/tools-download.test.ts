import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_PROBE_TOOL_CODE } from '@lse/shared';
import { prisma } from '../src/db.js';
import { shanghaiDay } from '../src/lib/platform-stats.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { settleDownloadRecords } from '../src/modules/tools/downloads.js';
import { downloadLinkSettings } from '../src/modules/tools/download-links.js';
import {
  bearer,
  createToolTestContext,
  destroyToolTestContext,
  type ToolTestContext,
} from './helpers/tool-fixtures.js';

// 下载与溯源（A-4，需求 2.3.8、2.3.9）：版本下载写下载记录并计入登录页下载量（同 IP 同文件 30 分钟一次）；
// 按用户汇总、按北京时间按天的 30 天趋势；匿名下载探针包也留一条记录。

const P = 'zz-a4-';
const REV = 'b'.repeat(40);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
let ctx: ToolTestContext;
let kitDir = '';
let probeId = '';
const usedIps: string[] = [];
const KIT = Buffer.from('fake linux kit for tool center');

function freshIp(): string {
  const ip = `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;
  usedIps.push(ip);
  return ip;
}

async function loginDownloads(): Promise<number> {
  return (
    (await prisma.platformDailyStat.findUnique({ where: { date: shanghaiDay() } }))?.downloads ?? 0
  );
}

async function newToolWithVersion(suffix: string, body = Buffer.from(`file of ${suffix}`)) {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/tools',
    headers: bearer(ctx.tokens.admin),
    payload: { code: `${P}${suffix}`, name: `下载${suffix}`, category: 'data' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const toolId = created.json().id as string;
  const q = new URLSearchParams({ version: '1.0.0', os: 'any', arch: 'any', filename: 'scan.zip' });
  const up = await ctx.app.inject({
    method: 'POST',
    url: `/api/tools/${toolId}/versions?${q}`,
    headers: { ...bearer(ctx.tokens.admin), 'content-type': 'application/octet-stream' },
    payload: body,
  });
  assert.equal(up.statusCode, 201, up.body);
  return { toolId, versionId: up.json().id as string, body };
}

function download(toolId: string, versionId: string, token: string | null, ip = freshIp()) {
  return ctx.app.inject({
    url: `/api/tools/${toolId}/versions/${versionId}/download`,
    remoteAddress: ip,
    headers: { ...(token ? bearer(token) : {}), 'user-agent': 'tool-center-test/1.0' },
  });
}

before(async () => {
  ctx = await createToolTestContext(P);
  kitDir = join(ctx.storageDir, 'kits');
  mkdirSync(kitDir);
  writeFileSync(join(kitDir, 'linux-amd64.tar.gz'), KIT);
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
          sha256: sha(KIT),
          bytes: KIT.length,
          manifest_sha256: 'c'.repeat(64),
        },
        {
          target: 'windows-amd64',
          os: 'windows',
          arch: 'amd64',
          version: REV,
          filename: 'windows-amd64.zip',
          sha256: sha('zip'),
          manifest_sha256: 'd'.repeat(64),
        },
      ],
    }),
  );
  process.env.FLEET_AGENT_ENABLED = 'true';
  process.env.FLEET_KIT_DIR = kitDir;
  probeId = (await prisma.tool.findUniqueOrThrow({ where: { code: BUILTIN_PROBE_TOOL_CODE } })).id;
});

after(async () => {
  await prisma.toolDownload.deleteMany({ where: { toolId: probeId, ip: { in: usedIps } } });
  await destroyToolTestContext(ctx, P);
  rmSync(kitDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

test('下载版本：返回文件，下载记录多一条（带 userId、ip、UA），写下载审计', async () => {
  const { toolId, versionId, body } = await newToolWithVersion('one');
  const ip = freshIp();
  const res = await download(toolId, versionId, ctx.tokens.operator, ip);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.rawPayload, body);
  assert.equal(res.headers['content-length'], String(body.length));
  assert.match(String(res.headers['content-disposition']), /attachment; filename="scan\.zip"/);
  const rows = await prisma.toolDownload.findMany({ where: { toolId } });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.kind, 'package');
  assert.equal(row.versionId, versionId);
  assert.equal(row.userId, ctx.userIds.operator);
  assert.equal(row.username, `${P}operator`);
  assert.equal(row.tenantId, PLATFORM_TENANT_ID);
  assert.equal(row.ip, ip);
  assert.equal(row.userAgent, 'tool-center-test/1.0');
  assert.equal(row.filename, 'scan.zip', '记下载的文件名');
  const log = await prisma.auditLog.findFirst({
    where: { action: 'download.tool_package', targetId: versionId },
  });
  assert.ok(log, '缺少下载审计');
  assert.equal(log.ip, ip);
  assert.equal(log.userAgent, 'tool-center-test/1.0');
});

test('30 分钟内同一 IP 同一文件只计一次登录页下载量，换 IP 再计；下载记录每次都写', async () => {
  const { toolId, versionId } = await newToolWithVersion('dedup');
  const ip = freshIp();
  const before = await loginDownloads();
  assert.equal((await download(toolId, versionId, ctx.tokens.operator, ip)).statusCode, 200);
  assert.equal(await loginDownloads(), before + 1);
  assert.equal((await download(toolId, versionId, ctx.tokens.auditor, ip)).statusCode, 200);
  assert.equal(await loginDownloads(), before + 1, '同一 IP 同一文件不重复计');
  assert.equal((await download(toolId, versionId, ctx.tokens.operator)).statusCode, 200);
  assert.equal(await loginDownloads(), before + 2);
  assert.equal(await prisma.toolDownload.count({ where: { toolId } }), 3);
});

function issueLink(toolId: string, versionId: string, token: string | null) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/tools/${toolId}/versions/${versionId}/download-link`,
    headers: token ? bearer(token) : {},
  });
}

function fetchLink(url: string, ip = freshIp()) {
  return ctx.app.inject({
    url,
    remoteAddress: ip,
    headers: { 'user-agent': 'browser-native/1.0' },
  });
}

test('下载链接：60 秒有效、只能用一次；不带 Authorization 也能下，下载记录和审计记签发人', async () => {
  const { toolId, versionId, body } = await newToolWithVersion('link');
  const issued = await issueLink(toolId, versionId, ctx.tokens.operator);
  assert.equal(issued.statusCode, 200, issued.body);
  const { url, expiresAt } = issued.json() as { url: string; expiresAt: string };
  assert.match(url, /^\/api\/tools\/download\?token=[A-Za-z0-9_-]{43}$/);
  const ttl = new Date(expiresAt).getTime() - Date.now();
  assert.ok(ttl > 55_000 && ttl <= 60_000, `有效期 ${ttl}ms`);

  const ip = freshIp();
  const res = await fetchLink(url, ip);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.rawPayload, body);
  assert.match(String(res.headers['content-disposition']), /attachment; filename="scan\.zip"/);
  const rows = await prisma.toolDownload.findMany({ where: { toolId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.userId, ctx.userIds.operator, '记签发人');
  assert.equal(rows[0]!.ip, ip);
  assert.equal(rows[0]!.filename, 'scan.zip');
  const log = await prisma.auditLog.findFirst({
    where: { action: 'download.tool_package', targetId: versionId },
  });
  assert.equal(log?.actorId, ctx.userIds.operator);
  assert.equal(log?.ip, ip);

  const again = await fetchLink(url);
  assert.equal(again.statusCode, 410, '只能用一次');
  assert.equal(await prisma.toolDownload.count({ where: { toolId } }), 1);
});

test('下载链接过期 410；令牌缺失或格式不对 401', async () => {
  const { toolId, versionId } = await newToolWithVersion('link-exp');
  const saved = downloadLinkSettings.ttlMs;
  downloadLinkSettings.ttlMs = 50;
  let url: string;
  try {
    const issued = await issueLink(toolId, versionId, ctx.tokens.operator);
    assert.equal(issued.statusCode, 200, issued.body);
    url = issued.json().url;
  } finally {
    downloadLinkSettings.ttlMs = saved;
  }
  await new Promise((r) => setTimeout(r, 150));
  const expired = await fetchLink(url);
  assert.equal(expired.statusCode, 410, expired.body);
  assert.match(expired.json().error.message, /下载链接已失效/);
  assert.equal((await fetchLink('/api/tools/download')).statusCode, 401);
  assert.equal((await fetchLink('/api/tools/download?token=abc')).statusCode, 401);
  assert.equal(
    (await fetchLink(`/api/tools/download?token=${'A'.repeat(43)}`)).statusCode,
    410,
    '格式对但不存在的令牌当作已失效',
  );
  assert.equal(await prisma.toolDownload.count({ where: { toolId } }), 0);
});

test('下载链接：隐藏、禁用的工具不签发；没有 tool:read 403，未登录 401；签发后被禁用也下不了', async () => {
  const { toolId, versionId } = await newToolWithVersion('link-state');
  assert.equal((await issueLink(toolId, versionId, null)).statusCode, 401);
  assert.equal((await issueLink(toolId, versionId, ctx.tokens.noTool)).statusCode, 403);
  const other = await newToolWithVersion('link-other');
  assert.equal(
    (await issueLink(toolId, other.versionId, ctx.tokens.operator)).statusCode,
    404,
    '版本不属于该工具',
  );

  const issued = await issueLink(toolId, versionId, ctx.tokens.operator);
  assert.equal(issued.statusCode, 200, issued.body);
  await prisma.tool.update({ where: { id: toolId }, data: { enabled: false } });
  assert.equal((await issueLink(toolId, versionId, ctx.tokens.operator)).statusCode, 409);
  assert.equal((await fetchLink(issued.json().url)).statusCode, 409, '签发后被禁用');

  await prisma.tool.update({ where: { id: toolId }, data: { enabled: true, hidden: true } });
  assert.equal((await issueLink(toolId, versionId, ctx.tokens.operator)).statusCode, 404);
  const admin = await issueLink(toolId, versionId, ctx.tokens.admin);
  assert.equal(admin.statusCode, 200, '管理员能看到隐藏工具，可以下载');
  assert.equal((await fetchLink(admin.json().url)).statusCode, 200);
});

test('下载要登录和 tool:read；版本不属于该工具 404', async () => {
  const a = await newToolWithVersion('perm-a');
  const b = await newToolWithVersion('perm-b');
  assert.equal((await download(a.toolId, a.versionId, null)).statusCode, 401);
  assert.equal((await download(a.toolId, a.versionId, ctx.tokens.noTool)).statusCode, 403);
  assert.equal((await download(a.toolId, b.versionId, ctx.tokens.operator)).statusCode, 404);
});

test('禁用工具下载 409，隐藏工具对没有管理权限的用户 404', async () => {
  const { toolId, versionId } = await newToolWithVersion('state');
  await prisma.tool.update({ where: { id: toolId }, data: { enabled: false } });
  assert.equal((await download(toolId, versionId, ctx.tokens.operator)).statusCode, 409);
  await prisma.tool.update({ where: { id: toolId }, data: { enabled: true, hidden: true } });
  assert.equal((await download(toolId, versionId, ctx.tokens.operator)).statusCode, 404);
  assert.equal((await download(toolId, versionId, ctx.tokens.admin)).statusCode, 200);
});

test('下载溯源带最近下载明细：时间、用户、文件名、IP，新到旧', async () => {
  const { toolId, versionId } = await newToolWithVersion('recent');
  const ip = freshIp();
  await download(toolId, versionId, ctx.tokens.operator, ip);
  await download(toolId, versionId, ctx.tokens.auditor);
  const res = await ctx.app.inject({
    url: `/api/tools/${toolId}/downloads`,
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  const recent = res.json().recent as Array<{
    username: string | null;
    filename: string | null;
    ip: string;
    kind: string;
    createdAt: string;
  }>;
  assert.equal(recent.length, 2);
  assert.equal(recent[0]!.username, `${P}auditor`, '新到旧');
  assert.equal(recent[1]!.username, `${P}operator`);
  assert.equal(recent[1]!.ip, ip);
  assert.equal(recent[1]!.filename, 'scan.zip');
  assert.equal(recent[1]!.kind, 'package');
});

test('下载溯源：按用户汇总，需要 tool:manage', async () => {
  const { toolId, versionId } = await newToolWithVersion('trace');
  await download(toolId, versionId, ctx.tokens.operator);
  await download(toolId, versionId, ctx.tokens.operator);
  await download(toolId, versionId, ctx.tokens.auditor);
  await prisma.toolDownload.create({ data: { toolId, kind: 'package', ip: '10.9.9.9' } });
  const denied = await ctx.app.inject({
    url: `/api/tools/${toolId}/downloads`,
    headers: bearer(ctx.tokens.operator),
  });
  assert.equal(denied.statusCode, 403);
  const res = await ctx.app.inject({
    url: `/api/tools/${toolId}/downloads`,
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.total, 4);
  const byName = new Map(
    (body.byUser as Array<{ username: string | null; packages: number; manuals: number }>).map(
      (u) => [u.username, u],
    ),
  );
  assert.equal(byName.get(`${P}operator`)?.packages, 2);
  assert.equal(byName.get(`${P}auditor`)?.packages, 1);
  assert.equal(byName.get(null)?.packages, 1, '匿名下载单独一行');
  assert.equal(body.byUser[0].username, `${P}operator`, '按下载次数倒序');
  const platform = await prisma.tenant.findUniqueOrThrow({ where: { id: PLATFORM_TENANT_ID } });
  assert.equal(body.byUser[0].tenantName, platform.name);
  assert.equal(body.trend.length, 30);
  assert.equal(body.trend.at(-1).count, 4, '今天的 4 次');
});

test('趋势按北京时间按天汇总', async () => {
  const { toolId } = await newToolWithVersion('trend');
  // 北京时间前天 00:30（UTC 是大前天 16:30）和前天 23:30（UTC 前天 15:30）都算前天。
  const day = new Date(shanghaiDay().getTime() - 2 * 86400000);
  const key = day.toISOString().slice(0, 10);
  const prevKey = new Date(day.getTime() - 86400000).toISOString().slice(0, 10);
  await prisma.toolDownload.createMany({
    data: [
      {
        toolId,
        kind: 'package',
        ip: '10.0.0.1',
        createdAt: new Date(day.getTime() - 7.5 * 3600000),
      },
      {
        toolId,
        kind: 'manual',
        ip: '10.0.0.2',
        createdAt: new Date(day.getTime() + 15.5 * 3600000),
      },
      // 31 天前，不在趋势里
      {
        toolId,
        kind: 'package',
        ip: '10.0.0.3',
        createdAt: new Date(day.getTime() - 40 * 86400000),
      },
    ],
  });
  const res = await ctx.app.inject({
    url: `/api/tools/${toolId}/downloads`,
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  const trend = new Map(
    (res.json().trend as Array<{ date: string; count: number }>).map((p) => [p.date, p.count]),
  );
  assert.equal(trend.get(key), 1, '趋势只算安装包，手册下载不算');
  assert.equal(trend.get(prevKey), 0);
  assert.equal(res.json().total, 2, '总数只算安装包，不受 30 天窗口限制');
  const byUser = res.json().byUser as Array<{ packages: number; manuals: number }>;
  assert.equal(byUser[0]!.manuals, 1, '按用户汇总里手册单独一列');
});

test('内置探针：版本来自安装包清单；匿名下载探针包记一条 userId 为空的下载记录，登录下载记下载人', async () => {
  const detail = await ctx.app.inject({
    url: `/api/tools/${probeId}`,
    headers: bearer(ctx.tokens.operator),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  const versions = detail.json().versions as Array<{
    os: string;
    arch: string;
    version: string;
    downloadUrl: string | null;
  }>;
  const linux = versions.find((v) => v.os === 'linux');
  assert.equal(linux?.version, REV);
  assert.equal(linux?.downloadUrl, '/api/fleet/kits/linux-amd64.tar.gz');
  assert.equal(versions.find((v) => v.os === 'windows')?.downloadUrl, null);

  const anonIp = freshIp();
  const anon = await ctx.app.inject({
    url: '/api/fleet/kits/linux-amd64.tar.gz',
    remoteAddress: anonIp,
  });
  assert.equal(anon.statusCode, 200);
  await settleDownloadRecords();
  const anonRow = await prisma.toolDownload.findFirst({ where: { toolId: probeId, ip: anonIp } });
  assert.ok(anonRow, '匿名下载没有留下记录');
  assert.equal(anonRow.userId, null);
  assert.equal(anonRow.kind, 'package');
  assert.equal(anonRow.filename, 'linux-amd64.tar.gz', '探针包记下载的文件名');

  const userIp = freshIp();
  const signed = await ctx.app.inject({
    url: '/api/fleet/kits/linux-amd64.tar.gz',
    remoteAddress: userIp,
    headers: bearer(ctx.tokens.operator),
  });
  assert.equal(signed.statusCode, 200);
  await settleDownloadRecords();
  const userRow = await prisma.toolDownload.findFirst({ where: { toolId: probeId, ip: userIp } });
  assert.equal(userRow?.userId, ctx.userIds.operator);
  assert.equal(userRow?.filename, 'linux-amd64.tar.gz');

  const badTokenIp = freshIp();
  const badToken = await ctx.app.inject({
    url: '/api/fleet/kits/linux-amd64.tar.gz',
    remoteAddress: badTokenIp,
    headers: bearer('not-a-jwt'),
  });
  assert.equal(badToken.statusCode, 200, '令牌无效也照常匿名下载');
  await settleDownloadRecords();
  const badRow = await prisma.toolDownload.findFirst({
    where: { toolId: probeId, ip: badTokenIp },
  });
  assert.equal(badRow?.userId, null);

  const head = await ctx.app.inject({
    method: 'HEAD',
    url: '/api/fleet/kits/linux-amd64.tar.gz',
    remoteAddress: anonIp,
  });
  assert.equal(head.statusCode, 200);
  await settleDownloadRecords();
  assert.equal(
    await prisma.toolDownload.count({ where: { toolId: probeId, ip: anonIp } }),
    1,
    'HEAD 不算下载',
  );
});

test('匿名下载探针包：同一 IP 同一文件 30 分钟内只记一条；带有效登录令牌的每次都记', async () => {
  const kit = (ip: string, token?: string) =>
    ctx.app.inject({
      url: '/api/fleet/kits/linux-amd64.tar.gz',
      remoteAddress: ip,
      headers: token ? bearer(token) : {},
    });
  const anonIp = freshIp();
  for (let i = 0; i < 20; i++) assert.equal((await kit(anonIp)).statusCode, 200);
  await settleDownloadRecords();
  assert.equal(
    await prisma.toolDownload.count({ where: { toolId: probeId, ip: anonIp } }),
    1,
    '匿名下载 20 次只多 1 条记录',
  );
  const userIp = freshIp();
  for (let i = 0; i < 3; i++)
    assert.equal((await kit(userIp, ctx.tokens.operator)).statusCode, 200);
  await settleDownloadRecords();
  assert.equal(
    await prisma.toolDownload.count({
      where: { toolId: probeId, ip: userIp, userId: ctx.userIds.operator },
    }),
    3,
  );
});
