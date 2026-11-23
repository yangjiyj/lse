import { Link } from 'react-router-dom';
import type { RagAlignmentMode } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/page-kit/SectionCard';

export const MODE_DETAIL: Record<
  RagAlignmentMode,
  { label: string; summary: string; needs: string[]; metrics: string }
> = {
  KB_EXISTING: {
    label: '已有知识库',
    summary: '被测系统的知识库里已经有与测试文档一致的内容（例如同一批制度文件）。',
    needs: [
      '上传与被测知识库一致的文档',
      '发起前勾选确认“这些文档已在被测系统知识库中并完成索引”（写入审计）',
    ],
    metrics:
      '正确性、忠实度（需配置检索上下文路径）、引用准确性（需配置引用路径）、无答案拒答（未拒答时标记需人工复核）',
  },
  TEST_PACKAGE: {
    label: '测试知识库包',
    summary:
      '平台用测试文档生成测试知识库包，导入被测系统的专用测试知识库。',
    needs: [
      '被测对象配置了上传接口：运行时自动上传、等待索引就绪、结束后清理',
      '或下载测试知识库包手工导入，发起时勾选“已导入”',
    ],
    metrics: '全部生成质量指标；索引就绪探测未通过时质量题记“未评估（原因）”',
  },
  RETRIEVAL_API: {
    label: '检索接口直评',
    summary: '直接调用被测系统的检索接口，评估检索是否命中来源文档。',
    needs: ['被测对象配置了检索接口与结果数组路径', '发起前确认文档已在被测知识库中并完成索引'],
    metrics: '检索命中率、平均倒数排名；不评估生成质量',
  },
};

export function ModeStep({
  mode,
  onChange,
  onNext,
}: {
  mode: RagAlignmentMode;
  onChange: (m: RagAlignmentMode) => void;
  onNext: () => void;
}) {
  return (
    <SectionCard title="2 · 知识对齐" bodyClassName="space-y-4">
      <>
        <p className="text-sm leading-6 text-ink-2">
          测试文档须与被测知识库一致；未对齐的题目不计分。
        </p>
        <div role="radiogroup" aria-label="知识对齐模式" className="grid gap-3 md:grid-cols-3">
          {(Object.keys(MODE_DETAIL) as RagAlignmentMode[]).map((m) => {
            const d = MODE_DETAIL[m];
            const active = m === mode;
            return (
              <label
                key={m}
                className={`flex cursor-pointer flex-col gap-2 rounded-card border p-4 text-sm ${
                  active ? 'border-brand-600' : 'border-line hover:border-line-2'
                }`}
              >
                <span className="flex items-center gap-2 font-medium text-ink">
                  <input
                    type="radio"
                    name="rag-mode"
                    checked={active}
                    onChange={() => onChange(m)}
                  />
                  {d.label}
                </span>
                <span className="leading-6 text-ink-2">{d.summary}</span>
              </label>
            );
          })}
        </div>
        <details className="text-xs text-ink-3"><summary className="cursor-pointer">接入要求与评估范围</summary><p className="mt-2">{MODE_DETAIL[mode].needs.join('；')}。{MODE_DETAIL[mode].metrics}</p></details>
        <p className="text-xs text-ink-3">
          上传、删除、检索接口在
          <Link to="/model-targets" className="mx-1 text-brand-600 hover:underline">
            评估对象
          </Link>
          的“声明为 RAG 应用”分组中配置（仅智能体应用 API 类对象）。
        </p>
        <Button onClick={onNext}>下一步：准备测试文档</Button>
      </>
    </SectionCard>
  );
}
