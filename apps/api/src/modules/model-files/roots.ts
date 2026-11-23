import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';

/** 部署时容器内的挂载点：服务器上的模型目录只读挂载到这里（见 docker-compose.yml）。 */
export const CONTAINER_MODELS_DIR = '/models';

export type RootSource = 'deploy' | 'admin';
export interface RootDetail {
  /** 容器内路径，也就是平台实际访问的路径。 */
  path: string;
  /** 对应的服务器路径；只有位于 /models 下且部署时给出了主机目录才能推出来。 */
  hostPath: string | null;
  /** deploy=部署时配置，只读；admin=管理员在页面添加，可增删。 */
  source: RootSource;
  exists: boolean;
  readable: boolean;
  /** 不可用时的中文原因，可用时为 null。 */
  problem: string | null;
}
export interface RejectedRoot {
  path: string;
  reason: string;
}

/** 部署时给出的主机目录：必须是绝对路径；末尾斜杠去掉，否则当作未知。 */
export function normalizeHostDir(raw: string | undefined | null): string | null {
  const v = raw?.trim();
  if (!v || !v.startsWith('/') || v.includes('\u0000')) return null;
  const n = posix.normalize(v);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

/** 容器内路径换算成服务器路径。只有 /models 本身及其子目录能推出来。 */
export function toHostPath(containerPath: string, hostDir: string | null): string | null {
  if (!hostDir) return null;
  const p = containerPath.length > 1 ? containerPath.replace(/\/+$/, '') : containerPath;
  if (p === CONTAINER_MODELS_DIR) return hostDir;
  if (p.startsWith(`${CONTAINER_MODELS_DIR}/`))
    return posix.join(hostDir, p.slice(CONTAINER_MODELS_DIR.length));
  return null;
}

/**
 * 管理员输入的目录写法检查与规整，不访问磁盘。
 * 通过返回规整后的路径，否则返回中文原因。
 */
export function normalizeRootInput(raw: string): { path: string } | { problem: string } {
  const v = raw.trim();
  if (!v) return { problem: '目录不能为空' };
  if (/[\u0000-\u001f]/.test(v)) return { problem: '目录含有不允许的字符' };
  if (!v.startsWith('/')) return { problem: '必须填写以 / 开头的绝对路径' };
  if (v.split('/').includes('..')) return { problem: '路径中不能包含 ..（上一级目录）' };
  const n = posix.normalize(v);
  return { path: n.length > 1 ? n.replace(/\/+$/, '') : n };
}

/**
 * 读取库里已有的目录：比保存时宽松，只做规整，不拒绝 ..（旧版本允许，realpath 会解析）。
 * 不是绝对路径的返回 null。
 */
export function lenientRoot(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v.startsWith('/') || /[\u0000-\u001f]/.test(v)) return null;
  const n = posix.normalize(v);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

/** 整棵树都不允许加入的系统目录：这些位置不会放模型，加入只会扩大平台能读到的范围。 */
const SYSTEM_TREES = [
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/run',
  '/boot',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
];
/**
 * 只禁止它本身，不禁止其子目录（模型常放在这些目录的子目录里）。
 * 范围过大的目录加进来，等于让平台能读整块区域；/data、/srv、/mnt、/opt 这类常用来
 * 挂载数据盘的目录不在此列，由管理员自行判断。
 */
const SYSTEM_EXACT = ['/root', '/usr', '/var', '/tmp', '/home'];

/** 路径本身是否属于不允许加入的系统目录。允许返回 null，否则返回中文原因（不含路径本身）。 */
export function rootPolicyProblem(path: string): string | null {
  if (path === '/') return '不能加入根目录：这会让平台读到整台服务器的文件';
  if (SYSTEM_TREES.some((t) => path === t || path.startsWith(`${t}/`)))
    return '属于系统目录，不允许加入';
  if (SYSTEM_EXACT.includes(path)) return '是系统目录，范围过大，请加入其下存放模型的具体子目录';
  return null;
}

/** 目录的实际状态：是否存在、是不是目录、平台进程能否读取。 */
export async function probeRoot(
  path: string,
): Promise<{ exists: boolean; readable: boolean; problem: string | null }> {
  const info = await stat(path).catch((e: NodeJS.ErrnoException) => e);
  if (info instanceof Error) {
    // 没有权限时无法判断是否存在，按“存在但读不了”处理，让界面提示权限问题而不是“不存在”
    if (info.code === 'EACCES' || info.code === 'EPERM')
      return { exists: true, readable: false, problem: '没有读取权限' };
    return {
      exists: false,
      readable: false,
      problem: info.code === 'ENOTDIR' ? '路径中有一段不是目录' : '目录不存在',
    };
  }
  if (!info.isDirectory()) return { exists: true, readable: false, problem: '不是目录（是文件）' };
  try {
    await access(path, constants.R_OK | constants.X_OK);
  } catch {
    return { exists: true, readable: false, problem: '没有读取权限' };
  }
  return { exists: true, readable: true, problem: null };
}

/** 保存前的完整校验：写法 → 系统目录 → 磁盘状态 → 真实位置（符号链接）。 */
export async function validateAdminRoot(
  raw: string,
  opts: { tolerateUnavailable?: boolean } = {},
): Promise<{ path: string; problem?: string }> {
  const norm = normalizeRootInput(raw);
  if ('problem' in norm) return { path: raw.trim(), problem: norm.problem };
  const policy = rootPolicyProblem(norm.path);
  if (policy) return { path: norm.path, problem: policy };
  const probe = await probeRoot(norm.path);
  if (probe.problem)
    return opts.tolerateUnavailable
      ? { path: norm.path }
      : { path: norm.path, problem: probe.problem };
  const real = await realpath(norm.path).catch(() => norm.path);
  if (real !== norm.path && rootPolicyProblem(real))
    return { path: norm.path, problem: `该路径实际指向系统目录 ${real}，不允许加入` };
  return { path: norm.path };
}

/**
 * 一次校验管理员提交的全部目录：返回通过的目录（已规整、去重）和被拒绝的目录及原因。
 * 已保存过的目录若暂时不可用（比如网络存储掉线），不阻塞管理员修改其他设置；新加的目录必须当场可用。
 */
export async function validateAdminRoots(
  raw: string[],
  ctx: { deployRoots: string[]; savedRoots: string[] },
): Promise<{ roots: string[]; rejected: RejectedRoot[] }> {
  const toSet = (list: string[]) =>
    new Set(list.map(lenientRoot).filter((x): x is string => x !== null));
  const deploy = toSet(ctx.deployRoots);
  const saved = toSet(ctx.savedRoots);
  const roots: string[] = [];
  const rejected: RejectedRoot[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const norm = normalizeRootInput(item);
    if ('problem' in norm) {
      rejected.push({ path: item.trim(), reason: norm.problem });
      continue;
    }
    if (deploy.has(norm.path)) {
      rejected.push({ path: norm.path, reason: '已在部署配置中，无需重复添加' });
      continue;
    }
    if (seen.has(norm.path)) continue;
    seen.add(norm.path);
    const v = await validateAdminRoot(norm.path, { tolerateUnavailable: saved.has(norm.path) });
    if (v.problem) rejected.push({ path: norm.path, reason: v.problem });
    else roots.push(norm.path);
  }
  return { roots, rejected };
}

/** 生效的管理员目录：丢掉写法不对、或历史上遗留的系统目录，并去重。 */
export function usableAdminRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    const n = lenientRoot(r);
    if (n === null || rootPolicyProblem(n)) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** 汇总每个白名单目录的来源、对应服务器路径与当前可用状态。部署目录在前；重复的只算部署的。 */
export async function describeRoots(input: {
  deployRoots: string[];
  adminRoots: string[];
  hostDir: string | null;
}): Promise<RootDetail[]> {
  const seen = new Set<string>();
  const items: Array<{ path: string; source: RootSource; invalid: boolean }> = [];
  for (const [list, source] of [
    [input.deployRoots, 'deploy'],
    [input.adminRoots, 'admin'],
  ] as const) {
    for (const raw of list) {
      const n = lenientRoot(raw);
      const key = n ?? `raw:${String(raw)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ path: n ?? String(raw), source, invalid: n === null });
    }
  }
  return Promise.all(
    items.map(async ({ path, source, invalid }): Promise<RootDetail> => {
      if (invalid)
        return {
          path,
          hostPath: null,
          source,
          exists: false,
          readable: false,
          problem: '路径格式不正确，该目录不再生效，请删除',
        };
      const probe = await probeRoot(path);
      const policy = source === 'admin' ? rootPolicyProblem(path) : null;
      if (policy)
        return {
          path,
          hostPath: toHostPath(path, input.hostDir),
          source,
          exists: probe.exists,
          readable: false,
          problem: `该目录不再生效：${policy}`,
        };
      return { path, hostPath: toHostPath(path, input.hostDir), source, ...probe };
    }),
  );
}
