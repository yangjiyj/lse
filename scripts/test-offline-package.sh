#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "[fail] $*" >&2
  exit 1
}

assert_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "expected file: $path"
}

assert_contains() {
  local path="$1"
  local pattern="$2"
  if ! grep -Fq -- "$pattern" "$path"; then
    echo "[debug] $path:" >&2
    sed -n '1,220p' "$path" >&2 || true
    fail "expected $path to contain: $pattern"
  fi
}

assert_not_contains() {
  local path="$1"
  local pattern="$2"
  if grep -Fq -- "$pattern" "$path"; then
    fail "did not expect $path to contain: $pattern"
  fi
}

# This focused contract check does not require release images or the reviewed Trivy DB cache.
assert_contains "scripts/package-offline-bundle.sh" '${REPORT_RENDERER:-html}'
assert_contains "scripts/package-offline-bundle.sh" '${REPORT_CHROMIUM_PATH:-/opt/lse-chromium/chrome}'
assert_contains "scripts/package-offline-bundle.sh" 'REPORT_RENDERER=html'
assert_contains "scripts/package-offline-bundle.sh" 'REPORT_CHROMIUM_PATH=/opt/lse-chromium/chrome'
assert_contains ".env.example" 'REPORT_RENDERER=html'
assert_contains ".env.example" 'REPORT_CHROMIUM_PATH=/opt/lse-chromium/chrome'
assert_contains "docker-compose.yml" '${REPORT_RENDERER:-html}'
assert_contains "docker-compose.yml" '${REPORT_CHROMIUM_PATH:-/opt/lse-chromium/chrome}'
if [[ "${1:-}" == "--report-defaults-only" ]]; then
  echo "[ok] report renderer defaults match the application image"
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
# Explicitly exercise audited fallbacks while retaining the production defaults.
export OFFLINE_ALLOW_DIRTY_TREE=1
export OFFLINE_ALLOW_MISSING_SBOM=1
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP_DIR/signing.key" >/dev/null 2>&1
export OFFLINE_MANIFEST_SIGNING_KEY_FILE="$TMP_DIR/signing.key"
export OFFLINE_ALLOW_UNSIGNED_MANIFEST=0

EXPORT_SCRIPT="scripts/package-offline-bundle.sh"
assert_file "$EXPORT_SCRIPT"
bash -n "$EXPORT_SCRIPT"
grep -A50 '^main()' "$EXPORT_SCRIPT" | grep -Fq '  write_image_sboms' || fail 'image SBOM hook is not invoked'
prisma_generate_line="$(
  grep -nF 'pnpm exec prisma generate --schema apps/api/prisma/schema.prisma' "$EXPORT_SCRIPT" |
    cut -d: -f1 || true
)"
typecheck_line="$(grep -nF 'pnpm typecheck' "$EXPORT_SCRIPT" | tail -1 | cut -d: -f1)"
[[ -n "$prisma_generate_line" ]] ||
  fail 'offline package build must generate Prisma Client in a clean worktree'
[[ -n "$typecheck_line" && "$prisma_generate_line" -lt "$typecheck_line" ]] ||
  fail 'offline package build must generate Prisma Client before typecheck'
assert_contains "$EXPORT_SCRIPT" 'OFFLINE_NUCLEI_BUILDER'
assert_contains "$EXPORT_SCRIPT" 'nuclei_builder_args'

CADDYFILE="apps/web/Caddyfile"
assert_file "$CADDYFILE"
assert_contains "$CADDYFILE" 'https://localhost,'
assert_contains "$CADDYFILE" 'https:// {'
assert_contains "$CADDYFILE" 'fallback_sni localhost'
assert_not_contains "$CADDYFILE" 'https://192.168.31.182'
assert_not_contains "$CADDYFILE" 'https://100.64.0.10'

bash "$EXPORT_SCRIPT" \
  --output "$TMP_DIR" \
  --stamp 20260624-test \
  --commit testcommit \
  --skip-build \
  --skip-image-save

