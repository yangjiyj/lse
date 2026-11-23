// Windows 安装包下载：exe 尾部追加部署配置（ASPDEPLOY1），不依赖探针车道的真实产物，exe 与 catalog 全部现场伪造。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PRODUCT_NAME } from '../src/lib/product-name.js';
import { shanghaiDay } from '../src/lib/platform-stats.js';
import { InstallerChangedError, streamInstaller } from '../src/modules/fleet-admin/installer.js';
import { settleDownloadRecords } from '../src/modules/tools/downloads.js';

const PREFIX = '__fleet_installer_';
const MARKER = 'ASPDEPLOY1';
const REV = 'a'.repeat(40);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

let app: FastifyInstance;
let adminJwt = '';
let auditorJwt = '';
let tmp = '';
let kitDir = '';
let certPath = '';
let certPem = '';
let certSha = '';
const exeBytes: Record<'amd64' | 'arm64', Buffer> = {
  amd64: Buffer.concat([Buffer.from('MZ'), randomBytes(4096)]),
  arm64: Buffer.concat([Buffer.from('MZ'), randomBytes(2048)]),
};
const SAVED: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'FLEET_AGENT_ENABLED',
  'FLEET_PUBLIC_BASE_URL',
  'FLEET_TLS_CERT_PEM_PATH',
  'FLEET_KIT_DIR',
  'LSE_PUBLIC_BASE_URL',
  'FLEET_KIT_BASE_URL',
];

