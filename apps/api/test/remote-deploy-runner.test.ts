import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { prisma, prismaUnscoped } from '../src/db.js';
import {
  runSshDeploy,
  type RemoteAuth,
  type RemoteSession,
  type RemoteShell,
} from '../src/modules/fleet-admin/remote-deploy/runner.js';

// B-9 远程部署执行（2.4.8）：假 RemoteShell，安装命令执行时直接登记一个带该接入码的终端。

const P = '__p2bb_rd_run_';
const FP = 'SHA256:cGj/cqIbfrhMCQoint5WptygiVcsJ0RIn0l/MtnmEaI';
const LINE =
  '10.0.0.8 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIS6+s+55r/eiJ0QnM/m0WA1x9njC81HJQZF4I1Kmkty';
const PASSWORD = ['Deploy', 'Pw', '42'].join('-');
const SUDO = ['Sudo', 'Pw', '42'].join('-');
const KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'abc',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');
let adminId = '';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function cleanup() {
  const deploys = await prismaUnscoped.fleetRemoteDeploy.findMany({
    where: { host: { startsWith: '10.0.0.' }, username: { in: ['root', 'deploy'] } },
    select: { id: true },
  });
  await prismaUnscoped.auditLog.deleteMany({
    where: { targetId: { in: deploys.map((d) => d.id) } },
  });
  await prismaUnscoped.fleetRemoteDeploy.deleteMany({
    where: { id: { in: deploys.map((d) => d.id) } },
  });
  await prismaUnscoped.fleetEndpoint.deleteMany({ where: { hostname: { startsWith: P } } });
  await prismaUnscoped.fleetEnrollmentCode.deleteMany({ where: { label: { startsWith: P } } });
}

