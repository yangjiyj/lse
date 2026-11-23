import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { prisma } from '../../db.js';
import { runModelFileScan, uploadPathFor } from './executor.js';
import { UPLOAD_DIR } from './service.js';

// 需要本车道独立测试库，交由总控在沙箱外执行。
test('完整扫描及重复投递均保留库文件，一次性上传完成后清理且历史扫描不丢失', async () => {
  await mkdir(UPLOAD_DIR, { recursive: true });
  for (const libraryUpload of [true, false]) {
    const uploadId = randomUUID();
    const fileName = '模型.pkl';
    const contents = Buffer.from('N.');
    let scanId: string | undefined;
    try {
      await writeFile(uploadPathFor(uploadId), contents);
      if (libraryUpload) {
        await prisma.modelFileUpload.create({
          data: {
            id: uploadId,
            fileName,
            bytes: BigInt(contents.length),
            expectedBytes: BigInt(contents.length),
            storedPath: uploadId,
            status: 'READY',
            completedAt: new Date(),
          },
        });
      }
      const scan = await prisma.modelFileScan.create({
        data: {
          source: 'UPLOAD',
          path: fileName,
          status: 'PENDING',
          uploadId: libraryUpload ? uploadId : null,
          request: { uploadId, fileName, libraryUpload, aibom: {} },
        },
      });
      scanId = scan.id;
      await runModelFileScan(scanId);
      await runModelFileScan(scanId);
      const completed = await prisma.modelFileScan.findUniqueOrThrow({ where: { id: scanId } });
      assert.equal(completed.status, 'COMPLETED', completed.error ?? '扫描应成功完成');
      if (libraryUpload) {
        assert.deepEqual(await readFile(uploadPathFor(uploadId)), contents);
        assert.equal(completed.uploadId, uploadId);
        assert.equal((completed.request as { uploadId: string }).uploadId, uploadId);
        await prisma.modelFileUpload.delete({ where: { id: uploadId } });
        assert.equal(
          (await prisma.modelFileScan.findUniqueOrThrow({ where: { id: scanId } })).uploadId,
          null,
        );
      } else {
        await assert.rejects(readFile(uploadPathFor(uploadId)), { code: 'ENOENT' });
      }
    } finally {
      if (scanId) await prisma.modelFileScan.deleteMany({ where: { id: scanId } });
      if (libraryUpload) await prisma.modelFileUpload.deleteMany({ where: { id: uploadId } });
      await rm(uploadPathFor(uploadId), { force: true });
    }
  }
});
