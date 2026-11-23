import { useEffect, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, ragEvalApi, type RagCorpus } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { dangerLink, formatBytes, linkButton, readFileBase64 } from './labels';

const FORMAT_LABEL: Record<string, string> = {
  txt: 'TXT',
  md: 'Markdown',
  pdf: 'PDF',
  docx: 'Word',
};

function errMsg(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

export function CorpusPanel({
  canManage,
  maxBytes,
  selectedId,
  onSelect,
}: {
  canManage: boolean;
  maxBytes: number;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);

  const corpora = useQuery({ queryKey: ['rag-eval', 'corpora'], queryFn: ragEvalApi.corpora });
  const list: RagCorpus[] = corpora.data ?? [];
  useEffect(() => {
    if (!selectedId && list[0]) onSelect(list[0].id);
  }, [list, selectedId, onSelect]);
  const selected = list.find((c) => c.id === selectedId) ?? null;

  const docs = useQuery({
    queryKey: ['rag-eval', 'documents', selectedId],
    queryFn: () => ragEvalApi.documents(selectedId),
    enabled: !!selectedId,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['rag-eval', 'corpora'] });
    void qc.invalidateQueries({ queryKey: ['rag-eval', 'documents', selectedId] });
  };

  const create = useMutation({
    mutationFn: () => ragEvalApi.createCorpus({ name: name.trim() }),
    onSuccess: (c) => {
      toast.success('知识库已创建');
      setCreateOpen(false);
      setName('');
      onSelect(c.id);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e, '创建失败')),
  });
  const removeCorpus = useMutation({
    mutationFn: (id: string) => ragEvalApi.deleteCorpus(id),
    onSuccess: () => {
      toast.success('知识库已删除');
      onSelect('');
      refresh();
    },
    onError: (e) => toast.error(errMsg(e, '删除失败')),
  });
  const removeDoc = useMutation({
    mutationFn: (id: string) => ragEvalApi.deleteDocument(id),
    onSuccess: () => {
      toast.success('文档已删除');
      refresh();
    },
    onError: (e) => toast.error(errMsg(e, '删除失败')),
  });

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!selectedId || files.length === 0) return;
    setUploading(true);
    let ok = 0;
    for (const file of files) {
      if (file.size > maxBytes) {
        toast.error(`${file.name} 超过 ${formatBytes(maxBytes)} 上限，已跳过`);
        continue;
      }
      try {
        const contentBase64 = await readFileBase64(file);
        await ragEvalApi.uploadDocument(selectedId, { filename: file.name, contentBase64 });
        ok++;
      } catch (e) {
        toast.error(`${file.name}：${errMsg(e, '上传失败')}`);
      }
    }
    setUploading(false);
    if (ok > 0) toast.success(`已上传 ${ok} 个文档`);
    refresh();
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>知识库</CardTitle>
          {canManage && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              新建知识库
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {corpora.isLoading ? (
            <LoadingBlock />
          ) : list.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              还没有测试文档集：点击“新建知识库”，再上传与被测知识库一致的文档（或用于生成测试知识库包的文档）。
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {list.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    className={`flex w-full items-center justify-between px-5 py-2.5 text-left text-sm ${
                      c.id === selectedId ? 'bg-brand-50 text-primary' : 'hover:bg-slate-50'
                    }`}
                  >
                    <span className="truncate font-medium">{c.name}</span>
                    <span className="shrink-0 text-xs text-slate-500">
                      {c.documentCount} 文档 · {c.chunkCount} 块
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{selected ? `文档 · ${selected.name}` : '文档'}</CardTitle>
          {selected && canManage && (
            <div className="flex items-center gap-4">
              <label className={`${linkButton} cursor-pointer`}>
                {uploading ? '上传中…' : '上传文档'}
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="上传文档"
                  accept=".txt,.md,.markdown,.pdf,.docx"
                  disabled={uploading}
                  onChange={(e) => void onFiles(e)}
                />
              </label>
              <button
                type="button"
                className={dangerLink}
                disabled={removeCorpus.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `确定删除知识库“${selected.name}”？其文档、切块与测试集将一并删除。`,
                    )
                  )
                    removeCorpus.mutate(selected.id);
                }}
              >
                删除知识库
              </button>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {!selected ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              请先在左侧新建或选择知识库，再上传文档
            </p>
          ) : docs.isLoading ? (
            <LoadingBlock />
          ) : (docs.data ?? []).length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              还没有文档：出题、测试知识库包与索引探测都依赖这里的文档。支持
              txt、md、pdf、docx，单个不超过 {formatBytes(maxBytes)}。
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>文件名</TH>
                  <TH>类型</TH>
                  <TH>大小</TH>
                  <TH>切块数</TH>
                  <TH>状态</TH>
                  <TH>上传时间</TH>
                  {canManage && <TH>操作</TH>}
                </TR>
              </THead>
              <TBody>
                {(docs.data ?? []).map((d) => (
                  <TR key={d.id}>
                    <TD data-label="文件名" className="font-medium">
                      {d.filename}
                    </TD>
                    <TD data-label="类型">{FORMAT_LABEL[d.format] ?? d.format}</TD>
                    <TD data-label="大小">{formatBytes(d.sizeBytes)}</TD>
                    <TD data-label="切块数">{d.chunkCount}</TD>
                    <TD data-label="状态">
                      {d.chunkCount > 0 ? (
                        <span className="text-severity-pass">已切块</span>
                      ) : (
                        <span className="text-severity-high">无可用文本</span>
                      )}
                    </TD>
                    <TD data-label="上传时间" className="whitespace-nowrap text-xs text-slate-500">
                      {formatDateTime(d.createdAt)}
                    </TD>
                    {canManage && (
                      <TD data-label="操作">
                        <button
                          type="button"
                          className={dangerLink}
                          disabled={removeDoc.isPending}
                          onClick={() => {
                            if (window.confirm(`确定删除文档“${d.filename}”？`))
                              removeDoc.mutate(d.id);
                          }}
                        >
                          删除
                        </button>
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建知识库"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              创建
            </Button>
          </>
        }
      >
        <Field label="名称" htmlFor="rag-corpus-name" required>
          <Input
            id="rag-corpus-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </Modal>
    </div>
  );
}
