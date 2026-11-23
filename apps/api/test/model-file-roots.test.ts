import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeRoots,
  normalizeHostDir,
  normalizeRootInput,
  rootPolicyProblem,
  toHostPath,
  usableAdminRoots,
} from '../src/modules/model-files/roots.js';

// config 在首次 import 时一次性解析环境变量，所以先设置、再动态加载依赖 config 的模块。
process.env.MODEL_SCAN_HOST_DIR = '/srv/lse-models/';
const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { SETTING_KEY } = await import('../src/modules/model-files/service.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let base = '';
const auth = () => ({ authorization: `Bearer ${token}` });
const LIMITS = { pickleMaxBytes: 512 * 1024 * 1024, totalMaxBytes: 1024 ** 4, maxFiles: 10_000 };
const putConfig = (roots: string[]) =>
  app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: { roots, ...LIMITS },
  });
const getConfig = () =>
  app.inject({ method: 'GET', url: '/api/model-files/config', headers: auth() });

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.systemSetting.deleteMany({ where: { key: SETTING_KEY } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  base = await mkdtemp(join(tmpdir(), 'lse-mf-roots-'));
  await mkdir(join(base, 'a'));
  await mkdir(join(base, 'b'));
  await writeFile(join(base, 'plain.txt'), 'x');
});

after(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: SETTING_KEY } });
  await chmod(join(base, 'locked'), 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
  await app.close();
});

test('主机路径推导：/models 本身和子目录能推出来，其他目录推不出来', () => {
  assert.equal(toHostPath('/models', '/opt/lse/models'), '/opt/lse/models');
  assert.equal(toHostPath('/models/llama/7b', '/opt/lse/models'), '/opt/lse/models/llama/7b');
  assert.equal(toHostPath('/models/', '/opt/lse/models'), '/opt/lse/models');
  assert.equal(toHostPath('/modelsx', '/opt/lse/models'), null);
  assert.equal(toHostPath('/data/models', '/opt/lse/models'), null);
  assert.equal(toHostPath('/models/a', null), null);
});

test('部署时的主机目录：必须是绝对路径、去掉末尾斜杠，否则当作未知', () => {
  assert.equal(normalizeHostDir('/opt/lse/models/'), '/opt/lse/models');
  assert.equal(normalizeHostDir('/opt/lse/models'), '/opt/lse/models');
  assert.equal(normalizeHostDir('./models'), null);
  assert.equal(normalizeHostDir(''), null);
  assert.equal(normalizeHostDir(undefined), null);
});

test('目录写法：必须是绝对路径，不能含 ..，末尾斜杠和重复斜杠会被规整', () => {
  assert.deepEqual(normalizeRootInput('/data//models/'), { path: '/data/models' });
  assert.match((normalizeRootInput('models/a') as { problem: string }).problem, /绝对路径/);
  assert.match((normalizeRootInput('/data/../etc') as { problem: string }).problem, /\.\./);
  assert.match((normalizeRootInput('/data/a/../b') as { problem: string }).problem, /\.\./);
  assert.match((normalizeRootInput('/data/a\u0000b') as { problem: string }).problem, /字符/);
});

test('系统目录：根目录和 /proc /sys /dev /etc /run 等整棵树都不允许', () => {
  assert.match(rootPolicyProblem('/') ?? '', /根目录/);
  for (const p of [
    '/proc',
    '/proc/self',
    '/sys',
    '/sys/kernel',
    '/dev',
    '/dev/shm',
    '/etc',
    '/etc/ssh',
    '/run',
    '/run/secrets',
  ]) {
    assert.match(rootPolicyProblem(p) ?? '', /系统目录/, p);
  }
});

test('范围过大的目录（/usr /var /tmp /home /root）只禁止其本身，其下的具体子目录允许', () => {
  for (const p of ['/usr', '/var', '/tmp', '/home', '/root']) {
    assert.match(rootPolicyProblem(p) ?? '', /范围过大/, p);
  }
  for (const p of [
    '/tmp/x',
    '/home/user/models',
    '/var/lib/models',
    '/usr/local/share/models',
    '/root/models',
  ]) {
    assert.equal(rootPolicyProblem(p), null, `${p} 应允许`);
  }
});

