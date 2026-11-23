import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 字段级凭据加密（AES-256-GCM）。密钥取自环境变量 LSE_CREDENTIAL_KEY，未配置时由 JWT_SECRET 派生
 * （api 与 worker 共用同一环境，二者一致即可互通）。密文格式：enc:v1:<iv>:<tag>:<data>（base64url）。
 * 更换密钥后已存密文无法解密，调用方按“未配置凭据”处理并提示重新填写。
 */
const PREFIX = 'enc:v1:';

function key(env: NodeJS.ProcessEnv = process.env): Buffer {
  const material = env.LSE_CREDENTIAL_KEY?.trim() || env.JWT_SECRET?.trim() || '';
  if (!material) throw new Error('未配置凭据加密密钥（LSE_CREDENTIAL_KEY 或 JWT_SECRET）');
  return createHash('sha256').update(`lse-credential-v1\u0000${material}`).digest();
}

export function isEncryptedCredential(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptCredential(plain: string, env?: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(env), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`;
}

/** 解密失败（密钥变更/数据损坏）返回 null，不抛出、不输出密文或明文。 */
export function decryptCredential(stored: string | null | undefined, env?: NodeJS.ProcessEnv): string | null {
  if (!stored || !isEncryptedCredential(stored)) return null;
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || dataB64 === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(env), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
