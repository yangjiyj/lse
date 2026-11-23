import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanModelBytes } from '../src/modules/model-files/scanner.js';
import { scanAllowedDirectory } from '../src/modules/model-files/filesystem.js';
import {
  buildGguf,
  buildStoredZip,
  maliciousPickle,
  safePickle,
} from './helpers/model-file-fixtures.js';

const limits = { pickleMaxBytes: 512 * 1024 * 1024, totalMaxBytes: 1024 * 1024, maxFiles: 100 };
const rules = (r: { findings: Array<{ ruleId: string }> }) => r.findings.map((f) => f.ruleId);

test('静态检查 pickle 中危险 GLOBAL，不执行反序列化', async () => {
  const r = await scanModelBytes('payload.pkl', Buffer.from('cos\nsystem\n.', 'binary'));
  assert.equal(r.format, 'pickle');
  assert.ok(rules(r).includes('PICKLE_DANGEROUS_GLOBAL'));
});

test('识别有效 safetensors 张量头并计算参数量', async () => {
  const header = Buffer.from(
    JSON.stringify({ weight: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }),
  );
  const bytes = Buffer.alloc(8 + header.length + 4);
  bytes.writeBigUInt64LE(BigInt(header.length));
  header.copy(bytes, 8);
  const r = await scanModelBytes('weights.safetensors', bytes);
  assert.ok(rules(r).includes('SAFETENSORS_VALIDATED'));
  assert.equal(
    r.findings.some((f) => f.severity === 'HIGH'),
    false,
  );
  assert.equal(r.meta.parameterCount, 1);
});

test('拒绝越界 safetensors offset', async () => {
  const header = Buffer.from(
    JSON.stringify({ weight: { dtype: 'F32', shape: [2], data_offsets: [0, 20] } }),
  );
  const bytes = Buffer.alloc(8 + header.length + 4);
  bytes.writeBigUInt64LE(BigInt(header.length));
  header.copy(bytes, 8);
  assert.ok(
    rules(await scanModelBytes('weights.safetensors', bytes)).includes('SAFETENSORS_INVALID'),
  );
});

test('PyTorch zip 扫描包内所有 pkl', async () => {
  const zip = buildStoredZip([
    ['model/data.pkl', safePickle()],
    ['model/extra/hook.pkl', maliciousPickle()],
    ['model/data/0', Buffer.alloc(8)],
  ]);
  const r = await scanModelBytes('model.pt', zip);
  assert.equal(r.format, 'pytorch-zip');
  const high = r.findings.filter((f) => f.severity === 'HIGH');
  assert.ok(high.length > 0 && high.every((f) => f.detail.startsWith('model/extra/hook.pkl')));
});

test('pickle 超过扫描窗口时仍扫描头部并标注未扫部分', async () => {
  // 危险调用在头部 20 字节内，窗口 24 字节：必须命中高危，同时标注超窗口
  const evil = maliciousPickle();
  const big = Buffer.concat([evil.subarray(0, evil.length - 1), Buffer.of(0x30), Buffer.from('N0'.repeat(64)), Buffer.of(0x2e)]);
  const r = await scanModelBytes('big.pkl', big, { pickleMaxBytes: 24 });
  assert.ok(rules(r).includes('PICKLE_DANGEROUS_GLOBAL'), rules(r).join());
  assert.ok(rules(r).includes('PICKLE_SIZE_LIMIT'));
  const ok = await scanModelBytes('big.pkl', big, { pickleMaxBytes: 4096 });
  assert.equal(rules(ok).includes('PICKLE_SIZE_LIMIT'), false);
});

test('GGUF 流式解析 KV，识别 chat_template 沙箱逃逸', async () => {
  const bad = buildGguf([
    ['general.architecture', 'llama'],
    ['llama.context_length', 4096],
    ['tokenizer.chat_template', "{{ ''.__class__.__mro__[1].__subclasses__() }}"],
  ]);
  const r = await scanModelBytes('m.gguf', bad);
  assert.ok(rules(r).includes('GGUF_TEMPLATE_SSTI'));
  assert.equal(r.meta['general.architecture'], 'llama');
  assert.equal(r.meta['llama.context_length'], 4096);
  const ok = await scanModelBytes(
    'm.gguf',
    buildGguf([['tokenizer.chat_template', '{% for m in messages %}{{ m.content }}{% endfor %}']]),
  );
  assert.deepEqual(rules(ok), ['GGUF_PARSED']);
  const cut = await scanModelBytes('m.gguf', bad.subarray(0, bad.length - 5));
  assert.ok(rules(cut).includes('GGUF_PARSE_ABORTED'));
});

