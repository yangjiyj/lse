import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { parseRagOptions } from '../src/modules/rag-eval/options.js';

const PREFIX = '__w6a_rag_target_';

let app!: FastifyInstance;
let token = '';

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function cleanup(): Promise<void> {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('parseRagOptions 规范化引用路径与知识库上传配置', () => {
  assert.deepEqual(parseRagOptions(null), {});
  const parsed = parseRagOptions({
    citationPath: ' data.citations ',
    citationTextField: 'content',
    knowledgeUpload: {
      url: 'https://rag.example.com/kb/upload',
      bodyTemplate: { kb: '{{knowledge_base_id}}', file: '{{content_base64}}' },
      testKnowledgeBaseId: 'kb-test',
    },
  });
  assert.equal(parsed.citationPath, 'data.citations');
  assert.equal(parsed.knowledgeUpload?.method, 'POST');
  assert.equal(parsed.knowledgeUpload?.testKnowledgeBaseId, 'kb-test');
  assert.throws(() => parseRagOptions({ knowledgeUpload: { url: 'file:///etc/passwd' } }));
  assert.throws(() => parseRagOptions({ citationPath: 'a.__proto__.b' }));
});

test('创建评估对象可声明 RAG 应用并返回 ragOptions，默认非 RAG', async () => {
  const plain = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: `${PREFIX}普通`,
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-plain-123456',
      model: 'm',
    },
  });
  assert.equal(plain.statusCode, 201, plain.body);
  assert.equal(plain.json().isRag, false);
  assert.equal(plain.json().ragOptions, null);

  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: `${PREFIX}RAG`,
      targetType: 'AGENT_API',
      baseUrl: 'http://127.0.0.1:9/rag/chat',
      apiKey: 'sk-rag-123456',
      model: 'rag-app',
      accessConfig: { requestTemplate: { query: '{{prompt}}' }, responseTextPath: 'answer' },
      isRag: true,
      ragOptions: { citationPath: 'citations', citationTextField: 'text' },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.isRag, true);
  assert.equal(body.ragOptions.citationPath, 'citations');

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${body.id}`,
    headers: auth(),
    payload: {
      ragOptions: {
        citationPath: 'citations',
        knowledgeUpload: { url: 'http://127.0.0.1:9/rag/kb', testKnowledgeBaseId: 'kb1' },
      },
    },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().ragOptions.knowledgeUpload.url, 'http://127.0.0.1:9/rag/kb');

  const off = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${body.id}`,
    headers: auth(),
    payload: { isRag: false },
  });
  assert.equal(off.json().isRag, false);
});

test('非法 ragOptions 返回 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: `${PREFIX}非法`,
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-bad-123456',
      model: 'm',
      isRag: true,
      ragOptions: { knowledgeUpload: { url: 'ftp://x/y' } },
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});
