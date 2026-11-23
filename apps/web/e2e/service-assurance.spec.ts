import path from 'node:path';
import { expect, test, type Page } from 'playwright/test';

const baseURL = process.env.LSE_SERVICE_ASSURANCE_E2E_BASE_URL ?? '';
const username = process.env.LSE_SERVICE_ASSURANCE_E2E_USERNAME ?? '';
const password = process.env.LSE_SERVICE_ASSURANCE_E2E_PASSWORD ?? '';
const affectedURL = process.env.LSE_SERVICE_ASSURANCE_E2E_AFFECTED_URL ?? '';
const openapiURL = process.env.LSE_SERVICE_ASSURANCE_E2E_OPENAPI_URL ?? '';
const sbomPath = process.env.LSE_SERVICE_ASSURANCE_E2E_SBOM_PATH ?? '';
const evidenceDir = process.env.LSE_SERVICE_ASSURANCE_E2E_EVIDENCE_DIR ?? '';

const forbiddenCustomerText =
  /\b(?:AIG|Nuclei|ZAP|Trivy)\b|service-assurance|raw\s*json|rawOutput|engineRun|runId|session\s*id|sessionId|container|容器名|内部字段|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

test.describe.configure({ mode: 'serial' });
test.setTimeout(15 * 60_000);

function requireEnvironment(): void {
  for (const [name, value] of Object.entries({
    LSE_SERVICE_ASSURANCE_E2E_BASE_URL: baseURL,
    LSE_SERVICE_ASSURANCE_E2E_USERNAME: username,
    LSE_SERVICE_ASSURANCE_E2E_PASSWORD: password,
    LSE_SERVICE_ASSURANCE_E2E_AFFECTED_URL: affectedURL,
    LSE_SERVICE_ASSURANCE_E2E_OPENAPI_URL: openapiURL,
    LSE_SERVICE_ASSURANCE_E2E_SBOM_PATH: sbomPath,
    LSE_SERVICE_ASSURANCE_E2E_EVIDENCE_DIR: evidenceDir,
  })) {
    expect(value, `${name} must be configured by the isolated E2E runner`).not.toBe('');
  }
}

async function login(page: Page): Promise<void> {
  await page.goto(`${baseURL}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await page.goto(`${baseURL}/service-assurance`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'AI 服务安全核验' })).toBeVisible();
}

async function waitForRunResult(
  page: Page,
  expectedText: string,
  expectedStatus: 'completed' | 'partial' = 'completed',
): Promise<void> {
  await expect
    .poll(
      async () => {
        const refresh = page.getByRole('button', { name: '刷新核验数据' });
        if (await refresh.isEnabled()) await refresh.click();
        await page.waitForTimeout(750);
        return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      },
      { timeout: 8 * 60_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toContain(expectedText);
  await expect(
    page
      .getByText(expectedStatus === 'completed' ? '核验已完成' : '核验未完成', { exact: true })
      .first(),
  ).toBeVisible();
}

async function assertCustomerSurface(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(forbiddenCustomerText);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

test('真实页面完成安全检查、授权深度核验和组件清单核验', async ({ page }) => {
  requireEnvironment();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);

  await page.getByRole('button', { name: '安全检查', exact: true }).click();
  await page.getByLabel('目标名称').fill('受控正样本服务 - 长名称用于验证客户结果布局稳定');
  await page.getByLabel('目标地址').fill(affectedURL);
  await page.getByRole('button', { name: '发起核验' }).click();
  await page
    .getByRole('button', { name: '受控正样本服务 - 长名称用于验证客户结果布局稳定' })
    .click();
  await waitForRunResult(page, '响应缺少类型嗅探防护');
  await expect(page.getByText('疑似组件、待核验线索', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '查看技术证据' }).click();
  await expect(page.getByRole('heading', { name: '技术证据', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '授权深度核验', exact: true }).click();
  await page.getByLabel('目标类型').selectOption({ label: 'OpenAPI 描述' });
  await page.getByLabel('目标名称').fill('授权深度核验正样本');
  await page.getByLabel('目标地址').fill(openapiURL);
  await page.getByText('我确认已取得该目标的深度核验授权').click();
  await page.getByRole('button', { name: '发起核验' }).click();
  await page.getByRole('button', { name: '授权深度核验正样本' }).click();
  await waitForRunResult(page, '未授权管理状态接口');

  await page.getByRole('button', { name: '组件清单核验', exact: true }).click();
  await page.getByLabel('目标名称').fill('受控组件清单正样本');
  await page.getByLabel('组件清单文件').setInputFiles(sbomPath);
  await page.getByRole('button', { name: '发起核验' }).click();
  await page.getByRole('button', { name: '受控组件清单正样本' }).click();
  await waitForRunResult(page, '版本受已知漏洞影响', 'partial');

  await assertCustomerSurface(page);
  await page.screenshot({
    path: path.join(evidenceDir, 'desktop.png'),
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('390x844 完整刷新后无横向溢出、遮挡或内部字段', async ({ page }) => {
  requireEnvironment();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByText('服务与核验结论')).toBeVisible();
  await assertCustomerSurface(page);
  await page.screenshot({
    path: path.join(evidenceDir, 'mobile-390x844.png'),
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
