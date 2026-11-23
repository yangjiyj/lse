import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { Spinner } from '@/components/ui/spinner';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { SegmentTabs } from '@/components/page-kit/SegmentTabs';
import { EndpointsTab } from './EndpointsTab';
import { JobsTab } from './JobsTab';
import { EnrollTab } from './EnrollTab';
import { AgentsTab } from './AgentsTab';
import { RemoteDeployTab } from './RemoteDeployTab';
import { TenantFilterSelect, useTenantView } from '@/lib/tenant-view';

const TABS = ['agents', 'endpoints', 'jobs', 'enroll', 'deploy'] as const;
type Tab = (typeof TABS)[number];

/** 地址栏 ?tab= 指定要打开的页签；缺省或写错时打开智能体清单。 */
function parseTab(value: string | null): Tab {
  return (TABS as readonly string[]).includes(value ?? '') ? (value as Tab) : 'agents';
}

export function FleetPage() {
  const { hasPermission } = useAuth();
  const { isAllTenants } = useTenantView();
  const canManage = hasPermission('model_target:create');
  // 远程部署（2.4.8）：要 fleet:remote_deploy，全部租户视角下不提供。
  const canDeploy = hasPermission('fleet:remote_deploy') && !isAllTenants;
  const [params, setParams] = useSearchParams();
  const parsedTab = parseTab(params.get('tab'));
  const tab: Tab = parsedTab === 'deploy' && !canDeploy ? 'agents' : parsedTab;
  // 页签状态放在地址栏里，刷新或分享链接不丢；切换页签不新增历史记录。
  const setTab = (next: Tab) =>
    setParams(
      (prev) => {
        const nextParams = new URLSearchParams(prev);
        nextParams.set('tab', next);
        return nextParams;
      },
      { replace: true },
    );
  const config = useQuery({
    queryKey: ['fleet', 'config'],
    queryFn: () => api.fleet.config(),
    retry: false,
  });

  return (
    <div className="space-y-5">
      <PageHeader title="终端与智能体" actions={<TenantFilterSelect />} />
      {config.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5" />
        </div>
      ) : config.isError ? (
        <NoteBox tone="warning" role="alert">
          读取终端接入配置失败，请稍后重试。
        </NoteBox>
      ) : !config.data?.enabled ? (
        <NoteBox tone="neutral" role="status">
          自管终端接入尚未启用，请联系管理员。
        </NoteBox>
      ) : (
        <>
          <SegmentTabs<Tab>
            ariaLabel="终端功能"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'agents', label: '智能体' },
              { value: 'endpoints', label: '终端' },
              { value: 'jobs', label: '测评任务' },
              ...(!isAllTenants ? [{ value: 'enroll' as Tab, label: '接入终端' }] : []),
              ...(canDeploy ? [{ value: 'deploy' as Tab, label: '远程部署' }] : []),
            ]}
          />
          {tab === 'agents' && <AgentsTab />}
          {tab === 'endpoints' && (
            <EndpointsTab canManage={canManage} onGoEnroll={() => setTab('enroll')} />
          )}
          {tab === 'jobs' && <JobsTab canManage={canManage} />}
          {tab === 'enroll' && !isAllTenants && <EnrollTab canManage={canManage} />}
          {tab === 'deploy' && canDeploy && <RemoteDeployTab />}
        </>
      )}
    </div>
  );
}
