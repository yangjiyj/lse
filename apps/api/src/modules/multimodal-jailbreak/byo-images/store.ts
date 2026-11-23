import { prisma } from '../../../db.js';
import type { ByoImageBlob } from './executor.js';

export async function loadByoImageBlob(imageId: string): Promise<ByoImageBlob | null> {
  const row = await prisma.byoImage.findUnique({ where: { id: imageId } });
  if (!row) return null;
  return {
    id: row.id,
    mimeType: row.mimeType,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    data: Buffer.from(row.data),
  };
}
