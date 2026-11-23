// 敏感信息规则（1.2.2）：40 类，逐类的写法、校验和来源对照见仓库文档 docs/corpus-scan-sensitive-rules.md；
// 带校验的照样校验（身份证 GB 11643 校验位、银行卡 IIN + Luhn、
// 统一社会信用代码 GB 32100 校验位、手机号号段）。命中原文不打码；打码副本用 maskSensitive 换成 [类型]。
// 纯函数，只依赖 node 内置模块，只用可擦除的 TS 语法。
import { isIP } from 'node:net';

export type SensitiveSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface SensitiveHit {
  type: string;
  label: string;
  severity: SensitiveSeverity;
  start: number;
  end: number;
  /** 命中的原文 */
  value: string;
}

export interface SensitiveTypeInfo {
  type: string;
  label: string;
  severity: SensitiveSeverity;
}

interface MatchContext {
  text: string;
  start: number;
  end: number;
  m: RegExpExecArray;
}

interface Rule extends SensitiveTypeInfo {
  /** 必须带 g、d 标志 */
  re: RegExp;
  /** 命中值取哪个命名分组（取第一个匹配到的）；span 为 true 时取这些分组覆盖的整段；不给就是整段匹配 */
  groups?: string[];
  span?: boolean;
  validate?: (value: string, ctx: MatchContext) => boolean;
  /** 严重度随上下文变化（如不带标签词的降为低危）；不给就是 severity */
  severityOf?: (ctx: MatchContext) => SensitiveSeverity;
}

// ---------------------------------------------------------------------------
// 校验与占位值判断
// ---------------------------------------------------------------------------

// 占位值：your_xxx、example、password、xxx、***、<…>、${…}
const PLACEHOLDER_VALUE =
  /^(?:your[-_ ]?|example[-_ ]?|sample[-_ ]?|dummy[-_ ]?|test[-_ ]?|change[-_ ]?me|password|passwd|pwd|x{3,}|\*{3,}|<[^>]+>|\$\{[^}]+\})$/i;
// 配置里的占位写法：your_api_key_here、replace_me、changeme 等
const CONFIG_PLACEHOLDER =
  /^(?:your[_-]?(?:api[_-]?key|password|secret|token)(?:[_-]?here)?|(?:example|sample|dummy|test|placeholder)[_-](?:password|api[_-]?key|secret|token)|(?:password|api[_-]?key|secret|token)[_-](?:here|placeholder)|replace[_-]?(?:me|this)|changeme|<[^<>\r\n]+>)$/i;
// 变量引用不是字面值：${VAR}、$VAR、%VAR%、{0}、%s
const REFERENCE_VALUE =
  /^(?:\$\{[A-Za-z_][A-Za-z0-9_.]*(?::-?|:\?[^{}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*|\$env:[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]*)\}|%(?:[0-9]+\$)?[-+0-9.]*[sdfiu])$/i;
const REFERENCE_PREFIX =
  /^(?:\$env:[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_])|\$[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_])|%[A-Za-z_][A-Za-z0-9_]*%|\$\{)/i;
// your_xxx、example-xxx 这类占位前缀，和代码里的空值字面量
const PLACEHOLDER_PREFIX = /^(?:your|example|sample|dummy|fake|placeholder)[-_]/i;
const EMPTY_LITERAL = /^(?:null|none|nil|true|false|undefined|empty|required|optional|string)$/i;
// 常见的示例密钥
const GENERIC_SECRET_PLACEHOLDERS = new Set([
  'changeme',
  'exampleapikey',
  'placeholder',
  'replace_me',
  'sampleapikey',
  'testapikey',
]);
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

export function isPlaceholder(raw: string): boolean {
  const s = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!s) return true;
  return (
    PLACEHOLDER_VALUE.test(s) ||
    CONFIG_PLACEHOLDER.test(s) ||
    REFERENCE_VALUE.test(s) ||
    REFERENCE_PREFIX.test(s) ||
    PLACEHOLDER_PREFIX.test(s) ||
    EMPTY_LITERAL.test(s) ||
    /^(.)\1+$/.test(s)
  );
}

function entropy(s: string): number {
  const chars = [...s];
  if (chars.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of chars) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let e = 0;
  for (const c of counts.values()) {
    const p = c / chars.length;
    e -= p * Math.log2(p);
  }
  return e;
}

/** 像真密钥：≥16 位、不是占位、熵 ≥ 3 */
function credibleSecret(v: string): boolean {
  const s = v.trim();
  return s.length >= 16 && !isPlaceholder(s) && entropy(s) >= 3.0;
}

/** 像真密码：≥10 位、至少三类字符、熵 ≥ 3 */
function crediblePassword(v: string): boolean {
  if (isPlaceholder(v) || v.length < 10) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  return classes >= 3 && entropy(v) >= 3.0;
}

// sk- 示例密钥（sk-xxx、sk-your-api-key）不算真钥
const SK_PLACEHOLDER_WORD =
  /^(?:x+|your|api|apikey|key|here|placeholder|examples?|test|sample|samples?|dummy|fake|redacted|changeme|todo|secret|token|value|name|my|the|proj|live|ant)$/i;
