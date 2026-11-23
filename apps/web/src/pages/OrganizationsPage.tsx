import { useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FolderInput, Pencil, Plus, Trash2 } from 'lucide-react';
import { orgMoveProblem } from '@lse/shared';
import {
  MAX_ORG_DEPTH,
  ORG_PATH_SEPARATOR,
  flattenOrgTree,
  orgTreeOf,
  organizationApi,
  type OrgNode,
} from '@/lib/organizations';
import { useAuth } from '@/lib/auth';
import { TenantFilterSelect, useTenantView } from '@/lib/tenant-view';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { SensitiveValue } from '@/components/SensitiveText';
import { Card } from '@/components/ui/card';
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
import { useToast } from '@/components/ui/toast';

const QUERY_KEY = ['organizations'] as const;
const PAGE_SIZE = 10;
const INDENT_BASE = 8;
const INDENT_STEP = 16;

/** 一棵树：普通视角只有一棵；「全部租户」视角每个租户一棵。 */
interface Section {
  tenantId: string | null;
  tenantName: string | null;
  items: OrgNode[];
}

interface Entry {
  node: OrgNode;
  path: string;
  level: number;
  section: Section;
}

type ModalState =
  | { kind: 'create'; parent: OrgNode | null }
  | { kind: 'rename'; node: OrgNode }
  | { kind: 'move'; node: OrgNode; section: Section };

function indexNodes(
  nodes: OrgNode[],
  section: Section,
  out: Map<string, Entry>,
  parentPath = '',
  level = 1,
): void {
  for (const node of nodes) {
    const path = parentPath ? `${parentPath}${ORG_PATH_SEPARATOR}${node.name}` : node.name;
    out.set(node.id, { node, path, level, section });
    indexNodes(node.children, section, out, path, level + 1);
  }
}

function visibleRows(
  nodes: OrgNode[],
  collapsed: Set<string>,
  level = 1,
): { node: OrgNode; level: number }[] {
  return nodes.flatMap((node) => [
    { node, level },
    ...(collapsed.has(node.id) ? [] : visibleRows(node.children, collapsed, level + 1)),
  ]);
}

function IconAction({
  label,
  title,
  icon: Icon,
  danger,
  disabled,
  onClick,
}: {
  label: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className={cn('h-4 w-4', danger && 'text-destructive')} />
    </Button>
  );
}

