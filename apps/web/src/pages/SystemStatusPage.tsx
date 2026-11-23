import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type SystemStatus } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';

export const STATUS_REFRESH_MS = 30_000;

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function percent(used: number, total: number): string {
  return total > 0 ? `${((used / total) * 100).toFixed(1)}%` : '—';
}

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function Metric({ title, value, sub }: { title: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-5">
        <div className="text-sm text-ink-3">{title}</div>
        <div className="text-2xl font-semibold tabular-nums text-ink">{value}</div>
        {sub ? <div className="text-xs tabular-nums text-ink-3">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}

function Dependencies({ deps }: { deps: SystemStatus['dependencies'] }) {
  const rows: Array<[string, 'ok' | 'error']> = [
    ['数据库', deps.database],
    ['Redis', deps.redis],
  ];
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-2 text-sm text-ink-3">依赖服务</div>
        <ul className="space-y-2">
          {rows.map(([name, state]) => (
            <li key={name} className="flex items-center justify-between text-sm">
              <span className="text-ink">{name}</span>
              <Badge tone={state === 'ok' ? 'success' : 'danger'}>
                {state === 'ok' ? '正常' : '异常'}
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function SystemStatusPage() {
  const query = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.system.status(),
    refetchInterval: STATUS_REFRESH_MS,
  });
  const data = query.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="运行状态"
        actions={
          data ? (
            <span className="text-xs text-ink-3">更新于 {formatDateTime(data.checkedAt)}</span>
          ) : null
        }
      />
      {query.isLoading ? (
        <LoadingBlock />
      ) : query.isError || !data ? (
        <p role="alert" className="py-10 text-center text-sm text-muted-foreground">
          {query.error instanceof Error ? query.error.message : '加载失败'}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              title="CPU"
              value={`${data.cpu.usagePercent.toFixed(1)}%`}
              sub={`${data.cpu.cores} 核 · 负载 ${data.cpu.load1.toFixed(2)} / ${data.cpu.load5.toFixed(2)}`}
            />
            <Metric
              title="内存"
              value={percent(data.memory.used, data.memory.total)}
              sub={`${gb(data.memory.used)} / ${gb(data.memory.total)}`}
            />
            <Metric title="平台已运行" value={uptime(data.uptimeSeconds)} />
            <Dependencies deps={data.dependencies} />
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>磁盘</TH>
                    <TH>已用 / 总量</TH>
                    <TH>使用率</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.disks.map((disk) => (
                    <TR key={disk.mount}>
                      <TD data-label="磁盘" className="break-all font-mono text-xs">
                        {disk.mount}
                      </TD>
                      <TD data-label="已用 / 总量" className="tabular-nums">
                        {`${gb(disk.used)} / ${gb(disk.total)}`}
                      </TD>
                      <TD data-label="使用率" className="tabular-nums">
                        {percent(disk.used, disk.total)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