BUNDLE_DIR="$TMP_DIR/llm-safety-eval-platform-offline-20260624-test-testcommit"
assert_file "$BUNDLE_DIR/docker-compose.yml"
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'MODEL_SCAN_ROOTS: ${MODEL_SCAN_ROOTS:-/models}'
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'MODEL_SCAN_HOST_DIR: ${MODEL_SCAN_HOST_DIR:-/opt/lse/models}'
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'MODEL_SCAN_UPLOAD_DIR: /var/lib/lse/model-scan-uploads'
assert_contains "$BUNDLE_DIR/docker-compose.yml" '${MODEL_SCAN_HOST_DIR:-/opt/lse/models}:/models:ro'
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'model_scan_uploads:/var/lib/lse/model-scan-uploads'
assert_contains "$BUNDLE_DIR/docker-compose.yml" '  model_scan_uploads:'

assert_file "$BUNDLE_DIR/install.sh"
assert_file "$BUNDLE_DIR/upgrade.sh"
assert_file "$BUNDLE_DIR/rollback.sh"
assert_file "$BUNDLE_DIR/backup-db.sh"
assert_file "$BUNDLE_DIR/uninstall.sh"
assert_file "$BUNDLE_DIR/status.sh"
assert_file "$BUNDLE_DIR/diagnose.sh"
assert_file "$BUNDLE_DIR/report-renderer-env.sh"
assert_file "$BUNDLE_DIR/README_OFFLINE.md"
assert_file "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md"
assert_file "$BUNDLE_DIR/MANIFEST.txt"
assert_file "$BUNDLE_DIR/manifest.json"
assert_file "$BUNDLE_DIR/manifest.sig"
assert_file "$BUNDLE_DIR/manifest.pub"
assert_file "$BUNDLE_DIR/image-lock.json"
assert_file "$BUNDLE_DIR/docs/service-assurance-offline.md"
assert_file "$BUNDLE_DIR/dependencies/docker-compose"
assert_file "$BUNDLE_DIR/dependencies/README.md"
assert_file "$BUNDLE_DIR/service-assurance/rules/manifest.json"
assert_file "$BUNDLE_DIR/service-assurance/vulndb/manifest.json"
assert_file "$BUNDLE_DIR/service-assurance/vulndb/db.tar.gz"
assert_file "$BUNDLE_DIR/service-assurance/vulndb/LICENSES.md"
assert_file "$BUNDLE_DIR/service-assurance/trust/manifest.pub"
assert_file "$BUNDLE_DIR/service-assurance/trust/rules/manifest.sig"
assert_file "$BUNDLE_DIR/service-assurance/trust/vulndb/manifest.sig"
if [[ -f "$BUNDLE_DIR/sbom.spdx.json" ]]; then
  assert_contains "$BUNDLE_DIR/sbom.spdx.json" '"spdxVersion"'
else
  assert_file "$BUNDLE_DIR/SBOM-MISSING.txt"
  assert_contains "$BUNDLE_DIR/SBOM-MISSING.txt" 'OFFLINE_ALLOW_MISSING_SBOM=1'
fi
openssl dgst -sha256 -verify "$BUNDLE_DIR/manifest.pub" -signature "$BUNDLE_DIR/manifest.sig" "$BUNDLE_DIR/manifest.json" >/dev/null
openssl dgst -sha256 \
  -verify "$BUNDLE_DIR/service-assurance/trust/manifest.pub" \
  -signature "$BUNDLE_DIR/service-assurance/trust/rules/manifest.sig" \
  "$BUNDLE_DIR/service-assurance/rules/manifest.json" >/dev/null
openssl dgst -sha256 \
  -verify "$BUNDLE_DIR/service-assurance/trust/manifest.pub" \
  -signature "$BUNDLE_DIR/service-assurance/trust/vulndb/manifest.sig" \
  "$BUNDLE_DIR/service-assurance/vulndb/manifest.json" >/dev/null
assert_file "$BUNDLE_DIR/checksums.sha256"
assert_file "$BUNDLE_DIR/images/checksums.sha256"

bash -n "$BUNDLE_DIR/install.sh"
bash -n "$BUNDLE_DIR/upgrade.sh"
bash -n "$BUNDLE_DIR/rollback.sh"
bash -n "$BUNDLE_DIR/backup-db.sh"
bash -n "$BUNDLE_DIR/uninstall.sh"
bash -n "$BUNDLE_DIR/status.sh"
bash -n "$BUNDLE_DIR/diagnose.sh"

