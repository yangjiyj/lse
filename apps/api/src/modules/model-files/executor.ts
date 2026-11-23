import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import type { AibomOptions } from './aibom.js';
import { scanAllowedDirectory, ScanCancelled, type DirectoryScanResult, type ScanHooks } from './filesystem.js';
import { identifyModels } from './identify.js';
import { linkAutoMap } from './script-scan.js';
import { scanModelSource, sourceSha256 } from './scanner.js';
import { fileSource } from './source.js';
import { completeScan, effectiveRoots, loadConfig } from './service.js';
import { cleanupScanUpload, uploadPathFor } from './upload-storage.js';
export { removeUpload, uploadPathFor, uploadMetaPathFor } from './upload-storage.js';

/** 扫描记录 request 字段：入队时写入，worker 执行时读取。 */
export interface ScanRequest {
  uploadId?: string;
  libraryUpload?: boolean;
  fileName?: string;
  displayName?: string;
  aibom: AibomOptions;
}

async function isCancelled(scanId: string): Promise<boolean> {
  const row = await prisma.modelFileScan.findUnique({ where: { id: scanId }, select: { status: true } });
  return !row || row.status === 'CANCELLED';
}

async function scanUpload(req: ScanRequest, limits: { pickleMaxBytes: number }, hooks: ScanHooks): Promise<DirectoryScanResult> {
  const src = await fileSource(uploadPathFor(req.uploadId!));
  try {
    const fileName = req.fileName!;
    const scan = await scanModelSource(fileName, src, limits);
    let bytes = 0;
    let last = Date.now();
    const sha256 = await sourceSha256(src, async (n) => {
      bytes += n;
      if (Date.now() - last > 1000) {
        last = Date.now();
        if (await hooks.isCancelled?.()) throw new ScanCancelled('扫描已取消');
        await hooks.onProgress?.({ files: 0, bytes, totalFiles: 1, totalBytes: src.size });
      }
    });
    await hooks.onProgress?.({ files: 1, bytes, totalFiles: 1, totalBytes: src.size });
    return {
      root: fileName,
      files: [{ ...scan, path: req.displayName || fileName, bytes: src.size, sha256 }],
      skipped: 0,
      totalBytes: src.size,
      truncatedFiles: 0,
      truncatedReason: null,
      rejectedLinks: [],
    };
  } finally {
    await src.close();
  }
}

/**
 * worker 执行入口：PENDING → RUNNING → COMPLETED/FAILED/CANCELLED。
 * 只有抢到 PENDING 的执行者才会处理（重复投递幂等）；一次性上传无论成败都删除，库文件保留。
 */
export async function runModelFileScan(scanId: string): Promise<void> {
  const claimed = await prisma.modelFileScan.updateMany({
    where: { id: scanId, status: 'PENDING' },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  const row = await prisma.modelFileScan.findUnique({ where: { id: scanId } });
  if (!row) return;
  const req = (row.request ?? { aibom: {} }) as unknown as ScanRequest;
  if (claimed.count === 0) {
    if (row.status !== 'RUNNING') await cleanupScanUpload(req);
    return;
  }
  const hooks: ScanHooks = {
    isCancelled: () => isCancelled(scanId),
    onProgress: async (p) => {
      await prisma.modelFileScan.updateMany({
        where: { id: scanId, status: 'RUNNING' },
        data: {
          progressFiles: p.files,
          progressBytes: BigInt(p.bytes),
          plannedFiles: p.totalFiles,
          plannedBytes: BigInt(p.totalBytes),
        },
      });
    },
  };
  try {
    const cfg = await loadConfig();
    const r =
      row.source === 'UPLOAD'
        ? await scanUpload(req, cfg, hooks)
        : await scanAllowedDirectory(row.path, effectiveRoots(cfg), cfg, hooks);
    const files = linkAutoMap(identifyModels(r.files, row.source === 'DIRECTORY' ? r.root : ''));
    await completeScan(scanId, { ...r, files, aibom: req.aibom });
  } catch (e) {
    const cancelled = e instanceof ScanCancelled;
    await prisma.modelFileScan.updateMany({
      where: { id: scanId, status: 'RUNNING' },
      data: {
        status: cancelled ? 'CANCELLED' : 'FAILED',
        error: cancelled ? null : (e instanceof Error ? e.message : '扫描失败').slice(0, 1000),
        finishedAt: new Date(),
      },
    });
  } finally {
    await cleanupScanUpload(req);
    if (req.uploadId && !req.libraryUpload) {
      const { uploadId: _u, ...rest } = req;
      await prisma.modelFileScan.update({
        where: { id: scanId },
        data: { request: rest as unknown as Prisma.InputJsonValue },
      });
    }
  }
}
