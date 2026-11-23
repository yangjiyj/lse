import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NoteBar, SectionCard } from './SectionCard';

describe('SectionCard / NoteBar', () => {
  it('渲染标题、说明、右侧操作与内容', () => {
    render(
      <SectionCard title="扫描记录" description="最近的扫描" extra={<button>刷新</button>}>
        <div>内容区</div>
      </SectionCard>,
    );
    expect(screen.getByRole('heading', { name: '扫描记录' })).toBeInTheDocument();
    expect(screen.getByText('最近的扫描')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument();
    expect(screen.getByText('内容区')).toBeInTheDocument();
  });

  it('NoteBar 渲染说明文字', () => {
    render(<NoteBar>说明一句话</NoteBar>);
    expect(screen.getByText('说明一句话')).toBeInTheDocument();
  });
});
