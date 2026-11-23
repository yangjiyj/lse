import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * 超时登出（前端计时）：minutes 分钟内没有鼠标/键盘/触摸操作即触发 onTimeout。
 * minutes <= 0 表示不限制。后端 authenticate 同样按最近活跃时间兜底校验。
 */
export function useIdleTimeout(minutes: number, onTimeout: () => void): void {
  const callback = useRef(onTimeout);
  callback.current = onTimeout;

  useEffect(() => {
    if (!minutes || minutes <= 0) return;
    const limit = minutes * 60_000;
    let last = Date.now();
    let fired = false;
    const touch = () => {
      last = Date.now();
    };
    const check = () => {
      if (!fired && Date.now() - last >= limit) {
        fired = true;
        callback.current();
      }
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, touch, { passive: true });
    const timer = window.setInterval(check, Math.min(15_000, limit));
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, touch);
      window.clearInterval(timer);
    };
  }, [minutes]);
}

/** 安全设置在前端的落地：超时登出计时 + 密码到期强制改密。挂在 AppShell 内。 */
export function SessionSecurityGuard() {
  const { user, logout, refreshUser } = useAuth();
  const navigate = useNavigate();

  useIdleTimeout(user?.idleTimeoutMinutes ?? 0, () => {
    void logout().then(() => navigate('/login?reason=idle', { replace: true }));
  });

  if (!user?.passwordExpired) return null;
  return (
    <ChangePasswordModal
      open
      forced
      onClose={() => undefined}
      onChanged={() => {
        void refreshUser();
      }}
    />
  );
}
