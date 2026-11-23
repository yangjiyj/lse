import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { runModelFileScan } from '../src/modules/model-files/executor.js';
import { maliciousPickle, safePickle } from './helpers/model-file-fixtures.js';

const PREFIX = 'MODEL-FILE-ROUTE-';
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let targetId = '';
let base = '';
const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.modelFileScan.deleteMany({
    where: {
      OR: [
        { path: { contains: 'lse-mf-route-' } },
        { path: { startsWith: PREFIX } },
        { target: { name: { startsWith: PREFIX } } },
      ],
    },
  });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
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
  targetId = (
    await prisma.modelTarget.create({
      data: {
        name: `${PREFIX}对象`,
        provider: 'openai-compatible',
        baseUrl: 'https://m.invalid/v1',
        apiKey: 'test-only',
        model: 'demo-7b',
      },
    })
  ).id;
  base = await mkdtemp(join(tmpdir(), 'lse-mf-route-'));
  await mkdir(join(base, 'models', 'sub'), { recursive: true });
  await writeFile(join(base, 'models', 'sub', 'evil.pkl'), maliciousPickle());
  await writeFile(join(base, 'models', 'ok.pkl'), safePickle());
});

after(async () => {
  await cleanup();
  await rm(base, { recursive: true, force: true });
  await app.close();
});

test('未配置白名单时目录扫描被拒绝', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/directory',
    headers: auth(),
    payload: { path: join(base, 'models') },
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.body, /白名单/);
});

test('上传扫描落库为 ModelFileScan/ModelFileFinding，风险域为组件安全，并生成 AIBOM', async () => {
  const sbom = JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    components: [
      { type: 'library', name: 'torch', version: '2.3.0', purl: 'pkg:pypi/torch@2.3.0' },
    ],
  });
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/upload',
    headers: auth(),
    payload: {
      uploadId: (
        await app.inject({
          method: 'POST',
          url: `/api/model-files/uploads?fileName=${encodeURIComponent(`${PREFIX}evil.pkl`)}`,
          headers: { ...auth(), 'content-type': 'application/octet-stream' },
          payload: maliciousPickle(),
        })
      ).json().uploadId,
      targetId,
      license: 'Apache-2.0',
      source: 'https://example.invalid/model',
      dependencySbom: { contentType: 'application/vnd.cyclonedx+json', content: sbom },
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  const { id } = r.json();
  await runModelFileScan(id);
  const { highCount } = await prisma.modelFileScan.findUniqueOrThrow({ where: { id } });
  assert.ok(highCount >= 1);
  const findings = await prisma.modelFileFinding.findMany({ where: { scanId: id } });
  assert.ok(findings.length > 0 && findings.every((f) => f.riskCategory === '组件安全'));
  assert.ok(
    findings.some(
      (f) => f.ruleId === 'PICKLE_DANGEROUS_GLOBAL' && f.evidence.includes('os.system'),
    ),
  );
  const exp = await app.inject({
    method: 'GET',
    url: `/api/model-files/scans/${id}/aibom`,
    headers: auth(),
  });
  assert.equal(exp.statusCode, 200);
  assert.match(String(exp.headers['content-disposition']), /aibom-.*\.cdx\.json/);
  const bom = exp.json();
  assert.equal(bom.specVersion, '1.6');
  const model = bom.components.find((c: { type: string }) => c.type === 'machine-learning-model');
  assert.equal(model.name, `${PREFIX}对象`);
  assert.equal(model.hashes[0].alg, 'SHA-256');
  assert.equal(model.licenses[0].license.name, 'Apache-2.0');
  assert.ok(bom.components.some((c: { purl?: string }) => c.purl === 'pkg:pypi/torch@2.3.0'));
  assert.ok(
    bom.dependencies.some(
      (d: { ref: string; dependsOn: string[] }) =>
        d.ref === 'model-1' && d.dependsOn.includes('dep-1'),
    ),
  );
  const tgt = await app.inject({
    method: 'GET',
    url: `/api/model-files/targets/${targetId}/aibom`,
    headers: auth(),
  });
  assert.equal(tgt.json().scanId, id);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'model_file_scan.run', targetId: id },
  });
  assert.ok(audit);
});

test('管理员配置白名单后目录扫描可用，越界路径入队前即被拒', async () => {
  const put = await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: {
      roots: [join(base, 'models')],
      pickleMaxBytes: 1024 * 1024,
      totalMaxBytes: 10 * 1024 * 1024,
      maxFiles: 100,
    },
  });
  assert.equal(put.statusCode, 200, put.body);
  const browse = await app.inject({
    method: 'GET',
    url: `/api/model-files/browse?path=${encodeURIComponent(join(base, 'models'))}`,
    headers: auth(),
  });
  assert.deepEqual(browse.json().directories, ['sub']);
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/directory',
    headers: auth(),
    payload: { path: join(base, 'models') },
  });
  assert.equal(r.statusCode, 200, r.body);
  await runModelFileScan(r.json().id);
  const detail = (
    await app.inject({
      method: 'GET',
      url: `/api/model-files/scans/${r.json().id}`,
      headers: auth(),
    })
  ).json();
  assert.equal(detail.source, 'DIRECTORY');
  assert.equal(detail.fileCount, 2);
  const list = (
    await app.inject({
      method: 'GET',
      url: `/api/model-files/scans/${r.json().id}/findings?severity=HIGH`,
      headers: auth(),
    })
  ).json();
  assert.ok(
    list.items.length > 0 &&
      list.items.every((f: { filePath: string }) => f.filePath.endsWith('evil.pkl')),
  );
  const bad = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/directory',
    headers: auth(),
    payload: { path: base },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /白名单/);
});

test('风险处置台来源列出全部中危及以上问题', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/model-files/findings', headers: auth() });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.ok(body.total > 0);
  assert.ok(
    body.items.every(
      (f: { severity: string; riskCategory: string }) =>
        ['CRITICAL', 'HIGH', 'MEDIUM'].includes(f.severity) && f.riskCategory === '组件安全',
    ),
  );
  assert.ok(body.items[0].scan.path);
});

test('无认证访问被拒', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/model-files/scans' });
  assert.equal(r.statusCode, 401);
});

test('评估对象最近一次扫描结论：返回最新一条（含高/中/低数量与时间），无扫描时为 null', async () => {
  const r = await app.inject({
    method: 'GET',
    url: `/api/model-files/targets/${targetId}/latest`,
    headers: auth(),
  });
  assert.equal(r.statusCode, 200, r.body);
  const latest = r.json();
  assert.equal(latest.status, 'COMPLETED');
  assert.ok(latest.highCount >= 1);
  assert.ok(latest.finishedAt);
  const none = await app.inject({
    method: 'GET',
    url: '/api/model-files/targets/00000000-0000-4000-8000-000000000000/latest',
    headers: auth(),
  });
  assert.equal(none.statusCode, 200);
  assert.equal(none.body, 'null');
});
