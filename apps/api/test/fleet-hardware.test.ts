import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointHardware } from '../src/modules/fleet-admin/hardware.js';

const accelerator = (i: number) => ({ vendor: 'nvidia', model: `GPU ${i}`, source: 'pci' });
const component = (i: number) => ({
  id: `c${i}`,
  name: `C${i}`,
  category: 'component',
  source: 'process',
});

test('主机快照解析：超量数组只取上限内的行', () => {
  const h = endpointHardware({
    host: {
      os: 'linux',
      accelerators: Array.from({ length: 65 }, (_, i) => accelerator(i)),
      ai_components: Array.from({ length: 257 }, (_, i) => component(i)),
      disks: Array.from({ length: 65 }, (_, i) => ({ mountpoint: `/m${i}` })),
      accelerator_errors: Array.from({ length: 20 }, () => 'accelerators_limit_exceeded'),
    },
  });
  assert.equal(h?.accelerators?.length, 64);
  assert.equal(h?.accelerators?.[63]?.model, 'GPU 63');
  assert.equal(h?.aiComponents?.length, 256);
  assert.equal(h?.aiComponents?.[255]?.id, 'c255');
  assert.equal(h?.disks?.length, 64);
  assert.deepEqual(h?.acceleratorErrors, ['accelerators_limit_exceeded']);
});

test('主机快照解析：超长字符串截断，不留半个代理对', () => {
  const emoji = '\u{1F600}';
  const h = endpointHardware({
    host: {
      os: 'linux',
      cpu_model: 'x'.repeat(10_000),
      kernel_version: 'k'.repeat(1_000),
      accelerators: [
        {
          vendor: 'nvidia',
          model: 'a'.repeat(254) + emoji,
          driver_version: 'd'.repeat(200),
          source: 'pci',
        },
        { vendor: 'v'.repeat(500), model: emoji.repeat(300), source: 's'.repeat(100) },
      ],
      ai_components: [
        {
          id: 'i'.repeat(65),
          name: 'n'.repeat(300),
          category: 'training',
          source: 'process',
          version: emoji.repeat(40),
        },
      ],
    },
  });
  assert.equal(h?.cpuModel?.length, 255);
  assert.equal(h?.kernelVersion?.length, 128);
  const [first, second] = h?.accelerators ?? [];
  assert.equal(first?.model, 'a'.repeat(254));
  assert.equal(first?.driverVersion, 'd'.repeat(64));
  assert.equal(second?.vendor.length, 32);
  assert.equal(second?.source.length, 32);
  assert.equal(second?.model, emoji.repeat(127));
  const row = h?.aiComponents?.[0];
  assert.equal(row?.id.length, 64);
  assert.equal(row?.name.length, 128);
  assert.equal(row?.version, emoji.repeat(32));
  for (const value of [first?.model, second?.model, row?.version]) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(value ?? ''), '截断处不留高位代理');
  }
});

test('主机快照解析：类型错乱时整项为空或丢掉坏行，不报错', () => {
  for (const host of [
    { accelerators: 'x' },
    { accelerators: {} },
    { accelerators: 5 },
    { accelerators: null },
  ]) {
    const h = endpointHardware({ host: { os: 'linux', ...host } });
    assert.equal(h?.accelerators, null, JSON.stringify(host));
  }
  const h = endpointHardware({
    host: {
      os: 'linux',
      accelerators: [
        null,
        1,
        's',
        [],
        { vendor: 1, model: 2, source: 3 },
        { vendor: 'nvidia', model: 'ok', source: 'pci', memory_mb: -1, index: 1.5 },
      ],
      ai_components: [{ id: 123, name: [], category: {}, source: true }],
      disks: 'x',
      cpu_cores: -1,
      memory_total_mb: 1e308,
      accelerator_errors: ['accelerators_unavailable', 'x y', 5, 'A'],
      ai_component_errors: 'python_env_limit_exceeded',
    },
  });
  assert.deepEqual(h?.accelerators, [{ vendor: 'nvidia', model: 'ok', source: 'pci' }]);
  assert.deepEqual(h?.aiComponents, []);
  assert.equal(h?.disks, null);
  assert.equal(h?.cpuCores, null);
  assert.deepEqual(h?.acceleratorErrors, ['accelerators_unavailable']);
  assert.equal(h?.aiComponentErrors, null);
  for (const body of [{ host: [] }, { host: 'str' }, { host: 5 }, { host: null }, {}, null, 'x']) {
    assert.equal(endpointHardware(body), null, JSON.stringify(body));
  }
});

test('主机快照解析：旧探针没有错误字段时为 null', () => {
  const h = endpointHardware({ host: { os: 'linux' } });
  assert.equal(h?.acceleratorErrors, null);
  assert.equal(h?.aiComponentErrors, null);
});