test('ONNX 解析识别自定义算子域与外部数据路径穿越', async () => {
  const s = (f: number, v: string) => {
    const b = Buffer.from(v);
    return Buffer.concat([Buffer.of((f << 3) | 2, b.length), b]);
  };
  const msg = (f: number, body: Buffer) =>
    Buffer.concat([Buffer.of((f << 3) | 2, body.length), body]);
  const node = msg(1, Buffer.concat([s(4, 'EvilOp'), s(7, 'com.evil')]));
  const ext = msg(13, Buffer.concat([s(1, 'location'), s(2, '../../etc/passwd')]));
  const init = msg(5, ext);
  const model = Buffer.concat([
    Buffer.of(0x08, 0x07),
    s(2, 'pytorch'),
    msg(7, Buffer.concat([node, init])),
  ]);
  const r = await scanModelBytes('m.onnx', model);
  assert.ok(rules(r).includes('ONNX_CUSTOM_OP'));
  assert.ok(rules(r).includes('ONNX_EXTERNAL_DATA_TRAVERSAL'));
  assert.equal(r.meta.producer, 'pytorch');
});

test('Keras 3 归档识别 Lambda 层', async () => {
  const config = {
    class_name: 'Functional',
    config: { layers: [{ class_name: 'Lambda', module: 'keras.layers', config: { name: 'l1' } }] },
  };
  const zip = buildStoredZip([
    ['metadata.json', Buffer.from('{}')],
    ['config.json', Buffer.from(JSON.stringify(config))],
  ]);
  const r = await scanModelBytes('m.keras', zip);
  assert.ok(rules(r).includes('KERAS_LAMBDA_LAYER'));
});

test('目录扫描拒绝符号链接逃逸白名单，并执行总量上限', async () => {
  const base = await mkdtemp(join(tmpdir(), 'lse-model-scan-'));
  try {
    const root = join(base, 'root'),
      outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.pkl'), 'cos\nsystem\n.');
    await writeFile(join(root, 'a.pkl'), maliciousPickle());
    await writeFile(join(root, 'readme.txt'), 'x');
    const ok = await scanAllowedDirectory(root, [root], limits);
    assert.equal(ok.files.length, 1);
    assert.equal(ok.skipped, 1);
    assert.match(ok.files[0]!.sha256, /^[0-9a-f]{64}$/);
    const partial = await scanAllowedDirectory(root, [root], { ...limits, totalMaxBytes: 4 });
    assert.equal(partial.files.length, 0);
    assert.match(partial.truncatedReason ?? '', /总量上限/);
    await assert.rejects(scanAllowedDirectory(outside, [root], limits), /白名单/);
    await symlink(outside, join(root, 'escape'), 'junction');
    const linked = await scanAllowedDirectory(root, [root], limits);
    assert.deepEqual(linked.rejectedLinks, ['escape']);
    assert.equal(linked.files.length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('ZIP DEFLATE 条目流式解压：内存窗口外的恶意 pickle 仍被扫描', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const { inflatingSource } = await import('../src/modules/model-files/inflate.js');
  // 3MiB 的 BINBYTES 填充后接 os.system 调用，跨越多个解压块
  const pad = Buffer.alloc(3 * 1024 * 1024, 0x41);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(pad.length);
  const body = Buffer.concat([Buffer.of(0x80, 2, 0x42), len, pad, Buffer.of(0x30), Buffer.from("cposix\nsystem\n(S'id'\ntR.", 'latin1')]);
  const comp = deflateRawSync(body);
  const { bufferSource } = await import('../src/modules/model-files/source.js');
  const src = inflatingSource(bufferSource(comp), 0, comp.length, body.length);
  const head = await src.read(0, 3);
  assert.deepEqual([...head], [0x80, 2, 0x42]);
  const tail = await src.read(body.length - 5, 5);
  assert.equal(tail.toString('latin1'), '\ntR.'.padStart(5, "'"));
  const { analyzePickle } = await import('../src/modules/model-files/pickle.js');
  const r = await analyzePickle(inflatingSource(bufferSource(comp), 0, comp.length, body.length));
  assert.ok(r.issues.some((i) => i.severity === 'HIGH'), JSON.stringify(r.issues));
});