function skSegLowSignal(seg: string): boolean {
  if (!seg) return true;
  const uniq = new Set(seg).size;
  if (uniq <= 2) return true;
  if (/[A-Za-z]/.test(seg) && /\d/.test(seg) && uniq >= 6) return false;
  return SK_PLACEHOLDER_WORD.test(seg) || uniq <= 3;
}
export function isPlaceholderSk(matched: string): boolean {
  const body = matched.replace(/^sk-(?:ant-)?/i, '');
  if (/^[x.\-*_]+$/i.test(body)) return true;
  const segs = body.split(/[-_]/).filter((s) => s !== '');
  if (segs.length === 0) return true;
  if (segs.every(skSegLowSignal)) return true;
  if (!/\d/.test(body) && segs.length >= 3 && segs.every((s) => s.length <= 12)) return true;
  return false;
}

/** 通用 API 密钥值：≥16 位、熵 ≥ 3.2，排除全大写常量名、单词拼接和占位 */
function credibleGenericSecret(v: string): boolean {
  if (v.length < 16 || v.startsWith('-')) return false;
  if (GENERIC_SECRET_PLACEHOLDERS.has(v.toLowerCase()) || isPlaceholder(v)) return false;
  if (/^sk-/i.test(v) && isPlaceholderSk(v)) return false;
  if (/^[A-Z][A-Z0-9_]+$/.test(v)) return false;
  if (/^[A-Za-z]+(?:[_-][A-Za-z]+)+$/.test(v)) return false;
  return entropy(v) >= 3.2;
}

// GB 11643 身份证校验位
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = '10X98765432';
const ID_AREAS = new Set([
  '11',
  '12',
  '13',
  '14',
  '15',
  '21',
  '22',
  '23',
  '31',
  '32',
  '33',
  '34',
  '35',
  '36',
  '37',
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '50',
  '51',
  '52',
  '53',
  '54',
  '61',
  '62',
  '63',
  '64',
  '65',
  '71',
  '81',
  '82',
  '83',
]);

function validDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function validIdCard(n: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(n)) return false;
  if (!ID_AREAS.has(n.slice(0, 2)) || n.slice(14, 17) === '000') return false;
  const birth = validDate(Number(n.slice(6, 10)), Number(n.slice(10, 12)), Number(n.slice(12, 14)));
  if (!birth || birth.getTime() > Date.now()) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(n[i]) * ID_WEIGHTS[i]!;
  return ID_CHECK[sum % 11] === n[17]!.toUpperCase();
}

