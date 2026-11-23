import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DETECT_CATEGORIES, DETECT_JOB_ITEM_META, TOOL_TASK_ENTRIES } from '@lse/shared';
import {
  generateSchemeItems,
  isPathInRoots,
  type GenerateAsset,
  type GenerateContext,
} from '../src/modules/detect-schemes/generate.js';

// 2.8.2 方案清单生成规则 R1～R13（纯函数）。

const asset = (id: string, type: string, over: Partial<GenerateAsset> = {}): GenerateAsset => ({
  id,
  type,
  name: id,
  attrs: {},
  fleetEndpointId: null,
  modelTargetId: null,
  ...over,
});

const MODEL_A = asset('模型甲', 'model', {
  modelTargetId: 'mt-1',
  attrs: { modelPath: '/data/models/qwen' },
});
const MODEL_B = asset('模型乙', 'model');
const PLATFORM = asset('平台', 'platform', {
  modelTargetId: 'agent-1',
  attrs: { url: 'https://app.example.com/chat?x=1' },
});
const SERVER_C = asset('服务器丙', 'server', {
  fleetEndpointId: 'ep-1',
  attrs: { ip: '10.0.0.8' },
});
const SERVER_D = asset('服务器丁', 'server', { attrs: { ip: '10.0.0.9' } });
const COMPONENT = asset('组件', 'component', {
  attrs: { assetKey: 'milvus@10.0.0.9', endpointUrl: 'http://10.0.0.9:19530' },
});
const SOFTWARE = asset('软件', 'software', { attrs: { vendor: 'Oracle' } });
const ALL = [MODEL_A, MODEL_B, PLATFORM, SERVER_C, SERVER_D, COMPONENT, SOFTWARE];
const CTX: GenerateContext = { modelFileRoots: ['/data/models/'], discoveryPorts: [80, 443] };
const EVAL = (modelTargetId: string) => ({
  modelTargetId,
  questionSetIds: [],
  engines: ['rule-judge', 'sensitive-info'],
  dimensions: [],
  concurrency: 4,
});

const generate = (categories: readonly string[] = DETECT_CATEGORIES, assets = ALL, ctx = CTX) =>
  generateSchemeItems(
    { categories: categories as never, assetIds: assets.map((a) => a.id) },
    assets,
    ctx,
  );

const rows = (items: ReturnType<typeof generate>) =>
  items.map((i) => [i.assetId, i.category, i.entryKey, i.mode, i.jobKind, i.params]);

test('四类全选时，每个资产出的入口、方式、子任务类型、参数逐条等于规则表', () => {
  assert.deepEqual(rows(generate()), [
    ['模型甲', 'content', 'content-eval', 'auto', 'eval_task', EVAL('mt-1')], // R1
    ['模型甲', 'content', 'red-team', 'manual', null, { modelTargetId: 'mt-1' }], // R2
    [
      '模型甲',
      'model',
      'model-file-scan',
      'auto',
      'model_file_scan',
      { source: 'directory', path: '/data/models/qwen', targetId: 'mt-1' },
    ], // R3
    ['模型甲', 'data', 'corpus-scan', 'manual', null, {}], // R5
    ['模型乙', 'model', 'model-file-scan', 'manual', null, {}], // R4
    ['模型乙', 'data', 'corpus-scan', 'manual', null, {}], // R5
    ['平台', 'content', 'content-eval', 'auto', 'eval_task', EVAL('agent-1')], // R6
    [
      '平台',
      'app_env',
      'asset-discovery',
      'auto',
      'asset_discovery',
      { targets: ['https://app.example.com'], ports: [], confirm: true },
    ], // R7
    [
      '平台',
      'app_env',
      'service-assurance',
      'manual',
      null,
      { url: 'https://app.example.com/chat?x=1' },
    ], // R8
    ['服务器丙', 'app_env', 'fleet-posture', 'auto', 'fleet_posture', { endpointId: 'ep-1' }], // R9
    [
      '服务器丙',
      'app_env',
      'asset-discovery',
      'auto',
      'asset_discovery',
      { targets: ['10.0.0.8'], ports: [80, 443], confirm: true },
    ], // R11
    ['服务器丁', 'app_env', 'fleet-onboard', 'manual', null, { host: '10.0.0.9' }], // R10
    [
      '服务器丁',
      'app_env',
      'asset-discovery',
      'auto',
      'asset_discovery',
      { targets: ['10.0.0.9'], ports: [80, 443], confirm: true },
    ], // R11
    [
      '组件',
      'app_env',
      'ai-component-scan',
      'manual',
      null,
      { assetKey: 'milvus@10.0.0.9', endpointUrl: 'http://10.0.0.9:19530' },
    ], // R12
    ['软件', 'app_env', 'service-assurance', 'manual', null, {}], // R13
  ]);
  const first = generate()[0]!;
  assert.equal(first.title, `${TOOL_TASK_ENTRIES['content-eval'].label} · 模型甲`);
});

