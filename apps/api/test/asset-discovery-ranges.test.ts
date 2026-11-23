import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TargetFormatError,
  endpointText,
  expandScanTargets,
  isUrlTarget,
  normalizeScopeConfig,
  parseScopeEntry,
  parseUrlTarget,
} from '../src/modules/asset-discovery/ranges.js';

test('解析 CIDR 与主机条目，/24 为 256 个地址', () => {
  const cidr = parseScopeEntry('10.0.0.0/24');
  assert.equal(cidr.kind, 'cidr');
  assert.equal(cidr.hostCount, 256);
  assert.equal(parseScopeEntry('127.0.0.1').hostCount, 1);
  const host = parseScopeEntry('Ollama.Lan');
  assert.equal(host.kind, 'host');
  assert.equal(host.text, 'ollama.lan');
});

test('CIDR 必须对齐网络地址且前缀不小于 /16', () => {
  assert.throws(() => parseScopeEntry('10.0.0.1/24'), /网络地址/);
  assert.throws(() => parseScopeEntry('10.0.0.0/8'), /\/16/);
  assert.throws(() => parseScopeEntry('http://10.0.0.1'), /格式/);
});

test('拒绝云元数据/链路本地、0.0.0.0/8 与组播保留段', () => {
  assert.throws(() => parseScopeEntry('169.254.169.254'), /不允许/);
  assert.throws(() => parseScopeEntry('0.0.0.0/16'), /不允许/);
  assert.throws(() => parseScopeEntry('224.0.0.1'), /不允许/);
});

test('默认配置为空，不扫描任何范围', () => {
  const cfg = normalizeScopeConfig(null);
  assert.deepEqual(cfg.entries, []);
  assert.deepEqual(cfg.ports, []);
  assert.throws(() => expandScanTargets(['127.0.0.1'], [11434], cfg), /尚未配置/);
});

test('扫描目标必须落在已配置范围内', () => {
  const cfg = normalizeScopeConfig({
    entries: ['10.1.0.0/16', 'gpu-box.lan'],
    ports: [11434, 8000],
    maxHostsPerRun: 256,
  });
  const plan = expandScanTargets(['10.1.2.0/30', 'gpu-box.lan'], [11434], cfg);
  assert.deepEqual(plan.hosts, ['10.1.2.0', '10.1.2.1', '10.1.2.2', '10.1.2.3', 'gpu-box.lan']);
  assert.deepEqual(plan.ports, [11434]);
  assert.throws(() => expandScanTargets(['10.2.0.1'], [11434], cfg), /不在已配置/);
  assert.throws(() => expandScanTargets(['other.lan'], [11434], cfg), /不在已配置/);
  assert.throws(() => expandScanTargets(['10.1.0.0/15'], [11434], cfg), /\/16|不在已配置/);
  assert.throws(() => expandScanTargets(['10.1.2.1'], [22], cfg), /端口/);
});

test('单次主机数超过上限时拒绝', () => {
  const cfg = normalizeScopeConfig({ entries: ['10.1.0.0/16'], ports: [80], maxHostsPerRun: 16 });
  assert.throws(() => expandScanTargets(['10.1.0.0/24'], [80], cfg), /上限/);
  assert.equal(expandScanTargets(['10.1.0.0/28'], [80], cfg).hosts.length, 16);
});

test('存储值中的非法条目与越界上限被规整', () => {
  const cfg = normalizeScopeConfig({
    entries: ['127.0.0.1/32', 'bad entry', 5],
    ports: [11434, 0, 70000, 11434],
    maxHostsPerRun: 99999,
  });
  assert.deepEqual(cfg.entries, ['127.0.0.1/32']);
  assert.deepEqual(cfg.ports, [11434]);
  assert.equal(cfg.maxHostsPerRun, 256);
});

test('URL 目标：解析协议、主机、端口与路径前缀', () => {
  assert.equal(isUrlTarget('http://10.0.0.5:11434'), true);
  assert.equal(isUrlTarget('10.0.0.5'), false);
  assert.deepEqual(parseUrlTarget('http://10.0.0.5:11434'), {
    scheme: 'http',
    host: '10.0.0.5',
    port: 11434,
    basePath: '',
  });
  assert.deepEqual(parseUrlTarget('https://LLM.example.com/v1/'), {
    scheme: 'https',
    host: 'llm.example.com',
    port: 443,
    basePath: '/v1',
  });
  assert.equal(parseUrlTarget('http://gpu-box.lan/proxy/openai').port, 80);
});

test('URL 目标：非法写法一律拒绝', () => {
  for (const bad of [
    'http://',
    'ftp://10.0.0.5/x',
    'http://user:pw@10.0.0.5:8000',
    'http://10.0.0.5:8000/v1?key=1',
    'http://10.0.0.5:8000/#x',
    'http://[::1]:8000',
    'http://bad_host:8000',
    'http://llm%2eexample.com/v1',
    'http://10.0.0.5:0',
    '10.0.0.5:70000',
  ]) {
    assert.throws(() => parseUrlTarget(bad), /URL/, bad);
  }
  assert.throws(() => parseUrlTarget('http://169.254.169.254/latest'), /不允许/);
});

