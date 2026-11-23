import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAllowedDirectory } from '../src/modules/model-files/filesystem.js';
import { maliciousPickle, safePickle } from './helpers/model-file-fixtures.js';

const limits = { pickleMaxBytes: 1024 * 1024, totalMaxBytes: 1024 * 1024, maxFiles: 10 };

test('HF 缓存式符号链接：白名单内的链接解析后扫描，白名单外的链接跳过且不逃逸', async () => {
  const base = await mkdtemp(join(tmpdir(), 'lse-model-scan-'));
  try {
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    const blobs = join(root, 'hub', 'models--x', 'blobs');
    const snap = join(root, 'hub', 'models--x', 'snapshots', 'abc');
    await mkdir(blobs, { recursive: true });
    await mkdir(snap, { recursive: true });
    await mkdir(outside);
    await writeFile(join(blobs, 'sha-evil'), maliciousPickle());
    await writeFile(join(outside, 'secret.pkl'), 'cos\nsystem\n.');
    await symlink(join(blobs, 'sha-evil'), join(snap, 'pytorch_model.bin'));
    await symlink(outside, join(root, 'escape'), 'junction');
    const r = await scanAllowedDirectory(join(root, 'hub'), [root], limits);
    assert.deepEqual(
      r.files.map((f) => f.path),
      ['models--x/snapshots/abc/pytorch_model.bin'],
    );
    assert.ok(r.files[0]!.findings.some((f) => f.severity === 'HIGH'));
    const whole = await scanAllowedDirectory(root, [root], limits);
    assert.deepEqual(whole.rejectedLinks, ['escape']);
    assert.ok(!whole.files.some((f) => f.path.includes('secret')));
    await assert.rejects(scanAllowedDirectory(join(root, 'escape'), [root], limits), /白名单/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('超过数量/总量上限返回部分结果并标注，而不是整单失败', async () => {
  const base = await mkdtemp(join(tmpdir(), 'lse-model-scan-'));
  try {
    for (const n of ['a.pkl', 'b.pkl', 'c.pkl']) await writeFile(join(base, n), safePickle());
    const r = await scanAllowedDirectory(base, [base], { ...limits, maxFiles: 2 });
    assert.equal(r.files.length, 2);
    assert.equal(r.truncatedFiles, 1);
    assert.match(r.truncatedReason ?? '', /数量超过上限 2/);
    const t = await scanAllowedDirectory(base, [base], {
      ...limits,
      totalMaxBytes: safePickle().length + 1,
    });
    assert.equal(t.files.length, 1);
    assert.match(t.truncatedReason ?? '', /总量上限/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('取消信号中止扫描', async () => {
  const base = await mkdtemp(join(tmpdir(), 'lse-model-scan-'));
  try {
    await writeFile(join(base, 'a.pkl'), safePickle());
    await assert.rejects(
      scanAllowedDirectory(base, [base], limits, { isCancelled: async () => true }),
      /已取消/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
