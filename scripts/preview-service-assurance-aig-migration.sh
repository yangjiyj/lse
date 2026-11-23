#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "${script_dir}/.." && pwd -P)"

cd "$repo_root"
exec pnpm exec tsx apps/api/scripts/service-assurance-migrate-aig.ts \
  --preview \
  --source-root "$repo_root"
