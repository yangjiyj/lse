import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File as FileIcon, Folder, RefreshCw } from 'lucide-react';
import { ApiError, modelFilesApi, type ModelFileRootDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { formatBytes, formatModified, hfRepoFromPath, joinPath } from './format';

/** 下拉里的根目录显示：服务器路径为主（运维和客户认的是它），容器内路径放括号里。 */
function rootLabel(r: ModelFileRootDetail): string {
  return r.hostPath ? `${r.hostPath}（容器内 ${r.path}）` : r.path;
}

/** 当前目录的两种写法：服务器路径为主，容器内路径为辅。 */
function PathLine({ hostPath, path }: { hostPath: string | null; path: string }) {
  return (
    <div className="min-w-0 text-sm" data-testid="current-path">
      {hostPath ? (
        <>
          <span className="text-muted-foreground">服务器路径：</span>
          <span className="break-all font-mono">{hostPath}</span>
          <span className="ml-3 text-xs text-muted-foreground">容器内路径 {path}</span>
        </>
      ) : (
        <>
          <span className="text-muted-foreground">目录：</span>
          <span className="break-all font-mono">{path}</span>
        </>
      )}
    </div>
  );
}

export interface DirectoryBrowserProps {
  roots: ModelFileRootDetail[];
  /** 点击「扫描当前目录」。 */
  onScan: (path: string) => void;
  scanning: boolean;
  /** 按钮文字，默认「扫描当前目录」；组合任务里选目录时用「选择此目录」。 */
  actionLabel?: string;
  /** 路径导航直接放进操作条（省掉单独一行路径，避免同一路径显示两遍）；组合任务里选目录时用。 */
  crumbsInBar?: boolean;
  /** 「管理目录」入口：有权限的用户传入，没有则不显示。 */
  manage?: ReactNode;
}

/** 目录浏览：根目录选择 + 面包屑 + 表格列表；扫描按钮固定在列表上方右侧。 */
export function DirectoryBrowser({
  roots,
  onScan,
  scanning,
  manage,
  actionLabel = '扫描当前目录',
  crumbsInBar = false,
}: DirectoryBrowserProps) {
  const [rootPath, setRootPath] = useState(roots[0]?.path ?? '');
  const [segments, setSegments] = useState<string[]>([]);
  // 管理目录后根目录可能被删：当前选中的根不在了就回到第一个
  useEffect(() => {
    if (!roots.some((r) => r.path === rootPath)) {
      setRootPath(roots[0]?.path ?? '');
      setSegments([]);
    }
  }, [roots, rootPath]);

  const root = roots.find((r) => r.path === rootPath);
  const currentPath = rootPath ? joinPath(rootPath, segments) : '';
  const browse = useQuery({
    queryKey: ['model-files', 'browse', currentPath],
    queryFn: () => modelFilesApi.browse(currentPath),
    enabled: Boolean(currentPath),
  });
  const data = browse.data;
  // 服务器路径由根目录的服务器路径加上已点进的子目录得出，不必等接口返回
  const hostPath = root?.hostPath ? joinPath(root.hostPath, segments) : null;

  const crumbs = useMemo(
    () => [
      { label: root ? (root.hostPath ?? root.path) : rootPath, to: [] as string[] },
      ...segments.map((s, i) => ({ label: s, to: segments.slice(0, i + 1) })),
    ],
    [root, rootPath, segments],
  );

  const total = (data?.directoryTotal ?? 0) + (data?.modelFileTotal ?? 0);
  const empty = Boolean(data) && total === 0;

  // 只有一个根目录时没有可选的，下拉省掉；「管理目录」改放在面包屑那一行右侧
  const multiRoot = roots.length > 1;

  const crumbNav = (
    <nav aria-label="目录路径" className="flex flex-wrap items-center gap-1 text-sm">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={`${i}-${c.label}`} className="flex items-center gap-1">
            {i > 0 && (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            )}
            {last ? (
              <span aria-current="page" className="font-medium text-foreground">
                {c.label}
              </span>
            ) : (
              <button
                type="button"
                className="text-brand-600 hover:underline"
                aria-label={`回到 ${i === 0 ? (root?.path ?? c.label) : c.label}`}
                onClick={() => setSegments(c.to)}
              >
                {c.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );

  return (
    <div className="space-y-3">
      {multiRoot && (
        <div className="flex flex-wrap items-center gap-3">
          <Select
            aria-label="扫描根目录"
            className="max-w-xl"
            value={rootPath}
            onChange={(e) => {
              setRootPath(e.target.value);
              setSegments([]);
            }}
          >
            {roots.map((r) => (
              <option key={r.path} value={r.path}>
                {rootLabel(r)}
              </option>
            ))}
          </Select>
          {manage}
        </div>
      )}

      {!crumbsInBar && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {crumbNav}
          {!multiRoot && manage}
        </div>
      )}
      <div
        data-testid="scan-bar"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-[#F8FAFD] px-3 py-2"
      >
        {crumbsInBar ? crumbNav : <PathLine hostPath={hostPath} path={currentPath} />}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="刷新"
            onClick={() => void browse.refetch()}
            disabled={browse.isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${browse.isFetching ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button size="sm" disabled={scanning || !currentPath} onClick={() => onScan(currentPath)}>
            {scanning && <Spinner className="h-4 w-4" />}
            {actionLabel}
          </Button>
        </div>
      </div>

      {browse.isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          正在读取目录…
        </div>
      ) : browse.error ? (
        <p className="text-sm text-severity-critical" role="alert">
          {browse.error instanceof ApiError ? browse.error.message : '目录读取失败，请刷新后重试'}
        </p>
      ) : empty ? (
        <div
          data-testid="empty-dir"
          className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
        >
          {hostPath ? (
            <p>
              这个目录下还没有模型文件。把模型文件放到服务器上的{' '}
              <span className="font-mono text-foreground">{hostPath}</span>{' '}
              目录（或其子目录）下，点右上方「刷新」即可看到。
            </p>
          ) : (
            <p>
              这个目录下还没有模型文件。把模型文件放到该目录（或其子目录）下，点右上方「刷新」即可看到。
            </p>
          )}
          {data && data.otherFileCount > 0 && (
            <p className="mt-1 text-xs">
              另有 {data.otherFileCount} 个文件不是受支持的模型格式，已忽略。
            </p>
          )}
        </div>
      ) : (
        <>
          <div
            data-testid="dir-list"
            className="max-h-[560px] overflow-y-auto rounded-lg border border-border"
          >
            <table className="w-full text-sm" aria-label="当前目录内容">
              <thead className="sticky top-0 bg-[#F7F9FD] text-left text-[13px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">名称</th>
                  <th className="px-3 py-2 font-semibold">类型</th>
                  <th className="px-3 py-2 text-right font-semibold">大小</th>
                  <th className="px-3 py-2 font-semibold">修改时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEF2F8]">
                {(data?.directories ?? []).map((d) => (
                  <tr key={`d-${d}`} className="hover:bg-brand-50/50">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        aria-label={`进入目录 ${d}`}
                        className="flex items-center gap-2 text-brand-600 hover:underline"
                        onClick={() => setSegments([...segments, d])}
                      >
                        <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="break-all">{d}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2">目录</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-2 text-muted-foreground">—</td>
                  </tr>
                ))}
                {(data?.modelFiles ?? []).map((f) => (
                  <tr key={`f-${f.name}`}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <FileIcon
                          className="h-4 w-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="break-all font-mono text-xs">{f.name}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">模型文件</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatBytes(f.bytes)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {formatModified(f.modifiedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.truncated && (
            <p data-testid="truncated-hint" className="text-xs text-severity-high">
              {truncatedText(data)}
            </p>
          )}
          {data && data.otherFileCount > 0 && (
            <p className="text-xs text-muted-foreground">
              本级另有 {data.otherFileCount} 个文件不是受支持的模型格式，已忽略。
            </p>
          )}
        </>
      )}
      {hfRepoFromPath(currentPath) && (
        <p className="text-xs text-muted-foreground">
          识别为 HuggingFace 缓存，模型清单（AIBOM）的来源将自动填为 {hfRepoFromPath(currentPath)}
        </p>
      )}
    </div>
  );
}

function truncatedText(d: {
  limit: number;
  directoryTotal: number;
  modelFileTotal: number;
  scanLimited: boolean;
}): string {
  const parts: string[] = [];
  if (d.directoryTotal > d.limit) parts.push(`${d.directoryTotal} 个子目录`);
  if (d.modelFileTotal > d.limit) parts.push(`${d.modelFileTotal} 个模型文件`);
  const shown = parts.length ? `仅显示前 ${d.limit} 项，共 ${parts.join('、')}。` : '';
  const limited = d.scanLimited
    ? '该目录下的内容过多，只统计了前一部分，列表可能不完整；扫描当前目录不受此限制。'
    : '';
  return [shown, limited].filter(Boolean).join('');
}
