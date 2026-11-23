import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, KeyRound, UserCog, AlertTriangle } from 'lucide-react';
import { api, ApiError, type PasswordPolicy, type User } from '@/lib/api';
import { DEFAULT_PASSWORD_POLICY, passwordSatisfies } from '@/lib/password-policy';
import { SensitiveValue } from '@/components/SensitiveText';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDateTime } from '@/lib/format';
import { roleLabel } from '@/lib/roles';
import { TenantCell, TenantFilterSelect, useTenantView } from '@/lib/tenant-view';
import { flattenOrgTree, organizationApi } from '@/lib/organizations';

interface FormState {
  username: string;
  password: string;
  displayName: string;
  email: string;
  isActive: boolean;
  roleIds: string[];
  /** 所属组织，空串表示未分配 */
  organizationId: string;
}

const EMPTY: FormState = {
  username: '',
  password: '',
  displayName: '',
  email: '',
  isActive: true,
  roleIds: [],
  organizationId: '',
};

/** 自助注册还没审核通过（待审核、已拒绝）：只能走审核启用。 */
function inReview(u: User): boolean {
  return u.registrationStatus === 'PENDING' || u.registrationStatus === 'REJECTED';
}

/** 把安全设置里的密码要求写成一句话，如「至少 10 位，含大写字母、数字」。 */
function passwordRequirementText(policy: PasswordPolicy): string {
  const extras = [
    policy.passwordRequireUppercase && '大写字母',
    policy.passwordRequireLowercase && '小写字母',
    policy.passwordRequireDigit && '数字',
    policy.passwordRequireSpecial && '特殊字符',
  ].filter(Boolean);
  return `至少 ${policy.passwordMinLength} 位${extras.length ? `，含${extras.join('、')}` : ''}`;
}

interface UsersPageProps {
  /** 嵌入「用户与权限」页时隐藏自己的页面标题头，只保留操作按钮。 */
  embedded?: boolean;
}

