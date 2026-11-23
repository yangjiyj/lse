import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ScrollText } from 'lucide-react';
import { api, type AuditLog } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { ENGINE_LABELS, formatDateTime, reportKindLabel } from '@/lib/format';
import { TenantCell, TenantFilterSelect, useTenantView } from '@/lib/tenant-view';

const ACTION_LABELS: Record<string, string> = {
  'tenant.create': '新建租户',
  'tenant.update': '修改租户',
  'tenant.enable': '启用租户',
  'tenant.disable': '停用租户',
  'tenant.asset.transfer-out': '转出资产到其他租户',
  'tenant.asset.transfer-in': '从其他租户转入资产',
  'external_asset.assess': '评估外部资产',
  'auth.login': '登录系统',
  'auth.logout': '退出登录',
  'auth.change_password': '修改登录密码',
  'auth.register': '自助注册',
  'endpoint_eval.posture': '执行终端配置体检',
  'endpoint_eval.run': '发起终端真机测评（评估对象页）',
  'agent_eval.run': '执行智能体安全评估',
  'benchmark.import': '导入评估基准',
  'engine.scan': '执行安全引擎扫描',
  'eval_task.create': '创建评估任务',
  'batch_evaluation.create': '创建批量评估计划',
  'batch_evaluation.start': '启动批量评估',
  'batch_evaluation.pause': '暂停批量评估',
  'batch_evaluation.resume': '恢复批量评估',
  'batch_evaluation.cancel': '取消批量评估',
  'batch_evaluation.retry-errors': '重试批量评估异常样本',
  'download.batch_evaluation_report': '下载批量评估报告',
  'download.tool_package': '下载工具安装包',
  'download.tool_manual': '下载工具操作手册',
  'eval_task.create_red_team': '创建自主红队任务',
  'eval_task.create_comprehensive': '创建综合安全评估任务',
  'eval_task.re_eval': '重新评估任务',
  'eval_task.cancel': '取消评估任务',
  'eval_task.pause': '暂停评估任务',
  'eval_task.resume': '恢复评估任务',
  'eval_task.delete': '删除评估任务',
  'gateway_log.analyze': '分析安全网关日志',
  'gateway_log.drill_prepare': '准备安全网关演练',
  'generator.customer_data.generate': '生成客户业务数据样本',
  'generator.generate': '生成测试样本',
  'generator.enhance': '执行 AI 增强生成',
  'question.create': '新建测试样本',
  'question.update': '更新测试样本',
  'question.delete': '删除测试样本',
  'question.import': '导入测试样本',
  'question_set.create': '新建样本库',
  'question_set.update': '更新样本库',
  'question_set.delete': '删除样本库',
  'question_set.mutation': '种子变异扩展',
  'fleet.enrollment_code.create': '创建终端接入码',
  'fleet.enrollment_code.revoke': '撤销终端接入码',
  'fleet.endpoint.revoke': '吊销终端',
  'fleet.endpoint.remove': '移除终端',
  'fleet.endpoint.owner': '设置终端责任人',
  'fleet.endpoint.posture_eval': '发起终端配置体检',
  'fleet.eval_job.create': '发起终端真机测评',
  'fleet.eval_job.approve': '批准终端真机测评',
  'fleet.eval_job.reject': '驳回终端真机测评',
  'fleet.eval_job.cancel': '取消终端真机测评',
  'fleet.eval_job.finalize': '终端真机测评结果入库',
  'download.fleet_tls_deployment': '下载终端部署文件',
  'fleet.installer.download': '下载终端安装包',
  'report.generate': '生成评估报告',
  'report.download': '下载评估报告',
  'report.delete': '删除评估报告',
  'system_setting.update': '更新系统设置',
  'license.update': '更新授权许可',
  'user.create': '新建用户',
  'user.update': '更新用户',
  'user.delete': '删除用户',
  'user.reset_password': '重置用户密码',
  'user.registration_approve': '通过注册审核',
  'user.registration_reject': '拒绝注册',
  'role.create': '新建角色',
  'role.update': '更新角色',
  'role.delete': '删除角色',
  'model_target.create': '新建评估对象',
  'model_target.update': '更新评估对象',
  'model_target.delete': '删除评估对象',
  'model_target.test': '测试评估对象连接',
  'wrong_answer.export': '导出风险样本',
  'download.standard_report_pdf': '下载标准对标报告',
  'download.standard_evidence_json': '下载标准对标证据附件',
  'download.question_template': '下载样本导入模板',
  'sensitive_data.reveal': '查看敏感信息明文',
  'auth.login_failed': '非法登录',
  'auth.account_locked': '账户已被锁定',
  // 路线图 W0–W6 新增动作，以及此前缺标签的基线动作（audit-action-labels.test.ts 校验完整性）
  'dashboard.todos.read': '查看我的待办',
  'eval_plan.create': '新建评估计划',
  'eval_plan.update': '更新评估计划',
  'eval_plan.enable': '启用评估计划',
  'eval_plan.disable': '停用评估计划',
  'eval_plan.delete': '删除评估计划',
  'eval_plan.trigger': '触发评估计划',
  'detect_job.create': '新建组合任务',
  'detect_job.start': '启动组合任务',
  'detect_job.pause': '暂停组合任务',
  'detect_job.resume': '恢复组合任务',
  'detect_job.stop': '停止组合任务',
  'detect_job.delete': '删除组合任务',
  'detect_strategy.create': '新建检测策略',
  'detect_strategy.update': '修改检测策略',
  'detect_strategy.delete': '删除检测策略',
  'detect_strategy.trigger': '触发检测策略',
  'detect_task.pause': '暂停检测任务',
  'detect_task.resume': '恢复检测任务',
  'detect_task.stop': '停止检测任务',
  'report_template.create': '新建报告模板',
  'report_template.update': '修改报告模板',
  'report_template.delete': '删除报告模板',
  'report_template.set_default': '设置默认报告模板',
  'fleet.remote_deploy.start': '发起远程部署',
  'fleet.remote_deploy.finish': '远程部署结束',
  'fleet.remote_deploy.host_key': '获取远程部署主机指纹',
  'dictionary.type_create': '新建字典类型',
  'dictionary.type_update': '修改字典类型',
  'dictionary.type_delete': '删除字典类型',
  'dictionary.item_create': '新增字典条目',
  'dictionary.item_update': '修改字典条目',
  'dictionary.item_delete': '删除字典条目',
  'dictionary.item_reorder': '调整字典条目顺序',
  'support_ticket.create': '提交工单',
  'support_ticket.reply': '回复工单',
  'support_ticket.close': '关闭工单',
  'organization.create': '新建组织',
  'organization.update': '修改组织',
  'organization.delete': '删除组织',
  'tool.create': '新建工具',
  'tool.delete': '删除工具',
  'tool.version_upload': '上传工具版本',
  'tool.version_delete': '删除工具版本',
  'tool.update': '编辑工具',
  'tool.manual_upload': '上传工具操作手册',
  'tool.manual_replace': '替换工具操作手册',
  'tool.manual_delete': '删除工具操作手册',
  'corpus_scan.create': '发起语料扫描',
  'corpus_scan.delete': '删除语料扫描',
  'corpus_scan.export': '导出语料扫描结果',
  'corpus_scan.masked_copy': '下载语料打码副本',
  'corpus_rule.create_set': '新建语料规则集',
  'corpus_rule.update_set': '修改语料规则集',
  'corpus_rule.delete_set': '删除语料规则集',
  'corpus_rule.create': '新增语料规则',
  'corpus_rule.update': '修改语料规则',
  'corpus_rule.delete': '删除语料规则',
  'corpus_rule.import': '导入语料规则',
  'ledger.asset_create': '新建台账资产',
  'ledger.asset_update': '修改台账资产',
  'ledger.asset_delete': '删除台账资产',
  'ledger.import_endpoints': '台账导入终端',
  'ledger.import_targets': '台账导入评估对象',
  'ledger.relation_create': '新建台账关系',
  'ledger.relation_delete': '删除台账关系',
  'detect_scheme.create': '新建检测方案',
  'detect_scheme.update': '修改检测方案',
  'detect_scheme.delete': '删除检测方案',
  'detect_scheme.archive': '归档检测方案',
  'detect_scheme.unarchive': '取消归档检测方案',
  'detect_scheme.generate': '生成方案清单',
  'detect_scheme.item_create': '新增方案清单项',
  'detect_scheme.item_update': '修改方案清单项',
  'detect_scheme.item_delete': '删除方案清单项',
  'detect_scheme.guide_download': '下载作业指导书',
  'detect_scheme.create_job': '方案建组合任务',
  'gate.create': '新建上线门禁',
  'gate.update': '更新上线门禁',
  'gate.delete': '删除上线门禁',
  'eval_task.export': '导出评估任务结果（CI）',
  'api_token.create': '创建 API 令牌',
  'api_token.revoke': '吊销 API 令牌',
  'api_token.use': '使用 API 令牌调用接口',
  'api_token.use_failed': 'API 令牌鉴权失败',
  'eval_task.retest_failed': '发起失败用例复测',
  'policy_suggestion.generate': '生成策略建议',
  'policy_suggestion.accept': '采纳策略建议',
  'policy_suggestion.modify': '修改后采纳策略建议',
  'policy_suggestion.reject': '驳回策略建议',
  'policy_suggestion.export': '导出策略建议',
  'policy_suggestion.dispatch': '下发策略建议到安全网关',
  'policy_suggestion.gateway_status': '策略建议网关状态变更',
  'model_file_scan.run': '上传模型文件扫描',
  'model_file_scan.directory': '扫描服务器模型目录',
  'model_file_scan.config.update': '更新模型文件扫描配置',
  'model_file_scan.aibom.export': '导出 AIBOM',
  'model_file_scan.cancel': '取消模型文件扫描',
  'model_file_library.delete': '删除已上传的模型文件',
  'model_file_finding.review': '复核模型文件发现',
  'model_file_finding.update': '更新模型文件发现整改',
  'model_file_finding.reopened_by_retest': '复扫仍命中，模型文件发现自动重开',
  'asset_discovery.scope.update': '更新 AI 资产测绘范围',
  'asset_discovery.run.start': '发起 AI 资产测绘',
  'asset_discovery.run.finish': 'AI 资产测绘完成',
  'asset_discovery.run.rejected': 'AI 资产测绘超出授权范围被拒',
  'rag_eval.corpus.create': '新建 RAG 知识库',
  'rag_eval.corpus.delete': '删除 RAG 知识库',
  'rag_eval.document.upload': '上传 RAG 知识库文档',
  'rag_eval.document.delete': '删除 RAG 知识库文档',
  'rag_eval.test_set.generate': '生成 RAG 测试集',
  'rag_eval.test_set.delete': '删除 RAG 测试集',
  'rag_eval.test_item.create': '新增 RAG 测试题',
  'rag_eval.test_item.update': '更新 RAG 测试题',
  'rag_eval.test_item.delete': '删除 RAG 测试题',
  'rag_eval.security_document.download': '下载 RAG 安全测试文档',
  'rag_eval.run.create': '发起 RAG 专项评估',
  'rag_eval.test_set.create': '新建 RAG 测试集',
  'rag_eval.test_set.update': '修改 RAG 测试集',
  'rag_eval.test_set.generate_finish': 'RAG 测试集生成结束',
  'rag_eval.test_set.generate_cancel': '取消生成 RAG 测试集',
  'rag_eval.test_package.download': '下载 RAG 测试知识库包',
  'rag_eval.test_item.import': '导入 RAG 测试题',
  'rag_eval.test_item.export': '导出 RAG 测试题',
  'rag_eval.run.alignment_confirm': '确认 RAG 知识对齐',
  'rag_eval.run.cancel': '取消 RAG 专项评估',
  'rag_eval.run.cleanup': '清理 RAG 测试文档',
  'eval_task.create_multimodal': '创建多模态越狱评估任务',
  'eval_task.create_multimodal_byo': '创建多模态自带图片评估任务',
  'multimodal_byo.upload': '上传多模态自带图片集',
  'multimodal_byo.upload_rejected': '多模态自带图片集校验未通过',
  'multimodal_byo.images_delete': '删除多模态自带图片',
  'model_fingerprint.collect': '采集模型指纹',
  'model_fingerprint.set_baseline': '设为基线指纹',
  'agent_eval.adr_import': '导入 ADR 会话记录',
  'attack_seed.generate': '生成攻击种子泛化样本',
  'attack_seed.save': '保存攻击种子泛化样本',
  'test_domain.create': '新建测试领域',
  'custom_risk.update': '更新自定义风险内容规则',
  'custom_risk.fuzz_import': '导入自定义风险模糊变体',
  'ai_component.scan': '发起 AI 组件漏洞扫描',
  'ai_component.mcp_fetch': '在线拉取 MCP 服务并扫描',
  'ai_component.rescan': '重新扫描 AI 组件',
  'ai_component.finding.review': '复核 AI 组件扫描发现',
  'ai_component.baseline.accept': '接受 MCP 工具描述新基线',
  'ai_component.delete': '删除 AI 组件扫描记录',
  'ai_component.link_task': 'AI 组件扫描关联评估任务',
  'eval_task.batch_create': '批量创建评估任务',
  'eval_task.create_standard_compliance': '创建国标评估任务（旧版）',
  'standard_evaluation.create_gbt45654': '创建 GB/T 45654 生成内容安全评估',
  'question_set.bank_import': '导入国标题目',
  'question_set.bank_update_run': '发起国标题库或关键词立即更新',
  'question_set.bank_update': '国标题库定期更新',
  'question_set.keyword_update': '国标关键词定期补充',
  'standard_evaluation.gbt_rejudge': '重新判定国标评估',
  'standard_evaluation.gbt_retry_failed': '重试国标评估失败题',
  'standard_evaluation.gbt_review_batch': '批量复核国标评估结论',
  'keyword_library.import': '导入关键词库',
  'keyword_library.review': '审校关键词库',
  'keyword_library.status': '修改关键词状态',
  'eval_task.import_to_question_bank': '攻击内容导入样本库',
  'question_set.copy': '复制内置样本库',
  'eval_task.log_export': '导出任务日志',
  'eval_task.list_export': '导出评估任务列表',
  'question_set.export': '导出样本库',
  'model_target.diagnose': '接口诊断',
  'model_target.batch_test': '批量测试评估对象连接',
  'finding.review': '复核风险发现',
  'finding.framework_mapping.update': '修订风险框架映射',
  'remediation.update': '更新整改项',
  'remediation.reopened_by_retest': '复测命中后重开整改项',
  'service_assurance.run.create': '发起 AI 服务安全核验',
  'service_assurance.run.cancel': '取消 AI 服务安全核验',
  'service_assurance.run.link_task': 'AI 服务安全核验关联评估任务',
  'service_assurance.run.unlink_task': 'AI 服务安全核验取消关联评估任务',
  'service_assurance.assessment.review': '复核 AI 服务安全核验结论',
  'service_assurance.assessment.retest': '复测 AI 服务安全核验项',
  'service_assurance.scope_policies.update': '更新 AI 服务安全核验授权范围',
  'standard_revision.create': '新建标准题目修订',
  'standard_revision.submit': '提交标准题目修订',
  'standard_revision.review': '审核标准题目修订',
  'standard_bank.publish': '发布标准题库版本',
  'standard_evaluation.create': '创建标准专项评估',
  'standard_evaluation.execute': '执行标准专项评估',
  'standard_evaluation.cancel': '取消标准专项评估',
  // 备案材料功能已删除，保留标签以便历史审计记录仍显示中文。
  'filing.package.generate': '生成备案材料包',
  'audit_log.export': '导出操作日志',
};