test('只选内容安全时只有 R1、R2、R6', () => {
  assert.deepEqual(
    generate(['content']).map((i) => [i.assetId, i.entryKey]),
    [
      ['模型甲', 'content-eval'],
      ['模型甲', 'red-team'],
      ['平台', 'content-eval'],
    ],
  );
});

test('资产测绘没配端口时 R11 的 ports 为空数组；终端类型不出资产测绘', () => {
  const items = generate(
    ['app_env'],
    [SERVER_D, asset('终端', 'endpoint', { attrs: { ip: '10.0.0.7' } })],
    {
      ...CTX,
      discoveryPorts: [],
    },
  );
  const discovery = items.find((i) => i.entryKey === 'asset-discovery')!;
  assert.deepEqual(discovery.params, { targets: ['10.0.0.9'], ports: [], confirm: true });
  assert.deepEqual(
    items.filter((i) => i.assetId === '终端').map((i) => [i.entryKey, i.params]),
    [['fleet-onboard', { host: '10.0.0.7' }]],
  );
});

test('同一资产同一入口不重复；auto 项的子任务类型与入口一致；只出需求配置里的资产，按配置顺序', () => {
  const items = generate();
  const keys = items.map((i) => `${i.assetId}|${i.entryKey}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const item of items) {
    if (item.mode === 'auto') {
      assert.ok(item.jobKind, item.title);
      assert.equal(DETECT_JOB_ITEM_META[item.jobKind].entry, item.entryKey, item.title);
      assert.equal(DETECT_JOB_ITEM_META[item.jobKind].category, item.category, item.title);
    } else {
      assert.equal(item.jobKind, null);
    }
    assert.equal(TOOL_TASK_ENTRIES[item.entryKey].category, item.category);
  }
  const subset = generateSchemeItems(
    { categories: ['app_env'], assetIds: ['软件', '服务器丁', '不存在', '软件'] },
    ALL,
    CTX,
  );
  assert.deepEqual(
    subset.map((i) => i.assetId),
    ['软件', '服务器丁', '服务器丁'],
  );
});

test('模型目录：在允许目录内（规范化末尾斜杠）才自动扫描；前缀相同的兄弟目录、含「..」的不算', () => {
  assert.equal(isPathInRoots('/data/models', ['/data/models/']), true);
  assert.equal(isPathInRoots('/data/models/qwen/', ['/data/models']), true);
  assert.equal(isPathInRoots('/data/models2/qwen', ['/data/models']), false);
  assert.equal(isPathInRoots('/data/models/../etc', ['/data/models']), false);
  assert.equal(isPathInRoots('data/models/qwen', ['/data/models']), false);
  assert.equal(isPathInRoots('/anything', ['/']), true);
  const outside = generate(
    ['model'],
    [asset('外部模型', 'model', { attrs: { modelPath: '/opt/other' }, modelTargetId: 'mt-9' })],
  );
  assert.deepEqual(rows(outside), [
    ['外部模型', 'model', 'model-file-scan', 'manual', null, { targetId: 'mt-9' }],
  ]);
});