/** 现场生成证书：extra 覆盖默认的扩展项，用来构造各种不合格证书。 */
function makeCert(
  name: string,
  opts: {
    cn?: string;
    san?: string;
    basic?: string | null;
    keyUsage?: string | null;
    eku?: string | null;
    days?: number;
    notBefore?: string;
    notAfter?: string;
    selfSigned?: boolean;
    twoCerts?: boolean;
    /** 多个长 OU + RSA-4096：单张合法证书，但 PEM 超过 4096 字节。 */
    bloat?: boolean;
  } = {},
): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  const ext: string[] = [];
  const basic = opts.basic === undefined ? 'critical,CA:FALSE' : opts.basic;
  const keyUsage = opts.keyUsage === undefined ? 'critical,digitalSignature' : opts.keyUsage;
  const eku = opts.eku === undefined ? 'serverAuth' : opts.eku;
  if (basic) ext.push(`basicConstraints=${basic}`);
  if (keyUsage) ext.push(`keyUsage=${keyUsage}`);
  if (eku) ext.push(`extendedKeyUsage=${eku}`);
  ext.push(`subjectAltName=${opts.san ?? 'IP:127.0.0.1'}`);
  const cnf = join(dir, 'c.cnf');
  const ous = opts.bloat
    ? Array.from({ length: 16 }, (_, i) => `${i}.OU=${'x'.repeat(60)}\n`).join('')
    : '';
  writeFileSync(
    cnf,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${opts.cn ?? 'lse-fleet'}\n${ous}[ext]\n${ext.join('\n')}\n`,
  );
  const key = join(dir, 'k.pem');
  const cert = join(dir, 'c.pem');
  const keyArgs = opts.bloat
    ? ['-newkey', 'rsa:4096']
    : ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
  const args = ['req', '-x509', ...keyArgs, '-nodes', '-keyout', key, '-out', cert, '-config', cnf];
  if (opts.notBefore && opts.notAfter)
    args.push('-not_before', opts.notBefore, '-not_after', opts.notAfter);
  else args.push('-days', String(opts.days ?? 30));
  execFileSync('openssl', args, { stdio: 'ignore' });
  if (opts.twoCerts) {
    const other = join(dir, 'c2.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'k2.pem'),
        '-out',
        other,
        '-config',
        cnf,
        '-days',
        '30',
      ],
      { stdio: 'ignore' },
    );
    writeFileSync(cert, execFileSync('cat', [cert, other]));
  }
  return cert;
}

/** 写入 kit 目录：catalog + 两个架构的 exe（按 opts 控制是否带 setup_server_kinds）。 */
function writeKit(
  dir: string,
  opts: {
    kinds?: string[] | null;
    withExe?: boolean;
    amd64Sha?: string;
    includeArm64?: boolean;
    filename?: string;
  } = {},
) {
  mkdirSync(dir, { recursive: true });
  const item = (arch: 'amd64' | 'arm64') => ({
    target: `windows-${arch}`,
    os: 'windows',
    arch,
    version: REV,
    filename: `windows-${arch}.zip`,
    sha256: 'c'.repeat(64),
    manifest_sha256: 'd'.repeat(64),
    bytes: 1234,
    setup_filename:
      opts.filename && arch === 'amd64'
        ? opts.filename
        : `agent-security-client-windows-${arch}.exe`,
    setup_sha256: arch === 'amd64' ? (opts.amd64Sha ?? sha(exeBytes.amd64)) : sha(exeBytes.arm64),
    setup_signature_status: 'unsigned',
    ...(opts.kinds === null
      ? {}
      : { setup_server_kinds: opts.kinds ?? ['agentshield', 'jiandun'] }),
  });
  const items: unknown[] = [item('amd64')];
  if (opts.includeArm64 !== false) items.push(item('arm64'));
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ source_revision: REV, items }));
  if (opts.withExe !== false) {
    writeFileSync(join(dir, 'agent-security-client-windows-amd64.exe'), exeBytes.amd64);
    writeFileSync(join(dir, 'agent-security-client-windows-arm64.exe'), exeBytes.arm64);
  }
}

async function newCode(
  over: Partial<{
    expiresAt: Date;
    maxUses: number;
    usedCount: number;
    status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  }> = {},
) {
  const code = `jdc_${randomBytes(32).toString('base64url')}`;
  const row = await prisma.fleetEnrollmentCode.create({
    data: {
      label: `${PREFIX}${randomBytes(3).toString('hex')}`,
      codeHash: sha(code),
      codePrefix: code.slice(0, 8),
      maxUses: over.maxUses ?? 3,
      usedCount: over.usedCount ?? 0,
      status: over.status ?? 'ACTIVE',
      revokedAt: over.status === 'REVOKED' ? new Date() : null,
      expiresAt: over.expiresAt ?? new Date(Date.now() + 36 * 3600_000),
    },
  });
  return { code, row };
}

const PASSWORD = ['Fleet', 'Inst', '123'].join('!');

async function makeUser(name: string, role: string): Promise<string> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { name: role } });
  const user = await prisma.user.create({
    data: {
      username: `${PREFIX}${name}`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: name,
      isActive: true,
      roles: { create: { roleId: roleRow.id } },
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: user.username, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  return login.json().token as string;
}

function download(code: string, target: string, jwt = adminJwt) {
  return app.inject({
    method: 'POST',
    url: '/api/fleet/install/windows-installer',
    headers: bearer(jwt),
    payload: { code, target },
  });
}

/** 按安装器的读取方式反向解析尾部：返回原 exe 字节与部署配置。 */
function parseOverlay(body: Buffer) {
  const trailer = 4 + MARKER.length;
  assert.equal(body.subarray(body.length - MARKER.length).toString('latin1'), MARKER, '尾部魔数');
  const len = body.readUInt32LE(body.length - trailer);
  assert.ok(len > 0 && len <= 8192, `JSON 长度 ${len}`);
  const jsonStart = body.length - trailer - len;
  const config = JSON.parse(body.subarray(jsonStart, jsonStart + len).toString('utf8')) as Record<
    string,
    unknown
  >;
  return { exe: body.subarray(0, jsonStart), config, len };
}

const saveEnv = () => ENV_KEYS.forEach((k) => (SAVED[k] = process.env[k]));
const restoreEnv = () =>
  ENV_KEYS.forEach((k) => {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  });

before(async () => {
  saveEnv();
  tmp = mkdtempSync(join(tmpdir(), 'fleet-installer-'));
  certPath = makeCert('good');
  certPem = execFileSync('cat', [certPath], { encoding: 'utf8' });
  certSha = sha(execFileSync('openssl', ['x509', '-in', certPath, '-outform', 'DER']));
  kitDir = join(tmp, 'kit');
  writeKit(kitDir);
  process.env.FLEET_AGENT_ENABLED = 'true';
  process.env.FLEET_PUBLIC_BASE_URL = 'https://127.0.0.1:18453';
  process.env.FLEET_TLS_CERT_PEM_PATH = certPath;
  process.env.FLEET_KIT_DIR = kitDir;
  process.env.LSE_PUBLIC_BASE_URL = 'https://lse.example';
  delete process.env.FLEET_KIT_BASE_URL;
  app = await buildApp();
  await app.ready();
  await prisma.fleetEnrollmentCode.deleteMany({ where: { label: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200, login.body);
  adminJwt = login.json().token;
  auditorJwt = await makeUser('auditor', 'auditor');
});

after(async () => {
  await prisma.auditLog.deleteMany({
    where: { action: 'fleet.installer.download', actorName: 'admin' },
  });
  await prisma.fleetEnrollmentCode.deleteMany({ where: { label: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  restoreEnv();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await app.close();
  await prisma.$disconnect();
});

// ───────────────────────── 成功路径 ─────────────────────────

test('成功：尾部格式可被解析回原 JSON，原 exe 字节不变，响应头齐全', async () => {
  const { code, row } = await newCode();
  const res = await download(code, 'windows-amd64');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(
    String(res.headers['content-disposition']),
    /^attachment; filename="[A-Za-z0-9._-]+-setup-windows-amd64\.exe"$/,
  );
  assert.ok(
    !String(res.headers['content-disposition']).includes(PRODUCT_NAME),
    '文件名不写死中文产品名',
  );
  const body = res.rawPayload;
  assert.equal(res.headers['content-length'], String(body.length));

  const { exe, config, len } = parseOverlay(body);
  assert.deepEqual(exe, exeBytes.amd64, '原 exe 字节原样保留在最前面');
  assert.equal(body.length, exeBytes.amd64.length + len + 4 + MARKER.length);
  // 只能是这些键：安装器 DisallowUnknownFields。
  assert.deepEqual(Object.keys(config).sort(), [
    'allow_http',
    'enrollment_code',
    'expires_at',
    'server',
    'server_kind',
    'tls_server_cert_pem',
    'tls_server_cert_sha256',
  ]);
  assert.equal(config.server, 'https://127.0.0.1:18453');
  assert.equal(config.enrollment_code, code);
  assert.equal(config.allow_http, false);
  assert.equal(config.server_kind, 'jiandun');
  assert.equal(config.tls_server_cert_sha256, certSha);
  assert.equal(String(config.tls_server_cert_pem).trim(), certPem.trim());
  assert.ok(Buffer.byteLength(String(config.tls_server_cert_pem)) <= 4096);
  // expires_at 与接入码到期时间一致（RFC3339 UTC，不截断）。
  assert.equal(config.expires_at, row.expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  assert.match(String(config.expires_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('成功下载 Windows 安装包计一次下载量，接入码不可用时不计', async () => {
  const downloads = async () =>
    (await prisma.platformDailyStat.findUnique({ where: { date: shanghaiDay() } }))?.downloads ?? 0;
  const before = await downloads();
  const adminId = (await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;
  const probeDownloads = () =>
    prisma.toolDownload.count({ where: { tool: { code: 'endpoint-probe' }, userId: adminId } });
  await settleDownloadRecords(); // 前面用例的探针下载记录在后台写，先等它们落库
  const probeBefore = await probeDownloads();
  const { code } = await newCode();
  assert.equal((await download(code, 'windows-amd64')).statusCode, 200);
  assert.equal(await downloads(), before + 1);
  await settleDownloadRecords();
  assert.equal(await probeDownloads(), probeBefore + 1, '工具中心记一条探针下载，带下载人');
  const last = await prisma.toolDownload.findFirst({
    where: { tool: { code: 'endpoint-probe' }, userId: adminId },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(last?.filename, 'jiandun-probe-setup-windows-amd64.exe', '记下载的文件名');
  const bad = await download('jdc_' + 'x'.repeat(20), 'windows-amd64');
  assert.equal(bad.statusCode, 409, bad.body);
  assert.equal(await downloads(), before + 1);
});

test('成功：arm64 目标取 arm64 安装包；接入码到期时间超过 7 天不被截断', async () => {
  const far = new Date(Date.now() + 100 * 24 * 3600_000);
  const { code, row } = await newCode({ expiresAt: far });
  const res = await download(code, 'windows-arm64');
  assert.equal(res.statusCode, 200, res.body);
  const { exe, config } = parseOverlay(res.rawPayload);
  assert.deepEqual(exe, exeBytes.arm64);
  assert.equal(config.expires_at, row.expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  assert.match(String(res.headers['content-disposition']), /windows-arm64\.exe/);
});

test('成功：下载不消耗接入码；审计记 codeId / codePrefix / target，不含明文', async () => {
  const { code, row } = await newCode({ maxUses: 1 });
  const before = await prisma.fleetEnrollmentCode.findUniqueOrThrow({ where: { id: row.id } });
  const res = await download(code, 'windows-amd64');
  assert.equal(res.statusCode, 200);
  const after = await prisma.fleetEnrollmentCode.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.usedCount, before.usedCount, '用量只在终端登记时消耗');
  const log = await prisma.auditLog.findFirst({
    where: { action: 'fleet.installer.download', targetId: row.id },
  });
  assert.ok(log, '应有审计');
  assert.equal(log.targetType, 'fleet_enrollment_code');
  const detail = log.detail as Record<string, unknown>;
  assert.equal(detail.codeId, row.id);
  assert.equal(detail.codePrefix, row.codePrefix);
  assert.equal(detail.target, 'windows-amd64');
  assert.ok(!JSON.stringify(log).includes(code), '审计不记明文接入码');
  assert.ok(!JSON.stringify(log).includes(code.slice(0, 20)));
  // 同一接入码可再次下载（换架构）。
  assert.equal((await download(code, 'windows-arm64')).statusCode, 200);
});

// ───────────────────────── 接入码状态 ─────────────────────────

test('接入码不可用：过期 / 用完 / 撤销 / 不存在 → 409 + 中文原因', async () => {
  const cases: Array<[string, string, string]> = [];
  const expired = await newCode({ expiresAt: new Date(Date.now() - 1000) });
  cases.push([expired.code, '已过期', 'FLEET_CODE_UNUSABLE']);
  const used = await newCode({ maxUses: 2, usedCount: 2 });
  cases.push([used.code, '已用完', 'FLEET_CODE_UNUSABLE']);
  const revoked = await newCode({ status: 'REVOKED' });
  cases.push([revoked.code, '已撤销', 'FLEET_CODE_UNUSABLE']);
  cases.push([`jdc_${randomBytes(32).toString('base64url')}`, '不存在', 'FLEET_CODE_UNUSABLE']);
  for (const [code, word, errCode] of cases) {
    const res = await download(code, 'windows-amd64');
    assert.equal(res.statusCode, 409, `${word}: ${res.body}`);
    assert.equal(res.json().error.code, errCode);
    assert.match(res.json().error.message, new RegExp(word));
    assert.ok(!res.body.includes(code), '错误信息不回显接入码');
  }
  // 失败不写“下载”审计。
  assert.equal(
    await prisma.auditLog.count({
      where: { action: 'fleet.installer.download', targetId: expired.row.id },
    }),
    0,
  );
});

test('接入码状态为 EXPIRED 但时间未到 → 也按已过期处理', async () => {
  const c = await newCode({ status: 'EXPIRED' });
  const res = await download(c.code, 'windows-amd64');
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error.message, /已过期/);
});

// ───────────────────────── 入参与权限 ─────────────────────────

test('非 Windows target / 缺字段 / 接入码格式不对 → 400；未登录 401；开关关闭 404', async () => {
  const { code } = await newCode();
  for (const target of ['linux-amd64', 'darwin-arm64', 'windows-x86', '../windows-amd64', '']) {
    const res = await download(code, target);
    assert.equal(res.statusCode, 400, `${target}: ${res.body}`);
  }
  const noBody = await app.inject({
    method: 'POST',
    url: '/api/fleet/install/windows-installer',
    headers: bearer(adminJwt),
    payload: {},
  });
  assert.equal(noBody.statusCode, 400);
  assert.equal((await download('abc', 'windows-amd64')).statusCode, 400, '接入码必须以 jdc_ 开头');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/fleet/install/windows-installer',
        payload: { code, target: 'windows-amd64' },
      })
    ).statusCode,
    401,
  );
  // 审计员只有查看权限，没有终端管理权限（与 deployment-info 一致）。
  assert.equal((await download(code, 'windows-amd64', auditorJwt)).statusCode, 403);
  process.env.FLEET_AGENT_ENABLED = 'false';
  try {
    assert.equal((await download(code, 'windows-amd64')).statusCode, 404);
  } finally {
    process.env.FLEET_AGENT_ENABLED = 'true';
  }
});

// ───────────────────────── 部署未就绪 / 证书预检 ─────────────────────────

test('部署未就绪（未配置服务地址 / 证书）→ 409 + 中文原因，不生成安装包', async () => {
  const { code } = await newCode();
  const base = process.env.FLEET_PUBLIC_BASE_URL;
  delete process.env.FLEET_PUBLIC_BASE_URL;
  try {
    const res = await download(code, 'windows-amd64');
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'FLEET_DEPLOYMENT_NOT_READY');
    assert.match(res.json().error.message, /部署/);
  } finally {
    process.env.FLEET_PUBLIC_BASE_URL = base;
  }
  const cert = process.env.FLEET_TLS_CERT_PEM_PATH;
  delete process.env.FLEET_TLS_CERT_PEM_PATH;
  try {
    assert.equal((await download(code, 'windows-amd64')).statusCode, 409);
  } finally {
    process.env.FLEET_TLS_CERT_PEM_PATH = cert;
  }
});

interface BadCase {
  name: string;
  server?: string;
  cert: Parameters<typeof makeCert>[1];
  expect: RegExp;
}
const BAD_CASES: BadCase[] = [
  {
    name: 'ca',
    cert: { basic: 'critical,CA:TRUE', keyUsage: 'critical,digitalSignature,keyCertSign' },
    expect: /CA|证书颁发|叶子/,
  },
  { name: 'nobasic', cert: { basic: null }, expect: /基本约束|BasicConstraints|叶子/ },
  { name: 'dnssan', cert: { san: 'IP:127.0.0.1,DNS:jiandun.test' }, expect: /DNS|SAN/ },
  { name: 'twoip', cert: { san: 'IP:127.0.0.1,IP:127.0.0.2' }, expect: /一个 IP|SAN/ },
  { name: 'otherip', cert: { san: 'IP:10.9.9.9' }, expect: /SAN|主机/ },
  {
    name: 'nodigsig',
    cert: { keyUsage: 'critical,keyEncipherment' },
    expect: /digitalSignature|密钥用途/,
  },
  {
    name: 'certsign',
    cert: { keyUsage: 'critical,digitalSignature,keyCertSign' },
    expect: /keyCertSign|证书签发|密钥用途/,
  },
  {
    name: 'crlsign',
    cert: { keyUsage: 'critical,digitalSignature,cRLSign' },
    expect: /cRLSign|密钥用途/,
  },
  { name: 'noeku', cert: { eku: null }, expect: /serverAuth|扩展密钥用途|服务器认证/ },
  { name: 'clientonly', cert: { eku: 'clientAuth' }, expect: /serverAuth|扩展密钥用途|服务器认证/ },
  {
    name: 'expired',
    cert: { notBefore: '20200101000000Z', notAfter: '20200102000000Z' },
    expect: /有效期/,
  },
  { name: 'two', cert: { twoCerts: true }, expect: /恰好|1 张|一张/ },
  { name: 'host', server: 'https://jiandun.test:18453', cert: {}, expect: /IP|主机/ },
  {
    name: 'path',
    server: 'https://127.0.0.1:18453/api',
    cert: {},
    expect: /路径|FLEET_PUBLIC_BASE_URL/,
  },
  { name: 'http', server: 'http://127.0.0.1:18453', cert: {}, expect: /https|HTTPS/ },
];

for (const c of BAD_CASES) {
  test(`证书 / 地址预检不通过（${c.name}）→ 409 中文原因，不生成安装包`, async () => {
    const { code } = await newCode();
    const cert = makeCert(`bad-${c.name}`, c.cert);
    const saved = [process.env.FLEET_TLS_CERT_PEM_PATH, process.env.FLEET_PUBLIC_BASE_URL];
    process.env.FLEET_TLS_CERT_PEM_PATH = cert;
    if (c.server) process.env.FLEET_PUBLIC_BASE_URL = c.server;
    try {
      const res = await download(code, 'windows-amd64');
      assert.equal(res.statusCode, 409, `${c.name}: ${res.statusCode} ${res.body.slice(0, 200)}`);
      assert.match(res.json().error.message, c.expect, `${c.name}: ${res.json().error.message}`);
      assert.ok(!res.body.includes('PRIVATE KEY'));
    } finally {
      [process.env.FLEET_TLS_CERT_PEM_PATH, process.env.FLEET_PUBLIC_BASE_URL] = saved as [
        string,
        string,
      ];
    }
  });
}

test('证书 PEM 超过 4096 字节 → 409，原因里写明字节限制', async () => {
  const { code } = await newCode();
  const big = makeCert('bad-bloat', { bloat: true });
  const size = Number(execFileSync('wc', ['-c', big], { encoding: 'utf8' }).trim().split(/\s+/)[0]);
  assert.ok(size > 4096, `构造的证书应超过 4096 字节，实际 ${size}`);
  const saved = process.env.FLEET_TLS_CERT_PEM_PATH;
  process.env.FLEET_TLS_CERT_PEM_PATH = big;
  try {
    const res = await download(code, 'windows-amd64');
    assert.equal(res.statusCode, 409, res.body.slice(0, 200));
    assert.match(res.json().error.message, /4096/);
  } finally {
    process.env.FLEET_TLS_CERT_PEM_PATH = saved;
  }
});

// ───────────────────────── 探针包清单 / exe 校验 ─────────────────────────

test('exe 的 sha256 与 catalog 不符 → 409 中文原因', async () => {
  const dir = join(tmp, 'kit-badsha');
  writeKit(dir, { amd64Sha: 'e'.repeat(64) });
  const saved = process.env.FLEET_KIT_DIR;
  process.env.FLEET_KIT_DIR = dir;
  try {
    const { code } = await newCode();
    const res = await download(code, 'windows-amd64');
    assert.equal(res.statusCode, 409, res.body);
    assert.match(res.json().error.message, /SHA-256|校验|不一致/);
    // 另一个架构不受影响
    assert.equal((await download(code, 'windows-arm64')).statusCode, 200);
  } finally {
    process.env.FLEET_KIT_DIR = saved;
  }
});

test('setup_server_kinds 缺失或不含 jiandun → 不可用；含 jiandun → 可用', async () => {
  const saved = process.env.FLEET_KIT_DIR;
  try {
    for (const [name, kinds, ok] of [
      ['old', null, false],
      ['onlyasp', ['agentshield'], false],
      ['empty', [], false],
      ['both', ['agentshield', 'jiandun'], true],
      ['only', ['jiandun'], true],
    ] as const) {
      const dir = join(tmp, `kit-kinds-${name}`);
      writeKit(dir, { kinds: kinds === null ? null : [...kinds] });
      process.env.FLEET_KIT_DIR = dir;
      const { code } = await newCode();
      const res = await download(code, 'windows-amd64');
      if (ok) assert.equal(res.statusCode, 200, name);
      else {
        assert.equal(res.statusCode, 409, `${name}: ${res.statusCode}`);
        assert.ok(
          res
            .json()
            .error.message.includes(`当前探针包版本不支持${PRODUCT_NAME}安装包，请更新探针包`),
          res.json().error.message,
        );
      }
      const info = (
        await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) })
      ).json();
      const t = info.oneclick.targets.find((x: any) => x.target === 'windows-amd64');
      assert.equal(t.installer.available, ok, name);
      if (!ok)
        assert.ok(
          t.installer.reason.includes(`当前探针包版本不支持${PRODUCT_NAME}安装包，请更新探针包`),
        );
      else assert.equal(t.installer.reason, undefined);
    }
  } finally {
    process.env.FLEET_KIT_DIR = saved;
  }
});

test('exe 文件不在探针包目录 → 不可用，原因「探针包目录缺少 Windows 安装包文件」', async () => {
  const dir = join(tmp, 'kit-noexe');
  writeKit(dir, { withExe: false });
  const saved = process.env.FLEET_KIT_DIR;
  process.env.FLEET_KIT_DIR = dir;
  try {
    const { code } = await newCode();
    const res = await download(code, 'windows-amd64');
    assert.equal(res.statusCode, 409);
    assert.ok(
      res.json().error.message.includes('探针包目录缺少 Windows 安装包文件'),
      res.json().error.message,
    );
    const info = (
      await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) })
    ).json();
    const t = info.oneclick.targets.find((x: any) => x.target === 'windows-amd64');
    assert.equal(t.installer.available, false);
    assert.equal(t.installer.reason, '探针包目录缺少 Windows 安装包文件');
  } finally {
    process.env.FLEET_KIT_DIR = saved;
  }
});

test('catalog 缺少该架构的 Windows 条目 / 未配置探针包目录 → 409', async () => {
  const saved = process.env.FLEET_KIT_DIR;
  try {
    const dir = join(tmp, 'kit-noarm');
    writeKit(dir, { includeArm64: false });
    process.env.FLEET_KIT_DIR = dir;
    const { code } = await newCode();
    const res = await download(code, 'windows-arm64');
    assert.equal(res.statusCode, 409, res.body);
    assert.match(res.json().error.message, /探针包/);
    delete process.env.FLEET_KIT_DIR;
    assert.equal((await download(code, 'windows-amd64')).statusCode, 409);
  } finally {
    process.env.FLEET_KIT_DIR = saved;
  }
});

test('setup_filename 非法（路径穿越 / 非 .exe 结尾）→ 该条目被忽略，不可下载', async () => {
  const saved = process.env.FLEET_KIT_DIR;
  try {
    for (const [name, filename] of [
      ['trav', '../agent-security-client-windows-amd64.exe'],
      ['ext', 'agent-security-client-windows-amd64.bin'],
      ['sep', 'sub/agent-security-client-windows-amd64.exe'],
    ] as const) {
      const dir = join(tmp, `kit-fn-${name}`);
      writeKit(dir, { filename });
      process.env.FLEET_KIT_DIR = dir;
      const { code } = await newCode();
      const res = await download(code, 'windows-amd64');
      assert.equal(res.statusCode, 409, `${name}: ${res.statusCode}`);
      assert.ok(!res.rawPayload.includes(Buffer.from(MARKER)) || res.statusCode !== 200);
    }
  } finally {
    process.env.FLEET_KIT_DIR = saved;
  }
});

test('exe 校验结果按 路径+大小+mtime 缓存：内容被替换（大小变）后立即重新校验', async () => {
  const dir = join(tmp, 'kit-cache');
  writeKit(dir);
  const saved = process.env.FLEET_KIT_DIR;
  process.env.FLEET_KIT_DIR = dir;
  try {
    const { code } = await newCode();
    assert.equal((await download(code, 'windows-amd64')).statusCode, 200);
    // 换成内容不同、大小也不同的文件，但 catalog 的 sha 不变 → 必须被发现。
    writeFileSync(
      join(dir, 'agent-security-client-windows-amd64.exe'),
      Buffer.concat([exeBytes.amd64, Buffer.from('tamper')]),
    );
    const res = await download(code, 'windows-amd64');
    assert.equal(res.statusCode, 409, res.body);
    // 同样大小、不同 mtime 的篡改也要发现。
    const tampered = Buffer.from(exeBytes.amd64);
    tampered[100] = tampered[100]! ^ 0xff;
    const p = join(dir, 'agent-security-client-windows-amd64.exe');
    writeFileSync(p, tampered);
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    assert.equal((await download(code, 'windows-amd64')).statusCode, 409);
    // 恢复原文件 → 又能下载。
    writeFileSync(p, exeBytes.amd64);
    utimesSync(p, new Date(), new Date(Date.now() + 9000));
    assert.equal((await download(code, 'windows-amd64')).statusCode, 200);
  } finally {
    process.env.FLEET_KIT_DIR = saved;
  }
});

test('发送过程中 exe 被换成别的内容（同样大小、同样 mtime）→ 响应中断，不会把被换过的安装包连同接入码发出去', async () => {
  const dir = join(tmp, 'kit-swap');
  writeKit(dir);
  const exePath = join(dir, 'agent-security-client-windows-amd64.exe');
  // mtime 固定在整数秒：散列缓存键（路径+大小+mtime）可以被精确还原，不依赖浮点往返。
  const T = 1_700_000_000;
  utimesSync(exePath, T, T);
  const saved = process.env.FLEET_KIT_DIR;
  process.env.FLEET_KIT_DIR = dir;
  try {
    const { code } = await newCode();
    // 先正常下载一次，把缓存预热。
    assert.equal((await download(code, 'windows-amd64')).statusCode, 200);
    // 再模拟「检查通过又被换掉」：大小、mtime 都不变的同尺寸篡改，缓存的散列仍然命中，
    // 预检会放行，只有发送时对已打开句柄边读边算的校验才能发现。
    const tampered = Buffer.from(exeBytes.amd64);
    tampered[200] = tampered[200]! ^ 0xff;
    writeFileSync(exePath, tampered);
    utimesSync(exePath, T, T);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    assert.ok(addr && typeof addr === 'object');
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/fleet/install/windows-installer`, {
      method: 'POST',
      headers: { ...bearer(adminJwt), 'content-type': 'application/json' },
      body: JSON.stringify({ code, target: 'windows-amd64' }),
    });
    assert.equal(res.status, 200, '预检按缓存放行，状态码应已发出');
    let received = Buffer.alloc(0);
    let aborted = false;
    try {
      received = Buffer.from(await res.arrayBuffer());
    } catch {
      aborted = true;
    }
    assert.ok(aborted, '发送中途发现文件已变化，必须中断连接而不是发完');
    assert.ok(!received.includes(Buffer.from(MARKER)), '尾部魔数不得出现');
    assert.ok(!received.includes(Buffer.from(code)), '接入码不得随被换过的安装包发出');
  } finally {
    process.env.FLEET_KIT_DIR = saved;
  }
});

