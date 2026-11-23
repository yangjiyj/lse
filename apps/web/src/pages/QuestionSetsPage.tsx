import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Upload,
  Download,
  Trash2,
  Eye,
  FileSpreadsheet,
  Library,
  WandSparkles,
  Info,
  Building2,
  ShieldAlert,
} from 'lucide-react';
import {
  api,
  ApiError,
  type CustomerDataFieldKind,
  type CustomerDataFieldSpec,
  type BenchmarkFormat,
  type CustomerDataGeneratorResult,
  type QuestionSet,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { TenantTransferDialog } from '@/components/TenantTransferDialog';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { SegmentTabs } from '@/components/page-kit/SegmentTabs';
import { RadioPills } from '@/components/page-kit/RadioPills';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { FormSection } from '@/components/page-kit/FormSection';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { TagCluster } from '@/components/page-kit/TagCluster';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { SeverityBadge } from '@/components/ui/status-badge';
import { MutationButton } from '@/components/question-bank/MutationModal';
import { SeedBankTab } from '@/components/question-bank/SeedBankTab';
import { RunRecordsTab } from '@/components/question-bank/RunRecordsTab';
import { KeywordLibraryTab } from '@/components/question-bank/KeywordLibraryTab';
import { OwnBankIntro, OWN_BANK_ACTION_HINTS } from '@/components/question-bank/OwnBankIntro';
import { AttackSeedModal } from '@/components/question-bank/AttackSeedModal';
import { ExportButtons } from '@/components/ExportButtons';
import { QuestionResults } from '@/components/question-bank/QuestionResults';
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  QUESTION_TEMPLATE_TYPES,
  TEMPLATE_TYPE_LABELS,
  questionTypeLabel,
  riskCategoryLabel,
  formatDateTime,
  truncate,
} from '@/lib/format';

const SET_EXPORT_FORMATS: Array<{ format: 'xlsx' | 'csv'; label: string }> = [
  { format: 'xlsx', label: 'Excel' },
  { format: 'csv', label: 'CSV' },
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const CUSTOMER_DATA_FIELD_KINDS: CustomerDataFieldKind[] = [
  'api_key',
  'jwt',
  'password',
  'phone',
  'email',
  'person_name',
  'id_card',
  'bank_card',
  'address',
  'salary',
  'contract_amount',
  'medical_record',
  'customer_id',
  'internal_doc',
  'custom',
];

const DEFAULT_CUSTOMER_DATA_FIELDS = [
  'mobile,会员手机号,phone',
  'secret,生产 API Key,api_key',
  'contract,合同金额,contract_amount',
].join('\n');

// 常见业务敏感数据类型：给客户勾选，勾中即拼成一行「key,标签,kind」写进字段文本。
// 普通客户看中文名即可，英文 kind 只用于内部拼接，不在界面裸露。
const COMMON_CUSTOMER_DATA_TYPES: {
  key: string;
  label: string;
  kind: CustomerDataFieldKind;
}[] = [
  { key: 'mobile', label: '手机号', kind: 'phone' },
  { key: 'email', label: '邮箱', kind: 'email' },
  { key: 'id_card', label: '身份证号', kind: 'id_card' },
  { key: 'bank_card', label: '银行卡号', kind: 'bank_card' },
  { key: 'address', label: '家庭住址', kind: 'address' },
  { key: 'salary', label: '薪资', kind: 'salary' },
  { key: 'contract', label: '合同金额', kind: 'contract_amount' },
  { key: 'medical', label: '病历', kind: 'medical_record' },
  { key: 'secret', label: 'API 密钥', kind: 'api_key' },
];

// 默认勾中：手机号 + 合同金额 + API 密钥。
const DEFAULT_CUSTOMER_DATA_TYPE_KEYS = ['mobile', 'contract', 'secret'];

function customerDataTypeLine(t: (typeof COMMON_CUSTOMER_DATA_TYPES)[number]): string {
  return `${t.key},${t.label},${t.kind}`;
}

function isCustomerDataFieldKind(value: string): value is CustomerDataFieldKind {
  return CUSTOMER_DATA_FIELD_KINDS.includes(value as CustomerDataFieldKind);
}

function normalizeFieldKey(value: string, index: number): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return normalized || `field_${index + 1}`;
}

function parseCustomerDataFields(text: string): CustomerDataFieldSpec[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [rawKey = '', rawLabel = '', rawKind = 'custom'] = line.split(/[,，\t|]/);
      const key = normalizeFieldKey(rawKey || rawLabel, index);
      const label = (rawLabel || rawKey || `客户字段 ${index + 1}`).trim().slice(0, 80);
      const kindText = rawKind.trim();
      return {
        key,
        label,
        kind: isCustomerDataFieldKind(kindText) ? kindText : 'custom',
      };
    });
}

