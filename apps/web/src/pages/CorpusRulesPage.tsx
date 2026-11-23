import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import {
  RULE_SEVERITY_OPTIONS,
  corpusRulesApi,
  type CorpusRuleImportResult,
  type CorpusRuleInput,
  type CorpusRuleSetView,
  type CorpusRuleView,
  type RuleKind,
  type RuleSeverity,
} from '@/lib/corpus-scans';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { SeverityBadge } from '@/components/ui/status-badge';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';

const SETS_KEY = ['corpus-rule-sets'] as const;
const RULES_KEY = ['corpus-rules'] as const;
const PAGE_SIZE = 50;
const KIND_LABELS: Record<RuleKind, string> = { keyword: '关键词', regex: '正则' };

function SetModal({
  set,
  onClose,
  onSaved,
}: {
  /** 为空表示新建 */
  set: CorpusRuleSetView | null;
  onClose: () => void;
  onSaved: (saved: CorpusRuleSetView) => void;
}) {
  const [name, setName] = useState(set?.name ?? '');
  const [description, setDescription] = useState(set?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: description.trim() || null };
      return set ? corpusRulesApi.updateSet(set.id, body) : corpusRulesApi.createSet(body);
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={set ? '编辑规则集' : '新建规则集'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="名称" htmlFor="corpus-set-name">
          <Input
            id="corpus-set-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="描述" htmlFor="corpus-set-desc">
          <Input
            id="corpus-set-desc"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function RuleModal({
  setId,
  rule,
  onClose,
  onSaved,
}: {
  setId: string;
  /** 为空表示新增 */
  rule: CorpusRuleView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CorpusRuleInput>({
    kind: rule?.kind ?? 'keyword',
    pattern: rule?.pattern ?? '',
    category: rule?.category ?? '',
    severity: rule?.severity ?? 'MEDIUM',
    enabled: rule?.enabled ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      rule ? corpusRulesApi.updateRule(rule.id, form) : corpusRulesApi.createRule(setId, form),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={rule ? '编辑规则' : '新增规则'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!form.pattern.trim() || !form.category.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="类型" htmlFor="corpus-rule-kind">
          <Select
            id="corpus-rule-kind"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as RuleKind })}
          >
            <option value="keyword">关键词</option>
            <option value="regex">正则</option>
          </Select>
        </Field>
        <Field
          label="内容"
          htmlFor="corpus-rule-pattern"
          hint={form.kind === 'regex' ? '不超过 500 字，不能有嵌套量词，如 (a+)+' : undefined}
        >
          <Input
            id="corpus-rule-pattern"
            value={form.pattern}
            className={cn(form.kind === 'regex' && 'font-mono')}
            onChange={(e) => setForm({ ...form, pattern: e.target.value })}
          />
        </Field>
        <Field label="类别" htmlFor="corpus-rule-category">
          <Input
            id="corpus-rule-category"
            value={form.category}
            maxLength={50}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
        </Field>
        <Field label="严重度" htmlFor="corpus-rule-severity">
          <Select
            id="corpus-rule-severity"
            value={form.severity}
            onChange={(e) => setForm({ ...form, severity: e.target.value as RuleSeverity })}
          >
            {RULE_SEVERITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          启用
        </label>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function ImportModal({
  setId,
  onClose,
  onDone,
}: {
  setId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [format, setFormat] = useState<'csv' | 'xlsx' | 'txt'>('csv');
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('自定义');
  const [severity, setSeverity] = useState<RuleSeverity>('MEDIUM');
  const [kind, setKind] = useState<RuleKind>('keyword');
  const [result, setResult] = useState<CorpusRuleImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () =>
      corpusRulesApi.importRules(setId, file!, {
        format,
        category: category.trim() || undefined,
        severity,
        kind,
      }),
    onSuccess: (r) => {
      setResult(r);
      onDone();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="导入规则"
      footer={
        result ? (
          <Button onClick={onClose}>完成</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button disabled={!file || run.isPending} onClick={() => run.mutate()}>
              导入
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3 text-sm text-ink-2">
          <p>
            新增 {result.added} 条，重复 {result.duplicates} 条，失败 {result.failed} 条
          </p>
          {result.issues.length > 0 && (
            <ul className="max-h-60 overflow-y-auto rounded-[10px] border border-line px-4 py-2 text-[13px]">
              {result.issues.map((i, n) => (
                <li key={`${i.row}-${n}`}>
                  {i.row > 0 ? `第 ${i.row} 行：` : ''}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field
            label="文件格式"
            htmlFor="corpus-import-format"
            hint={
              format === 'txt'
                ? '每行一个关键词'
                : '首行表头：类型、内容、类别、严重度、启用；类型填「关键词」或「正则」'
            }
          >
            <Select
              id="corpus-import-format"
              value={format}
              onChange={(e) => setFormat(e.target.value as 'csv' | 'xlsx' | 'txt')}
            >
              <option value="csv">CSV</option>
              <option value="xlsx">Excel（xlsx）</option>
              <option value="txt">TXT</option>
            </Select>
          </Field>
          <Field label="文件" htmlFor="corpus-import-file">
            <input
              id="corpus-import-file"
              type="file"
              accept={format === 'xlsx' ? '.xlsx' : format === 'txt' ? '.txt' : '.csv'}
              className="text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            {format === 'txt' && (
              <Field label="类型" htmlFor="corpus-import-kind">
                <Select
                  id="corpus-import-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as RuleKind)}
                >
                  <option value="keyword">关键词</option>
                  <option value="regex">正则</option>
                </Select>
              </Field>
            )}
            <Field label="默认类别" htmlFor="corpus-import-category">
              <Input
                id="corpus-import-category"
                value={category}
                maxLength={50}
                onChange={(e) => setCategory(e.target.value)}
              />
            </Field>
            <Field label="默认严重度" htmlFor="corpus-import-severity">
              <Select
                id="corpus-import-severity"
                value={severity}
                onChange={(e) => setSeverity(e.target.value as RuleSeverity)}
              >
                {RULE_SEVERITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {error && <p className="text-sm text-severity-critical">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

export function CorpusRulesPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('corpus_rule:manage');
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<'' | RuleKind>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [setModal, setSetModal] = useState<{ set: CorpusRuleSetView | null } | null>(null);
  const [ruleModal, setRuleModal] = useState<{ rule: CorpusRuleView | null } | null>(null);
  const [importing, setImporting] = useState(false);

  const setsQuery = useQuery({ queryKey: SETS_KEY, queryFn: () => corpusRulesApi.listSets() });
  const sets = setsQuery.data?.items ?? [];
  const current = sets.find((s) => s.id === selected) ?? sets[0] ?? null;
  const rulesQuery = useQuery({
    queryKey: [...RULES_KEY, current?.id, kind, q.trim(), page],
    queryFn: () =>
      corpusRulesApi.listRules(current!.id, {
        ...(kind ? { kind } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
        page,
        pageSize: PAGE_SIZE,
      }),
    enabled: Boolean(current),
  });
  const rules = rulesQuery.data?.items ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: SETS_KEY });
    void queryClient.invalidateQueries({ queryKey: RULES_KEY });
  };
  const onFail = (e: Error) => toastError(e.message);
  const toggle = useMutation({
    mutationFn: (r: CorpusRuleView) => corpusRulesApi.updateRule(r.id, { enabled: !r.enabled }),
    onSuccess: refresh,
    onError: onFail,
  });
  const removeRule = useMutation({
    mutationFn: (r: CorpusRuleView) => corpusRulesApi.deleteRule(r.id),
    onSuccess: () => {
      success('已删除');
      refresh();
    },
    onError: onFail,
  });
  const removeSet = useMutation({
    mutationFn: (s: CorpusRuleSetView) => corpusRulesApi.deleteSet(s.id),
    onSuccess: () => {
      success('已删除');
      setSelected(null);
      refresh();
    },
    onError: onFail,
  });
  const busy = toggle.isPending || removeRule.isPending;

  return (
    <div>
      <PageHeader
        title="语料规则"
        actions={
          canManage ? (
            <Button onClick={() => setSetModal({ set: null })}>新建规则集</Button>
          ) : undefined
        }
      />
      {setsQuery.isLoading ? (
        <LoadingBlock />
      ) : setsQuery.error ? (
        <p className="p-4 text-sm text-severity-critical">{(setsQuery.error as Error).message}</p>
      ) : sets.length === 0 || !current ? (
        <EmptyState title="暂无规则集" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <Card className="h-fit p-2">
            <nav aria-label="规则集" className="flex flex-col gap-0.5">
              {sets.map((s) => {
                const active = s.id === current.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      setSelected(s.id);
                      setPage(1);
                    }}
                    className={cn(
                      'flex flex-col items-start rounded-[10px] px-3 py-2 text-left transition-colors',
                      active ? 'bg-brand-50 text-brand-700' : 'text-ink-2 hover:bg-slate-100',
                    )}
                  >
                    <span className={cn('text-[14px]', active && 'font-semibold')}>{s.name}</span>
                    <span className="text-xs text-ink-3">
                      {s.enabledCount} / {s.ruleCount} 条启用
                    </span>
                  </button>
                );
              })}
            </nav>
          </Card>
          <SectionCard
            title={current.name}
            description={current.description ?? undefined}
            bodyClassName="p-0"
            extra={
              canManage ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => setSetModal({ set: current })}>
                    编辑规则集
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removeSet.isPending}
                    onClick={() => {
                      if (window.confirm(`删除规则集「${current.name}」和其中全部规则？`))
                        removeSet.mutate(current);
                    }}
                  >
                    删除规则集
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
                    导入
                  </Button>
                  <Button size="sm" onClick={() => setRuleModal({ rule: null })}>
                    新增规则
                  </Button>
                </>
              ) : undefined
            }
          >
            <div className="flex flex-wrap items-center gap-3 px-6 pt-4">
              <Select
                aria-label="规则类型"
                className="w-36"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as '' | RuleKind);
                  setPage(1);
                }}
              >
                <option value="">全部类型</option>
                <option value="keyword">关键词</option>
                <option value="regex">正则</option>
              </Select>
              <Input
                aria-label="搜索规则"
                placeholder="内容或类别"
                className="w-60"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            {rulesQuery.isLoading ? (
              <LoadingBlock />
            ) : rules.length === 0 ? (
              <EmptyState title="暂无规则" />
            ) : (
              <div className="px-6 pb-4">
                <Table>
                  <THead>
                    <TR>
                      <TH>类型</TH>
                      <TH>内容</TH>
                      <TH>类别</TH>
                      <TH>严重度</TH>
                      <TH>状态</TH>
                      {canManage && <TH>操作</TH>}
                    </TR>
                  </THead>
                  <TBody>
                    {rules.map((r) => (
                      <TR key={r.id} className="h-12">
                        <TD data-label="类型">{KIND_LABELS[r.kind]}</TD>
                        <TD
                          data-label="内容"
                          className={cn(
                            'max-w-[420px] break-all',
                            r.kind === 'regex' && 'font-mono text-[13px]',
                          )}
                        >
                          {r.pattern}
                        </TD>
                        <TD data-label="类别">{r.category}</TD>
                        <TD data-label="严重度">
                          <SeverityBadge value={r.severity} />
                        </TD>
                        <TD data-label="状态">
                          <Badge icon tone={r.enabled ? 'success' : 'neutral'}>
                            {r.enabled ? '启用' : '停用'}
                          </Badge>
                        </TD>
                        {canManage && (
                          <TD data-label="操作">
                            <div className="flex items-center gap-3 text-sm">
                              <button
                                type="button"
                                className="text-brand-600 hover:underline"
                                onClick={() => setRuleModal({ rule: r })}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className="text-brand-600 hover:underline"
                                disabled={busy}
                                onClick={() => toggle.mutate(r)}
                              >
                                {r.enabled ? '停用' : '启用'}
                              </button>
                              <button
                                type="button"
                                className="text-severity-critical hover:underline"
                                disabled={busy}
                                onClick={() => {
                                  if (window.confirm(`删除规则「${r.pattern}」？`))
                                    removeRule.mutate(r);
                                }}
                              >
                                删除
                              </button>
                            </div>
                          </TD>
                        )}
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <Pagination
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={rulesQuery.data?.total ?? 0}
                  onPageChange={setPage}
                />
              </div>
            )}
          </SectionCard>
        </div>
      )}
      {setModal && (
        <SetModal
          key={setModal.set?.id ?? 'new'}
          set={setModal.set}
          onClose={() => setSetModal(null)}
          onSaved={(saved) => {
            success('已保存');
            setSetModal(null);
            setSelected(saved.id);
            refresh();
          }}
        />
      )}
      {ruleModal && current && (
        <RuleModal
          key={ruleModal.rule?.id ?? 'new'}
          setId={current.id}
          rule={ruleModal.rule}
          onClose={() => setRuleModal(null)}
          onSaved={() => {
            success('已保存');
            setRuleModal(null);
            refresh();
          }}
        />
      )}
      {importing && current && (
        <ImportModal setId={current.id} onClose={() => setImporting(false)} onDone={refresh} />
      )}
    </div>
  );
}
