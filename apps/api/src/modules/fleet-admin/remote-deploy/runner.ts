import { prisma } from '../../../db.js';
import { writeAudit } from '../../../lib/audit.js';
import { shQuote } from '../install-script.js';

// 远程部署执行（2.4.8）：经 SSH 上传一键安装脚本并用一次性接入码安装终端探针，记各阶段时间。
// 凭据（口令、私钥、sudo 口令、接入码明文）只在本函数的内存里，不写库、不进日志和审计。

export interface RemoteSession {
  exec(
    command: string,
    stdin: string | null,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
}

export type RemoteAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKey: string; passphrase?: string };

export interface RemoteShell {
  scanHostKey(
    host: string,
    port: number,
  ): Promise<{ type: string; fingerprint: string; line: string }>;
  open(
    target: { host: string; port: number; username: string; knownHostsLine: string },
    auth: RemoteAuth,
  ): Promise<RemoteSession>;
}

export interface RemoteDeploySecrets {
  auth: RemoteAuth;
  sudoPassword?: string;
  /** 一次性接入码明文 */
  code: string;
  /** buildOneclick 生成的安装脚本 */
  script: string;
  /**
   * 解析并校验过范围的 IP 字面量（resolveDeployTarget）：扫指纹、连接都用它，不再按主机名解析，
   * 挡住 DNS 重绑定。不给时用记录里的主机。
   */
  address?: string;
}

export interface RunSshDeployDeps {
  shell: RemoteShell;
  /** 安装完成后等终端登记的最长时间，默认 10 秒 */
  waitEndpointMs?: number;
  /** 整体上限，默认 120 秒 */
  deadlineMs?: number;
}

export const LOG_MAX_BYTES = 64 * 1024;
const UPGRADED_MARK = '升级完成（本机原已接入';

type ErrorCode =
  | 'CONNECT_TIMEOUT'
  | 'CONNECT_REFUSED'
  | 'DNS_FAILED'
  | 'CONNECT_FAILED'
  | 'AUTH_FAILED'
  | 'HOST_KEY_MISMATCH'
  | 'SUDO_FAILED'
  | 'INSTALL_FAILED'
  | 'DEPLOY_TIMEOUT';

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  CONNECT_TIMEOUT: '连接目标主机超时，请确认主机可达、SSH 端口开放',
  CONNECT_REFUSED: '目标主机拒绝连接，请确认 SSH 服务已启动、端口正确',
  DNS_FAILED: '域名解析失败，请确认主机名',
  CONNECT_FAILED: '连接目标主机失败，详情见部署日志',
  AUTH_FAILED: 'SSH 登录失败，请检查用户名、口令或私钥',
  HOST_KEY_MISMATCH: '主机指纹与确认的不一致，已中止部署（可能是中间人攻击或主机已重装）',
  SUDO_FAILED: 'sudo 提权失败，请检查 sudo 口令或该用户的 sudo 权限',
  INSTALL_FAILED: '安装脚本执行失败，详情见部署日志',
  DEPLOY_TIMEOUT: '部署超过 120 秒未完成，已中止',
};

class DeployError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail?: string,
  ) {
    super(detail ? `${ERROR_MESSAGES[code]}：${detail}` : ERROR_MESSAGES[code]);
  }
}

/** 日志里的接入码换成 jdc_****，截到 64 KiB。 */
export function maskDeployLog(text: string, code: string): string {
  let out = text
    .split(code)
    .join('jdc_****')
    .replace(/jdc_[A-Za-z0-9_-]{8,}/g, 'jdc_****');
  if (Buffer.byteLength(out, 'utf8') > LOG_MAX_BYTES) {
    out = Buffer.from(out, 'utf8').subarray(0, LOG_MAX_BYTES).toString('utf8') + '\n…（已截断）';
  }
  return out;
}

/** ssh 退出码 255 是 ssh 自己失败：按输出分指纹不符、登录失败、拒绝连接、域名解析失败、连接超时。 */
export function sshFailure(stderr: string): ErrorCode {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return 'HOST_KEY_MISMATCH';
  }
  if (/Permission denied|Authentication failed|Too many authentication failures/i.test(stderr)) {
    return 'AUTH_FAILED';
  }
  if (/Connection refused/i.test(stderr)) return 'CONNECT_REFUSED';
  if (
    /Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution/i.test(
      stderr,
    )
  ) {
    return 'DNS_FAILED';
  }
  if (/timed out|Connection timeout/i.test(stderr)) return 'CONNECT_TIMEOUT';
  return 'CONNECT_FAILED';
}