before(async () => {
  await cleanup();
  adminId = (await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;
});
after(cleanup);

async function setup(opts: { username?: string; authType?: string; fingerprint?: string } = {}) {
  const code = `jdc_${randomBytes(24).toString('base64url')}`;
  const enrollment = await prisma.fleetEnrollmentCode.create({
    data: {
      label: `${P}code`,
      codeHash: sha(code),
      codePrefix: code.slice(0, 8),
      maxUses: 1,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      createdById: adminId,
    },
  });
  const deploy = await prisma.fleetRemoteDeploy.create({
    data: {
      mode: 'ssh',
      host: '10.0.0.8',
      port: 22,
      username: opts.username ?? 'root',
      authType: opts.authType ?? 'password',
      hostKeyFingerprint: opts.fingerprint ?? FP,
      hostKeyType: 'ssh-ed25519',
      enrollmentCodeId: enrollment.id,
      createdById: adminId,
    },
  });
  return { code, enrollment, deploy };
}

interface Exec {
  command: string;
  stdin: string | null;
}

function fakeShell(opts: {
  code: string;
  enrollmentId: string;
  installCode?: number;
  /** 安装失败前也登记终端（模拟远端超时，但登记那一步已做完） */
  registerOnFail?: boolean;
  scanned?: string[];
  openedHosts?: string[];
  statuses: string[];
  deployId: () => string;
  execs: Exec[];
  opened: { count: number };
}): RemoteShell {
  return {
    async scanHostKey(host) {
      opts.scanned?.push(host);
      const row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({
        where: { id: opts.deployId() },
      });
      opts.statuses.push(row.status);
      return { type: 'ssh-ed25519', fingerprint: FP, line: LINE };
    },
    async open(target, _auth: RemoteAuth): Promise<RemoteSession> {
      opts.opened.count += 1;
      opts.openedHosts?.push(target.host);
      return {
        async exec(command, stdin) {
          opts.execs.push({ command, stdin });
          if (command.includes('cat >')) {
            return { code: 0, stdout: '/tmp/jiandun-rd.Ab12Cd\n', stderr: '' };
          }
          const row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({
            where: { id: opts.deployId() },
          });
          opts.statuses.push(row.status);
          const register = () =>
            prisma.fleetEndpoint.create({
              data: {
                publicId: `ep_${randomBytes(10).toString('hex')}`,
                installationId: randomUUID(),
                machineId: `m-${P}`,
                hostname: `${P}host`,
                os: 'linux',
                osUser: 'root',
                capabilities: [],
                tokenHash: sha(randomUUID()),
                enrollmentCodeId: opts.enrollmentId,
              },
            });
          if ((opts.installCode ?? 0) !== 0) {
            if (opts.registerOnFail) await register();
            return { code: opts.installCode!, stdout: `安装失败 ${opts.code}`, stderr: 'boom' };
          }
          await register();
          return { code: 0, stdout: `接入码 ${opts.code} 已使用，安装完成`, stderr: '' };
        },
        async close() {},
      };
    },
  };
}

test('成功：依次经过连接中、安装中、成功；耗时、终端、吊销接入码、日志打码', async () => {
  const { code, enrollment, deploy } = await setup();
  const statuses: string[] = [];
  const execs: Exec[] = [];
  const opened = { count: 0 };
  await runSshDeploy(
    deploy.id,
    { auth: { type: 'password', password: PASSWORD }, code, script: '#!/bin/bash\necho hi\n' },
    {
      shell: fakeShell({
        code,
        enrollmentId: enrollment.id,
        statuses,
        deployId: () => deploy.id,
        execs,
        opened,
      }),
      waitEndpointMs: 2000,
    },
  );
  const row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: deploy.id } });
  assert.deepEqual(statuses, ['CONNECTING', 'INSTALLING']);
  assert.equal(row.status, 'SUCCEEDED');
  assert.ok(row.installedAt && row.startedAt && row.connectedAt && row.uploadedAt);
  assert.equal(row.durationMs, row.installedAt!.getTime() - row.startedAt!.getTime());
  assert.ok(row.endpointId);
  assert.ok(row.registeredAt);
  const codeRow = await prisma.fleetEnrollmentCode.findUniqueOrThrow({
    where: { id: enrollment.id },
  });
  assert.equal(codeRow.status, 'REVOKED');
  assert.ok(row.log.includes('jdc_****'));
  assert.ok(!row.log.includes(code));
  // 远端命令都交给 sh；上传到 mktemp 建的目录里，接入码写在脚本开头，命令行里没有；
  // 安装用 timeout 包住，装完删临时目录；root 不带 sudo
  assert.match(execs[0]!.command, /^sh -c 'umask 077; d=\$\(mktemp -d \/tmp\/jiandun-rd\.XXXXXX\)/);
  assert.equal(execs[0]!.stdin, `#!/bin/bash\nJD_CODE='${code}'\necho hi\n`);
  assert.match(execs[1]!.command, /^sh -c 'd=/);
  assert.ok(execs[1]!.command.includes('/tmp/jiandun-rd.Ab12Cd'));
  assert.ok(execs[1]!.command.includes('timeout -k 5'));
  assert.ok(execs[1]!.command.includes('rm -rf'));
  assert.ok(!execs[1]!.command.includes('sudo'));
  assert.equal(execs[1]!.stdin, null);
  assert.ok(!execs.some((e) => e.command.includes(code)), '接入码不在任何命令行里');
  const audits = await prismaUnscoped.auditLog.findMany({ where: { targetId: deploy.id } });
  assert.ok(audits.some((a) => a.action === 'fleet.remote_deploy.finish'));
  const dump = JSON.stringify({ row, audits });
  for (const secret of [PASSWORD, code]) assert.ok(!dump.includes(secret), '不含口令和接入码明文');
});

test('主机指纹和确认的不一致：失败 HOST_KEY_MISMATCH，不再连接', async () => {
  const { code, enrollment, deploy } = await setup({ fingerprint: 'SHA256:other' });
  const opened = { count: 0 };
  await runSshDeploy(
    deploy.id,
    { auth: { type: 'password', password: PASSWORD }, code, script: 'x' },
    {
      shell: fakeShell({
        code,
        enrollmentId: enrollment.id,
        statuses: [],
        deployId: () => deploy.id,
        execs: [],
        opened,
      }),
    },
  );
  const row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: deploy.id } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'HOST_KEY_MISMATCH');
  assert.equal(opened.count, 0);
  const codeRow = await prisma.fleetEnrollmentCode.findUniqueOrThrow({
    where: { id: enrollment.id },
  });
  assert.equal(codeRow.status, 'REVOKED');
});

