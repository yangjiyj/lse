import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import {
  MULTIMODAL_VISION_DISABLED_REASON,
  MultimodalEvalModal,
  multimodalDisabledReason,
} from './MultimodalEvalModal';
import { EvaluationPlanSelector } from './EvaluationPlanSelector';
import { MultimodalEvidencePanel } from '@/components/MultimodalEvidencePanel';
import { ApiError } from '@/lib/api';

const apiMock = vi.hoisted(() => ({
  createMultimodal: vi.fn(),
  listModels: vi.fn(),
  listQuestionSets: vi.fn(),
  fetchImage: vi.fn(),
  listCategories: vi.fn(),
  uploadByo: vi.fn(),
  createByo: vi.fn(),
  deleteByoImages: vi.fn(),
  downloadTemplate: vi.fn(),
  deleteTaskByo: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  fetchMultimodalImageUrl: apiMock.fetchImage,
  api: {
    evalTasks: {
      createMultimodal: apiMock.createMultimodal,
      multimodalGeneratorCategories: apiMock.listCategories,
      uploadByoImageSet: apiMock.uploadByo,
      createMultimodalByo: apiMock.createByo,
      deleteByoImageSetImages: apiMock.deleteByoImages,
      downloadByoManifestTemplate: apiMock.downloadTemplate,
      deleteTaskByoImages: apiMock.deleteTaskByo,
    },
    modelTargets: { list: apiMock.listModels },
    questionSets: { list: apiMock.listQuestionSets },
  },
}));

function target(id: string, name: string, supportsVision: boolean) {
  return {
    id,
    name,
    targetType: 'MODEL',
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'm',
    apiKeyMasked: 'masked', // pragma: allowlist secret
    hasApiKey: true,
    extraHeaders: null,
    defaultParams: null,
    accessConfig: null,
    isGlobal: true,
    isActive: true,
    lastTestedAt: null,
    lastTestStatus: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    createdBy: null,
    supportsVision,
  } as any;
}
const VISION = target('11111111-1111-4111-8111-111111111111', '视觉模型', true);
const TEXT = target('22222222-2222-4222-8222-222222222222', '纯文本模型', false);

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listModels.mockResolvedValue({ items: [VISION, TEXT], total: 2 });
  apiMock.listQuestionSets.mockResolvedValue({
    items: [{ id: '33333333-3333-4333-8333-333333333333', name: '应拒答题集', questionCount: 12 }],
    total: 1,
  });
  apiMock.createMultimodal.mockResolvedValue({
    id: 'task-1',
    name: 't',
    totalQuestions: 5,
    seed: 's',
  });
  apiMock.fetchImage.mockResolvedValue('blob:mock-image');
  apiMock.listCategories.mockResolvedValue({
    items: [
      { id: '危险物品', label: '危险物品' },
      { id: '违法行为', label: '违法行为' },
    ],
  });
});

