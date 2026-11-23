import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RemoteAuth, RemoteSession, RemoteShell } from './runner.js';

// 远程部署（2.4.8）调用系统 OpenSSH 客户端：口令走 askpass、私钥走临时 ssh-agent，凭据都不落盘；
// 主机指纹严格比对，只信本次扫描并经用户确认的那一行 known_hosts。

export const SSH_COMMANDS = ['ssh', 'ssh-keyscan', 'ssh-agent', 'ssh-add'] as const;
const ASKPASS = fileURLToPath(new URL('./askpass.sh', import.meta.url));
/** 每次部署的临时目录名前缀（known_hosts、agent 套接字、连接复用套接字）。 */
export const SSH_DIR_PREFIX = 'lse-rd-';
const KEY_PREFERENCE = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
];

/** PATH 里有没有 ssh、ssh-keyscan、ssh-agent、ssh-add。 */
export function sshCapability(pathEnv = process.env.PATH ?? ''): {
  ssh: boolean;
  missing: string[];
} {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const missing = SSH_COMMANDS.filter(
    (cmd) =>
      !dirs.some((dir) => {
        try {
          accessSync(join(dir, cmd), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
  );
  return { ssh: missing.length === 0, missing };
}

/** ssh-keyscan 的一行「host type base64」→ 类型和 SHA256 指纹（与 ssh-keygen -lf 一致）。 */
export function fingerprintOfKeyLine(
  line: string,
): { type: string; fingerprint: string; line: string } | null {
  const text = line.trim();
  if (!text || text.startsWith('#')) return null;
  const [, type, key] = text.split(/\s+/);
  if (!type || !key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return null;
  const raw = Buffer.from(key, 'base64');
  if (raw.length === 0) return null;
  const digest = createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
  return { type, fingerprint: `SHA256:${digest}`, line: text };
}

/** 多种主机密钥时按 ed25519 > ecdsa > rsa 取一个。 */
export function pickHostKey(lines: string[]) {
  const keys = lines.map(fingerprintOfKeyLine).filter((k): k is NonNullable<typeof k> => !!k);
  const rank = (t: string) => {
    const i = KEY_PREFERENCE.indexOf(t);
    return i < 0 ? KEY_PREFERENCE.length : i;
  };
  return keys.sort((a, b) => rank(a.type) - rank(b.type))[0] ?? null;
}

/**
 * ssh 公共参数：严格校验主机指纹、只用本次的 known_hosts、复用连接、限时。
 * 和运行账号的 SSH 配置、默认私钥隔开：不读 ~/.ssh/config 和 /etc/ssh/ssh_config，不试默认私钥；
 * 口令方式不用公钥和 agent，私钥方式不退回口令和键盘交互。
 */
export function buildSshArgs(t: {
  dir: string;
  host: string;
  port: number;
  username: string;
  authType: RemoteAuth['type'];
}): string[] {
  const opt = (v: string) => ['-o', v];
  const byAuth =
    t.authType === 'password'
      ? [...opt('PubkeyAuthentication=no'), ...opt('IdentityAgent=none')]
      : [...opt('PasswordAuthentication=no'), ...opt('KbdInteractiveAuthentication=no')];
  return [
    '-F',
    '/dev/null',
    ...opt('IdentityFile=none'),
    ...byAuth,
    ...opt('StrictHostKeyChecking=yes'),
    ...opt(`UserKnownHostsFile=${join(t.dir, 'known_hosts')}`),
    ...opt('GlobalKnownHostsFile=/dev/null'),
    ...opt('ConnectTimeout=10'),
    ...opt('ServerAliveInterval=5'),
    ...opt('ServerAliveCountMax=2'),
    ...opt('ControlMaster=auto'),
    ...opt(`ControlPath=${join(t.dir, 'cm')}`),
    ...opt('ControlPersist=60'),
    ...opt('NumberOfPasswordPrompts=1'),
    ...opt('LogLevel=ERROR'),
    '-p',
    String(t.port),
    '-l',
    t.username,
    '--',
    t.host,
  ];
}

/** 给 ssh 子进程的环境：口令方式走 askpass（口令只在 LSE_SSH_SECRET 的值里）；私钥方式指向临时 agent。 */
export function sshEnv(auth: RemoteAuth, dir: string): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    LANG: 'C.UTF-8',
  };
  if (auth.type === 'password') {
    return {
      ...base,
      SSH_ASKPASS: ASKPASS,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: 'lse',
      LSE_SSH_SECRET: auth.password,
    };
  }
  return { ...base, SSH_AUTH_SOCK: join(dir, 'agent.sock') };
}

function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string | null; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? { PATH: process.env.PATH ?? '' },
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    const cap = (s: string, chunk: Buffer) =>
      s.length < 256 * 1024 ? s + chunk.toString('utf8') : s;
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      stderr += '\n[timeout]';
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 255, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.stdin ?? '');
  });
}

