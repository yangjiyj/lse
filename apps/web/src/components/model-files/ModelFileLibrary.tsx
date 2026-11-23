import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelFilesApi, type ModelFileAibomFields, type ModelFileLibraryItem } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { useToast } from '@/components/ui/toast';
import { formatBytes } from './format';
import { uploadInChunks } from './library-upload';

const CHUNK_SIZE = 8 * 1024 ** 2;
const SCAN_STATUS: Record<string, string> = {
  PENDING: '等待扫描',
  RUNNING: '扫描中',
  COMPLETED: '已完成',
  FAILED: '扫描失败',
  CANCELLED: '已取消',
};

/** 文件留存在文件库；扫描只读取文件，删除不会影响服务器模型目录或历史结果。 */
export function ModelFileLibrary({
  onDone,
  fields,
  uploadMaxBytes,
}: {
  onDone: (id: string) => void;
  fields: () => Promise<ModelFileAibomFields>;
  uploadMaxBytes: number;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [active, setActive] = useState<{ id: string; file: File; chunkSize: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState<ModelFileLibraryItem | null>(null);
  const controller = useRef<AbortController | null>(null);
  const starting = useRef(false);
  const cancelling = useRef<string | null>(null);
  const library = useQuery({
    queryKey: ['model-files', 'library', page],
    queryFn: () => modelFilesApi.library({ page, pageSize: 20 }),
    refetchInterval: 5000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['model-files', 'library'] });
  useEffect(() => () => controller.current?.abort(), []);

  async function upload(file: File, existing?: ModelFileLibraryItem, resume = active) {
    if (starting.current) return;
    starting.current = true;
    cancelling.current = null;
    let uploadId: string | null = null;
    let confirmedBytes = 0;
    let checking = false;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setPaused(false);
    setVerifying(false);
    setProgress(0);
    setSpeed(0);
    setMessage('正在准备上传…');
    try {
      if (
        existing &&
        (file.name !== existing.fileName ||
          (existing.expectedBytes !== null && file.size !== existing.expectedBytes))
      )
        throw new Error('请选择之前上传的同一个文件，文件名和大小都需要一致');
      const session = existing
        ? { uploadId: existing.id, chunkSize: CHUNK_SIZE }
        : resume && resume.file === file
          ? { uploadId: resume.id, chunkSize: resume.chunkSize }
          : await modelFilesApi.createLibraryUpload({ fileName: file.name, totalBytes: file.size });
      uploadId = session.uploadId;
      const current = { id: session.uploadId, file, chunkSize: session.chunkSize };
      setActive(current);
      void refresh();
      let lastTime = Date.now();
      let lastBytes: number | null = null;
      setMessage('正在上传');
      await uploadInChunks({
        id: current.id,
        file,
        chunkSize: current.chunkSize,
        signal: abort.signal,
        api: {
          state: modelFilesApi.libraryUpload,
          chunk: modelFilesApi.uploadLibraryChunk,
          complete: modelFilesApi.completeLibraryUpload,
        },
        onConfirmed: (bytes) => {
          confirmedBytes = bytes;
        },
        onCompleting: () => {
          checking = true;
          setVerifying(true);
          setMessage('文件已上传，正在后台核对；此时不能暂停，可取消上传并删除该文件');
        },
        onProgress: (bytes) => {
          if (abort.signal.aborted) return;
          const now = Date.now();
          if (lastBytes !== null && now > lastTime)
            setSpeed(Math.max(0, ((bytes - lastBytes) * 1000) / (now - lastTime)));
          lastBytes = bytes;
          lastTime = now;
          setProgress(bytes);
          setMessage(bytes === file.size ? '文件已传完，正在核对文件，请稍候…' : '正在上传');
        },
        onRetry: (attempt) => setMessage(`连接中断，正在第 ${attempt} 次重试；已上传内容会保留`),
      });
      if (uploadId && cancelling.current === uploadId) return;
      setMessage('上传完成，文件已保存在服务器上，可随时扫描或删除');
      setActive(null);
      toast.success('模型文件已上传到文件库');
    } catch (error) {
      if (uploadId && cancelling.current === uploadId) return;
      if (abort.signal.aborted && !checking && uploadId) {
        setProgress(confirmedBytes);
        try {
          const received = await modelFilesApi.libraryUpload(uploadId);
          if (uploadId && cancelling.current === uploadId) return;
          setProgress(received.bytes);
        } catch {
          // 回查失败时只展示已经确认的字节，继续时会再次查询服务器。
        }
      }
      if (uploadId && cancelling.current === uploadId) return;
      setPaused(true);
      setMessage(
        abort.signal.aborted
          ? '已暂停，已上传内容保留，可继续上传'
          : error instanceof Error
            ? error.message
            : '上传失败，请重试',
      );
    } finally {
      starting.current = false;
      setBusy(false);
      setVerifying(false);
      setSpeed(0);
      void refresh();
    }
  }

  const remove = useMutation({
    mutationFn: async (item: ModelFileLibraryItem) => {
      if (active?.id === item.id) {
        cancelling.current = item.id;
        controller.current?.abort();
        setPaused(false);
        setMessage('正在取消上传并删除已传内容…');
      }
      await modelFilesApi.deleteLibrary(item.id);
      return item.id;
    },
    onSuccess: (id) => {
      if (active?.id === id) {
        setActive(null);
        setMessage('已取消上传，服务器上的未完成文件已删除');
      }
      setDeleting(null);
      toast.success('已删除上传的模型文件，历史扫描结果已保留');
      void refresh();
    },
    onError: () => {
      if (active?.id === cancelling.current) {
        cancelling.current = null;
        setPaused(true);
        setMessage('取消上传未完成，服务器已收到的内容保留，可继续上传或重试删除');
      }
    },
  });
  const scan = useMutation({
    mutationFn: async (id: string) => modelFilesApi.scanLibrary(id, await fields()),
    onSuccess: (result) => {
      toast.success('扫描任务已提交，文件会继续保存在文件库中');
      onDone(result.id);
      void refresh();
      void qc.invalidateQueries({ queryKey: ['model-files', 'scans'] });
    },
  });
  const activeItem: ModelFileLibraryItem | null = active
    ? {
        id: active.id,
        fileName: active.file.name,
        bytes: progress,
        expectedBytes: active.file.size,
        status: 'UPLOADING',
        sha256: null,
        createdBy: null,
        createdAt: '',
        latestScan: null,
      }
    : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">上传的文件保存在服务器上，可随时扫描或删除。</p>
      <p className="text-xs text-muted-foreground">
        {uploadMaxBytes > 0
          ? `管理员设置的单个文件大小为 ${formatBytes(uploadMaxBytes)}；如需调整请联系管理员`
          : '文件大小由服务器可用空间决定'}
      </p>
      <p className="text-sm">
        服务器磁盘剩余 {library.data ? formatBytes(library.data.diskFreeBytes) : '正在读取…'}
        {library.data && ` · 文件库占用 ${formatBytes(library.data.libraryBytes)}`}
      </p>
      <Field
        label="模型文件"
        htmlFor="mf-file"
        hint="选中文件后立即上传；关闭页面会暂停，重新进入后请在下方未完成文件旁选择原文件继续。"
      >
        <Input
          id="mf-file"
          type="file"
          disabled={busy || Boolean(active)}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file, undefined, null);
            event.target.value = '';
          }}
        />
      </Field>
      {(message || active) && (
        <div className="space-y-2 rounded-lg border border-border p-3" aria-live="polite">
          <p className="text-sm">{message}</p>
          {active && (
            <>
              <p className="break-all text-sm">
                {active.file.name} · {formatBytes(progress)} / {formatBytes(active.file.size)} ·{' '}
                {formatBytes(speed)}/秒
              </p>
              <progress
                className="h-2 w-full"
                aria-label="上传进度"
                max={active.file.size || 1}
                value={progress}
              />
              <div className="flex gap-2">
                {busy
                  ? !verifying && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => controller.current?.abort()}
                      >
                        暂停上传
                      </Button>
                    )
                  : paused && (
                      <Button size="sm" onClick={() => void upload(active.file)}>
                        继续上传
                      </Button>
                    )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    remove.reset();
                    setDeleting(activeItem);
                  }}
                >
                  取消上传
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {library.isError && (
        <p role="alert" className="text-sm text-severity-critical">
          {library.error instanceof Error ? library.error.message : '文件库读取失败，请刷新后重试'}
        </p>
      )}
      {scan.isError && (
        <p role="alert" className="text-sm text-severity-critical">
          {scan.error instanceof Error ? scan.error.message : '扫描提交失败'}
        </p>
      )}
      {library.isLoading && <p className="text-sm text-muted-foreground">正在读取模型文件库…</p>}
      {library.data?.items.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          文件库暂无模型文件。可以上传文件，也可以用「目录扫描」扫描服务器上已有的模型目录。
        </p>
      )}
      {Boolean(library.data?.items.length) && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                {['文件名', '大小', '上传人', '上传时间', '最近扫描结论', '操作'].map((title) => (
                  <th key={title} className="px-3 py-2 font-medium">
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {library.data?.items.map((item) => (
                <tr key={item.id} className="border-b border-border">
                  <td className="max-w-xs break-all px-3 py-3">
                    {item.fileName}
                    {item.sha256 && (
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary>文件指纹</summary>
                        {item.sha256}
                      </details>
                    )}
                    {item.status === 'UPLOADING' && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        未完成 · 已传 {formatBytes(item.bytes)}
                        {item.expectedBytes !== null && ` / ${formatBytes(item.expectedBytes)}`}
                      </p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3">
                    {formatBytes(
                      item.status === 'UPLOADING' ? (item.expectedBytes ?? item.bytes) : item.bytes,
                    )}
                  </td>
                  <td className="px-3 py-3">{item.createdBy?.displayName ?? '已删除的用户'}</td>
                  <td className="whitespace-nowrap px-3 py-3">
                    {new Date(item.createdAt).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={item.latestScan?.status === 'COMPLETED' ? 'info' : 'neutral'}>
                      {item.latestScan
                        ? (item.latestScan.verdict ??
                          SCAN_STATUS[item.latestScan.status] ??
                          '等待结果')
                        : '尚未扫描'}
                    </Badge>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.status === 'READY' ? (
                        <Button
                          size="sm"
                          disabled={scan.isPending}
                          onClick={() => scan.mutate(item.id)}
                          aria-label={`扫描 ${item.fileName}`}
                        >
                          扫描
                        </Button>
                      ) : (
                        <label
                          className={`cursor-pointer text-brand-600 ${busy || active ? 'pointer-events-none opacity-50' : ''}`}
                        >
                          选择原文件继续
                          <Input
                            className="sr-only"
                            type="file"
                            aria-label={`继续上传 ${item.fileName}`}
                            disabled={busy || Boolean(active)}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void upload(file, item, null);
                              event.target.value = '';
                            }}
                          />
                        </label>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`删除 ${item.fileName}`}
                        onClick={() => {
                          remove.reset();
                          setDeleting(item);
                        }}
                      >
                        删除
                      </Button>
                      {item.latestScan && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onDone(item.latestScan!.id)}
                        >
                          查看最近扫描
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {library.data && (
        <Pagination page={page} pageSize={20} total={library.data.total} onPageChange={setPage} />
      )}
      <Modal
        open={Boolean(deleting)}
        onClose={() => {
          if (!remove.isPending) setDeleting(null);
        }}
        title="删除模型文件"
        footer={
          <>
            <Button variant="outline" disabled={remove.isPending} onClick={() => setDeleting(null)}>
              暂不删除
            </Button>
            <Button disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
              {remove.isPending ? '正在删除…' : '确认删除'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="break-all">
            将删除「{deleting?.fileName}」
            {deleting?.status === 'UPLOADING'
              ? '已上传的部分，并取消本次上传'
              : '保存在文件库中的文件'}
            ，此操作不能撤销，如需恢复请重新上传。
          </p>
          <p>只删除您上传的这个文件，服务器模型目录里的文件不受影响；历史扫描结果会保留。</p>
          {remove.isError && (
            <p role="alert" className="text-severity-critical">
              {remove.error instanceof Error ? remove.error.message : '删除失败，请重试'}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
