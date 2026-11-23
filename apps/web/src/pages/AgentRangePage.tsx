import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';

const usage = (count: number) => (count > 0 ? `${count} 条样本` : '未使用');

function Stat({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="min-w-0 p-4">
      <p className="text-xs text-ink-3">{title}</p>
      <div className="mt-2 space-y-1">{children}</div>
    </Card>
  );
}

export function AgentRangePage() {
  const [page, setPage] = useState(1);
  const range = useQuery({ queryKey: ['agent-range'], queryFn: api.agentSamples.range, retry: false });
  const endpoints = useQuery({
    queryKey: ['agent-range', 'endpoints', page],
    queryFn: () => api.fleet.endpoints({ page, pageSize: 20, status: 'ACTIVE' }),
    retry: false,
  });
  const items = endpoints.data?.items ?? [];
  const sandboxReady = items.filter((endpoint) => endpoint.agents.some((agent) => agent.runtimeV2)).length;
  const data = range.data;
  const reach = data?.receiverReachable;
  return (
    <main className="space-y-6">
      <PageHeader title="测评靶场" />

      <div className="grid gap-3 md:grid-cols-3">
        <Stat title="运行隔离">
          {endpoints.isError ? <p role="alert" className="text-sm">终端能力读取失败。</p> : endpoints.isLoading ? <p role="status" className="text-sm text-ink-3">正在读取…</p> : (
            <p><span className="text-2xl font-semibold">{sandboxReady} / {endpoints.data?.total ?? items.length}</span> <span className="text-sm text-ink-2">台终端支持蜜罐沙箱</span></p>
          )}
        </Stat>
        <Stat title="受控接收端">
          {range.isError ? <p role="alert" className="text-sm">靶场信息读取失败。</p> : !data ? <p role="status" className="text-sm text-ink-3">正在读取…</p> : <>
            <p className="break-all font-mono text-sm">{data.receiverBase || '地址未配置'}</p>
            <p className="text-sm text-ink-2">{reach == null ? '可达性未检测' : reach ? '可达' : '不可达'}</p>
          </>}
        </Stat>
        <Stat title="蜜标">
          {data ? <p><span className="text-2xl font-semibold">{data.decoys.length} 种</span> <span className="text-sm text-ink-2">每次运行生成唯一标记</span></p>
            : <p role="status" className="text-sm text-ink-3">正在读取…</p>}
        </Stat>
      </div>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">终端</h2>
        {endpoints.isError ? null : (
          <>
            <Table>
              <THead><TR><TH>终端</TH><TH>状态</TH><TH>运行能力</TH></TR></THead>
              <TBody>
                {items.map((endpoint) => (
                  <TR key={endpoint.id}>
                    <TD data-label="终端"><Link className="text-brand-700 hover:underline" to={`/fleet/endpoints/${encodeURIComponent(endpoint.id)}`}>{endpoint.hostname}</Link></TD>
                    <TD data-label="状态"><Badge tone={endpoint.online ? 'success' : 'neutral'}>{endpoint.online ? '在线' : '离线'}</Badge></TD>
                    <TD data-label="运行能力">
                      {endpoint.agents.some((agent) => agent.runtimeV2)
                        ? <Badge tone="success">蜜罐沙箱</Badge>
                        : <Badge tone="neutral">仅配置检测</Badge>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {!items.length && !endpoints.isLoading && <p className="py-3 text-sm text-ink-3">暂无终端</p>}
            <Pagination page={page} pageSize={20} total={endpoints.data?.total ?? 0} onPageChange={setPage} />
          </>
        )}
      </section>

      {data && <>
        <section className="space-y-3">
          <h2 className="text-base font-semibold">靶场项目</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {data.projects.map((project) => (
              <section key={project.template} className="min-w-0 rounded-xl border border-line bg-white">
                <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
                  <h3 className="font-medium">{project.name}</h3>
                  <span className="text-xs text-ink-3">{project.files.length} 个可投毒位置</span>
                </div>
                <ul className="divide-y divide-line">
                  {project.files.map((file) => (
                    <li key={file.path} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="w-48 shrink-0 break-all font-mono text-xs">{file.path}</span>
                      <span className="min-w-0 flex-1 text-ink-2">{file.label}</span>
                      <span className={file.usedBy ? 'shrink-0 text-xs text-brand-700' : 'shrink-0 text-xs text-ink-3'}>{usage(file.usedBy)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">蜜标</h2>
          <Table>
            <THead><TR><TH>蜜标</TH><TH>放在哪</TH><TH>用来测什么</TH><TH>使用</TH></TR></THead>
            <TBody>
              {data.decoys.map((decoy) => (
                <TR key={decoy.id}>
                  <TD data-label="蜜标" className="whitespace-nowrap font-medium">{decoy.label}</TD>
                  <TD data-label="放在哪"><code className="font-mono text-xs">{decoy.path}</code></TD>
                  <TD data-label="用来测什么" className="text-sm text-ink-2">{decoy.purpose}</TD>
                  <TD data-label="使用" className="whitespace-nowrap text-sm">{usage(decoy.usedBy)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">模拟 MCP</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.mcp.map((item) => (
              <Card key={item.kind} className="p-4">
                <p className="font-medium">{item.label}</p>
                <p className="mt-1 text-sm text-ink-2">{item.description}</p>
                <p className="mt-2 text-xs text-ink-3">{usage(item.usedBy)}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">最近接收记录</h2>
          {data.recentReceipts.length
            ? <ul className="space-y-1 text-sm">{data.recentReceipts.map((entry) => (
              <li key={entry.id}>{formatDateTime(entry.createdAt)} · 收到蜜标 · <Link className="text-brand-700 underline" to={`/eval-tasks/${encodeURIComponent(entry.taskId)}`}>查看任务</Link></li>
            ))}</ul>
            : <p className="text-sm text-ink-3">暂无接收记录</p>}
        </section>
      </>}
    </main>
  );
}
