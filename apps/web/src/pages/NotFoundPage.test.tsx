import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotFoundPage } from './NotFoundPage';

describe('NotFoundPage', () => {
  it('说明页面不存在，显示用户访问的地址，并给出返回首页的链接', () => {
    render(
      <MemoryRouter initialEntries={['/this-page-does-not-exist']}>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('页面不存在')).toBeInTheDocument();
    expect(screen.getByText('/this-page-does-not-exist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');
  });
});
