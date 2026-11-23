import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { readScopeConfig, saveScopeConfig } from '../src/modules/asset-discovery/service.js';
import { onProbeReportStored } from '../src/modules/fleet-admin/remote-deploy/hooks.js';
import { sweepRemoteDeploys } from '../src/modules/fleet-admin/remote-deploy/routes.js';
import type { RemoteShell } from '../src/modules/fleet-admin/remote-deploy/runner.js';
import { sampleReport } from './fleet-admin-fixtures.js';
import {
  adminToken,
  bearer,
  builtinRoleUserToken,
  cleanupFixtures,
} from './helpers/w4-fixtures.js';

// B-9 远程部署接口（2.4.8）：权限、扫描范围、一键脚本可用性、一次性部署命令与计时、上报后自动体检、启动清理。

const P = 'p2bbrd_';
const REV = 'a'.repeat(40);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let app: FastifyInstance;
let admin = '';
let operator = '';
let tmp = '';
let savedScope: Awaited<ReturnType<typeof readScopeConfig>> | null = null;
let adminId = '';
const saved: Record<string, string | undefined> = {};

function makeKit(dir: string) {
  const root = join(dir, 'kit-src');
  mkdirSync(join(root, 'runtime/bin'), { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ source_revision: REV }) + '\n');
  writeFileSync(join(root, 'runtime/bin/python3'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(root, 'runtime/bin/python3'), 0o755);
  const tar = join(dir, 'linux-amd64.tar.gz');
  execFileSync('tar', ['czf', tar, '-C', root, '.']);
  return { tar, manifest: join(root, 'manifest.json') };
}

async function cleanup() {
  const rows = await prismaUnscoped.fleetRemoteDeploy.findMany({
    where: { OR: [{ host: { startsWith: '10.4' } }, { host: { endsWith: '.p2bbrd.test' } }] },
    select: { id: true, postureTaskId: true },
  });
  await prismaUnscoped.auditLog.deleteMany({ where: { targetId: { in: rows.map((r) => r.id) } } });
  await prismaUnscoped.fleetRemoteDeploy.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  const taskIds = rows.map((r) => r.postureTaskId).filter((v): v is string => Boolean(v));
  await prismaUnscoped.evalTask.deleteMany({ where: { id: { in: taskIds } } });
  await prismaUnscoped.fleetProbeReport.deleteMany({
    where: { endpoint: { hostname: { startsWith: P } } },
  });
  await prismaUnscoped.fleetEndpoint.deleteMany({ where: { hostname: { startsWith: P } } });
  await prismaUnscoped.fleetEnrollmentCode.deleteMany({
    where: {
      OR: [
        { label: { startsWith: '远程部署 10.4' } },
        { label: { endsWith: '.p2bbrd.test' } },
        { label: { startsWith: P } },
      ],
    },
  });
  await prismaUnscoped.auditLog.deleteMany({ where: { action: 'fleet.remote_deploy.host_key' } });
  await cleanupFixtures(P);
}

const post = (url: string, payload: unknown, token = admin) =>
  app.inject({ method: 'POST', url, headers: bearer(token), payload: payload as object });
