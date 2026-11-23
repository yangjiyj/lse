import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import {
  CORPUS_FORMAT_OPTIONS,
  corpusRulesApi,
  corpusScansApi,
  formatBytes,
  formatLimit,
  scanFormatLabel,
  type CorpusFormat,
  type CorpusScanView,
} from '@/lib/corpus-scans';
import { formatDateTime, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { TaskStatusBadge } from '@/components/ui/status-badge';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';

const QUERY_KEY = ['corpus-scans'] as const;
const PAGE_SIZE = 20;
const ACCEPT = '.jsonl,.json,.csv,.txt';

/** 读 CSV 首行表头（只读文件开头 64 KB），供用户选要检测的列。 */
function readCsvHeader(file: File): Promise<string[]> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '').replace(/^﻿/, '');
      const first = text.split(/\r?\n/)[0] ?? '';
      const cells: string[] = [];
      let cell = '';
      let quoted = false;
      for (let i = 0; i < first.length; i++) {
        const ch = first[i]!;
        if (quoted) {
          if (ch === '"' && first[i + 1] === '"') {
            cell += '"';
            i += 1;
          } else if (ch === '"') quoted = false;
          else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          cells.push(cell.trim());
          cell = '';
        } else cell += ch;
      }
      cells.push(cell.trim());
      resolve(cells.filter(Boolean));
    };
    reader.onerror = () => resolve([]);
    reader.readAsText(file.slice(0, 64 * 1024));
  });
}

