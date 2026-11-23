import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWN_MODELS_FILE,
  applyKnownModels,
  buildKnownModelIndex,
  knownModelIndex,
  loadKnownModels,
  matchKnownModels,
  parseKnownModelLine,
  quantizationFromFileName,
  readKnownModels,
  type KnownModel,
} from '../src/modules/model-files/known-models.js';
import type { ModelFinding } from '../src/modules/model-files/types.js';

const sha = (c: string) => c.repeat(64);
const model = (
  m: Partial<KnownModel> & Pick<KnownModel, 'repo' | 'kind' | 'files'>,
): KnownModel => ({
  name: m.repo.split('/')[1]!,
  family: 'Qwen',
  org: m.repo.split('/')[0]!,
  source: `https://huggingface.co/${m.repo}/tree/0000`,
  fetchedAt: '2026-11-21T00:00:00.000Z',
  ...m,
});
const QWEN = model({
  repo: 'Qwen/Qwen2.5-7B-Instruct',
  kind: 'instruct',
  official: true,
  baseModel: 'Qwen/Qwen2.5-7B',
  license: 'apache-2.0',
  files: [
    { path: 'model-00001-of-00004.safetensors', size: 10, sha256: sha('a') },
    { path: 'model-00002-of-00004.safetensors', size: 10, sha256: sha('b') },
  ],
});
const QWEN_GGUF = model({
  repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
  kind: 'quantized',
  official: true,
  quantization: 'GGUF',
  baseModel: 'Qwen/Qwen2.5-7B-Instruct',
  files: [{ path: 'qwen2.5-7b-instruct-q4_k_m.gguf', size: 20, sha256: sha('c') }],
});
const LLAMA = model({
  repo: 'meta-llama/Llama-3.1-8B-Instruct',
  family: 'Llama',
  kind: 'instruct',
  official: true,
  files: [{ path: 'model-00001-of-00004.safetensors', size: 10, sha256: sha('d') }],
});
/** 社区量化仓库：文件名与常见的社区量化同名 */
const BARTOWSKI = model({
  repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
  kind: 'quantized',
  official: false,
  quantization: 'GGUF',
  files: [{ path: 'Qwen2.5-7B-Instruct-Q5_K_M.gguf', size: 30, sha256: sha('7') }],
});
const index = buildKnownModelIndex([QWEN, QWEN_GGUF, LLAMA, BARTOWSKI]);

test('sha256 命中已知模型：返回模型名、类型和来源仓库', () => {
  const [r] = matchKnownModels(index, [
    { path: 'x/model-00001-of-00004.safetensors', sha256: sha('a'), bytes: 10 },
  ]);
  assert.equal(r!.known?.name, 'Qwen2.5-7B-Instruct');
  assert.equal(r!.known?.kind, 'instruct');
  assert.equal(r!.known?.repo, 'Qwen/Qwen2.5-7B-Instruct');
  assert.equal(r!.known?.official, true);
  assert.equal(r!.known?.baseModel, 'Qwen/Qwen2.5-7B');
  assert.equal(r!.label, '已知模型：Qwen2.5-7B-Instruct（指令微调）');
  assert.deepEqual(r!.findings, []);
});

test('量化仓库命中时从文件名取量化类型；文件名里的 fp16、bf16 写法也能认出', () => {
  const [r] = matchKnownModels(index, [
    { path: 'qwen2.5-7b-instruct-q4_k_m.gguf', sha256: sha('c'), bytes: 20 },
  ]);
  assert.equal(r!.known?.kind, 'quantized');
  assert.equal(r!.known?.quantization, 'Q4_K_M');
  assert.equal(r!.label, '已知模型：Qwen2.5-7B-Instruct-GGUF（量化）');
  assert.equal(quantizationFromFileName('qwen2.5-7b-instruct-fp16-00001-of-00004.gguf'), 'F16');
  assert.equal(quantizationFromFileName('Qwen2.5-7B-Instruct-bf16.gguf'), 'BF16');
  assert.equal(quantizationFromFileName('model.FP32.gguf'), 'F32');
});