# Fresh install must advance both public entry ports and persist the selected
# values. Upgrade behavior remains unchanged because install.sh preserves .env.
(
  port_case="$TMP_DIR/port-case"
  mkdir -p "$port_case/bin" "$port_case/install"
  awk '/^require_cmd docker$/ { exit } { print }' "$BUNDLE_DIR/install.sh" >"$port_case/install-lib.sh"
  # shellcheck disable=SC1090
  source "$port_case/install-lib.sh"
  cat >"$port_case/bin/ss" <<'EOF'
#!/bin/sh
printf '%s\n' \
  'LISTEN 0 128 0.0.0.0:8090 0.0.0.0:*' \
  'LISTEN 0 128 0.0.0.0:8091 0.0.0.0:*' \
  'LISTEN 0 128 0.0.0.0:10443 0.0.0.0:*'
EOF
  chmod 0755 "$port_case/bin/ss"
  export LSE_PORT_CHECK_BINDIR="$port_case/bin"
  cd "$port_case/install"
  write_env >/dev/null
  grep -Fqx 'WEB_HTTP_PORT=8092' .env || fail 'HTTP port did not advance past occupied ports'
  grep -Fqx 'WEB_HTTPS_PORT=10444' .env || fail 'HTTPS port did not advance past occupied port'
)
echo '[ok] fresh installer advances occupied public ports'

assert_contains "$BUNDLE_DIR/MANIFEST.txt" "package=llm-safety-eval-platform-offline-20260624-test-testcommit"
assert_contains "$BUNDLE_DIR/MANIFEST.txt" "commit=testcommit"
assert_contains "$BUNDLE_DIR/MANIFEST.txt" "upgrade_supported=true"
assert_contains "$BUNDLE_DIR/MANIFEST.txt" "rollback_supported=true"
assert_contains "$BUNDLE_DIR/MANIFEST.txt" "image_lock=image-lock.json"
assert_contains "$BUNDLE_DIR/MANIFEST.txt" "service_assurance_default=SAFE,SBOM"
assert_contains "$BUNDLE_DIR/MANIFEST.txt" "service_assurance_optional=DEEP"
assert_contains "$BUNDLE_DIR/MANIFEST.txt" "source_env_copied=false"
assert_contains "$BUNDLE_DIR/manifest.json" '"schema":"offline-manifest/v2"'
assert_contains "$BUNDLE_DIR/manifest.json" '"target_arch":"'
assert_contains "$BUNDLE_DIR/manifest.json" '"manifest_signature":"rsa-sha256"'
assert_contains "$BUNDLE_DIR/manifest.json" '"rollback_supported":true'
assert_contains "$BUNDLE_DIR/manifest.json" '"default_modes":["SAFE","SBOM"]'
assert_contains "$BUNDLE_DIR/manifest.json" '"optional_modes":["DEEP"]'
assert_contains "$BUNDLE_DIR/image-lock.json" '"status": "TEST_ONLY_SKIPPED"'

# Report exports must use the same browser as the tested application image.
assert_contains "$BUNDLE_DIR/docker-compose.yml" '${REPORT_RENDERER:-html}'
assert_contains "$BUNDLE_DIR/docker-compose.yml" '${REPORT_CHROMIUM_PATH:-/opt/lse-chromium/chrome}'
assert_contains "$BUNDLE_DIR/install.sh" 'REPORT_RENDERER=html'
assert_contains "$BUNDLE_DIR/install.sh" 'REPORT_CHROMIUM_PATH=/opt/lse-chromium/chrome'
assert_contains ".env.example" 'REPORT_RENDERER=html'
assert_contains ".env.example" 'REPORT_CHROMIUM_PATH=/opt/lse-chromium/chrome'

