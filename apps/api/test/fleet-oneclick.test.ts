// 一键安装：探针包托管、脚本生成、脚本分支（假 kit + 桩安装器，不需要 root）。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PRODUCT_NAME } from '../src/lib/product-name.js';
import { shanghaiDay } from '../src/lib/platform-stats.js';

const run = promisify(execFile);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const REV = 'a'.repeat(40);

let app: FastifyInstance;
let adminJwt = '';
let tmp = '';
let kitDir = '';
let baseUrl = '';
let tarSha = '';
let manifestSha = '';
let tarBytes = 0;
let certSha = '';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const STUB_PY = `#!/bin/bash
# 桩 python3：只记录参数，不真正安装
echo "ARGS: $*" >> "$JD_TEST_LOG"
prev=""
for a in "$@"; do
  if [ "$prev" = "--token-file" ]; then echo "TOKEN: $(cat "$a") MODE: $(stat -c %a "$a")" >> "$JD_TEST_LOG"; fi
  if [ "$prev" = "--tls-config" ]; then echo "TLS: $(tr -d '\\n' < "$a")" >> "$JD_TEST_LOG"; fi
  prev="$a"
done
if [ -n "\${STUB_FAIL:-}" ]; then echo "$STUB_FAIL" >&2; exit 1; fi
exit 0
`;
const STUB_SYSTEMCTL = `#!/bin/bash
echo "SYSTEMCTL: $*" >> "$JD_TEST_LOG"
if [ "\${STUB_INACTIVE:-}" = "1" ] && [ "$1" = "is-active" ]; then exit 3; fi
exit 0
`;

function makeKit(dir: string) {
  const root = join(dir, 'kit-src');
  mkdirSync(join(root, 'runtime/bin'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ source_revision: REV }) + '\n');
  writeFileSync(join(root, 'manifest.sig'), 'sig');
  writeFileSync(join(root, 'runtime/bin/python3'), STUB_PY);
  chmodSync(join(root, 'runtime/bin/python3'), 0o755);
  writeFileSync(join(root, 'tools/install-enterprise-linux.py'), '# stub\n');
  const tar = join(dir, 'linux-amd64.tar.gz');
  execFileSync('tar', ['czf', tar, '-C', root, '.']);
  return { tar, manifest: join(root, 'manifest.json') };
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'fleet-oneclick-'));
  kitDir = join(tmp, 'kits');
  mkdirSync(kitDir);
  const built = makeKit(tmp);
  copyFileSync(built.tar, join(kitDir, 'linux-amd64.tar.gz'));
  const tarBuf = readFileSync(built.tar);
  tarSha = sha(tarBuf);
  tarBytes = tarBuf.length;
  manifestSha = sha(readFileSync(built.manifest));
  writeFileSync(join(kitDir, 'windows-amd64.zip'), 'zip');
  writeFileSync(join(kitDir, 'secret.txt'), 'do not serve');
  writeFileSync(
    join(kitDir, 'catalog.json'),
    JSON.stringify({
      source_revision: REV,
      items: [
        {
          target: 'linux-amd64', os: 'linux', arch: 'amd64', version: REV,
          filename: 'linux-amd64.tar.gz', sha256: tarSha, bytes: tarBytes, manifest_sha256: manifestSha,
        },
        {
          // 文件不存在：只应产生告警
          target: 'linux-arm64', os: 'linux', arch: 'arm64', version: REV,
          filename: 'linux-arm64.tar.gz', sha256: 'b'.repeat(64), manifest_sha256: 'c'.repeat(64),
        },
        {
          target: 'windows-amd64', os: 'windows', arch: 'amd64', version: REV,
          filename: 'windows-amd64.zip', sha256: sha('zip'), manifest_sha256: 'd'.repeat(64),
        },
      ],
    }),
  );

  const key = join(tmp, 'key.pem');
  const cert = join(tmp, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=jiandun.test',
      '-addext', 'subjectAltName=DNS:jiandun.test,IP:127.0.0.1',
      '-addext', 'basicConstraints=critical,CA:FALSE',
    ],
    { stdio: 'ignore' },
  );
  certSha = sha(execFileSync('openssl', ['x509', '-in', cert, '-outform', 'DER']));

  process.env.FLEET_AGENT_ENABLED = 'true';
  process.env.FLEET_PUBLIC_BASE_URL = 'https://jiandun.test:8443';
  process.env.FLEET_TLS_CERT_PEM_PATH = cert;
  process.env.FLEET_KIT_DIR = kitDir;
  process.env.LSE_PUBLIC_BASE_URL = 'https://lse.example';
  delete process.env.FLEET_KIT_BASE_URL;
  app = await buildApp();
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  assert.ok(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200, login.body);
  adminJwt = login.json().token;
});