test('常见的数据盘与模型目录允许加入', () => {
  for (const p of [
    '/models',
    '/models/llama',
    '/data',
    '/data/models',
    '/srv',
    '/mnt/nas',
    '/opt/lse/models',
  ]) {
    assert.equal(rootPolicyProblem(p), null, `${p} 应允许`);
  }
});

test('生效的管理员目录会剔除历史遗留的系统目录，不再放行', () => {
  assert.deepEqual(usableAdminRoots(['/', '/etc', '/data/models/', 'relative', '/proc/1']), [
    '/data/models',
  ]);
});

test('配置接口：返回服务器路径、每个目录的来源与可读状态', async () => {
  assert.equal((await putConfig([join(base, 'a')])).statusCode, 200);
  const cfg = (await getConfig()).json();
  assert.equal(cfg.hostDir, '/srv/lse-models');
  assert.deepEqual(cfg.envRoots, ['/models']);
  const [deploy, admin] = cfg.rootDetails;
  assert.deepEqual(
    { path: deploy.path, hostPath: deploy.hostPath, source: deploy.source },
    { path: '/models', hostPath: '/srv/lse-models', source: 'deploy' },
  );
  assert.deepEqual(admin, {
    path: join(base, 'a'),
    hostPath: null,
    source: 'admin',
    exists: true,
    readable: true,
    problem: null,
  });
  assert.equal(cfg.limitBounds.totalMaxBytes.max, 16 * 1024 ** 4);
});

test('配置接口：管理员目录之后被删掉时，状态里标明不存在，而不是读取失败', async () => {
  const gone = join(base, 'gone');
  await mkdir(gone);
  assert.equal((await putConfig([gone])).statusCode, 200);
  await rm(gone, { recursive: true });
  const cfg = (await getConfig()).json();
  const item = cfg.rootDetails.find((r: { path: string }) => r.path === gone);
  assert.equal(item.exists, false);
  assert.equal(item.readable, false);
  assert.match(item.problem, /不存在/);
});

test('描述目录：部署目录在前；与部署目录重复的管理员目录只算部署的；问题目录给出中文原因', async () => {
  const details = await describeRoots({
    deployRoots: [join(base, 'a')],
    adminRoots: [
      join(base, 'b'),
      join(base, 'a'),
      join(base, 'nope'),
      '/etc',
      join(base, 'plain.txt'),
    ],
    hostDir: null,
  });
  assert.deepEqual(
    details.map((d) => [d.path === '/etc' ? '/etc' : d.path.replace(base, '<base>'), d.source]),
    [
      ['<base>/a', 'deploy'],
      ['<base>/b', 'admin'],
      ['<base>/nope', 'admin'],
      ['/etc', 'admin'],
      ['<base>/plain.txt', 'admin'],
    ],
  );
  assert.match(details[2]!.problem ?? '', /不存在/);
  assert.match(details[3]!.problem ?? '', /系统目录/);
  assert.match(details[4]!.problem ?? '', /不是目录/);
  assert.equal(details[1]!.problem, null);
});

test('保存校验：相对路径、含 ..、不存在、是文件、系统目录都被拒绝，并给出中文原因', async () => {
  const cases: Array<[string, RegExp]> = [
    ['models/relative', /绝对路径/],
    [`${base}/a/../b`, /\.\./],
    [join(base, 'does-not-exist'), /不存在/],
    [join(base, 'plain.txt'), /不是目录/],
    ['/', /根目录/],
    ['/etc', /系统目录/],
    ['/proc/self', /系统目录/],
  ];
  for (const [path, reason] of cases) {
    const r = await putConfig([path]);
    assert.equal(r.statusCode, 400, `${path} 应被拒绝：${r.body}`);
    const err = r.json().error;
    assert.equal(err.code, 'MODEL_FILE_ROOT_INVALID');
    assert.match(err.message, reason, path);
    assert.doesNotMatch(err.message, /MODEL_SCAN|环境变量/);
    assert.deepEqual(
      err.details.rejected.map((x: { path: string }) => x.path),
      [path],
    );
  }
});

test('保存校验：同时有多个问题时一次性全部指出；通过的目录不会被保存', async () => {
  await putConfig([join(base, 'a')]);
  const r = await putConfig([join(base, 'b'), '/etc', join(base, 'missing')]);
  assert.equal(r.statusCode, 400);
  const err = r.json().error;
  assert.equal(err.details.rejected.length, 2);
  assert.match(err.message, /\/etc/);
  assert.match(err.message, /missing/);
  const after = (await getConfig()).json();
  assert.deepEqual(after.roots, [join(base, 'a')], '校验失败时原配置保持不变');
});

