import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePickle } from '../src/modules/model-files/pickle.js';
import { bufferSource } from '../src/modules/model-files/source.js';
import { listZip } from '../src/modules/model-files/zip.js';
import { buildStoredZip, pk } from './helpers/model-file-fixtures.js';

test('STACK_GLOBAL 经 memo 间接引用 os.system 被识别为高危', async () => {
  // proto 4：模块名、函数名分别 BINPUT 进 memo，再 BINGET 取回后 STACK_GLOBAL + REDUCE
  const bytes = Buffer.concat([
    pk.proto(4),
    pk.frame(0),
    pk.shortUnicode('os'),
    pk.binput(0),
    pk.pop(),
    pk.shortUnicode('system'),
    pk.memoize(),
    pk.pop(),
    pk.binget(0),
    pk.binget(1),
    Buffer.of(0x93), // STACK_GLOBAL
    pk.shortUnicode('id'),
    Buffer.of(0x85), // TUPLE1
    Buffer.of(0x52), // REDUCE
    Buffer.of(0x2e),
  ]);
  const r = await analyzePickle(bufferSource(bytes));
  assert.equal(r.complete, true);
  assert.deepEqual(r.globals, ['os.system']);
  // 同一载荷的引用与调用合并为一条高危，证据同时列出 STACK_GLOBAL 与 REDUCE
  const high = r.issues.filter((i) => i.severity === 'HIGH');
  assert.equal(high.length, 1, JSON.stringify(r.issues));
  assert.equal(high[0]!.ruleId, 'PICKLE_DANGEROUS_GLOBAL');
  assert.match(high[0]!.detail, /os\.system（STACK_GLOBAL 引用、REDUCE 调用）/);
});

test('BINUNICODE8/LONG_BINPUT/LONG_BINGET 链路识别 builtins.eval', async () => {
  const bytes = Buffer.concat([
    pk.proto(5),
    pk.unicode8('builtins'),
    pk.longBinput(7),
    pk.pop(),
    pk.longBinget(7),
    pk.binunicode('eval'),
    Buffer.of(0x93),
    Buffer.of(0x2e),
  ]);
  const r = await analyzePickle(bufferSource(bytes));
  assert.ok(
    r.issues.some((i) => i.severity === 'HIGH' && i.detail === 'builtins.eval（STACK_GLOBAL 引用）'),
    JSON.stringify(r.issues),
  );
});

test('协议 0 的 GLOBAL/INST/PUT/GET 文本 opcode', async () => {
  const bytes = Buffer.from("(S'ls'\np0\ng0\nisubprocess\ncheck_output\n.", 'latin1');
  const r = await analyzePickle(bufferSource(bytes));
  assert.equal(r.complete, true);
  assert.ok(
    r.issues.some(
      (i) =>
        i.ruleId === 'PICKLE_DANGEROUS_GLOBAL' &&
        i.detail === 'subprocess.check_output（INST 引用、INST 调用）',
    ),
  );
});

test('安全的 torch rebuild 不产生告警', async () => {
  const bytes = Buffer.concat([
    pk.proto(2),
    pk.global('collections', 'OrderedDict'),
    Buffer.of(0x29, 0x52),
    pk.binput(0),
    pk.shortUnicode('weight'),
    pk.global('torch._utils', '_rebuild_tensor_v2'),
    Buffer.of(0x28), // MARK
    Buffer.of(0x28),
    pk.shortUnicode('storage'),
    pk.global('torch', 'FloatStorage'),
    pk.shortUnicode('0'),
    pk.shortUnicode('cpu'),
    Buffer.of(0x4b, 4),
    Buffer.of(0x74),
    Buffer.of(0x51), // BINPERSID
    Buffer.of(0x4b, 0),
    Buffer.of(0x4b, 2),
    Buffer.of(0x4b, 2),
    Buffer.of(0x86),
    Buffer.of(0x4b, 2),
    Buffer.of(0x4b, 1),
    Buffer.of(0x86),
    Buffer.of(0x89),
    pk.global('collections', 'OrderedDict'),
    Buffer.of(0x29, 0x52),
    Buffer.of(0x74),
    Buffer.of(0x52), // TUPLE + REDUCE
    Buffer.of(0x73),
    Buffer.of(0x2e),
  ]);
  const r = await analyzePickle(bufferSource(bytes));
  assert.equal(r.complete, true, JSON.stringify(r.issues));
  assert.deepEqual(r.issues, []);
  assert.ok(r.globals.includes('torch._utils._rebuild_tensor_v2'));
});

test('截断与未知 opcode 报告“解析中止”', async () => {
  const truncated = Buffer.concat([pk.proto(4), Buffer.of(0x8c, 10), Buffer.from('os')]);
  const r1 = await analyzePickle(bufferSource(truncated));
  assert.equal(r1.complete, false);
  assert.ok(
    r1.issues.some((i) => i.ruleId === 'PICKLE_PARSE_ABORTED' && i.detail.includes('截断')),
  );
  const unknown = Buffer.concat([pk.proto(4), Buffer.of(0xff), Buffer.of(0x2e)]);
  const r2 = await analyzePickle(bufferSource(unknown));
  assert.ok(
    r2.issues.some((i) => i.ruleId === 'PICKLE_PARSE_ABORTED' && i.detail.includes('0xff')),
  );
});

