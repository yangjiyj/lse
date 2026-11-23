import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@lse/shared';
import { Plus, Pencil, Trash2, ShieldCheck } from 'lucide-react';
import { api, ApiError, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { roleLabel } from '@/lib/roles';
import { DetailDrawer } from '@/components/fleet/DetailDrawer';

interface FormState {
  name: string;
  description: string;
  permissions: string[];
}

const EMPTY: FormState = { name: '', description: '', permissions: [] };

const BUILTIN_ROLE_DESCRIPTIONS: Record<string, string> = {
  admin: '平台管理员，拥有全部系统权限，可管理租户。',
  tenant_admin: '租户管理员，管理本租户的用户和全部评估业务。',
  operator: '评估操作员，负责评估对象、样本库、任务和报告管理。',
  auditor: '审计员，可只读查看并下载报告、导出风险样本和查阅操作日志。',
};

interface PermissionCatalogGroup {
  group: string;
  items: Array<{ code: string; name: string }>;
}

const PERMISSION_DEFS_BY_CODE = new Map(
  PERMISSIONS.map((permission) => [permission.code, permission]),
);

/** 前端已下线的功能（检测方案）：权限仍在库里，角色编辑时不再列出，已有授权原样保留。 */
const HIDDEN_PERMISSION_CODES = new Set(['scheme:read', 'scheme:manage']);

function canonicalizePermissionGroups(groups: PermissionCatalogGroup[]): PermissionCatalogGroup[] {
  const normalized = new Map<string, PermissionCatalogGroup['items']>();
  for (const group of groups) {
    for (const item of group.items) {
      if (HIDDEN_PERMISSION_CODES.has(item.code)) continue;
      const definition = PERMISSION_DEFS_BY_CODE.get(item.code);
      const groupName = definition?.group ?? group.group;
      const items = normalized.get(groupName) ?? [];
      items.push({ code: item.code, name: definition?.name ?? item.name });
      normalized.set(groupName, items);
    }
  }
  return Array.from(normalized, ([group, items]) => ({ group, items }));
}

function roleDescription(role: Role): string {
  return role.isBuiltin
    ? (BUILTIN_ROLE_DESCRIPTIONS[role.name] ?? role.description ?? '')
    : (role.description ?? '');
}

function RoleUsersDrawer({ role, onClose }: { role: Role; onClose: () => void }) {
  const query = useQuery({
    queryKey: ['roles', role.id, 'users'],
    queryFn: () => api.roles.users(role.id),
  });
  const users = query.data?.items ?? [];
  const multiTenant = new Set(users.map((u) => u.tenantName)).size > 1;
  return (
    <DetailDrawer title={roleLabel(role.name)} onClose={onClose}>
      {query.isLoading ? (
        <LoadingBlock />
      ) : query.isError ? (
        <p role="alert">加载失败，请稍后重试</p>
      ) : users.length === 0 ? (
        <p className="text-muted-foreground">暂无用户</p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {users.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="font-medium text-ink">{u.displayName}</div>
                  <div className="break-all text-xs text-ink-3">{u.username}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-ink-3">
                  {multiTenant ? <span>{u.tenantName}</span> : null}
                  {u.isActive ? null : <Badge tone="neutral">禁用</Badge>}
                </div>
              </li>
            ))}
          </ul>
          {query.data?.truncated ? (
            <p className="pt-3 text-xs text-ink-3">仅显示前 500 人</p>
          ) : null}
        </>
      )}
    </DetailDrawer>
  );
}

interface RolesPageProps {
  /** 嵌入「用户与权限」页时隐藏自己的页面标题头，只保留操作按钮。 */
  embedded?: boolean;
}

