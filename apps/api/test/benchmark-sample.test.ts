import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QuestionType } from '@lse/shared';
import {
  listBenchmarkSamples,
  getBenchmarkSample,
  loadBenchmarkSample,
} from '../src/modules/benchmarks/index.js';

test('内置样本：列出至少一个自有样本集（中文标签 + 许可证 + itemCount>0）', () => {
  const list = listBenchmarkSamples();
  assert.ok(list.length >= 1, '应至少有一个内置样本集');
  const s = list[0];
  assert.ok(s);
  assert.match(s.label, /[一-龥]/, 'label 应含中文');
  assert.match(s.description, /[一-龥]/, 'description 应含中文');
  assert.ok(s.license.length > 0, '应标注许可证');
  assert.ok(s.itemCount > 0, 'itemCount 应大于 0');
  assert.ok(
    ['generic-jsonl', 'generic-csv', 'salad-bench', 'jade-db'].includes(s.formatId),
    'formatId 应为已注册格式',
  );
});

test('内置样本：getBenchmarkSample 命中与未命中', () => {
  const id = listBenchmarkSamples()[0]!.id;
  assert.ok(getBenchmarkSample(id), '应命中已存在样本');
  assert.equal(getBenchmarkSample('不存在的样本'), undefined);
});

test('内置样本：loadBenchmarkSample 全部行有效（failedRows=0）且 severity 不留空', () => {
  const id = listBenchmarkSamples()[0]!.id;
  const res = loadBenchmarkSample(id);
  assert.equal(res.failedRows, 0, '自有样本不应有失败行');
  assert.equal(res.importedRows, res.totalRows);
  assert.ok(res.items.length > 0);
  assert.equal(res.issues.length, 0, '自有样本不应产生告警/错误');
  for (const it of res.items) {
    assert.ok(it.content.length > 0, '内容非空');
    assert.notEqual(it.severity, null, '自有样本显式标注 severity，不留空');
  }
});

test('内置样本：覆盖全部四类题型', () => {
  const id = listBenchmarkSamples()[0]!.id;
  const res = loadBenchmarkSample(id);
  const types = new Set<QuestionType>(res.items.map((i) => i.type));
  for (const t of [
    'COMPLIANCE',
    'PROMPT_INJECTION',
    'SHOULD_REFUSE',
    'GENERAL',
  ] as QuestionType[]) {
    assert.ok(types.has(t), `应覆盖题型 ${t}`);
  }
});

test('内置样本：应拒答类条目 shouldRefuse=true', () => {
  const id = listBenchmarkSamples()[0]!.id;
  const res = loadBenchmarkSample(id);
  const refuseItems = res.items.filter((i) => i.type === 'SHOULD_REFUSE');
  assert.ok(refuseItems.length > 0, '应包含应拒答类条目');
  for (const it of refuseItems) assert.equal(it.shouldRefuse, true);
});

test('内置样本：loadBenchmarkSample 未知 id 抛错', () => {
  assert.throws(() => loadBenchmarkSample('nope'), /未知的内置样本/);
});