export const systemRemoteShell: RemoteShell = {
  async scanHostKey(host, port) {
    const out = await run('ssh-keyscan', ['-T', '5', '-p', String(port), '--', host], {
      timeoutMs: 15_000,
    });
    const picked = pickHostKey(out.stdout.split('\n'));
    if (!picked) throw new Error(`取不到主机公钥：${out.stderr.trim() || '无输出'}`);
    return picked;
  },

  async open(target, auth): Promise<RemoteSession> {
    const dir = await mkdtemp(join(tmpdir(), SSH_DIR_PREFIX));
    await writeFile(join(dir, 'known_hosts'), `${target.knownHostsLine}\n`, { mode: 0o600 });
    const env = sshEnv(auth, dir);
    let agent: ReturnType<typeof spawn> | null = null;
    if (auth.type === 'key') {
      // 私钥只经 ssh-add 的标准输入进临时 agent，不写文件；口令短语同样走 askpass。
      agent = spawn('ssh-agent', ['-D', '-a', join(dir, 'agent.sock')], {
        env: { PATH: process.env.PATH ?? '' },
        stdio: 'ignore',
      });
      // 起不来（如没装）时不让 error 事件变成未捕获异常；随后 ssh-add 连不上，按私钥无法加载处理。
      agent.on('error', (err) => console.warn('[remote-deploy] ssh-agent 启动失败:', err.message));
      for (let i = 0; i < 50; i += 1) {
        try {
          accessSync(join(dir, 'agent.sock'));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const addEnv: Record<string, string> = {
        ...env,
        ...(auth.passphrase
          ? {
              SSH_ASKPASS: ASKPASS,
              SSH_ASKPASS_REQUIRE: 'force',
              DISPLAY: 'lse',
              LSE_SSH_SECRET: auth.passphrase,
            }
          : {}),
      };
      // 私钥在 agent 里最多留 5 分钟（部署整体上限 120 秒）。
      const added = await run('ssh-add', ['-t', '300', '-'], {
        env: addEnv,
        stdin: auth.privateKey.endsWith('\n') ? auth.privateKey : `${auth.privateKey}\n`,
        timeoutMs: 15_000,
      });
      if (added.code !== 0) {
        agent.kill();
        await rm(dir, { recursive: true, force: true });
        throw Object.assign(new Error('私钥无法加载（格式不对或口令短语错误）'), {
          sshCode: 'AUTH_FAILED',
        });
      }
    }
    const args = buildSshArgs({ dir, ...target, authType: auth.type });
    return {
      exec: (command, stdin, timeoutMs) =>
        run('ssh', [...args, command], { env, stdin, timeoutMs }),
      async close() {
        await run('ssh', ['-O', 'exit', ...args], { env, timeoutMs: 5_000 }).catch(() => undefined);
        agent?.kill();
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
};

/**
 * 服务启动时清理上次进程留下的临时目录（进程被杀时 close 没来得及执行）。只删超过 maxAgeMs 的，
 * 不碰别的进程正在用的。目录里只有 known_hosts、agent 套接字和连接复用套接字，没有凭据文件。
 */
export async function cleanupStaleSshDirs(maxAgeMs = 10 * 60_000): Promise<number> {
  const root = tmpdir();
  const names = await readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(SSH_DIR_PREFIX)) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory() || Date.now() - info.mtimeMs < maxAgeMs) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}
