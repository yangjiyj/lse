import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type KeywordListItem, type KeywordStatus } from '@/lib/api';
import { DetailDrawer } from '@/components/fleet/DetailDrawer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { formatDateTime, type BadgeTone } from '@/lib/format';

const PAGE_SIZE = 100;

const STATUS_TONE: Record<KeywordStatus, BadgeTone> = {
  approved: 'success',
  pending: 'warning',
  disabled: 'neutral',
  rejected: 'neutral',
};

type StatusFilter = '' | KeywordStatus;
type Change =
  | { kind: 'ids'; ids: string[]; to: 'approved' | 'disabled' }
  | {
      kind: 'item';
      itemCode: string;
      fromStatus: 'pending' | 'approved' | 'disabled';
      to: 'approved' | 'disabled';
    };

/** 改状态的按钮名：停用；待确认的词启用叫「确认使用」。 */
const actionLabel = (to: 'approved' | 'disabled', allPending: boolean) =>
  to === 'disabled' ? '停用' : allPending ? '确认使用' : '启用';

/** 跨小项打开（从「待确认 N 个」进入）时，标题随状态筛选变。 */
const STATUS_TITLE: Record<StatusFilter, string> = {
  '': '全部关键词',
  approved: '在用的关键词',
  pending: '待确认的关键词',
  disabled: '停用的关键词',
  rejected: '已剔除的关键词',
};

