#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "[fail] $*" >&2
  exit 1
}

required_files=(
  test/service-assurance-lab/docker-compose.yml
  test/service-assurance-lab/gateway-negative/server.mjs
  test/service-assurance-lab/triton-affected/server.mjs
  test/service-assurance-lab/triton-fixed/server.mjs
  test/service-assurance-lab/openapi/openapi.yaml
  test/service-assurance-lab/sbom/maven-log4j-affected.json
  test/service-assurance-lab/sbom/maven-log4j-fixed.json
  apps/web/e2e/service-assurance.spec.ts
)

for file in "${required_files[@]}"; do
  [[ -f "$file" ]] || fail "受控靶场文件缺失: $file"
done

for command in docker jq curl openssl sha256sum pnpm setsid ss awk grep tr strings; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令: $command"
done

COMPOSE_FILE="$ROOT_DIR/test/service-assurance-lab/docker-compose.yml"
EVIDENCE_DIR="$ROOT_DIR/docs/superpowers/evidence/service-assurance"
TRIVY_DB_DIR="${SERVICE_ASSURANCE_TRIVY_DB_CACHE_DIR:-${HOME}/.cache/lse-service-assurance/trivy-db/sha256-9d3b66601a0d6dc18dc7f5ab59257fcc9b1f7f73f64e632f303a0594967a4d3a}"
RUN_KEY="$(date -u +%Y%m%dT%H%M%SZ)_$$"
PROJECT_NAME="lse-sa-e2e-${RUN_KEY//_/-}"
PROJECT_NAME="${PROJECT_NAME,,}"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lse-service-assurance-e2e.XXXXXX")"
SIGNATURE_DIR="$RUNTIME_DIR/signatures"
SIGNING_KEY="$RUNTIME_DIR/manifest-signing.key"
STATE_FILE="$RUNTIME_DIR/state.json"
LOG_DIR="$RUNTIME_DIR/logs"
DB_ROLE="sae2e_${RUN_KEY//[^a-zA-Z0-9_]/_}"
DB_NAME="$DB_ROLE"
DB_PASSWORD="$(openssl rand -hex 24)"
ADMIN_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
AUDITOR_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
SENTINEL="LSE_SA_SENTINEL_$(openssl rand -hex 24)"
AUDITOR_USERNAME="sae2e_auditor_${RUN_KEY//[^a-zA-Z0-9_]/_}"
DATABASE_URL="postgresql://${DB_ROLE}:${DB_PASSWORD}@127.0.0.1:55433/${DB_NAME}?schema=public"
REDIS_URL="redis://192.168.241.10:6379"
API_BASE="http://127.0.0.1:58090/api"
WEB_BASE="http://127.0.0.1:55173"
POSTGRES_CONTAINER="lse-service-assurance-test-postgres"
POSTGRES_ADMIN_USER=''
POSTGRES_ADMIN_DB=''
NUCLEI_URL="http://192.168.240.21:8095"
TRIVY_URL="http://192.168.240.22:8095"
ZAP_URL="http://192.168.240.23:8095"
NEGATIVE_URL="http://192.168.240.10:8080"
AFFECTED_URL="http://192.168.240.11:8080"
FIXED_URL="http://192.168.240.12:8080"
AFFECTED_OPENAPI_URL="$AFFECTED_URL/openapi.yaml"
NEGATIVE_OPENAPI_URL="$NEGATIVE_URL/openapi.yaml"
SBOM_AFFECTED="$ROOT_DIR/test/service-assurance-lab/sbom/maven-log4j-affected.json"
SBOM_FIXED="$ROOT_DIR/test/service-assurance-lab/sbom/maven-log4j-fixed.json"
SBOM_UNSUPPORTED_ROOT="$ROOT_DIR/apps/api/test/fixtures/service-assurance/cyclonedx-triton-affected.json"
SBOM_MISSING_VERSION="$ROOT_DIR/apps/api/test/fixtures/service-assurance/cyclonedx-missing-version.json"
API_PID=''
WORKER_PID=''
WEB_PID=''
DB_CREATED=0
STACK_STARTED=0
SUCCESS=0

install -d -m 0700 "$LOG_DIR"
install -d -m 0755 "$EVIDENCE_DIR"

