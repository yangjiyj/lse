import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBenchmark,
  listBenchmarkAdapters,
  BENCHMARK_FORMAT_IDS,
} from '../src/modules/benchmarks/index.js';

// 公开安全基准适配器：仅验证字段映射/错误处理/去重；夹具为无害占位内容，不含任何真实数据集样本。

test('注册：7 个公开基准格式均可发现，且带出处/表头/许可提示', () => {
  const ids = [
    'harmbench',
    'jailbreakbench',
    'strongreject',
    'advbench',
    'xstest',
    'beavertails',
    'do-not-answer',
  ];
  for (const id of ids) assert.ok(BENCHMARK_FORMAT_IDS.includes(id), id);
  const infos = listBenchmarkAdapters();
  for (const id of ids) {
    const info = infos.find((i) => i.id === id)!;
    assert.ok(info.origin && info.expectedHeaders && info.typicalFiles, id);
    assert.match(info.licenseNote ?? '', /原始许可/);
  }
});

test('HarmBench：映射 BehaviorID/SemanticCategory，ContextString 拼入题面', () => {
  const csv = [
    'Behavior,FunctionalCategory,SemanticCategory,Tags,ContextString,BehaviorID',
    '示例题面1,standard,chemical_biological,,,id_1',
    '示例题面2,contextual,cybercrime_intrusion,"ctx,tag",示例上下文,id_2',
  ].join('\n');
  const r = parseBenchmark(csv, 'harmbench');
  assert.equal(r.importedRows, 2);
  const [a, b] = r.items;
  assert.equal(a!.content, '示例题面1');
  assert.equal(a!.externalId, 'id_1');
  assert.equal(a!.category, 'chemical_biological');
  assert.equal(a!.shouldRefuse, true);
  assert.equal(a!.type, 'SHOULD_REFUSE');
  assert.equal(b!.content, '示例上下文\n\n示例题面2');
  assert.deepEqual((b!.metadata as Record<string, unknown>).contextString, '示例上下文');
  assert.equal((b!.metadata as Record<string, unknown>).behavior, '示例题面2');
  assert.ok(b!.tags.includes('ctx') && b!.tags.includes('contextual'));
});

test('JailbreakBench：Goal 为题面，Behavior 为外部 ID，Target 仅入 metadata', () => {
  const csv = [
    'Index,Goal,Target,Behavior,Category,Source',
    '1,示例题面1,示例目标1,示例行为1,Harassment,Original',
    '2,示例题面2,示例目标2,示例行为2,Malware,TDC',
  ].join('\n');
  const r = parseBenchmark(csv, 'jailbreakbench');
  assert.equal(r.importedRows, 2);
  assert.equal(r.items[0]!.content, '示例题面1');
  assert.equal(r.items[0]!.externalId, '示例行为1');
  assert.equal(r.items[0]!.category, 'Harassment');
  assert.equal(r.items[0]!.referenceAnswer, null);
  assert.equal((r.items[0]!.metadata as Record<string, unknown>).target, '示例目标1');
  assert.equal((r.items[0]!.metadata as Record<string, unknown>).source, 'Original');
});

test('StrongREJECT：forbidden_prompt 为题面', () => {
  const csv = ['category,source,forbidden_prompt', '示例类别,示例来源,示例题面1'].join('\n');
  const r = parseBenchmark(csv, 'strongreject');
  assert.equal(r.items[0]!.content, '示例题面1');
  assert.equal(r.items[0]!.category, '示例类别');
  assert.equal((r.items[0]!.metadata as Record<string, unknown>).source, '示例来源');
});

test('AdvBench：goal 为题面，无类别', () => {
  const csv = ['goal,target', '示例题面1,示例目标1', '示例题面2,示例目标2'].join('\n');
  const r = parseBenchmark(csv, 'advbench');
  assert.equal(r.importedRows, 2);
  assert.equal(r.items[0]!.category, null);
  assert.equal(r.items[0]!.shouldRefuse, true);
});

test('XSTest：safe 题标记为应正常回答，unsafe 为应拒答', () => {
  const csv = [
    'id,prompt,type,label,focus,note',
    '1,示例题面1,homonyms,safe,示例焦点,',
    '2,示例题面2,contrast_homonyms,unsafe,示例焦点,',
  ].join('\n');
  const r = parseBenchmark(csv, 'xstest');
  assert.equal(r.importedRows, 2);
  const [safe, unsafe] = r.items;
  assert.equal(safe!.shouldRefuse, false);
  assert.equal(safe!.type, 'GENERAL');
  assert.match(safe!.expectedBehavior ?? '', /正常回答/);
  assert.ok(safe!.tags.includes('过度拒答'));
  assert.equal(safe!.externalId, '1');
  assert.equal(unsafe!.shouldRefuse, true);
  assert.equal(unsafe!.type, 'SHOULD_REFUSE');
});

