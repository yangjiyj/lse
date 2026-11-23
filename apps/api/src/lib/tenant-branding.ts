import { z } from 'zod';
import { badRequest } from './errors.js';
import { DEFAULT_PLATFORM_TITLE_TEXT } from './product-name.js';

/** 租户信息设置（systemSetting key = 'tenant'）：平台 logo、页签 logo、平台标题。 */
export const TENANT_SETTING_KEY = 'tenant';
export const DEFAULT_PLATFORM_TITLE = DEFAULT_PLATFORM_TITLE_TEXT;
/** logo 解码后大小上限。 */
export const LOGO_MAX_BYTES = 256 * 1024;

const ALLOWED_MIME = [
  'image/png',
  'image/jpeg',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/webp',
];

/** 按文件头识别真实格式，防止把 SVG/HTML 改后缀或改 MIME 冒充图片。 */
function sniff(buf: Buffer): 'png' | 'jpeg' | 'ico' | 'webp' | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

const MIME_BY_KIND = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
  webp: 'image/webp',
};

/**
 * 校验并规范化 logo data URL：只允许 png/jpg/ico/webp，禁止 SVG，限制大小；
 * 以文件头识别的真实格式重写 MIME。空串表示清除（恢复默认）。
 */
export function normalizeLogoDataUrl(value: string, label: string): string {
  if (!value) return '';
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (!m) throw badRequest(`${label}格式非法，请上传 PNG/JPG/ICO/WEBP 图片`, 'LOGO_INVALID');
  const mime = m[1]!.toLowerCase();
  if (mime.includes('svg')) throw badRequest(`${label}不支持 SVG 格式`, 'LOGO_SVG_FORBIDDEN');
  if (!ALLOWED_MIME.includes(mime)) {
    throw badRequest(`${label}仅支持 PNG/JPG/ICO/WEBP 格式`, 'LOGO_TYPE_FORBIDDEN');
  }
  const buf = Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64');
  if (buf.length === 0) throw badRequest(`${label}内容为空`, 'LOGO_INVALID');
  if (buf.length > LOGO_MAX_BYTES) {
    throw badRequest(`${label}不能超过 ${LOGO_MAX_BYTES / 1024} KB`, 'LOGO_TOO_LARGE');
  }
  const kind = sniff(buf);
  if (!kind) throw badRequest(`${label}文件内容不是有效的 PNG/JPG/ICO/WEBP 图片`, 'LOGO_INVALID');
  return `data:${MIME_BY_KIND[kind]};base64,${buf.toString('base64')}`;
}

// data URL 最长 ≈ 4/3 × 上限 + 头部
const logoField = z.string().max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 200);

/** 数字、空格、+、- 和括号，结尾可带分机：「转 8001」或「ext 8001」。 */
const PHONE_RE = /^[0-9+\-\s()]*(?:(?:转|ext\.?)\s*[0-9]+)?$/i;

export const tenantSchema = z.object({
  platformTitle: z.string().trim().min(1, '请填写平台标题').max(40, '平台标题不超过 40 字'),
  platformLogo: logoField,
  tabLogo: logoField,
  /** 技术支持单位与联系人：登录页底部展示，空串表示不展示。 */
  supportOrg: z.string().trim().max(100, '支持单位不超过 100 字'),
  contactName: z.string().trim().max(40, '联系人不超过 40 字'),
  contactPhone: z
    .string()
    .trim()
    .max(30, '联系电话不超过 30 位')
    .regex(PHONE_RE, '联系电话格式不正确，分机可写「转 8001」或「ext 8001」'),
  contactEmail: z
    .string()
    .trim()
    .max(100, '联系邮箱不超过 100 字')
    .refine((v) => v === '' || z.string().email().safeParse(v).success, '联系邮箱格式不正确'),
});

export type TenantSettings = z.infer<typeof tenantSchema>;

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  platformTitle: DEFAULT_PLATFORM_TITLE,
  platformLogo: '',
  tabLogo: '',
  supportOrg: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
};

/** 逐项校验存量设置：哪一项不合法只回退那一项，其余照常生效。 */
export function parseStoredTenant(value: unknown): TenantSettings {
  const stored = (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  ) as Record<string, unknown>;
  const result: TenantSettings = { ...DEFAULT_TENANT_SETTINGS };
  for (const key of Object.keys(tenantSchema.shape) as Array<keyof TenantSettings>) {
    if (stored[key] === undefined) continue;
    const parsed = tenantSchema.shape[key].safeParse(stored[key]);
    if (parsed.success) result[key] = parsed.data;
  }
  return result;
}

/** 合并提交值并校验 logo。 */
export function mergeTenant(
  current: TenantSettings,
  patch: Partial<TenantSettings>,
): TenantSettings {
  const merged = tenantSchema.parse({ ...current, ...patch });
  return {
    ...merged,
    platformLogo:
      patch.platformLogo !== undefined
        ? normalizeLogoDataUrl(merged.platformLogo, '平台logo')
        : merged.platformLogo,
    tabLogo:
      patch.tabLogo !== undefined
        ? normalizeLogoDataUrl(merged.tabLogo, '页签logo')
        : merged.tabLogo,
  };
}