const get = (url: string, token = admin) => app.inject({ url, headers: bearer(token) });

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'p2bb-rd-'));
  const kitDir = join(tmp, 'kits');
  mkdirSync(kitDir);
  const built = makeKit(tmp);
  copyFileSync(built.tar, join(kitDir, 'linux-amd64.tar.gz'));
  const tarBuf = readFileSync(built.tar);
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
          sha256: sha(tarBuf),
          bytes: tarBuf.length,
          manifest_sha256: sha(readFileSync(built.manifest)),
        },
      ],
    }),
  );
  const key = join(tmp, 'key.pem');
  const cert = join(tmp, 'cert.pem');
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
      key,
      '-out',
      cert,
      '-days',
      '30',
      '-subj',
      '/CN=jiandun.test',
      '-addext',
      'subjectAltName=DNS:jiandun.test,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
    ],
    { stdio: 'ignore' },
  );
  for (const k of [
    'FLEET_AGENT_ENABLED',
    'FLEET_PUBLIC_BASE_URL',
    'FLEET_TLS_CERT_PEM_PATH',
    'FLEET_KIT_DIR',
    'LSE_PUBLIC_BASE_URL',
    'FLEET_KIT_BASE_URL',
  ]) {
    saved[k] = process.env[k];
  }
  process.env.FLEET_AGENT_ENABLED = 'true';
  process.env.FLEET_PUBLIC_BASE_URL = 'https://jiandun.test:8443';
  process.env.FLEET_TLS_CERT_PEM_PATH = cert;
  process.env.FLEET_KIT_DIR = kitDir;
  process.env.LSE_PUBLIC_BASE_URL = 'https://lse.example';
  delete process.env.FLEET_KIT_BASE_URL;
  app = await buildApp();
  await app.ready();
  await cleanup();
  admin = await adminToken(app);
  operator = await builtinRoleUserToken(app, P, 'operator');
  adminId = (await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;
  savedScope = await readScopeConfig();
  await saveScopeConfig({ entries: ['10.40.0.0/24'], ports: [22], maxHostsPerRun: 16 }, adminId);
});

after(async () => {
  await cleanup();
  if (savedScope) await saveScopeConfig(savedScope, adminId);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('操作员调任何远程部署接口都是 403', async () => {
  assert.equal((await get('/api/fleet/remote-deploys/capability', operator)).statusCode, 403);
  assert.equal((await get('/api/fleet/remote-deploys', operator)).statusCode, 403);
  assert.equal(
    (await post('/api/fleet/remote-deploys', { mode: 'manual', host: '10.40.0.9' }, operator))
      .statusCode,
    403,
  );
  assert.equal(
    (await post('/api/fleet/remote-deploys/host-key', { host: '10.40.0.9', port: 22 }, operator))
      .statusCode,
    403,
  );
});

test('目标不在资产测绘扫描范围：403 REMOTE_DEPLOY_OUT_OF_SCOPE；参数不合法时不回显凭据', async () => {
  const out = await post('/api/fleet/remote-deploys', { mode: 'manual', host: '10.50.0.1' });
  assert.equal(out.statusCode, 403, out.body);
  assert.equal(out.json().error.code, 'REMOTE_DEPLOY_OUT_OF_SCOPE');
  const key = await post('/api/fleet/remote-deploys/host-key', { host: '10.50.0.1', port: 22 });
  assert.equal(key.statusCode, 403, key.body);
  const secret = ['Leak', 'Pw', '9'].join('-');
  const bad = await post('/api/fleet/remote-deploys', {
    mode: 'ssh',
    host: 'a;b',
    username: 'root',
    auth: { type: 'password', password: secret },
    hostKeyFingerprint: 'SHA256:x',
    hostKeyType: 'ssh-ed25519',
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().error.message, /参数不合法：host/);
  assert.ok(!bad.body.includes(secret));
});

test('能力检测：PATH 指向空目录时没有 SSH 客户端，SSH 部署 409', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'p2bb-rd-path-'));
  const path = process.env.PATH;
  process.env.PATH = empty;
  try {
    const cap = await get('/api/fleet/remote-deploys/capability');
    assert.equal(cap.statusCode, 200, cap.body);
    assert.equal(cap.json().ssh, false);
    assert.deepEqual([...cap.json().missing].sort(), [
      'ssh',
      'ssh-add',
      'ssh-agent',
      'ssh-keyscan',
    ]);
    assert.equal(cap.json().oneclick, true);
    const ssh = await post('/api/fleet/remote-deploys', {
      mode: 'ssh',
      host: '10.40.0.9',
      username: 'root',
      auth: { type: 'password', password: 'x' },
      hostKeyFingerprint: 'SHA256:cGj/cqIbfrhMCQoint5WptygiVcsJ0RIn0l/MtnmEaI',
      hostKeyType: 'ssh-ed25519',
    });
    assert.equal(ssh.statusCode, 409, ssh.body);
    assert.equal(ssh.json().error.code, 'REMOTE_DEPLOY_SSH_UNAVAILABLE');
  } finally {
    process.env.PATH = path;
    rmSync(empty, { recursive: true, force: true });
  }
});