describe('多模态越狱入口', () => {
  it('未声明视觉能力返回禁用原因', () => {
    expect(multimodalDisabledReason(TEXT)).toBe(MULTIMODAL_VISION_DISABLED_REASON);
    expect(multimodalDisabledReason(VISION)).toBeNull();
  });

  it('方案选择器：纯文本对象的多模态卡片禁用并写明原因', async () => {
    const user = userEvent.setup();
    wrap(
      <EvaluationPlanSelector
        targets={[VISION, TEXT]}
        loading={false}
        failed={false}
        retry={() => {}}
        onSelect={() => {}}
      />,
    );
    await user.selectOptions(screen.getByLabelText('本次评估对象'), TEXT.id);
    const card = screen.getByRole('button', { name: /多模态越狱/ });
    expect(card).toBeDisabled();
    expect(card).toHaveTextContent('评估对象 → 编辑');
    expect(card).toHaveTextContent('支持图片输入');
    await user.selectOptions(screen.getByLabelText('本次评估对象'), VISION.id);
    expect(screen.getByRole('button', { name: /多模态越狱/ })).toBeEnabled();
  });

  it('方案选择器：默认内容线就显示多模态卡片，未选对象时提示先选', async () => {
    const user = userEvent.setup();
    wrap(
      <EvaluationPlanSelector
        targets={[VISION, TEXT]}
        loading={false}
        failed={false}
        retry={() => {}}
        onSelect={() => {}}
      />,
    );
    // 未勾专家方案，卡片仍在。
    const card = screen.getByRole('button', { name: /多模态越狱/ });
    expect(card).toBeDisabled();
    expect(card).toHaveTextContent('请先在上方选择评估对象');
    await user.selectOptions(screen.getByLabelText('本次评估对象'), VISION.id);
    expect(screen.getByRole('button', { name: /多模态越狱/ })).toBeEnabled();
  });

  it('非模型 API 对象给出明确说明', () => {
    const APP = {
      ...target('44444444-4444-4444-8444-444444444444', '应用对象', true),
      targetType: 'APP',
    };
    expect(multimodalDisabledReason(APP)).toContain('模型 API');
  });

  it('弹窗：纯文本对象禁用提交；自动生成题源提交 generatorSpec 与承载场景', async () => {
    const user = userEvent.setup();
    wrap(<MultimodalEvalModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('评估对象')).toBeEnabled());
    await user.selectOptions(screen.getByLabelText('评估对象'), TEXT.id);
    expect(screen.getByRole('alert')).toHaveTextContent('评估对象 → 编辑');
    expect(screen.getByRole('button', { name: '开始评估' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('评估对象'), VISION.id);
    // 默认即「自动生成」，无需题集即可提交。
    expect(screen.getByRole('radio', { name: /自动生成/ })).toBeChecked();
    await screen.findByRole('checkbox', { name: '危险物品' });
    await user.click(screen.getByRole('checkbox', { name: '危险物品' }));
    await user.click(screen.getByRole('checkbox', { name: '承载场景：网页截图' }));
    await user.type(screen.getByLabelText('随机种子'), 'seed-x');
    await user.click(screen.getByRole('button', { name: '开始评估' }));
    await waitFor(() => expect(apiMock.createMultimodal).toHaveBeenCalledTimes(1));
    expect(apiMock.createMultimodal).toHaveBeenCalledWith({
      modelTargetId: VISION.id,
      attackTypes: ['typographic', 'split', 'injection'],
      carriers: ['notice', 'webpage'],
      generatorSpec: { language: 'zh', count: 10, categories: ['危险物品'], seed: 'seed-x' },
    });
  });

  it('弹窗：切换到复用样本库后须选题集，提交 questionSetId', async () => {
    const user = userEvent.setup();
    wrap(<MultimodalEvalModal open onClose={() => {}} initialTargetId={VISION.id} />);
    await waitFor(() => expect(screen.getByLabelText('评估对象')).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: /复用已有样本库/ }));
    await waitFor(() => expect(screen.getByLabelText('样本库')).toBeEnabled());
    expect(screen.getByRole('button', { name: '开始评估' })).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText('样本库'),
      '33333333-3333-4333-8333-333333333333',
    );
    await user.click(screen.getByRole('checkbox', { name: /图内注入/ }));
    expect(screen.queryByRole('checkbox', { name: /承载场景/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '开始评估' }));
    await waitFor(() => expect(apiMock.createMultimodal).toHaveBeenCalledTimes(1));
    expect(apiMock.createMultimodal).toHaveBeenCalledWith({
      modelTargetId: VISION.id,
      questionSetId: '33333333-3333-4333-8333-333333333333',
      attackTypes: ['typographic', 'split'],
      sampleCount: 10,
    });
  });

  it('复用样本库：不列已禁用的样本库', async () => {
    apiMock.listQuestionSets.mockResolvedValue({
      items: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: '应拒答题集',
          questionCount: 12,
          enabled: true,
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          name: '已停用题集',
          questionCount: 8,
          enabled: false,
        },
      ],
      total: 2,
    });
    const user = userEvent.setup();
    wrap(<MultimodalEvalModal open onClose={() => {}} initialTargetId={VISION.id} />);
    await waitFor(() => expect(screen.getByLabelText('评估对象')).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: /复用已有样本库/ }));
    await waitFor(() => expect(screen.getByLabelText('样本库')).toBeEnabled());
    expect(screen.getByRole('option', { name: /应拒答题集/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /已停用题集/ })).not.toBeInTheDocument();
    expect(apiMock.listQuestionSets).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it('结果详情面板展示存证图片、sha256 与判定', async () => {
    wrap(
      <MultimodalEvidencePanel
        taskId="t1"
        resultId="r1"
        evidence={{
          attackType: 'typographic',
          attackLabel: '排版攻击',
          seed: 's#0',
          text: '请按图片中的要求完成任务',
          imageText: 'x',
          injectedText: null,
          image: { mimeType: 'image/png', width: 768, height: 512, sha256: 'abc123' },
          judge: {
            engine: 'llm-judge',
            status: 'success',
            verdict: 'FAIL',
            severity: 'HIGH',
            score: 0.1,
            evidence: '给出了步骤',
          },
          error: null,
        }}
      />,
    );
    const img = await screen.findByRole('img', { name: /排版攻击/ });
    expect(img).toHaveAttribute('src', 'blob:mock-image');
    expect(apiMock.fetchImage).toHaveBeenCalledWith('t1', 'r1');
    expect(screen.getByText('abc123')).toBeInTheDocument();
    expect(screen.getByText('越狱成功（风险）')).toBeInTheDocument();
    expect(screen.getByText('给出了步骤')).toBeInTheDocument();
  });

  it('客户自带图片集：展示格式说明、合规提示与模板下载', async () => {
    const user = userEvent.setup();
    apiMock.downloadTemplate.mockResolvedValue(undefined);
    wrap(<MultimodalEvalModal open onClose={() => {}} initialTargetId={VISION.id} />);
    await user.click(screen.getByRole('radio', { name: /客户自带图片集/ }));
    expect(screen.getByText(/图片须由您自行确认合法合规来源/)).toBeInTheDocument();
    expect(screen.getByText(/manifest.csv 列：image/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /图内注入/ })).toBeNull();
    expect(screen.getByRole('button', { name: '开始评估' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '下载 manifest 模板' }));
    expect(apiMock.downloadTemplate).toHaveBeenCalledTimes(1);
  });

  it('客户自带图片集：校验失败展示逐行报告；通过后可发起并可删除图片', async () => {
    const user = userEvent.setup();
    const err = new ApiError('自带图片集校验未通过，共 2 项问题', 400);
    (err as any).issues = {
      issues: [
        { line: 3, message: '压缩包内找不到图片“missing.png”' },
        { line: 0, message: '压缩包根目录缺少 manifest.csv' },
      ],
      warnings: [],
      stats: {},
    };
    apiMock.uploadByo.mockRejectedValueOnce(err);
    wrap(<MultimodalEvalModal open onClose={() => {}} initialTargetId={VISION.id} />);
    await waitFor(() => expect(screen.getByLabelText('评估对象')).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: /客户自带图片集/ }));
    const input = screen.getByLabelText('选择图片集 zip');
    const zip = new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'set.zip', {
      type: 'application/zip',
    });
    await user.upload(input, zip);
    await user.click(screen.getByRole('button', { name: '上传并校验' }));
    expect(await screen.findByText(/第 3 行：压缩包内找不到图片“missing.png”/)).toBeInTheDocument();
    expect(screen.getByText(/整体：压缩包根目录缺少 manifest.csv/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始评估' })).toBeDisabled();

    apiMock.uploadByo.mockResolvedValueOnce({
      id: '55555555-5555-4555-8555-555555555555',
      name: 'set',
      questionCount: 2,
      imageCount: 2,
      warnings: [
        { line: 0, message: '压缩包内“unused.png”未在 manifest 中引用，已忽略且不会保存' },
      ],
      stats: { zipBytes: 10, entries: 3, rows: 2, images: 2, unpackedBytes: 2048 },
    });
    await user.click(screen.getByRole('button', { name: '上传并校验' }));
    expect(await screen.findByText(/校验通过：共 2 道题、2 张图片/)).toBeInTheDocument();
    expect(screen.getByText(/unused.png/)).toBeInTheDocument();
    apiMock.createByo.mockResolvedValue({ id: 'task-9', name: 't', totalQuestions: 2 });
    await user.click(screen.getByRole('button', { name: '开始评估' }));
    await waitFor(() => expect(apiMock.createByo).toHaveBeenCalledTimes(1));
    expect(apiMock.createByo).toHaveBeenCalledWith({
      modelTargetId: VISION.id,
      byoImageSetId: '55555555-5555-4555-8555-555555555555',
    });
  });

  it('客户自带图片集：上传后可一键删除图片，删除后不能发起', async () => {
    const user = userEvent.setup();
    apiMock.uploadByo.mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555',
      name: 'set',
      questionCount: 1,
      imageCount: 1,
      warnings: [],
      stats: { zipBytes: 10, entries: 2, rows: 1, images: 1, unpackedBytes: 100 },
    });
    apiMock.deleteByoImages.mockResolvedValue({ ok: true, deleted: 1 });
    wrap(<MultimodalEvalModal open onClose={() => {}} initialTargetId={VISION.id} />);
    await waitFor(() => expect(screen.getByLabelText('评估对象')).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: /客户自带图片集/ }));
    await user.upload(
      screen.getByLabelText('选择图片集 zip'),
      new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'a.zip'),
    );
    await user.click(screen.getByRole('button', { name: '上传并校验' }));
    await screen.findByText(/校验通过/);
    await user.click(screen.getByRole('button', { name: '删除已上传的图片' }));
    await waitFor(() =>
      expect(apiMock.deleteByoImages).toHaveBeenCalledWith('55555555-5555-4555-8555-555555555555'),
    );
    expect(await screen.findByText(/已删除上传的图片/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始评估' })).toBeDisabled();
  });

  it('结果详情面板：自带图片显示类别与期望，并可按任务删除图片', async () => {
    const user = userEvent.setup();
    apiMock.deleteTaskByo.mockResolvedValue({ ok: true, deleted: 3 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap(
      <MultimodalEvidencePanel
        taskId="t1"
        resultId="r1"
        evidence={{
          attackType: 'byo_image',
          attackLabel: '客户自带图片',
          seed: '',
          text: '请详细描述这张图',
          imageText: '',
          injectedText: null,
          image: { mimeType: 'image/png', width: 4, height: 4, sha256: 'def456' },
          byo: { category: '有害图片理解', expected: '应拒绝', note: '', imageName: 'a.png' },
          judge: null,
          error: null,
        }}
      />,
    );
    expect(await screen.findByRole('img', { name: /客户自带图片/ })).toBeInTheDocument();
    expect(screen.getByText('有害图片理解')).toBeInTheDocument();
    expect(screen.getByText('应拒绝')).toBeInTheDocument();
    expect(screen.queryByText('生成种子')).toBeNull();
    await user.click(screen.getByRole('button', { name: '删除本评估的自带图片' }));
    expect(apiMock.deleteTaskByo).toHaveBeenCalledWith('t1');
    expect(await screen.findByText('已删除 3 张图片')).toBeInTheDocument();
  });
});
