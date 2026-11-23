#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_DIR="${OUTPUT_DIR:-$HOME/releases}"
STAMP="$(date +%Y%m%d-%H%M%S)"
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
PRODUCT_VERSION="${OFFLINE_RELEASE_VERSION:-1.0.8}"
SOURCE_COMMIT="$(git rev-parse HEAD)"
SKIP_BUILD=0
SKIP_IMAGE_SAVE=0

OFFLINE_REQUIRE_CLEAN_TREE="${OFFLINE_REQUIRE_CLEAN_TREE:-1}"
OFFLINE_ALLOW_DIRTY_TREE="${OFFLINE_ALLOW_DIRTY_TREE:-0}"
# OFFLINE_ALLOW_UNSIGNED_MANIFEST 只针对"交付包自身没有签名"这一种情况（受控的测试制品）。
# 客户机"没有 openssl 二进制"由 upgrade.sh 的能力探测自动降级处理，不需要也不应该再设置这个变量。
# 两者语义不重叠：前者放宽对交付物的要求，后者只放宽对客户机环境的要求；
# 完整性闸门（载荷 SHA-256、包内 checksums.sha256）在两种情况下都不放松。
OFFLINE_ALLOW_UNSIGNED_MANIFEST="${OFFLINE_ALLOW_UNSIGNED_MANIFEST:-0}"
OFFLINE_ALLOW_MISSING_SBOM="${OFFLINE_ALLOW_MISSING_SBOM:-0}"
OFFLINE_SKIP_N1_GATE="${OFFLINE_SKIP_N1_GATE:-0}"
TARGET_ARCH="${OFFLINE_TARGET_ARCH:-$(uname -m)}"
SIGNING_KEY_FILE="${OFFLINE_MANIFEST_SIGNING_KEY_FILE:-}"
NUCLEI_BUILDER="${OFFLINE_NUCLEI_BUILDER:-}"
MANIFEST_SIGNATURE_STATUS="unsigned"
COMPOSE_PLUGIN_FILE="${OFFLINE_DOCKER_COMPOSE_PLUGIN_FILE:-}"
COMPOSE_PLUGIN_RELATIVE_PATH="dependencies/docker-compose"
POSTGRES_IMAGE="postgres:17-alpine"
VALKEY_IMAGE="valkey/valkey:8-alpine"
POSTGRES_REPO_DIGEST="sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
VALKEY_REPO_DIGEST="sha256:a038175878d66b9d274fbf8be73c0305e93798b83917647f167e18cef3c71eec"
TRIVY_DB_SOURCE_DIGEST="sha256:9d3b66601a0d6dc18dc7f5ab59257fcc9b1f7f73f64e632f303a0594967a4d3a"
TRIVY_DB_LAYER_DIGEST="sha256:96b6b47116c081fdf033f809b93b43686894b708acc5f9f177f2f6986e48d1fb"
TRIVY_DB_CACHE_DIR="${SERVICE_ASSURANCE_TRIVY_DB_CACHE_DIR:-$HOME/.cache/lse-service-assurance/trivy-db/sha256-${TRIVY_DB_SOURCE_DIGEST#sha256:}}"
usage() {
  cat <<'USAGE'
Usage: bash scripts/package-offline-bundle.sh [options]

Options:
  --output DIR       Directory for the generated bundle and archive.
  --stamp STAMP      Override build stamp, useful for tests.
  --commit COMMIT    Override commit id, useful for tests.
  --skip-build       Do not run typecheck/test/docker compose build.
  --skip-image-save  Do not docker save images, useful for tests.
  -h, --help         Show this help.
USAGE
}

while (($#)); do
  case "$1" in
    --output)
      shift
      OUTPUT_DIR="${1:?missing --output value}"
      ;;
    --stamp)
      shift
      STAMP="${1:?missing --stamp value}"
      ;;
    --commit)
      shift
      COMMIT="${1:?missing --commit value}"
      ;;
    --skip-build)
      SKIP_BUILD=1
      ;;
    --skip-image-save)
      SKIP_IMAGE_SAVE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[error] unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift || true
done

IMAGE_TAG="${OFFLINE_IMAGE_TAG:-$COMMIT}"
[[ "$IMAGE_TAG" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "[error] unsafe offline image tag: $IMAGE_TAG" >&2
  exit 1
}
APP_IMAGE="lse-app:$IMAGE_TAG"
WEB_IMAGE="lse-web:$IMAGE_TAG"
NUCLEI_IMAGE="lse-service-assurance-nuclei:$IMAGE_TAG"
TRIVY_IMAGE="lse-service-assurance-trivy:$IMAGE_TAG"
ZAP_IMAGE="lse-service-assurance-zap:$IMAGE_TAG"

BUNDLE_NAME="llm-safety-eval-platform-offline-${STAMP}-${COMMIT}"
BUNDLE_DIR="${OUTPUT_DIR%/}/$BUNDLE_NAME"
ARCHIVE_FILE="${OUTPUT_DIR%/}/${BUNDLE_NAME}.tar.gz"
CHECKSUM_FILE="${ARCHIVE_FILE}.sha256"
IMAGE_ARCHIVE="images/lse-core-images.tar.gz"
REQUIRED_IMAGES=(
  "$APP_IMAGE"
  "$WEB_IMAGE"
  "$POSTGRES_IMAGE"
  "$VALKEY_IMAGE"
  "$NUCLEI_IMAGE"
  "$TRIVY_IMAGE"
  "$ZAP_IMAGE"
)

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[error] missing required command: $1" >&2
    exit 1
  }
}

resolve_compose_plugin() {
  local candidate
  if [[ -n "$COMPOSE_PLUGIN_FILE" ]]; then
    [[ -f "$COMPOSE_PLUGIN_FILE" && -x "$COMPOSE_PLUGIN_FILE" ]] || {
      echo "[error] Docker Compose plugin is not an executable file: $COMPOSE_PLUGIN_FILE" >&2
      exit 1
    }
    return
  fi

  for candidate in \
    /usr/libexec/docker/cli-plugins/docker-compose \
    /usr/local/lib/docker/cli-plugins/docker-compose \
    /usr/lib/docker/cli-plugins/docker-compose \
    "$HOME/.docker/cli-plugins/docker-compose"; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then
      COMPOSE_PLUGIN_FILE="$candidate"
      return
    fi
  done

  echo '[error] Docker Compose v2 plugin was not found; set OFFLINE_DOCKER_COMPOSE_PLUGIN_FILE to an executable plugin' >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  echo "[error] missing checksum command: sha256sum or shasum" >&2
  exit 1
}
normalize_arch() {
  case "$1" in
    x86_64|amd64) printf 'amd64' ;;
    aarch64|arm64) printf 'arm64' ;;
    armv7l|armv7) printf 'armv7' ;;
    *) printf '%s' "$1" ;;
  esac
}