test("非 root 用户：安装命令以 sudo -S -p '' 开头，标准输入是 sudo 口令加换行", async () => {
  const { code, enrollment, deploy } = await setup({ username: 'deploy', authType: 'key' });
  const execs: Exec[] = [];
  await runSshDeploy(
    deploy.id,
    { auth: { type: 'key', privateKey: KEY }, sudoPassword: SUDO, code, script: 'x' },
    {
      shell: fakeShell({
        code,
        enrollmentId: enrollment.id,
        statuses: [],
        deployId: () => deploy.id,
        execs,
        opened: { count: 0 },
      }),
      waitEndpointMs: 2000,
    },
  );
  assert.ok(execs[1]!.command.includes('sudo -S -p '));
  assert.equal(execs[1]!.stdin, `${SUDO}\n`);
  const row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: deploy.id } });
  assert.equal(row.status, 'SUCCEEDED');
  assert.ok(!JSON.stringify(row).includes(SUDO));
  assert.ok(!JSON.stringify(row).includes('PRIVATE KEY'));
});

test('安装脚本退出码非 0：INSTALL_FAILED，接入码仍吊销，日志打码', async () => {
  const { code, enrollment, deploy } = await setup();
  await runSshDeploy(
    deploy.id,
    { auth: { type: 'password', password: PASSWORD }, code, script: 'x' },
    {
      shell: fakeShell({
        code,
        enrollmentId: enrollment.id,
        installCode: 3,
        statuses: [],
        deployId: () => deploy.id,
        execs: [],
        opened: { count: 0 },
      }),
    },
  );
  const row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: deploy.id } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'INSTALL_FAILED');
  assert.ok(row.errorMessage);
  assert.ok(!row.log.includes(code));
  const codeRow = await prisma.fleetEnrollmentCode.findUniqueOrThrow({
    where: { id: enrollment.id },
  });
  assert.equal(codeRow.status, 'REVOKED');
});

test('远端安装超时（timeout 退出码 124），终端已登记：记为完成并提示确认，不显示失败', async () => {
  const { code, enrollment, deploy } = await setup();
  await runSshDeploy(
    deploy.id,
    { auth: { type: 'password', password: PASSWORD }, code, script: 'x' },
    {
      shell: fakeShell({
        code,
        enrollmentId: enrollment.id,
        installCode: 124,
        registerOnFail: true,
        statuses: [],
        deployId: () => deploy.id,
        execs: [],
        opened: { count: 0 },
      }),
    },
  );
  const row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: deploy.id } });
  assert.equal(row.status, 'SUCCEEDED');
  assert.equal(row.errorCode, 'TIMEOUT_REGISTERED');
  assert.ok(row.endpointId);
  assert.match(row.errorMessage ?? '', /终端已登记/);
});

test('远端安装超时、终端没登记：DEPLOY_TIMEOUT', async () => {
  const { code, enrollment, deploy } = await setup();
  await runSshDeploy(
    deploy.id,
    { auth: { type: 'password', password: PASSWORD }, code, script: 'x' },
    {
      shell: fakeShell({
        code,
        enrollmentId: enrollment.id,
        installCode: 124,
        statuses: [],
        deployId: () => deploy.id,
        execs: [],
        opened: { count: 0 },
      }),
    },
  );
  const row = await prisma.fleetRemoteDeploy.findUniqueOrThrow({ where: { id: deploy.id } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'DEPLOY_TIMEOUT');
});

test('扫指纹和连接都用解析并校验过的 IP，不再按主机名解析', async () => {
  const { code, enrollment, deploy } = await setup();
  const scanned: string[] = [];
  const openedHosts: string[] = [];
  await runSshDeploy(
    deploy.id,
    { auth: { type: 'password', password: PASSWORD }, code, script: 'x', address: '10.0.0.9' },
    {
      shell: fakeShell({
        code,
        enrollmentId: enrollment.id,
        statuses: [],
        deployId: () => deploy.id,
        execs: [],
        opened: { count: 0 },
        scanned,
        openedHosts,
      }),
      waitEndpointMs: 2000,
    },
  );
  assert.deepEqual(scanned, ['10.0.0.9']);
  assert.deepEqual(openedHosts, ['10.0.0.9']);
});
