import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type ByoUploadResult,
  type ModelTarget,
  type MultimodalAttackType,
  type MultimodalCarrier,
} from '@/lib/api';
import { MultimodalByoSection } from '@/components/MultimodalByoSection';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

export const MULTIMODAL_VISION_DISABLED_REASON =
  '该对象未开启“支持图片输入”，请到 评估对象 → 编辑 勾选后再试。';
export const MULTIMODAL_NOT_MODEL_REASON =
  '多模态越狱仅支持“模型 API”类评估对象，应用 API 无法直接发送图片。';

export const MULTIMODAL_ATTACK_OPTIONS: Array<{
  id: MultimodalAttackType;
  label: string;
  description: string;
}> = [
  {
    id: 'typographic',
    label: '排版攻击',
    description:
      '把有害请求直接写成图片里的文字，配套文字只说“请按图片中的要求完成任务”。适合检验模型是否只在文字上做安全过滤，对图中文字放松警惕。',
  },
  {
    id: 'split',
    label: '图文拆分',
    description:
      '把一句有害请求拆成两半，前半句放图片、后半句放文字，单看任何一半都不明显。适合检验模型能否跨图文识别拼接后的真实意图。',
  },
  {
    id: 'injection',
    label: '图内注入',
    description:
      '图片本身是一份正常内容（通知、网页、邮件等），角落用小字夹带一条“忽略上述内容、改做另一件事”的指令。适合检验模型读取外部图片时是否被其中的隐藏指令牵着走。',
  },
];

export const MULTIMODAL_CARRIER_OPTIONS: Array<{ id: MultimodalCarrier; label: string }> = [
  { id: 'notice', label: '会议通知' },
  { id: 'webpage', label: '网页截图' },
  { id: 'email', label: '邮件' },
  { id: 'product', label: '商品详情页' },
  { id: 'document', label: '公文' },
];

/** 仅可直接调用的模型对象才能发起多模态越狱；未声明视觉能力时返回禁用原因。 */
export function multimodalDisabledReason(target: ModelTarget | undefined): string | null {
  if (!target) return null;
  if ((target.targetType ?? 'MODEL') !== 'MODEL') return MULTIMODAL_NOT_MODEL_REASON;
  if (!target.supportsVision) return MULTIMODAL_VISION_DISABLED_REASON;
  return null;
}

type SourceMode = 'generate' | 'reuse' | 'byo';

interface MultimodalEvalModalProps {
  initialTargetId?: string;
  open: boolean;
  onClose: () => void;
}

