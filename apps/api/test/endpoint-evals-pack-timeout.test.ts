import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEndpointPack } from '../src/modules/endpoint-evals/pack.js';

// 端点 collector 对整个任务有 3600 秒的硬上限；场景超时之和必须落在其内，并留出余量。
test('终端场景包：单场景 270 秒，总时长不超过端点的一小时上限', () => {
  const pack = buildEndpointPack('https://lse.example/sink/token');
  for (const s of pack.scenarios) assert.equal(s.timeout_sec, 270);
  const total = pack.scenarios.reduce((sum, s) => sum + s.timeout_sec, 0);
  assert.ok(total <= 3600 - 300, `总时长 ${total} 秒超过端点上限`);
});
