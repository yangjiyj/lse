import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type TenantItem } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { useTenantView } from '@/lib/tenant-view';

/** 生成满足默认密码策略的随机初始密码（大小写字母 + 数字 + 符号，12 位）。 */
export function generateInitialPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '@#%+=!'];
  const all = sets.join('');
  const pick = (chars: string) => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return chars[buf[0]! % chars.length]!;
  };
  const chars = sets.map(pick);
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

interface CreatedInfo {
  tenant: TenantItem;
  username: string;
  password: string;
}

function CreateTenantModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (info: CreatedInfo) => void;
}) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState(() => generateInitialPassword());
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setName('');
    setUsername('');
    setPassword(generateInitialPassword());
    setDescription('');
    setError(null);
  };
  const mutation = useMutation({
    mutationFn: () =>
      api.tenants.create({
        name: name.trim(),
        description: description.trim() || undefined,
        admin: { username: username.trim(), password },
      }),
    onSuccess: (tenant) => {
      onCreated({ tenant, username: username.trim(), password });
      reset();
    },
    onError: (e: Error) => setError(e.message),
  });
  const canSubmit =
    name.trim().length > 0 && username.trim().length >= 3 && password.length >= 8 && !mutation.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建租户"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={() => mutation.mutate()}>
            创建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="租户名称" htmlFor="tenant-name" required>
          <Input
            id="tenant-name"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：某某单位"
          />
        </Field>
        <Field label="租户管理员账号" htmlFor="tenant-admin-username" required>
          <Input
            id="tenant-admin-username"
            value={username}
            maxLength={64}
            autoComplete="off"
            onChange={(e) => setUsername(e.target.value)}
            placeholder="字母、数字、_ . -"
          />
        </Field>
        <Field label="初始密码" htmlFor="tenant-admin-password" required>
          <div className="flex gap-2">
            <Input
              id="tenant-admin-password"
              value={password}
              maxLength={128}
              autoComplete="new-password"
              className="font-mono"
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button variant="outline" onClick={() => setPassword(generateInitialPassword())}>
              换一个
            </Button>
          </div>
        </Field>
        <Field label="备注" htmlFor="tenant-description">
          <Input
            id="tenant-description"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function CreatedModal({
  info,
  onClose,
  onEnter,
}: {
  info: CreatedInfo | null;
  onClose: () => void;
  onEnter: (tenantId: string) => void;
}) {
  const { success, error } = useToast();
  if (!info) return null;
  const text = `租户：${info.tenant.name}\n账号：${info.username}\n初始密码：${info.password}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      success('已复制');
    } catch {
      error('复制失败，请手动选中复制');
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="租户已创建"
      description="把下面的登录信息交给租户管理员，首次登录后可自行修改密码。"
      footer={
        <>
          <Button variant="outline" onClick={copy}>
            复制
          </Button>
          <Button variant="outline" onClick={() => onEnter(info.tenant.id)}>
            进入该租户
          </Button>
          <Button onClick={onClose}>完成</Button>
        </>
      }
    >
      <dl
        data-testid="tenant-created-info"
        className="grid select-all grid-cols-[6rem_1fr] gap-y-2 rounded border border-line bg-canvas p-3 text-sm"
      >
        <dt className="text-ink-3">租户</dt>
        <dd className="text-ink">{info.tenant.name}</dd>
        <dt className="text-ink-3">账号</dt>
        <dd className="font-mono text-ink">{info.username}</dd>
        <dt className="text-ink-3">初始密码</dt>
        <dd className="font-mono text-ink">{info.password}</dd>
      </dl>
    </Modal>
  );
}

function EditTenantModal({ tenant, onClose }: { tenant: TenantItem | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { success } = useToast();
  const [name, setName] = useState(tenant?.name ?? '');
  const [description, setDescription] = useState(tenant?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      api.tenants.update(tenant!.id, { name: name.trim(), description: description.trim() || null }),
    onSuccess: () => {
      success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  if (!tenant) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title="编辑租户"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="租户名称" htmlFor="tenant-edit-name" required>
          <Input id="tenant-edit-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="备注" htmlFor="tenant-edit-description">
          <Input
            id="tenant-edit-description"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

export function TenantsPage() {
  const { user, switchTenant } = useAuth();
  const { enterTenant } = useTenantView();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInfo | null>(null);
  const [editing, setEditing] = useState<TenantItem | null>(null);
  const isPlatformAdmin = Boolean(user?.isPlatformAdmin);
  const { data, isLoading, error } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.tenants.list(),
    enabled: isPlatformAdmin,
  });
  const toggle = useMutation({
    mutationFn: (t: TenantItem) => api.tenants.update(t.id, { isActive: !t.isActive }),
    onSuccess: (t) => {
      success(t.isActive ? `已启用「${t.name}」` : `已停用「${t.name}」，该租户的账号暂时不能登录`);
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
    },
    onError: (e: Error) => toastError(e.message),
  });

  if (!isPlatformAdmin) {
    return (
      <div>
        <PageHeader title="租户管理" />
        <EmptyState title="仅平台管理员可以管理租户" />
      </div>
    );
  }

  const items = data?.items ?? [];
  const currentId = user?.tenant?.id;
  return (
    <div>
      <PageHeader
        title="租户管理"
        description="每个租户独立管理自己的评估对象、终端和评估任务，互相不可见。"
        actions={<Button onClick={() => setCreating(true)}>新建租户</Button>}
      />
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <p className="p-4 text-sm text-severity-critical">{(error as Error).message}</p>
      ) : items.length === 0 ? (
        <EmptyState title="暂无租户" />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>租户</TH>
              <TH>状态</TH>
              <TH>用户</TH>
              <TH>评估对象</TH>
              <TH>终端</TH>
              <TH>评估任务</TH>
              <TH>风险</TH>
              <TH>高危</TH>
              <TH>最近评估</TH>
              <TH>操作</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((t) => (
              <TR key={t.id} className="h-12">
                <TD data-label="租户">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{t.name}</span>
                    {t.isPlatform && <Badge tone="info">平台</Badge>}
                    {t.id === currentId && <Badge tone="success">当前</Badge>}
                  </div>
                  {t.description && <div className="mt-0.5 text-xs text-ink-3">{t.description}</div>}
                </TD>
                <TD data-label="状态">
                  <Badge icon tone={t.isActive ? 'success' : 'neutral'}>
                    {t.isActive ? '正常' : '已停用'}
                  </Badge>
                </TD>
                <TD data-label="用户" className="font-num">{t.userCount}</TD>
                <TD data-label="评估对象" className="font-num">{t.targetCount}</TD>
                <TD data-label="终端" className="font-num">{t.endpointCount}</TD>
                <TD data-label="评估任务" className="font-num">{t.taskCount}</TD>
                <TD data-label="风险" className="font-num">
                  <button type="button" data-testid={'tenant-risk-' + t.id}
                    className="text-brand-700 hover:underline"
                    onClick={() => enterTenant(t.id, '/wrong-answers')}>{t.riskCount ?? 0}</button>
                </TD>
                <TD data-label="高危" className="font-num">
                  <button type="button" data-testid={'tenant-high-risk-' + t.id}
                    className="text-brand-700 hover:underline"
                    onClick={() => enterTenant(t.id, '/wrong-answers')}>{t.highRiskCount ?? 0}</button>
                </TD>
                <TD data-label="最近评估">{formatDateTime(t.lastTaskAt)}</TD>
                <TD data-label="操作">
                  <div className="flex items-center gap-3 text-sm">
                    <button
                      type="button"
                      className="text-brand-600 hover:underline disabled:cursor-default disabled:text-ink-3 disabled:no-underline"
                      disabled={t.id === currentId}
                      onClick={() => switchTenant(t.id)}
                    >
                      进入
                    </button>
                    <button type="button" className="text-brand-600 hover:underline" onClick={() => setEditing(t)}>
                      编辑
                    </button>
                    {!t.isPlatform && (
                      <button
                        type="button"
                        className={t.isActive ? 'text-severity-critical hover:underline' : 'text-brand-600 hover:underline'}
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate(t)}
                      >
                        {t.isActive ? '停用' : '启用'}
                      </button>
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <CreateTenantModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(info) => {
          setCreating(false);
          setCreated(info);
          void queryClient.invalidateQueries({ queryKey: ['tenants'] });
        }}
      />
      <CreatedModal info={created} onClose={() => setCreated(null)} onEnter={(id) => switchTenant(id)} />
      {editing && <EditTenantModal key={editing.id} tenant={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
