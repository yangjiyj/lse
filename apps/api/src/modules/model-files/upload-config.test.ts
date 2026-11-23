import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('上传默认没有人为大小上限并允许显式配置为零', () => {
  for (const limit of [undefined, '0', '1099511627776']) {
    const env = { ...process.env };
    if (limit === undefined) delete env.MODEL_SCAN_UPLOAD_MAX_BYTES;
    else env.MODEL_SCAN_UPLOAD_MAX_BYTES = limit;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const { config } = await import('./src/config.ts'); process.exit(config.MODEL_SCAN_UPLOAD_MAX_BYTES === ${limit ?? '0'} ? 0 : 20)`,
      ],
      { env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, '配置应接受零或正数，默认值应为零');
  }
});