test('streamInstaller：内容与清单一致 → 先出 exe 字节再出尾部，并关闭文件句柄', async () => {
  const p = join(tmp, 'stream-ok.bin');
  writeFileSync(p, exeBytes.amd64);
  const handle = await open(p, 'r');
  const tail = Buffer.from('TAIL-' + 'z'.repeat(24));
  const chunks: Buffer[] = [];
  for await (const c of streamInstaller(handle, exeBytes.amd64.length, sha(exeBytes.amd64), tail))
    chunks.push(c);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([exeBytes.amd64, tail]));
  await assert.rejects(() => handle.stat(), '读完后句柄应已关闭');
});

test('streamInstaller：内容与清单不一致 → 抛错、不输出尾部，句柄同样关闭', async () => {
  const p = join(tmp, 'stream-bad.bin');
  writeFileSync(p, exeBytes.amd64);
  const handle = await open(p, 'r');
  const tail = Buffer.from('TAIL-' + 'z'.repeat(24));
  const chunks: Buffer[] = [];
  await assert.rejects(async () => {
    for await (const c of streamInstaller(handle, exeBytes.amd64.length, sha('别的内容'), tail))
      chunks.push(c);
  }, InstallerChangedError);
  assert.ok(!Buffer.concat(chunks).includes(tail), '校验失败后不得输出尾部');
  await assert.rejects(() => handle.stat(), '出错后句柄也应已关闭');
});