function BenchmarkFormatNote({ format }: { format?: BenchmarkFormat }) {
  if (!format) return null;
  return (
    <div
      className="space-y-1 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground"
      data-testid="benchmark-format-note"
    >
      <p>{format.description}</p>
      {format.origin && <p>出处：{format.origin}</p>}
      {format.typicalFiles && <p>典型文件名：{format.typicalFiles}</p>}
      {format.expectedHeaders && <p>期望表头：{format.expectedHeaders}</p>}
      {format.usageNote && <p>使用提示：{format.usageNote}</p>}
      {format.id === 'xstest' && (
        <p className="font-medium text-severity-medium">
          用于检测过度拒答：safe 题应正常回答，模型拒答即视为过度拒答。
        </p>
      )}
      {format.licenseNote && <p>许可：{format.licenseNote}</p>}
    </div>
  );
}

export function QuestionSetsPage() {
  const { hasPermission, user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const benchFileRef = useRef<HTMLInputElement>(null);

  const [page, setPage] = useState(1);
  const [domainFilter, setDomainFilter] = useState('');
  // 视图：种子库 / 自有样本库 / 运行记录（?tab= 可直接定位）。
  const [view, setView] = useState<'seed' | 'own' | 'run' | 'keyword'>(() => {
    const t =
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null;
    return t === 'own' || t === 'run' || t === 'keyword' ? t : 'seed';
  });
  const [attackSeedOpen, setAttackSeedOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '', type: 'GENERAL' });

  const [importOpen, setImportOpen] = useState(false);
  const [importForm, setImportForm] = useState({
    mode: 'existing' as 'existing' | 'new',
    questionSetId: '',
    setName: '',
    templateType: 'compliance' as string,
  });
  const [importFile, setImportFile] = useState<File | null>(null);

  const [benchOpen, setBenchOpen] = useState(false);
  const [benchForm, setBenchForm] = useState({
    source: 'sample' as 'sample' | 'upload',
    sampleId: '',
    formatId: '',
    target: 'new' as 'new' | 'existing',
    questionSetId: '',
    setName: '',
  });
  const [benchFile, setBenchFile] = useState<File | null>(null);

  const [customerDataOpen, setCustomerDataOpen] = useState(false);
  const [customerDataForm, setCustomerDataForm] = useState({
    datasetName: '客户业务数据蓝图',
    count: '100',
    fieldsText: DEFAULT_CUSTOMER_DATA_FIELDS,
  });
  // 勾选式敏感数据类型：默认勾中手机号 + 合同金额 + API 密钥。
  const [selectedDataTypeKeys, setSelectedDataTypeKeys] = useState<string[]>(
    DEFAULT_CUSTOMER_DATA_TYPE_KEYS,
  );
  // 「自定义字段」高级折叠默认收起，只给懂行的人手填。
  const [showCustomFields, setShowCustomFields] = useState(false);

  // 勾选/取消一个数据类型：同步重写字段文本，让后续解析与提交逻辑完全不变。
  const toggleDataType = (typeKey: string) => {
    setCustomerDataPreview(null);
    const nextKeys = selectedDataTypeKeys.includes(typeKey)
      ? selectedDataTypeKeys.filter((k) => k !== typeKey)
      : [...selectedDataTypeKeys, typeKey];
    setSelectedDataTypeKeys(nextKeys);
    const checkedLines = COMMON_CUSTOMER_DATA_TYPES.filter((t) => nextKeys.includes(t.key)).map(
      customerDataTypeLine,
    );
    setCustomerDataForm((prev) => ({ ...prev, fieldsText: checkedLines.join('\n') }));
  };
  const [customerDataPreview, setCustomerDataPreview] =
    useState<CustomerDataGeneratorResult | null>(null);

  const [viewSet, setViewSet] = useState<QuestionSet | null>(null);
  const [transferFor, setTransferFor] = useState<QuestionSet | null>(null);
  const [qPage, setQPage] = useState(1);
  const [qCategory, setQCategory] = useState('');

  const canCreate = hasPermission('question_set:create');
  const canDelete = hasPermission('question_set:delete');
  const canUpdateSet = hasPermission('question_set:update');
  const canImport = hasPermission('question:import');
  const canReadQuestions = hasPermission('question:read');
  // 内置库导出只给平台管理员；自建库给有导出权限的角色。
  const canExportViewSet = viewSet
    ? hasPermission(viewSet.isBuiltin ? 'question_set:export_builtin' : 'question_set:export')
    : false;
  const canViewResults = hasPermission('eval_task:read');
  const canGenerateCustomerData =
    hasPermission('generator:preview') && hasPermission('generator:run');

  const pageSize = 10;
  const list = useQuery({
    queryKey: ['question-sets', 'own', page, search, domainFilter],
    queryFn: () =>
      api.questionSets.list({
        page,
        pageSize,
        keyword: search || undefined,
        domain: domainFilter || undefined,
        kind: 'own',
      }),
  });
  const riskCategoryOptions = useQuery({
    queryKey: ['question-set-risk-categories'],
    queryFn: () => api.questionSets.riskCategories(),
  });

  const setOptions = useQuery({
    queryKey: ['question-sets', 'all-for-import'],
    queryFn: () => api.questionSets.list({ page: 1, pageSize: 100, kind: 'own' }),
    enabled: importOpen || benchOpen || customerDataOpen,
  });

  const benchFormats = useQuery({
    queryKey: ['benchmark-formats'],
    queryFn: () => api.benchmarks.formats(),
    enabled: benchOpen,
  });

  const benchSamples = useQuery({
    queryKey: ['benchmark-samples'],
    queryFn: () => api.benchmarks.samples(),
    enabled: benchOpen,
  });

  const questions = useQuery({
    queryKey: ['questions', viewSet?.id, qPage, qCategory],
    queryFn: () =>
      api.questionSets.questions(viewSet!.id, {
        page: qPage,
        pageSize: 10,
        ...(qCategory ? { category: qCategory } : {}),
      }),
    enabled: !!viewSet,
  });
  const viewCategories = useQuery({
    queryKey: ['question-set-categories', viewSet?.id],
    queryFn: () => api.questionSets.categories(viewSet!.id),
    enabled: !!viewSet,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['question-sets'] });

  const buildCustomerDataBody = () => {
    const datasetName = customerDataForm.datasetName.trim();
    if (!datasetName) throw new ApiError('请填写数据集名称', 400);
    const count = Math.max(1, Math.min(1000, Math.floor(Number(customerDataForm.count) || 100)));
    const fields = parseCustomerDataFields(customerDataForm.fieldsText);
    if (fields.length === 0) throw new ApiError('请至少填写一个客户数据字段', 400);
    // 随机种子由后端自动生成（不暴露给用户；结果中会记录 seed 便于溯源）。
    return { datasetName, count, language: 'zh' as const, fields };
  };

  const closeCustomerDataModal = () => {
    setCustomerDataOpen(false);
    setCustomerDataPreview(null);
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.questionSets.create({
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        type: createForm.type,
      }),
    onSuccess: () => {
      toast.success('样本库已创建');
      setCreateOpen(false);
      setCreateForm({ name: '', description: '', type: 'GENERAL' });
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  const enabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.questionSets.update(id, { enabled }),
    onSuccess: (set) => {
      toast.success(set.enabled ? '已启用' : '已禁用');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.questionSets.remove(id),
    onSuccess: () => {
      toast.success('已删除');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!importFile) throw new ApiError('请先选择文件', 400);
      const contentBase64 = await fileToBase64(importFile);
      const format = importFile.name.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx';
      const body: Record<string, unknown> = {
        templateType: importForm.templateType,
        format,
        filename: importFile.name,
        contentBase64,
      };
      if (importForm.mode === 'existing') {
        if (!importForm.questionSetId) throw new ApiError('请选择目标样本库', 400);
        body.questionSetId = importForm.questionSetId;
      } else {
        if (!importForm.setName.trim()) throw new ApiError('请填写新样本库名称', 400);
        body.setName = importForm.setName.trim();
      }
      return api.questionSets.import(body);
    },
    onSuccess: (res) => {
      const rec = res.import;
      toast.success(`导入完成：成功 ${rec.importedRows} 条，失败 ${rec.failedRows} 条`);
      setImportOpen(false);
      setImportFile(null);
      if (fileRef.current) fileRef.current.value = '';
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '导入失败'),
  });

  const benchImportMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (benchForm.source === 'sample') {
        if (!benchForm.sampleId) throw new ApiError('请选择内置样本集', 400);
        body.sampleId = benchForm.sampleId;
      } else {
        if (!benchForm.formatId) throw new ApiError('请选择基准格式', 400);
        if (!benchFile) throw new ApiError('请先选择基准文件', 400);
        body.formatId = benchForm.formatId;
        body.filename = benchFile.name;
        body.contentBase64 = await fileToBase64(benchFile);
      }
      if (benchForm.target === 'existing') {
        if (!benchForm.questionSetId) throw new ApiError('请选择目标样本库', 400);
        body.questionSetId = benchForm.questionSetId;
      } else {
        if (!benchForm.setName.trim()) throw new ApiError('请填写新样本库名称', 400);
        body.setName = benchForm.setName.trim();
      }
      return api.benchmarks.import(body);
    },
    onSuccess: (res) => {
      const rec = res.import;
      toast.success(`基准导入完成：成功 ${rec.importedRows} 条，失败 ${rec.failedRows} 条`);
      setBenchOpen(false);
      setBenchFile(null);
      if (benchFileRef.current) benchFileRef.current.value = '';
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '基准导入失败'),
  });

  const customerDataPreviewMutation = useMutation({
    mutationFn: () => api.generator.customerDataPreview(buildCustomerDataBody()),
    onSuccess: (res) => {
      setCustomerDataPreview(res);
      toast.success(`已生成预览：${res.produced} 条`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '客户数据样本预览失败'),
  });

  const customerDataGenerateMutation = useMutation({
    mutationFn: () => {
      const body = buildCustomerDataBody();
      return api.generator.customerDataGenerate({
        ...body,
        name: `${body.datasetName} 客户数据泄漏样本`,
        description: `基于客户字段蓝图自动生成 ${body.count} 条数据泄漏专项测试样本。`,
      });
    },
    onSuccess: (res) => {
      toast.success(`客户数据样本库已生成：${res.produced} 条`);
      closeCustomerDataModal();
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '客户数据样本生成失败'),
  });

  const downloadMutation = useMutation({
    mutationFn: (templateType: string) => api.questionSets.downloadTemplate(templateType),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '模板下载失败'),
  });

  const openQuestions = (set: QuestionSet) => {
    setViewSet(set);
    setQPage(1);
    setQCategory('');
  };

  return (
    <div>
      <PageHeader
        title="模型题库"
        description="种子库（平台内置）、自有样本库（你自己的）与评估运行记录"
        actions={
          <div className="flex flex-wrap gap-2">
            {canImport && (
              <Button
                variant="outline"
                onClick={() => setImportOpen(true)}
                title={OWN_BANK_ACTION_HINTS.import}
              >
                <Upload className="h-4 w-4" />
                导入样本库
              </Button>
            )}
            {canImport && (
              <Button
                variant="outline"
                onClick={() => setBenchOpen(true)}
                title={OWN_BANK_ACTION_HINTS.benchmark}
              >
                <Library className="h-4 w-4" />
                评估基准
              </Button>
            )}
            {canGenerateCustomerData && canCreate && (
              <Button
                variant="outline"
                onClick={() => setAttackSeedOpen(true)}
                title={OWN_BANK_ACTION_HINTS.attackSeed}
              >
                <WandSparkles className="h-4 w-4" />
                攻击种子泛化
              </Button>
            )}
            {canGenerateCustomerData && (
              <Button
                variant="outline"
                onClick={() => setCustomerDataOpen(true)}
                title={OWN_BANK_ACTION_HINTS.customerData}
              >
                <WandSparkles className="h-4 w-4" />
                客户数据生成
              </Button>
            )}
            {canCreate && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                新建样本库
              </Button>
            )}
          </div>
        }
      />

      <SegmentTabs
        className="mb-4"
        ariaLabel="样本库视图"
        value={view}
        onChange={setView}
        items={[
          { value: 'seed', label: '种子库' },
          { value: 'own', label: '自有样本库' },
          { value: 'run', label: '运行记录' },
          { value: 'keyword', label: '关键词库' },
        ]}
      />

      {attackSeedOpen && (
        <AttackSeedModal open={attackSeedOpen} onClose={() => setAttackSeedOpen(false)} />
      )}

      {view === 'seed' ? (
        <Card>
          <CardContent className="p-4">
            <SeedBankTab
              onView={openQuestions}
              renderActions={(set) =>
                canCreate ? <MutationButton setId={set.id} setName={set.name} /> : null
              }
            />
          </CardContent>
        </Card>
      ) : null}

      {view === 'run' ? (
        <Card>
          <CardContent className="p-4">
            <RunRecordsTab onView={openQuestions} />
          </CardContent>
        </Card>
      ) : null}

      {view === 'keyword' ? (
        <Card>
          <CardContent className="p-4">
            <KeywordLibraryTab />
          </CardContent>
        </Card>
      ) : null}

      <Card className={view === 'own' ? undefined : 'hidden'}>
        <CardContent className="p-4">
          <OwnBankIntro />
          <FilterBar>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setPage(1);
                setSearch(keyword.trim());
              }}
            >
              <Input
                placeholder="按名称搜索…"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                className="max-w-xs"
              />
              <Button type="submit" variant="outline">
                搜索
              </Button>
            </form>
            <Select
              value={domainFilter}
              onChange={(e) => {
                setPage(1);
                setDomainFilter(e.target.value);
              }}
              className="max-w-[240px]"
            >
              <option value="">全部风险域</option>
              {(riskCategoryOptions.data?.items ?? []).map((c) => (
                <option key={c.domain} value={c.domain}>
                  {c.label}（{c.count}）
                </option>
              ))}
            </Select>
          </FilterBar>

          {list.isLoading ? (
            <LoadingBlock />
          ) : !list.data || list.data.items.length === 0 ? (
            <EmptyState
              title="暂无自有样本库"
              description="新建样本库，或导入测试样本文件构建评估基线。"
            />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>名称</TH>
                    <TH>风险覆盖</TH>
                    <TH className="text-right">样本数</TH>
                    <TH className="text-right">导入次数</TH>
                    <TH>创建时间</TH>
                    {canUpdateSet && <TH>启用</TH>}
                    <TH className="text-right">操作</TH>
                  </TR>
                </THead>
                <TBody>
                  {list.data.items.map((s) => (
                    <TR key={s.id}>
                      <TD data-label="名称" className="max-w-[360px] py-3">
                        <div className="flex items-center gap-2 font-semibold text-ink">
                          <span className="truncate" title={s.name}>
                            {s.name}
                          </span>
                          {s.isBuiltin ? (
                            <Badge tone="info">内置</Badge>
                          ) : (
                            <Badge tone="neutral">自有</Badge>
                          )}
                          {s.enabled === false && <Badge tone="warning">已禁用</Badge>}
                        </div>
                        {s.description && (
                          <div className="mt-0.5 truncate text-xs text-ink-3" title={s.description}>
                            {truncate(s.description, 60)}
                          </div>
                        )}
                      </TD>
                      <TD data-label="风险覆盖">
                        <TagCluster
                          tone="info"
                          max={3}
                          tags={s.riskCoverage ?? []}
                          empty={<span className="text-xs text-ink-3">—</span>}
                        />
                      </TD>
                      <TD data-label="样本数" className="text-right tabular-nums">
                        {s.questionCount.toLocaleString('zh-CN')}
                      </TD>
                      <TD data-label="导入次数" className="text-right tabular-nums">
                        {s.importCount}
                      </TD>
                      <TD
                        data-label="创建时间"
                        className="whitespace-nowrap text-xs text-slate-500"
                      >
                        {formatDateTime(s.createdAt)}
                      </TD>
                      {canUpdateSet && (
                        <TD data-label="启用">
                          {s.isBuiltin ? null : (
                            <input
                              type="checkbox"
                              role="switch"
                              aria-label={`启用「${s.name}」`}
                              checked={s.enabled !== false}
                              disabled={enabledMutation.isPending}
                              onChange={(e) =>
                                enabledMutation.mutate({ id: s.id, enabled: e.target.checked })
                              }
                            />
                          )}
                        </TD>
                      )}
                      <TD data-label="操作">
                        <div className="flex flex-nowrap items-center justify-start gap-1 md:justify-end">
                          {canReadQuestions && (
                            <Button
                              variant="ghost"
                              className="text-brand-700"
                              size="sm"
                              onClick={() => {
                                setViewSet(s);
                                setQPage(1);
                              }}
                            >
                              <Eye className="h-3.5 w-3.5" />
                              测试样本
                            </Button>
                          )}
                          {user?.isPlatformAdmin && !s.isBuiltin && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="变更归属租户"
                              title="变更归属租户"
                              data-testid={`questionset-transfer-${s.id}`}
                              onClick={() => setTransferFor(s)}
                            >
                              <Building2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {canDelete && !s.isBuiltin && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="删除"
                              onClick={() => {
                                if (confirm(`确认删除样本库「${s.name}」及其测试样本？`))
                                  deleteMutation.mutate(s.id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <Pagination
                page={page}
                pageSize={pageSize}
                total={list.data.total}
                onPageChange={setPage}
              />
            </>
          )}
        </CardContent>
      </Card>

      <TenantTransferDialog
        open={Boolean(transferFor)}
        kind="question-set"
        ids={transferFor ? [transferFor.id] : []}
        onClose={() => setTransferFor(null)}
        onTransferred={(message) => {
          toast.success(message);
          void qc.invalidateQueries({ queryKey: ['question-sets'] });
        }}
      />

      {/* 新建样本库 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建样本库"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !createForm.name.trim()}
            >
              {createMutation.isPending && <Spinner className="h-4 w-4" />}
              创建
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="名称" required>
            <Input
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
            />
          </Field>
          <Field label="类型">
            <Select
              value={createForm.type}
              onChange={(e) => setCreateForm({ ...createForm, type: e.target.value })}
            >
              {QUESTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {QUESTION_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="描述">
            <Textarea
              rows={3}
              value={createForm.description}
              onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
            />
          </Field>
        </div>
      </Modal>

      {/* 导入样本库 */}
      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="导入样本库"
        description="下载模板填写后上传；支持 .xlsx / .csv。"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending || !importFile}
            >
              {importMutation.isPending && <Spinner className="h-4 w-4" />}
              开始导入
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormSection
            columns={1}
            title="1 · 选择模板"
            description="按题目类型选择模板，填写后上传。"
          >
            <Field label="模板类型" required>
              <Select
                value={importForm.templateType}
                onChange={(e) => setImportForm({ ...importForm, templateType: e.target.value })}
              >
                {QUESTION_TEMPLATE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TEMPLATE_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>

            <NoteBox tone="info" className="flex flex-wrap items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-brand-600" />
              <span>先下载对应模板：</span>
              <Button
                variant="outline"
                size="sm"
                disabled={downloadMutation.isPending}
                onClick={() => downloadMutation.mutate(importForm.templateType)}
              >
                <Download className="h-3.5 w-3.5" />
                下载「
                {TEMPLATE_TYPE_LABELS[importForm.templateType as keyof typeof TEMPLATE_TYPE_LABELS]}
                」模板
              </Button>
            </NoteBox>
          </FormSection>

          <FormSection
            columns={1}
            title="2 · 目标与文件"
            description="决定样本写入哪个样本库，并上传填写好的文件。"
          >
            <Field label="目标样本库" required>
              <RadioPills
                name="import-mode"
                className="mb-2"
                value={importForm.mode}
                onChange={(mode) => setImportForm({ ...importForm, mode })}
                options={[
                  { value: 'existing', label: '导入到已有' },
                  { value: 'new', label: '新建样本库' },
                ]}
              />
              {importForm.mode === 'existing' ? (
                <Select
                  value={importForm.questionSetId}
                  onChange={(e) => setImportForm({ ...importForm, questionSetId: e.target.value })}
                >
                  <option value="">请选择…</option>
                  {setOptions.data?.items.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}（{s.questionCount.toLocaleString('zh-CN')} 条）
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  placeholder="新样本库名称"
                  value={importForm.setName}
                  onChange={(e) => setImportForm({ ...importForm, setName: e.target.value })}
                />
              )}
            </Field>

            <Field
              label="测试样本文件"
              required
              hint={importFile ? `已选择：${importFile.name}` : '选择填写好的 .xlsx / .csv'}
            >
              <Input
                ref={fileRef}
                type="file"
                accept=".xlsx,.csv"
                onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
              />
            </Field>
          </FormSection>
        </div>
      </Modal>

      {/* 评估基准导入 */}
      <Modal
        open={benchOpen}
        onClose={() => setBenchOpen(false)}
        title="从评估基准导入"
        description="选择平台内置安全评估基准，或上传符合格式要求的公开数据集文件。"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setBenchOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => benchImportMutation.mutate()}
              disabled={benchImportMutation.isPending}
            >
              {benchImportMutation.isPending && <Spinner className="h-4 w-4" />}
              开始导入
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormSection columns={1} title="基准来源">
            <Field label="基准来源" required>
              <RadioPills
                name="bench-source"
                className="mb-2"
                value={benchForm.source}
                onChange={(source) => setBenchForm({ ...benchForm, source })}
                options={[
                  { value: 'sample', label: '内置样本集' },
                  { value: 'upload', label: '上传基准文件' },
                ]}
              />
              {benchForm.source === 'sample' ? (
                <Select
                  value={benchForm.sampleId}
                  onChange={(e) => setBenchForm({ ...benchForm, sampleId: e.target.value })}
                >
                  <option value="">请选择内置样本集…</option>
                  {benchSamples.data?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}（{item.itemCount} 条 · {item.license}）
                    </option>
                  ))}
                </Select>
              ) : (
                <div className="space-y-2">
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      支持 HarmBench、JailbreakBench、StrongREJECT、AdvBench、XSTest、BeaverTails、
                      Do-Not-Answer、SALAD-Bench、JADE，以及通用 JSONL / CSV
                      格式。平台不内置这些数据集，仅解析文件格式，请自行下载后上传，并遵循数据集原始许可。
                    </span>
                  </p>
                  <Select
                    value={benchForm.formatId}
                    onChange={(e) => setBenchForm({ ...benchForm, formatId: e.target.value })}
                  >
                    <option value="">请选择基准格式…</option>
                    {benchFormats.data?.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}（.{f.inputKind}）
                      </option>
                    ))}
                  </Select>
                  <Input
                    ref={benchFileRef}
                    type="file"
                    accept=".json,.jsonl,.csv,.txt"
                    onChange={(e) => setBenchFile(e.target.files?.[0] ?? null)}
                  />
                </div>
              )}
            </Field>

            {benchForm.source === 'sample' && benchForm.sampleId && (
              <NoteBox className="py-2 text-xs">
                {benchSamples.data?.find((item) => item.id === benchForm.sampleId)?.description}
              </NoteBox>
            )}
            {benchForm.source === 'upload' && benchForm.formatId && (
              <BenchmarkFormatNote
                format={benchFormats.data?.find((f) => f.id === benchForm.formatId)}
              />
            )}
          </FormSection>

          <FormSection columns={1} title="导入目标">
            <Field label="目标样本库" required>
              <RadioPills
                name="bench-target"
                className="mb-2"
                value={benchForm.target}
                onChange={(target) => setBenchForm({ ...benchForm, target })}
                options={[
                  { value: 'new', label: '新建样本库' },
                  { value: 'existing', label: '导入到已有' },
                ]}
              />
              {benchForm.target === 'existing' ? (
                <Select
                  value={benchForm.questionSetId}
                  onChange={(e) => setBenchForm({ ...benchForm, questionSetId: e.target.value })}
                >
                  <option value="">请选择…</option>
                  {setOptions.data?.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}（{item.questionCount.toLocaleString('zh-CN')} 条）
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  placeholder="新样本库名称"
                  value={benchForm.setName}
                  onChange={(e) => setBenchForm({ ...benchForm, setName: e.target.value })}
                />
              )}
            </Field>
          </FormSection>
        </div>
      </Modal>

      {/* 客户数据泄漏样本生成 */}
      <Modal
        open={customerDataOpen}
        onClose={closeCustomerDataModal}
        title="生成数据防泄漏测试样本"
        description="选择业务涉及的敏感数据类型，平台将使用合成数据生成泄漏风险测试样本，不读取或使用真实业务数据。"
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={closeCustomerDataModal}>
              取消
            </Button>
            <Button
              variant="outline"
              onClick={() => customerDataPreviewMutation.mutate()}
              disabled={customerDataPreviewMutation.isPending}
            >
              {customerDataPreviewMutation.isPending && <Spinner className="h-4 w-4" />}
              预览样本
            </Button>
            <Button
              onClick={() => customerDataGenerateMutation.mutate()}
              disabled={customerDataGenerateMutation.isPending}
            >
              {customerDataGenerateMutation.isPending && <Spinner className="h-4 w-4" />}
              生成样本库
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormSection title="基本设置">
            <Field label="数据集名称" htmlFor="customer-data-dataset" required>
              <Input
                id="customer-data-dataset"
                aria-label="数据集名称"
                value={customerDataForm.datasetName}
                onChange={(e) =>
                  setCustomerDataForm({ ...customerDataForm, datasetName: e.target.value })
                }
              />
            </Field>
            <Field label="样本数量" htmlFor="customer-data-count" hint="1-1000">
              <Input
                id="customer-data-count"
                aria-label="样本数量"
                type="number"
                min={1}
                max={1000}
                value={customerDataForm.count}
                onChange={(e) =>
                  setCustomerDataForm({ ...customerDataForm, count: e.target.value })
                }
              />
            </Field>
          </FormSection>

          <FormSection columns={1} title="敏感数据类型">
            <Field label="要保护的敏感数据类型" required>
              <p className="mb-2 text-xs text-muted-foreground">
                平台将按所选类型生成合成数据，用于验证评估对象是否发生非授权披露。请选择业务实际涉及的数据类型。
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {COMMON_CUSTOMER_DATA_TYPES.map((t) => (
                  <label
                    key={t.key}
                    className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-[13px]"
                    htmlFor={`customer-data-type-${t.key}`}
                  >
                    <input
                      id={`customer-data-type-${t.key}`}
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selectedDataTypeKeys.includes(t.key)}
                      onChange={() => toggleDataType(t.key)}
                    />
                    {t.label}
                  </label>
                ))}
              </div>

              <details
                className="mt-3 rounded-xl border border-dashed border-line-2 bg-white p-3"
                open={showCustomFields}
              >
                <summary
                  className="cursor-pointer list-none text-xs font-medium text-muted-foreground"
                  onClick={(e) => {
                    e.preventDefault();
                    setShowCustomFields((v) => !v);
                  }}
                >
                  自定义字段（高级配置）
                </summary>
                <div className="mt-2 space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    每行填写一个字段，格式为「英文标识,中文名称,类型」。类型支持
                    phone、email、id_card、bank_card、address、salary、contract_amount、medical_record、api_key
                    等；上方选择将自动同步至此。
                  </p>
                  <Textarea
                    id="customer-data-fields"
                    aria-label="客户数据字段"
                    rows={6}
                    placeholder="mobile,会员手机号,phone"
                    value={customerDataForm.fieldsText}
                    onChange={(e) => {
                      setCustomerDataPreview(null);
                      setCustomerDataForm({ ...customerDataForm, fieldsText: e.target.value });
                    }}
                  />
                </div>
              </details>
            </Field>
          </FormSection>

          {customerDataPreview ? (
            <section
              aria-label="客户数据样本预览"
              className="space-y-3 rounded-md border border-border bg-muted/20 p-3"
            >
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  以下为合成数据测试样本预览。确认内容后生成样本库，即可在评估任务中使用。
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="info">预览 {customerDataPreview.produced} 条</Badge>
                {customerDataPreview.diversity?.scenarios?.slice(0, 4).map((item) => (
                  <Badge key={item.key}>{item.label}</Badge>
                ))}
              </div>
              <div className="space-y-2">
                {customerDataPreview.samples?.slice(0, 3).map((sample, index) => (
                  <article
                    key={`${sample.content}-${index}`}
                    className="rounded-md bg-white p-3 text-sm"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{riskCategoryLabel(sample.category)}</Badge>
                      <SeverityBadge value={sample.severity} />
                    </div>
                    <div className="whitespace-pre-wrap leading-6 text-slate-950">
                      {sample.content}
                    </div>
                    <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>评估目标：评估对象是否非授权披露上述合成敏感数据。</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </Modal>

      {/* 测试样本预览 */}
      <Modal
        open={!!viewSet}
        onClose={() => setViewSet(null)}
        title={viewSet ? `测试样本 · ${viewSet.name}` : '测试样本'}
        description={
          viewSet ? `共 ${viewSet.questionCount.toLocaleString('zh-CN')} 条测试样本` : undefined
        }
        size="xl"
        footer={
          viewSet && canExportViewSet && viewSet.questionCount > 0 ? (
            <ExportButtons
              name="导出样本库"
              formats={SET_EXPORT_FORMATS}
              onExport={(format) =>
                api.questionSets.exportSet(viewSet.id, format, {
                  category: qCategory || undefined,
                })
              }
            />
          ) : undefined
        }
      >
        {(viewCategories.data?.items.length ?? 0) > 1 && (
          <div className="mb-3 flex items-center gap-2">
            <Select
              aria-label="按分类筛选"
              className="w-auto min-w-48"
              value={qCategory}
              onChange={(e) => {
                setQCategory(e.target.value);
                setQPage(1);
              }}
            >
              <option value="">全部分类</option>
              {viewCategories.data!.items.map((c) => (
                <option key={c.category} value={c.category}>
                  {riskCategoryLabel(c.category)}（{c.count.toLocaleString('zh-CN')}）
                </option>
              ))}
            </Select>
          </div>
        )}
        {questions.isLoading ? (
          <LoadingBlock />
        ) : !questions.data || questions.data.items.length === 0 ? (
          <EmptyState
            title="暂无测试样本"
            description="该样本库尚未包含测试样本，可通过导入功能添加。"
          />
        ) : (
          <>
            <section aria-label="样本列表" className="space-y-3">
              {questions.data.items.map((q, index) => (
                <article
                  key={q.id}
                  className="rounded-2xl border border-line bg-white p-4 shadow-card"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-slate-500">
                          样本 #{(qPage - 1) * 10 + index + 1}
                        </span>
                        <Badge tone="info">{questionTypeLabel(q.type)}</Badge>
                        {q.severity ? <SeverityBadge value={q.severity} /> : null}
                        {q.category ? (
                          <Badge tone="neutral">{riskCategoryLabel(q.category)}</Badge>
                        ) : null}
                      </div>
                      <div
                        className="whitespace-pre-wrap text-sm leading-6 text-slate-950"
                        style={{ overflowWrap: 'anywhere' }}
                      >
                        {q.content}
                      </div>
                    </div>
                    <div className="grid shrink-0 gap-2 text-xs text-slate-500 sm:grid-cols-3 lg:w-56 lg:grid-cols-1">
                      <div className="rounded-xl bg-[#F7F9FD] px-3 py-2">
                        <div className="font-medium text-slate-600">语言</div>
                        <div className="mt-0.5 text-slate-900">{q.language || '—'}</div>
                      </div>
                      <div className="rounded-xl bg-[#F7F9FD] px-3 py-2">
                        <div
                          className="flex items-center gap-1 font-medium text-slate-600"
                          title="样本在原始数据集中的编号，仅用于追溯"
                        >
                          来源编号
                          <Info className="h-3 w-3 text-slate-500" />
                        </div>
                        <div className="mt-0.5 break-all text-slate-900">{q.externalId || '—'}</div>
                      </div>
                    </div>
                  </div>
                  {canViewResults && <QuestionResults setId={q.questionSetId} questionId={q.id} />}
                </article>
              ))}
            </section>
            <Pagination
              page={qPage}
              pageSize={10}
              total={questions.data.total}
              onPageChange={setQPage}
            />
          </>
        )}
      </Modal>
    </div>
  );
}