test('保存校验：指向系统目录的符号链接按真实位置判断，同样被拒绝', async () => {
  const link = join(base, 'to-etc');
  await symlink('/etc', link);
  const r = await putConfig([link]);
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /实际指向系统目录/);
});

test(
  '保存校验：目录没有读取权限时被拒绝（root 身份运行时跳过）',
  { skip: process.getuid?.() === 0 },
  async () => {
    const locked = join(base, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    const r = await putConfig([locked]);
    await chmod(locked, 0o755);
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error.message, /读取权限/);
  },
);

test('保存校验：与部署目录重复的目录被拒绝；管理员列表里的重复项自动合并；末尾斜杠被规整', async () => {
  const dup = await putConfig(['/models']);
  assert.equal(dup.statusCode, 400);
  assert.match(dup.json().error.message, /部署配置/);
  const ok = await putConfig([`${join(base, 'a')}/`, join(base, 'a'), join(base, 'b')]);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json().roots, [join(base, 'a'), join(base, 'b')]);
  assert.equal(ok.json().rootDetails.length, 3, '1 个部署目录 + 2 个管理员目录');
});

test('保存校验：不指名的错误提示里不出现校验框架的英文句子', async () => {
  const r = await putConfig(['']);
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error.code, 'MODEL_FILE_ROOT_INVALID');
  assert.match(r.json().error.message, /不能为空/);
  assert.doesNotMatch(r.body, /[A-Za-z]{4,} [a-z]+/, '不应出现英文句子');
});

test('保存校验：目录数量、数值越界也用中文说明', async () => {
  const many = await putConfig(Array.from({ length: 21 }, (_, i) => `/data/m${i}`));
  assert.equal(many.statusCode, 400);
  assert.match(many.json().error.message, /最多.*20/);
  const bad = await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: { roots: [], pickleMaxBytes: 1, totalMaxBytes: LIMITS.totalMaxBytes, maxFiles: 10 },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error.message, /单个 pickle|扫描上限/);
  assert.doesNotMatch(bad.body, /[A-Za-z]{4,} [a-z]+/, '不应出现英文句子');
});

test('保存校验：已保存的目录暂时不可用（如网络存储掉线）时，不阻塞修改其他设置；新加的不存在目录仍被拒', async () => {
  const flaky = join(base, 'flaky');
  await mkdir(flaky);
  assert.equal((await putConfig([flaky])).statusCode, 200);
  await rm(flaky, { recursive: true });
  const keep = await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: { roots: [flaky], ...LIMITS, maxFiles: 5000 },
  });
  assert.equal(keep.statusCode, 200, keep.body);
  assert.equal(keep.json().maxFiles, 5000);
  const detail = keep.json().rootDetails.find((r: { path: string }) => r.path === flaky);
  assert.equal(detail.exists, false, '界面上仍会标出该目录不可用');
  const added = await putConfig([flaky, join(base, 'still-missing')]);
  assert.equal(added.statusCode, 400);
  assert.deepEqual(
    added.json().error.details.rejected.map((x: { path: string }) => x.path),
    [join(base, 'still-missing')],
  );
});

test('审计：配置变更记录增加和移除了哪些目录', async () => {
  await putConfig([]);
  const added = await putConfig([join(base, 'a'), join(base, 'b')]);
  assert.equal(added.statusCode, 200, added.body);
  const latest = () =>
    prisma.auditLog.findFirstOrThrow({
      where: { action: 'model_file_scan.config.update', targetId: SETTING_KEY },
      orderBy: { createdAt: 'desc' },
    });
  let detail = (await latest()).detail as Record<string, unknown>;
  assert.deepEqual(detail.addedRoots, [join(base, 'a'), join(base, 'b')]);
  assert.deepEqual(detail.removedRoots, []);
  assert.equal(detail.rootCount, 2);
  assert.equal(detail.totalMaxBytes, LIMITS.totalMaxBytes);

  assert.equal((await putConfig([join(base, 'b')])).statusCode, 200);
  detail = (await latest()).detail as Record<string, unknown>;
  assert.deepEqual(detail.addedRoots, []);
  assert.deepEqual(detail.removedRoots, [join(base, 'a')]);
});
