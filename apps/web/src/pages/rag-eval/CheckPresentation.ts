/** 配置项只展示中文名称和会影响操作的提示，不透传内部模板。 */
const LABELS: Record<string, string> = {
  type: '智能体应用接口', isRag: '已声明为 RAG 应用', active: '对象已启用',
  contextPath: '检索上下文路径', citationPath: '引用来源路径',
  testKnowledgeBaseId: '测试知识库标识', upload: '知识库上传接口',
  delete: '运行结束自动清理', retrieval: '检索接口', restricted: '受限库上传凭据',
};
const HINTS: Record<string, string> = {
  type: '请选择智能体应用接口。', isRag: '请在评估对象中开启 RAG 应用。',
  active: '请先启用该对象。', contextPath: '未配置时忠实度记“未评估”',
};
export const checkLabel = (key: string, fallback: string) => LABELS[key] ?? fallback;
export const checkHint = (key: string) => HINTS[key] ?? '';