export SERVICE_ASSURANCE_E2E_SIGNATURE_DIR="$SIGNATURE_DIR"
export SERVICE_ASSURANCE_E2E_TRIVY_DB_DIR="$TRIVY_DB_DIR"
export SERVICE_ASSURANCE_E2E_RULESET_STATUS=CURRENT

compose() {
  docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

stop_process() {
  local process_id="$1"
  [[ -n "$process_id" ]] || return 0
  if kill -0 -- "-$process_id" >/dev/null 2>&1; then
    kill -TERM -- "-$process_id" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      if ! kill -0 -- "-$process_id" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    kill -KILL -- "-$process_id" >/dev/null 2>&1 || true
  fi
  wait "$process_id" >/dev/null 2>&1 || true
}

drop_test_database() {
  printf 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid();\n' \
    "$(printf "'%s'" "$DB_NAME")" |
    docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_ADMIN_USER" \
      -d "$POSTGRES_ADMIN_DB" \
      >/dev/null 2>&1 || true
  printf 'DROP DATABASE IF EXISTS "%s";\nDROP ROLE IF EXISTS "%s";\n' "$DB_NAME" "$DB_ROLE" |
    docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_ADMIN_USER" \
      -d "$POSTGRES_ADMIN_DB" \
      >/dev/null 2>&1 || true
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e
  stop_process "$WEB_PID"
  stop_process "$WORKER_PID"
  stop_process "$API_PID"
  if [[ "$STACK_STARTED" == '1' ]]; then
    compose logs --no-color >"$LOG_DIR/compose.log" 2>&1
    compose down --remove-orphans >"$LOG_DIR/compose-down.log" 2>&1
  fi
  if [[ "$DB_CREATED" == '1' && "$SUCCESS" == '1' ]]; then
    drop_test_database
  elif [[ "$DB_CREATED" == '1' ]]; then
    printf 'failed_database=%s\n' "$DB_NAME" >"$RUNTIME_DIR/preserved-failure.txt"
  fi
  if [[ -f "$SIGNING_KEY" ]]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u "$SIGNING_KEY" >/dev/null 2>&1
    else
      rm -f "$SIGNING_KEY"
    fi
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    echo "[preserved] 失败证据目录: $RUNTIME_DIR" >&2
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

assert_image_id() {
  local reference="$1"
  local expected="$2"
  local actual
  actual="$(docker image inspect "$reference" --format '{{.Id}}' 2>/dev/null)" ||
    fail "固定镜像不存在: $reference"
  [[ "$actual" == "$expected" ]] || fail "固定镜像内容 ID 不匹配: $reference"
}

assert_sha256() {
  local file="$1"
  local expected="$2"
  [[ -f "$file" ]] || fail "固定制品不存在: $file"
  local actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fail "固定制品摘要不匹配: $file"
}

assert_port_free() {
  local port="$1"
  if ss -H -ltn | awk '{print $4}' | grep -Eq "(^|[:.])${port}$"; then
    fail "隔离测试端口已占用: $port"
  fi
}

wait_http() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 180); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "$label 未就绪"
}

wait_valkey() {
  local container_id
  for _ in $(seq 1 120); do
    container_id="$(compose ps -q valkey 2>/dev/null || true)"
    if [[ -n "$container_id" ]] &&
      [[ "$(docker exec "$container_id" valkey-cli ping 2>/dev/null || true)" == 'PONG' ]]; then
      return 0
    fi
    sleep 1
  done
  fail '独立 Valkey 未就绪'
}

assert_image_id lse-service-assurance-nuclei:task10-advisory \
  sha256:4e74692cbcdfeb65c2f71159db70706241f12ce9cde2163600893c33bd2be336
assert_image_id lse-service-assurance-trivy:task10-advisory \
  sha256:12589460e404c70e127eaf35641319ccca57f8c9c8db1ae9c9c450adbffd2307
assert_image_id lse-service-assurance-zap:task10-advisory \
  sha256:2d9b7d50daca5d3a4aedabeea44d99ebf03f8ae6a2db996a3c15c8452f35625f
assert_image_id \
  node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 \
  sha256:6e6261159fd399ebe5a3d556b7d89da9c85c873f3f270918aad6c8107da8b411
