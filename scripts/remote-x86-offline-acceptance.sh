#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OFFLINE_NETWORK_RESTART="$ROOT_DIR/scripts/lib/offline-network-restart.sh"
REPORT_RENDERER_ENV_HELPER="$ROOT_DIR/scripts/lib/report-renderer-env.sh"

usage() {
  cat <<'USAGE'
Usage: remote-x86-offline-acceptance.sh OLD_RUN_FILE NEW_RUN_FILE user@host

Required environment:
  LSE_ACCEPT_KNOWN_HOSTS   Reviewed known_hosts file (default: ~/.ssh/known_hosts)

Optional environment:
  LSE_ACCEPT_SSH_PORT      SSH port (default: resolved SSH config or 22)
  LSE_ACCEPT_SSH_PASSWORD_FILE
                           Password file for sshpass; the password is never logged
  LSE_ACCEPT_REBOOT        Reboot after the N-1 install (default: 1)
  LSE_ACCEPT_NETWORK_CUT   Remove the guest default route for the offline test (default: 1)
  LSE_ACCEPT_RESUME_AFTER_N1
                           Resume only after a previously verified N-1 clean install (default: 0)
  LSE_ACCEPT_REMOTE_DIR    Reuse a verified /var/tmp/lse-x86-acceptance-* directory
USAGE
}