export function RolesPage({ embedded = false }: RolesPageProps = {}) {
  const { hasPermission } = useAuth();
  const { success, error: toastError } = useToast();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [usersOf, setUsersOf] = useState<Role | null>(null);
  const closeUsers = useCallback(() => setUsersOf(null), []);

  const canCreate = hasPermission('role:create');
  const canUpdate = hasPermission('role:update');
  const canDelete = hasPermission('role:delete');

  const listQuery = useQuery({
    queryKey: ['roles', 'all'],
    queryFn: () => api.roles.list(),
  });

  const catalogQuery = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api.permissions(),
  });
  const groups = canonicalizePermissionGroups(catalogQuery.data?.groups ?? []);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['roles'] });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api.roles.create({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        permissions: form.permissions,
      }),
    onSuccess: () => {
      success('角色已创建');
      setCreateOpen(false);
      setForm(EMPTY);
      invalidate();
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '创建失败'),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      api.roles.update(editing!.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        permissions: form.permissions,
      }),
    onSuccess: () => {
      success('角色已更新');
      setEditing(null);
      setForm(EMPTY);
      invalidate();
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '更新失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.roles.remove(id),
    onSuccess: () => {
      success('角色已删除');
      invalidate();
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '删除失败'),
  });

  function openCreate() {
    setForm(EMPTY);
    setCreateOpen(true);
  }

  function openEdit(r: Role) {
    setForm({
      name: r.name,
      description: roleDescription(r),
      permissions: [...r.permissions],
    });
    setEditing(r);
  }

  function togglePermission(code: string) {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(code)
        ? f.permissions.filter((x) => x !== code)
        : [...f.permissions, code],
    }));
  }

  function toggleGroup(codes: string[], allOn: boolean) {
    setForm((f) => ({
      ...f,
      permissions: allOn
        ? f.permissions.filter((x) => !codes.includes(x))
        : Array.from(new Set([...f.permissions, ...codes])),
    }));
  }

  const items = listQuery.data?.items ?? [];

  const PermissionPicker = (
    <Field
      label="权限"
      hint={`已选 ${form.permissions.filter((code) => !HIDDEN_PERMISSION_CODES.has(code)).length} 项`}
    >
      <div className="max-h-80 space-y-4 overflow-y-auto rounded-md border border-border p-3">
        {groups.length === 0 ? (
          <span className="text-xs text-muted-foreground">权限目录加载中…</span>
        ) : (
          groups.map((g) => {
            const codes = g.items.map((i) => i.code);
            const allOn = codes.every((c) => form.permissions.includes(c));
            const someOn = codes.some((c) => form.permissions.includes(c));
            return (
              <div key={g.group}>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold">{g.group}</span>
                  <button
                    type="button"
                    onClick={() => toggleGroup(codes, allOn)}
                    className="text-xs text-primary hover:underline"
                  >
                    {allOn ? '取消全选' : someOn ? '全选本组' : '全选本组'}
                  </button>
                </div>
                <div
                  data-testid="permission-option-grid"
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                >
                  {g.items.map((item) => {
                    const on = form.permissions.includes(item.code);
                    return (
                      <label
                        key={item.code}
                        title={`权限标识：${item.code}`}
                        className="flex cursor-pointer items-center gap-2 rounded border border-transparent px-2 py-2 text-sm leading-5 hover:bg-accent"
                      >
                        <input
                          type="checkbox"
                          aria-label={item.name}
                          className="shrink-0"
                          checked={on}
                          onChange={() => togglePermission(item.code)}
                        />
                        <span className="min-w-0 flex-1 font-medium text-ink">{item.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Field>
  );

  const dialogBody = (
    <div className="space-y-4">
      <Field label="角色名称" required hint="2–64 个字符">
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="如 安全分析员"
        />
      </Field>
      <Field label="描述">
        <Textarea
          rows={2}
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="该角色的职责说明（可选）"
        />
      </Field>
      {PermissionPicker}
    </div>
  );

  return (
    <div className="space-y-6">
      {embedded ? (
        canCreate ? (
          <div className="mb-4 flex justify-end">
            <Button onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              新建角色
            </Button>
          </div>
        ) : null
      ) : (
        <PageHeader
          title="角色管理"
          description="角色与权限定义"
          actions={
            canCreate ? (
              <Button onClick={openCreate}>
                <Plus className="mr-1 h-4 w-4" />
                新建角色
              </Button>
            ) : null
          }
        />
      )}

      <Card>
        <CardContent className="p-0">
          {listQuery.isLoading ? (
            <LoadingBlock />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck className="h-6 w-6" />}
              title="暂无角色"
              description="点击右上角「新建角色」创建第一个角色。"
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>角色名称</TH>
                  <TH>描述</TH>
                  <TH>权限数</TH>
                  <TH>用户数</TH>
                  <TH className="text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((r) => (
                  <TR key={r.id}>
                    <TD data-label="角色名称" className="font-medium">
                      {roleLabel(r.name)}
                      {r.isBuiltin ? (
                        <Badge tone="info" className="ml-2">
                          内置
                        </Badge>
                      ) : null}
                    </TD>
                    <TD data-label="描述" className="text-muted-foreground">
                      {roleDescription(r) || '—'}
                    </TD>
                    <TD data-label="权限数">
                      <Badge tone="neutral">{r.permissions.length}</Badge>
                    </TD>
                    <TD data-label="用户数">
                      {r.userCount > 0 ? (
                        <button
                          type="button"
                          aria-label={`${roleLabel(r.name)}的用户（${r.userCount}）`}
                          className="text-primary hover:underline"
                          onClick={() => setUsersOf(r)}
                        >
                          {r.userCount}
                        </button>
                      ) : (
                        r.userCount
                      )}
                    </TD>
                    <TD data-label="操作" className="text-right">
                      <div className="flex flex-wrap justify-start gap-1 md:justify-end">
                        {canUpdate ? (
                          <Button variant="ghost" size="sm" onClick={() => openEdit(r)}>
                            <Pencil className="mr-1 h-4 w-4" />
                            编辑
                          </Button>
                        ) : null}
                        {canDelete && !r.isBuiltin ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (confirm(`确认删除角色「${roleLabel(r.name)}」？`))
                                deleteMutation.mutate(r.id);
                            }}
                          >
                            <Trash2 className="mr-1 h-4 w-4 text-destructive" />
                            删除
                          </Button>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建角色"
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || form.name.trim().length < 2}
            >
              创建
            </Button>
          </>
        }
      >
        {dialogBody}
      </Modal>

      {/* Edit */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `编辑角色：${roleLabel(editing.name)}` : '编辑角色'}
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending || form.name.trim().length < 2}
            >
              保存
            </Button>
          </>
        }
      >
        {editing?.isBuiltin ? (
          <p className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            内置角色的权限通常由系统维护，请谨慎修改。
          </p>
        ) : null}
        {dialogBody}
      </Modal>

      {usersOf ? <RoleUsersDrawer role={usersOf} onClose={closeUsers} /> : null}
    </div>
  );
}
