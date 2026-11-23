#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "[fail] $*" >&2
  exit 1
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file: $1"
}

assert_contains() {
  local file="$1" value="$2"
  grep -Fq -- "$value" "$file" || fail "$file missing: $value"
}

assert_not_contains() {
  local file="$1" value="$2"
  ! grep -Fq -- "$value" "$file" || fail "$file unexpectedly contains: $value"
}

for command in docker jq rg; do
  command -v "$command" >/dev/null 2>&1 || fail "missing command: $command"
done
docker compose version >/dev/null 2>&1 || fail 'docker compose v2 is required'

for file in \
  docker-compose.yml \
  scripts/package-offline-bundle.sh \
  scripts/build-x86-offline-installer.sh \
  scripts/offline-diagnostics.sh \
  scripts/lib/offline-network-restart.sh \
  scripts/remote-x86-offline-acceptance.sh \
  scripts/verify-offline-degraded-rootfs.sh; do
  assert_file "$file"
done

for script in \
  scripts/package-offline-bundle.sh \
  scripts/build-x86-offline-installer.sh \
  scripts/offline-diagnostics.sh \
  scripts/lib/offline-network-restart.sh \
  scripts/remote-x86-offline-acceptance.sh \
  scripts/verify-offline-degraded-rootfs.sh; do
  bash -n "$script"
done

compose_json="$(mktemp)"
trap 'rm -f "$compose_json"' EXIT
docker compose --profile '*' -f docker-compose.yml config --format json >"$compose_json"