[[ $# -eq 3 ]] || {
  usage >&2
  exit 64
}

OLD_RUN_FILE="$1"
NEW_RUN_FILE="$2"
TARGET="$3"
KNOWN_HOSTS="${LSE_ACCEPT_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
REBOOT_AFTER_INSTALL="${LSE_ACCEPT_REBOOT:-1}"
NETWORK_CUT="${LSE_ACCEPT_NETWORK_CUT:-1}"
RESUME_AFTER_N1="${LSE_ACCEPT_RESUME_AFTER_N1:-0}"
REUSE_REMOTE_DIR="${LSE_ACCEPT_REMOTE_DIR:-}"

fail() {
  echo "[error] $*" >&2
  exit 1
}

for command in ssh scp ssh-keygen sha256sum; do
  command -v "$command" >/dev/null 2>&1 || fail "missing command: $command"
done
[[ -f "$OFFLINE_NETWORK_RESTART" && ! -L "$OFFLINE_NETWORK_RESTART" ]] ||
  fail "offline network restart helper is unavailable: $OFFLINE_NETWORK_RESTART"
bash -n "$OFFLINE_NETWORK_RESTART" || fail 'offline network restart helper has invalid syntax'
[[ -f "$REPORT_RENDERER_ENV_HELPER" && ! -L "$REPORT_RENDERER_ENV_HELPER" ]] ||
  fail 'report renderer environment helper is unavailable'
bash -n "$REPORT_RENDERER_ENV_HELPER"

[[ -r "$KNOWN_HOSTS" && ! -L "$KNOWN_HOSTS" ]] ||
  fail "reviewed known_hosts file is required: $KNOWN_HOSTS"
[[ "$REBOOT_AFTER_INSTALL" =~ ^[01]$ ]] || fail 'LSE_ACCEPT_REBOOT must be 0 or 1'
[[ "$NETWORK_CUT" =~ ^[01]$ ]] || fail 'LSE_ACCEPT_NETWORK_CUT must be 0 or 1'
[[ "$RESUME_AFTER_N1" =~ ^[01]$ ]] || fail 'LSE_ACCEPT_RESUME_AFTER_N1 must be 0 or 1'
if [[ -n "$REUSE_REMOTE_DIR" ]]; then
  [[ "$REUSE_REMOTE_DIR" =~ ^/var/tmp/lse-x86-acceptance-[A-Za-z0-9._-]+$ ]] ||
    fail 'LSE_ACCEPT_REMOTE_DIR is outside the accepted temporary directory pattern'
fi

for run_file in "$OLD_RUN_FILE" "$NEW_RUN_FILE"; do
  [[ -f "$run_file" && ! -L "$run_file" ]] || fail "installer is unavailable: $run_file"
  [[ -f "$run_file.sha256" && ! -L "$run_file.sha256" ]] ||
    fail "installer checksum is unavailable: $run_file.sha256"
  (
    cd "$(dirname "$run_file")"
    sha256sum -c "$(basename "$run_file").sha256" >/dev/null
  ) || fail "installer checksum verification failed: $run_file"
done

OLD_SHA="$(sha256sum "$OLD_RUN_FILE" | awk '{print $1}')"
NEW_SHA="$(sha256sum "$NEW_RUN_FILE" | awk '{print $1}')"
[[ "$OLD_SHA" != "$NEW_SHA" ]] || fail 'N-1 and candidate installers must be different files'

OLD_NAME="$(basename "$OLD_RUN_FILE")"
NEW_NAME="$(basename "$NEW_RUN_FILE")"
for name in "$OLD_NAME" "$NEW_NAME"; do
  [[ "$name" =~ ^[A-Za-z0-9._-]+\.run$ ]] || fail "unsafe installer name: $name"
done
[[ "$OLD_NAME" != "$NEW_NAME" ]] || fail 'installer basenames must be distinct'
OLD_VERSION="$(bash "$OLD_RUN_FILE" --inspect | awk -F= '$1 == "version" { print $2; exit }')"
[[ "$OLD_VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'N-1 installer has no safe version metadata'

ssh_config="$(ssh -G "$TARGET" 2>/dev/null)" || fail "cannot resolve SSH config for $TARGET"
resolved_host="$(awk '$1 == "hostname" { print $2; exit }' <<<"$ssh_config")"
resolved_port="${LSE_ACCEPT_SSH_PORT:-$(awk '$1 == "port" { print $2; exit }' <<<"$ssh_config")}"
[[ "$resolved_port" =~ ^[0-9]+$ && "$resolved_port" -ge 1 && "$resolved_port" -le 65535 ]] ||
  fail 'invalid SSH port'
host_key_name="$resolved_host"
[[ "$resolved_port" == 22 ]] || host_key_name="[$resolved_host]:$resolved_port"
ssh-keygen -F "$host_key_name" -f "$KNOWN_HOSTS" >/dev/null ||
  fail "target host key is not present in reviewed known_hosts: $host_key_name"

ssh_options=(
  -p "$resolved_port"
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$KNOWN_HOSTS"
  -o LogLevel=ERROR
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=12
)
scp_options=(
  -P "$resolved_port"
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$KNOWN_HOSTS"
  -o LogLevel=ERROR
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=12
)
if [[ -n "${LSE_ACCEPT_SSH_PASSWORD_FILE:-}" ]]; then
  command -v sshpass >/dev/null 2>&1 || fail 'sshpass is required for password-file authentication'
  [[ -r "$LSE_ACCEPT_SSH_PASSWORD_FILE" && ! -L "$LSE_ACCEPT_SSH_PASSWORD_FILE" ]] ||
    fail 'LSE_ACCEPT_SSH_PASSWORD_FILE must be a readable regular file'
  SSH=(sshpass -f "$LSE_ACCEPT_SSH_PASSWORD_FILE" ssh "${ssh_options[@]}" "$TARGET")
  SCP=(sshpass -f "$LSE_ACCEPT_SSH_PASSWORD_FILE" scp "${scp_options[@]}")
else
  SSH=(ssh -o BatchMode=yes "${ssh_options[@]}" "$TARGET")
  SCP=(scp -o BatchMode=yes "${scp_options[@]}")
fi

wait_for_ssh() {
  local attempt
  for attempt in $(seq 1 90); do
    if "${SSH[@]}" true >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail 'guest did not return after reboot'
}

wait_for_ssh_down() {
  local attempt
  for attempt in $(seq 1 90); do
    if ! "${SSH[@]}" true >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail 'guest SSH never went down for reboot'
}

wait_for_docker() {
  local attempt
  for attempt in $(seq 1 90); do
    if "${SSH[@]}" 'sudo systemctl is-active --quiet docker && sudo test -S /var/run/docker.sock' \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  fail 'Docker did not become ready after reboot'
}

wait_for_installed_services() {
  local attempt
  for attempt in $(seq 1 120); do
    if "${SSH[@]}" 'sudo bash -se' >/dev/null 2>&1 <<'REMOTE'
set -Eeuo pipefail
cd /opt/lse/platform
release_dir=/opt/lse/platform
[[ -f current/docker-compose.yml ]] && release_dir=/opt/lse/platform/current
set -a
. ./.env
set +a
compose=(docker compose --project-name lse --env-file .env -f "$release_dir/docker-compose.yml")
running="$("${compose[@]}" ps --status running --services)"
for service in postgres valkey api worker web; do grep -qx "$service" <<<"$running"; done
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/api/health" >/dev/null
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/login" >/dev/null
REMOTE
    then
      return 0
    fi
    sleep 2
  done
  fail 'installed LSE services did not become healthy after reboot'
}

if [[ -n "$REUSE_REMOTE_DIR" ]]; then
  REMOTE_DIR="$REUSE_REMOTE_DIR"
  "${SSH[@]}" "set -Eeuo pipefail; test -d '$REMOTE_DIR' && test ! -L '$REMOTE_DIR'; cd '$REMOTE_DIR'; sha256sum -c '$OLD_NAME.sha256'; sha256sum -c '$NEW_NAME.sha256'; uname -a; df -h /; free -h"
else
  REMOTE_DIR="/var/tmp/lse-x86-acceptance-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  "${SSH[@]}" "install -d -m 0700 '$REMOTE_DIR'; uname -a; df -h /; free -h"
  "${SCP[@]}" \
    "$OLD_RUN_FILE" "$OLD_RUN_FILE.sha256" \
    "$NEW_RUN_FILE" "$NEW_RUN_FILE.sha256" \
    "$TARGET:$REMOTE_DIR/"
fi

"${SCP[@]}" "$REPORT_RENDERER_ENV_HELPER" "$TARGET:$REMOTE_DIR/report-renderer-env.sh"

wait_for_ssh
if [[ "$RESUME_AFTER_N1" == 1 ]]; then
  echo '[step] validating the existing N-1 clean-install baseline before resume'
  wait_for_docker
  wait_for_installed_services
  "${SSH[@]}" "sudo env OLD_VERSION='$OLD_VERSION' REPORT_ENV_HELPER='$REMOTE_DIR/report-renderer-env.sh' bash -se" <<'REMOTE'
set -Eeuo pipefail
cd /opt/lse/platform
test -s .env
test -s INITIAL_CREDENTIALS.txt
release_dir=/opt/lse/platform
[[ -f current/docker-compose.yml ]] && release_dir=/opt/lse/platform/current
set -a
. ./.env
set +a
compose=(docker compose --project-name lse --env-file .env -f "$release_dir/docker-compose.yml")
bash /usr/local/bin/lsectl status
# The installer version may include a product version prefix; image tags use the manifest commit.
command -v python3 >/dev/null
manifest_path="$release_dir/manifest.json"
[[ -f "$manifest_path" && ! -L "$manifest_path" ]] || {
  echo '[error] installed release manifest is unavailable' >&2
  exit 1
}
installed_commit="$(python3 - "$manifest_path" <<'PY_MANIFEST_COMMIT'
import json
import re
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
commit = manifest.get("commit") if isinstance(manifest, dict) else None
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{7,40}", commit):
    raise SystemExit("[error] installed manifest has no valid Git commit")
print(commit)
PY_MANIFEST_COMMIT
)"
[[ "$OLD_VERSION" == "$installed_commit" || "$OLD_VERSION" == *-"$installed_commit" ]] || {
  echo '[error] N-1 installer version does not match the installed manifest commit' >&2
  exit 1
}
expected_app="lse-app:$installed_commit"
expected_web="lse-web:$installed_commit"
configured_images="$("${compose[@]}" config --images)"
grep -Fxq -- "$expected_app" <<<"$configured_images"
grep -Fxq -- "$expected_web" <<<"$configured_images"
for service in api worker web; do
  expected_image="$expected_app"
  [[ "$service" != web ]] || expected_image="$expected_web"
  container_ids="$("${compose[@]}" ps -q "$service")"
  [[ -n "$container_ids" ]] || {
    echo "[error] N-1 baseline has no running container for $service" >&2
    exit 1
  }
  while IFS= read -r container_id; do
    actual_image="$(docker inspect "$container_id" --format '{{.Config.Image}}')"
    [[ "$actual_image" == "$expected_image" ]] || {
      echo "[error] N-1 running image does not match the installed manifest for $service" >&2
      exit 1
    }
  done <<<"$container_ids"
done
running="$("${compose[@]}" ps --status running --services)"
for service in postgres valkey api worker web; do grep -qx "$service" <<<"$running"; done
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/api/health" >/dev/null
sha256sum .env | awk '{print $1}' >/var/tmp/lse-env-before-upgrade.sha256
source "$REPORT_ENV_HELPER"
normalize_report_renderer_env .env | sha256sum | awk '{print $1}' >/var/tmp/lse-env-after-report-migration.sha256
history_file=/var/tmp/lse-history-before-upgrade.tsv
: >"$history_file"
for metric in EngineRun Finding AuditLog; do
  case "$metric" in
    EngineRun) table=engine_runs ;;
    Finding) table=findings ;;
    AuditLog) table=audit_logs ;;
  esac
  count="$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -Atc "SELECT count(*) FROM \"$table\";")"
  [[ "$count" =~ ^[0-9]+$ ]] || exit 1
  printf '%s\t%s\n' "$metric" "$count" >>"$history_file"
