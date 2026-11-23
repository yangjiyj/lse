/**
 * 应用台账（2.8.1）：应用平台、服务器、终端、通用软件、AI 模型及组件。
 * 页面表单按 LEDGER_ATTR_FIELDS 生成专有字段，API 的 zod 校验（apps/api/src/modules/ledger/attrs.ts）与它逐字段对应。
 */
export const LEDGER_ASSET_TYPES = [
  'platform',
  'server',
  'endpoint',
  'software',
  'model',
  'component',
] as const;
export type LedgerAssetType = (typeof LEDGER_ASSET_TYPES)[number];

export const LEDGER_ASSET_TYPE_LABELS: Record<LedgerAssetType, string> = {
  platform: '应用平台',
  server: '服务器',
  endpoint: '终端',
  software: '通用软件',
  model: 'AI 模型',
  component: 'AI 组件',
};

export function isLedgerAssetType(value: unknown): value is LedgerAssetType {
  return typeof value === 'string' && (LEDGER_ASSET_TYPES as readonly string[]).includes(value);
}

export const LEDGER_RELATION_KINDS = ['uses', 'deployed_on', 'contains'] as const;
export type LedgerRelationKind = (typeof LEDGER_RELATION_KINDS)[number];

export const LEDGER_RELATION_LABELS: Record<LedgerRelationKind, string> = {
  uses: '使用',
  deployed_on: '部署于',
  contains: '包含',
};

/** 允许的关系：from 类型 + 关系 → 可指向的类型。 */
export const LEDGER_RELATION_RULES: ReadonlyArray<{
  from: LedgerAssetType;
  kind: LedgerRelationKind;
  to: readonly LedgerAssetType[];
}> = [
  { from: 'platform', kind: 'uses', to: ['model', 'component', 'software'] },
  { from: 'platform', kind: 'deployed_on', to: ['server'] },
  { from: 'platform', kind: 'contains', to: ['platform'] },
  { from: 'model', kind: 'deployed_on', to: ['server', 'endpoint'] },
  { from: 'model', kind: 'uses', to: ['component'] },
  { from: 'component', kind: 'deployed_on', to: ['server', 'endpoint'] },
  { from: 'software', kind: 'deployed_on', to: ['server', 'endpoint'] },
];

export function ledgerRelationAllowed(
  from: LedgerAssetType,
  kind: LedgerRelationKind,
  to: LedgerAssetType,
): boolean {
  return LEDGER_RELATION_RULES.some((r) => r.from === from && r.kind === kind && r.to.includes(to));
}

/** 能关联终端（fleet_endpoints）的类型。 */
export const LEDGER_ENDPOINT_LINK_TYPES: readonly LedgerAssetType[] = ['server', 'endpoint'];

/** 能关联评估对象（model_targets）的类型，以及各自允许的评估对象类型（TargetType）。 */
export const LEDGER_TARGET_LINK_TYPES: Readonly<
  Partial<Record<LedgerAssetType, readonly string[]>>
> = {
  model: ['MODEL'],
  platform: ['AGENT', 'AGENT_API', 'PLATFORM_APP', 'PUBLIC_AGENT', 'MCP_OPENAPI'],
};

export interface LedgerAttrField {
  key: string;
  label: string;
  input: 'text' | 'number' | 'url' | 'host' | 'select';
  options?: Array<{ value: string; label: string }>;
  /** 文本最大长度（字符） */
  max?: number;
}

/** 没写 max 的文本字段的默认上限。 */
export const LEDGER_ATTR_TEXT_MAX = 200;

const opts = (pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));

/** 各类型的专有字段（页面表单按它生成；API 的 zod 校验与它逐字段对应，测试核对 key 一致）。 */
export const LEDGER_ATTR_FIELDS: Record<LedgerAssetType, LedgerAttrField[]> = {
  platform: [
    { key: 'url', label: '访问地址', input: 'url' },
    { key: 'businessScenario', label: '业务场景', input: 'text', max: 500 },
    {
      key: 'deploymentMode',
      label: '部署方式',
      input: 'select',
      options: opts([
        ['third_party_api', '第三方 API'],
        ['self_hosted_open_weights', '自部署开源模型'],
        ['self_trained', '自训练'],
        ['unknown', '不确定'],
      ]),
    },
    {
      key: 'environment',
      label: '环境',
      input: 'select',
      options: opts([
        ['prod', '生产'],
        ['test', '测试'],
        ['dev', '开发'],
      ]),
    },
    { key: 'contact', label: '联系人', input: 'text', max: 100 },
  ],
  server: [
    { key: 'ip', label: 'IP', input: 'host' },
    { key: 'os', label: '操作系统', input: 'text' },
    { key: 'cpu', label: 'CPU', input: 'text' },
    { key: 'memoryGB', label: '内存（GB）', input: 'number' },
    { key: 'gpu', label: 'GPU', input: 'text' },
    { key: 'location', label: '位置', input: 'text' },
    {
      key: 'purpose',
      label: '用途',
      input: 'select',
      options: opts([
        ['training', '训练'],
        ['inference', '推理'],
        ['application', '应用'],
        ['other', '其他'],
      ]),
    },
  ],
  endpoint: [
    { key: 'ip', label: 'IP', input: 'host' },
    { key: 'user', label: '使用人', input: 'text' },
  ],
  software: [
    { key: 'vendor', label: '厂商', input: 'text' },
    { key: 'version', label: '版本', input: 'text' },
    {
      key: 'category',
      label: '类别',
      input: 'select',
      options: opts([
        ['os', '操作系统'],
        ['database', '数据库'],
        ['middleware', '中间件'],
        ['web', 'Web 服务'],
        ['other', '其他'],
      ]),
    },
    { key: 'license', label: '许可证', input: 'text' },
  ],
  model: [
    { key: 'modelName', label: '模型名称', input: 'text' },
    { key: 'version', label: '版本', input: 'text' },
    { key: 'provider', label: '提供方', input: 'text' },
    { key: 'parameterSize', label: '参数规模', input: 'text' },
    {
      key: 'modality',
      label: '模态',
      input: 'select',
      options: opts([
        ['text', '文本'],
        ['multimodal', '多模态'],
        ['speech', '语音'],
        ['other', '其他'],
      ]),
    },
    { key: 'baseModel', label: '基座模型', input: 'text' },
    { key: 'modelPath', label: '模型目录', input: 'text', max: 2000 },
  ],
  component: [
    {
      key: 'componentType',
      label: '组件类型',
      input: 'select',
      options: opts([
        ['framework', '训练推理框架'],
        ['vector_db', '向量库'],
        ['mcp', 'MCP 服务'],
        ['plugin', '插件'],
        ['skill', '技能'],
        ['other', '其他'],
      ]),
    },
    { key: 'version', label: '版本', input: 'text' },
    { key: 'endpointUrl', label: '服务地址', input: 'url' },
    { key: 'assetKey', label: '资产键', input: 'text' },
  ],
};
