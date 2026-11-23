import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DetectJobItemKind } from '@lse/shared';
import { api, assetDiscoveryApi, modelFilesApi } from '@/lib/api';
import { corpusRulesApi, corpusScansApi } from '@/lib/corpus-scans';
import { isContentEvalTarget } from '@/lib/eval-targets';
import { engineLabel } from '@/lib/format';
import { usePlatformAppEnabled } from '@/lib/use-platform-app-enabled';
import { DirectoryBrowser } from '@/components/model-files/DirectoryBrowser';
import { RadioPills } from '@/components/page-kit/RadioPills';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { isUrlTarget, parsePorts, splitList } from '@/pages/asset-discovery/ScopeCard';
import { REQUIRED_ENGINES } from '@/pages/eval-plans/eval-plan-form';

// 组合任务、检测策略里每类子任务的参数表单（2.4.9）。
// 提交的参数与后端 detect-jobs/item-params.ts 的校验一一对应。

export type JobItemParams = Record<string, unknown>;

export function defaultJobItemParams(kind: DetectJobItemKind): JobItemParams {
  switch (kind) {
    case 'eval_task':
      return { modelTargetId: '', questionSetIds: [], engines: [...REQUIRED_ENGINES] };
    case 'model_file_scan':
      return { source: 'directory', path: '' };
    case 'corpus_scan':
      return { sourceScanId: '', ruleSetId: null };
    case 'asset_discovery':
      return { targets: [], ports: [], confirm: false };
    case 'fleet_posture':
      return { endpointId: '' };
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const asParams = (v: unknown): JobItemParams | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as JobItemParams) : null;

/** 评估子任务实际用的引擎：内置引擎（规则判定、敏感信息）总会跑，和所选的取并集。 */
const withRequiredEngines = (engines: unknown): string[] => [
  ...new Set([...REQUIRED_ENGINES, ...strings(engines)]),
];

/**
 * 提交前规整参数（子任务列表等不经过表单的调用方也用它）：评估子任务补上内置引擎。
 * 与后端 parseDetectJobItemParams 的规整一致。
 */
export function normalizeJobItemParams(kind: DetectJobItemKind, value: unknown): JobItemParams {
  const p = asParams(value) ?? defaultJobItemParams(kind);
  return kind === 'eval_task' ? { ...p, engines: withRequiredEngines(p.engines) } : p;
}

/** 参数还缺什么；齐了返回 null。只查前端能判断的，引用对象是否存在等由后端检查。 */
export function jobItemProblem(kind: DetectJobItemKind, value: unknown): string | null {
  const p = asParams(value) ?? {};
  switch (kind) {
    case 'eval_task':
      if (!str(p.modelTargetId)) return '请选择评估对象';
      if (strings(p.questionSetIds).length === 0) return '请选择样本库';
      return null;
    case 'model_file_scan':
      if (p.source === 'library') return str(p.uploadId) ? null : '请选择模型库文件';
      return str(p.path).trim() ? null : '请选择扫描目录';
    case 'corpus_scan':
      return str(p.sourceScanId) ? null : '请选择要重扫的语料';
    case 'asset_discovery': {
      const targets = strings(p.targets);
      if (targets.length === 0) return '请填写扫描目标';
      const ports = Array.isArray(p.ports) ? p.ports : [];
      if (targets.some((t) => !isUrlTarget(t)) && ports.length === 0) return '请选择扫描端口';
      if (p.confirm !== true) return '需确认已获授权对目标主动探测';
      return null;
    }
    case 'fleet_posture':
      if (!str(p.endpointId)) return '请选择终端';
      if (Array.isArray(p.items) && p.items.length === 0) return '请至少选择一个体检项';
      return null;
  }
}

type Emit = (params: JobItemParams, problem?: string | null) => void;

/** 后端校验返回的问题（zod issues 的 path 用点连起来），按字段显示在对应控件下。 */
export interface JobItemIssue {
  path: string;
  message: string;
}

export interface JobItemEditorProps {
  kind: DetectJobItemKind;
  value: unknown;
  /** problem 为 null 表示参数齐全，可以提交。 */
  onChange: (params: JobItemParams, problem: string | null) => void;
  /** 可选：后端指出的字段问题 */
  issues?: JobItemIssue[];
}

export function JobItemEditor({ kind, value, onChange, issues }: JobItemEditorProps) {
  const params = normalizeJobItemParams(kind, value);
  const emit: Emit = (next, problem) => {
    const normalized = normalizeJobItemParams(kind, next);
    onChange(normalized, problem === undefined ? jobItemProblem(kind, normalized) : problem);
  };
  const errorOf = (field: string) =>
    issues?.find((i) => i.path === field || i.path.startsWith(`${field}.`))?.message;
  const props = { params, emit, errorOf };
  switch (kind) {
    case 'eval_task':
      return <EvalTaskFields {...props} />;
    case 'model_file_scan':
      return <ModelFileFields {...props} />;
    case 'corpus_scan':
      return <CorpusFields {...props} />;
    case 'asset_discovery':
      return <AssetDiscoveryFields {...props} />;
    case 'fleet_posture':
      return <FleetPostureFields {...props} />;
  }
}

interface FieldsProps {
  params: JobItemParams;
  emit: Emit;
  errorOf: (field: string) => string | undefined;
}

const boxClass = 'max-h-40 space-y-1.5 overflow-y-auto rounded border border-line p-3';

function EvalTaskFields({ params, emit, errorOf }: FieldsProps) {
  const id = useId();
  const platformAppEnabled = usePlatformAppEnabled();
  const targets = useQuery({
    queryKey: ['model-targets', 'job-item-options'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 100 }),
  });
  const sets = useQuery({
    queryKey: ['question-sets', 'job-item-options'],
    queryFn: () => api.questionSets.list({ page: 1, pageSize: 100 }),
  });
  const engines = useQuery({
    queryKey: ['engines-catalog'],
    queryFn: () => api.engines.list(),
    staleTime: 60 * 60 * 1000,
  });
  const setIds = strings(params.questionSetIds);
  const chosenEngines = strings(params.engines);
  const toggle = (field: 'questionSetIds' | 'engines', value: string) => {
    const current = field === 'engines' ? chosenEngines : setIds;
    const next = current.includes(value) ? current.filter((x) => x !== value) : [...current, value];
    emit({ ...params, [field]: next });
  };
  // 只列内容评估能用的对象（终端智能体、网关日志、停用的都不列）；已选的照常列出，方便看清和改掉。
  const selectedTarget = str(params.modelTargetId);
  const targetItems = (targets.data?.items ?? []).filter(
    (t) => isContentEvalTarget(t, platformAppEnabled) || t.id === selectedTarget,
  );
  // 打开时已选的样本库排在前面：固定高度的滚动框里一眼能看到选了哪些。
  const [initialPicked] = useState(() => new Set(setIds));
  const setItems = (sets.data?.items ?? [])
    .filter((s) => (s.enabled !== false && s.kind !== 'run') || setIds.includes(s.id))
    .sort((a, b) => Number(initialPicked.has(b.id)) - Number(initialPicked.has(a.id)));
  return (
    <div className="grid gap-3">
      <Field label="评估对象" htmlFor={`${id}-target`} required error={errorOf('modelTargetId')}>
        <Select
          id={`${id}-target`}
          value={str(params.modelTargetId)}
          onChange={(e) => emit({ ...params, modelTargetId: e.target.value })}
        >
          <option value="">请选择</option>
          {targetItems.map((t) => (
            <option key={t.id} value={t.id}>
              {t.isActive ? t.name : `${t.name}（已禁用）`}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={setIds.length ? `样本库（已选 ${setIds.length} 个）` : '样本库'}
        required
        error={errorOf('questionSetIds')}
      >
        <div role="group" aria-label="样本库" className={boxClass}>
          {sets.isLoading ? (
            <Spinner className="h-4 w-4" />
          ) : (
            setItems.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={setIds.includes(s.id)}
                  onChange={() => toggle('questionSetIds', s.id)}
                />
                <span>{s.enabled === false ? `${s.name}（已禁用）` : s.name}</span>
              </label>
            ))
          )}
        </div>
      </Field>
      <Field label="安全引擎" error={errorOf('engines')}>
        <div
          role="group"
          aria-label="安全引擎"
          className="flex flex-wrap gap-x-4 gap-y-1.5 rounded border border-line p-3"
        >
          {engines.isLoading ? (
            <Spinner className="h-4 w-4" />
          ) : (
            (engines.data ?? [])
              .filter((e) => e.builtin || e.available)
              .map((e) => {
                const required = REQUIRED_ENGINES.includes(e.engine);
                return (
                  <label key={e.engine} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={required || chosenEngines.includes(e.engine)}
                      disabled={required}
                      onChange={() => toggle('engines', e.engine)}
                    />
                    <span>{engineLabel(e.engine)}</span>
                  </label>
                );
              })
          )}
        </div>
      </Field>
    </div>
  );
}

function ModelFileFields({ params, emit, errorOf }: FieldsProps) {
  const id = useId();
  const source = params.source === 'library' ? 'library' : 'directory';
  const keep = str(params.targetId) ? { targetId: params.targetId } : {};
  const config = useQuery({
    queryKey: ['model-files', 'config'],
    queryFn: () => modelFilesApi.config(),
    enabled: source === 'directory',
  });
  const library = useQuery({
    queryKey: ['model-files', 'library', 'job-item-options'],
    queryFn: () => modelFilesApi.library({ page: 1, pageSize: 100 }),
    enabled: source === 'library',
  });
  const roots = config.data?.rootDetails ?? [];
  return (
    <div className="space-y-3">
      <RadioPills
        name={`${id}-source`}
        options={[
          { value: 'directory', label: '服务器目录' },
          { value: 'library', label: '模型库文件' },
        ]}
        value={source}
        onChange={(v) =>
          emit(
            v === 'library'
              ? { source: 'library', uploadId: '', ...keep }
              : { source: 'directory', path: '', ...keep },
          )
        }
      />
      {source === 'directory' ? (
        <>
          <Field label="扫描目录" htmlFor={`${id}-path`} required error={errorOf('path')}>
            <Input
              id={`${id}-path`}
              value={str(params.path)}
              onChange={(e) => emit({ source: 'directory', path: e.target.value, ...keep })}
            />
          </Field>
          {config.isLoading ? (
            <Spinner className="h-4 w-4" />
          ) : roots.length > 0 ? (
            <DirectoryBrowser
              roots={roots}
              scanning={false}
              actionLabel="选择此目录"
              crumbsInBar
              onScan={(path) => emit({ source: 'directory', path, ...keep })}
            />
          ) : (
            <p className="text-[13px] text-ink-3">管理员还没有配置允许扫描的目录</p>
          )}
        </>
      ) : (
        <Field label="模型库文件" htmlFor={`${id}-upload`} required error={errorOf('uploadId')}>
          <Select
            id={`${id}-upload`}
            value={str(params.uploadId)}
            onChange={(e) => emit({ source: 'library', uploadId: e.target.value, ...keep })}
          >
            <option value="">请选择</option>
            {(library.data?.items ?? [])
              .filter((f) => f.status === 'READY')
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.fileName}
                </option>
              ))}
          </Select>
        </Field>
      )}
    </div>
  );
}