test('URL 主机写成 IP 时必须是标准点分十进制，八进制、十六进制、整数、缩写一律拒绝', () => {
  for (const bad of [
    'http://010.0.0.5:11434',
    'http://0x0a.0.0.5:11434',
    'http://2130706433:11434',
    'http://10.1:11434',
    'http://10.0.0.5.:11434',
    '010.0.0.5:11434',
  ]) {
    assert.throws(() => parseUrlTarget(bad), /请写成标准 IP/, bad);
  }
  assert.equal(parseUrlTarget('HTTP://LLM.EXAMPLE.COM:11434').host, 'llm.example.com');
  assert.equal(parseUrlTarget('http://10.0.0.5:080/').port, 80);
});

test('「主机:端口」按 http://主机:端口 处理，不需要另填端口', () => {
  assert.equal(isUrlTarget('10.0.0.5:11434'), true);
  assert.equal(isUrlTarget('gpu-box.lan:8000'), true);
  assert.equal(isUrlTarget('10.0.0.0/24'), false);
  assert.equal(isUrlTarget('gpu-box.lan'), false);
  assert.deepEqual(parseUrlTarget('10.0.0.5:11434'), {
    scheme: 'http',
    host: '10.0.0.5',
    port: 11434,
    basePath: '',
  });
  assert.deepEqual(parseUrlTarget('GPU-Box.lan:8000'), {
    scheme: 'http',
    host: 'gpu-box.lan',
    port: 8000,
    basePath: '',
  });
  const cfg = normalizeScopeConfig({
    entries: ['10.1.0.0/16'],
    ports: [11434],
    maxHostsPerRun: 4,
  });
  const plan = expandScanTargets(['10.1.0.5:11434'], [], cfg);
  assert.deepEqual(plan.endpoints, [
    { scheme: 'http', host: '10.1.0.5', port: 11434, basePath: '' },
  ]);
  assert.throws(() => expandScanTargets(['10.1.0.5:8000'], [], cfg), /端口 8000/);
});

test('目标格式错误与越界分开报：格式错误抛 TargetFormatError', () => {
  const cfg = normalizeScopeConfig({ entries: ['10.1.0.0/16'], ports: [80], maxHostsPerRun: 4 });
  for (const bad of [
    'bad entry',
    '10.1.0.0/33',
    'http://010.1.0.5/',
    '10.1.0.5:0',
    '169.254.169.254',
  ]) {
    assert.throws(() => expandScanTargets([bad], [80], cfg), TargetFormatError, bad);
  }
  for (const out of ['10.2.0.1', 'http://10.2.0.1/', '10.1.0.0/24']) {
    assert.throws(
      () => expandScanTargets([out], [80], cfg),
      (err: Error) => !(err instanceof TargetFormatError),
      out,
    );
  }
});

test('端点写成文本：协议、主机、端口和路径前缀都写全', () => {
  assert.equal(
    endpointText({ scheme: 'http', host: '10.0.0.5', port: 80, basePath: '/v1' }),
    'http://10.0.0.5:80/v1',
  );
  assert.equal(
    endpointText(parseUrlTarget('HTTPS://LLM.example.com/v1/')),
    'https://llm.example.com:443/v1',
  );
});

test('URL 目标沿用范围与端口限制，并展开为带协议和前缀的端点', () => {
  const cfg = normalizeScopeConfig({
    entries: ['10.1.0.0/16', 'llm.example.com'],
    ports: [11434, 443],
    maxHostsPerRun: 4,
  });
  const plan = expandScanTargets(
    ['https://llm.example.com/v1', 'http://10.1.0.5:11434', '10.1.0.6'],
    [11434],
    cfg,
  );
  assert.deepEqual(plan.hosts, ['10.1.0.6', 'llm.example.com', '10.1.0.5']);
  assert.deepEqual(plan.ports, [11434, 443]);
  assert.deepEqual(plan.endpoints, [
    { scheme: 'http', host: '10.1.0.6', port: 11434, basePath: '' },
    { scheme: 'https', host: 'llm.example.com', port: 443, basePath: '/v1' },
    { scheme: 'http', host: '10.1.0.5', port: 11434, basePath: '' },
  ]);
  const urlOnly = expandScanTargets(['http://10.1.0.5:11434/'], [], cfg);
  assert.deepEqual(urlOnly.ports, [11434]);
  assert.equal(urlOnly.endpoints.length, 1);
  assert.throws(() => expandScanTargets(['https://other.example.com/v1'], [], cfg), /不在已配置/);
  assert.throws(() => expandScanTargets(['http://10.1.0.5:8000/v1'], [], cfg), /端口 8000/);
  assert.throws(() => expandScanTargets(['10.1.0.5'], [], cfg), /端口/);
  assert.throws(
    () => expandScanTargets(['10.1.0.0/30', 'http://10.1.1.1:11434'], [11434], cfg),
    /上限/,
  );
});
