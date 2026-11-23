/** Dify 应用接入预设；密钥只存独立字段，不嵌入请求头或模板。 */
export type DifyPresetKind = 'chat' | 'workflow';
export function buildDifyPreset(kind: DifyPresetKind, baseUrl: string, apiKey: string) {
  const url = new URL(baseUrl.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('应用地址须为不含凭据、查询参数的 HTTP 或 HTTPS 地址');
  }
  const base = url.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
  const chat = kind === 'chat';
  return {
    baseUrl: `${base}/v1/${chat ? 'chat-messages' : 'workflows/run'}`,
    apiKey: apiKey.trim(),
    accessConfig: {
      authType: 'bearer' as const,
      requestTemplate: chat
        ? { inputs: {}, query: '{{question}}', response_mode: 'blocking', user: 'lse-rag-eval' }
        : { inputs: { query: '{{question}}' }, response_mode: 'blocking', user: 'lse-rag-eval' },
      responseTextPath: chat ? 'answer' : 'data.outputs.text',
    },
    ragOptions: chat ? {
      contextPath: 'metadata.retriever_resources',
      contextTextField: 'content',
      contextIdField: 'document_id',
      citationPath: 'metadata.retriever_resources',
      citationTextField: 'content',
      citationIdField: 'document_name',
    } : {},
  };
}