jq -e '
  .networks["service-assurance-control"].internal == true and
  (.services.api.networks // {} | has("service-assurance-control")) and
  (.services.worker.networks // {} | has("service-assurance-control")) and
  (.services.postgres.networks // {} | has("service-assurance-control") | not) and
  (.services.valkey.networks // {} | has("service-assurance-control") | not)
' "$compose_json" >/dev/null || fail 'API/worker control network is not isolated from data services'

for service in service-assurance-nuclei service-assurance-trivy service-assurance-zap; do
  jq -e --arg service "$service" '
    .services[$service] as $sidecar |
    $sidecar != null and
    $sidecar.read_only == true and
    ($sidecar.cap_drop | index("ALL")) != null and
    ($sidecar.security_opt | index("no-new-privileges:true")) != null and
    ($sidecar.user | type == "string" and . != "" and . != "0" and . != "0:0") and
    ($sidecar.pids_limit | type == "number" and . > 0 and . <= 256) and
    (($sidecar.mem_limit | tonumber) > 0) and
    ($sidecar.cpus | type == "number" and . > 0) and
    ($sidecar.tmpfs | length > 0) and
    ($sidecar.networks // {} | has("service-assurance-control")) and
    ($sidecar.networks // {} | has("service-assurance-egress")) and
    ($sidecar.networks // {} | has("default") | not) and
    ($sidecar.ports == null or ($sidecar.ports | length == 0)) and
    ($sidecar.environment.DATABASE_URL == null) and
    ($sidecar.environment.REDIS_URL == null) and
    ($sidecar.environment.JWT_SECRET == null) and
    ($sidecar.environment.NEWAPI_INTERNAL_API_SECRET == null) and
    ($sidecar.volumes // [] | map(.source // "") | all(
      contains("docker.sock") | not
    )) and
    ($sidecar.volumes // [] | map(.source // "") | all(
      endswith("/.env") | not
    ))
  ' "$compose_json" >/dev/null || fail "sidecar hardening contract failed: $service"
done

jq -e '
  (.services["service-assurance-nuclei"].profiles == null) and
  (.services["service-assurance-trivy"].profiles == null) and
  (.services["service-assurance-zap"].profiles | index("service-assurance-deep") != null) and
  (.services["service-assurance-nuclei"].pull_policy == "never") and
  (.services["service-assurance-trivy"].pull_policy == "never") and
  (.services["service-assurance-zap"].pull_policy == "never")
' "$compose_json" >/dev/null || fail 'SAFE/SBOM defaults or optional DEEP profile are incorrect'

for service in service-assurance-nuclei service-assurance-trivy service-assurance-zap; do
  image="$(jq -r --arg service "$service" '.services[$service].image' "$compose_json")"
  [[ "$image" == lse-service-assurance-*:* ]] || fail "unexpected image: $image"
  [[ "$image" != *latest* ]] || fail "mutable latest image is forbidden: $image"
done

assert_contains scripts/package-offline-bundle.sh 'service-assurance-nuclei'
assert_contains scripts/package-offline-bundle.sh 'service-assurance-trivy'
assert_contains scripts/package-offline-bundle.sh 'service-assurance-zap'
assert_contains scripts/package-offline-bundle.sh 'image-lock.json'
assert_contains scripts/package-offline-bundle.sh 'service-assurance/vulndb'
assert_contains scripts/package-offline-bundle.sh 'sign-service-assurance-artifacts.sh'
assert_contains scripts/package-offline-bundle.sh 'rollback.sh'
assert_contains scripts/package-offline-bundle.sh 'SERVICE_ASSURANCE_TRIVY_DB_CACHE_DIR'
assert_contains scripts/package-offline-bundle.sh 'SERVICE_ASSURANCE_SCOPE_POLICIES'
assert_not_contains scripts/package-offline-bundle.sh '"lse-app:latest"'
assert_not_contains scripts/package-offline-bundle.sh '"lse-web:latest"'

assert_contains scripts/package-offline-bundle.sh 'openssl_signing_usable'
assert_contains scripts/package-offline-bundle.sh 'refuse_degraded_when_full_required'
assert_contains scripts/package-offline-bundle.sh 'LSE_REQUIRE_FULL_VERIFICATION'
assert_contains scripts/package-offline-bundle.sh 'sha256-degraded'
assert_contains scripts/package-offline-bundle.sh 'full-signature'
assert_not_contains scripts/package-offline-bundle.sh 'openssl is required to verify manifest'
assert_not_contains scripts/package-offline-bundle.sh 'openssl is required to verify service assurance artifacts'
assert_contains scripts/build-x86-offline-installer.sh 'openssl_signing_usable'
assert_contains scripts/build-x86-offline-installer.sh 'check_runtime_dependencies'
assert_contains scripts/build-x86-offline-installer.sh '本次将以降级模式安装'
assert_contains scripts/verify-offline-degraded-rootfs.sh 'LSE_DEGRADED_ROOTFS_IMAGE'
assert_contains scripts/verify-offline-degraded-rootfs.sh 'ships an openssl binary'
assert_not_contains scripts/verify-offline-degraded-rootfs.sh 'docker pull'

assert_contains scripts/build-x86-offline-installer.sh '--rollback'
assert_contains scripts/build-x86-offline-installer.sh 'lsectl rollback'
assert_contains scripts/offline-diagnostics.sh 'service-assurance-nuclei'
assert_contains scripts/offline-diagnostics.sh 'service-assurance-trivy'
assert_contains scripts/offline-diagnostics.sh 'service-assurance-zap'
assert_contains scripts/offline-diagnostics.sh 'LSE_DIAGNOSTIC_SENTINEL'

assert_contains scripts/remote-x86-offline-acceptance.sh 'OLD_RUN_FILE'
assert_contains scripts/remote-x86-offline-acceptance.sh 'NEW_RUN_FILE'
assert_contains scripts/remote-x86-offline-acceptance.sh 'known_hosts'
assert_contains scripts/remote-x86-offline-acceptance.sh 'lsectl rollback'
assert_contains scripts/remote-x86-offline-acceptance.sh 'scripts/lib/offline-network-restart.sh'
assert_contains scripts/remote-x86-offline-acceptance.sh 'wait_for_ssh_down'
assert_contains scripts/remote-x86-offline-acceptance.sh 'wait_for_docker'
assert_contains scripts/remote-x86-offline-acceptance.sh 'wait_for_installed_services'
assert_contains scripts/remote-x86-offline-acceptance.sh 'installed LSE services did not become healthy after reboot'
assert_contains scripts/remote-x86-offline-acceptance.sh 'ps --status running --services'
assert_contains scripts/remote-x86-offline-acceptance.sh 'LSE_ACCEPT_RESUME_AFTER_N1'
assert_contains scripts/remote-x86-offline-acceptance.sh 'LSE_ACCEPT_REMOTE_DIR'
assert_contains scripts/remote-x86-offline-acceptance.sh '/var/tmp/lse-x86-acceptance-'
assert_contains scripts/remote-x86-offline-acceptance.sh 'bash "$OLD_NAME" </dev/null'
assert_contains scripts/remote-x86-offline-acceptance.sh 'bash "$NEW_NAME" </dev/null'
assert_contains scripts/remote-x86-offline-acceptance.sh 'bash ./diagnose.sh >/dev/null </dev/null'
assert_contains scripts/remote-x86-offline-acceptance.sh 'bash /usr/local/bin/lsectl rollback </dev/null'
assert_contains scripts/remote-x86-offline-acceptance.sh 'sudo env SSH_CONNECTION="$SSH_CONNECTION" bash -se'
assert_contains scripts/remote-x86-offline-acceptance.sh 'python3'
assert_not_contains scripts/remote-x86-offline-acceptance.sh 'jq '
assert_contains scripts/remote-x86-offline-acceptance.sh 'runtimeDigest'
assert_contains scripts/remote-x86-offline-acceptance.sh '{{json .Config}}|{{json .RootFS.Layers}}'
assert_contains scripts/lib/offline-network-restart.sh 'docker compose --profile service-assurance-deep --env-file .env restart'
assert_contains scripts/lib/offline-network-restart.sh 'service-assurance-nuclei'
assert_contains scripts/lib/offline-network-restart.sh 'service-assurance-trivy'
assert_contains scripts/lib/offline-network-restart.sh 'service-assurance-zap'
assert_contains scripts/lib/offline-network-restart.sh 'guest already has no default route'
assert_not_contains scripts/lib/offline-network-restart.sh 'guest has no default route to remove'
assert_not_contains scripts/remote-x86-offline-acceptance.sh 'StrictHostKeyChecking=no'
assert_not_contains scripts/remote-x86-offline-acceptance.sh '--arg password'
assert_not_contains scripts/remote-x86-offline-acceptance.sh '-H "Authorization: Bearer $token"'

assert_file docs/service-assurance-offline.md
assert_contains docs/service-assurance-offline.md '安全检查'
assert_contains docs/service-assurance-offline.md '组件清单核验'
assert_contains docs/service-assurance-offline.md '授权深度核验'
assert_contains docs/service-assurance-offline.md '回滚'
assert_contains docs/service-assurance-offline.md '不恢复旧数据库'

echo '[ok] service assurance offline delivery contract passed'