/** 银行卡：12-19 位、首位 3/4/5/6、Luhn */
export function validBankCard(n: string): boolean {
  if (!/^\d{12,19}$/.test(n) || !'3456'.includes(n[0]!)) return false;
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 手机号：已向公众放号的号段 */
const MOBILE_SEGMENT = /^1(?:3[0-9]|4[5-9]|5[0-35-9]|6[2567]|7[0-8]|8[0-9]|9[0-35-9])[0-9]{8}$/;

// GB 32100 统一社会信用代码校验位
const USCC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
export function validUscc(c: string): boolean {
  if (!/^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(c)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += USCC_CHARS.indexOf(c[i]!) * USCC_WEIGHTS[i]!;
  return USCC_CHARS[(31 - (sum % 31)) % 31] === c[17];
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

// 上下文佐证
const ADDRESS_CORROBORATION =
  /(?:省|自治区|市|州|区|县|镇|乡|街道|路|街|巷|弄|号|栋|幢|单元|室|小区|村)/;
const ADDRESS_STREET =
  /(?:路|街|大道|巷|弄|胡同|号|栋|幢|单元|室|楼|小区|村|院|大厦|园|座|广场|公寓)/;
const ADDRESS_REGION = /(?:省|自治区|市|州|区|县|镇|乡|旗|[0-9一二三四五六七八九十])/;
const LEGACY_ADDRESS_LABELS = new Set(['家庭住址', '家庭地址', '现住址', '居住地址', '收货地址']);
const COMMUNICATION_CORROBORATION =
  /(?:1[3-9]\d{9}|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}|\d{1,2}:\d{2}|\d+\s*(?:秒|分钟)|短信内容|通话时长|对方号码)/;
const BANK_STATEMENT_CORROBORATION = [
  /(?:交易|转账|收款|付款|借方|贷方|摘要)/,
  /(?:金额|余额|人民币|CNY|RMB|\d+(?:\.\d{2})?\s*元)/i,
  /(?:账号|账户|卡号|对方|户名)/,
  /(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/,
];
const MEDICAL_CORROBORATION = [
  /(?:病历|患者|门诊|住院|医院|病区)/,
  /(?:诊断|处方|用药|检查结果|检验结果|治疗|过敏史)/,
];
const CRIMINAL_CORROBORATION =
  /(?:犯罪|罪名|刑事|案底|判处|判决|拘役|有期徒刑|无期徒刑|缓刑|服刑|案件编号)/;
const CODE_CORROBORATION =
  /(?:\bdef\s+\w+\s*\(|\bclass\s+\w+|\bfunction\s+\w+\s*\(|\breturn\b|\bSELECT\b.+\bFROM\b|\bprivate\s+key\b|\bhmac\.|\bsha(?:256|512)\b|\b[A-Za-z_]\w*\s*[:=]\s*[^,，。]+)/i;
const EDUCATION_WORDS = /(?:大学|学院|学校|本科|硕士|博士|研究生|大专|中专|高中)/;
// AWS 秘密访问密钥旁边要有的字段名
const AWS_SECRET_KEY_CONTEXT =
  /(?:aws[_\-\s]*secret[_\-\s]*access[_\-\s]*key|aws[_\-\s]*secret[_\-\s]*key|secret[_\-\s]*access[_\-\s]*key)/i;
// 带分隔符的卡号要有卡号、账户类上下文
const BANK_CONTEXT = /(?:卡号|银行卡|信用卡|借记卡|储蓄卡|账号|帐号|账户|card)/i;

function validIpv4(v: string): boolean {
  const parts = v.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (p.length > 1 && p.startsWith('0')) return false;
    if (Number(p) > 255) return false;
  }
  if (v === '0.0.0.0') return false;
  const first = Number(parts[0]);
  return !(first >= 224 && first <= 239);
}

function validIpv6(v: string): boolean {
  if (isIP(v) !== 6) return false;
  const lower = v.toLowerCase();
  return lower !== '::' && !lower.startsWith('ff');
}

/** 连接串里要有字面口令（userinfo 或 query 里的 password 等） */
function dbUrlHasLiteral(url: string): boolean {
  const m = /^[A-Za-z0-9+:]+:\/\/([^/?#]*)/.exec(url);
  if (!m) return false;
  const authority = m[1]!;
  const candidates: string[] = [];
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    if (!authority.slice(at + 1)) return false;
    const userinfo = authority.slice(0, at);
    const ci = userinfo.indexOf(':');
    if (ci >= 0) candidates.push(safeDecode(userinfo.slice(ci + 1)));
  }
  const qi = url.indexOf('?');
  if (qi >= 0) {
    for (const kv of url.slice(qi + 1).split('&')) {
      const eq = kv.indexOf('=');
      const k = eq >= 0 ? kv.slice(0, eq) : kv;
      if (/^(?:password|passwd|pwd|sslpassword|auth|token)$/i.test(k))
        candidates.push(safeDecode(kv.slice(eq + 1)));
    }
  }
  return candidates.some((v) => v !== '' && !isPlaceholder(v));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function hasValidCardNear(text: string, start: number, end: number): boolean {
  const window = text.slice(Math.max(0, start - 160), end + 160);
  for (const m of window.matchAll(/(?<!\d)[3-6]\d{12,18}(?!\d)/g))
    if (validBankCard(m[0])) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 规则（按优先级排列：同一段原文只记最先命中的那一类）
// ---------------------------------------------------------------------------

// 号码前面的标签词（几个字以内）
const USCC_LABEL =
  /(?:统一社会信用代码|社会信用代码|信用代码|纳税人识别号|税号|营业执照|USCC)[^\n]{0,8}$/i;
const PASSPORT_LABEL = /(?:护照|passport)[^\n]{0,8}$/i;
function labelBefore(re: RegExp, c: MatchContext): boolean {
  return re.test(c.text.slice(Math.max(0, c.start - 24), c.start));
}

const LABEL_SEP = String.raw`\s*(?:号码?|编号|No\.?|Number)?\s*[:：#]?\s*`;
const ADDRESS_LABEL = String.raw`(?:家庭住址|家庭地址|现居住地址|现住址|现居地址|居住地址|常住地址|收货地址|收件地址|寄件地址|送货地址|配送地址|邮寄地址|联系地址|通讯地址|通信地址|户籍地址|户口地址|详细地址|住址|家住(?:在|于)?|地址(?:(?<=的地址)|(?<![一-鿿A-Za-z0-9_]地址)))`;
const ADDRESS_VALUE = String.raw`(?:(?!\s*(?:联系人|收件人|收货人|联系电话|电话|手机|邮编|姓名))[^\n,，;；。！？!?"]){6,80}`;
const IP_LABEL = String.raw`(?:(?:客户端|用户|访客|来源|登录|注册|设备)\s*IP|IP\s*地址|["']ip["'])`;

const RULES: Rule[] = [
  // ---- 密钥与凭据 ----
  {
    type: 'private_key',
    label: '私钥',
    severity: 'CRITICAL',
    re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,12000}?-----END (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----)?/dg,
  },
  {
    type: 'database_url',
    label: '数据库连接串',
    severity: 'CRITICAL',
    re: /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|mssql|sqlserver|oracle|amqps?|jdbc:[a-z0-9]+):\/\/[^\s'"`<>]{1,512}/dgi,
    validate: (v) => dbUrlHasLiteral(v),
  },
  {
    type: 'aws_access_key',
    label: 'AWS 访问密钥 ID',
    severity: 'CRITICAL',
    re: /(?<![A-Z0-9])(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/dg,
    validate: (v) => v !== 'AKIAIOSFODNN7EXAMPLE',
  },
  {
    type: 'aws_secret_key',
    label: 'AWS 秘密访问密钥',
    severity: 'CRITICAL',
    re: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/dg,
    validate: (v, c) =>
      v !== 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' &&
      AWS_SECRET_KEY_CONTEXT.test(c.text.slice(Math.max(0, c.start - 80), c.end + 80)),
  },
  {
    type: 'cloud_credential',
    label: '云凭据',
    severity: 'CRITICAL',
    re: /(?:AccountKey|client[_ -]?secret|secret[_ -]?access[_ -]?key|service[_ -]?account[_ -]?key|云(?:厂商)?凭据|云密钥)["']?\s*[:=：]\s*["']?(?<value>[A-Za-z0-9_+/=-]{16,256})/dgi,
    groups: ['value'],
    validate: (v) => credibleSecret(v),
  },
  {
    type: 'anthropic_key',
    label: 'Anthropic 密钥',
    severity: 'CRITICAL',
    re: /sk-ant-[A-Za-z0-9_-]{20,}/dgi,
    validate: (v) => !isPlaceholderSk(v),
  },
  {
    type: 'openai_key',
    label: 'OpenAI 密钥',
    severity: 'CRITICAL',
    re: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/dgi,
    validate: (v) => !isPlaceholderSk(v),
  },
  {
    type: 'github_token',
    label: 'GitHub 令牌',
    severity: 'CRITICAL',
    re: /gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])/dg,
  },
  {
    type: 'jwt_token',
    label: 'JWT 令牌',
    severity: 'HIGH',
    re: /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/dg,
  },
  {
    type: 'generic_api_key',
    label: 'API 密钥',
    severity: 'HIGH',
    re: /(?:api[_-]?key|apikey|api[_-]?secret|private[_-]?key|privatekey)["']?[\s:=]+["']?(?<value>[A-Za-z0-9_-]{8,128})/dgi,
    groups: ['value'],
    validate: (v) => credibleGenericSecret(v),
  },
  {
    type: 'access_key',
    label: '访问密钥',
    severity: 'CRITICAL',
    re: /(?:access[_-]?key(?:[_-]?(?:id|secret))?|accesskey|secret[_-]?key|secretkey)["']?\s*[:=]\s*["'](?<value>[^"'\s]{4,256})["']/dgi,
    groups: ['value'],
    validate: (v) => !isPlaceholder(v),
  },
  {
    type: 'token_leak',
    label: '令牌',
    severity: 'HIGH',
    re: /(?:token|secret)["']?\s*[:=]\s*["'](?<value>[A-Za-z0-9_-]{16,256})["']/dgi,
    groups: ['value'],
    validate: (v) => !isPlaceholder(v),
  },
  {
    // 需求 1.2.2「用户名与密码」：用户名和口令成对出现时，口令短也算
    type: 'login_credential',
    label: '登录凭据',
    severity: 'HIGH',
    re: /(?:用户名|账号|帐号|登录名|username|user|login|account)\s*[:=：]\s*(?<user>[^\s,，;；:："'|/]{2,64})[\s,，;；|/]{1,4}(?:密码|口令|password|passwd|pwd|pass)\s*[:=：]\s*(?<value>[^\s,，;；"']{3,128})/dgi,
    groups: ['user', 'value'],
    span: true,
    validate: (_v, c) => {
      const user = c.m.groups?.user ?? '';
      const pwd = c.m.groups?.value ?? '';
      return !isPlaceholder(user) && !isPlaceholder(pwd) && !CJK.test(pwd);
    },
  },
  {
    type: 'plain_password',
    label: '明文密码',
    severity: 'CRITICAL',
    re: /(?:登录密码|账户密码|用户密码|明文密码|password|passwd|passphrase|pwd)(?:\\*["'])?[ \t]*[:=：][ \t]*["']?(?<value>(?:(?!\\+[nrt"'])[^\s,，;；"']){8,128})/dgi,
    groups: ['value'],
    validate: (v) => crediblePassword(v),
  },
  {
    // 代码、配置里的密码赋值，也认中文标签「密码」「口令」
    type: 'password_in_code',
    label: '密码',
    severity: 'CRITICAL',
    re: /(?:password|passwd|pwd|密码|口令)["']?[ \t]*[:=：][ \t]*(?:'(?<q1>[^'\r\n]{4,128})'|"(?<q2>[^"\r\n]{4,128})"|`(?<q3>[^`\r\n]{4,128})`|(?<bare>[^\s,，;；`'"。！？：]{8,128}))/dgi,
    groups: ['q1', 'q2', 'q3', 'bare'],
    validate: (v) => !isPlaceholder(v) && !CJK.test(v),
  },

  // ---- 带标签的证件号与个人信息（放在通用号码规则前面，同一段号码先按标签认） ----
  {
    type: 'driver_license_cn',
    label: '驾驶证号',
    severity: 'HIGH',
    re: new RegExp(
      String.raw`(?:驾驶证|驾照)${LABEL_SEP}(?<value>\d{17}[\dXx]|\d{12})(?![A-Za-z0-9_])`,
      'dgi',
    ),
    groups: ['value'],
    validate: (v) => v.length === 12 || validIdCard(v),
  },
  {
    type: 'social_security_cn',
    label: '社会保障号',
    severity: 'HIGH',
    re: new RegExp(
      String.raw`(?:社会保障卡|社会保障号码|社保卡)${LABEL_SEP}(?<value>\d{17}[\dXx]|[A-Z0-9]{9,18})(?![A-Za-z0-9_])`,
      'dgi',
    ),
    groups: ['value'],
    validate: (v) => !/^\d{17}[\dXx]$/.test(v) || validIdCard(v),
  },
  {
    type: 'passport_cn',
    label: '护照号',
    severity: 'HIGH',
    re: new RegExp(
      String.raw`(?:中国)?(?:护照|passport)${LABEL_SEP}(?<value>[EGDSPHM]\d{7,8})(?![A-Za-z0-9])`,
      'dgi',
    ),
    groups: ['value'],
  },
  {
    type: 'hk_macao_taiwan_id',
    label: '港澳台证件号',
    severity: 'HIGH',
    re: new RegExp(
      String.raw`(?:香港(?:永久性)?(?:居民)?身份证|澳门(?:居民)?身份证|台湾(?:居民)?身份证|港澳台(?:居民)?证件|回乡证|台胞证)${LABEL_SEP}(?<value>[A-Z]{1,2}\d{6}\(?[A-Z0-9]\)?|[A-Z]\d{9}|\d{7,8}\(?[A-Z0-9]\)?)`,
      'dgi',
    ),
    groups: ['value'],
  },
  {
    type: 'officer_id_cn',
    label: '军官证/警官证号',
    severity: 'HIGH',
    re: new RegExp(
      String.raw`(?:军官证|警官证|武警证|士兵证)${LABEL_SEP}(?<value>[一-鿿A-Z]{0,6}(?:字第)?\d{6,12}号?)`,
      'dgi',
    ),
    groups: ['value'],
  },
  {
    type: 'home_address_cn',
    label: '家庭住址',
    severity: 'HIGH',
    re: new RegExp(
      String.raw`(?<label>${ADDRESS_LABEL})(?<sep>\s*[:：]\s*|\s*(?:是|为)\s*|\s+|)(?<value>${ADDRESS_VALUE})`,
      'dgi',
    ),
    groups: ['value'],
    validate: (v, c) => {
      if (v.includes('://') || v.includes('@')) return false;
      const label = c.m.groups?.label ?? '';
      const sep = c.m.groups?.sep ?? '';
      if (LEGACY_ADDRESS_LABELS.has(label) && /[:：]/.test(sep)) {
        return v.trim().length >= 8 && ADDRESS_CORROBORATION.test(v);
      }
      const cjk = [...v].filter((ch) => ch >= '一' && ch <= '鿿').length;
      return cjk >= 4 && ADDRESS_STREET.test(v) && ADDRESS_REGION.test(v);
    },
  },
  {
    type: 'ip_address',
    label: 'IP 地址',
    severity: 'MEDIUM',
    re: new RegExp(
      String.raw`${IP_LABEL}\s*[:=：]\s*["']?(?<value>(?:\d{1,3}\.){3}\d{1,3})(?![\d.])`,
      'dgi',
    ),
    groups: ['value'],
    validate: (v) => validIpv4(v),
  },
  {
    type: 'ip_address',
    label: 'IP 地址',
    severity: 'MEDIUM',
    re: new RegExp(
      String.raw`(?:IPv6|${IP_LABEL})\s*[:=：]\s*["']?(?<value>[0-9A-Fa-f:]{3,45})`,
      'dgi',
    ),
    groups: ['value'],
    validate: (v) => validIpv6(v),
  },
  {
    type: 'birth_date',
    label: '出生日期',
    severity: 'MEDIUM',
    re: /(?:出生日期|出生年月|出生时间|生日|date\s+of\s+birth|DOB)\s*[:：]?\s*(?<value>(?:19|20)\d{2}(?:[-/.年]\d{1,2})(?:[-/.月]\d{1,2})日?)/dgi,
    groups: ['value'],
    validate: (v) => {
      const parts = v
        .replace(/日$/, '')
        .split(/[-/.年月]/)
        .map(Number);
      const dt = validDate(parts[0]!, parts[1]!, parts[2]!);
      return !!dt && dt.getTime() >= Date.UTC(1900, 0, 1) && dt.getTime() <= Date.now();
    },
  },
  {
    type: 'gps_location',
    label: 'GPS 位置',
    severity: 'HIGH',
    re: /(?:GPS(?:\s*坐标)?|经纬度|地理坐标|location)\s*[:=：]\s*(?<lat>[+-]?\d{1,2}(?:\.\d{3,8})?)\s*[,，]\s*(?<lon>[+-]?\d{1,3}(?:\.\d{3,8})?)/dgi,
    groups: ['lat', 'lon'],
    span: true,
    validate: (_v, c) => {
      const lat = Number(c.m.groups?.lat);
      const lon = Number(c.m.groups?.lon);
      return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    },
  },
  {
    type: 'communication_record',
    label: '通信记录',
    severity: 'HIGH',
    re: /(?:通话记录|通信记录|短信记录|短信内容|聊天记录)\s*[:：]\s*(?<value>[^\n]{8,180})/dgi,
    groups: ['value'],
    validate: (v) => COMMUNICATION_CORROBORATION.test(v),
  },
  {
    type: 'credit_card_cvv',
    label: '信用卡安全码',
    severity: 'CRITICAL',
    re: /(?<![A-Za-z])(?:CVV2?|CVC2?|CID|信用卡安全码|卡片安全码)\s*[:=：]\s*(?<value>\d{3,4})(?!\d)/dgi,
    groups: ['value'],
    // CID 多是频道、内容、客户端 ID，旁边有有效卡号才算安全码
    validate: (_v, c) =>
      c.m[0].slice(0, 3).toLowerCase() !== 'cid' ||
      hasValidCardNear(c.text, c.m.index, c.m.index + c.m[0].length),
  },
  {
    type: 'bank_statement',
    label: '银行流水',
    severity: 'HIGH',
    re: /(?:银行流水|账户流水|交易明细|账户明细)\s*[:：]\s*(?<value>[^\n]{12,220})/dgi,
    groups: ['value'],
    validate: (v) => BANK_STATEMENT_CORROBORATION.filter((r) => r.test(v)).length >= 2,
  },
  {
    type: 'insurance_info',
    label: '保单信息',
    severity: 'HIGH',
    re: /(?:保险单号|保单号|理赔编号|理赔案号)\s*[:：#]?\s*(?<value>[A-Z0-9][A-Z0-9_-]{7,31})/dgi,
    groups: ['value'],
  },
  {
    type: 'medical_record',
    label: '病历信息',
    severity: 'HIGH',
    re: /(?:病历记录|电子病历|病历号|门诊记录|住院记录)\s*[:：#]?\s*(?<value>[^\n]{8,220})/dgi,
    groups: ['value'],
    validate: (_v, c) => {
      const window = c.text.slice(Math.max(0, c.m.index - 32), c.m.index + c.m[0].length + 80);
      return MEDICAL_CORROBORATION.every((r) => r.test(window));
    },
  },
  {
    type: 'genetic_data',
    label: '基因数据',
    severity: 'HIGH',
    re: /(?:DNA|RNA|基因|核酸)\s*(?:检测)?\s*(?:序列|数据|结果)\s*[:：]\s*(?<value>[ACGTUNacgtun\s-]{20,500})/dgi,
    groups: ['value'],
    validate: (v) => {
      const compact = v.replace(/[\s-]/g, '').toUpperCase();
      return compact.length >= 20 && /^[ACGTUN]+$/.test(compact) && new Set(compact).size >= 3;
    },
  },
  {
    type: 'biometric_data',
    label: '生物识别数据',
    severity: 'HIGH',
    re: /(?:生物识别)?(?:指纹(?:特征)?(?:数据|模板)?|虹膜(?:特征)?(?:数据|模板)?|人脸特征(?:向量|模板|数据)?|声纹特征(?:向量|模板|数据)?|掌纹(?:特征)?(?:数据|模板)?)\s*[:：]\s*(?<value>[A-Za-z0-9+/=,._ -]{20,500})/dgi,
    groups: ['value'],
    validate: (v) => credibleSecret(v),
  },
  {
    type: 'internal_project_code',
    label: '内部项目代号',
    severity: 'HIGH',
    re: /(?:内部项目代号|项目代号|内部产品代号|产品代号|project\s+code)\s*[:=：]\s*(?<value>[A-Z][A-Z0-9_-]{3,31})/dgi,
    groups: ['value'],
    validate: (v) => /[0-9_-]/.test(v),
  },
  {
    type: 'sensitive_code',
    label: '敏感代码',
    severity: 'HIGH',
    re: /(?:敏感代码片段|核心算法代码|核心源代码|专有源代码|proprietary\s+source\s+code)\s*[:：]\s*(?<value>[^\n]{16,400})/dgi,
    groups: ['value'],
    validate: (v) => CODE_CORROBORATION.test(v),
  },
  {
    type: 'education_background',
    label: '教育背景',
    severity: 'MEDIUM',
    re: /(?:教育背景|学历信息|学历|毕业院校|毕业学校)\s*[:：]\s*(?<value>[^\n,，;；]{4,80})/dgi,
    groups: ['value'],
    validate: (v) => EDUCATION_WORDS.test(v),
  },
  {
    type: 'criminal_record',
    label: '犯罪记录',
    severity: 'HIGH',
    re: /(?:犯罪记录|刑事处罚记录|案底|判决记录)\s*[:：]\s*(?<value>[^\n]{6,220})/dgi,
    groups: ['value'],
    validate: (v) => CRIMINAL_CORROBORATION.test(v),
  },

  // ---- 通用号码（不靠标签） ----
  {
    type: 'id_card_cn',
    label: '身份证号',
    severity: 'HIGH',
    re: /(?<![0-9])\d{17}[\dXx](?![0-9])/dg,
    validate: (v) => validIdCard(v),
  },
  {
    type: 'id_card_cn',
    label: '身份证号',
    severity: 'HIGH',
    re: /(?<![0-9])\d{6}(?<sep>[ -])(?:\d{8}|\d{4}\k<sep>\d{4})\k<sep>\d{3}[\dXx](?![0-9])/dg,
    validate: (v) => validIdCard(v.replace(/[ -]/g, '')),
  },
  {
    type: 'bank_card_cn',
    label: '银行卡号',
    severity: 'HIGH',
    re: /(?<![0-9])[3-6]\d{15,18}(?![0-9])/dg,
    validate: (v) => validBankCard(v),
  },
  {
    type: 'bank_card_cn',
    label: '银行卡号',
    severity: 'HIGH',
    re: /(?<![0-9])[3-6]\d{3}(?<sep>[ -])\d{4}\k<sep>\d{4}\k<sep>\d{4}(?:\k<sep>\d{1,3})?(?![0-9])/dg,
    validate: (v, c) => {
      const d = digitsOf(v);
      const ctx = BANK_CONTEXT.test(c.text.slice(Math.max(0, c.start - 16), c.start));
      return (ctx || (d.startsWith('62') && d.length === 19)) && validBankCard(d);
    },
  },
  {
    type: 'phone_cn',
    label: '手机号',
    severity: 'MEDIUM',
    re: /(?<![0-9])(?:(?:\+|00)86[ -]?)?(?<value>1[3-9]\d(?<sep>[ -]?)\d{4}\k<sep>\d{4})(?![0-9])/dg,
    groups: ['value'],
    validate: (v) => MOBILE_SEGMENT.test(digitsOf(v)),
  },
  {
    type: 'email',
    label: '电子邮箱',
    severity: 'LOW',
    // 本地部分前面加边界：长串里每个起点都吃 64 字再回溯会很慢（本地部分本来就不超过 64）
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/dg,
    validate: (v) => {
      const domain = v.slice(v.lastIndexOf('@') + 1).toLowerCase();
      if (/^\d+\.\d+(?:[.\-+]|$)/.test(domain) || domain === 'openssh.com') return false;
      return v.toLowerCase() !== 'noreply@anthropic.com';
    },
  },
  {
    // 不带标签词时多半是单据号、编号碰巧对上校验位，降为低危
    type: 'uscc',
    label: '统一社会信用代码',
    severity: 'MEDIUM',
    re: /(?<![0-9A-Z])[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])/dg,
    validate: (v) => validUscc(v),
    severityOf: (c) => (labelBefore(USCC_LABEL, c) ? 'MEDIUM' : 'LOW'),
  },
  {
    // 通用护照号写法，不带标签也认；不带标签词时多半是 D20231201 这类单据号，降为低危
    type: 'passport_cn',
    label: '护照号',
    severity: 'HIGH',
    re: /(?<![A-Za-z0-9])[EGPSDK]\d{8}(?![A-Za-z0-9])/dg,
    severityOf: (c) => (labelBefore(PASSPORT_LABEL, c) ? 'HIGH' : 'LOW'),
  },
];

/** 全部敏感信息类别（去重，按规则顺序）。 */
export const SENSITIVE_TYPES: readonly SensitiveTypeInfo[] = (() => {
  const seen = new Map<string, SensitiveTypeInfo>();
  for (const r of RULES) {
    if (!seen.has(r.type)) seen.set(r.type, { type: r.type, label: r.label, severity: r.severity });
  }
  return [...seen.values()];
})();

export const SENSITIVE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  SENSITIVE_TYPES.map((t) => [t.type, t.label]),
);

function valueSpan(rule: Rule, m: RegExpExecArray): [number, number] | null {
  const whole: [number, number] = [m.index, m.index + m[0].length];
  if (!rule.groups) return whole;
  const idx = m.indices?.groups;
  if (!idx) return whole;
  if (rule.span) {
    let start = Infinity;
    let end = -1;
    for (const g of rule.groups) {
      const s = idx[g];
      if (!s) continue;
      start = Math.min(start, s[0]);
      end = Math.max(end, s[1]);
    }
    return end >= 0 ? [start, end] : null;
  }
  for (const g of rule.groups) {
    const s = idx[g];
    if (s) return [s[0], s[1]];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 结构性误报过滤（逐条对照见 docs/corpus-scan-sensitive-rules.md「误报过滤」）：
// 1. 二进制编码块：≥256 字的 base64 串、解出来是图片、PDF、压缩包等文件头的，里面的手机号、银行卡号、
//    身份证号、邮箱、护照号不算；
// 2. 不是个人信息的数字：小数的小数部分（0.30000000000000004）、ASCII 标识符里的数字串
//    （img_13800138000.png、u4111111111111111）、swap 表的大小列，与手机号、银行卡号整段重合的不算；
// 3. URL 里的 userinfo（https://alice@example.com/repo.git）不是邮箱。
// ---------------------------------------------------------------------------

const BINARY_FILTER_TYPES = new Set([
  'phone_cn',
  'bank_card_cn',
  'id_card_cn',
  'email',
  'passport_cn',
]);
const NUMERIC_FILTER_TYPES = new Set(['phone_cn', 'bank_card_cn']);

const BASE64_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{256,}={0,2}(?![A-Za-z0-9+/_=-])/g;

function startsWithBytes(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function binaryKind(prefix: Uint8Array): string {
  if (startsWithBytes(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWithBytes(prefix, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWithBytes(prefix, ascii('GIF87a')) || startsWithBytes(prefix, ascii('GIF89a')))
    return 'gif';
  if (startsWithBytes(prefix, ascii('RIFF'))) {
    if (startsWithBytes(prefix, ascii('WEBP'), 8)) return 'webp';
    if (startsWithBytes(prefix, ascii('WAVE'), 8)) return 'wave';
  }
  if (
    startsWithBytes(prefix, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWithBytes(prefix, [0x4d, 0x4d, 0x00, 0x2a])
  )
    return 'tiff';
  if (startsWithBytes(prefix, ascii('%PDF-'))) return 'pdf';
  if (
    startsWithBytes(prefix, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(prefix, [0x1f, 0x8b, 0x08])
  )
    return 'archive';
  return '';
}

/** 能认出文件头的 base64 二进制块（start, end）。 */
export function binaryRegions(text: string): [number, number][] {
  const out: [number, number][] = [];
  BASE64_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BASE64_RUN.exec(text)) !== null) {
    const value = m[0];
    if (value.length % 4 !== 0) continue;
    const head = value.slice(0, 128).replace(/-/g, '+').replace(/_/g, '/');
    if (binaryKind(Buffer.from(head, 'base64'))) out.push([m.index, m.index + value.length]);
  }
  return out;
}

const DECIMAL_FRACTION = /(?<![\p{L}\p{N}_.])[+-]?\d+\.(?<fraction>\d{11,19})(?!\d)/dgu;
const ASCII_TOKEN = /[A-Za-z0-9_]+/g;
const NL = String.raw`(?:\r?\n|\\r\\n|\\n)`;
const SWAP_HEADER = new RegExp(
  String.raw`(?:^|${NL})NAME[ \t]+TYPE[ \t]+SIZE[ \t]+USED[ \t]+PRIO[ \t]*${NL}`,
  'gm',
);
const SWAP_ROW = new RegExp(
  String.raw`[^ \t\r\n\\"]+[ \t]+(?:file|partition)[ \t]+(?<size>\d+)[ \t]+(?<used>\d+)[ \t]+-?\d+[ \t]*(?=${NL}|$)`,
  'dy',
);
const NL_AT = new RegExp(NL, 'y');

/** 是语法而不是个人信息的数字段，返回 "start:end" 集合（与手机号、银行卡号的命中整段比较）。 */
export function nonPiiNumericSpans(text: string): Set<string> {
  const spans = new Set<string>();
  DECIMAL_FRACTION.lastIndex = 0;
  for (const m of text.matchAll(DECIMAL_FRACTION)) {
    const f = m.indices?.groups?.fraction;
    if (f) spans.add(`${f[0]}:${f[1]}`);
  }
  // ASCII 标识符、哈希里的数字串（中文标签可以紧贴真号码，不能用 Unicode 的词边界）
  for (const t of text.matchAll(ASCII_TOKEN)) {
    const value = t[0];
    if (value.length < 12 || !/[A-Za-z_]/.test(value)) continue;
    for (const d of value.matchAll(/\d{11,19}/g)) {
      const s = t.index + d.index;
      spans.add(`${s}:${s + d[0].length}`);
    }
  }
  SWAP_HEADER.lastIndex = 0;
  for (const h of text.matchAll(SWAP_HEADER)) {
    let pos = h.index + h[0].length;
    for (let n = 0; n < 32; n++) {
      SWAP_ROW.lastIndex = pos;
      const row = SWAP_ROW.exec(text);
      if (!row) break;
      for (const g of ['size', 'used']) {
        const sp = row.indices?.groups?.[g];
        if (sp) spans.add(`${sp[0]}:${sp[1]}`);
      }
      const rowEnd = row.index + row[0].length;
      NL_AT.lastIndex = rowEnd;
      const nl = NL_AT.exec(text.slice(0, rowEnd + 4));
      if (!nl) break;
      pos = rowEnd + nl[0].length;
    }
  }
  return spans;
}

const URL_USERINFO_PREFIX = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@"'`<>]*$/;

/** scheme://user:pass@host 里的 user:pass@host 是 URL 的 authority，不是邮箱。 */
export function isUrlUserinfo(text: string, start: number): boolean {
  return URL_USERINFO_PREFIX.test(text.slice(Math.max(0, start - 512), start));
}

/** hits 按 start 有序且互不重叠：二分找到插入位置，看左右邻居是否重叠；不重叠返回插入位置，否则 -1。 */
function insertionIndex(hits: SensitiveHit[], start: number, end: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid]!.start < start) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && hits[lo - 1]!.end > start) return -1;
  if (lo < hits.length && hits[lo]!.start < end) return -1;
  return lo;
}

/** 两个按 start 有序、互不重叠的列表归并（一条规则的命中整批并入，不逐个往中间插）。 */
function mergeHits(a: SensitiveHit[], b: SensitiveHit[]): SensitiveHit[] {
  if (a.length === 0) return b;
  const out: SensitiveHit[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i]!.start <= b[j]!.start ? a[i++]! : b[j++]!;
  while (i < a.length) out[k++] = a[i++]!;
  while (j < b.length) out[k++] = b[j++]!;
  return out;
}

/** 找出一段文本里的全部敏感信息；同一段原文只记优先级最高的一类，按位置排序。 */
export function findSensitive(text: string): SensitiveHit[] {
  let hits: SensitiveHit[] = [];
  if (!text) return hits;
  let regions: [number, number][] | null = null;
  let numeric: Set<string> | null = null;
  for (const rule of RULES) {
    const added: SensitiveHit[] = [];
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0] === '') {
        rule.re.lastIndex += 1;
        continue;
      }
      const span = valueSpan(rule, m);
      if (!span) continue;
      const [start, end] = span;
      if (insertionIndex(hits, start, end) < 0) continue;
      const last = added[added.length - 1];
      if (last && last.end > start) continue;
      const value = text.slice(start, end);
      const ctx: MatchContext = { text, start, end, m };
      if (rule.validate && !rule.validate(value, ctx)) continue;
      if (BINARY_FILTER_TYPES.has(rule.type)) {
        regions ??= binaryRegions(text);
        if (regions.some(([s, e]) => s <= start && end <= e)) continue;
      }
      if (NUMERIC_FILTER_TYPES.has(rule.type)) {
        numeric ??= nonPiiNumericSpans(text);
        if (numeric.has(`${start}:${end}`)) continue;
      }
      if (rule.type === 'email' && isUrlUserinfo(text, start)) continue;
      added.push({
        type: rule.type,
        label: rule.label,
        severity: rule.severityOf ? rule.severityOf(ctx) : rule.severity,
        start,
        end,
        value,
      });
    }
    if (added.length > 0) hits = mergeHits(hits, added);
  }
  return hits;
}

/** 打码并返回替换个数：敏感信息换成「[类型]」，跨行的命中（私钥块）保留原有换行数，行数不变。 */
export function maskSensitiveCounted(text: string): { text: string; count: number } {
  const hits = findSensitive(text);
  if (hits.length === 0) return { text, count: 0 };
  let out = '';
  let pos = 0;
  for (const h of hits) {
    let newlines = 0;
    for (let i = h.start; i < h.end; i++) if (text.charCodeAt(i) === 10) newlines += 1;
    out += text.slice(pos, h.start) + `[${h.label}]` + '\n'.repeat(newlines);
    pos = h.end;
  }
  return { text: out + text.slice(pos), count: hits.length };
}

/** 打码：敏感信息换成「[类型]」，行数不变。 */
export function maskSensitive(text: string): string {
  return maskSensitiveCounted(text).text;
}