/** 动作筛选中的「下载」分类：所有文件下载日志。 */
const DOWNLOAD_CATEGORY = 'category:download';

const ACTION_OPTIONS = Object.keys(ACTION_LABELS);

const TARGET_TYPE_LABELS: Record<string, string> = {
  tenant: '租户',
  external_asset_assessment: '外部资产评估',
  system_setting: '系统设置',
  license: '授权许可',
  user: '用户',
  role: '角色',
  eval_task: '评估任务',
  batch_evaluation: '批量评估计划',
  model_target: '评估对象',
  question_set: '样本库',
  question: '测试样本',
  report: '评估报告',
  gateway_drill: '安全网关演练',
  standard_run: '标准专项',
  keyword_library: '关键词库',
  question_template: '样本导入模板',
  api_token: 'API 令牌',
  asset_discovery_run: 'AI 资产测绘',
  ai_component_scan: 'AI 组件漏洞扫描',
  dashboard: '态势概览',
  eval_plan: '评估计划',
  detect_job: '组合检测任务',
  detect_strategy: '检测策略',
  detect_task: '检测任务记录',
  report_template: '报告模板',
  fleet_remote_deploy: '远程部署',
  dict_type: '字典类型',
  dict_item: '字典条目',
  support_ticket: '工单',
  organization: '组织',
  tool: '工具',
  tool_version: '工具版本',
  tool_manual: '工具操作手册',
  corpus_scan: '语料扫描',
  corpus_rule_set: '语料规则集',
  corpus_rule: '语料规则',
  ledger_asset: '台账资产',
  ledger_relation: '台账关系',
  detect_scheme: '检测方案',
  eval_task_batch: '批量评估任务',
  eval_result: '评估结果',
  finding: '风险发现',
  gate_rule: '上线门禁',
  model_file_scan: '模型文件扫描',
  model_file_upload: '已上传的模型文件',
  model_file_finding: '模型文件发现',
  policy_suggestion: '策略建议',
  test_domain: '测试领域',
  rag_corpus: 'RAG 知识库',
  rag_document: 'RAG 知识库文档',
  rag_test_set: 'RAG 测试集',
  rag_test_item: 'RAG 测试题',
  rag_eval_run: 'RAG 专项评估',
  service_assurance_run: 'AI 服务安全核验',
  service_assurance_assessment: 'AI 服务安全核验结论',
  standard_question_revision: '标准题目修订',
  standard_bank_release: '标准题库版本',
  wrong_answer: '风险样本',
  StandardRun: '标准评估结论',
  fleet_enrollment_code: '终端接入码',
  fleet_endpoint: '终端',
  fleet_eval_job: '终端真机测评任务',
  fleet_deployment: '终端部署信息',
  // 备案材料功能已删除，保留标签以便历史审计记录仍显示中文。
  FilingPackage: '备案材料包',
  audit_log: '操作日志',
};