test('sha256 不命中：标「未在已知模型库中」，不报问题', () => {
  const [r] = matchKnownModels(index, [
    { path: 'my-finetune.safetensors', sha256: sha('9'), bytes: 1 },
  ]);
  assert.equal(r!.known, null);
  assert.equal(r!.label, '未在已知模型库中');
  assert.deepEqual(r!.findings, []);
});

test('文件名只属于一个官方仓库、大小相同但哈希不同：高危「与已知发布文件不一致」，说明写官方', () => {
  const [r] = matchKnownModels(index, [
    { path: 'qwen2.5-7b-instruct-q4_k_m.gguf', sha256: sha('e'), bytes: 20 },
  ]);
  assert.equal(r!.known, null);
  assert.equal(r!.findings.length, 1);
  const f = r!.findings[0]!;
  assert.equal(f.ruleId, 'KNOWN_MODEL_HASH_MISMATCH');
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.title, '与已知发布文件不一致');
  assert.match(f.detail, /官方仓库 Qwen\/Qwen2\.5-7B-Instruct-GGUF/);
  assert.match(f.detail, /cccccccccccccccc/);
});

test('同名但大小不同：只提示「同名但不是同一文件」，不报高危', () => {
  const [r] = matchKnownModels(index, [
    { path: 'qwen2.5-7b-instruct-q4_k_m.gguf', sha256: sha('e'), bytes: 21 },
  ]);
  assert.deepEqual(
    r!.findings.map((f) => [f.ruleId, f.severity, f.title]),
    [['KNOWN_MODEL_NAME_ONLY', 'INFO', '同名但不是同一文件']],
  );
  assert.match(r!.findings[0]!.detail, /其他发布者的版本或本地重新生成/);
});

test('社区仓库的同名文件不能单凭文件名认定来源（大小写不同、按官方 README 合并的文件也一样）', () => {
  for (const p of ['Qwen2.5-7B-Instruct-Q5_K_M.gguf', 'out/qwen2.5-7b-instruct-q5_k_m.gguf']) {
    const [r] = matchKnownModels(index, [{ path: p, sha256: sha('e'), bytes: 30 }], '/data');
    assert.deepEqual(r!.findings, [], p);
  }
});

test('社区仓库有上下文（同目录其他文件命中）时照常比对，说明里不写官方', () => {
  const idx = buildKnownModelIndex([
    model({
      repo: 'bartowski/Some-GGUF',
      kind: 'quantized',
      official: false,
      files: [
        { path: 'Some-Q4_K_M.gguf', size: 5, sha256: sha('1') },
        { path: 'Some-Q8_0.gguf', size: 8, sha256: sha('2') },
      ],
    }),
  ]);
  const rs = matchKnownModels(idx, [
    { path: 'd/Some-Q4_K_M.gguf', sha256: sha('1'), bytes: 5 },
    { path: 'd/Some-Q8_0.gguf', sha256: sha('3'), bytes: 8 },
  ]);
  const f = rs[1]!.findings[0]!;
  assert.equal(f.ruleId, 'KNOWN_MODEL_HASH_MISMATCH');
  assert.doesNotMatch(f.detail, /官方/);
  assert.match(f.detail, /bartowski\/Some-GGUF/);
});

test('同目录其他分片命中某仓库，同名分片哈希不同：按该仓库报高危', () => {
  const rs = matchKnownModels(index, [
    { path: 'm/model-00001-of-00004.safetensors', sha256: sha('a'), bytes: 10 },
    { path: 'm/model-00002-of-00004.safetensors', sha256: sha('f'), bytes: 10 },
  ]);
  assert.equal(rs[0]!.findings.length, 0);
  assert.equal(rs[1]!.findings[0]?.ruleId, 'KNOWN_MODEL_HASH_MISMATCH');
  assert.match(rs[1]!.findings[0]!.detail, /Qwen\/Qwen2\.5-7B-Instruct/);
});

test('目录名指向已知仓库（含 HF 缓存目录），同名文件哈希不同：报高危', () => {
  for (const root of [
    '/models/Qwen2.5-7B-Instruct',
    '/hf/hub/models--Qwen--Qwen2.5-7B-Instruct/snapshots/abc',
  ]) {
    const [r] = matchKnownModels(
      index,
      [{ path: 'model-00001-of-00004.safetensors', sha256: sha('f'), bytes: 10 }],
      root,
    );
    assert.equal(r!.findings[0]?.ruleId, 'KNOWN_MODEL_HASH_MISMATCH', root);
  }
});