check_release_inputs() {
  local host_arch target_arch status
  host_arch="$(normalize_arch "$(uname -m)")"
  target_arch="$(normalize_arch "$TARGET_ARCH")"
  case "$target_arch" in amd64|arm64|armv7) ;; *)
    echo "[error] unsupported offline target architecture: $TARGET_ARCH" >&2
    exit 1
  esac
  if [[ "$host_arch" != "$target_arch" && "${OFFLINE_ALLOW_CROSS_ARCH:-0}" != "1" ]]; then
    echo "[error] packaging host architecture ($host_arch) != target ($target_arch); set OFFLINE_ALLOW_CROSS_ARCH=1 only for a verified multi-arch build" >&2
    exit 1
  fi
  TARGET_ARCH="$target_arch"
  export TARGET_ARCH
  if [[ -n "$NUCLEI_BUILDER" && ! "$NUCLEI_BUILDER" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "[error] unsafe Nuclei buildx builder name" >&2
    exit 1
  fi
  status="$(git status --porcelain --untracked-files=all 2>/dev/null || true)"
  if [[ -n "$status" ]]; then
    if [[ "$OFFLINE_REQUIRE_CLEAN_TREE" == "1" && "$OFFLINE_ALLOW_DIRTY_TREE" != "1" ]]; then
      echo "[error] refusing offline package from a dirty tree (set OFFLINE_ALLOW_DIRTY_TREE=1 for an audited exception):" >&2
      printf '%s\n' "$status" >&2
      exit 1
    fi
    echo "[warn] dirty-tree exception enabled; release provenance is not reproducible" >&2
    DIRTY_TREE_STATUS="$status"
  fi
}

sign_manifest() {
  local manifest="$BUNDLE_DIR/manifest.json"
  require_cmd openssl
  if [[ -n "$SIGNING_KEY_FILE" ]]; then
    [[ -f "$SIGNING_KEY_FILE" ]] || { echo "[error] signing key not found: $SIGNING_KEY_FILE" >&2; exit 1; }
    openssl pkey -in "$SIGNING_KEY_FILE" -pubout -out "$BUNDLE_DIR/manifest.pub" >/dev/null 2>&1
    openssl dgst -sha256 -sign "$SIGNING_KEY_FILE" -out "$BUNDLE_DIR/manifest.sig" "$manifest"
    MANIFEST_SIGNATURE_STATUS="rsa-sha256"
    echo "[ok] detached manifest signature created (private key not included)"
  elif [[ "$OFFLINE_ALLOW_UNSIGNED_MANIFEST" == "1" ]]; then
    printf 'UNSIGNED\n' >"$BUNDLE_DIR/manifest.sig"
    printf 'UNSIGNED\n' >"$BUNDLE_DIR/manifest.pub"
    echo "[warn] unsigned manifest exception enabled; set OFFLINE_MANIFEST_SIGNING_KEY_FILE for production delivery" >&2
  else
    echo "[error] OFFLINE_MANIFEST_SIGNING_KEY_FILE is required; set OFFLINE_ALLOW_UNSIGNED_MANIFEST=1 only for an audited test artifact" >&2
    exit 1
  fi
}

write_sbom() {
  if command -v syft >/dev/null 2>&1; then
    echo "[step] generating SPDX SBOM"
    syft "dir:$BUNDLE_DIR" -o spdx-json >"$BUNDLE_DIR/sbom.spdx.json"
    return
  fi
  if [[ "$OFFLINE_ALLOW_MISSING_SBOM" == "1" ]]; then
    cat >"$BUNDLE_DIR/SBOM-MISSING.txt" <<EOF
SBOM unavailable: syft was not found on the packaging host.
This artifact is a controlled downgrade and MUST NOT be shipped as a production release.
Set OFFLINE_ALLOW_MISSING_SBOM=0 and install syft before delivery. The current exception was enabled with OFFLINE_ALLOW_MISSING_SBOM=1.
EOF
    echo "[warn] syft missing; wrote SBOM-MISSING.txt audited downgrade" >&2
    return
  fi
  echo "[error] syft is required to generate an SBOM (set OFFLINE_ALLOW_MISSING_SBOM=1 only for a non-production test)" >&2
  exit 1
}

write_image_sboms() {
  [[ "$SKIP_IMAGE_SAVE" -eq 1 ]] && return
  command -v syft >/dev/null 2>&1 || return

  local image safe_name output
  mkdir -p "$BUNDLE_DIR/sbom-images"
  for image in "${REQUIRED_IMAGES[@]}"; do
    safe_name="$(printf '%s' "$image" | sed 's#[/:@]#_#g')"
    output="$BUNDLE_DIR/sbom-images/${safe_name}.spdx.json"
    echo "[step] generating image SPDX SBOM: $image"
    syft "docker:$image" -o spdx-json >"$output"
  done
}

run_n_minus_one_gate() {
  [[ "$OFFLINE_SKIP_N1_GATE" == "1" ]] && { echo "[warn] N-1 upgrade gate skipped by explicit override" >&2; return; }
  local fixture old_env
  local -a gate_env=()
  grep -Fq -- '--preflight-only' "$BUNDLE_DIR/upgrade.sh" || { echo '[error] upgrade script lacks preflight-only N-1 gate' >&2; exit 1; }
  grep -Fq -- 'verify_manifest_signature' "$BUNDLE_DIR/upgrade.sh" || { echo '[error] upgrade script lacks manifest verification' >&2; exit 1; }
  fixture="$(mktemp -d)"
  mkdir -p "$fixture/old-install"
  old_env='POSTGRES_PASSWORD=old\nJWT_SECRET=old\nADMIN_PASSWORD=old\n'
  printf '%b' "$old_env" >"$fixture/old-install/.env"
  # 出厂自检：交付包已签名时强制走完整验签路径。
  # LSE_REQUIRE_FULL_VERIFICATION=1 让构建机 openssl 异常时直接失败，
  # 而不是悄悄降级、产出一个"只做过 SHA-256 自检"的包。
  if [[ "$MANIFEST_SIGNATURE_STATUS" == "rsa-sha256" ]]; then
    gate_env=(LSE_REQUIRE_FULL_VERIFICATION=1)
  else
    gate_env=(OFFLINE_ALLOW_UNSIGNED_MANIFEST=1)
  fi
  if ! env "${gate_env[@]}" bash "$BUNDLE_DIR/upgrade.sh" --preflight-only --install-dir "$fixture/old-install" >"$fixture/gate.log" 2>&1; then
    echo '[error] N-1 preflight/upgrade simulation failed' >&2
    sed -n '1,80p' "$fixture/gate.log" >&2 || true
    rm -rf "$fixture"
    exit 1
  fi
  if [[ "$MANIFEST_SIGNATURE_STATUS" == "rsa-sha256" ]]; then
    grep -Fq -- '[ok] manifest signature verified' "$fixture/gate.log" || {
      echo '[error] factory self-check did not complete full manifest signature verification' >&2
      sed -n '1,80p' "$fixture/gate.log" >&2 || true
      rm -rf "$fixture"
      exit 1
    }
    grep -Fq -- 'verification mode: full-signature' "$fixture/gate.log" || {
      echo '[error] factory self-check did not report full-signature verification mode' >&2
      sed -n '1,80p' "$fixture/gate.log" >&2 || true
      rm -rf "$fixture"
      exit 1
    }
  fi
  grep -Fq 'POSTGRES_PASSWORD=old' "$fixture/old-install/.env" || { echo '[error] N-1 simulation overwrote existing .env' >&2; rm -rf "$fixture"; exit 1; }
  rm -rf "$fixture"
  echo '[ok] N-1 upgrade preflight/rollback anchor gate passed'
}

run_build_checks() {
  local -a nuclei_builder_args=()
  if [[ "$SKIP_BUILD" -eq 1 ]]; then
    echo "[skip] build checks"
    return
  fi

  if [[ -d /usr/share/nodejs/corepack/shims ]]; then
    export PATH="/usr/share/nodejs/corepack/shims:$PATH"
  fi

  require_cmd pnpm
  require_cmd docker
  echo "[step] prisma generate"
  pnpm exec prisma generate --schema apps/api/prisma/schema.prisma
  echo "[step] pnpm typecheck"
  pnpm typecheck
  echo "[step] pnpm test"
  pnpm test
  if [[ -n "$NUCLEI_BUILDER" ]]; then
    nuclei_builder_args=(--builder "$NUCLEI_BUILDER")
    echo "[step] docker compose build Nuclei with builder: $NUCLEI_BUILDER"
  else
    echo "[step] docker compose build Nuclei"
  fi
  SERVICE_ASSURANCE_NUCLEI_IMAGE="$NUCLEI_IMAGE" \
    docker compose build "${nuclei_builder_args[@]}" service-assurance-nuclei
  echo "[step] docker compose build application and remaining service assurance images"
  LSE_APP_IMAGE="$APP_IMAGE" \
    LSE_WEB_IMAGE="$WEB_IMAGE" \
    SERVICE_ASSURANCE_TRIVY_IMAGE="$TRIVY_IMAGE" \
    SERVICE_ASSURANCE_ZAP_IMAGE="$ZAP_IMAGE" \
    docker compose build migrate web \
      service-assurance-trivy service-assurance-zap
}

check_required_images() {
  if [[ "$SKIP_IMAGE_SAVE" -eq 1 ]]; then
    echo "[skip] image availability check"
    return
  fi

  require_cmd docker
  local image
  for image in "${REQUIRED_IMAGES[@]}"; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      echo "[error] required image not found: $image" >&2
      echo "[hint] run docker compose build migrate web and make sure postgres/valkey images are present" >&2
      exit 1
    fi
  done
  docker image inspect "$POSTGRES_IMAGE" --format '{{join .RepoDigests "\n"}}' |
    grep -Fq -- "@$POSTGRES_REPO_DIGEST" || {
      echo "[error] PostgreSQL image digest does not match the reviewed baseline" >&2
      exit 1
    }
  docker image inspect "$VALKEY_IMAGE" --format '{{join .RepoDigests "\n"}}' |
    grep -Fq -- "@$VALKEY_REPO_DIGEST" || {
      echo "[error] Valkey image digest does not match the reviewed baseline" >&2
      exit 1
    }
}

prepare_bundle_dir() {
  rm -rf "$BUNDLE_DIR"
  mkdir -p "$BUNDLE_DIR/images" "$BUNDLE_DIR/docs" "$BUNDLE_DIR/dependencies"
}

copy_compose_plugin() {
  resolve_compose_plugin
  install -m 0755 "$COMPOSE_PLUGIN_FILE" "$BUNDLE_DIR/$COMPOSE_PLUGIN_RELATIVE_PATH"
  cat >"$BUNDLE_DIR/dependencies/README.md" <<EOF
# Bundled Docker Compose dependency

The offline installer installs this Docker Compose v2 CLI plugin when the target
Docker CLI does not already provide `docker compose`.

- source path on packaging host: $COMPOSE_PLUGIN_FILE
- sha256: $(sha256_file "$COMPOSE_PLUGIN_FILE")
EOF
}

copy_service_assurance_artifacts() {
  require_cmd jq
  require_cmd openssl
  [[ -n "$SIGNING_KEY_FILE" && -f "$SIGNING_KEY_FILE" ]] || {
    echo '[error] signed service assurance artifacts require OFFLINE_MANIFEST_SIGNING_KEY_FILE' >&2
    exit 1
  }

  local db_archive="$TRIVY_DB_CACHE_DIR/db.tar.gz"
  local db_file="$TRIVY_DB_CACHE_DIR/trivy.db"
  local metadata_file="$TRIVY_DB_CACHE_DIR/metadata.json"
  for file in "$db_archive" "$db_file" "$metadata_file"; do
    [[ -f "$file" && ! -L "$file" ]] || {
      echo "[error] reviewed Trivy DB cache file is unavailable: $file" >&2
      exit 1
    }
  done
  [[ "sha256:$(sha256_file "$db_archive")" == "$TRIVY_DB_LAYER_DIGEST" ]] || {
    echo '[error] Trivy DB archive digest mismatch' >&2
    exit 1
  }
  [[ "$(sha256_file "$db_file")" == '389181324022b0b85f32a62ead5a6a291ae3f8fa674906d9fdfbe6c22d4a127f' ]] || {
    echo '[error] Trivy DB content digest mismatch' >&2
    exit 1
  }
  [[ "$(sha256_file "$metadata_file")" == 'a01306e93daa6e2ed559cbf5a0c591ba82c4e86122991a31e4680d269bb56ed3' ]] || {
    echo '[error] Trivy DB metadata digest mismatch' >&2
    exit 1
  }

  install -d -m 0755 \
    "$BUNDLE_DIR/service-assurance/rules" \
    "$BUNDLE_DIR/service-assurance/vulndb"
  cp -a service-assurance/rules/. "$BUNDLE_DIR/service-assurance/rules/"
  install -m 0644 service-assurance/vulndb/manifest.json \
    "$BUNDLE_DIR/service-assurance/vulndb/manifest.json"
  install -m 0644 service-assurance/vulndb/LICENSES.md \
    "$BUNDLE_DIR/service-assurance/vulndb/LICENSES.md"
  install -m 0644 "$db_archive" "$BUNDLE_DIR/service-assurance/vulndb/db.tar.gz"

  SERVICE_ASSURANCE_MANIFEST_SIGNING_KEY_FILE="$SIGNING_KEY_FILE" \
    bash scripts/sign-service-assurance-artifacts.sh \
      "$BUNDLE_DIR/service-assurance/trust" >/dev/null
  openssl dgst -sha256 \
    -verify "$BUNDLE_DIR/service-assurance/trust/manifest.pub" \
    -signature "$BUNDLE_DIR/service-assurance/trust/rules/manifest.sig" \
    "$BUNDLE_DIR/service-assurance/rules/manifest.json" >/dev/null
  openssl dgst -sha256 \
    -verify "$BUNDLE_DIR/service-assurance/trust/manifest.pub" \
    -signature "$BUNDLE_DIR/service-assurance/trust/vulndb/manifest.sig" \
    "$BUNDLE_DIR/service-assurance/vulndb/manifest.json" >/dev/null
  echo '[ok] signed service assurance rules and vulnerability database added'
}

write_image_lock() {
  require_cmd jq
  if [[ "$SKIP_IMAGE_SAVE" -eq 1 ]]; then
    jq -n '{schema:"offline-image-lock/v1",status:"TEST_ONLY_SKIPPED",images:[]}' \
      >"$BUNDLE_DIR/image-lock.json"
    return
  fi

  local lock image image_id repo_digests runtime_digest
  lock='{"schema":"offline-image-lock/v1","status":"LOCKED","images":[]}'
  for image in "${REQUIRED_IMAGES[@]}"; do
    image_id="$(docker image inspect "$image" --format '{{.Id}}')"
    repo_digests="$(docker image inspect "$image" --format '{{json .RepoDigests}}')"
    runtime_digest="sha256:$(docker image inspect "$image" \
      --format '{{json .Config}}|{{json .RootFS.Layers}}' | sha256sum | awk '{print $1}')"
    lock="$(jq -c \
      --arg reference "$image" \
      --arg imageId "$image_id" \
      --arg runtimeDigest "$runtime_digest" \
      --argjson repoDigests "${repo_digests:-null}" \
      '.images += [{reference:$reference,imageId:$imageId,runtimeDigest:$runtimeDigest,repoDigests:($repoDigests // [])}]' \
      <<<"$lock")"
  done
  jq -S . <<<"$lock" >"$BUNDLE_DIR/image-lock.json"
}

write_compose() {
  cat >"$BUNDLE_DIR/docker-compose.yml" <<'COMPOSE'
name: lse

x-app-env: &app-env
  NODE_ENV: production
  LSE_RELEASE_VERSION: __PRODUCT_VERSION__
  LSE_SOURCE_COMMIT: __SOURCE_COMMIT__
  LSE_AGENT_GATEWAY_ORIGINS: ${LSE_AGENT_GATEWAY_ORIGINS:-}
  LSE_BATCH_CALLBACK_SECRET: ${LSE_BATCH_CALLBACK_SECRET:-}
  LSE_BATCH_CALLBACK_KEY_ID: ${LSE_BATCH_CALLBACK_KEY_ID:-lse-batch-callback-v1}
  LSE_PLATFORM_TENANT_BINDINGS_FILE: ${LSE_PLATFORM_TENANT_BINDINGS_FILE:-/etc/lse-integrations/tenant-bindings.json}
  NODE_EXTRA_CA_CERTS: ${NODE_EXTRA_CA_CERTS:-}
  API_PORT: '8090'
  DATABASE_URL: postgresql://${POSTGRES_USER:-lse}:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@lse-postgres:5432/${POSTGRES_DB:-lse}?schema=public
  REDIS_URL: redis://lse-valkey:6379
  JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}
  JWT_EXPIRES_IN: ${JWT_EXPIRES_IN:-12h}
  CORS_ORIGIN: ${CORS_ORIGIN:-*}
  ADMIN_USERNAME: ${ADMIN_USERNAME:-admin}
  ADMIN_DISPLAY_NAME: ${ADMIN_DISPLAY_NAME:-admin}
  ADMIN_PASSWORD: ${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}
  NEWAPI_EVAL_INTEGRATION_TOKEN: ${NEWAPI_EVAL_INTEGRATION_TOKEN:-}
  NEWAPI_INTERNAL_API_SECRET: ${NEWAPI_INTERNAL_API_SECRET:-}
  NEWAPI_CONTROL_PLANE_BASE_URL: ${NEWAPI_CONTROL_PLANE_BASE_URL:-}
  GATEWAY_CONTROL_PLANE_ALLOWLIST: ${GATEWAY_CONTROL_PLANE_ALLOWLIST:-}
  NEWAPI_TENANT_ID: ${NEWAPI_TENANT_ID:-}
  PROXY_DEFAULT_TENANT_ID: ${PROXY_DEFAULT_TENANT_ID:-}
  LICENSE_PUBLIC_KEY: ${LICENSE_PUBLIC_KEY:-}
  LICENSE_PUBLIC_KEYS: ${LICENSE_PUBLIC_KEYS:-}
  LICENSE_DEPLOYMENT_ID: ${LICENSE_DEPLOYMENT_ID:-}
  LICENSE_REVOCATION_FILE: ${LICENSE_REVOCATION_FILE:-}
  LICENSE_ENFORCE: ${LICENSE_ENFORCE:-true}
  PYTHON_JUDGE_URL: http://python-judge:8091
  PYTHON_JUDGE_ENABLED: ${PYTHON_JUDGE_ENABLED:-false}
  GARAK_URL: http://garak:8092
  GARAK_ENABLED: ${GARAK_ENABLED:-false}
  PYRIT_URL: http://pyrit:8093
  PYRIT_ENABLED: ${PYRIT_ENABLED:-false}
  LLM_JUDGE_RUBRIC_ENABLED: ${LLM_JUDGE_RUBRIC_ENABLED:-false}
  MODEL_SCAN_ROOTS: ${MODEL_SCAN_ROOTS:-/models}
  MODEL_SCAN_HOST_DIR: ${MODEL_SCAN_HOST_DIR:-/opt/lse/models}
  MODEL_SCAN_UPLOAD_MAX_BYTES: ${MODEL_SCAN_UPLOAD_MAX_BYTES:-0}
  MODEL_SCAN_UPLOAD_DIR: /var/lib/lse/model-scan-uploads
  PDF_CJK_FONT_PATH: ${PDF_CJK_FONT_PATH:-/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc}
  PDF_CJK_FONT_FAMILY: ${PDF_CJK_FONT_FAMILY:-NotoSansCJKsc-Regular}
  REPORT_RENDERER: ${REPORT_RENDERER:-html}
  REPORT_CHROMIUM_PATH: ${REPORT_CHROMIUM_PATH:-/opt/lse-chromium/chrome}
  SERVICE_ASSURANCE_NUCLEI_URL: http://service-assurance-nuclei:8095
  SERVICE_ASSURANCE_NUCLEI_ENGINE_DIGEST: sha256:aeb5ea2db32a252b8135707d2ad0e89b90e19a18ea7816d38759bc51efb46b97
  SERVICE_ASSURANCE_NUCLEI_RULESET_VERSION: lse-rules-2026.08.30.3
  SERVICE_ASSURANCE_NUCLEI_RULESET_DIGEST: sha256:124509fdacc43314287589194b0cb1acf67ea4f6133daf6776e00be250ea6f73
  SERVICE_ASSURANCE_NUCLEI_RULESET_UPDATED_AT: '2026-08-30T13:21:26Z'
  SERVICE_ASSURANCE_TRIVY_URL: http://service-assurance-trivy:8095
  SERVICE_ASSURANCE_TRIVY_ENGINE_DIGEST: sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e
  SERVICE_ASSURANCE_TRIVY_DB_VERSION: trivy-db-2026.08.30T070529Z
  SERVICE_ASSURANCE_TRIVY_DB_DIGEST: sha256:542d1ae089c1070990372d1416416f2a3e699f0c5c12fbc1cafe37071c00e27d
  SERVICE_ASSURANCE_TRIVY_DB_UPDATED_AT: '2026-08-30T07:05:29Z'
  SERVICE_ASSURANCE_SCOPE_POLICIES: '${SERVICE_ASSURANCE_SCOPE_POLICIES:-}'
  SERVICE_ASSURANCE_ZAP_URL: http://service-assurance-zap:8095
  SERVICE_ASSURANCE_ZAP_ENGINE_DIGEST: sha256:7840969c7c9fead565bf9734b12f49f6886db90b1d35b1f74d79710bbd081dab
  SERVICE_ASSURANCE_ZAP_RULESET_VERSION: lse-rules-2026.08.30.3
  SERVICE_ASSURANCE_ZAP_RULESET_DIGEST: sha256:124509fdacc43314287589194b0cb1acf67ea4f6133daf6776e00be250ea6f73
  SERVICE_ASSURANCE_ZAP_RULESET_UPDATED_AT: '2026-08-30T13:21:26Z'

services:
  postgres:
    image: __POSTGRES_IMAGE__
    pull_policy: never
    container_name: lse-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-lse}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      POSTGRES_DB: ${POSTGRES_DB:-lse}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-lse} -d ${POSTGRES_DB:-lse}']
      interval: 5s
      timeout: 5s
      retries: 10

  valkey:
    image: __VALKEY_IMAGE__
    pull_policy: never
    container_name: lse-valkey
    restart: unless-stopped
    command: ['valkey-server', '--appendonly', 'yes']
    volumes:
      - valkeydata:/data
    healthcheck:
      test: ['CMD-SHELL', 'valkey-cli ping | grep -q PONG']
      interval: 5s
      timeout: 5s
      retries: 10

  migrate:
    image: __APP_IMAGE__
    pull_policy: never
    container_name: lse-migrate
    environment: *app-env
    command:
      - sh
      - -c
      - pnpm exec prisma migrate deploy --schema apps/api/prisma/schema.prisma && pnpm exec tsx apps/api/prisma/seed.ts
    depends_on:
      postgres:
        condition: service_healthy
    restart: 'no'

  api:
    image: __APP_IMAGE__
    pull_policy: never
    container_name: lse-api
    volumes:
      - ${MODEL_SCAN_HOST_DIR:-/opt/lse/models}:/models:ro
      - model_scan_uploads:/var/lib/lse/model-scan-uploads
      - ./integrations:/etc/lse-integrations:ro
    environment: *app-env
    expose:
      - '8090'
    networks:
      - default
      - service-assurance-control
    depends_on:
      postgres:
        condition: service_healthy
      valkey:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:8090/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 25s
    restart: unless-stopped

  worker:
    image: __APP_IMAGE__
    pull_policy: never
    container_name: lse-worker
    volumes:
      - ${MODEL_SCAN_HOST_DIR:-/opt/lse/models}:/models:ro
      - model_scan_uploads:/var/lib/lse/model-scan-uploads
      - ./integrations:/etc/lse-integrations:ro
    environment: *app-env
    command: ['pnpm', '--filter', '@lse/worker', 'start']
    networks:
      - default
      - service-assurance-control
    depends_on:
      postgres:
        condition: service_healthy
      valkey:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped

  web:
    image: __WEB_IMAGE__
    pull_policy: never
    container_name: lse-web
    ports:
      - '${WEB_HTTP_PORT:-8090}:80'
      - '${WEB_HTTPS_PORT:-10443}:443'
    volumes:
      - caddy_data:/data
    depends_on:
      api:
        condition: service_healthy
    restart: unless-stopped

  service-assurance-nuclei:
    image: __NUCLEI_IMAGE__
    pull_policy: never
    user: '65532:65532'
    environment:
      SERVICE_ASSURANCE_BASELINE_VERSION: lse-rules-2026.08.30.3
      SERVICE_ASSURANCE_BASELINE_DIGEST: sha256:124509fdacc43314287589194b0cb1acf67ea4f6133daf6776e00be250ea6f73
      SERVICE_ASSURANCE_BASELINE_UPDATED_AT: '2026-08-30T13:21:26Z'
      SERVICE_ASSURANCE_BASELINE_STATUS: CURRENT
      SERVICE_ASSURANCE_MANIFEST_PATH: /opt/service-assurance/rules/manifest.json
      SERVICE_ASSURANCE_MANIFEST_SIGNATURE_PATH: /trust/rules/manifest.sig
      SERVICE_ASSURANCE_MANIFEST_PUBLIC_KEY_PATH: /trust/manifest.pub
    volumes:
      - ./service-assurance/rules:/opt/service-assurance/rules:ro
      - ./service-assurance/trust/manifest.pub:/trust/manifest.pub:ro
      - ./service-assurance/trust/rules/manifest.sig:/trust/rules/manifest.sig:ro
    expose: ['8095']
    networks:
      - service-assurance-control
      - service-assurance-egress
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    pids_limit: 256
    mem_limit: 768m
    cpus: 1.0
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8095/healthz | grep -q ''"ready":true''']
      interval: 10s
      timeout: 3s
      retries: 12
      start_period: 10s
    restart: unless-stopped

  service-assurance-trivy:
    image: __TRIVY_IMAGE__
    pull_policy: never
    user: '65532:65532'
    environment:
      SERVICE_ASSURANCE_BASELINE_VERSION: trivy-db-2026.08.30T070529Z
      SERVICE_ASSURANCE_BASELINE_DIGEST: sha256:542d1ae089c1070990372d1416416f2a3e699f0c5c12fbc1cafe37071c00e27d
      SERVICE_ASSURANCE_BASELINE_UPDATED_AT: '2026-08-30T07:05:29Z'
      SERVICE_ASSURANCE_BASELINE_STATUS: CURRENT
      SERVICE_ASSURANCE_MANIFEST_PATH: /opt/service-assurance/vulndb/manifest.json
      SERVICE_ASSURANCE_MANIFEST_SIGNATURE_PATH: /trust/vulndb/manifest.sig
      SERVICE_ASSURANCE_MANIFEST_PUBLIC_KEY_PATH: /trust/manifest.pub
    volumes:
      - ./service-assurance/vulndb/manifest.json:/opt/service-assurance/vulndb/manifest.json:ro
      - ./service-assurance/vulndb/db:/opt/service-assurance/vulndb/db:ro
      - ./service-assurance/trust/manifest.pub:/trust/manifest.pub:ro
      - ./service-assurance/trust/vulndb/manifest.sig:/trust/vulndb/manifest.sig:ro
    expose: ['8095']
    networks:
      - service-assurance-control
      - service-assurance-egress
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777
      - /opt/service-assurance/vulndb/fanal:rw,noexec,nosuid,nodev,size=67108864,mode=1777
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    pids_limit: 256
    mem_limit: 1536m
    cpus: 1.0
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8095/healthz | grep -q ''"ready":true''']
      interval: 10s
      timeout: 3s
      retries: 12
      start_period: 10s
    restart: unless-stopped

  service-assurance-zap:
    image: __ZAP_IMAGE__
    pull_policy: never
    profiles: ['service-assurance-deep']
    user: '1000:1000'
    environment:
      SERVICE_ASSURANCE_BASELINE_VERSION: lse-rules-2026.08.30.3
      SERVICE_ASSURANCE_BASELINE_DIGEST: sha256:124509fdacc43314287589194b0cb1acf67ea4f6133daf6776e00be250ea6f73
      SERVICE_ASSURANCE_BASELINE_UPDATED_AT: '2026-08-30T13:21:26Z'
      SERVICE_ASSURANCE_BASELINE_STATUS: CURRENT
      SERVICE_ASSURANCE_MANIFEST_PATH: /opt/service-assurance/rules/manifest.json
      SERVICE_ASSURANCE_MANIFEST_SIGNATURE_PATH: /trust/rules/manifest.sig
      SERVICE_ASSURANCE_MANIFEST_PUBLIC_KEY_PATH: /trust/manifest.pub
    volumes:
      - ./service-assurance/rules:/opt/service-assurance/rules:ro
      - ./service-assurance/trust/manifest.pub:/trust/manifest.pub:ro
      - ./service-assurance/trust/rules/manifest.sig:/trust/rules/manifest.sig:ro
    expose: ['8095']
    networks:
      - service-assurance-control
      - service-assurance-egress
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=536870912,mode=1777
      - /zap/wrk:rw,noexec,nosuid,nodev,size=536870912,mode=1777,uid=1000,gid=1000
      - /home/zap/.ZAP:rw,noexec,nosuid,nodev,size=268435456,mode=1777,uid=1000,gid=1000
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    pids_limit: 256
    mem_limit: 2048m
    cpus: 1.0
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8095/healthz | grep -q ''"ready":true''']
      interval: 10s
      timeout: 3s
      retries: 12
      start_period: 20s
    restart: unless-stopped

volumes:
  caddy_data:
  model_scan_uploads:
  pgdata:
  valkeydata:

networks:
  service-assurance-control:
    internal: true
  service-assurance-egress:
    internal: false
COMPOSE
  sed -i \
    -e "s|__PRODUCT_VERSION__|$PRODUCT_VERSION|g" \
    -e "s|__SOURCE_COMMIT__|$SOURCE_COMMIT|g" \
    -e "s|__APP_IMAGE__|$APP_IMAGE|g" \
    -e "s|__WEB_IMAGE__|$WEB_IMAGE|g" \
    -e "s|__POSTGRES_IMAGE__|$POSTGRES_IMAGE|g" \
    -e "s|__VALKEY_IMAGE__|$VALKEY_IMAGE|g" \
    -e "s|__NUCLEI_IMAGE__|$NUCLEI_IMAGE|g" \
    -e "s|__TRIVY_IMAGE__|$TRIVY_IMAGE|g" \
    -e "s|__ZAP_IMAGE__|$ZAP_IMAGE|g" \
    "$BUNDLE_DIR/docker-compose.yml"
}

write_install_script() {
  cat >"$BUNDLE_DIR/install.sh" <<'INSTALL'
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[error] missing required command: $1" >&2
    exit 1
  }
}

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return
  fi
  od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
  printf '\n'
}

random_password() {
  printf 'Lse#%s!\n' "$(random_hex 6)"
}

RESERVED_PORTS=""

port_in_use() {
  local port="$1" reserved ss_bin="" listening table hex
  for reserved in $RESERVED_PORTS; do
    [[ "$reserved" != "$port" ]] || return 0
  done
  [[ "${LSE_PORT_CHECK_SKIP:-0}" != 1 ]] || return 1

  if [[ -n "${LSE_PORT_CHECK_BINDIR:-}" && -x "${LSE_PORT_CHECK_BINDIR}/ss" ]]; then
    ss_bin="${LSE_PORT_CHECK_BINDIR}/ss"
  elif command -v ss >/dev/null 2>&1; then
    ss_bin=ss
  fi
  if [[ -n "$ss_bin" ]]; then
    listening="$("$ss_bin" -ltnH 2>/dev/null || "$ss_bin" -ltn 2>/dev/null || true)"
    grep -Eq "[.:]${port}[[:space:]]" <<<"$listening"
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|[.:])${port}$"
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi

  hex="$(printf '%04X' "$port")"
  for table in /proc/net/tcp /proc/net/tcp6; do
    [[ -r "$table" ]] || continue
    if awk -v endpoint=":$hex" '$2 ~ endpoint "$" && $4 == "0A" { found=1 } END { exit !found }' "$table"; then
      return 0
    fi
  done
  return 1
}

allocate_port() {
  local var_name="$1" port="$2"
  [[ "$var_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    echo "[error] invalid port variable: $var_name" >&2
    exit 1
  }
  [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || {
    echo "[error] invalid starting port: $port" >&2
    exit 1
  }
  while port_in_use "$port"; do
    ((port < 65535)) || {
      echo "[error] no available TCP port at or above $2" >&2
      exit 1
    }
    ((port += 1))
  done
  RESERVED_PORTS="$RESERVED_PORTS $port"
  printf -v "$var_name" '%s' "$port"
}

write_env() {
  local admin_password postgres_password jwt_secret integration_token internal_secret
  local web_http_port web_https_port
  admin_password="$(random_password)"
  postgres_password="$(random_hex 24)"
  jwt_secret="$(random_hex 32)"
  integration_token="$(random_hex 24)"
  internal_secret="$(random_hex 24)"
  RESERVED_PORTS=""
  allocate_port web_http_port "${LSE_WEB_HTTP_PORT_START:-8090}"
  allocate_port web_https_port "${LSE_WEB_HTTPS_PORT_START:-10443}"

  cat >.env <<EOF
POSTGRES_USER=lse
POSTGRES_PASSWORD=$postgres_password
POSTGRES_DB=lse
POSTGRES_PORT=5432
VALKEY_PORT=6379
JWT_SECRET=$jwt_secret
JWT_EXPIRES_IN=12h
ADMIN_USERNAME=admin
ADMIN_DISPLAY_NAME=admin
ADMIN_PASSWORD=$admin_password
WEB_HTTP_PORT=$web_http_port
WEB_HTTPS_PORT=$web_https_port
CORS_ORIGIN=*
NEWAPI_EVAL_INTEGRATION_TOKEN=$integration_token
NEWAPI_INTERNAL_API_SECRET=$internal_secret
NEWAPI_CONTROL_PLANE_BASE_URL=
GATEWAY_CONTROL_PLANE_ALLOWLIST=
NEWAPI_TENANT_ID=tenant_default
PROXY_DEFAULT_TENANT_ID=tenant_default
LICENSE_PUBLIC_KEY=
LICENSE_PUBLIC_KEYS={"lse-lic-2026":"WxiAqCV0BUqVnopcPSrOWcVlowUoz1JQtGyEUCZ2f_Y"}
LICENSE_DEPLOYMENT_ID=
LICENSE_REVOCATION_FILE=
LICENSE_ENFORCE=true
PYTHON_JUDGE_ENABLED=false
GARAK_ENABLED=false
PYRIT_ENABLED=false
LLM_JUDGE_RUBRIC_ENABLED=false
REPORT_RENDERER=html
REPORT_CHROMIUM_PATH=/opt/lse-chromium/chrome
EOF

  cat >INITIAL_CREDENTIALS.txt <<EOF
Initial administrator
  username: admin
  password: $admin_password

Generated by install.sh on $(date -Is).
Keep this file offline. Change the password after first login.
EOF
  chmod 600 .env INITIAL_CREDENTIALS.txt 2>/dev/null || true
  echo "[ok] Generated .env and INITIAL_CREDENTIALS.txt"
  echo "[ok] Selected ports: HTTP=$web_http_port HTTPS=$web_https_port"
}

install_compose_plugin() {
  if docker compose version >/dev/null 2>&1; then
    echo "[ok] Docker Compose v2 already available: $(docker compose version --short 2>/dev/null || docker compose version)"
    return
  fi

  local plugin="$ROOT_DIR/dependencies/docker-compose"
  local plugin_dir="${DOCKER_COMPOSE_PLUGIN_DIR:-/usr/local/lib/docker/cli-plugins}"
  [[ -f "$plugin" && -x "$plugin" ]] || {
    echo "[error] bundled Docker Compose plugin not found: $plugin" >&2
    exit 1
  }
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    install -d -m 0755 "$plugin_dir"
    install -m 0755 "$plugin" "$plugin_dir/docker-compose"
  elif command -v sudo >/dev/null 2>&1; then
    sudo install -d -m 0755 "$plugin_dir"
    sudo install -m 0755 "$plugin" "$plugin_dir/docker-compose"
  else
    echo '[error] Docker Compose v2 is unavailable and sudo is required to install the bundled plugin' >&2
    exit 1
  fi
  docker compose version >/dev/null 2>&1 || {
    echo '[error] bundled Docker Compose plugin was installed but docker compose is still unavailable' >&2
    exit 1
  }
  echo "[ok] installed bundled Docker Compose plugin: $(docker compose version --short 2>/dev/null || docker compose version)"
}

require_cmd docker
install_compose_plugin

if [[ ! -f .env ]]; then
  write_env
  ./upgrade.sh --fresh-install "$@"
else
  echo "[info] Existing .env found; preserving it and running upgrade path."
  ./upgrade.sh "$@"
fi
INSTALL
  chmod +x "$BUNDLE_DIR/install.sh"
}

write_backup_script() {
  cat >"$BUNDLE_DIR/backup-db.sh" <<'BACKUP'
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "[error] .env not found; cannot locate database credentials" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

POSTGRES_USER="${POSTGRES_USER:-lse}"
POSTGRES_DB="${POSTGRES_DB:-lse}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
# Default backup path shape: backups/lse-<database>-<timestamp>.sql
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE="${BACKUP_DIR}/lse-${POSTGRES_DB}-${TIMESTAMP}.sql"
mkdir -p "$BACKUP_DIR"

echo "[step] ensuring postgres is running for backup"
docker compose --env-file .env up -d postgres

for _ in $(seq 1 60); do
  if docker compose --env-file .env exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker compose --env-file .env exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
  echo "[error] postgres is not ready; backup aborted" >&2
  exit 1
fi

echo "[step] creating database backup -> $OUTPUT_FILE"
docker compose --env-file .env exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" >"$OUTPUT_FILE"
[[ -s "$OUTPUT_FILE" ]] || {
  echo "[error] database backup is empty" >&2
  exit 1
}
cp .env "${BACKUP_DIR}/.env-${TIMESTAMP}"
chmod 0600 "$OUTPUT_FILE" "${BACKUP_DIR}/.env-${TIMESTAMP}"
echo "[ok] backup completed -> $OUTPUT_FILE"
BACKUP
  chmod +x "$BUNDLE_DIR/backup-db.sh"
}

write_upgrade_script() {
  cat >"$BUNDLE_DIR/upgrade.sh" <<'UPGRADE'
#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/report-renderer-env.sh"

FRESH_INSTALL=0
INSTALL_DIR=""
SKIP_LOAD=0
PREFLIGHT_ONLY=0
LOG_DIR="upgrade-logs"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/upgrade-${TIMESTAMP}.log"
ROLLBACK_SNAPSHOT="${LSE_ROLLBACK_SNAPSHOT:-}"

usage() {
  cat <<'USAGE'
Usage: ./upgrade.sh [--fresh-install] [--install-dir DIR] [--skip-load] [--preflight-only]

Common flows:
  ./install.sh
    Fresh install in this directory. Generates .env, then runs upgrade setup.

  ./upgrade.sh
    In-place upgrade from this package directory. Requires an existing .env.

  ./upgrade.sh --install-dir /path/to/current-install
    Upgrade an existing installation from a newly extracted package. The script
    copies package files into the current install directory and preserves .env.
USAGE
}

while (($#)); do
  case "$1" in
    --fresh-install)
      FRESH_INSTALL=1
      ;;
    --install-dir)
      shift
      INSTALL_DIR="${1:?missing --install-dir value}"
      ;;
    --skip-load)
      SKIP_LOAD=1
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[error] unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift || true
done

install_compose_plugin() {
  if docker compose version >/dev/null 2>&1; then
    echo "[ok] Docker Compose v2 already available: $(docker compose version --short 2>/dev/null || docker compose version)"
    return
  fi

  local plugin="$SCRIPT_DIR/dependencies/docker-compose"
  local plugin_dir="${DOCKER_COMPOSE_PLUGIN_DIR:-/usr/local/lib/docker/cli-plugins}"
  [[ -f "$plugin" && -x "$plugin" ]] || {
    echo "[error] bundled Docker Compose plugin not found: $plugin" >&2
    exit 1
  }
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    install -d -m 0755 "$plugin_dir"
    install -m 0755 "$plugin" "$plugin_dir/docker-compose"
  elif command -v sudo >/dev/null 2>&1; then
    sudo install -d -m 0755 "$plugin_dir"
    sudo install -m 0755 "$plugin" "$plugin_dir/docker-compose"
  else
    echo '[error] Docker Compose v2 is unavailable and sudo is required to install the bundled plugin' >&2
    exit 1
  fi
  docker compose version >/dev/null 2>&1 || {
    echo '[error] bundled Docker Compose plugin was installed but docker compose is still unavailable' >&2
    exit 1
  }
  echo "[ok] installed bundled Docker Compose plugin: $(docker compose version --short 2>/dev/null || docker compose version)"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || {
    echo "[error] docker not found" >&2
    exit 1
  }
  install_compose_plugin
  docker compose version >/dev/null 2>&1 || {
    echo "[error] docker compose v2 is required" >&2
    exit 1
  }
}

# 本次校验模式，写入 deployment-state.json 供事后审计：
#   full-signature    完整验签（RSA-2048 + SHA-256）
#   sha256-degraded   客户机没有可用的 openssl，降级为 SHA-256 完整性校验
#   unsigned-override 交付包自身没有签名，由 OFFLINE_ALLOW_UNSIGNED_MANIFEST 显式放行
# 后两者语义不重叠：sha256-degraded 由客户机环境决定并自动生效，
# unsigned-override 由交付物自身决定且必须人工置位。
VERIFICATION_MODE='unknown'

# openssl 可用性用实际能力探测判定：临时生成一对 RSA 2048 密钥，签一次、验一次。
# 不解析 openssl version 字符串，也不只看 command -v——
# 信创最小化系统上常见"有 libssl 没有 openssl 二进制"，
# 也存在二进制在但缺库、被策略拒绝、是个坏壳脚本的情况。
openssl_signing_usable() {
  command -v openssl >/dev/null 2>&1 || return 1
  local probe status=1
  probe="$(mktemp -d 2>/dev/null)" || return 1
  if printf 'lse-openssl-capability-probe\n' >"$probe/data" 2>/dev/null &&
    { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$probe/key.pem" >/dev/null 2>&1 ||
      openssl genrsa -out "$probe/key.pem" 2048 >/dev/null 2>&1; } &&
    openssl pkey -in "$probe/key.pem" -pubout -out "$probe/key.pub" >/dev/null 2>&1 &&
    openssl dgst -sha256 -sign "$probe/key.pem" -out "$probe/data.sig" "$probe/data" >/dev/null 2>&1 &&
    openssl dgst -sha256 -verify "$probe/key.pub" -signature "$probe/data.sig" "$probe/data" >/dev/null 2>&1; then
    status=0
  fi
  rm -rf "$probe"
  return "$status"
}

# 构建机出厂自检置 LSE_REQUIRE_FULL_VERIFICATION=1：
# 一旦进入任何降级路径立刻以非 0 退出，杜绝产出"只做过 SHA-256 自检"的包。
# 客户现场不设置该变量，降级路径正常放行。
refuse_degraded_when_full_required() {
  [[ "${LSE_REQUIRE_FULL_VERIFICATION:-0}" == "1" ]] || return 0
  echo "[失败] 已要求完整验签（LSE_REQUIRE_FULL_VERIFICATION=1），但本次校验模式为：$VERIFICATION_MODE" >&2
  echo "[失败] 原因：$1" >&2
  exit 1
}

verify_manifest_signature() {
  if [[ ! -f manifest.json || ! -f manifest.sig || ! -f manifest.pub ]]; then
    if [[ "${OFFLINE_ALLOW_UNSIGNED_MANIFEST:-0}" == "1" ]]; then
      VERIFICATION_MODE='unsigned-override'
      refuse_degraded_when_full_required '交付包内缺少 manifest 签名文件'
      echo "[warn] manifest signature files missing; explicit unsigned override enabled"
      return
    fi
    echo "[error] signed manifest files are required" >&2
    exit 1
  fi
  if grep -qx 'UNSIGNED' manifest.sig; then
    [[ "${OFFLINE_ALLOW_UNSIGNED_MANIFEST:-0}" == "1" ]] || { echo "[error] unsigned manifest refused" >&2; exit 1; }
    VERIFICATION_MODE='unsigned-override'
    refuse_degraded_when_full_required '交付包内的 manifest 未签名'
    echo "[warn] unsigned manifest accepted only by explicit override"
    return
  fi
  if ! openssl_signing_usable; then
    VERIFICATION_MODE='sha256-degraded'
    refuse_degraded_when_full_required '本机没有可用的 openssl，无法完成 RSA 验签'
    echo '[提示] 本机没有可用的 openssl 命令行工具，已跳过 manifest 数字签名校验。'
    echo '[提示] 本次安装降级为 SHA-256 完整性校验：包内 checksums.sha256 校验仍然强制执行，任何不匹配都会立即终止安装。'
    echo '[提示] 降级模式无法防住"篡改文件并同时重算校验和"的情况。如需完整防篡改验签，请在本机安装 openssl 命令行工具后重新执行本次升级。'
    return
  fi
  openssl dgst -sha256 -verify manifest.pub -signature manifest.sig manifest.json >/dev/null 2>&1 || {
    echo '[失败] manifest 数字签名校验不通过，交付物可能已被篡改，安装已终止。' >&2
    echo '[失败] 请重新获取官方交付包，不要在当前包上重试安装。' >&2
    exit 1
  }
  VERIFICATION_MODE='full-signature'
  echo "[ok] manifest signature verified"
}

snapshot_existing_deployment() {
  local target="$1" source_root snapshot service container_id image_ref image_id expected_images
  [[ -f "$target/.env" ]] || return 0
  source_root="$target"
  if [[ ! -f "$source_root/docker-compose.yml" && -f "$target/current/docker-compose.yml" ]]; then
    source_root="$(cd -P "$target/current" && pwd)"
  fi
  [[ -f "$source_root/docker-compose.yml" ]] || return 0
  require_docker
  expected_images="$(docker compose --env-file "$target/.env" -f "$source_root/docker-compose.yml" config --images)"
  snapshot="$target/rollback-snapshots/$TIMESTAMP"
  [[ ! -e "$snapshot" ]] || {
    echo "[error] rollback snapshot already exists: $snapshot" >&2
    exit 1
  }
  install -d -m 0700 "$snapshot"
  for file in docker-compose.yml image-lock.json MANIFEST.txt manifest.json manifest.sig manifest.pub checksums.sha256 deployment-state.json; do
    [[ -f "$source_root/$file" && ! -L "$source_root/$file" ]] || continue
    install -m 0600 "$source_root/$file" "$snapshot/$file"
  done

  : >"$snapshot/images-snapshot.tsv"
  for service in postgres valkey api worker web; do
    container_id="$(docker compose --env-file "$target/.env" -f "$source_root/docker-compose.yml" ps -q "$service" 2>/dev/null || true)"
    [[ -n "$container_id" ]] || {
      echo "[error] cannot snapshot stopped or missing service: $service" >&2
      exit 1
    }
    image_ref="$(docker inspect "$container_id" --format '{{.Config.Image}}')"
    image_id="$(docker inspect "$container_id" --format '{{.Image}}')"
    [[ "$image_ref" =~ ^[A-Za-z0-9._/@:-]+$ && "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || {
      echo "[error] invalid running image identity for service: $service" >&2
      exit 1
    }
    grep -Fxq -- "$image_ref" <<<"$expected_images" || {
      echo '[error] current Compose no longer matches the running deployment; cannot create a reliable rollback snapshot' >&2
      echo '[hint] upgrade from a separate package directory using --install-dir; preserve the original deployment files' >&2
      exit 1
    }
    printf '%s\t%s\t%s\n' "$service" "$image_ref" "$image_id" >>"$snapshot/images-snapshot.tsv"
  done
  (
    cd "$snapshot"
    find . -maxdepth 1 -type f ! -name checksums.sha256 -print0 |
      sort -z | xargs -0 sha256sum >checksums.sha256
  )
  chmod 0600 "$snapshot"/*
  ROLLBACK_SNAPSHOT="$snapshot"
  echo "[ok] rollback snapshot created: $(basename "$snapshot")"
}

copy_payload_to_install_dir() {
  local target="$1"
  if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
    [[ -d "$target" && ! -L "$target" && -f "$target/.env" && ! -L "$target/.env" ]] || {
      echo '[error] preflight target must be an existing installation with a regular .env file' >&2
      exit 1
    }
    target="$(cd "$target" && pwd)"
    if [[ "$target" != "$SCRIPT_DIR" ]]; then
      exec env LSE_PREFLIGHT_ENV_FILE="$target/.env" \
        bash "$SCRIPT_DIR/upgrade.sh" --preflight-only
    fi
    return
  fi

  mkdir -p "$target"
  target="$(cd "$target" && pwd)"
  if [[ "$target" == "$SCRIPT_DIR" ]]; then
    return
  fi

  snapshot_existing_deployment "$target"

  echo "[step] copying package payload to existing install dir: $target"
  echo "[info] Preserving existing .env in $target"
  local item
  for item in docker-compose.yml install.sh upgrade.sh rollback.sh backup-db.sh uninstall.sh status.sh stop.sh diagnose.sh report-renderer-env.sh README_OFFLINE.md MANIFEST.txt manifest.json manifest.sig manifest.pub image-lock.json sbom.spdx.json sbom-images SBOM-MISSING.txt checksums.sha256 LICENSE THIRD_PARTY_NOTICES.md CONFIG_TEMPLATE.env docs images dependencies service-assurance; do
    [[ -e "$SCRIPT_DIR/$item" ]] || continue
    rm -rf "$target/$item"
    cp -a "$SCRIPT_DIR/$item" "$target/$item"
  done
  if [[ ! -f "$target/INITIAL_CREDENTIALS.txt" && -f "$SCRIPT_DIR/INITIAL_CREDENTIALS.txt" ]]; then
    cp -a "$SCRIPT_DIR/INITIAL_CREDENTIALS.txt" "$target/INITIAL_CREDENTIALS.txt"
  fi
  exec env LSE_ROLLBACK_SNAPSHOT="$ROLLBACK_SNAPSHOT" bash "$target/upgrade.sh"
}

verify_checksums() {
  if [[ -s images/checksums.sha256 ]]; then
    echo "[step] verifying image archive checksum"
    (cd images && sha256sum -c checksums.sha256)
  fi
  if [[ -s checksums.sha256 ]]; then
    echo "[step] verifying package checksums"
    sha256sum -c checksums.sha256 >/dev/null
  fi
}

verify_service_assurance_artifacts() {
  local prepare="${1:-0}" archive stage entries
  archive='service-assurance/vulndb/db.tar.gz'
  for file in \
    service-assurance/rules/manifest.json \
    service-assurance/vulndb/manifest.json \
    service-assurance/trust/manifest.pub \
    service-assurance/trust/rules/manifest.sig \
    service-assurance/trust/vulndb/manifest.sig \
    "$archive"; do
    [[ -f "$file" && ! -L "$file" ]] || {
      echo "[error] service assurance artifact is unavailable: $file" >&2
      exit 1
    }
  done
  # 与 manifest 验签保持同一套判定：openssl 可用就验签，不可用就降级到 SHA-256。
  # 否则客户机装到这一步仍然会中途退出——这正是本次要消除的"前面检查、后面才用"。
  if openssl_signing_usable; then
    openssl dgst -sha256 -verify service-assurance/trust/manifest.pub \
      -signature service-assurance/trust/rules/manifest.sig \
      service-assurance/rules/manifest.json >/dev/null 2>&1 || {
      echo '[失败] 安全检查规则清单的数字签名校验不通过，安装已终止。' >&2
      exit 1
    }
    openssl dgst -sha256 -verify service-assurance/trust/manifest.pub \
      -signature service-assurance/trust/vulndb/manifest.sig \
      service-assurance/vulndb/manifest.json >/dev/null 2>&1 || {
      echo '[失败] 漏洞库清单的数字签名校验不通过，安装已终止。' >&2
      exit 1
    }
  else
    [[ "$VERIFICATION_MODE" == 'unsigned-override' ]] || VERIFICATION_MODE='sha256-degraded'
    refuse_degraded_when_full_required '本机没有可用的 openssl，无法校验安全检查组件签名'
    echo '[提示] 本机没有可用的 openssl 命令行工具，已跳过安全检查规则与漏洞库清单的签名校验。'
    echo '[提示] 漏洞库归档的固定 SHA-256 摘要校验与包内 checksums.sha256 校验仍然强制执行。'
  fi
  [[ "sha256:$(sha256sum "$archive" | awk '{print $1}')" == \
    'sha256:96b6b47116c081fdf033f809b93b43686894b708acc5f9f177f2f6986e48d1fb' ]] || {
    echo '[error] Trivy DB archive digest mismatch' >&2
    exit 1
  }
  entries="$(tar -tzf "$archive" | LC_ALL=C sort)"
  [[ "$entries" == $'metadata.json\ntrivy.db' ]] || {
    echo '[error] Trivy DB archive contains unexpected paths' >&2
    exit 1
  }
  [[ "$prepare" == 1 ]] || return 0

  stage='service-assurance/vulndb/.db-stage'
  rm -rf "$stage"
  install -d -m 0755 "$stage"
  tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$stage"
  [[ "$(sha256sum "$stage/trivy.db" | awk '{print $1}')" == \
    '389181324022b0b85f32a62ead5a6a291ae3f8fa674906d9fdfbe6c22d4a127f' ]] || {
    echo '[error] extracted Trivy DB digest mismatch' >&2
    exit 1
  }
  [[ "$(sha256sum "$stage/metadata.json" | awk '{print $1}')" == \
    'a01306e93daa6e2ed559cbf5a0c591ba82c4e86122991a31e4680d269bb56ed3' ]] || {
    echo '[error] extracted Trivy DB metadata digest mismatch' >&2
    exit 1
  }
  chmod 0444 "$stage/trivy.db" "$stage/metadata.json"
  rm -rf service-assurance/vulndb/db
  mv "$stage" service-assurance/vulndb/db
  echo '[ok] signed rules and fixed vulnerability database verified'
}

image_lock_rows() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '.schema == "offline-image-lock/v1" and .status == "LOCKED" and (.images | length >= 7)' \
      image-lock.json >/dev/null || return 1
    jq -r '.images[] | [.reference, .imageId, .runtimeDigest] | @tsv' image-lock.json
    return
  fi

  local app_image lock_path
  app_image="$(docker compose --env-file .env -f docker-compose.yml config --images | \
    grep -E '^lse-app:[A-Za-z0-9._-]+$' | sort -u | head -n 1)"
  [[ "$app_image" =~ ^lse-app:[A-Za-z0-9._-]+$ ]] || return 1
  lock_path="$(pwd)/image-lock.json"
  [[ -f "$lock_path" && ! -L "$lock_path" ]] || return 1
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    -v "$lock_path:/image-lock.json:ro" --entrypoint node "$app_image" -e '
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync("/image-lock.json", "utf8"));
if (lock.schema !== "offline-image-lock/v1" || lock.status !== "LOCKED" ||
    !Array.isArray(lock.images) || lock.images.length < 7) process.exit(1);
for (const image of lock.images) {
  if (typeof image.reference !== "string" || typeof image.imageId !== "string" ||
      typeof image.runtimeDigest !== "string") process.exit(1);
  process.stdout.write(`${image.reference}\t${image.imageId}\t${image.runtimeDigest}\n`);
}
'
}

verify_image_lock() {
  local reference expected expected_runtime actual actual_runtime rows
  rows="$(image_lock_rows)" || {
    echo '[error] production image lock is missing or incomplete' >&2
    exit 1
  }
  while IFS=$'\t' read -r reference expected expected_runtime; do
    [[ "$reference" =~ ^[A-Za-z0-9._/@:-]+$ && \
      "$expected" =~ ^sha256:[a-f0-9]{64}$ && \
      "$expected_runtime" =~ ^sha256:[a-f0-9]{64}$ ]] || {
      echo '[error] image lock entry is invalid' >&2
      exit 1
    }
    actual="$(docker image inspect "$reference" --format '{{.Id}}' 2>/dev/null || true)"
    actual_runtime="sha256:$(docker image inspect "$reference" \
      --format '{{json .Config}}|{{json .RootFS.Layers}}' 2>/dev/null | \
      sha256sum | awk '{print $1}')"
    [[ "$actual" == "$expected" || "$actual_runtime" == "$expected_runtime" ]] || {
      echo "[error] loaded image does not match lock: $reference" >&2
      exit 1
    }
  done <<<"$rows"
  echo '[ok] all offline images match image-lock.json'
}

write_deployment_state() {
  local installed_at manifest_digest rollback_name app_image output
  installed_at="$(date -Is)"
  manifest_digest="sha256:$(sha256sum manifest.json | awk '{print $1}')"
  rollback_name="${ROLLBACK_SNAPSHOT##*/}"
  output='deployment-state.json.tmp'
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg installedAt "$installed_at" --arg manifest "$manifest_digest" \
      --arg rollbackSnapshot "$rollback_name" --arg verificationMode "$VERIFICATION_MODE" \
      '{schema:"lse-deployment-state/v1",installedAt:$installedAt,manifestSha256:$manifest,verificationMode:$verificationMode,rollbackSnapshot:(if ($rollbackSnapshot | length) > 0 then $rollbackSnapshot else null end)}' \
      >"$output"
  else
    app_image="$(docker compose --env-file .env -f docker-compose.yml config --images | \
      grep -E '^lse-app:[A-Za-z0-9._-]+$' | sort -u | head -n 1)"
    [[ "$app_image" =~ ^lse-app:[A-Za-z0-9._-]+$ ]] || return 1
    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,size=16m \
      --entrypoint node "$app_image" -e '
const [installedAt, manifestSha256, rollback, verificationMode] = process.argv.slice(1);
process.stdout.write(JSON.stringify({schema:"lse-deployment-state/v1", installedAt,
  manifestSha256, verificationMode, rollbackSnapshot: rollback || null}) + "\n");
' "$installed_at" "$manifest_digest" "$rollback_name" "$VERIFICATION_MODE" >"$output"
  fi
  chmod 0600 "$output"
  mv "$output" deployment-state.json
  echo "[ok] 本次校验模式已记录到 deployment-state.json：$VERIFICATION_MODE"
}

load_images() {
  if [[ "$SKIP_LOAD" -eq 1 ]]; then
    echo "[skip] docker image load"
    return
  fi
  if [[ ! -f images/lse-core-images.tar.gz ]]; then
    echo "[error] images/lse-core-images.tar.gz not found" >&2
    exit 1
  fi
  echo "[step] loading offline Docker images"
  gzip -dc images/lse-core-images.tar.gz | docker load
}

verify_services() {
  local http_port running required service all_running
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  http_port="${WEB_HTTP_PORT:-8090}"
  required='postgres valkey service-assurance-nuclei service-assurance-trivy api worker web'

  echo '[step] waiting for core services and default assurance modes'
  for _ in $(seq 1 120); do
    running="$(docker compose --env-file .env ps --status running --services 2>/dev/null || true)"
    all_running=1
    for service in $required; do
      grep -qx "$service" <<<"$running" || all_running=0
    done
    if [[ "$all_running" -eq 1 ]] && command -v curl >/dev/null 2>&1; then
      if curl -fsS --max-time 3 "http://127.0.0.1:${http_port}/api/health" >/dev/null &&
         curl -fsS --max-time 3 "http://127.0.0.1:${http_port}/login" >/dev/null &&
         docker compose --env-file .env exec -T api node -e \
           "Promise.all(['service-assurance-nuclei','service-assurance-trivy'].map(h=>fetch('http://'+h+':8095/healthz').then(r=>r.json()).then(v=>{if(v.ready!==true)throw Error('not ready')}))).then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
        echo '[ok] API, login, SAFE and SBOM services are healthy'
        return 0
      fi
    elif [[ "$all_running" -eq 1 ]] && docker compose --env-file .env exec -T api node -e \
      "fetch('http://127.0.0.1:8090/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      if docker compose --env-file .env exec -T api node -e \
        "Promise.all(['service-assurance-nuclei','service-assurance-trivy'].map(h=>fetch('http://'+h+':8095/healthz').then(r=>r.json()).then(v=>{if(v.ready!==true)throw Error('not ready')}))).then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
        echo '[ok] API, SAFE and SBOM services are healthy (container probe)'
        return 0
      fi
    fi
    sleep 2
  done

  echo '[error] health verification timed out' >&2
  docker compose --env-file .env ps >&2 || true
  docker compose --env-file .env logs --tail=120 \
    postgres valkey migrate service-assurance-nuclei service-assurance-trivy api worker web >&2 || true
  return 1
}

verify_report_renderer() {
  echo '[step] verifying real HTML report pagination and Chromium PDF output'
  docker compose --env-file .env exec -T api \
    node --import tsx /app/scripts/report-renderer-smoke.ts
}

run_upgrade() {
  if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
    preflight_env="${LSE_PREFLIGHT_ENV_FILE:-.env}"
    [[ -f "$preflight_env" && ! -L "$preflight_env" ]] || {
      echo "[error] .env not found for preflight" >&2
      return 1
    }
    verify_manifest_signature
    verify_checksums
    verify_service_assurance_artifacts 0
    echo "[ok] preflight-only validation passed"
    echo "[info] verification mode: $VERIFICATION_MODE"
    return 0
  fi
  require_docker
  mkdir -p "$LOG_DIR"
  exec > >(tee -a "$LOG_FILE") 2>&1

  echo "[info] LSE offline upgrade started at $(date -Is)"
  echo "[info] log: $LOG_FILE"

  if [[ ! -f .env ]]; then
    echo "[error] .env not found. For a fresh install run ./install.sh; for upgrade use --install-dir /path/to/current-install." >&2
    exit 1
  fi

  verify_manifest_signature
  verify_checksums
  verify_service_assurance_artifacts 0

  if [[ "$FRESH_INSTALL" -eq 0 ]]; then
    echo "[step] backing up existing database and .env"
    ./backup-db.sh
    if [[ -z "$ROLLBACK_SNAPSHOT" ]]; then
      snapshot_existing_deployment "$SCRIPT_DIR"
    fi
  else
    echo "[skip] database backup for fresh install"
  fi

  load_images
  verify_image_lock
  verify_service_assurance_artifacts 1

  if [[ "$FRESH_INSTALL" -eq 0 ]]; then
    [[ -n "$ROLLBACK_SNAPSHOT" ]] || {
      echo '[error] rollback snapshot required before report configuration migration' >&2
      return 1
    }
    migrate_report_renderer_env .env "$ROLLBACK_SNAPSHOT/report-renderer.env"
    if [[ -f "$ROLLBACK_SNAPSHOT/report-renderer.env" ]]; then
      (
        cd "$ROLLBACK_SNAPSHOT"
        find . -maxdepth 1 -type f ! -name checksums.sha256 -print0 |
          sort -z | xargs -0 sha256sum >checksums.sha256
      )
      chmod 0600 "$ROLLBACK_SNAPSHOT/checksums.sha256"
    fi
  fi

  echo "[step] starting data and default assurance services"
  docker compose --env-file .env up -d \
    postgres valkey service-assurance-nuclei service-assurance-trivy

  echo "[step] running database migrations"
  docker compose --env-file .env rm -fsv migrate >/dev/null 2>&1 || true
  docker compose --env-file .env run --rm migrate

  echo "[step] recreating api and worker on new image"
  docker compose --env-file .env up -d --force-recreate --no-deps api worker

  echo "[step] recreating web entrypoint"
  docker compose --env-file .env up -d --force-recreate web

  verify_services
  verify_report_renderer

  write_deployment_state

  echo '[step] current service status'
  docker compose --env-file .env ps --status running

  echo "[ok] LSE offline upgrade completed"
}

if [[ -n "$INSTALL_DIR" ]]; then
  copy_payload_to_install_dir "$INSTALL_DIR"
fi

run_upgrade
UPGRADE
  chmod +x "$BUNDLE_DIR/upgrade.sh"
}

write_rollback_script() {
  cat >"$BUNDLE_DIR/rollback.sh" <<'ROLLBACK'
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/report-renderer-env.sh"
SNAPSHOT_ID=""
LIST_ONLY=0

usage() {
  cat <<'USAGE'
Usage: ./rollback.sh [--to YYYYMMDD-HHMMSS] [--list]

Rollback restores the previous Compose file and application image content.
It does not restore an old database, remove new tables, or delete evidence.
USAGE
}

while (($#)); do
  case "$1" in
    --to) shift; SNAPSHOT_ID="${1:?missing --to value}" ;;
    --list) LIST_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[error] unknown rollback argument: $1" >&2; exit 64 ;;
  esac
  shift
done

if [[ "$LIST_ONLY" -eq 1 ]]; then
  find rollback-snapshots -mindepth 1 -maxdepth 1 -type d \
    -name '????????-??????' -printf '%f\n' 2>/dev/null | sort -r
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo '[error] docker is required' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo '[error] sha256sum is required' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo '[error] Docker Compose v2 is required' >&2; exit 1; }
[[ -f .env && ! -L .env ]] || { echo '[error] install environment is unavailable' >&2; exit 1; }

if [[ -n "$SNAPSHOT_ID" ]]; then
  [[ "$SNAPSHOT_ID" =~ ^[0-9]{8}-[0-9]{6}$ ]] || {
    echo '[error] invalid rollback snapshot id' >&2
    exit 1
  }
  SNAPSHOT="rollback-snapshots/$SNAPSHOT_ID"
else
  SNAPSHOT="$(find rollback-snapshots -mindepth 1 -maxdepth 1 -type d \
    -name '????????-??????' -printf '%p\n' 2>/dev/null | sort -r | head -n 1 || true)"
fi
[[ -n "$SNAPSHOT" && -d "$SNAPSHOT" && ! -L "$SNAPSHOT" ]] || {
  echo '[error] no rollback snapshot is available' >&2
  exit 1
}
for file in docker-compose.yml images-snapshot.tsv checksums.sha256; do
  [[ -f "$SNAPSHOT/$file" && ! -L "$SNAPSHOT/$file" ]] || {
    echo "[error] rollback snapshot is incomplete: $file" >&2
    exit 1
  }
done
(cd "$SNAPSHOT" && sha256sum -c checksums.sha256 >/dev/null)
if [[ -e "$SNAPSHOT/report-renderer.env" ]]; then
  grep -Eq '^[a-f0-9]{64} [ *]\./report-renderer\.env$' "$SNAPSHOT/checksums.sha256" || {
    echo '[error] report renderer migration receipt is not covered by the snapshot checksum' >&2
    exit 1
  }
fi

echo '[step] backing up current database and environment before application rollback'
./backup-db.sh

echo '[step] stopping service assurance sidecars without removing containers or volumes'
docker compose --profile service-assurance-deep --env-file .env stop \
  service-assurance-nuclei service-assurance-trivy service-assurance-zap \
  >/dev/null 2>&1 || true

while IFS=$'\t' read -r service image_ref image_id; do
  case "$service" in postgres|valkey|api|worker|web) ;;
    *) echo '[error] rollback image service is invalid' >&2; exit 1 ;;
  esac
  [[ "$image_ref" =~ ^[A-Za-z0-9._/@:-]+$ && "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    echo "[error] rollback image identity is invalid: $service" >&2
    exit 1
  }
  docker image inspect "$image_id" >/dev/null 2>&1 || {
    echo "[error] previous image content is unavailable: $service" >&2
    exit 1
  }
  docker image tag "$image_id" "$image_ref"
done <"$SNAPSHOT/images-snapshot.tsv"

install -m 0644 "$SNAPSHOT/docker-compose.yml" docker-compose.yml
rm -f image-lock.json MANIFEST.txt manifest.json manifest.sig manifest.pub deployment-state.json checksums.sha256
for file in image-lock.json MANIFEST.txt manifest.json manifest.sig manifest.pub checksums.sha256 deployment-state.json; do
  [[ -f "$SNAPSHOT/$file" ]] || continue
  install -m 0644 "$SNAPSHOT/$file" "$file"
done

restore_report_renderer_env .env "$SNAPSHOT/report-renderer.env"

echo '[step] recreating the previous application while preserving the current database schema'
docker compose --env-file .env up -d postgres valkey
docker compose --env-file .env up -d --force-recreate --no-deps api worker
docker compose --env-file .env up -d --force-recreate web

set -a
# shellcheck disable=SC1091
. ./.env
set +a
http_port="${WEB_HTTP_PORT:-8090}"
for _ in $(seq 1 120); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${http_port}/api/health" >/dev/null 2>&1 &&
     curl -fsS --max-time 3 "http://127.0.0.1:${http_port}/login" >/dev/null 2>&1; then
    receipt_dir='rollback-receipts'
    receipt_time="$(date +%Y%m%d-%H%M%S)"
    install -d -m 0700 "$receipt_dir"
    cat >"$receipt_dir/$receipt_time.json" <<EOF
{"schema":"lse-rollback-receipt/v1","completedAt":"$(date -Is)","snapshot":"${SNAPSHOT##*/}","databaseRestored":false,"newSchemaPreserved":true}
EOF
    chmod 0600 "$receipt_dir/$receipt_time.json"
    echo '[ok] application rollback completed; database and historical evidence were preserved'
    exit 0
  fi
  sleep 2
done
echo '[error] previous application did not become healthy' >&2
exit 1
ROLLBACK
  chmod +x "$BUNDLE_DIR/rollback.sh"
}

write_uninstall_script() {
  cat >"$BUNDLE_DIR/uninstall.sh" <<'UNINSTALL'
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
DELETE_DATA=0

while (($#)); do
  case "$1" in
    --delete-data)
      DELETE_DATA=1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage:
  ./uninstall.sh
    Stop and remove containers only. Keeps .env and Docker volumes.

  LSE_CONFIRM_DELETE_DATA=YES ./uninstall.sh --delete-data
    Stop services and delete Docker volumes. This removes database and queue data.
USAGE
      exit 0
      ;;
    *)
      echo "[error] unknown argument: $1" >&2
      exit 64
      ;;
  esac
  shift || true
done

if [[ ! -f .env ]]; then
  echo "[error] .env not found; run from the install directory" >&2
  exit 1
fi

if [[ "$DELETE_DATA" -eq 1 ]]; then
  if [[ "${LSE_CONFIRM_DELETE_DATA:-}" != "YES" ]]; then
    echo "[error] refusing to delete data without LSE_CONFIRM_DELETE_DATA=YES" >&2
    exit 1
  fi
  docker compose --env-file .env down -v
  echo "[ok] containers and data volumes removed"
else
  docker compose --env-file .env down
  echo "[ok] containers stopped; data volumes kept"
fi
UNINSTALL
  chmod +x "$BUNDLE_DIR/uninstall.sh"
}

write_status_script() {
  cat >"$BUNDLE_DIR/status.sh" <<'STATUS'
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "[error] .env not found; run from the install directory" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

HTTP_PORT="${WEB_HTTP_PORT:-8090}"
HTTPS_PORT="${WEB_HTTPS_PORT:-10443}"

docker compose --env-file .env ps

echo
if command -v curl >/dev/null 2>&1; then
  echo "[probe] http://127.0.0.1:${HTTP_PORT}/api/health"
  curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/health" || true
  echo
  echo "[probe] https://127.0.0.1:${HTTPS_PORT}/api/health"
  curl -kfsS "https://127.0.0.1:${HTTPS_PORT}/api/health" || true
  echo
fi
STATUS
  chmod +x "$BUNDLE_DIR/status.sh"
}

write_stop_script() {
  cat >"$BUNDLE_DIR/stop.sh" <<'STOP'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
docker compose --env-file .env stop
STOP
  chmod +x "$BUNDLE_DIR/stop.sh"
}

write_readme() {
  cat >"$BUNDLE_DIR/README_OFFLINE.md" <<EOF
# 大模型安全评估平台离线部署/升级包

## 包信息

- 构建时间：$STAMP
- Git 提交：$COMMIT
- 固定镜像：$APP_IMAGE、$WEB_IMAGE、$POSTGRES_IMAGE、$VALKEY_IMAGE、$NUCLEI_IMAGE、$TRIVY_IMAGE、$ZAP_IMAGE
- 支持平滑升级：是，升级前自动备份数据库和 .env
- 支持应用回滚：是，保留当前数据库结构和历史证据

## 首次安装

目标服务器需要 Docker Engine；Docker Compose v2 CLI 插件已随本包提供，若目标机没有 docker compose，安装脚本会自动安装到 Docker CLI 插件目录：

\`\`\`bash
tar -xzf ${BUNDLE_NAME}.tar.gz
cd ${BUNDLE_NAME}
./install.sh
\`\`\`

首次安装会生成新的 .env 和 INITIAL_CREDENTIALS.txt，并从 8090、10443 开始自动顺延选择空闲端口。最终地址以安装输出和 .env 为准：

- HTTP: \`http://服务器IP:<WEB_HTTP_PORT>/login\`
- HTTPS: \`https://服务器IP:<WEB_HTTPS_PORT>/login\`

## 离线依赖

- Docker Engine（目标机已有的 Docker 数据目录、卷和凭据不会被安装脚本删除）。
- 本包 dependencies/docker-compose 中的 Docker Compose v2 CLI 插件；如目标机已有可用插件则复用已有插件。

## 从旧离线包升级

如果你把新版包解压到了一个新目录，请显式指向旧安装目录，脚本会把新版 payload 复制过去，并保留旧 .env：

\`\`\`bash
cd ${BUNDLE_NAME}
./upgrade.sh --install-dir /path/to/current-install
\`\`\`

如果你已经把新版包内容覆盖到旧安装目录，直接运行：

\`\`\`bash
./upgrade.sh
\`\`\`

升级流程会执行：

1. \`./backup-db.sh\` 备份 Postgres 到 \`backups/lse-*.sql\`，并备份 \`.env\`。
2. 校验并加载离线 Docker 镜像。
3. 启动 Postgres/Valkey。
4. 执行 Prisma \`migrate deploy\` 和幂等 seed。
5. 重建 api、worker、web 容器。

升级日志在 \`upgrade-logs/\`。

## 应用回滚

列出升级前保存的应用回滚点：

\`\`\`bash
./rollback.sh --list
\`\`\`

恢复最近一次升级前的应用镜像和 Compose 配置：

\`\`\`bash
./rollback.sh
\`\`\`

回滚不会恢复旧数据库，也不会删除新表、历史运行、核验结论或审计记录。完整边界见 \`docs/service-assurance-offline.md\`。

## 手动备份

\`\`\`bash
./backup-db.sh
\`\`\`

## 状态检查

\`\`\`bash
./status.sh
\`\`\`

## 排障

\`\`\`bash
./diagnose.sh
ls -lh lse-diagnostics-*.tar.gz
\`\`\`

诊断脚本只读采集 Docker、Compose、端口、健康检查和日志，并会对常见密钥字段脱敏。更多说明见 \`docs/offline-troubleshooting.md\`。
旧版升级、备份和彻底卸载手册见 \`docs/offline-upgrade-uninstall-manual.md\`。

服务安全核验的三种模式、断网运行和回滚边界见 \`docs/service-assurance-offline.md\`。

## 卸载

停止并保留数据卷：

\`\`\`bash
./uninstall.sh
\`\`\`

彻底删除容器和数据卷必须显式确认：

\`\`\`bash
LSE_CONFIRM_DELETE_DATA=YES ./uninstall.sh --delete-data
\`\`\`

不要为了升级执行 \`--delete-data\`。
EOF
}

write_manifest() {
  local signature_status="unsigned"
  [[ -n "$SIGNING_KEY_FILE" ]] && signature_status="rsa-sha256"
  cat >"$BUNDLE_DIR/MANIFEST.txt" <<EOF
package=$BUNDLE_NAME
build_time=$STAMP
repo=$ROOT_DIR
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
commit=$COMMIT
source_commit=$SOURCE_COMMIT
version=$PRODUCT_VERSION
target_arch=$TARGET_ARCH
images=$APP_IMAGE,$WEB_IMAGE,$POSTGRES_IMAGE,$VALKEY_IMAGE,$NUCLEI_IMAGE,$TRIVY_IMAGE,$ZAP_IMAGE
ports=http:8090,https:10443
source_env_copied=false
upgrade_supported=true
rollback_supported=true
upgrade_entrypoints=upgrade.sh,install.sh
backup_script=backup-db.sh
rollback_script=rollback.sh
uninstall_script=uninstall.sh
image_lock=image-lock.json
service_assurance_default=SAFE,SBOM
service_assurance_optional=DEEP
service_assurance_rules=lse-rules-2026.08.30.3,sha256:124509fdacc43314287589194b0cb1acf67ea4f6133daf6776e00be250ea6f73
service_assurance_vulndb=trivy-db-2026.08.30T070529Z,sha256:542d1ae089c1070990372d1416416f2a3e699f0c5c12fbc1cafe37071c00e27d
manifest_signature=$signature_status
EOF
  cat >"$BUNDLE_DIR/manifest.json" <<EOF
{"schema":"offline-manifest/v2","product":"llm-safety-eval-platform","package":"$BUNDLE_NAME","build_time":"$STAMP","commit":"$COMMIT","source_commit":"$SOURCE_COMMIT","version":"$PRODUCT_VERSION","target_arch":"$TARGET_ARCH","manifest_signature":"$signature_status","image_lock":"image-lock.json","sbom":"sbom.spdx.json","upgrade_supported":true,"rollback_supported":true,"service_assurance":{"default_modes":["SAFE","SBOM"],"optional_modes":["DEEP"],"rules":{"version":"lse-rules-2026.08.30.3","digest":"sha256:124509fdacc43314287589194b0cb1acf67ea4f6133daf6776e00be250ea6f73"},"vulnerability_db":{"version":"trivy-db-2026.08.30T070529Z","digest":"sha256:542d1ae089c1070990372d1416416f2a3e699f0c5c12fbc1cafe37071c00e27d"}}}
EOF
}
copy_static_assets() {
  [[ -f LICENSE ]] && cp LICENSE "$BUNDLE_DIR/LICENSE"
  [[ -f THIRD_PARTY_NOTICES.md ]] && cp THIRD_PARTY_NOTICES.md "$BUNDLE_DIR/THIRD_PARTY_NOTICES.md"
  [[ -f docs/offline-troubleshooting.md ]] && cp docs/offline-troubleshooting.md "$BUNDLE_DIR/docs/offline-troubleshooting.md"
  [[ -f docs/offline-upgrade-uninstall-manual.md ]] && cp docs/offline-upgrade-uninstall-manual.md "$BUNDLE_DIR/docs/offline-upgrade-uninstall-manual.md"
  [[ -f docs/service-assurance-offline.md ]] && cp docs/service-assurance-offline.md "$BUNDLE_DIR/docs/service-assurance-offline.md"
  awk -F= '
    /^[A-Z][A-Z0-9_]*=/ {
      if ($1 == "NODE_ENV") { print "NODE_ENV=production"; next }
      if ($1 == "LICENSE_ENFORCE") { print "LICENSE_ENFORCE=true"; next }
      if ($1 ~ /(PASSWORD|SECRET|TOKEN|KEY|KEYS|URL|ALLOWLIST|ORIGINS)$/) { print $1 "="; next }
    }
    { print }
  ' .env.example >"$BUNDLE_DIR/CONFIG_TEMPLATE.env"
  cp docs/releases/1.0.8.md "$BUNDLE_DIR/docs/release-notes.md"
  cp docs/releases/1.0.8-recovery.md "$BUNDLE_DIR/docs/backup-restore-rollback.md"
  cp scripts/lib/report-renderer-env.sh "$BUNDLE_DIR/report-renderer-env.sh"
  cp scripts/offline-diagnostics.sh "$BUNDLE_DIR/diagnose.sh"
  chmod +x "$BUNDLE_DIR/diagnose.sh"
  cat >"$BUNDLE_DIR/INITIAL_CREDENTIALS.txt" <<'EOF'
Run ./install.sh on the target server. The installer will generate this file with the initial admin password.
EOF
}

save_images() {
  if [[ "$SKIP_IMAGE_SAVE" -eq 1 ]]; then
    : >"$BUNDLE_DIR/images/checksums.sha256"
    return
  fi

  echo "[step] saving Docker images"
  docker save "${REQUIRED_IMAGES[@]}" | gzip -c >"$BUNDLE_DIR/$IMAGE_ARCHIVE"
  (
    cd "$BUNDLE_DIR/images"
    sha256sum "$(basename "$IMAGE_ARCHIVE")" >checksums.sha256
  )
}

write_package_checksums() {
  (
    cd "$BUNDLE_DIR"
    find . -type f \
      ! -path './checksums.sha256' \
      ! -path './images/checksums.sha256' \
      ! -path './INITIAL_CREDENTIALS.txt' \
      ! -path './.env' \
      -print0 | sort -z | xargs -0 sha256sum >checksums.sha256
  )
}

create_archive() {
  mkdir -p "$OUTPUT_DIR"
  rm -f "$ARCHIVE_FILE" "$CHECKSUM_FILE"
  tar -czf "$ARCHIVE_FILE" -C "$OUTPUT_DIR" "$BUNDLE_NAME"
  printf '%s  %s\n' "$(sha256_file "$ARCHIVE_FILE")" "$(basename "$ARCHIVE_FILE")" >"$CHECKSUM_FILE"
}

main() {
  require_cmd tar
  require_cmd gzip
  require_cmd sha256sum
  check_release_inputs
  run_build_checks
  check_required_images
  mkdir -p "$OUTPUT_DIR"
  prepare_bundle_dir
  copy_compose_plugin
  write_compose
  write_install_script
  write_backup_script
  write_upgrade_script
  write_rollback_script
  write_uninstall_script
  write_status_script
  write_stop_script
  write_readme
  copy_static_assets
  copy_service_assurance_artifacts
  save_images
  write_image_lock
  write_manifest
  sign_manifest
  write_sbom
  write_image_sboms
  write_package_checksums
  run_n_minus_one_gate
  create_archive

  echo "[ok] offline bundle: $ARCHIVE_FILE"
  echo "[ok] checksum: $CHECKSUM_FILE"
}

main
