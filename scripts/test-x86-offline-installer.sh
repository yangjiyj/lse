#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILDER="$ROOT_DIR/scripts/build-x86-offline-installer.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[fail] $*" >&2; exit 1; }
assert_contains() {
  local file="$1" value="$2"
  grep -Fq -- "$value" "$file" || fail "$file missing: $value"
}
assert_not_contains() {
  local file="$1" value="$2"
  ! grep -Fq -- "$value" "$file" || fail "$file unexpectedly contains: $value"
}

mkdir -p "$TMP/core/images" "$TMP/docker/docker-engine" "$TMP/docker/cli-plugins" "$TMP/out"
printf 'x86_64\n' >"$TMP/docker/ARCH"
printf 'fixture\n' >"$TMP/core/manifest.json"
printf 'fixture\n' >"$TMP/core/manifest.sig"
printf 'fixture\n' >"$TMP/core/manifest.pub"
printf 'fixture\n' >"$TMP/core/checksums.sha256"
printf '{"schema":"offline-image-lock/v1"}\n' >"$TMP/core/image-lock.json"
printf 'fixture\n' >"$TMP/core/images/lse-core-images.tar.gz"
cat >"$TMP/core/install.sh" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'fresh\n' >>"${LSE_TEST_LOG:?}"
SH
cat >"$TMP/core/upgrade.sh" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'upgrade:%s\n' "$*" >>"${LSE_TEST_LOG:?}"
SH
cat >"$TMP/core/status.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$TMP/core/stop.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$TMP/core/backup-db.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$TMP/core/diagnose.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$TMP/docker/install-docker.sh" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'docker-installed\n' >>"${LSE_TEST_LOG:?}"
SH
chmod +x "$TMP/core/"*.sh "$TMP/docker/install-docker.sh"

if bash "$BUILDER" \
  --core-dir "$TMP/core" \
  --docker-pack "$TMP/docker" \
  --output "$TMP/out" \
  --version missing-rollback >"$TMP/missing-rollback.log" 2>&1; then
  fail 'builder accepted a core payload without rollback.sh'
fi
assert_contains "$TMP/missing-rollback.log" 'core payload missing: rollback.sh'

cat >"$TMP/core/rollback.sh" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'rollback:%s\n' "$*" >>"${LSE_TEST_LOG:?}"
SH
chmod +x "$TMP/core/rollback.sh"

bash "$BUILDER" \
  --core-dir "$TMP/core" \
  --docker-pack "$TMP/docker" \
  --output "$TMP/out" \
  --version 0.0.0-test

RUN="$TMP/out/lse-x86-offline-0.0.0-test.run"
[[ -x "$RUN" ]] || fail "run file not executable"
[[ -f "$RUN.sha256" ]] || fail "checksum missing"
(cd "$TMP/out" && sha256sum -c "$(basename "$RUN").sha256")

INSPECT="$TMP/inspect.txt"
bash "$RUN" --inspect >"$INSPECT"
assert_contains "$INSPECT" 'product=llm-safety-eval-platform'
assert_contains "$INSPECT" 'arch=x86_64'
assert_contains "$INSPECT" 'version=0.0.0-test'
assert_contains "$RUN" '仅支持 x86_64'
assert_contains "$RUN" '必须使用 root'
assert_contains "$RUN" '载荷 SHA-256 校验失败'
assert_contains "$RUN" 'install-docker.sh'
assert_contains "$RUN" '/opt/lse/platform'
assert_contains "$RUN" 'upgrade.sh --install-dir'
assert_contains "$RUN" 'exec lsectl rollback "$@"'
assert_contains "$RUN" 'service-assurance-deep'
assert_contains "$RUN" 'INITIAL_CREDENTIALS.txt'
assert_contains "$RUN" 'lsectl'
assert_contains "$RUN" "systemctl enable docker >/dev/null 2>&1 || die '无法设置 Docker 开机启动'"
assert_contains "$RUN" 'echo "访问地址：https://${host_ip:-服务器IP}:${https_port:-10443}/login"'
assert_not_contains "$RUN" 'echo "访问地址：http://${host_ip:-服务器IP}:${http_port:-8090}/login"'

PAYLOAD_LINE="$(awk '$0 == "__LSE_PAYLOAD_BELOW__" { print NR + 1; exit }' "$RUN")"
[[ -n "$PAYLOAD_LINE" ]] || fail 'payload marker missing'
tail -n +"$PAYLOAD_LINE" "$RUN" | tar -tzf - | grep -qx 'lse-platform/rollback.sh'
tail -n +"$PAYLOAD_LINE" "$RUN" | tar -tzf - | grep -qx 'lse-platform/image-lock.json'