done
raw_count="$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Atc 'SELECT count(*) FROM engine_runs WHERE "rawOutput" IS NOT NULL;')"
[[ "$raw_count" =~ ^[0-9]+$ ]] || exit 1
printf 'EngineRun.rawOutput\t%s\n' "$raw_count" >>"$history_file"
chmod 0600 /var/tmp/lse-env-before-upgrade.sha256 /var/tmp/lse-env-after-report-migration.sha256 "$history_file"
echo '[ok] existing N-1 baseline is healthy and matches the installer version'
REMOTE
else
  echo '[step] clean N-1 installation'
  "${SSH[@]}" "sudo env REMOTE_DIR='$REMOTE_DIR' OLD_NAME='$OLD_NAME' REPORT_ENV_HELPER='$REMOTE_DIR/report-renderer-env.sh' bash -se" <<'REMOTE'
set -Eeuo pipefail
[[ ! -e /opt/lse/platform/.env ]] || {
  echo '[error] clean-install acceptance requires a guest snapshot without an existing LSE install' >&2
  exit 1
}
cd "$REMOTE_DIR"
sha256sum -c "$OLD_NAME.sha256" >/dev/null
bash "$OLD_NAME" </dev/null

cd /opt/lse/platform
test -s .env
test -s INITIAL_CREDENTIALS.txt
release_dir=/opt/lse/platform
[[ -f current/docker-compose.yml ]] && release_dir=/opt/lse/platform/current
before_env="$(sha256sum .env | awk '{print $1}')"
printf '%s\n' "$before_env" >/var/tmp/lse-env-before-upgrade.sha256
source "$REPORT_ENV_HELPER"
normalize_report_renderer_env .env | sha256sum | awk '{print $1}' >/var/tmp/lse-env-after-report-migration.sha256

