import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '../src/db.js';
import {
  FLEET_TARGET_PROVIDER,
  ensureFleetTarget,
  fleetTargetName,
  publicBaseUrl,
} from '../src/modules/fleet-admin/service.js';

// 自管终端评估对象的命名：「主机名（系统）」，不再带内部编号；旧格式名称在再次使用时同步为新格式。
const PREFIX = '__fleet_naming_';
let adminId = '';

async function cleanup() {
  await prisma.modelTarget.deleteMany({
    where: { provider: FLEET_TARGET_PROVIDER, name: { contains: PREFIX } },
  });
  await prisma.fleetEndpoint.deleteMany({ where: { hostname: { startsWith: PREFIX } } });
}

async function makeEndpoint(name: string, os = 'linux') {
  return prisma.fleetEndpoint.create({
    data: {
      publicId: `ep_${randomBytes(10).toString('hex')}`,
      installationId: randomUUID(),
      machineId: `m-${name}`,
      hostname: `${PREFIX}${name}`,
      os,
      capabilities: [],
      tokenHash: randomBytes(16).toString('hex') + randomBytes(16).toString('hex'),
    },
  });
}

const ensure = (endpoint: Awaited<ReturnType<typeof makeEndpoint>>) =>
  prisma.$transaction((tx) => ensureFleetTarget(tx, endpoint, adminId));

before(async () => {
  adminId = (await prisma.user.findFirstOrThrow({ where: { username: 'admin' } })).id;
  await cleanup();
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test('fleetTargetName：主机名（系统），系统取终端记录里的 os，没有就只用主机名', () => {
  assert.equal(fleetTargetName({ hostname: 'demo-host', os: 'linux' }), 'demo-host（Linux）');
  assert.equal(fleetTargetName({ hostname: 'YJ40B4', os: 'windows' }), 'YJ40B4（Windows）');
  assert.equal(fleetTargetName({ hostname: 'mac-01', os: 'darwin' }), 'mac-01（macOS）');
  assert.equal(fleetTargetName({ hostname: 'mac-02', os: 'macOS' }), 'mac-02（macOS）');
  assert.equal(fleetTargetName({ hostname: 'bare', os: '' }), 'bare');
  assert.equal(fleetTargetName({ hostname: 'bare', os: '  ' }), 'bare');
});

test('新建对象的名称不含终端编号，也不带「自管终端」前缀', async () => {
  const endpoint = await makeEndpoint('a');
  const target = await ensure(endpoint);
  assert.equal(target.name, `${PREFIX}a（Linux）`);
  assert.ok(!target.name.includes(endpoint.publicId));
  assert.ok(!target.name.startsWith('自管终端'));
  // 内部编号仍保存在接入配置里，供后端关联
  assert.equal((target.accessConfig as { endpointId: string }).endpointId, endpoint.publicId);
});

test('同一终端重复调用只会得到同一个对象', async () => {
  const endpoint = await makeEndpoint('same');
  const first = await ensure(endpoint);
  const second = await ensure(endpoint);
  assert.equal(second.id, first.id);
  assert.equal(second.name, first.name);
});

test('旧格式的自动名称在再次使用时同步为新格式', async () => {
  const endpoint = await makeEndpoint('legacy', 'windows');
  const target = await ensure(endpoint);
  const legacyName = `自管终端 ${endpoint.hostname}（${endpoint.publicId}）`;
  await prisma.modelTarget.update({ where: { id: target.id }, data: { name: legacyName } });

  const synced = await ensure(endpoint);
  assert.equal(synced.id, target.id);
  assert.equal(synced.name, `${PREFIX}legacy（Windows）`);
  const stored = await prisma.modelTarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(stored.name, `${PREFIX}legacy（Windows）`);
});

test('旧格式名称里的主机名与现在不同（终端改过名）也能同步', async () => {
  const endpoint = await makeEndpoint('renamed');
  const target = await ensure(endpoint);
  await prisma.modelTarget.update({
    where: { id: target.id },
    data: { name: `自管终端 ${PREFIX}old-hostname（${endpoint.publicId}）` },
  });
  const synced = await ensure(endpoint);
  assert.equal(synced.name, `${PREFIX}renamed（Linux）`);
});

test('用户手改过的名称不会被覆盖', async () => {
  const endpoint = await makeEndpoint('manual');
  const target = await ensure(endpoint);
  const custom = `${PREFIX}财务部演示机`;
  await prisma.modelTarget.update({ where: { id: target.id }, data: { name: custom } });

  const again = await ensure(endpoint);
  assert.equal(again.name, custom);
  // 前缀相同但并非旧格式的名字同样保持不动
  const lookalike = `自管终端 ${PREFIX}manual 的备份`;
  await prisma.modelTarget.update({ where: { id: target.id }, data: { name: lookalike } });
  assert.equal((await ensure(endpoint)).name, lookalike);
});

test('主机名和系统都相同的两台终端：名称自动加序号区分，且不暴露终端编号', async () => {
  const one = await makeEndpoint('dup');
  const two = await makeEndpoint('dup');
  const three = await makeEndpoint('dup');
  const names = [(await ensure(one)).name, (await ensure(two)).name, (await ensure(three)).name];
  assert.deepEqual(names, [
    `${PREFIX}dup（Linux）`,
    `${PREFIX}dup（Linux） #2`,
    `${PREFIX}dup（Linux） #3`,
  ]);
  for (const name of names) assert.ok(!/ep_[0-9a-f]{20}/.test(name));
});

test('旧名称同步时遇到重名，同样自动加序号而不是报唯一约束错误', async () => {
  const taken = await makeEndpoint('clash');
  await ensure(taken);
  const other = await makeEndpoint('clash');
  const target = await ensure(other); // 已经是「… #2」
  await prisma.modelTarget.update({
    where: { id: target.id },
    data: { name: `自管终端 ${other.hostname}（${other.publicId}）` },
  });
  const synced = await ensure(other);
  assert.equal(synced.name, `${PREFIX}clash（Linux） #2`);
});

test('publicBaseUrl 未配置时的报错不暴露环境变量名', () => {
  const saved = process.env.LSE_PUBLIC_BASE_URL;
  try {
    process.env.LSE_PUBLIC_BASE_URL = '';
    assert.throws(
      () => publicBaseUrl(),
      (error: Error) => {
        assert.match(error.message, /部署管理员/);
        assert.ok(!/LSE_|环境变量/.test(error.message), error.message);
        return true;
      },
    );
  } finally {
    if (saved === undefined) delete process.env.LSE_PUBLIC_BASE_URL;
    else process.env.LSE_PUBLIC_BASE_URL = saved;
  }
});