function CorpusFields({ params, emit, errorOf }: FieldsProps) {
  const id = useId();
  const scans = useQuery({
    queryKey: ['corpus-scans', 'job-item-options'],
    queryFn: () => corpusScansApi.list({ page: 1, pageSize: 100 }),
  });
  const ruleSets = useQuery({
    queryKey: ['corpus-rules', 'sets'],
    queryFn: () => corpusRulesApi.listSets(),
  });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="重扫的语料" htmlFor={`${id}-scan`} required error={errorOf('sourceScanId')}>
        <Select
          id={`${id}-scan`}
          value={str(params.sourceScanId)}
          onChange={(e) => emit({ ...params, sourceScanId: e.target.value })}
        >
          <option value="">请选择</option>
          {/* 原文件已清理的扫描没法重扫，不列 */}
          {(scans.data?.items ?? [])
            .filter((s) => !s.filesPurgedAt || s.id === str(params.sourceScanId))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.fileName}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="规则集" htmlFor={`${id}-rules`} error={errorOf('ruleSetId')}>
        <Select
          id={`${id}-rules`}
          value={str(params.ruleSetId)}
          onChange={(e) => emit({ ...params, ruleSetId: e.target.value || null })}
        >
          <option value="">内置规则</option>
          {(ruleSets.data?.items ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

const portsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function AssetDiscoveryFields({ params, emit, errorOf }: FieldsProps) {
  const id = useId();
  const [targetsText, setTargetsText] = useState(() => strings(params.targets).join('\n'));
  const [portsText, setPortsText] = useState(() => portsOf(params.ports).join(', '));
  const confirm = params.confirm === true;
  // 受控：记住最后一次发出的规范值；父组件传进来的值和它不一样（换了值），按新值重置文本。
  const canonical = JSON.stringify([strings(params.targets), portsOf(params.ports)]);
  const lastEmitted = useRef(canonical);
  useEffect(() => {
    if (canonical === lastEmitted.current) return;
    lastEmitted.current = canonical;
    setTargetsText(strings(params.targets).join('\n'));
    setPortsText(portsOf(params.ports).join(', '));
    // 只在规范值变化时同步（params 每次渲染都是新对象）
  }, [canonical]);
  const scope = useQuery({
    queryKey: ['asset-discovery', 'scope'],
    queryFn: () => assetDiscoveryApi.scope(),
  });
  const push = (tText: string, pText: string, confirmed: boolean) => {
    const ports = parsePorts(pText);
    const next = { targets: splitList(tText), ports: ports ?? [], confirm: confirmed };
    lastEmitted.current = JSON.stringify([next.targets, next.ports]);
    emit(next, ports === null ? '端口写法不正确' : jobItemProblem('asset_discovery', next));
  };
  const scopePorts = scope.data?.ports ?? [];
  return (
    <div className="grid gap-3">
      <Field label="扫描目标" htmlFor={`${id}-targets`} required error={errorOf('targets')}>
        <Textarea
          id={`${id}-targets`}
          rows={3}
          value={targetsText}
          placeholder="每行一个：IP、网段、主机名或 URL"
          onChange={(e) => {
            setTargetsText(e.target.value);
            push(e.target.value, portsText, confirm);
          }}
        />
      </Field>
      <Field label="端口" htmlFor={`${id}-ports`} error={errorOf('ports')}>
        <Input
          id={`${id}-ports`}
          value={portsText}
          placeholder={scopePorts.length ? scopePorts.join(', ') : '如 80, 443, 8000'}
          onChange={(e) => {
            setPortsText(e.target.value);
            push(targetsText, e.target.value, confirm);
          }}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirm}
          onChange={(e) => push(targetsText, portsText, e.target.checked)}
        />
        已获授权对目标主动探测
      </label>
      {errorOf('confirm') && <p className="text-[12.5px] text-destructive">{errorOf('confirm')}</p>}
    </div>
  );
}

function FleetPostureFields({ params, emit, errorOf }: FieldsProps) {
  const id = useId();
  const endpoints = useQuery({
    queryKey: ['fleet', 'endpoints', 'job-item-options'],
    queryFn: () => api.fleet.endpoints({ status: 'ACTIVE', page: 1, pageSize: 100 }),
  });
  const catalog = useQuery({
    queryKey: ['fleet', 'check-catalog'],
    queryFn: () => api.fleet.checkCatalog(),
  });
  const all = catalog.data?.posture ?? [];
  // 不传 items 表示全部体检项。
  const selected = Array.isArray(params.items) ? strings(params.items) : all.map((c) => c.id);
  const endpointId = str(params.endpointId);
  const withItems = (items: string[] | undefined) =>
    items && items.length !== all.length ? { endpointId, items } : { endpointId };
  const toggle = (checkId: string) =>
    emit(
      withItems(
        selected.includes(checkId) ? selected.filter((x) => x !== checkId) : [...selected, checkId],
      ),
    );
  return (
    <div className="grid gap-3">
      <Field label="终端" htmlFor={`${id}-endpoint`} required error={errorOf('endpointId')}>
        <Select
          id={`${id}-endpoint`}
          value={endpointId}
          onChange={(e) =>
            emit({
              ...(Array.isArray(params.items) ? { items: params.items } : {}),
              endpointId: e.target.value,
            })
          }
        >
          <option value="">请选择</option>
          {(endpoints.data?.items ?? []).map((ep) => (
            <option key={ep.id} value={ep.id}>
              {ep.osUser ? `${ep.hostname}（${ep.osUser}）` : ep.hostname}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="体检项" error={errorOf('items')}>
        <div role="group" aria-label="体检项" className={boxClass}>
          {catalog.isLoading ? (
            <Spinner className="h-4 w-4" />
          ) : (
            all.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(c.id)}
                  onChange={() => toggle(c.id)}
                />
                <span>{c.title}</span>
              </label>
            ))
          )}
        </div>
      </Field>
    </div>
  );
}