set -a
# shellcheck disable=SC1091
. ./.env
set +a
compose=(docker compose --project-name lse --env-file .env -f "$release_dir/docker-compose.yml")
bash /usr/local/bin/lsectl status
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/api/health" >/dev/null
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/login" >/dev/null
running="$("${compose[@]}" ps --status running --services)"
for service in postgres valkey api worker web; do grep -qx "$service" <<<"$running"; done

history_file=/var/tmp/lse-history-before-upgrade.tsv
: >"$history_file"
for metric in EngineRun Finding AuditLog; do
  case "$metric" in
    EngineRun) table=engine_runs ;;
    Finding) table=findings ;;
    AuditLog) table=audit_logs ;;
  esac
  count="$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -Atc "SELECT count(*) FROM \"$table\";")"
  [[ "$count" =~ ^[0-9]+$ ]] || exit 1
  printf '%s\t%s\n' "$metric" "$count" >>"$history_file"
done
raw_count="$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Atc 'SELECT count(*) FROM engine_runs WHERE "rawOutput" IS NOT NULL;')"
[[ "$raw_count" =~ ^[0-9]+$ ]] || exit 1
printf 'EngineRun.rawOutput\t%s\n' "$raw_count" >>"$history_file"
chmod 0600 /var/tmp/lse-env-before-upgrade.sha256 /var/tmp/lse-env-after-report-migration.sha256 "$history_file"
REMOTE
  if [[ "$REBOOT_AFTER_INSTALL" == 1 ]]; then
    echo '[step] rebooting N-1 installation and checking autostart'
    "${SSH[@]}" 'sudo systemctl reboot' >/dev/null 2>&1 || true
    wait_for_ssh_down
    wait_for_ssh
    wait_for_docker
    wait_for_installed_services
    "${SSH[@]}" 'sudo bash -se' <<'REMOTE'
set -Eeuo pipefail
cd /opt/lse/platform
bash /usr/local/bin/lsectl status
set -a
. ./.env
set +a
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/api/health" >/dev/null
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/login" >/dev/null
REMOTE
  fi
fi

