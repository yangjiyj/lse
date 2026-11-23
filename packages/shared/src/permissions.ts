// 权限与角色目录：seed 与运行时 RBAC 的唯一事实来源。
export interface PermissionDef {
  code: string;
  name: string;
  group: string;
}

export const PERMISSIONS: PermissionDef[] = [
  // A restrictive service boundary, never an implicit administrator grant.
  { code: 'platform_connector:restricted', name: '平台连接器自身数据边界', group: '服务连接器' },
  // 评估任务
  { code: 'eval_task:create', name: '创建评估任务', group: '评估任务' },
  { code: 'eval_task:read', name: '查看评估任务', group: '评估任务' },
  { code: 'eval_task:delete', name: '删除评估任务', group: '评估任务' },
  { code: 'eval_task:re_eval', name: '重新评估', group: '评估任务' },
  { code: 'eval_task:log_view', name: '查看任务日志', group: '评估任务' },
  // 评估对象
  { code: 'model_target:create', name: '新建评估对象', group: '评估对象' },
  { code: 'model_target:read', name: '查看评估对象', group: '评估对象' },
  { code: 'model_target:update', name: '编辑评估对象', group: '评估对象' },
  { code: 'model_target:delete', name: '删除评估对象', group: '评估对象' },
  { code: 'model_target:test', name: '测试连接', group: '评估对象' },
  // 样本库
  { code: 'question_set:create', name: '新建样本库', group: '样本库' },
  { code: 'question_set:read', name: '查看样本库', group: '样本库' },
  { code: 'question_set:update', name: '编辑样本库', group: '样本库' },
  { code: 'question_set:delete', name: '删除样本库', group: '样本库' },
  { code: 'question_set:preview', name: '预览样本库', group: '样本库' },
  { code: 'question_set:export', name: '导出样本库', group: '样本库' },
  { code: 'question_set:export_builtin', name: '导出内置样本库', group: '样本库' },
  // 测试样本
  { code: 'question:create', name: '新建测试样本', group: '测试样本' },
  { code: 'question:read', name: '查看测试样本', group: '测试样本' },
  { code: 'question:update', name: '编辑测试样本', group: '测试样本' },
  { code: 'question:delete', name: '删除测试样本', group: '测试样本' },
  { code: 'question:import', name: '导入测试样本', group: '测试样本' },
  // 报告
  { code: 'report:read', name: '查看报告', group: '报告' },
  { code: 'report:download', name: '下载报告', group: '报告' },
  { code: 'report:generate', name: '生成报告', group: '报告' },
  // 报告模板（2.4.7）：章节、封面、页眉页脚、密级；只给两个管理员角色。
  { code: 'report_template:manage', name: '管理报告模板', group: '报告' },
  // 远程部署终端探针（2.4.8）：经 SSH 推送或一次性部署命令；只给两个管理员角色。
  { code: 'fleet:remote_deploy', name: '远程部署终端探针', group: '终端与智能体' },
  // 风险样本
  { code: 'wrong_answer:export', name: '导出风险样本', group: '风险样本' },
  // 风险整改闭环
  { code: 'remediation:read', name: '查看整改项', group: '风险整改' },
  { code: 'remediation:update', name: '更新整改项', group: '风险整改' },
  // 系统管理
  { code: 'system_setting:read', name: '查看系统设置', group: '系统管理' },
  { code: 'system_setting:update', name: '更新系统设置', group: '系统管理' },
  { code: 'platform_setting:read', name: '查看平台设置', group: '系统管理' },
  { code: 'platform_setting:update', name: '更新平台设置', group: '系统管理' },
  { code: 'redteam_setting:read', name: '查看攻击策略', group: '系统管理' },
  { code: 'redteam_setting:update', name: '更新攻击策略', group: '系统管理' },
  { code: 'license:read', name: '查看授权许可', group: '系统管理' },
  { code: 'license:update', name: '更新授权许可', group: '系统管理' },
  // 技术支持与意见反馈：任何登录用户都能提交，处理全部租户的工单要单独授权（平台级）。
  { code: 'support:manage', name: '处理技术支持与意见反馈', group: '系统管理' },
  // 操作日志
  { code: 'audit_log:read', name: '查看操作日志', group: '操作日志' },
  // 角色管理
  { code: 'role:create', name: '新建角色', group: '角色管理' },
  { code: 'role:read', name: '查看角色', group: '角色管理' },
  { code: 'role:update', name: '编辑角色', group: '角色管理' },
  { code: 'role:delete', name: '删除角色', group: '角色管理' },
  // 用户管理
  { code: 'user:create', name: '新建用户', group: '用户管理' },
  { code: 'user:read', name: '查看用户', group: '用户管理' },
  { code: 'user:update', name: '编辑用户', group: '用户管理' },
  { code: 'user:delete', name: '删除用户', group: '用户管理' },
  { code: 'user:reset_password', name: '重置密码', group: '用户管理' },
  // 组织架构：租户内的组织树与用户归属（本期不按组织分权分域）。
  { code: 'org:read', name: '查看组织架构', group: '组织架构' },
  { code: 'org:manage', name: '维护组织架构', group: '组织架构' },
  // 样本生成
  { code: 'generator:preview', name: '预览生成', group: '样本生成' },
  { code: 'generator:run', name: '执行生成', group: '样本生成' },
  { code: 'generator:llm', name: 'AI 增强生成', group: '样本生成' },
  // 安全引擎
  { code: 'engine:scan', name: '发起安全引擎扫描', group: '安全引擎' },
  { code: 'gateway_log:analyze', name: '分析智能体安全网关日志', group: '安全引擎' },
  // AI 服务安全核验
  { code: 'service_assurance:read', name: '查看服务安全核验', group: '服务安全核验' },
  { code: 'service_assurance:scan', name: '发起服务安全核验', group: '服务安全核验' },
  { code: 'service_assurance:verify', name: '发起授权深度核验', group: '服务安全核验' },
  { code: 'service_assurance:review', name: '复核服务安全结论', group: '服务安全核验' },
  // GB/T 45654 输出安全专项：与旧题库/评估权限显式分离。
  { code: 'standard_eval:read', name: '查看标准专项', group: '标准专项' },
  { code: 'standard_eval:run', name: '发起标准专项', group: '标准专项' },
  { code: 'standard_bank:edit', name: '维护标准题目版本', group: '标准专项' },
  { code: 'standard_bank:review', name: '审核标准题目版本', group: '标准专项' },
  { code: 'standard_bank:publish', name: '发布标准题库版本', group: '标准专项' },
  { code: 'standard_review:judge', name: '提交标准人工判定', group: '标准专项' },
  { code: 'standard_report:generate', name: '生成标准对标报告', group: '标准专项' },
  // 数据安全：敏感个人信息默认脱敏，「查看明文」需单独授权并留审计。
  { code: 'sensitive_data:view_plain', name: '查看敏感信息明文', group: '数据安全' },
  // 持续评估：上线门禁（API 令牌管理沿用 system_setting:update，仅管理员）。
  { code: 'gate:read', name: '查看上线门禁', group: '持续评估' },
  { code: 'gate:manage', name: '管理上线门禁', group: '持续评估' },
  // RAG 专项评估：知识库、测试集与评估运行。
  { code: 'rag_eval:read', name: '查看 RAG 专项评估', group: 'RAG 专项评估' },
  { code: 'rag_eval:manage', name: '维护 RAG 知识库与测试集', group: 'RAG 专项评估' },
  { code: 'rag_eval:run', name: '发起 RAG 专项评估', group: 'RAG 专项评估' },
  // 语料扫描（数据安全工具）：训练、微调语料的违规内容、敏感信息、自定义规则检测。
  { code: 'corpus_scan:read', name: '查看语料扫描', group: '语料扫描' },
  { code: 'corpus_scan:create', name: '发起语料扫描', group: '语料扫描' },
  // 导出命中原文（不打码）和下载打码副本；删除别人发起的扫描要 corpus_scan:manage。
  { code: 'corpus_scan:export', name: '导出语料扫描结果和打码副本', group: '语料扫描' },
  { code: 'corpus_scan:manage', name: '管理全部语料扫描', group: '语料扫描' },
  { code: 'corpus_rule:manage', name: '管理语料规则', group: '语料扫描' },
  // 检测任务（2.4.x）：统一任务视图、组合任务、检测策略。看各类记录另要该类的查看权限。
  { code: 'detect_task:read', name: '查看检测任务', group: '检测任务' },
  { code: 'detect_task:manage', name: '管理组合任务和检测策略', group: '检测任务' },
  // 多租户：新建/停用租户、进入任意租户代管。只对平台租户的用户生效。
  { code: 'tenant:manage', name: '管理租户', group: '租户管理' },
  // 工具中心：工具是平台级内容，所有租户共用；管理（上传、删除、禁用、隐藏、看下载溯源）只给平台管理员。
  { code: 'tool:read', name: '查看工具中心', group: '工具中心' },
  { code: 'tool:manage', name: '管理工具中心', group: '工具中心' },
  // 应用台账（2.8.1）：租户内数据，查看给全部内置角色，维护给管理员和操作员。
  { code: 'ledger:read', name: '查看应用台账', group: '应用台账' },
  { code: 'ledger:manage', name: '维护应用台账', group: '应用台账' },
  // 检测方案（2.8.2～2.8.4）：需求配置、方案清单、作业指导书；租户内数据。
  { code: 'scheme:read', name: '查看检测方案', group: '检测方案' },
  { code: 'scheme:manage', name: '维护检测方案', group: '检测方案' },
];