# --- 客户侧预检必须在安装开始前就说清 openssl 的事 --------------------------
assert_contains "$RUN" 'openssl_signing_usable'
assert_contains "$RUN" 'check_runtime_dependencies'
assert_contains "$RUN" '本次将以降级模式安装'
assert_contains "$RUN" '载荷 SHA-256 校验失败'

# openssl 可用时，预检报告完整验签。
bash "$RUN" --check-env >"$TMP/check-with-openssl.log" 2>&1 ||
  { cat "$TMP/check-with-openssl.log" >&2; fail 'preflight failed on a host with openssl'; }
assert_contains "$TMP/check-with-openssl.log" '已检测到可用的 openssl'
echo '--- 安装器预检：本机有 openssl，实际输出 ---'
cat "$TMP/check-with-openssl.log"

# a) PATH 中没有 openssl：预检必须提示降级，且不得拒绝安装。
NO_OPENSSL_BIN="$TMP/no-openssl-bin"
mkdir -p "$NO_OPENSSL_BIN"
for dir in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
  if [[ -d "$dir" ]]; then
    for entry in "$dir"/*; do
      name="$(basename "$entry")"
      if [[ "$name" == openssl ]]; then
        continue
      fi
      if [[ -e "$NO_OPENSSL_BIN/$name" ]]; then
        continue
      fi
      ln -s "$entry" "$NO_OPENSSL_BIN/$name" 2>/dev/null || true
    done
  fi
done
[[ ! -e "$NO_OPENSSL_BIN/openssl" ]] || fail 'degraded PATH fixture still exposes openssl'

if ! env -i PATH="$NO_OPENSSL_BIN" HOME="$TMP" bash "$RUN" --check-env \
  >"$TMP/check-no-openssl.log" 2>&1; then
  cat "$TMP/check-no-openssl.log" >&2
  fail 'installer preflight refused to continue without openssl'
fi
assert_contains "$TMP/check-no-openssl.log" '本机没有可用的 openssl 命令行工具'
assert_contains "$TMP/check-no-openssl.log" '本次将以降级模式安装'
assert_contains "$TMP/check-no-openssl.log" '仍然强制执行'
assert_not_contains "$TMP/check-no-openssl.log" '[失败]'
echo '--- 安装器预检：本机无 openssl，实际输出 ---'
cat "$TMP/check-no-openssl.log"

# d) 载荷改一个字节：必须拒绝，且在没有 openssl 的机器上同样拒绝。
bash "$RUN" --verify-payload >"$TMP/payload-intact.log" 2>&1 ||
  { cat "$TMP/payload-intact.log" >&2; fail 'intact payload failed SHA-256 verification'; }
assert_contains "$TMP/payload-intact.log" '载荷 SHA-256 校验通过'

TAMPERED_RUN="$TMP/tampered.run"
cp "$RUN" "$TAMPERED_RUN"
PAYLOAD_OFFSET="$(head -n "$((PAYLOAD_LINE - 1))" "$RUN" | wc -c)"
python3 - "$TAMPERED_RUN" "$PAYLOAD_OFFSET" <<'PY'
import sys

path, offset = sys.argv[1], int(sys.argv[2])
with open(path, "r+b") as handle:
    handle.seek(offset)
    original = handle.read(1)
    if not original:
        raise SystemExit("payload offset is past end of file")
    handle.seek(offset)
    handle.write(bytes([original[0] ^ 0x01]))
PY
if cmp -s "$RUN" "$TAMPERED_RUN"; then
  fail 'payload tamper fixture did not change the installer'
fi
if bash "$TAMPERED_RUN" --verify-payload >"$TMP/payload-tampered.log" 2>&1; then
  fail 'installer accepted a payload with one flipped byte'
fi
assert_contains "$TMP/payload-tampered.log" '载荷 SHA-256 校验失败'
if env -i PATH="$NO_OPENSSL_BIN" HOME="$TMP" bash "$TAMPERED_RUN" --verify-payload \
  >"$TMP/payload-tampered-degraded.log" 2>&1; then
  fail 'installer accepted a flipped payload byte on a host without openssl'
fi
assert_contains "$TMP/payload-tampered-degraded.log" '载荷 SHA-256 校验失败'
echo '--- 安装器载荷校验：完好 / 改一字节 / 改一字节且无 openssl，实际输出 ---'
cat "$TMP/payload-intact.log"
cat "$TMP/payload-tampered.log"
cat "$TMP/payload-tampered-degraded.log"

echo '[ok] x86 self-extracting installer contract passed'
