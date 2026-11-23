import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type QuestionSet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { RUN_SOURCE_TYPES, RUN_TYPE_OTHER, runSourceType } from './seed-bank-meta';

const FETCH_SIZE = 200;
const PAGE_SIZE = 20;

/** 「运行记录」页签：评估任务运行时自动落库的样本快照。默认折叠，可按来源类型筛选。 */
export function RunRecordsTab({ onView }: { onView?: (set: QuestionSet) => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['question-sets', 'run-list'],
    queryFn: () => api.questionSets.list({ kind: 'run', pageSize: FETCH_SIZE }),
  });
  const filtered = useMemo(
    () => (list.data?.items ?? []).filter((s) => !type || runSourceType(s.source).id === type),
    [list.data, type],
  );
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const total = list.data?.total ?? 0;
  return (
    <div className="space-y-3">
      <NoteBox tone="info">
        由评估任务自动产生，用于追溯，通常无需管理。需要复用其中的样本，请到评估任务详情里查看。
      </NoteBox>
      <Button variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? '收起运行记录' : `展开运行记录（${total} 条）`}
      </Button>
      {open ? (
        <div className="space-y-3">
          <FilterBar className="mb-0">
            <Select
              aria-label="来源类型"
              value={type}
              onChange={(e) => {
                setPage(1);
                setType(e.target.value);
              }}
              className="max-w-[220px]"
            >
              <option value="">全部来源类型</option>
              {[...RUN_SOURCE_TYPES, { ...RUN_TYPE_OTHER, prefix: '' }].map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </FilterBar>
          {list.isLoading ? (
            <LoadingBlock />
          ) : filtered.length === 0 ? (
            <EmptyState title="暂无运行记录" description="评估任务运行后会在这里留下样本快照。" />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>名称</TH>
                    <TH>来源类型</TH>
                    <TH className="text-right">样本数</TH>
                    <TH>创建时间</TH>
                    <TH className="text-right">操作</TH>
                  </TR>
                </THead>
                <TBody>
                  {pageItems.map((s) => (
                    <TR key={s.id}>
                      <TD data-label="名称" className="max-w-[420px]">
                        <div className="truncate font-medium text-ink" title={s.name}>
                          {s.name}
                        </div>
                      </TD>
                      <TD data-label="来源类型">
                        <Badge tone="neutral">{runSourceType(s.source).label}</Badge>
                      </TD>
                      <TD data-label="样本数" className="text-right tabular-nums">
                        {s.questionCount.toLocaleString('zh-CN')}
                      </TD>
                      <TD
                        data-label="创建时间"
                        className="whitespace-nowrap text-xs text-slate-500"
                      >
                        {formatDateTime(s.createdAt)}
                      </TD>
                      <TD data-label="操作" className="text-right">
                        {onView ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-brand-700"
                            onClick={() => onView(s)}
                          >
                            测试样本
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={filtered.length}
                onPageChange={setPage}
              />
              {total > FETCH_SIZE ? (
                <p className="text-xs text-ink-3">（仅加载最近 {FETCH_SIZE} 条）</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
