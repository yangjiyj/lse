import { formatBytes } from './units.js';

/** 提示里指代“服务器上存放模型的目录”：知道主机路径就写具体路径，否则用泛称。 */
const where = (hostDir: string | null) =>
  hostDir ? `服务器目录 ${hostDir} ` : '服务器上的模型目录';

/** 没有任何可扫描目录时的提示：说明怎么做，不出现环境变量名。 */
export function rootsEmptyMessage(hostDir: string | null): string {
  return hostDir
    ? `暂无可扫描的目录。请把模型文件放到服务器上的 ${hostDir} 目录（或其子目录）下，刷新页面即可看到；也可由管理员在「管理目录」中添加其他已挂载的目录。`
    : '暂无可扫描的目录。请把模型文件放到服务器上的模型目录（或其子目录）下，刷新页面即可看到；也可由管理员在「管理目录」中添加其他已挂载的目录。';
}

/** 上传超过上限时的提示：给出上限，并指明改用目录扫描时该把模型放哪里。 */
export function uploadTooLargeMessage(maxBytes: number, hostDir: string | null): string {
  return `上传上限 ${formatBytes(maxBytes)}，更大的模型请放到${where(hostDir)}后用目录扫描`;
}
