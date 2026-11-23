import { useCallback } from 'react';
import { api, type ViewMode } from './api';
import { useAuth } from './auth';

// 内部专家角色：这些角色进来才默认看技术细节版（expert），其余一律看通俗版（demo）
const EXPERT_ROLES = ['admin', 'security_expert', 'red_team', 'analyst'];

export function useDemoMode() {
  const { user, refreshUser } = useAuth();
  // 默认给客户看通俗版（中文画像 + 雷达图，结论用「通过/发现风险」）。
  // 只有两种情况才切到技术细节版（expert）：
  //   1. 用户手动点了「查看技术细节」（viewMode 显式设为 'expert'）；
  //   2. 登录者本身是内部专家角色。
  const savedMode = user?.preferences?.viewMode;
  const isExpertRole = (user?.roles ?? []).some((role) => EXPERT_ROLES.includes(role));
  const mode: ViewMode =
    savedMode === 'expert' || savedMode === 'demo' ? savedMode : isExpertRole ? 'expert' : 'demo';

  const setMode = useCallback(
    async (next: ViewMode) => {
      await api.patchMyPreferences({ viewMode: next });
      await refreshUser();
    },
    [refreshUser],
  );

  return { mode, setMode };
}