/**
 * 接入码写进安装脚本开头的变量（脚本按 JD_CODE 取接入码），随脚本一起上传到 0600 的临时文件，
 * 不出现在本机和远端的任何命令行参数里。
 */
export function scriptWithCode(script: string, code: string): string {
  const line = `JD_CODE=${shQuote(code)}`;
  if (script.startsWith('#!')) {
    const nl = script.indexOf('\n');
    return nl < 0
      ? `${script}\n${line}\n`
      : `${script.slice(0, nl + 1)}${line}\n${script.slice(nl + 1)}`;
  }
  return `${line}\n${script}`;
}

/** 远端命令一律交给 sh 执行，不依赖登录账号的 shell（csh、fish 等）。 */
const viaSh = (command: string) => `sh -c ${shQuote(command)}`;
const REMOTE_DIR_RE = /^\/tmp\/jiandun-rd\.[A-Za-z0-9]+$/;
/** 远端 timeout 退出码：安装超时。 */
const REMOTE_TIMEOUT_CODE = 124;

const SUDO_FAILED_RE =
  /sudo: (?:\d+ )?incorrect password|sudo: a password is required|is not in the sudoers file|sudo: no tty present|Sorry, try again/i;

/**
 * 执行一次 SSH 部署：重新比对主机指纹 → 建会话 → 上传脚本 → 安装 → 等终端登记。
 * 失败按阶段给 errorCode；无论成败都吊销接入码、关闭会话、写结束审计。
 */
