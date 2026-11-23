import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relativePath: string): string => readFileSync(path.join(root, relativePath), 'utf8');

test('AIG 新任务链路已退役且历史数据能力仍保留', () => {
  for (const removedPath of [
    'apps/api/src/modules/engines/ai-infra-guard.ts',
    'apps/api/src/modules/engines/ai-infra-guard/client.ts',
    'apps/api/src/modules/engines/ai-infra-guard/normalize.ts',
    'apps/api/src/modules/engines/ai-infra-guard/scan.ts',
    'apps/web/src/pages/ComponentScanPage.tsx',
    'apps/web/src/pages/ComponentScanPage.test.tsx',
  ]) {
    assert.equal(existsSync(path.join(root, removedPath)), false, removedPath);
  }

  const apiConfig = read('apps/api/src/config.ts');
  const routes = read('apps/api/src/modules/engines/routes.ts');
  const registry = read('apps/api/src/modules/engines/registry.ts');
  const catalog = read('apps/api/src/modules/engines/catalog.ts');
  const webApi = read('apps/web/src/lib/api.ts');
  const app = read('apps/web/src/App.tsx');
  const compose = read('docker-compose.yml');
  const packageScript = read('scripts/package-offline-bundle.sh');
  const envExample = read('.env.example');

  assert.doesNotMatch(apiConfig, /AI_INFRA_GUARD/);
  assert.doesNotMatch(routes, /registerAigRoutes|ai-infra-guard/);
  assert.doesNotMatch(registry, /createAigEngine|AI_INFRA_GUARD_ENGINE/);
  assert.doesNotMatch(catalog, /AI_INFRA_GUARD_ENGINE|AI-Infra-Guard/);
  assert.doesNotMatch(webApi, /\/engines\/ai-infra-guard/);
  assert.match(app, /ComponentScanRedirect[\s\S]*Navigate to="\/service-assurance"/);
  assert.match(app, /path="\/component-scan" element={<ComponentScanRedirect \/>}/);
  assert.doesNotMatch(compose, /^  ai-infra-guard(?:-agent)?:/m);
  assert.doesNotMatch(compose, /AI_INFRA_GUARD_(?:URL|ENABLED|SERVER_IMAGE|AGENT_IMAGE)/);
  assert.doesNotMatch(packageScript, /AI_INFRA_GUARD_(?:URL|ENABLED)/);
  assert.doesNotMatch(envExample, /AI_INFRA_GUARD/);

  for (const preservedPath of [
    'apps/api/scripts/service-assurance-migrate-aig.ts',
    'apps/api/scripts/service-assurance-rollback-aig.ts',
    'apps/api/test/fixtures/service-assurance/aig-historical-result-update.json',
    'scripts/preview-service-assurance-aig-migration.sh',
  ]) {
    assert.equal(existsSync(path.join(root, preservedPath)), true, preservedPath);
  }
  assert.match(read('apps/api/src/modules/reports/labels.ts'), /'ai-infra-guard'/);
  assert.match(read('apps/web/src/lib/format.ts'), /'ai-infra-guard'/);
  for (const volume of ['aig_data', 'aig_db', 'aig_logs', 'aig_uploads', 'aig_api_checker_data']) {
    assert.match(compose, new RegExp(`^  ${volume}:`, 'm'));
  }
});
