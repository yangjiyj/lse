import { describe, it, expect } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { ResultDrill } from './ResultDrill';
import { result } from './test-fixtures';
import type { RagEvalResult } from '@/lib/api';

function renderDrill(over: Record<string, unknown>) {
  const r = result({ itemType: 'FACT', ...over }) as unknown as RagEvalResult;
  return render(<ResultDrill r={r} onClose={() => undefined} />);
}

describe('ResultDrill 单题下钻：上下文与引用结构化展示', () => {
  it('上下文每条一块：来源、分数、正文；不直接输出 JSON', () => {
    renderDrill({
      retrievedContext: [
        { id: '差旅制度.md', text: '差旅报销须在十五个工作日内提交。', score: 0.8123 },
        { text: '住宿标准为每晚五百元。' },
      ],
      citations: [{ id: '差旅制度.md', text: null }],
    });
    const first = screen.getByRole('listitem', { name: '片段 1' });
    expect(within(first).getByText('差旅制度.md')).toBeInTheDocument();
    expect(within(first).getByText('0.812')).toBeInTheDocument();
    expect(within(first).getByText('差旅报销须在十五个工作日内提交。')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: '片段 2' })).getByText('未标注')).toBeInTheDocument();
    const cite = screen.getByRole('listitem', { name: '引用 1' });
    expect(within(cite).getByText('差旅制度.md')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/"text":|"id":/);
  });

  it('模式 C 的 { answerContext, retrieval } 分两组展示', () => {
    renderDrill({
      retrievedContext: { answerContext: [{ text: '回答用片段' }], retrieval: [{ id: 'doc-a', text: '检索片段', score: 1 }] },
    });
    expect(screen.getByText('回答时的检索上下文（1）')).toBeInTheDocument();
    expect(screen.getByText('检索接口返回（1）')).toBeInTheDocument();
    expect(screen.getByText('检索片段')).toBeInTheDocument();
    expect(screen.getByText('doc-a')).toBeInTheDocument();
  });

  it('未知结构回退为可折叠的格式化 JSON（缩进 2）', () => {
    renderDrill({ retrievedContext: [{ weird: { nested: 1 } }], citations: [42] });
    const toggles = screen.getAllByText('未识别的结构，展开查看原始 JSON');
    expect(toggles.length).toBe(2);
    fireEvent.click(toggles[0]!);
    const pre = document.querySelector('details pre')!;
    expect(pre.textContent).toBe(JSON.stringify({ weird: { nested: 1 } }, null, 2));
    expect(pre.closest('details')).not.toBeNull();
  });

  it('无上下文/无引用时给出原因', () => {
    renderDrill({ retrievedContext: null, citations: null });
    expect(screen.getByText('未取到（未配置检索上下文路径或响应中没有该字段）')).toBeInTheDocument();
    expect(screen.getByText('未返回引用（空引用不计分）')).toBeInTheDocument();
  });
});
