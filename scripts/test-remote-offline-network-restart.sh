#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBJECT="$ROOT_DIR/scripts/lib/offline-network-restart.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[fail] $*" >&2
  exit 1
}

assert_contains() {
  local file="$1" value="$2"
  grep -Fq -- "$value" "$file" || fail "$file missing: $value"
}

assert_not_contains() {
  local file="$1" value="$2"
  ! grep -Fq -- "$value" "$file" || fail "$file unexpectedly contains: $value"
}

[[ -f "$SUBJECT" ]] || fail "expected helper: $SUBJECT"
bash -n "$SUBJECT"
assert_contains "$SUBJECT" '</dev/null'

mkdir -p "$TMP/bin" "$TMP/platform"
printf 'WEB_HTTP_PORT=8090\n' >"$TMP/platform/.env"

cat >"$TMP/bin/ip" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'ip %s\n' "$*" >>"${TEST_COMMAND_LOG:?}"
case "$*" in
  '-4 route show table main match 192.168.252.1')
    if [[ "${TEST_SSH_USES_DEFAULT:-0}" == 1 ]]; then
      printf 'default via 192.168.252.1 dev ens3\n'
    else
      printf '192.168.252.0/24 dev ens3 proto kernel scope link src 192.168.252.10\n'
    fi
    ;;
  '-4 route show default')
    if [[ "${TEST_HAS_DEFAULT_ROUTE:-0}" == 1 ]]; then
      printf 'default via 192.168.252.1 dev ens3\n'
    fi
    ;;
esac
SH

cat >"$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'curl %s\n' "$*" >>"${TEST_COMMAND_LOG:?}"
[[ "$*" != *https://example.com* ]]
SH

cat >"$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'docker %s\n' "$*" >>"${TEST_COMMAND_LOG:?}"
SH

cat >"$TMP/bin/lsectl" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'lsectl %s\n' "$*" >>"${TEST_COMMAND_LOG:?}"
SH
chmod +x "$TMP/bin/"*

run_subject() {
  env \
    PATH="$TMP/bin:$PATH" \
    SSH_CONNECTION='192.168.252.1 40222 192.168.252.10 22' \
    TEST_COMMAND_LOG="$1" \
    TEST_HAS_DEFAULT_ROUTE="$2" \
    TEST_SSH_USES_DEFAULT="${3:-0}" \
    LSE_ACCEPT_INSTALL_DIR="$TMP/platform" \
    LSE_ACCEPT_LSECTL="$TMP/bin/lsectl" \
    bash "$SUBJECT"
}

no_route_log="$TMP/no-default-route.log"
run_subject "$no_route_log" 0
assert_contains "$no_route_log" 'curl -fsS --max-time 5 https://example.com'
assert_contains "$no_route_log" 'docker compose --profile service-assurance-deep --env-file .env restart postgres valkey service-assurance-nuclei service-assurance-trivy service-assurance-zap api worker web'
assert_contains "$no_route_log" 'lsectl status'
assert_contains "$no_route_log" 'curl -fsS --max-time 5 http://127.0.0.1:8090/api/health'
assert_contains "$no_route_log" "service-assurance-nuclei','service-assurance-trivy','service-assurance-zap"
assert_not_contains "$no_route_log" 'ip -4 route del default'
assert_not_contains "$no_route_log" 'ip -4 route replace default'

route_log="$TMP/default-route.log"
run_subject "$route_log" 1
assert_contains "$route_log" 'ip -4 route del default'
assert_contains "$route_log" 'ip -4 route replace default via 192.168.252.1 dev ens3'

unsafe_log="$TMP/ssh-default-route.log"
if run_subject "$unsafe_log" 1 1 >"$TMP/unsafe.stdout" 2>"$TMP/unsafe.stderr"; then
  fail 'helper accepted an SSH session that depends on the default route'
fi
assert_contains "$TMP/unsafe.stderr" 'SSH reaches this guest through its default route'
assert_not_contains "$unsafe_log" 'docker compose'

echo '[ok] remote offline network restart accepts an already-isolated guest and preserves SSH safety'
