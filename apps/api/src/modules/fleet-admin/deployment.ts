// 部署所需信息：服务地址、自签叶子证书及其 SHA-256、tls-deployment.json（规格 §0.2）、collector.json 片段（§7）。
import { readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { PRODUCT_NAME } from '../../lib/product-name.js';

export interface DeploymentInfo {
  ready: boolean;
  issues: string[];
  warnings: string[];
  server: string | null;
  certificate: {
    pem: string;
    sha256: string;
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    selfSigned: boolean;
    hostMatches: boolean | null;
  } | null;
  tlsDeployment: {
    server: string;
    tls_server_cert_pem: string;
    tls_server_cert_sha256: string;
  } | null;
  collectorConfigPatch: Record<string, unknown>;
  installCommands: Array<{ title: string; command: string }>;
}

function parseServer(raw: string | undefined, issues: string[]): URL | null {
  if (!raw) {
    issues.push(`未配置 FLEET_PUBLIC_BASE_URL（终端访问${PRODUCT_NAME}的 HTTPS 服务地址）`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push('FLEET_PUBLIC_BASE_URL 不是有效地址');
    return null;
  }
  // 规格 §0.2：只能是 scheme://host[:port]，不能带路径、查询串或用户信息；且只能是 HTTPS。
  if (url.protocol !== 'https:') issues.push('FLEET_PUBLIC_BASE_URL 必须使用 https://');
  if (url.username || url.password || url.search || url.hash || !/^\/?$/.test(url.pathname))
    issues.push('FLEET_PUBLIC_BASE_URL 只能是 https://主机[:端口]，不能带路径、查询串或用户信息');
  return url;
}

function loadCertificate(
  path: string | undefined,
  host: string | null,
  issues: string[],
  warnings: string[],
) {
  if (!path) {
    issues.push('未配置 FLEET_TLS_CERT_PEM_PATH（挂载的自签叶子证书 PEM 文件）');
    return null;
  }
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch {
    issues.push('无法读取 FLEET_TLS_CERT_PEM_PATH 指向的证书文件');
    return null;
  }
  // 绝不把私钥回显给前端：文件里出现私钥就拒绝。
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    issues.push('证书文件里包含私钥，请只挂载证书（公钥）部分');
    return null;
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length !== 1) {
    issues.push('证书文件必须恰好包含 1 张证书');
    return null;
  }
  const normalized = blocks[0]!.replace(/\r\n/g, '\n') + '\n';
  if (Buffer.byteLength(normalized) > 4096) issues.push('证书 PEM 超过 4096 字节，采集器不接受');
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(normalized);
  } catch {
    issues.push('证书文件无法解析');
    return null;
  }
  const selfSigned = cert.subject === cert.issuer && cert.verify(cert.publicKey);
  if (!selfSigned)
    issues.push('证书不是自签证书；采集器把服务端证书作为唯一信任锚，CA 签发的叶子证书会握手失败');
  const now = Date.now();
  if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo))
    issues.push('证书不在有效期内');
  let hostMatches: boolean | null = null;
  if (host) {
    const bare = host.replace(/^\[|\]$/g, '');
    hostMatches = Boolean(isIP(bare) ? cert.checkIP(bare) : cert.checkHost(bare));
    if (!hostMatches) issues.push('证书 SAN 未覆盖 FLEET_PUBLIC_BASE_URL 中的主机名或 IP');
  }
  if (cert.ca) warnings.push('证书带 CA:TRUE 基本约束；建议签发不带 CA 约束的自签叶子证书');
  return {
    pem: normalized,
    sha256: createHash('sha256').update(cert.raw).digest('hex'),
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(),
    selfSigned,
    hostMatches,
  };
}

export function deploymentInfo(): DeploymentInfo {
  const issues: string[] = [];
  const warnings: string[] = [];
  const url = parseServer(process.env.FLEET_PUBLIC_BASE_URL?.trim(), issues);
  const server = url ? url.origin : null;
  const certificate = loadCertificate(
    process.env.FLEET_TLS_CERT_PEM_PATH?.trim(),
    url?.hostname ?? null,
    issues,
    warnings,
  );
  const ready = issues.length === 0 && Boolean(server && certificate);
  const serverText = server ?? '<服务地址>';
  return {
    ready,
    issues,
    warnings,
    server,
    certificate,
    tlsDeployment:
      ready && server && certificate
        ? {
            server,
            tls_server_cert_pem: certificate.pem,
            tls_server_cert_sha256: certificate.sha256,
          }
        : null,
    collectorConfigPatch: {
      managed_config: false,
      system_audit: false,
      eval_jobs_enabled: true,
      eval_user: '<登录用户>',
    },
    installCommands: [
      {
        title: '登记终端（按提示粘贴接入码后回车；接入码不会出现在命令行历史里）',
        command: `sudo python3 <kit 目录>/tools/platform-collector.py --state <状态目录> enroll --kit <kit 目录> --server ${serverText} --tls-config <tls-deployment.json 路径> --token-stdin`,
      },
      {
        title: '把推荐的 collector.json 片段合并进采集器配置后，执行一次采集验证',
        command:
          'sudo python3 <kit 目录>/tools/platform-collector.py --state <状态目录> run --once',
      },
      {
        title: '查看采集与传输状态（不显示凭据）',
        command: 'sudo python3 <kit 目录>/tools/platform-collector.py --state <状态目录> status',
      },
      {
        title: '证书轮换（同主机、同端口）',
        command: `sudo python3 <kit 目录>/tools/platform-collector.py --state <状态目录> set-https --kit <kit 目录> --server ${serverText} --tls-config <新 tls-deployment.json 路径>`,
      },
    ],
  };
}
