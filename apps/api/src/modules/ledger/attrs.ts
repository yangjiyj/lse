import { isIP } from 'node:net';
import { z } from 'zod';
import { LEDGER_ATTR_TEXT_MAX, type LedgerAssetType } from '@lse/shared';

// 台账各类型的专有字段校验（2.8.1）。键、下拉选项与 @lse/shared 的 LEDGER_ATTR_FIELDS 逐字段对应（测试核对）。
// 空字符串、null 视为没填，不入库；未知键报错。

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** IP（v4/v6）或主机名；全是数字和点的必须是合法 IPv4（「1.2.3」不算）。 */
export function isLedgerHost(value: string): boolean {
  if (isIP(value) !== 0) return true;
  return HOSTNAME_RE.test(value) && !/^[\d.]+$/.test(value);
}

/** 只认 http、https 的绝对地址。 */
export function isLedgerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

const text = (max = LEDGER_ATTR_TEXT_MAX) => z.string().trim().max(max);
const url = () =>
  z.string().trim().max(2000).refine(isLedgerUrl, { message: '请填写 http 或 https 开头的地址' });
const host = () =>
  z.string().trim().max(253).refine(isLedgerHost, { message: '请填写正确的 IP 或主机名' });
const num = () => z.number().finite().min(0).max(10_000_000);

export const LEDGER_ATTR_SCHEMAS = {
  platform: z
    .object({
      url: url(),
      businessScenario: text(500),
      deploymentMode: z.enum([
        'third_party_api',
        'self_hosted_open_weights',
        'self_trained',
        'unknown',
      ]),
      environment: z.enum(['prod', 'test', 'dev']),
      contact: text(100),
    })
    .partial()
    .strict(),
  server: z
    .object({
      ip: host(),
      os: text(),
      cpu: text(),
      memoryGB: num(),
      gpu: text(),
      location: text(),
      purpose: z.enum(['training', 'inference', 'application', 'other']),
    })
    .partial()
    .strict(),
  endpoint: z.object({ ip: host(), user: text() }).partial().strict(),
  software: z
    .object({
      vendor: text(),
      version: text(),
      category: z.enum(['os', 'database', 'middleware', 'web', 'other']),
      license: text(),
    })
    .partial()
    .strict(),
  model: z
    .object({
      modelName: text(),
      version: text(),
      provider: text(),
      parameterSize: text(),
      modality: z.enum(['text', 'multimodal', 'speech', 'other']),
      baseModel: text(),
      modelPath: text(2000),
    })
    .partial()
    .strict(),
  component: z
    .object({
      componentType: z.enum(['framework', 'vector_db', 'mcp', 'plugin', 'skill', 'other']),
      version: text(),
      endpointUrl: url(),
      assetKey: text(),
    })
    .partial()
    .strict(),
} satisfies Record<LedgerAssetType, z.AnyZodObject>;

export type LedgerAttrs = Record<string, string | number>;

/** 去掉没填的项（空字符串、null、undefined；文本去首尾空白后为空的也算）。 */
function dropEmpty(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([, v]) => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === ''),
    ),
  );
}

/** 按类型校验专有字段，返回入库的值；不合法抛 ZodError（接口返回 400）。 */
export function parseLedgerAttrs(type: LedgerAssetType, raw: unknown): LedgerAttrs {
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    // 让 zod 报出类型错误
    return LEDGER_ATTR_SCHEMAS[type].parse(raw) as LedgerAttrs;
  }
  const parsed = LEDGER_ATTR_SCHEMAS[type].parse(dropEmpty(input)) as Record<string, unknown>;
  return dropEmpty(parsed) as LedgerAttrs;
}

/** 读库里的 attrs（JSON）成普通对象；脏数据按空对象处理。 */
export function readLedgerAttrs(value: unknown): LedgerAttrs {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as LedgerAttrs) : {};
}
