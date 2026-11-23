#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGER="$ROOT_DIR/scripts/package-offline-bundle.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[fail] $*" >&2
  exit 1
}

INSTALLER="$TMP/install.sh"
INSTALLER_LIB="$TMP/install-lib.sh"
awk '
  index($0, "cat >\"$BUNDLE_DIR/install.sh\"") && index($0, "INSTALL") {
    found=1
    next
  }
  found && $0 == "INSTALL" { exit }
  found { print }
  END { if (!found) exit 1 }
' "$PACKAGER" >"$INSTALLER"
chmod 0700 "$INSTALLER"
bash -n "$INSTALLER"
awk '/^require_cmd docker$/ { exit } { print }' "$INSTALLER" >"$INSTALLER_LIB"
bash -n "$INSTALLER_LIB"

mkdir -p "$TMP/bin" "$TMP/install"
cat >"$TMP/bin/ss" <<'SH'
#!/bin/sh
printf '%s\n' \
  'LISTEN 0 128 0.0.0.0:8090 0.0.0.0:*' \
  'LISTEN 0 128 0.0.0.0:8091 0.0.0.0:*' \
  'LISTEN 0 128 0.0.0.0:10443 0.0.0.0:*'
SH
chmod 0755 "$TMP/bin/ss"

(
  export LSE_PORT_CHECK_BINDIR="$TMP/bin"
  # shellcheck disable=SC1090
  source "$INSTALLER_LIB"
  cd "$TMP/install"
  write_env >/dev/null
  grep -Fqx 'WEB_HTTP_PORT=8092' .env ||
    fail 'HTTP port did not advance past 8090 and 8091'
  grep -Fqx 'WEB_HTTPS_PORT=10444' .env ||
    fail 'HTTPS port did not advance past 10443'
  [[ "$(stat -c %a .env)" == 600 ]] || fail '.env mode is not 600'

  RESERVED_PORTS=""
  LSE_PORT_CHECK_SKIP=1
  allocate_port first 12000
  allocate_port second 12000
  [[ "$first" == 12000 && "$second" == 12001 ]] ||
    fail 'allocator did not reserve a port selected earlier in the same install'
)

grep -Fq 'allocate_port web_http_port' "$PACKAGER" ||
  fail 'write_env does not allocate the HTTP port'
grep -Fq 'allocate_port web_https_port' "$PACKAGER" ||
  fail 'write_env does not allocate the HTTPS port'
grep -Fq 'Existing .env found; preserving it and running upgrade path.' "$PACKAGER" ||
  fail 'upgrade no longer preserves the existing port configuration'

echo '[ok] LSE fresh install advances occupied public ports and upgrade preserves .env'
