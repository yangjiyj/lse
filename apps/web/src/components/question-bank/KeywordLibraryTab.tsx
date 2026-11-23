import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ANNEX_A_ITEMS } from '@lse/shared';
import { ApiError, api, type BankCoverageRow, type KeywordStatus } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTenantView } from '@/lib/tenant-view';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { KeywordListDrawer } from './KeywordListDrawer';
import { readFileText } from './read-file';

const num = (n: number) => n.toLocaleString('zh-CN');

/** 样本库「关键词库」页签：每个小项在用的词数和国标最少数，点小项看词并停用、启用；待确认的词从顶部入口进；导入、导出。对应 GB/T 45654 附录 B 的关键词库要求。 */
export function KeywordLibraryTab() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [itemCode, setItemCode] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [drawer, setDrawer] = useState<{ title?: string; itemCode?: string; status?: KeywordStatus } | null>(null);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const canImport = hasPermission('question_set:create');
  // 「全部租户」视角只读。
  const { isAllTenants } = useTenantView();
  const canEdit = hasPermission('question_set:update') && !isAllTenants;

  const coverage = useQuery({
    queryKey: ['question-sets', 'keyword-coverage'],
    queryFn: () => api.questionSets.keywordCoverage(),
  });

  const doImport = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('请先选择要导入的文件');
      const format = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'txt';
      return api.questionSets.keywordImport({
        format,
        filename: file.name,
        content: await readFileText(file),
        itemCode: itemCode || undefined,
      });
    },
    onSuccess: (r) => {
      toast.success(
        `已导入 ${r.added} 个，重复 ${r.duplicates} 个${
          r.skippedInactive ? `，跳过停用的 ${r.skippedInactive} 行` : ''
        }${r.failed ? `，${r.failed} 行有问题` : ''}`,
      );
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      void qc.invalidateQueries({ queryKey: ['question-sets', 'keyword-coverage'] });
      void qc.invalidateQueries({ queryKey: ['question-sets', 'keyword-list'] });
    },
    onError: (err) => toast.error(err instanceof ApiError || err instanceof Error ? err.message : '导入失败'),
  });

  if (coverage.isLoading) return <LoadingBlock />;
  const c = coverage.data;
  const pending = c?.pendingImportItems ?? [];
  const pendingText = pending
    .map((code) => `${code} ${ANNEX_A_ITEMS.find((i) => i.code === code)?.name ?? ''}`.trim())
    .join('、');
  const candidates = c?.byStatus.pending ?? 0;

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <NoteBox tone="warning">
          以下小项的词数不够国标最少，需要导入：{pendingText}。
        </NoteBox>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span>
          在用 <b className="tabular-nums">{num(c?.total ?? 0)}</b> 个（国标要求不少于 {num(c?.totalMin ?? 10000)}）
        </span>
        {candidates > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDrawer({ status: 'pending' })}
          >
            待确认 {num(candidates)} 个
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void api.questionSets.keywordExport()}>
          导出全部
        </Button>
      </div>
      {canImport && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line p-4">
          <label className="text-[13px]">
            <div className="mb-1 text-ink-3">导入到小项（CSV 里带「小项」列时可不选）</div>
            <Select value={itemCode} onChange={(e) => setItemCode(e.target.value)} className="min-w-[260px]">
              <option value="">按文件里的小项列</option>
              {ANNEX_A_ITEMS.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.code} {i.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-[13px]">
            <div className="mb-1 text-ink-3">文件（CSV：小项,关键词；TXT：每行一个词）</div>
            <Input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <Button disabled={!file || doImport.isPending} onClick={() => doImport.mutate()}>
            导入
          </Button>
        </div>
      )}
      <Table>
        <THead>
          <TR>
            <TH>小项</TH>
            <TH className="text-right">在用</TH>
            <TH className="text-right">国标最少</TH>
          </TR>
        </THead>
        <TBody>
          {(c?.rows ?? []).map((r: BankCoverageRow) => {
            const short = r.min > 0 && !r.ok;
            return (
              <TR key={r.key}>
                <TD data-label="小项">
                  <button
                    type="button"
                    className="text-left text-brand-700 hover:underline"
                    onClick={() => setDrawer({ title: r.label, itemCode: r.key })}
                  >
                    {r.label}
                  </button>
                </TD>
                <TD data-label="在用" className={cn('text-right tabular-nums', short && 'text-red-700')}>
                  {num(r.count)}
                  {short && <span>（还差 {num(r.gap)}）</span>}
                </TD>
                <TD data-label="国标最少" className="text-right tabular-nums">
                  {r.min > 0 ? num(r.min) : '—'}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      {drawer && (
        <KeywordListDrawer
          key={`${drawer.itemCode ?? ''}|${drawer.status ?? ''}`}
          title={drawer.title}
          itemCode={drawer.itemCode}
          initialStatus={drawer.status ?? ''}
          canEdit={canEdit}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}