const TARGET_TYPE_OPTIONS = Object.keys(TARGET_TYPE_LABELS);

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? '其他操作';
}

function targetTypeLabel(targetType: string | null): string {
  if (!targetType) return '—';
  return TARGET_TYPE_LABELS[targetType] ?? '其他对象';
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function countOf(v: unknown): number | null {
  return Array.isArray(v) ? v.length : null;
}

const QUESTION_SET_TYPE_LABELS: Record<string, string> = {
  GENERAL: '通用样本库',
  COMPLIANCE: '合规专项',
  PROMPT_INJECTION: '提示注入专项',
  SHOULD_REFUSE: '应拒答专项',
  AGENT: '智能体专项',
};

const SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: '严重',
  HIGH: '高危',
  MEDIUM: '中危',
  LOW: '低危',
  INFO: '提示',
};

/** 严重级别可能是「全部」这类中文串，也可能是 ["HIGH"] 这样的数组。 */
function severityText(v: unknown): string | null {
  const one = (x: unknown): string | null => {
    const raw = str(x);
    if (!raw) return null;
    return SEVERITY_LABELS[raw.toUpperCase()] ?? raw;
  };
  if (Array.isArray(v)) {
    const mapped = v.map(one).filter((x): x is string => Boolean(x));
    return mapped.length ? mapped.join('、') : null;
  }
  return one(v);
}

