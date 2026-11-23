import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  uploadKnowledgeDocument,
  deleteKnowledgeDocument,
  retrieveFromTarget,
} from '../src/modules/rag-eval/target-client.js';
import type { EvaluationTargetConfig } from '../src/modules/eval-targets/invoker.js';

// 真实 HTTP 桩：记录每次请求的方法、路径、头与原始请求体。
const seen: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let server!: http.Server;
let base = '';
const envBackup = {
  allow: process.env.LSE_TARGET_EGRESS_ALLOWLIST,
  priv: process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE,
};

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url!, method: req.method!, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url!.startsWith('/search')) {
        return res.end(JSON.stringify({ data: { hits: [{ doc: 'lse-doc-1', text: '片段' }] } }));
      }
      res.end(JSON.stringify({ data: { id: 'remote-42' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = base;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (envBackup.allow === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  else process.env.LSE_TARGET_EGRESS_ALLOWLIST = envBackup.allow;
  if (envBackup.priv === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  else process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = envBackup.priv;
});

const target = (): EvaluationTargetConfig => ({
  targetType: 'AGENT_API',
  baseUrl: `${base}/chat`,
  apiKey: 'sk-target-identity',
  model: 'm',
  extraHeaders: null,
  defaultParams: null,
  accessConfig: { requestTemplate: { query: '{{prompt}}' }, responseTextPath: 'answer' },
});

test('multipart 上传：文件字段 + 附加字段，读取文档 ID；删除接口用 {{document_id}}', async () => {
  seen.length = 0;
  const up = await uploadKnowledgeDocument(
    target(),
    {
      url: `${base}/kb/{{knowledge_base_id}}/files`,
      method: 'POST',
      format: 'multipart',
      multipartFileField: 'upload',
      multipartFields: { kb: '{{knowledge_base_id}}' },
      documentIdPath: 'data.id',
    },
    { filename: 'a.md', content: '# 标题\n正文', knowledgeBaseId: 'kb 1' },
  );
  assert.equal(up.ok, true, up.error ?? '');
  assert.equal(up.documentId, 'remote-42');
  const req = seen[0]!;
  assert.equal(req.url, '/kb/kb%201/files');
  assert.match(String(req.headers['content-type']), /multipart\/form-data; boundary=/);
  assert.match(req.body, /name="upload"; filename="a.md"/);
  assert.match(req.body, /name="kb"\r\n\r\nkb 1/);
  assert.ok(req.body.includes('# 标题\n正文'));

  const del = await deleteKnowledgeDocument(
    target(),
    { url: `${base}/kb/files/{{document_id}}`, method: 'DELETE' },
    { documentId: 'remote-42', filename: 'a.md', knowledgeBaseId: 'kb' },
  );
  assert.equal(del.ok, true);
  assert.equal(seen[1]!.url, '/kb/files/remote-42');
  assert.equal(seen[1]!.method, 'DELETE');
});

test('受限库上传只带单独凭据，不带被测身份的任何鉴权头', async () => {
  seen.length = 0;
  await uploadKnowledgeDocument(
    target(),
    { url: `${base}/kb/upload`, method: 'POST', format: 'json' },
    { filename: 's.md', content: 'x', knowledgeBaseId: 'kb-r' },
    { auth: { kind: 'restricted', headerName: 'X-Restricted-Token', value: 'restricted-cred' } },
  );
  const h = seen[0]!.headers;
  assert.equal(h['x-restricted-token'], 'restricted-cred');
  assert.equal(h.authorization, undefined);
  assert.doesNotMatch(JSON.stringify(h), /sk-target-identity/);

  seen.length = 0;
  await uploadKnowledgeDocument(
    target(),
    { url: `${base}/kb/upload`, method: 'POST', format: 'json' },
    { filename: 't.md', content: 'x', knowledgeBaseId: 'kb' },
  );
  assert.match(JSON.stringify(seen[0]!.headers), /sk-target-identity/, '普通上传沿用被测身份');
});

test('检索接口：按 resultsPath/idField/textField 读取片段', async () => {
  seen.length = 0;
  const r = await retrieveFromTarget(
    target(),
    {},
    { url: `${base}/search`, method: 'POST', resultsPath: 'data.hits', idField: 'doc', textField: 'text', topK: 3 },
    '报销期限',
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.entries, [{ id: 'lse-doc-1', text: '片段' }]);
  assert.deepEqual(JSON.parse(seen[0]!.body), { query: '报销期限', top_k: '3' });
});
