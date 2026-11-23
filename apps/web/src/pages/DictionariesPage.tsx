import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { dictionaryApi, type DictItemView, type DictTypeView } from '@/lib/dictionaries';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';

const QUERY_KEY = ['dictionaries'] as const;

function TypeModal({
  type,
  onClose,
  onSaved,
}: {
  /** 为空表示新建。 */
  type: DictTypeView | null;
  onClose: () => void;
  onSaved: (code: string) => void;
}) {
  const [code, setCode] = useState(type?.code ?? '');
  const [name, setName] = useState(type?.name ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      const desc = description.trim() || null;
      if (!type) {
        return dictionaryApi.createType({
          code: code.trim(),
          name: name.trim(),
          description: desc,
        });
      }
      // 内置字典不能改名，只提交描述。
      return dictionaryApi.updateType(
        type.code,
        type.builtin ? { description: desc } : { name: name.trim(), description: desc },
      );
    },
    onSuccess: (saved) => onSaved(saved.code),
    onError: (e: Error) => setError(e.message),
  });
  const title = type ? '编辑类型' : '新建类型';
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
            disabled={!code.trim() || !name.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="编码"
          htmlFor="dict-type-code"
          required
          hint={type ? undefined : '小写字母开头，只能用小写字母、数字和下划线，保存后不能修改'}
        >
          <Input
            id="dict-type-code"
            value={code}
            maxLength={64}
            disabled={Boolean(type)}
            className="font-mono"
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field label="名称" htmlFor="dict-type-name" required>
          <Input
            id="dict-type-name"
            value={name}
            maxLength={64}
            disabled={Boolean(type?.builtin)}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="描述" htmlFor="dict-type-description">
          <Input
            id="dict-type-description"
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

function ItemModal({
  code,
  builtin,
  item,
  onClose,
  onSaved,
}: {
  code: string;
  /** 内置字典的条目不能改值。 */
  builtin: boolean;
  /** 为空表示新增。 */
  item: DictItemView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(item?.value ?? '');
  const [label, setLabel] = useState(item?.label ?? '');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      const body = { value: value.trim(), label: label.trim() };
      if (!item) return dictionaryApi.createItem(code, body);
      return dictionaryApi.updateItem(code, item.id, builtin ? { label: body.label } : body);
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={item ? '编辑条目' : '新增条目'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!value.trim() || !label.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="值" htmlFor="dict-item-value" required>
          <Input
            id="dict-item-value"
            value={value}
            maxLength={64}
            disabled={builtin && Boolean(item)}
            className="font-mono"
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Field label="名称" htmlFor="dict-item-label" required>
          <Input
            id="dict-item-label"
            value={label}
            maxLength={64}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

export function DictionariesPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('system_setting:update');
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [typeModal, setTypeModal] = useState<{ type: DictTypeView | null } | null>(null);
  const [itemModal, setItemModal] = useState<{ item: DictItemView | null } | null>(null);

  const typesQuery = useQuery({ queryKey: QUERY_KEY, queryFn: () => dictionaryApi.listTypes() });
  const types = typesQuery.data?.items ?? [];
  const code =
    selected && types.some((t) => t.code === selected) ? selected : (types[0]?.code ?? null);
  const detailQuery = useQuery({
    queryKey: [...QUERY_KEY, code],
    queryFn: () => dictionaryApi.getType(code!),
    enabled: Boolean(code),
  });
  const detail = detailQuery.data;
  const items = detail?.items ?? [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const onFail = (e: Error) => toastError(e.message);

  const toggle = useMutation({
    mutationFn: (item: DictItemView) =>
      dictionaryApi.updateItem(code!, item.id, { enabled: !item.enabled }),
    onSuccess: refresh,
    onError: onFail,
  });
  const move = useMutation({
    mutationFn: (ids: string[]) => dictionaryApi.reorder(code!, ids),
    onSuccess: refresh,
    onError: onFail,
  });
  const removeItem = useMutation({
    mutationFn: (item: DictItemView) => dictionaryApi.deleteItem(code!, item.id),
    onSuccess: () => {
      success('已删除');
      void refresh();
    },
    onError: onFail,
  });
  const removeType = useMutation({
    mutationFn: (type: DictTypeView) => dictionaryApi.deleteType(type.code),
    onSuccess: () => {
      success('已删除');
      setSelected(null);
      void refresh();
    },
    onError: onFail,
  });

  const moveItem = (index: number, offset: -1 | 1) => {
    const ids = items.map((i) => i.id);
    const target = index + offset;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    move.mutate(ids);
  };
  const busy = toggle.isPending || move.isPending || removeItem.isPending;

  return (
    <div>
      <PageHeader
        title="数据字典"
        actions={
          canWrite ? (
            <Button onClick={() => setTypeModal({ type: null })}>新建类型</Button>
          ) : undefined
        }
      />
      {typesQuery.isLoading ? (
        <LoadingBlock />
      ) : typesQuery.error ? (
        <p className="p-4 text-sm text-severity-critical">{(typesQuery.error as Error).message}</p>
      ) : types.length === 0 ? (
        <EmptyState title="暂无字典类型" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <Card className="h-fit p-2">
            <nav aria-label="字典类型" className="flex flex-col gap-0.5">
              {types.map((t) => {
                const active = t.code === code;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setSelected(t.code)}
                    className={cn(
                      'flex flex-col items-start rounded-[10px] px-3 py-2 text-left transition-colors',
                      active ? 'bg-brand-50 text-brand-700' : 'text-ink-2 hover:bg-slate-100',
                    )}
                  >
                    <span className={cn('text-[14px]', active && 'font-semibold')}>{t.name}</span>
                    <span className="font-mono text-xs text-ink-3">{t.code}</span>
                  </button>
                );
              })}
            </nav>
          </Card>
          {detail && (
            <SectionCard
              title={detail.name}
              description={detail.description ?? undefined}
              bodyClassName="p-0"
              extra={
                canWrite ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setTypeModal({ type: detail })}
                    >
                      编辑
                    </Button>
                    {!detail.builtin && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={removeType.isPending}
                        onClick={() => {
                          if (window.confirm(`删除类型「${detail.name}」及其全部条目？`))
                            removeType.mutate(detail);
                        }}
                      >
                        删除类型
                      </Button>
                    )}
                    {!detail.builtin && (
                      <Button size="sm" onClick={() => setItemModal({ item: null })}>
                        新增条目
                      </Button>
                    )}
                  </>
                ) : undefined
              }
            >
              {items.length === 0 ? (
                <EmptyState title="暂无条目" />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>值</TH>
                      <TH>名称</TH>
                      <TH>状态</TH>
                      {canWrite && <TH>操作</TH>}
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((item, index) => (
                      <TR key={item.id} className="h-12">
                        <TD data-label="值" className="font-mono">
                          {item.value}
                        </TD>
                        <TD data-label="名称">{item.label}</TD>
                        <TD data-label="状态">
                          <Badge icon tone={item.enabled ? 'success' : 'neutral'}>
                            {item.enabled ? '启用' : '停用'}
                          </Badge>
                        </TD>
                        {canWrite && (
                          <TD data-label="操作">
                            <div className="flex items-center gap-3 text-sm">
                              <span className="flex items-center gap-0.5">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  aria-label="上移"
                                  disabled={index === 0 || busy}
                                  onClick={() => moveItem(index, -1)}
                                >
                                  <ArrowUp className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  aria-label="下移"
                                  disabled={index === items.length - 1 || busy}
                                  onClick={() => moveItem(index, 1)}
                                >
                                  <ArrowDown className="h-4 w-4" />
                                </Button>
                              </span>
                              <button
                                type="button"
                                className="text-brand-600 hover:underline"
                                onClick={() => setItemModal({ item })}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className="text-brand-600 hover:underline"
                                disabled={busy}
                                onClick={() => toggle.mutate(item)}
                              >
                                {item.enabled ? '停用' : '启用'}
                              </button>
                              {!detail.builtin && (
                                <button
                                  type="button"
                                  className="text-severity-critical hover:underline"
                                  disabled={busy}
                                  onClick={() => {
                                    if (window.confirm(`删除条目「${item.label}」？`))
                                      removeItem.mutate(item);
                                  }}
                                >
                                  删除
                                </button>
                              )}
                            </div>
                          </TD>
                        )}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </SectionCard>
          )}
        </div>
      )}
      {typeModal && (
        <TypeModal
          key={typeModal.type?.id ?? 'new'}
          type={typeModal.type}
          onClose={() => setTypeModal(null)}
          onSaved={(saved) => {
            success('已保存');
            setTypeModal(null);
            setSelected(saved);
            void refresh();
          }}
        />
      )}
      {itemModal && code && (
        <ItemModal
          key={itemModal.item?.id ?? 'new'}
          code={code}
          builtin={Boolean(detail?.builtin)}
          item={itemModal.item}
          onClose={() => setItemModal(null)}
          onSaved={() => {
            success('已保存');
            setItemModal(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
