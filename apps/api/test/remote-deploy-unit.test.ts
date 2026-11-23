import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostInScope } from '../src/modules/asset-discovery/ranges.js';
import {
  validDeployHost,
  validSshUsername,
} from '../src/modules/fleet-admin/remote-deploy/host.js';
import { scriptWithCode, sshFailure } from '../src/modules/fleet-admin/remote-deploy/runner.js';
import {
  buildSshArgs,
  cleanupStaleSshDirs,
  fingerprintOfKeyLine,
  pickHostKey,
  SSH_DIR_PREFIX,
  sshCapability,
  sshEnv,
} from '../src/modules/fleet-admin/remote-deploy/system-ssh.js';

// B-9 远程部署（2.4.8）：目标校验、主机指纹、ssh 参数、扫描范围、能力检测。

// home 上 `ssh-keygen -t ed25519 -N '' -f /tmp/rdk` 生成的公钥，指纹取自 `ssh-keygen -lf /tmp/rdk.pub`（私钥已删）。
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIS6+s+55r/eiJ0QnM/m0WA1x9njC81HJQZF4I1Kmkty';
const FP = 'SHA256:cGj/cqIbfrhMCQoint5WptygiVcsJ0RIn0l/MtnmEaI';

test('目标主机、用户名校验：拒绝参数注入和多余字符', () => {
  for (const ok of ['10.0.0.1', 'srv-1.example.com', 'db01', '::1', 'fe80::1']) {
    assert.equal(validDeployHost(ok), true, ok);
  }
  for (const bad of ['-oProxyCommand=x', 'a;b', 'root@x', 'a b', '', 'x'.repeat(254)]) {
    assert.equal(validDeployHost(bad), false, bad);
  }
  // 非标准写法的 IPv4：系统按八进制、十六进制解析成别的地址，一律不收
  for (const bad of ['10.41.010.5', '0177.0.0.1', '0x0a.0.0.1', '167772165', '10.1', '010.0.0.1']) {
    assert.equal(validDeployHost(bad), false, bad);
  }
  for (const ok of ['1password.example.com', 'deadbeef', 'a1.b2']) {
    assert.equal(validDeployHost(ok), true, ok);
  }
  for (const ok of ['root', 'deploy', '_svc', 'ops-01'])
    assert.equal(validSshUsername(ok), true, ok);
  for (const bad of ['-oProxyCommand=x', 'a;b', 'root@x', 'Root', '', 'a'.repeat(33)]) {
    assert.equal(validSshUsername(bad), false, bad);
  }
});

test('主机指纹：与 ssh-keygen -lf 一致；多种密钥时优先 ed25519', () => {
  const fp = fingerprintOfKeyLine(`10.0.0.1 ${PUB}`);
  assert.deepEqual(fp, { type: 'ssh-ed25519', fingerprint: FP, line: `10.0.0.1 ${PUB}` });
  assert.equal(fingerprintOfKeyLine('# 10.0.0.1:22 SSH-2.0-OpenSSH_9.6'), null);
  assert.equal(fingerprintOfKeyLine('10.0.0.1 ssh-ed25519 !!!'), null);
  const rsa = '10.0.0.1 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7';
  const picked = pickHostKey([rsa, `10.0.0.1 ${PUB}`]);
  assert.equal(picked?.type, 'ssh-ed25519');
});

