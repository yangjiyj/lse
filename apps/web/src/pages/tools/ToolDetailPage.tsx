import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Download, ListChecks, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { TOOL_TASK_ENTRIES, canCreateToolTask, toolTaskEntry } from '@lse/shared';
import { toolsApi, type ToolDetail, type ToolManual, type ToolVersion } from '@/lib/tools';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { formatBytes } from '@/components/model-files/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { DownloadTrace } from './DownloadTrace';
import { ToolFormModal } from './ToolFormModal';
import { ManualUploadModal, VersionUploadModal } from './UploadModals';
import { TOOLS_QUERY_KEY, archLabel, categoryLabel, osLabel } from './labels';

/** 操作说明是纯文本：空行分段，段内换行保留，不渲染 HTML。 */
function Instructions({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return <p className="text-[13.5px] text-ink-3">暂无说明</p>;
  return (
    <div className="space-y-3 text-[13.5px] leading-6 text-ink-2">
      {paragraphs.map((p, i) => (
        <p key={i} className="whitespace-pre-line break-words">
          {p}
        </p>
      ))}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-[13.5px] text-ink-3">{children}</p>;
}

export function ToolDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error: toastError } = useToast();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('tool:manage');
  const [editing, setEditing] = useState(false);
  const [uploadingVersion, setUploadingVersion] = useState(false);
  const [manualModal, setManualModal] = useState<{ manual?: ToolManual } | null>(null);

  const q = useQuery({
    queryKey: [TOOLS_QUERY_KEY, 'detail', id],
    queryFn: () => toolsApi.get(id),
    enabled: Boolean(id),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: [TOOLS_QUERY_KEY] });
  const onError = (e: unknown) => toastError((e as Error).message);

  const update = useMutation({
    mutationFn: (body: { enabled?: boolean; hidden?: boolean }) => toolsApi.update(id, body),
    onSuccess: () => void refresh(),
    onError,
  });
  const remove = useMutation({
    mutationFn: () => toolsApi.remove(id),
    onSuccess: () => {
      void refresh();
      success('工具已删除');
      navigate('/tools');
    },
    onError,
  });
  const removeVersion = useMutation({
    mutationFn: (versionId: string) => toolsApi.deleteVersion(id, versionId),
    onSuccess: () => void refresh(),
    onError,
  });
  const removeManual = useMutation({
    mutationFn: (manualId: string) => toolsApi.deleteManual(id, manualId),
    onSuccess: () => void refresh(),
    onError,
  });
  // 工具版本可能很大：换一次性下载链接让浏览器原生下载；手册和内置探针的一键包文件小，带鉴权拉取。
  const download = useMutation({
    mutationFn: (file: { url: string; filename: string; versionId?: string }) =>
      file.versionId
        ? toolsApi.downloadVersion(id, file.versionId)
        : toolsApi.download(file.url, file.filename),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [TOOLS_QUERY_KEY, 'downloads', id] }),
    onError,
  });

  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data)
    return (
      <div>
        <PageHeader title="工具中心" />
        <EmptyState title={(q.error as Error | null)?.message ?? '工具不存在'} />
      </div>
    );
  const tool: ToolDetail = q.data;
  // 只按白名单里的路径跳转，不用接口给的任意地址。
  const task = toolTaskEntry(tool.taskEntry);
  const canCreateTask = task ? canCreateToolTask(task, hasPermission) : false;
  const onboarding = TOOL_TASK_ENTRIES['fleet-onboard'].createPath;

  const versionAction = (v: ToolVersion) => {
    if (v.downloadUrl)
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={!tool.enabled || download.isPending}
          aria-label={`下载 ${v.version} ${osLabel(v.os)} ${archLabel(v.arch)}`}
          onClick={() =>
            download.mutate({
              url: v.downloadUrl!,
              filename: v.filename,
              versionId: tool.builtin ? undefined : v.id,
            })
          }
        >
          <Download className="h-3.5 w-3.5" />
          下载
        </Button>
      );
    // 内置探针的非一键包要带接入码生成，去终端接入页下载。
    return tool.builtin ? (
      <Link to={onboarding} className="text-[13px] text-brand-700 hover:underline">
        去终端接入
      </Link>
    ) : null;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={tool.name}
        actions={
          <>
            {task && (
              <>
                <Button
                  disabled={!tool.enabled || !canCreateTask}
                  title={canCreateTask ? undefined : '没有新建权限'}
                  onClick={() => navigate(task.createPath)}
                >
                  <Plus className="h-4 w-4" />
                  新建任务
                </Button>
                <Button
                  variant="outline"
                  disabled={!tool.enabled}
                  onClick={() => navigate(task.listPath)}
                >
                  <ListChecks className="h-4 w-4" />
                  任务列表
                </Button>
              </>
            )}
            {canManage && (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" />
                  编辑
                </Button>
                {!tool.builtin && (
                  <Button
                    variant="outline"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ enabled: !tool.enabled })}
                  >
                    {tool.enabled ? '禁用' : '启用'}
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ hidden: !tool.hidden })}
                >
                  {tool.hidden ? '取消隐藏' : '隐藏'}
                </Button>
                {!tool.builtin && (
                  <Button
                    variant="destructive"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          '删除后版本文件、手册和下载记录一并删除，不能恢复。确定删除？',
                        )
                      )
                        remove.mutate();
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    删除
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
        <Badge tone="neutral">{categoryLabel(tool.category)}</Badge>
        {tool.builtin && <Badge tone="info">内置</Badge>}
        {!tool.enabled && <Badge tone="neutral">已禁用</Badge>}
        {tool.hidden && <Badge tone="warning">已隐藏</Badge>}
        <span className="font-num">{tool.code}</span>
        {tool.description && <span className="text-ink-2">{tool.description}</span>}
      </div>

      <SectionCard title="操作说明">
        <Instructions text={tool.instructions} />
      </SectionCard>

      <SectionCard title="配置参数">
        {tool.configParams.length === 0 ? (
          <Empty>无</Empty>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>参数</TH>
                <TH>名称</TH>
                <TH>默认值</TH>
                <TH>必填</TH>
                <TH>说明</TH>
              </TR>
            </THead>
            <TBody>
              {tool.configParams.map((p) => (
                <TR key={p.name}>
                  <TD data-label="参数" className="font-num">
                    {p.name}
                  </TD>
                  <TD data-label="名称">{p.label}</TD>
                  <TD data-label="默认值" className="font-num">
                    {p.defaultValue || '—'}
                  </TD>
                  <TD data-label="必填">{p.required ? '是' : '否'}</TD>
                  <TD data-label="说明">{p.description || '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard
        title="版本"
        extra={
          canManage && !tool.builtin ? (
            <Button size="sm" variant="outline" onClick={() => setUploadingVersion(true)}>
              <Upload className="h-3.5 w-3.5" />
              上传版本
            </Button>
          ) : undefined
        }
      >
        {tool.versions.length === 0 ? (
          <Empty>暂无版本</Empty>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>版本</TH>
                <TH>系统</TH>
                <TH>架构</TH>
                <TH>文件</TH>
                <TH>大小</TH>
                <TH>SHA-256</TH>
                <TH>上传时间</TH>
                <TH>操作</TH>
              </TR>
            </THead>
            <TBody>
              {tool.versions.map((v) => (
                <TR key={v.id}>
                  <TD data-label="版本" className="font-num" title={v.releaseNotes || undefined}>
                    {v.version}
                  </TD>
                  <TD data-label="系统">{osLabel(v.os)}</TD>
                  <TD data-label="架构">{archLabel(v.arch)}</TD>
                  <TD data-label="文件" className="break-all">
                    {v.filename}
                  </TD>
                  <TD data-label="大小" className="font-num">
                    {v.size == null ? '—' : formatBytes(v.size)}
                  </TD>
                  <TD data-label="SHA-256" className="font-num" title={v.sha256}>
                    {v.sha256.slice(0, 12)}…
                  </TD>
                  <TD data-label="上传时间">{v.createdAt ? formatDateTime(v.createdAt) : '—'}</TD>
                  <TD data-label="操作">
                    <div className="flex items-center gap-2">
                      {versionAction(v)}
                      {canManage && !tool.builtin && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`删除版本 ${v.version} ${osLabel(v.os)} ${archLabel(v.arch)}`}
                          disabled={removeVersion.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `删除版本 ${v.version}（${osLabel(v.os)} · ${archLabel(v.arch)}）的文件？`,
                              )
                            )
                              removeVersion.mutate(v.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard
        title="操作手册"
        extra={
          canManage ? (
            <Button size="sm" variant="outline" onClick={() => setManualModal({})}>
              <Upload className="h-3.5 w-3.5" />
              上传手册
            </Button>
          ) : undefined
        }
      >
        {tool.manuals.length === 0 ? (
          <Empty>暂无手册</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {tool.manuals.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium text-ink">{m.title}</div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {m.filename} · {formatBytes(m.size)} · {formatDateTime(m.updatedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`下载手册 ${m.title}`}
                    disabled={download.isPending}
                    onClick={() => download.mutate({ url: m.downloadUrl, filename: m.filename })}
                  >
                    <Download className="h-3.5 w-3.5" />
                    下载
                  </Button>
                  {canManage && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setManualModal({ manual: m })}
                      >
                        替换
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`删除手册 ${m.title}`}
                        disabled={removeManual.isPending}
                        onClick={() => {
                          if (window.confirm(`删除手册「${m.title}」？`)) removeManual.mutate(m.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {canManage && <DownloadTrace toolId={tool.id} />}

      {editing && <ToolFormModal tool={tool} onClose={() => setEditing(false)} />}
      {uploadingVersion && (
        <VersionUploadModal
          toolId={tool.id}
          maxBytes={tool.maxUploadBytes}
          onClose={() => setUploadingVersion(false)}
        />
      )}
      {manualModal && (
        <ManualUploadModal
          toolId={tool.id}
          manual={manualModal.manual}
          onClose={() => setManualModal(null)}
        />
      )}
    </div>
  );
}
