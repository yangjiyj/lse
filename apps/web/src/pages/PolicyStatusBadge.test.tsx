import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PolicyStatusBadge } from './PolicyStatusBadge';

describe('PolicyStatusBadge', () => {
  it('按状态显示中文标签', () => {
    const { rerender } = render(<PolicyStatusBadge status="PUBLISHED" />);
    expect(screen.getByText('已发布')).toBeInTheDocument();
    rerender(<PolicyStatusBadge status="GATEWAY_REJECTED" />);
    expect(screen.getByText('网关驳回')).toBeInTheDocument();
  });

  it('未知状态原样回显，不抛错', () => {
    render(<PolicyStatusBadge status="WEIRD" />);
    expect(screen.getByText('WEIRD')).toBeInTheDocument();
  });
});
