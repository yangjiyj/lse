import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LoadingBlock } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';
import type { AiComponentScanList } from '@/lib/api';
import { ASSET_TYPE_LABEL, SOURCE_TYPE_LABEL, SEVERITY_TEXT } from './labels';

interface Props {
  data?: AiComponentScanList;
  loading: boolean;
  page: number;
  onPage: (p: number) => void;
  selectedId: string | null;
  onOpen: (id: string) => void;
}

function Counts({ c, h, m, l }: { c: number; h: number; m: number; l: number }) {
  if (c + h + m + l === 0) return <span className="text-ink-3">未发现风险</span>;
  return (
    <span className="space-x-2 whitespace-nowrap">
      {c + h > 0 ? <span className={SEVERITY_TEXT.HIGH}>高 {c + h}</span> : null}
      {m > 0 ? <span className={SEVERITY_TEXT.MEDIUM}>中 {m}</span> : null}
      {l > 0 ? <span className={SEVERITY_TEXT.LOW}>低 {l}</span> : null}
    </span>
  );
}

export function ScanList({ data, loading, page, onPage, selectedId, onOpen }: Props) {
  if (loading) return <LoadingBlock />;
  if (!data || data.total === 0) {
    return (
      <EmptyState
        title="还没有扫描记录"
        description="在左侧填写资产名称，上传 Skill / MCP / 插件的源码压缩包、目录，或填写 MCP 服务地址，即可发起扫描。扫描不需要预先创建评估任务。"
      />
    );
  }
  return (
    <div>
      <Table>
        <THead>
          <TR>
            <TH>资产</TH>
            <TH>来源</TH>
            <TH>发现</TH>
            <TH>关联评估任务</TH>
            <TH>扫描时间</TH>
            <TH>操作</TH>
          </TR>
        </THead>
        <TBody>
          {data.items.map((s) => (
            <TR key={s.id} className={`h-10 ${s.id === selectedId ? 'bg-brand-600/5' : ''}`}>
              <TD data-label="资产">
                <div className="font-medium text-ink">{s.assetName}</div>
                <div className="text-xs text-ink-3">
                  {ASSET_TYPE_LABEL[s.assetType]}
                  {s.assetVersion ? ` · ${s.assetVersion}` : ''}
                </div>
              </TD>
              <TD data-label="来源" className="text-xs text-ink-3">
                <div>{SOURCE_TYPE_LABEL[s.sourceType]}</div>
                <div
                  className="max-w-[14rem] truncate text-ink-3"
                  title={s.endpointUrl ?? s.sourceLabel ?? ''}
                >
                  {s.endpointUrl ?? s.sourceLabel ?? '—'}
                </div>
              </TD>
              <TD data-label="发现" className="text-sm">
                {s.status === 'FAILED' ? (
                  <span className="text-severity-critical" title={s.error ?? ''}>
                    扫描失败
                  </span>
                ) : (
                  <Counts c={s.criticalCount} h={s.highCount} m={s.mediumCount} l={s.lowCount} />
                )}
              </TD>
              <TD data-label="关联评估任务" className="text-xs text-ink-3">
                {s.linkedTaskName ?? '未关联'}
              </TD>
              <TD data-label="扫描时间" className="whitespace-nowrap text-xs text-ink-3">
                {formatDateTime(s.createdAt)}
                {s.createdByName ? <div>{s.createdByName}</div> : null}
              </TD>
              <TD data-label="操作">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-brand-600"
                  onClick={() => onOpen(s.id)}
                >
                  查看
                </Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <Pagination page={page} pageSize={data.pageSize} total={data.total} onPageChange={onPage} />
    </div>
  );
}