after(async () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await app.close();
  await prisma.$disconnect();
});

// ───────────────────────── 探针包下载 ─────────────────────────

test('kits 下载：catalog 内文件带 content-length 返回，且无需登录', async () => {
  const res = await app.inject({ url: '/api/fleet/kits/linux-amd64.tar.gz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-length'], String(tarBytes));
  assert.equal(sha(res.rawPayload), tarSha);
  assert.match(String(res.headers['content-disposition']), /linux-amd64\.tar\.gz/);
});

test('kits 下载：同一 IP 同一文件 30 分钟内只计一次，换 IP 再计；404 和 HEAD 不计', async () => {
  const downloads = async () =>
    (await prisma.platformDailyStat.findUnique({ where: { date: shanghaiDay() } }))?.downloads ?? 0;
  const ip = () => `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;
  const kit = (
    remoteAddress: string,
    method: 'GET' | 'HEAD' = 'GET',
    file = 'linux-amd64.tar.gz',
  ) => app.inject({ method, url: `/api/fleet/kits/${file}`, remoteAddress });
  const first = ip();
  const before = await downloads();
  assert.equal((await kit(first)).statusCode, 200);
  assert.equal(await downloads(), before + 1);
  assert.equal((await kit(first)).statusCode, 200);
  assert.equal(await downloads(), before + 1, '同一 IP 重复下载不重复计');
  assert.equal((await kit(ip())).statusCode, 200);
  assert.equal(await downloads(), before + 2);
  assert.equal((await kit(ip(), 'GET', 'nope.tar.gz')).statusCode, 404);
  assert.equal(await downloads(), before + 2);
  assert.equal((await kit(ip(), 'HEAD')).statusCode, 200);
  assert.equal(await downloads(), before + 2, 'HEAD 请求不算下载');
});

test('kits 下载：路径穿越、未列出文件、非一键目标、文件缺失一律 404', async () => {
  const urls = [
    '/api/fleet/kits/..%2Fcatalog.json',
    '/api/fleet/kits/..%2F..%2Fetc%2Fpasswd',
    '/api/fleet/kits/%2e%2e%2fcatalog.json',
    '/api/fleet/kits/catalog.json', // 目录里存在但不在 catalog 条目里
    '/api/fleet/kits/secret.txt',
    '/api/fleet/kits/windows-amd64.zip', // 在 catalog 里但不提供一键脚本
    '/api/fleet/kits/linux-arm64.tar.gz', // 在 catalog 里但文件不存在
    '/api/fleet/kits/nope.tar.gz',
    '/api/fleet/kits/linux-amd64.tar.gz%00.png',
  ];
  for (const url of urls) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 404, `${url} -> ${res.statusCode}`);
    assert.ok(!res.body.includes('do not serve'));
  }
});

test('开关关闭时 kits / 脚本 / 脚本散列 / deployment-info 全部 404', async () => {
  process.env.FLEET_AGENT_ENABLED = 'false';
  try {
    for (const url of [
      '/api/fleet/kits/linux-amd64.tar.gz',
      '/api/fleet/install/linux.sh',
      '/api/fleet/install/linux.sh.sha256',
      '/api/fleet/deployment-info',
    ]) {
      assert.equal(
        (await app.inject({ url, headers: bearer(adminJwt) })).statusCode,
        404,
        url,
      );
    }
  } finally {
    process.env.FLEET_AGENT_ENABLED = 'true';
  }
});

// ───────────────────────── 脚本生成 ─────────────────────────

test('脚本生成：写死服务端、证书指纹、包散列与下载地址；无需登录', async () => {
  const res = await app.inject({ url: '/api/fleet/install/linux.sh' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/x-shellscript/);
  const s = res.body;
  assert.match(s, /^#!\/usr\/bin\/env bash/);
  assert.ok(s.includes("SERVER='https://jiandun.test:8443'"));
  assert.ok(s.includes(`CERT_SHA256='${certSha}'`));
  assert.ok(s.includes(`KIT_SHA256='${tarSha}'`));
  assert.ok(s.includes(`MANIFEST_SHA256='${manifestSha}'`));
  assert.ok(s.includes(`KIT_VERSION='${REV}'`));
  assert.ok(s.includes("KIT_URL='https://lse.example/api/fleet/kits/linux-amd64.tar.gz'"));
  // 文件缺失的 arm64 不会被写进脚本
  assert.ok(!s.includes('linux-arm64.tar.gz'));
  // 证书 PEM 在写入 tls-deployment.json 的片段里
  assert.ok(s.includes('"tls_server_cert_pem": "-----BEGIN CERTIFICATE-----'));
  assert.ok(s.includes(`"tls_server_cert_sha256": "${certSha}"`));
  assert.ok(!s.includes('PRIVATE KEY'));
  assert.ok(!s.includes('@@'), '占位符必须全部替换');
  assert.ok(s.includes(`PRODUCT='${PRODUCT_NAME}'`));
});

test('脚本生成：语法检查通过（bash -n）', async () => {
  const s = (await app.inject({ url: '/api/fleet/install/linux.sh' })).body;
  const f = join(tmp, 'syntax.sh');
  writeFileSync(f, s);
  execFileSync('bash', ['-n', f]);
});

test('脚本稳定：同配置两次生成 sha 相同，且与 .sha256 接口、deployment-info 一致', async () => {
  const a = (await app.inject({ url: '/api/fleet/install/linux.sh' })).body;
  await new Promise((r) => setTimeout(r, 1100));
  const b = (await app.inject({ url: '/api/fleet/install/linux.sh' })).body;
  assert.equal(a, b);
  const h = await app.inject({ url: '/api/fleet/install/linux.sh.sha256' });
  assert.equal(h.statusCode, 200);
  assert.equal(h.body.trim(), sha(a));
  const info = (await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) })).json();
  assert.equal(info.oneclick.available, true);
  assert.equal(info.oneclick.scriptSha256, sha(a));
  assert.equal(info.oneclick.scriptUrl, 'https://lse.example/api/fleet/install/linux.sh');
  assert.equal(info.oneclick.scriptFile, '/tmp/jiandun-probe.sh');
  const targets = Object.fromEntries(info.oneclick.targets.map((t: any) => [t.target, t]));
  assert.equal(targets['linux-amd64'].status, 'ok');
  assert.equal(targets['linux-arm64'].status, 'missing');
  assert.equal(targets['windows-amd64'].oneclick, false);
  assert.equal(targets['windows-amd64'].status, 'not_supported');
});

test('地址优先级：FLEET_KIT_BASE_URL 覆盖 LSE_PUBLIC_BASE_URL；都没配时取请求地址；改配置后 sha 变化', async () => {
  const before = (await app.inject({ url: '/api/fleet/install/linux.sh' })).body;
  process.env.FLEET_KIT_BASE_URL = 'http://10.1.2.3:8080/';
  try {
    const s = (await app.inject({ url: '/api/fleet/install/linux.sh' })).body;
    assert.ok(s.includes("KIT_URL='http://10.1.2.3:8080/api/fleet/kits/linux-amd64.tar.gz'"));
    assert.notEqual(sha(s), sha(before));
    delete process.env.FLEET_KIT_BASE_URL;
    const saved = process.env.LSE_PUBLIC_BASE_URL;
    delete process.env.LSE_PUBLIC_BASE_URL;
    try {
      const s2 = (
        await app.inject({ url: '/api/fleet/install/linux.sh', headers: { host: 'lse.lan:8090' } })
      ).body;
      assert.ok(s2.includes("KIT_URL='http://lse.lan:8090/api/fleet/kits/linux-amd64.tar.gz'"));
    } finally {
      process.env.LSE_PUBLIC_BASE_URL = saved;
    }
  } finally {
    delete process.env.FLEET_KIT_BASE_URL;
  }
});

test('脚本生成：未就绪（无证书 / 无 kit）返回 404，不泄露半成品', async () => {
  const cert = process.env.FLEET_TLS_CERT_PEM_PATH;
  delete process.env.FLEET_TLS_CERT_PEM_PATH;
  try {
    assert.equal((await app.inject({ url: '/api/fleet/install/linux.sh' })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/fleet/install/linux.sh.sha256' })).statusCode, 404);
  } finally {
    process.env.FLEET_TLS_CERT_PEM_PATH = cert;
  }
  const dir = process.env.FLEET_KIT_DIR;
  delete process.env.FLEET_KIT_DIR;
  try {
    assert.equal((await app.inject({ url: '/api/fleet/install/linux.sh' })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/fleet/kits/linux-amd64.tar.gz' })).statusCode, 404);
  } finally {
    process.env.FLEET_KIT_DIR = dir;
  }
});

// ───────────────────────── deployment-info 的 kit 告警 ─────────────────────────

test('deployment-info：kit 状态只进 warnings，不影响 ready', async () => {
  const get = async () =>
    (await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) })).json();
  let info = await get();
  assert.equal(info.ready, true);
  assert.ok(info.warnings.some((w: string) => w.includes('linux-arm64.tar.gz') && w.includes('不存在')));

  // 目录未配置
  const dir = process.env.FLEET_KIT_DIR;
  delete process.env.FLEET_KIT_DIR;
  info = await get();
  assert.equal(info.ready, true);
  assert.ok(info.warnings.some((w: string) => w.includes('FLEET_KIT_DIR')));
  assert.equal(info.oneclick.available, false);

  // 缺 catalog
  const empty = join(tmp, 'empty');
  mkdirSync(empty);
  process.env.FLEET_KIT_DIR = empty;
  info = await get();
  assert.equal(info.ready, true);
  assert.ok(info.warnings.some((w: string) => w.includes('catalog.json')));

  // sha 不符
  const bad = join(tmp, 'bad');
  mkdirSync(bad);
  copyFileSync(join(dir!, 'catalog.json'), join(bad, 'catalog.json'));
  writeFileSync(join(bad, 'linux-amd64.tar.gz'), 'tampered');
  process.env.FLEET_KIT_DIR = bad;
  info = await get();
  assert.equal(info.ready, true);
  assert.ok(info.warnings.some((w: string) => w.includes('SHA-256') || w.includes('大小')));
  assert.equal(info.oneclick.available, false);
  assert.equal((await app.inject({ url: '/api/fleet/install/linux.sh' })).statusCode, 404);

  // catalog 过大 / 字段非法
  const huge = join(tmp, 'huge');
  mkdirSync(huge);
  writeFileSync(join(huge, 'catalog.json'), ' '.repeat(300 * 1024));
  process.env.FLEET_KIT_DIR = huge;
  info = await get();
  assert.ok(info.warnings.some((w: string) => w.includes('超过')));
  const junk = join(tmp, 'junk');
  mkdirSync(junk);
  writeFileSync(
    join(junk, 'catalog.json'),
    JSON.stringify({
      items: [
        { target: 'linux-amd64', os: 'linux', arch: 'amd64', version: REV, filename: '../x.tar.gz', sha256: 'a'.repeat(64), manifest_sha256: 'a'.repeat(64) },
        { target: 'linux-arm64', os: 'linux', arch: 'arm64', version: REV, filename: 'a.tar.gz', sha256: 'xyz', manifest_sha256: 'a'.repeat(64) },
      ],
    }),
  );
  process.env.FLEET_KIT_DIR = junk;
  info = await get();
  assert.equal(info.ready, true);
  assert.ok(info.warnings.filter((w: string) => w.includes('已忽略')).length >= 2);
  assert.equal(info.oneclick.targets.length, 0);

  process.env.FLEET_KIT_DIR = dir;
});

// ───────────────────────── 脚本分支（假 kit + 桩安装器） ─────────────────────────

interface Sandbox {
  root: string;
  stage: string;
  state: string;
  base: string;
  log: string;
  script: string;
}

async function sandbox(): Promise<Sandbox> {
  const root = mkdtempSync(join(tmp, 'sb-'));
  const sb: Sandbox = {
    root,
    stage: join(root, 'stage'),
    state: join(root, 'state'),
    base: join(root, 'base'),
    log: join(root, 'log.txt'),
    script: join(root, 'probe.sh'),
  };
  mkdirSync(sb.state);
  writeFileSync(sb.log, '');
  writeFileSync(join(root, 'systemctl'), STUB_SYSTEMCTL);
  chmodSync(join(root, 'systemctl'), 0o755);
  process.env.FLEET_KIT_BASE_URL = baseUrl;
  try {
    const res = await app.inject({ url: '/api/fleet/install/linux.sh' });
    assert.equal(res.statusCode, 200);
    writeFileSync(sb.script, res.body);
  } finally {
    delete process.env.FLEET_KIT_BASE_URL;
  }
  return sb;
}

async function runScript(
  sb: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string; log: string }> {
  try {
    const r = await run('setsid', ['-w', 'bash', sb.script, ...args], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        JD_TEST_MODE: '1',
        JD_TEST_ARCH: 'x86_64',
        JD_TEST_STAGE_ROOT: sb.stage,
        JD_TEST_STATE_DIR: sb.state,
        JD_TEST_BASE_DIR: sb.base,
        JD_TEST_UNIT_FILE: join(sb.root, 'unit'),
        JD_TEST_EVAL_REGISTRY: join(sb.root, 'eval-registry.json'),
        JD_TEST_SYSTEMCTL: join(sb.root, 'systemctl'),
        JD_TEST_LOG: sb.log,
        ...env,
      },
      timeout: 60_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr, log: readFileSync(sb.log, 'utf8') };
  } catch (e: any) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      out: String(e.stdout ?? ''),
      err: String(e.stderr ?? ''),
      log: readFileSync(sb.log, 'utf8'),
    };
  }
}

const CODE = 'jdc_TESTCODE_abcdefghijklmnopqrstuvwxyz0123456789';

function assertCleaned(sb: Sandbox) {
  const left = existsSync(sb.stage) ? readdirSync(sb.stage) : [];
  assert.deepEqual(left, [], `暂存目录应被清理：${left.join(',')}`);
}

test('脚本分支：全新接入 + 开测评；接入码不进参数，只在 0600 文件里，用完删除', async () => {
  const sb = await sandbox();
  const r = await runScript(sb, ['--code', CODE, '--enable-eval']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(r.out.includes('接入成功'));
  assert.ok(r.out.includes('真机测评：已开启'));
  assert.ok(r.out.includes('https://jiandun.test:8443'));
  const args = r.log.split('\n').filter((l) => l.startsWith('ARGS:'));
  const install = args.find((l) => l.includes(' install '))!;
  assert.ok(install, r.log);
  assert.ok(install.includes('--server-kind jiandun'));
  assert.ok(install.includes('--server https://jiandun.test:8443'));
  assert.ok(install.includes(`--manifest-sha256 ${manifestSha}`));
  assert.ok(install.includes('--tls-config'));
  assert.ok(install.includes('--token-file'));
  assert.ok(install.includes('-I -B'));
  assert.ok(!r.log.split('\n').filter((l) => l.startsWith('ARGS:')).join('\n').includes(CODE), '接入码不得出现在参数里');
  assert.ok(!r.out.includes(CODE) && !r.err.includes(CODE));
  assert.match(r.log, new RegExp(`TOKEN: ${CODE} MODE: 600`));
  assert.match(r.log, /TLS: .*"server": "https:\/\/jiandun\.test:8443"/);
  assert.ok(r.log.includes(`"tls_server_cert_sha256": "${certSha}"`));
  assert.ok(args.some((l) => l.includes('platform-collector.py') && l.includes('set-eval-enabled on')));
  assert.ok(r.log.indexOf('SYSTEMCTL: stop') < r.log.indexOf('set-eval-enabled'));
  assert.ok(r.log.indexOf('set-eval-enabled') < r.log.lastIndexOf('SYSTEMCTL: start'));
  assert.ok(!args.some((l) => l.includes(' unbind')));
  assertCleaned(sb);
});

test('脚本分支：不带 --enable-eval 不动测评开关', async () => {
  const sb = await sandbox();
  const r = await runScript(sb, [], { JD_CODE: CODE });
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(r.out.includes('真机测评：未开启'));
  assert.ok(!r.log.includes('set-eval-enabled'));
  assert.ok(!r.log.includes('SYSTEMCTL: stop'));
  assertCleaned(sb);
});

test('脚本分支：已绑定智能体安全平台且不带 --switch：报错提示，什么都不装', async () => {
  const sb = await sandbox();
  writeFileSync(
    join(sb.state, 'endpoint.json'),
    JSON.stringify({ server: 'https://agentshield.example', server_kind: 'agentshield' }),
  );
  const r = await runScript(sb, ['--code', CODE]);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('--switch'));
  assert.ok(r.err.includes('智能体安全平台'));
  assert.ok(!r.log.includes('ARGS:'), '不应调用任何安装器');
  assertCleaned(sb);
});

test('脚本分支：--switch 先 unbind 再 install', async () => {
  const sb = await sandbox();
  writeFileSync(join(sb.state, 'endpoint.json'), JSON.stringify({ server: 'https://a.example' }));
  const r = await runScript(sb, ['--code', CODE, '--switch']);
  assert.equal(r.code, 0, r.err + r.out);
  const args = r.log.split('\n').filter((l) => l.startsWith('ARGS:'));
  const iu = args.findIndex((l) => l.endsWith(' unbind'));
  const ii = args.findIndex((l) => l.includes(' install '));
  assert.ok(iu >= 0 && ii > iu, r.log);
  assertCleaned(sb);
});

test('脚本分支：本机已是同一鉴盾服务端 → 走 upgrade，不需要接入码', async () => {
  const sb = await sandbox();
  writeFileSync(
    join(sb.state, 'endpoint.json'),
    JSON.stringify({ server: 'https://jiandun.test:8443', server_kind: 'jiandun' }),
  );
  const r = await runScript(sb, []);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(r.out.includes('升级完成'));
  const args = r.log.split('\n').filter((l) => l.startsWith('ARGS:'));
  assert.ok(args.some((l) => l.includes(' upgrade ') && l.includes(`--manifest-sha256 ${manifestSha}`)));
  assert.ok(!args.some((l) => l.includes(' install ')));
  assertCleaned(sb);
});

test('脚本分支：缺接入码 / 前缀不对 / 未知参数 → 中文报错', async () => {
  const sb = await sandbox();
  let r = await runScript(sb, []);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('缺少接入码'));
  r = await runScript(sb, ['--code', 'abc123']);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('jdc_'));
  r = await runScript(sb, ['--bogus']);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('未知参数'));
  assert.ok(!r.log.includes('ARGS:'));
  assertCleaned(sb);
});

test('脚本分支：包 sha256 / manifest sha256 被篡改 → 中止，不调用安装器', async () => {
  for (const key of ['KIT_SHA256', 'MANIFEST_SHA256']) {
    const sb = await sandbox();
    const s = readFileSync(sb.script, 'utf8');
    const re = new RegExp(`^(\\s*${key}=)'[0-9a-f]{64}'`, 'm');
    assert.match(s, re);
    writeFileSync(sb.script, s.replace(re, `$1'${'0'.repeat(64)}'`));
    const r = await runScript(sb, ['--code', CODE]);
    assert.notEqual(r.code, 0, key);
    assert.ok(r.err.includes('SHA-256'), r.err);
    assert.ok(!r.log.includes('install-enterprise-linux.py'), '校验失败不能执行包里的代码');
    assertCleaned(sb);
  }
});

test('脚本分支：下载失败 → 中文报错', async () => {
  const sb = await sandbox();
  const s = readFileSync(sb.script, 'utf8');
  writeFileSync(sb.script, s.replace(baseUrl, 'http://127.0.0.1:9'));
  const r = await runScript(sb, ['--code', CODE]);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('下载探针包失败'));
  assertCleaned(sb);
});

test('脚本分支：安装器登记失败 → 中文原因，接入码文件已删除', async () => {
  const sb = await sandbox();
  const r = await runScript(sb, ['--code', CODE], { STUB_FAIL: 'Linux collector operation failed: enrollment failed; inspect retained state before retrying' });
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('登记终端失败'));
  assert.ok(r.err.includes('接入码'));
  assert.ok(!r.err.includes(CODE));
  assertCleaned(sb);
});

test('脚本分支：采集服务未运行 → 提示并以非 0 退出', async () => {
  const sb = await sandbox();
  const r = await runScript(sb, ['--code', CODE], { STUB_INACTIVE: '1' });
  assert.notEqual(r.code, 0);
  assert.ok(r.out.includes('采集服务：未运行'));
});

test('脚本不依赖 curl/tar/sha256sum/systemctl/install/mktemp 之外的非常见工具', async () => {
  const s = (await app.inject({ url: '/api/fleet/install/linux.sh' })).body;
  // 逐行取每条命令的首词，排除 bash 内建 / 关键字 / 函数 / 变量赋值。
  const allowed = new Set([
    'curl', 'tar', 'sha256sum', 'systemctl', 'install', 'mktemp',
    // 通用基础命令
    'rm', 'chmod', 'chown', 'cat', 'grep', 'sed', 'head', 'tr', 'stat', 'dirname', 'id', 'uname',
    'printf', 'command', 'sudo', 'mkdir',
  ]);
  const used = new Set<string>();
  for (const m of s.matchAll(/(?:\$\(|\|\s*|&&\s*|;\s*|^\s*)(curl|tar|sha256sum|install|mktemp|rm|chmod|chown|cat|grep|sed|head|tr|stat|dirname|id|uname|sudo|mkdir|awk|python3?|perl|jq|xxd|openssl|wget|unzip|base64|find|xargs|cut|sort|tee)\b/gm))
    used.add(m[1]!);
  for (const u of used) assert.ok(allowed.has(u), `脚本使用了不在白名单里的工具：${u}`);
});
