#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${LSE_OFFLINE_ROOT:-$SCRIPT_DIR}"
if [[ ! -f "$ROOT_DIR/docker-compose.yml" && -f "$SCRIPT_DIR/../docker-compose.yml" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
cd "$ROOT_DIR"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT_DIR/diagnostics/$RUN_ID"
SUMMARY="$OUT_DIR/summary.txt"
mkdir -p "$OUT_DIR"

HTTP_PORT="${WEB_HTTP_PORT:-8090}"
HTTPS_PORT="${WEB_HTTPS_PORT:-10443}"
if [[ -f .env ]]; then
  HTTP_PORT="$(awk -F= '/^WEB_HTTP_PORT=/{print $2}' .env | tail -1)"
  HTTPS_PORT="$(awk -F= '/^WEB_HTTPS_PORT=/{print $2}' .env | tail -1)"
  HTTP_PORT="${HTTP_PORT:-8090}"
  HTTPS_PORT="${HTTPS_PORT:-10443}"
fi

section() {
  printf '\n===== %s =====\n' "$1" | tee -a "$SUMMARY"
}

run_capture() {
  local name="$1"
  shift
  section "$name"
  {
    printf '$'
    printf ' %q' "$@"
    printf '\n'
    "$@"
  } 2>&1 | sanitize_sensitive > "$OUT_DIR/$name.txt" || true
  sed -n '1,120p' "$OUT_DIR/$name.txt" | tee -a "$SUMMARY"
}

capture_text() {
  local name="$1"
  local file="$OUT_DIR/$name.txt"
  section "$name"
  sanitize_sensitive > "$file"
  sed -n '1,160p' "$file" | tee -a "$SUMMARY"
}

sanitize_sensitive() {
  sed -E \
    -e 's#(postgresql://[^:[:space:]]+:)[^@[:space:]]+@#\1<redacted>@#Ig' \
    -e 's#("?(Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)"?[[:space:]]*:[[:space:]]*)\[[^]]*\]#\1["<redacted>"]#Ig' \
    -e 's#^([[:space:]]*(Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)[[:space:]]*:[[:space:]]*).*$#\1<redacted>#Ig' \
    -e 's#((Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)"?[[:space:]]*:[[:space:]]*)("[^"]*"|[^,}]+)#\1"<redacted>"#Ig' \
    -e 's#((Bearer|Basic)[[:space:]]+)[A-Za-z0-9._~+/=-]+#\1<redacted>#Ig' \
    -e 's#(([A-Za-z0-9_.-]*(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|KEY|LICENSE|PRIVATE|CREDENTIAL|SENTINEL)[A-Za-z0-9_.-]*)=)[^[:space:]]+#\1<redacted>#Ig' \
    -e 's#^([[:space:]-]*[A-Za-z0-9_.-]*(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|KEY|LICENSE|PRIVATE|CREDENTIAL|SENTINEL)[A-Za-z0-9_.-]*:[[:space:]]*).+$#\1<redacted>#Ig' |
    redact_sentinel_literal
}

redact_sentinel_literal() {
  awk -v needle="${LSE_DIAGNOSTIC_SENTINEL:-}" '
    needle == "" { print; next }
    {
      while ((position = index($0, needle)) > 0) {
        $0 = substr($0, 1, position - 1) "<redacted-sentinel>" substr($0, position + length(needle))
      }
      print
    }
  '
}

mask_env() {
  if [[ ! -f .env ]]; then
    echo ".env not found"
    return
  fi
  awk -F= '
    /^[[:space:]]*#/ || NF == 0 { next }
    {
      key=$1
      value=substr($0, length(key) + 2)
      sensitive=(key ~ /(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|KEY|LICENSE|PRIVATE|CREDENTIAL|SENTINEL)/)
      if (sensitive) {
        printf "%s=<redacted-len=%d>\n", key, length(value)
      } else {
        printf "%s=%s\n", key, value
      }
    }
  ' .env
}

http_probe() {
  local label="$1"
  local url="$2"
  local body="$OUT_DIR/${label}.body"
  local headers="$OUT_DIR/${label}.headers"
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found"
    return
  fi
  curl -k -sS --max-time 10 -D "$headers" -o "$body" "$url" || true
  {
    echo "URL: $url"
    echo "--- headers ---"
    sed -n '1,40p' "$headers" 2>/dev/null || true
    echo "--- body head ---"
    sed -n '1,40p' "$body" 2>/dev/null || true
    echo "--- assets ---"
    local origin
    origin="$(printf '%s\n' "$url" | sed -E 's#^(https?://[^/]+).*#\1#')"
    local asset_count=0
    while read -r asset; do
      [[ -n "$asset" ]] || continue
      asset_count=$((asset_count + 1))
      printf '%s -> ' "$asset"
      curl -k -sS --max-time 10 -o /dev/null -w '%{http_code} %{content_type} %{size_download} bytes\n' "${origin}${asset}" || true
    done < <(grep -Eo 'src="/[^"]+|href="/[^"]+' "$body" 2>/dev/null | sed 's/^[^"]*"//' | sed -n '1,40p' || true)
    if [[ "$asset_count" -eq 0 ]]; then
      echo "no page assets found"
    fi
  } | sanitize_sensitive > "$OUT_DIR/${label}.txt"
  sed -n '1,120p' "$OUT_DIR/${label}.txt" | tee -a "$SUMMARY"
}

compose_cmd=()
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose --env-file .env)
fi

{
  echo "LSE offline diagnostics"
  echo "time: $(date -Is)"
  echo "root: $ROOT_DIR"
  echo "http_port: $HTTP_PORT"
  echo "https_port: $HTTPS_PORT"
} | tee "$SUMMARY" >/dev/null

run_capture uname uname -a
run_capture disk df -h .
run_capture files sh -c "find . -maxdepth 2 -type f | sort"
capture_text env-redacted < <(mask_env)

if command -v ip >/dev/null 2>&1; then
  run_capture network-addresses sh -c "hostname -I 2>/dev/null || true; ip -br addr"
else
  run_capture network-addresses hostname -I
fi

if command -v sha256sum >/dev/null 2>&1 && [[ -f checksums.sha256 ]]; then
  run_capture checksums sha256sum -c checksums.sha256
else
  capture_text checksums <<'EOF'
sha256sum or checksums.sha256 not found
EOF
fi

if command -v docker >/dev/null 2>&1; then
  run_capture docker-version docker version
  run_capture docker-info docker info
  run_capture docker-images sh -c "docker images | grep -E '(^REPOSITORY|lse-|postgres|valkey)' || true"
  run_capture docker-ps docker ps -a
else
  capture_text docker <<'EOF'
docker not found
EOF
fi

if [[ "${#compose_cmd[@]}" -gt 0 ]]; then
  run_capture compose-version docker compose version
  run_capture compose-config "${compose_cmd[@]}" config
  run_capture compose-ps "${compose_cmd[@]}" ps -a
  run_capture compose-logs-web "${compose_cmd[@]}" logs --tail=200 web
  run_capture compose-logs-api "${compose_cmd[@]}" logs --tail=200 api
  run_capture compose-logs-migrate "${compose_cmd[@]}" logs --tail=200 migrate
  run_capture compose-logs-worker "${compose_cmd[@]}" logs --tail=120 worker
  run_capture compose-logs-assurance-nuclei "${compose_cmd[@]}" logs --tail=120 service-assurance-nuclei
  run_capture compose-logs-assurance-trivy "${compose_cmd[@]}" logs --tail=120 service-assurance-trivy
  run_capture compose-logs-assurance-zap docker compose --profile service-assurance-deep --env-file .env logs --tail=120 service-assurance-zap
  run_capture compose-assurance-readiness "${compose_cmd[@]}" exec -T api node -e \
    "Promise.all(['service-assurance-nuclei','service-assurance-trivy'].map(h=>fetch('http://'+h+':8095/healthz').then(r=>r.json()))).then(v=>console.log(JSON.stringify(v))).catch(()=>process.exit(1))"
else
  capture_text compose <<'EOF'
docker compose v2 not found or docker unavailable
EOF
fi

if command -v ss >/dev/null 2>&1; then
  run_capture ports-ss ss -ltnp
elif command -v netstat >/dev/null 2>&1; then
  run_capture ports-netstat netstat -ltnp
fi

if command -v ufw >/dev/null 2>&1; then
  run_capture firewall-ufw ufw status verbose
elif command -v firewall-cmd >/dev/null 2>&1; then
  run_capture firewall-cmd firewall-cmd --list-all
fi

section "http-login"
http_probe http-login "http://127.0.0.1:${HTTP_PORT}/login"
section "https-login"
http_probe https-login "https://127.0.0.1:${HTTPS_PORT}/login"
section "https-api-health"
http_probe https-api-health "https://127.0.0.1:${HTTPS_PORT}/api/health"

if command -v openssl >/dev/null 2>&1; then
  run_capture tls-cert sh -c "echo | openssl s_client -connect 127.0.0.1:${HTTPS_PORT} -servername localhost 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null"
fi

if command -v tar >/dev/null 2>&1; then
  ARCHIVE="$ROOT_DIR/lse-diagnostics-${RUN_ID}.tar.gz"
  if [[ -n "${LSE_DIAGNOSTIC_SENTINEL:-}" ]] &&
    rg -l -F -- "$LSE_DIAGNOSTIC_SENTINEL" "$OUT_DIR" >/dev/null 2>&1; then
    echo '[error] diagnostic sentinel remained in collected files' >&2
    exit 1
  fi
  tar -czf "$ARCHIVE" -C "$ROOT_DIR" "diagnostics/$RUN_ID"
  if [[ -n "${LSE_DIAGNOSTIC_SENTINEL:-}" ]] &&
    gzip -dc "$ARCHIVE" | grep -aFq -- "$LSE_DIAGNOSTIC_SENTINEL"; then
    echo '[error] diagnostic sentinel remained in archive' >&2
    exit 1
  fi
  echo "archive: $ARCHIVE" | tee -a "$SUMMARY"
fi

cat <<EOF | tee -a "$SUMMARY"

Next:
1. Send the archive lse-diagnostics-${RUN_ID}.tar.gz back to support.
2. If http-login/https-login has 200 but browser still cannot open, check browser certificate warning or proxy/firewall.
3. If /api/health is not 200, inspect compose-logs-api and compose-logs-migrate.
4. If web logs show Caddy config errors, inspect config/Caddyfile and port conflicts.
EOF