test('ssh 参数：严格校验主机指纹、只信本次的 known_hosts；参数和环境变量名里都没有口令', () => {
  const args = buildSshArgs({
    dir: '/tmp/lse-rd-x',
    host: '10.0.0.1',
    port: 2222,
    username: 'root',
    authType: 'password',
  });
  const text = args.join(' ');
  // 不读运行账号的 SSH 配置、不试默认私钥；口令方式不用公钥和 agent
  assert.deepEqual(args.slice(0, 2), ['-F', '/dev/null']);
  assert.ok(args.includes('IdentityFile=none'));
  assert.ok(args.includes('PubkeyAuthentication=no') && args.includes('IdentityAgent=none'));
  assert.ok(!args.includes('PasswordAuthentication=no'));
  const keyArgs = buildSshArgs({
    dir: '/tmp/lse-rd-x',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'key',
  });
  assert.ok(keyArgs.includes('PasswordAuthentication=no'));
  assert.ok(keyArgs.includes('KbdInteractiveAuthentication=no'));
  assert.ok(
    !keyArgs.includes('PubkeyAuthentication=no') && !keyArgs.includes('IdentityAgent=none'),
  );
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('UserKnownHostsFile=/tmp/lse-rd-x/known_hosts'));
  assert.ok(args.includes('GlobalKnownHostsFile=/dev/null'));
  assert.deepEqual(args.slice(-2), ['--', '10.0.0.1']);
  assert.ok(text.includes('-p 2222') && text.includes('-l root'));
  const secret = ['S3cret', 'Pw'].join('-');
  const env = sshEnv({ type: 'password', password: secret }, '/tmp/lse-rd-x');
  assert.ok(!text.includes(secret));
  assert.ok(Object.keys(env).every((k) => !k.includes(secret)));
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force');
});

test('扫描范围：只比网段不比端口；带前导 0 的写法不按网段判', () => {
  const cfg = { entries: ['10.0.0.0/24', 'db.internal'], ports: [22], maxHostsPerRun: 16 };
  assert.equal(hostInScope('10.0.0.5', cfg), true);
  assert.equal(hostInScope('10.0.0.05', cfg), false);
  assert.equal(hostInScope('010.0.0.5', cfg), false);
  assert.equal(hostInScope('10.0.1.5', cfg), false);
  assert.equal(hostInScope('db.internal', cfg), true);
  assert.equal(hostInScope('other.internal', cfg), false);
});

test('能力检测：PATH 里没有 ssh 相关命令时报告缺哪些', () => {
  const empty = mkdtempSync(join(tmpdir(), 'p2bb-nossh-'));
  try {
    const cap = sshCapability(empty);
    assert.equal(cap.ssh, false);
    assert.deepEqual(cap.missing.sort(), ['ssh', 'ssh-add', 'ssh-agent', 'ssh-keyscan']);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('ssh 失败（退出码 255）按输出细分：拒绝连接、域名解析失败、连接超时、其他', () => {
  assert.equal(
    sshFailure('ssh: connect to host 10.0.0.1 port 22: Connection refused'),
    'CONNECT_REFUSED',
  );
  assert.equal(
    sshFailure('ssh: Could not resolve hostname x.invalid: Name or service not known'),
    'DNS_FAILED',
  );
  assert.equal(
    sshFailure('ssh: connect to host 10.0.0.1 port 22: Connection timed out'),
    'CONNECT_TIMEOUT',
  );
  assert.equal(sshFailure('Host key verification failed.'), 'HOST_KEY_MISMATCH');
  assert.equal(sshFailure('root@10.0.0.1: Permission denied (publickey).'), 'AUTH_FAILED');
  assert.equal(
    sshFailure('kex_exchange_identification: read: Connection reset by peer'),
    'CONNECT_FAILED',
  );
});

test('接入码写进脚本开头的变量，不进命令行', () => {
  const code = 'jdc_' + 'A'.repeat(40);
  assert.equal(
    scriptWithCode('#!/usr/bin/env bash\nset -e\n', code),
    `#!/usr/bin/env bash\nJD_CODE='${code}'\nset -e\n`,
  );
  assert.equal(scriptWithCode('echo hi\n', code), `JD_CODE='${code}'\necho hi\n`);
});

test('启动时清理上次进程留下的临时目录：只删超过时限的', async () => {
  const old = join(tmpdir(), `${SSH_DIR_PREFIX}p2bbold`);
  const fresh = join(tmpdir(), `${SSH_DIR_PREFIX}p2bbnew`);
  mkdirSync(old, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  const past = new Date(Date.now() - 20 * 60_000);
  utimesSync(old, past, past);
  try {
    await cleanupStaleSshDirs(10 * 60_000);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
  } finally {
    rmSync(old, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});