assert_contains "$BUNDLE_DIR/docker-compose.yml" 'image: lse-app:testcommit'
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'image: lse-web:testcommit'
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'image: postgres:17-alpine'
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'image: valkey/valkey:8-alpine'
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'image: lse-service-assurance-nuclei:testcommit'
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'image: lse-service-assurance-trivy:testcommit'
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'image: lse-service-assurance-zap:testcommit'
assert_not_contains "$BUNDLE_DIR/docker-compose.yml" 'latest'
assert_contains "$BUNDLE_DIR/docker-compose.yml" '${WEB_HTTP_PORT:-8090}:80'
assert_contains "$BUNDLE_DIR/docker-compose.yml" '${WEB_HTTPS_PORT:-10443}:443'
# 自签证书必须跨 web 容器重建保留，否则每次升级客户都要重新处理证书警告。
assert_contains "$BUNDLE_DIR/docker-compose.yml" 'caddy_data:/data'
assert_contains "$BUNDLE_DIR/docker-compose.yml" '  caddy_data:'
assert_not_contains "$BUNDLE_DIR/docker-compose.yml" 'build:'
assert_not_contains "$BUNDLE_DIR/docker-compose.yml" '${POSTGRES_PORT:-5432}:5432'
assert_not_contains "$BUNDLE_DIR/docker-compose.yml" '${VALKEY_PORT:-6379}:6379'
assert_not_contains "$BUNDLE_DIR/docker-compose.yml" '127.0.0.1:${POSTGRES_PORT'
assert_not_contains "$BUNDLE_DIR/docker-compose.yml" '127.0.0.1:${VALKEY_PORT'

assert_contains "$BUNDLE_DIR/install.sh" './upgrade.sh --fresh-install'
assert_contains "$BUNDLE_DIR/install.sh" 'Generated .env'
assert_contains "$BUNDLE_DIR/install.sh" 'allocate_port web_http_port'
assert_contains "$BUNDLE_DIR/install.sh" 'allocate_port web_https_port'
assert_contains "$BUNDLE_DIR/install.sh" 'install_compose_plugin'

assert_contains "$BUNDLE_DIR/backup-db.sh" 'pg_dump'
assert_contains "$BUNDLE_DIR/backup-db.sh" 'backups/lse-'

assert_contains "$BUNDLE_DIR/upgrade.sh" 'backup-db.sh'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'install_compose_plugin'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'snapshot_existing_deployment'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'current/docker-compose.yml'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'source_root'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'verify_image_lock'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'image_lock_rows'
assert_contains "$BUNDLE_DIR/upgrade.sh" '--network none'
assert_contains "$BUNDLE_DIR/upgrade.sh" '--read-only'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'JSON.parse'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'runtimeDigest'
assert_contains "$BUNDLE_DIR/upgrade.sh" '{{json .Config}}|{{json .RootFS.Layers}}'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'write_deployment_state'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'rollbackSnapshot: rollback || null'
assert_not_contains "$BUNDLE_DIR/upgrade.sh" 'jq is required to verify the offline image lock'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'verify_service_assurance_artifacts'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'docker load'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'service-assurance-nuclei service-assurance-trivy'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'docker compose --env-file .env run --rm migrate'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'docker compose --env-file .env up -d --force-recreate --no-deps api worker'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'docker compose --env-file .env up -d --force-recreate web'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'upgrade-logs'
assert_contains "$BUNDLE_DIR/upgrade.sh" '--install-dir'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'copy_payload_to_install_dir'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'Preserving existing .env'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'sbom-images'
assert_contains "$BUNDLE_DIR/upgrade.sh" '--preflight-only'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'verify_manifest_signature'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'verify_services'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'verify_report_renderer'
assert_contains "$BUNDLE_DIR/upgrade.sh" '/app/scripts/report-renderer-smoke.ts'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'migrate_report_renderer_env .env'
assert_contains "$BUNDLE_DIR/rollback.sh" 'restore_report_renderer_env .env'

assert_contains "$BUNDLE_DIR/upgrade.sh" 'docker compose --env-file .env ps --status running'
assert_contains "$BUNDLE_DIR/upgrade.sh" '/api/health'
assert_contains "$BUNDLE_DIR/upgrade.sh" '/login'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'health verification timed out'

