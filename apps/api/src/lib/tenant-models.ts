// 由 .scratch 生成脚本按迁移 20261106120000_multi_tenant 的清单写出：哪些 Prisma 模型带 tenantId、按什么语义过滤。
// 新增业务表若需要按租户隔离：在 schema 里加 tenantId 列与触发器，并把模型名加到这里。

/** 平台租户（默认租户）的固定 ID：升级前的全部数据与平台管理员都在这里。 */
export const PLATFORM_TENANT_ID = '00000000-0000-4000-8000-000000000001';

/** 只属于一个租户的数据：读写都限定为当前租户。 */
export const TENANT_OWNED_MODELS: ReadonlySet<string> = new Set([
  'EvalTask',
  'EvalPlan',
  'BatchEvaluation',
  'Report',
  'ApiToken',
  'GateRule',
  'PolicySuggestion',
  'ModelFileUpload',
  'ModelFileScan',
  'ModelFileFinding',
  'AssetDiscoveryRun',
  'RagCorpus',
  'RagTestSet',
  'RagEvalRun',
  'AiComponentScan',
  'AiComponentFinding',
  'AiComponentToolBaseline',
  'ServiceAssuranceRun',
  'VulnerabilityAssessment',
  'FleetEnrollmentCode',
  'FleetEndpoint',
  'FleetProbeReport',
  'FleetEvalJob',
  'AuditLog',
  'ExternalAssetAssessment',
  'EvalResult',
  'Finding',
  'WrongAnswer',
  'ModelFingerprint',
  'StandardRun',
  'AgentSampleTrial',
  'SupportTicket',
  'Organization',
  'CorpusRuleSet',
  'CorpusRule',
  'CorpusScan',
  'CorpusFinding',
  'DetectStrategy',
  'DetectJob',
  'DetectJobItem',
  'LedgerAsset',
  'LedgerRelation',
  'DetectScheme',
  'DetectSchemeItem',
  'ReportTemplate',
  'FleetRemoteDeploy',
]);

/** 可平台共享的数据：tenantId 为空表示平台内置/共享，各租户可读不可改；其余同 owned。 */
export const TENANT_SHARED_MODELS: ReadonlySet<string> = new Set([
  'ModelTarget',
  'QuestionSet',
  'Question',
  'AgentSample',
  // 测试领域：内置的为空（各租户只读），租户自建的按租户，同名只在租户内算冲突。
  'TestDomain',
]);

// 注意：StandardBankRelease 故意不在这里。标准题库（GB/T 45654 发布版）是平台级内容，
// 只有「任务自动样本集」跟着任务所属租户走，所以在用到它的两处（样本集列表、建标准专项时取发布版）
// 显式按 tenantId 过滤：平台发布的（tenantId 为空）各租户可用，自动样本集只给所属租户。
