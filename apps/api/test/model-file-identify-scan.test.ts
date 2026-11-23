import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { runModelFileScan } from '../src/modules/model-files/executor.js';

/** 目录扫描落库后：模型文件带识别结论，配置文件不进 AIBOM 的模型组件。 */
const here = dirname(fileURLToPath(import.meta.url));
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let base = '';
const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.modelFileScan.deleteMany({ where: { path: { contains: 'lse-mf-idscan-' } } });
  await prisma.systemSetting.deleteMany({ where: { key: 'model_file_scan.config' } });
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
  base = await mkdtemp(join(tmpdir(), 'lse-mf-idscan-'));
  execFileSync('python3', [join(here, 'fixtures/model-files/gen_identify.py'), base], {
    cwd: join(here, 'fixtures/model-files'),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: 'pipe',
  });
  const put = await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: {
      roots: [base],
      pickleMaxBytes: 1024 * 1024,
      totalMaxBytes: 64 * 1024 * 1024,
      maxFiles: 100,
    },
  });
  assert.equal(put.statusCode, 200, put.body);
});

after(async () => {
  await cleanup();
  await rm(base, { recursive: true, force: true });
  await app.close();
});

test('目录扫描结果带模型识别；AIBOM 只把模型权重列为模型组件', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/directory',
    headers: auth(),
    payload: { path: join(base, 'lora') },
  });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().id as string;
  await runModelFileScan(id);
  const detail = (
    await app.inject({ method: 'GET', url: `/api/model-files/scans/${id}`, headers: auth() })
  ).json();
  assert.equal(detail.status, 'COMPLETED', detail.error);
  const files = detail.files as Array<{
    path: string;
    format: string;
    meta: Record<string, unknown>;
  }>;
  const weight = files.find((f) => f.path === 'adapter_model.safetensors')!;
  assert.equal((weight.meta.identification as { verdict: string }).verdict, 'adapter');
  assert.equal(weight.meta.knownModelLabel, '未在已知模型库中');
  assert.equal(files.find((f) => f.path === 'adapter_config.json')?.format, 'config');
  const bom = (
    await app.inject({ method: 'GET', url: `/api/model-files/scans/${id}/aibom`, headers: auth() })
  ).json();
  const models = bom.components.filter(
    (c: { type: string }) => c.type === 'machine-learning-model',
  );
  assert.deepEqual(
    models.map(
      (c: { properties: Array<{ name: string; value: string }> }) =>
        c.properties.find((p) => p.name === 'lse:path')?.value,
    ),
    ['adapter_model.safetensors'],
  );
});
