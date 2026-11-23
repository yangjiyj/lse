#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${LSE_ACCEPT_INSTALL_DIR:-/opt/lse/platform}"
LSECTL="${LSE_ACCEPT_LSECTL:-/usr/local/bin/lsectl}"

fail() {
  echo "[error] $*" >&2
  exit 1
}

[[ -n "${SSH_CONNECTION:-}" ]] || fail 'SSH_CONNECTION is required for route safety validation'
cd "$INSTALL_DIR"

client_ip="${SSH_CONNECTION%% *}"
selected_route="$(ip -4 route show table main match "$client_ip" | head -n 1)"
[[ -n "$selected_route" && "$selected_route" != default* ]] ||
  fail 'SSH reaches this guest through its default route; refusing unsafe network cut'

default_route="$(ip -4 route show default | head -n 1)"
route_removed=0
restore_route() {
  if [[ "$route_removed" == 1 ]]; then
    read -r -a default_route_args <<<"$default_route"
    ip -4 route replace "${default_route_args[@]}" >/dev/null 2>&1 || true
    route_removed=0
  fi
}
trap restore_route EXIT

if [[ -n "$default_route" ]]; then
  route_removed=1
  ip -4 route del default
else
  echo '[info] guest already has no default route; keeping isolated network state'
fi

if curl -fsS --max-time 5 https://example.com >/dev/null 2>&1; then
  fail 'public network remained reachable during the offline restart'
fi

docker compose --profile service-assurance-deep --env-file .env restart \
  postgres valkey service-assurance-nuclei service-assurance-trivy service-assurance-zap api worker web \
  </dev/null
set -a
# shellcheck disable=SC1091
. ./.env
set +a
for _ in $(seq 1 90); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/api/health" >/dev/null 2>&1 && \
    docker compose --profile service-assurance-deep --env-file .env exec -T api node -e \
      "Promise.all(['service-assurance-nuclei','service-assurance-trivy','service-assurance-zap'].map(h=>fetch('http://'+h+':8095/healthz').then(r=>r.json()).then(v=>{if(v.ready!==true)throw Error('not ready')}))).then(()=>process.exit(0)).catch(()=>process.exit(1))" \
      </dev/null; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/api/health" >/dev/null
docker compose --profile service-assurance-deep --env-file .env exec -T api node -e \
  "Promise.all(['service-assurance-nuclei','service-assurance-trivy','service-assurance-zap'].map(h=>fetch('http://'+h+':8095/healthz').then(r=>r.json()).then(v=>{if(v.ready!==true)throw Error('not ready')}))).then(()=>process.exit(0)).catch(()=>process.exit(1))" \
  </dev/null
"$LSECTL" status </dev/null

restore_route
trap - EXIT
echo '[ok] installed images restarted without public network access'