test('XSTest：label 非法记为失败行', () => {
  const csv = ['id,prompt,type,label', '1,示例题面1,t,maybe', '2,示例题面2,t,safe'].join('\n');
  const r = parseBenchmark(csv, 'xstest');
  assert.equal(r.failedRows, 1);
  assert.equal(r.importedRows, 1);
  assert.ok(r.issues.some((i) => i.level === 'error' && i.row === 2));
});

test('BeaverTails：仅导入 is_safe=false，category 对象取为 true 的键，不存回答正文', () => {
  const lines = [
    JSON.stringify({
      prompt: '示例题面1',
      response: '示例回答1',
      category: { violence: true, privacy_violation: true, politics: false },
      is_safe: false,
    }),
    JSON.stringify({ prompt: '示例题面2', response: '示例回答2', category: {}, is_safe: true }),
  ].join('\n');
  const r = parseBenchmark(lines, 'beavertails');
  assert.equal(r.totalRows, 2);
  assert.equal(r.importedRows, 1);
  assert.equal(r.failedRows, 1);
  const it = r.items[0]!;
  assert.equal(it.category, 'violence');
  assert.ok(it.tags.includes('privacy_violation'));
  assert.ok(!JSON.stringify(it).includes('示例回答1'));
  assert.ok(r.issues.some((i) => i.level === 'warning' && i.row === 2));
});

test('Do-Not-Answer：类别取 types_of_harm，保留 risk_area/specific_harms', () => {
  const csv = [
    'id,risk_area,types_of_harm,specific_harms,question',
    '1,示例风险域,示例危害类型,示例具体危害,示例题面1',
  ].join('\n');
  const r = parseBenchmark(csv, 'do-not-answer');
  const it = r.items[0]!;
  assert.equal(it.content, '示例题面1');
  assert.equal(it.category, '示例危害类型');
  assert.ok(it.tags.includes('示例风险域') && it.tags.includes('示例具体危害'));
  assert.equal(it.externalId, '1');
});

test('错误处理：表头缺失时整体失败并给出期望表头', () => {
  const r = parseBenchmark('foo,bar\n1,2\n3,4', 'strongreject');
  assert.equal(r.importedRows, 0);
  assert.equal(r.failedRows, 2);
  const err = r.issues.find((i) => i.level === 'error');
  assert.ok(err);
  assert.match(err!.message, /forbidden_prompt/);
  assert.match(err!.message, /category, source, forbidden_prompt/);
});

test('错误处理：空行跳过、缺题面行记失败、带 BOM 的表头可识别', () => {
  const csv = '\uFEFFgoal,target\n示例题面1,t\n\n,t2\n示例题面3,t3\n';
  const r = parseBenchmark(csv, 'advbench');
  assert.equal(r.totalRows, 3);
  assert.equal(r.importedRows, 2);
  assert.equal(r.failedRows, 1);
});

test('去重：按题面（忽略大小写与空白差异）去重并报告重复数', () => {
  const csv = [
    'goal,target',
    '示例 题面1,a',
    '示例题面2,b',
    '示例  题面1 ,c',
    'Sample A,d',
    'sample a,e',
  ].join('\n');
  const r = parseBenchmark(csv, 'advbench');
  assert.equal(r.totalRows, 5);
  assert.equal(r.importedRows, 3);
  assert.equal(r.duplicateRows, 2);
  assert.equal(r.failedRows, 0);
  assert.equal(r.issues.filter((i) => /重复/.test(i.message)).length, 2);
});

test('编码：非 UTF-8（GB18030）CSV 自动回退解码并告警', () => {
  const buf = Buffer.from([
    ...Buffer.from('goal,target\n', 'utf8'),
    0xca,
    0xbe,
    0xc0,
    0xfd, // 「示例」的 GB18030 编码
    ...Buffer.from(',t\n', 'utf8'),
  ]);
  const r = parseBenchmark(buf, 'advbench');
  assert.equal(r.items[0]!.content, '示例');
  assert.ok(r.issues.some((i) => /GB18030/.test(i.message)));
});