echo '[step] upgrading N-1 installation with the candidate package'
"${SSH[@]}" "sudo env REMOTE_DIR='$REMOTE_DIR' NEW_NAME='$NEW_NAME' bash -se" <<'REMOTE'
set -Eeuo pipefail
cd "$REMOTE_DIR"
sha256sum -c "$NEW_NAME.sha256" >/dev/null
bash "$NEW_NAME" </dev/null
REMOTE

echo '[step] verifying fixed images, three mode readiness, diagnostics and fault recovery'
"${SSH[@]}" 'sudo bash -se' <<'REMOTE'
set -Eeuo pipefail
cd /opt/lse/platform
command -v python3 >/dev/null
test "$(cat /var/tmp/lse-env-after-report-migration.sha256)" = "$(sha256sum .env | awk '{print $1}')"
find backups -type f -name 'lse-*.sql' -size +0c | grep -q .
test -s image-lock.json
test -s service-assurance/trust/manifest.pub
test -s service-assurance/vulndb/db/trivy.db

set -a
# shellcheck disable=SC1091
. ./.env
set +a
compose=(docker compose --env-file .env -f docker-compose.yml)
running="$("${compose[@]}" ps --status running --services)"
for service in postgres valkey service-assurance-nuclei service-assurance-trivy api worker web; do
  grep -qx "$service" <<<"$running"
done

while IFS=$'\t' read -r reference expected; do
  actual="sha256:$(docker image inspect "$reference" \
    --format '{{json .Config}}|{{json .RootFS.Layers}}' | sha256sum | awk '{print $1}')"
  test "$actual" = "$expected"
done < <(python3 -c 'import json; data=json.load(open("image-lock.json", encoding="utf-8")); [print(item["reference"], item["runtimeDigest"], sep="\t") for item in data["images"]]')

readiness_file="$(mktemp)"
login_file="$(mktemp)"
auth_config="$(mktemp)"
cleanup_auth() { rm -f "$readiness_file" "$login_file" "$auth_config"; }
trap cleanup_auth EXIT
admin_password="$(awk '$1 == "password:" { print $2; exit }' INITIAL_CREDENTIALS.txt)"
test -n "$admin_password"
printf '%s\n' "$admin_password" |
  python3 -c 'import json,sys; print(json.dumps({"username":"admin","password":sys.stdin.read().rstrip("\n")}))' |
  curl -fsS --max-time 10 -H 'Content-Type: application/json' --data-binary @- \
    "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/api/auth/login" >"$login_file"
token="$(python3 -c 'import json,sys; token=json.load(sys.stdin).get("token"); assert isinstance(token,str) and token; print(token)' <"$login_file")"
: >"$login_file"
printf 'header = "Authorization: Bearer %s"\n' "$token" >"$auth_config"
chmod 0600 "$readiness_file" "$login_file" "$auth_config"

fetch_readiness() {
  curl -fsS --max-time 10 --config "$auth_config" \
    "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/api/service-assurance/readiness" \
    >"$readiness_file"
}
wait_mode() {
  local mode="$1" expected="$2"
  for _ in $(seq 1 60); do
    fetch_readiness
    if python3 -c 'import json,sys; mode=sys.argv[1]; expected=sys.argv[2]=="true"; data=json.load(open(sys.argv[3], encoding="utf-8")); raise SystemExit(0 if any(item.get("mode")==mode and item.get("ready") is expected for item in data.get("modes",[])) else 1)' \
      "$mode" "$expected" "$readiness_file"; then
      return 0
    fi
    sleep 2
  done
  echo "[error] mode readiness did not reach expected state: $mode=$expected" >&2
  python3 -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); print(json.dumps({"modes":[{key:item.get(key) for key in ("mode","ready","message")} for item in data.get("modes",[])]}, ensure_ascii=False))' "$readiness_file" >&2
  return 1
}

wait_mode SAFE true
wait_mode SBOM true
bash /usr/local/bin/lsectl deep-start >/dev/null
wait_mode DEEP true

"${compose[@]}" stop service-assurance-trivy >/dev/null
wait_mode SBOM false
"${compose[@]}" up -d service-assurance-trivy >/dev/null
wait_mode SBOM true

env_backup="$(mktemp)"
cp -p .env "$env_backup"
# 被验收机器可能没有 openssl 二进制（信创最小化安装常见），
# 这里只需要随机数，按 install.sh 里 random_hex 的同一套回退处理。
if command -v openssl >/dev/null 2>&1; then
  sentinel_hex="$(openssl rand -hex 12)"