test('ZIP 中央目录可列出 PyTorch 包内全部 pkl', async () => {
  const zip = buildStoredZip([
    ['archive/data.pkl', Buffer.of(0x80, 2, 0x7d, 0x2e)],
    ['archive/extra/other.pkl', Buffer.of(0x80, 2, 0x4e, 0x2e)],
    ['archive/data/0', Buffer.alloc(16)],
  ]);
  const names = (await listZip(bufferSource(zip))).map((e) => e.name);
  assert.deepEqual(names, ['archive/data.pkl', 'archive/extra/other.pkl', 'archive/data/0']);
});

test('多段 legacy：第二段首字节非 0x80（协议 0）仍继续解析到文件尾', async () => {
  const seg1 = Buffer.concat([pk.proto(2), Buffer.of(0x4e, 0x2e)]);
  const seg2 = Buffer.from("cposix\nsystem\n(S'id'\ntR.", 'latin1');
  const r = await analyzePickle(bufferSource(Buffer.concat([seg1, seg1, seg2])));
  const high = r.issues.filter((i) => i.severity === 'HIGH');
  assert.equal(high.length, 1, JSON.stringify(r.issues));
  assert.match(high[0]!.detail, /第 3 段/);
});

test('旧格式尾随原始张量字节不误报', async () => {
  const seg = Buffer.concat([pk.proto(2), Buffer.of(0x4e, 0x2e)]);
  const r = await analyzePickle(bufferSource(Buffer.concat([seg, Buffer.alloc(64, 0xff)])));
  assert.deepEqual(
    r.issues.filter((i) => i.severity !== 'INFO'),
    [],
  );
});

test('BFloat16Storage、numpy 重建对象为安全；nn 模块为提示级', async () => {
  const g = (m: string, n: string) => Buffer.concat([pk.global(m, n), Buffer.of(0x30)]);
  const bytes = Buffer.concat([
    pk.proto(2),
    g('torch', 'BFloat16Storage'),
    g('numpy._core.numeric', '_frombuffer'),
    g('numpy.core.multiarray', '_reconstruct'),
    g('numpy', 'dtype'),
    g('torch.nn.modules.linear', 'Linear'),
    g('argparse', 'Namespace'),
    Buffer.of(0x4e, 0x2e),
  ]);
  const r = await analyzePickle(bufferSource(bytes));
  assert.deepEqual(
    r.issues.map((i) => `${i.severity}:${i.ruleId}`),
    ['INFO:PICKLE_COMMON_GLOBAL'],
  );
});

test('REDUCE 作用在非白名单对象上为高危；仅引用为中危', async () => {
  const call = Buffer.concat([pk.proto(2), pk.global('evil_pkg', 'run'), Buffer.of(0x29, 0x52, 0x2e)]);
  const r1 = await analyzePickle(bufferSource(call));
  assert.deepEqual(
    r1.issues.map((i) => `${i.severity}:${i.ruleId}`),
    ['HIGH:PICKLE_UNSAFE_CALL'],
  );
  const ref = Buffer.concat([pk.proto(2), pk.global('evil_pkg', 'Config'), Buffer.of(0x2e)]);
  const r2 = await analyzePickle(bufferSource(ref));
  assert.deepEqual(
    r2.issues.map((i) => `${i.severity}:${i.ruleId}`),
    ['MEDIUM:PICKLE_UNLISTED_GLOBAL'],
  );
});

test('扩充的危险名单（对齐 picklescan/modelscan）均为高危', async () => {
  const cases: Array<[string, string]> = [
    ['ctypes', 'CDLL'],
    ['_pickle', 'loads'],
    ['pickle', 'loads'],
    ['operator', 'attrgetter'],
    ['operator', 'methodcaller'],
    ['functools', 'partial'],
    ['torch', 'load'],
    ['torch.hub', 'load'],
    ['numpy', 'load'],
    ['numpy.testing._private.utils', 'runstring'],
    ['builtins', 'breakpoint'],
    ['builtins', 'setattr'],
    ['builtins', 'globals'],
    ['__builtin__', 'apply'],
    ['_posixsubprocess', 'fork_exec'],
    ['asyncio.subprocess', 'create_subprocess_shell'],
    ['multiprocessing.util', 'spawnv_passfds'],
    ['code', 'InteractiveInterpreter'],
    ['pdb', 'run'],
    ['timeit', 'timeit'],
    ['cProfile', 'run'],
    ['pydoc', 'pipepager'],
    ['http.client', 'HTTPConnection'],
    ['aiohttp.client', 'ClientSession'],
    ['pip', 'main'],
    ['venv', 'create'],
    ['webbrowser', 'open'],
  ];
  for (const [m, n] of cases) {
    const r = await analyzePickle(
      bufferSource(Buffer.concat([pk.proto(2), pk.global(m, n), Buffer.of(0x2e)])),
    );
    assert.ok(
      r.issues.some((i) => i.severity === 'HIGH'),
      `${m}.${n}: ${JSON.stringify(r.issues)}`,
    );
  }
});
