const SAFE_TEST_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'test-postgres',
  'lse-test-postgres',
]);

function isSafeTestHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return SAFE_TEST_HOSTS.has(host) || host.endsWith('.test');
}

function isTestDatabaseName(pathname: string): boolean {
  const database = decodeURIComponent(pathname.replace(/^\/+/, '')).toLowerCase();
  return /(^|[_-])test([_-]|$)/.test(database);
}

export function assertSafeTestDatabaseUrl(
  databaseUrl: string,
  env: { ALLOW_LIVE_TEST_DB?: string } = process.env,
): void {
  if (env.ALLOW_LIVE_TEST_DB === '1') return;

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      '[test-safety] refusing live database: DATABASE_URL is not a valid PostgreSQL URL',
    );
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('[test-safety] refusing live database: DATABASE_URL must use a PostgreSQL URL');
  }

  if (!isSafeTestHost(parsed.hostname) || !isTestDatabaseName(parsed.pathname)) {
    throw new Error(
      '[test-safety] refusing live database: set ALLOW_LIVE_TEST_DB=1 only for an intentional isolated rehearsal',
    );
  }
}

/**
 * 测试入口（test/test-db-safety-preload.ts）的前置检查：必须显式设置 LSE_TEST=1。
 *
 * 为什么需要：src/env.ts 只有在 LSE_TEST=1 时才校验 DATABASE_URL 的主机和库名。
 * 多个 git worktree 通过软链共用同一份 node_modules，Prisma 会沿软链读到主检出目录的 .env。
 * 直接 `node --import … --test <文件>` 跑单文件时漏设 LSE_TEST=1，闸门整个被跳过，测试会静默连到 .env 里的库
 * （实测：不设 LSE_TEST 时连的是共享 .env 里的 127.0.0.1:55433）。
 * 把“没设 LSE_TEST=1”从“不检查”改成“直接拒绝”，是这个入口唯一需要多做的事；设了之后仍由 assertSafeTestDatabaseUrl 校验地址。
 */
export function assertTestEntryEnvironment(env: { LSE_TEST?: string } = process.env): void {
  if (env.LSE_TEST !== '1') {
    throw new Error(
      '[test-safety] LSE_TEST=1 is required to run database tests: without it the safety gate is skipped and a shared .env may point the tests at a real database',
    );
  }
}
