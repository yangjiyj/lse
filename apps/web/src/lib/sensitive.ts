/**
 * 第 16 条数据安全：前端展示敏感个人信息时默认脱敏。
 * 覆盖手机号、身份证号、邮箱、银行卡号、姓名；自由文本（样本、回答）按模式识别后脱敏。
 */
export type SensitiveKind = 'phone' | 'id_card' | 'email' | 'bank_card' | 'name';

export const SENSITIVE_KIND_LABELS: Record<SensitiveKind, string> = {
  phone: '手机号',
  id_card: '身份证号',
  email: '邮箱',
  bank_card: '银行卡号',
  name: '姓名',
};

const stars = (n: number) => '*'.repeat(Math.max(n, 1));

export function maskPhone(v: string): string {
  return v.length >= 7 ? `${v.slice(0, 3)}${stars(v.length - 7)}${v.slice(-4)}` : stars(v.length);
}

export function maskIdCard(v: string): string {
  return v.length > 7 ? `${v.slice(0, 3)}${stars(v.length - 7)}${v.slice(-4)}` : stars(v.length);
}

export function maskBankCard(v: string): string {
  const digits = v.replace(/\s+/g, '');
  return digits.length > 8
    ? `${digits.slice(0, 4)} ${stars(digits.length - 8)} ${digits.slice(-4)}`
    : stars(digits.length);
}

export function maskEmail(v: string): string {
  const at = v.indexOf('@');
  if (at <= 0) return stars(v.length);
  const local = v.slice(0, at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}${stars(local.length - keep)}${v.slice(at)}`;
}

/** 姓名：两字保留姓（张*），三字及以上保留首尾（张*三）。 */
export function maskName(v: string): string {
  const chars = Array.from(v.trim());
  if (chars.length <= 1) return chars.join('');
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${stars(chars.length - 2)}${chars[chars.length - 1]}`;
}

export function maskValue(kind: SensitiveKind, v: string): string {
  switch (kind) {
    case 'phone':
      return maskPhone(v);
    case 'id_card':
      return maskIdCard(v);
    case 'email':
      return maskEmail(v);
    case 'bank_card':
      return maskBankCard(v);
    case 'name':
      return maskName(v);
  }
}

// 顺序有意义：身份证（含出生日期结构）先于银行卡，银行卡先于手机号。
const TEXT_PATTERNS: Array<{ kind: SensitiveKind; re: RegExp }> = [
  {
    kind: 'id_card',
    re: /(?<![\dA-Za-z])\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g,
  },
  { kind: 'bank_card', re: /(?<!\d)(?:\d{4}[ ]?){3,4}\d{1,4}(?!\d)/g },
  { kind: 'phone', re: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

export interface MaskTextResult {
  text: string;
  /** 命中的敏感信息类型（去重，保持首次出现顺序）。 */
  kinds: SensitiveKind[];
}

/** 对自由文本中的手机号、身份证号、银行卡号、邮箱做脱敏。 */
export function maskSensitiveText(input: string): MaskTextResult {
  const kinds: SensitiveKind[] = [];
  let text = input;
  for (const { kind, re } of TEXT_PATTERNS) {
    text = text.replace(re, (m) => {
      const digits = m.replace(/\s+/g, '');
      if (kind === 'bank_card' && (digits.length < 16 || digits.length > 19)) return m;
      if (!kinds.includes(kind)) kinds.push(kind);
      if (kind === 'phone') {
        const core = m.slice(-11);
        return m.slice(0, -11) + maskPhone(core);
      }
      return maskValue(kind, m);
    });
  }
  return { text, kinds };
}