function engineText(v: unknown): string | null {
  const raw = str(v);
  if (!raw) return null;
  return ENGINE_LABELS[raw] ?? raw;
}

const STATUS_LABELS: Record<string, string> = {
  SUCCESS: '成功',
  FAILED: '失败',
  ERROR: '异常',
  PARTIAL: '部分成功',
  SKIPPED: '已跳过',
};

function statusText(v: unknown): string | null {
  const raw = str(v);
  if (!raw) return null;
  return STATUS_LABELS[raw.toUpperCase()] ?? raw;
}

/**
 * 把审计明细渲染成一句中文摘要。仅覆盖库中实际出现过的字段组合，
 * 其余走兜底的字段计数，避免把原始 JSON 直接吐到列表里。
 * 完整明细在「查看」弹窗中展示。
 */
function detailSummary(action: string, detail: Record<string, unknown> | null): string {
  if (!detail) return '—';
  const d = detail;
  const parts: string[] = [];
  const push = (v: string | null | undefined) => {
    if (v) parts.push(v);
  };

  switch (action) {
    case 'model_target.create':
    case 'model_target.update':
    case 'model_target.delete': {
      push(str(d.name));
      push(str(d.model));
      push(str(d.provider));
      break;
    }
    case 'model_target.test': {
      push(statusText(d.status));
      const ms = num(d.latencyMs);
      push(ms === null ? null : `耗时 ${ms} 毫秒`);
      push(str(d.error));
      break;
    }
    case 'eval_task.create':
    case 'eval_task.delete':
    case 'eval_task.cancel': {
      push(str(d.name));
      const total = num(d.totalQuestions);
      push(total === null ? null : `共 ${total} 条样本`);
      const sets = countOf(d.questionSetIds);
      push(sets ? `取自 ${sets} 个样本库` : null);
      const prev = str(d.previousStatus);
      push(prev ? `原状态 ${prev}` : null);
      break;
    }
    case 'eval_task.re_eval': {
      const total = num(d.totalQuestions);
      push(total === null ? null : `重测 ${total} 条样本`);
      break;
    }
    case 'eval_task.create_red_team': {
      push(str(d.name));
      const total = num(d.totalQuestions);
      push(total === null ? null : `共 ${total} 轮攻击`);
      const dirs = countOf(d.directions);
      push(dirs ? `${dirs} 个攻击方向` : null);
      break;
    }
    case 'eval_task.create_comprehensive': {
      push(str(d.name));
      const total = num(d.totalQuestions);
      push(total === null ? null : `共 ${total} 条样本`);
      const modules = countOf(d.modules);
      push(modules ? `${modules} 个评估模块` : null);
      push(d.mode === 'full' ? '全量能力覆盖' : d.mode === 'random' ? '随机抽样' : null);
      break;
    }
    case 'report.generate': {
      const rate = num(d.passRate);
      push(rate === null ? null : `通过率 ${Math.round(rate * 100)}%`);
      push(str(d.kind) ? reportKindLabel(str(d.kind)) : null);
      break;
    }
    case 'report.download': {
      const fmt = str(d.format);
      push(fmt ? fmt.toUpperCase() : null);
      const secs = countOf(d.sections);
      push(secs ? `${secs} 个章节` : null);
      push(severityText(d.severity));
      break;
    }
    case 'report.delete': {
      push(str(d.title));
      break;
    }
    case 'generator.generate':
    case 'generator.customer_data.generate': {
      push(str(d.datasetName));
      const produced = num(d.produced);
      const requested = num(d.requested);
      if (produced !== null && requested !== null) {
        push(`生成 ${produced}/${requested} 条`);
      } else if (produced !== null) {
        push(`生成 ${produced} 条`);
      }
      push(str(d.language));
      break;
    }
    case 'generator.enhance': {
      push('AI 增强生成');
      break;
    }
    case 'question.import': {
      push(str(d.filename));
      const ok = num(d.imported);
      const bad = num(d.failed);
      push(ok === null ? null : `成功 ${ok} 条`);
      push(bad ? `失败 ${bad} 条` : null);
      break;
    }
    case 'benchmark.import': {
      push(str(d.source));
      const ok = num(d.importedRows);
      const total = num(d.totalRows);
      const bad = num(d.failedRows);
      if (ok !== null && total !== null) push(`导入 ${ok}/${total} 行`);
      push(bad ? `失败 ${bad} 行` : null);
      push(statusText(d.status));
      break;
    }
    case 'engine.scan': {
      push(engineText(d.engine));
      const targets = countOf(d.targets);
      push(targets ? `${targets} 个目标` : null);
      const found = num(d.normalizedCount);
      push(found === null ? null : `发现 ${found} 项`);
      push(statusText(d.status));
      break;
    }
    case 'gateway_log.analyze': {
      const total = num(d.totalEvents);
      const risk = num(d.riskEvents);
      push(total === null ? null : `分析 ${total} 条日志`);
      push(risk === null ? null : `风险 ${risk} 条`);
      const findings = num(d.findingCount);
      push(findings === null ? null : `发现 ${findings} 项`);
      const ip = str(d.sourceIp);
      push(ip ? `来源 ${ip}` : null);
      break;
    }
    case 'wrong_answer.export': {
      const n = num(d.count);
      push(n === null ? null : `导出 ${n} 条`);
      push(severityText(d.severity));
      break;
    }
    case 'audit_log.export': {
      const n = num(d.count);
      push(n === null ? null : `导出 ${n} 条`);
      const format = str(d.format);
      push(format ? format.toUpperCase() : null);
      break;
    }
    case 'question_set.create':
    case 'question_set.delete': {
      push(str(d.name));
      const qsType = str(d.type);
      push(qsType ? (QUESTION_SET_TYPE_LABELS[qsType.toUpperCase()] ?? qsType) : null);
      break;
    }
    case 'question.update':
    case 'question_set.update': {
      const f = d.fields;
      const names = Array.isArray(f)
        ? f.filter((x) => typeof x === 'string')
        : Object.keys(f && typeof f === 'object' ? (f as object) : {});
      push(names.length ? `修改 ${names.length} 个字段` : null);
      break;
    }
    default:
      break;
  }

  if (parts.length) return parts.join(' · ');
  const keys = Object.keys(d);
  return keys.length ? `${keys.length} 项明细` : '—';
}

