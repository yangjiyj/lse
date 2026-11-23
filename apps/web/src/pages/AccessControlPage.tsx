import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { UsersPage } from './UsersPage';
import { RolesPage } from './RolesPage';

const TABS = [
  { id: 'users', label: '用户', permission: 'user:read' },
  { id: 'roles', label: '角色', permission: 'role:read' },
] as const;

type AccessTabId = (typeof TABS)[number]['id'];

/**
 * 用户与权限：把「用户管理」「角色管理」并到一个入口下的两个分页。
 * 两个分页复用原页面组件的嵌入形态，只去掉各自的页面标题头。
 */
export function AccessControlPage() {
  const { hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const visibleTabs = TABS.filter((tab) => hasPermission(tab.permission));
  if (visibleTabs.length === 0) {
    return <div className="p-8 text-sm text-ink-3">当前账号没有查看用户与权限的权限。</div>;
  }

  const requested = searchParams.get('tab');
  const active: AccessTabId =
    visibleTabs.find((tab) => tab.id === requested)?.id ?? visibleTabs[0]!.id;

  return (
    <div>
      <PageHeader title="用户与权限" description="登录账号与角色授权" />
      <div
        role="tablist"
        aria-label="用户与权限分类"
        className="mb-5 flex gap-2 border-b border-line"
      >
        {visibleTabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`access-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`access-panel-${tab.id}`}
              onClick={() => setSearchParams(tab.id === visibleTabs[0]!.id ? {} : { tab: tab.id })}
              className={cn(
                '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-brand-600 text-brand-600'
                  : 'border-transparent text-ink-3 hover:text-ink',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id="access-panel-users"
        role="tabpanel"
        aria-labelledby="access-tab-users"
        hidden={active !== 'users'}
      >
        {active === 'users' && <UsersPage embedded />}
      </div>
      <div
        id="access-panel-roles"
        role="tabpanel"
        aria-labelledby="access-tab-roles"
        hidden={active !== 'roles'}
      >
        {active === 'roles' && <RolesPage embedded />}
      </div>
    </div>
  );
}
