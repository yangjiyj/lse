import { FLEET_LIVE_PRODUCTS } from '../../../../../packages/shared/src/fleet-live-eval.js';
// 一键安装脚本生成：把服务端地址、证书、探针包下载地址与散列写死进 bash 脚本。
// 脚本内容必须稳定：同样配置下两次生成的字节完全相同（不写时间戳、不写随机数），这样 sha256 才能写进复制即用的命令。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PRODUCT_NAME } from '../../lib/product-name.js';
import { deploymentInfo, type DeploymentInfo } from './deployment.js';
import {
  checkKitItems,
  kitWarnings,
  loadKitCatalog,
  type KitCatalog,
  type KitItemStatus,
} from './kits.js';

const TEMPLATE_URL = new URL('./templates/install-linux.sh.in', import.meta.url);
let templateCache: string | null = null;
function template(): string {
  if (templateCache === null) templateCache = readFileSync(TEMPLATE_URL, 'utf8');
  return templateCache;
}

/** bash 单引号转义。 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 终端下载脚本和探针包所用的 lse 地址（只取 origin）。
 * 优先级：FLEET_KIT_BASE_URL > LSE_PUBLIC_BASE_URL > 本次请求使用的地址。
 */
export function kitBaseUrl(requestOrigin: string | null): string | null {
  for (const raw of [
    process.env.FLEET_KIT_BASE_URL?.trim(),
    process.env.LSE_PUBLIC_BASE_URL?.trim(),
    requestOrigin ?? undefined,
  ]) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      return url.origin;
    } catch {
      /* 试下一个来源 */
    }
  }
  return null;
}

export interface OneclickInfo {
  /** 是否可以给出一键命令：部署就绪 + 至少一个 Linux 架构的包可用。 */
  available: boolean;
  /** 不可用的原因（中文）。 */
  reasons: string[];
  scriptUrl: string | null;
  scriptSha256: string | null;
  /** 下载脚本时落到磁盘的文件名，前端拼命令用。 */
  scriptFile: string;
  targets: Array<{
    target: string;
    os: string;
    arch: string;
    version: string;
    filename: string;
    bytes: number | null;
    status: KitItemStatus['status'];
    /** 是否支持一键安装（Windows / macOS 目前只列出）。 */
    oneclick: boolean;
    /** Windows 安装包是否可下载；仅 Windows 目标带这个字段，由 deployment-info 路由补充。 */
    installer?: { available: boolean; reason?: string };
  }>;
}

export const SCRIPT_FILE = '/tmp/jiandun-probe.sh';

export interface OneclickBundle {
  info: DeploymentInfo;
  catalog: KitCatalog;
  oneclick: OneclickInfo;
  /** 动态生成的脚本；不可用时为 null。 */
  script: string | null;
  kitWarnings: string[];
}

export function renderInstallScript(args: {
  server: string;
  certSha256: string;
  tlsJson: string;
  baseUrl: string;
  kits: KitItemStatus[];
}): string {
  const cases = args.kits
    .filter((k) => k.oneclick && k.status === 'ok')
    .map(
      (k) =>
        `  ${k.arch})\n` +
        `    KIT_URL=${shQuote(`${args.baseUrl}/api/fleet/kits/${k.filename}`)}\n` +
        `    KIT_FILE=${shQuote(k.filename)}\n` +
        `    KIT_SHA256=${shQuote(k.sha256)}\n` +
        `    MANIFEST_SHA256=${shQuote(k.manifestSha256)}\n` +
        `    KIT_VERSION=${shQuote(k.version)}\n` +
        `    ;;`,
    )
    .join('\n');
  // 用函数形式替换，避免替换串里的 $ 被当作特殊序列。
  return template()
    .replace('@@EVAL_PRODUCTS@@', () => FLEET_LIVE_PRODUCTS.map(shQuote).join(' '))
    .replace(/@@PRODUCT@@/g, () => shQuote(PRODUCT_NAME))
    .replace('@@SERVER@@', () => shQuote(args.server))
    .replace('@@CERT_SHA256@@', () => shQuote(args.certSha256))
    .replace('@@KIT_CASES@@', () => cases)
    .replace('@@TLS_JSON@@', () => args.tlsJson.replace(/\n+$/, ''));
}

export async function buildOneclick(requestOrigin: string | null): Promise<OneclickBundle> {
  const info = deploymentInfo();
  const catalog = await loadKitCatalog();
  const kits = await checkKitItems(catalog);
  const warnings = kitWarnings(catalog, kits);
  const reasons: string[] = [];
  if (!info.ready || !info.server || !info.certificate || !info.tlsDeployment)
    reasons.push('部署信息尚未就绪（服务端地址或证书未配置完整）');
  const baseUrl = kitBaseUrl(requestOrigin);
  if (!baseUrl)
    reasons.push('无法确定终端访问本平台的地址：请配置 LSE_PUBLIC_BASE_URL 或 FLEET_KIT_BASE_URL');
  if (!catalog.configured) reasons.push('未配置探针包目录 FLEET_KIT_DIR');
  else if (!kits.some((k) => k.oneclick && k.status === 'ok'))
    reasons.push('探针包目录里没有可用的 Linux 探针包');

  let script: string | null = null;
  if (reasons.length === 0 && info.server && info.certificate && info.tlsDeployment && baseUrl) {
    script = renderInstallScript({
      server: info.server,
      certSha256: info.certificate.sha256,
      tlsJson: JSON.stringify(info.tlsDeployment, null, 2),
      baseUrl,
      kits,
    });
  }
  const oneclick: OneclickInfo = {
    available: script !== null,
    reasons,
    scriptUrl: script && baseUrl ? `${baseUrl}/api/fleet/install/linux.sh` : null,
    scriptSha256: script ? sha256Text(script) : null,
    scriptFile: SCRIPT_FILE,
    targets: kits.map((k) => ({
      target: k.target,
      os: k.os,
      arch: k.arch,
      version: k.version,
      filename: k.filename,
      bytes: k.bytes,
      status: k.status,
      oneclick: k.oneclick,
    })),
  };
  return { info, catalog, oneclick, script, kitWarnings: warnings };
}