function OrgTree({
  label,
  items,
  collapsed,
  selectedId,
  canManage,
  onToggle,
  onSelect,
  onAction,
}: {
  label: string;
  items: OrgNode[];
  collapsed: Set<string>;
  selectedId: string | null;
  canManage: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onAction: (kind: 'create' | 'rename' | 'move' | 'delete', node: OrgNode) => void;
}) {
  return (
    <div role="tree" aria-label={label} className="flex flex-col gap-0.5">
      {visibleRows(items, collapsed).map(({ node, level }) => {
        const active = node.id === selectedId;
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(node.id);
        return (
          <div
            key={node.id}
            role="treeitem"
            aria-level={level}
            aria-selected={active}
            aria-expanded={hasChildren ? !isCollapsed : undefined}
            className={cn(
              'flex h-9 items-center gap-1 rounded-[10px] pr-1 transition-colors',
              active ? 'bg-brand-50 text-brand-700' : 'text-ink-2 hover:bg-slate-100',
            )}
            style={{ paddingLeft: INDENT_BASE + (level - 1) * INDENT_STEP }}
          >
            {hasChildren ? (
              <button
                type="button"
                aria-label={`${isCollapsed ? '展开' : '折叠'} ${node.name}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-slate-200"
                onClick={() => onToggle(node.id)}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>
            ) : (
              <span aria-hidden className="h-6 w-6 shrink-0" />
            )}
            <button
              type="button"
              title={node.name}
              className={cn(
                'min-w-0 flex-1 truncate text-left text-[14px]',
                active && 'font-semibold',
              )}
              onClick={() => onSelect(node.id)}
            >
              {node.name}
            </button>
            {node.memberCount > 0 && (
              <span className="shrink-0 px-1 text-xs tabular-nums text-ink-3">
                {node.memberCount}
              </span>
            )}
            {active && canManage && (
              <span className="flex shrink-0 items-center">
                <IconAction
                  label={`新增下级 ${node.name}`}
                  title={level >= MAX_ORG_DEPTH ? `最多 ${MAX_ORG_DEPTH} 级` : '新增下级'}
                  icon={Plus}
                  disabled={level >= MAX_ORG_DEPTH}
                  onClick={() => onAction('create', node)}
                />
                <IconAction
                  label={`改名 ${node.name}`}
                  title="改名"
                  icon={Pencil}
                  onClick={() => onAction('rename', node)}
                />
                <IconAction
                  label={`移动 ${node.name}`}
                  title="移动"
                  icon={FolderInput}
                  onClick={() => onAction('move', node)}
                />
                <IconAction
                  label={`删除 ${node.name}`}
                  title="删除"
                  icon={Trash2}
                  danger
                  onClick={() => onAction('delete', node)}
                />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NameModal({
  title,
  initial,
  save,
  onClose,
  onSaved,
}: {
  title: string;
  initial: { name: string; sort: number };
  save: (body: { name: string; sort: number }) => Promise<OrgNode>;
  onClose: () => void;
  onSaved: (saved: OrgNode) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [sort, setSort] = useState(String(initial.sort));
  const [error, setError] = useState<string | null>(null);
  const sortValid = /^\d{1,5}$/.test(sort.trim());
  const mutation = useMutation({
    mutationFn: () => save({ name: name.trim(), sort: Number(sort.trim()) }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!name.trim() || !sortValid || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="名称" htmlFor="org-name" required>
          <Input
            id="org-name"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="排序" htmlFor="org-sort" hint="同一上级下数字小的排在前面">
          <Input
            id="org-sort"
            inputMode="numeric"
            value={sort}
            maxLength={5}
            onChange={(e) => setSort(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function MoveModal({
  node,
  section,
  onClose,
  onSaved,
}: {
  node: OrgNode;
  section: Section;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [parentId, setParentId] = useState(node.parentId ?? '');
  const [error, setError] = useState<string | null>(null);
  // 与后端同一套校验：不能移到自己或下级下面，目标层级 + 子树高度不超过 MAX_ORG_DEPTH
  const tree = orgTreeOf(section.items);
  const options = flattenOrgTree(section.items).filter(
    (o) => orgMoveProblem(tree, node.id, o.id) === null,
  );
  const mutation = useMutation({
    mutationFn: () => organizationApi.update(node.id, { parentId: parentId || null }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`移动：${node.name}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={parentId === (node.parentId ?? '') || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="上级组织" htmlFor="org-parent">
          <Select id="org-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">顶级</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.path}
              </option>
            ))}
          </Select>
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

export function OrganizationsPage() {
  const { hasPermission } = useAuth();
  const { isAllTenants, listParams, tenantFilter } = useTenantView();
  // 组织树按租户区分：「全部租户」视角只读，写操作要先进入具体租户。
  const canManage = hasPermission('org:manage') && !isAllTenants;
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<ModalState | null>(null);

  const treeQuery = useQuery({
    queryKey: [...QUERY_KEY, 'tree', tenantFilter],
    queryFn: () => organizationApi.tree(listParams),
  });
  const sections = useMemo<Section[]>(() => {
    const data = treeQuery.data;
    if (!data) return [];
    if (data.groups) {
      return data.groups.map((g) => ({
        tenantId: g.tenantId,
        tenantName: g.tenantName,
        items: g.items,
      }));
    }
    return [{ tenantId: null, tenantName: null, items: data.items ?? [] }];
  }, [treeQuery.data]);
  const index = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const section of sections) indexNodes(section.items, section, map);
    return map;
  }, [sections]);
  const firstId = sections.find((s) => s.items.length > 0)?.items[0]?.id ?? null;
  const selected = index.get(selectedId ?? '') ?? (firstId ? index.get(firstId) : undefined);

  const membersQuery = useQuery({
    queryKey: [...QUERY_KEY, 'members', selected?.node.id, includeDescendants, page],
    queryFn: () =>
      organizationApi.members(selected!.node.id, { includeDescendants, page, pageSize: PAGE_SIZE }),
    enabled: Boolean(selected),
  });
  const members = membersQuery.data?.items ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const removeMutation = useMutation({
    mutationFn: (node: OrgNode) => organizationApi.remove(node.id),
    onSuccess: () => {
      success('已删除');
      setSelectedId(null);
      refresh();
    },
    onError: (e: Error) => toastError(e.message),
  });

  const select = (id: string) => {
    setSelectedId(id);
    setPage(1);
  };
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const onAction = (kind: 'create' | 'rename' | 'move' | 'delete', node: OrgNode) => {
    const entry = index.get(node.id);
    if (!entry) return;
    if (kind === 'create') setModal({ kind: 'create', parent: node });
    else if (kind === 'rename') setModal({ kind: 'rename', node });
    else if (kind === 'move') setModal({ kind: 'move', node, section: entry.section });
    else if (window.confirm(`删除组织「${node.name}」？`)) removeMutation.mutate(node);
  };
  const onSaved = (saved?: OrgNode) => {
    success('已保存');
    setModal(null);
    // 新建的下级要看得见：展开它的上级。
    const parentId = saved?.parentId;
    if (parentId) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
    refresh();
  };

  return (
    <div>
      <PageHeader
        title="组织架构"
        actions={
          <>
            <TenantFilterSelect />
            {canManage && (
              <Button onClick={() => setModal({ kind: 'create', parent: null })}>
                <Plus className="mr-1 h-4 w-4" />
                新建组织
              </Button>
            )}
          </>
        }
      />
      {treeQuery.isLoading ? (
        <LoadingBlock />
      ) : treeQuery.error ? (
        <p className="p-4 text-sm text-severity-critical">{(treeQuery.error as Error).message}</p>
      ) : index.size === 0 ? (
        <EmptyState title="暂无组织" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="h-fit p-2">
            {sections
              .filter((s) => s.items.length > 0)
              .map((section) => (
                <div key={section.tenantId ?? 'own'} className="flex flex-col">
                  {section.tenantName && (
                    <div className="px-2 pb-1 pt-2 text-xs font-medium text-ink-3">
                      {section.tenantName}
                    </div>
                  )}
                  <OrgTree
                    label={section.tenantName ?? '组织架构'}
                    items={section.items}
                    collapsed={collapsed}
                    selectedId={selected?.node.id ?? null}
                    canManage={canManage}
                    onToggle={toggle}
                    onSelect={select}
                    onAction={onAction}
                  />
                </div>
              ))}
          </Card>
          {selected && (
            <SectionCard
              title={selected.path}
              bodyClassName="p-0"
              extra={
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    checked={includeDescendants}
                    onChange={(e) => {
                      setIncludeDescendants(e.target.checked);
                      setPage(1);
                    }}
                  />
                  含下级组织
                </label>
              }
            >
              {membersQuery.isLoading ? (
                <LoadingBlock />
              ) : members.length === 0 ? (
                <EmptyState title="暂无成员" />
              ) : (
                <div className="px-6 pb-4">
                  <Table>
                    <THead>
                      <TR>
                        <TH>用户名</TH>
                        <TH>姓名</TH>
                        {includeDescendants && <TH>组织</TH>}
                        <TH>状态</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {members.map((m) => (
                        <TR key={m.id}>
                          <TD data-label="用户名" className="font-mono text-xs">
                            {m.username}
                          </TD>
                          <TD data-label="姓名">
                            <SensitiveValue
                              kind="name"
                              value={m.displayName}
                              field="users.displayName"
                              targetType="user"
                              targetId={m.id}
                            />
                          </TD>
                          {includeDescendants && (
                            <TD data-label="组织" className="text-xs">
                              {m.organizationPath ?? '—'}
                            </TD>
                          )}
                          <TD data-label="状态">
                            <Badge icon tone={m.isActive ? 'success' : 'danger'}>
                              {m.isActive ? '启用' : '禁用'}
                            </Badge>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  <Pagination
                    page={page}
                    pageSize={PAGE_SIZE}
                    total={membersQuery.data?.total ?? 0}
                    onPageChange={setPage}
                  />
                </div>
              )}
            </SectionCard>
          )}
        </div>
      )}
      {modal?.kind === 'create' && (
        <NameModal
          title={modal.parent ? `新增下级：${modal.parent.name}` : '新建组织'}
          initial={{ name: '', sort: 0 }}
          save={(body) => organizationApi.create({ ...body, parentId: modal.parent?.id ?? null })}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
      {modal?.kind === 'rename' && (
        <NameModal
          title={`改名：${modal.node.name}`}
          initial={{ name: modal.node.name, sort: modal.node.sort }}
          save={(body) => organizationApi.update(modal.node.id, body)}
          onClose={() => setModal(null)}
          onSaved={() => onSaved()}
        />
      )}
      {modal?.kind === 'move' && (
        <MoveModal
          node={modal.node}
          section={modal.section}
          onClose={() => setModal(null)}
          onSaved={() => onSaved()}
        />
      )}
    </div>
  );
}
