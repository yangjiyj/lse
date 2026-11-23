import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiTokenItem, type ApiTokenScope } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';

export const API_TOKEN_SCOPE_LABELS: Record<ApiTokenScope, string> = {
  'gates:read': '查询门禁判定',
  'eval-plans:trigger': '触发评估计划',
  'eval-tasks:read': '导出评估任务结果',
};

const STATUS_LABEL: Record<
  ApiTokenItem['status'],
  { text: string; tone: 'success' | 'neutral' | 'warning' }
> = {
  ACTIVE: { text: '有效', tone: 'success' },
  EXPIRED: { text: '已过期', tone: 'warning' },
  REVOKED: { text: '已吊销', tone: 'neutral' },
};

const EXPIRY_OPTIONS = [7, 30, 90, 180, 365];

function CreateTokenModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiTokenScope[]>(['gates:read']);
  const [days, setDays] = useState(90);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => api.apiTokens.create({ name: name.trim(), scopes, expiresInDays: days }),
    onSuccess: (res) => {
      setName('');
      setScopes(['gates:read']);
      setError(null);
      onCreated(res.token);
    },
    onError: (e: Error) => setError(e.message),
  });
  const toggle = (s: ApiTokenScope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  const canSubmit = name.trim().length > 0 && scopes.length > 0 && !mutation.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建 API 令牌"
      description="令牌用于 CI 等系统调用，只能访问所选权限范围内的接口。"
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
        <Field label="名称" htmlFor="api-token-name" required>
          <Input
            id="api-token-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：GitLab 发布流水线"
          />
        </Field>
        <Field label="权限范围" required>
          <div className="flex flex-col gap-2">
            {(Object.keys(API_TOKEN_SCOPE_LABELS) as ApiTokenScope[]).map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                {API_TOKEN_SCOPE_LABELS[s]}
                <span className="font-mono text-xs text-ink-3">{s}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="有效期" htmlFor="api-token-expiry" required>
          <Select
            id="api-token-expiry"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {EXPIRY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} 天
              </option>
            ))}
          </Select>
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function PlainTokenModal({ token, onClose }: { token: string | null; onClose: () => void }) {
  const { success, error } = useToast();
  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      success('已复制到剪贴板');
    } catch {
      error('复制失败，请手动选中复制');
    }
  };
  return (
    <Modal
      open={token !== null}
      onClose={onClose}
      title="令牌已创建"
      description="明文令牌只显示这一次，关闭后无法再次查看，请立即保存到 CI 的密文变量中。"
      footer={
        <>
          <Button variant="outline" onClick={copy}>
            复制
          </Button>
          <Button onClick={onClose}>我已保存</Button>
        </>
      }
    >
      <code
        data-testid="plain-token"
        className="block select-all break-all rounded border border-line bg-canvas p-3 font-mono text-sm text-ink"
      >
        {token}
      </code>
    </Modal>
  );
}

export function ApiTokensPage() {
  const { user } = useAuth();
  const isAdmin = Boolean(
    user?.roles.includes('admin') || user?.roles.includes('tenant_admin'),
  );
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [creating, setCreating] = useState(false);
  const [plain, setPlain] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['api-tokens'],
    queryFn: () => api.apiTokens.list(),
    enabled: isAdmin,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.apiTokens.revoke(id),
    onSuccess: () => {
      success('令牌已吊销');
      void queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (e: Error) => toastError(e.message),
  });

  if (!isAdmin) {
    return (
      <div>
        <PageHeader title="API 令牌" />
        <EmptyState title="仅管理员可管理 API 令牌" />
      </div>
    );
  }

  const items = data?.items ?? [];
  return (
    <div>
      <PageHeader
        title="API 令牌"
        description="供 CI 调用触发评估计划、查询上线门禁；令牌只保存哈希，明文仅在创建时显示一次。"
        actions={<Button onClick={() => setCreating(true)}>新建令牌</Button>}
      />
      <div>
        {isLoading ? (
          <LoadingBlock />
        ) : error ? (
          <p className="p-4 text-sm text-severity-critical">{(error as Error).message}</p>
        ) : items.length === 0 ? (
          <EmptyState title="暂无数据" description="还没有创建 API 令牌。" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>名称</TH>
                <TH>令牌</TH>
                <TH>权限范围</TH>
                <TH>状态</TH>
                <TH>过期时间</TH>
                <TH>最近使用</TH>
                <TH>创建人</TH>
                <TH>操作</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((t) => (
                <TR key={t.id} className="h-12">
                  <TD data-label="名称">{t.name}</TD>
                  <TD data-label="令牌" className="font-mono text-xs">
                    {t.maskedToken}
                  </TD>
                  <TD data-label="权限范围">
                    {t.scopes.map((s) => API_TOKEN_SCOPE_LABELS[s] ?? s).join('、')}
                  </TD>
                  <TD data-label="状态">
                    <Badge icon tone={STATUS_LABEL[t.status].tone}>
                      {STATUS_LABEL[t.status].text}
                    </Badge>
                  </TD>
                  <TD data-label="过期时间">{formatDateTime(t.expiresAt)}</TD>
                  <TD data-label="最近使用">{formatDateTime(t.lastUsedAt)}</TD>
                  <TD data-label="创建人">{t.createdByName ?? '—'}</TD>
                  <TD data-label="操作">
                    {t.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        className="text-sm text-severity-critical hover:underline"
                        disabled={revoke.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `确认吊销令牌「${t.name}」？吊销后使用该令牌的调用将立即失败。`,
                            )
                          ) {
                            revoke.mutate(t.id);
                          }
                        }}
                      >
                        吊销
                      </button>
                    ) : (
                      <span className="text-sm text-ink-3">—</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
      <CreateTokenModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(token) => {
          setCreating(false);
          setPlain(token);
          void queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
        }}
      />
      <PlainTokenModal token={plain} onClose={() => setPlain(null)} />
    </div>
  );
}
