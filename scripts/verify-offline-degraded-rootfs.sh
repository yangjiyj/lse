#!/usr/bin/env bash
# 在一个真实的、没有 openssl 二进制的最小 rootfs 里验证离线交付路径。
#
# 用意：单元测试用"从 PATH 里摘掉 openssl"来模拟，本脚本换成真实文件系统——
# 镜像里本来就没有 openssl 命令行，只有 libssl 库，与信创最小化安装一致。
#
# 覆盖范围仅到校验闸门为止：容器里没有可用的 Docker 守护进程，
# 因此 docker load、数据库迁移、拉起服务这半段不在本脚本内，
# 这不是一次完整的装机验收。
#
# 用法：
#   bash scripts/verify-offline-degraded-rootfs.sh
#   LSE_DEGRADED_ROOTFS_IMAGE=centos:7 bash scripts/verify-offline-degraded-rootfs.sh
#
# 镜像要求：本机已有该镜像（本脚本不联网拉取），且镜像内没有 openssl 二进制，
# 但具备 bash / tar / gzip / sha256sum / awk / sed / grep / find / xargs / sort。
set -Euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IMAGE="${LSE_DEGRADED_ROOTFS_IMAGE:-centos:7}"
PASS=0
FAIL=0
SKIPPED=0
LAST_OUT=""

fatal() {
  echo "[error] $*" >&2
  exit 1
}

note() { printf '\n=== %s ===\n' "$*"; }

for command in docker openssl python3; do
  command -v "$command" >/dev/null 2>&1 || fatal "missing command on this build host: $command"
done
docker image inspect "$IMAGE" >/dev/null 2>&1 ||
  fatal "rootfs image not present locally: $IMAGE (this script never pulls; load or build it first)"

if docker run --rm --network none "$IMAGE" sh -c 'command -v openssl' >/dev/null 2>&1; then
  fatal "$IMAGE ships an openssl binary; it cannot stand in for a host without one"
fi

WORK="$(mktemp -d /tmp/lse-degraded-rootfs.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# $1 期望退出语义 ok|nonzero，$2 用例名，其余为命令
expect() {
  local want="$1" name="$2" out rc
  shift 2
  out="$("$@" 2>&1)"
  rc=$?
  printf -- '--- %s (exit=%d) ---\n%s\n' "$name" "$rc" "$out"
  if { [[ "$want" == ok && "$rc" -eq 0 ]] || [[ "$want" == nonzero && "$rc" -ne 0 ]]; }; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf '[fail] %s: expected %s, got exit=%d\n' "$name" "$want" "$rc" >&2
  fi
  LAST_OUT="$out"
}

want_text() {
  local name="$1" needle="$2"
  if printf '%s' "$LAST_OUT" | grep -Fq -- "$needle"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf '[fail] %s: output is missing %s\n' "$name" "$needle" >&2
  fi
}

in_rootfs() {
  local dir="$1"
  shift
  docker run --rm --network none -v "$dir:/pkg" -w /pkg "$IMAGE" "$@"
}

make_fixture() {
  local target="$1"
  rm -rf "$target"
  cp -a "$BUNDLE_DIR" "$target"
  printf 'POSTGRES_PASSWORD=old\nJWT_SECRET=old\nADMIN_PASSWORD=old\n' >"$target/.env"
}

note "rootfs under test: $IMAGE"
docker run --rm --network none "$IMAGE" sh -c \
  'printf "openssl binary: "; command -v openssl || echo MISSING; printf "libssl: "; ls /usr/lib64/libssl.so.* /usr/lib/x86_64-linux-gnu/libssl.so.* 2>/dev/null | head -1 || echo none'

note 'building a signed offline bundle (lightweight: no image save, no app build)'
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$WORK/signing.key" >/dev/null 2>&1
OFFLINE_ALLOW_DIRTY_TREE=1 \
OFFLINE_ALLOW_MISSING_SBOM=1 \
OFFLINE_ALLOW_UNSIGNED_MANIFEST=0 \
OFFLINE_MANIFEST_SIGNING_KEY_FILE="$WORK/signing.key" \
  bash scripts/package-offline-bundle.sh \
    --output "$WORK" --stamp degraded-rootfs --commit realcheck \
    --skip-build --skip-image-save >"$WORK/package.log" 2>&1 || {
  tail -40 "$WORK/package.log" >&2
  fatal 'offline bundle build failed'
}
tail -2 "$WORK/package.log"
BUNDLE_DIR="$WORK/llm-safety-eval-platform-offline-degraded-rootfs-realcheck"
[[ -d "$BUNDLE_DIR" ]] || fatal "bundle directory not found: $BUNDLE_DIR"

note 'building a real .run installer around that bundle'
mkdir -p "$WORK/docker-pack" "$WORK/out"
printf 'x86_64\n' >"$WORK/docker-pack/ARCH"
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/docker-pack/install-docker.sh"
chmod +x "$WORK/docker-pack/install-docker.sh"
bash scripts/build-x86-offline-installer.sh \
  --core-dir "$BUNDLE_DIR" --docker-pack "$WORK/docker-pack" \
  --output "$WORK/out" --version degraded-rootfs >"$WORK/build-run.log" 2>&1 || {
  tail -20 "$WORK/build-run.log" >&2
  fatal 'x86 installer build failed'
}
tail -2 "$WORK/build-run.log"
RUN_NAME='lse-x86-offline-degraded-rootfs.run'