/**
 * 平台级权限：只对平台租户的用户生效；其他租户的用户即使角色里带了也会在登录态里剔除。
 * 平台设置、授权许可、角色定义、标准题库发布对全平台生效，不能交给单个租户。
 */
export const PLATFORM_ONLY_PERMISSIONS: readonly string[] = [
  'tenant:manage',
  'license:update',
  'platform_setting:update',
  'system_setting:update',
  'redteam_setting:update',
  'role:create',
  'role:update',
  'role:delete',
  'standard_bank:edit',
  'standard_bank:review',
  'standard_bank:publish',
  'support:manage',
  // 内置样本库（平台内容）导出只给平台管理员；租户管理员只能导出自建库。
  'question_set:export_builtin',
  // 工具中心是平台级内容。
  'tool:manage',
];

export const PERMISSION_CODES: string[] = PERMISSIONS.map((p) => p.code);

const codesByPrefix = (...prefixes: string[]): string[] =>
  PERMISSION_CODES.filter((c) => prefixes.some((p) => c.startsWith(p)));

export interface RoleDef {
  name: string;
  description: string;
  isBuiltin: true;
  permissions: string[]; // 已展开的权限码
}

// 内置角色（与已落库的 seed 数据保持一致）：
//  - admin：平台管理员，拥有全部系统权限（含租户管理）；只能分配给平台租户的用户
//  - tenant_admin：租户管理员，管理本租户的用户与全部评估业务，不含平台级权限
//  - operator：评估执行相关权限（任务/评估对象/样本库/测试样本/报告/生成/引擎）
//  - auditor：只读 + 报告下载 + 风险样本导出 + 操作日志；不包含写权限
export const PLATFORM_ADMIN_ROLE = 'admin';
export const TENANT_ADMIN_ROLE = 'tenant_admin';

