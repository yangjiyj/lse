import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BUILTIN_PROBE_TOOL_CODE } from '@lse/shared';
import { prisma } from '../src/db.js';
import { shanghaiDay } from '../src/lib/platform-stats.js';
import {
  bearer,
  createToolTestContext,
  destroyToolTestContext,
  waitForParts,
  type ToolTestContext,
} from './helpers/tool-fixtures.js';

// 说明与手册（A-5，需求 2.3.3、2.3.5）：编辑名称、说明、参数、类别；手册上传、替换（id 不变）、删除、下载。

const P = 'zz-a5-';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let ctx: ToolTestContext;
let toolId = '';

function patchTool(token: string, id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/tools/${id}`,
    headers: bearer(token),
    payload,
  });
}

function sendManual(
  token: string,
  body: Buffer | Readable,
  query: Record<string, string>,
  method: 'POST' | 'PUT' = 'POST',
  manualId?: string,
  forTool = toolId,
) {
  return ctx.app.inject({
    method,
    url: `/api/tools/${forTool}/manuals${manualId ? `/${manualId}` : ''}?${new URLSearchParams(query)}`,
    headers: { ...bearer(token), 'content-type': 'application/octet-stream' },
    payload: body,
  });
}

const storedFiles = () => readdirSync(ctx.storageDir).sort();

before(async () => {
  ctx = await createToolTestContext(P);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/tools',
    headers: bearer(ctx.tokens.admin),
    payload: { code: `${P}manuals`, name: '手册工具', category: 'content' },
  });
  assert.equal(res.statusCode, 201, res.body);
  toolId = res.json().id;
});

after(async () => {
  await destroyToolTestContext(ctx, P);
  await prisma.$disconnect();
});

test('编辑名称、说明、参数、类别，写审计 tool.update；operator 403', async () => {
  const res = await patchTool(ctx.tokens.admin, toolId, {
    name: '改过的名字',
    description: '一句话简介',
    instructions: '第一步\n第二步\n\n<b>不渲染</b>',
    category: 'data',
    configParams: [{ name: 'dir', label: '目录', required: true }],
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.name, '改过的名字');
  assert.equal(body.category, 'data');
  assert.equal(body.instructions, '第一步\n第二步\n\n<b>不渲染</b>');
  assert.deepEqual(body.configParams, [
    { name: 'dir', label: '目录', description: '', defaultValue: '', required: true },
  ]);
  const log = await prisma.auditLog.findFirst({
    where: { action: 'tool.update', targetId: toolId },
  });
  assert.ok(log, '缺少 tool.update 审计');
  assert.equal((await patchTool(ctx.tokens.operator, toolId, { name: 'x' })).statusCode, 403);
  assert.equal((await patchTool(ctx.tokens.admin, toolId, { code: 'other' })).statusCode, 400);
  assert.equal((await patchTool(ctx.tokens.admin, toolId, { category: 'secret' })).statusCode, 400);
});

test('内置工具可以改说明，不能改类别', async () => {
  const probe = await prisma.tool.findUniqueOrThrow({ where: { code: BUILTIN_PROBE_TOOL_CODE } });
  try {
    const ok = await patchTool(ctx.tokens.admin, probe.id, { instructions: '临时说明' });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().instructions, '临时说明');
    const bad = await patchTool(ctx.tokens.admin, probe.id, { category: 'model' });
    assert.equal(bad.statusCode, 400, bad.body);
  } finally {
    await prisma.tool.update({
      where: { id: probe.id },
      data: { instructions: probe.instructions, updatedAt: probe.updatedAt },
    });
  }
});

test('上传手册：只收 pdf、docx、md、txt，其他扩展名 400 且不留文件', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake manual');
  const res = await sendManual(ctx.tokens.admin, pdf, { filename: '使用手册.pdf' });
  assert.equal(res.statusCode, 201, res.body);
  const m = res.json();
  assert.equal(m.title, '使用手册', '没给标题时用文件名');
  assert.equal(m.filename, '使用手册.pdf');
  assert.equal(m.mime, 'application/pdf');
  assert.equal(m.size, pdf.length);
  assert.equal(m.sha256, sha(pdf));
  const row = await prisma.toolManual.findUniqueOrThrow({ where: { id: m.id } });
  assert.ok(storedFiles().includes(row.storageKey));
  assert.ok(
    await prisma.auditLog.findFirst({ where: { action: 'tool.manual_upload', targetId: m.id } }),
  );

  const before = storedFiles();
  for (const filename of ['setup.exe', 'page.html', 'noext', 'manual.pdf.sh']) {
    const bad = await sendManual(ctx.tokens.admin, Buffer.from('x'), { filename });
    assert.equal(bad.statusCode, 400, filename);
  }
  assert.deepEqual(storedFiles(), before);
  assert.equal(
    (await sendManual(ctx.tokens.operator, Buffer.from('x'), { filename: 'a.md' })).statusCode,
    403,
  );
});

test('替换手册：id 不变、sha256 变，旧文件删掉，写审计 tool.manual_replace', async () => {
  const first = (
    await sendManual(ctx.tokens.admin, Buffer.from('# v1'), { filename: 'guide.md', title: '指南' })
  ).json();
  const oldRow = await prisma.toolManual.findUniqueOrThrow({ where: { id: first.id } });
  const v2 = Buffer.from('v2 正文');
  const res = await sendManual(ctx.tokens.admin, v2, { filename: 'guide-v2.txt' }, 'PUT', first.id);
  assert.equal(res.statusCode, 200, res.body);
  const m = res.json();
  assert.equal(m.id, first.id);
  assert.notEqual(m.sha256, first.sha256);
  assert.equal(m.sha256, sha(v2));
  assert.equal(m.filename, 'guide-v2.txt');
  assert.equal(m.mime, 'text/plain; charset=utf-8');
  assert.equal(m.title, '指南', '没给新标题时保留原标题');
  assert.equal(existsSync(join(ctx.storageDir, oldRow.storageKey)), false);
  const newRow = await prisma.toolManual.findUniqueOrThrow({ where: { id: first.id } });
  assert.ok(existsSync(join(ctx.storageDir, newRow.storageKey)));
  assert.ok(
    await prisma.auditLog.findFirst({ where: { action: 'tool.manual_replace', targetId: m.id } }),
  );
  const bad = await sendManual(
    ctx.tokens.admin,
    Buffer.from('x'),
    { filename: 'a.zip' },
    'PUT',
    m.id,
  );
  assert.equal(bad.statusCode, 400);
});

test('并发替换同一份手册：一个成功、一个 409，不留孤儿文件', async () => {
  const first = (
    await sendManual(ctx.tokens.admin, Buffer.from('# v1'), { filename: 'race.md' })
  ).json();
  const oldKey = (await prisma.toolManual.findUniqueOrThrow({ where: { id: first.id } }))
    .storageKey;
  const before = storedFiles();
  // 两个请求都读到旧记录、都开始写盘之后才写完，保证真正并发（共用一个等待，先写完的改名后另一个也不会卡住）。
  const bothWriting = waitForParts(ctx.storageDir, 2);
  async function* body(tag: string) {
    yield Buffer.from(`${tag} part 1 `);
    await bothWriting;
    yield Buffer.from(`${tag} part 2`);
  }
  const results = await Promise.all(
    ['a', 'b'].map((tag) =>
      sendManual(
        ctx.tokens.admin,
        Readable.from(body(tag)),
        { filename: `race-${tag}.md` },
        'PUT',
        first.id,
      ),
    ),
  );
  assert.deepEqual(
    results.map((r) => r.statusCode).sort(),
    [200, 409],
    results.map((r) => r.body).join(' | '),
  );
  const row = await prisma.toolManual.findUniqueOrThrow({ where: { id: first.id } });
  const after = storedFiles();
  assert.equal(after.length, before.length, '只留下一份新文件');
  assert.ok(after.includes(row.storageKey), '库里记的文件在');
  assert.ok(!after.includes(oldKey), '旧文件删掉');
  assert.ok(!after.some((f) => f.endsWith('.part')));
});

test('上传或替换手册中途工具被删：404「工具不存在」，不留文件', async () => {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/tools',
    headers: bearer(ctx.tokens.admin),
    payload: { code: `${P}gone`, name: '要删的工具', category: 'content' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const goneId = created.json().id as string;
  const before = storedFiles();
  const storageDir = ctx.storageDir;
  async function* body() {
    yield Buffer.from('half ');
    await waitForParts(storageDir, 1);
    await prisma.tool.delete({ where: { id: goneId } });
    yield Buffer.from('rest');
  }
  const res = await sendManual(
    ctx.tokens.admin,
    Readable.from(body()),
    { filename: 'gone.md' },
    'POST',
    undefined,
    goneId,
  );
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error.message, '工具不存在');
  assert.deepEqual(storedFiles(), before);
});

test('手册下载写下载记录（kind=manual），不计登录页下载量', async () => {
  const body = Buffer.from('plain text manual');
  const m = (await sendManual(ctx.tokens.admin, body, { filename: 'readme.txt' })).json();
  const day = async () =>
    (await prisma.platformDailyStat.findUnique({ where: { date: shanghaiDay() } }))?.downloads ?? 0;
  const before = await day();
  const ip = `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;
  const res = await ctx.app.inject({
    url: `/api/tools/${toolId}/manuals/${m.id}/download`,
    headers: bearer(ctx.tokens.operator),
    remoteAddress: ip,
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.rawPayload, body);
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(String(res.headers['content-disposition']), /readme\.txt/);
  assert.equal(await day(), before);
  const rows = await prisma.toolDownload.findMany({ where: { manualId: m.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'manual');
  assert.equal(rows[0]!.userId, ctx.userIds.operator);
  assert.equal(rows[0]!.ip, ip);
  assert.equal(rows[0]!.filename, 'readme.txt');
  assert.ok(
    await prisma.auditLog.findFirst({ where: { action: 'download.tool_manual', targetId: m.id } }),
  );
});

test('删除手册：文件删掉；operator 403；隐藏工具的手册对 operator 404', async () => {
  const m = (await sendManual(ctx.tokens.admin, Buffer.from('bye'), { filename: 'bye.md' })).json();
  const row = await prisma.toolManual.findUniqueOrThrow({ where: { id: m.id } });
  const url = `/api/tools/${toolId}/manuals/${m.id}`;
  assert.equal(
    (await ctx.app.inject({ method: 'DELETE', url, headers: bearer(ctx.tokens.operator) }))
      .statusCode,
    403,
  );
  await prisma.tool.update({ where: { id: toolId }, data: { hidden: true } });
  try {
    const hidden = await ctx.app.inject({
      url: `${url}/download`,
      headers: bearer(ctx.tokens.operator),
    });
    assert.equal(hidden.statusCode, 404);
  } finally {
    await prisma.tool.update({ where: { id: toolId }, data: { hidden: false } });
  }
  const del = await ctx.app.inject({ method: 'DELETE', url, headers: bearer(ctx.tokens.admin) });
  assert.equal(del.statusCode, 204, del.body);
  assert.equal(existsSync(join(ctx.storageDir, row.storageKey)), false);
  assert.equal(await prisma.toolManual.count({ where: { id: m.id } }), 0);
  assert.ok(
    await prisma.auditLog.findFirst({ where: { action: 'tool.manual_delete', targetId: m.id } }),
  );
});

test('内置工具可以管理手册', async () => {
  const probe = await prisma.tool.findUniqueOrThrow({ where: { code: BUILTIN_PROBE_TOOL_CODE } });
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/tools/${probe.id}/manuals?filename=probe.md`,
    headers: { ...bearer(ctx.tokens.admin), 'content-type': 'application/octet-stream' },
    payload: Buffer.from('# 探针手册'),
  });
  assert.equal(res.statusCode, 201, res.body);
  const del = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tools/${probe.id}/manuals/${res.json().id}`,
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(del.statusCode, 204);
});
