import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { BankVersionInfo } from './BankUpdateInfo';
import { CoverageTable } from './CoverageTable';
import { readFileText } from './read-file';

const BANK_OPTIONS = [
  { value: '', label: '按文件里的题库列' },
  { value: 'generation', label: '生成内容测试题库' },
  { value: 'refusal', label: '应拒答测试题库' },
  { value: 'non_refusal', label: '非拒答测试题库' },
];

/** 种子库「国标题库」视图：三套附录 B 题库的覆盖与缺口，以及按小项导入题目的入口。 */
export function BankCoveragePanel() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [bank, setBank] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const canImport = hasPermission('question_set:create');
  const coverage = useQuery({
    queryKey: ['question-sets', 'bank-coverage'],
    queryFn: () => api.questionSets.bankCoverage(),
  });

  const doImport = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('请先选择要导入的文件');
      const format = file.name.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'csv';
      return api.questionSets.bankImport({
        format,
        filename: file.name,
        content: await readFileText(file),
        bank: bank || undefined,
      });
    },
    onSuccess: (r) => {
      toast.success(
        `已导入 ${r.imported} 题，重复 ${r.duplicates} 题${r.failed ? `，${r.failed} 行有问题` : ''}`,
      );
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      void qc.invalidateQueries({ queryKey: ['question-sets'] });
    },
    onError: (err) => toast.error(err instanceof ApiError || err instanceof Error ? err.message : '导入失败'),
  });

  if (coverage.isLoading) return <LoadingBlock />;
  const banks = coverage.data?.banks ?? [];

  return (
    <div className="space-y-4">
      <BankVersionInfo />
      <NoteBox tone="info">
        这里统计平台内置题库与您导入的题目合并后的覆盖情况。内置题库已覆盖附录 A 31 项，可继续导入贵单位自有的题目一并统计。
      </NoteBox>
      {canImport && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line p-4">
          <label className="text-[13px]">
            <div className="mb-1 text-ink-3">导入到题库</div>
            <Select value={bank} onChange={(e) => setBank(e.target.value)} className="min-w-[220px]">
              {BANK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-[13px]">
            <div className="mb-1 text-ink-3">文件（CSV 或 JSONL，字段：小项编号、题目内容、题库）</div>
            <Input
              ref={fileRef}
              type="file"
              accept=".csv,.jsonl"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <Button disabled={!file || doImport.isPending} onClick={() => doImport.mutate()}>
            导入
          </Button>
          <Button variant="outline" onClick={() => void api.questionSets.bankImportTemplate()}>
            下载导入模板
          </Button>
        </div>
      )}
      {banks.map((b) => (
        <section key={b.bank} className="space-y-2">
          <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-bold text-ink">
            {b.label}
            <Badge tone={b.ok ? 'success' : 'warning'}>{b.ok ? '满足附录 B' : '未满足附录 B'}</Badge>
          </h3>
          <p className="text-[13px] text-ink-2">
            总数 <b className="tabular-nums">{b.total.toLocaleString('zh-CN')}</b> 题（要求不少于{' '}
            {b.totalMin.toLocaleString('zh-CN')}）；
            {b.gaps.length === 0 ? '各项均已达标。' : `${b.gaps.length} 项未达标。`}
          </p>
          <CoverageTable rows={b.rows} firstColumn={b.bank === 'non_refusal' ? '方面' : '附录 A 小项'} unit="题" />
        </section>
      ))}
    </div>
  );
}
