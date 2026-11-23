// Windows 安装包：把部署配置（含接入码）追加到探针安装器 exe 的尾部，用户双击即可接入。
//
// 尾部格式与探针仓库（AgentShield）apps/api/internal/handler/client_installers.go 完全一致：
//   exe 原始字节 + 部署配置 JSON（UTF-8，≤ 8192 字节）+ 4 字节小端 uint32（JSON 字节数）+ ASCII "ASPDEPLOY1"
// 安装器用 DisallowUnknownFields 严格解析 JSON，所以这里只能出现约定好的键。
//
// 预检规则以安装器源码 probe/internal/enterprise/deployment.go 的 ValidateDeployment 为准：
// 生成之前先在服务端检查一遍，宁可给出中文原因，也不生成一个装不上的安装包。
import { createHash, X509Certificate } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { isIP } from 'node:net';
import { conflict } from '../../lib/errors.js';
import type { DeploymentInfo } from './deployment.js';
import {
  checkInstaller,
  INSTALLER_SERVER_KIND,
  INSTALLER_TARGETS,
  type InstallerState,
  type KitCatalog,
} from './kits.js';

/** 尾部魔数（10 个 ASCII 字节）。 */
export const OVERLAY_MARKER = 'ASPDEPLOY1';
/** 部署配置 JSON 的字节上限（安装器同样限制）。 */
export const MAX_OVERLAY_JSON = 8192;
/** 下载文件名前缀（不写中文产品名，避免响应头编码问题）。 */
export const INSTALLER_FILE_PREFIX = 'jiandun-probe-setup';

// ───────────────────────── 最小 DER 解析 ─────────────────────────
// Node 的 X509Certificate 看不到 BasicConstraints 是否存在、KeyUsage 位、SAN 的条目类型，
// 这里只读证书里这几项，不做通用 ASN.1。

interface Tlv {
  tag: number;
  start: number;
  vStart: number;
  vEnd: number;
}

class DerError extends Error {}

function readTlv(buf: Buffer, pos: number, limit: number): Tlv {
  if (pos + 2 > limit) throw new DerError('truncated');
  const tag = buf[pos]!;
  let len = buf[pos + 1]!;
  let off = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || off + n > limit) throw new DerError('bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + i]!;
    off += n;
  }
  if (off + len > limit) throw new DerError('overrun');
  return { tag, start: pos, vStart: off, vEnd: off + len };
}

function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = parent.vStart;
  while (pos < parent.vEnd) {
    const t = readTlv(buf, pos, parent.vEnd);
    out.push(t);
    pos = t.vEnd;
  }
  return out;
}