/** 关键词列表抽屉：按小项（或跨小项）列词，可搜索、按状态筛选、勾选后批量停用 / 启用。 */
export function KeywordListDrawer({
  title,
  itemCode,
  initialStatus = '',
  canEdit,
  onClose,
}: {
  /** 小项抽屉的标题；跨小项时不用，按状态筛选取标题。 */
  title?: string;
  itemCode?: string;
  initialStatus?: StatusFilter;
  canEdit: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ change: Change; count: number; label: string } | null>(
    null,
  );
  // 确认框开着时按 Esc 只关确认框，不关抽屉；回调保持稳定，抽屉才不会每次渲染都抢焦点。
  const confirmOpen = useRef(false);
  confirmOpen.current = confirm !== null;
  const closeDrawer = useCallback(() => {
    if (!confirmOpen.current) onClose();
  }, [onClose]);

  const query = {
    itemCode,
    keyword: keyword.trim() || undefined,
    reviewStatus: status || undefined,
    page,
    pageSize: PAGE_SIZE,
  };
  const list = useQuery({
    queryKey: ['question-sets', 'keyword-list', query],
    queryFn: () => api.questionSets.keywordList(query),
  });
  useEffect(() => setSelected(new Set()), [itemCode, keyword, status, page]);
  // 最后一页的词全改掉（不再符合筛选）后，回到最后一个有词的页，不停在空页。
  const lastPage = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));
  useEffect(() => {
    if (list.data && list.data.items.length === 0 && page > lastPage) setPage(lastPage);
  }, [list.data, page, lastPage]);

  const items = list.data?.items ?? [];
  const editable = useMemo(
    () => (canEdit ? items.filter((i) => i.editable) : []),
    [canEdit, items],
  );
  const picked = editable.filter((i) => selected.has(i.id));
  const toDisable = picked.filter((i) => i.reviewStatus !== 'disabled');
  const toEnable = picked.filter((i) => i.reviewStatus !== 'approved');

  const save = useMutation({
    mutationFn: (c: Change) =>
      api.questionSets.keywordSetStatus(
        c.kind === 'ids'
          ? { ids: c.ids, to: c.to }
          : { itemCode: c.itemCode, fromStatus: c.fromStatus, to: c.to },
      ),
    onSuccess: (r, c) => {
      const verb =
        c.to === 'disabled'
          ? '停用'
          : c.kind === 'item' && c.fromStatus === 'pending'
            ? '确认使用'
            : '启用';
      toast.success(`已${verb} ${r.changed} 个`);
      setSelected(new Set());
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['question-sets', 'keyword-coverage'] });
      void qc.invalidateQueries({ queryKey: ['question-sets', 'keyword-list'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : '操作失败'),
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allPicked = editable.length > 0 && picked.length === editable.length;

  // 按小项 + 原状态整批改：只在小项抽屉、筛了某个状态、没有搜索时出现。
  const whole =
    canEdit &&
    itemCode &&
    (status === 'pending' || status === 'approved' || status === 'disabled') &&
    !keyword.trim()
      ? {
          fromStatus: status,
          to: status === 'approved' ? ('disabled' as const) : ('approved' as const),
        }
      : null;
  const wholeCount = list.data?.editableTotal ?? 0;

  const rowActions = (w: KeywordListItem) => {
    if (w.reviewStatus === 'pending')
      return [
        { label: '确认使用', to: 'approved' as const },
        { label: '停用', to: 'disabled' as const },
      ];
    if (w.reviewStatus === 'approved') return [{ label: '停用', to: 'disabled' as const }];
    if (w.reviewStatus === 'disabled') return [{ label: '启用', to: 'approved' as const }];
    return [];
  };

  return (
    <>
      <DetailDrawer
        title={itemCode ? (title ?? itemCode) : STATUS_TITLE[status]}
        size="lg"
        onClose={closeDrawer}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            aria-label="搜索关键词"
            placeholder="搜索关键词"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPage(1);
            }}
            className="max-w-[240px]"
          />
          <Select
            aria-label="状态"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as StatusFilter);
              setPage(1);
            }}
            className="w-[120px]"
          >
            <option value="">全部</option>
            <option value="approved">在用</option>
            <option value="pending">待确认</option>
            <option value="disabled">停用</option>
          </Select>
          {whole && wholeCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={save.isPending}
              onClick={() =>
                setConfirm({
                  change: {
                    kind: 'item',
                    itemCode: itemCode!,
                    fromStatus: whole.fromStatus,
                    to: whole.to,
                  },
                  count: wholeCount,
                  label: actionLabel(whole.to, whole.fromStatus === 'pending'),
                })
              }
            >
              全部{actionLabel(whole.to, whole.fromStatus === 'pending')}
            </Button>
          )}
        </div>

        {picked.length > 0 && (
          <div
            role="toolbar"
            aria-label="批量操作"
            className="flex flex-wrap items-center gap-2 rounded-lg bg-brand-50/60 px-3 py-2"
          >
            <span className="text-[13px] text-ink-2">已选 {picked.length} 个</span>
            {toDisable.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={save.isPending}
                onClick={() =>
                  setConfirm({
                    change: { kind: 'ids', ids: toDisable.map((i) => i.id), to: 'disabled' },
                    count: toDisable.length,
                    label: '停用',
                  })
                }
              >
                停用
              </Button>
            )}
            {toEnable.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={save.isPending}
                onClick={() => {
                  const label = actionLabel(
                    'approved',
                    toEnable.every((i) => i.reviewStatus === 'pending'),
                  );
                  setConfirm({
                    change: { kind: 'ids', ids: toEnable.map((i) => i.id), to: 'approved' },
                    count: toEnable.length,
                    label,
                  });
                }}
              >
                {actionLabel(
                  'approved',
                  toEnable.every((i) => i.reviewStatus === 'pending'),
                )}
              </Button>
            )}
          </div>
        )}

        {list.isLoading ? (
          <LoadingBlock />
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-ink-3">没有关键词</div>
        ) : (
          <div>
            <Table fit>
              <THead>
                <TR>
                  <TH className="w-10">
                    {editable.length > 0 && (
                      <input
                        type="checkbox"
                        aria-label="全选本页"
                        checked={allPicked}
                        onChange={() =>
                          setSelected(allPicked ? new Set() : new Set(editable.map((i) => i.id)))
                        }
                      />
                    )}
                  </TH>
                  {!itemCode && <TH className="w-[72px]">小项</TH>}
                  <TH>关键词</TH>
                  <TH className="w-[72px]">状态</TH>
                  <TH className="w-[84px]">来源</TH>
                  <TH className="w-[150px]">最后修改</TH>
                  <TH className="w-[150px]" />
                </TR>
              </THead>
              <TBody>
                {items.map((w) => {
                  const can = canEdit && w.editable;
                  return (
                    <TR key={w.id} aria-label={w.term}>
                      <TD>
                        {can && (
                          <input
                            type="checkbox"
                            aria-label={`选择 ${w.term}`}
                            checked={selected.has(w.id)}
                            onChange={() => toggle(w.id)}
                          />
                        )}
                      </TD>
                      {!itemCode && (
                        <TD data-label="小项" className="tabular-nums" title={w.itemName}>
                          {w.itemCode}
                        </TD>
                      )}
                      <TD data-label="关键词" className="break-all">
                        {w.term}
                      </TD>
                      <TD data-label="状态">
                        <Badge tone={STATUS_TONE[w.reviewStatus] ?? 'neutral'}>
                          {w.reviewStatusLabel}
                        </Badge>
                      </TD>
                      <TD data-label="来源" className="text-ink-3">
                        {w.sourceLabel}
                      </TD>
                      <TD data-label="最后修改" className="text-[12.5px] leading-5 text-ink-3">
                        {w.statusChangedAt ? (
                          <>
                            {w.statusChangedBy && <div>{w.statusChangedBy}</div>}
                            <div className="tabular-nums">{formatDateTime(w.statusChangedAt)}</div>
                          </>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD className="text-right">
                        {can && (
                          <div className="flex justify-end gap-1">
                            {rowActions(w).map((a) => (
                              <Button
                                key={a.label}
                                size="sm"
                                variant="ghost"
                                disabled={save.isPending}
                                onClick={() => save.mutate({ kind: 'ids', ids: [w.id], to: a.to })}
                              >
                                {a.label}
                              </Button>
                            ))}
                          </div>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={list.data?.total ?? 0}
              onPageChange={setPage}
            />
          </div>
        )}
      </DetailDrawer>
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        size="sm"
        title={
          confirm
            ? confirm.label === '确认使用'
              ? '确认使用'
              : `${confirm.label}关键词`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              disabled={save.isPending}
              onClick={() => confirm && save.mutate(confirm.change)}
            >
              {confirm?.label}
            </Button>
          </>
        }
      >
        {confirm &&
          `这 ${confirm.count.toLocaleString('zh-CN')} 个词将${confirm.change.to === 'disabled' ? '不再' : ''}参与${
            list.data?.writesPlatform ? '所有租户的' : ''
          }判定。`}
      </Modal>
    </>
  );
}