assert_image_id \
  valkey/valkey:8-alpine@sha256:a038175878d66b9d274fbf8be73c0305e93798b83917647f167e18cef3c71eec \
  sha256:180e6d8b8cee8d0c0bb769a980b1d516a3c6fc155540b8d7735ef640fdc44124

assert_sha256 "$TRIVY_DB_DIR/db.tar.gz" \
  96b6b47116c081fdf033f809b93b43686894b708acc5f9f177f2f6986e48d1fb
assert_sha256 "$TRIVY_DB_DIR/trivy.db" \
  389181324022b0b85f32a62ead5a6a291ae3f8fa674906d9fdfbe6c22d4a127f
assert_sha256 "$TRIVY_DB_DIR/metadata.json" \
  a01306e93daa6e2ed559cbf5a0c591ba82c4e86122991a31e4680d269bb56ed3

for port in 58090 55173; do
  assert_port_free "$port"
done
docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1 ||
  fail '独立测试 PostgreSQL 容器不存在'
[[ "$(docker inspect "$POSTGRES_CONTAINER" --format '{{.State.Running}}')" == 'true' ]] ||
  fail '独立测试 PostgreSQL 容器未运行'
POSTGRES_ADMIN_USER="$(
  docker exec "$POSTGRES_CONTAINER" sh -c 'printf %s "$POSTGRES_USER"'
)"
POSTGRES_ADMIN_DB="$(
  docker exec "$POSTGRES_CONTAINER" sh -c 'printf %s "${POSTGRES_DB:-$POSTGRES_USER}"'
)"
[[ -n "$POSTGRES_ADMIN_USER" && -n "$POSTGRES_ADMIN_DB" ]] ||
  fail '独立测试 PostgreSQL 管理身份未配置'

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$SIGNING_KEY" \
  >"$LOG_DIR/signing-key.log" 2>&1
SERVICE_ASSURANCE_MANIFEST_SIGNING_KEY_FILE="$SIGNING_KEY" \
  bash scripts/sign-service-assurance-artifacts.sh "$SIGNATURE_DIR" \
  >"$LOG_DIR/signatures.log" 2>&1
openssl dgst -sha256 -verify "$SIGNATURE_DIR/manifest.pub" \
  -signature "$SIGNATURE_DIR/rules/manifest.sig" service-assurance/rules/manifest.json \
  >/dev/null
openssl dgst -sha256 -verify "$SIGNATURE_DIR/manifest.pub" \
  -signature "$SIGNATURE_DIR/vulndb/manifest.sig" service-assurance/vulndb/manifest.json \
  >/dev/null

compose config >"$RUNTIME_DIR/compose.rendered.yml"
compose config --format json >"$RUNTIME_DIR/compose.rendered.json"
if ! jq -e '
  ([
    .services.zap.tmpfs[]
    | select(startswith("/home/zap/.ZAP:"))
    | capture("size=(?<bytes>[0-9]+)").bytes
    | tonumber
  ]) as $sizes
  | ($sizes | length == 1) and ($sizes[0] >= 268435456)
' "$RUNTIME_DIR/compose.rendered.json" >/dev/null; then
  fail '授权核验 sidecar 的 ZAP home 临时盘小于 256 MiB'
fi
if rg -n 'docker\.sock|/var/run/docker|DATABASE_URL|REDIS_URL|169\.254\.169\.254' \
  "$RUNTIME_DIR/compose.rendered.yml" >/dev/null; then
  fail 'sidecar Compose 暴露了禁止的控制面能力'
fi
compose up -d --pull never >"$LOG_DIR/compose-up.log" 2>&1
STACK_STARTED=1
wait_http "$NUCLEI_URL/healthz" '安全检查 sidecar'
wait_http "$TRIVY_URL/healthz" '组件清单 sidecar'
wait_http "$ZAP_URL/healthz" '授权核验 sidecar'
wait_http "$NEGATIVE_URL/healthz" '普通网关负样本'
wait_http "$AFFECTED_URL/healthz" '受影响正样本'
wait_http "$FIXED_URL/healthz" '修复负样本'
wait_valkey