function decodeOid(b: Buffer): string {
  if (b.length === 0) throw new DerError('empty oid');
  const first = b[0]!;
  const parts: number[] = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i]! & 0x7f);
    if (!(b[i]! & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

const OID_KEY_USAGE = '2.5.29.15';
const OID_SAN = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

interface CertFacts {
  subjectRaw: Buffer;
  issuerRaw: Buffer;
  /** 扩展 OID → extnValue 的内容（OCTET STRING 去壳后的字节）。 */
  extensions: Map<string, Buffer>;
}

function parseCertFacts(der: Buffer): CertFacts {
  const cert = readTlv(der, 0, der.length);
  if (cert.tag !== 0x30) throw new DerError('not a sequence');
  const tbs = children(der, cert)[0];
  if (!tbs || tbs.tag !== 0x30) throw new DerError('no tbs');
  const f = children(der, tbs);
  let i = 0;
  if (f[i]?.tag === 0xa0) i++; // version [0]
  i += 2; // serialNumber, signature
  const issuer = f[i++];
  i++; // validity
  const subject = f[i++];
  i++; // subjectPublicKeyInfo
  if (!issuer || !subject) throw new DerError('no names');
  const extensions = new Map<string, Buffer>();
  const extWrap = f.slice(i).find((t) => t.tag === 0xa3);
  if (extWrap) {
    const seq = children(der, extWrap)[0];
    if (!seq || seq.tag !== 0x30) throw new DerError('bad extensions');
    for (const ext of children(der, seq)) {
      const c = children(der, ext);
      const oid = c[0];
      if (!oid || oid.tag !== 0x06) throw new DerError('bad extension');
      const value = c[1]?.tag === 0x01 ? c[2] : c[1]; // 跳过可选的 critical 标志
      if (!value || value.tag !== 0x04) throw new DerError('bad extension value');
      extensions.set(
        decodeOid(der.subarray(oid.vStart, oid.vEnd)),
        der.subarray(value.vStart, value.vEnd),
      );
    }
  }
  return {
    subjectRaw: der.subarray(subject.start, subject.vEnd),
    issuerRaw: der.subarray(issuer.start, issuer.vEnd),
    extensions,
  };
}

/** BasicConstraints.cA（扩展里没有 cA 布尔值时按 DER 默认值 FALSE）。 */
function basicConstraintsIsCa(value: Buffer): boolean {
  const seq = readTlv(value, 0, value.length);
  const first = children(value, seq)[0];
  return Boolean(first && first.tag === 0x01 && value[first.vStart] !== 0);
}

/** KeyUsage 位串第一个字节：bit0 digitalSignature=0x80，keyCertSign=0x04，cRLSign=0x02。 */
function keyUsageByte(value: Buffer): number {
  const t = readTlv(value, 0, value.length);
  if (t.tag !== 0x03 || t.vEnd - t.vStart < 2) return 0;
  return value[t.vStart + 1]!;
}

function extKeyUsages(value: Buffer): string[] {
  const seq = readTlv(value, 0, value.length);
  return children(value, seq)
    .filter((t) => t.tag === 0x06)
    .map((t) => decodeOid(value.subarray(t.vStart, t.vEnd)));
}

interface SanFacts {
  dns: number;
  uri: number;
  email: number;
  ip: number;
}

function sanFacts(value: Buffer): SanFacts {
  const seq = readTlv(value, 0, value.length);
  const out: SanFacts = { dns: 0, uri: 0, email: 0, ip: 0 };
  for (const t of children(value, seq)) {
    if (t.tag === 0x82) out.dns++;
    else if (t.tag === 0x86) out.uri++;
    else if (t.tag === 0x81) out.email++;
    else if (t.tag === 0x87) out.ip++;
  }
  return out;
}

// ───────────────────────── 部署预检 ─────────────────────────

/**
 * 按安装器的校验规则检查部署信息，返回不满足的原因（中文）；空数组表示可以生成安装包。
 * deploymentInfo() 已经查出来的问题（未配置、不是 https、带路径、证书不是自签、不在有效期、
 * SAN 不覆盖主机……）原样带上，再补上它没查的几项：主机必须是 IP、证书是显式 CA:FALSE 的叶子、
 * SAN 只有一个 IP、密钥用途与扩展密钥用途。
 */
export function installerDeploymentProblems(info: DeploymentInfo): string[] {
  const problems = new Set<string>(info.issues);
  if (!info.server || !info.certificate) {
    if (problems.size === 0) problems.add('部署信息尚未就绪（服务端地址或证书未配置完整）');
    return [...problems];
  }

  let host = '';
  try {
    host = new URL(info.server).hostname.replace(/^\[|\]$/g, '');
  } catch {
    problems.add('服务地址无法解析');
  }
  if (host && isIP(host) === 0) problems.add('服务地址的主机必须是 IP 地址，安装包不支持域名');

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(info.certificate.pem);
  } catch {
    problems.add('证书文件无法解析');
    return [...problems];
  }

  let facts: CertFacts;
  try {
    facts = parseCertFacts(cert.raw);
  } catch {
    problems.add('证书结构无法解析');
    return [...problems];
  }

  try {
    const basic = facts.extensions.get(OID_BASIC_CONSTRAINTS);
    if (!basic)
      problems.add('证书缺少基本约束扩展（BasicConstraints），安装器要求显式声明 CA:FALSE');
    else if (cert.ca || basicConstraintsIsCa(basic))
      problems.add('证书是 CA 证书（CA:TRUE），安装器只接受自签叶子证书，请重新签发');

    if (!facts.subjectRaw.equals(facts.issuerRaw) && info.certificate.selfSigned)
      problems.add('证书的主体与颁发者不一致，不是自签证书');

    const san = facts.extensions.get(OID_SAN);
    const sanInfo = san ? sanFacts(san) : { dns: 0, uri: 0, email: 0, ip: 0 };
    if (sanInfo.dns + sanInfo.uri + sanInfo.email > 0)
      problems.add('证书 SAN 含 DNS、URI 或邮箱条目，安装器要求 SAN 只能有一个 IP 地址');
    if (sanInfo.ip !== 1)
      problems.add(`证书 SAN 必须恰好包含一个 IP 地址（当前 ${sanInfo.ip} 个）`);
    else if (
      info.certificate.hostMatches !== false &&
      host &&
      isIP(host) !== 0 &&
      !cert.checkIP(host)
    )
      problems.add('证书 SAN 中的 IP 与服务地址的主机不一致');

    const ku = facts.extensions.get(OID_KEY_USAGE);
    const kuByte = ku ? keyUsageByte(ku) : 0;
    if (!(kuByte & 0x80)) problems.add('证书密钥用途（keyUsage）必须包含 digitalSignature');
    if (kuByte & (0x04 | 0x02))
      problems.add('证书密钥用途（keyUsage）不得包含 keyCertSign 或 cRLSign');

    const eku = facts.extensions.get(OID_EXT_KEY_USAGE);
    if (!eku || !extKeyUsages(eku).includes(OID_SERVER_AUTH))
      problems.add('证书扩展密钥用途（extendedKeyUsage）必须包含 serverAuth（服务器认证）');
  } catch {
    problems.add('证书扩展项无法解析');
  }

  const now = Date.now();
  if (now < cert.validFromDate.getTime() || now > cert.validToDate.getTime())
    problems.add('证书不在有效期内');
  return [...problems];
}

// ───────────────────────── 可用性 ─────────────────────────

export interface InstallerAvailability {
  available: boolean;
  /** 不可用的原因（中文）。 */
  reason?: string;
}

export type InstallerCheck =
  | { ok: true; kit: Extract<InstallerState, { ok: true }> }
  | {
      ok: false;
      reason: string;
      code: 'FLEET_DEPLOYMENT_NOT_READY' | 'FLEET_INSTALLER_UNAVAILABLE';
    };

/** 某个 Windows 目标现在能不能提供安装包：先看部署，再看探针包。 */
export async function checkInstallerTarget(
  catalog: KitCatalog,
  info: DeploymentInfo,
  target: string,
  productName: string,
): Promise<InstallerCheck> {
  const problems = installerDeploymentProblems(info);
  if (problems.length > 0)
    return {
      ok: false,
      code: 'FLEET_DEPLOYMENT_NOT_READY',
      reason: `部署信息不满足${productName}安装包的要求：${problems.join('；')}`,
    };
  const kit = await checkInstaller(catalog, target, productName);
  if (!kit.ok) return { ok: false, code: 'FLEET_INSTALLER_UNAVAILABLE', reason: kit.reason };
  return { ok: true, kit };
}

/** 给 deployment-info 用：每个 Windows 目标的可用状态。 */
export async function installerAvailability(
  catalog: KitCatalog,
  info: DeploymentInfo,
  target: string,
  productName: string,
): Promise<InstallerAvailability> {
  const check = await checkInstallerTarget(catalog, info, target, productName);
  return check.ok ? { available: true } : { available: false, reason: check.reason };
}

export const isInstallerTarget = (target: string): boolean =>
  (INSTALLER_TARGETS as readonly string[]).includes(target);

// ───────────────────────── 尾部 ─────────────────────────

/** RFC3339 UTC，精确到秒（向下取整，比接入码真实到期时间只早不晚）。 */
export function toRfc3339Seconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface InstallerOverlayInput {
  server: string;
  code: string;
  expiresAt: Date;
  certPem: string;
  certSha256: string;
}

/** 部署配置 JSON + 4 字节小端长度 + 魔数：直接接在 exe 原始字节后面。 */
export function buildInstallerTail(input: InstallerOverlayInput): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      server: input.server,
      enrollment_code: input.code,
      allow_http: false,
      expires_at: toRfc3339Seconds(input.expiresAt),
      tls_server_cert_pem: input.certPem,
      tls_server_cert_sha256: input.certSha256,
      server_kind: INSTALLER_SERVER_KIND,
    }),
    'utf8',
  );
  if (json.length === 0 || json.length > MAX_OVERLAY_JSON)
    throw conflict(
      `部署配置超过安装包允许的 ${MAX_OVERLAY_JSON} 字节，请检查服务地址与证书`,
      'FLEET_DEPLOYMENT_NOT_READY',
    );
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length, 0);
  return Buffer.concat([json, length, Buffer.from(OVERLAY_MARKER, 'ascii')]);
}

/** 发送过程中发现安装包文件已不是校验时的内容。 */
export class InstallerChangedError extends Error {
  constructor() {
    super('安装包文件在发送过程中发生变化');
  }
}

/**
 * 流式输出 exe 原始字节，最后接上部署配置尾部（含接入码）。
 *
 * 预检（sha256 与清单一致）和发送之间文件可能被替换，所以发送时对已打开的句柄边读边算 sha256，
 * 读完先与清单比对，一致才发尾部；不一致就抛错中断响应——宁可让下载失败，
 * 也不能把「被换过的安装包 + 接入码」发出去。读完（或出错）一定关闭句柄。
 */
export async function* streamInstaller(
  handle: FileHandle,
  size: number,
  expectedSha256: string,
  tail: Buffer,
): AsyncGenerator<Buffer> {
  try {
    const hash = createHash('sha256');
    let sent = 0;
    for await (const chunk of handle.createReadStream({
      start: 0,
      end: size - 1,
      autoClose: false,
    })) {
      const buf = chunk as Buffer;
      hash.update(buf);
      sent += buf.length;
      yield buf;
    }
    if (sent !== size || hash.digest('hex') !== expectedSha256) throw new InstallerChangedError();
    yield tail;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