test('通用文件名在多个仓库出现且没有上下文：不判定，避免误报', () => {
  const [r] = matchKnownModels(
    index,
    [{ path: 'model-00001-of-00004.safetensors', sha256: sha('f'), bytes: 10 }],
    '/data/x',
  );
  assert.equal(r!.label, '未在已知模型库中');
  assert.deepEqual(r!.findings, []);
});

test('通用分片名即使只属于一个已知仓库，没有上下文也不判定（自己微调的同规格模型不误报）', () => {
  const big = buildKnownModelIndex([
    model({
      repo: 'Qwen/Qwen2.5-72B-Instruct',
      kind: 'instruct',
      official: true,
      files: [{ path: 'model-00001-of-00037.safetensors', size: 10, sha256: sha('a') }],
    }),
  ]);
  const [r] = matchKnownModels(
    big,
    [{ path: 'model-00001-of-00037.safetensors', sha256: sha('f'), bytes: 10 }],
    '/data/my-ft',
  );
  assert.deepEqual(r!.findings, []);
});

test('一个哈希收录在多个仓库时，按同目录其他文件命中的仓库选', () => {
  const shared = { path: 'model-00002-of-00002.safetensors', size: 9, sha256: sha('5') };
  const idx = buildKnownModelIndex([
    model({
      repo: 'org/A',
      kind: 'base',
      official: true,
      files: [{ path: 'model-00001-of-00002.safetensors', size: 9, sha256: sha('4') }, shared],
    }),
    model({
      repo: 'mirror/B',
      kind: 'base',
      official: false,
      files: [{ path: 'model-00001-of-00002.safetensors', size: 9, sha256: sha('6') }, shared],
    }),
  ]);
  const inB = matchKnownModels(idx, [
    { path: 'b/model-00001-of-00002.safetensors', sha256: sha('6'), bytes: 9 },
    { path: 'b/model-00002-of-00002.safetensors', sha256: sha('5'), bytes: 9 },
  ]);
  assert.equal(inB[1]!.known?.repo, 'mirror/B');
  const alone = matchKnownModels(idx, [{ path: 'x.safetensors', sha256: sha('5'), bytes: 9 }]);
  assert.equal(alone[0]!.known?.repo, 'org/A', '没有上下文时按清单顺序，官方在前');
});

test('社区转存：与官方一致的文件显示官方仓库并注明哈希经转存核对；重新保存的标发布者重新保存版', () => {
  const idx = buildKnownModelIndex([
    model({
      repo: 'NousResearch/Meta-Llama-3-8B',
      family: 'Llama',
      kind: 'base',
      official: false,
      mirrorOf: 'meta-llama/Meta-Llama-3-8B',
      files: [
        {
          path: 'model-00001-of-00004.safetensors',
          size: 1,
          sha256: sha('1'),
          identicalToOfficial: true,
        },
      ],
    }),
    model({
      repo: 'unsloth/gemma-2b-it',
      family: 'Gemma',
      kind: 'instruct',
      official: false,
      mirrorOf: 'google/gemma-2b-it',
      files: [{ path: 'model.safetensors', size: 1, sha256: sha('2'), identicalToOfficial: false }],
    }),
  ]);
  const [same, resaved] = matchKnownModels(idx, [
    { path: 'a/model-00001-of-00004.safetensors', sha256: sha('1'), bytes: 1 },
    { path: 'b/model.safetensors', sha256: sha('2'), bytes: 1 },
  ]);
  assert.equal(same!.known?.repo, 'meta-llama/Meta-Llama-3-8B');
  assert.equal(same!.known?.official, true);
  assert.equal(same!.known?.verifiedVia, 'NousResearch/Meta-Llama-3-8B');
  assert.equal(same!.known?.source, 'https://huggingface.co/meta-llama/Meta-Llama-3-8B');
  assert.equal(same!.label, '已知模型：Meta-Llama-3-8B（基座）');
  assert.equal(resaved!.known?.repo, 'unsloth/gemma-2b-it');
  assert.equal(resaved!.known?.official, false);
  assert.deepEqual(resaved!.known?.copyOf, {
    repo: 'google/gemma-2b-it',
    publisher: 'unsloth',
    resaved: true,
  });
  assert.equal(resaved!.label, '已知模型：gemma-2b-it（unsloth 重新保存版）');
});

