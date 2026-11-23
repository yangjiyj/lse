import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_DIR = config.MODEL_SCAN_UPLOAD_DIR || join(tmpdir(), 'lse-model-scan-uploads');

export function uploadPathFor(uploadId: string, directory = UPLOAD_DIR): string {
  if (!UUID.test(uploadId)) throw new Error('非法的上传 ID');
  return join(directory, `${uploadId}.bin`);
}

export function uploadMetaPathFor(uploadId: string, directory = UPLOAD_DIR): string {
  return `${uploadPathFor(uploadId, directory).slice(0, -4)}.json`;
}

export async function removeUpload(
  uploadId: string | undefined,
  directory = UPLOAD_DIR,
): Promise<void> {
  if (!uploadId || !UUID.test(uploadId)) return;
  await rm(uploadPathFor(uploadId, directory), { force: true });
  await rm(uploadMetaPathFor(uploadId, directory), { force: true });
}

export async function cleanupScanUpload(
  request: { uploadId?: string; libraryUpload?: boolean },
  directory = UPLOAD_DIR,
): Promise<void> {
  if (request.libraryUpload === true) return;
  await removeUpload(request.uploadId, directory);
}
