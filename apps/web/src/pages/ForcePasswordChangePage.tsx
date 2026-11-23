import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';

/** 首次登录强制改密：改完密码才能进入平台，其他路由都会被送到这里。 */
export function ForcePasswordChangePage() {
  const { user, refreshUser, logout } = useAuth();
  const navigate = useNavigate();
  if (!user?.passwordChangeRequired) return <Navigate to="/" replace />;
  return (
    <div className="min-h-screen bg-canvas">
      <ChangePasswordModal
        open
        forced
        reason="first-login"
        onClose={() => undefined}
        onChanged={() => {
          void refreshUser();
        }}
        onLogout={() => {
          void logout().then(() => navigate('/login', { replace: true }));
        }}
      />
    </div>
  );
}