test('streamInstaller：文件比预检时短（被截断）→ 抛错', async () => {
  const p = join(tmp, 'stream-short.bin');
  writeFileSync(p, exeBytes.amd64.subarray(0, 1000));
  const handle = await open(p, 'r');
  const tail = Buffer.from('TAIL-' + 'z'.repeat(24));
  await assert.rejects(async () => {
    for await (const c of streamInstaller(handle, exeBytes.amd64.length, sha(exeBytes.amd64), tail))
      void c;
  }, InstallerChangedError);
});

// ───────────────────────── deployment-info 的 installer 字段 ─────────────────────────

test('deployment-info：Windows 目标带 installer 状态；Linux 目标不带', async () => {
  const info = (
    await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) })
  ).json();
  const byTarget = Object.fromEntries(info.oneclick.targets.map((t: any) => [t.target, t]));
  assert.deepEqual(byTarget['windows-amd64'].installer, { available: true });
  assert.deepEqual(byTarget['windows-arm64'].installer, { available: true });
  for (const t of info.oneclick.targets.filter((x: any) => x.os !== 'windows'))
    assert.equal(t.installer, undefined);
});

test('deployment-info：部署未就绪时 Windows 安装包不可用并写明原因', async () => {
  const saved = process.env.FLEET_TLS_CERT_PEM_PATH;
  delete process.env.FLEET_TLS_CERT_PEM_PATH;
  try {
    const info = (
      await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) })
    ).json();
    const t = info.oneclick.targets.find((x: any) => x.target === 'windows-amd64');
    assert.equal(t.installer.available, false);
    assert.ok(t.installer.reason.length > 0);
  } finally {
    process.env.FLEET_TLS_CERT_PEM_PATH = saved;
  }
});

test('不依赖现网产物：用现网 catalog 副本的 Windows 条目（无 setup_server_kinds）→ 不可用', async () => {
  const dir = join(tmp, 'kit-prodlike');
  writeKit(dir, { kinds: null });
  const saved = process.env.FLEET_KIT_DIR;
  process.env.FLEET_KIT_DIR = dir;
  try {
    const info = (
      await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) })
    ).json();
    const t = info.oneclick.targets.find((x: any) => x.target === 'windows-amd64');
    assert.equal(t.installer.available, false);
  } finally {
    process.env.FLEET_KIT_DIR = saved;
  }
});
