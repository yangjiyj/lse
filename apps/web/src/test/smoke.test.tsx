import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('测试地基', () => {
  it('能渲染并断言 DOM', () => {
    render(<div>样本库生成地基就绪</div>);
    expect(screen.getByText('样本库生成地基就绪')).toBeInTheDocument();
  });
});