note 'a) install must continue on a host without openssl'
make_fixture "$WORK/case-degraded"
expect ok 'upgrade.sh --preflight-only without openssl' \
  in_rootfs "$WORK/case-degraded" bash ./upgrade.sh --preflight-only
want_text 'case a' '本机没有可用的 openssl 命令行工具'
want_text 'case a' '降级为 SHA-256 完整性校验'
want_text 'case a' '已跳过安全检查规则与漏洞库清单的签名校验'
want_text 'case a' '[step] verifying package checksums'
want_text 'case a' 'verification mode: sha256-degraded'

note 'c) a tampered manifest must still be refused without openssl'
make_fixture "$WORK/case-tampered"
sed -i 's/"rollback_supported":true/"rollback_supported":false/' "$WORK/case-tampered/manifest.json"
grep -Fq '"rollback_supported":false' "$WORK/case-tampered/manifest.json" ||
  fatal 'manifest tamper fixture did not change the manifest'
expect nonzero 'tampered manifest without openssl' \
  in_rootfs "$WORK/case-tampered" bash ./upgrade.sh --preflight-only
want_text 'case c' 'computed checksum did NOT match'

note 'd) one flipped byte in the package must be refused without openssl'
make_fixture "$WORK/case-byte"
printf 'x' >>"$WORK/case-byte/docker-compose.yml"
expect nonzero 'modified package byte without openssl' \
  in_rootfs "$WORK/case-byte" bash ./upgrade.sh --preflight-only
want_text 'case d' 'computed checksum did NOT match'

note 'e) LSE_REQUIRE_FULL_VERIFICATION=1 must fail instead of degrading'
make_fixture "$WORK/case-require-full"
expect nonzero 'required full verification without openssl' \
  docker run --rm --network none -e LSE_REQUIRE_FULL_VERIFICATION=1 \
    -v "$WORK/case-require-full:/pkg" -w /pkg "$IMAGE" bash ./upgrade.sh --preflight-only
want_text 'case e' '已要求完整验签'
want_text 'case e' 'sha256-degraded'

note 'client-side .run preflight and payload gate on the same rootfs'
# .run 的预检本来就要求 systemd，这一条与 openssl 无关。
# 最小 rootfs 镜像常常没有 systemctl，这时跳过并说明原因，不冒充通过。
if docker run --rm --network none "$IMAGE" sh -c 'command -v systemctl' >/dev/null 2>&1; then
  expect ok '.run --check-env without openssl' \
    in_rootfs "$WORK/out" bash "./$RUN_NAME" --check-env
  want_text '.run --check-env' '本机没有可用的 openssl 命令行工具'
  want_text '.run --check-env' '本次将以降级模式安装'
else
  SKIPPED=$((SKIPPED + 1))
  echo '[skip] .run --check-env: 该 rootfs 没有 systemctl，安装器本就只支持 systemd 系统（与 openssl 无关）'
fi

expect ok '.run --verify-payload on an intact payload' \
  in_rootfs "$WORK/out" bash "./$RUN_NAME" --verify-payload
want_text '.run --verify-payload' '载荷 SHA-256 校验通过'

cp "$WORK/out/$RUN_NAME" "$WORK/out/tampered.run"
PAYLOAD_LINE="$(awk '$0 == "__LSE_PAYLOAD_BELOW__" { print NR + 1; exit }' "$WORK/out/$RUN_NAME")"
[[ -n "$PAYLOAD_LINE" ]] || fatal 'payload marker not found in the generated installer'
PAYLOAD_OFFSET="$(head -n "$((PAYLOAD_LINE - 1))" "$WORK/out/$RUN_NAME" | wc -c)"
python3 - "$WORK/out/tampered.run" "$PAYLOAD_OFFSET" <<'PY'
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
if cmp -s "$WORK/out/$RUN_NAME" "$WORK/out/tampered.run"; then
  fatal 'payload tamper fixture did not change the installer'
fi
expect nonzero '.run --verify-payload on a flipped payload byte' \
  in_rootfs "$WORK/out" bash ./tampered.run --verify-payload
want_text '.run tampered payload' '载荷 SHA-256 校验失败'

note 'result'
printf 'assertions passed: %d   failed: %d   skipped cases: %d\n' "$PASS" "$FAIL" "$SKIPPED"
if [[ "$FAIL" -ne 0 ]]; then
  echo '[error] degraded rootfs verification failed' >&2
  exit 1
fi
cat <<'SCOPE'
[ok] degraded rootfs verification passed
[note] 覆盖范围：仅到校验闸门（manifest 验签判定、checksums.sha256、载荷 SHA-256）。
[note] 未覆盖：docker load、数据库迁移、服务拉起。这不是一次完整的装机验收。
SCOPE