test('一键脚本不可用时 409，带不可用原因', async () => {
  const kit = process.env.FLEET_KIT_DIR;
  delete process.env.FLEET_KIT_DIR;
  try {
    const res = await post('/api/fleet/remote-deploys', { mode: 'manual', host: '10.40.0.9' });
    assert.equal(res.statusCode, 409, res.body);
    assert.ok(res.json().error.details.reasons.length > 0);
  } finally {
    process.env.FLEET_KIT_DIR = kit;
  }
});

test('一次性部署命令：下载脚本记时间、脚本字节不变；终端登记后成功并算耗时；上报后自动体检', async () => {
  const res = await post('/api/fleet/remote-deploys', { mode: 'manual', host: '10.40.0.9' });
  assert.equal(res.statusCode, 201, res.body);
  const { item, command } = res.json() as { item: { id: string }; command: string };
  assert.ok(command.includes(`deploy=${item.id}`));
  assert.match(command, /--code 'jdc_/);
  // 与接入页一样先校验脚本 SHA-256；落盘用 mktemp，不用固定文件名
  const shaText = (await app.inject({ url: '/api/fleet/install/linux.sh.sha256' })).body.trim();
  assert.ok(command.includes(`'${shaText}'`) && command.includes('| sha256sum -c -'));
  assert.match(command, /^f=\$\(mktemp \/tmp\/jiandun-probe\.XXXXXX\) && curl -fsSL /);
  assert.ok(!command.includes('/tmp/jiandun-probe.sh'));
  assert.ok(command.endsWith('; rm -f "$f"'));
  const plain = await app.inject({ url: '/api/fleet/install/linux.sh' });
  const withDeploy = await app.inject({ url: `/api/fleet/install/linux.sh?deploy=${item.id}` });
  assert.equal(withDeploy.statusCode, 200);
  assert.equal(sha(withDeploy.rawPayload), sha(plain.rawPayload));
  let row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: item.id } });
  assert.ok(row.scriptFetchedAt);
  const fetchedAt = row.scriptFetchedAt!;
  // 第二次下载不改时间
  await app.inject({ url: `/api/fleet/install/linux.sh?deploy=${item.id}` });
  row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(row.scriptFetchedAt!.toISOString(), fetchedAt.toISOString());

  const endpoint = await prismaUnscoped.fleetEndpoint.create({
    data: {
      publicId: `ep_${randomBytes(10).toString('hex')}`,
      installationId: randomUUID(),
      machineId: `m-${P}`,
      hostname: `${P}host`,
      os: 'linux',
      osUser: 'root',
      capabilities: ['asset_snapshot'],
      tokenHash: sha(randomUUID()),
      enrollmentCodeId: row.enrollmentCodeId,
      tenantId: row.tenantId,
      registeredAt: new Date(fetchedAt.getTime() + 12_000),
    },
  });
  const detail = await get(`/api/fleet/remote-deploys/${item.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().status, 'SUCCEEDED');
  assert.equal(detail.json().endpointId, endpoint.id);
  assert.equal(detail.json().durationMs, 12_000);
  assert.equal(detail.json().withinTarget, true);

  await prismaUnscoped.fleetProbeReport.create({
    data: {
      endpointId: endpoint.id,
      reportId: `pr_${randomBytes(16).toString('hex')}`,
      scannedAt: new Date(),
      status: 'complete',
      assetCount: 1,
      bodyHash: 'h',
      body: sampleReport(),
      tenantId: row.tenantId,
    },
  });
  await onProbeReportStored(endpoint.id);
  row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: item.id } });
  assert.ok(row.firstReportAt);
  assert.ok(row.postureTaskId);
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: row.postureTaskId! } });
  assert.match(task.name, /远程部署后配置体检/);
  // 再次上报不重复体检
  await onProbeReportStored(endpoint.id);
  const again = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(again.postureTaskId, row.postureTaskId);

  const list = await get('/api/fleet/remote-deploys');
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(list.json().items.some((d: { id: string }) => d.id === item.id));
  const audits = await prismaUnscoped.auditLog.findMany({ where: { targetId: item.id } });
  assert.ok(audits.some((a) => a.action === 'fleet.remote_deploy.start'));
  assert.ok(!JSON.stringify(audits).includes('jdc_'), '审计不含接入码');
});

test('启动时把超过 5 分钟还在执行的部署置为失败 INTERRUPTED', async () => {
  const stale = await prisma.fleetRemoteDeploy.create({
    data: {
      mode: 'ssh',
      host: '10.40.0.77',
      username: 'root',
      status: 'INSTALLING',
      createdById: adminId,
    },
  });
  await prisma.$executeRaw`UPDATE "fleet_remote_deploys" SET "updatedAt" = now() - interval '6 minutes' WHERE id = ${stale.id}`;
  const fresh = await prisma.fleetRemoteDeploy.create({
    data: {
      mode: 'ssh',
      host: '10.40.0.78',
      username: 'root',
      status: 'CONNECTING',
      createdById: adminId,
    },
  });
  const second = await buildApp();
  await second.ready();
  await second.close();
  const a = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(a.status, 'FAILED');
  assert.equal(a.errorCode, 'INTERRUPTED');
  const b = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: fresh.id } });
  assert.equal(b.status, 'CONNECTING');
});

const FP = 'SHA256:cGj/cqIbfrhMCQoint5WptygiVcsJ0RIn0l/MtnmEaI';

test('目标写法与范围：前导 0 的 IPv4 400；IPv6 字面量 403；主机名有一个地址（含 AAAA）不在范围内就 403', async () => {
  const scanned: string[] = [];
  const opened: string[] = [];
  const done: Promise<void>[] = [];
  const shell: RemoteShell = {
    async scanHostKey(host) {
      scanned.push(host);
      return { type: 'ssh-ed25519', fingerprint: FP, line: `${host} ssh-ed25519 AAAA` };
    },
    async open(target) {
      opened.push(target.host);
      return {
        async exec(command) {
          return command.includes('cat >')
            ? { code: 0, stdout: '/tmp/jiandun-rd.Ab12Cd\n', stderr: '' }
            : { code: 1, stdout: '', stderr: 'fake' };
        },
        async close() {},
      };
    },
  };
  const dns: Record<string, Array<{ address: string; family: number }>> = {
    'dual.p2bbrd.test': [
      { address: '10.40.0.5', family: 4 },
      { address: 'fd00::5', family: 6 },
    ],
    'only4.p2bbrd.test': [{ address: '10.40.0.6', family: 4 }],
  };
  const second = await buildApp({
    remoteDeploy: {
      shell,
      lookup: async (host) => dns[host] ?? [],
      onDeployStarted: (_id, p) => void done.push(p),
    },
  });
  await second.ready();
  const call = (url: string, payload: unknown) =>
    second.inject({ method: 'POST', url, headers: bearer(admin), payload: payload as object });
  try {
    for (const host of ['10.40.010.5', '0x0a.40.0.5', '012.40.0.5']) {
      const res = await call('/api/fleet/remote-deploys/host-key', { host, port: 22 });
      assert.equal(res.statusCode, 400, `${host} ${res.body}`);
    }
    for (const host of ['::1', '::ffff:10.40.0.5', 'dual.p2bbrd.test']) {
      const res = await call('/api/fleet/remote-deploys/host-key', { host, port: 22 });
      assert.equal(res.statusCode, 403, `${host} ${res.body}`);
    }
    const missing = await call('/api/fleet/remote-deploys/host-key', {
      host: 'nx.p2bbrd.test',
      port: 22,
    });
    assert.equal(missing.statusCode, 400, missing.body);
    assert.equal(missing.json().error.code, 'REMOTE_DEPLOY_HOST_UNRESOLVED');
    assert.deepEqual(scanned, [], '不在范围内的一个都没去扫');

    // 主机名解析一次：扫指纹、连接都用解析出的 IP；取指纹写审计
    const key = await call('/api/fleet/remote-deploys/host-key', {
      host: 'only4.p2bbrd.test',
      port: 22,
    });
    assert.equal(key.statusCode, 200, key.body);
    assert.deepEqual(scanned, ['10.40.0.6']);
    const audit = await prismaUnscoped.auditLog.findFirst({
      where: { action: 'fleet.remote_deploy.host_key' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal((audit?.detail as Record<string, unknown>).address, '10.40.0.6');
    const ssh = await call('/api/fleet/remote-deploys', {
      mode: 'ssh',
      host: 'only4.p2bbrd.test',
      username: 'root',
      auth: { type: 'password', password: 'x' },
      hostKeyFingerprint: FP,
      hostKeyType: 'ssh-ed25519',
    });
    assert.equal(ssh.statusCode, 202, ssh.body);
    await Promise.allSettled(done);
    assert.deepEqual(opened, ['10.40.0.6']);
    assert.ok(scanned.every((h) => h === '10.40.0.6'));
  } finally {
    await Promise.allSettled(done);
    await second.close();
  }
});

test('每个租户同时进行的 SSH 部署最多 5 个，超出 429', async () => {
  const busy = await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      prisma.fleetRemoteDeploy.create({
        data: {
          mode: 'ssh',
          tenantId: PLATFORM_TENANT_ID,
          host: `10.40.0.${100 + i}`,
          username: 'root',
          status: 'INSTALLING',
          createdById: adminId,
        },
      }),
    ),
  );
  try {
    const res = await post('/api/fleet/remote-deploys', {
      mode: 'ssh',
      host: '10.40.0.9',
      username: 'root',
      auth: { type: 'password', password: 'x' },
      hostKeyFingerprint: FP,
      hostKeyType: 'ssh-ed25519',
    });
    assert.equal(res.statusCode, 429, res.body);
    assert.equal(res.json().error.code, 'REMOTE_DEPLOY_TOO_MANY');
  } finally {
    await prisma.fleetRemoteDeploy.deleteMany({ where: { id: { in: busy.map((b) => b.id) } } });
  }
});

test('周期清理：停在执行中的部署置为部署中断并吊销接入码；过期没执行的一次性命令置为已过期', async () => {
  const code = (label: string, expiresAt: Date) =>
    prisma.fleetEnrollmentCode.create({
      data: {
        label: `${P}${label}`,
        codeHash: sha(randomUUID()),
        codePrefix: 'jdc_test',
        maxUses: 1,
        expiresAt,
        createdById: adminId,
      },
    });
  const sshCode = await code('ssh', new Date(Date.now() + 10 * 60_000));
  const stale = await prisma.fleetRemoteDeploy.create({
    data: {
      mode: 'ssh',
      host: '10.40.0.81',
      username: 'root',
      status: 'CONNECTING',
      enrollmentCodeId: sshCode.id,
      createdById: adminId,
    },
  });
  await prisma.$executeRaw`UPDATE "fleet_remote_deploys" SET "updatedAt" = now() - interval '6 minutes' WHERE id = ${stale.id}`;
  const expiredCode = await code('manual', new Date(Date.now() - 60_000));
  const manual = await prisma.fleetRemoteDeploy.create({
    data: {
      mode: 'manual',
      host: '10.40.0.82',
      status: 'PENDING',
      enrollmentCodeId: expiredCode.id,
      createdById: adminId,
    },
  });
  const liveCode = await code('live', new Date(Date.now() + 60_000));
  const waiting = await prisma.fleetRemoteDeploy.create({
    data: {
      mode: 'manual',
      host: '10.40.0.83',
      status: 'PENDING',
      enrollmentCodeId: liveCode.id,
      createdById: adminId,
    },
  });
  await sweepRemoteDeploys();
  const a = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(a.status, 'FAILED');
  assert.equal(a.errorCode, 'INTERRUPTED');
  assert.match(a.errorMessage ?? '', /部署中断/);
  const revoked = await prisma.fleetEnrollmentCode.findUniqueOrThrow({ where: { id: sshCode.id } });
  assert.equal(revoked.status, 'REVOKED');
  const b = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: manual.id } });
  assert.equal(b.status, 'EXPIRED');
  const c = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: waiting.id } });
  assert.equal(c.status, 'PENDING', '接入码还没过期的不动');
});
