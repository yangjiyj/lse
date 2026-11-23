import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const meMock = vi.hoisted(() => vi.fn());

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: { ...actual.api, me: meMock } };
});

import { PASSWORD_CHANGE_REQUIRED_EVENT, setToken } from './api';
import { AuthProvider, useAuth } from './auth';

function Probe() {
  const { user } = useAuth();
  return <div>{user ? `须改密:${String(Boolean(user.passwordChangeRequired))}` : '未登录'}</div>;
}

describe('AuthProvider 响应须改密事件', () => {
  beforeEach(() => {
    localStorage.clear();
    meMock.mockReset();
  });

  it('收到 PASSWORD_CHANGE_REQUIRED 事件后重新拉取当前用户', async () => {
    setToken('test-token');
    meMock.mockResolvedValueOnce({ user: { username: 'u', passwordChangeRequired: false } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(await screen.findByText('须改密:false')).toBeInTheDocument();

    meMock.mockResolvedValueOnce({ user: { username: 'u', passwordChangeRequired: true } });
    act(() => {
      window.dispatchEvent(new CustomEvent(PASSWORD_CHANGE_REQUIRED_EVENT));
    });
    await waitFor(() => expect(meMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('须改密:true')).toBeInTheDocument();
  });
});