else
  sentinel_hex="$(od -An -N 12 -tx1 /dev/urandom | tr -d ' \n')"
fi
[[ "$sentinel_hex" =~ ^[a-f0-9]{24}$ ]] || exit 1
sentinel="LSE_DIAGNOSTIC_SENTINEL_$sentinel_hex"
restore_env() { cp -p "$env_backup" .env; rm -f "$env_backup"; cleanup_auth; }
trap restore_env EXIT
printf '\nLSE_DIAGNOSTIC_SENTINEL=%s\n' "$sentinel" >>.env
before_marker="$(mktemp)"
touch "$before_marker"
LSE_DIAGNOSTIC_SENTINEL="$sentinel" bash ./diagnose.sh >/dev/null </dev/null
archive="$(find . -maxdepth 1 -type f -name 'lse-diagnostics-*.tar.gz' -newer "$before_marker" -print | head -n 1)"
test -s "$archive"
! gzip -dc "$archive" | grep -aFq -- "$sentinel"
restore_env
trap cleanup_auth EXIT
test "$(cat /var/tmp/lse-env-after-report-migration.sha256)" = "$(sha256sum .env | awk '{print $1}')"
echo '[ok] candidate images, SAFE/SBOM/DEEP readiness, diagnostic redaction and recovery verified'
REMOTE

if [[ "$NETWORK_CUT" == 1 ]]; then
  echo '[step] validating offline state and restarting installed services'
  "${SSH[@]}" 'sudo env SSH_CONNECTION="$SSH_CONNECTION" bash -se' <"$OFFLINE_NETWORK_RESTART"
fi

echo '[step] rolling back application content while retaining the upgraded database'
"${SSH[@]}" 'sudo bash -se' <<'REMOTE'
set -Eeuo pipefail
cd /opt/lse/platform
bash /usr/local/bin/lsectl rollback </dev/null
test "$(cat /var/tmp/lse-env-before-upgrade.sha256)" = "$(sha256sum .env | awk '{print $1}')"
set -a
. ./.env
set +a
compose=(docker compose --env-file .env -f docker-compose.yml)
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_HTTP_PORT:-8090}/api/health" >/dev/null
schema_present="$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Atc 'SELECT to_regclass('"'"'service_assurance_runs'"'"') IS NOT NULL;' </dev/null)"
test "$schema_present" = t
while IFS=$'\t' read -r metric before; do
  case "$metric" in
    EngineRun|Finding|AuditLog)
      case "$metric" in
        EngineRun) table=engine_runs ;;
        Finding) table=findings ;;
        AuditLog) table=audit_logs ;;
      esac
      after="$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -Atc "SELECT count(*) FROM \"$table\";" </dev/null)"
      ;;
    EngineRun.rawOutput)
      after="$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -Atc 'SELECT count(*) FROM engine_runs WHERE "rawOutput" IS NOT NULL;' </dev/null)"
      ;;
    *) echo '[error] unexpected history metric' >&2; exit 1 ;;
  esac
  [[ "$after" =~ ^[0-9]+$ && "$after" -ge "$before" ]] || {
    echo "[error] historical evidence count decreased: $metric" >&2
    exit 1
  }
done </var/tmp/lse-history-before-upgrade.tsv
find rollback-receipts -type f -name '*.json' -size +0c | grep -q .
echo '[ok] rollback kept the upgraded schema and historical evidence'
REMOTE

echo '[step] re-upgrading with the candidate package'
"${SSH[@]}" "sudo env REMOTE_DIR='$REMOTE_DIR' NEW_NAME='$NEW_NAME' bash -se" <<'REMOTE'
set -Eeuo pipefail
cd "$REMOTE_DIR"
bash "$NEW_NAME" </dev/null
cd /opt/lse/platform
running="$(docker compose --env-file .env ps --status running --services)"
for service in postgres valkey service-assurance-nuclei service-assurance-trivy api worker web; do
  grep -qx "$service" <<<"$running"
done
test "$(cat /var/tmp/lse-env-after-report-migration.sha256)" = "$(sha256sum .env | awk '{print $1}')"
echo '[ok] candidate re-upgrade completed'
REMOTE

echo "[ok] offline clean install, N-1 upgrade, reboot, three modes, diagnose, failure recovery, rollback and re-upgrade passed"
echo "[info] guest evidence retained at $REMOTE_DIR and /opt/lse/platform/rollback-receipts"
