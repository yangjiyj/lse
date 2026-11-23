const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const TiB = 1024 * GiB;

/** 字节数展示：B / KiB / MiB / GiB / TiB，整数不带小数。与后端提示文案的规则一致。 */
export function formatBytes(n: number): string {
  const units: Array<[number, string]> = [
    [TiB, 'TiB'],
    [GiB, 'GiB'],
    [MiB, 'MiB'],
    [KiB, 'KiB'],
  ];
  for (const [size, label] of units) {
    if (n >= size) return `${(n / size).toFixed(n % size ? 1 : 0)} ${label}`;
  }
  return `${n} B`;
}

/** 管理目录弹窗里的单位换算：界面用 GiB / MiB / 个，提交给后端时换成字节。 */
export const UNIT = { KiB, MiB, GiB, TiB } as const;

/** 把字节数换成界面输入框里的数值（保留两位小数，去掉多余的 0）。 */
export function bytesToUnit(bytes: number, unit: number): string {
  return String(Number((bytes / unit).toFixed(2)));
}

/**
 * 扫描要把每个模型文件完整读一遍来算指纹，耗时主要看磁盘：机械盘和千兆网络存储约每秒
 * 100 MiB；固态盘受 SHA-256 计算速度限制，实测稀疏文件约 724 MiB/s（页缓存命中，是上限），
 * 这里取更保守的 500 MiB/s。给管理员的量级参考，不是承诺。
 */
const READ_RATE_SLOW = 100 * MiB;
const READ_RATE_FAST = 500 * MiB;

function formatSpan(seconds: number): { n: number; unit: '分钟' | '小时' } {
  const minutes = Math.round(seconds / 60);
  if (seconds >= 3600 || minutes >= 60) {
    return { n: Number((seconds / 3600).toFixed(1)), unit: '小时' };
  }
  return { n: Math.max(1, minutes), unit: '分钟' };
}

/** 完整读取 bytes 字节的预计耗时区间，如「35 分钟到 2.9 小时」；无法估算时返回 null。 */
export function estimateReadDuration(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const slowSeconds = bytes / READ_RATE_SLOW;
  if (slowSeconds < 60) return '不到 1 分钟';
  const fast = formatSpan(bytes / READ_RATE_FAST);
  const slow = formatSpan(slowSeconds);
  if (fast.unit === slow.unit) {
    return fast.n === slow.n ? `${fast.n} ${fast.unit}` : `${fast.n} 到 ${slow.n} ${fast.unit}`;
  }
  return `${fast.n} ${fast.unit}到 ${slow.n} ${slow.unit}`;
}

/** 修改时间：精确到分钟的本地时间；无法解析时显示 —。 */
export function formatModified(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 在根目录后拼接子目录，得到完整路径。 */
export function joinPath(root: string, segments: string[]): string {
  return [root.replace(/\/+$/, ''), ...segments].join('/').replace(/\/+/g, '/') || '/';
}

/** 从 HuggingFace 缓存路径（…/models--org--name/…）推导模型仓库地址，用作 AIBOM 来源默认值。 */
export function hfRepoFromPath(path: string): string | null {
  const m = /(?:^|\/)models--([^/]+?)--([^/]+)/.exec(path);
  return m ? `https://huggingface.co/${m[1]}/${m[2]}` : null;
}

/** 上传超过上限时的提示：给出上限，并指明改用目录扫描时该把模型放哪（与后端提示一致）。 */
export function uploadHint(maxBytes: number, hostDir: string | null): string {
  const where = hostDir ? `服务器目录 ${hostDir} ` : '服务器上的模型目录';
  return `上传上限 ${formatBytes(maxBytes)}，更大的模型请放到${where}后用目录扫描`;
}
