import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanModelBytes } from '../src/modules/model-files/scanner.js';

/**
 * 样本驱动回归：运行 fixtures/model-files/gen_samples.py 生成全部样本到临时目录，
 * 逐个断言“必须命中”与“不得误报”。需要 python3 与 numpy（开发机与 CI 均具备）。
 */
interface Expect {
  file: string;
  maxSeverity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';
  minHigh?: number;
  maxHigh?: number;
  rules?: string[];
  format?: string;
  note?: string;
}
const ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const here = dirname(fileURLToPath(import.meta.url));
let dir = '';
let manifest: Expect[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lse-mf-samples-'));
  execFileSync('python3', [join(here, 'fixtures/model-files/gen_samples.py'), dir], {
    cwd: join(here, 'fixtures/model-files'),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: 'pipe',
  });
  manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Expect[];
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('样本清单覆盖全部要求的类别', () => {
  const files = manifest.map((m) => m.file);
  for (const want of [
    'p0_os_system.pkl', 'p1_os_system.pkl', 'p2_os_system.pkl', 'p4_os_system.pkl', 'p5_os_system.pkl',
    'p2_subprocess_popen.pkl', 'p4_builtins_eval.pkl', 'p4_ctypes_cdll.pkl', 'p4_pickle_loads_nested.pkl',
    'proto0_payload.bin', 'multi_legacy_evil.bin', 'zip_extra_evil.pt', 'state_dict_bf16.pt',
    'state_dict_fp16.pt', 'state_dict_fp32.pt', 'object_evil.npy', 'oob.safetensors',
    'bad_dtype.safetensors', 'size_mismatch.safetensors', 'ok.safetensors',
    'real_qwen2.5-3b-instruct.gguf', 'real_llama3-8b-instruct.gguf', 'ssti_mro.gguf',
  ])
    assert.ok(files.includes(want), `缺少样本 ${want}`);
});

test('每个样本：命中与不误报双向断言', async () => {
  const failures: string[] = [];
  for (const m of manifest) {
    const r = await scanModelBytes(m.file, await readFile(join(dir, m.file)));
    const worst = Math.max(...r.findings.map((f) => ORDER.indexOf(f.severity)), 0);
    const high = r.findings.filter((f) => f.severity === 'HIGH' || f.severity === 'CRITICAL').length;
    const ids = r.findings.map((f) => `${f.severity}:${f.ruleId}`).join(',');
    if (worst !== ORDER.indexOf(m.maxSeverity) && !(m.maxSeverity === 'LOW' && worst <= 1))
      failures.push(`${m.file} 最高严重度 ${ORDER[worst]}，期望 ${m.maxSeverity} [${ids}]`);
    if (m.minHigh !== undefined && high < m.minHigh) failures.push(`${m.file} 高危 ${high} < ${m.minHigh} [${ids}]`);
    if (m.maxHigh !== undefined && high > m.maxHigh) failures.push(`${m.file} 高危 ${high} > ${m.maxHigh}（重复计数） [${ids}]`);
    for (const rule of m.rules ?? [])
      if (!r.findings.some((f) => f.ruleId === rule)) failures.push(`${m.file} 未命中 ${rule} [${ids}]`);
    if (m.format && r.format !== m.format) failures.push(`${m.file} 格式 ${r.format}，期望 ${m.format}`);
  }
  assert.deepEqual(failures, []);
});
