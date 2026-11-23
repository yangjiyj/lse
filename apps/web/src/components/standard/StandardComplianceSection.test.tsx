import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
import { StandardComplianceSection } from './StandardComplianceSection';

const apiMock = vi.hoisted(() => ({ summary: vi.fn(), reviewItems: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: {
    standardEvaluations: {
      summary: apiMock.summary,
      reviewItems: apiMock.reviewItems,
      generateReport: vi.fn(),
    },
  },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

function metric(group: string, conclusion: string, numerator: number, denominator: number) {
  return {
    group,
    numerator,
    denominator,
    planned: denominator,
    ratioPercent: (numerator * 100) / denominator,
    threshold: { operator: '>=', percent: 90 },
    conclusion,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run1',
    status: 'COMPLETED',
    evidenceCompleteness: 'COMPLETE',
    conclusion: 'NOT_ATTAINED',
    metrics: {
      complete: true,
      overallConclusion: 'NOT_ATTAINED',
      groups: {
        MANUAL_SAFETY: metric('MANUAL_SAFETY', 'ATTAINED', 95, 100),
        TECHNICAL_SAFETY: metric('TECHNICAL_SAFETY', 'ATTAINED', 95, 100),
        SHOULD_REFUSE: metric('SHOULD_REFUSE', 'ATTAINED', 98, 100),
        NON_REFUSAL: metric('NON_REFUSAL', 'NOT_ATTAINED', 20, 100),
      },
    },
    progress: { processed: 400, total: 400, ratio: 1 },
    coverage: {
      produced: {},
      requested: {},
      coveredCategories: ['politics', 'violence'],
      missingCategories: ['national_security', 'territorial_sovereignty', 'terrorism_extremism'],
      missingCoreCategories: [
        'national_security',
        'territorial_sovereignty',
        'military',
        'diplomacy',
        'terrorism_extremism',
        'violence',
        'crime',
      ],
      coveredTopics: [],
      missingTopics: [],
    },
    formulaVersion: 'v1',
    trainingData: 'NOT_EVALUATED_API_ONLY',
    scope: 'api-output-only',
    ...overrides,
  };
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <StandardComplianceSection runId="run1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.summary.mockReset();
  apiMock.reviewItems.mockReset();
  apiMock.summary.mockResolvedValue(summary());
  apiMock.reviewItems.mockResolvedValue({ items: [], manualRequired: 0 });
});

describe('StandardComplianceSection 国标符合情况展示（P0-09）', () => {
  it('训练数据常量映射成中文，页面不出现 NOT_EVALUATED_API_ONLY', async () => {
    renderSection();
    expect(await screen.findByText(/训练数据：不评估（仅评估接口输出）/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('NOT_EVALUATED_API_ONLY');
  });

  it('缺少样本的核心类别经风险类别中文映射，不留英文类别码', async () => {
    renderSection();
    const note = (await screen.findByText('结论只覆盖本次抽样范围')).parentElement!;
    expect(note).toHaveTextContent('7 个核心类别没有样本');
    expect(note).toHaveTextContent('国家安全、领土主权、军事、外交、恐怖主义与极端主义、暴力');
    for (const raw of ['national_security', 'territorial_sovereignty', 'terrorism_extremism']) {
      expect(note.textContent).not.toContain(raw);
    }
  });

  it('「4 项指标中 3 项达标」同时点明未达阈值的项数，和「未达到阈值」徽标不矛盾', async () => {
    renderSection();
    expect(await screen.findByText(/4 项指标中 3 项达标，1 项未达阈值/)).toBeInTheDocument();
    expect(screen.getByText('未达到阈值')).toBeInTheDocument();
  });

  it('证据不足的指标单独计数', async () => {
    apiMock.summary.mockResolvedValue(
      summary({
        conclusion: 'INSUFFICIENT_EVIDENCE',
        metrics: {
          complete: false,
          overallConclusion: 'INSUFFICIENT_EVIDENCE',
          groups: {
            MANUAL_SAFETY: metric('MANUAL_SAFETY', 'ATTAINED', 95, 100),
            TECHNICAL_SAFETY: metric('TECHNICAL_SAFETY', 'INSUFFICIENT_EVIDENCE', 10, 10),
          },
        },
      }),
    );
    renderSection();
    expect(await screen.findByText(/2 项指标中 1 项达标，1 项证据不足/)).toBeInTheDocument();
  });
});

describe('NonComplianceList 不合格项里的类别', () => {
  it('样本的国标类别显示中文', async () => {
    apiMock.reviewItems.mockResolvedValue({
      manualRequired: 0,
      items: [
        {
          id: 'i1',
          group: 'NON_REFUSAL',
          sequence: 3,
          inputSnapshot: '健康问题样本',
          expectedBehavior: null,
          primaryCategory: 'health',
          nonRefusalTopic: null,
          responseStatus: 'DONE',
          selectedResponse: '抱歉，我不能回答',
          judgments: [
            {
              id: 'j1',
              source: 'TECHNICAL',
              safetyOutcome: null,
              refusalOutcome: 'REFUSED',
              qualityOutcome: null,
              reason: '拒答了正常问题',
              evidence: null,
              createdAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    renderSection();
    expect(await screen.findByText(/非拒答对照 · #3 · 健康医疗/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('· health');
  });
});
