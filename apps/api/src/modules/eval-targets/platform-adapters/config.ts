import { z } from 'zod';
import { badRequest } from '../../../lib/errors.js';

const baseUrl = z.string().trim().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, '请填写不含凭据和查询参数的 HTTP 基地址');
// 靶应用侧预埋的固定暗号：知识库文档里放 knowledgeCanary，系统提示词里放 systemCanary。
// 发起评测时用它们补齐场景暗号，避免随机暗号与靶应用内容对不上而使场景无效。
const canaryField = z.string().trim().regex(/^LSE-CANARY-[a-zA-Z0-9_-]+$/, '暗号格式应为 LSE-CANARY-…').max(128).optional();
const common = { baseUrl, user: z.string().trim().max(256).optional(), knowledgeCanary: canaryField, systemCanary: canaryField };
export const platformAppConfigSchema = z.discriminatedUnion('platform', [
  z.object({ ...common, platform: z.literal('dify'), appMode: z.enum(['agent-chat', 'chat', 'advanced-chat', 'workflow']).default('agent-chat'), inputs: z.record(z.unknown()).optional() }).strict(),
  z.object({ ...common, platform: z.literal('coze'), botId: z.string().trim().min(1).max(256) }).strict(),
]);
export type PlatformAppConfig = z.infer<typeof platformAppConfigSchema>;
export function parsePlatformAppConfig(value: unknown): PlatformAppConfig {
  const cfg = platformAppConfigSchema.parse(value);
  assertPlatformConfigCredentialFree(cfg);
  return cfg;
}
export function platformAppEnabled(): boolean {
  return process.env.LSE_PLATFORM_APP_ENABLED === 'true';
}

function assertPlatformConfigCredentialFree(value: unknown): void {
  if (typeof value === 'string' && /^(?:app-(?=[a-zA-Z0-9_-]*\d)[a-zA-Z0-9_-]{20,}|(?:pat_|sk-)[a-zA-Z0-9_-]{12,}|jjd_[a-fA-F0-9]{48}|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*)$/.test(value))
    throw badRequest('平台应用配置不能包含访问凭据。', 'PLATFORM_CONFIG_CREDENTIAL');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(api_?key|authorization|secret|password|access_?token)$/i.test(key))
      throw badRequest('平台应用配置不能包含访问凭据。', 'PLATFORM_CONFIG_CREDENTIAL');
    assertPlatformConfigCredentialFree(child);
  }
}