assert_contains "$BUNDLE_DIR/rollback.sh" 'images-snapshot.tsv'
assert_contains "$BUNDLE_DIR/rollback.sh" 'backup-db.sh'
assert_contains "$BUNDLE_DIR/rollback.sh" 'databaseRestored":false'
assert_contains "$BUNDLE_DIR/rollback.sh" 'newSchemaPreserved":true'
assert_not_contains "$BUNDLE_DIR/rollback.sh" 'down -v'

PREFLIGHT_TARGET="$TMP_DIR/preflight-existing"
mkdir -p "$PREFLIGHT_TARGET"
printf 'POSTGRES_PASSWORD=old\nJWT_SECRET=old\nADMIN_PASSWORD=old\n' >"$PREFLIGHT_TARGET/.env"
printf 'customer-owned\n' >"$PREFLIGHT_TARGET/customer-owned.txt"
bash "$BUNDLE_DIR/upgrade.sh" --preflight-only --install-dir "$PREFLIGHT_TARGET"
assert_file "$PREFLIGHT_TARGET/.env"
assert_file "$PREFLIGHT_TARGET/customer-owned.txt"
[[ ! -e "$PREFLIGHT_TARGET/docker-compose.yml" ]] ||
  fail '--preflight-only copied package files into the existing installation'
[[ ! -e "$PREFLIGHT_TARGET/rollback-snapshots" ]] ||
  fail '--preflight-only created a rollback snapshot'

MISSING_FILE_TARGET="$TMP_DIR/missing-file-candidate"
cp -a "$BUNDLE_DIR" "$MISSING_FILE_TARGET"
printf 'POSTGRES_PASSWORD=old\nJWT_SECRET=old\nADMIN_PASSWORD=old\n' >"$MISSING_FILE_TARGET/.env"
rm "$MISSING_FILE_TARGET/docker-compose.yml"
if bash "$MISSING_FILE_TARGET/upgrade.sh" --preflight-only >"$TMP_DIR/missing-file.log" 2>&1; then
  fail 'preflight accepted a package with a checksummed file missing'
fi
assert_contains "$TMP_DIR/missing-file.log" 'sha256sum: ./docker-compose.yml: No such file or directory'

assert_contains "$BUNDLE_DIR/rollback.sh" 'rm -f image-lock.json MANIFEST.txt manifest.json manifest.sig manifest.pub deployment-state.json'

assert_contains "$BUNDLE_DIR/uninstall.sh" '--delete-data'
assert_contains "$BUNDLE_DIR/uninstall.sh" 'LSE_CONFIRM_DELETE_DATA=YES'
assert_contains "$BUNDLE_DIR/uninstall.sh" 'docker compose --env-file .env down -v'

assert_contains "$BUNDLE_DIR/status.sh" 'docker compose --env-file .env ps'
assert_contains "$BUNDLE_DIR/status.sh" '/api/health'

assert_contains "$BUNDLE_DIR/README_OFFLINE.md" './upgrade.sh'
assert_contains "$BUNDLE_DIR/README_OFFLINE.md" './rollback.sh'
assert_contains "$BUNDLE_DIR/README_OFFLINE.md" './backup-db.sh'
assert_contains "$BUNDLE_DIR/README_OFFLINE.md" './uninstall.sh --delete-data'
assert_contains "$BUNDLE_DIR/README_OFFLINE.md" './upgrade.sh --install-dir /path/to/current-install'
assert_contains "$BUNDLE_DIR/README_OFFLINE.md" 'docs/offline-upgrade-uninstall-manual.md'
assert_contains "$BUNDLE_DIR/README_OFFLINE.md" 'docs/service-assurance-offline.md'

assert_contains "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md" '旧版彻底卸载'
assert_contains "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md" '不要为了升级执行彻底卸载'
assert_contains "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md" './upgrade.sh --install-dir /path/to/current-install'
assert_contains "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md" 'docker compose --env-file .env down -v --remove-orphans'
assert_contains "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md" 'docker rm -f lse-web lse-api lse-worker lse-migrate lse-postgres lse-valkey'
assert_contains "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md" 'docker volume rm lse_pgdata lse_valkeydata'
assert_contains "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md" 'docker exec lse-postgres pg_dump'
assert_contains "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md" 'docker ps -a | grep lse || true'

