import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const authState = vi.hoisted(() => ({
  user: { username: 'admin', displayName: '管理员', roles: ['admin'] } as {
    username: string;
    displayName: string;
    roles: string[];
    passwordChangeRequired?: boolean;
  } | null,
}));

vi.mock('@/lib/auth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: authState.user,
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    hasPermission: () => true,
  }),
}));

// 页面本身与路由无关，用占位组件避免拉起整套接口请求。
vi.mock('@/pages/DashboardPage', () => ({ DashboardPage: () => <div>首页占位</div> }));
vi.mock('@/pages/ModelTargetsPage', () => ({ ModelTargetsPage: () => <div>评估对象占位</div> }));
vi.mock('@/pages/SettingsPage', () => ({ SettingsPage: () => <div>设置页占位</div> }));
vi.mock('@/pages/ReportsPage', () => ({ ReportsPage: () => <div>报告页占位</div> }));
vi.mock('@/pages/ledger/LedgerPage', () => ({ LedgerPage: () => <div>应用台账占位</div> }));
vi.mock('@/pages/ledger/LedgerAssetDetailPage', () => ({
  LedgerAssetDetailPage: () => <div>台账详情占位</div>,
}));

import App from './App';

function visit(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

describe('App 路由', () => {
  beforeEach(() => {
    authState.user = { username: 'admin', displayName: '管理员', roles: ['admin'] };
  });

  it('登录态下访问未知路径：显示「页面不存在」，地址不被改写，不再静默回首页', async () => {
    visit('/this-page-does-not-exist');
    expect(await screen.findByText('页面不存在')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/this-page-does-not-exist');
    expect(screen.queryByText('首页占位')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');
  });

  it('已有页面照常打开', async () => {
    visit('/');
    expect(await screen.findByText('首页占位')).toBeInTheDocument();
    expect(screen.queryByText('页面不存在')).not.toBeInTheDocument();
  });

  it('保留旧路径重定向：/license 仍跳到平台设置的授权许可分区', async () => {
    visit('/license');
    expect(await screen.findByText('设置页占位')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
    expect(window.location.hash).toBe('#license-settings');
  });

  it('备案材料页已删除：旧地址显示页面不存在', async () => {
    visit('/reports/filing');
    expect(await screen.findByText('页面不存在')).toBeInTheDocument();
    expect(screen.queryByText('补齐步骤')).not.toBeInTheDocument();
  });

  it('须改密的账号访问任何页面都跳到改密页', async () => {
    authState.user = {
      username: 'newbie',
      displayName: '新用户',
      roles: ['operator'],
      passwordChangeRequired: true,
    };
    visit('/settings');
    await waitFor(() => expect(window.location.pathname).toBe('/change-password'));
    expect(await screen.findByText('首次登录请修改密码')).toBeInTheDocument();
    expect(screen.queryByText('设置页占位')).not.toBeInTheDocument();
    expect(screen.getByText(/^当前密码/)).toBeInTheDocument();
  });

  it('不须改密时打开改密页回到首页', async () => {
    visit('/change-password');
    expect(await screen.findByText('首页占位')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('未登录访问未知路径：去登录页，而不是显示 404', async () => {
    authState.user = null;
    visit('/this-page-does-not-exist');
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(screen.queryByText('页面不存在')).not.toBeInTheDocument();
  });
});

it.each(['/external-assets', '/external-assets/old-id'])('旧外部资产地址 %s 重定向到评估对象', async (path) => {
  authState.user = { username: 'admin', displayName: '管理员', roles: ['admin'] };
  visit(path);
  expect(await screen.findByText('评估对象占位')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/model-targets');
});

it.each([
  ['/schemes/ledger', '/ledger', '应用台账占位'],
  ['/schemes/ledger/x', '/ledger/x', '台账详情占位'],
])('应用台账旧地址 %s 重定向到 %s', async (from, to, text) => {
  authState.user = { username: 'admin', displayName: '管理员', roles: ['admin'] };
  visit(from);
  expect(await screen.findByText(text)).toBeInTheDocument();
  expect(window.location.pathname).toBe(to);
});

it('应用台账旧地址重定向时保留查询参数', async () => {
  authState.user = { username: 'admin', displayName: '管理员', roles: ['admin'] };
  visit('/schemes/ledger?type=model');
  expect(await screen.findByText('应用台账占位')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/ledger');
  expect(window.location.search).toBe('?type=model');
});

it.each(['/schemes', '/schemes/sc1'])('检测方案页已去掉：%s 显示页面不存在', async (path) => {
  authState.user = { username: 'admin', displayName: '管理员', roles: ['admin'] };
  visit(path);
  expect(await screen.findByText('页面不存在')).toBeInTheDocument();
  expect(window.location.pathname).toBe(path);
});
