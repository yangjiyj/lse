import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBrandingForTest, setBranding } from '@/lib/branding';
import { LoginPage } from './LoginPage';

// 登录页加载时会记一次访问、取登录页统计（W1），这里只关心技术支持一行，给空实现。
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    recordVisit: () => Promise.resolve(),
    loginStats: () => new Promise(() => undefined),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ login: vi.fn() }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe('登录页技术支持', () => {
  beforeEach(() => {
    resetBrandingForTest();
  });

  it('显示「技术支持：单位 · 联系人 · 电话」', () => {
    renderPage();
    act(() =>
      setBranding({
        supportOrg: '国家管网信息中心',
        contactName: '张工',
        contactPhone: '010-12345678',
        contactEmail: 'support@example.com',
      }),
    );
    expect(
      screen.getByText('技术支持：国家管网信息中心 · 张工 · 010-12345678'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/support@example.com/)).not.toBeInTheDocument();
  });

  it('没填的项不显示', () => {
    renderPage();
    act(() => setBranding({ supportOrg: '国家管网信息中心', contactPhone: '010-12345678' }));
    expect(screen.getByText('技术支持：国家管网信息中心 · 010-12345678')).toBeInTheDocument();
  });

  it('三项都没填时整行不显示', () => {
    renderPage();
    act(() => setBranding({ contactEmail: 'support@example.com' }));
    expect(screen.queryByText(/技术支持/)).not.toBeInTheDocument();
  });
});