export function AuditLogsPage() {
  const { isAllTenants, listParams, tenantFilter, guardRow } = useTenantView();
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [actorInput, setActorInput] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [targetTypeFilter, setTargetTypeFilter] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [selected, setSelected] = useState<AuditLog | null>(null);

  const pageSize = 15;
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);
  const [exportError, setExportError] = useState('');

  const filters = {
    ...listParams,
    action: actionFilter && actionFilter !== DOWNLOAD_CATEGORY ? actionFilter : undefined,
    category: actionFilter === DOWNLOAD_CATEGORY ? ('download' as const) : undefined,
    actorName: actorFilter || undefined,
    targetType: targetTypeFilter || undefined,
    start: start ? new Date(start).toISOString() : undefined,
    end: end ? new Date(end).toISOString() : undefined,
  };

  const exportLogs = async (format: 'csv' | 'json') => {
    setExporting(format);
    setExportError('');
    try {
      await api.auditLogs.export({ ...filters, format });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExporting(null);
    }
  };

  const list = useQuery({
    queryKey: [
      'audit-logs',
      page,
      actionFilter,
      actorFilter,
      targetTypeFilter,
      start,
      end,
      tenantFilter,
    ],
    queryFn: () => api.auditLogs.list({ page, pageSize, ...filters }),
  });

  const applyFilters = () => {
    setPage(1);
    setActorFilter(actorInput.trim());
  };

  const resetFilters = () => {
    setPage(1);
    setActionFilter('');
    setActorInput('');
    setActorFilter('');
    setTargetTypeFilter('');
    setStart('');
    setEnd('');
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="操作日志"
        description="平台关键操作的审计记录"
        actions={
          <>
            <Button
              variant="outline"
              disabled={exporting !== null}
              onClick={() => void exportLogs('csv')}
            >
              <Download className="h-4 w-4" />
              导出 CSV
            </Button>
            <Button
              variant="outline"
              disabled={exporting !== null}
              onClick={() => void exportLogs('json')}
            >
              <Download className="h-4 w-4" />
              导出 JSON
            </Button>
          </>
        }
      />
      {exportError ? (
        <p role="alert" className="text-sm text-destructive">
          {exportError}
        </p>
      ) : null}

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-white p-3 shadow-card">
          <Select
            aria-label="动作筛选"
            value={actionFilter}
            onChange={(e) => {
              setPage(1);
              setActionFilter(e.target.value);
            }}
            className="max-w-[180px]"
          >
            <option value="">全部动作</option>
            <option value={DOWNLOAD_CATEGORY}>下载</option>
            {ACTION_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </Select>
          <Input
            placeholder="按操作人搜索…"
            value={actorInput}
            onChange={(e) => setActorInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilters();
            }}
            className="max-w-[200px]"
          />
          <Select
            aria-label="对象类型筛选"
            value={targetTypeFilter}
            onChange={(e) => {
              setPage(1);
              setTargetTypeFilter(e.target.value);
            }}
            className="max-w-[160px]"
          >
            <option value="">全部对象类型</option>
            {TARGET_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {targetTypeLabel(t)}
              </option>
            ))}
          </Select>
          <Input
            type="datetime-local"
            value={start}
            onChange={(e) => {
              setPage(1);
              setStart(e.target.value);
            }}
            className="max-w-[200px]"
            aria-label="开始时间"
          />
          <span className="text-sm text-muted-foreground">至</span>
          <Input
            type="datetime-local"
            value={end}
            onChange={(e) => {
              setPage(1);
              setEnd(e.target.value);
            }}
            className="max-w-[200px]"
            aria-label="结束时间"
          />
          <TenantFilterSelect />
          <Button variant="outline" onClick={applyFilters}>
            搜索
          </Button>
          <Button variant="ghost" onClick={resetFilters}>
            重置
          </Button>
        </div>

        {list.isLoading ? (
          <LoadingBlock />
        ) : list.isError ? (
          <p role="alert" className="py-10 text-center text-sm text-muted-foreground">
            {list.error instanceof Error ? list.error.message : '加载失败'}
          </p>
        ) : !list.data || list.data.items.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="h-10 w-10" />}
            title="暂无操作日志"
            description="当前筛选条件下没有记录，可调整筛选或重置后重试。"
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  {isAllTenants && <TH>租户</TH>}
                  <TH>时间</TH>
                  <TH>操作人</TH>
                  <TH>动作</TH>
                  <TH>对象类型</TH>
                  <TH>IP</TH>
                  <TH>详情</TH>
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((log) => (
                  <TR
                    key={log.id}
                    className="cursor-pointer"
                    onClick={() => {
                      if (!guardRow(log.tenantId, '/audit-logs')) setSelected(log);
                    }}
                    title="点击查看完整详情"
                  >
                    {isAllTenants && (
                      <TD data-label="租户">
                        <TenantCell tenantId={log.tenantId} />
                      </TD>
                    )}
                    <TD data-label="时间" className="whitespace-nowrap text-sm">
                      {formatDateTime(log.createdAt)}
                    </TD>
                    <TD data-label="操作人" className="text-sm font-medium">
                      {log.actorName}
                    </TD>
                    <TD data-label="动作" className="text-sm">
                      {actionLabel(log.action)}
                    </TD>
                    <TD data-label="对象类型" className="text-sm">
                      {targetTypeLabel(log.targetType)}
                    </TD>
                    <TD data-label="IP" className="text-sm">
                      {log.ip ?? '—'}
                    </TD>
                    <TD data-label="详情" className="max-w-md text-xs text-muted-foreground">
                      {detailSummary(log.action, log.detail)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={list.data.total}
              onPageChange={setPage}
            />
          </>
        )}
      </div>

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="操作日志详情"
        size="lg"
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <div className="text-xs font-semibold text-ink-3">时间</div>
                <div className="text-ink">{formatDateTime(selected.createdAt)}</div>
              </div>
              <div>
                <div className="text-xs font-semibold text-ink-3">操作人</div>
                <div className="text-ink">{selected.actorName}</div>
              </div>
              <div>
                <div className="text-xs font-semibold text-ink-3">动作</div>
                <div className="text-ink">{actionLabel(selected.action)}</div>
              </div>
              <div>
                <div className="text-xs font-semibold text-ink-3">对象类型</div>
                <div className="text-ink">{targetTypeLabel(selected.targetType)}</div>
              </div>
              <div>
                <div className="text-xs font-semibold text-ink-3">对象 ID</div>
                <div className="break-all text-ink">{selected.targetId ?? '—'}</div>
              </div>
              <div>
                <div className="text-xs font-semibold text-ink-3">IP</div>
                <div className="text-ink">{selected.ip ?? '—'}</div>
              </div>
              <div className="sm:col-span-2">
                <div className="text-xs font-semibold text-ink-3">User-Agent</div>
                <div className="break-all text-ink">{selected.userAgent ?? '—'}</div>
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold text-ink-3">技术详情</div>
              <pre className="max-h-80 overflow-auto rounded-md border border-line bg-canvas p-3 text-xs leading-5 text-ink scrollbar-thin">
                {selected.detail ? JSON.stringify(selected.detail, null, 2) : '（无）'}
              </pre>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