# --- openssl 缺失降级与完整性闸门 -------------------------------------------
# 打包脚本必须把出厂自检钉在完整验签上。
assert_contains "$EXPORT_SCRIPT" 'LSE_REQUIRE_FULL_VERIFICATION=1'
assert_contains "$EXPORT_SCRIPT" 'openssl_signing_usable'
assert_contains "$EXPORT_SCRIPT" 'sha256-degraded'
# 交付的 upgrade.sh 里不允许再有"没有 openssl 就直接退出"的老逻辑。
assert_not_contains "$BUNDLE_DIR/upgrade.sh" 'openssl is required to verify manifest'
assert_not_contains "$BUNDLE_DIR/upgrade.sh" 'openssl is required to verify service assurance artifacts'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'openssl_signing_usable'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'refuse_degraded_when_full_required'
assert_contains "$BUNDLE_DIR/upgrade.sh" 'verificationMode'

# 一个不含 openssl 二进制的 PATH：镜像真实 PATH 上的所有命令，只去掉 openssl。
DEGRADE_BIN="$TMP_DIR/no-openssl-bin"
mkdir -p "$DEGRADE_BIN"
for dir in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
  if [[ -d "$dir" ]]; then
    for entry in "$dir"/*; do
      name="$(basename "$entry")"
      if [[ "$name" == openssl ]]; then
        continue
      fi
      if [[ -e "$DEGRADE_BIN/$name" ]]; then
        continue
      fi
      ln -s "$entry" "$DEGRADE_BIN/$name" 2>/dev/null || true
    done
  fi
done
[[ ! -e "$DEGRADE_BIN/openssl" ]] || fail 'degraded PATH fixture still exposes openssl'
if env -i PATH="$DEGRADE_BIN" bash -c 'command -v openssl' >/dev/null 2>&1; then
  fail 'degraded PATH fixture still resolves openssl'
fi

degraded_upgrade() {
  env -i PATH="$DEGRADE_BIN" HOME="$TMP_DIR" "$@"
}

make_verification_fixture() {
  local target="$1"
  rm -rf "$target"
  cp -a "$BUNDLE_DIR" "$target"
  printf 'POSTGRES_PASSWORD=old\nJWT_SECRET=old\nADMIN_PASSWORD=old\n' >"$target/.env"
}

# a) 客户机没有 openssl：必须继续安装，并打印中文降级提示。
CASE_NO_OPENSSL="$TMP_DIR/case-no-openssl"
make_verification_fixture "$CASE_NO_OPENSSL"
if ! degraded_upgrade bash "$CASE_NO_OPENSSL/upgrade.sh" --preflight-only \
  >"$TMP_DIR/case-no-openssl.log" 2>&1; then
  cat "$TMP_DIR/case-no-openssl.log" >&2
  fail 'upgrade preflight refused to continue on a host without openssl'
fi
assert_contains "$TMP_DIR/case-no-openssl.log" '本机没有可用的 openssl 命令行工具'
assert_contains "$TMP_DIR/case-no-openssl.log" '降级为 SHA-256 完整性校验'
assert_contains "$TMP_DIR/case-no-openssl.log" '已跳过安全检查规则与漏洞库清单的签名校验'
assert_contains "$TMP_DIR/case-no-openssl.log" '[step] verifying package checksums'
assert_contains "$TMP_DIR/case-no-openssl.log" 'verification mode: sha256-degraded'
assert_not_contains "$TMP_DIR/case-no-openssl.log" 'openssl is required'
echo '--- 用例 a：客户机缺 openssl，升级预检实际输出 ---'
cat "$TMP_DIR/case-no-openssl.log"

# b) openssl 可用且签名正确：必须走完整验签。
CASE_SIGNED="$TMP_DIR/case-full-signature"
make_verification_fixture "$CASE_SIGNED"
if ! bash "$CASE_SIGNED/upgrade.sh" --preflight-only >"$TMP_DIR/case-full-signature.log" 2>&1; then
  cat "$TMP_DIR/case-full-signature.log" >&2
  fail 'upgrade preflight failed on a correctly signed package'
fi
assert_contains "$TMP_DIR/case-full-signature.log" '[ok] manifest signature verified'
assert_contains "$TMP_DIR/case-full-signature.log" 'verification mode: full-signature'
echo '--- 用例 b：openssl 可用且签名正确，实际输出 ---'
cat "$TMP_DIR/case-full-signature.log"

# c) openssl 可用但 manifest 被篡改：必须拒绝。
CASE_TAMPERED="$TMP_DIR/case-tampered-manifest"
make_verification_fixture "$CASE_TAMPERED"
sed -i 's/"rollback_supported":true/"rollback_supported":false/' "$CASE_TAMPERED/manifest.json"
grep -Fq '"rollback_supported":false' "$CASE_TAMPERED/manifest.json" ||
  fail 'manifest tamper fixture did not change the manifest'
if bash "$CASE_TAMPERED/upgrade.sh" --preflight-only >"$TMP_DIR/case-tampered.log" 2>&1; then
  fail 'upgrade preflight accepted a tampered manifest'
fi
assert_contains "$TMP_DIR/case-tampered.log" 'manifest 数字签名校验不通过'
echo '--- 用例 c：manifest 被篡改（openssl 可用），实际输出 ---'
cat "$TMP_DIR/case-tampered.log"

# c2) 同一个被篡改的包，在没有 openssl 的机器上也必须被拒绝：完整性闸门不放松。
if degraded_upgrade bash "$CASE_TAMPERED/upgrade.sh" --preflight-only \
  >"$TMP_DIR/case-tampered-degraded.log" 2>&1; then
  fail 'degraded verification accepted a tampered manifest'
fi
assert_contains "$TMP_DIR/case-tampered-degraded.log" 'computed checksum did NOT match'
echo '--- 用例 c2：manifest 被篡改且无 openssl，实际输出 ---'
cat "$TMP_DIR/case-tampered-degraded.log"

# d) 载荷改一个字节：签名与降级两条路径都必须拒绝。
CASE_BYTE="$TMP_DIR/case-payload-byte"
make_verification_fixture "$CASE_BYTE"
printf 'x' >>"$CASE_BYTE/docker-compose.yml"
if bash "$CASE_BYTE/upgrade.sh" --preflight-only >"$TMP_DIR/case-payload-byte.log" 2>&1; then
  fail 'upgrade preflight accepted a package payload with a modified byte'
fi
assert_contains "$TMP_DIR/case-payload-byte.log" 'computed checksum did NOT match'
if degraded_upgrade bash "$CASE_BYTE/upgrade.sh" --preflight-only \
  >"$TMP_DIR/case-payload-byte-degraded.log" 2>&1; then
  fail 'degraded verification accepted a package payload with a modified byte'
fi
assert_contains "$TMP_DIR/case-payload-byte-degraded.log" 'computed checksum did NOT match'
echo '--- 用例 d：包内文件改一个字节，签名路径与降级路径实际输出 ---'
cat "$TMP_DIR/case-payload-byte.log"
cat "$TMP_DIR/case-payload-byte-degraded.log"

# e) LSE_REQUIRE_FULL_VERIFICATION=1 且 openssl 缺失：必须失败，不许报告成功。
CASE_REQUIRE_FULL="$TMP_DIR/case-require-full"
make_verification_fixture "$CASE_REQUIRE_FULL"
if env -i PATH="$DEGRADE_BIN" HOME="$TMP_DIR" LSE_REQUIRE_FULL_VERIFICATION=1 \
  bash "$CASE_REQUIRE_FULL/upgrade.sh" --preflight-only \
  >"$TMP_DIR/case-require-full.log" 2>&1; then
  fail 'LSE_REQUIRE_FULL_VERIFICATION=1 accepted a degraded verification'
fi
assert_contains "$TMP_DIR/case-require-full.log" '已要求完整验签'
assert_contains "$TMP_DIR/case-require-full.log" 'sha256-degraded'
assert_not_contains "$TMP_DIR/case-require-full.log" 'preflight-only validation passed'
echo '--- 用例 e：LSE_REQUIRE_FULL_VERIFICATION=1 且无 openssl，实际输出 ---'
cat "$TMP_DIR/case-require-full.log"

echo '[ok] openssl degradation and integrity gates behave as specified'

echo "[ok] offline package scripts generated with upgrade support"
