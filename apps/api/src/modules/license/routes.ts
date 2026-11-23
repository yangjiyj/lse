import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import {
  currentLicenseVerificationContext,
  getActiveLicenseState,
  readDeploymentId,
  sanitizeLicenseStatusResponse,
} from '../../lib/license-enforcement.js';
import {
  LSE_PRODUCT_ID,
  getLocalLicenseFingerprints,
  getMachineFingerprint,
  isLicenseEnvelopeV2,
  verifyLicense,
  verifyLicenseV2,
  type LicenseEnvelopeV2,
  type LicenseFile,
} from '../../lib/license.js';

const uploadSchema = z.object({
  license: z.union([z.string(), z.record(z.unknown())]),
});

export async function licenseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/fingerprint', { preHandler: [requirePermission('license:read')] }, async () => {
    return {
      fingerprint: getMachineFingerprint(),
      fingerprints: getLocalLicenseFingerprints({ deploymentId: config.LICENSE_DEPLOYMENT_ID }),
    };
  });

  app.get('/host-info', { preHandler: [requirePermission('license:read')] }, async () => {
    const deploymentId = config.LICENSE_DEPLOYMENT_ID.trim() || (await readDeploymentId()) || '';
    const fps = getLocalLicenseFingerprints({ deploymentId });
    const dep = fps.find((f) => f.scope === 'deployment');
    return {
      product: LSE_PRODUCT_ID,
      deploymentId,
      fingerprint: dep?.value ?? '',
      machineFingerprint: getMachineFingerprint(),
      hostname: os.hostname(),
      version: process.env.APP_VERSION ?? '',
      edition: 'enterprise',
      generatedAt: new Date().toISOString(),
    };
  });

  app.get('/', { preHandler: [requirePermission('license:read')] }, async () => {
    const fingerprint = getMachineFingerprint();
    const liveState = await getActiveLicenseState();
    const lic = await prisma.license.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!lic) {
      return sanitizeLicenseStatusResponse({
        configured: false,
        enforce: config.LICENSE_ENFORCE,
        publicKeyConfigured: Boolean(config.LICENSE_PUBLIC_KEY),
        publicKeyRingConfigured: Boolean(config.LICENSE_PUBLIC_KEYS || config.LICENSE_PUBLIC_KEY),
        license: null,
      });
    }
    let live: { valid: boolean; status: string; reason?: string } = {
      valid: liveState.valid,
      status: liveState.status,
      reason: liveState.reason,
    };
    try {
      const file = JSON.parse(lic.raw) as LicenseFile;
      if (!isLicenseEnvelopeV2(file)) {
        const r = verifyLicense(file, config.LICENSE_PUBLIC_KEY, {
          machineFingerprint: fingerprint,
        });
        live = { valid: r.valid, status: r.status, reason: r.valid ? undefined : r.reason };
      }
    } catch {
      live = { valid: false, status: 'INVALID', reason: '存储的 license 无法解析' };
    }
    return sanitizeLicenseStatusResponse({
      configured: true,
      enforce: config.LICENSE_ENFORCE,
      publicKeyConfigured: Boolean(config.LICENSE_PUBLIC_KEY),
      publicKeyRingConfigured: Boolean(config.LICENSE_PUBLIC_KEYS || config.LICENSE_PUBLIC_KEY),
      license: {
        subject: lic.subject,
        status: live.status,
        valid: live.valid,
        reason: live.reason,
        issuedAt: lic.issuedAt,
        expiresAt: lic.expiresAt,
        edition: liveState.payload?.edition ?? null,
        maxUsers: liveState.payload?.maxUsers ?? null,
        createdAt: lic.createdAt,
      },
    });
  });

  app.post('/', { preHandler: [requirePermission('license:update')] }, async (request) => {
    const body = uploadSchema.parse(request.body);
    let file: LicenseFile | LicenseEnvelopeV2;
    let rawStr: string;
    if (typeof body.license === 'string') {
      rawStr = body.license.trim();
      try {
        file = JSON.parse(rawStr) as LicenseFile;
      } catch {
        throw badRequest('授权文件格式无效，请重新选择文件。');
      }
    } else {
      file = body.license as unknown as LicenseFile;
      rawStr = JSON.stringify(file);
    }
    if (!file || typeof file !== 'object' || !file.payload || typeof file.signature !== 'string') {
      throw badRequest('授权文件内容不完整，请使用有效的正式授权文件。');
    }

    const fingerprint = getMachineFingerprint();
    const result = isLicenseEnvelopeV2(file)
      ? verifyLicenseV2(file, {
          product: LSE_PRODUCT_ID,
          ...(await currentLicenseVerificationContext(file.keyId)),
        })
      : verifyLicense(file, config.LICENSE_PUBLIC_KEY, {
          machineFingerprint: fingerprint,
        });
    if (config.LICENSE_ENFORCE && !result.valid) {
      throw badRequest('授权文件校验失败，请确认文件有效且未被修改。', 'LICENSE_INVALID', {
        reason: result.reason,
      });
    }

    const isV2 = isLicenseEnvelopeV2(file);
    const payload = file.payload;
    let subject: string | null = null;
    if (isLicenseEnvelopeV2(file)) {
      subject = file.payload.subject.displayName;
    } else if (typeof payload.subject === 'string') {
      subject = payload.subject;
    }
    const issuedAt = typeof payload.issuedAt === 'string' ? payload.issuedAt : null;
    const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt : null;
    const created = await prisma.$transaction(async (tx) => {
      await tx.license.updateMany({ where: { isActive: true }, data: { isActive: false } });
      return tx.license.create({
        data: {
          raw: rawStr,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          payload: payload as any,
          subject,
          issuedAt: issuedAt ? new Date(issuedAt) : null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          machineFingerprint:
            typeof payload.machineFingerprint === 'string' ? payload.machineFingerprint : null,
          status: result.status,
          isActive: true,
          uploadedById: request.currentUser!.id,
        },
      });
    });

    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'license.update',
      targetType: 'license',
      targetId: created.id,
      detail: { status: result.status, valid: result.valid },
    });

    return {
      ok: true,
      valid: result.valid,
      status: result.status,
      reason: result.valid ? undefined : result.reason,
      license: {
        id: created.id,
        subject: created.subject,
        status: created.status,
        expiresAt: created.expiresAt,
      },
    };
  });
}