for service in nuclei trivy zap; do
  container_id="$(compose ps -q "$service")"
  [[ -n "$container_id" ]] || fail "sidecar 未启动: $service"
  network_count="$(docker inspect "$container_id" | jq '.[0].NetworkSettings.Networks | length')"
  [[ "$network_count" == '1' ]] || fail "sidecar 网络隔离失败: $service"
  docker inspect "$container_id" | jq -e '
    .[0].HostConfig.ReadonlyRootfs == true and
    .[0].HostConfig.Privileged == false and
    .[0].HostConfig.CapDrop == ["ALL"] and
    ([.[0].Mounts[].Destination] | index("/var/run/docker.sock") | not)
  ' >/dev/null || fail "sidecar 容器安全策略失败: $service"
done
valkey_id="$(compose ps -q valkey)"
[[ "$(docker inspect "$valkey_id" | jq '.[0].NetworkSettings.Networks | length')" == '1' ]] ||
  fail 'Valkey 控制网络隔离失败'

printf 'CREATE ROLE "%s" LOGIN PASSWORD '\''%s'\'';\n' "$DB_ROLE" "$DB_PASSWORD" |
  docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_ADMIN_USER" \
    -d "$POSTGRES_ADMIN_DB" \
    >/dev/null
printf 'CREATE DATABASE "%s" OWNER "%s";\n' "$DB_NAME" "$DB_ROLE" |
  docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_ADMIN_USER" \
    -d "$POSTGRES_ADMIN_DB" \
    >/dev/null
DB_CREATED=1

SCOPE_POLICIES="$(jq -nc \
  --arg negative "$NEGATIVE_URL" \
  --arg affected "$AFFECTED_URL" \
  --arg fixed "$FIXED_URL" \
  '{e2e:{ref:"e2e",origins:[$negative,$affected,$fixed],cidrs:["192.168.240.0/24"],allowPrivate:true,allowPublic:false}}')"

APP_ENV=(
  NODE_ENV=development
  LICENSE_ENFORCE=false
  API_PORT=58090
  DATABASE_URL="$DATABASE_URL"
  REDIS_URL="$REDIS_URL"
  JWT_SECRET="$JWT_SECRET"
  CORS_ORIGIN="$WEB_BASE"
  REPORT_RENDERER=pdfkit
  SERVICE_ASSURANCE_SCOPE_POLICIES="$SCOPE_POLICIES"
  SERVICE_ASSURANCE_NUCLEI_URL="$NUCLEI_URL"
  SERVICE_ASSURANCE_NUCLEI_ENGINE_DIGEST=sha256:aeb5ea2db32a252b8135707d2ad0e89b90e19a18ea7816d38759bc51efb46b97
  SERVICE_ASSURANCE_NUCLEI_RULESET_VERSION=lse-rules-2026.08.30.3
  SERVICE_ASSURANCE_NUCLEI_RULESET_DIGEST=sha256:124509fdacc43314287589194b0cb1acf67ea4f6133daf6776e00be250ea6f73
  SERVICE_ASSURANCE_NUCLEI_RULESET_UPDATED_AT=2026-08-30T13:21:26Z
  SERVICE_ASSURANCE_ZAP_URL="$ZAP_URL"
  SERVICE_ASSURANCE_ZAP_ENGINE_DIGEST=sha256:7840969c7c9fead565bf9734b12f49f6886db90b1d35b1f74d79710bbd081dab
  SERVICE_ASSURANCE_ZAP_RULESET_VERSION=lse-rules-2026.08.30.3
  SERVICE_ASSURANCE_ZAP_RULESET_DIGEST=sha256:124509fdacc43314287589194b0cb1acf67ea4f6133daf6776e00be250ea6f73
  SERVICE_ASSURANCE_ZAP_RULESET_UPDATED_AT=2026-08-30T13:21:26Z
  SERVICE_ASSURANCE_TRIVY_URL="$TRIVY_URL"
  SERVICE_ASSURANCE_TRIVY_ENGINE_DIGEST=sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e
  SERVICE_ASSURANCE_TRIVY_DB_VERSION=trivy-db-2026.08.30T070529Z
  SERVICE_ASSURANCE_TRIVY_DB_DIGEST=sha256:542d1ae089c1070990372d1416416f2a3e699f0c5c12fbc1cafe37071c00e27d
  SERVICE_ASSURANCE_TRIVY_DB_UPDATED_AT=2026-08-30T07:05:29Z
)

