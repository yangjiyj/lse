import { z } from 'zod';
import { getRedisConnection } from '../../lib/queue.js';
import { parseSbomUpload, SERVICE_ASSURANCE_SBOM_LIMITS, type ParsedSbom } from './sbom.js';

export const SERVICE_ASSURANCE_SBOM_TTL_SECONDS = 10 * 60;

export interface ServiceAssuranceSbomUpload {
  contentType: string;
  content: string;
  parsed: ParsedSbom;
}

export interface SbomChannelStore {
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<'OK' | null>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface ServiceAssuranceSbomChannel {
  put(runId: string, upload: ServiceAssuranceSbomUpload): Promise<void>;
  take(runId: string): Promise<ServiceAssuranceSbomUpload>;
  delete(runId: string): Promise<void>;
}

export type SbomChannelErrorCode =
  | 'SERVICE_ASSURANCE_SBOM_CHANNEL_CONFLICT'
  | 'SERVICE_ASSURANCE_SBOM_CONTENT_UNAVAILABLE'
  | 'SERVICE_ASSURANCE_SBOM_CONTENT_INVALID';

const ERROR_MESSAGE: Record<SbomChannelErrorCode, string> = {
  SERVICE_ASSURANCE_SBOM_CHANNEL_CONFLICT: '组件清单通道已存在。',
  SERVICE_ASSURANCE_SBOM_CONTENT_UNAVAILABLE: '组件清单内容已过期或不可用。',
  SERVICE_ASSURANCE_SBOM_CONTENT_INVALID: '组件清单内容校验失败。',
};

export class SbomChannelError extends Error {
  constructor(readonly code: SbomChannelErrorCode) {
    super(ERROR_MESSAGE[code]);
    this.name = 'SbomChannelError';
  }
}

const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    contentType: z.string().min(1).max(200),
    content: z.string().max(SERVICE_ASSURANCE_SBOM_LIMITS.maxBytes),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative().max(SERVICE_ASSURANCE_SBOM_LIMITS.maxBytes),
    format: z.enum(['CYCLONEDX_JSON', 'SPDX_JSON', 'SPDX_TAG_VALUE']),
  })
  .strict();

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function serviceAssuranceSbomKey(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new SbomChannelError('SERVICE_ASSURANCE_SBOM_CONTENT_INVALID');
  }
  return `serviceassurance:sbom:${runId.toLowerCase()}`;
}

function validatedUpload(upload: ServiceAssuranceSbomUpload): ServiceAssuranceSbomUpload {
  try {
    const parsed = parseSbomUpload({
      contentType: upload.contentType,
      content: upload.content,
    });
    if (
      parsed.contentSha256 !== upload.parsed.contentSha256 ||
      parsed.byteLength !== upload.parsed.byteLength ||
      parsed.format !== upload.parsed.format
    ) {
      throw new SbomChannelError('SERVICE_ASSURANCE_SBOM_CONTENT_INVALID');
    }
    return { contentType: upload.contentType, content: upload.content, parsed };
  } catch (error) {
    if (error instanceof SbomChannelError) throw error;
    throw new SbomChannelError('SERVICE_ASSURANCE_SBOM_CONTENT_INVALID');
  }
}

export function createServiceAssuranceSbomChannel(
  store: SbomChannelStore,
): ServiceAssuranceSbomChannel {
  return {
    async put(runId, upload) {
      const validated = validatedUpload(upload);
      const result = await store.set(
        serviceAssuranceSbomKey(runId),
        JSON.stringify({
          schemaVersion: 1,
          contentType: validated.contentType,
          content: validated.content,
          contentSha256: validated.parsed.contentSha256,
          byteLength: validated.parsed.byteLength,
          format: validated.parsed.format,
        }),
        'EX',
        SERVICE_ASSURANCE_SBOM_TTL_SECONDS,
        'NX',
      );
      if (result !== 'OK') {
        throw new SbomChannelError('SERVICE_ASSURANCE_SBOM_CHANNEL_CONFLICT');
      }
    },

    async take(runId) {
      const raw = await store.getdel(serviceAssuranceSbomKey(runId));
      if (raw === null) {
        throw new SbomChannelError('SERVICE_ASSURANCE_SBOM_CONTENT_UNAVAILABLE');
      }
      try {
        const envelope = envelopeSchema.parse(JSON.parse(raw));
        const parsed = parseSbomUpload({
          contentType: envelope.contentType,
          content: envelope.content,
        });
        if (
          parsed.contentSha256 !== envelope.contentSha256 ||
          parsed.byteLength !== envelope.byteLength ||
          parsed.format !== envelope.format
        ) {
          throw new SbomChannelError('SERVICE_ASSURANCE_SBOM_CONTENT_INVALID');
        }
        return {
          contentType: envelope.contentType,
          content: envelope.content,
          parsed,
        };
      } catch (error) {
        if (error instanceof SbomChannelError) throw error;
        throw new SbomChannelError('SERVICE_ASSURANCE_SBOM_CONTENT_INVALID');
      }
    },

    async delete(runId) {
      await store.del(serviceAssuranceSbomKey(runId));
    },
  };
}

function defaultChannel(): ServiceAssuranceSbomChannel {
  return createServiceAssuranceSbomChannel(getRedisConnection());
}

export async function putServiceAssuranceSbom(
  runId: string,
  upload: ServiceAssuranceSbomUpload,
): Promise<void> {
  await defaultChannel().put(runId, upload);
}

export async function takeServiceAssuranceSbom(runId: string): Promise<ServiceAssuranceSbomUpload> {
  return defaultChannel().take(runId);
}

export async function deleteServiceAssuranceSbom(runId: string): Promise<void> {
  await defaultChannel().delete(runId);
}