export function UsersPage({ embedded = false }: UsersPageProps = {}) {
  const { hasPermission } = useAuth();
  const { isAllTenants, listParams, tenantFilter, guardCreate, guardRow } = useTenantView();
  const { success, error: toastError } = useToast();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [resetUser, setResetUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [orgFilter, setOrgFilter] = useState('');
  // 换了租户筛选：原来选的组织不在新范围里，清掉组织筛选、回到第 1 页。
  // 在渲染时比对上一次的租户（不用 effect），不会先带着旧组织去查一次新租户。
  const [orgFilterTenant, setOrgFilterTenant] = useState(tenantFilter);
  if (orgFilterTenant !== tenantFilter) {
    setOrgFilterTenant(tenantFilter);
    setOrgFilter('');
    setPage(1);
  }
  const [approving, setApproving] = useState<User | null>(null);
  const [approveRoleIds, setApproveRoleIds] = useState<string[]>([]);

  const canCreate = hasPermission('user:create');
  const canUpdate = hasPermission('user:update');
  const canDelete = hasPermission('user:delete');
  const canReset = hasPermission('user:reset_password');
  const canReadOrg = hasPermission('org:read');

  const listQuery = useQuery({
    queryKey: ['users', page, search, tenantFilter, pendingOnly, orgFilter],
    queryFn: () =>
      api.users.list({
        page,
        pageSize: 10,
        keyword: search || undefined,
        registrationStatus: pendingOnly ? 'PENDING' : undefined,
        // 按组织筛选时连同下级组织的成员一起列出
        organizationId: orgFilter || undefined,
        includeDescendants: orgFilter ? true : undefined,
        ...listParams,
      }),
  });
  // 组织：普通视角是本租户的树（筛选和编辑框都用）；全部租户视角按租户分组，只用于筛选。
  const orgQuery = useQuery({
    queryKey: ['organizations', 'tree', tenantFilter],
    queryFn: () => organizationApi.tree(listParams),
    enabled: canReadOrg,
  });
  const orgOptions = orgQuery.data?.items ? flattenOrgTree(orgQuery.data.items) : [];
  const orgGroups = (orgQuery.data?.groups ?? [])
    .map((g) => ({ ...g, options: flattenOrgTree(g.items) }))
    .filter((g) => g.options.length > 0);
  const pendingQuery = useQuery({
    queryKey: ['users', 'pending-count', tenantFilter],
    queryFn: () =>
      api.users.list({ page: 1, pageSize: 1, registrationStatus: 'PENDING', ...listParams }),
  });
  const pendingCount = pendingQuery.data?.total ?? 0;
  // 全部租户视角下，行操作先进入该行所属租户，再停留在用户与权限页。
  const rowAction = (u: User, fn: () => void) => {
    if (!guardRow(u.tenantId, '/users')) fn();
  };

  // 密码长度与强度取自「安全设置」（与改密码弹窗同一接口、同一缓存）；取不到时按默认值兜底。
  const policyQuery = useQuery({
    queryKey: ['auth', 'password-policy'],
    queryFn: () => api.passwordPolicy(),
    enabled: createOpen || !!resetUser,
  });
  const policy = policyQuery.data ?? DEFAULT_PASSWORD_POLICY;
  const passwordHint = passwordRequirementText(policy);

  const rolesQuery = useQuery({
    queryKey: ['roles', 'all'],
    queryFn: () => api.roles.list(),
  });
  const roles = rolesQuery.data?.items ?? [];

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['users'] });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api.users.create({
        username: form.username.trim(),
        password: form.password,
        displayName: form.displayName.trim(),
        email: form.email.trim() || undefined,
        isActive: form.isActive,
        roleIds: form.roleIds,
        organizationId: form.organizationId || undefined,
      }),
    onSuccess: () => {
      success('用户已创建');
      setCreateOpen(false);
      setForm(EMPTY);
      setConfirmPassword('');
      invalidate();
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '创建失败'),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      api.users.update(editing!.id, {
        displayName: form.displayName.trim(),
        email: form.email.trim() || null,
        // 待审核、已拒绝的账号只能走审核启用，编辑里不提交启用状态。
        ...(editing && inReview(editing) ? {} : { isActive: form.isActive }),
        roleIds: form.roleIds,
        // 组织只在改了时提交：没有组织权限或组织没加载出来时，不会把原有归属清掉。
        ...(editing && form.organizationId !== (editing.organizationId ?? '')
          ? { organizationId: form.organizationId || null }
          : {}),
      }),
    onSuccess: () => {
      success('用户已更新');
      setEditing(null);
      setForm(EMPTY);
      invalidate();
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '更新失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.users.remove(id),
    onSuccess: () => {
      success('用户已删除');
      invalidate();
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '删除失败'),
  });

  const reviewMutation = useMutation({
    mutationFn: (
      args: { id: string; action: 'approve'; roleIds: string[] } | { id: string; action: 'reject' },
    ) =>
      api.users.reviewRegistration(
        args.id,
        args.action === 'approve'
          ? { action: 'approve', roleIds: args.roleIds }
          : { action: 'reject' },
      ),
    onSuccess: (_res, args) => {
      success(args.action === 'approve' ? '已通过' : '已拒绝');
      setApproving(null);
      invalidate();
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '操作失败'),
  });

  const resetMutation = useMutation({
    mutationFn: () => api.users.resetPassword(resetUser!.id, newPassword),
    onSuccess: () => {
      success('密码已重置');
      setResetUser(null);
      setNewPassword('');
      setConfirmPassword('');
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '重置失败'),
  });

  function openCreate() {
    setForm(EMPTY);
    setConfirmPassword('');
    setCreateOpen(true);
  }

  function openEdit(u: User) {
    setForm({
      username: u.username,
      password: '',
      displayName: u.displayName,
      email: u.email ?? '',
      isActive: u.isActive,
      roleIds: u.roles.map((r) => r.id),
      organizationId: u.organizationId ?? '',
    });
    setEditing(u);
  }

  function toggleRole(id: string) {
    setForm((f) => ({
      ...f,
      roleIds: f.roleIds.includes(id) ? f.roleIds.filter((x) => x !== id) : [...f.roleIds, id],
    }));
  }

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;

  const RolePicker = (
    <Field label="角色" hint="角色决定账号可访问的页面与功能，可多选。">
      <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-md border border-border p-2">
        {roles.length === 0 ? (
          <span className="text-xs text-muted-foreground">暂无角色</span>
        ) : (
          roles.map((r) => {
            const on = form.roleIds.includes(r.id);
            return (
              <button
                type="button"
                key={r.id}
                onClick={() => toggleRole(r.id)}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  on
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground hover:bg-accent'
                }`}
              >
                {roleLabel(r.name)}
              </button>
            );
          })
        )}
      </div>
      {roles.length > 0 && form.roleIds.length === 0 ? (
        <p className="flex items-center gap-1 text-xs text-severity-high">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          未分配角色的账号登录后无可用功能，请至少选择一个角色。
        </p>
      ) : null}
    </Field>
  );

  const OrgPicker =
    canReadOrg && orgOptions.length > 0 ? (
      <Field label="组织" htmlFor="user-organization">
        <Select
          id="user-organization"
          value={form.organizationId}
          onChange={(e) => setForm((f) => ({ ...f, organizationId: e.target.value }))}
        >
          <option value="">未分配</option>
          {orgOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.path}
            </option>
          ))}
        </Select>
      </Field>
    ) : null;

  const createButton = canCreate ? (
    <Button onClick={() => guardCreate(openCreate)}>
      <Plus className="mr-1 h-4 w-4" />
      新建用户
    </Button>
  ) : null;

  return (
    <div className="space-y-5">
      {!embedded && (
        <PageHeader
          title="用户管理"
          description="登录账号、角色分配与密码重置"
          actions={createButton}
        />
      )}

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-white p-3 shadow-card">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(keyword.trim());
              setPage(1);
            }}
          >
            <Input
              placeholder="搜索用户名 / 姓名"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="w-72"
            />
            <Button type="submit" variant="outline">
              搜索
            </Button>
            <Button
              type="button"
              variant={pendingOnly ? 'primary' : 'outline'}
              aria-pressed={pendingOnly}
              onClick={() => {
                setPendingOnly((v) => !v);
                setPage(1);
              }}
            >
              待审核
              {pendingCount > 0 ? (
                <span className="ml-1.5 rounded-full bg-severity-medium-bg px-1.5 text-xs font-semibold text-severity-medium">
                  {pendingCount}
                </span>
              ) : null}
            </Button>
            {canReadOrg && (orgOptions.length > 0 || orgGroups.length > 0) ? (
              <Select
                aria-label="按组织筛选"
                value={orgFilter}
                onChange={(e) => {
                  setOrgFilter(e.target.value);
                  setPage(1);
                }}
                className="w-56"
              >
                <option value="">全部组织</option>
                {orgOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.path}
                  </option>
                ))}
                {orgGroups.map((g) => (
                  <optgroup key={g.tenantId} label={g.tenantName}>
                    {g.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.path}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            ) : null}
          </form>
          <TenantFilterSelect />
          {embedded && createButton}
        </div>

        {listQuery.isLoading ? (
          <LoadingBlock />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<UserCog className="h-6 w-6" />}
            title="暂无用户"
            description="点击右上角「新建用户」创建第一个登录账号。"
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  {isAllTenants && <TH>租户</TH>}
                  <TH>用户名</TH>
                  <TH>姓名</TH>
                  <TH>组织</TH>
                  <TH>邮箱</TH>
                  <TH>手机号</TH>
                  <TH>单位</TH>
                  <TH>角色</TH>
                  <TH>状态</TH>
                  <TH>最近登录</TH>
                  <TH className="w-[120px] text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((u) => (
                  <TR key={u.id}>
                    {isAllTenants && (
                      <TD data-label="租户">
                        <TenantCell tenantId={u.tenantId} />
                      </TD>
                    )}
                    <TD data-label="用户名" className="min-w-[160px] break-words font-mono text-xs">
                      {u.username}
                      {u.isBuiltin ? (
                        <Badge tone="info" className="ml-2">
                          内置
                        </Badge>
                      ) : null}
                    </TD>
                    <TD data-label="姓名" className="font-medium">
                      <SensitiveValue
                        kind="name"
                        value={u.displayName}
                        field="users.displayName"
                        targetType="user"
                        targetId={u.id}
                      />
                    </TD>
                    <TD data-label="组织" className="text-xs">
                      {u.organizationPath || '—'}
                    </TD>
                    <TD data-label="邮箱" className="text-xs">
                      <SensitiveValue
                        kind="email"
                        value={u.email}
                        field="users.email"
                        targetType="user"
                        targetId={u.id}
                      />
                    </TD>
                    <TD data-label="手机号" className="text-xs">
                      <SensitiveValue
                        kind="phone"
                        value={u.phone ?? null}
                        field="users.phone"
                        targetType="user"
                        targetId={u.id}
                      />
                    </TD>
                    <TD data-label="单位" className="text-xs">
                      {u.organization || '—'}
                    </TD>
                    <TD data-label="角色">
                      <div className="flex flex-wrap gap-1">
                        {u.roles.length === 0 ? (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-severity-high"
                            title="该账号登录后无可用功能，请通过「编辑」分配角色。"
                          >
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                            未分配角色
                          </span>
                        ) : (
                          u.roles.map((r) => (
                            <Badge key={r.id} tone="neutral">
                              {roleLabel(r.name)}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TD>
                    <TD data-label="状态">
                      <div className="flex flex-wrap gap-1">
                        {u.registrationStatus === 'PENDING' ? (
                          <Badge tone="warning" icon>
                            待审核
                          </Badge>
                        ) : u.registrationStatus === 'REJECTED' ? (
                          <Badge tone="danger" icon>
                            已拒绝
                          </Badge>
                        ) : null}
                        {u.isActive ? (
                          <Badge tone="success" icon>
                            启用
                          </Badge>
                        ) : !inReview(u) ? (
                          <Badge tone="danger" icon>
                            禁用
                          </Badge>
                        ) : null}
                      </div>
                    </TD>
                    <TD data-label="最近登录" className="text-muted-foreground">
                      {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '从未登录'}
                    </TD>
                    <TD data-label="操作" className="px-2 text-right">
                      <div className="flex flex-wrap justify-start gap-0.5 md:flex-nowrap md:justify-end">
                        {canUpdate && inReview(u) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="px-2 text-brand-700"
                            aria-label={`通过 ${u.username}`}
                            onClick={() =>
                              rowAction(u, () => {
                                setApproveRoleIds([]);
                                setApproving(u);
                              })
                            }
                          >
                            通过
                          </Button>
                        ) : null}
                        {canUpdate && u.registrationStatus === 'PENDING' ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="px-2 text-destructive"
                              aria-label={`拒绝 ${u.username}`}
                              onClick={() =>
                                rowAction(u, () => {
                                  if (confirm(`确认拒绝「${u.displayName}」的注册？`))
                                    reviewMutation.mutate({ id: u.id, action: 'reject' });
                                })
                              }
                            >
                              拒绝
                            </Button>
                          </>
                        ) : null}
                        {canUpdate && u.registrationStatus !== 'PENDING' ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-brand-700"
                            title="编辑"
                            aria-label={`编辑 ${u.username}`}
                            onClick={() => rowAction(u, () => openEdit(u))}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canReset && u.registrationStatus !== 'PENDING' ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="重置密码"
                            aria-label={`重置密码 ${u.username}`}
                            onClick={() =>
                              rowAction(u, () => {
                                setNewPassword('');
                                setConfirmPassword('');
                                setResetUser(u);
                              })
                            }
                          >
                            <KeyRound className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canDelete && !u.isBuiltin ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="删除"
                            aria-label={`删除 ${u.username}`}
                            onClick={() =>
                              rowAction(u, () => {
                                if (confirm(`确认删除用户「${u.displayName}」？`))
                                  deleteMutation.mutate(u.id);
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        ) : canDelete ? (
                          <span aria-hidden className="hidden h-8 w-8 md:inline-block" />
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={10} total={total} onPageChange={setPage} />
          </>
        )}
      </div>

      <Modal
        open={!!approving}
        onClose={() => setApproving(null)}
        title="通过注册"
        footer={
          <>
            <Button variant="ghost" onClick={() => setApproving(null)}>
              取消
            </Button>
            <Button
              onClick={() =>
                reviewMutation.mutate({
                  id: approving!.id,
                  action: 'approve',
                  roleIds: approveRoleIds,
                })
              }
              disabled={reviewMutation.isPending}
            >
              通过
            </Button>
          </>
        }
      >
        <Field label="角色">
          <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-md border border-border p-2">
            {roles.map((r) => {
              const on = approveRoleIds.includes(r.id);
              return (
                <button
                  type="button"
                  key={r.id}
                  aria-pressed={on}
                  onClick={() =>
                    setApproveRoleIds((ids) =>
                      ids.includes(r.id) ? ids.filter((x) => x !== r.id) : [...ids, r.id],
                    )
                  }
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {roleLabel(r.name)}
                </button>
              );
            })}
          </div>
          {approveRoleIds.length === 0 ? (
            <p className="flex items-center gap-1 text-xs text-severity-high">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              未分配角色的账号登录后无可用功能。
            </p>
          ) : null}
        </Field>
      </Modal>

      {/* Create */}
      <Modal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setConfirmPassword('');
        }}
        title="新建用户"
        size="lg"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setCreateOpen(false);
                setConfirmPassword('');
              }}
            >
              取消
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={
                createMutation.isPending ||
                form.username.trim().length < 3 ||
                !passwordSatisfies(form.password, policy) ||
                form.password !== confirmPassword ||
                !form.displayName.trim()
              }
            >
              创建
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="用户名" required hint="字母、数字、_ . -，至少 3 位">
              <Input
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="如 zhangsan"
              />
            </Field>
            <Field label="初始密码" htmlFor="user-create-password" required hint={passwordHint}>
              <Input
                id="user-create-password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="确认初始密码"
              htmlFor="user-create-confirm"
              required
              error={
                confirmPassword.length > 0 && form.password !== confirmPassword
                  ? '两次输入的密码不一致'
                  : undefined
              }
            >
              <Input
                id="user-create-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </Field>
            <div />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="姓名" htmlFor="user-create-display-name" required>
              <Input
                id="user-create-display-name"
                value={form.displayName}
                onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              />
            </Field>
            <Field label="邮箱">
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </Field>
          </div>
          {OrgPicker}
          {RolePicker}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            />
            启用账号
          </label>
        </div>
      </Modal>

      {/* Edit */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `编辑用户：${editing.username}` : '编辑用户'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending || !form.displayName.trim()}
            >
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="姓名" required>
            <Input
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
            />
          </Field>
          <Field label="邮箱">
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </Field>
          {OrgPicker}
          {RolePicker}
          {editing && !inReview(editing) ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                disabled={editing.isBuiltin}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              启用账号
              {editing.isBuiltin ? (
                <span className="text-xs text-muted-foreground">（内置用户不可禁用）</span>
              ) : null}
            </label>
          ) : null}
        </div>
      </Modal>

      {/* Reset password */}
      <Modal
        open={!!resetUser}
        onClose={() => {
          setResetUser(null);
          setConfirmPassword('');
        }}
        title={resetUser ? `重置密码：${resetUser.displayName}` : '重置密码'}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setResetUser(null);
                setConfirmPassword('');
              }}
            >
              取消
            </Button>
            <Button
              onClick={() => resetMutation.mutate()}
              disabled={
                resetMutation.isPending ||
                !passwordSatisfies(newPassword, policy) ||
                newPassword !== confirmPassword
              }
            >
              确认重置
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="新密码" htmlFor="user-reset-password" required hint={passwordHint}>
            <Input
              id="user-reset-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
          <Field
            label="确认新密码"
            htmlFor="user-reset-confirm"
            required
            error={
              confirmPassword.length > 0 && newPassword !== confirmPassword
                ? '两次输入的密码不一致'
                : undefined
            }
          >
            <Input
              id="user-reset-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
