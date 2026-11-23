#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PNPM_BIN="${PNPM_BIN:-}"
if [[ -z "$PNPM_BIN" ]]; then
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_BIN="$(command -v pnpm)"
  elif [[ -x /usr/share/nodejs/corepack/shims/pnpm ]]; then
    PNPM_BIN="/usr/share/nodejs/corepack/shims/pnpm"
  else
    echo "pnpm not found" >&2
    exit 1
  fi
fi

can_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

run_gitleaks() {
  echo "== gitleaks: secret scan =="
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks detect --no-banner --redact
    return
  fi
  if can_docker; then
    docker run --rm -v "$PWD:/repo:ro" -w /repo zricethezav/gitleaks:latest detect --no-banner --redact --source /repo
    return
  fi
  echo "gitleaks not found and Docker is unavailable" >&2
  exit 1
}

run_semgrep() {
  echo "== semgrep: code security rules =="
  local paths=(apps/api/src/modules/generator apps/web/src/pages/GeneratePage.tsx)
  if command -v semgrep >/dev/null 2>&1; then
    semgrep --config p/owasp-top-ten --config p/typescript --error "${paths[@]}"
    return
  fi
  if can_docker; then
    docker run --rm -v "$PWD:/src:ro" -w /src semgrep/semgrep:latest \
      --config p/owasp-top-ten --config p/typescript --error "${paths[@]}"
    return
  fi
  echo "semgrep not found and Docker is unavailable" >&2
  exit 1
}

run_audit() {
  echo "== pnpm audit: high and critical dependencies =="
  "$PNPM_BIN" audit --audit-level high --registry=https://registry.npmjs.org/
}

run_gitleaks
run_semgrep
run_audit

echo "security checks passed"
