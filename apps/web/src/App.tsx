import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { TenantViewProvider } from '@/lib/tenant-view';
import { ToastProvider } from '@/components/ui/toast';
import { LoadingBlock } from '@/components/ui/spinner';
import { AppShell } from '@/components/AppShell';
import { LoginPage } from '@/pages/LoginPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { ForcePasswordChangePage } from '@/pages/ForcePasswordChangePage';
import { DashboardPage } from '@/pages/DashboardPage';
import { DetectResultsPage } from '@/pages/analysis/DetectResultsPage';
import { AppProfilesPage } from '@/pages/analysis/AppProfilesPage';
import { AppProfilePage } from '@/pages/analysis/AppProfilePage';
import { MyTodosPage } from '@/pages/MyTodosPage';
import { ModelTargetsPage } from '@/pages/ModelTargetsPage';
import { EndpointOnboardingPage } from '@/pages/EndpointOnboardingPage';
import { FleetPage } from '@/pages/fleet/FleetPage';
import { QuestionSetsPage } from '@/pages/QuestionSetsPage';
import { AgentSamplesPage } from '@/pages/AgentSamplesPage';
import { AgentRangePage } from '@/pages/AgentRangePage';
import { AgentEvalWizardPage } from '@/pages/AgentEvalWizardPage';
import { EvalTasksPage } from '@/pages/EvalTasksPage';
import { BatchEvaluationsPage } from '@/pages/BatchEvaluationsPage';
import { EvalComparePage } from '@/pages/EvalComparePage';
import { EvalTaskDetailPage } from '@/pages/EvalTaskDetailPage';
import { ServiceAssurancePage } from '@/pages/ServiceAssurancePage';
import { AiAssetScanPage } from '@/pages/AiAssetScanPage';
import { ReportsPage } from '@/pages/ReportsPage';
import { WrongAnswersPage } from '@/pages/WrongAnswersPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AccessControlPage } from '@/pages/AccessControlPage';
import { AuditLogsPage } from '@/pages/AuditLogsPage';
import { SystemStatusPage } from '@/pages/SystemStatusPage';
import { ApiTokensPage } from '@/pages/ApiTokensPage';
import { TenantsPage } from '@/pages/TenantsPage';
import { GatesPage } from '@/pages/GatesPage';
import { EvalPlansPage } from '@/pages/EvalPlansPage';
import { PolicySuggestionsPage } from '@/pages/PolicySuggestionsPage';
import { ModelFileScanPage } from '@/pages/ModelFileScanPage';
import { AssetDiscoveryPage } from '@/pages/AssetDiscoveryPage';
import { RagEvalPage } from '@/pages/RagEvalPage';
import { FrameworkCoveragePage, FrameworkMapRedirect } from '@/pages/FrameworkCoveragePage';
import { StandardClausesPage } from '@/pages/StandardClausesPage';
import { EndpointDetailPage } from '@/pages/fleet/EndpointDetailPage';
import { AgentProfilePage } from '@/pages/fleet/AgentProfilePage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { StandardManualReviewPage } from '@/pages/StandardManualReviewPage';
import { StandardMeasuresPage } from '@/pages/StandardMeasuresPage';
import { DictionariesPage } from '@/pages/DictionariesPage';
import { OrganizationsPage } from '@/pages/OrganizationsPage';
import { CorpusScansPage } from '@/pages/CorpusScansPage';
import { CorpusScanDetailPage } from '@/pages/CorpusScanDetailPage';
import { CorpusRulesPage } from '@/pages/CorpusRulesPage';
import { SupportTicketsPage } from '@/pages/support/SupportTicketsPage';
import { SupportTicketAdminPage } from '@/pages/support/SupportTicketAdminPage';
import { ToolsPage } from '@/pages/tools/ToolsPage';
import { ToolDetailPage } from '@/pages/tools/ToolDetailPage';
import { LedgerPage } from '@/pages/ledger/LedgerPage';
import { LedgerAssetDetailPage } from '@/pages/ledger/LedgerAssetDetailPage';
import { DetectTasksPage } from '@/pages/detect-tasks/DetectTasksPage';
import { DetectJobsPage } from '@/pages/detect-tasks/DetectJobsPage';
import { DetectJobDetailPage } from '@/pages/detect-tasks/DetectJobDetailPage';
import { DetectStrategiesPage } from '@/pages/detect-tasks/DetectStrategiesPage';
import { ReportTemplatesPage } from '@/pages/report-templates/ReportTemplatesPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingBlock label="正在校验登录状态…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (user.passwordChangeRequired && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <>{children}</>;
}

export function ComponentScanRedirect() {
  return <Navigate to="/service-assurance" replace />;
}

