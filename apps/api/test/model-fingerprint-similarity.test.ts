import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINGERPRINT_PROBES_V1,
  FINGERPRINT_PROBE_VERSION,
  DEFAULT_FINGERPRINT_THRESHOLD,
  extractFeatures,
  compareFingerprints,
  trigramJaccard,
  truncateOutput,
} from '../src/modules/model-fingerprint/similarity.js';

const mk = (fn: (id: string, i: number) => string) =>
  FINGERPRINT_PROBES_V1.map((p, i) => ({ probeId: p.id, output: fn(p.id, i) }));

test('探针集为 10 道固定题且版本 v1', () => {
  assert.equal(FINGERPRINT_PROBES_V1.length, 10);
  assert.equal(FINGERPRINT_PROBE_VERSION, 'v1');
  assert.equal(new Set(FINGERPRINT_PROBES_V1.map((p) => p.id)).size, 10);
  for (const k of ['identity', 'cutoff', 'json', 'arithmetic', 'refusal', 'continuation']) {
    assert.ok(FINGERPRINT_PROBES_V1.some((p) => p.kind === k), k);
  }
});

test('extractFeatures 提取长度、拒答、JSON 可解析', () => {
  const f = extractFeatures([
    { probeId: 'p03', output: '{"name":"lse","n":3}' },
    { probeId: 'p05', output: '抱歉，我无法提供这类信息。' },
    { probeId: 'p04', output: '440' },
  ]);
  assert.equal(f[0]!.jsonParsable, true);
  assert.equal(f[1]!.refused, true);
  assert.equal(f[2]!.refused, false);
  assert.equal(f[2]!.length, 3);
  assert.equal(extractFeatures([{ probeId: 'x', output: 'a'.repeat(5000) }])[0]!.length, 2000);
  assert.equal(truncateOutput('abc'), 'abc');
});

test('相同文本相似度为 1', () => {
  const a = extractFeatures(mk((id) => `我是测试模型，回答 ${id} 的内容，保持一致。`));
  const r = compareFingerprints(a, a);
  assert.equal(r.similarity, 1);
  assert.equal(r.drift, false);
  assert.equal(r.comparedProbes, 10);
  assert.equal(r.threshold, DEFAULT_FINGERPRINT_THRESHOLD);
});

test('完全不同文本相似度接近 0', () => {
  const a = extractFeatures(mk(() => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  const b = extractFeatures(mk(() => '{"z":1}'));
  // 拒答一致（都未拒答）会贡献 0.15，其余分项接近 0
  const r = compareFingerprints(a, b, { weights: { refusal: 0 } });
  assert.ok(r.similarity < 0.15, `similarity=${r.similarity}`);
  assert.equal(r.components.ngram, 0);
  assert.equal(r.components.format, 0);
  assert.equal(r.drift, true);
  assert.equal(trigramJaccard('abcdef', 'uvwxyz'), 0);
});

test('阈值边界：等于阈值不告警，低于阈值告警，阈值可配置', () => {
  const a = extractFeatures(mk(() => 'same'));
  const r = compareFingerprints(a, a, { threshold: 1 });
  assert.equal(r.similarity, 1);
  assert.equal(r.drift, false);
  const b = extractFeatures(mk(() => 'xyzw'));
  const r2 = compareFingerprints(a, b);
  const atEdge = compareFingerprints(a, b, { threshold: r2.similarity });
  assert.equal(atEdge.drift, false);
  const above = compareFingerprints(a, b, { threshold: r2.similarity + 0.0001 });
  assert.equal(above.drift, true);
});

test('权重可配置：只看格式分项', () => {
  const a = extractFeatures(mk(() => '{"a":1}'));
  const b = extractFeatures(mk(() => '{"completely":"different"}'));
  const r = compareFingerprints(a, b, {
    weights: { ngram: 0, length: 0, refusal: 0, format: 1, identity: 0 },
  });
  assert.equal(r.similarity, 1);
  assert.equal(r.weights.format, 1);
  const r2 = compareFingerprints(a, b, {
    weights: { ngram: 1, length: 0, refusal: 0, format: 0, identity: 0 },
  });
  assert.ok(r2.similarity < 0.5);
});

test('无共同题目时相似度为 0', () => {
  const r = compareFingerprints(
    extractFeatures([{ probeId: 'p01', output: 'x' }]),
    extractFeatures([{ probeId: 'p02', output: 'x' }]),
  );
  assert.equal(r.similarity, 0);
  assert.equal(r.comparedProbes, 0);
});
