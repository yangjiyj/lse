import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAllowedDirectory, type ScannedFile } from '../src/modules/model-files/filesystem.js';
import { identifyModels, type ModelIdentification } from '../src/modules/model-files/identify.js';
import { buildKnownModelIndex, type KnownModel } from '../src/modules/model-files/known-models.js';

/** 夹具由 fixtures/model-files/gen_identify.py 生成到临时目录。 */
const here = dirname(fileURLToPath(import.meta.url));
const limits = { pickleMaxBytes: 1024 * 1024, totalMaxBytes: 64 * 1024 * 1024, maxFiles: 1000 };
let dir = '';
let files: ScannedFile[] = [];
let root = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lse-mf-identify-'));
  execFileSync('python3', [join(here, 'fixtures/model-files/gen_identify.py'), dir], {
    cwd: join(here, 'fixtures/model-files'),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: 'pipe',
  });
  const r = await scanAllowedDirectory(dir, [dir], limits);
  root = r.root;
  files = identifyModels(r.files, r.root, buildKnownModelIndex([]));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const file = (p: string) => {
  const f = files.find((x) => x.path === p);
  assert.ok(f, `缺少文件 ${p}，实际：${files.map((x) => x.path).join(', ')}`);
  return f!;
};
const id = (p: string) => file(p).meta.identification as ModelIdentification | undefined;

test('GGUF：general.file_type 为 Q4_K_M → 量化', () => {
  const r = id('q4/demo-7b-q4_k_m.gguf')!;
  assert.equal(r.verdict, 'quantized');
  assert.equal(r.verdictLabel, '量化');
  assert.equal(r.quantization, 'Q4_K_M');
  assert.equal(r.name, 'Demo-7B');
  assert.equal(r.architecture, 'llama');
});

test('GGUF：general.file_type 为 F16、不在已知库 → 未识别（只记精度）', () => {
  const r = id('f16/demo-7b-f16.gguf')!;
  assert.equal(r.verdict, 'unidentified');
  assert.equal(r.verdictLabel, '未识别');
  assert.equal(r.dtype, 'F16');
  assert.equal(r.quantization, undefined);
});

test('safetensors + config.json 的 quantization_config：AWQ、FP8 → 量化', () => {
  const awq = id('awq/model.safetensors')!;
  assert.equal(awq.verdict, 'quantized');
  assert.equal(awq.quantization, 'AWQ 4bit');
  assert.equal(awq.architecture, 'Qwen2ForCausalLM');
  assert.equal(awq.modelType, 'qwen2');
  assert.ok(
    awq.basis.some((b) => b.includes('quant_method')),
    awq.basis.join('；'),
  );
  assert.equal(id('fp8/model.safetensors')!.quantization, 'FP8');
});

test('safetensors 含 F8 类型的权重张量（其余为 BF16）、config.json 没写量化配置 → 量化 FP8', () => {
  const r = id('fp8mix/model.safetensors')!;
  assert.equal(r.verdict, 'quantized');
  assert.equal(r.quantization, 'FP8');
  assert.ok(
    r.basis.some((b) => b.includes('含有 F8 类型的权重张量')),
    r.basis.join('；'),
  );
});

test('adapter_config.json → 适配器（LoRA），取 r、lora_alpha、target_modules、基座', () => {
  const r = id('lora/adapter_model.safetensors')!;
  assert.equal(r.verdict, 'adapter');
  assert.equal(r.verdictLabel, '适配器（LoRA/PEFT）');
  assert.equal(r.baseModel, 'Qwen/Qwen2.5-7B-Instruct');
  assert.deepEqual(r.lora, {
    peftType: 'LORA',
    r: 8,
    alpha: 16,
    targetModules: ['q_proj', 'v_proj'],
  });
});

test('不在已知库、无量化、无适配器、无训练痕迹 → 未识别', () => {
  const r = id('plain/model.safetensors')!;
  assert.equal(r.verdict, 'unidentified');
  assert.equal(r.verdictLabel, '未识别');
  assert.equal(r.dtype, 'bfloat16');
  assert.equal(r.architecture, 'LlamaForCausalLM');
});

test('同目录有 mergekit 配置 → 合并；有 training_args.bin → 微调（全参）', () => {
  assert.equal(id('merged/model.safetensors')!.verdict, 'merged');
  const ft = id('ft/model.safetensors')!;
  assert.equal(ft.verdict, 'finetuned');
  assert.equal(ft.verdictLabel, '微调（全参）');
  assert.equal(ft.baseModel, 'Qwen/Qwen2.5-7B');
});

test('配置文件和训练产物不出识别结论，配置文件按 config 格式扫描', () => {
  assert.equal(file('plain/config.json').format, 'config');
  assert.equal(id('plain/config.json'), undefined);
  assert.equal(id('ft/training_args.bin'), undefined);
  assert.equal(file('lora/adapter_config.json').format, 'config');
});