test('哈希取自 ModelScope 的官方仓库：注明核对来源', () => {
  const idx = buildKnownModelIndex([
    model({
      repo: 'meta-llama/Llama-3.2-1B',
      family: 'Llama',
      kind: 'base',
      official: true,
      hashVia: 'ModelScope LLM-Research/Llama-3.2-1B',
      source: 'https://modelscope.cn/models/LLM-Research/Llama-3.2-1B/files',
      files: [{ path: 'model.safetensors', size: 1, sha256: sha('3') }],
    }),
  ]);
  const [r] = matchKnownModels(idx, [{ path: 'model.safetensors', sha256: sha('3'), bytes: 1 }]);
  assert.equal(r!.known?.verifiedVia, 'ModelScope LLM-Research/Llama-3.2-1B');
  assert.equal(r!.known?.official, true);
});

test('命中官方旧版本：识别为该仓库并给一条提示「官方旧版本」', () => {
  const idx = buildKnownModelIndex([
    model({
      repo: 'Qwen/Qwen2.5-7B-Instruct',
      kind: 'instruct',
      official: true,
      files: [{ path: 'model-00001-of-00004.safetensors', size: 10, sha256: sha('a') }],
      previousFiles: [
        {
          path: 'model-00001-of-00004.safetensors',
          size: 10,
          sha256: sha('8'),
          revision: 'd1e200fcf9aa',
          date: '2024-09-16T13:55:22.000Z',
        },
      ],
    }),
  ]);
  const [r] = matchKnownModels(idx, [
    { path: 'model-00001-of-00004.safetensors', sha256: sha('8'), bytes: 10 },
  ]);
  assert.equal(r!.known?.repo, 'Qwen/Qwen2.5-7B-Instruct');
  assert.deepEqual(r!.known?.previous, {
    revision: 'd1e200fcf9aa',
    date: '2024-09-16T13:55:22.000Z',
  });
  assert.equal(r!.label, '已知模型：Qwen2.5-7B-Instruct（指令微调，官方旧版本）');
  assert.deepEqual(
    r!.findings.map((f) => [f.ruleId, f.severity, f.title]),
    [['KNOWN_MODEL_OLD_VERSION', 'INFO', '官方旧版本']],
  );
});

test('applyKnownModels 把识别结果写进 meta 并追加问题', () => {
  const files = applyKnownModels(
    [
      {
        path: 'qwen2.5-7b-instruct-q4_k_m.gguf',
        sha256: sha('c'),
        format: 'gguf',
        bytes: 20,
        findings: [] as ModelFinding[],
        meta: {} as Record<string, unknown>,
      },
      {
        path: 'other/qwen2.5-7b-instruct-q4_k_m.gguf',
        sha256: sha('e'),
        format: 'gguf',
        bytes: 20,
        findings: [] as ModelFinding[],
        meta: {} as Record<string, unknown>,
      },
    ],
    '',
    index,
  );
  assert.equal((files[0]!.meta.knownModel as { name: string }).name, 'Qwen2.5-7B-Instruct-GGUF');
  assert.equal(files[0]!.meta.knownModelLabel, '已知模型：Qwen2.5-7B-Instruct-GGUF（量化）');
  assert.equal(files[1]!.meta.knownModel, null);
  assert.equal(files[1]!.findings[0]?.ruleId, 'KNOWN_MODEL_HASH_MISMATCH');
});