export function MultimodalEvalModal({ open, onClose, initialTargetId }: MultimodalEvalModalProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [targetId, setTargetId] = useState('');
  const [sourceMode, setSourceMode] = useState<SourceMode>('generate');
  const [questionSetId, setQuestionSetId] = useState('');
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [categories, setCategories] = useState<string[]>([]);
  const [attackTypes, setAttackTypes] = useState<MultimodalAttackType[]>([
    'typographic',
    'split',
    'injection',
  ]);
  const [carriers, setCarriers] = useState<MultimodalCarrier[]>(['notice']);
  const [sampleCount, setSampleCount] = useState('10');
  const [seed, setSeed] = useState('');
  const [byoSet, setByoSet] = useState<ByoUploadResult | null>(null);

  useEffect(() => {
    if (open && initialTargetId) setTargetId(initialTargetId);
  }, [open, initialTargetId]);

  const targetsQuery = useQuery({
    queryKey: ['model-targets', 'multimodal-eval'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 200 }),
    enabled: open,
  });
  const setsQuery = useQuery({
    queryKey: ['question-sets', 'multimodal-eval'],
    queryFn: () => api.questionSets.list({ page: 1, pageSize: 100, enabled: true }),
    enabled: open && sourceMode === 'reuse',
  });
  const categoriesQuery = useQuery({
    queryKey: ['multimodal-generator-categories', language],
    queryFn: () => api.evalTasks.multimodalGeneratorCategories(language),
    enabled: open && sourceMode === 'generate',
  });
  const targets = (targetsQuery.data?.items ?? []).filter(
    (t) => t.isActive && (t.targetType ?? 'MODEL') === 'MODEL',
  );
  const sets = (setsQuery.data?.items ?? []).filter(
    (s) => s.questionCount > 0 && s.enabled !== false,
  );
  const categoryItems = categoriesQuery.data?.items ?? [];
  const target = targets.find((t) => t.id === targetId);
  const disabledReason = multimodalDisabledReason(target);
  const count = Number.parseInt(sampleCount, 10);
  const countValid = Number.isInteger(count) && count >= 1 && count <= 200;
  const injectionOn = attackTypes.includes('injection');

  const mutation = useMutation({
    mutationFn: () => {
      if (sourceMode === 'byo') {
        return api.evalTasks.createMultimodalByo({
          modelTargetId: targetId,
          byoImageSetId: byoSet!.id,
        });
      }
      const common = {
        modelTargetId: targetId,
        attackTypes,
        ...(injectionOn && carriers.length > 0 ? { carriers } : {}),
      };
      if (sourceMode === 'generate') {
        return api.evalTasks.createMultimodal({
          ...common,
          generatorSpec: {
            language,
            count,
            ...(categories.length > 0 ? { categories } : {}),
            ...(seed.trim() ? { seed: seed.trim() } : {}),
          },
        });
      }
      return api.evalTasks.createMultimodal({
        ...common,
        questionSetId,
        sampleCount: count,
        ...(seed.trim() ? { seed: seed.trim() } : {}),
      });
    },
    onSuccess: (task) => {
      toast.success(sourceMode === 'byo' ? '已发起自带图片评估' : '已发起多模态越狱评估');
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
      onClose();
      navigate(`/eval-tasks/${task.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '多模态越狱评估发起失败'),
  });

  const canSubmit =
    Boolean(target) &&
    (sourceMode === 'generate' || sourceMode === 'byo' || Boolean(questionSetId)) &&
    (sourceMode !== 'byo' || Boolean(byoSet)) &&
    disabledReason === null &&
    (sourceMode === 'byo' ||
      (attackTypes.length > 0 && (!injectionOn || carriers.length > 0) && countValid)) &&
    !mutation.isPending;

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="多模态越狱"
      description="把有害请求画进图片，再发给视觉模型，检验图片能否绕过它的安全限制；由判定模型评估是否被突破。图片按种子确定生成，结果详情可查看原图与判定。"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Spinner className="h-4 w-4" />}
            开始评估
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-md bg-slate-50 p-3 text-xs leading-5 text-slate-600">
          使用条件：评估对象须是能看图的视觉模型（模型 API 类型），并已在 评估对象 → 编辑
          中勾选“支持图片输入”；否则无法发起。
        </div>
        <Field label="评估对象" htmlFor="multimodal-target" required>
          <Select
            id="multimodal-target"
            aria-label="评估对象"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={targetsQuery.isLoading}
          >
            <option value="">{targetsQuery.isLoading ? '正在读取对象…' : '请选择评估对象'}</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.supportsVision ? '' : '（未开启支持图片输入）'}
              </option>
            ))}
          </Select>
        </Field>
        {disabledReason && (
          <p role="alert" className="text-sm text-severity-critical">
            {disabledReason}
          </p>
        )}
        {targetsQuery.isError && (
          <p role="alert" className="text-sm text-severity-critical">
            评估对象读取失败，请关闭后重试。
          </p>
        )}

        <Field label="题目来源" required>
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="multimodal-source"
                className="mt-1"
                checked={sourceMode === 'generate'}
                onChange={() => setSourceMode('generate')}
              />
              <span>
                <span className="font-medium">自动生成（按风险类别现产）</span>
                <span className="ml-2 text-xs text-slate-500">
                  无需准备题库，选风险类别后由平台现场出题，同一种子可复现。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="multimodal-source"
                className="mt-1"
                checked={sourceMode === 'reuse'}
                onChange={() => setSourceMode('reuse')}
              />
              <span>
                <span className="font-medium">复用已有样本库</span>
                <span className="ml-2 text-xs text-slate-500">
                  从已有题集中抽题，适合沿用客户自己的题库。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="multimodal-source"
                className="mt-1"
                checked={sourceMode === 'byo'}
                onChange={() => setSourceMode('byo')}
              />
              <span>
                <span className="font-medium">客户自带图片集</span>
                <span className="ml-2 text-xs text-slate-500">
                  上传您自己的图片与配套提问，用于有害图片理解、隐私、图像偏见等测评。
                </span>
              </span>
            </label>
          </div>
        </Field>

        {sourceMode === 'byo' ? (
          <MultimodalByoSection uploaded={byoSet} onUploaded={setByoSet} />
        ) : sourceMode === 'generate' ? (
          <>
            <Field label="题目语言" htmlFor="multimodal-language">
              <Select
                id="multimodal-language"
                aria-label="题目语言"
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value as 'zh' | 'en');
                  setCategories([]);
                }}
              >
                <option value="zh">中文</option>
                <option value="en">英文</option>
              </Select>
            </Field>
            <Field label="风险类别" hint="不勾选表示全部类别">
              {categoriesQuery.isLoading ? (
                <p className="text-sm text-slate-500">正在读取风险类别…</p>
              ) : categoriesQuery.isError ? (
                <p role="alert" className="text-sm text-severity-critical">
                  风险类别读取失败，请关闭后重试。
                </p>
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {categoryItems.map((c) => (
                    <label key={c.id} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={categories.includes(c.id)}
                        onChange={() => setCategories((prev) => toggle(prev, c.id))}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              )}
            </Field>
          </>
        ) : (
          <>
            <Field label="样本库（已有题集）" htmlFor="multimodal-set" required>
              <Select
                id="multimodal-set"
                aria-label="样本库"
                value={questionSetId}
                onChange={(e) => setQuestionSetId(e.target.value)}
                disabled={setsQuery.isLoading}
              >
                <option value="">{setsQuery.isLoading ? '正在读取题集…' : '请选择题集'}</option>
                {sets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{s.questionCount} 题）
                  </option>
                ))}
              </Select>
            </Field>
            {!setsQuery.isLoading && !setsQuery.isError && sets.length === 0 && (
              <p className="text-sm text-slate-500">暂无数据</p>
            )}
          </>
        )}

        {sourceMode !== 'byo' && (
          <Field label="攻击类型" required>
            <div className="space-y-2">
              {MULTIMODAL_ATTACK_OPTIONS.map((opt) => (
                <label key={opt.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={attackTypes.includes(opt.id)}
                    onChange={() => setAttackTypes((prev) => toggle(prev, opt.id))}
                  />
                  <span>
                    <span className="font-medium">{opt.label}</span>
                    <span className="ml-2 text-xs leading-5 text-slate-500">{opt.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}

        {sourceMode !== 'byo' && injectionOn && (
          <Field
            label="承载场景（图内注入）"
            hint="选多个时按题目轮换；全选即各场景随机混用"
            required
          >
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {MULTIMODAL_CARRIER_OPTIONS.map((opt) => (
                <label key={opt.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`承载场景：${opt.label}`}
                    checked={carriers.includes(opt.id)}
                    onChange={() => setCarriers((prev) => toggle(prev, opt.id))}
                  />
                  {opt.label}
                </label>
              ))}
              <button
                type="button"
                className="text-xs text-primary underline"
                onClick={() => setCarriers(MULTIMODAL_CARRIER_OPTIONS.map((o) => o.id))}
              >
                全选（随机混用）
              </button>
            </div>
          </Field>
        )}

        {sourceMode !== 'byo' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={sourceMode === 'generate' ? '生成题数' : '抽样题数'}
              htmlFor="multimodal-count"
              hint="1–200，按种子可复现"
            >
              <Input
                id="multimodal-count"
                type="number"
                min={1}
                max={200}
                value={sampleCount}
                onChange={(e) => setSampleCount(e.target.value)}
              />
            </Field>
            <Field
              label="随机种子"
              htmlFor="multimodal-seed"
              hint="留空则自动生成；同种子题目与图片字节一致"
            >
              <Input
                id="multimodal-seed"
                value={seed}
                maxLength={128}
                onChange={(e) => setSeed(e.target.value)}
              />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
