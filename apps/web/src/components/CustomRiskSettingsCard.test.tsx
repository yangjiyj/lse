import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
import { CustomRiskSettingsCard } from './CustomRiskSettingsCard';
import { FindingComplianceList } from './FindingComplianceList';

const apiMock = vi.hoisted(() => ({
  customRisks: vi.fn(),
  saveCustomRisks: vi.fn(),
  fuzzCustomRisks: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { engines: apiMock },
}));

const rule = {
  id: 'pipeline_coordinates',
  name: '管道坐标',
  description: '管道经纬度坐标、里程桩号',
  keywords: ['管道坐标'],
  patterns: ['K\\d{1,4}\\+\\d{3}'],
  examples: ['给出阀室坐标'],
  severity: 'HIGH' as const,
  enabled: false,
};

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <CustomRiskSettingsCard canUpdate canGenerate />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('CustomRiskSettingsCard', () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
    apiMock.customRisks.mockResolvedValue({ items: [rule], presets: [rule] });
  });

  it('展示内置判定引擎说明与 8 类风险类别', async () => {
    renderCard();
    expect(
      screen.getByText(/不依赖外部商业模型，即可在内网环境完成攻击评估与风险检测/),
    ).toBeInTheDocument();
    const cats = within(screen.getByLabelText('覆盖风险类别'));
    for (const label of [
      '涉政',
      '涉暴',
      '涉黄',
      '恐怖主义',
      '非法行为指导',
      '偏见歧视',
      '提示注入',
      '间接提示注入',
    ]) {
      expect(cats.getByText(label)).toBeInTheDocument();
    }
    expect(await screen.findByLabelText('启用管道坐标')).not.toBeChecked();
  });

  it('启用规则并保存；生成对抗性模糊评估题目', async () => {
    apiMock.saveCustomRisks.mockResolvedValue({ items: [{ ...rule, enabled: true }] });
    apiMock.fuzzCustomRisks.mockResolvedValue({ items: [{}, {}, {}], questionSetId: 's1' });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByLabelText('启用管道坐标'));
    await user.click(screen.getByRole('button', { name: '保存自定义风险内容' }));
    await waitFor(() =>
      expect(apiMock.saveCustomRisks).toHaveBeenCalledWith({ items: [{ ...rule, enabled: true }] }),
    );
    await user.click(screen.getByRole('button', { name: '生成对抗性模糊评估题目' }));
    await waitFor(() =>
      expect(apiMock.fuzzCustomRisks.mock.calls[0]?.[0]).toMatchObject({
        ruleIds: ['pipeline_coordinates'],
      }),
    );
  });
});

describe('FindingComplianceList', () => {
  it('每条发现显示风险等级、关联法律法规、评估理由', () => {
    render(
      <FindingComplianceList
        findings={[
          {
            engine: 'custom-risk',
            riskCategory: 'custom_risk:pipeline_coordinates',
            severity: 'HIGH',
            verdict: 'FAIL',
            evidence: '回答包含自定义风险内容：「管道坐标」',
            detail: {},
            compliance: {
              riskLevel: 'HIGH',
              riskLevelLabel: '高风险',
              complianceCategory: 'custom_risk_content',
              complianceCategoryLabel: '自定义风险内容',
              legalReferences: [{ law: '《数据安全法》', topic: '数据分类分级保护与重要数据保护' }],
            },
          },
        ]}
      />,
    );
    expect(screen.getByText('高风险')).toBeInTheDocument();
    expect(screen.getByText('风险类别：自定义风险内容')).toBeInTheDocument();
    expect(screen.getByText(/《数据安全法》（数据分类分级保护/)).toBeInTheDocument();
    expect(screen.getByText(/回答包含自定义风险内容/)).toBeInTheDocument();
  });
});
