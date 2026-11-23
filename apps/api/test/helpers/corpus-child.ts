import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// 语料扫描核心的内存测试：在单独的子进程里跑（--expose-gc，用 maxRSS 量峰值），不受测试进程里别的对象干扰。

const run = promisify(execFile);
const CORE = fileURLToPath(new URL('../../src/modules/corpus-scans/core/', import.meta.url));

/** 子进程里执行 body（ESM 模块代码，可用 top-level await；变量 CORE 是 core 目录的绝对路径，末尾带 /），返回它最后打印的 JSON。 */
export async function runCoreChild<T>(body: string): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'corpus-child-'));
  try {
    const file = join(dir, 'child.mjs');
    await writeFile(file, `const CORE = ${JSON.stringify(CORE)};\n${body}\n`);
    const { stdout } = await run(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--expose-gc', file],
      { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
    );
    const last = stdout.trim().split('\n').pop() ?? '';
    return JSON.parse(last) as T;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