env "${APP_ENV[@]}" pnpm exec prisma migrate deploy --schema apps/api/prisma/schema.prisma \
  >"$LOG_DIR/migrate.log" 2>&1
env "${APP_ENV[@]}" ADMIN_USERNAME=admin ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  pnpm exec prisma db seed --schema apps/api/prisma/schema.prisma \
  >"$LOG_DIR/seed.log" 2>&1
env "${APP_ENV[@]}" \
  SERVICE_ASSURANCE_E2E_STATE_FILE="$STATE_FILE" \
  SERVICE_ASSURANCE_E2E_RUN_KEY="$RUN_KEY" \
  SERVICE_ASSURANCE_E2E_AUDITOR_USERNAME="$AUDITOR_USERNAME" \
  SERVICE_ASSURANCE_E2E_AUDITOR_PASSWORD="$AUDITOR_PASSWORD" \
  SERVICE_ASSURANCE_E2E_SENTINEL="$SENTINEL" \
  SERVICE_ASSURANCE_E2E_AFFECTED_URL="$AFFECTED_URL" \
  pnpm exec tsx test/service-assurance-lab/setup.mts \
  >"$LOG_DIR/setup.log" 2>&1

start_worker() {
  setsid env "${APP_ENV[@]}" SERVICE_ASSURANCE_WORKER_CONCURRENCY=1 \
    pnpm --filter @lse/worker start >>"$LOG_DIR/worker.log" 2>&1 &
  WORKER_PID=$!
  sleep 2
  kill -0 "$WORKER_PID" >/dev/null 2>&1 || fail '源码 Worker 启动失败'
}

stop_worker() {
  stop_process "$WORKER_PID"
  WORKER_PID=''
}

setsid env "${APP_ENV[@]}" pnpm --filter @lse/api start >"$LOG_DIR/api.log" 2>&1 &
API_PID=$!
start_worker
env VITE_API_BASE="$API_BASE" VITE_SERVICE_ASSURANCE_SCOPE_POLICY_REF=e2e \
  pnpm --filter @lse/web build >"$LOG_DIR/web-build.log" 2>&1
setsid env VITE_API_BASE="$API_BASE" VITE_SERVICE_ASSURANCE_SCOPE_POLICY_REF=e2e \
  pnpm --filter @lse/web exec vite preview --host 127.0.0.1 --port 55173 --strictPort \
  >"$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
wait_http "$API_BASE/health" '源码 API'
wait_http "$WEB_BASE/login" '源码 Web'

E2E_ENV=(
  SERVICE_ASSURANCE_E2E_API_BASE="$API_BASE"
  SERVICE_ASSURANCE_E2E_STATE_FILE="$STATE_FILE"
  SERVICE_ASSURANCE_E2E_RUNTIME_DIR="$RUNTIME_DIR"
  SERVICE_ASSURANCE_E2E_EVIDENCE_DIR="$EVIDENCE_DIR"
  SERVICE_ASSURANCE_E2E_ADMIN_USERNAME=admin
  SERVICE_ASSURANCE_E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD"
  SERVICE_ASSURANCE_E2E_AUDITOR_PASSWORD="$AUDITOR_PASSWORD"
  SERVICE_ASSURANCE_E2E_NEGATIVE_URL="$NEGATIVE_URL"
  SERVICE_ASSURANCE_E2E_AFFECTED_URL="$AFFECTED_URL"
  SERVICE_ASSURANCE_E2E_FIXED_URL="$FIXED_URL"
  SERVICE_ASSURANCE_E2E_OPENAPI_URL="$AFFECTED_OPENAPI_URL"
  SERVICE_ASSURANCE_E2E_NEGATIVE_OPENAPI_URL="$NEGATIVE_OPENAPI_URL"
  SERVICE_ASSURANCE_E2E_SBOM_AFFECTED="$SBOM_AFFECTED"
  SERVICE_ASSURANCE_E2E_SBOM_FIXED="$SBOM_FIXED"
  SERVICE_ASSURANCE_E2E_SBOM_UNSUPPORTED_ROOT="$SBOM_UNSUPPORTED_ROOT"
  SERVICE_ASSURANCE_E2E_SBOM_MISSING_VERSION="$SBOM_MISSING_VERSION"
)