export const ROLE_DEFS: RoleDef[] = [
  {
    name: PLATFORM_ADMIN_ROLE,
    description: '平台管理员，拥有全部系统权限，可管理租户。',
    isBuiltin: true,
    permissions: PERMISSION_CODES.filter((code) => code !== 'platform_connector:restricted'),
  },
  {
    name: 'operator',
    description: '评估操作员，负责评估对象、样本库、任务和报告管理。',
    isBuiltin: true,
    permissions: [
      // 导出样本库只给平台管理员和租户管理员（内置库导出只给平台管理员）。
      ...codesByPrefix(
        'eval_task:',
        'model_target:',
        'question_set:',
        'question:',
        'report:',
        'wrong_answer:',
        'remediation:',
        'generator:',
        'engine:',
        'gate:',
      ).filter(
        (code) => code !== 'question_set:export' && code !== 'question_set:export_builtin',
      ),
      'redteam_setting:read',
      'service_assurance:read',
      'service_assurance:scan',
      'service_assurance:verify',
      'rag_eval:read',
      'rag_eval:manage',
      'rag_eval:run',
      'org:read',
      'tool:read',
      'corpus_scan:read',
      'corpus_scan:create',
      'corpus_scan:export',
      'detect_task:read',
      'detect_task:manage',
      'ledger:read',
      'ledger:manage',
      'scheme:read',
      'scheme:manage',
    ],
  },
  {
    name: 'auditor',
    description: '审计员，可只读查看并下载报告、导出风险样本和查阅操作日志。',
    isBuiltin: true,
    permissions: [
      'eval_task:read',
      'eval_task:log_view',
      'model_target:read',
      'question_set:read',
      'question:read',
      'report:read',
      'report:download',
      'wrong_answer:export',
      'audit_log:read',
      'platform_setting:read',
      'redteam_setting:read',
      'service_assurance:read',
      'gate:read',
      'rag_eval:read',
      'org:read',
      'tool:read',
      'corpus_scan:read',
      'detect_task:read',
      'ledger:read',
      'scheme:read',
    ],
  },
  {
    name: TENANT_ADMIN_ROLE,
    description: '租户管理员，管理本租户的用户和全部评估业务。',
    isBuiltin: true,
    permissions: PERMISSION_CODES.filter(
      (code) => code !== 'platform_connector:restricted' && !PLATFORM_ONLY_PERMISSIONS.includes(code),
    ),
  },
];
