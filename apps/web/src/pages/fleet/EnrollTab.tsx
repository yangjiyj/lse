import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, TerminalSquare } from 'lucide-react';
import { api, type FleetDeploymentInfo, type FleetEnrollmentCodeCreated } from '@/lib/api';
import { errorMessage, FLEET_CODE_STATUS_LABELS, FLEET_CODE_STATUS_TONE } from '@/lib/fleet';
import { formatDateTime } from '@/lib/format';
import { PRODUCT_NAME } from '@/lib/product-name';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { NoteBar, SectionCard } from '@/components/page-kit/SectionCard';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { CreateCodeModal } from '@/components/fleet/CreateCodeModal';
import { OneTimeCodeCard } from '@/components/fleet/OneTimeCodeCard';

/** 部署没配好时，把后端给出的原因原样告诉管理员；接入本身不需要在页面上做任何手工配置。 */
function DeploymentNote({ info }: { info: FleetDeploymentInfo | undefined }) {
  if (!info) return null;
  const notReady = !info.ready;
  const oneclickDown = info.ready && info.oneclick !== undefined && !info.oneclick.available;
  if (!notReady && !oneclickDown) return null;
  const reasons = notReady ? info.issues : (info.oneclick?.reasons ?? []);
  return (
    <NoteBox tone="warning" role="alert">
      <p className="font-semibold">{notReady ? '部署信息尚未就绪' : 'Linux 一键安装暂不可用'}</p>
      {reasons.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : notReady ? (
        <p className="mt-1">服务端尚未完成终端接入所需的配置。</p>
      ) : null}
      <p className="mt-1">请联系平台管理员完成部署配置。</p>
    </NoteBox>
  );
}

function CodesSection({
  canManage,
  oneclick,
}: {
  canManage: boolean;
  oneclick: FleetDeploymentInfo['oneclick'];
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<FleetEnrollmentCodeCreated | null>(null);
  const [platform, setPlatform] = useState<'linux' | 'windows'>('linux');
  const q = useQuery({
    queryKey: ['fleet', 'codes'],
    queryFn: () => api.fleet.enrollmentCodes(),
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.fleet.revokeEnrollmentCode(id),
    onSuccess: () => {
      toast.success('接入码已撤销');
      void qc.invalidateQueries({ queryKey: ['fleet', 'codes'] });
    },
    onError: (err) => toast.error(errorMessage(err, '撤销失败')),
  });
  const items = q.data?.items ?? [];
  return (
    <SectionCard
      title="接入码"
      description="终端首次注册时使用，用完即失效。创建后明文只显示一次。"
      extra={
        canManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            创建接入码
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {created && (
          <OneTimeCodeCard created={created} oneclick={oneclick} initialPlatform={platform} onClose={() => setCreated(null)} />
        )}
        {canManage && !created && <div className="flex flex-wrap items-center gap-2 border-b border-line pb-4">
          <Button variant="outline" onClick={() => { setPlatform('linux'); setCreating(true); }}><TerminalSquare className="h-4 w-4" />安装 Linux 终端</Button>
          <Button variant="outline" onClick={() => { setPlatform('windows'); setCreating(true); }}><Download className="h-4 w-4" />安装 Windows 终端</Button>
        </div>}
        {q.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-5 w-5" />
          </div>
        ) : q.isError ? (
          <NoteBox tone="warning" role="alert">
            接入码列表加载失败。
          </NoteBox>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-[13.5px] text-ink-3">还没有接入码。</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>名称</TH>
                <TH>前缀</TH>
                <TH>已用 / 上限</TH>
                <TH>状态</TH>
                <TH>到期时间</TH>
                <TH>创建人</TH>
                {canManage && <TH>操作</TH>}
              </TR>
            </THead>
            <TBody>
              {items.map((c) => (
                <TR key={c.id}>
                  <TD data-label="名称" className="font-medium">
                    {c.label}
                  </TD>
                  <TD data-label="前缀">
                    <code className="font-mono text-[12.5px]">{c.codePrefix}…</code>
                  </TD>
                  <TD data-label="已用 / 上限">
                    {c.usedCount} / {c.maxUses}
                  </TD>
                  <TD data-label="状态">
                    <Badge tone={FLEET_CODE_STATUS_TONE[c.status]} icon>
                      {FLEET_CODE_STATUS_LABELS[c.status]}
                    </Badge>
                  </TD>
                  <TD data-label="到期时间">{formatDateTime(c.expiresAt)}</TD>
                  <TD data-label="创建人">{c.createdBy?.username ?? '—'}</TD>
                  {canManage && (
                    <TD data-label="操作">
                      {c.status === 'ACTIVE' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`撤销接入码：${c.label}`}
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(c.id)}
                        >
                          撤销
                        </Button>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
      <CreateCodeModal open={creating} onClose={() => setCreating(false)} onCreated={setCreated} />
    </SectionCard>
  );
}

export function EnrollTab({ canManage }: { canManage: boolean }) {
  // 部署信息只有管理员能读；没有管理权限时不请求，也就不显示部署提示。
  const deployment = useQuery({
    queryKey: ['fleet', 'deployment-info'],
    queryFn: () => api.fleet.deploymentInfo(),
    enabled: canManage,
    retry: false,
  });
  return (
    <div className="space-y-5">
      <NoteBar>
        把终端接入{PRODUCT_NAME}：先创建接入码，Linux 终端复制一条命令到终端执行，Windows
        终端下载安装包双击运行。
      </NoteBar>
      <DeploymentNote info={deployment.data} />
      <CodesSection canManage={canManage} oneclick={deployment.data?.oneclick} />
    </div>
  );
}