run_api_scenario() {
  env "${APP_ENV[@]}" "${E2E_ENV[@]}" \
    pnpm exec tsx test/service-assurance-lab/api-e2e.mts "$1"
}

run_api_scenario primary

stop_worker
run_api_scenario queue-partial
compose stop zap >"$LOG_DIR/zap-stop.log" 2>&1
start_worker
run_api_scenario wait-partial
stop_worker
compose up -d --pull never zap >"$LOG_DIR/zap-restore.log" 2>&1
wait_http "$ZAP_URL/healthz" '恢复后的授权核验 sidecar'

SERVICE_ASSURANCE_E2E_RULESET_STATUS=STALE \
  compose up -d --pull never --force-recreate nuclei >"$LOG_DIR/nuclei-stale.log" 2>&1
wait_http "$NUCLEI_URL/healthz" '过期规则 sidecar'
run_api_scenario queue-stale
start_worker
run_api_scenario wait-stale
stop_worker
SERVICE_ASSURANCE_E2E_RULESET_STATUS=CURRENT \
  compose up -d --pull never --force-recreate nuclei >"$LOG_DIR/nuclei-current.log" 2>&1
wait_http "$NUCLEI_URL/healthz" '恢复后的安全检查 sidecar'

run_api_scenario queue-canceled
start_worker
run_api_scenario wait-canceled

env \
  LSE_SERVICE_ASSURANCE_E2E_BASE_URL="$WEB_BASE" \
  LSE_SERVICE_ASSURANCE_E2E_USERNAME=admin \
  LSE_SERVICE_ASSURANCE_E2E_PASSWORD="$ADMIN_PASSWORD" \
  LSE_SERVICE_ASSURANCE_E2E_AFFECTED_URL="$AFFECTED_URL" \
  LSE_SERVICE_ASSURANCE_E2E_OPENAPI_URL="$AFFECTED_OPENAPI_URL" \
  LSE_SERVICE_ASSURANCE_E2E_SBOM_PATH="$SBOM_AFFECTED" \
  LSE_SERVICE_ASSURANCE_E2E_EVIDENCE_DIR="$EVIDENCE_DIR" \
  pnpm exec playwright test apps/web/e2e/service-assurance.spec.ts --workers=1 --reporter=line

env "${APP_ENV[@]}" \
  SERVICE_ASSURANCE_E2E_STATE_FILE="$STATE_FILE" \
  SERVICE_ASSURANCE_E2E_SENTINEL="$SENTINEL" \
  SERVICE_ASSURANCE_E2E_RUNTIME_DIR="$RUNTIME_DIR" \
  pnpm exec tsx test/service-assurance-lab/verify-db.mts

for log_file in "$LOG_DIR"/*.log; do
  if rg -F -l -- "$SENTINEL" "$log_file" >/dev/null; then
    fail "哨兵密钥出现在运行日志"
  fi
done
if strings "$RUNTIME_DIR/service-assurance-report.pdf" | rg -F -q -- "$SENTINEL"; then
  fail '哨兵密钥出现在 PDF 报告'
fi
if command -v pdftotext >/dev/null 2>&1; then
  pdftotext "$RUNTIME_DIR/service-assurance-report.pdf" \
    "$RUNTIME_DIR/service-assurance-report.txt"
  if rg -i -q '\b(AIG|Nuclei|ZAP|Trivy)\b|service-assurance|raw[[:space:]]*json|session[[:space:]]*id|/opt/' \
    "$RUNTIME_DIR/service-assurance-report.txt"; then
    fail 'PDF 报告包含内部实现字段'
  fi
fi

for artifact in \
  "$EVIDENCE_DIR/mode-safe.txt" \
  "$EVIDENCE_DIR/mode-deep.txt" \
  "$EVIDENCE_DIR/mode-sbom.txt" \
  "$EVIDENCE_DIR/desktop.png" \
  "$EVIDENCE_DIR/mobile-390x844.png"; do
  [[ -s "$artifact" ]] || fail "验收证据未生成: $artifact"
done

SUCCESS=1
echo "[ok] service assurance isolated E2E and visual acceptance passed"
echo "[evidence] runtime logs retained at $RUNTIME_DIR"