/** 去掉已有识别结果，换一个已知库重新识别。 */
function reidentify(index: ReturnType<typeof buildKnownModelIndex>) {
  const raw = files.map((f) => {
    const { identification: _i, knownModel: _k, knownModelLabel: _l, ...meta } = f.meta;
    return {
      ...f,
      meta,
      findings: f.findings.filter((x) => !x.ruleId.startsWith('KNOWN_MODEL')),
    };
  });
  const out = identifyModels(raw, root, index);
  return (p: string) => out.find((f) => f.path === p)!;
}
const known = (
  m: Partial<KnownModel> & Pick<KnownModel, 'repo' | 'kind'>,
  file: ScannedFile,
  path = file.path.split('/').pop()!,
): KnownModel => ({
  name: m.repo.split('/')[1]!,
  family: 'Qwen',
  org: m.repo.split('/')[0]!,
  files: [{ path, size: file.bytes, sha256: file.sha256 }],
  source: `https://huggingface.co/${m.repo}/tree/0`,
  fetchedAt: '2026-11-21T00:00:00.000Z',
  ...m,
});

test('命中官方指令版：结论为原始（官方指令版），保留来源和基座', () => {
  const plain = file('plain/model.safetensors');
  const get = reidentify(
    buildKnownModelIndex([
      known(
        {
          repo: 'Qwen/Qwen2.5-7B-Instruct',
          kind: 'instruct',
          official: true,
          baseModel: 'Qwen/Qwen2.5-7B',
        },
        plain,
      ),
    ]),
  );
  const p = get('plain/model.safetensors');
  const r = p.meta.identification as ModelIdentification;
  assert.equal(p.meta.knownModelLabel, '已知模型：Qwen2.5-7B-Instruct（指令微调）');
  assert.equal(r.verdict, 'original');
  assert.equal(r.verdictLabel, '原始（官方指令版）');
  assert.equal(r.baseModel, 'Qwen/Qwen2.5-7B');
});

test('命中官方基座：原始；命中社区微调：微调（全参）并带基座', () => {
  const plain = file('plain/model.safetensors');
  const base = reidentify(
    buildKnownModelIndex([known({ repo: 'Qwen/Qwen2.5-7B', kind: 'base', official: true }, plain)]),
  )('plain/model.safetensors').meta.identification as ModelIdentification;
  assert.equal(base.verdict, 'original');
  assert.equal(base.verdictLabel, '原始');
  const ft = reidentify(
    buildKnownModelIndex([
      known(
        {
          repo: 'HuggingFaceH4/zephyr-7b-beta',
          kind: 'instruct',
          official: false,
          baseModel: 'mistralai/Mistral-7B-v0.1',
        },
        plain,
      ),
    ]),
  )('plain/model.safetensors').meta.identification as ModelIdentification;
  assert.equal(ft.verdict, 'finetuned');
  assert.equal(ft.verdictLabel, '微调（全参）');
  assert.equal(ft.baseModel, 'mistralai/Mistral-7B-v0.1');
});

test('已知量化仓库里的 F16 文件：原始（格式转换），不算量化', () => {
  const f16 = file('f16/demo-7b-f16.gguf');
  const r = reidentify(
    buildKnownModelIndex([
      known(
        {
          repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
          kind: 'quantized',
          official: true,
          quantization: 'GGUF',
        },
        f16,
        'qwen2.5-7b-instruct-fp16.gguf',
      ),
    ]),
  )('f16/demo-7b-f16.gguf').meta.identification as ModelIdentification;
  assert.equal(r.verdict, 'original');
  assert.equal(r.verdictLabel, '原始（格式转换）');
  assert.equal(r.quantization, undefined);
  assert.equal(r.dtype, 'F16');
});

test('社区转存：与官方一致按官方原始；重新保存版标原始（重新保存版）', () => {
  const plain = file('plain/model.safetensors');
  const mk = (identicalToOfficial: boolean) =>
    reidentify(
      buildKnownModelIndex([
        {
          ...known(
            {
              repo: 'unsloth/gemma-2b-it',
              family: 'Gemma',
              kind: 'instruct',
              official: false,
              mirrorOf: 'google/gemma-2b-it',
            },
            plain,
          ),
          files: [
            {
              path: 'model.safetensors',
              size: plain.bytes,
              sha256: plain.sha256,
              identicalToOfficial,
            },
          ],
        },
      ]),
    )('plain/model.safetensors');
  const same = mk(true);
  assert.equal(
    (same.meta.identification as ModelIdentification).verdictLabel,
    '原始（官方指令版）',
  );
  assert.equal((same.meta.knownModel as { repo: string }).repo, 'google/gemma-2b-it');
  const resaved = mk(false);
  assert.equal(
    (resaved.meta.identification as ModelIdentification).verdictLabel,
    '原始（重新保存版）',
  );
  assert.equal(resaved.meta.knownModelLabel, '已知模型：gemma-2b-it（unsloth 重新保存版）');
});