test('数据文件有坏行：跳过坏行，其余照常匹配，扫描结果给一条提示', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lse-km-bad-'));
  try {
    const file = join(dir, 'known.jsonl');
    writeFileSync(
      file,
      [JSON.stringify(QWEN), '{坏行', JSON.stringify({ ...QWEN_GGUF, kind: 'other' }), ''].join(
        '\n',
      ),
    );
    const r = readKnownModels(file);
    assert.equal(r.models.length, 1);
    assert.deepEqual(
      r.invalid.map((x) => x.line),
      [2, 3],
    );
    assert.equal(loadKnownModels(file).length, 1);
    const missing = readKnownModels(join(dir, 'nope.jsonl'));
    assert.equal(missing.models.length, 0);
    assert.equal(missing.invalid.length, 1);
    const files = applyKnownModels(
      [
        {
          path: 'model-00001-of-00004.safetensors',
          sha256: sha('a'),
          format: 'safetensors',
          bytes: 10,
          findings: [] as ModelFinding[],
          meta: {} as Record<string, unknown>,
        },
      ],
      '',
      buildKnownModelIndex(r.models, r.invalid),
    );
    assert.equal(files[0]!.meta.knownModelLabel, '已知模型：Qwen2.5-7B-Instruct（指令微调）');
    const note = files[0]!.findings.find((f) => f.ruleId === 'KNOWN_MODELS_DATA_INVALID');
    assert.ok(note);
    assert.equal(note!.severity, 'LOW');
    assert.match(note!.detail, /第 2 行/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实数据：lmstudio-community、second-state、QuantFactory 的同名量化不报高危', () => {
  const idx = knownModelIndex();
  // 审查时从 hf-mirror 文件树取的真实大小和 sha256
  const cases: Array<[string, string, number, string]> = [
    [
      'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
      '3e357ab3eda2c442f25c0080bb8998eedc05fd16ce1728eacff9ccc5c3d240c6',
      4683073952,
      '',
    ],
    [
      'qwen/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
      'a30c3c08ca3284a7b59fa35cd835ec50b4a54e211379692b0e48a34bdb72c2fb',
      4683073952,
      '/data/models',
    ],
    [
      'Mistral-7B-Instruct-v0.3.Q4_K_M.gguf',
      'f43b5a008d8889a88c9171bf51200359b5c1539d901f21a811d53e9430eca952',
      4372811712,
      '',
    ],
    // 按 Qwen 官方 README 用 llama-gguf-split 合并两个分片得到的小写文件名
    ['out/qwen2.5-7b-instruct-q4_k_m.gguf', sha('1'), 4683073632, '/data'],
  ];
  for (const [path, sha256, bytes, root] of cases) {
    const [r] = matchKnownModels(idx, [{ path, sha256, bytes }], root);
    assert.ok(
      !r!.findings.some((f) => f.severity === 'HIGH'),
      `${path}：${r!.findings.map((f) => f.detail).join('；')}`,
    );
  }
});

test('真实数据：官方指令版、受限官方仓库（ModelScope 核对）、社区转存和重新保存版的识别', () => {
  const idx = knownModelIndex();
  const rec = (repo: string) => idx.models.find((m) => m.repo === repo)!;
  const qwen = rec('Qwen/Qwen2.5-7B-Instruct');
  assert.equal(qwen.official, true);
  assert.match(
    qwen.source,
    /^https:\/\/huggingface\.co\/Qwen\/Qwen2\.5-7B-Instruct\/tree\/[0-9a-f]{40}$/,
  );
  const llama = rec('meta-llama/Meta-Llama-3-8B');
  assert.equal(llama.official, true);
  assert.match(llama.hashVia ?? '', /^ModelScope /);
  const nous = rec('NousResearch/Meta-Llama-3-8B');
  assert.equal(nous.mirrorOf, 'meta-llama/Meta-Llama-3-8B');
  const sameFile = nous.files.find((f) => f.identicalToOfficial === true)!;
  assert.ok(sameFile, 'NousResearch/Meta-Llama-3-8B 应有与官方一致的文件');
  const [hit] = matchKnownModels(idx, [
    { path: sameFile.path, sha256: sameFile.sha256, bytes: sameFile.size },
  ]);
  assert.equal(hit!.known?.repo, 'meta-llama/Meta-Llama-3-8B');
  assert.equal(hit!.known?.official, true);
  const gemma = rec('unsloth/gemma-2b-it');
  assert.ok(
    gemma.files.every((f) => f.identicalToOfficial === false),
    '审查人核对过：重新保存版',
  );
  const [g] = matchKnownModels(idx, [
    { path: gemma.files[0]!.path, sha256: gemma.files[0]!.sha256, bytes: gemma.files[0]!.size },
  ]);
  assert.equal(g!.known?.official, false);
  assert.match(g!.label, /unsloth 重新保存版/);
});

test('数据文件：每行能解析，sha256 为 64 位小写十六进制，仓库数和系列覆盖达标，来源记官方地址', () => {
  const lines = readFileSync(KNOWN_MODELS_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const models = lines.map((l, i) => {
    try {
      return parseKnownModelLine(l);
    } catch (e) {
      throw new Error(`第 ${i + 1} 行无法解析：${e instanceof Error ? e.message : e}`);
    }
  });
  assert.ok(models.length >= 120, `仓库数 ${models.length} 少于 120`);
  const repos = new Set(models.map((m) => m.repo));
  assert.equal(repos.size, models.length, '仓库不得重复');
  for (const m of models) {
    assert.ok(m.files.length > 0, `${m.repo} 没有文件`);
    assert.equal(typeof m.official, 'boolean', `${m.repo} 缺少 official`);
    assert.match(
      m.source,
      /^https:\/\/(?:huggingface\.co|modelscope\.cn)\//,
      `${m.repo} ${m.source}`,
    );
    for (const f of [...m.files, ...(m.previousFiles ?? [])])
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${m.repo} ${f.path}`);
    if (m.mirrorOf) assert.equal(m.official, false, `${m.repo} 转存不能标官方`);
  }
  assert.ok(models.some((m) => m.official) && models.some((m) => !m.official));
  assert.ok(
    models.some((m) => m.previousFiles?.length),
    '应收录官方旧版本',
  );
  const families = new Set(models.map((m) => m.family));
  for (const fam of [
    'Qwen',
    'DeepSeek',
    'GLM',
    'Llama',
    'Mistral',
    'InternLM',
    'Baichuan',
    'Yi',
    'Gemma',
    'Phi',
  ])
    assert.ok(families.has(fam), `缺少系列 ${fam}`);
  const kinds = new Set(models.map((m) => m.kind));
  for (const k of ['base', 'instruct', 'quantized', 'lora', 'merged'])
    assert.ok(kinds.has(k as never), `缺少类型 ${k}`);
  assert.ok(
    models.some((m) => m.files.some((f) => f.path.endsWith('.gguf'))),
    '缺少 GGUF 量化仓库',
  );
});

test('首次使用时加载数据文件，之后复用；真实条目的 sha256 能命中', () => {
  const idx = knownModelIndex();
  assert.equal(knownModelIndex(), idx);
  assert.deepEqual(idx.invalid, []);
  const first = loadKnownModels(KNOWN_MODELS_FILE)[0]!;
  const file = first.files[0]!;
  const [r] = matchKnownModels(idx, [{ path: file.path, sha256: file.sha256, bytes: file.size }]);
  assert.ok(r!.known, '应命中');
  assert.equal(r!.known!.repo, first.repo);
  assert.equal(r!.known!.name, first.name);
});

test('解析拒绝不合规的行', () => {
  const ok = {
    repo: 'a/b',
    name: 'b',
    family: 'Qwen',
    org: 'a',
    kind: 'base',
    official: true,
    files: [{ path: 'x.safetensors', size: 1, sha256: sha('a') }],
    source: 's',
    fetchedAt: 't',
  };
  assert.doesNotThrow(() => parseKnownModelLine(JSON.stringify(ok)));
  assert.throws(() => parseKnownModelLine(JSON.stringify({ ...ok, kind: 'other' })));
  assert.throws(() =>
    parseKnownModelLine(JSON.stringify({ ...ok, files: [{ path: 'x', size: 1, sha256: 'abc' }] })),
  );
  assert.throws(() => parseKnownModelLine(JSON.stringify({ ...ok, repo: 'nope' })));
  assert.throws(() => parseKnownModelLine(JSON.stringify({ ...ok, official: 'yes' })));
  assert.throws(() => parseKnownModelLine(JSON.stringify({ ...ok, mirrorOf: 'bad' })));
  assert.throws(() =>
    parseKnownModelLine(
      JSON.stringify({ ...ok, previousFiles: [{ path: 'x', size: 1, sha256: sha('b') }] }),
    ),
  );
});