function NewScanModal({
  uploadMaxBytes,
  onClose,
  onCreated,
}: {
  uploadMaxBytes: number | undefined;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<CorpusFormat>('auto');
  const [ruleSetId, setRuleSetId] = useState('');
  const [judgeReview, setJudgeReview] = useState(false);
  const [judgeLimit, setJudgeLimit] = useState('200');
  const [columns, setColumns] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const sets = useQuery({
    queryKey: ['corpus-rule-sets'],
    queryFn: () => corpusRulesApi.listSets(),
  });

  const isCsv = format === 'csv' || (format === 'auto' && /\.csv$/i.test(file?.name ?? ''));
  useEffect(() => {
    let alive = true;
    if (!file || !isCsv) {
      setColumns([]);
      setPicked(new Set());
      return;
    }
    void readCsvHeader(file).then((cols) => {
      if (!alive) return;
      setColumns(cols);
      setPicked(new Set(cols));
    });
    return () => {
      alive = false;
    };
  }, [file, isCsv]);

  const limit = Number(judgeLimit);
  const limitOk = !judgeReview || (Number.isInteger(limit) && limit >= 1 && limit <= 1000);
  const create = useMutation({
    mutationFn: () =>
      corpusScansApi.create(file!, {
        format,
        ruleSetId: ruleSetId || null,
        judgeReview,
        judgeLimit: limit,
        csvColumns:
          isCsv && picked.size < columns.length ? columns.filter((c) => picked.has(c)) : [],
      }),
    onSuccess: (res) => onCreated(res.id),
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="新建语料扫描"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              !file ||
              !limitOk ||
              (isCsv && columns.length > 0 && picked.size === 0) ||
              create.isPending
            }
            onClick={() => create.mutate()}
          >
            {create.isPending ? '上传中…' : '开始扫描'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="语料文件"
          htmlFor="corpus-file"
          hint={`jsonl、json、csv、txt，UTF-8 编码${uploadMaxBytes ? `，不超过 ${formatLimit(uploadMaxBytes)}` : ''}`}
        >
          <input
            id="corpus-file"
            type="file"
            accept={ACCEPT}
            className="text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="格式" htmlFor="corpus-format">
          <Select
            id="corpus-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as CorpusFormat)}
          >
            {CORPUS_FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {columns.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium text-ink">检测的列</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {columns.map((c) => (
                <label key={c} className="flex items-center gap-1.5 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    checked={picked.has(c)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(c);
                      else next.delete(c);
                      setPicked(next);
                    }}
                  />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <Field label="自定义规则集" htmlFor="corpus-rule-set">
          <Select
            id="corpus-rule-set"
            value={ruleSetId}
            onChange={(e) => setRuleSetId(e.target.value)}
          >
            <option value="">不使用</option>
            {(sets.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={judgeReview}
            onChange={(e) => setJudgeReview(e.target.checked)}
          />
          裁判复核
        </label>
        {judgeReview && (
          <Field
            label="复核上限"
            htmlFor="corpus-judge-limit"
            hint="1～1000 条，只复核命中违规关键词的记录"
            error={limitOk ? undefined : '请输入 1～1000 的整数'}
          >
            <Input
              id="corpus-judge-limit"
              type="number"
              min={1}
              max={1000}
              value={judgeLimit}
              onChange={(e) => setJudgeLimit(e.target.value)}
            />
          </Field>
        )}
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

export function CorpusScansPage() {
  const { hasPermission, user } = useAuth();
  const canCreate = hasPermission('corpus_scan:create');
  const canManage = hasPermission('corpus_scan:manage');
  // 删除：自己发起的，或有管理全部扫描的权限
  const canDelete = (s: CorpusScanView) =>
    canManage || (canCreate && !!user && s.createdBy?.id === user.id);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  // 工具中心「新建任务」跳过来时带 ?new=1，直接打开新建框
  useEffect(() => {
    if (params.get('new') === '1' && canCreate) {
      setCreating(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams, canCreate]);

  const list = useQuery({
    queryKey: [...QUERY_KEY, page],
    queryFn: () => corpusScansApi.list({ page, pageSize: PAGE_SIZE }),
    refetchInterval: (q) =>
      q.state.data?.items.some((s) => s.status === 'PENDING' || s.status === 'RUNNING')
        ? 3000
        : false,
  });
  const remove = useMutation({
    mutationFn: (s: CorpusScanView) => corpusScansApi.remove(s.id),
    onSuccess: () => {
      success('已删除');
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (e: Error) => toastError(e.message),
  });
  const items = useMemo(() => list.data?.items ?? [], [list.data]);

  return (
    <div>
      <PageHeader
        title="语料扫描"
        actions={
          canCreate ? <Button onClick={() => setCreating(true)}>新建扫描</Button> : undefined
        }
      />
      <Card className="p-4">
        {list.isLoading ? (
          <LoadingBlock />
        ) : list.error ? (
          <p className="text-sm text-severity-critical">{(list.error as Error).message}</p>
        ) : items.length === 0 ? (
          <EmptyState title="暂无语料扫描" />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>文件</TH>
                  <TH>格式</TH>
                  <TH>状态</TH>
                  <TH>记录数</TH>
                  <TH>违规 / 敏感 / 自定义</TH>
                  <TH>发起人</TH>
                  <TH>时间</TH>
                  <TH>操作</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((s) => {
                  const c = s.stats?.byCategory;
                  return (
                    <TR key={s.id} className="h-12">
                      <TD data-label="文件">
                        <Link
                          to={`/data/corpus-scans/${s.id}`}
                          className="text-brand-600 hover:underline"
                        >
                          {s.fileName}
                        </Link>
                        <span className="ml-2 text-xs text-ink-3">{formatBytes(s.bytes)}</span>
                      </TD>
                      <TD data-label="格式">{scanFormatLabel(s)}</TD>
                      <TD data-label="状态">
                        <TaskStatusBadge value={s.status} />
                      </TD>
                      <TD data-label="记录数">
                        {s.status === 'COMPLETED' ? formatNumber(s.totalRecords) : '—'}
                      </TD>
                      <TD data-label="违规 / 敏感 / 自定义">
                        {c
                          ? `${formatNumber(c.violation)} / ${formatNumber(c.sensitive)} / ${formatNumber(c.custom)}`
                          : '—'}
                      </TD>
                      <TD data-label="发起人">{s.createdBy?.name ?? '—'}</TD>
                      <TD data-label="时间">{formatDateTime(s.createdAt)}</TD>
                      <TD data-label="操作">
                        <div className="flex items-center gap-3 text-sm">
                          <Link
                            to={`/data/corpus-scans/${s.id}`}
                            className="text-brand-600 hover:underline"
                          >
                            查看
                          </Link>
                          {canDelete(s) && (
                            <button
                              type="button"
                              className="text-severity-critical hover:underline"
                              disabled={remove.isPending}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `删除「${s.fileName}」的扫描记录和上传的文件？删除后不能恢复。`,
                                  )
                                )
                                  remove.mutate(s);
                              }}
                            >
                              删除
                            </button>
                          )}
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={list.data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </Card>
      {creating && (
        <NewScanModal
          uploadMaxBytes={list.data?.uploadMaxBytes}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            success('已上传，开始扫描');
            void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
            navigate(`/data/corpus-scans/${id}`);
          }}
        />
      )}
    </div>
  );
}