/** 应用台账原在「检测方案」下（/schemes/ledger），旧地址带着查询参数跳到 /ledger。 */
export function LegacyLedgerRedirect() {
  const { id } = useParams();
  const { search } = useLocation();
  const pathname = id ? `/ledger/${encodeURIComponent(id)}` : '/ledger';
  return <Navigate to={{ pathname, search }} replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <TenantViewProvider>
            <ToastProvider>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route
                  path="/change-password"
                  element={
                    <RequireAuth>
                      <ForcePasswordChangePage />
                    </RequireAuth>
                  }
                />
                <Route
                  element={
                    <RequireAuth>
                      <AppShell />
                    </RequireAuth>
                  }
                >
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/my-todos" element={<MyTodosPage />} />
                  <Route path="/model-targets" element={<ModelTargetsPage />} />
                  <Route
                    path="/model-targets/endpoint-onboarding"
                    element={<EndpointOnboardingPage />}
                  />
                  <Route path="/question-sets" element={<QuestionSetsPage />} />
                  <Route path="/agent-samples" element={<AgentSamplesPage />} />
                  <Route path="/agent-range" element={<AgentRangePage />} />
                  <Route path="/agent-evals/new" element={<AgentEvalWizardPage />} />
                  <Route path="/fleet" element={<FleetPage />} />
                  <Route path="/fleet/endpoints/:id" element={<EndpointDetailPage />} />
                  <Route
                    path="/fleet/agents/:endpointId/:agentKey"
                    element={<AgentProfilePage />}
                  />
                  <Route path="/eval-tasks" element={<EvalTasksPage />} />
                  <Route path="/batch-evaluations" element={<BatchEvaluationsPage />} />
                  <Route path="/eval-tasks/compare" element={<EvalComparePage />} />
                  <Route path="/eval-tasks/:id" element={<EvalTaskDetailPage />} />
                  <Route
                    path="/standard-evaluations/:runId/manual-review"
                    element={<StandardManualReviewPage />}
                  />
                  <Route
                    path="/standard-evaluations/:runId/measures"
                    element={<StandardMeasuresPage />}
                  />
                  {/* 国标符合性已并入评估任务，旧链接跳到任务列表。 */}
                  <Route
                    path="/standard-evaluations"
                    element={<Navigate to="/eval-tasks" replace />}
                  />
                  <Route
                    path="/external-assets/*"
                    element={<Navigate to="/model-targets" replace />}
                  />
                  <Route path="/service-assurance" element={<ServiceAssurancePage />} />
                  <Route path="/component-scan" element={<ComponentScanRedirect />} />
                  <Route path="/ai-asset-scan" element={<AiAssetScanPage />} />
                  <Route path="/inspect/model-files" element={<ModelFileScanPage />} />
                  <Route path="/inspect/asset-discovery" element={<AssetDiscoveryPage />} />
                  <Route path="/detect-tasks" element={<DetectTasksPage />} />
                  <Route path="/detect-tasks/jobs" element={<DetectJobsPage />} />
                  <Route path="/detect-tasks/jobs/:id" element={<DetectJobDetailPage />} />
                  <Route path="/detect-tasks/strategies" element={<DetectStrategiesPage />} />
                  <Route path="/tools" element={<ToolsPage />} />
                  <Route path="/tools/:id" element={<ToolDetailPage />} />
                  <Route path="/ledger" element={<LedgerPage />} />
                  <Route path="/ledger/:id" element={<LedgerAssetDetailPage />} />
                  <Route path="/schemes/ledger" element={<LegacyLedgerRedirect />} />
                  <Route path="/schemes/ledger/:id" element={<LegacyLedgerRedirect />} />
                  <Route path="/data/corpus-scans" element={<CorpusScansPage />} />
                  <Route path="/data/corpus-scans/:id" element={<CorpusScanDetailPage />} />
                  <Route path="/analysis/results" element={<DetectResultsPage />} />
                  <Route path="/analysis/profiles" element={<AppProfilesPage />} />
                  <Route path="/analysis/profiles/:assetId" element={<AppProfilePage />} />
                  <Route path="/data/corpus-rules" element={<CorpusRulesPage />} />
                  <Route path="/reports" element={<ReportsPage />} />
                  <Route path="/reports/framework-coverage" element={<FrameworkCoveragePage />} />
                  <Route path="/reports/standard-clauses" element={<StandardClausesPage />} />
                  <Route path="/reports/templates" element={<ReportTemplatesPage />} />
                  <Route path="/wrong-answers" element={<WrongAnswersPage />} />
                  <Route path="/users" element={<AccessControlPage />} />
                  {/* 角色管理并入「用户与权限」，授权许可与对抗评估配置并入「平台设置」；
                    旧路径保留重定向，收藏夹和历史链接不会失效。 */}
                  <Route path="/roles" element={<Navigate to="/users?tab=roles" replace />} />
                  <Route
                    path="/license"
                    element={<Navigate to="/settings#license-settings" replace />}
                  />
                  <Route path="/tenants" element={<TenantsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route
                    path="/redteam-policy"
                    element={<Navigate to="/settings#redteam-policy" replace />}
                  />
                  <Route path="/audit-logs" element={<AuditLogsPage />} />
                  <Route path="/system/dictionaries" element={<DictionariesPage />} />
                  <Route path="/system/organizations" element={<OrganizationsPage />} />
                  <Route path="/system/support-tickets" element={<SupportTicketAdminPage />} />
                  <Route
                    path="/support"
                    element={<SupportTicketsPage key="SUPPORT" kind="SUPPORT" />}
                  />
                  <Route
                    path="/feedback"
                    element={<SupportTicketsPage key="FEEDBACK" kind="FEEDBACK" />}
                  />
                  <Route path="/system/status" element={<SystemStatusPage />} />
                  <Route path="/settings/api-tokens" element={<ApiTokensPage />} />
                  <Route path="/eval/gates" element={<GatesPage />} />
                  <Route path="/eval/plans" element={<EvalPlansPage />} />
                  <Route path="/risk/policy-suggestions" element={<PolicySuggestionsPage />} />
                  <Route path="/inspect/rag" element={<RagEvalPage />} />
                  <Route path="/risk/framework-map" element={<FrameworkMapRedirect />} />
                  {/* 未知路径：登录态下显示「页面不存在」，未登录则由 RequireAuth 送去登录页。 */}
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </ToastProvider>
          </TenantViewProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