export async function runSshDeploy(
  deployId: string,
  secrets: RemoteDeploySecrets,
  deps: RunSshDeployDeps,
): Promise<void> {
  const deploy = await prisma.fleetRemoteDeploy.findUnique({ where: { id: deployId } });
  if (!deploy) return;
  const startedAt = new Date();
  const deadline = startedAt.getTime() + (deps.deadlineMs ?? 120_000);
  const remaining = () => Math.max(1_000, deadline - Date.now());
  const log: string[] = [];
  const update = (data: Parameters<typeof prisma.fleetRemoteDeploy.update>[0]['data']) =>
    prisma.fleetRemoteDeploy.update({ where: { id: deployId }, data });
  let session: RemoteSession | null = null;
  let status: 'SUCCEEDED' | 'FAILED' = 'FAILED';
  let durationMs: number | null = null;
  const address = secrets.address ?? deploy.host;
  try {
    await update({ status: 'CONNECTING', startedAt });
    const scanned = await deps.shell.scanHostKey(address, deploy.port).catch((err: Error) => {
      throw new DeployError(sshFailure(err.message), err.message);
    });
    if (scanned.fingerprint !== deploy.hostKeyFingerprint) {
      log.push(`扫描到的指纹 ${scanned.fingerprint} 与确认的 ${deploy.hostKeyFingerprint} 不一致`);
      throw new DeployError('HOST_KEY_MISMATCH');
    }
    session = await deps.shell
      .open(
        {
          host: address,
          port: deploy.port,
          username: deploy.username,
          knownHostsLine: scanned.line,
        },
        secrets.auth,
      )
      .catch((err: Error & { sshCode?: ErrorCode }) => {
        throw new DeployError(err.sshCode ?? 'AUTH_FAILED', err.message);
      });

    // 上传：远端 mktemp 建 0700 目录，安装脚本（开头带接入码）写成 0600 文件，回显目录名。
    const upload = await session.exec(
      viaSh(
        'umask 077; d=$(mktemp -d /tmp/jiandun-rd.XXXXXX) && cat > "$d/install.sh" && printf \'%s\\n\' "$d"',
      ),
      scriptWithCode(secrets.script, secrets.code),
      remaining(),
    );
    log.push(upload.stdout, upload.stderr);
    if (upload.code === 255) throw new DeployError(sshFailure(upload.stderr));
    const dir = upload.stdout.trim().split('\n').pop() ?? '';
    if (upload.code !== 0 || !REMOTE_DIR_RE.test(dir)) {
      throw new DeployError('INSTALL_FAILED', '上传安装脚本失败');
    }
    const uploadedAt = new Date();
    await update({ connectedAt: uploadedAt, uploadedAt, status: 'INSTALLING' });

    // 安装：远端用 timeout 包住（比本机剩余时间少 5 秒），本机超时断开后远端不会接着跑；装完删临时目录。
    const root = deploy.username === 'root';
    const limitSec = Math.max(10, Math.floor(remaining() / 1000) - 5);
    const command = [
      `d=${shQuote(dir)}`,
      `T=; command -v timeout >/dev/null 2>&1 && T="timeout -k 5 ${limitSec}"`,
      `${root ? '' : "sudo -S -p '' "}$T bash "$d/install.sh"${deploy.enableEval ? ' --enable-eval' : ''}`,
      'rc=$?',
      'rm -rf "$d"',
      'exit $rc',
    ].join('; ');
    const sudoInput =
      secrets.sudoPassword ?? (secrets.auth.type === 'password' ? secrets.auth.password : '');
    const result = await session.exec(viaSh(command), root ? null : `${sudoInput}\n`, remaining());
    log.push(result.stdout, result.stderr);
    if (Date.now() >= deadline || result.code === REMOTE_TIMEOUT_CODE) {
      throw new DeployError('DEPLOY_TIMEOUT');
    }
    if (result.code === 255) throw new DeployError(sshFailure(result.stderr));
    if (result.code !== 0) {
      if (!root && SUDO_FAILED_RE.test(`${result.stdout}\n${result.stderr}`)) {
        throw new DeployError('SUDO_FAILED');
      }
      throw new DeployError('INSTALL_FAILED', `退出码 ${result.code}`);
    }
    const installedAt = new Date();
    durationMs = installedAt.getTime() - startedAt.getTime();

    // 等终端用这个接入码登记（最多 waitEndpointMs）；本机原已接入时脚本只做升级，没有新终端。
    let endpoint: { id: string; registeredAt: Date } | null = null;
    const waitUntil = Date.now() + (deps.waitEndpointMs ?? 10_000);
    while (deploy.enrollmentCodeId) {
      endpoint = await prisma.fleetEndpoint.findFirst({
        where: { enrollmentCodeId: deploy.enrollmentCodeId },
        select: { id: true, registeredAt: true },
      });
      if (endpoint || Date.now() >= waitUntil) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!endpoint && `${result.stdout}`.includes(UPGRADED_MARK)) {
      log.push('目标主机原已接入，本次只升级了探针，没有登记新终端。');
    }
    await update({
      status: 'SUCCEEDED',
      installedAt,
      durationMs,
      ...(endpoint ? { endpointId: endpoint.id, registeredAt: endpoint.registeredAt } : {}),
      errorCode: null,
      errorMessage: null,
    });
    status = 'SUCCEEDED';
  } catch (err) {
    const deployErr =
      err instanceof DeployError ? err : new DeployError('INSTALL_FAILED', (err as Error).message);
    // 超时但终端已经用这个接入码登记了：探针多半已装好，记为完成并提示去终端详情确认，不显示失败。
    const registered =
      deployErr.code === 'DEPLOY_TIMEOUT' && deploy.enrollmentCodeId
        ? await prisma.fleetEndpoint
            .findFirst({
              where: { enrollmentCodeId: deploy.enrollmentCodeId },
              select: { id: true, registeredAt: true },
            })
            .catch(() => null)
        : null;
    if (registered) {
      await update({
        status: 'SUCCEEDED',
        endpointId: registered.id,
        registeredAt: registered.registeredAt,
        durationMs: registered.registeredAt.getTime() - startedAt.getTime(),
        errorCode: 'TIMEOUT_REGISTERED',
        errorMessage: '部署超过 120 秒，安装脚本已中止，但终端已登记；请到终端详情确认探针状态',
      }).catch(() => undefined);
    } else {
      await update({
        status: 'FAILED',
        errorCode: deployErr.code,
        errorMessage: maskDeployLog(deployErr.message, secrets.code).slice(0, 1000),
      }).catch(() => undefined);
    }
  } finally {
    if (deploy.enrollmentCodeId) {
      await prisma.fleetEnrollmentCode
        .updateMany({
          where: { id: deploy.enrollmentCodeId, status: { not: 'REVOKED' } },
          data: { status: 'REVOKED', revokedAt: new Date() },
        })
        .catch(() => undefined);
    }
    await session?.close().catch(() => undefined);
    await update({ log: maskDeployLog(log.filter(Boolean).join('\n'), secrets.code) }).catch(
      () => undefined,
    );
    const final = await prisma.fleetRemoteDeploy
      .findUnique({ where: { id: deployId } })
      .catch(() => null);
    await writeAudit({
      actorId: deploy.createdById,
      actorName: null,
      action: 'fleet.remote_deploy.finish',
      targetType: 'fleet_remote_deploy',
      targetId: deployId,
      detail: {
        host: deploy.host,
        port: deploy.port,
        username: deploy.username,
        authType: deploy.authType,
        hostKeyFingerprint: deploy.hostKeyFingerprint,
        status: final?.status ?? status,
        errorCode: final?.errorCode ?? null,
        durationMs: final?.durationMs ?? durationMs,
      },
    });
  }
}
