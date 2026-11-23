import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  api,
  type ReportEvidenceDetail,
  type ReportTemplate,
  type ReportTemplateInput,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { REPORT_SECTION_LABELS, REPORT_SECTIONS } from '@/lib/format';

export const EVIDENCE_DETAIL_LABELS: Record<ReportEvidenceDetail, string> = {
  full: '完整',
  summary: '精简（只附攻破的对话）',
  none: '不附对话过程',
};
const DEFAULT_CLASSIFICATION = '内部使用';

/** 模板的章节为空表示不限定，表单里按全选显示。 */
function sectionsOf(t: ReportTemplate | null): string[] {
  return t && t.sections.length > 0 ? [...t.sections] : [...REPORT_SECTIONS];
}

function toForm(t: ReportTemplate | null): ReportTemplateInput {
  return {
    name: t?.name ?? '',
    sections: sectionsOf(t),
    evidenceDetail: t?.evidenceDetail ?? 'full',
    coverTitle: t?.coverTitle ?? '',
    coverKicker: t?.coverKicker ?? '',
    organization: t?.organization ?? '',
    client: t?.client ?? '',
    classification: t?.classification ?? DEFAULT_CLASSIFICATION,
    headerText: t?.headerText ?? '',
    footerText: t?.footerText ?? '',
    isDefault: t?.isDefault ?? false,
  };
}

/** 报告模板（2.4.7）：章节、证据详略、封面、密级、页眉页脚；可设一个默认模板。 */
export function ReportTemplatesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('report_template:manage');
  const [editing, setEditing] = useState<ReportTemplate | 'new' | null>(null);
  const [removing, setRemoving] = useState<ReportTemplate | null>(null);

  const templates = useQuery({
    queryKey: ['report-templates'],
    queryFn: () => api.reportTemplates.list(),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['report-templates'] });
  const setDefault = useMutation({
    mutationFn: (id: string) => api.reportTemplates.setDefault(id),
    onSuccess: () => {
      toast.success('已设为默认模板');
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.reportTemplates.remove(id),
    onSuccess: () => {
      toast.success('已删除');
      setRemoving(null);
      refresh();
    },
    onError: (err) => {
      setRemoving(null);
      toast.error((err as Error).message);
    },
  });

  const rows = templates.data?.items ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="报告模板"
        actions={canManage && <Button onClick={() => setEditing('new')}>新建模板</Button>}
      />
      <Card className="min-w-0 p-6">
        {templates.isLoading ? (
          <LoadingBlock />
        ) : rows.length === 0 ? (
          <EmptyState title="还没有报告模板" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>名称</TH>
                <TH>章节</TH>
                <TH>证据详略</TH>
                <TH>密级</TH>
                <TH>检测单位</TH>
                {canManage && <TH>操作</TH>}
              </TR>
            </THead>
            <TBody>
              {rows.map((t) => (
                <TR key={t.id}>
                  <TD>
                    <span className="font-medium text-ink">{t.name}</span>
                    {t.isDefault && (
                      <Badge tone="info" className="ml-2">
                        默认
                      </Badge>
                    )}
                  </TD>
                  <TD>
                    {t.sections.length === 0 || t.sections.length === REPORT_SECTIONS.length
                      ? '全部'
                      : `${t.sections.length} 个`}
                  </TD>
                  <TD>{EVIDENCE_DETAIL_LABELS[t.evidenceDetail] ?? t.evidenceDetail}</TD>
                  <TD>{t.classification}</TD>
                  <TD>{t.organization || '—'}</TD>
                  {canManage && (
                    <TD>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditing(t)}>
                          编辑
                        </Button>
                        {!t.isDefault && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={setDefault.isPending}
                            onClick={() => setDefault.mutate(t.id)}
                          >
                            设为默认
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(t)}>
                          删除
                        </Button>
                      </div>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {editing && (
        <TemplateFormModal
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title="删除报告模板"
        footer={
          <>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing.id)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-ink-2">
          删除「{removing?.name}」后，用它生成的报告仍按生成时的样式下载。
        </p>
      </Modal>
    </div>
  );
}

const TEXT_FIELDS: Array<{ key: keyof ReportTemplateInput; label: string; max: number }> = [
  { key: 'coverTitle', label: '封面标题', max: 200 },
  { key: 'coverKicker', label: '封面抬头', max: 100 },
  { key: 'organization', label: '检测单位', max: 100 },
  { key: 'client', label: '委托单位', max: 100 },
  { key: 'headerText', label: '页眉', max: 100 },
  { key: 'footerText', label: '页脚', max: 100 },
];

function TemplateFormModal({
  template,
  onClose,
}: {
  template: ReportTemplate | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ReportTemplateInput>(() => toForm(template));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ReportTemplateInput>(key: K, value: ReportTemplateInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const toggleSection = (s: string) =>
    set(
      'sections',
      form.sections.includes(s) ? form.sections.filter((x) => x !== s) : [...form.sections, s],
    );

  const save = useMutation({
    mutationFn: (body: ReportTemplateInput) =>
      template ? api.reportTemplates.update(template.id, body) : api.reportTemplates.create(body),
    onSuccess: () => {
      toast.success(template ? '报告模板已更新' : '报告模板已创建');
      void queryClient.invalidateQueries({ queryKey: ['report-templates'] });
      onClose();
    },
    onError: (err) => setError((err as Error).message),
  });
  const ready =
    form.name.trim().length > 0 &&
    form.sections.length > 0 &&
    form.classification.trim().length > 0;
  const submit = () =>
    save.mutate({
      ...form,
      name: form.name.trim(),
      // 按章节固定顺序提交；全选提交空数组，表示不限定章节（以后新增的章节也带上）。
      sections:
        form.sections.length === REPORT_SECTIONS.length
          ? []
          : REPORT_SECTIONS.filter((s) => form.sections.includes(s)),
      classification: form.classification.trim(),
    });

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={template ? '编辑报告模板' : '新建报告模板'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!ready || save.isPending} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称" htmlFor="template-name" required>
          <Input
            id="template-name"
            value={form.name}
            maxLength={100}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field label="证据详略" htmlFor="template-evidence">
          <Select
            id="template-evidence"
            value={form.evidenceDetail}
            onChange={(e) => set('evidenceDetail', e.target.value as ReportEvidenceDetail)}
          >
            {(Object.keys(EVIDENCE_DETAIL_LABELS) as ReportEvidenceDetail[]).map((k) => (
              <option key={k} value={k}>
                {EVIDENCE_DETAIL_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="章节"
          className="sm:col-span-2"
          error={form.sections.length === 0 ? '至少选一个章节' : undefined}
        >
          <div className="grid gap-1.5 rounded border border-line p-3 sm:grid-cols-2">
            {REPORT_SECTIONS.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.sections.includes(s)}
                  onChange={() => toggleSection(s)}
                />
                {REPORT_SECTION_LABELS[s]}
              </label>
            ))}
          </div>
        </Field>
        {TEXT_FIELDS.map(({ key, label, max }) => (
          <Field key={key} label={label} htmlFor={`template-${key}`}>
            <Input
              id={`template-${key}`}
              value={form[key] as string}
              maxLength={max}
              onChange={(e) => set(key, e.target.value)}
            />
          </Field>
        ))}
        <Field label="密级" htmlFor="template-classification" required>
          <Input
            id="template-classification"
            value={form.classification}
            maxLength={20}
            onChange={(e) => set('classification', e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => set('isDefault', e.target.checked)}
          />
          设为默认
        </label>
        {error && <p className="text-[13px] text-destructive sm:col-span-2">{error}</p>}
      </div>
    </Modal>
  );
}
