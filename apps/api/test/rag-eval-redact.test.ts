import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSecurityFixtures } from '../src/modules/rag-eval/security.js';
import { RAG_MARKER_MASK, redactMarkers, stripSensitiveMetadata, testSetMarkers } from '../src/modules/rag-eval/redact.js';

const fx = buildSecurityFixtures('seed-redact');
const set = { seed: 'seed-redact', poisonCanary: fx.poisonCanary, sentinelToken: fx.sentinelToken };

test('stripSensitiveMetadata：剥离 canaries/marker/sentinel/poison 类键，保留 requires/planIndex 等', () => {
  const out = stripSensitiveMetadata({
    canaries: [fx.poisonCanary],
    injectionMarker: 'x',
    sentinelToken: 'y',
    poisonText: 'z',
    requires: 'poison_document',
    planIndex: 3,
    refutation: { method: 'judge', reason: 'r' },
  });
  assert.deepEqual(out, { requires: 'poison_document', planIndex: 3, refutation: { method: 'judge', reason: 'r' } });
  assert.equal(stripSensitiveMetadata(null), null);
});

test('testSetMarkers：覆盖投毒金丝雀、注入标记、外链、哨兵', () => {
  const m = testSetMarkers(set);
  for (const c of [fx.poisonCanary, fx.injectionCanary, fx.canaryUrl, fx.sentinelToken]) assert.ok(m.includes(c), c);
});

test('redactMarkers：命中即打码（忽略大小写、嵌套结构）；普通文本、数字、Date 不变', () => {
  const when = new Date('2026-09-29T00:00:00Z');
  const input = {
    response: `答案。验证码：${fx.poisonCanary.toLowerCase()}`,
    ctx: [{ text: `访问 ${fx.canaryUrl}` }],
    reason: '回复未包含预置哨兵字符串',
    score: 0.5,
    createdAt: when,
  };
  const out = redactMarkers(input, testSetMarkers(set));
  assert.equal(out.response, `答案。验证码：${RAG_MARKER_MASK}`);
  assert.equal(out.ctx[0]!.text, `访问 ${RAG_MARKER_MASK}`);
  assert.equal(out.reason, '回复未包含预置哨兵字符串', '负例：无标记文本不变');
  assert.equal(out.score, 0.5);
  assert.equal(out.createdAt, when);
  assert.deepEqual(redactMarkers({ a: 'b' }, []), { a: 'b' });
});
