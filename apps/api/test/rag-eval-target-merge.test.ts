import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { decryptCredential, isEncryptedCredential } from '../src/lib/credential-crypto.js';

const PREFIX = '__rag_merge_';
let app!: FastifyInstance;
let token = '';
const auth = () => ({ authorization: `Bearer ${token}` });

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  token = login.json().token;
});

after(async () => {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const agentBase = {
  targetType: 'AGENT_API' as const,
  provider: 'agent',
  baseUrl: 'http://127.0.0.1:9/rag/chat',
  apiKey: 'sk-rag-merge-123456',
  model: 'rag-app',
  accessConfig: { requestTemplate: { query: '{{prompt}}' }, responseTextPath: 'answer' },
};

test('非智能体应用 API 类对象不能声明 RAG（创建与编辑）', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: { name: `${PREFIX}模型`, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-m-123456', model: 'm', isRag: true },
  });
  assert.equal(created.statusCode, 400, created.body);
  assert.equal(created.json().error.code, 'RAG_TARGET_TYPE_UNSUPPORTED');

  const plain = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: { name: `${PREFIX}模型2`, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-m-123456', model: 'm' },
  });
  assert.equal(plain.statusCode, 201, plain.body);
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${plain.json().id}`,
    headers: auth(),
    payload: { isRag: true },
  });
  assert.equal(patched.statusCode, 400, patched.body);
});

test('编辑 ragOptions 按字段合并：只改一项不丢其它字段；旧字段迁移到顶层；null 清除', async () => {
  const t = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}旧数据`,
      ...agentBase,
      isRag: true,
      // 旧数据：测试知识库标识放在 knowledgeUpload 里
      ragOptions: {
        citationPath: 'citations',
        citationTextField: 'text',
        knowledgeUpload: { url: 'http://127.0.0.1:9/kb', testKnowledgeBaseId: 'kb-old', restrictedKnowledgeBaseId: 'kb-r' },
      },
    },
  });
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${t.id}`,
    headers: auth(),
    payload: { ragOptions: { contextPath: 'data.contexts', knowledgeUpload: { format: 'multipart' } } },
  });
  assert.equal(res.statusCode, 200, res.body);
  const o = res.json().ragOptions;
  assert.equal(o.contextPath, 'data.contexts');
  assert.equal(o.citationPath, 'citations', '未提交的字段保留');
  assert.equal(o.citationTextField, 'text');
  assert.equal(o.testKnowledgeBaseId, 'kb-old', '旧字段迁移到顶层');
  assert.equal(o.knowledgeUpload.url, 'http://127.0.0.1:9/kb', '分组内未提交的字段保留');
  assert.equal(o.knowledgeUpload.format, 'multipart');
  assert.equal(o.knowledgeUpload.restrictedKnowledgeBaseId, 'kb-r');

  const cleared = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${t.id}`,
    headers: auth(),
    payload: { ragOptions: { citationPath: null, knowledgeUpload: { restrictedKnowledgeBaseId: '' } } },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().ragOptions.citationPath, undefined);
  assert.equal(cleared.json().ragOptions.knowledgeUpload.restrictedKnowledgeBaseId, undefined);
  assert.equal(cleared.json().ragOptions.contextPath, 'data.contexts');

  const bad = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${t.id}`,
    headers: auth(),
    payload: { ragOptions: { knowledgeUpload: { url: 'ftp://x/y' } } },
  });
  assert.equal(bad.statusCode, 400, '合并后仍做完整校验');
});

test('受限库上传凭据加密存储、响应与审计不回显', async () => {
  const secret = 'restricted-secret-XYZ-987';
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: { name: `${PREFIX}凭据`, ...agentBase, isRag: true, ragRestrictedUploadSecret: secret },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().hasRagRestrictedUploadSecret, true);
  assert.doesNotMatch(res.body, /restricted-secret-XYZ/);
  const row = await prisma.modelTarget.findUniqueOrThrow({ where: { id: res.json().id } });
  assert.ok(isEncryptedCredential(row.ragRestrictedUploadSecret));
  assert.notEqual(row.ragRestrictedUploadSecret, secret);
  assert.equal(decryptCredential(row.ragRestrictedUploadSecret), secret);

  // 不提交则保持不变
  const keep = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${row.id}`,
    headers: auth(),
    payload: { name: `${PREFIX}凭据2` },
  });
  assert.equal(keep.json().hasRagRestrictedUploadSecret, true);
  const get = await app.inject({ method: 'GET', url: `/api/model-targets/${row.id}`, headers: auth() });
  assert.doesNotMatch(get.body, /restricted-secret-XYZ|enc:v1/);

  const clear = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${row.id}`,
    headers: auth(),
    payload: { ragRestrictedUploadSecret: null },
  });
  assert.equal(clear.json().hasRagRestrictedUploadSecret, false);
  const audits = await prisma.auditLog.findMany({ where: { targetId: row.id } });
  assert.ok(audits.length >= 2);
  for (const a of audits) assert.doesNotMatch(JSON.stringify(a.detail ?? {}), /restricted-secret-XYZ|enc:v1/);
});
