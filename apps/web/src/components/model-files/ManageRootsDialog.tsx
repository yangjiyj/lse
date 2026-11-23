import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  ApiError,
  modelFilesApi,
  type ModelFileRootDetail,
  type ModelFileScanConfig,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { bytesToUnit, estimateReadDuration, formatBytes, UNIT } from './format';

interface Rejected {
  path: string;
  reason: string;
}

/** 后端校验不通过时 details.rejected 里带着每个目录的原因，用来就地标注。 */
function rejectedFrom(e: unknown): Rejected[] {
  if (!(e instanceof ApiError)) return [];
  const list = (e.issues as { rejected?: unknown } | undefined)?.rejected;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (x): x is Rejected => Boolean(x) && typeof x.path === 'string' && typeof x.reason === 'string',
  );
}

function RootStatus({ r }: { r: ModelFileRootDetail }) {
  if (r.readable) return <Badge tone="success">存在且可读</Badge>;
  return <Badge tone="danger">{r.problem ?? '不可用'}</Badge>;
}

export interface ManageRootsDialogProps {
  open: boolean;
  onClose: () => void;
  config: ModelFileScanConfig;
}

/** 管理目录：部署目录只读；管理员目录可增删；三项扫描上限用 GiB / MiB / 个填写。 */
export function ManageRootsDialog({ open, onClose, config }: ManageRootsDialogProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const [adminRoots, setAdminRoots] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [totalGiB, setTotalGiB] = useState('');
  const [pickleMiB, setPickleMiB] = useState('');
  const [maxFiles, setMaxFiles] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Rejected[]>([]);

  // 每次打开都用服务器上的最新配置重置表单，取消的修改不残留
  useEffect(() => {
    if (!open) return;
    setAdminRoots(config.rootDetails.filter((r) => r.source === 'admin').map((r) => r.path));
    setDraft('');
    setTotalGiB(bytesToUnit(config.totalMaxBytes, UNIT.GiB));
    setPickleMiB(bytesToUnit(config.pickleMaxBytes, UNIT.MiB));
    setMaxFiles(String(config.maxFiles));
    setError(null);
    setRejected([]);
  }, [open, config]);

  const save = useMutation({
    mutationFn: () =>
      modelFilesApi.updateConfig({
        roots: adminRoots,
        pickleMaxBytes: Math.round(Number(pickleMiB) * UNIT.MiB),
        totalMaxBytes: Math.round(Number(totalGiB) * UNIT.GiB),
        maxFiles: Math.round(Number(maxFiles)),
      }),
    onSuccess: () => {
      toast.success('扫描目录与上限已保存');
      void qc.invalidateQueries({ queryKey: ['model-files'] });
      onClose();
    },
    onError: (e) => {
      const list = rejectedFrom(e);
      setRejected(list);
      setError(e instanceof ApiError ? e.message : '保存失败，请稍后重试');
    },
  });

  const deploy = config.rootDetails.filter((r) => r.source === 'deploy');
  const saved = new Map(config.rootDetails.map((r) => [r.path, r] as const));
  const hostDir = config.hostDir;

  function addDraft() {
    const v = draft.trim().replace(/\/+$/, '') || draft.trim();
    if (!v) return;
    if (!adminRoots.includes(v)) setAdminRoots([...adminRoots, v]);
    setDraft('');
    setError(null);
    setRejected((r) => r.filter((x) => x.path !== v));
  }

  const b = config.limitBounds;
  // 按输入框里当前填的总量估算读满要多久；填的不是有效数字时不给估算
  const typedTotalBytes = Math.round(Number(totalGiB) * UNIT.GiB);
  const eta = estimateReadDuration(typedTotalBytes);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="管理扫描目录"
      description="平台只能扫描下面列出的目录；这里可以增删管理员添加的目录，并设置单次扫描的上限。"
    >
      <div role="dialog" aria-label="管理扫描目录" className="space-y-5">
        <p
          data-testid="boundary-note"
          className="rounded-lg bg-[#F8FAFD] p-3 text-xs leading-5 text-muted-foreground"
        >
          平台只能看到部署时挂载进来的目录。要扫描服务器上别的目录，最简单的做法是把模型放进{' '}
          <span className="font-mono text-foreground">{hostDir ?? '服务器上的模型目录'}</span>
          ，或请运维把那个目录只读挂载进来后，再在这里添加。
        </p>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">部署时配置的目录</h3>
          {deploy.length === 0 ? (
            <p className="text-xs text-muted-foreground">部署时没有配置目录。</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {deploy.map((r) => (
                <li
                  key={r.path}
                  data-testid={`root-${r.path}`}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="break-all font-mono">{r.hostPath ?? r.path}</div>
                    {r.hostPath && (
                      <div className="text-xs text-muted-foreground">容器内路径 {r.path}</div>
                    )}
                  </div>
                  <Badge tone="neutral">部署时配置</Badge>
                  <RootStatus r={r} />
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            部署时配置的目录不能在这里修改，需要调整请联系运维。
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">管理员添加的目录</h3>
          {adminRoots.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有添加。</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {adminRoots.map((p) => {
                const s = saved.get(p);
                const rej = rejected.find((x) => x.path === p);
                return (
                  <li key={p} data-testid={`root-${p}`} className="space-y-1 px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1 break-all font-mono">{p}</div>
                      <Badge tone="info">管理员添加</Badge>
                      {s ? <RootStatus r={s} /> : <Badge tone="neutral">待保存</Badge>}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`删除目录 ${p}`}
                        onClick={() => {
                          setAdminRoots(adminRoots.filter((x) => x !== p));
                          setRejected((r) => r.filter((x) => x.path !== p));
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    {rej && <p className="text-xs text-severity-critical">{rej.reason}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          <Field
            label="添加目录"
            htmlFor="mf-add-root"
            hint="填写平台容器内能访问的绝对路径，例如 /models/llama；保存时会检查目录是否存在、能否读取。"
          >
            <div className="flex items-center gap-2">
              <Input
                id="mf-add-root"
                value={draft}
                className="flex-1 font-mono text-xs"
                placeholder="/models/…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addDraft();
                  }
                }}
              />
              <Button variant="outline" onClick={addDraft} disabled={!draft.trim()}>
                <Plus className="h-4 w-4" />
                添加
              </Button>
            </div>
          </Field>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">扫描上限</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field
              label="单次扫描总量上限（GiB）"
              htmlFor="mf-total"
              hint={`最大 ${Math.round(b.totalMaxBytes.max / UNIT.TiB)} TiB`}
            >
              <Input
                id="mf-total"
                type="number"
                min={0}
                value={totalGiB}
                onChange={(e) => setTotalGiB(e.target.value)}
              />
            </Field>
            <Field
              label="单个 pickle 文件的解析上限（MiB）"
              htmlFor="mf-pickle"
              hint="超出部分只检查开头"
            >
              <Input
                id="mf-pickle"
                type="number"
                min={1}
                value={pickleMiB}
                onChange={(e) => setPickleMiB(e.target.value)}
              />
            </Field>
            <Field
              label="单次扫描文件数上限（个）"
              htmlFor="mf-files"
              hint={`最多 ${b.maxFiles.max} 个`}
            >
              <Input
                id="mf-files"
                type="number"
                min={1}
                value={maxFiles}
                onChange={(e) => setMaxFiles(e.target.value)}
              />
            </Field>
          </div>
          <p data-testid="limit-note" className="text-xs leading-5 text-muted-foreground">
            扫描会完整读取每个模型文件来计算指纹，所以总量就是实际要读的数据量，耗时取决于磁盘速度（按每秒
            100～500 MiB 估算，机械盘和网络存储偏慢，固态盘偏快）。
            {eta && (
              <>
                {' '}
                读满上限 {formatBytes(typedTotalBytes)} 约需 {eta}。
              </>
            )}{' '}
            超出上限时只扫描前面的文件，并标记为部分结果。
          </p>
        </section>

        {config.ignoredRoots.length > 0 && (
          <p className="text-xs text-severity-high">
            有 {config.ignoredRoots.length}{' '}
            个历史目录已不再生效（写法不正确或属于系统目录），请在上面删除后保存。
          </p>
        )}

        {/* 报错放进吸底操作栏：弹窗内容滚动时也始终看得见，不会被操作栏盖住 */}
        <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-wrap items-center gap-3 border-t border-line bg-[#F8FAFD] px-6 py-4">
          {error && (
            <p role="alert" className="min-w-0 flex-1 text-sm leading-5 text-severity-critical">
              {error}
            </p>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={save.isPending}>
              取消
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending && <Spinner className="h-4 w-4" />}
              保存
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
