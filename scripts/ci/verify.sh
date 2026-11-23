#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--dry-run' ) ]]; then
  echo 'usage: bash scripts/ci/verify.sh [--dry-run]' >&2
  exit 2
fi
# Validate before install or any command that can load repository environment files.
# Never echo a DSN, source .env, or permit the existing live-test bypass.
node <<'JS'
const { isIP } = require('node:net');
function loopback(host) {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '::1' || (isIP(name) === 4 && name.startsWith('127.'));
}
function reject() {
  console.error('[ci-safety] refusing unsafe test connection');
  process.exit(2);
}
try {
  const u = new URL(process.env.DATABASE_URL || '');
  if (
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    !loopback(u.hostname) ||
    u.pathname !== '/lse_test' ||
    decodeURIComponent(u.username) !== 'lse_test' ||
    u.search ||
    u.hash ||
    ['ALLOW_LIVE_TEST_DB', 'DIRECT_URL', 'SHADOW_DATABASE_URL'].some((key) => key in process.env)
  )
    reject();
  const redis = new URL(process.env.REDIS_URL || '');
  if (redis.protocol !== 'redis:' || !loopback(redis.hostname) || redis.search || redis.hash)
    reject();
} catch {
  reject();
}
JS
if [[ "${1:-}" == '--dry-run' ]]; then
  echo '[ci] dry-run: connection validation passed; no install, migration, seed or tests executed'
  exit 0
fi
export NODE_ENV=test LSE_TEST=1 LICENSE_ENFORCE=false LSE_BROWSER_RUNNER_TEST=1
step() { printf '[ci] %s\n' "$1"; shift; nice -n 19 "$@"; }
step install corepack pnpm install --frozen-lockfile
step generate corepack pnpm exec prisma generate
step migrate corepack pnpm exec prisma migrate deploy
step seed corepack pnpm exec prisma db seed
step typecheck corepack pnpm -r --workspace-concurrency=1 --if-present typecheck
step api corepack pnpm --filter @lse/api test
step web env NODE_OPTIONS=--no-experimental-webstorage corepack pnpm --dir apps/web exec vitest run --no-file-parallelism --maxWorkers=1
step worker corepack pnpm --dir apps/worker exec node --import tsx --test --test-concurrency=1 --test-force-exit 'test/**/*.test.ts'
step browser corepack pnpm --dir apps/browser-runner exec node --import tsx --test --test-concurrency=1 --test-force-exit 'test/**/*.test.ts'
step build corepack pnpm -r --workspace-concurrency=1 --if-present build
